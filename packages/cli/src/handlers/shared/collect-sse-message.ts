/**
 * Claude SSE → a single Claude Messages JSON response.
 *
 * Every stream parser in this directory emits Claude SSE, because that is what
 * Claude Code wants for an interactive turn. But the Messages API also has a
 * non-streaming mode — `stream` absent or false — and Claude Code uses it for
 * one-shot internal calls, `/compact` being the one people notice.
 *
 * `NativeHandler` has always served those correctly by accident of its design:
 * it forwards the client's payload verbatim to Anthropic and branches on the
 * RESPONSE content-type, so a `stream: false` request comes back as JSON. Every
 * adapter's `buildPayload`, by contrast, hardcodes `stream: true` and
 * ComposedHandler answered with an event stream regardless. That is the whole
 * asymmetry: `/compact` worked on a native `claude-*` model and returned
 * unparseable `event: message_start` on every proxied one.
 *
 * Rather than give each of the six parsers a second output mode, this consumes
 * the SSE they already produce and folds it back into the object the
 * non-streaming API would have returned. One implementation, all stream formats,
 * and every behaviour that lives in the parsers (tool repair, thinking filter,
 * token accounting) applies unchanged.
 *
 * Deliberately tolerant: a malformed data line is skipped rather than thrown on,
 * and a stream that ends early still yields whatever content did arrive. A
 * partial answer beats a 500 for a client that cannot retry.
 */

import { log } from "../../logger.js";
import { streamFailureHeaders } from "./recovery-marker.js";

/**
 * Give up after this long with NOTHING on the wire — not one byte, not a ping.
 *
 * Streaming mode never needed this: the client holds an open socket, sees the
 * turn stop producing, and the user cancels. Buffering removes that escape
 * hatch, because we `await` the stream to completion before anything reaches
 * the client, so a parser that never closes its controller hangs the caller
 * forever with no output to hint at why.
 *
 * The number is safe rather than tuned, because every parser in this directory
 * emits a keepalive `ping` on a 1-second interval for as long as it is alive
 * (openai-sse:215, anthropic-sse:210, gemini-sse:93, ollama-jsonl:62,
 * openai-responses-sse:206). A model that thinks for ten minutes still pings
 * ten minutes' worth, so this can never truncate a live turn — 120 seconds of
 * total silence means 120 consecutive missed pings, which only happens once the
 * parser is genuinely dead.
 *
 * It does NOT cover an upstream provider that goes quiet with the socket open:
 * the parser is alive there and keeps pinging on its behalf. That case is
 * unbounded in streaming mode today too, so buffering does not make it worse,
 * and fixing it belongs upstream where the provider socket actually lives.
 */
const STALL_TIMEOUT_MS = 120_000;

interface CollectedBlock {
  type: "text" | "thinking" | "tool_use";
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  /** tool_use input arrives as partial_json fragments; parsed at block stop. */
  partialJson?: string;
  input?: unknown;
}

export interface CollectedMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
  /**
   * Set when the stream carried an SSE `error` event: the turn FAILED after the
   * provider answered 200. `content` is then empty (every collected block is
   * discarded) and `sseResponseToJson` answers an error, not this message.
   * Never serialised as part of a message.
   */
  streamError?: CollectedStreamError;
}

/** The error an SSE `error` event declared: `{type, message}` of its `error` object. */
export interface CollectedStreamError {
  type: string;
  message: string;
}

/**
 * The HTTP status the Anthropic Messages API defines for an error type. Any
 * type not listed is answered 500.
 */
const STATUS_FOR_ERROR_TYPE: Record<string, number> = {
  invalid_request_error: 400,
  api_error: 500,
  overloaded_error: 529,
};

/** The status an Anthropic error body of this `type` is answered with. */
export function statusForStreamErrorType(type: string): number {
  return STATUS_FOR_ERROR_TYPE[type] ?? 500;
}

export interface CollectSseOptions {
  /** Overrides {@link STALL_TIMEOUT_MS}. Tests set this; nothing else should. */
  stallTimeoutMs?: number;
}

