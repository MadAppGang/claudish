/**
 * The metered canary: a loopback listener registered for `api.openai.com` through
 * `CLAUDISH_TEST_UPSTREAM=api.openai.com=<origin>`. It records every request and
 * answers 500, so contacting the metered path is an observed event, not an
 * absence. Zero requests is a standing assertion on every row except V17.
 */

import { appendFileSync, writeFileSync } from "node:fs";

export interface CanaryHit {
  at: number;
  method: string;
  path: string;
  /** The key the request signed with. Always the fake canary key. */
  authorization: string | null;
}

export interface Canary {
  origin: string;
  hits: CanaryHit[];
  /** Forget every hit and empty the log: used once, after the per-run self-test. */
  reset(): void;
  stop(): void;
}

export function startCanary(logPath: string): Canary {
  const hits: CanaryHit[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.text();
      const hit: CanaryHit = {
        at: Date.now(),
        method: req.method,
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
      };
      hits.push(hit);
      appendFileSync(logPath, `${JSON.stringify(hit)}\n`);
      return Response.json(
        { error: { type: "server_error", message: "CANARY: the metered path was contacted" } },
        { status: 500 }
      );
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    hits,
    reset: () => {
      hits.length = 0;
      writeFileSync(logPath, "");
    },
    stop: () => server.stop(true),
  };
}
