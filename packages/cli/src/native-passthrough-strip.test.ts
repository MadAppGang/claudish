/**
 * #282 — route-level pin: the proxy's OWN headers never reach api.anthropic.com.
 *
 * Measured by ai-01 (2026-09-29, fetch stub): the native passthrough forwarded
 * `x-proxy-key` byte-equal, plus `x-claudish-machine` and `x-claudish-hops`
 * (#279), on every native request. The proxy-key swap READS `x-proxy-key` but
 * ignoring is not stripping. `stripProxyOwnHeaders` (native-handler.ts, shared)
 * now runs at BOTH sites — `NativeHandler.handle` and the native `count_tokens`
 * path in proxy-server.ts.
 *
 * This file drives the REAL routes in-process (createProxyServer on a loopback
 * port, same harness contract as proxy-server-openai-notice.test.ts) and
 * asserts on the header NAMES of the outbound fetch the proxy actually makes.
 * Assertions are name-only: no credential value, prefix or length appears here.
 *
 * Mutation proof: remove the strip call at either site ⇒ that site's test goes
 * red while the other stays green (the shared helper keeps the lists from
 * drifting, but each site is pinned on its own).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { resetFailoverForTests } from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// ---- harness -----------------------------------------------------------------

// Distinct range from proxy-server-routing-error.test.ts (19700+) and
// proxy-server-openai-notice.test.ts (19851/19951).
const PROXY_PORT = 19871;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-openai-notice.test.ts: a provisioned
// machine must behave like a bare CI runner. Keys would change resolution and
// CLAUDISH_PROXY_KEY would 401 the request before the route runs.
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

/** Header NAMES of every outbound call to the Anthropic API, in order. */
let anthropicCalls: { url: string; headerNames: string[] }[] = [];

function anthropicJSON(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(REAL_CONFIG_PATH, JSON.stringify({}), "utf-8");
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  anthropicCalls = [];
  // Intercept the proxy→Anthropic leg; the client→proxy leg stays real.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com/")) {
      anthropicCalls.push({
        url,
        headerNames: Object.keys((init?.headers ?? {}) as Record<string, string>),
      });
      if (url.endsWith("/count_tokens")) return anthropicJSON({ input_tokens: 42 });
      return anthropicJSON({
        id: "msg_route_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  if (configBackup !== null) {
    writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  } else if (!configExisted && existsSync(REAL_CONFIG_PATH)) {
    try {
      rmSync(REAL_CONFIG_PATH);
    } catch {}
  }
  configBackup = null;
  configExisted = false;
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetFailoverForTests();
});

/**
 * The fleet-client inbound set: fake OAuth + the proxy's own three headers.
 * The fake token is sk-ant-oat-SHAPED since #296: the native credential guard
 * refuses a non-Anthropic-shaped Bearer, so a realistic shape is what lets
 * this passthrough pin stay exercisable. The shape is fixture dressing — the
 * assertions below are about strip vs passthrough, unchanged.
 */
const INBOUND_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  authorization: "Bearer sk-ant-oat01-fake-client-oauth-route-test",
  "x-proxy-key": "fake-cluster-key-route-test",
  "x-claudish-machine": "myia-fake",
  "x-claudish-hops": "fake-hop-id-route-test",
  // #686 — the attribution pair rides the same `x-claudish-` prefix, so the
  // existing sweep covers it by construction; these two lines pin that the
  // NATIVE lane never leaks what opted-in OpenAI endpoints receive.
  "x-claudish-client": "myia-fake:claudish",
  "x-claudish-workspace": "claudish",
  "anthropic-beta": "interleaved-thinking-2025-05-14",
  "anthropic-version": "2023-06-01",
};

async function spin(): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    { quiet: true }
  );
}

// ---- the pin -------------------------------------------------------------------

describe("#282 — the proxy's own headers never reach api.anthropic.com", () => {
  test("native /v1/messages: OAuth passes through, x-proxy-key + x-claudish-* stripped, client headers kept", async () => {
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: INBOUND_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "ok" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(anthropicCalls.length).toBe(1);
    const names = anthropicCalls[0].headerNames.map((n) => n.toLowerCase());
    // The three proxy-own headers are GONE (x-proxy-key is the credential).
    expect(names).not.toContain("x-proxy-key");
    expect(names).not.toContain("x-claudish-machine");
    expect(names).not.toContain("x-claudish-hops");
    // #686 — the attribution pair falls under the same prefix sweep.
    expect(names).not.toContain("x-claudish-client");
    expect(names).not.toContain("x-claudish-workspace");
    // The client's OAuth survives — that is what makes the subscription work.
    expect(names).toContain("authorization");
    // Negative control: the passthrough exists for a reason — genuine client
    // Anthropic headers still traverse.
    expect(names).toContain("anthropic-beta");
    expect(names).toContain("anthropic-version");
  }, 30_000);

  test("native count_tokens: same strip, same negative control", async () => {
    await spin();
    const res = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages/count_tokens`, {
      method: "POST",
      headers: INBOUND_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "ok" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(anthropicCalls.length).toBe(1);
    expect(anthropicCalls[0].url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    const names = anthropicCalls[0].headerNames.map((n) => n.toLowerCase());
    expect(names).not.toContain("x-proxy-key");
    expect(names).not.toContain("x-claudish-machine");
    expect(names).not.toContain("x-claudish-hops");
    expect(names).not.toContain("x-claudish-client");
    expect(names).not.toContain("x-claudish-workspace");
    expect(names).toContain("authorization");
    expect(names).toContain("anthropic-version");
    const body: any = await res.json();
    expect(body.input_tokens).toBe(42); // the intercepted upstream's answer
  }, 30_000);
});
