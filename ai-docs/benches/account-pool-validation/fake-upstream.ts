/**
 * Fake Codex upstream for the built-binary pool validation.
 *
 * One `Bun.serve` on 127.0.0.1 answers BOTH the OAuth token host and the Codex
 * responses host, because `CLAUDISH_TEST_UPSTREAM=default=<this origin>` rewrites
 * every known upstream host onto one origin (the metered `api.openai.com` is
 * pointed at the canary instead; see canary.ts).
 *
 * - `POST /oauth/token` takes a JSON body only (`{grant_type, refresh_token}`; a
 *   form-encoded body is not supported) and answers 200 with a JSON object holding a
 *   string `access_token`, a string `refresh_token` and a numeric `expires_in`. It counts exchanges, REVOKES the refresh token it was given
 *   and answers a reuse with `invalid_grant`. That is the only way "exactly one
 *   exchange across N processes" is observable.
 * - `POST /backend-api/codex/responses` classifies each request as `title` or
 *   `main`, logs it (body sha256, bearer, session id) and answers from a
 *   per-row script. A title request never advances the main-turn counter.
 *
 * Every token here is fake. Nothing is persisted outside `logPath` and `bodyDir`.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RequestKind = "main" | "title" | "token" | "models" | "other";

export interface LoggedRequest {
  seq: number;
  at: number;
  method: string;
  path: string;
  kind: RequestKind;
  /** 1-based index among `main` requests only; null for every other kind. */
  mainIndex: number | null;
  bytes: number;
  bodySha256: string;
  bearer: string | null;
  chatgptAccountId: string | null;
  /** `prompt_cache_key` from the body, else the `session_id` header. */
  sessionId: string | null;
  status: number;
  /** Token path only. */
  exchange?: { presented: string; outcome: "ok" | "invalid_grant"; issued?: string };
}

export interface ReplyContext {
  kind: RequestKind;
  mainIndex: number | null;
  bearer: string | null;
  body: string;
  json: unknown;
}

export type Reply =
  | { type: "text"; text: string; usagePercent?: number }
  | { type: "quota"; resetsAt: number }
  | { type: "status"; status: number; body?: unknown; headers?: Record<string, string> };

export type Script = (ctx: ReplyContext) => Reply;

export interface FakeOptions {
  /** JSONL request log, appended one line per request. */
  logPath: string;
  script: Script;
  /**
   * When set, every request body is also written here as `<seq>-<kind>.json`, with seq
   * zero-padded to at least 3 digits (`001-main.json`).
   */
  bodyDir?: string;
  /** Refresh tokens the token endpoint accepts once each. */
  validRefreshTokens?: Iterable<string>;
  /** Overrides {@link classifyResponsesRequest}; a direct row passes `() => "main"`. */
  classify?: (json: unknown) => "main" | "title";
  /** Token endpoint: wait this long before answering, so concurrent exchanges overlap (V2). */
  tokenDelayMs?: number;
  /** Token endpoint: `invalid_grant` answers every exchange as rejected without revoking (V10). */
  tokenMode?: "ok" | "invalid_grant";
}

