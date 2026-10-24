/**
 * #630 — `shutdown()` must not wait for a client that cannot receive anything.
 *
 * `server.close()` drops the listening socket immediately, then waits for every
 * connection to END. A half-written request — the shape an agent killed
 * mid-turn leaves behind — never completes, so it is invisible to the stream
 * tracker, yet it holds `close()` open until the kernel or the client gives up.
 * Measured 2026-10-24 on hub po-2025: `shutdown()` resolved at 3046 ms, exactly
 * when the client destroyed its own socket, and a throwaway container carrying
 * one such request took 21 401 ms to stop against 482 ms with no client. With
 * `stop_grace_period: 120s` that is up to two minutes of hub downtime per
 * recreate.
 *
 * THE RULE THIS FILE PINS: shutdown waits only for CONSUMABLE work — a request
 * whose body has fully arrived (`req.complete`) and whose response is not yet
 * written (`!res.writableEnded`). Everything else (headers without a body, an
 * idle keep-alive) earns nothing. Mutant check (run by hand, 2026-10-24):
 * hardcoding the `req.complete` gate to `true` makes the first pin red again —
 * the half-written socket earns the full grace back.
 *
 * The slow upstream of the last pin is synthesized with `installStubFetch`
 * (#593) plus a delay — a real socket here would be a Bun.serve, and every
 * Bun.serve created after a node:http server in the same `bun test` process is
 * unreachable (see test-support/stub-fetch.ts for the measurement).
 */

import { describe, test, expect } from "bun:test";
import net from "node:net";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { installStubFetch } from "./test-support/stub-fetch.js";

const PORT_BASE = 19860;
const CONFIG_PATH = join(homedir(), ".claudish", "config.json");

function nextPort(): number {
  return PORT_BASE + Math.floor(Math.random() * 120);
}

/** A request whose body never arrives: headers promise 500 bytes, 11 are sent. */
function openHalfWrittenRequest(port: number): { socket: net.Socket; closed: () => boolean } {
  let closed = false;
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.write('POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 500\r\n\r\n{"model":');
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => {});
  return { socket, closed: () => closed };
}

