/**
 * #317 — route-level pins for the session budget ceiling. Review of #454 (CR,
 * 14/10): the wiring sites were written but pinned only at module level — the
 * coordinator's mutation (admission removed from `/v1/messages`) ran 102/102
 * green, so nothing proved the ROUTE carries the counter. These tests drive
 * the real proxy over HTTP, exactly like proxy-server-overload-walk-route:
 * every site the feature has in proxy-server.ts is now red under its own
 * mutation.
 *
 * Mutation table (one row per wiring site — each was run):
 *  - drop the `/v1/messages` admission (the block after `extractSessionKey`)
 *    ⇒ B1 red at `expect(r3.status).toBe(429)` (the request goes upstream);
 *  - drop the `/v1/chat/completions` admission ⇒ B3 red (200 from the
 *    translated ingress instead of the 429 envelope);
 *  - hardcode `machineHeader = null` ⇒ B7 red (both machines land in one
 *    counter, R3 refuses at 800 ≥ 700);
 *  - remove `openSessionBudgetAttempt` before the LOOP's `handler.handle`
 *    ⇒ B2a red at `expect(consumed).toBe(350)` (the armed cascade's second
 *    attempt — the one that SERVED — is never counted);
 *  - remove `openSessionBudgetAttempt` before the WALK's `walkHandler.handle`
 *    ⇒ B2b stays GREEN, by construction (measured): a nominal that walks
 *    (529/503/400-connection_error) carries NO usage chunk, so the stale
 *    nominal token still counts the walk's report — nothing is lost. The
 *    site's real protection is slot DISTINCTNESS when both attempts pay,
 *    which the wire cannot produce on the walk path; that is pinned at
 *    module level (session-budget.test.ts "pin 2b": same raw, re-attached
 *    between two paid attempts ⇒ sum, not max — red under the token-reuse
 *    mutation);
 *  - neutralize the ComposedHandler sink (`recordSessionBudgetOutput` call in
 *    `onTokenUpdate`) ⇒ B1/B2a/B2b/B3 red (consumed stays 0, nothing ever
 *    refuses);
 *  - remove the NativeHandler SSE line scan ⇒ B4 red (consumed stays 0);
 *  - remove the NativeHandler JSON branch tap ⇒ B5 red (consumed stays 0).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  isQuotaExhaustion,
  resetFailoverForTests,
  setRoleNominalResolver,
} from "./fork/failover.js";
import {
  resetSessionBudgetForTests,
  sessionBudgetConsumed,
} from "./fork/session-budget.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883, 19895/19995).
const PROXY_PORT = 19907;
const UPSTREAM_PORT = 20007;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-overload-walk-route.test.ts —
// plus the two #317 knobs, which MUST be cleared between tests or a leftover
// ceiling leaks into every later test on this port.
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_FAILOVER_OVERLOAD_WALK", "CLAUDISH_FAILOVER_WALK_BUDGET_MS",
  "CLAUDISH_FAILOVER_SONNET", "CLAUDISH_FAILOVER_OPUS",
  "CLAUDISH_FAILOVER_HAIKU",
  "CLAUDISH_FAILOVER_AUTO", "CLAUDISH_FAILOVER_ARM_AFTER",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_SESSION_BUDGET_CEILING", "CLAUDISH_SESSION_BUDGET_WARN",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
/** Completion tokens each fake endpoint reports in its terminal usage chunk. */
let endpointCompletion: Record<string, number> = {};
/** The nm endpoint's status — 529 by default (the overload shape B2b walks
 *  on); tests that want a healthy or quota-walled nominal override it. */
let nmStatus = 529;
/** Completion tokens the native stub reports (SSE and JSON variants). */
let nativeCompletion = 333;

function usageSSE(completionTokens: number, promptTokens = 10): Response {
  const chunk = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "fake-c" };
  const sse =
    chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }) +
    chunk({ ...base, choices: [{ index: 0, delta: { content: "Hello." } }] }) +
    chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    chunk({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }) +
    "data: [DONE]\n\n";
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

/** Anthropic-shaped SSE for the native lane: usage rides message_delta, where
 *  the NativeHandler's line scan reads it. */
function anthropicSSE(outputTokens: number): Response {
  const frame = (event: string, data: any) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const sse =
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake", type: "message", role: "assistant", content: [],
        model: "claude-sonnet-5", stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    }) +
    frame("content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: "Hello native." },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 20, output_tokens: outputTokens },
    }) +
    frame("message_stop", { type: "message_stop" });
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

