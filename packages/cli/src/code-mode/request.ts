/**
 * Step 5d: the code-mode request shape for `openai-codex`.
 *
 * Runs after 5c, so `prompt_cache_key`, `store`, `include` and
 * `reasoning.summary` are already on the payload and are kept. The decision
 * (`decideCodeMode`) reads THIS request's auth binding, its Claude Code session
 * id, the account's `/models` discovery and whether the sandbox loads; when it
 * is on, the payload is rewritten into one of the two shapes the backend
 * accepts (R1 §1d), each carrying exactly one tool, the exec tool:
 *
 *   lite:    no top-level `tools` or `instructions`; `input` starts with
 *            `{type:"additional_tools", id:"at_<uuidv5>", role:"developer",
 *            tools:[exec]}` and a developer message carrying the system text;
 *            `reasoning.context: "all_turns"` (the lite header without it is a
 *            400, variant D); header `x-openai-internal-codex-responses-lite: true`.
 *   classic: `tools: [exec]`, `instructions` = the system text.
 *   both:    `parallel_tool_calls: false` (parallelism lives in the script),
 *            `tool_choice: "auto"`, `input` from `buildCodeModeInput`.
 *
 * The system text is the step-4 `instructions` (Claude Code's system prompt,
 * identity-filtered, after Layer 4) plus a short claudish note — not the
 * 21.7 KB Codex persona. Everything here degrades: a build that throws sends
 * the request non-code-mode (logged), never refuses it; discovery and the
 * sandbox resolve to "off" on any failure.
 */

import { createHash } from "node:crypto";
import { extractSessionId } from "../behavior/harness.js";
import { log } from "../logger.js";
import {
  type CodexModelInfo,
  getCodexModelInfo,
  prefetchCodexModels,
} from "../providers/codex-models-discovery.js";
import type { WireApi, WireHeader } from "../providers/connection-wire.js";
import type { AuthBinding } from "../providers/transport/types.js";
import {
  DEFAULT_EXEC_MAX_OUTPUT_TOKENS,
  type ExecToolDefinition,
  type ExecToolMeta,
  renderExecTool,
} from "./exec-tool.js";
import { accountKeyFromBinding, sessionKeyFor, uuidV5 } from "./ids.js";
import { buildCodeModeInput } from "./input-builder.js";
import { defaultExecOutputTokens } from "./output.js";
import {
  type CodeModeDecision,
  type CodeModeSetting,
  decideCodeMode,
  describeCodeModeDecision,
} from "./policy.js";
import { isSandboxAvailable } from "./sandbox/quickjs-loader.js";
import { getCodeModeStores } from "./stores.js";
import type { ToolNameTable } from "./tool-names.js";
import type { ResponsesItem } from "./types.js";

/** The header that marks a lite request (sent over HTTP; Codex's WebSocket uses client_metadata). */
export const LITE_HEADER_NAME = "x-openai-internal-codex-responses-lite";

/**
 * Appended to Claude Code's system prompt in code mode. Short on purpose: the
 * exec tool's own description carries the runtime contract.
 */
export const CODE_MODE_NOTE = [
  "# Tools in this session",
  "Every tool is called from JavaScript through the `exec` tool: `await tools.<Name>(args)` with the tool's own argument object. A tool's result is its text; a failed or denied call rejects with a string.",
  "Batch independent reads and searches in one exec with `await Promise.allSettled([...])` and inspect every result. Use `text()` to return what you need from the script.",
].join("\n");

/** How long a lite rejection keeps a model on the classic shape (the discovery TTL). */
export const LITE_FALLBACK_TTL_MS = 60 * 60 * 1000;

/** model slug (lowercase) → until when the classic shape is used instead of lite. */
const liteFallbackUntil = new Map<string, number>();

/** True while a lite rejection for `model` is remembered. */
export function isLiteFallbackActive(model: string, now: number = Date.now()): boolean {
  const until = liteFallbackUntil.get(model.toLowerCase());
  if (until === undefined) return false;
  if (now >= until) {
    liteFallbackUntil.delete(model.toLowerCase());
    return false;
  }
  return true;
}

/** Forget remembered lite rejections and logged decisions (tests only). */
export function resetCodeModeRequestStateForTests(): void {
  liteFallbackUntil.clear();
  lastLogged.clear();
}

/** Remember that the backend rejected a lite request for `model`. */
export function markLiteFallback(model: string, now: number = Date.now()): void {
  liteFallbackUntil.set(model.toLowerCase(), now + LITE_FALLBACK_TTL_MS);
  log(`[CodeMode] ${model}: lite request rejected; classic shape for the next hour`);
}

export interface CodeModePayloadContext {
  shape: "lite" | "classic";
  execTool: ExecToolDefinition;
  /** `buildCodeModeInput`'s output. */
  input: ResponsesItem[];
  sessionKey: string;
  modelInfo?: CodexModelInfo;
}

