/**
 * claudish/hooks — the public hook contract.
 *
 * Everything a hook author can import lives here, and nothing else does. This
 * file imports nothing from the rest of claudish and has no side effects, so it
 * can be built on its own into `dist/hooks.js` + `dist/hooks.d.ts` and served to
 * user modules as the `claudish/hooks` virtual module (see `loader.ts`).
 *
 * Every internal hooks module takes its types from here, so the contract has a
 * single source.
 *
 * ## Process isolation
 *
 * A hook module's top-level state is PER PROCESS. In the interactive launcher,
 * proxy events (`request` … `responseEnd`, raw) and session events
 * (`sessionStart` … `sessionEnd`) run in one process. In `create_session` and
 * team children they do not: proxy events run in the pane child, and session
 * events run in the MCP server or the CLI process that drives the pane. Pass
 * per-turn data from a proxy event to `sessionIdle` with `annotateTurn`, never
 * with module variables.
 *
 * ## Output
 *
 * Log with `ctx.log`. `console.*` and `process.stdout`/`stderr` writes made by a
 * hook are routed to claudish's debug log, never to the terminal or the MCP
 * protocol stream.
 */

export const HOOK_API_VERSION = 1;

export type Severity = "off" | "warn" | "fix";
export type HookOrder = "pre" | "normal" | "post";
/** native = RouteInfo.native true; foreign = RouteInfo.native false; all = both */
export type RouteScope = "foreign" | "native" | "all";
export type HostMode = "interactive" | "pane-child" | "serve" | "mcp" | "other";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [k: string]: JsonValue };

/* ───────────── facts ───────────── */

export interface HarnessFacts {
  planModeActive: boolean;
  planFilePath?: string;
  planDir?: string;
  /** Claude Code session id from request metadata */
  sessionId?: string;
  /** empty = no listing found, not "no skills" */
  skills?: ReadonlyArray<{ name: string; description: string }>;
}

export interface RouteInfo {
  /** bare model name the handler serves, e.g. "glm-5" */
  modelId: string;
  /** claudish provider name, e.g. "openrouter"; "anthropic" for native */
  provider: string;
  /**
   * true when the request is served by the native Anthropic handler, OR when
   *   !forceForeignModel && (/^claude[-.]/i.test(modelId) || provider === "anthropic")
   * where forceForeignModel is the provider profile's opt-in override. This is the exact
   * rule the plan-mode built-in has always used (a claude-* uid on an aggregator that sets
   * forceForeignModel is foreign).
   */
  native: boolean;
}

export interface ClaudeTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

/** A Claude-format content block. Only `text` blocks are editable by closed actions. */
export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: string; [k: string]: unknown };

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ReadonlyArray<ClaudeContentBlock>;
}

export interface RequestFacts {
  /** as Claude Code asked for it */
  model: string;
  stream: boolean;
  /** system prompt flattened to text */
  systemText: string;
  /** read-only view; change it through actions */
  messages: ReadonlyArray<ClaudeMessage>;
  /** read-only view; change it through actions */
  tools: ReadonlyArray<ClaudeTool>;
}

/** Which session a proxy event belongs to, when claudish knows. */
export interface ProxySessionRef {
  kind: SessionKind;
  id: string;
  role: "slot" | "judge" | null;
}

interface BaseContext {
  readonly hookId: string;
  /** "warn" or "fix" (an "off" hook is never called) */
  readonly severity: Severity;
  /** writes to claudish's debug log; never to the terminal */
  log(message: string): void;
  /** aborted when this hook's timeout elapses */
  readonly signal: AbortSignal;
}

export interface ProxyContext extends BaseContext {
  readonly host: { mode: HostMode };
  readonly route: RouteInfo;
  readonly request: RequestFacts;
  readonly harness: HarnessFacts;
  readonly session: ProxySessionRef | null;
}

export interface RequestContext extends ProxyContext {
  readonly event: "request";
}

export interface ToolCallContext extends ProxyContext {
  readonly event: "toolCall";
  readonly tool: {
    id: string;
    name: string;
    args: Readonly<Record<string, unknown>>;
    rawArgs: string;
  };
}

export type ResponseBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "other"; blockType: string };

export interface ResponseView {
  blocks: ReadonlyArray<ResponseBlock>;
  /** every text block, joined with "\n\n" */
  text: string;
  /** every thinking block, joined with "\n\n" */
  reasoning: string;
  toolNames: ReadonlyArray<string>;
  /** "tool_use" = an intermediate step of a tool loop; the turn continues after the tool runs */
  stopReason: string | null;
}

