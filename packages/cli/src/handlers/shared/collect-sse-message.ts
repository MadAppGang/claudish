/**
 * Collect a translated Claude-format SSE stream into a single Anthropic
 * `message` object for non-streaming clients.
 *
 * Why this exists: ComposedHandler always drives the upstream provider in
 * streaming mode (every adapter's buildPayload hardcodes `stream: true`) and
 * the whole translation pipeline emits Claude SSE. But a client that sent
 * `stream: false` (notably Claude Code's `/compact`, and any non-streaming
 * Anthropic API caller) expects a JSON `message` body with
 * `Content-Type: application/json`, NOT `text/event-stream`. Returning SSE to
 * such a client surfaces as `"API returned an empty or malformed response
 * (HTTP 200)"`. This collector buffers the already-translated SSE and rebuilds
 * the single message, so the existing pipeline (all stream formats, web-tool
 * interception, empty-response classification) is reused verbatim.
 *
 * HARD constraint (never-hang priority): this function NEVER throws. A broken
 * or empty stream degrades to a well-formed message with an empty text block,
 * so the client always receives valid JSON and the agent never stalls.
 */

export interface CollectedMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: any[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: Record<string, any>;
}

interface BlockAccum {
  type: string;
  text?: string;
  json?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
}

/**
 * Read a Claude-format SSE Response body and assemble the equivalent
 * non-streaming Anthropic message. Always resolves (never rejects).
 */
export async function collectAnthropicSseToMessage(
  response: Response,
  fallbackModel: string
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

  const blocks = new Map<number, BlockAccum>();
  const getBlock = (idx: number): BlockAccum => {
    let b = blocks.get(idx);
    if (!b) {
      b = { type: "text", text: "" };
      blocks.set(idx, b);
    }
    return b;
  };

  try {
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;
          let evt: any;
          try {
            evt = JSON.parse(dataStr);
          } catch {
            continue;
          }
          switch (evt?.type) {
            case "message_start": {
              const m = evt.message;
              if (m) {
                if (m.id) message.id = m.id;
                if (m.model) message.model = m.model;
                if (m.role) message.role = m.role;
                if (m.usage) message.usage = { ...message.usage, ...m.usage };
              }
              break;
            }
            case "content_block_start": {
              const idx = evt.index ?? 0;
              const cb = evt.content_block || {};
              if (cb.type === "tool_use") {
                blocks.set(idx, { type: "tool_use", id: cb.id, name: cb.name, json: "" });
              } else if (cb.type === "thinking") {
                blocks.set(idx, {
                  type: "thinking",
                  thinking: cb.thinking || "",
                  signature: cb.signature,
                });
              } else if (cb.type === "text") {
                blocks.set(idx, { type: "text", text: cb.text || "" });
              } else {
                blocks.set(idx, { type: cb.type || "text", text: cb.text || "" });
              }
              break;
            }
            case "content_block_delta": {
              const idx = evt.index ?? 0;
              const b = getBlock(idx);
              const d = evt.delta || {};
              if (d.type === "text_delta") b.text = (b.text || "") + (d.text || "");
              else if (d.type === "input_json_delta") b.json = (b.json || "") + (d.partial_json || "");
              else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + (d.thinking || "");
              else if (d.type === "signature_delta")
                b.signature = (b.signature || "") + (d.signature || "");
              break;
            }
            case "message_delta": {
              if (evt.delta) {
                if (evt.delta.stop_reason !== undefined) message.stop_reason = evt.delta.stop_reason;
                if (evt.delta.stop_sequence !== undefined)
                  message.stop_sequence = evt.delta.stop_sequence;
              }
              if (evt.usage) message.usage = { ...message.usage, ...evt.usage };
              break;
            }
            // content_block_stop / message_stop / ping carry no payload we need.
            default:
              break;
          }
        }
      }
    }
  } catch {
    // Never throw — fall through and emit whatever we accumulated.
  }

  // Assemble content blocks in ascending index order.
  const content: any[] = [];
  for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
    const b = blocks.get(idx)!;
    if (b.type === "text") {
      if (b.text) content.push({ type: "text", text: b.text });
    } else if (b.type === "thinking") {
      const block: any = { type: "thinking", thinking: b.thinking || "" };
      if (b.signature) block.signature = b.signature;
      content.push(block);
    } else if (b.type === "tool_use") {
      let input: any = {};
      if (b.json) {
        try {
          input = JSON.parse(b.json);
        } catch {
          input = {};
        }
      }
      content.push({ type: "tool_use", id: b.id, name: b.name, input });
    }
  }

  // A well-formed message must always carry at least one content block.
  if (content.length === 0) content.push({ type: "text", text: "" });
  message.content = content;

  if (message.stop_reason == null) {
    message.stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  }

  return message;
}
