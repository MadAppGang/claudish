/**
 * Tool-name alias for the `antigravity` provider.
 *
 * Claude Code advertises its tools under its own names (`Bash`, `Edit`). This
 * renames the ones with a true equivalent to the names Google's own Antigravity
 * client sends (`run_command`, `edit_file`), so the backend sees its own tool
 * vocabulary. The rename is reversible and provider-scoped.
 *
 * SCOPE: tool names, and the argument names of the four tools whose arguments
 * have a true equivalent (`run_command`, `read_file`, `write_file`,
 * `edit_file`; `AGY_ARGUMENT_ALIAS`). An argument with no equivalent keeps
 * Claude Code's name, and the tool's description stays Claude Code's.
 *
 * REVERSIBILITY is the invariant. Every name changed on the way out
 * (`aliasToolsForProvider`) MUST be mapped back on the way in (its `restore`
 * for a tool name, its `restoreArguments` for a call's arguments), or Claude
 * Code receives a `tool_use` for a tool it never declared, or one whose input
 * fails that tool's schema, and the turn fails. The round trip is covered in
 * `tool-name-alias.test.ts`.
 *
 * The native names are the `functionDeclarations` the `agy` CLI 1.5.9 puts on
 * the wire (recorded 2026-11-15; see
 * `ai-docs/architecture/providers/antigravity.md`). The last three are not in
 * that tool set: they are the names of the binary's other tool set, kept for a
 * Claude Code that still declares `Grep`, `Glob` or `LS`.
 */

/** Claude Code built-in → the agy-native name. A fixed, hand-verified set. */
const AGY_TOOL_ALIAS: ReadonlyArray<readonly [string, string]> = [
  ["Bash", "run_command"],
  ["Read", "read_file"],
  ["Write", "write_file"],
  ["Edit", "edit_file"],
  ["Agent", "invoke_subagent"],
  ["AskUserQuestion", "ask_question"],
  ["WebSearch", "search_web"],
  ["SendMessage", "send_message"],
  ["Workflow", "run_workflow"],
  ["Grep", "grep_search"],
  ["Glob", "find_by_name"],
  ["LS", "list_dir"],
];

/** Providers that get a native tool-name alias, each with its own table. */
const PROVIDER_ALIASES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  antigravity: AGY_TOOL_ALIAS,
};

/**
 * Argument names of the four tools whose arguments have a true equivalent,
 * keyed by the agy-native tool name: Claude Code's name, then the name the
 * `agy` CLI 1.5.9 declares (recorded 2026-11-17). An argument not listed keeps
 * its name.
 */
const AGY_ARGUMENT_ALIAS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  run_command: [
    ["command", "CommandLine"],
    ["description", "toolSummary"],
    ["run_in_background", "IsDaemon"],
  ],
  read_file: [["file_path", "Path"]],
  write_file: [
    ["file_path", "Path"],
    ["content", "Content"],
  ],
  edit_file: [
    ["file_path", "Path"],
    ["old_string", "Target"],
    ["new_string", "Replacement"],
  ],
};

/** Argument tables per provider, keyed by the native tool name. */
const PROVIDER_ARGUMENT_ALIASES: Record<
  string,
  Record<string, ReadonlyArray<readonly [string, string]>>
> = {
  antigravity: AGY_ARGUMENT_ALIAS,
};

type Arguments = Record<string, unknown>;

const isRecord = (value: unknown): value is Arguments =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function renameKeys(args: Arguments, names: Map<string, string>): Arguments {
  const out: Arguments = {};
  for (const [key, value] of Object.entries(args)) out[names.get(key) ?? key] = value;
  return out;
}

/**
 * `read_file` names a range of lines by its first and last line
 * (`StartLine`, `EndLine`); Claude Code's `Read` names it by the first line and
 * a count (`offset`, `limit`).
 */
function readRangeToWire(args: Arguments): Arguments {
  const { offset, limit, ...rest } = args;
  const out: Arguments = { ...rest };
  if (typeof offset === "number") out.StartLine = offset;
  if (typeof limit === "number")
    out.EndLine = (typeof offset === "number" ? offset : 1) + limit - 1;
  return out;
}

function readRangeFromWire(args: Arguments): Arguments {
  const { StartLine, EndLine, ...rest } = args;
  const out: Arguments = { ...rest };
  if (typeof StartLine === "number") out.offset = StartLine;
  if (typeof EndLine === "number") {
    out.limit = Math.max(1, EndLine - (typeof StartLine === "number" ? StartLine : 1) + 1);
  }
  return out;
}

const READ_RANGE_PROPERTIES = {
  StartLine: { type: "integer", description: "The first line to read, counted from 1." },
  EndLine: { type: "integer", description: "The last line to read, counted from 1." },
};