export interface ResponseRewriteContext extends ProxyContext {
  readonly event: "responseRewrite";
  readonly response: ResponseView;
}
/** response = the final bytes the client received: after any rewrite AND any raw `response` replacement */
export interface ResponseEndContext extends ProxyContext {
  readonly event: "responseEnd";
  readonly response: ResponseView;
}

export type SessionKind = "interactive" | "channel" | "team";

export interface SessionInfo {
  kind: SessionKind;
  /** team only; null otherwise */
  role: "slot" | "judge" | null;
  /** channel: the 8-hex session_id · team: "<run_id>:<slot id>" · interactive: the Claude Code session id */
  id: string;
  claudeSessionId: string | null;
  /** as the caller asked for it */
  model: string;
  cwd: string;
  /** a one-shot session stays "one-shot" through a hook-extended turn chain */
  shape: "interactive" | "one-shot";
  injection: "available" | "unavailable";
}

export interface SessionStartContext extends BaseContext {
  readonly event: "sessionStart";
  readonly session: SessionInfo;
}

export interface TurnAnnotation {
  hookId: string;
  key: string;
  value: JsonValue;
}

export interface SessionIdleContext extends BaseContext {
  readonly event: "sessionIdle";
  readonly session: SessionInfo;
  readonly turn: {
    /** 1-based within the session; a re-woken turn keeps its index */
    index: number;
    /** this turn's assistant text */
    answer: string;
    stopReason: string | null;
    apiError: boolean;
    /** this turn was started by an injection */
    hookCaused: boolean;
    /** annotateTurn actions from this turn's responses, in arrival order */
    annotations: ReadonlyArray<TurnAnnotation>;
  };
  readonly consecutiveHookTurns: number;
  /** caller/human input is queued; an injection returned now will be dropped as stale */
  readonly callerInputPending: boolean;
}

export interface SessionBlockedContext extends BaseContext {
  readonly event: "sessionBlocked";
  readonly session: SessionInfo;
  readonly block: { kind: "question" | "permission"; text: string };
}

export interface SessionEndContext extends BaseContext {
  readonly event: "sessionEnd";
  readonly session: SessionInfo;
  readonly outcome: { state: string; reason: string | null; exitCode: number | null };
}

/* ───────────── actions (closed) ───────────── */

type TextMatch = { find: string; regex?: boolean; flags?: string };
/** default ["user"] */
type MessageRoles = { roles?: ReadonlyArray<"user" | "assistant"> };

// request: system prompt
export type InjectSystemNote = { type: "injectSystemNote"; text: string };
// request: messages
export type AppendUserText = { type: "appendUserText"; text: string };
export type ReplaceMessageText = { type: "replaceMessageText"; replace: string } & TextMatch &
  MessageRoles;
export type RemoveMessageText = { type: "removeMessageText" } & TextMatch & MessageRoles;
// request: tools
export type RewriteToolDescription = {
  type: "rewriteToolDescription";
  tool: string;
  append: string;
};
export type ReplaceToolDescription = {
  type: "replaceToolDescription";
  tool: string;
  description: string;
};
export type ReplaceToolSchema = {
  type: "replaceToolSchema";
  tool: string;
  inputSchema: { type: "object"; [k: string]: unknown };
};
export type RemoveTool = { type: "removeTool"; tool: string };
// toolCall
export type RepairToolArgs = {
  type: "repairToolArgs";
  args: Record<string, unknown>;
  reason: string;
};
// responseRewrite
export type AppendText = { type: "appendText"; text: string };
export type PrependText = { type: "prependText"; text: string };
export type ReplaceText = { type: "replaceText"; replace: string } & TextMatch;
export type RemoveText = { type: "removeText" } & TextMatch;
// responseEnd / session
export type InjectUserTurn = { type: "injectUserTurn"; text: string };
export type AnnotateTurn = { type: "annotateTurn"; key: string; value: JsonValue };
// any
export type Warn = { type: "warn"; message: string };

export type RequestAction =
  | InjectSystemNote
  | AppendUserText
  | ReplaceMessageText
  | RemoveMessageText
  | RewriteToolDescription
  | ReplaceToolDescription
  | ReplaceToolSchema
  | RemoveTool
  | Warn;
export type ToolCallAction = RepairToolArgs | Warn;
export type RewriteAction = AppendText | PrependText | ReplaceText | RemoveText | Warn;
export type ResponseEndAction = InjectSystemNote | InjectUserTurn | AnnotateTurn | Warn;
export type SessionAction = InjectUserTurn | Warn;
export type ObserveAction = Warn;
export type HookAction =
  | RequestAction
  | ToolCallAction
  | RewriteAction
  | ResponseEndAction
  | SessionAction;

// biome-ignore lint/suspicious/noConfusingVoidType: an `async` handler that returns nothing is Promise<void>; `undefined` would reject it
export type HookResult<A> = A[] | void | Promise<A[] | void>;

