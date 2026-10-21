/**
 * Closed actions: which actions each event may return, the shape and limit
 * check every action passes before it is applied, and the appliers for the
 * request and tool-call targets.
 *
 * Actions are plain data (the Command pattern as a discriminated union), so
 * they can be validated, severity-gated, applied one hook-chain step at a time,
 * journaled and, for `injectUserTurn` / `annotateTurn`, serialised into the
 * hook inbox. Nothing here runs hook code.
 *
 * The request appliers never mutate a message, block or tool object in place.
 * Stage A works on a step's copy of the request chain's working state and
 * returns a new one (every changed message or tool a new object); stage B
 * replaces ELEMENTS of the two tool arrays it is given, so a converted array the
 * provider payload aliases sees the change. That makes them safe on the NativeHandler's
 * copy-on-write view as well as on ComposedHandler's deep copy.
 */

import { sanitizeToolNameForGemini } from "../handlers/shared/gemini-schema.js";
import type {
  ClaudeContentBlock,
  HookAction,
  JsonValue,
  RemoveMessageText,
  ReplaceMessageText,
  ReplaceToolDescription,
  RequestAction,
  RewriteToolDescription,
  ToolCallAction,
} from "./public.js";
import { compileMatcher } from "./text-rewrite.js";

/** The events whose handlers return closed actions. */
export type ClosedEvent =
  | "request"
  | "toolCall"
  | "responseRewrite"
  | "responseEnd"
  | "sessionStart"
  | "sessionIdle"
  | "sessionBlocked"
  | "sessionEnd";

export const CLOSED_EVENTS: ReadonlyArray<ClosedEvent> = [
  "request",
  "toolCall",
  "responseRewrite",
  "responseEnd",
  "sessionStart",
  "sessionIdle",
  "sessionBlocked",
  "sessionEnd",
];

type ActionType = HookAction["type"];

/** §4.4 "Allowed actions", per event. */
export const ALLOWED_ACTIONS: Readonly<Record<ClosedEvent, ReadonlySet<ActionType>>> = {
  request: new Set<ActionType>([
    "injectSystemNote",
    "appendUserText",
    "replaceMessageText",
    "removeMessageText",
    "rewriteToolDescription",
    "replaceToolDescription",
    "replaceToolSchema",
    "removeTool",
    "warn",
  ]),
  toolCall: new Set<ActionType>(["repairToolArgs", "warn"]),
  responseRewrite: new Set<ActionType>([
    "appendText",
    "prependText",
    "replaceText",
    "removeText",
    "warn",
  ]),
  responseEnd: new Set<ActionType>(["injectSystemNote", "injectUserTurn", "annotateTurn", "warn"]),
  sessionStart: new Set<ActionType>(["injectUserTurn", "warn"]),
  sessionIdle: new Set<ActionType>(["injectUserTurn", "warn"]),
  sessionBlocked: new Set<ActionType>(["warn"]),
  sessionEnd: new Set<ActionType>(["warn"]),
};

/** Only `warn` is allowed from an observe-mode `toolCall` hook. */
const OBSERVE_ONLY: ReadonlySet<ActionType> = new Set<ActionType>(["warn"]);

/* ───────────── limits ───────────── */

export const LIMITS = {
  systemNote: 20_000,
  userText: 20_000,
  toolDescriptionAppend: 4_000,
  toolDescription: 20_000,
  toolSchemaBytes: 64 * 1024,
  repairArgsBytes: 1024 * 1024,
  responseText: 1_000_000,
  injectUserTurn: 100_000,
  annotationValueBytes: 16 * 1024,
  warn: 20_000,
} as const;

const ANNOTATION_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ROLES = new Set(["user", "assistant"]);

export type Validation = { ok: true; action: HookAction } | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function textIn(v: unknown, max: number): string | null {
  if (typeof v !== "string") return "not_string";
  if (v.length === 0) return "empty_text";
  if (v.length > max) return "too_long";
  return null;
}

/** Bytes of a value's JSON, or null when it does not serialise. */
function jsonBytes(v: unknown): number | null {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? null : Buffer.byteLength(s);
  } catch {
    return null;
  }
}

