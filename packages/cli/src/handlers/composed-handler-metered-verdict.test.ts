import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";
import { authVerdict } from "./shared/auth-failure.js";
import { decideHopFailure } from "./shared/hop-decision.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeContext(): Context {
  return {
    req: { header: () => ({}) },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number, headers?: HeadersInit) =>
      new Response(JSON.stringify(body), { status: status ?? 200, headers }),
  } as unknown as Context;
}

/** A metered native API: the api-key arm, a name outside SUBSCRIPTION_PROVIDERS. */
function meteredTransport(): ProviderTransport {
  return {
    name: "metered-verdict-test",
    displayName: "Metered Test",
    streamFormat: "openai-sse",
    signRequest: async () => ({
      arm: "api-key",
      endpoint: "http://upstream.test/v1/chat/completions",
      headers: { Authorization: "Bearer sk-wrong" },
    }),
    getEndpoint: (_model, artifact) => artifact?.auth?.endpoint ?? "http://upstream.test",
    getHeaders: async (_req, artifact) => ({ ...(artifact?.auth?.headers ?? {}) }),
  };
}

async function answerFor(status: number, body: unknown): Promise<Response> {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  const handler = new ComposedHandler(meteredTransport(), "m", "m", 8080, {});
  return handler.handle(makeContext(), {
    model: "m",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });
}

async function hopDecision(res: Response) {
  return decideHopFailure({
    kind: "response",
    status: res.status,
    body: await res.clone().text(),
    name: "Metered Test",
    headers: res.headers,
  });
}

describe("a metered hop's rejected key carries the terminal verdict", () => {
  test("a 403 bad key is answered 400 with the terminal verdict and advances as credential-rejected", async () => {
    const res = await answerFor(403, {
      error: { type: "invalid_api_key", message: "The supplied API key is invalid." },
    });
    expect(res.status).toBe(400);
    expect(authVerdict(res.headers)).toBe("terminal");
    // Without the header the recovered 403 advanced as a plain "retryable"
    // failure, with no notice naming the next hop's billing.
    expect(await hopDecision(res)).toEqual({ action: "advance", reason: "credential-rejected" });
  });

  test("a 401 bad key is answered with the terminal verdict", async () => {
    const res = await answerFor(401, { error: { message: "Invalid API-key provided." } });
    expect(res.status).toBe(400);
    expect(authVerdict(res.headers)).toBe("terminal");
  });

  test("a 403 RegionError is a per-model miss and carries no verdict", async () => {
    const res = await answerFor(403, {
      error: { type: "RegionError", message: "only available hosted in China" },
    });
    expect(authVerdict(res.headers)).toBeUndefined();
  });

  test("a 401 naming an unsupported model is a per-model miss and carries no verdict", async () => {
    const res = await answerFor(401, { error: { message: "Model m is not supported" } });
    expect(authVerdict(res.headers)).toBeUndefined();
  });
});
