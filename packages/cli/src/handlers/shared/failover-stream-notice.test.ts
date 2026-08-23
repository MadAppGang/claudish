import { describe, test, expect } from "bun:test";
import { prependNoticeToAnthropicStream } from "./failover-stream-notice.js";
import { resetFailoverForTests, consumeStreamNotice } from "../../fork/failover.js";

const NOTICE = "[claudish] You are a budget substitute.";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function drain(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

// A minimal text-only Anthropic SSE stream (one text block at index 0).
const TEXT_STREAM = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", content: [] } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

// A text + tool_use stream (two blocks, indices 0 and 1).
const TOOL_STREAM = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m2", content: [] } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "get_weather", input: {} } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

describe("prependNoticeToAnthropicStream", () => {
  test("prepends notice at index 0 and shifts the text block to index 1", async () => {
    const out = await drain(prependNoticeToAnthropicStream(streamFrom(TEXT_STREAM), NOTICE));

    // Notice text is present, exactly once.
    expect(out.match(new RegExp(NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);

    // The original "Hello" delta now carries index 1, not 0.
    const helloLine = out
      .split("\n")
      .find((l) => l.includes("text_delta") && l.includes("Hello"));
    expect(helloLine).toBeTruthy();
    expect(helloLine!).toContain('"index":1');

    // The notice's own delta carries index 0.
    const noticeDelta = out
      .split("\n")
      .find((l) => l.includes("text_delta") && l.includes(NOTICE));
    expect(noticeDelta).toBeTruthy();
    expect(noticeDelta!).toContain('"index":0');

    // Ordering: notice block appears before the (shifted) original text block.
    expect(out.indexOf(NOTICE)).toBeLessThan(out.indexOf("Hello"));

    // message_stop still terminates the stream.
    expect(out).toContain('"type":"message_stop"');
  });

  test("shifts tool_use stream: text→1, tool_use→2, input_json_delta→2", async () => {
    const out = await drain(prependNoticeToAnthropicStream(streamFrom(TOOL_STREAM), NOTICE));

    // Original text block (now index 1).
    const textDelta = out.split("\n").find((l) => l.includes('"Let me check."'));
    expect(textDelta!).toContain('"index":1');

    // tool_use start shifted to index 2.
    const toolStart = out.split("\n").find((l) => l.includes("tool_use") && l.includes("get_weather"));
    expect(toolStart!).toContain('"index":2');

    // input_json_delta shifted to index 2.
    const jsonDelta = out.split("\n").find((l) => l.includes("input_json_delta"));
    expect(jsonDelta!).toContain('"index":2');

    // stop_reason preserved.
    expect(out).toContain('"stop_reason":"tool_use"');
  });

  test("no content blocks → no notice injected (passthrough)", async () => {
    const onlyMeta = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { content: [] } })}\n\n` +
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    const out = await drain(prependNoticeToAnthropicStream(streamFrom(onlyMeta), NOTICE));
    expect(out).not.toContain(NOTICE);
    expect(out).toContain('"type":"message_stop"');
  });

  test("notice emitted exactly once even with many blocks", async () => {
    const out = await drain(prependNoticeToAnthropicStream(streamFrom(TOOL_STREAM), NOTICE));
    const occurrences = out.split(NOTICE).length - 1;
    expect(occurrences).toBe(1);
  });

  test("handles a stream delivered byte-by-byte (split mid-frame)", async () => {
    // Feed the TEXT_STREAM one byte at a time to exercise the line buffer.
    const enc = new TextEncoder();
    const bytes = enc.encode(TEXT_STREAM);
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(new Uint8Array([b]));
        controller.close();
      },
    });
    const out = await drain(prependNoticeToAnthropicStream(chunked, NOTICE));
    expect(out).toContain(NOTICE);
    expect(out).toContain('"index":1'); // shifted text block
    expect(out).toContain('"index":0'); // notice block
  });

  test("never throws on malformed JSON data line — passthrough", async () => {
    const malformed =
      `event: content_block_start\ndata: {not valid json\n\n` +
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    // Should not reject; the malformed event is passed through, notice not injected
    // (we couldn't identify it as a content_block via JSON).
    const out = await drain(prependNoticeToAnthropicStream(streamFrom(malformed), NOTICE));
    expect(out).toContain("{not valid json");
    expect(out).toContain('"type":"message_stop"');
  });
});

describe("consumeStreamNotice", () => {
  test("armed opus: first call returns the notice, second is a no-op (dedup per session)", () => {
    resetFailoverForTests({
      CLAUDISH_FAILOVER_OPUS: "qwen-token-plan@qwen3.8-max",
      CLAUDISH_FAILOVER_OPUS_LABEL: "Qwen 3.8 Max",
      CLAUDISH_FAILOVER_OPUS_DIRECTION: "degraded",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
    });
    const sid = "992df400-056a-4a71-b813-3b3f0728425e";
    const first = consumeStreamNotice("opus", sid);
    const second = consumeStreamNotice("opus", sid);
    expect(first).toBeTruthy();
    expect(first).toContain("Qwen 3.8 Max");
    expect(first).toContain("conservative"); // degraded → risk-reduction wording
    expect(second).toBeNull();
  });

  test("different sessions each get the notice once", () => {
    resetFailoverForTests({
      CLAUDISH_FAILOVER_OPUS: "qwen@qwen3.8-max",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
    });
    expect(consumeStreamNotice("opus", "sess-A")).toBeTruthy();
    expect(consumeStreamNotice("opus", "sess-B")).toBeTruthy();
    expect(consumeStreamNotice("opus", "sess-A")).toBeNull();
  });

  test("null sessionKey → null (can't dedup, so skip rather than spam)", () => {
    resetFailoverForTests({
      CLAUDISH_FAILOVER_OPUS: "qwen@qwen3.8-max",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
    });
    expect(consumeStreamNotice("opus", null)).toBeNull();
  });

  test("role not under failover → null", () => {
    resetFailoverForTests({
      CLAUDISH_FAILOVER_OPUS: "qwen@qwen3.8-max",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
    });
    expect(consumeStreamNotice("sonnet", "sess-X")).toBeNull();
  });

  test("improved direction does not use the risk-reduction wording", () => {
    resetFailoverForTests({
      CLAUDISH_FAILOVER_HAIKU: "deepseek@deepseek-v4-flash",
      CLAUDISH_FAILOVER_HAIKU_LABEL: "DeepSeek v4 Flash",
      CLAUDISH_FAILOVER_HAIKU_DIRECTION: "improved",
      CLAUDISH_FAILOVER_ACTIVE: "haiku",
    });
    const n = consumeStreamNotice("haiku", "sess-H");
    expect(n).toBeTruthy();
    expect(n).toContain("stronger than the nominal model");
    expect(n).not.toContain("conservative");
  });

  test("TTL disarm clears the notified set so a re-arm re-notifies", () => {
    resetFailoverForTests({
      CLAUDISH_FAILOVER_SONNET: "ds@deepseek-v4-flash",
      CLAUDISH_FAILOVER_AUTO: "1",
    });
    // Arm reactively (AUTO path), then confirm dedup, then simulate disarm by
    // clearing state and re-arming — the session should be notifiable again.
    // We exercise this through the public surface: auto-arm, consume, disarm via
    // TTL by advancing the clock is covered in failover.test.ts; here we verify
    // that after a reset+re-arm the same session gets a notice again.
    // (resetFailoverForTests clears notifiedSessions — see failover.ts.)
    const sid = "sess-TTL";
    // First arm + consume.
    resetFailoverForTests({
      CLAUDISH_FAILOVER_SONNET: "ds@deepseek-v4-flash",
      CLAUDISH_FAILOVER_SONNET_DIRECTION: "lateral",
      CLAUDISH_FAILOVER_AUTO: "1",
    });
    // No public arm by config here; emulate an auto-arm via armFailover by
    // importing it lazily to keep the surface tight.
    const { armFailover } = require("../../fork/failover.js");
    expect(armFailover("sonnet", "test wall")).toBe(true);
    expect(consumeStreamNotice("sonnet", sid)).toBeTruthy();
    expect(consumeStreamNotice("sonnet", sid)).toBeNull();
    // After a full reset (simulating a new episode), the session is notifiable again.
    resetFailoverForTests({
      CLAUDISH_FAILOVER_SONNET: "ds@deepseek-v4-flash",
      CLAUDISH_FAILOVER_AUTO: "1",
    });
    expect(armFailover("sonnet", "test wall 2")).toBe(true);
    expect(consumeStreamNotice("sonnet", sid)).toBeTruthy();
  });
});

resetFailoverForTests();
