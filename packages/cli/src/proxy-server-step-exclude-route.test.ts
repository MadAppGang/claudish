/**
 * #693 — per-machine step exclusion through the real routes.
 *
 * `CLAUDISH_FAILOVER_STEP_EXCLUDE=<step>:<machine>` subtracts a cascade step
 * for ONE machine's requests while the cascade stays global. Here the haiku
 * role is armed for everyone (the walled-nominal shape), step 0 (`s0`) is
 * excluded for `m-ai01`, so that machine's walk starts at step 1 (`s1` — the
 * role-tail analogue) while every other machine and a machine-blind request
 * keep step 0. The mandate case: ai-01's structural prompts must never land on
 * the local engine when the nominal walls.
 *
 * Same harness contract as proxy-server-machine-arm-route.test.ts.
 *
 * Mutation proof: drop the `machine` argument at the 2a resolution in
 * getHandlerForRequest ⇒ X1 and X3 go red (m-ai01 pays s0 like everyone else).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionDwellPinForTests, resetFailoverForTests } from "./fork/failover.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

const PROXY_PORT = 19886;
const UPSTREAM_PORT = 19986;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same sandbox set as the machine-arm route test, kept compact (split of one
// string) — the machine-arm file spells it line by line. CLAUDISH_PROXY_KEY
// matters most: a dev machine running its own proxy would otherwise 401 every
// header-less test request.
const SANDBOX_ENV_KEYS =
  ("ZAI_API_KEY ZAI_CODING_API_KEY GLM_API_KEY ZHIPU_API_KEY GLM_CODING_API_KEY " +
    "MOONSHOT_API_KEY KIMI_API_KEY KIMI_CODING_API_KEY OPENAI_API_KEY OPENAI_CODEX_API_KEY " +
    "GEMINI_API_KEY OPENROUTER_API_KEY MINIMAX_API_KEY MINIMAX_CODING_API_KEY LITELLM_API_KEY " +
    "POE_API_KEY DEEPSEEK_API_KEY CLAUDE_API_KEY ANTHROPIC_API_KEY CLAUDISH_NO_ANTHROPIC " +
    "CLAUDE_API_KEY ANTHROPIC_API_KEY CLAUDISH_FAILOVER_ACTIVE CLAUDISH_PROXY_KEY " +
    "CLAUDE_API_KEY ANTHROPIC_API_KEY CLAUDISH_PROXY_KEY_PREVIOUS CLAUDISH_CAPTURE_DIR").split(
    /\s+/
  );
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};

function healthySSE(): Response {
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake-c",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  const sse =
    chunk({ role: "assistant", content: "" }) +
    chunk({ content: "Hello." }) +
    chunk({}, "stop") +
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

/** haiku nominal `nm`; cascade s0 (excluded for m-ai01) > s1; armed role-wide. */
const EXCLUDE_ENV = {
  CLAUDISH_FAILOVER_HAIKU: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_HAIKU_LABEL: "Local engine>Role tail",
  CLAUDISH_FAILOVER_HAIKU_DIRECTION: "degraded>improved",
  CLAUDISH_FAILOVER_HAIKU_NOTE: "Step 0 is the engine ai-01 must not draw on.>",
  CLAUDISH_FAILOVER_ACTIVE: "haiku",
  CLAUDISH_FAILOVER_STEP_EXCLUDE: "s0-ep@fake-s0:m-ai01",
} as Record<string, string>;

async function postMessage(
  machine?: string,
  opts: { session?: string; path?: string } = {}
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}${opts.path ?? "/v1/messages"}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(machine ? { "X-Claudish-Machine": machine } : {}),
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
      ...(opts.session ? { metadata: { user_id: opts.session } } : {}),
    }),
  });
}

const messageText = (msg: any): string =>
  (msg?.content ?? []).map((b: any) => (b?.type === "text" ? b.text : "")).join("\n");

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0 };
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ep = (name: string) => ({
    kind: "simple",
    url: `${UPSTREAM_BASE}/${name}/v1`,
    format: "openai",
    apiKey: "test-key",
  });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: { "nm-ep": ep("nm"), "s0-ep": ep("s0"), "s1-ep": ep("s1") },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 3);
    calls[which] = (calls[which] ?? 0) + 1;
    return healthySSE();
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

async function spin(): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    undefined,
    { haiku: "nm-ep@fake-nom" },
    { quiet: true }
  );
  resetFailoverForTests(EXCLUDE_ENV);
}

describe("#693 per-machine step exclusion through the real routes", () => {
  test("X1: the excluded machine's haiku walk starts at step 1 — s0 is never paid", async () => {
    await spin();
    const r = await postMessage("m-ai01");
    expect(r.status).toBe(200);
    expect(calls.s1).toBe(1);
    expect(calls.s0).toBe(0);
    expect(calls.nm).toBe(0); // role-wide arm: the nominal is bypassed for all
    const text = messageText(await r.json());
    // The notice names the step actually served (the wall-arm variant carries
    // no per-step note — the label is the identity proof).
    expect(text).toContain("Role tail");
    expect(text).toContain("s1-ep@fake-s1");
  });

  test("X2: every other machine keeps step 0, and a header-less request too", async () => {
    await spin();
    const other = await postMessage("m-po2023");
    expect(other.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(0);
    const bare = await postMessage();
    expect(bare.status).toBe(200);
    expect(calls.s0).toBe(2); // machine-blind resolution = the global walk
    expect(calls.s1).toBe(0);
    expect(calls.nm).toBe(0);
  });

  test("X3: count_tokens from the excluded machine resolves and pins at step 1", async () => {
    await spin();
    const counted = await postMessage("m-ai01", {
      session: "sess-x3",
      path: "/v1/messages/count_tokens",
    });
    expect(counted.status).toBe(200);
    expect(typeof ((await counted.json()) as any).input_tokens).toBe("number");
    // The counting path threads the machine too: the pin it writes is at the
    // machine's own walk, not the global one.
    expect(getSessionDwellPinForTests("haiku", "sess-x3")).toMatchObject({ stepIndex: 1 });
    expect(calls.s0).toBe(0);
    expect(calls.s1).toBe(0); // counting pays no upstream on this lane

    const served = await postMessage("m-ai01", { session: "sess-x3" });
    expect(served.status).toBe(200);
    expect(calls.s1).toBe(1);
    expect(calls.s0).toBe(0);
  });
});
