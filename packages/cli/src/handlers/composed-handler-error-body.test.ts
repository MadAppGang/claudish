import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const handlerUrl = pathToFileURL(join(import.meta.dir, "composed-handler.ts")).href;
const fallbackUrl = pathToFileURL(join(import.meta.dir, "fallback-handler.ts")).href;

function errorBodyChild(afterResign: boolean, classified: boolean) {
  return `
    const { ComposedHandler } = await import(${JSON.stringify(handlerUrl)});
    const { FallbackHandler } = await import(${JSON.stringify(fallbackUrl)});
    const afterResign = ${afterResign};
    const classified = ${classified};
    const bodyError = classified
      ? Object.assign(new Error("error body reset"), { code: "ECONNRESET" })
      : { type: "test-body-error", detail: "unchanged object" };
    const signContexts = [];
    const calls = [];
    let meteredRequests = 0;
    const transport = {
      name: "openai-codex",
      displayName: "OpenAI Codex",
      streamFormat: "openai-sse",
      signRequest: async (ctx) => {
        signContexts.push({ ...ctx });
        const account = ctx.forceRefresh ? "fresh" : "stale";
        return {
          arm: "oauth",
          endpoint: "http://upstream.test/" + account,
          headers: { Authorization: "Bearer " + account },
        };
      },
      // v14 rebase: AuthBinding at every consumer and forceRefreshAuth on 401.
      async forceRefreshAuth(ctx) {
        return { auth: await this.signRequest({ ...ctx, forceRefresh: true }) };
      },
      getEndpoint: (_model, binding) => binding.auth.endpoint,
      getHeaders: async (_request, binding) => ({ ...binding.auth.headers }),
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith("http://upstream.test/")) return new Response(null, { status: 404 });
      calls.push({ url, bearer: new Headers(init.headers).get("authorization") });
      if (afterResign && calls.length === 1) {
        return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
      }
      return new Response(new ReadableStream({
        start(controller) { controller.error(bodyError); },
      }), { status: 502 });
    };
    const context = {
      req: { header: () => ({}) },
      header: () => {},
      json: (body, status = 200, headers) => Response.json(body, { status, headers }),
    };
    const handler = new ComposedHandler(transport, "auth-test-model", "auth-test-model", 8080, {});
    const payload = { model: "auth-test-model", max_tokens: 16, messages: [{ role: "user", content: "body read" }] };
    let response;
    let sameError = false;
    if (classified) {
      const chain = new FallbackHandler([
        { name: "OpenAI Codex", provider: "openai-codex", handler },
        { name: "Metered", provider: "openrouter", handler: { handle: async () => {
          meteredRequests++;
          return Response.json({ unexpected: "metered request" });
        } } },
      ]);
      response = await chain.handle(context, payload);
    } else {
      try { response = await handler.handle(context, payload); }
      catch (error) { sameError = error === bodyError; }
    }
    process.stdout.write(JSON.stringify({
      signContexts, calls, meteredRequests, sameError,
      status: response?.status,
      marker: response?.headers.get("x-claudish-connection-error"),
      body: response ? await response.json() : undefined,
    }));
  `;
}

interface BodyReadResult {
  signContexts: Array<{
    forceRefresh?: boolean;
    requireOAuth?: boolean;
    exclude?: unknown[];
    rejected?: { headers: { Authorization?: string } };
    selectionContext?: {
      provider: string;
      failed: Record<string, unknown>;
      leaseFailures: Record<string, unknown>;
      reauthAttempts: Record<string, unknown>;
    };
  }>;
  calls: Array<{ url: string; bearer: string }>;
  meteredRequests: number;
  sameError: boolean;
  status?: number;
  marker?: string;
  body?: { error?: { type?: string; message?: string } };
}

describe("ComposedHandler non-2xx body reads", () => {
  for (const afterResign of [false, true]) {
    for (const classified of [true, false]) {
      test(`${afterResign ? "post-re-sign" : "first-response"} ${classified ? "reset is marked and stops before metered" : "unknown error escapes unchanged"}`, () => {
        const home = mkdtempSync(join(tmpdir(), "claudish-error-body-"));
        try {
          const child = Bun.spawnSync(
            [process.execPath, "--eval", errorBodyChild(afterResign, classified)],
            {
              env: { ...process.env, HOME: home },
              stdout: "pipe",
              stderr: "pipe",
            }
          );
          expect(child.exitCode).toBe(0);
          const result = JSON.parse(new TextDecoder().decode(child.stdout)) as BodyReadResult;
          expect(result.signContexts).toHaveLength(afterResign ? 2 : 1);
          expect(result.signContexts[0]).toMatchObject({ requireOAuth: false });
          expect(result.signContexts[0].forceRefresh).toBeUndefined();
          for (const context of result.signContexts) {
            expect(context.selectionContext).toEqual({
              provider: "openai-codex",
              failed: {},
              leaseFailures: {},
              reauthAttempts: {},
            });
          }
          if (afterResign) {
            expect(result.signContexts[1]).toMatchObject({
              forceRefresh: true,
              requireOAuth: true,
              exclude: [],
              rejected: { headers: { Authorization: "Bearer stale" } },
            });
          }
          expect(result.calls).toEqual(
            afterResign
              ? [
                  { url: "http://upstream.test/stale", bearer: "Bearer stale" },
                  { url: "http://upstream.test/fresh", bearer: "Bearer fresh" },
                ]
              : [{ url: "http://upstream.test/stale", bearer: "Bearer stale" }]
          );
          expect(result.meteredRequests).toBe(0);
          if (classified) {
            expect(result.status).toBe(400);
            expect(result.marker).toBe("1");
            expect(result.body?.error?.type).toBe("connection_error");
            expect(result.body?.error?.message).toContain(afterResign ? "/fresh" : "/stale");
          } else {
            expect(result.sameError).toBe(true);
            expect(result.status).toBeUndefined();
          }
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }
});