export interface CodeModeRequest {
  payload: any;
  /** The shape actually built (lite falls back to classic when no effort can be set). */
  shape: "lite" | "classic";
  /** Headers to merge into every header fetch of this request. */
  headers: WireHeader[];
}

function systemText(instructions: unknown): string {
  const base = typeof instructions === "string" ? instructions.trim() : "";
  return base ? `${base}\n\n${CODE_MODE_NOTE}` : CODE_MODE_NOTE;
}

/**
 * Lite needs `reasoning.context: "all_turns"`, which needs a reasoning object
 * with an effort: Claude Code's when it set one, else discovery's default
 * level (with `summary: "auto"`, as 5c adds). Undefined when neither exists:
 * the request then goes in the classic shape and nothing is pinned.
 */
function liteReasoning(payload: any, modelInfo: CodexModelInfo | undefined): any | undefined {
  const reasoning =
    payload.reasoning && typeof payload.reasoning === "object" ? payload.reasoning : {};
  if (typeof reasoning.effort === "string" && reasoning.effort) {
    return { ...reasoning, context: "all_turns" };
  }
  const level = modelInfo?.defaultReasoningLevel;
  if (!level) return undefined;
  return {
    ...reasoning,
    effort: level,
    summary: reasoning.summary ?? "auto",
    context: "all_turns",
  };
}

/**
 * Rewrite `payload` (mutated and returned) into the code-mode shape `ctx.shape`.
 * The caller passes a clone, so a throw leaves the original intact.
 */
export function applyCodeModeToPayload(payload: any, ctx: CodeModePayloadContext): CodeModeRequest {
  const system = systemText(payload.instructions);
  let shape = ctx.shape;
  const headers: WireHeader[] = [];

  if (shape === "lite") {
    const reasoning = liteReasoning(payload, ctx.modelInfo);
    if (reasoning) {
      const toolsHash = createHash("sha256").update(JSON.stringify(ctx.execTool)).digest("hex");
      payload.reasoning = reasoning;
      delete payload.tools;
      delete payload.instructions;
      payload.input = [
        {
          type: "additional_tools",
          id: `at_${uuidV5(ctx.sessionKey, toolsHash)}`,
          role: "developer",
          tools: [ctx.execTool],
        },
        { type: "message", role: "developer", content: [{ type: "input_text", text: system }] },
        ...ctx.input,
      ];
      headers.push({ name: LITE_HEADER_NAME, value: "true", merge: "append-comma" });
    } else {
      log("[CodeMode] no reasoning effort and no discovery default; classic shape instead of lite");
      shape = "classic";
    }
  }
  if (shape === "classic") {
    payload.tools = [ctx.execTool];
    payload.instructions = system;
    payload.input = ctx.input;
  }
  payload.parallel_tool_calls = false;
  payload.tool_choice = "auto";
  return { payload, shape, headers };
}

// ─── decision logging ─────────────────────────────────────────────────

const MAX_LOG_KEYS = 10_000;
/** session (or process-wide reason) → the last decision line logged for it. */
const lastLogged = new Map<string, string>();

/** Log the decision once per session per change; process-wide reasons once per process. */
function logDecision(
  line: string,
  sessionKey: string | undefined,
  decision: CodeModeDecision
): void {
  const processWide =
    !decision.on && (decision.reason === "no-account-id" || decision.reason === "no-session-id");
  const key = processWide ? `process:${decision.reason}` : (sessionKey ?? "process:no-session");
  if (lastLogged.get(key) === line) return;
  lastLogged.delete(key);
  lastLogged.set(key, line);
  while (lastLogged.size > MAX_LOG_KEYS) {
    const oldest = lastLogged.keys().next().value;
    if (oldest === undefined) break;
    lastLogged.delete(oldest);
  }
  log(line);
}

// ─── step 5d ──────────────────────────────────────────────────────────

export interface PrepareCodeModeInput {
  providerName: string;
  setting: CodeModeSetting;
  /** THIS request's auth binding (step 5b). */
  binding: AuthBinding | undefined;
  api: WireApi | undefined;
  /** Claude Code's request after Layer 4 (`tools`, `messages`, `tool_choice`, `metadata`). */
  claudeRequest: any;
  /** The upstream payload after 5c. */
  payload: any;
  /** Test seam: discovery wait. */
  discoveryWaitMs?: number;
}

export interface PreparedCodeMode {
  decision: CodeModeDecision;
  /** Present only when the decision is on and the build succeeded. */
  request?: CodeModeRequest;
  /** A deep clone of the post-5c payload, for the lite → classic fallback. */
  prePayload?: any;
  /** What the payload was built from; the lite → classic fallback rebuilds from it. */
  context?: CodeModePayloadContext;
  /** What the turn's exec calls run with (`createCodeModeTurnHooks`). */
  turn?: {
    accountKey: string;
    sessionKey: string;
    names: ToolNameTable;
    allTools: ExecToolMeta[];
    defaultMaxOutputTokens: number;
  };
}

