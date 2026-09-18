import { describe, it, expect, afterEach } from "bun:test";
import {
  withFirstUsefulEventWatchdog,
  boundRetryUpstream,
  firstEventWatchdogWindowMs,
} from "./first-event-watchdog.js";

const encoder = new TextEncoder();

/** A source that emits SSE comments (`: keep-alive`) every `intervalMs`
 *  and never ends on its own — the 14/09 deepseek-flash signature.
 *  Stops when cancelled (the watchdog's job). */
function keepAliveOnlySource(intervalMs: number): {
  body: ReadableStream<Uint8Array>;
  stopped: () => boolean;
} {
  let interval: ReturnType<typeof setInterval> | null = null;
  let stop = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let n = 0;
      interval = setInterval(() => {
        if (stop) return;
        try {
          controller.enqueue(encoder.encode(`: keep-alive-${n++}\n\n`));
        } catch {
          /* consumer gone */
        }
      }, intervalMs);
    },
    cancel() {
      stop = true;
      if (interval) clearInterval(interval);
    },
  });
  return { body, stopped: () => stop };
}

/** Read a Response body to completion; returns [text, elapsedMs]. */
async function drain(resp: Response): Promise<[string, number]> {
  const t0 = Date.now();
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return [out, Date.now() - t0];
}

describe("first-useful-event watchdog (#108)", () => {
  const origEnv = process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
    else process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = origEnv;
  });

  it("closes a keep-alive-only stream at the window, without any data event", async () => {
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "200";
    const src = keepAliveOnlySource(20);
    const wrapped = withFirstUsefulEventWatchdog(
      new Response(src.body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      "test-model"
    );
    const [text, elapsed] = await drain(wrapped);
    expect(text).not.toContain("data:");
    expect(elapsed).toBeLessThan(2000); // closed ~200ms, not held open indefinitely
    expect(src.stopped()).toBe(true); // upstream cancelled → hub slot freed
  });

  it("does not fire when a useful event arrives inside the window", async () => {
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "600";
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // comments first (the mute phase), then the first real event
        await new Promise((r) => setTimeout(r, 60));
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        await new Promise((r) => setTimeout(r, 60));
        controller.enqueue(
          encoder.encode(`event: message_start\ndata: {"type":"message_start","message":{}}\n\n`)
        );
        controller.enqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
        controller.close();
      },
    });
    const wrapped = withFirstUsefulEventWatchdog(
      new Response(body, { status: 200 }),
      "test-model"
    );
    const [text, elapsed] = await drain(wrapped);
    expect(text).toContain('"message_start"');
    expect(text).toContain('"message_stop"');
    expect(elapsed).toBeLessThan(3000); // drained normally, no watchdog trip
  });

  it("is inert when CLAUDISH_FIRST_EVENT_TIMEOUT_MS=0", async () => {
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "0";
    const src = keepAliveOnlySource(20);
    const wrapped = withFirstUsefulEventWatchdog(new Response(src.body, { status: 200 }), "m");
    const reader = wrapped.body!.getReader();
    // Read past what a live watchdog window would have been (300ms > any trip)
    const deadline = Date.now() + 350;
    let sawDone = false;
    while (Date.now() < deadline) {
      const { done } = await Promise.race([
        reader.read(),
        new Promise<{ done: boolean }>((r) => setTimeout(() => r({ done: false }), 100)),
      ]);
      if (done) {
        sawDone = true;
        break;
      }
    }
    expect(sawDone).toBe(false); // still streaming — watchdog disabled
    await reader.cancel();
  });

  it("window parsing: absent → 300s default, 0 → off, garbage → default", () => {
    delete process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
    expect(firstEventWatchdogWindowMs()).toBe(300_000);
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "0";
    expect(firstEventWatchdogWindowMs()).toBe(0);
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "1500";
    expect(firstEventWatchdogWindowMs()).toBe(1500);
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "not-a-number";
    expect(firstEventWatchdogWindowMs()).toBe(300_000);
  });
});

describe("boundRetryUpstream — the retried stream carries its own watchdog (#65 review)", () => {
  // The original wrap has already disarmed when a retry fires (the triggering
  // in-stream error chunk is a `data:` line), so the replacement stream must
  // bring its own bound — a mute-but-200 replacement upstream hung the client
  // indefinitely before this (measured by the coordinator's probe: control A
  // terminated, B — the bare retry stream — did not, same window in force).
  const origEnv = process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
    else process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = origEnv;
  });

  it("a mute-but-200 retried upstream is terminated at the window, not held open", async () => {
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "200";
    const src = keepAliveOnlySource(20);
    const retry = boundRetryUpstream(
      async () =>
        new Response(src.body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      "test-model"
    );
    const resp = (await retry())!;
    const [text, elapsed] = await drain(resp);
    expect(text).not.toContain("data:");
    expect(elapsed).toBeLessThan(2000);
    expect(src.stopped()).toBe(true);
  });

  it("a non-ok retry response passes through unwrapped (identity), for the caller to surface", async () => {
    const err500 = new Response("upstream boom", { status: 500 });
    const retry = boundRetryUpstream(async () => err500, "test-model");
    const resp = await retry();
    expect(resp).toBe(err500); // same object — no watchdog wrapper added
  });

  it("a healthy retried upstream streams through unchanged", async () => {
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "600";
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: {"type":"message_start"}\n\n`));
        controller.enqueue(encoder.encode(`data: {"type":"message_stop"}\n\n`));
        controller.close();
      },
    });
    const retry = boundRetryUpstream(
      async () => new Response(body, { status: 200 }),
      "test-model"
    );
    const resp = (await retry())!;
    const [text] = await drain(resp);
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");
  });
});
