#!/usr/bin/env bun

/**
 * Claudish MCP Server
 *
 * Exposes all claudish models (OpenRouter, Kimi, GLM, Qwen, MiniMax, Gemini, OpenAI,
 * local models, etc.) and channel sessions as MCP tools for Claude Code.
 * Routes through the same proxy engine as the CLI — same auto-routing, fallback chains,
 * custom routing rules, and provider transports.
 *
 * Run with: claudish --mcp (stdio transport)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "dotenv";
import { searchCatalogModels } from "./adapters/model-catalog.js";
import { assertAgentAvailable } from "./agent-availability.js";
import { prehydrateCredentialsForSpawn } from "./auth/credentials/prehydrate.js";
import { installWireTap, watchNotificationResult, wrapStateChange } from "./channel/diagnostics.js";
import { SessionManager } from "./channel/index.js";
import { isSubscriptionProvider } from "./handlers/shared/remote-provider-types.js";
import {
  type HeartbeatHandle,
  NOOP_HEARTBEAT,
  resolveProgressIntervalMs,
  startHeartbeat,
} from "./mcp/progress-heartbeat.js";
import {
  type RecommendedModelGroup,
  type RecommendedModelsDoc,
  collectRoutingPrefixes,
  computeQuickPicks,
  formatListingPrice,
  getRecommendedModels,
  groupRecommendedModels,
  normalizePricingDisplay,
} from "./model-loader.js";
import { findAvailablePort } from "./port-manager.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { compareByReleaseDateDesc } from "./providers/model-ordering.js";
import { isLocalProviderName } from "./providers/model-parser.js";
import { NATIVE_NOT_PROBED, nativeRouteFor } from "./providers/native-route.js";
import { renderOpFailureBlock } from "./providers/onepassword.js";
import { isReadyState, probeLink } from "./providers/probe-live.js";
import { BUILTIN_PROVIDERS } from "./providers/provider-definitions.js";
import { nativeProviderForVendor } from "./providers/route-candidates.js";
import { route } from "./providers/routing-rules.js";
import { createProxyServer } from "./proxy-server.js";
import { sanitizeForReport } from "./redact.js";
import {
  cancelTeamRun,
  getStatus,
  judgeResponses,
  readTeamInputFile,
  runModels,
  setupSession,
  shutdownAllTeamRuns,
  startModels,
  teamSlotActivity,
  teamSlotIdleSeconds,
  teamSlotLiveBytes,
  validateSessionPath,
} from "./team-orchestrator.js";
import type { ProxyServer } from "./types.js";

// Load environment variables.
//
// `quiet: true` is REQUIRED, not cosmetic: this process speaks MCP JSON-RPC over
// STDOUT, and dotenv v17 otherwise prints a banner there —
//   [dotenv@17.2.3] injecting env (0) from .env -- tip: …
// — the moment a .env exists in the cwd. That single non-JSON line corrupts the
// stream, so the host (Claude Code) fails to initialize the server and the user
// silently gets NO claudish tools. index.ts already passes quiet for the same
// reason; this call is the one the MCP path actually hits.
config({ quiet: true });

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ───────────────────────────────────────────────────────────────

const CLAUDISH_CACHE_DIR = join(homedir(), ".claudish");
// OpenRouter's own model list, for `search_models`. Its OWN file: this once shared
// `all-models.json` with the cloud models catalog cache, and each writer erased the
// other's data, because the two hold different shapes.
const OPENROUTER_MODELS_CACHE_PATH = join(CLAUDISH_CACHE_DIR, "openrouter-models.json");
const CACHE_MAX_AGE_DAYS = 2;

/** Instructions added to Claude's system prompt when channel mode is active. */
const INSTRUCTIONS = `Claudish MCP server provides access to external AI models (OpenRouter, Ollama, LM Studio, etc.) for coding tasks.

## Channel Mode — External Model Sessions

When channel mode is active, you receive <channel source="claudish" ...> notifications about running external model sessions.

### Events

- session_started: A session began producing output. Note the session_id for future calls.
- tool_executing: The model is using a tool (Read, Write, Bash, etc.). May include tool_count for batched events.
- input_required: The model is asking a question and waiting for input. Call send_input with the session_id and your answer.
- completed: The session finished successfully. Call get_output to retrieve the full output.
- failed: The session exited with an error. Call get_diagnostics for the cause.
- timeout: The session hit its timeout_seconds and was killed. Call get_diagnostics to see how far it got.
- cancelled: The session was cancelled via cancel_session.

### Workflow

1. Call create_session with a model and prompt to start an async session.
2. Watch for <channel> notifications — they arrive automatically.
3. On input_required: call send_input with the answer.
4. On completed: call get_output to get the full response.
5. On failed or timeout — or on a completed session whose output is empty or
   surprising — call get_diagnostics. It returns the child's stderr, the upstream
   error bodies, the recent event frames, the resolved model chain and the paths
   to the full records. It needs no re-run and no debug flag.
6. Use list_sessions to see all active/completed sessions.
7. Use cancel_session to stop a running session.

The session_id in the channel tag's meta attributes is the key for all tool calls.`;

// ─── Types ───────────────────────────────────────────────────────────────────

type ToolGroup = "low-level" | "agentic" | "channel";

/**
 * Per-call context handed to every tool handler. Built fresh in the CallTool
 * dispatch, so nothing here is shared between concurrent calls.
 *
 * It is an explicit parameter rather than AsyncLocalStorage on purpose: ambient
 * state is exactly what would let a long-lived closure (`SessionManager.onStateChange`,
 * a `runModels` progress callback) read a `progressToken` from whatever call happens
 * to be on the stack later, which is the one bug class this design makes unreachable.
 */
interface ToolCallContext {
  /**
   * Emit ONE keepalive frame right now, in addition to the periodic ones.
   * Safe to call from anywhere inside the handler; a no-op when the client sent
   * no `progressToken`, when the tool did not opt into `heartbeat`, or after the
   * heartbeat has been stopped. Never throws.
   */
  reportProgress: (message?: string) => void;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  group: ToolGroup;
  /**
   * Opt in to the periodic `notifications/progress` keepalive. Set ONLY on tools
   * that can block past the client's MCP idle window (30 min by default on stdio).
   * The dispatch owns start and stop; the handler cannot leak a timer.
   *
   * The type is the literal `true`, not `boolean`: `heartbeat: false` has no
   * meaning distinct from omitting the flag, and spelling it that way keeps the
   * only legal state an opt-in.
   */
  heartbeat?: true;
  /**
   * Widening this to two parameters costs NOTHING at the existing call sites:
   * TypeScript function types are bivariant in parameter count, so every
   * `async (args) => …` / `async () => …` handler already in this file stays
   * assignable verbatim. A handler that ignores `ctx` also pays nothing at
   * runtime — its heartbeat is `NOOP_HEARTBEAT` unless it opted in above.
   */
  handler: (
    args: Record<string, unknown>,
    ctx: ToolCallContext
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

async function loadAllModels(forceRefresh = false): Promise<any[]> {
  if (!forceRefresh && existsSync(OPENROUTER_MODELS_CACHE_PATH)) {
    try {
      const cacheData = JSON.parse(readFileSync(OPENROUTER_MODELS_CACHE_PATH, "utf-8"));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const ageInDays = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
      if (ageInDays <= CACHE_MAX_AGE_DAYS) {
        return cacheData.models || [];
      }
    } catch {
      // Cache invalid
    }
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    const models = data.data || [];
    mkdirSync(CLAUDISH_CACHE_DIR, { recursive: true });
    writeFileSync(
      OPENROUTER_MODELS_CACHE_PATH,
      JSON.stringify({ lastUpdated: new Date().toISOString(), models }),
      "utf-8"
    );
    return models;
  } catch {
    if (existsSync(OPENROUTER_MODELS_CACHE_PATH)) {
      const cacheData = JSON.parse(readFileSync(OPENROUTER_MODELS_CACHE_PATH, "utf-8"));
      return cacheData.models || [];
    }
    return [];
  }
}

// ─── Lazy Proxy Singleton ────────────────────────────────────────────────────
// The proxy runs the same routing engine as the CLI: auto-route, fallback chains,
// custom routing rules, catalog resolution, and all direct provider transports.
// It's started once on first use and reused for all subsequent MCP tool calls.

let proxyInstance: ProxyServer | null = null;
let proxyStarting: Promise<ProxyServer> | null = null;

async function getProxy(): Promise<ProxyServer> {
  if (proxyInstance) return proxyInstance;
  if (proxyStarting) return proxyStarting;

  proxyStarting = (async () => {
    const port = await findAvailablePort(10000, 19999);
    const proxy = await createProxyServer(
      port,
      process.env.OPENROUTER_API_KEY,
      undefined, // no default model — each call specifies its own
      false, // not monitor mode
      process.env.ANTHROPIC_API_KEY,
      undefined, // no model map
      { quiet: true }
    );
    proxyInstance = proxy;
    return proxy;
  })();

  return proxyStarting;
}

/** Parse Anthropic SSE stream and extract text content + usage */
export function parseAnthropicSse(raw: string): {
  text: string;
  usage?: { input: number; output: number };
} {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsage = false;

  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n").filter((l) => l.trim());
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) dataStr += line.slice(6);
    }
    if (!dataStr || dataStr === "[DONE]") continue;

    try {
      const data = JSON.parse(dataStr);
      if (data.type === "message_start" && data.message?.usage) {
        inputTokens = data.message.usage.input_tokens || 0;
        outputTokens = data.message.usage.output_tokens || 0;
        hasUsage = true;
      } else if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
        text += data.delta.text;
      } else if (data.type === "message_delta" && data.usage) {
        outputTokens = data.usage.output_tokens || outputTokens;
        hasUsage = true;
      }
    } catch {
      // Skip unparseable events
    }
  }

  return { text, usage: hasUsage ? { input: inputTokens, output: outputTokens } : undefined };
}

