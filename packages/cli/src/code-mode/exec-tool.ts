/**
 * The exec tool: ONE freeform custom tool whose input is JavaScript that calls
 * Claude Code's tools as `tools.<Name>(args)`.
 *
 * The definition follows the official Codex client's (R1 §1c,
 * `evidence/r1/exec-tool.json`): `type: "custom"`, `name: "exec"`, the same
 * lark grammar (with its optional `// @exec:` first-line pragma), and a
 * description whose head explains the runtime, followed by one section per
 * nested tool in Codex's form:
 *
 *     ### `Name`
 *     <the tool's description>
 *
 *     exec tool declaration:
 *     ```ts
 *     declare const tools: { Name(args: {…}): Promise<string>; };
 *     ```
 *
 * The head lists only what claudish's sandbox implements (`text()`, `exit()`,
 * `tools`, `ALL_TOOLS`); Codex's `image()`, `store()`, `notify()`, timers and
 * yield are absent, so the model is never told about a helper that would throw.
 *
 * Sections are rendered from `claudeRequest.tools` AFTER the hook request stages (1a, 3a) have
 * rewritten descriptions, so names are Claude Code's own, never the step-5
 * encoded names. A size budget keeps the description bounded on sessions with
 * many MCP tools: a section is at most `perToolBytes` (its description is cut to
 * fit; the full text stays in `ALL_TOOLS`), sections are added in Claude Code's
 * order up to `totalBytes`, and the rest are listed as deferred tools by name
 * and first sentence. Every tool stays callable either way.
 */

import { log } from "../logger.js";
import { schemaToTs } from "./schema-to-ts.js";
import { ToolNameTable, normalizeToolIdent } from "./tool-names.js";

/** The exec tool's grammar, verbatim from the Codex client's definition. */
export const EXEC_TOOL_GRAMMAR =
  "\nstart: pragma_source | plain_source\npragma_source: PRAGMA_LINE NEWLINE SOURCE\nplain_source: SOURCE\n\nPRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/\nNEWLINE: /\\r?\\n/\nSOURCE: /[\\s\\S]+/\n";

/** The exec tool's name on the wire. */
export const EXEC_TOOL_NAME = "exec";

/**
 * The output budget the exec description states when discovery publishes no
 * token truncation policy: the protocol default the Codex exec description
 * itself states ("Defaults to 10000 tokens"). A rule, not model data.
 */
export const DEFAULT_EXEC_MAX_OUTPUT_TOKENS = 10_000;

/** Description size limits (claudish policy; UTF-8 bytes). */
export interface ExecToolBudget {
  /** One nested tool's section, heading to closing fence. */
  perToolBytes: number;
  /** Every rendered section together. */
  totalBytes: number;
}

export const DEFAULT_EXEC_TOOL_BUDGET: ExecToolBudget = {
  perToolBytes: 6 * 1024,
  totalBytes: 48 * 1024,
};

/** The Responses custom tool definition sent upstream. */
export interface ExecToolDefinition {
  type: "custom";
  name: typeof EXEC_TOOL_NAME;
  description: string;
  format: { type: "grammar"; syntax: "lark"; definition: string };
}

