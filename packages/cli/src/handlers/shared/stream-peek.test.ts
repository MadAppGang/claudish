import { describe, test, expect } from "bun:test";
import { peekStreamStart } from "./stream-peek.js";

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ch of chunks) controller.enqueue(encoder.encode(ch));
      controller.close();
    },
  });
  return new Response(stream as any, { status });
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const MESSAGE_START =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"glm-5.1","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
const CONTENT =
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n';

describe("peekStreamStart", () => {
  test("classifies a message_start as healthy and hands the FULL stream downstream", async () => {
    const res = sseResponse([MESSAGE_START + CONTENT]);
    const peeked = await peekStreamStart(res);

    expect(peeked.cls).toBe("healthy");
    // branch B must carry the entire stream — prefix included — not just what
    // came after the peek.
    const body = await readAll(peeked.response);
    expect(body).toContain("message_start");
    expect(body).toContain("Hello");
  });

  test("reads past leading ping/comment lines before deciding healthy", async () => {
    const res = sseResponse(['event: ping\ndata: {"type":"ping"}\n\n', MESSAGE_START + CONTENT]);
    const peeked = await peekStreamStart(res);

    expect(peeked.cls).toBe("healthy");
    const body = await readAll(peeked.response);
    expect(body).toContain("ping");
    expect(body).toContain("Hello");
  });

  test("classifies a [1302] start-of-stream error as rate-limit", async () => {
    const res = sseResponse([
      'event: error\ndata: {"error":{"code":"1302","message":"Your account has reached its rate limit"}}\n\n',
    ]);
    const peeked = await peekStreamStart(res);

    expect(peeked.cls).toBe("rate-limit");
    expect(peeked.detail).toContain("rate limit");
  });

  test("classifies a non-rate-limit in-stream error as other-error and still hands the stream downstream", async () => {
    const res = sseResponse([
      'event: error\ndata: {"error":{"code":"5000","message":"internal boom"}}\n\n',
    ]);
    const peeked = await peekStreamStart(res);

    expect(peeked.cls).toBe("other-error");
    expect(peeked.detail).toContain("internal boom");
    // other-error flows to the parser (its graceful finalizer surfaces it).
    const body = await readAll(peeked.response);
    expect(body).toContain("internal boom");
  });

  test("fails open (healthy) when the response has no body", async () => {
    const res = new Response(null, { status: 200 });
    const peeked = await peekStreamStart(res);

    expect(peeked.cls).toBe("healthy");
    expect(peeked.response).toBe(res); // original, untouched
  });
});
