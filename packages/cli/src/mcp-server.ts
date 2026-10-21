/**
 * Claudish MCP Server
 *
 * Exposes all claudish models (OpenRouter, Kimi, GLM, Qwen, MiniMax, Gemini, OpenAI,
 * local models, etc.) and sessions as MCP tools for Claude Code.
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
import { searchCatalogModels } from "./adapters/model-catalog.js";
import { prehydrateCredentialsForSpawn } from "./auth/credentials/prehydrate.js";
import { setCredentialPromptRole } from "./auth/credentials/prompt-role.js";
import { isSubscriptionProvider } from "./handlers/shared/remote-provider-types.js";
import { loadHooksOnce } from "./hooks/index.js";
import { type ProtocolStdout, isolateProtocolStdout } from "./hooks/output-capture.js";
import { initLogger, log } from "./logger.js";
import { SessionManager } from "./mcp-session/index.js";
import { resolveSetupFrom } from "./mcp-session/inherited-settings.js";
import { parentSessionForCall } from "./mcp-session/parent-session.js";
import { NESTED_INSTRUCTIONS, NESTED_MCP_TOOL_NAMES } from "./mcp/nested-mode.js";
import {
  type HeartbeatHandle,
  NOOP_HEARTBEAT,
  resolveProgressIntervalMs,
  startHeartbeat,
} from "./mcp/progress-heartbeat.js";
import {
  type RunPromptResult,
  runPromptViaClaudeCode,
  stopAllClaudeCodePrintChildren,
} from "./mcp/run-prompt-claude-code.js";
import { type RecommendedModelsDoc, getRecommendedModels } from "./model-loader.js";
// Imported for the predicate only. child-env's import-time bootstrap is a no-op here:
// a claudish MCP server is never the pane child (it carries no CLAUDISH_PANE_CWD).
import { inMcpSession } from "./pane/child-env.js";
import {
  ContractErrorException,
  type FailureReason,
  MIN_MAGMUX_VERSION,
  SLOT_STATES,
  type SlotState,
  TERMINAL_STATES,
  type TeamRunRow,
  assertMagmuxAvailable,
  checkChildFlags,
  contractMeta,
  ensureSwept,
  installPaneShutdownHooks,
  sockRootFor,
} from "./pane/index.js";
import { findAvailablePort } from "./port-manager.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { compareByReleaseDateDesc } from "./providers/model-ordering.js";
import { isLocalProviderName } from "./providers/model-parser.js";
import { NATIVE_NOT_PROBED, nativeRouteFor } from "./providers/native-route.js";
import { renderOpFailureBlock } from "./providers/onepassword.js";
import { isReadyState, probeLink } from "./providers/probe-live.js";
import { route } from "./providers/routing-rules.js";
import { createProxyServer } from "./proxy-server.js";
import { nativeShortcutForVendor, renderRecommendedMarkdown } from "./recommended-listing.js";
import { sanitizeForReport } from "./redact.js";
import {
  type ModelStatus,
  type TeamRunOutcome,
  type TeamStatus,
  cancelTeamRun,
  captureTeamSlot,
  getStatus,
  isSupersededRun,
  judgeResponses,
  listTeamRuns,
  preflightTeamRun,
  readTeamInputFile,
  readTeamStatus,
  resizeTeamSlot,
  setupSession,
  shutdownAllTeamRuns,
  startModels,
  summarise,
  teamLiveMaps,
  teamRunRow,
  teamRunRowFromDisk,
  validateSessionPath,
} from "./team-orchestrator.js";
import type { ProxyServer } from "./types.js";
import { VERSION } from "./version.js";

// No `.env` load here. `index.ts` loads the working directory's `.env` through the
// allowlist (dotenv-allowlist.ts) before it imports this module, and that is the only
// `.env` load claudish has. Claude Code starts this server in a checkout before its
// folder-trust dialog, so a second, unfiltered load here would hand the checkout every
// name the allowlist refused (`CLAUDE_PATH`, `NODE_OPTIONS`, base URLs, the pane markers).

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

/** The server's `instructions`, which the host adds to its system prompt. */
const INSTRUCTIONS = `Claudish MCP server gives you access to external AI models (OpenRouter, Ollama, LM Studio and every claudish provider), and to Claude models on the user's own Claude Code login.

## Which tool

- run_prompt: one quick prompt to one model's API. One request, one answer; no tools, no files, no session.
- create_session: one model doing a task as a full Claude Code session (tools, files, several turns).
- team: several models on the same task, each a full Claude Code session, with optional blind judging.

## Sessions

Each session is an interactive Claude Code running the model in its own headless terminal pane. Nothing is pushed to you while it runs: poll.

1. create_session returns {session_id, state: "STARTING"} at once while Claude Code boots.
2. Poll list_sessions (include_completed: true), about once every 10 seconds. Each row has state, activity, idle_seconds and accounting.
   - STARTING: booting, or the first prompt is not yet accepted.
   - RUNNING: a turn is in progress (activity names the tool in use).
   - AWAITING_INPUT: waiting for send_input — an interactive session between turns, or a turn stopped on a question (activity "AskUserQuestion"). A send declines a question and becomes the next prompt.
   - AWAITING_PERMISSION: a permission or plan-approval dialog is open. A send declines it and becomes the next prompt.
   - COMPLETED, FAILED, TIMEOUT, CANCELLED, EMPTY: finished.
3. send_input may be called at any time; it is queued until the session is idle.
4. COMPLETED: call get_output for the answer.
5. FAILED or TIMEOUT — or COMPLETED with an empty or surprising answer — call get_diagnostics. It returns the child's final screen, the upstream error bodies, the recent state records, the resolved model chain and the paths to the full records. It needs no re-run and no debug flag.
6. capture_session reads a session's current screen; resize_session sets its terminal size (any time, mid-turn included); cancel_session stops it. Nothing stops a session for being idle: a child inside a long build is silent and working.

The session_id from create_session is the key for every session tool.`;

// ─── Types ───────────────────────────────────────────────────────────────────

type ToolGroup = "low-level" | "agentic" | "session" | "debug";

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
  /**
   * Fires when the host cancels the call (`notifications/cancelled`) or gives up on it
   * (its own request timeout). From the SDK's `RequestHandlerExtra.signal`. A tool that
   * starts a child process stops it on this signal.
   */
  signal: AbortSignal;
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
      { quiet: true, hostMode: "mcp" }
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
 * One request through the in-process proxy, for every model that is not a bare
 * Claude name. The body carries NO `max_tokens`: step 5w strips every output-limit
 * field the adapters write and adds the wire's own only when the request has one,
 * except on the Messages API, which requires one and gets the catalog's
 * `maxOutputTokens`. No model limit is pinned here
 * (ai-docs/architecture/wire.md "Output limit").
 */
