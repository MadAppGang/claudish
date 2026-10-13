/**
 * Closed actions: which actions each event may return, the shape and limit
 * check every action passes before it is applied, and the appliers for the
 * request and tool-call targets.
 *
 * Actions are plain data (the Command pattern as a discriminated union), so
 * they can be validated, severity-gated, conflict-checked, journaled and, for
 * `injectUserTurn` / `annotateTurn`, serialised into the hook inbox. Nothing
 * here runs hook code.
 *
 * The request appliers never mutate a message, block or tool object in place.
 * Stage A replaces `system`, `messages` and `tools` (and every changed message
 * or tool) with new objects on the request object it is given; stage B replaces
 * ELEMENTS of the two tool arrays it is given, so a converted array the provider
 * payload aliases sees the change. That makes them safe on the NativeHandler's
 * copy-on-write view as well as on ComposedHandler's deep copy.
 */

import type {
  ClaudeContentBlock,
  HookAction,
  JsonValue,
  RemoveMessageText,
  ReplaceMessageText,
  RequestAction,
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
  decision: "matched" | "superseded" | "invalid" | "ignored";
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

/** The outcome of stage A, and what stage B still has to do. */
export interface StageAResult {
  results: ActionResult<RequestAction>[];
  /** Tool-description actions, held for stage B in effective order. */
  held: PlannedAction<RequestAction>[];
  /** Tools stage A removed; description actions on them are `superseded`. */
  removedTools: ReadonlySet<string>;
}

/**
 * Stage A, before conversion: system notes, then message text, then tool
 * schemas, then tool removal. `items` are in effective order and already
 * severity-gated (fix only) and validated; `warn` actions are skipped.
 *
 * Conflict rules: identical system notes and identical appended user texts are
 * applied once (later copies `superseded`); message text actions apply
 * sequentially; one schema per tool (first wins); one removal per tool (first
 * wins); every other action on a removed tool is `superseded`.
 */
export function applyStageA(
  req: MutableClaudeRequest,
  items: ReadonlyArray<PlannedAction<RequestAction>>
): StageAResult {
  const results: ActionResult<RequestAction>[] = [];
  const held: PlannedAction<RequestAction>[] = [];
  const result = (
    item: PlannedAction<RequestAction>,
    decision: ActionResult["decision"],
    detail?: string
  ) => results.push(detail === undefined ? { ...item, decision } : { ...item, decision, detail });

  const notes: PlannedAction<RequestAction>[] = [];
  const messageEdits: PlannedAction<RequestAction>[] = [];
  const schemas: PlannedAction<RequestAction>[] = [];
  const removals: PlannedAction<RequestAction>[] = [];
  for (const item of items) {
    const t = item.action.type;
    if (t === "warn") continue;
    if (t === "injectSystemNote") notes.push(item);
    else if (t === "appendUserText" || t === "replaceMessageText" || t === "removeMessageText") {
      messageEdits.push(item);
    } else if (t === "replaceToolSchema") schemas.push(item);
    else if (t === "removeTool") removals.push(item);
    else if (STAGE_B.has(t)) held.push(item);
  }

  // 1. System notes.
  const seenNotes = new Set<string>();
  for (const item of notes) {
    const text = (item.action as { text: string }).text;
    if (seenNotes.has(text)) {
      result(item, "superseded", "duplicate");
      continue;
    }
    seenNotes.add(text);
    req.system = withSystemNote(req.system, text);
    result(item, "matched");
  }

  // 2. Message text, sequentially in effective order.
  const seenAppends = new Set<string>();
  for (const item of messageEdits) {
    const a = item.action;
    if (a.type === "appendUserText") {
      if (seenAppends.has(a.text)) {
        result(item, "superseded", "duplicate");
        continue;
      }
      seenAppends.add(a.text);
      const r = appendUserText(req, a.text);
      if (r) result(item, "invalid", r);
      else result(item, "matched");
      continue;
    }
    const edit = editMessageText(req, a as ReplaceMessageText | RemoveMessageText);
    if (edit.invalid) result(item, "invalid", edit.invalid);
    else if (edit.reverted > 0 && !edit.changed) result(item, "invalid", "empty_message");
    else if (edit.reverted > 0) result(item, "matched", `empty_message_reverted:${edit.reverted}`);
    else if (!edit.changed) result(item, "ignored", "no_match");
    else result(item, "matched");
  }

  // 3. Decide removals first, so a schema action on a removed tool is superseded.
  const toolNames = new Set<string>((req.tools ?? []).map((t) => t?.name));
  const removed = new Set<string>();
  const removalOutcome = new Map<
    PlannedAction<RequestAction>,
    [ActionResult["decision"], string?]
  >();
  for (const item of removals) {
    const name = (item.action as { tool: string }).tool;
    if (removed.has(name)) removalOutcome.set(item, ["superseded", "already_removed"]);
    else if (!toolNames.has(name)) removalOutcome.set(item, ["invalid", "unknown_tool"]);
    else if (toolInHistory(req.messages, name)) {
      removalOutcome.set(item, ["invalid", "tool_in_history"]);
    } else {
      removed.add(name);
      removalOutcome.set(item, ["matched"]);
    }
  }

  // 4. Schemas: one per tool, first wins.
  const schemaDone = new Set<string>();
  for (const item of schemas) {
    const a = item.action as { tool: string; inputSchema: Record<string, unknown> };
    if (!toolNames.has(a.tool)) result(item, "invalid", "unknown_tool");
    else if (removed.has(a.tool)) result(item, "superseded", "tool_removed");
    else if (schemaDone.has(a.tool)) result(item, "superseded");
    else {
      schemaDone.add(a.tool);
      req.tools = (req.tools ?? []).map((t) =>
        t?.name === a.tool ? { ...t, input_schema: structuredClone(a.inputSchema) } : t
      );
      result(item, "matched");
    }
  }

  // 5. Removal.
  if (removed.size > 0) req.tools = (req.tools ?? []).filter((t) => !removed.has(t?.name));
  for (const item of removals) {
    const [decision, detail] = removalOutcome.get(item) ?? ["invalid"];
    result(item, decision, detail);
  }

  return { results, held, removedTools: removed };
}

/**
 * Stage B, after conversion: tool descriptions on BOTH representations, so
 * `--summarize-tools` (which truncates the converted description to its first
 * sentence) can never cut an appended instruction. One description action per
 * tool (first wins). A tool present in `claudeTools` but not in the converted
 * array (the tool-count cap removed it) gets the Claude-format change only and is
 * `matched` with detail `capped`.
 *
 * `convertedTools` is null on a route with one representation (native).
 */
export function applyStageB(
  // biome-ignore lint/suspicious/noExplicitAny: Claude-format and provider-format tools
  claudeTools: any[],
  // biome-ignore lint/suspicious/noExplicitAny: see above
  convertedTools: any[] | null,
  held: ReadonlyArray<PlannedAction<RequestAction>>,
  removedTools: ReadonlySet<string> = new Set()
): ActionResult<RequestAction>[] {
  const results: ActionResult<RequestAction>[] = [];
  const done = new Set<string>();
  const sameArray = convertedTools === claudeTools;

  for (const item of held) {
    const a = item.action;
    if (a.type !== "rewriteToolDescription" && a.type !== "replaceToolDescription") continue;
    if (removedTools.has(a.tool)) {
      results.push({ ...item, decision: "superseded", detail: "tool_removed" });
      continue;
    }
    if (done.has(a.tool)) {
      results.push({ ...item, decision: "superseded" });
      continue;
    }
    const describe = (current: unknown) =>
      a.type === "rewriteToolDescription"
        ? `${typeof current === "string" ? current : ""}${a.append}`
        : a.description;

    let claudeHits = 0;
    claudeTools.forEach((t, i) => {
      if (t?.name !== a.tool) return;
      claudeTools[i] = { ...t, description: describe(t.description) };
      claudeHits++;
    });
    if (claudeHits === 0) {
      results.push({ ...item, decision: "invalid", detail: "unknown_tool" });
      continue;
    }
    done.add(a.tool);

    let convertedHits = 0;
    if (convertedTools && !sameArray) {
      convertedTools.forEach((t, i) => {
        // Chat Completions wraps the definition in `function`; Responses does not.
        if (t?.function?.name === a.tool) {
          convertedTools[i] = {
            ...t,
            function: { ...t.function, description: describe(t.function.description) },
          };
          convertedHits++;
        } else if (!t?.function && t?.name === a.tool) {
          convertedTools[i] = { ...t, description: describe(t.description) };
          convertedHits++;
        }
      });
    }
    const capped = convertedTools !== null && !sameArray && convertedHits === 0;
    results.push(
      capped ? { ...item, decision: "matched", detail: "capped" } : { ...item, decision: "matched" }
    );
  }
  return results;
}

/** The outcome of the `repairToolArgs` actions for one call. */
export interface ToolCallApplied {
  /** The replacement arguments, or undefined when nothing was applied. */
  args?: Record<string, unknown>;
  results: ActionResult<ToolCallAction>[];
}

/** One call's arguments: the first `repairToolArgs` in effective order wins. */
export function applyToolCallActions(
  items: ReadonlyArray<PlannedAction<ToolCallAction>>
): ToolCallApplied {
  const results: ActionResult<ToolCallAction>[] = [];
  let args: Record<string, unknown> | undefined;
  for (const item of items) {
    if (item.action.type !== "repairToolArgs") continue;
    if (args !== undefined) {
      results.push({ ...item, decision: "superseded" });
      continue;
    }
    args = structuredClone(item.action.args);
    results.push({ ...item, decision: "matched" });
  }
  return args === undefined ? { results } : { args, results };
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