function finalizeBlock(block: CollectedBlock): Record<string, unknown> {
  if (block.type === "text") {
    return { type: "text", text: block.text ?? "" };
  }
  if (block.type === "thinking") {
    return {
      type: "thinking",
      thinking: block.thinking ?? "",
      ...(block.signature ? { signature: block.signature } : {}),
    };
  }
  // tool_use — the arguments arrived as a JSON string in fragments.
  let input: unknown = block.input ?? {};
  if (block.partialJson !== undefined && block.partialJson !== "") {
    try {
      input = JSON.parse(block.partialJson);
    } catch {
      // A tool call we cannot parse is worse than useless downstream, but
      // dropping the block silently would hide the turn entirely. Keep the
      // block with empty input and let the client's own validation report it.
      log(
        `[CollectSSE] tool_use ${block.name ?? "?"} had unparseable input, emitting empty object`
      );
      input = {};
    }
  }
  return {
    type: "tool_use",
    id: block.id ?? "",
    name: block.name ?? "",
    input,
  };
}

/**
 * Read a Claude SSE stream to completion and assemble the equivalent
 * non-streaming Messages response. Never rejects.
 */
export async function collectSseMessage(
  sse: Response,
  fallbackModel: string,
  opts: CollectSseOptions = {}
): Promise<CollectedMessage> {
  const message: CollectedMessage = {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: fallbackModel,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  const blocks = new Map<number, CollectedBlock>();
  let streamError: CollectedStreamError | undefined;

  /**
   * A delta may name a block no `content_block_start` announced.
   *
   * Canonical Claude SSE always registers a block first, and every parser here
   * does. But this reads whatever the wire carried, and a stream truncated
   * before its opening frame — or a provider that simply omits one — would
   * otherwise have its entire turn silently discarded. Defaulting to a text
   * block keeps the words; guessing wrong costs a block type, not the content.
   */
  const blockAt = (index: number): CollectedBlock => {
    let block = blocks.get(index);
    if (!block) {
      block = { type: "text", text: "" };
      blocks.set(index, block);
    }
    return block;
  };

  if (!sse.body) return message;

  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  const stallMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  let buffer = "";

  const handle = (data: any) => {
    switch (data?.type) {
      case "message_start": {
        const m = data.message ?? {};
        if (m.id) message.id = m.id;
        if (m.model) message.model = m.model;
        if (m.usage?.input_tokens != null) message.usage.input_tokens = m.usage.input_tokens;
        if (m.usage?.output_tokens != null) message.usage.output_tokens = m.usage.output_tokens;
        break;
      }
      case "content_block_start": {
        const cb = data.content_block ?? {};
        const kind =
          cb.type === "thinking" ? "thinking" : cb.type === "tool_use" ? "tool_use" : "text";
        blocks.set(data.index, {
          type: kind,
          text: kind === "text" ? (cb.text ?? "") : undefined,
          thinking: kind === "thinking" ? (cb.thinking ?? "") : undefined,
          id: cb.id,
          name: cb.name,
          partialJson: kind === "tool_use" ? "" : undefined,
        });
        break;
      }
      case "content_block_delta": {
        const block = blockAt(data.index);
        const d = data.delta ?? {};
        if (d.type === "text_delta") block.text = (block.text ?? "") + (d.text ?? "");
        else if (d.type === "thinking_delta")
          block.thinking = (block.thinking ?? "") + (d.thinking ?? "");
        else if (d.type === "signature_delta") block.signature = d.signature;
        else if (d.type === "input_json_delta")
          block.partialJson = (block.partialJson ?? "") + (d.partial_json ?? "");
        break;
      }
      case "message_delta": {
        if (data.delta?.stop_reason !== undefined) message.stop_reason = data.delta.stop_reason;
        if (data.delta?.stop_sequence !== undefined)
          message.stop_sequence = data.delta.stop_sequence;
        if (data.usage?.input_tokens != null) message.usage.input_tokens = data.usage.input_tokens;
        if (data.usage?.output_tokens != null)
          message.usage.output_tokens = data.usage.output_tokens;
        break;
      }
      case "error": {
        // The parsers' terminal failure: Claude Code discards a streamed message
        // that ends this way and retries the turn. The first one wins.
        if (!streamError) {
          const e = data.error ?? {};
          streamError = {
            type: typeof e.type === "string" && e.type ? e.type : "api_error",
            message:
              typeof e.message === "string" && e.message ? e.message : "Stream ended with an error",
          };
        }
        break;
      }
      default:
        break;
    }
  };

  try {
    while (true) {
      // A fresh timer per chunk, so the deadline is "silence since the last
      // byte" rather than a cap on the turn. The losing read stays pending
      // until reader.cancel() settles it below.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"stalled">((resolve) => {
          timer = setTimeout(() => resolve("stalled"), stallMs);
        }),
      ]);
      clearTimeout(timer);

      if (chunk === "stalled") {
        log(
          `[CollectSSE] no data for ${stallMs}ms — returning ${blocks.size} block(s) collected so far`
        );
        await reader.cancel().catch(() => {});
        break;
      }
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        // SSE allows one optional space after the colon; providers differ.
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          handle(JSON.parse(payload));
        } catch {
          // Malformed frame — skip it rather than losing the whole turn.
        }
      }
    }
  } catch (e) {
    // A read error mid-stream keeps whatever arrived. Same reasoning as the
    // parsers' own catch blocks: a partial turn beats no turn.
    log(`[CollectSSE] read failed, keeping ${blocks.size} block(s): ${e}`);
  }

  if (streamError) {
    // A failed turn has no partial answer worth keeping: in streaming mode the
    // client discards every block of it, so the JSON form does too.
    log(
      `[CollectSSE] stream ended with SSE error (${streamError.type}): discarding ${blocks.size} block(s)`
    );
    message.content = [];
    message.streamError = streamError;
    return message;
  }

  // Emit blocks in index order; the map is keyed by the wire index.
  for (const index of Array.from(blocks.keys()).sort((a, b) => a - b)) {
    message.content.push(finalizeBlock(blocks.get(index)!));
  }

  // A turn that produced content but never delivered a closing delta still has
  // to name a stop_reason: Claude Code rejects `stop_reason: undefined`, and
  // null is only valid mid-stream. Derive it the same way devin-connect does —
  // any tool_use block means the model is handing back to the harness.
  if (message.stop_reason === null) {
    message.stop_reason = message.content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : "end_turn";
  }

  return message;
}