export async function runPromptViaProxy(
  model: string,
  prompt: string,
  systemPrompt?: string
): Promise<RunPromptResult> {
  const proxy = await getProxy();

  // Build Anthropic Messages API request
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
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

/**
 * One `run_prompt` request, on the path its model needs. `nativeRouteFor` FIRST, as
 * the proxy does (CLAUDE.md invariant): a bare Claude name (`claude-*`, `opus`,
 * `sonnet`, `haiku`, `internal`, ...) runs as one Claude Code print-mode call on the
 * user's own Claude Code login, because the proxy's native route forwards the
 * caller's credential and an MCP call has none. Every other model, including the
 * explicit `anthropic@claude-*` (metered), goes through the in-process proxy. The
 * ORIGINAL model string is passed on; claudish's CLI owns alias normalisation.
 */
export async function runPrompt(
  model: string,
  prompt: string,
  systemPrompt?: string,
  signal?: AbortSignal
): Promise<RunPromptResult> {
  if (nativeRouteFor(model) !== null) {
    return runPromptViaClaudeCode(model, prompt, systemPrompt, { signal });
  }
  return runPromptViaProxy(model, prompt, systemPrompt);
}

/** `run_prompt`'s success text: the answer, then a footer of token and auth lines. */
function formatRunPromptResult(result: RunPromptResult): string {
  const footer: string[] = [];
  if (result.usage) {
    footer.push(`Tokens: ${result.usage.input} input, ${result.usage.output} output`);
  }
  if (result.auth !== undefined) {
    footer.push(
      result.auth === "subscription"
        ? "Auth: Claude Code login (subscription)"
        : `Auth: ${result.auth}`
    );
  }
  return footer.length > 0 ? `${result.content}\n\n---\n${footer.join("\n")}` : result.content;
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
export const NEXT_STEP: Record<FailureReason, string> = {
  cancelled:
    "you stopped this slot; nothing is wrong with it. Re-run it if you still want its vote",
  timeout: "grid mode only — magmux ended the pane. The orchestrator has no deadline",
  boot_timeout:
    "the child never reached its prompt and its screen kept changing — read the evidence " +
    "screen; usually a slow catalog fetch or MCP server start",
  boot_blocked:
    "a screen claudish does not know stopped boot — its text is in `what`; answer it once " +
    "interactively in that directory",
  first_run_dialog:
    "run claude (or claudish --model X) once interactively in that directory and answer the " +
    "dialog named in `what`; claudish never accepts it for you",
  agent_rejected: "fix the agent name; the available agents are listed in `what`",
  prompt_not_accepted: "the REPL never took the prompt — read the evidence screen; retry",
  prompt_not_read:
    "the child never read all of its task file — check that its agent or tool flags allow " +
    "Read and that the model can call tools; `what` says which lines were read",
  child_exited: "read the evidence screen, then retry or drop the model",
  pane_lost: `magmux died — check \`magmux --version\` ≥ ${MIN_MAGMUX_VERSION} and retry`,
  blocked:
    "the child asked a question team cannot answer — make the prompt self-contained or use " +
    "create_session",
  api_error: "retry once, or route via a different provider (or@<model>)",
  refused: "the model refused — rephrase or drop the model",
  empty_output: "retry once; if it repeats, drop the model",
  shape_mismatch:
    "the answer (assistant text after the task was read) did not match. Every assistant " +
    "message of the turn was read from the transcript, so nothing was lost in transit — " +
    "the model did not produce it. Re-prompt with the required format restated; do NOT " +
    "count this slot as a vote",
};

/**
 * The Details cell of a preflight "no route" row: the reason, then EVERY line
 * of the plan's hint — for a missing credential that is the same login
 * instruction `--probe` prints. Without it the row read only `No credentials
 * configured for "meta-muse-code".`, which an agent cannot act on.
 *
 * Hints come in two shapes. Most are one remedy sentence (explicit-not-served,
 * catalog-unreadable, …), kept whole. `buildCredentialHint`'s is a header
 * (`No credentials found for "<model>". Options:`) and one line per option.
 * Only a line that REPEATS the reason is dropped, and that header is one: it
 * restates the reason's "no credentials" before the options.
 *
 * One table cell, so the kept lines are joined with ` · ` (a space after a
 * line ending in `:`), whitespace runs collapse, and a `|` is escaped.
 */
export function noRouteCell(reason: string, hint?: string): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const lines = (hint ?? "")
    .split("\n")
    .map(flat)
    .filter((line) => line && !repeatsNoRouteReason(line, flat(reason)));
  // A line ending in ":" introduces the next, so it joins with a space.
  const joined = lines.reduce(
    (acc, line, i) => (i === 0 ? line : `${acc}${lines[i - 1].endsWith(":") ? " " : " · "}${line}`),
    ""
  );
  const cell = joined ? `${reason} ${joined}` : reason;
  return cell.replace(/\|/g, "\\|");
}

/** A hint line that restates the reason: the same text, or the credential hint's header. */
function repeatsNoRouteReason(line: string, reason: string): boolean {
  if (line === reason) return true;
  return (
    // "No credentials configured for …" and "No credentialed providers in …".
    reason.startsWith("No credential") &&
    line.startsWith("No credentials found for ") &&
    line.endsWith("Options:")
  );
}

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
 * A slot's `outputSize` is written once, when it finishes, so a working slot
 * always reports 0. Real orchestrators have read that 0 next to a 20-minute-old
 * `startedAt` and concluded the slot produced nothing; one then had to reason its
 * way back out in front of the user. The note leads with that, because a caller
 * skimming a JSON blob reads the first clause and stops.
 *
 * Returned only while some slot is not terminal — on a settled run the states are
 * final, `outputSize` means exactly what it says, and this would be noise.
 */
export function teamStatusNote(opts: {
  anyActive: boolean;
  live: boolean;
  /** slots whose turn sits in `finishing` with no end-of-turn record (R3-M4) */
  endRecordMissing?: string[];
}): string | undefined {
  if (!opts.anyActive) return undefined;
  const trap =
    "outputSize is the size of the FINAL answer and is written once, when a slot " +
    "finishes. Every slot still working therefore reports 0 however much work it has " +
    "done: it is NOT a progress signal, and 0 there does not mean the slot produced nothing.";
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
  const missing = opts.endRecordMissing ?? [];
  const missingNote = missing.length
    ? ` Slot(s) ${missing.join(", ")}: the model's message ended long ago with a static ` +
      "screen and no Stop hook running, but Claude Code never wrote its end-of-turn record " +
      "(turn_end_record_missing). Nothing ends such a slot on a timer — cancel it if it " +
      "stays this way."
    : "";
  return (
    `${trap} Judge a working slot on three fields read TOGETHER: ` +
    "live_output_bytes_by_slot (answer bytes so far, the number outputSize will become), " +
    "idle_seconds_by_slot (seconds of silence) and activity_by_slot (what it is doing: a " +
    'tool name, "thinking", "background" or "finishing"). Silence while a tool runs is a ' +
    "build or test suite, and is not a failure signal. Nothing cancels on your behalf — " +
    `use mode:"cancel" if you decide to.${missingNote}`
  );
}

/** A persisted state outside the closed set reads FAILED (terminal), as §8 B says. */
function slotStateOf(m: ModelStatus): string {
  return (SLOT_STATES as readonly string[]).includes(m.state) ? m.state : "FAILED";
}

/**
 * Assemble the `status` response: the legacy path-based payload, the contract's
 * `contract_version`/`capabilities`, and `run` (§8 B). Pure and exported so the payload
 * can be tested without spawning a run: every liveness input is a parameter.
 */
export function buildTeamStatusPayload(opts: {
  status: TeamStatus;
  sessionPath: string;
  idle: Record<string, number> | null;
  activity: Record<string, string> | null;
  liveBytes: Record<string, number> | null;
  run: TeamRunRow;
  endRecordMissing?: string[];
}): Record<string, unknown> {
  const { status, sessionPath, idle, activity, liveBytes } = opts;
  // Keyed on the states, not on liveness. A run this server never spawned can still
  // show working slots from a stale status.json, and that is precisely a reader who
  // is about to misjudge an `outputSize` of 0.
  const anyActive = Object.values(status.models).some(
    (m) => !TERMINAL_STATES.includes(slotStateOf(m) as SlotState)
  );
  const note = teamStatusNote({
    anyActive,
    live: idle !== null,
    endRecordMissing: opts.endRecordMissing,
  });
  return {
    ...status,
    // §8 B: the legacy `models[slot].state` uses the same closed SlotState set as `run`
    // (a pre-contract status.json can still say PENDING; it reads as FAILED, like `run`)
    models: Object.fromEntries(
      Object.entries(status.models ?? {}).map(([id, m]) => [id, { ...m, state: slotStateOf(m) }])
    ),
    // Bytes of answer produced SO FAR, per slot still working. `outputSize` cannot
    // answer this.
    live_output_bytes_by_slot: liveBytes,
    idle_seconds_by_slot: idle,
    // What each slot is DOING, which is what makes the idle number readable. Silence
    // while a tool runs is a build; the same silence in "thinking" is a stalled answer.
    activity_by_slot: activity,
    ...(note ? { note } : {}),
    // The rendered result card, once there is a result to render.
    ...(anyActive ? {} : { summary: formatTeamResult(status, sessionPath) }),
    ...contractMeta(),
    run: opts.run,
  };
}

/** One failed slot on the result card: reason, what happened, next step, evidence. */
function failureLines(id: string, m: ModelStatus): string[] {
  const reason = m.error?.reason;
  const out = [`  ${id}  ${slotStateOf(m)}  reason=${reason ?? "unknown"}`];
  // A blocked slot's detail is the question it stopped on.
  if (m.error?.detail)
    out.push(`      ${reason === "blocked" ? "question" : "what"}: ${m.error.detail}`);
  out.push(`      next: ${(reason && NEXT_STEP[reason]) || "read the evidence log"}`);
  out.push(
    m.error?.errorLogPath
      ? `      evidence: ${m.error.errorLogPath}`
      : "      evidence: NONE CAPTURED — orchestrator bug, report via report_error"
  );
  return out;
}

export function formatTeamResult(status: TeamStatus, sessionPath: string): string {
  const entries = Object.entries(status.models).sort(([a], [b]) => a.localeCompare(b));
  // Everything that is not COMPLETED belongs with the failures: EMPTY (the turn settled
  // but its answer is unusable), CANCELLED (the caller stopped it), FAILED and TIMEOUT.
  // Filing EMPTY under "succeeded" is what forced callers to infer failure from
  // outputSize by hand.
  const succeeded = entries.filter(([, m]) => m.state === "COMPLETED");
  const failed = entries.filter(([, m]) => m.state !== "COMPLETED");

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
      // R3-M5: an open background shell (or a truncated turn) is worth a line.
      for (const a of m.anomalies ?? []) lines.push(`      note: ${a}`);
    }
  }

  if (failed.length > 0) {
    lines.push("failures:");
    for (const [id, m] of failed) lines.push(...failureLines(id, m));
    lines.push("actions:");
    lines.push("  final screen and answer for one failure → Read the evidence path above");
    lines.push(
      `  machine-readable status                → team(mode="status", path="${sessionPath}")`
    );
    lines.push(
      `  report a provider bug                  → report_error(session_path="${sessionPath}")`
    );
  }

  lines.push("<<<END_TEAM_RESULT>>>");
  return lines.join("\n");
}