/** True for a value that round-trips through JSON as itself (no functions, NaN, cycles…). */
function isJsonValue(v: unknown, depth = 0): v is JsonValue {
  if (depth > 64) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (isPlainObject(v)) {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v).every((x) => isJsonValue(x, depth + 1));
  }
  return false;
}

function matchProblem(a: { find?: unknown; regex?: unknown; flags?: unknown }): string | null {
  if (a.regex !== undefined && typeof a.regex !== "boolean") return "regex_not_boolean";
  if (a.flags !== undefined && typeof a.flags !== "string") return "invalid_flags";
  const compiled = compileMatcher(a as ReplaceMessageText);
  return "invalid" in compiled ? compiled.invalid : null;
}

/**
 * Check one value a hook returned: is it a known action, allowed for this
 * event, well-formed and within its limits. `observe` restricts a `toolCall`
 * hook to `warn`.
 */
export function validateAction(
  event: ClosedEvent,
  value: unknown,
  opts: { observe?: boolean } = {}
): Validation {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    return { ok: false, reason: "not_an_action" };
  }
  const type = value.type as ActionType;
  if (!ALLOWED_ACTIONS[event].has(type)) {
    return { ok: false, reason: `not_allowed:${String(value.type)}` };
  }
  if (opts.observe && !OBSERVE_ONLY.has(type)) return { ok: false, reason: "observe_only" };

  const problem = shapeProblem(value);
  return problem ? { ok: false, reason: problem } : { ok: true, action: value as HookAction };
}

function shapeProblem(a: Record<string, unknown>): string | null {
  switch (a.type as ActionType) {
    case "injectSystemNote":
      return textIn(a.text, LIMITS.systemNote);
    case "appendUserText":
      return textIn(a.text, LIMITS.userText);
    case "replaceMessageText":
    case "removeMessageText": {
      if (a.type === "replaceMessageText" && typeof a.replace !== "string") {
        return "replace_not_string";
      }
      if (a.roles !== undefined) {
        if (!Array.isArray(a.roles) || a.roles.length === 0) return "invalid_roles";
        if (!a.roles.every((r) => typeof r === "string" && ROLES.has(r))) return "invalid_roles";
      }
      return matchProblem(a);
    }
    case "rewriteToolDescription":
      return toolName(a.tool) ?? textIn(a.append, LIMITS.toolDescriptionAppend);
    case "replaceToolDescription":
      return toolName(a.tool) ?? textIn(a.description, LIMITS.toolDescription);
    case "replaceToolSchema": {
      const bad = toolName(a.tool);
      if (bad) return bad;
      if (!isPlainObject(a.inputSchema) || a.inputSchema.type !== "object") {
        return "schema_not_object";
      }
      if (!isJsonValue(a.inputSchema)) return "schema_not_json";
      const bytes = jsonBytes(a.inputSchema);
      if (bytes === null) return "schema_not_json";
      return bytes > LIMITS.toolSchemaBytes ? "schema_too_large" : null;
    }
    case "removeTool":
      return toolName(a.tool);
    case "repairToolArgs": {
      if (!isPlainObject(a.args)) return "args_not_object";
      if (!isJsonValue(a.args)) return "args_not_json";
      const bytes = jsonBytes(a.args);
      if (bytes === null) return "args_not_json";
      if (bytes > LIMITS.repairArgsBytes) return "args_too_large";
      return typeof a.reason === "string" ? null : "reason_not_string";
    }
    case "appendText":
    case "prependText":
      return textIn(a.text, LIMITS.responseText);
    case "replaceText":
    case "removeText": {
      if (a.type === "replaceText" && typeof a.replace !== "string") return "replace_not_string";
      if ("roles" in a) return "roles_not_allowed";
      return matchProblem(a);
    }
    case "injectUserTurn": {
      const bad = textIn(a.text, LIMITS.injectUserTurn);
      if (bad) return bad;
      return (a.text as string).trimStart().startsWith("/") ? "slash_command" : null;
    }
    case "annotateTurn": {
      if (typeof a.key !== "string" || !ANNOTATION_KEY.test(a.key)) return "invalid_key";
      if (!("value" in a) || !isJsonValue(a.value)) return "value_not_json";
      const bytes = jsonBytes(a.value);
      if (bytes === null) return "value_not_json";
      return bytes > LIMITS.annotationValueBytes ? "value_too_large" : null;
    }
    case "warn":
      return typeof a.message === "string" ? null : "message_not_string";
    default:
      return `unknown_action:${String(a.type)}`;
  }
}

