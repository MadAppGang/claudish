import { describe, it, expect, afterEach } from "bun:test";
import {
  withFirstUsefulEventWatchdog,
  firstEventWatchdogWindowMs,
} from "./first-event-watchdog.js";

const encoder = new TextEncoder();

/** A source that emits SSE comments (`: keep-alive`) every `intervalMs`
 *  and never ends on its own — the admitted-with-200-but-mute signature.
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

describe("first-useful-event watchdog", () => {
  const origEnv = process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
    else process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = origEnv;
  });

  it("is inert by default: unset / 0 / negative / garbage → disabled, and the response passes through unwrapped", async () => {
    delete process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
    expect(firstEventWatchdogWindowMs()).toBe(0);
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "0";
    expect(firstEventWatchdogWindowMs()).toBe(0);
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "-5";
    expect(firstEventWatchdogWindowMs()).toBe(0);
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "not-a-number";
    expect(firstEventWatchdogWindowMs()).toBe(0);

    // Unarmed window → same Response object, no wrapper installed.
    const resp = new Response(keepAliveOnlySource(20).body, { status: 200 });
    const wrapped = withFirstUsefulEventWatchdog(resp, "test-model");
    expect(wrapped).toBe(resp);
    await wrapped.body!.cancel();
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
    expect(src.stopped()).toBe(true); // upstream cancelled → connection freed
  });

  it("the guarantee is per-response: a replacement (retried) stream gets its own watchdog after the predecessor's fired", async () => {
    // handleStream wraps every response it serves at one choke point — the
    // original fetch and any replacement from a retry/re-sign path alike.
    // A predecessor wrap that already fired must not leave the replacement
    // unbounded: the wrap is per-response, so the second one arms fresh.
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "200";

    // First attempt: mute-but-200 → watchdog terminates it.
    const first = keepAliveOnlySource(20);
    const firstWrapped = withFirstUsefulEventWatchdog(
      new Response(first.body, { status: 200 }),
      "m"
    );
    const [firstText] = await drain(firstWrapped);
    expect(firstText).not.toContain("data:");
    expect(first.stopped()).toBe(true);

    // Replacement stream (what a retry path re-enters the pipe with): also
    // mute — it must be terminated by ITS OWN watchdog, not ride free on the
    // predecessor's already-fired timer.
    const second = keepAliveOnlySource(20);
    const secondWrapped = withFirstUsefulEventWatchdog(
      new Response(second.body, { status: 200 }),
      "m"
    );
    const [secondText, elapsed] = await drain(secondWrapped);
    expect(secondText).not.toContain("data:");
    expect(elapsed).toBeLessThan(2000);
    expect(second.stopped()).toBe(true);
  });

  it("does not fire when a useful event arrives inside the window, and passes bytes through unchanged", async () => {
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
        controller.enqueue(
          encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
        );
        controller.close();
      },
    });
    const wrapped = withFirstUsefulEventWatchdog(new Response(body, { status: 200 }), "test-model");
    const [text, elapsed] = await drain(wrapped);
    expect(text).toContain('"message_start"');
    expect(text).toContain('"message_stop"');
    expect(text).toContain(": keep-alive"); // byte-for-byte passthrough, comments included
    expect(elapsed).toBeLessThan(3000); // drained normally, no watchdog trip
  });
});