// ─── team: the mod-contract verbs (§8 A–D) ───────────────────────────────────

type ToolAnswer = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function contractAnswer(value: unknown): ToolAnswer {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Every §8 verb answers its errors as the `ContractError` JSON with `isError: true`. */
function contractErrorAnswer(e: unknown): ToolAnswer {
  const err =
    e instanceof ContractErrorException
      ? e
      : new ContractErrorException("invalid_args", e instanceof Error ? e.message : String(e));
  return {
    content: [{ type: "text", text: JSON.stringify(err.toContractError()) }],
    isError: true,
  };
}

function contractPath(raw: unknown, mode: string): string {
  if (typeof raw !== "string" || !raw)
    throw new ContractErrorException("invalid_args", `'path' is required for mode '${mode}'`);
  try {
    return validateSessionPath(raw);
  } catch (e) {
    throw new ContractErrorException("invalid_args", e instanceof Error ? e.message : String(e));
  }
}

function optionalString(raw: unknown, name: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw)
    throw new ContractErrorException("invalid_args", `'${name}' must be a non-empty string`);
  return raw;
}

/** A boolean argument: absent → false; anything but a JSON boolean is the caller's error. */
function optionalBoolean(raw: unknown, name: string): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean")
    throw new ContractErrorException("invalid_args", `'${name}' must be a boolean`);
  return raw;
}

/** An integer argument such as `since_seq`; absent → undefined. */
function optionalInteger(raw: unknown, name: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw))
    throw new ContractErrorException("invalid_args", `'${name}' must be an integer`);
  return raw;
}

/** A required integer argument such as `cols`; absent or not an integer → `invalid_args`. */
function requiredInteger(raw: unknown, name: string, mode?: string): number {
  const n = optionalInteger(raw, name);
  if (n === undefined)
    throw new ContractErrorException(
      "invalid_args",
      `'${name}' is required${mode ? ` for mode '${mode}'` : ""}`
    );
  return n;
}

/**
 * `team(mode="status")` (§8 B): the legacy payload of the newest run at `path` plus
 * `contract_version`, `capabilities` and `run`. Given a `run_id` that a newer run at the
 * same path superseded, only `run` and the contract keys: `status.json` there now
 * belongs to the newer run.
 */
