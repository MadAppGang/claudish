import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { RequestAuth } from "../auth/credentials/types.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { resetRecoveryClock, setRecoveryClock } from "../recovery/clock.js";
import { closeAllEpisodes } from "../recovery/coordinator.js";
import { resetRecoveryFlagOverrides, setRecoveryFlagOverrides } from "../recovery/settings.js";
import { FakeClock, advanceUntilSettled } from "../recovery/test-helpers/fake-clock.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;
const success = readFileSync(
  join(import.meta.dir, "../test-fixtures/sse-responses/SEED-openai-text-only.sse"),
  "utf8"
);
let clock: FakeClock;
beforeEach(() => {
  clock = new FakeClock();
  setRecoveryClock(clock);
  setRecoveryFlagOverrides({ recovery: true, recoveryUi: false });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  closeAllEpisodes();
  resetRecoveryClock();
  resetRecoveryFlagOverrides();
});
// PROVISIONAL: replace synthetic refusal/auth failures with sanitized request-path captures.
const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const rejected = () =>
  Object.assign(new Error("Codex login rejected; run `claudish login codex`"), {
    terminal: true,
    upstreamStatus: 401,
  });
function auth(id: string): RequestAuth {
  return {
    arm: "oauth",
    endpoint: `http://127.0.0.1:4567/${id}`,
    headers: { Authorization: `Bearer ${id}` },
  };
}
function transport(): ProviderTransport {
  return {
    name: "merge-regression",
    displayName: "Merge Regression",
    streamFormat: "openai-sse",
    signRequest: async () => auth("old"),
    // Rebase resolution: the 401 path uses the same pool-aware signing seam.
    async forceRefreshAuth(ctx) {
      return { auth: await this.signRequest!({ ...ctx, forceRefresh: true }) };
    },
    getEndpoint: (_model, artifact) => artifact?.auth?.endpoint ?? "http://wrong.test",
    getHeaders: async (_payload, artifact) => ({ ...artifact?.auth?.headers }),
  };
}
const payload = {
  model: "regression-model",
  max_tokens: 16,
  messages: [{ role: "user", content: "identity" }],
};
async function run(t: ProviderTransport) {
  const handler = new ComposedHandler(t, payload.model, payload.model, 8080, {});
  const app = new Hono();
  app.post("/", async (c) => handler.handle(c, await c.req.json()));
  return advanceUntilSettled(
    clock,
    Promise.resolve(
      app.request("http://local.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    ),
    100_000
  );
}
function ok() {
  return new Response(success, { headers: { "content-type": "text/event-stream" } });
}
function unauthorized() {
  return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
}

for (const forced of [false, true]) {
  test(`H5/H11: ${forced ? "forced" : "initial"} sign gets the same terminal answer after a ladder refusal`, async () => {
    // Mutation: remove the ladder's unclassified catch at either auth site: Hono returns 500.
    for (const blip of [false, true]) {
      const t = transport();
      let attempts = 0;
      let outbound = 0;
      t.signRequest = async (ctx) => {
        if (forced && !ctx.forceRefresh) return auth("old");
        attempts++;
        if (blip && attempts === 1) throw refused();
        throw rejected();
      };
      globalThis.fetch = (async () => {
        outbound++;
        return unauthorized();
      }) as unknown as typeof fetch;
      const response = await run(t);
      expect(response.status).toBe(400);
      expect(response.headers.get("x-claudish-auth-verdict")).toBe("terminal");
      const body = (await response.json()) as {
        error: { type: string; upstream_status: number; message: string };
      };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.upstream_status).toBe(401);
      expect(body.error.message).toContain("claudish login codex");
      expect(attempts).toBe(blip ? 2 : 1);
      expect(outbound).toBe(forced ? 1 : 0);
    }
  });
}

test("H9: ladder reissues the successful re-sign artifact without another forced exchange", async () => {
  // Mutation: remove reSignedAuth guard, reuse old endpoint/headers, or reserialize different bytes.
  const t = transport();
  const signs: boolean[] = [];
  const calls: Array<{ url: string; bearer: string | null; body: BodyInit | null | undefined }> =
    [];
  t.signRequest = async (ctx) => {
    signs.push(!!ctx.forceRefresh);
    return auth(ctx.forceRefresh ? "new" : "old");
  };
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      bearer: new Headers(init?.headers).get("authorization"),
      body: init?.body,
    });
    if (calls.length === 1) return unauthorized();
    if (calls.length === 2) throw refused();
    return ok();
  }) as unknown as typeof fetch;
  const response = await run(t);
  expect(response.status).toBe(200);
  await response.text();
  expect(signs).toEqual([false, true]);
  expect(calls.map((c) => c.url)).toEqual([
    auth("old").endpoint!,
    auth("new").endpoint!,
    auth("new").endpoint!,
  ]);
  expect(calls.map((c) => c.bearer)).toEqual(["Bearer old", "Bearer new", "Bearer new"]);
  expect(new Set(calls.map((c) => c.body)).size).toBe(1);
});

test("H6: getHeaders recovery receives both original conversation and artifact", async () => {
  // Mutation: recover with getHeaders() or getHeaders(payload) instead of both arguments.
  const t = transport();
  const artifact = auth("identity");
  const args: Array<[unknown, unknown]> = [];
  t.signRequest = async () => artifact;
  t.getHeaders = async (body, signed) => {
    args.push([body, signed]);
    if (args.length === 1) throw refused();
    return {
      ...signed?.auth?.headers,
      "x-conversation": String((body as typeof payload | undefined)?.messages[0]?.content),
    };
  };
  let seen = "";
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    seen = new Headers(init?.headers).get("x-conversation") ?? "";
    return ok();
  }) as unknown as typeof fetch;
  const response = await run(t);
  expect(response.status).toBe(200);
  await response.text();
  expect(args).toHaveLength(2);
  expect(args[1]?.[0]).toBe(args[0]?.[0]);
  expect(args[1]?.[0]).toEqual(payload);
  expect((args[1]?.[1] as { auth?: RequestAuth })?.auth).toBe(artifact);
  expect(seen).toBe("identity");
});