function toolName(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? null : "invalid_tool";
}

/* ───────────── appliers ───────────── */

/** One action to apply, attributed to the hook that returned it. */
export interface PlannedAction<A extends HookAction = HookAction> {
  hookId: string;
  action: A;
}

/** What happened to one planned action. */
export interface ActionResult<A extends HookAction = HookAction> {
  hookId: string;
  action: A;
  decision: "matched" | "superseded" | "invalid" | "ignored" | "queued" | "dropped";
  detail?: string;
}

/** The mutable slice of a Claude-format request the appliers touch. */
export interface MutableClaudeRequest {
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format request fields are untyped at this layer
  system?: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  messages?: any[];
  // biome-ignore lint/suspicious/noExplicitAny: see above
  tools?: any[];
}

const STAGE_B: ReadonlySet<string> = new Set(["rewriteToolDescription", "replaceToolDescription"]);

/**
 * The working state of one request hook chain (§4.4.1): the request as the
 * steps so far left it, plus what the duplicate and removal rules need to
 * remember across steps. Never mutated: each step produces a new one.
 */
export interface RequestChainState {
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format system is a string or a block array
  readonly system: any;
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format messages
  readonly messages: any[] | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format tools
  readonly tools: any[] | undefined;
  /** Tool-description actions in chain order: the overlay, replayed at stage B. */
  readonly held: ReadonlyArray<PlannedAction<RequestAction>>;
  /** System-note texts earlier steps of this dispatch added (pending notes included). */
  readonly seenNotes: ReadonlySet<string>;
  /** User texts earlier steps of this dispatch appended. */
  readonly seenAppends: ReadonlySet<string>;
  /**
   * Tools earlier steps removed, each with the number of `held` description actions at
   * the moment of its removal: the held actions before that index preceded the removal
   * and stay `matched` at stage B; the ones from it on are `superseded: tool_removed`.
   */
  readonly removedTools: ReadonlyMap<string, number>;
}

/** The working state a request chain starts from: the attempt's request as given. */
export function requestChainState(req: MutableClaudeRequest): RequestChainState {
  return {
    system: req.system,
    messages: req.messages,
    tools: req.tools,
    held: [],
    seenNotes: new Set(),
    seenAppends: new Set(),
    removedTools: new Map(),
  };
}

/** One step's stage A: the next working state, the outcomes to journal, what took effect. */
export interface StageAStep {
  state: RequestChainState;
  /** Outcomes of every action but the description actions (those journal at stage B). */
  results: ActionResult<RequestAction>[];
  /** What took effect at this step, description actions on a present tool included. */
  applied: PlannedAction<RequestAction>[];
}

/**
 * Stage A for one step of the request chain, before conversion. `items` are one
 * hook's actions (or the pending notes), already severity-gated and validated,
 * applied in ARRAY ORDER, each over the state every action before it produced:
 * earlier actions of the same list and every earlier step. `warn` is skipped.
 *
 * - `injectSystemNote` / `appendUserText`: a text equal to one an earlier action
 *   of this dispatch added is `superseded` (`duplicate`).
 * - message text edits: over the current messages.
 * - `replaceToolSchema`: replaces the current schema; on a removed tool
 *   `superseded: tool_removed`.
 * - `removeTool`: removes the tool now; a second removal is
 *   `superseded: already_removed`; a tool still used in the history is
 *   `invalid: tool_in_history`.
 * - description actions join the overlay (`held`), in order, and are journaled
 *   when stage B applies them.
 *
 * `state` is never mutated, so a throw leaves the chain's working state intact.
 */