export function teamStatusAnswer(path: string, runId?: string): Record<string, unknown> {
  let row: TeamRunRow | null = null;
  if (runId) {
    row = teamRunRow(path, runId);
    if (!row)
      throw new ContractErrorException(
        "unknown_run",
        `no team run with run_id ${runId} at ${path} is retained by this server`
      );
    if (isSupersededRun(runId)) return { ...contractMeta(), run: row };
  } else {
    row = teamRunRow(path);
  }
  let status: TeamStatus;
  try {
    status = getStatus(path);
  } catch {
    if (row) return { ...contractMeta(), run: row };
    throw new ContractErrorException(
      "unknown_run",
      `no team run at ${path}: no status.json there and no run held by this server`
    );
  }
  const live = teamLiveMaps(path, runId);
  return buildTeamStatusPayload({
    status,
    sessionPath: path,
    idle: live?.idle ?? null,
    activity: live?.activity ?? null,
    liveBytes: live?.liveBytes ?? null,
    run: row ?? teamRunRowFromDisk(path, status),
    endRecordMissing: live?.endRecordMissing,
  });
}

/**
 * `list` / `status` / `cancel` / `capture` / `resize`: memory reads and the two pane verbs,
 * JSON answers, ContractError errors.
 */
export async function teamContractVerb(
  mode: "list" | "status" | "cancel" | "capture" | "resize",
  args: Record<string, unknown>
): Promise<ToolAnswer> {
  try {
    if (mode === "list") return contractAnswer(listTeamRuns());
    // Every argument's TYPE is checked before the run is looked up: a wrongly typed argument
    // is the caller's error whether or not the run exists (§8 E).
    const path = contractPath(args.path, mode);
    const runId = optionalString(args.run_id, "run_id");
    const slot = optionalString(args.slot, "slot");
    const since = optionalInteger(args.since_seq, "since_seq");
    const spans = optionalBoolean(args.spans, "spans");
    const cols = mode === "resize" ? requiredInteger(args.cols, "cols", mode) : undefined;
    const rows = mode === "resize" ? requiredInteger(args.rows, "rows", mode) : undefined;
    switch (mode) {
      case "status":
        return contractAnswer(teamStatusAnswer(path, runId));
      case "cancel":
        return contractAnswer(await cancelTeamRun(path, slot, runId));
      case "capture": {
        if (slot === undefined)
          throw new ContractErrorException("invalid_args", "'slot' is required for mode 'capture'");
        return contractAnswer(captureTeamSlot(path, slot, since, spans, runId));
      }
      case "resize": {
        if (slot === undefined)
          throw new ContractErrorException("invalid_args", "'slot' is required for mode 'resize'");
        return contractAnswer(
          await resizeTeamSlot(path, slot, cols as number, rows as number, runId)
        );
      }
    }
  } catch (e) {
    return contractErrorAnswer(e);
  }
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

function defineTools(sessionManager: SessionManager, nested: boolean): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // A nested server does not register `report_error` (mcp/nested-mode.ts), so an
  // error text must not point at it.
  const reportHint = (text: string): string => (nested ? "" : text);

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
      "One quick prompt, straight to one model's API: a single request and its answer. No " +
      "Claude Code session, no tools, no files, no conversation state — this is not subagent " +
      "work. For a task that needs tools, files or more than one turn, use create_session " +
      "(one model) or team (several models). Non-Claude models (Kimi, GLM, Qwen, MiniMax, " +
      "Gemini, GPT, Grok, …) go through claudish's routing straight to the provider's API. " +
      "A Claude model name (claude-*, opus, sonnet, haiku) runs as one Claude Code " +
      "print-mode call on the user's own Claude Code login, with tools, MCP servers and " +
      "settings off.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Model name or model spec. A bare name auto-routes to the best provider; " +
            "'provider@model' pins the provider (e.g. 'google@gemini-4-argon', " +
            "'or@x-ai/grok-4.7'). A bare Claude name (claude-*, opus, sonnet, haiku) runs on " +
            "Claude Code's own login.",
        },
        prompt: { type: "string", description: "The prompt to send to the model" },
        system_prompt: { type: "string", description: "Optional system prompt" },
      },
      required: ["model", "prompt"],
    },
    group: "low-level",
    // A single reasoning model can block for many minutes with nothing on the
    // wire. Handler body unchanged — the dispatch owns the keepalive.
    heartbeat: true,
    handler: async (args, ctx) => {
      try {
        const result = await runPrompt(
          args.model as string,
          args.prompt as string,
          args.system_prompt as string | undefined,
          ctx.signal
        );
        return { content: [{ type: "text" as const, text: formatRunPromptResult(result) }] };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: withOpFailureContext(
                `Error: ${errMsg}${reportHint(`\n\n---\n**To report this error**, use the \`report_error\` tool with \`error_type: "provider_failure"\` and \`model: "${args.model}"\`.`)}`,
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

      return {
        content: [
          {
            type: "text" as const,
            text: renderRecommendedMarkdown(doc, nativeShortcutForVendor),
          },
        ],
      };
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
    description:
      "DEBUG. Send the same single prompt to several models, one after another, and show " +
      "their answers side by side — to check that routes answer or to eyeball raw answers. " +
      "Each model gets exactly what run_prompt sends: one request, no tools, no Claude Code " +
      "session. Not for real work: use team for a blind-judged multi-model run, or " +
      "create_session for one model doing a task.",
    inputSchema: {
      type: "object",
      properties: {
        models: {
          type: "array",
          items: { type: "string" },
          description: "List of model names or model specs to compare, in the order to run them",
        },
        prompt: { type: "string", description: "The prompt to send to all models" },
        system_prompt: { type: "string", description: "Optional system prompt" },
      },
      required: ["models", "prompt"],
    },
    group: "debug",
    // N models run SEQUENTIALLY below, so the total blocking time is the sum of
    // every model's latency — the easiest of the three tools to push past the
    // client's idle window.
    heartbeat: true,
    handler: async (args, ctx) => {
      const modelIds = args.models as string[];
      const prompt = args.prompt as string;
      const systemPrompt = args.system_prompt as string | undefined;

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
          const result = await runPrompt(model, prompt, systemPrompt, ctx.signal);
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
        output += reportHint(
          '---\n**To report failed model(s)**, use the `report_error` tool with `error_type: "provider_failure"` and the model ID(s) above.\n'
        );
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
          rows.push(
            `| \`${model}\` | — | — | ❌ no route | ${noRouteCell(plan.reason, plan.hint)} |`
          );
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
      "Run AI models on a task with anonymized outputs and optional blind judging. Every " +
      "slot is an interactive Claude Code session in its own headless magmux pane. " +
      "Modes: 'run' (START the models and return once each has taken its prompt — it does " +
      "NOT wait for answers), 'status' (per-slot state; read `run.slots`), 'list' (every " +
      "run this server holds), 'capture' (one slot's screen), 'resize' (set one slot's " +
      "terminal size), 'cancel' (stop one slot or the whole run), 'judge'(blind-vote on existing outputs), 'run-and-judge' (the " +
      "blocking pipeline). Poll 'status' (read run.slots) or 'list'. " +
      "NO SLOT IS EVER KILLED ON A TIMER once its prompt is accepted. A team slot is a full " +
      "Claude Code session and may work for a long time; a slot inside a build or test " +
      "suite emits nothing for minutes and is working, not stuck. Judge the silence " +
      "against the task you set, and use 'cancel' if you decide a slot is wedged. A slot " +
      "that stops on a question it cannot answer is FAILED 'blocked' (team has no way to " +
      "answer it). JUDGING A WORKING SLOT: read live_output_bytes_by_slot, " +
      "idle_seconds_by_slot and activity_by_slot (or each row's idle_seconds and " +
      "activity). Do NOT use 'outputSize' — it is the size of the final answer, written " +
      "only when a slot finishes, so it is 0 for every working slot no matter how much " +
      "that slot has produced.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["run", "judge", "run-and-judge", "status", "cancel", "list", "capture", "resize"],
          description:
            "Operation mode. 'run' STARTS the models and returns once every slot has taken " +
            "its prompt (or failed to) — it does not wait for answers. Poll 'status' (read " +
            "`run.slots`) or 'list' for progress, then 'judge' once the slots have " +
            "finished. 'capture' returns one slot's screen; 'resize' sets its terminal size. " +
            "'run-and-judge' is the blocking pipeline and holds the call open for the whole run. 'cancel' stops one slot or " +
            "the whole run.",
        },
        slot: {
          type: "string",
          description:
            "For 'cancel', 'capture' and 'resize': the anonymised slot id (e.g. '02') from the " +
            "slot map 'run' returned. 'capture' and 'resize' require it; for 'cancel', omit it " +
            "to stop every slot in the run.",
        },
        path: {
          type: "string",
          description:
            "Session directory path (must be within current working directory). Required " +
            "by every mode except 'list'.",
        },
        run_id: {
          type: "string",
          description:
            "For 'status', 'cancel', 'capture' and 'resize': the run_id a 'run' answer " +
            "returned. It " +
            "addresses THAT run while this server retains it, even after a newer run reused " +
            "the path. Omit it to address the newest run at 'path'.",
        },
        since_seq: {
          type: "number",
          description:
            "For 'capture': the `seq` of the screen you already hold. When it is still " +
            "current the answer is `{unchanged:true}`; any other value returns the full screen.",
        },
        spans: {
          type: "boolean",
          description: "For 'capture': also return the colour/attribute spans of each line.",
        },
        cols: {
          type: "integer",
          description:
            "For 'resize' (required): the terminal width in columns, clamped to 40–9999. The " +
            "answer {run_id, path, slot, cols, rows, changed, seq} reports the size set.",
        },
        rows: {
          type: "integer",
          description:
            "For 'resize' (required): the terminal height in rows, clamped to 24–9999 and to " +
            "at most 4 000 000 cells (cols × rows).",
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
            "so a native reviewer that never produced the required shape is reported " +
            "EMPTY 'shape_mismatch' instead of silently succeeding.",
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
            "Regex (no flags) the slot's answer MUST match, or the slot is reported EMPTY " +
            "with reason 'shape_mismatch' instead of succeeded. The answer is the turn's " +
            "assistant text, read from the transcript; for a prompt delivered as a file it " +
            "starts after the child read that file, so `^` anchors to the answer's start. " +
            "Strongly recommended whenever your prompt mandates an output shape — e.g. " +
            "'```vote' for a voting panel.",
        },
        min_output_bytes: {
          type: "number",
          description:
            "Report a slot EMPTY if its answer is shorter than this many bytes (default 0 = " +
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
            "model in the run (native and external alike); there is no per-model form. An " +
            "unknown agent fails the slot 'agent_rejected', listing the available agents.",
        },
        claude_flags: {
          type: "string",
          description:
            "Any other Claude Code flags, space-separated (e.g. '--effort high " +
            "--permission-mode plan'): flags and their values only, never positional text. " +
            "One value per flag (write '--allowedTools Read,Bash'). Flags that would break " +
            "the interactive pane (-p, --output-format, --resume, …) and print-mode-only " +
            "flags (--max-turns, --max-budget-usd, …) are refused. Prefer the dedicated " +
            "'agent' parameter for the subagent; an --agent given here is ignored when " +
            "'agent' is also set. NOTE: split on whitespace, so a flag VALUE containing " +
            'spaces (e.g. --append-system-prompt "two words") cannot be expressed here.',
        },
      },
      required: ["mode"],
    },
    group: "agentic",
    // The tool the whole keepalive exists for: a real run was aborted at exactly
    // 1800s with no `notifications/progress` on the wire. A progress frame is the
    // only notification measured to reset the client's MCP idle timer.
    //
    // Still needed even though `run` no longer blocks on answers: `run-and-judge` is
    // the pipeline mode and holds the call open for the whole run, and `run` itself
    // waits up to boot + admission (≤ 120 s) for every slot to take its prompt.
    //
    // The background run keeps calling `ctx.reportProgress` after `run` has
    // returned. That is safe by contract — see ToolCallContext: a no-op once the
    // heartbeat is stopped, and it never throws.
    heartbeat: true,
    handler: async (args, ctx) => {
      const mode = args.mode as string;
      if (
        mode === "list" ||
        mode === "status" ||
        mode === "cancel" ||
        mode === "capture" ||
        mode === "resize"
      ) {
        return teamContractVerb(mode, args);
      }
      try {
        if (mode !== "run" && mode !== "judge" && mode !== "run-and-judge")
          throw new Error(`Unknown mode: ${mode}`);
        const path = args.path;
        if (typeof path !== "string" || !path) throw new Error(`'path' is required for '${mode}'`);
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
        const childFlags = buildChildClaudeFlags(args.agent, args.claude_flags) ?? [];
        // No agent probe here: the interactive child refuses an unknown --agent itself,
        // before any model request, and that slot is FAILED agent_rejected (D11).

        const resolved = validateSessionPath(path);

        const runOpts = {
          requirePattern,
          minOutputBytes,
          claudeFlags: childFlags,
          onProgress: (u: { phase: "running" | "settled" }) => {
            // A state change is real news, so refresh the client's idle timer at
            // that moment as well as on the periodic tick. Short phase string only:
            // the run's progress is read with `team(mode:"status")`, never pushed.
            ctx.reportProgress(`team: ${u.phase}`);
          },
        };

        /** The prompt the slots will get: `input`, else an input.md already in the dir. */
        const promptText = (): string | undefined => {
          if (input !== undefined) return input;
          const existing = join(resolved, "input.md");
          return existsSync(existing) ? readFileSync(existing, "utf-8") : undefined;
        };

        switch (mode) {
          case "run": {
            if (!models?.length) throw new Error("'models' is required for 'run' mode");
            // Every refusal BEFORE anything is written: a refused run leaves no
            // session directory, no record and no pane (§4.1).
            await preflightTeamRun({
              path: resolved,
              slots: models.length,
              claudeFlags: childFlags,
              input: promptText(),
              requirePattern,
            });
            setupSession(resolved, models, input);

            // The run's record in the sessions directory, for observers outside
            // this process (the magus claudish plugin monitor): the run's own
            // status.json lives wherever the caller pointed `path`, and the record
            // is how an observer outside this process learns the run ended.
            // Written BEFORE any pane exists; a throw here fails the call with
            // nothing started.
            const parentClaudeSessionId = await parentSessionForCall({
              hostPid: sessionManager.hostPid,
            });
            const monitorRecord = sessionManager.recordTeamRun({
              teamPath: resolved,
              slots: models.length,
              parentClaudeSessionId,
            });
            const settleRecord = (outcome: TeamRunOutcome): void =>
              sessionManager.finishTeamRun(monitorRecord, outcome);

            // Returns once every slot has LEFT STARTING (D9): its prompt was
            // accepted, or it failed to boot or to take it. Never once the answers
            // exist: a team slot can legitimately work for a long time, and holding
            // the call open for that made the run's duration the client's problem.
            //
            // The record's end is passed IN as `onSettled`, so it exists before
            // the first pane and fires however fast the run settles. If
            // `startModels` throws, it has already reaped whatever it started;
            // the record ends `failed`, `reason: start-failed`, and the ORIGINAL
            // error reaches the caller (`finishTeamRun` never throws).
            let handle: Awaited<ReturnType<typeof startModels>>;
            try {
              handle = await startModels(resolved, {
                ...runOpts,
                onSettled: (status) => settleRecord(summarise(status)),
              });
            } catch (err) {
              const counts = summarise(readTeamStatus(resolved));
              settleRecord({
                ...counts,
                slots: Math.max(counts.slots, models.length),
                failed: models.length - counts.ok - counts.cancelled,
                status: "failed",
                reason: "start-failed",
              });
              throw err;
            }
            const run = teamRunRow(resolved, handle.runId);
            const p = handle.sessionPath;
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      started: true,
                      run_id: handle.runId,
                      team_session_id: handle.teamSessionId,
                      session_path: p,
                      monitor_record: monitorRecord,
                      slots: handle.slots,
                      run,
                      next: {
                        status: `team(mode:"status", path:"${p}", run_id:"${handle.runId}") — read run.slots`,
                        list: `team(mode:"list")`,
                        capture: `team(mode:"capture", path:"${p}", slot:"<id>")`,
                        cancel: `team(mode:"cancel", path:"${p}", slot:"<id>")`,
                        judge: `team(mode:"judge", path:"${p}") once every slot has finished`,
                      },
                      note:
                        "Every slot has taken its prompt or failed to. Nothing terminates a " +
                        "working slot on a timer: `status` reports each slot's state, " +
                        "activity and seconds of silence; a slot inside a long build is " +
                        "quiet and working. You decide whether to cancel.",
                    },
                    null,
                    2
                  ),
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
            await preflightTeamRun({
              path: resolved,
              slots: models.length,
              claudeFlags: childFlags,
              input: promptText(),
              requirePattern,
            });
            setupSession(resolved, models, input);
            const handle = await startModels(resolved, runOpts);
            await handle.done;
            const run = teamRunRow(resolved, handle.runId);
            const verdict = await judgeResponses(resolved, { judges, claudeFlags: childFlags });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ ...verdict, run_id: handle.runId, run }, null, 2),
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

  // ── Session Tools ────────────────────────────────────────────────────

  tools.push({
    name: "create_session",
    description:
      "Create a new claudish proxy session for an external model: an interactive Claude Code running " +
      "it in its own headless magmux pane. Returns at once with state STARTING; nothing is " +
      "pushed while it runs: poll list_sessions (about once every 10 s) for its state, then " +
      "call get_output once it is COMPLETED. With a prompt it is one-shot (it ends when that turn " +
      `settles); without one it is interactive and waits for send_input. Needs magmux >= ${MIN_MAGMUX_VERSION} ` +
      "(darwin and linux).",
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
          type: "integer",
          minimum: 1,
          maximum: 3600,
          description:
            "Session timeout in whole seconds, 1-3600 (default: 600). Out-of-range values are clamped.",
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
            "Any other Claude Code / claudish flags and their values, space-separated — no " +
            "positional text. Unrecognised flags pass through to the child Claude Code. " +
            "Flags the pane owns or that only work in print mode are refused. NOTE: split on " +
            "whitespace, so a flag VALUE containing spaces cannot be expressed here.",
        },
        work_dir: {
          type: "string",
          description: "Working directory for the session (default: current directory)",
        },
        setup_from: {
          type: ["string", "null"],
          description:
            "Directory whose .claude/settings.json and settings.local.json the session " +
            "inherits (enabled plugins, permissions, env), so a session in another work_dir " +
            "keeps the caller's plugins and agents; an explicit path must be an existing " +
            "directory. Default: the caller's project directory, " +
            "when work_dir differs from it. null keeps the session on work_dir's own settings only.",
        },
      },
      required: ["model"],
    },
    group: "session",
    handler: async (args) => {
      try {
        const claudishFlags = buildChildClaudeFlags(args.agent, args.claude_flags) ?? [];
        // Refusals first, before any credential work: reserved or positional flags, then
        // a missing magmux (its message starts with the code word). An unknown --agent is
        // refused by the child itself, before any model request (D11).
        const flagCheck = checkChildFlags(claudishFlags);
        if (!flagCheck.ok) throw new Error(`invalid_args: ${flagCheck.message}`);
        await assertMagmuxAvailable();

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

        const plan = await prehydrateCredentialsForSpawn([requestedModel], {
          pin: workDir === undefined || resolve(workDir) === process.cwd(),
        });

        // The conversation live in the calling window, from the host's session
        // record: one read at call time, no wait. See mcp-session/parent-session.ts.
        const parentClaudeSessionId = await parentSessionForCall({
          hostPid: sessionManager.hostPid,
        });

        // Reserves the pane, writes prompt.md and spawn.json, then starts the pane; no
        // boot wait.
        const sessionId = await sessionManager.createSession({
          model: requestedModel,
          spawnModel: plan.pinned.get(requestedModel),
          prompt: args.prompt as string | undefined,
          timeoutSeconds: args.timeout_seconds as number | undefined,
          claudishFlags,
          cwd: workDir,
          // Claude Code reads project settings only from the child's own cwd.
          setupFrom: resolveSetupFrom(args.setup_from, workDir, process.cwd()),
          parentClaudeSessionId,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                session_id: sessionId,
                state: sessionManager.getSession(sessionId).state,
              }),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        // A missing magmux or a full pane limit is the environment, not the provider:
        // `Error: <code>: …` with the code first (§4.3), and no report_error hint.
        // A refused argument is the CALLER's error: same bare form, never a provider_failure hint.
        const code = (error as { code?: unknown } | null)?.code;
        if (
          code === "magmux_unavailable" ||
          code === "pane_limit" ||
          errMsg.startsWith("invalid_args:")
        ) {
          return { content: [{ type: "text" as const, text: `Error: ${errMsg}` }], isError: true };
        }
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
      "Send a prompt to a session. Accepted in every non-terminal state and queued until the " +
      "session is idle: STARTING and RUNNING queue it; AWAITING_INPUT delivers it at once; during " +
      "a question or a permission dialog the dialog is declined (Esc) and the text becomes the next " +
      "prompt. Any accepted send makes a one-shot session interactive. Returns {success, queued} or " +
      "{success:false, reason, state}.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_session" },
        text: { type: "string", description: "Text to send to the session" },
      },
      required: ["session_id", "text"],
    },
    group: "session",
    handler: async (args) => {
      const result = sessionManager.sendInput(args.session_id as string, args.text as string);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  });

  tools.push({
    name: "get_output",
    description:
      "Get a session's answer prose (each settled turn's assistant text, from its transcript). " +
      "Call once list_sessions shows the session COMPLETED (or between turns of an " +
      "interactive session).",
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
    group: "session",
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
      "Cancel a session. Returns once its state is CANCELLED ({session_id, state, changed}); the " +
      "pane close and process-group reap finish in the background. Idempotent: a second call " +
      "returns the same state with changed:false. Errors are a JSON ContractError.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID to cancel" },
      },
      required: ["session_id"],
    },
    group: "session",
    handler: async (args) => {
      try {
        const sessionId = optionalString(args.session_id, "session_id");
        if (sessionId === undefined)
          throw new ContractErrorException("invalid_args", "'session_id' is required");
        return contractAnswer(sessionManager.cancelSession(sessionId));
      } catch (e) {
        return contractErrorAnswer(e);
      }
    },
  });

  tools.push({
    name: "list_sessions",
    description:
      "List sessions: {contract_version, capabilities, sessions}. Optionally include " +
      "finished ones. Each row reports `state`, `activity` and `idle_seconds`: how long since " +
      "the session's screen or transcript last changed. Nothing kills a session for being " +
      "idle — a child inside a long Bash call is silent and working — so this is yours to " +
      "judge against the task you set, and `cancel_session` is yours to call if the answer is no. " +
      "A failed row's `reason_detail` is one line saying why (for api_error, the provider's " +
      "own error message); it is null while the session is live and on COMPLETED.",
    inputSchema: {
      type: "object",
      properties: {
        include_completed: {
          type: "boolean",
          description: "Include completed/failed/cancelled sessions (default: false)",
        },
      },
    },
    group: "session",
    handler: async (args) => {
      try {
        const includeCompleted = optionalBoolean(args.include_completed, "include_completed");
        return contractAnswer({
          ...contractMeta(),
          sessions: sessionManager.listSessionRows(includeCompleted),
        });
      } catch (e) {
        return contractErrorAnswer(e);
      }
    },
  });

  // Diagnostics as API.
  //
  // Two sessions once ran 900 seconds of genuine billed work — 241
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
      "Explain what a session actually did — its final screen, upstream error bodies, " +
      "the recent state records, anomalies, the resolved model chain, accounting, and the paths " +
      "to the full records (transcript included). Call this FIRST whenever a session fails, times " +
      "out, or completes with empty or surprising output; it needs no re-run and no debug flag. " +
      "`idleSeconds` reports how long since the screen or transcript last changed, and is null " +
      "once the session is no longer live. It is information, never a verdict: claudish does " +
      "not terminate a session for silence.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_session" },
        event_limit: {
          type: "number",
          description:
            "How many of the most recent state records to include (default: 40, max: 200). " +
            "0 omits them; `event_log_path` always has the full record.",
        },
      },
      required: ["session_id"],
    },
    group: "session",
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

  tools.push({
    name: "capture_session",
    description:
      "Read a session's current terminal screen: {seq, cols, rows, cursor, lines, final, " +
      "spans?}. A memory read, meant for polling about once per second. Pass the last `seq` as " +
      "since_seq to get {unchanged:true, seq, final} while nothing changed. `final:true` is the " +
      "last screen of a closed pane. Errors are a JSON ContractError.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_session" },
        since_seq: {
          type: "number",
          description: "The seq of your previous capture; an equal seq answers {unchanged:true}",
        },
        spans: {
          type: "boolean",
          description: "Include per-row colour and attribute runs (default: false)",
        },
      },
      required: ["session_id"],
    },
    group: "session",
    handler: async (args) => {
      try {
        const sessionId = optionalString(args.session_id, "session_id");
        if (sessionId === undefined)
          throw new ContractErrorException("invalid_args", "'session_id' is required");
        const since = optionalInteger(args.since_seq, "since_seq");
        const spans = optionalBoolean(args.spans, "spans");
        return contractAnswer(sessionManager.captureSession(sessionId, since, spans));
      } catch (e) {
        return contractErrorAnswer(e);
      }
    },
  });

  tools.push({
    name: "resize_session",
    description:
      "Set a session's terminal size: the child gets a real SIGWINCH and Claude Code reflows. " +
      "Allowed at any time, mid-turn included; the last call wins. The size is clamped to " +
      "cols 40–9999, rows 24–9999 and at most 4 000 000 cells (claudish's floor, magmux's " +
      "ceiling); the answer " +
      "{session_id, cols, rows, changed, seq, pending?} reports the size set. `seq` is the screen's seq after the resize: the next capture_session " +
      "shows the new cols/rows. `changed:false` = already that size. `pending:true` = the pane " +
      "is starting or its socket is reconnecting; the size is applied then. A finished session " +
      "answers its last size with changed:false. Errors are a JSON ContractError " +
      "(`resize_unsupported` when the installed magmux has no resize op).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from create_session" },
        cols: { type: "integer", description: "Terminal width in columns (clamped to 40–9999)" },
        rows: {
          type: "integer",
          description: "Terminal height in rows (clamped to 24–9999 and 4 000 000 cells)",
        },
      },
      required: ["session_id", "cols", "rows"],
    },
    group: "session",
    handler: async (args) => {
      try {
        const sessionId = optionalString(args.session_id, "session_id");
        if (sessionId === undefined)
          throw new ContractErrorException("invalid_args", "'session_id' is required");
        const cols = requiredInteger(args.cols, "cols");
        const rows = requiredInteger(args.rows, "rows");
        return contractAnswer(await sessionManager.resizeSession(sessionId, cols, rows));
      } catch (e) {
        return contractErrorAnswer(e);
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
    case "session":
      return new Set(["session"]);
    case "debug":
      return new Set(["debug"]);
    default:
      // Every other value — `all`, unset, a typo, or the removed `channel` — is
      // everything. `channel` gets no alias: a rename removes the old name.
      return new Set(["low-level", "agentic", "session", "debug"]);
  }
}