/** Does a 400 body name the lite header or `reasoning.context` (the lite shape's own rejections)? */
export function isLiteRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  const text = body.toLowerCase();
  return text.includes(LITE_HEADER_NAME) || text.includes("reasoning.context");
}

/**
 * The lite → classic fallback: the classic code-mode shape built from the
 * post-5c payload clone and the same context (the same exec tool and the same
 * `buildCodeModeInput` output — never the non-code-mode function tools).
 * `model` is remembered for the discovery TTL, so the next requests go classic.
 */
export function rebuildAsClassic(
  prePayload: any,
  context: CodeModePayloadContext,
  model: string
): CodeModeRequest {
  markLiteFallback(model);
  return applyCodeModeToPayload(structuredClone(prePayload), { ...context, shape: "classic" });
}

/** `headers` without the lite header (a classic body with it is itself a 400, variant D). */
export function withoutLiteHeader(headers: WireHeader[]): WireHeader[] {
  return headers.filter((h) => h.name.toLowerCase() !== LITE_HEADER_NAME);
}

/**
 * Decide and, when on, build the code-mode request for one `openai-codex`
 * request. Never throws: every failure is "off" or a non-code-mode request.
 */
export async function prepareCodeModeRequest(
  input: PrepareCodeModeInput
): Promise<PreparedCodeMode> {
  try {
    return await prepare(input);
  } catch (err) {
    log(`[CodeMode] decision failed; sending this request non-code-mode: ${err}`);
    return { decision: { on: false, reason: "discovery-unknown" } };
  }
}

async function prepare(input: PrepareCodeModeInput): Promise<PreparedCodeMode> {
  const { binding, claudeRequest, payload } = input;
  const arm = binding?.auth?.arm;
  const accountKey = accountKeyFromBinding(binding);
  const sessionKey = sessionKeyFor(extractSessionId(claudeRequest), accountKey);
  const tools = Array.isArray(claudeRequest?.tools) ? claudeRequest.tools : [];
  const model = typeof payload?.model === "string" ? payload.model : "";

  // Warm the account's dynamic models catalog as early as possible (Claude
  // Code's first request is usually tool-less); never while the setting is off.
  if (input.setting !== "off" && binding && accountKey && arm === "oauth") {
    prefetchCodexModels(binding, accountKey);
  }

  const base = {
    providerName: input.providerName,
    arm,
    accountKey,
    api: input.api,
    hasTools: tools.length > 0,
    toolChoice: claudeRequest?.tool_choice,
    hasSessionId: sessionKey !== undefined,
    setting: input.setting,
    pinned: false,
    sandboxAvailable: true,
    liteFallbackActive: isLiteFallbackActive(model),
  };

  // Static gates first: no discovery wait, no store, no sandbox load.
  const gate = decideCodeMode({ ...base, modelInfo: undefined });
  if (!gate.on && gate.reason !== "discovery-unknown") {
    logDecision(describeCodeModeDecision(gate, undefined), sessionKey, gate);
    return { decision: gate };
  }

  const stores = getCodeModeStores();
  const pinned = sessionKey !== undefined && stores.scripts.isPinned(sessionKey);
  const modelInfo =
    binding && accountKey
      ? await getCodexModelInfo(model, binding, accountKey, { waitMs: input.discoveryWaitMs })
      : undefined;
  let decision = decideCodeMode({ ...base, pinned, modelInfo });
  if (decision.on && !(await isSandboxAvailable())) {
    decision = decideCodeMode({ ...base, pinned, modelInfo, sandboxAvailable: false });
  }
  logDecision(describeCodeModeDecision(decision, modelInfo), sessionKey, decision);
  if (!decision.on || !accountKey || !sessionKey) return { decision };

  try {
    const defaultMaxOutputTokens = defaultExecOutputTokens(
      modelInfo?.truncationPolicy,
      DEFAULT_EXEC_MAX_OUTPUT_TOKENS
    );
    const rendered = renderExecTool(tools, {}, { defaultMaxOutputTokens });
    const codeModeInput = buildCodeModeInput(
      Array.isArray(claudeRequest.messages) ? claudeRequest.messages : [],
      stores,
      { accountKey, sessionKey },
      { defaultMaxOutputTokens, toolNames: rendered.names }
    );
    const prePayload = structuredClone(payload);
    const context: CodeModePayloadContext = {
      shape: decision.shape,
      execTool: rendered.tool,
      input: codeModeInput,
      sessionKey,
      modelInfo,
    };
    const request = applyCodeModeToPayload(structuredClone(payload), context);
    return {
      decision,
      request,
      prePayload,
      context,
      turn: {
        accountKey,
        sessionKey,
        names: rendered.names,
        allTools: rendered.allTools,
        defaultMaxOutputTokens,
      },
    };
  } catch (err) {
    log(`[CodeMode] request build failed; sending this request non-code-mode: ${err}`);
    return { decision };
  }
}