/* ───────────── handlers ───────────── */

export interface HookHandlers {
  request?(ctx: RequestContext): HookResult<RequestAction>;
  toolCall?: {
    /** tool names whose completed arguments this hook sees; "*" = every tool (costs streaming of all tool input) */
    tools: ReadonlyArray<string>;
    /** synchronous, per request; default true. false = not armed for this request */
    armed?(ctx: RequestContext): boolean;
    /** true = see the call after it was forwarded; can only warn; never holds the stream */
    observe?: boolean;
    handle(ctx: ToolCallContext): HookResult<ToolCallAction>;
  };
  responseRewrite?: {
    /** synchronous, per request, evaluated before the response starts; default true */
    claims?(ctx: RequestContext): boolean;
    handle(ctx: ResponseRewriteContext): HookResult<RewriteAction>;
  };
  responseEnd?(ctx: ResponseEndContext): HookResult<ResponseEndAction>;
  sessionStart?(ctx: SessionStartContext): HookResult<SessionAction>;
  sessionIdle?(ctx: SessionIdleContext): HookResult<SessionAction>;
  sessionBlocked?(ctx: SessionBlockedContext): HookResult<ObserveAction>;
  sessionEnd?(ctx: SessionEndContext): HookResult<ObserveAction>;
}

/* ───────────── raw (unsafe) tier ───────────── */

