/**
 * Claude Code `tool_result` blocks as code mode reads them: the text a nested
 * call resolves (or rejects) with, the images it carried, and how a script's
 * results are shown when its own output cannot be.
 *
 * Images never enter the script. A nested result's images become numbered
 * placeholders in the text the script receives and `(tool_use_id, index)`
 * references in the script's output, resolved from this request's history
 * when the output is rendered — so each image appears exactly once, inside the
 * output.
 */

import { imageBlockToUrlPart } from "../handlers/shared/format/openai-messages.js";
import type { ImageRef } from "./output.js";
import type { NestedResult } from "./sandbox/script-runtime.js";
import type { ClaudeContentBlock } from "./types.js";

/** The placeholder a script sees for image `index` of a result. */
export function imagePlaceholder(index: number): string {
  return `[image ${index}: attached to the exec output]`;
}

function blocksOf(content: unknown): ClaudeContentBlock[] {
  return Array.isArray(content) ? (content as ClaudeContentBlock[]) : [];
}

/** The image blocks of a tool_result, in order. */
export function toolResultImages(block: ClaudeContentBlock): ClaudeContentBlock[] {
  return blocksOf(block.content).filter((inner) => inner?.type === "image");
}

/**
 * A tool_result's text: string content as-is; block content as its text
 * blocks joined with `\n`, an image placeholder per image, and any other
 * block as JSON.
 */
export function toolResultText(block: ClaudeContentBlock): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  const pieces: string[] = [];
  let images = 0;
  for (const inner of content as ClaudeContentBlock[]) {
    if (inner?.type === "text" && typeof inner.text === "string") pieces.push(inner.text);
    else if (inner?.type === "image") pieces.push(imagePlaceholder(images++));
    else pieces.push(JSON.stringify(inner));
  }
  return pieces.join("\n");
}

/**
 * The start of the tool_result Claude Code writes, on resuming a session, for a
 * call whose real result was never recorded (V7, 2.1.304): `[Tool call
 * interrupted: the session ended before this call's result was recorded, so
 * its outcome is unknown. …]`, `is_error: true`. Such a result never reached
 * claudish: the session (and claudish with it) ended while the call ran.
 */
export const SESSION_ENDED_RESULT_MARKER = "[Tool call interrupted";

/** True for a tool_result Claude Code synthesized because the session ended before the call's result. */
export function isSessionEndedResult(block: ClaudeContentBlock): boolean {
  // `is_error` too: a tool that merely printed the words is a real result.
  return (
    block.is_error === true &&
    toolResultText(block).trimStart().startsWith(SESSION_ENDED_RESULT_MARKER)
  );
}

/** The answer a script receives for nested call `seq` from Claude Code's tool_result. */
export function nestedResultFromToolResult(seq: number, block: ClaudeContentBlock): NestedResult {
  const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
  const images: ImageRef[] = toolResultImages(block).map((_, index) => ({ toolUseId, index }));
  const result: NestedResult = { seq, ok: block.is_error !== true, text: toolResultText(block) };
  if (images.length > 0) result.images = images;
  return result;
}

/** An image block as a Responses `input_image` URL, or undefined when it cannot be expressed. */
export function imageUrlOf(block: ClaudeContentBlock): string | undefined {
  const part = imageBlockToUrlPart(block);
  const url = part?.image_url?.url;
  return typeof url === "string" && url ? url : undefined;
}