/**
 * Wrap a Claude SSE Response as a non-streaming JSON Response.
 *
 * A 200 carrying the message, unless the stream carried an SSE `error` event.
 * Every ComposedHandler parser (openai-responses-sse, openai-sse, gemini-sse,
 * ollama-jsonl, devin-connect, anthropic-sse) emits one from its terminal
 * failure path, and in streaming mode Claude Code discards that message and
 * retries the turn. The non-streamed form now does the same: the Anthropic
 * error body `{type:"error", error:{type, message}}` with the status the
 * Messages API defines for that type (`statusForStreamErrorType`), and the
 * stream-failure marker, so `FallbackHandler` returns it verbatim and never
 * advances a routing chain on it. The status is the one the event declares,
 * not an upstream status claim. An upstream non-ok response never reaches
 * here: ComposedHandler returns those directly without building a stream.
 */
export async function sseResponseToJson(
  sse: Response,
  fallbackModel: string,
  opts: CollectSseOptions = {}
): Promise<Response> {
  const message = await collectSseMessage(sse, fallbackModel, opts);
  if (message.streamError) {
    const { type, message: text } = message.streamError;
    return new Response(JSON.stringify({ type: "error", error: { type, message: text } }), {
      status: statusForStreamErrorType(type),
      headers: streamFailureHeaders(),
    });
  }
  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
