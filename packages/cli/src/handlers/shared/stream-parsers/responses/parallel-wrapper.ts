/**
 * The `parallel` tool wrapper some OpenAI models emit instead of N separate
 * function calls.
 *
 * Models trained on the ChatGPT tool protocol know a built-in
 * `multi_tool_use.parallel` tool whose arguments are
 * `{tool_uses:[{recipient_name:"functions.<tool>", parameters:{...}}]}`. The
 * Codex backend normally unpacks a valid wrapper itself, so claudish never sees
 * one; what does reach the Responses stream is a function_call NAMED
 * `parallel` (or `multi_tool_use.parallel`) that no tool in the request
 * declares. In the observed failure (~1% of turns,
 * `ai-docs/reports/codex-parallel-wrapper-degeneration-2026-10.md`) its
 * arguments are a degenerate 41-96 KB string (`a.ts.tsaaa.ts.ts...`) that
 * arrives in one burst after a 361-484 s keepalive-only stall, ending on
 * `response.incomplete` `max_output_tokens`.
 *
 * Forwarded as-is, Claude Code receives a call to a tool that does not exist.
 * So the parser holds such a call (no `content_block_start`) and decides at
 * `output_item.done`: a valid wrapper becomes one tool_use block per entry; a
 * degenerate one is never shown to Claude Code.
 */

/** Wrapper names, with the optional `functions.` namespace stripped first. */
const WRAPPER_NAMES = new Set(["parallel", "multi_tool_use.parallel"]);

function stripFunctionsPrefix(name: string): string {
  return name.startsWith("functions.") ? name.slice("functions.".length) : name;
}

/**
 * Is this function_call the `parallel` wrapper rather than a real tool?
 *
 * True iff the name (optionally `functions.`-prefixed) is `parallel` or
 * `multi_tool_use.parallel` AND no tool the request declared is called that.
 * `declaredNames` are the request's tool names as Claude Code sent them (the
 * DECODED names, not the encoded wire names), so a user tool really named
 * `parallel` is always forwarded as an ordinary call.
 */
export function isParallelWrapperName(name: string, declaredNames: Iterable<string>): boolean {
  if (!name) return false;
  const bare = stripFunctionsPrefix(name);
  if (!WRAPPER_NAMES.has(bare)) return false;
  for (const declared of declaredNames) {
    if (declared === name || declared === bare) return false;
  }
  return true;
}

/** One expanded call: the Claude Code tool name and its argument JSON. */
export interface ParallelWrapperCall {
  name: string;
  /** JSON text of the call's arguments, ready for one `input_json_delta`. */
  arguments: string;
}

export type ParallelWrapperParse =
  | { ok: true; calls: ParallelWrapperCall[] }
  | { ok: false; reason: "unparseable" | "shape" | "empty" };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The argument JSON for one entry's `parameters`, or undefined when it is not an object. */
function parametersJson(parameters: unknown): string | undefined {
  if (isPlainObject(parameters)) return JSON.stringify(parameters);
  if (typeof parameters === "string") {
    try {
      const parsed = JSON.parse(parameters);
      if (isPlainObject(parsed)) return parameters;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Parse a wrapper's complete argument string.
 *
 * Valid: `{tool_uses:[{recipient_name, parameters}, ...]}` with at least one
 * entry, every `recipient_name` a non-empty string and every `parameters` an
 * object (or a JSON string of one). Each name has `functions.` stripped and is
 * then passed through `decode` (the request's encoded-to-Claude tool name map);
 * an unknown recipient is kept as-is, so Claude Code reports it to the model
 * rather than claudish dropping it silently.
 *
 * Anything else is degenerate: `unparseable` (not JSON), `shape` (JSON of the
 * wrong shape), `empty` (an empty argument string or an empty `tool_uses`).
 */
export function parseParallelWrapper(
  args: string,
  decode: (name: string) => string
): ParallelWrapperParse {
  if (!args || args.trim() === "") return { ok: false, reason: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.tool_uses)) {
    return { ok: false, reason: "shape" };
  }
  if (parsed.tool_uses.length === 0) return { ok: false, reason: "empty" };
  const calls: ParallelWrapperCall[] = [];
  for (const entry of parsed.tool_uses) {
    if (!isPlainObject(entry)) return { ok: false, reason: "shape" };
    const recipient = entry.recipient_name;
    if (typeof recipient !== "string" || recipient.trim() === "") {
      return { ok: false, reason: "shape" };
    }
    const json = parametersJson(entry.parameters);
    if (json === undefined) return { ok: false, reason: "shape" };
    const bare = stripFunctionsPrefix(recipient);
    calls.push({ name: decode(bare) || bare, arguments: json });
  }
  return { ok: true, calls };
}