export function applyStageA(
  state: RequestChainState,
  items: ReadonlyArray<PlannedAction<RequestAction>>
): StageAStep {
  const req: MutableClaudeRequest = {
    system: state.system,
    messages: state.messages,
    tools: state.tools,
  };
  const held = [...state.held];
  const seenNotes = new Set(state.seenNotes);
  const seenAppends = new Set(state.seenAppends);
  const removed = new Map(state.removedTools);
  const results: ActionResult<RequestAction>[] = [];
  const applied: PlannedAction<RequestAction>[] = [];
  const result = (
    item: PlannedAction<RequestAction>,
    decision: ActionResult["decision"],
    detail?: string
  ) => {
    results.push(detail === undefined ? { ...item, decision } : { ...item, decision, detail });
    if (decision === "matched") applied.push(item);
  };
  const hasTool = (name: string) => (req.tools ?? []).some((t) => t?.name === name);

  for (const item of items) {
    const a = item.action;
    switch (a.type) {
      case "warn":
        break;
      case "injectSystemNote":
        if (seenNotes.has(a.text)) {
          result(item, "superseded", "duplicate");
          break;
        }
        seenNotes.add(a.text);
        req.system = withSystemNote(req.system, a.text);
        result(item, "matched");
        break;
      case "appendUserText": {
        if (seenAppends.has(a.text)) {
          result(item, "superseded", "duplicate");
          break;
        }
        const r = appendUserText(req, a.text);
        if (r) result(item, "invalid", r);
        else {
          // Only an append that took effect makes a later identical one a duplicate.
          seenAppends.add(a.text);
          result(item, "matched");
        }
        break;
      }
      case "replaceMessageText":
      case "removeMessageText": {
        const edit = editMessageText(req, a);
        if (edit.invalid) result(item, "invalid", edit.invalid);
        else if (edit.reverted > 0 && !edit.changed) result(item, "invalid", "empty_message");
        else if (edit.reverted > 0)
          result(item, "matched", `empty_message_reverted:${edit.reverted}`);
        else if (!edit.changed) result(item, "ignored", "no_match");
        else result(item, "matched");
        break;
      }
      case "replaceToolSchema":
        if (removed.has(a.tool)) result(item, "superseded", "tool_removed");
        else if (!hasTool(a.tool)) result(item, "invalid", "unknown_tool");
        else {
          req.tools = (req.tools ?? []).map((t) =>
            t?.name === a.tool ? { ...t, input_schema: structuredClone(a.inputSchema) } : t
          );
          result(item, "matched");
        }
        break;
      case "removeTool":
        if (removed.has(a.tool)) result(item, "superseded", "already_removed");
        else if (!hasTool(a.tool)) result(item, "invalid", "unknown_tool");
        else if (toolInHistory(req.messages, a.tool)) result(item, "invalid", "tool_in_history");
        else {
          removed.set(a.tool, held.length);
          req.tools = (req.tools ?? []).filter((t) => t?.name !== a.tool);
          result(item, "matched");
        }
        break;
      default:
        if (STAGE_B.has(a.type)) {
          held.push(item);
          // Visible to later steps through the overlay when the tool is on offer;
          // stage B journals its outcome either way.
          const tool = (a as { tool: string }).tool;
          if (!removed.has(tool) && hasTool(tool)) applied.push(item);
        }
        break;
    }
  }

  return {
    state: {
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      held,
      seenNotes,
      seenAppends,
      removedTools: removed,
    },
    results,
    applied,
  };
}

/** One description action over a description. */
function describeWith(
  a: RewriteToolDescription | ReplaceToolDescription,
  current: unknown
): string {
  return a.type === "rewriteToolDescription"
    ? `${typeof current === "string" ? current : ""}${a.append}`
    : a.description;
}

/**
 * The description overlay: `tools` with every held description action replayed
 * in chain order on new tool objects, exactly as stage B will give the
 * Claude-format tools. `tools` is never mutated; an action on a tool not in it
 * is passed over.
 */
export function overlayToolDescriptions(
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format tools
  tools: any[] | undefined,
  held: ReadonlyArray<PlannedAction<RequestAction>>
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format tools
): any[] {
  const out = [...(tools ?? [])];
  for (const { action: a } of held) {
    if (a.type !== "rewriteToolDescription" && a.type !== "replaceToolDescription") continue;
    out.forEach((t, i) => {
      if (t?.name === a.tool) out[i] = { ...t, description: describeWith(a, t.description) };
    });
  }
  return out;
}