/** Anthropic-shaped JSON for the native lane's stream:false branch. */
function anthropicJSON(outputTokens: number): Response {
  return new Response(
    JSON.stringify({
      id: "msg_fake", type: "message", role: "assistant",
      content: [{ type: "text", text: "Hello native." }],
      model: "claude-sonnet-5", stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: outputTokens },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/** 402 quota wall on the nominal (drives the armed cascade of B2a). */
function quotaWall(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** MiniMax-shaped 529 (drives the #299-B walk of B2b). */
function overload529(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", code: "2064", message: "The server cluster is currently under high load" },
    }),
    { status: 529, headers: { "content-type": "application/json" } }
  );
}

const SONNET_NOMINAL = "nom-ep@fake-nom";

function writeTestConfig(): void {
  const ep = (name: string) => ({
    kind: "simple",
    url: `${UPSTREAM_BASE}/${name}/v1`,
    format: "openai",
    apiKey: "test-key",
  });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: { "nom-ep": ep("nm"), "s0-ep": ep("s0"), "s1-ep": ep("s1") },
    }),
    "utf-8"
  );
}

interface PostOpts {
  session?: string;
  machine?: string;
  stream?: boolean;
  nativeKey?: string;
}

async function postMessage(
  model: string,
  o: PostOpts = {}
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(o.machine ? { "x-claudish-machine": o.machine } : {}),
      ...(o.nativeKey ? { "x-api-key": o.nativeKey } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: o.stream ?? false,
      // The #91 p4 seam the budget keys on: metadata.user_id (string form).
      ...(o.session ? { metadata: { user_id: o.session } } : {}),
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

/** The OpenAI-compatible ingress, same session via the `user` field (the
 *  converter maps it onto metadata.user_id — openai-request-to-anthropic.ts). */
async function postChatCompletions(session: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 64,
      user: session,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0, native: 0 };
  endpointCompletion = {};
  nmStatus = 529;
  nativeCompletion = 333;
  resetSessionBudgetForTests();
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeTestConfig();
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.native = (calls.native ?? 0) + 1;
      // The native stub's shape follows the request's `stream` flag.
      const isStream = String(init?.body ?? "").includes('"stream":true') ||
        String(init?.body ?? "").includes('"stream": true');
      return isStream ? anthropicSSE(nativeCompletion) : anthropicJSON(nativeCompletion);
    }
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 3);
    calls[which] = (calls[which] ?? 0) + 1;
    if (which === "nm") {
      if (nmStatus === 402) return quotaWall();
      if (nmStatus === 529) return overload529();
      return usageSSE(endpointCompletion.nm ?? 350);
    }
    return usageSSE(endpointCompletion[which] ?? 350);
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
  resetSessionBudgetForTests();
  resetFailoverForTests();
});

/** Default spin: sonnet → nom-ep (the fake custom endpoint). */
async function spin(map?: Record<string, string>): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    map ?? { sonnet: SONNET_NOMINAL },
    { quiet: true }
  );
}

const totalUpstreamCalls = () => (calls.nm ?? 0) + (calls.s0 ?? 0) + (calls.s1 ?? 0) + (calls.native ?? 0);