describe("#630 shutdown waits only for consumable work", () => {
  // Per the CR: the bound is observable with a LONG grace — 5 s — so a return
  // well under 1 s can only come from the gate refusing to count the socket,
  // never from the grace having elapsed.
  const GRACE_MS = 5000;

  function withGrace<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.CLAUDISH_SHUTDOWN_GRACE_MS;
    process.env.CLAUDISH_SHUTDOWN_GRACE_MS = String(GRACE_MS);
    return fn().finally(() => {
      if (previous === undefined) delete process.env.CLAUDISH_SHUTDOWN_GRACE_MS;
      else process.env.CLAUDISH_SHUTDOWN_GRACE_MS = previous;
    });
  }

  test("a half-written request earns nothing: shutdown() returns at the settle, not the grace", async () => {
    const port = nextPort();
    const proxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, { quiet: true });

    const half = openHalfWrittenRequest(port);
    // Let the connection land and the parser sit on the missing body.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(half.closed()).toBe(false);

    const startedAt = Date.now();
    await withGrace(() => proxy.shutdown());
    const elapsed = Date.now() - startedAt;

    // The client is STILL holding its socket — a fast return can only come
    // from the gate, never from waiting for it. Under the pre-fix path (or the
    // `req.complete → true` mutant) this is red: the socket earns the grace.
    expect(half.closed()).toBe(false);
    expect(elapsed).toBeLessThan(1000);

    half.socket.destroy();
  }, 15_000);

  test("a complete request whose response is in progress IS waited for, up to the grace", async () => {
    // The /compact shape: `stream:false`, body fully received, upstream slow.
    // The endpoint URL is never dialed for real — the stub answers it.
    const port = nextPort();
    const UPSTREAM_DELAY_MS = 1500;
    const realFetch = globalThis.fetch;

    const configExisted = existsSync(CONFIG_PATH);
    const configBackup = configExisted ? readFileSync(CONFIG_PATH, "utf-8") : null;
    const savedProxyKey = process.env.CLAUDISH_PROXY_KEY;
    const savedPreviousKey = process.env.CLAUDISH_PROXY_KEY_PREVIOUS;
    delete process.env.CLAUDISH_PROXY_KEY;
    delete process.env.CLAUDISH_PROXY_KEY_PREVIOUS;
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        customEndpoints: {
          "slow-ep": { kind: "simple", url: "http://127.0.0.1:1/slow/v1", format: "openai", apiKey: "test-key" },
        },
      }),
      "utf-8"
    );

    const restoreFetch = installStubFetch((req) => {
      if (!req.url.startsWith("http://127.0.0.1:1/")) return realFetch(req);
      // SSE shape, as the walk-route tests answer: a `stream:false` client
      // still gets an SSE upstream (the proxy collects it into one message),
      // so a JSON body here would parse as zero events and answer "empty".
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-slow",
          object: "chat.completion.chunk",
          created: 1,
          model: "fake-slow",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`;
      const sse =
        chunk({ role: "assistant", content: "" }) +
        chunk({ content: "slow answer" }) +
        chunk({}, "stop") +
        "data: [DONE]\n\n";
      return new Promise<Response>((resolve) => {
        setTimeout(
          () =>
            resolve(
              new Response(new TextEncoder().encode(sse), {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              })
            ),
          UPSTREAM_DELAY_MS
        );
      });
    });

    try {
      const proxy = await createProxyServer(port, undefined, undefined, false, undefined, { sonnet: "slow-ep@fake-slow" }, { quiet: true });

      const client = realFetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 64,
          stream: false,
          messages: [{ role: "user", content: "say hi" }],
        }),
      });

      // Let headers AND body land — `request` fires on headers alone, but
      // `req.complete` needs the body. The response is now pending upstream.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const startedAt = Date.now();
      await withGrace(() => proxy.shutdown());
      const elapsed = Date.now() - startedAt;

      const resp = await client;
      expect(resp.status).toBe(200);
      const body = await resp.text();
      expect(body).toContain("slow answer");
      // The wait lasted for the RESPONSE, not for the settle bound: shutdown
      // held the stop while consumable work existed, then returned at the
      // finish — well under the grace, far above the 250 ms settle.
      expect(elapsed).toBeGreaterThanOrEqual(UPSTREAM_DELAY_MS - 400);
      expect(elapsed).toBeLessThan(GRACE_MS);
    } finally {
      restoreFetch();
      if (configBackup !== null) writeFileSync(CONFIG_PATH, configBackup, "utf-8");
      else if (!configExisted && existsSync(CONFIG_PATH)) {
        try {
          rmSync(CONFIG_PATH);
        } catch {}
      }
      if (savedProxyKey === undefined) delete process.env.CLAUDISH_PROXY_KEY;
      else process.env.CLAUDISH_PROXY_KEY = savedProxyKey;
      if (savedPreviousKey === undefined) delete process.env.CLAUDISH_PROXY_KEY_PREVIOUS;
      else process.env.CLAUDISH_PROXY_KEY_PREVIOUS = savedPreviousKey;
    }
  }, 20_000);

  test("the listening socket is really closed — fast must not mean 'forgot to stop'", async () => {
    const port = nextPort();
    const proxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, { quiet: true });

    const half = openHalfWrittenRequest(port);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await withGrace(() => proxy.shutdown());

    // A refused connection after shutdown proves close() ran; a listener left
    // behind would keep answering and would also keep the port busy for the
    // replacement container.
    let refused = false;
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    half.socket.destroy();
  }, 15_000);

  test("a second shutdown() call is harmless", async () => {
    const port = nextPort();
    const proxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, { quiet: true });

    await proxy.shutdown();
    // The drain's wrapper and the signal path can both land here; a throw would
    // surface as OUTCOME exception on a deploy that actually succeeded.
    await proxy.shutdown();
    expect(true).toBe(true);
  }, 15_000);
});