/**
 * Stage B, after conversion: the held description actions replayed in chain
 * order on BOTH representations, each over the description the earlier ones
 * produced, so `--summarize-tools` (which truncates the converted description
 * to its first sentence) can never cut an appended instruction. An append
 * extends the current description; a replace replaces it on both copies. A tool
 * present in `claudeTools` but not in the converted array (the tool-count cap
 * removed it) gets the Claude-format change only and is `matched` with detail
 * `capped`. On a tool a step removed, an action held before the removal is `matched`
 * (it took effect on the view the steps in between saw) and one held after it is
 * `superseded: tool_removed`.
 *
 * `convertedTools` is null on a route with one representation (native).
 */
export function applyStageB(
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format and provider-format tools
  claudeTools: any[],
  // biome-ignore lint/suspicious/noExplicitAny: see above
  convertedTools: any[] | null,
  held: ReadonlyArray<PlannedAction<RequestAction>>,
  removedTools: ReadonlyMap<string, number> = new Map()
): ActionResult<RequestAction>[] {
  const results: ActionResult<RequestAction>[] = [];
  for (const [index, item] of held.entries()) {
    const a = item.action;
    if (a.type !== "rewriteToolDescription" && a.type !== "replaceToolDescription") continue;
    const removedAt = removedTools.get(a.tool);
    // §4-J: an action applied before the removal stays `matched` (it took effect on the
    // view the hooks between saw); one after it is `superseded: tool_removed`.
    const outcome: Outcome =
      removedAt === undefined
        ? describeOnBoth(claudeTools, convertedTools, a)
        : index < removedAt
          ? { decision: "matched" }
          : { decision: "superseded", detail: "tool_removed" };
    results.push({ ...item, ...outcome });
  }
  return results;
}

type Outcome = Pick<ActionResult, "decision" | "detail">;

/** One description action on both tool representations (stage B), and its outcome. */
function describeOnBoth(
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format and provider-format tools
  claudeTools: any[],
  // biome-ignore lint/suspicious/noExplicitAny: see above
  convertedTools: any[] | null,
  a: RewriteToolDescription | ReplaceToolDescription
): Outcome {
  const claudeHits = replaceEach(claudeTools, (t) =>
    t?.name === a.tool
      ? { tool: { ...t, description: describeWith(a, t.description) }, hits: 1 }
      : null
  );
  if (claudeHits === 0) return { decision: "invalid", detail: "unknown_tool" };
  // null: a route with one representation (native); the same array: nothing to convert.
  if (convertedTools === null || convertedTools === claudeTools) return { decision: "matched" };
  const convertedHits = replaceEach(convertedTools, (t) => describeConverted(t, a));
  return convertedHits === 0 ? { decision: "matched", detail: "capped" } : { decision: "matched" };
}

/**
 * Replace each element `edit` matches with the tool it returns, in place (the
 * element, never the tool object), and count the definitions matched.
 */
function replaceEach(
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format or provider-format tools
  tools: any[],
  // biome-ignore lint/suspicious/noExplicitAny: see above
  edit: (t: any) => { tool: any; hits: number } | null
): number {
  let hits = 0;
  tools.forEach((t, i) => {
    const r = edit(t);
    if (!r || r.hits === 0) return;
    tools[i] = r.tool;
    hits += r.hits;
  });
  return hits;
}

/**
 * One description action on one provider-format tool entry: the new entry and how many
 * definitions in it matched. Chat Completions wraps the definition in `function`;
 * Responses does not; Gemini groups every definition under one `functionDeclarations`
 * entry, by the name `convertToolsToGemini` sanitized.
 */
function describeConverted(
  // biome-ignore lint/suspicious/noExplicitAny: provider-format tool
  t: any,
  a: RewriteToolDescription | ReplaceToolDescription
  // biome-ignore lint/suspicious/noExplicitAny: provider-format tool
): { tool: any; hits: number } {
  if (t?.function?.name === a.tool) {
    return {
      tool: {
        ...t,
        function: { ...t.function, description: describeWith(a, t.function.description) },
      },
      hits: 1,
    };
  }
  if (Array.isArray(t?.functionDeclarations)) {
    const name = sanitizeToolNameForGemini(a.tool);
    let hits = 0;
    // biome-ignore lint/suspicious/noExplicitAny: Gemini function declaration
    const decls = t.functionDeclarations.map((d: any) => {
      if (d?.name !== name) return d;
      hits++;
      return { ...d, description: describeWith(a, d.description) };
    });
    return { tool: hits > 0 ? { ...t, functionDeclarations: decls } : t, hits };
  }
  if (!t?.function && t?.name === a.tool) {
    return { tool: { ...t, description: describeWith(a, t.description) }, hits: 1 };
  }
  return { tool: t, hits: 0 };
}