export interface RawProviderRequestContext {
  readonly hookId: string;
  readonly route: RouteInfo;
  // biome-ignore lint/suspicious/noExplicitAny: the raw tier hands out provider-format objects by contract
  claudeRequest: any; // a clone of the post-request-stage request
  // biome-ignore lint/suspicious/noExplicitAny: provider format
  messages: any[]; // a clone, provider format
  // biome-ignore lint/suspicious/noExplicitAny: provider format
  tools: any[]; // a clone, provider format
}
export interface RawProviderChunkContext {
  readonly hookId: string;
  readonly route: RouteInfo;
  /** A clone of the parsed provider event. Whatever this field holds when the call returns is
   *  what the parser reads from then on, so it may be edited in place or replaced. */
  // biome-ignore lint/suspicious/noExplicitAny: provider format
  chunk: any;
  /** The delta object inside `chunk` at call time (Responses wire: `chunk` itself). Edit it in
   *  place; assigning a new object to this field has no effect. */
  // biome-ignore lint/suspicious/noExplicitAny: provider format
  delta: any;
  /** per-stream, shared across this hook's chunk calls; never cloned */
  metadata: Map<string, unknown>;
}
export interface RawProviderStreamEndContext {
  readonly hookId: string;
  readonly route: RouteInfo;
  metadata: Map<string, unknown>;
}
export interface RawResponseContext {
  readonly hookId: string;
  readonly route: RouteInfo;
  readonly request: RequestFacts;
  /** A replay of the current Claude-format response (SSE, or JSON for stream:false), read at the
   *  hook's own pace. claudish drains the original itself, so leaving this unread delays nothing. */
  response: Response;
}
export interface RawMiddleware {
  /**
   * Receives clones. They replace the live request only when this call returns (or its promise
   * resolves) within its timeout. A throw, a rejection or a timeout discards every change.
   */
  providerRequest?(ctx: RawProviderRequestContext): void | Promise<void>;
  /**
   * MUST be synchronous. Called on the parser's loop, on a clone of the chunk. On a normal return
   * of anything but a thenable, the clone (whatever `ctx.chunk` holds then) is committed: it
   * becomes the object the parser reads, deletions included. On a throw nothing is committed.
   * A declared `async` function is rejected at load. Any other thenable return is an invalid
   * invocation: the clone is discarded even if the hook mutated it before returning, the call is
   * journaled `invalid` (`async_return`) and counts toward the circuit breaker, and a rejection
   * handler is attached, so a rejection is journaled `error` and never becomes an
   * unhandledRejection.
   */
  providerChunk?(ctx: RawProviderChunkContext): void;
  providerStreamEnd?(ctx: RawProviderStreamEndContext): void | Promise<void>;
  /**
   * Return a replacement Response, or nothing to keep the current one. A replacement is read
   * whole and forwarded only when it completes cleanly; on any failure the original is forwarded.
   * The client never sees a partial replacement. A replacement must close within this hook's
   * timeout after the later of this call's return and the end of the original; the original's end
   * never depends on whether `ctx.response` is read.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: an `async` hook that returns nothing is Promise<void>
  response?(ctx: RawResponseContext): Response | void | Promise<Response | void>;
}

/* ───────────── definition ───────────── */

interface HookBase {
  apiVersion: 1;
  id: string;
  description?: string;
  /** default "fix" for user hooks */
  defaultSeverity?: Severity;
  /** default "normal" */
  order?: HookOrder;
  /** globs on RouteInfo.modelId; default "*"; proxy events only */
  models?: string | ReadonlyArray<string>;
  /** default "all"; proxy events only */
  routes?: RouteScope;
  /** per-handler; clamped to the event's maximum */
  timeoutMs?: number;
  on?: HookHandlers;
}
export interface SafeHook extends HookBase {
  unsafe?: never;
  raw?: never;
}
export interface UnsafeHook extends HookBase {
  unsafe: true;
  raw: RawMiddleware;
}
/**
 * One hook. Module-level state is per process: in `create_session` and team
 * children, proxy events run in the pane child and session events in the MCP
 * server or CLI process. Pass per-turn data from proxy events to `sessionIdle`
 * with `annotateTurn`, never with module variables.
 */
export type HookDefinition = SafeHook | UnsafeHook;

/** Identity function: gives editor type-checking and inference. */
export function defineHook<const H extends HookDefinition>(hook: H): H {
  return hook;
}

type RegexOpts = { regex?: boolean; flags?: string };
type RoleOpts = { roles?: ReadonlyArray<"user" | "assistant"> };

/** Copy only the options that are set, so a constructed action equals the literal. */
function matchOpts(opts: (RegexOpts & RoleOpts) | undefined): RegexOpts & RoleOpts {
  const out: RegexOpts & RoleOpts = {};
  if (opts?.regex !== undefined) out.regex = opts.regex;
  if (opts?.flags !== undefined) out.flags = opts.flags;
  if (opts?.roles !== undefined) out.roles = opts.roles;
  return out;
}

/** Action constructors (plain data; equivalent to writing the object literal). */
export const act: {
  injectSystemNote(text: string): InjectSystemNote;
  appendUserText(text: string): AppendUserText;
  replaceMessageText(
    find: string,
    replace: string,
    opts?: { regex?: boolean; flags?: string; roles?: ReadonlyArray<"user" | "assistant"> }
  ): ReplaceMessageText;
  removeMessageText(
    find: string,
    opts?: { regex?: boolean; flags?: string; roles?: ReadonlyArray<"user" | "assistant"> }
  ): RemoveMessageText;
  rewriteToolDescription(tool: string, append: string): RewriteToolDescription;
  replaceToolDescription(tool: string, description: string): ReplaceToolDescription;
  replaceToolSchema(
    tool: string,
    inputSchema: { type: "object"; [k: string]: unknown }
  ): ReplaceToolSchema;
  removeTool(tool: string): RemoveTool;
  repairToolArgs(args: Record<string, unknown>, reason: string): RepairToolArgs;
  appendText(text: string): AppendText;
  prependText(text: string): PrependText;
  replaceText(
    find: string,
    replace: string,
    opts?: { regex?: boolean; flags?: string }
  ): ReplaceText;
  removeText(find: string, opts?: { regex?: boolean; flags?: string }): RemoveText;
  injectUserTurn(text: string): InjectUserTurn;
  annotateTurn(key: string, value: JsonValue): AnnotateTurn;
  warn(message: string): Warn;
} = {
  injectSystemNote: (text) => ({ type: "injectSystemNote", text }),
  appendUserText: (text) => ({ type: "appendUserText", text }),
  replaceMessageText: (find, replace, opts) => ({
    type: "replaceMessageText",
    find,
    replace,
    ...matchOpts(opts),
  }),
  removeMessageText: (find, opts) => ({ type: "removeMessageText", find, ...matchOpts(opts) }),
  rewriteToolDescription: (tool, append) => ({ type: "rewriteToolDescription", tool, append }),
  replaceToolDescription: (tool, description) => ({
    type: "replaceToolDescription",
    tool,
    description,
  }),
  replaceToolSchema: (tool, inputSchema) => ({ type: "replaceToolSchema", tool, inputSchema }),
  removeTool: (tool) => ({ type: "removeTool", tool }),
  repairToolArgs: (args, reason) => ({ type: "repairToolArgs", args, reason }),
  appendText: (text) => ({ type: "appendText", text }),
  prependText: (text) => ({ type: "prependText", text }),
  replaceText: (find, replace, opts) => ({
    type: "replaceText",
    find,
    replace,
    ...matchOpts(opts),
  }),
  removeText: (find, opts) => ({ type: "removeText", find, ...matchOpts(opts) }),
  injectUserTurn: (text) => ({ type: "injectUserTurn", text }),
  annotateTurn: (key, value) => ({ type: "annotateTurn", key, value }),
  warn: (message) => ({ type: "warn", message }),
};