/** Every value `CLAUDISH_MCP_TOOLS` recognises, in the order the docs list them. */
const TOOL_MODES = ["all", "low-level", "agentic", "session", "debug"] as const;

/**
 * The stderr line for a `CLAUDISH_MCP_TOOLS` value that names no tool mode, or
 * undefined for a recognised one. The value still selects every tool; the line
 * exists so a typo, or the removed `channel`, is not silently read as `all`.
 */
function unknownToolModeWarning(mode: string): string | undefined {
  if ((TOOL_MODES as readonly string[]).includes(mode)) return undefined;
  const renamed = mode === "channel" ? " (`channel` was renamed to `session`)" : "";
  return `[claudish] CLAUDISH_MCP_TOOLS=${JSON.stringify(mode)} is not a tool mode${renamed}; selecting all tools. Valid values: ${TOOL_MODES.join(", ")}`;
}

// ─── Server Setup ────────────────────────────────────────────────────────────

/**
 * Whether `claudish --mcp` writes the debug log (`logs/` in the working directory):
 * the same switches as every other claudish run. `--debug-claudish` / `-d` turn it
 * on and `--no-debug-claudish` off, the last one on the command line winning; without
 * a flag, `CLAUDISH_DEBUG` decides (1/true on, 0/false or unset off). The MCP server
 * runs no `parseArgs`, so it reads these itself.
 */
