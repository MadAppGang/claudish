/**
 * The ladder as it is actually reached: through `ComposedHandler.handle()`,
 * over a real socket, against a real refused port.
 *
 * Two validation criteria live here and both are demonstrated rather than
 * asserted in the abstract:
 *
 *   C-9  — a client disconnect stops the loop and releases the request within
 *          a second. Reachable because `Request.signal` was measured firing in
 *          0.49–0.86 ms in the HELD shape (handler awaiting, no headers sent).
 *   C-11 — `--probe` and the config TUI's Test All still fail fast. Without the
 *          `x-claudish-no-recovery` guard this feature breaks both tools for
 *          exactly the fault they exist to diagnose, and misreports it as
 *          `timeout` rather than `network error`.
 *
 * C-11 runs through a REAL `Bun.serve` and the REAL `probeLink`, not a
 * simulation of either: the header has to survive an actual HTTP hop for the
 * criterion to mean anything.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { probeLink } from "../providers/probe-live.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { resetRecoveryClock, setRecoveryClock } from "../recovery/clock.js";
import { closeAllEpisodes, episodeCount } from "../recovery/coordinator.js";
import { resetRecoveryFlagOverrides, setRecoveryFlagOverrides } from "../recovery/settings.js";
import {
  capturedRecoveryLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { FakeClock } from "../recovery/test-helpers/fake-clock.js";
import { ComposedHandler } from "./composed-handler.js";
import { classifyConnectionError, markOwnTimeout } from "./shared/connection-error.js";

/** A port nothing is listening on, taken and released so it is VERIFIED free. */
function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

let deadPort: number;

beforeEach(() => {
  deadPort = freePort();
  startLogCapture();
});

afterEach(() => {
  stopLogCapture();
  closeAllEpisodes();
  resetRecoveryClock();
  resetRecoveryFlagOverrides();
});