/**
 * Append the contents of local files to a prompt as labeled fenced blocks.
 *
 * Paths resolve against the process working directory. An unreadable or missing
 * file does not fail the call: it is reported inline as a short warning line so
 * the model still sees which file was requested, and the readable files are
 * appended regardless. Returns the prompt unchanged when no files are given.
 */
export function appendFilesToPrompt(prompt: string, files: string[] | undefined): string {
  if (!Array.isArray(files) || files.length === 0) return prompt;
  const blocks = files.map((file) => {
    try {
      const contents = readFileSync(file, "utf-8");
      return `--- ${file} ---\n\`\`\`\n${contents}\n\`\`\``;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `--- ${file} (could not be read: ${msg}) ---`;
    }
  });
  return `${prompt}\n\n${blocks.join("\n\n")}`;
}

export async function runPromptViaProxy(
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number
): Promise<{ content: string; usage?: { input: number; output: number } }> {
  const proxy = await getProxy();

  // Build Anthropic Messages API request
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens || 4096,
    stream: true,
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Proxy error: ${response.status} - ${error}`);
  }

  const raw = await response.text();
  const parsed = parseAnthropicSse(raw);

  if (!parsed.text) {
    throw new Error("Model returned empty response");
  }

  return { content: parsed.text, usage: parsed.usage };
}

function fuzzyScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerText === lowerQuery) return 1;
  if (lowerText.includes(lowerQuery)) return 0.8;
  let score = 0;
  let queryIndex = 0;
  for (const char of lowerText) {
    if (queryIndex < lowerQuery.length && char === lowerQuery[queryIndex]) {
      score++;
      queryIndex++;
    }
  }
  return queryIndex === lowerQuery.length ? score / lowerText.length : 0;
}

/**
 * Two `fuzzyScore` results this close count as EQUAL relevance, and the
 * freshness tiebreak decides. Chosen well below the smallest meaningful gap
 * fuzzyScore can produce (its subsequence branch is `matched / text.length`,
 * so distinct scores differ by at least ~1e-3 for realistic id lengths) and
 * well above float noise.
 */
const SCORE_TIE_EPSILON = 1e-6;

/**
 * Project a raw model record onto the shape `compareByReleaseDateDesc` reads.
 * `loadAllModels` returns the OpenRouter `/api/v1/models` shape, which dates a
 * model with a unix-seconds `created` rather than an ISO `releaseDate`; the
 * Firebase-derived cache rows use `releaseDate`. Accept either.
 */
function orderingKey(model: any): { releaseDate?: string; id?: string } {
  const releaseDate =
    typeof model?.releaseDate === "string"
      ? model.releaseDate
      : typeof model?.created === "number" && Number.isFinite(model.created)
        ? new Date(model.created * 1000).toISOString()
        : undefined;
  return { releaseDate, id: typeof model?.id === "string" ? model.id : "" };
}

/**
 * The action a caller should take for each failure class. Deterministic strings
 * so the agent branches on a known value instead of parsing prose.
 */
const NEXT_STEP: Record<string, string> = {
  nonzero_exit: "read the evidence log, then retry or drop the model",
  cancelled:
    "you stopped this slot; nothing is wrong with it. Re-run it if you still want its vote",
  timeout: "grid mode only — magmux ended the pane. The orchestrator has no deadline",
  api_error: "retry once, or route via a different provider (or@<model>)",
  background_task_ceiling:
    "set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 for children, or forbid background work in the prompt",
  empty_output: "retry once; if it repeats, drop the model",
  shape_mismatch:
    "the response does not carry the shape you required. Every assistant message the " +
    "child emitted was captured, so nothing was lost in transit — the model did not " +
    "produce it. Re-prompt with the required format restated; do NOT count this slot " +
    "as a vote",
};

/** `18864` → `18.4KB`. */
function fmtSize(n: number): string {
  if (n <= 0) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Render a team run as a compact, self-delimiting card.
 *
 * Deliberately does NOT emit `JSON.stringify(status)` and does NOT inline raw
 * stderr/stdout. The previous implementation did both, which billed every
 * snippet TWICE — once JSON-escaped in the dump, once raw in the markdown block.
 * Measured worst case (6 models, 3 failures, both snippets at their 2000-char
 * cap): 28,403 B delivered, 12,000 B of it pure duplication (42%).
 *
 * Nothing is lost. Machine-readable status stays one `mode: "status"` call away
 * and on disk at `<session>/status.json`; full stderr/stdout stay in
 * `<session>/errors/<id>.log`, which the card names per failure. The card itself
 * carries reason + one-line detail + next step, which is what a caller needs to
 * decide, without paying for evidence it may never read.
 *
 * Self-delimiting because MCP `resource_link` blocks arrive flattened into the
 * text stream with no separator — a consumer must be able to see where this ends.
 */
/**
 * Build the flag list handed to every child Claude Code process.
 *
 * Two inputs, deliberately: `agent` is first-class because selecting a
 * subagent is the common case and a caller should not have to know the flag
 * spelling, and `claude_flags` stays open because claudish forwards ANY
 * unrecognised flag to Claude Code (cli.ts catch-all) — so `--effort`,
 * `--permission-mode`, `--allowedTools` and anything added later work without
 * a claudish release.
 *
 * The dedicated parameter WINS: if `claude_flags` also carries an `--agent`,
 * that pair is dropped rather than emitted twice, so the effective agent is
 * always the one the caller named explicitly.
 */
export function buildChildClaudeFlags(agent: unknown, claudeFlags: unknown): string[] | undefined {
  const extra = typeof claudeFlags === "string" ? claudeFlags.split(/\s+/).filter(Boolean) : [];
  const named = typeof agent === "string" ? agent.trim() : "";

  if (named.startsWith("-")) {
    throw new Error(
      `Invalid 'agent': ${named}. Expected a subagent name (e.g. "dev:reviewer"), not a flag.`
    );
  }

  const cleaned: string[] = [];
  for (let i = 0; i < extra.length; i++) {
    const tok = extra[i];
    // ONLY `--agent`. NOT `--agents`, which is an unrelated Claude Code flag
    // ("--agents <json>: JSON object defining custom agents") — stripping it
    // would silently discard the caller's custom agent DEFINITIONS while they
    // believe they were passed.
    if (named && (tok === "--agent" || tok.startsWith("--agent="))) {
      // Skip the flag and, for the space-separated form, its value. A dangling
      // `--agent` with no value drops just the flag.
      if (tok === "--agent" && extra[i + 1] && !extra[i + 1].startsWith("-")) i++;
      continue;
    }
    cleaned.push(tok);
  }

  const flags = [...(named ? ["--agent", named] : []), ...cleaned];
  return flags.length > 0 ? flags : undefined;
}

/**
 * The prose that stops a caller reading `outputSize` as progress.
 *
 * A slot's `outputSize` is written once, when it finishes, so a RUNNING slot
 * always reports 0. Real orchestrators have read that 0 next to a 20-minute-old
 * `startedAt` and concluded the slot produced nothing; one then had to reason its
 * way back out in front of the user. The note leads with that, because a caller
 * skimming a JSON blob reads the first clause and stops.
 *
 * Returned only while something is still RUNNING — on a settled run the states
 * are final, `outputSize` means exactly what it says, and this would be noise.
 */
export function teamStatusNote(opts: { anyRunning: boolean; live: boolean }): string | undefined {
  if (!opts.anyRunning) return undefined;
  const trap =
    "outputSize is the size of the FINAL answer and is written once, when a slot " +
    "finishes. Every RUNNING slot therefore reports 0 however much work it has done: " +
    "it is NOT a progress signal, and 0 there does not mean the slot produced nothing.";
  // No live handles means this server did not spawn the run, or was restarted
  // under it. Promising fields that are null would send the reader after
  // evidence that is not there.
  if (!opts.live) {
    return (
      `${trap} This run is not live in this process — it was started elsewhere, or this ` +
      "server restarted — so there are no liveness fields for it and the states above are " +
      "whatever was last written to status.json."
    );
  }
  return (
    `${trap} Judge a running slot on three fields read TOGETHER: ` +
    "live_output_bytes_by_slot (answer bytes so far, the number outputSize will become), " +
    "idle_seconds_by_slot (seconds of silence) and activity_by_slot (what it is doing). " +
    "Silence in tool_executing is a build or test suite running, and is not a failure " +
    'signal. Nothing cancels on your behalf — use mode:"cancel" if you decide to.'
  );
}

/**
 * Assemble the `status` response. Pure and exported so the contract above can be
 * tested without spawning a run: every liveness input is a parameter.
 */
export function buildTeamStatusPayload(opts: {
  status: import("./team-orchestrator.js").TeamStatus;
  sessionPath: string;
  idle: Record<string, number> | null;
  activity: Record<string, string> | null;
  liveBytes: Record<string, number> | null;
}): Record<string, unknown> {
  const { status, sessionPath, idle, activity, liveBytes } = opts;
  const anyRunning = Object.values(status.models).some((m) => m.state === "RUNNING");
  // Keyed on RUNNING, not on liveness. A run this server never spawned can still
  // show RUNNING slots from a stale status.json, and that is precisely a reader
  // who is about to misjudge an `outputSize` of 0.
  const note = teamStatusNote({ anyRunning, live: idle !== null });
  return {
    ...status,
    // Bytes of answer produced SO FAR, per still-running slot. `outputSize` cannot
    // answer this — see teamSlotLiveBytes.
    live_output_bytes_by_slot: liveBytes,
    idle_seconds_by_slot: idle,
    // What each slot is DOING, which is what makes the idle number readable.
    // Silence in `tool_executing` is a build; the same silence in `running` is a
    // stalled answer.
    activity_by_slot: activity,
    ...(note ? { note } : {}),
    // The rendered result card, once there is a result to render. This is the
    // summary `run` used to return before it stopped waiting; a settled `status`
    // is now where it belongs, since that is the call that knows the outcome.
    ...(anyRunning ? {} : { summary: formatTeamResult(status, sessionPath) }),
  };
}

export function formatTeamResult(
  status: import("./team-orchestrator.js").TeamStatus,
  sessionPath: string
): string {
  const entries = Object.entries(status.models).sort(([a], [b]) => a.localeCompare(b));
  // EMPTY belongs with the failures: the process exited 0 but produced no usable
  // answer. Filing it under "succeeded" is what forced callers to infer failure
  // from outputSize by hand.
  const failed = entries.filter(
    ([, m]) => m.state === "FAILED" || m.state === "TIMEOUT" || m.state === "EMPTY"
  );
  const succeeded = entries.filter(([, m]) => m.state === "COMPLETED");

  const lines: string[] = [];
  lines.push(`<<<TEAM_RESULT path="${sessionPath}">>>`);
  lines.push(
    `status: ${failed.length === 0 ? "ok" : succeeded.length === 0 ? "all-failed" : "partial"}` +
      ` — ${succeeded.length}/${entries.length} succeeded`
  );

  if (succeeded.length > 0) {
    lines.push("succeeded:");
    for (const [id, m] of succeeded) {
      lines.push(`  ${id}  ${fmtSize(m.outputSize)}  response-${id}.md`);
    }
  }

  if (failed.length > 0) {
    lines.push("failures:");
    for (const [id, m] of failed) {
      const reason = m.error?.reason ?? "unknown";
      const next = NEXT_STEP[reason] ?? "read the evidence log";
      lines.push(`  ${id}  ${m.state}  reason=${reason}`);
      if (m.error?.detail) lines.push(`      what: ${m.error.detail}`);
      lines.push(`      next: ${next}`);
      if (m.error?.errorLogPath) {
        lines.push(`      evidence: ${m.error.errorLogPath}`);
      } else {
        lines.push("      evidence: NONE CAPTURED — orchestrator bug, report via report_error");
      }
    }
    lines.push("actions:");
    lines.push("  full stderr/stdout for one failure  → Read the evidence path above");
    lines.push(
      `  machine-readable status             → team(mode="status", path="${sessionPath}")`
    );
    lines.push(
      `  report a provider bug               → report_error(session_path="${sessionPath}")`
    );
  }

  lines.push("<<<END_TEAM_RESULT>>>");
  return lines.join("\n");
}

/**
 * `report_error` sends data OFF this machine, so it gets the full treatment:
 * credentials AND the personal details that identify the user.
 *
 * Replaces a local implementation that knew only `sk-` keys — it missed Google
 * (`AIza…`), xAI, JWTs, GitHub tokens, and every `_TOKEN` / `_SECRET` / `_KEY`
 * variable that wasn't literally named `*_API_KEY`.
 */
const sanitize = sanitizeForReport;

// ─── Tool Definitions ────────────────────────────────────────────────────────

/**
 * Pushes a live progress frame to the client, or is a no-op when the channel
 * capability is not enabled. `team` uses this to report per-model token/cost
 * stats while a multi-minute run is still in flight.
 *
 * Channels are the ONLY measured-working push mechanism FOR RENDERING:
 * `notifications/progress` renders nowhere on Claude Code 2.1.220 — verified empty
 * in both the agent's context and the interactive terminal UI. See
 * ai-docs/sessions/dev-arch-20260729-171308-1dad34b5/capability-findings.md.
 *
 * That says nothing about KEEPALIVE, which is the opposite result: a progress frame
 * resets the client's MCP idle timer and a channel frame does not (measured
 * 2026-08-14 on 2.1.231 — a real `team` run died at exactly 1800s while emitting
 * channel frames throughout). See
 * ai-docs/sessions/mcp-progress-idle-timeout-20260814-000000-b7e21f4a/findings.md.
 * The two mechanisms are complementary and both stay: channel is the visible
 * surface, `notifications/progress` (mcp/progress-heartbeat.ts) is the keepalive.
 */
type ChannelNotifier = (params: {
  content: string;
  sessionId: string;
  event: string;
  model: string;
  elapsedSeconds: number;
  createdAt: string;
}) => void;

function defineTools(
  sessionManager: SessionManager,
  notifyChannel: ChannelNotifier
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ── Low-Level Tools ──────────────────────────────────────────────────

  /**
   * Append the 1Password failure block to an error a tool is about to return.
   *
   * Every op-source failure is deliberately non-fatal — a broken import must never
   * lock the user out — so the only report was `warnOnce` on STDERR. An MCP host
   * captures that stream and shows the user nothing, which is exactly why a
   * 1Password problem here reads as silence rather than an error: claudish was
   * explaining itself into a pipe nobody reads. Splicing the block into the tool
   * RESULT puts the explanation where the agent and the user will actually see it.
   *
   * Returns the message unchanged when 1Password played no part this run, so
   * non-op users and unrelated failures see byte-identical output.
   */
  function withOpFailureContext(message: string, subject: string): string {
    const block = renderOpFailureBlock(subject);
    return block.length === 0 ? message : `${message}\n\n${block.join("\n")}`;
  }

  tools.push({
    name: "run_prompt",
    description:
      "Run a prompt through any model — supports all providers (Kimi, GLM, Qwen, MiniMax, Gemini, GPT, Grok, etc.) with auto-routing, fallback chains, and custom routing rules.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Model name or ID. Short names auto-route to the best provider (e.g., 'kimi-k2.5', 'glm-5', 'gpt-5.4'). Provider prefix optional (e.g., 'google@gemini-3.1-pro-preview', 'or@x-ai/grok-3').",
        },
        prompt: { type: "string", description: "The prompt to send to the model" },
        system_prompt: { type: "string", description: "Optional system prompt" },
        max_tokens: { type: "number", description: "Maximum tokens in response (default: 4096)" },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Local file paths whose contents are appended to the prompt as labeled code blocks",
        },
      },
      required: ["model", "prompt"],
    },
    group: "low-level",
    // A single reasoning model can block for many minutes with nothing on the
    // wire. Handler body unchanged — the dispatch owns the keepalive.
    heartbeat: true,
    handler: async (args) => {
      try {
        const result = await runPromptViaProxy(
          args.model as string,
          appendFilesToPrompt(args.prompt as string, args.files as string[] | undefined),
          args.system_prompt as string | undefined,
          args.max_tokens as number | undefined
        );
        let response = result.content;
        if (result.usage) {
          response += `\n\n---\nTokens: ${result.usage.input} input, ${result.usage.output} output`;
        }
        return { content: [{ type: "text" as const, text: response }] };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: withOpFailureContext(
                `Error: ${errMsg}\n\n---\n**To report this error**, use the \`report_error\` tool with \`error_type: "provider_failure"\` and \`model: "${args.model}"\`.`,
                `while routing ${args.model}`
              ),
            },
          ],
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "list_models",
    description: "List recommended models for coding tasks",
    inputSchema: { type: "object" },
    group: "low-level",
    handler: async () => {
      let doc: RecommendedModelsDoc;
      try {
        doc = await getRecommendedModels();
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "No recommended models found. Try search_models instead.",
            },
          ],
        };
      }
      if (!doc.models || doc.models.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No recommended models found. Try search_models instead.",
            },
          ],
        };
      }

      const { flagship, fast } = groupRecommendedModels(doc.models);

      // Native-prefix lookup: vendor slug → its native API provider → shortcuts[0].
      const providerByName = new Map(BUILTIN_PROVIDERS.map((p) => [p.name, p] as const));
      const getNativePrefix = (firebaseSlug: string): string | null => {
        const canonical = nativeProviderForVendor(firebaseSlug);
        if (!canonical) return null;
        const def = providerByName.get(canonical);
        if (!def || !def.shortcuts || def.shortcuts.length === 0) return null;
        return def.shortcuts[0];
      };

      const renderGroup = (group: RecommendedModelGroup): string => {
        const m = group.primary;
        const pricing = formatListingPrice(m);
        const ctx = m.context || "N/A";
        const caps: string[] = [];
        if (m.supportsTools) caps.push("tools");
        if (m.supportsReasoning) caps.push("reasoning");
        if (m.supportsVision) caps.push("vision");
        const capsLine = caps.length > 0 ? caps.join(", ") : "none";

        const prefixes = collectRoutingPrefixes(group, getNativePrefix);
        const accessLine =
          prefixes.length > 0 ? prefixes.map((p) => `\`${p}@${m.id}\``).join(" · ") : `\`${m.id}\``;

        return [
          `### ${m.id}`,
          `- **Pricing**: ${pricing} avg · ${ctx} context`,
          `- **Capabilities**: ${capsLine}`,
          `- **Access**: ${accessLine}`,
          "",
        ].join("\n");
      };

      let output = "# Recommended Models\n\n";
      output += `_Last updated: ${doc.lastUpdated || "unknown"}_\n\n`;

      if (flagship.length > 0) {
        output += "## Flagship models\n\n";
        for (const group of flagship) output += renderGroup(group);
      }

      if (fast.length > 0) {
        output += "## Fast variants\n\n";
        for (const group of fast) output += renderGroup(group);
      }

      // Quick picks — over the deduped primaries
      const primaries = [...flagship, ...fast].map((g) => g.primary);
      const picks = computeQuickPicks(primaries);
      const pickLines: string[] = [];
      if (picks.budget)
        pickLines.push(
          `- **Budget**: \`${picks.budget.id}\` (${normalizePricingDisplay(
            picks.budget.pricing?.average
          )})`
        );
      if (picks.largeContext)
        pickLines.push(
          `- **Large context**: \`${picks.largeContext.id}\` (${
            picks.largeContext.context || "N/A"
          })`
        );
      if (picks.mostCapable) pickLines.push(`- **Most capable**: \`${picks.mostCapable.id}\``);
      if (picks.visionCoding) pickLines.push(`- **Vision + coding**: \`${picks.visionCoding.id}\``);
      if (picks.agentic) pickLines.push(`- **Agentic**: \`${picks.agentic.id}\``);

      if (pickLines.length > 0) {
        output += "## Quick picks\n\n";
        output += `${pickLines.join("\n")}\n`;
      }

      return { content: [{ type: "text" as const, text: output }] };
    },
  });

  tools.push({
    name: "search_models",
    description:
      "Search OpenRouter's listing by name, provider, or capability, and cross-reference " +
      "claudish's own catalog. SCOPE: the listing covers OpenRouter only, so a name's " +
      "absence from it is NOT evidence the name is unroutable — subscription wire ids " +
      "(`k3`) and catalog aliases live outside that namespace and are reported separately " +
      "here.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g., 'grok', 'vision', 'free')" },
        limit: { type: "number", description: "Maximum results to return (default: 10)" },
      },
      required: ["query"],
    },
    group: "low-level",
    handler: async (args) => {
      const query = args.query as string;
      const maxResults = (args.limit as number) || 10;
      const allModels = await loadAllModels();
      if (allModels.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Failed to load models. Check your internet connection.",
            },
          ],
          isError: true,
        };
      }
      const results = allModels
        .map((model: any) => {
          const nameScore = fuzzyScore(model.name || "", query);
          const idScore = fuzzyScore(model.id || "", query);
          const descScore = fuzzyScore(model.description || "", query) * 0.5;
          return { model, score: Math.max(nameScore, idScore, descScore) };
        })
        .filter((item: any) => item.score > 0.2)
        // RELEVANCE stays primary — a search must never rank a stale exact
        // match below a fresh fuzzy one. Freshness is the TIEBREAK, which is
        // what decides the many exact ties fuzzyScore produces (1 for an exact
        // match, 0.8 for any substring hit). Scores are floats, so compare them
        // with an epsilon rather than `===`; otherwise a 1e-17 difference
        // between two "equal" subsequence scores would silently keep the old
        // arbitrary insertion order.
        .sort((a: any, b: any) => {
          if (Math.abs(a.score - b.score) > SCORE_TIE_EPSILON) return b.score - a.score;
          return compareByReleaseDateDesc(orderingKey(a.model), orderingKey(b.model));
        })
        .slice(0, maxResults);
      // The listing above is ONE namespace. Subscription wire ids (`k3`) and
      // catalog identities live outside it, so a miss here is not evidence a
      // name is unroutable — and that inference is exactly what sends callers
      // to a metered route. Always report what the catalog knows alongside it.
      const catalogMatches = searchCatalogModels(query, Math.max(maxResults, 5));
      const renderCatalogSection = (): string => {
        if (catalogMatches.length === 0) return "";
        let s = "\n## Catalog names (what claudish routes)\n\n";
        s += "| Bare name | Matched alias | Subscription plan |\n";
        s += "|-----------|---------------|-------------------|\n";
        for (const m of catalogMatches) {
          const plans = m.subscriptionPlanIds.length > 0 ? m.subscriptionPlanIds.join(", ") : "-";
          s += `| ${m.modelId} | ${m.matchedAlias ?? "-"} | ${plans} |\n`;
        }
        s +=
          "\nPass the **bare name**. Routing puts a subscription ahead of the metered API and " +
          "rewrites the model to that plan's wire id for you. An aggregator-qualified id " +
          "(`moonshotai/...`, `accounts/fireworks/...`) pins that aggregator and bills per token.\n";
        return s;
      };

      if (results.length === 0) {
        const catalog = renderCatalogSection();
        const text = catalog
          ? `No OpenRouter listing matches "${query}", but claudish's catalog knows these:\n${catalog}`
          : `No models found matching "${query}".\n\n` +
            "This searched OpenRouter's listing only. Subscription wire ids and catalog " +
            "aliases are not in it, so this is not proof the name is unroutable. Call " +
            "`list_models` for the recommended set.";
        return { content: [{ type: "text" as const, text }] };
      }
      let output = `# Search Results for "${query}"\n\n`;
      output += "## OpenRouter listing\n\n";
      output += "| Model | Provider | Pricing | Context |\n";
      output += "|-------|----------|---------|----------|\n";
      for (const { model } of results) {
        const provider = model.id.split("/")[0];
        const promptPrice = Number.parseFloat(model.pricing?.prompt || "0") * 1000000;
        const completionPrice = Number.parseFloat(model.pricing?.completion || "0") * 1000000;
        const avgPrice = (promptPrice + completionPrice) / 2;
        const pricing =
          avgPrice > 0 ? `$${avgPrice.toFixed(2)}/1M` : avgPrice < 0 ? "varies" : "FREE";
        const context = model.context_length
          ? `${Math.round(model.context_length / 1000)}K`
          : "N/A";
        output += `| ${model.id} | ${provider} | ${pricing} | ${context} |\n`;
      }
      output += renderCatalogSection();
      // Suggest the BARE catalog name, never the top aggregator id. The old
      // footer recommended whatever the listing ranked first — for "kimi" that
      // was `accounts/fireworks/routers/kimi-k3-fast`, a metered address, so
      // the tool's own advice routed users off their subscription.
      const suggested = catalogMatches[0]?.modelId ?? results[0].model.id;
      output += `\nUse with: run_prompt(model="${suggested}", prompt="your prompt")`;
      return { content: [{ type: "text" as const, text: output }] };
    },
  });

  tools.push({
    name: "compare_models",
    description: "Run the same prompt through multiple models and compare responses",
    inputSchema: {
      type: "object",
      properties: {
        models: {
          type: "array",
          items: { type: "string" },
          description: "List of model IDs to compare",
        },
        prompt: { type: "string", description: "The prompt to send to all models" },
        system_prompt: { type: "string", description: "Optional system prompt" },
        max_tokens: {
          type: "number",
          description: "Maximum tokens in response (omit to let model decide)",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Local file paths whose contents are appended to the prompt as labeled code blocks",
        },
      },
      required: ["models", "prompt"],
    },
    group: "low-level",
    // N models run SEQUENTIALLY below, so the total blocking time is the sum of
    // every model's latency — the easiest of the three tools to push past the
    // client's idle window.
    heartbeat: true,
    handler: async (args, ctx) => {
      const modelIds = args.models as string[];
      // `prompt` stays the user's text for the comparison header and progress
      // notes; the file-augmented form is what each model actually receives.
      const prompt = args.prompt as string;
      const promptWithFiles = appendFilesToPrompt(prompt, args.files as string[] | undefined);
      const systemPrompt = args.system_prompt as string | undefined;
      const maxTokens = args.max_tokens as number | undefined;

      // Ordering: ARGUMENT order, deliberately. The caller chose this sequence
      // and reads the comparison against it, so the repo-wide newest-first
      // display rule does NOT apply here.
      const results: Array<{
        model: string;
        response: string;
        error?: string;
        tokens?: { input: number; output: number };
      }> = [];
      for (const model of modelIds) {
        try {
          const result = await runPromptViaProxy(model, promptWithFiles, systemPrompt, maxTokens);
          results.push({ model, response: result.content, tokens: result.usage });
        } catch (error) {
          results.push({
            model,
            response: "",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Belt-and-braces: the periodic timer alone already suffices, but a
        // completed model is real news, so refresh the idle timer at that moment
        // too. Counts only — no model output, no prompt text.
        ctx.reportProgress(`compare_models: ${results.length}/${modelIds.length} models done`);
      }

      let output = "# Model Comparison\n\n";
      output += `**Prompt:** ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}\n\n`;
      for (const result of results) {
        output += `## ${result.model}\n\n`;
        if (result.error) {
          output += `**Error:** ${result.error}\n\n`;
        } else {
          output += `${result.response}\n\n`;
          if (result.tokens) {
            output += `*Tokens: ${result.tokens.input} in, ${result.tokens.output} out*\n\n`;
          }
        }
        output += "---\n\n";
      }
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        output +=
          '---\n**To report failed model(s)**, use the `report_error` tool with `error_type: "provider_failure"` and the model ID(s) above.\n';
      }
      return { content: [{ type: "text" as const, text: output }] };
    },
  });

  // ── Agentic Tools ────────────────────────────────────────────────────

  tools.push({
    name: "preflight",
    description:
      "DIAGNOSTIC. For a list of models, report which provider would serve each, " +
      "whether that hop is subscription or metered, and whether it is reachable right " +
      "now. This is for a human investigating a model list. It is NOT a step before " +
      "`team`, `create_session` or `run_prompt` — those resolve their own routing, and " +
      "a caller that hands them a bare model name never needs to know the route.",
    inputSchema: {
      type: "object",
      properties: {
        models: {
          type: "array",
          items: { type: "string" },
          description:
            "Model ids to check — bare (`glm-5.2`) or explicit (`dv@swe-1.7`). Bare names go " +
            "through the SAME routing rules and credential filter a real run would use, so " +
            "the provider reported here is the provider that would serve it.",
        },
        probe: {
          type: "boolean",
          description:
            "Send a real short request to each resolved route (default true). Set false for " +
            "a routing/billing answer only — far faster, but it cannot tell you the provider " +
            "is actually reachable, which is the failure this tool exists to catch.",
        },
        timeout_ms: {
          type: "number",
          description: "Per-model probe timeout in ms (default 20000).",
        },
      },
      required: ["models"],
    },
    group: "agentic",
    // N models each waiting on a live provider can sit well past the client's MCP
    // idle window, and this tool is specifically meant to be called with a big
    // model list — exactly the shape that gets aborted without a keepalive.
    heartbeat: true,
    handler: async (args, ctx) => {
      const models = Array.isArray(args.models) ? (args.models as string[]) : [];
      if (models.length === 0) {
        return {
          content: [{ type: "text" as const, text: "preflight: no models given." }],
          isError: true,
        };
      }

      const doProbe = args.probe !== false;
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 20_000;
      // Start the proxy only if something will actually be probed. Native names
      // never are (see the loop), so an all-native model list must neither wait on
      // proxy startup nor throw from it.
      const needsProxy = doProbe && models.some((m) => nativeRouteFor(m) === null);
      const proxy = needsProxy ? await getProxy() : null;

      // Register runtime providers before ANY `route()` call below.
      //
      // `preflight` exists to answer "which provider would serve this, and can it
      // right now" before a caller commits slots to a `team` run. Asking that
      // against a registry that has never been populated makes every bundled
      // catalog row and every user `customEndpoints` entry invisible, so a model
      // that works reports "no credentialed provider" — the exact failure mode
      // preflight exists to prevent, produced by preflight itself. Eighth surface
      // of #192; `--probe`, the picker and `providers --json` were the others.
      //
      // Sync, latched, config-only. Free after the first call.
      ensureEndpointsRegistered();

      const rows: string[] = [];
      const readyModels: string[] = [];
      const failedModels: string[] = [];
      const nativeModels: string[] = [];
      let subCount = 0;
      let meteredCount = 0;

      for (const model of models) {
        ctx.reportProgress(`preflight: ${model}`);

        // A bare Claude name never reaches route(): the proxy serves it on the
        // harness's own auth and checks for that BEFORE routing. route() cannot
        // see that path — `native-anthropic` has no credential store, so its
        // filter drops it and the chain degrades to OpenRouter — and preflight
        // was reporting subscription models as "no route" / "metered".
        const native = nativeRouteFor(model);
        if (native) {
          // Deliberately NOT probed. The native handler authenticates by forwarding
          // the INBOUND request's Claude Code header (native-handler.ts) and only
          // falls back to ANTHROPIC_API_KEY. A synthetic probe from this process
          // carries neither, so it fails "x-api-key header is required" for a
          // healthy model and a typo alike — measured on the built bundle. That
          // result is noise, and reporting it drove the very "drop your own
          // model" advice this guard exists to stop. Counted in its own bucket,
          // neither ready nor failed: the proxy will serve it on the session's
          // auth, and that is all this process can say.
          nativeModels.push(model);
          rows.push(
            `| \`${model}\` | ${native.displayName} | native | ${NATIVE_NOT_PROBED} | \`${native.modelSpec}\` |`
          );
          continue;
        }

        let plan: Awaited<ReturnType<typeof route>>;
        try {
          plan = await route(model);
        } catch (err) {
          failedModels.push(model);
          rows.push(
            `| \`${model}\` | — | — | ❌ route error | ${err instanceof Error ? err.message : String(err)} |`
          );
          continue;
        }

        if (plan.kind === "no-route") {
          // No credentialed provider can serve this at all. Reported as a FAILURE
          // rather than omitted, because "none of your credentials reaches this model" is the
          // single most useful thing to learn before the run rather than during it.
          failedModels.push(model);
          rows.push(`| \`${model}\` | — | — | ❌ no route | ${plan.reason} |`);
          continue;
        }

        const primary = plan.primary;
        // Billing mode is a property of the PROVIDER, not the model — the same
        // model can be flat-rate through a plan and metered through a vendor API,
        // and which one a bare name lands on is exactly what a caller cannot see.
        const billing = isLocalProviderName(primary.provider)
          ? "local"
          : isSubscriptionProvider(primary.provider)
            ? "SUB"
            : "metered";
        if (billing === "SUB") subCount++;
        else if (billing === "metered") meteredCount++;

        let status = "not probed";
        let ok = true;
        if (proxy) {
          try {
            const result = await probeLink(
              proxy.url,
              {
                provider: primary.provider,
                // route() already credential-filtered, so a miss here would be a
                // routing bug, not a missing key.
                modelSpec: primary.modelSpec,
                hasCredentials: true,
              },
              timeoutMs
            );
            ok = isReadyState(result.state);
            status = ok
              ? `✅ ${result.state}`
              : `❌ ${result.state}${result.errorMessage ? ` — ${result.errorMessage}` : ""}`;
          } catch (err) {
            ok = false;
            status = `❌ probe error — ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        if (ok) readyModels.push(model);
        else failedModels.push(model);

        const fallbacks = plan.fallbacks.length > 0 ? ` (+${plan.fallbacks.length} fallback)` : "";
        rows.push(
          `| \`${model}\` | ${primary.displayName}${fallbacks} | ${billing} | ${status} | \`${primary.modelSpec}\` |`
        );
      }

      const lines = [
        `# Preflight — ${models.length} model${models.length === 1 ? "" : "s"}`,
        "",
        `**Ready: ${readyModels.length}** · **Failed: ${failedModels.length}** · ` +
          (nativeModels.length > 0 ? `native (not probed): ${nativeModels.length} · ` : "") +
          `subscription: ${subCount} · metered: ${meteredCount}`,
        "",
        "| Model | Provider | Billing | Status | Wire id |",
        "|---|---|---|---|---|",
        ...rows,
      ];

      if (failedModels.length > 0) {
        lines.push(
          "",
          `⚠️ Drop or replace before running: ${failedModels.map((m) => `\`${m}\``).join(", ")}`
        );
      }
      if (meteredCount > 0) {
        lines.push(
          "",
          `💸 ${meteredCount} model${meteredCount === 1 ? "" : "s"} will be billed PER TOKEN. ` +
            "A bare name can land on a metered provider when the subscription that covers it " +
            "has no credential configured — name the provider explicitly to pin it."
        );
      }
      if (!doProbe) {
        lines.push(
          "",
          "ℹ️ `probe: false` — routing and billing only. Reachability was NOT checked."
        );
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  tools.push({
    name: "team",
    description:
      "Run AI models on a task with anonymized outputs and optional blind judging. " +
      "Modes: 'run' (START the models and return a slot map immediately — it does NOT " +
      "wait), 'status' (per-slot state, plus live answer bytes, seconds of silence and " +
      "current activity per slot), " +
      "'cancel' (stop one slot or the whole run), 'judge' (blind-vote on existing " +
      "outputs), 'run-and-judge' (the blocking pipeline). " +
      "NO SLOT IS EVER KILLED ON A TIMER. A team slot is a full Claude Code session and " +
      "may work for a long time; a slot inside a build or test suite emits nothing for " +
      "minutes and is working, not stuck. Poll 'status', judge the silence against the " +
      "task you set, and use 'cancel' if you decide a slot is wedged. " +
      "JUDGING A RUNNING SLOT: read live_output_bytes_by_slot, idle_seconds_by_slot and " +
      "activity_by_slot. Do NOT use 'outputSize' — it is the size of the final answer, " +
      "written only when a slot finishes, so it is 0 for every running slot no matter how " +
      "much that slot has produced.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["run", "judge", "run-and-judge", "status", "cancel"],
          description:
            "Operation mode. 'run' STARTS the models and returns immediately with a " +
            "slot map — it does not wait. Poll 'status' for progress (read it from " +
            "live_output_bytes_by_slot and activity_by_slot, never from outputSize, " +
            "which stays 0 until a slot finishes), then 'judge' once the slots have " +
            "finished. 'run-and-judge' is the blocking pipeline and holds the call open " +
            "for the whole run. 'cancel' stops one slot or the whole run.",
        },
        slot: {
          type: "string",
          description:
            "For 'cancel': the anonymised slot id to stop (e.g. '02'), from the slot map " +
            "'run' returned. Omit to cancel every slot in the run.",
        },
        path: {
          type: "string",
          description: "Session directory path (must be within current working directory)",
        },
        models: {
          type: "array",
          items: { type: "string" },
          description:
            "Model IDs to run (required for 'run' and 'run-and-judge' modes). " +
            "Native Claude names ARE runnable slots and belong in this array alongside " +
            "external models: 'internal'/'default' select the default tier, and " +
            "'opus'/'sonnet'/'haiku'/'claude-*' select a specific one. They run on the " +
            "user's Claude subscription through the native passthrough (no API key, no " +
            "translation), and — unlike a Task agent — they are covered by require_pattern, " +
            "so a native reviewer that never produced the required shape is reported FAILED " +
            "instead of silently succeeding.",
        },
        judges: {
          type: "array",
          items: { type: "string" },
          description: "Model IDs to use as judges (default: same as runners)",
        },
        input_file: {
          type: "string",
          description:
            "PREFERRED. Path to a file holding the task prompt, relative to the working " +
            "directory. Use this rather than `input` for anything longer than a sentence: " +
            "a prompt passed inline is echoed verbatim in the caller's terminal, where a " +
            "200-line review brief buries every other argument and makes the call " +
            "unreadable. Write the brief to the session directory first (input.md is the " +
            "conventional name) and point here.",
        },
        input: {
          type: "string",
          description:
            "Task prompt as inline text. Prefer `input_file` — inline text is rendered in " +
            "full in the caller's terminal. Passing both is an error. If neither is given, " +
            "an input.md already present in the session directory is used.",
        },
        require_pattern: {
          type: "string",
          description:
            "Regex the response MUST match, or the slot is reported FAILED (state EMPTY, " +
            "reason 'shape_mismatch') instead of succeeded. Strongly recommended whenever " +
            "your prompt mandates an output shape — e.g. '```vote' for a voting panel. " +
            "Exit code 0 is not a success oracle: it is 0 on API errors and on a child " +
            "that simply never followed the format. Answers are no longer LOST to print " +
            "mode (every assistant message is captured), so a mismatch now means the model " +
            "did not produce the shape, not that the shape was discarded.",
        },
        min_output_bytes: {
          type: "number",
          description:
            "Report a slot FAILED if it produced fewer than this many bytes (default 0 = " +
            "off). A blunter instrument than require_pattern — short answers can be " +
            "legitimate — so prefer require_pattern when you know the expected shape.",
        },
        agent: {
          type: "string",
          description:
            "Claude Code subagent every child runs as, e.g. 'dev:reviewer', 'dev:architect'. " +
            "Each child is a full Claude Code session, so this loads that agent's system " +
            "prompt and tool allowlist — the same specialisation a Task agent gets, but " +
            "inside the team run, where require_pattern still applies. Applies to EVERY " +
            "model in the run (native and external alike); there is no per-model form.",
        },
        claude_flags: {
          type: "string",
          description:
            "Any other Claude Code flags, space-separated (e.g. '--effort high " +
            "--permission-mode plan'). Unrecognised flags pass straight through to the " +
            "child Claude Code, so anything Claude Code accepts works here. Prefer the " +
            "dedicated 'agent' parameter for the subagent; an --agent given here is " +
            "ignored when 'agent' is also set. NOTE: split on whitespace, so a flag " +
            'VALUE containing spaces (e.g. --append-system-prompt "two words") cannot ' +
            "be expressed here.",
        },
      },
      required: ["mode", "path"],
    },
    group: "agentic",
    // The tool the whole keepalive exists for: a real run was aborted at exactly
    // 1800s of channel-frame-only silence. NOT gated on `channelEnabled` — that
    // failure happened in a session with channels unregistered, so gating the
    // keepalive behind the channel group would reproduce the bug exactly.
    //
    // Still needed even though `run` no longer blocks: `run-and-judge` is the
    // pipeline mode and holds the call open for the whole run, which is exactly
    // the shape that hit the ceiling. `run` returning early does not remove the
    // exposure, it just stops the common path from carrying it.
    //
    // The background run keeps calling `ctx.reportProgress` after `run` has
    // returned. That is safe by contract — see ToolCallContext: a no-op once the
    // heartbeat is stopped, and it never throws.
    heartbeat: true,
    handler: async (args, ctx) => {
      try {
        const mode = args.mode as string;
        const path = args.path as string;
        const models = args.models as string[] | undefined;
        const judges = args.judges as string[] | undefined;
        // `input_file` is the preferred form: a team prompt is usually a long
        // brief, and inline text is echoed in full in the caller's terminal.
        // Accepting both would silently pick one and discard the other, which is
        // the kind of thing a caller only discovers from the models' answers.
        const inlineInput = args.input as string | undefined;
        const inputFile = args.input_file as string | undefined;
        if (inlineInput !== undefined && inputFile !== undefined) {
          throw new Error(
            "Pass `input_file` or `input`, not both. Prefer `input_file` — inline text is " +
              "rendered verbatim in the caller's terminal."
          );
        }
        const input = inputFile !== undefined ? readTeamInputFile(inputFile) : inlineInput;
        const requirePattern = args.require_pattern as string | undefined;
        const minOutputBytes = args.min_output_bytes as number | undefined;
        const childFlags = buildChildClaudeFlags(args.agent, args.claude_flags);
        // Reject an unknown agent BEFORE spawning N children. `team` spawns with
        // --stdin so Claude Code would catch it, but centrally is where the two
        // spawn sites stay consistent — see agent-availability.ts.
        await assertAgentAvailable(args.agent as string | undefined, process.cwd());

        const resolved = validateSessionPath(path);

        // Live per-model token/cost progress for the run modes. The session
        // basename is a stable, human-recognisable id for the channel frames.
        const teamSessionId = resolved.split("/").filter(Boolean).pop() ?? "team";
        const teamCreatedAt = new Date().toISOString();
        const runOpts = {
          requirePattern,
          minOutputBytes,
          claudeFlags: childFlags,
          onProgress: (u: {
            rendered: string;
            phase: "running" | "settled";
            allFailed: boolean;
          }) => {
            // Two mechanisms, deliberately both: the channel frame below is what
            // the agent and the human SEE, and this one is what keeps the client
            // from aborting the call. A state change is real news, so refresh the
            // idle timer at that moment as well as on the periodic tick. Short
            // phase string only — the rendered grid stays on the channel path.
            ctx.reportProgress(`team: ${u.phase}`);
            notifyChannel({
              content: u.rendered,
              sessionId: teamSessionId,
              // A settled run must emit a TERMINAL event. Emitting "running"
              // for the final frame leaves any status-tracking consumer
              // believing the run never closed.
              event: u.phase === "settled" ? (u.allFailed ? "failed" : "completed") : "running",
              model: "team",
              elapsedSeconds: (Date.now() - Date.parse(teamCreatedAt)) / 1000,
              createdAt: teamCreatedAt,
            });
          },
        };

        switch (mode) {
          case "run": {
            if (!models?.length) throw new Error("'models' is required for 'run' mode");
            setupSession(resolved, models, input);
            // Returns once the children EXIST, not once they finish. A team slot
            // is a full Claude Code session and can legitimately work for a long
            // time; holding the tool call open for that made the run's duration
            // the client's problem, and the deadline that existed to bound it
            // killed working slots. Poll `mode: "status"` instead.
            const handle = await startModels(resolved, runOpts);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      started: true,
                      team_session_id: handle.teamSessionId,
                      session_path: handle.sessionPath,
                      slots: handle.slots,
                      next: {
                        status: `team(mode:"status", path:"${handle.sessionPath}")`,
                        cancel: `team(mode:"cancel", path:"${handle.sessionPath}", slot:"<id>")`,
                        judge: `team(mode:"judge", path:"${handle.sessionPath}") once every slot has finished`,
                      },
                      note:
                        "Nothing terminates a slot on a timer. `status` reports how many " +
                        "seconds each slot has been silent; a slot inside a long build is " +
                        "quiet and working. You decide whether to cancel.",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          case "cancel": {
            const slot = args.slot as string | undefined;
            const teamSessionId = resolved.split("/").filter(Boolean).pop() ?? "team";
            const result = await cancelTeamRun(teamSessionId, slot);
            if (!result.found) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      cancelled: [],
                      note:
                        "No live run for that path. It already settled (read `status`), or " +
                        "it was started by a different process — this server can only stop " +
                        "children it spawned.",
                    }),
                  },
                ],
              };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ cancelled: result.cancelled }, null, 2),
                },
              ],
            };
          }
          case "judge": {
            const verdict = await judgeResponses(resolved, { judges, claudeFlags: childFlags });
            return { content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }] };
          }
          case "run-and-judge": {
            if (!models?.length) throw new Error("'models' is required for 'run-and-judge' mode");
            setupSession(resolved, models, input);
            await runModels(resolved, runOpts);
            const verdict = await judgeResponses(resolved, { judges, claudeFlags: childFlags });
            return { content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }] };
          }
          case "status": {
            const status = getStatus(resolved);
            const teamSessionId = resolved.split("/").filter(Boolean).pop() ?? "team";
            // All three liveness reads are null once the run has settled or if it
            // was never spawned here — the states in `status` are then whatever
            // status.json last recorded, and there is no child left to ask.
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    buildTeamStatusPayload({
                      status,
                      sessionPath: resolved,
                      idle: teamSlotIdleSeconds(teamSessionId),
                      activity: teamSlotActivity(teamSessionId),
                      liveBytes: teamSlotLiveBytes(teamSessionId),
                    }),
                    null,
                    2
                  ),
                },
              ],
            };
          }
          default:
            throw new Error(`Unknown mode: ${mode}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: withOpFailureContext(
                `Error: ${error instanceof Error ? error.message : String(error)}`,
                "while running the team"
              ),
            },
          ],
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "report_error",
    description:
      "Report a claudish error to developers. IMPORTANT: Ask the user for consent BEFORE calling this tool. Show them what data will be sent (sanitized). All data is anonymized: API keys, user paths, and emails are stripped. Set auto_send=true to suggest the user enables automatic future reporting.",
    inputSchema: {
      type: "object",
      properties: {
        error_type: {
          type: "string",
          enum: ["provider_failure", "team_failure", "stream_error", "adapter_error", "other"],
          description: "Category of the error",
        },
        model: { type: "string", description: "Model ID that failed (anonymized in report)" },
        command: { type: "string", description: "Command that was run" },
        stderr_snippet: { type: "string", description: "First 500 chars of stderr output" },
        exit_code: { type: "number", description: "Process exit code" },
        error_log_path: { type: "string", description: "Path to full error log file" },
        session_path: { type: "string", description: "Path to team session directory" },
        additional_context: { type: "string", description: "Any extra context about the error" },
        auto_send: {
          type: "boolean",
          description: "If true, suggest the user enable automatic error reporting",
        },
      },
      required: ["error_type"],
    },
    group: "agentic",
    handler: async (args) => {
      const error_type = args.error_type as string;
      const model = args.model as string | undefined;
      const command = args.command as string | undefined;
      const stderr_snippet = args.stderr_snippet as string | undefined;
      const exit_code = args.exit_code as number | undefined;
      const error_log_path = args.error_log_path as string | undefined;
      const session_path = args.session_path as string | undefined;
      const additional_context = args.additional_context as string | undefined;
      const auto_send = args.auto_send as boolean | undefined;

      let stderrFull = stderr_snippet || "";
      if (error_log_path) {
        try {
          stderrFull = readFileSync(error_log_path, "utf-8");
        } catch {}
      }

      const sessionData: Record<string, string> = {};
      if (session_path) {
        const sp = session_path;
        for (const file of ["status.json", "manifest.json", "input.md"]) {
          try {
            sessionData[file] = readFileSync(join(sp, file), "utf-8");
          } catch {}
        }
        try {
          const errorDir = join(sp, "errors");
          if (existsSync(errorDir)) {
            for (const f of readdirSync(errorDir)) {
              if (f.endsWith(".log")) {
                try {
                  sessionData[`errors/${f}`] = readFileSync(join(errorDir, f), "utf-8");
                } catch {}
              }
            }
          }
        } catch {}
        try {
          for (const f of readdirSync(sp)) {
            if (f.startsWith("response-") && f.endsWith(".md")) {
              try {
                const content = readFileSync(join(sp, f), "utf-8");
                sessionData[f] =
                  content.slice(0, 200) + (content.length > 200 ? "... (truncated)" : "");
              } catch {}
            }
          }
        } catch {}
      }

      let version = "unknown";
      try {
        const pkgPath = join(__dirname, "../package.json");
        if (existsSync(pkgPath)) {
          version = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
        }
      } catch {}

      const report = {
        version,
        timestamp: new Date().toISOString(),
        error_type,
        model: model || "unknown",
        command: sanitize(command),
        stderr: sanitize(stderrFull),
        exit_code: exit_code ?? null,
        platform: process.platform,
        arch: process.arch,
        runtime: `bun ${process.version}`,
        context: sanitize(additional_context),
        session: Object.fromEntries(Object.entries(sessionData).map(([k, v]) => [k, sanitize(v)])),
      };

      const reportSummary = JSON.stringify(report, null, 2);
      const autoSendHint = auto_send
        ? "\n\n**Suggestion:** Enable automatic error reporting so future errors are sent without asking. Run `claudish config` → Privacy → toggle Telemetry, or set `CLAUDISH_TELEMETRY=1`."
        : "";

      const REPORT_URL = "https://us-central1-claudish-6da10.cloudfunctions.net/errorReportIngest";

      try {
        const response = await fetch(REPORT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error report sent successfully.\n\n**Sanitized data sent:**\n\`\`\`json\n${reportSummary}\n\`\`\`${autoSendHint}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error report endpoint returned ${response.status}. Report was NOT sent.\n\n**Data that would have been sent (all sanitized):**\n\`\`\`json\n${reportSummary}\n\`\`\`\n\nYou can manually report this at https://github.com/anthropics/claudish/issues${autoSendHint}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not reach error reporting endpoint (${err instanceof Error ? err.message : "network error"}).\n\n**Sanitized error data (for manual reporting):**\n\`\`\`json\n${reportSummary}\n\`\`\`\n\nReport manually at https://github.com/anthropics/claudish/issues${autoSendHint}`,
            },
          ],
        };
      }
    },
  });

  // ── Channel Tools ────────────────────────────────────────────────────

  tools.push({
    name: "create_session",
    description:
      "Create a new claudish proxy session for an external model. Spawns an async session that produces channel notifications as it runs.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Model identifier (e.g., 'google@gemini-2.0-flash', 'x-ai/grok-code-fast-1')",
        },
        prompt: {
          type: "string",
          description: "Initial prompt to send. If omitted, send later via send_input.",
        },
        timeout_seconds: {
          type: "number",
          description: "Session timeout in seconds (default: 600, max: 3600)",
        },
        agent: {
          type: "string",
          description:
            "Claude Code subagent the session runs as, e.g. 'dev:reviewer'. Equivalent to " +
            "putting '--agent <name>' in claude_flags, and wins over one given there.",
        },
        claude_flags: {
          type: "string",
          description:
            "Any other Claude Code / claudish flags, space-separated. Unrecognised flags " +
            "pass through to the child Claude Code. NOTE: split on whitespace, so a flag " +
            "VALUE containing spaces cannot be expressed here.",
        },
        work_dir: {
          type: "string",
          description: "Working directory for the session (default: current directory)",
        },
      },
      required: ["model"],
    },
    group: "channel",
    handler: async (args) => {
      try {
        const claudishFlags = buildChildClaudeFlags(args.agent, args.claude_flags);

        // Resolve the model's credential AND its route in THIS process before
        // spawning the child. Several create_session calls in flight at once
        // would otherwise each open their own 1Password SDK client, and the
        // desktop app denies all but one ("Denied authorization for SDK
        // client"). Resolving here write-throughs the key into process.env,
        // which the child inherits; the returned plan pins the bare name to an
        // explicit "provider@model" spec so the child never re-walks the chain
        // and asks 1Password about candidates the parent short-circuited past.
        //
        // Pinning is SKIPPED for a work_dir outside this process's cwd: route()
        // reads project-local config relative to process.cwd(), so the parent
        // would decide with the wrong project's rules. process.chdir() is not
        // an option — it is process-global and races concurrent calls.
        const requestedModel = args.model as string;
        const workDir = args.work_dir as string | undefined;
        // The agent list is cwd-dependent, so validate against the directory this
        // session will actually run in, not the parent's.
        await assertAgentAvailable(args.agent as string | undefined, workDir ?? process.cwd());

        const plan = await prehydrateCredentialsForSpawn([requestedModel], {
          pin: workDir === undefined || resolve(workDir) === process.cwd(),
        });

        const sessionId = sessionManager.createSession({
          model: requestedModel,
          spawnModel: plan.pinned.get(requestedModel),
          prompt: args.prompt as string | undefined,
          timeoutSeconds: args.timeout_seconds as number | undefined,
          claudishFlags,
          cwd: workDir,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ session_id: sessionId, status: "starting" }),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: withOpFailureContext(
                `Error creating session: ${errMsg}\n\n---\n**To report this error**, use the \`report_error\` tool with \`error_type: "provider_failure"\` and \`model: "${args.model}"\`.`,
                `while routing ${args.model}`
              ),
            },
          ],
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "send_input",
    description:
      "Send input text to an active session's stdin. Use when a session is in 'waiting_for_input' state.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_session" },
        text: { type: "string", description: "Text to send to the session" },
      },
      required: ["session_id", "text"],
    },
    group: "channel",
    handler: async (args) => {
      const success = sessionManager.sendInput(args.session_id as string, args.text as string);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success }) }],
      };
    },
  });

  tools.push({
    name: "get_output",
    description:
      "Get output from a session's scrollback buffer. Call after 'completed' notification to get full response.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_session" },
        tail_lines: {
          type: "number",
          description: "Number of lines to return from the end (default: all)",
        },
      },
      required: ["session_id"],
    },
    group: "channel",
    handler: async (args) => {
      try {
        const output = sessionManager.getOutput(
          args.session_id as string,
          args.tail_lines as number | undefined
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "cancel_session",
    description:
      "Cancel a running session. Sends SIGTERM, then SIGKILL after 5 seconds if still running.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID to cancel" },
      },
      required: ["session_id"],
    },
    group: "channel",
    handler: async (args) => {
      const success = sessionManager.cancelSession(args.session_id as string);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success }) }],
      };
    },
  });

  tools.push({
    name: "list_sessions",
    description:
      "List all active channel sessions. Optionally include completed sessions. " +
      "Each session reports `idleSeconds`: how long since the child last emitted " +
      "anything. Nothing kills a session for being idle — a child inside a long " +
      "Bash call is silent and working — so this is yours to judge against the " +
      "task you set, and `cancel_session` is yours to call if the answer is no.",
    inputSchema: {
      type: "object",
      properties: {
        include_completed: {
          type: "boolean",
          description: "Include completed/failed/cancelled sessions (default: false)",
        },
      },
    },
    group: "channel",
    handler: async (args) => {
      const sessions = sessionManager.listSessions(args.include_completed as boolean | undefined);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ sessions }) }],
      };
    },
  });

  // Diagnostics as API.
  //
  // Two channel sessions once ran 900 seconds of genuine billed work — 241
  // assistant messages, ~94k output tokens, 150 tool calls — and reported
  // success with an empty output log. The cause was one line, written to
  // `~/.claudish/sessions/<id>/stderr.log` and left there:
  //   [claude-code:unrecognized_model] {"model":"cx@gpt-5.6-sol"}
  // No MCP tool returned it. Diagnosis meant reading the filesystem by hand,
  // which an agent consuming this interface has no reason to know about — and a
  // failure that has already happened cannot be reproduced with `--debug`.
  //
  // Everything this returns is captured unconditionally while the session runs.
  tools.push({
    name: "get_diagnostics",
    description:
      "Explain what a channel session actually did — stderr, upstream error bodies, the " +
      "recent event frames, the resolved model chain, accounting, and the paths to the " +
      "full records. Call this FIRST whenever a session fails, times out, or completes " +
      "with empty or surprising output; it needs no re-run and no debug flag. " +
      "`idleSeconds` reports how long since the child last emitted a frame, and is " +
      "null once the session is no longer live. It is information, never a verdict: " +
      "claudish does not terminate a session for silence.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_session" },
        event_limit: {
          type: "number",
          description:
            "How many of the most recent semantic frames to include (default: 40, max: 200). " +
            "0 omits them; `event_log_path` always has the full record.",
        },
      },
      required: ["session_id"],
    },
    group: "channel",
    handler: async (args) => {
      try {
        const diagnostics = sessionManager.getDiagnostics(
          args.session_id as string,
          args.event_limit as number | undefined
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(diagnostics) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  return tools;
}

// ─── Tool Group Resolution ───────────────────────────────────────────────────

function resolveToolGroups(mode: string): Set<ToolGroup> {
  switch (mode) {
    case "low-level":
      return new Set(["low-level"]);
    case "agentic":
      return new Set(["agentic"]);
    case "channel":
      return new Set(["channel"]);
    default:
      return new Set(["low-level", "agentic", "channel"]);
  }
}

// ─── SEP-1686 status mapping ─────────────────────────────────────────────────
// Maps Claudish's 7-value `event` enum to SEP-1686's 5-value `TaskStatus`.
// See: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1732
// Migration plan: ai-docs/sessions/.../sep-1686-migration-schema.md
type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

const EVENT_TO_TASK_STATUS = new Map<string, TaskStatus>([
  ["starting", "working"],
  ["running", "working"],
  ["tool_executing", "working"],
  ["waiting_for_input", "input_required"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["cancelled", "cancelled"],
  // The key whose ABSENCE forced the channel wire to lie. `mapEventToTaskStatus`
  // falls through to `?? "working"`, so a session killed by its own timeout was
  // reported to a SEP-1686 consumer as still working — which is why the timeout
  // path emitted `"failed"` on the wire while `SessionInfo.status` said
  // `"timeout"`. With this key present `ChannelEventType` is the full
  // `SessionStatus` and the timeout emits its own event; SEP-1686 has no
  // `timeout` member, and `failed` is the only honest projection of it.
  ["timeout", "failed"],
]);

// Exported ONLY so the regression guard can call it instead of grepping this
// file's source text. The behaviour worth guarding is the fall-through below: a
// key missing from EVENT_TO_TASK_STATUS does not throw, it silently yields
// "working", so a dead session (e.g. one killed by its own timeout) reports to a
// SEP-1686 consumer as still alive. Only a real call can catch that; a source
// regex stays green if the entry moves to a dead map, is shadowed, or ends up in
// a comment.
export function mapEventToTaskStatus(event: string): TaskStatus {
  return EVENT_TO_TASK_STATUS.get(event) ?? "working";
}

// ─── Server Setup ────────────────────────────────────────────────────────────

async function main() {
  const toolMode = (process.env.CLAUDISH_MCP_TOOLS || "all").toLowerCase();
  const enabledGroups = resolveToolGroups(toolMode);

  // Create server with channel capability
  const server = new Server(
    { name: "claudish", version: "9.0.0" },
    {
      capabilities: {
        ...(enabledGroups.has("channel") ? { experimental: { "claude/channel": {} } } : {}),
        tools: {},
      },
      instructions: INSTRUCTIONS,
    }
  );

  // Create session manager with channel notification bridge.
  // The bridge translates SessionManager events into MCP notifications.
  // When CLAUDISH_CHANNEL_TRACE=1 is set, the diagnostics module wraps the
  // callback to log each step of the producer→bridge→wire pipeline.
  //
  // Wire format aligns with SEP-1686 (Tasks) for forward-compat: each
  // notification carries both Claudish-specific fields (`session_id`, `event`)
  // and SEP-1686-shaped fields (`task_id`, `status`, `created_at`,
  // `last_updated_at`). When Claude Code ships notifications/tasks/status
  // receiver support, the migration is a method-name swap + payload restructure
  // (no semantic changes).
  // See: ai-docs/sessions/.../sep-1686-migration-schema.md
  const sessionManager = new SessionManager({
    onStateChange: wrapStateChange((sessionId, event) => {
      // `timeout` is here because it used to arrive AS `failed` — the wire had
      // no timeout event until EVENT_TO_TASK_STATUS learned to project one — and
      // dropping the hint when the event split in two would have been a silent
      // regression. Both are terminal failures worth reporting, and both are now
      // explainable without a re-run via get_diagnostics.
      const notificationContent =
        event.type === "failed" || event.type === "timeout"
          ? `${event.content}\n\nCall get_diagnostics with session_id: "${sessionId}" for the stderr, the upstream error bodies and the transcript path. To report it, use the report_error tool with error_type: "provider_failure" and model: "${event.model}".`
          : event.content;
      const result = server.notification({
        method: "notifications/claude/channel",
        params: {
          content: notificationContent,
          meta: {
            session_id: sessionId,
            event: event.type,
            model: event.model,
            elapsed_seconds: String(event.elapsedSeconds),
            // SEP-1686 forward-compat fields (additive, do not break consumers
            // of the existing fields above):
            task_id: sessionId,
            status: mapEventToTaskStatus(event.type),
            created_at: event.createdAt,
            last_updated_at: new Date().toISOString(),
            ...event.extraMeta,
          },
        },
      });
      watchNotificationResult(result, { sessionId, eventType: event.type });
    }),
  });

  // Live-progress push for long-running tools. Gated on the channel capability
  // actually being declared — emitting a channel frame the client never
  // registered for is silently dropped, and `team` still writes status.txt
  // regardless, so there is always a visible path.
  const channelEnabled = enabledGroups.has("channel");
  const notifyChannel: ChannelNotifier = (p) => {
    if (!channelEnabled) return;
    try {
      const result = server.notification({
        method: "notifications/claude/channel",
        params: {
          content: p.content,
          meta: {
            // meta keys must match [a-zA-Z0-9_]+ — Claude Code silently drops
            // keys containing hyphens or other characters.
            session_id: p.sessionId,
            event: p.event,
            model: p.model,
            elapsed_seconds: String(Math.round(p.elapsedSeconds)),
            task_id: p.sessionId,
            status: mapEventToTaskStatus(p.event),
            created_at: p.createdAt,
            last_updated_at: new Date().toISOString(),
          },
        },
      });
      watchNotificationResult(result, { sessionId: p.sessionId, eventType: p.event });
    } catch {
      // Progress reporting must never fail the tool call it is describing.
    }
  };

  // Keepalive cadence for `heartbeat: true` tools. Resolved ONCE per server rather
  // than per call, so a long-lived session cannot change its behaviour mid-flight.
  const progressIntervalMs = resolveProgressIntervalMs();

  // Build tool registry
  const allTools = defineTools(sessionManager, notifyChannel);
  const enabledTools = allTools.filter((t) => enabledGroups.has(t.group));
  const toolMap = new Map(enabledTools.map((t) => [t.name, t]));

  console.error(`[claudish] MCP server started (tools: ${toolMode}, ${enabledTools.length} tools)`);

  // Register ListTools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: enabledTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Register CallTool handler
  //
  // `extra._meta` is the caller's request `_meta` (SDK protocol.ts sets it from
  // `request.params?._meta`), which is where Claude Code puts `progressToken`. A
  // tool marked `heartbeat: true` gets a periodic `notifications/progress`
  // keepalive for as long as it runs: the client aborts a call that emits nothing
  // for its idle window (30 min on stdio by default — the exact 1800s a real
  // `team` run died at), and a progress frame is the ONLY notification measured to
  // reset that timer. Channel frames do not.
  //
  // `extra.sendNotification` is preferred over `server.notification` because it is
  // the request-scoped sender; on non-stdio transports it is what correlates the
  // frame with its request. `notifications/progress` needs no capability
  // declaration — the SDK always allows it.
  //
  // The dispatch owns start AND stop. `finally` runs after the result value is
  // computed but before it reaches the SDK, so a frame can never be emitted after
  // the response it belongs to — the GLips/Figma-Context-MCP#362 teardown pattern
  // is structurally unreachable, and a handler cannot forget to stop a timer it
  // never started.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Error: Unknown tool "${name}"` }],
        isError: true,
      };
    }

    const heartbeat: HeartbeatHandle = tool.heartbeat
      ? startHeartbeat({
          token: extra._meta?.progressToken,
          label: name,
          intervalMs: progressIntervalMs,
          send: (frame) =>
            extra.sendNotification({ method: "notifications/progress", params: frame }),
        })
      : NOOP_HEARTBEAT;
    const ctx: ToolCallContext = { reportProgress: (message) => heartbeat.tick(message) };

    try {
      return await tool.handler(args ?? {}, ctx);
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    } finally {
      heartbeat.stop();
    }
  });

  // Connect via stdio transport. installWireTap() is a no-op unless
  // CLAUDISH_CHANNEL_TRACE=1 is set; when active it mirrors outbound channel
  // notification frames to stderr so we can confirm wire-level delivery.
  const transport = new StdioServerTransport();
  installWireTap();
  await server.connect(transport);

  // Cleanup on shutdown. Both subsystems spawn children that outlive the call
  // that started them — channel sessions always did, and team runs do now that
  // `run` returns before its models finish — so both must be reached here or
  // their process trees survive this one and keep billing.
  process.on("SIGTERM", () => {
    sessionManager.shutdownAll().catch(() => {});
    shutdownAllTeamRuns().catch(() => {});
  });
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Entry point for MCP server mode.
 * Called from index.ts when --mcp flag is used.
 */
export function startMcpServer() {
  main().catch((error) => {
    console.error("[claudish] MCP fatal error:", error);
    process.exit(1);
  });
}
