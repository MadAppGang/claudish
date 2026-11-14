/**
 * Tool-name alias for the `antigravity` provider.
 *
 * Claude Code advertises its tools under its own names (`Bash`, `Edit`). This
 * renames the ones with a true equivalent to the names Google's own Antigravity
 * client sends (`run_command`, `edit_file`), so the backend sees its own tool
 * vocabulary. The rename is reversible and provider-scoped.
 *
 * SCOPE — names only. The argument SCHEMAS are left as Claude Code's. agy's
 * `edit_file` takes an `Instruction` plus a `CodeEdit` with `{{...}}` elision
 * that a separate apply-model reconciles; Claude Code's `Edit` takes exact
 * `old_string`/`new_string`. Translating between them is not a rename, so this
 * does not attempt it. A renamed tool therefore carries Claude Code's arguments
 * under agy's name — enough to match the vocabulary, not the full request shape.
 *
 * REVERSIBILITY is the invariant. Every name changed on the way out
 * (`aliasToolsForProvider`) MUST be mapped back on the way in (its `restore`), or
 * Claude Code receives a `tool_use` for a tool it never declared and the turn
 * fails. The round trip is covered in `tool-name-alias.test.ts`.
 *
 * The native names come from the `agy` binary's own prompt (few-shot tool
 * calls); see `ai-docs/architecture/providers/antigravity.md`. `Read` is left
 * unaliased on purpose: the binary carries both `read_file` and `view_file` and
 * does not settle which is current, and a wrong name is worse than none.
 */

/** Claude Code built-in → the agy-native name. A fixed, hand-verified set. */
const AGY_TOOL_ALIAS: ReadonlyArray<readonly [string, string]> = [
  ["Bash", "run_command"],
  ["Write", "write_to_file"],
  ["Edit", "edit_file"],
  ["Grep", "grep_search"],
  ["Glob", "find_by_name"],
  ["LS", "list_dir"],
];

/** Providers that get a native tool-name alias, each with its own table. */
const PROVIDER_ALIASES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  antigravity: AGY_TOOL_ALIAS,
};

export interface AppliedToolAlias<T> {
  /** The request with the active alias pairs applied. */
  request: T;
  /** Claude name → the name sent on the wire; identity for an unaliased name. */
  forward: (name: string) => string;
  /** Wire name → Claude name, for the names THIS request renamed only. */
  restore: (name: string) => string;
}

const identity = (name: string) => name;

function renameToolUses(content: unknown, forward: Map<string, string>): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block: any) =>
    block?.type === "tool_use" && typeof block.name === "string" && forward.has(block.name)
      ? { ...block, name: forward.get(block.name) }
      : block
  );
}

/**
 * A copy of the request with aliased tool names renamed in the tool
 * definitions, in `tool_choice` and in assistant-history `tool_use` blocks,
 * plus the `forward` and `restore` maps of what was renamed. The request given
 * is not mutated. A provider with no alias returns the request unchanged.
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
  if (!table) return { request: req, forward: identity, restore: identity };
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
  const out: Record<string, any> = { ...req };
  if (Array.isArray(req.tools)) {
    out.tools = req.tools.map((tool: any) =>
      typeof tool?.name === "string" && forward.has(tool.name)
        ? { ...tool, name: forward.get(tool.name) }
        : tool
    );
  }
  const choice = req.tool_choice;
  if (choice && typeof choice.name === "string" && forward.has(choice.name)) {
    out.tool_choice = { ...choice, name: forward.get(choice.name) };
  }
  if (Array.isArray(req.messages)) {
    out.messages = req.messages.map((msg: any) =>
      msg?.role === "assistant" ? { ...msg, content: renameToolUses(msg.content, forward) } : msg
    );
  }
  return {
    request: out as T,
    forward: (name: string) => forward.get(name) ?? name,
    restore: (name: string) => backward.get(name) ?? name,
  };
}
