/**
 * Content blocks of one Claude-format response, as the response-side hooks see
 * them: assembled from parsed SSE events (the seam's `buffer` mode and its
 * observe tap) or read off a non-streaming message (the JSON branch).
 *
 * The view is normalized on purpose. Every route converges on Claude SSE before
 * the seam, so a hook reads one shape, whichever parser produced the bytes.
 */

import type { ResponseBlock, ResponseView } from "./public.js";
import type { RewriteBlock, RewrittenBlock } from "./text-rewrite.js";

/** One block as the collector assembled it. */
export interface CollectedBlock {
  /** The block's index as it arrived. */
  index: number;
  /** `text`, `thinking`, `redacted_thinking`, `tool_use`, or anything else. */
  type: string;
  /** Text of a text block, or thinking of a thinking block. */
  text: string;
  /** A tool block's accumulated `input_json_delta` fragments. */
  args: string;
  /** A tool block's id and name. */
  id?: string;
  name?: string;
  /** A tool block's `input` from its start event (a JSON message carries it whole). */
  startInput?: unknown;
  /** A text block that carried a non-`text_delta` delta (e.g. `citations_delta`). */
  locked: boolean;
  complete: boolean;
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

export function isThinkingType(type: string | undefined): boolean {
  return THINKING_TYPES.has(type ?? "");
}

// biome-ignore lint/suspicious/noExplicitAny: parsed SSE payloads are untyped
type Json = any;

/** Assembles blocks from Claude SSE events, in arrival order. */
export class BlockCollector {
  readonly blocks: CollectedBlock[] = [];
  private readonly open = new Map<number, CollectedBlock>();
  stopReason: string | null = null;
  sawMessageStop = false;

  /**
   * Feed one parsed event. Returns the block it completed, if it was a
   * `content_block_stop`.
   */
  onEvent(data: Json): CollectedBlock | undefined {
    switch (data?.type) {
      case "content_block_start": {
        const cb = data.content_block ?? {};
        const block: CollectedBlock = {
          index: data.index,
          type: typeof cb.type === "string" ? cb.type : "unknown",
          text:
            typeof cb.text === "string"
              ? cb.text
              : typeof cb.thinking === "string"
                ? cb.thinking
                : "",
          args: "",
          locked: false,
          complete: false,
        };
        if (block.type === "tool_use") {
          block.id = typeof cb.id === "string" ? cb.id : undefined;
          block.name = typeof cb.name === "string" ? cb.name : undefined;
          block.startInput = cb.input;
        }
        this.blocks.push(block);
        this.open.set(data.index, block);
        return undefined;
      }
      case "content_block_delta": {
        const block = this.open.get(data.index);
        const delta = data.delta ?? {};
        if (!block) return undefined;
        if (delta.type === "text_delta" && typeof delta.text === "string") block.text += delta.text;
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.text += delta.thinking;
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          block.args += delta.partial_json;
        } else if (block.type === "text") {
          block.locked = true;
        }
        return undefined;
      }
      case "content_block_stop": {
        const block = this.open.get(data.index);
        if (!block) return undefined;
        this.open.delete(data.index);
        block.complete = true;
        return block;
      }
      case "message_delta":
        if (typeof data.delta?.stop_reason === "string") this.stopReason = data.delta.stop_reason;
        return undefined;
      case "message_stop":
        this.sawMessageStop = true;
        return undefined;
      default:
        return undefined;
    }
  }
}

/** A tool block's arguments: the parsed object, or null when they are malformed. */
export function parseToolArgs(raw: string): Record<string, unknown> | null {
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The input a view reports for a collected tool block. */
function toolInput(block: CollectedBlock, override?: Record<string, unknown>): unknown {
  if (override) return override;
  if (block.args === "" && block.startInput !== undefined) return block.startInput;
  return parseToolArgs(block.args) ?? block.args;
}

/** One collected block as a hook sees it. */
export function viewBlock(
  block: CollectedBlock,
  override?: Record<string, unknown>
): ResponseBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id ?? "",
        name: block.name ?? "",
        input: toolInput(block, override),
      };
    default:
      return { type: "other", blockType: block.type };
  }
}

/** Assemble a view from normalized blocks. */
export function responseView(
  blocks: ReadonlyArray<ResponseBlock>,
  stopReason: string | null
): ResponseView {
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolNames: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") text.push(b.text);
    else if (b.type === "thinking") reasoning.push(b.thinking);
    else if (b.type === "tool_use") toolNames.push(b.name);
  }
  return {
    blocks,
    text: text.join("\n\n"),
    reasoning: reasoning.join("\n\n"),
    toolNames,
    stopReason,
  };
}

/** A view over every block a collector saw. */
export function collectorView(
  collector: BlockCollector,
  overrides?: ReadonlyMap<number, Record<string, unknown>>
): ResponseView {
  return responseView(
    collector.blocks.map((b) => viewBlock(b, overrides?.get(b.index))),
    collector.stopReason
  );
}

/** One block of a non-streaming message's `content[]`, as a hook sees it. */
export function messageBlock(b: Json): ResponseBlock {
  switch (b?.type) {
    case "text":
      return { type: "text", text: typeof b.text === "string" ? b.text : "" };
    case "thinking":
      return { type: "thinking", thinking: typeof b.thinking === "string" ? b.thinking : "" };
    case "tool_use":
      return {
        type: "tool_use",
        id: String(b.id ?? ""),
        name: String(b.name ?? ""),
        input: b.input,
      };
    default:
      return { type: "other", blockType: typeof b?.type === "string" ? b.type : "unknown" };
  }
}

/** A view over a non-streaming message's `content[]`. */
export function messageView(message: Json): ResponseView {
  const content: Json[] = Array.isArray(message?.content) ? message.content : [];
  return responseView(
    content.map(messageBlock),
    typeof message?.stop_reason === "string" ? message.stop_reason : null
  );
}

/**
 * The view a later `responseRewrite` step sees (§4.4.1): `lead` (blocks before
 * the held region, e.g. thinking that streamed live), then the held region as
 * `applyTextActions` left it — an edited or inserted text block as its new
 * text, any other block as `original(source)` gives it. Text actions touch only
 * text blocks, so `reasoning`, `toolNames` and `stopReason` come out unchanged.
 */
export function rewrittenView(
  lead: ReadonlyArray<ResponseBlock>,
  rewritten: ReadonlyArray<RewrittenBlock<RewriteBlock>>,
  original: (source: number) => ResponseBlock,
  stopReason: string | null
): ResponseView {
  const held = rewritten.map(
    (b): ResponseBlock =>
      b.source === null || b.changed
        ? { type: "text", text: (b.block as { text?: string }).text ?? "" }
        : original(b.source)
  );
  return responseView([...lead, ...held], stopReason);
}