export function mcpDebugLogEnabled(
  argv: readonly string[],
  env: Record<string, string | undefined>
): boolean {
  let flag: boolean | undefined;
  for (const arg of argv) {
    if (arg === "--debug-claudish" || arg === "-d") flag = true;
    else if (arg === "--no-debug-claudish") flag = false;
  }
  if (flag !== undefined) return flag;
  const fromEnv = env.CLAUDISH_DEBUG?.toLowerCase();
  return fromEnv === "1" || fromEnv === "true";
}

async function main() {
  // FIRST, before anything can start loadHooksOnce(): descriptor 1 belongs to
  // the JSON-RPC writer alone. Every other stdout route — Bun's native
  // console.log, process.stdout.write, fs.writeSync(1), Bun.write(Bun.stdout),
  // an inheriting child — lands on stderr or in the debug log, so no hook
  // output (and no stray write of claudish's own) can corrupt the protocol.
  // Where libc cannot be bound, `active` is false, stdout is untouched, and the
  // loader loads no user hook module in this process.
  const iso: ProtocolStdout = isolateProtocolStdout();

  // The debug log is also where hook output and diverted stdout writes go.
  if (mcpDebugLogEnabled(process.argv.slice(2), process.env)) initLogger(true, "debug", true);
  if (!iso.active) log(`[mcp] protocol stdout not isolated: ${iso.reason ?? "unknown"}`);

  // Session hooks need the engine without a proxy, so loading starts now, in the
  // background. The MCP server's own proxy (run_prompt, preflight) awaits the
  // same memoised promise before it builds a handler.
  void loadHooksOnce({ hostMode: "mcp" });

  const toolMode = (process.env.CLAUDISH_MCP_TOOLS || "all").toLowerCase();
  // Inside a session a claudish owner started, one level of nesting is the limit:
  // only the one-shot tools of NESTED_MCP_TOOL_NAMES, intersected with the groups
  // CLAUDISH_MCP_TOOLS enables (never widened), no channel capability, and the
  // nested instructions. See pane-session.md § One level of nesting.
  const nested = inMcpSession();
  const enabledGroups = resolveToolGroups(toolMode);
  const toolModeWarning = unknownToolModeWarning(toolMode);
  if (toolModeWarning) console.error(toolModeWarning);

  // Tools only, for every tool mode. No `experimental: {"claude/channel": {}}`: the
  // server pushes nothing; a host polls `list_sessions` and reads the records.
  const server = new Server(
    // `version.ts` is generated from packages/cli/package.json, so serverInfo names
    // the release the host is actually talking to.
    { name: "claudish", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: nested ? NESTED_INSTRUCTIONS : INSTRUCTIONS,
    }
  );

  // Sessions are observed by polling (`list_sessions`, `get_output`) and through
  // their records on disk; nothing is pushed to the host.
  const sessionManager = new SessionManager();

  // Keepalive cadence for `heartbeat: true` tools. Resolved ONCE per server rather
  // than per call, so a long-lived session cannot change its behaviour mid-flight.
  const progressIntervalMs = resolveProgressIntervalMs();

  // Build tool registry
  const allTools = defineTools(sessionManager, nested);
  const nestedNames: readonly string[] = NESTED_MCP_TOOL_NAMES;
  const enabledTools = allTools.filter(
    (t) => enabledGroups.has(t.group) && (!nested || nestedNames.includes(t.name))
  );
  const toolMap = new Map(enabledTools.map((t) => [t.name, t]));

  console.error(
    `[claudish] MCP server started (tools: ${nested ? "nested" : toolMode}, ${enabledTools.length} tools)`
  );

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
  // reset that timer.
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
    const ctx: ToolCallContext = {
      reportProgress: (message) => heartbeat.tick(message),
      signal: extra.signal,
    };

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

  // Connect via stdio transport, writing through the protocol writer (the real
  // stdout's private descriptor when isolation is active).
  const transport = new StdioServerTransport(process.stdin, iso.protocolOut);
  await server.connect(transport);
  installMcpShutdown(sessionManager);
  // The startup sweep: panes whose owner died (and whose watcher died too) are reaped
  // after an identity check. Asynchronous, and once per root per process — the first
  // pane's own sweep (ensureSwept in startPaneSession) is this one, not a second `ps`.
  // A nested server registers no session tools and never spawns a pane, so it has
  // nothing to sweep.
  if (!nested) void ensureSwept(sockRootFor()).catch(() => undefined);
}