let seq = 0;
function deadTransport(port: number): ProviderTransport {
  return {
    name: `dead-${++seq}`,
    displayName: "Dead Endpoint",
    streamFormat: "openai-sse",
    getEndpoint: () => `http://127.0.0.1:${port}/v1/chat/completions`,
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

const PAYLOAD = {
  model: "dead-model",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

/** A Hono-shaped Context over a REAL `Request`, so `c.req.raw.signal` is real. */
function contextFor(req: Request): { c: Context; captured: { status?: number; body?: any } } {
  const captured: { status?: number; body?: any } = {};
  const c = {
    req: {
      raw: req,
      header: (name?: string) => (name === undefined ? {} : (req.headers.get(name) ?? undefined)),
    },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) => {
      captured.body = body;
      captured.status = status;
      return new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Context;
  return { c, captured };
}

// ───────────────────────────────────────────────────────────────────────────
// C-9
// ───────────────────────────────────────────────────────────────────────────

describe("C-9 — a client disconnect stops the retry loop within a second", () => {
  test("the held request is released, the episode closed, and no attempt follows", async () => {
    const handler = new ComposedHandler(deadTransport(deadPort), "dead-model", "dead-model", 8080, {
      // no x-claudish-no-recovery header: this request DOES enter the ladder
    });
    const ac = new AbortController();
    const req = new Request("http://127.0.0.1:8080/v1/messages", {
      method: "POST",
      signal: ac.signal,
    });
    const { c } = contextFor(req);

    const started = performance.now();
    const p = handler.handle(c, PAYLOAD);

    // Let the first attempt fail and the ladder park on its 5 s first rung,
    // then go away — the shape of Claude Code being killed mid-outage.
    await new Promise((r) => setTimeout(r, 120));
    expect(episodeCount()).toBe(1);

    const abortedAt = performance.now();
    ac.abort(new DOMException("client gone", "AbortError"));
    const response = await p;
    const releasedAt = performance.now();

    // NFR-2: released promptly, not after the 5 s rung and emphatically not
    // after the 120 s handoff grace, which is for a DELIBERATE tier-2 handoff.
    expect(releasedAt - abortedAt).toBeLessThan(1_000);
    expect(releasedAt - started).toBeLessThan(5_000);
    expect(response.status).toBe(499);

    // The loop exited and the episode released its timer at once.
    expect(episodeCount()).toBe(0);

    const lines = await capturedRecoveryLines();
    expect(lines.some((l) => l.includes("client gone during wait"))).toBe(true);
    expect(lines.some((l) => l.includes("client disconnected after"))).toBe(true);
    // Exactly one attempt was ever made — the one that opened the episode.
    // A second would mean the loop kept running after the client left.
    const attemptLines = lines.filter((l) => /attempt \d+ failed/.test(l));
    expect(attemptLines.length).toBe(1);
  });

  test("a client that is ALREADY gone is answered without entering the ladder at all", async () => {
    const handler = new ComposedHandler(
      deadTransport(deadPort),
      "dead-model",
      "dead-model",
      8080,
      {}
    );
    const ac = new AbortController();
    const req = new Request("http://127.0.0.1:8080/v1/messages", {
      method: "POST",
      signal: ac.signal,
    });
    ac.abort(new DOMException("client gone", "AbortError"));
    const { c } = contextFor(req);

    const started = performance.now();
    const response = await handler.handle(c, PAYLOAD);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(response.status).toBe(499);
    expect(episodeCount()).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C-11
// ───────────────────────────────────────────────────────────────────────────

describe("C-11 — probes still fail fast against a dead endpoint", () => {
  test("the header gate answers connection_error 400 in well under a second", async () => {
    const handler = new ComposedHandler(
      deadTransport(deadPort),
      "dead-model",
      "dead-model",
      8080,
      {}
    );
    const req = new Request("http://127.0.0.1:8080/v1/messages", {
      method: "POST",
      headers: { "x-claudish-no-recovery": "1" },
    });
    const { c, captured } = contextFor(req);

    const started = performance.now();
    await handler.handle(c, PAYLOAD);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
    // Nothing was held: no episode was ever opened.
    expect(episodeCount()).toBe(0);
    const lines = await capturedRecoveryLines();
    expect(lines.some((l) => l.includes("skipped (probe)"))).toBe(true);
  });

  test("REAL probeLink over a REAL socket reports `network-error`, not `timeout`", async () => {
    // The whole hop: probeLink → HTTP → ComposedHandler → the header gate →
    // an immediate connection_error 400 → probe-live's classifier. A
    // simulation of any one of those links would leave the criterion unproven.
    const handler = new ComposedHandler(
      deadTransport(deadPort),
      "dead-model",
      "dead-model",
      8080,
      {}
    );
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const payload = await req.json();
        const { c } = contextFor(req);
        return await handler.handle(c, payload as Record<string, unknown>);
      },
    });

    try {
      const started = performance.now();
      const result = await probeLink(
        `http://127.0.0.1:${proxy.port}`,
        { provider: "dead", modelSpec: "dead@dead-model", hasCredentials: true },
        // Generously long, so "under a second" is a real discrimination: an
        // unguarded ladder would burn this whole budget and then report the
        // probe's own abort as `timeout`.
        8_000
      );
      const elapsed = performance.now() - started;

      expect(result.state).toBe("network-error");
      expect(result.state).not.toBe("timeout");
      expect(elapsed).toBeLessThan(1_000);
      expect(result.errorMessage ?? "").toMatch(/reach|connect|network/i);
      expect(episodeCount()).toBe(0);
    } finally {
      proxy.stop(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The other two skip gates, and the absence of a fourth
// ───────────────────────────────────────────────────────────────────────────

describe("shouldSkipTier1 — three gates, and no loopback carve-out", () => {
  test("the master switch restores today's immediate 400 (RISK-7, the CI escape)", async () => {
    setRecoveryFlagOverrides({ recovery: false });
    const handler = new ComposedHandler(
      deadTransport(deadPort),
      "dead-model",
      "dead-model",
      8080,
      {}
    );
    const req = new Request("http://127.0.0.1:8080/v1/messages", { method: "POST" });
    const { c, captured } = contextFor(req);

    const started = performance.now();
    await handler.handle(c, PAYLOAD);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
    expect(episodeCount()).toBe(0);
    expect(
      (await capturedRecoveryLines()).some((l) => l.includes("skipped (recovery-disabled)"))
    ).toBe(true);
  });

  test("A REFUSED LOOPBACK ADDRESS ENTERS THE LADDER — there is no carve-out", async () => {
    // DEC-1, and this is the assertion that pins it. Two successive designs
    // carved out `refused` + loopback, and each revision of the predicate
    // either fired universally (skipping recovery everywhere) or never. The
    // rule is now general: every classified connection failure enters the
    // ladder regardless of address or UI state.
    setRecoveryFlagOverrides({ recoveryUi: false }); // the old carve-out's key
    const handler = new ComposedHandler(
      deadTransport(deadPort),
      "dead-model",
      "dead-model",
      8080,
      {}
    );
    const ac = new AbortController();
    const req = new Request("http://127.0.0.1:8080/v1/messages", {
      method: "POST",
      signal: ac.signal,
    });
    const { c } = contextFor(req);

    const p = handler.handle(c, PAYLOAD);
    await new Promise((r) => setTimeout(r, 120));

    // 127.0.0.1, refused, recovery UI OFF — and still held.
    expect(episodeCount()).toBe(1);
    const lines = await capturedRecoveryLines();
    expect(lines.some((l) => l.includes("episode") && l.includes("opened for"))).toBe(true);
    expect(lines.some((l) => l.includes("skipped ("))).toBe(false);

    ac.abort(new DOMException("done", "AbortError"));
    await p;
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The transport's own signal, per attempt
// ───────────────────────────────────────────────────────────────────────────

describe("every ladder attempt gets a FRESH transport init", () => {
  /**
   * The defect this pins, in one sentence: `getRequestInit()` was called once,
   * before the primary fetch, and the same object was spread into every
   * re-issue — so a transport that returns a ONE-SHOT `AbortSignal.timeout`
   * (`vertex-oauth.ts` returns a 30-second one) poisoned the whole ladder the
   * moment that signal fired. `AbortSignal.any([fired, live])` is ALREADY
   * ABORTED, so the attempt rejected before it opened a socket.
   *
   * The visible cost was not a slow retry but a FAKE one: tier 1 held the
   * request for the full ~270 s deadline making ZERO real connect attempts,
   * while the `[Recovery]` log and the pane both counted attempts that never
   * left the process.
   *
   * So the assertion is about what the NETWORK saw, and it needs the real
   * runtime: a real `AbortSignal.timeout`, real `fetch`, and a real refused
   * port. A stubbed `globalThis.fetch` cannot fail this test, because the
   * rejection being tested happens inside fetch itself.
   */
  test("a retry after the transport's own signal has fired still reaches the socket", async () => {
    const clock = new FakeClock(0);
    setRecoveryClock(clock);

    // Shorter than the gap the test then waits, so by attempt 2 the FIRST
    // signal minted here is certainly dead.
    const CEILING_MS = 40;
    let initCalls = 0;
    const transport = {
      ...(deadTransport(deadPort) as object),
      getRequestInit: () => {
        initCalls++;
        return { signal: AbortSignal.timeout(CEILING_MS) };
      },
    } as unknown as ProviderTransport;

    const handler = new ComposedHandler(transport, "dead-model", "dead-model", 8080, {});
    const ac = new AbortController();
    const req = new Request("http://127.0.0.1:8080/v1/messages", {
      method: "POST",
      signal: ac.signal,
    });
    const { c } = contextFor(req);
    const p = handler.handle(c, PAYLOAD);

    // Attempt 1 fails on a refused socket and the ladder parks on its 5 s rung.
    // The wait is REAL time and is what kills the first signal.
    await new Promise((r) => setTimeout(r, 150));
    expect(episodeCount()).toBe(1);
    expect(initCalls).toBe(1);

    // Fire the rung. Attempt 2 runs here.
    await clock.advance(5_000);
    await new Promise((r) => setTimeout(r, 150));

    const lines = await capturedRecoveryLines();
    const attempt2 = lines.find((l) => /attempt 2 failed/.test(l)) ?? "";

    // THE ASSERTION. `ConnectionRefused` is the runtime saying it reached the
    // network and the port said no. `TimeoutError` here would mean the attempt
    // was refused by an expired signal without a socket ever being opened —
    // and with a signal whose origin is not ours it is not even classifiable,
    // so the ladder would break out entirely.
    expect(attempt2).toContain("ConnectionRefused");
    expect(attempt2).not.toContain("TimeoutError");
    // Re-minted, not re-used: once for the primary fetch, once per re-issue.
    expect(initCalls).toBeGreaterThanOrEqual(2);

    ac.abort(new DOMException("done", "AbortError"));
    await p.catch(() => {});
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Whose timeout was it?
// ───────────────────────────────────────────────────────────────────────────

describe("a transport's own request timeout is NOT a connection failure", () => {
  /**
   * `TimeoutError` used to mean `unreachable` whatever raised it, and
   * `AbortSignal.timeout` on a transport's INFERENCE request raises exactly
   * that name. So a turn whose time-to-first-byte exceeded the transport's own
   * ceiling — ordinary for a thinking model on a streaming endpoint — was
   * classified as "the host is unreachable", entered the ladder, took the
   * tier-2 handoff, and with the retry watchdog on was re-POSTed ~300 times.
   * Each of those re-POSTs runs ONE MORE REAL BILLED INFERENCE against a host
   * that answered the TCP connect and was already generating.
   *
   * RISK-6 was accepted for `ECONNRESET`/`EPIPE` on a genuine network fault.
   * A latency event is neither a network fault nor transient, and was not
   * priced. The discriminator is therefore the SIGNAL'S ORIGIN, not the name.
   */
  test("a hung upstream that trips the TRANSPORT's ceiling never opens an episode", async () => {
    // A server that accepts the connection and then never answers: the exact
    // shape a slow model presents, and the one a network classifier must not
    // confuse with an unreachable host.
    const hung = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const transport = {
        name: `hung-${Date.now()}`,
        displayName: "Slow Model",
        streamFormat: "openai-sse",
        getEndpoint: () => `http://127.0.0.1:${hung.port}/v1/chat/completions`,
        getHeaders: async () => ({}),
        getRequestInit: () => ({ signal: AbortSignal.timeout(60) }),
      } as unknown as ProviderTransport;

      const handler = new ComposedHandler(transport, "slow-model", "slow-model", 8080, {});
      const ac = new AbortController();
      const req = new Request("http://127.0.0.1:8080/v1/messages", {
        method: "POST",
        signal: ac.signal,
      });
      const { c } = contextFor(req);

      // Raced explicitly rather than simply awaited, because the defect's
      // signature is a HOLD: misclassified, this request parks on the ladder
      // for the full derived deadline (~270 s), which a bare `await` would
      // report as a hung test run rather than as a failure.
      const p = handler.handle(c, PAYLOAD);
      const outcome = await Promise.race([
        p.then(
          () => "resolved" as const,
          (e: unknown) => e
        ),
        new Promise<"still-holding">((r) => setTimeout(() => r("still-holding"), 2_000)),
      ]);

      // Unclassified means rethrown unchanged — the pre-recovery route, which
      // is the whole point. No ladder, no hold, no 300 re-POSTs.
      expect(outcome).not.toBe("still-holding");
      expect(outcome).not.toBe("resolved");
      expect((outcome as Error).name).toBe("TimeoutError");
      expect(episodeCount()).toBe(0);
      expect((await capturedRecoveryLines()).some((l) => l.includes("opened for"))).toBe(false);

      ac.abort(new DOMException("done", "AbortError"));
      await p.catch(() => {});
    } finally {
      hung.stop(true);
    }
  }, 15_000);

  test("but OUR OWN clamp still is one — the ladder can retry what it gave up on", async () => {
    // The other half, and the reason the discriminator cannot simply be "drop
    // TimeoutError": the per-attempt clamp aborts with that same name, and an
    // attempt WE cut short is a failed attempt to be retried, not an error
    // that escapes the ladder. It carries `markOwnTimeout`, so it classifies.
    const clampAbort = markOwnTimeout(new DOMException("attempt cap", "TimeoutError"));
    expect(classifyConnectionError(clampAbort)).toEqual({
      kind: "unreachable",
      code: "TimeoutError",
    });
    // Provoked, not hand-written: this is what a real `AbortSignal.timeout`
    // rejection looks like, and it must NOT classify.
    const hung = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      let raised: unknown;
      try {
        await fetch(`http://127.0.0.1:${hung.port}/`, { signal: AbortSignal.timeout(40) });
      } catch (e) {
        raised = e;
      }
      expect((raised as Error).name).toBe("TimeoutError");
      expect(classifyConnectionError(raised)).toBeNull();
    } finally {
      hung.stop(true);
    }
  });
});
