/**
 * #548 — route-level pin: a malformed body is a terminal 400 on all three
 * JSON ingresses: /v1/messages, /v1/messages/count_tokens and
 * /v1/chat/completions.
 *
 * Before: readRequestBody() / c.req.json() threw a SyntaxError inside each
 * route's try, the catches mapped only RoutingError to 400, and everything
 * else became a retryable 500 (logged as a server error, counted by relays
 * as `hub HTTP 500`). ai-01's review of #550 reproduced the 500 on BOTH other
 * routes — the original PR body's "already answers 400" claim was untested.
 *
 * Mutation proof: drop the parse/shape guard at the top of any one route =>
 * that route's empty / non-JSON / non-object cases go red (500), while its
 * valid-body case stays green (the guard must not touch a well-formed
 * request). No upstream is ever reached on the 400 paths (fetch counter 0).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProxyServer } from "./proxy-server.js";
import { resetFailoverForTests } from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

const PROXY_PORT = 19931;

const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let upstreamCalls = 0;

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  authorization: "Bearer sk-ant-oat01-fake-client-oauth-malformed-body-test",
  "anthropic-version": "2023-06-01",
};

async function postTo(path: string, body: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: "POST",
    headers: HEADERS,
    body,
  });
}

async function post(body: string): Promise<Response> {
  return postTo("/v1/messages", body);
}

beforeEach(async () => {
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  upstreamCalls = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com/")) {
      upstreamCalls++;
      return new Response(
        JSON.stringify({
          id: "msg_malformed_fixture",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
  activeProxy = await createProxyServer(PROXY_PORT, undefined, undefined, false, undefined, undefined, {
    quiet: true,
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetFailoverForTests();
});

describe("#548 — malformed /v1/messages body is a terminal 400", () => {
  for (const [label, raw] of [
    ["empty body", ""],
    ["non-JSON body", "not json {"],
    ["JSON array", "[1,2,3]"],
    ["JSON null", "null"],
    ["JSON string", '"hello"'],
  ] as const) {
    test(`${label} -> 400 invalid_request_error, no upstream call`, async () => {
      const res = await post(raw);
      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.type).toBe("error");
      expect(json.error.type).toBe("invalid_request_error");
      expect(upstreamCalls).toBe(0);
    });
  }

  test("a well-formed body still flows (the guard does not touch valid requests)", async () => {
    const res = await post(
      JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "ok" }] })
    );
    expect(res.status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });
});

describe("#548 — malformed /v1/messages/count_tokens body is a terminal 400", () => {
  for (const [label, raw] of [
    ["empty body", ""],
    ["non-JSON body", "not json {"],
    ["JSON array", "[1,2,3]"],
    ["JSON null", "null"],
    ["JSON string", '"hello"'],
  ] as const) {
    test(`${label} -> 400 invalid_request_error, no upstream call`, async () => {
      const res = await postTo("/v1/messages/count_tokens", raw);
      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.type).toBe("error");
      expect(json.error.type).toBe("invalid_request_error");
      // Distinguishes the body guard from the route's later missing-model 400
      // (an equivalent-mutant escape without this pin: array/null/string would
      // still answer 400, just with the wrong reason).
      expect(json.error.message).toMatch(/^Invalid request body/);
      expect(upstreamCalls).toBe(0);
    });
  }

  test("a well-formed body still flows (the guard does not touch valid requests)", async () => {
    const res = await postTo(
      "/v1/messages/count_tokens",
      JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "ok" }] })
    );
    expect(res.status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });
});

describe("#548 — malformed /v1/chat/completions body is a terminal 400", () => {
  for (const [label, raw] of [
    ["empty body", ""],
    ["non-JSON body", "not json {"],
    ["JSON array", "[1,2,3]"],
    ["JSON null", "null"],
    ["JSON string", '"hello"'],
  ] as const) {
    test(`${label} -> 400 OpenAI invalid_request_error, no upstream call`, async () => {
      const res = await postTo("/v1/chat/completions", raw);
      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.error.type).toBe("invalid_request_error");
      // Same equivalent-mutant pin as count_tokens: without the body guard the
      // array/null/string shapes fall through to the missing-model 400.
      expect(json.error.message).toMatch(/^Invalid request body/);
      expect(upstreamCalls).toBe(0);
    });
  }

  test("a well-formed body still flows (the guard does not touch valid requests)", async () => {
    const res = await postTo(
      "/v1/chat/completions",
      JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "ok" }] })
    );
    expect(res.status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });
});