/**
 * Shutdown (D15 layer 3, §20.3 item 8): stdin EOF, transport close, SIGINT, SIGTERM and
 * SIGHUP settle every team run and session CANCELLED — so their records end
 * (`meta.json`, the closing wait line) — then reap every pane in parallel and exit.
 * Installed before any pane exists, so `startPaneSession`'s own default hooks never
 * replace these options. A SIGKILL of this process ends no record; the per-pane
 * watchers still remove the panes.
 */
function installMcpShutdown(sessionManager: SessionManager): void {
  const before = async (): Promise<void> => {
    // `run_prompt`'s Claude Code print children are plain processes, not panes: stop
    // their process groups here, or they outlive the server.
    stopAllClaudeCodePrintChildren();
    await Promise.allSettled([shutdownAllTeamRuns(), sessionManager.shutdownAll()]);
  };
  // The stdio transport closes when stdin does, so stdin's `end`/`close` is the
  // transport-close hook too.
  installPaneShutdownHooks({ stdin: true, before });
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Entry point for MCP server mode.
 * Called from index.ts when --mcp flag is used.
 */
export function startMcpServer() {
  // An MCP server never opens a credential dialog: its host is a program, and
  // its panes are pane children (`auth/credentials/prompt-role.ts`).
  setCredentialPromptRole("never");
  main().catch((error) => {
    console.error("[claudish] MCP fatal error:", error);
    process.exit(1);
  });
}