/** One entry of the sandbox's `ALL_TOOLS` global. */
export interface ExecToolMeta {
  /** The identifier a script calls (`tools[name]`). */
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface RenderedExecTool {
  tool: ExecToolDefinition;
  /** Identifier ↔ Claude Code name for every callable tool. */
  names: ToolNameTable;
  /** `ALL_TOOLS`: every callable tool with its full description and schema. */
  allTools: ExecToolMeta[];
  /** Claude Code names listed only under "Deferred tools" (over the budget). */
  deferred: string[];
}

/** A Claude Code tool as it arrives in `claudeRequest.tools`. */
export interface ClaudeToolLike {
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
}

export interface RenderExecToolOptions {
  /** The `max_output_tokens` default the description states. Default 10,000. */
  defaultMaxOutputTokens?: number;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** `text` cut to at most `maxBytes` UTF-8 bytes at a line (else character) boundary. */
function cutToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  const head = text.slice(0, lo);
  const nl = head.lastIndexOf("\n");
  return nl > head.length / 2 ? head.slice(0, nl) : head;
}

/** The first sentence (or first line) of a description, for the deferred list. */
function firstSentence(description: string): string {
  const line = description.trim().split(/\r?\n/)[0] ?? "";
  const match = /^(.+?[.!?])(\s|$)/.exec(line);
  const sentence = (match ? match[1] : line).trim();
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

function execToolHead(defaultMaxOutputTokens: number): string {
  return [
    "Run JavaScript code to orchestrate/compose tool calls",
    "- Evaluates the provided JavaScript code in a fresh sandbox as the body of an async function, so top-level `await` works.",
    '- All nested tools are available on the global `tools` object, for example `await tools.Read({ file_path: "/abs/path" })`. Tool names are exposed as normalized JavaScript identifiers.',
    "- Nested tool methods take an object as their input argument.",
    "- Nested tools return a string: the tool's result text. A failed or denied call rejects with a string (the tool's error text), so use `Promise.allSettled` to inspect every result.",
    "- Runs raw JavaScript -- no Node, no file system, no network access, no console, no timers.",
    "- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.",
    '- You may optionally start the tool input with a first-line pragma like `// @exec: {"max_output_tokens": 1000}`.',
    `- \`max_output_tokens\` sets the token budget for direct \`exec\` results. Defaults to ${defaultMaxOutputTokens} tokens.`,
    "- When the script finishes, nested tool calls it never awaited are discarded and never run.",
    "",
    "- Global helpers:",
    "- `exit()`: Immediately ends the current script successfully (like an early return from the top level).",
    "- `text(value: string | number | boolean | undefined | null)`: Appends a text item. Non-string values are stringified with `JSON.stringify(...)` when possible.",
    "- `ALL_TOOLS`: metadata for the enabled nested tools as `{ name, description, inputSchema }` entries.",
    "",
    "Batch independent searches and reads in one exec using await Promise.allSettled([...]); inspect every result.",
    "When calling `exec`, parallelize independent tool calls by awaiting Promises.",
  ].join("\n");
}

function renderSection(ident: string, description: string, schema: unknown): string {
  const declaration = `declare const tools: { ${ident}(args: ${schemaToTs(schema)}): Promise<string>; };`;
  const body = description.trim();
  return [
    `### \`${ident}\``,
    ...(body ? [body] : []),
    "",
    "exec tool declaration:",
    "```ts",
    declaration,
    "```",
  ].join("\n");
}

/**
 * One section within `perToolBytes`: the full description when it fits, else
 * the description cut to fit with a pointer to `ALL_TOOLS`; undefined when the
 * declaration alone exceeds the budget (the tool is then deferred).
 */
function sectionWithinBudget(
  ident: string,
  description: string,
  schema: unknown,
  perToolBytes: number
): string | undefined {
  const full = renderSection(ident, description, schema);
  if (utf8Bytes(full) <= perToolBytes) return full;
  const bare = renderSection(ident, "", schema);
  const marker = "\n[description shortened; the full text is in ALL_TOOLS]";
  const room = perToolBytes - utf8Bytes(bare) - utf8Bytes(marker) - 1;
  if (room < 0) return undefined;
  const cut = cutToBytes(description.trim(), room);
  return renderSection(ident, cut ? `${cut}${marker}` : marker.trim(), schema);
}

/** The "Deferred tools" list: identifier and first sentence of each. */
function deferredSection(
  deferred: readonly string[],
  names: ToolNameTable,
  allTools: readonly ExecToolMeta[]
): string {
  const lines = deferred.map((name) => {
    const ident = names.identFor(name) ?? name;
    const meta = allTools.find((m) => m.name === ident);
    const sentence = firstSentence(meta?.description ?? "");
    return sentence ? `- \`${ident}\` — ${sentence}` : `- \`${ident}\``;
  });
  return `### Deferred tools\n${lines.join("\n")}`;
}

/**
 * Every callable tool's `ALL_TOOLS` entry, the sections that fit the budget,
 * and the names deferred past it.
 */
function layOutSections(
  named: ReadonlyArray<ClaudeToolLike & { name: string }>,
  names: ToolNameTable,
  limits: ExecToolBudget
): { sections: string[]; deferred: string[]; allTools: ExecToolMeta[] } {
  const sections: string[] = [];
  const deferred: string[] = [];
  // One entry per kept table name (a repeated name or a skipped collision is not callable).
  const seen = new Set<string>();
  const callable = named.filter((tool) => {
    if (seen.has(tool.name) || names.identFor(tool.name) === undefined) return false;
    seen.add(tool.name);
    return true;
  });
  const allTools: ExecToolMeta[] = callable.map((tool) => ({
    name: names.identFor(tool.name) ?? normalizeToolIdent(tool.name),
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: tool.input_schema ?? {},
  }));
  let used = 0;
  let overflowed = false;

  for (const [i, tool] of callable.entries()) {
    const { name: ident, description, inputSchema } = allTools[i];
    const section = overflowed
      ? undefined
      : sectionWithinBudget(ident, description, inputSchema, limits.perToolBytes);
    const size = section === undefined ? 0 : utf8Bytes(section) + 2;
    if (section === undefined || used + size > limits.totalBytes) {
      // Claude Code's order is kept: once one section does not fit the total,
      // every later tool is deferred too. A tool whose declaration alone
      // exceeds the per-tool budget is deferred on its own.
      if (section !== undefined) overflowed = true;
      deferred.push(tool.name);
      continue;
    }
    sections.push(section);
    used += size;
  }
  return { sections, deferred, allTools };
}

/**
 * The exec tool for `tools` (Claude Code's tool list, in its order).
 *
 * Tools without a string name are ignored; a name whose identifier collides
 * with an earlier one is skipped (logged by `ToolNameTable`) and not callable.
 */
export function renderExecTool(
  tools: readonly ClaudeToolLike[],
  budget: Partial<ExecToolBudget> = {},
  options: RenderExecToolOptions = {}
): RenderedExecTool {
  const limits: ExecToolBudget = { ...DEFAULT_EXEC_TOOL_BUDGET, ...budget };
  const defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? DEFAULT_EXEC_MAX_OUTPUT_TOKENS;
  const named = tools.filter(
    (t): t is ClaudeToolLike & { name: string } => typeof t?.name === "string" && t.name !== ""
  );
  const names = new ToolNameTable(named.map((t) => t.name));
  const { sections, deferred, allTools } = layOutSections(named, names, limits);

  const parts = [execToolHead(defaultMaxOutputTokens)];
  if (deferred.length > 0) {
    parts.push(
      "Some deferred nested tools are omitted from this description. They are still available on the global `tools` object and listed in `ALL_TOOLS`.\nTo find one, filter `ALL_TOOLS` by `name` and `description`."
    );
  }
  parts.push(...sections);
  if (deferred.length > 0) {
    parts.push(deferredSection(deferred, names, allTools));
    log(
      `[CodeMode] exec tool: ${sections.length} tool(s) described, ${deferred.length} deferred over the ${limits.totalBytes}-byte budget`
    );
  }

  return {
    tool: {
      type: "custom",
      name: EXEC_TOOL_NAME,
      description: parts.join("\n\n"),
      format: { type: "grammar", syntax: "lark", definition: EXEC_TOOL_GRAMMAR },
    },
    names,
    allTools,
    deferred,
  };
}
