/**
 * #642 — the suppressed-server-tool webReader path must SURFACE what it fetched.
 *
 * Measured defect (main @ 5261b78f): `handleServerToolResult` awaits
 * `executeWebFetch(url)` — declared `Promise<string>` — then branches on
 * `result.ok ? result.text : \`… failed: ${result.error}\``. On a string both
 * `ok` and `error` are `undefined`, so the failure arm fires on EVERY call: the
 * client always receives `[Web fetch for <url> failed: undefined]` and the page
 * that was actually fetched is discarded.
 *
 * These tests drive the real parser (`createAnthropicPassthroughStream`) with a
 * Z.AI-shaped frame sequence (live capture 2026-08-11: the complete input
 * object arrives in `content_block_start`, then start → stop with no deltas)
 * and a stubbed upstream. The fetch is stubbed rather than served: see
 * test-support/stub-fetch.ts (#604 — an in-process Bun.serve is unreachable
 * once a node:http server has lived in the same `bun test` process).
 */

import { afterEach, describe, expect, it } from "bun:test";

import { createAnthropicPassthroughStream } from "./anthropic-sse.js";
import { installStubFetch } from "../../../test-support/stub-fetch.js";

const PAGE_TEXT =
  "Claudish test page. This paragraph exists only to prove the fetched body " +
  "reaches the client instead of being replaced by a failure marker.";

function mockContext() {
  const c: any = {
    req: {},
    body: (stream: ReadableStream, init?: any) => new Response(stream, init),
  };
  return c;
}

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Frames delivered one read at a time; a number stands for a delay (ms) before
 * the next chunk. The gap is load-bearing: the injection is fire-and-forget, so
 * a stream that offers its whole body in one pull can close before the fetch
 * resolves — that would test the race, not the content.
 */
const gappedResponse = (parts: Array<string | number>) => {
  let i = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (i >= parts.length) {
          controller.close();
          return;
        }
        const part = parts[i++];
        if (typeof part === "number") {
          await new Promise((r) => setTimeout(r, part));
          await this.pull!(controller);
          return;
        }
        controller.enqueue(new TextEncoder().encode(part));
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
};

const messageStart = () =>
  frame("message_start", {
    type: "message_start",
    message: {
      id: "msg_642",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });

/** start (input inline) → stop → pause → optional tail. */
const webReaderFrames = (url: string, tail: string[] = []) => [
  messageStart(),
  frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "webReader", input: { url } },
  }),
  frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  60,
  ...tail,
  frame("message_stop", { type: "message_stop" }),
];

const run = async (response: Response): Promise<string> => {
  const text = await createAnthropicPassthroughStream(mockContext(), response, {
    modelName: "test-model",
  }).text();
  return text.replaceAll('event: ping\ndata: {"type":"ping"}\n\n', "");
};

let restore: (() => void) | null = null;
afterEach(() => {
  if (restore) {
    restore();
    restore = null;
  }
});

describe("#642 suppressed webReader surfaces the fetched content", () => {
  it("injects the page text, never the failed-undefined marker", async () => {
    let calls = 0;
    restore = installStubFetch((_req) => {
      calls++;
      return new Response(PAGE_TEXT, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const out = await run(gappedResponse(webReaderFrames("https://example.test/page")));

    expect(calls).toBe(1);
    expect(out).toContain(PAGE_TEXT);
    expect(out).not.toContain("failed: undefined");
  });

  it("on a failed fetch, surfaces the real reason — never undefined", async () => {
    restore = installStubFetch(() => new Response("nope", { status: 500 }));

    const out = await run(gappedResponse(webReaderFrames("https://example.test/broken")));

    expect(out).toContain("HTTP 500");
    expect(out).not.toContain("failed: undefined");
  });

  it("NEGATIVE CONTROL: the run still terminates with message_stop (never-hang holds)", async () => {
    restore = installStubFetch(() => new Response(PAGE_TEXT, { status: 200 }));

    const out = await run(gappedResponse(webReaderFrames("https://example.test/page")));

    expect(out).toContain("event: message_stop");
  });
});
