/**
 * A classic tool round as exec items, for a code-mode request whose history
 * holds classic function calls: a session that started with code mode off, a
 * `/model` switch, the parallel wrapper's `toolu_<id>_p<k>` ids, a stray
 * classic call the model made in code mode (architecture §5.10).
 *
 * Mixing classic `function_call` items with the exec tool is the one history
 * shape nobody has shown the backend accepts. A round therefore goes as ONE
 * synthetic exec — a shape variants G/H/I proved:
 *
 *   custom_tool_call        call_id = "call_" + first 32 hex of sha256(first tool_use id)
 *                           input   = const r = await Promise.allSettled([tools.Read({...}), …]);
 *                                     for (const x of r) text(…);
 *   custom_tool_call_output Script completed, one text part per result in call
 *                           order; an is_error result as its rejected reason
 *
 * A tool absent from today's list is called in bracket form,
 * `tools["name"]`, so the script still says which tool ran. The round's cached
 * classic reasoning is not replayed (it belonged to function calls that are no
 * longer in the request). Pure: the same round gives the same bytes.
 */

import { createHash } from "node:crypto";
import { EXEC_TOOL_NAME } from "./exec-tool.js";
import type { ExecOutput, OutputPart } from "./output.js";
import type { ToolNameTable } from "./tool-names.js";
import { toolResultImages, toolResultText } from "./tool-results.js";
import type { ClaudeContentBlock, ResponsesItem } from "./types.js";

/** One classic round: an assistant message's classic tool_use blocks and their results. */
export interface ClassicRound {
  /** The tool_use blocks, in order. */
  uses: readonly ClaudeContentBlock[];
  /** tool_use id → its tool_result, for the ids that have one. */
  results: ReadonlyMap<string, ClaudeContentBlock>;
}

export interface TransliteratedRound {
  callId: string;
  /** The `custom_tool_call` item. */
  call: ResponsesItem;
  /** The script's output; the caller formats it (images resolve from the request). */
  output: ExecOutput;
}

/** The line each settled result prints (the source states what the output shows). */
const PRINT_LINE =
  'for (const x of r) text(x.status === "fulfilled" ? x.value : "Error: " + x.reason);';

/** `call_` + the first 32 hex of sha256(the round's first tool_use id). */
export function transliteratedCallId(firstToolUseId: string): string {
  return `call_${createHash("sha256").update(firstToolUseId).digest("hex").slice(0, 32)}`;
}

function callExpression(use: ClaudeContentBlock, names: ToolNameTable | undefined): string {
  const name = typeof use.name === "string" ? use.name : "";
  const ident = names?.identFor(name);
  const target = ident ? `tools.${ident}` : `tools[${JSON.stringify(name)}]`;
  return `${target}(${JSON.stringify(use.input ?? {})})`;
}

/** The synthetic script for a round. */
export function transliteratedSource(
  uses: readonly ClaudeContentBlock[],
  names?: ToolNameTable
): string {
  const calls = uses.map((use) => `  ${callExpression(use, names)}`).join(",\n");
  return `const r = await Promise.allSettled([\n${calls}\n]);\n${PRINT_LINE}`;
}

/**
 * The exec items for `round`. `names` is today's identifier table (tools absent
 * from it are called in bracket form).
 */
export function transliterateRound(
  round: ClassicRound,
  options: { names?: ToolNameTable } = {}
): TransliteratedRound {
  const firstId = typeof round.uses[0]?.id === "string" ? (round.uses[0].id as string) : "";
  const callId = transliteratedCallId(firstId);
  const parts: OutputPart[] = [];
  for (const use of round.uses) {
    const id = typeof use.id === "string" ? use.id : "";
    const result = round.results.get(id);
    if (!result) {
      parts.push({ type: "text", text: "Error: no tool_result returned" });
      continue;
    }
    const text = toolResultText(result);
    parts.push({ type: "text", text: result.is_error === true ? `Error: ${text}` : text });
    toolResultImages(result).forEach((_, index) => {
      parts.push({ type: "image", ref: { toolUseId: id, index } });
    });
  }
  return {
    callId,
    call: {
      type: "custom_tool_call",
      call_id: callId,
      name: EXEC_TOOL_NAME,
      input: transliteratedSource(round.uses, options.names),
    },
    output: { status: "completed", wallMs: undefined, parts },
  };
}
