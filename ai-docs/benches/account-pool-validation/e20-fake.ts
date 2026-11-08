/**
 * Recording upstream for E20 parity. Unlike `fake-upstream.ts` (which logs a
 * request's identity fields), this keeps EVERY header and the raw body of every
 * request, because E20 compares the two binaries' requests field by field.
 *
 * One listener stands in for the OAuth token host and the Codex responses host
 * (`CLAUDISH_TEST_UPSTREAM=default=<origin>`); a second listener is the metered
 * canary for `api.openai.com`. Both answer from a fixed per-case script, so the
 * two binaries see byte-identical replies. Every token is fake.
 */

import { responsesSse } from "./fake-upstream.ts";

export interface Recorded {
  seq: number;
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string;
}

export type ResponsesReply =
  | { type: "text"; text: string }
  | { type: "status"; status: number; body: unknown };
export type TokenMode = "ok" | "invalid_grant";

export interface RecordingFake {
  origin: string;
  requests: Recorded[];
  stop(): void;
}

async function capture(req: Request, into: Recorded[]): Promise<Recorded> {
  const url = new URL(req.url);
  const entry: Recorded = {
    seq: into.length + 1,
    method: req.method,
    path: url.pathname,
    search: url.search,
    headers: Object.fromEntries(req.headers),
    body: await req.text(),
  };
  into.push(entry);
  return entry;
}

/** The scripted 500 body used by `legacy-error` (rows-contract V16). */
export const SCRIPTED_500 = { error: { type: "server_error", message: "scripted" } };
/** A 400 the terminal-error decision treats as terminal (`legacy-terminal`). */
export const SCRIPTED_400 = { error: { type: "invalid_request_error", message: "scripted" } };

export function startRecordingFake(opts: {
  responses: ResponsesReply;
  tokenMode: TokenMode;
}): RecordingFake {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const entry = await capture(req, requests);
      if (req.method === "POST" && entry.path.endsWith("/oauth/token")) {
        if (opts.tokenMode === "invalid_grant") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({
          access_token: "at-rotated-1",
          refresh_token: "rt-rotated-1",
          expires_in: 3600,
        });
      }
      if (req.method === "POST" && entry.path.endsWith("/codex/responses")) {
        if (opts.responses.type === "status") {
          return new Response(JSON.stringify(opts.responses.body), {
            status: opts.responses.status,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(responsesSse(opts.responses.text), {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-codex-primary-used-percent": "20",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": "1784054000",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/** The metered canary with full capture: answers 500 and keeps headers and body. */
export function startRecordingCanary(): RecordingFake {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await capture(req, requests);
      return Response.json(
        { error: { type: "server_error", message: "CANARY: the metered path was contacted" } },
        { status: 500 }
      );
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