export interface Fake {
  origin: string;
  port: number;
  requests: LoggedRequest[];
  /** Exchange count at the token path (accepted + rejected). */
  exchanges(): { ok: number; invalidGrant: number };
  /**
   * Every token value this fake issued (access and refresh), in issue order. The leak scan
   * searches for these EXACT values, not for their shape.
   */
  issued(): string[];
  /** Change the token endpoint's answer mode mid-row (V10: reject, then accept). */
  setTokenMode(mode: "ok" | "invalid_grant"): void;
  setTokenDelayMs(ms: number): void;
  stop(): void;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Responses-API SSE for one assistant message (event arrays follow truncated-toolcall/mock-upstream.ts). */
export function responsesSse(text: string): string {
  const response = {
    id: "resp_fake",
    object: "response",
    created_at: 1784050286,
    status: "in_progress",
    background: false,
    completed_at: null,
    error: null,
    incomplete_details: null,
    model: "gpt-fake",
    output: [],
    parallel_tool_calls: true,
    usage: null,
    metadata: {},
  };
  const item = "msg_fake";
  const part = { type: "output_text", annotations: [], logprobs: [], text };
  const events: Array<Record<string, unknown>> = [
    { type: "response.created", response },
    { type: "response.in_progress", response },
    {
      type: "response.output_item.added",
      item: { id: item, type: "message", status: "in_progress", content: [], role: "assistant" },
      output_index: 0,
    },
    {
      type: "response.content_part.added",
      content_index: 0,
      item_id: item,
      output_index: 0,
      part: { ...part, text: "" },
    },
    {
      type: "response.output_text.delta",
      content_index: 0,
      delta: text,
      item_id: item,
      logprobs: [],
      output_index: 0,
    },
    {
      type: "response.output_text.done",
      content_index: 0,
      text,
      item_id: item,
      logprobs: [],
      output_index: 0,
    },
    { type: "response.content_part.done", content_index: 0, item_id: item, output_index: 0, part },
    {
      type: "response.output_item.done",
      item: { id: item, type: "message", status: "completed", content: [part], role: "assistant" },
      output_index: 0,
    },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [
          { id: item, type: "message", status: "completed", content: [part], role: "assistant" },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  return events
    .map(
      (event, i) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: i })}\n\n`
    )
    .join("");
}

/**
 * Title vs main for a session row. Measured (implementation-log.md 3b): Claude
 * Code under `-p` fires NO title request, so every `/responses` request of a `-p`
 * row is main; the rule exists for an interactive or `create_session` row, where
 * Claude Code sends a small structured call with no tools (296 bytes in the
 * direct probe's equivalent) beside the main turn (12 tools, a 5.8 KB
 * `instructions`, 36 KB). A `direct` row has no tools in its body, so it passes
 * `classify: () => "main"`.
 */
export function classifyResponsesRequest(json: unknown): "main" | "title" {
  const body = (json ?? {}) as { tools?: unknown[] };
  return Array.isArray(body.tools) && body.tools.length > 0 ? "main" : "title";
}

export function startFake(opts: FakeOptions): Fake {
  const requests: LoggedRequest[] = [];
  const validRefresh = new Set(opts.validRefreshTokens ?? []);
  const revoked = new Set<string>();
  let mainCount = 0;
  let seqCounter = 0;
  let rotation = 0;
  let tokenMode = opts.tokenMode ?? "ok";
  let tokenDelayMs = opts.tokenDelayMs ?? 0;
  const exchangeTally = { ok: 0, invalidGrant: 0 };
  const issuedValues: string[] = [];
  if (opts.bodyDir) mkdirSync(opts.bodyDir, { recursive: true });

  const record = (entry: LoggedRequest) => {
    requests.push(entry);
    appendFileSync(opts.logPath, `${JSON.stringify(entry)}\n`);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const bearer = req.headers.get("authorization");
      let json: unknown = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      const base = {
        seq: ++seqCounter,
        at: Date.now(),
        method: req.method,
        path: url.pathname,
        bytes: Buffer.byteLength(body),
        bodySha256: sha256(body),
        bearer,
        chatgptAccountId: req.headers.get("chatgpt-account-id"),
        sessionId:
          ((json as { prompt_cache_key?: string } | null)?.prompt_cache_key ?? null) ||
          req.headers.get("session_id") ||
          null,
      };
      const dump = (kind: string) => {
        if (opts.bodyDir) {
          writeFileSync(
            join(opts.bodyDir, `${String(base.seq).padStart(3, "0")}-${kind}.json`),
            body
          );
        }
      };

      if (req.method === "POST" && url.pathname.endsWith("/oauth/token")) {
        const presented = (json as { refresh_token?: string } | null)?.refresh_token ?? "";
        const fresh = tokenMode === "ok" && validRefresh.has(presented) && !revoked.has(presented);
        // Revoke-on-use is atomic: decide, revoke and register the successor
        // before the delay, so a concurrent reuse of this token sees it revoked.
        let issued = "";
        let issuedRotation = 0;
        if (fresh) {
          revoked.add(presented);
          rotation += 1;
          issuedRotation = rotation;
          issued = `rt-rotated-${issuedRotation}`;
          validRefresh.add(issued);
          // Registered before the answer is sent: a value is known before it can leak.
          issuedValues.push(`at-rotated-${issuedRotation}`, issued);
        }
        dump("token");
        if (tokenDelayMs > 0) await Bun.sleep(tokenDelayMs);
        if (fresh) {
          exchangeTally.ok += 1;
          record({
            ...base,
            kind: "token",
            mainIndex: null,
            status: 200,
            exchange: { presented, outcome: "ok", issued },
          });
          return Response.json({
            access_token: `at-rotated-${issuedRotation}`,
            refresh_token: issued,
            expires_in: 3600,
          });
        }
        exchangeTally.invalidGrant += 1;
        record({
          ...base,
          kind: "token",
          mainIndex: null,
          status: 400,
          exchange: { presented, outcome: "invalid_grant" },
        });
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      if (req.method === "POST" && url.pathname.endsWith("/codex/responses")) {
        const kind = (opts.classify ?? classifyResponsesRequest)(json);
        const mainIndex = kind === "main" ? ++mainCount : null;
        dump(kind);
        const reply = opts.script({ kind, mainIndex, bearer, body, json });
        if (reply.type === "quota") {
          record({ ...base, kind, mainIndex, status: 429 });
          return new Response(
            JSON.stringify({
              error: {
                type: "usage_limit_reached",
                message: "You have hit your usage limit",
                resets_at: reply.resetsAt,
              },
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "x-codex-primary-used-percent": "100",
                "x-codex-primary-window-minutes": "300",
                "x-codex-primary-reset-at": String(reply.resetsAt),
              },
            }
          );
        }
        if (reply.type === "status") {
          record({ ...base, kind, mainIndex, status: reply.status });
          return new Response(JSON.stringify(reply.body ?? { error: { message: "scripted" } }), {
            status: reply.status,
            headers: { "content-type": "application/json", ...reply.headers },
          });
        }
        record({ ...base, kind, mainIndex, status: 200 });
        return new Response(responsesSse(reply.text), {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-codex-primary-used-percent": String(reply.usagePercent ?? 20),
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
          },
        });
      }

      const kind: RequestKind = url.pathname.includes("/models") ? "models" : "other";
      dump(kind);
      record({ ...base, kind, mainIndex: null, status: 404 });
      return new Response("not found", { status: 404 });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    requests,
    exchanges: () => ({ ...exchangeTally }),
    issued: () => [...issuedValues],
    setTokenMode: (mode) => {
      tokenMode = mode;
    },
    setTokenDelayMs: (ms) => {
      tokenDelayMs = ms;
    },
    stop: () => server.stop(true),
  };
}
