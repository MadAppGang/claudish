import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createStreamTracker } from "./stream-registry";

const enc = new TextEncoder();

/** An SSE body that emits `chunks` then closes. */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]!));
      i++;
    },
  });
}

function appWithSse(bodyFactory: () => ReadableStream<Uint8Array>) {
  const tracker = createStreamTracker();
  const app = new Hono();
  app.use("*", tracker.middleware);
  app.get("/health", (c) => c.json({ activeStreams: tracker.getActiveStreams() }));
  app.get("/sse", () =>
    new Response(bodyFactory(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  );
  app.get("/json", (c) => c.json({ ok: true }));
  return { app, tracker };
}

describe("stream tracker", () => {
  test("passes an SSE body through byte-identical", async () => {
    const parts = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const { app } = appWithSse(() => sseBody(parts));
    const res = await app.request("/sse");
    expect(await res.text()).toBe(parts.join(""));
  });

  test("counts a stream while it runs and releases it at close", async () => {
    const { app, tracker } = appWithSse(() => sseBody(["a", "b"]));
    expect(tracker.getActiveStreams()).toBe(0);

    const res = await app.request("/sse");
    const reader = res.body!.getReader();
    await reader.read(); // first chunk pulled → stream is live
    expect(tracker.getActiveStreams()).toBe(1);

    // Drain to completion.
    while (!(await reader.read()).done) {
      /* keep reading */
    }
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("releases the count when the client cancels mid-stream", async () => {
    // The leak that matters: a client that walks away must not pin the counter
    // above zero forever, or the watchdog would drain until its cap on every
    // restart.
    const { app, tracker } = appWithSse(() => sseBody(["a", "b", "c", "d"]));
    const res = await app.request("/sse");
    const reader = res.body!.getReader();
    await reader.read();
    expect(tracker.getActiveStreams()).toBe(1);

    await reader.cancel();
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("releases the count when the upstream body throws mid-stream", async () => {
    // A hub death mid-relay. The wrapper must close cleanly, never error() —
    // otherwise the counting layer becomes a new way for a stream to break.
    let pulls = 0;
    const exploding = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(enc.encode("data: partial\n\n"));
          return;
        }
        throw new Error("socket closed unexpectedly");
      },
    });
    const { app, tracker } = appWithSse(() => exploding);

    const res = await app.request("/sse");
    const text = await res.text(); // must resolve, not reject
    expect(text).toBe("data: partial\n\n");
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("ignores non-SSE responses", async () => {
    const { app, tracker } = appWithSse(() => sseBody(["x"]));
    const res = await app.request("/json");
    expect(await res.json()).toEqual({ ok: true });
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("counts concurrent streams independently", async () => {
    const { app, tracker } = appWithSse(() => sseBody(["a", "b"]));
    const r1 = (await app.request("/sse")).body!.getReader();
    const r2 = (await app.request("/sse")).body!.getReader();
    await r1.read();
    await r2.read();
    expect(tracker.getActiveStreams()).toBe(2);

    await r1.cancel();
    expect(tracker.getActiveStreams()).toBe(1);
    await r2.cancel();
    expect(tracker.getActiveStreams()).toBe(0);
  });

  test("/health reports the live count", async () => {
    const { app } = appWithSse(() => sseBody(["a", "b"]));
    const reader = (await app.request("/sse")).body!.getReader();
    await reader.read();

    const health = await (await app.request("/health")).json();
    expect(health).toEqual({ activeStreams: 1 });

    await reader.cancel();
    const health2 = await (await app.request("/health")).json();
    expect(health2).toEqual({ activeStreams: 0 });
  });
});