describe("#317 — session budget ceiling wired through the route", () => {
  test("B1: over the ceiling → local 429 + retry-after, quota-word-free, ZERO upstream fetch", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    endpointCompletion.nm = 400;
    nmStatus = 200; // healthy nominal, serves with usage

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r1.status).toBe(200);
    const r2 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r2.status).toBe(200);
    expect(sessionBudgetConsumed(null, "sess-alpha")).toBe(800);

    const fetchesBefore = totalUpstreamCalls();
    const r3 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r3.status).toBe(429);
    const body = await r3.text();
    expect(body).toContain("[SessionBudgetCeiling]");
    // The wording contract at ROUTE level: the rendered body must never arm
    // the budget failover off our own ceiling.
    expect(isQuotaExhaustion(429, body)).toBe(false);
    const retryAfter = Number(r3.headers.get("retry-after"));
    expect(Number.isFinite(retryAfter) && retryAfter > 0).toBe(true);
    // THE wiring pin: a refused request pays NOTHING upstream.
    expect(totalUpstreamCalls()).toBe(fetchesBefore);
  }, 30_000);

  test("B2a: an ARMED cascade's two attempts through the route — the SERVING step's usage is counted", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    resetFailoverForTests({
      CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0",
      CLAUDISH_FAILOVER_AUTO: "1",
      CLAUDISH_FAILOVER_ARM_AFTER: "1",
    });
    setRoleNominalResolver(() => SONNET_NOMINAL);
    nmStatus = 402; // nominal: quota wall → arm → loop continues to the step
    endpointCompletion.s0 = 350;

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-casc" });
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1); // the second PAID attempt, a different handler
    // The loop-site token re-attach is what makes this non-zero: without it
    // the serving attempt's usage lands in a slot nobody reads.
    expect(sessionBudgetConsumed(null, "sess-casc")).toBe(350);
  }, 30_000);

  test("B2b: a #299-B WALK attempt through the route — its usage is counted too", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    resetFailoverForTests({ CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0" });
    setRoleNominalResolver(() => SONNET_NOMINAL);
    // nm answers 529 by default (the stub's nominal default) → one-shot walk.
    endpointCompletion.s0 = 350;

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-walk" });
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1); // the walk's single attempt
    expect(sessionBudgetConsumed(null, "sess-walk")).toBe(350);
  }, 30_000);

  test("B3: the OpenAI ingress refuses in its OWN envelope (error.message, rate_limit_error)", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    nmStatus = 200;
    endpointCompletion.nm = 750;

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-oai" });
    expect(r1.status).toBe(200);
    expect(sessionBudgetConsumed(null, "sess-oai")).toBe(750);

    const fetchesBefore = totalUpstreamCalls();
    const r2 = await postChatCompletions("sess-oai");
    expect(r2.status).toBe(429);
    const envelope = (await r2.json()) as any;
    expect(envelope.error?.type).toBe("rate_limit_error");
    expect(envelope.error?.code).toBeNull();
    expect(envelope.error?.message).toContain("[SessionBudgetCeiling]");
    expect(Number(r2.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(totalUpstreamCalls()).toBe(fetchesBefore); // translated ingress refused pre-upstream too
  }, 30_000);

  test("B4: native lane SSE tap — message_delta's output_tokens reaches the counter", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "300";
    await spin({}); // EMPTY modelMap → bare claude-sonnet-5 is native
    nativeCompletion = 333;

    const r1 = await postMessage("claude-sonnet-5", {
      session: "sess-nat", stream: true, nativeKey: "sk-ant-test-budget",
    });
    expect(r1.status).toBe(200);
    expect(calls.native).toBe(1);
    expect(sessionBudgetConsumed(null, "sess-nat")).toBe(333);

    // Second request on the same session: refused locally, native untouched.
    const r2 = await postMessage("claude-sonnet-5", {
      session: "sess-nat", nativeKey: "sk-ant-test-budget",
    });
    expect(r2.status).toBe(429);
    expect(calls.native).toBe(1);
  }, 30_000);

  test("B5: native lane JSON branch tap (stream:false) — usage.output_tokens reaches the counter", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "400";
    await spin({});
    nativeCompletion = 290;

    const r1 = await postMessage("claude-sonnet-5", {
      session: "sess-natj", nativeKey: "sk-ant-test-budget",
    });
    expect(r1.status).toBe(200);
    expect(calls.native).toBe(1);
    expect(sessionBudgetConsumed(null, "sess-natj")).toBe(290);
  }, 30_000);

  test("B6: a DIFFERENT session serves while the first is walled (key isolation)", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    nmStatus = 200;
    endpointCompletion.nm = 750;

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r1.status).toBe(200);
    const r2 = await postMessage("claude-sonnet-5", { session: "sess-alpha" });
    expect(r2.status).toBe(429);

    const r3 = await postMessage("claude-sonnet-5", { session: "sess-beta" });
    expect(r3.status).toBe(200); // the counter is per-session, not global
    expect(sessionBudgetConsumed(null, "sess-beta")).toBe(750);
  }, 30_000);

  test("B7: the machine header is the OTHER half of the key — two machines, two counters", async () => {
    process.env.CLAUDISH_SESSION_BUDGET_CEILING = "700";
    await spin();
    nmStatus = 200;
    endpointCompletion.nm = 500;

    const r1 = await postMessage("claude-sonnet-5", { session: "sess-m", machine: "m-one" });
    expect(r1.status).toBe(200);
    endpointCompletion.nm = 300;
    const r2 = await postMessage("claude-sonnet-5", { session: "sess-m", machine: "m-two" });
    expect(r2.status).toBe(200);

    // Distinct counters. If machineHeader were hardcoded null, both attempts
    // would share one key (500+300=800 ≥ 700) and r3 would REFUSE — that is
    // exactly the mutation this pin kills.
    expect(sessionBudgetConsumed("m-one", "sess-m")).toBe(500);
    expect(sessionBudgetConsumed("m-two", "sess-m")).toBe(300);
    endpointCompletion.nm = 100;
    const r3 = await postMessage("claude-sonnet-5", { session: "sess-m", machine: "m-one" });
    expect(r3.status).toBe(200); // 500 < 700 on ITS counter
    expect(sessionBudgetConsumed("m-one", "sess-m")).toBe(600);
  }, 30_000);
});