/** The outcome of one step's `repairToolArgs` actions for one call. */
export interface ToolCallApplied {
  /** The working arguments after the step: a new object when a repair applied, else `args`. */
  args: Record<string, unknown>;
  /** True when at least one repair applied. */
  repaired: boolean;
  results: ActionResult<ToolCallAction>[];
}

/**
 * One step's repairs of one call, in order: each `repairToolArgs` replaces the
 * working arguments, and every one is `matched` (journaled `repaired`). `args`
 * is never mutated.
 */
export function applyToolCallActions(
  args: Record<string, unknown>,
  items: ReadonlyArray<PlannedAction<ToolCallAction>>
): ToolCallApplied {
  const results: ActionResult<ToolCallAction>[] = [];
  let current = args;
  let repaired = false;
  for (const item of items) {
    if (item.action.type !== "repairToolArgs") continue;
    current = structuredClone(item.action.args);
    repaired = true;
    results.push({ ...item, decision: "matched" });
  }
  return { args: current, repaired, results };
}

/* ───────────── request helpers ───────────── */

// biome-ignore lint/suspicious/noExplicitAny: Claude-format system is a string or a block array
function withSystemNote(system: any, text: string): any {
  if (typeof system === "string") return system.length > 0 ? `${system}\n\n${text}` : text;
  if (Array.isArray(system)) return [...system, { type: "text", text }];
  return text;
}

/** @returns an invalid reason, or null when applied. */
function appendUserText(req: MutableClaudeRequest, text: string): string | null {
  const messages = req.messages ?? [];
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      last = i;
      break;
    }
  }
  if (last === -1) return "no_user_message";
  const msg = messages[last];
  const content: ClaudeContentBlock[] =
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : Array.isArray(msg.content)
        ? [...msg.content]
        : [];
  content.push({ type: "text", text });
  req.messages = messages.map((m, i) => (i === last ? { ...m, content } : m));
  return null;
}

/** Apply a replace/remove to every text block of the messages whose role is in `roles`. */
function editMessageText(
  req: MutableClaudeRequest,
  a: ReplaceMessageText | RemoveMessageText
): { changed: boolean; reverted: number; invalid?: string } {
  const matcher = compileMatcher(a);
  if ("invalid" in matcher) return { changed: false, reverted: 0, invalid: matcher.invalid };
  const roles = new Set<string>(a.roles ?? ["user"]);
  let changed = false;
  let reverted = 0;

  const messages = (req.messages ?? []).map((m) => {
    if (!m || !roles.has(m.role)) return m;
    if (typeof m.content === "string") {
      const next = matcher.apply(m.content);
      if (next === m.content) return m;
      if (next === "") {
        reverted++;
        return m;
      }
      changed = true;
      return { ...m, content: next };
    }
    if (!Array.isArray(m.content)) return m;
    let touched = false;
    const content: ClaudeContentBlock[] = [];
    for (const block of m.content as ClaudeContentBlock[]) {
      if (block?.type !== "text" || typeof (block as { text?: unknown }).text !== "string") {
        content.push(block);
        continue;
      }
      const text = (block as { text: string }).text;
      const next = matcher.apply(text);
      if (next === text) {
        content.push(block);
        continue;
      }
      touched = true;
      if (next !== "") content.push({ ...block, text: next } as ClaudeContentBlock);
    }
    if (!touched) return m;
    if (content.length === 0) {
      reverted++;
      return m;
    }
    changed = true;
    return { ...m, content };
  });

  if (changed) req.messages = messages;
  return { changed, reverted };
}

/** True while any message holds a `tool_use` block of `name`. */
// biome-ignore lint/suspicious/noExplicitAny: Claude-format messages
function toolInHistory(messages: any[] | undefined, name: string): boolean {
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) if (b?.type === "tool_use" && b?.name === name) return true;
  }
  return false;
}