/** The tool's input schema with its argument names as the provider declares them. */
function schemaToWire(schema: unknown, native: string, names: Map<string, string>): unknown {
  if (!isRecord(schema) || !isRecord(schema.properties)) return schema;
  let properties = renameKeys(schema.properties, names);
  if (native === "read_file" && ("offset" in properties || "limit" in properties)) {
    const { offset: _offset, limit: _limit, ...rest } = properties;
    properties = { ...rest, ...READ_RANGE_PROPERTIES };
  }
  const out: Arguments = { ...schema, properties };
  if (Array.isArray(schema.required)) {
    out.required = schema.required
      .filter((name) => !(native === "read_file" && (name === "offset" || name === "limit")))
      .map((name) => (typeof name === "string" ? (names.get(name) ?? name) : name));
  }
  return out;
}

export interface AppliedToolAlias<T> {
  /** The request with the active alias pairs applied. */
  request: T;
  /** Claude name → the name sent on the wire; identity for an unaliased name. */
  forward: (name: string) => string;
  /** Wire name → Claude name, for the names THIS request renamed only. */
  restore: (name: string) => string;
  /**
   * A returned call's arguments in Claude Code's names. `wireName` is the name
   * the provider called; a tool this request did not rename keeps its arguments.
   */
  restoreArguments: (wireName: string, args: unknown) => unknown;
}

const identity = (name: string) => name;

function renameToolUses(
  content: unknown,
  forward: Map<string, string>,
  argumentsToWire: (native: string, args: unknown) => unknown
): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block: any) => {
    if (block?.type !== "tool_use" || typeof block.name !== "string") return block;
    const native = forward.get(block.name);
    if (native === undefined) return block;
    return { ...block, name: native, input: argumentsToWire(native, block.input) };
  });
}

/**
 * A copy of the request with aliased tool names renamed in the tool
 * definitions, in `tool_choice` and in assistant-history `tool_use` blocks,
 * and the renamed tools' argument names changed in their schemas and in those
 * `tool_use` inputs, plus the maps that undo it. The request given is not
 * mutated. A provider with no alias returns the request unchanged.
 *
 * The alias is built PER REQUEST. A pair is skipped when the request already
 * declares a tool under the native name (a custom `run_command`): renaming
 * `Bash` onto it would declare one name twice, and restoring it would turn the
 * custom tool's calls into `Bash` calls. `restore` therefore knows only the
 * pairs this request applied, never the whole table.
 */
export function aliasToolsForProvider<T extends Record<string, any>>(
  req: T,
  providerName: string
): AppliedToolAlias<T> {
  const table = PROVIDER_ALIASES[providerName];
  if (!table) {
    return {
      request: req,
      forward: identity,
      restore: identity,
      restoreArguments: (_name, args) => args,
    };
  }
  const argumentTables = PROVIDER_ARGUMENT_ALIASES[providerName] ?? {};
  const declared = new Set<string>(
    Array.isArray(req.tools) ? req.tools.map((tool: any) => tool?.name) : []
  );
  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  for (const [claude, native] of table) {
    if (declared.has(native)) continue;
    forward.set(claude, native);
    backward.set(native, claude);
  }
  const toWire = new Map<string, Map<string, string>>();
  const fromWire = new Map<string, Map<string, string>>();
  for (const native of backward.keys()) {
    const pairs = argumentTables[native];
    if (!pairs) continue;
    toWire.set(native, new Map(pairs.map(([claude, wire]) => [claude, wire])));
    fromWire.set(native, new Map(pairs.map(([claude, wire]) => [wire, claude])));
  }
  const argumentsToWire = (native: string, args: unknown): unknown => {
    const names = toWire.get(native);
    if (!names || !isRecord(args)) return args;
    const renamed = renameKeys(args, names);
    return native === "read_file" ? readRangeToWire(renamed) : renamed;
  };
  const restoreArguments = (wireName: string, args: unknown): unknown => {
    const names = fromWire.get(wireName);
    if (!names || !isRecord(args)) return args;
    const renamed = renameKeys(args, names);
    return wireName === "read_file" ? readRangeFromWire(renamed) : renamed;
  };
  const out: Record<string, any> = { ...req };
  if (Array.isArray(req.tools)) {
    out.tools = req.tools.map((tool: any) => {
      const native = typeof tool?.name === "string" ? forward.get(tool.name) : undefined;
      if (native === undefined) return tool;
      const names = toWire.get(native);
      return names && "input_schema" in tool
        ? { ...tool, name: native, input_schema: schemaToWire(tool.input_schema, native, names) }
        : { ...tool, name: native };
    });
  }
  const choice = req.tool_choice;
  if (choice && typeof choice.name === "string" && forward.has(choice.name)) {
    out.tool_choice = { ...choice, name: forward.get(choice.name) };
  }
  if (Array.isArray(req.messages)) {
    out.messages = req.messages.map((msg: any) =>
      msg?.role === "assistant"
        ? { ...msg, content: renameToolUses(msg.content, forward, argumentsToWire) }
        : msg
    );
  }
  return {
    request: out as T,
    forward: (name: string) => forward.get(name) ?? name,
    restore: (name: string) => backward.get(name) ?? name,
    restoreArguments,
  };
}
