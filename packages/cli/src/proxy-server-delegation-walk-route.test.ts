/**
 * #609 route pins — a `role:<r>` delegation walks the target's remaining path
 * INSIDE the request when the concrete it resolved to fails.
 *
 * Measured on the hub, 2026-10-22 (MiniMax wall, vLLM engine wedged
 * 22:08→22:25:19Z): a po-2023 haiku session received `[Failover] haiku: every
 * step walled — last: glm-5.3 429`, while five minutes later a haiku probe was
 * served in 545 ms by `role:sonnet → ds@deepseek-flash` — sonnet's own PAYG
 * terminator had been alive the whole time.
 *
 * Mechanism: a delegation resolves ONE concrete per request. A delegated wall
 * of the target's NOMINAL goes through the target's grace/arm semantics, so a
 * first wall does not wall its bucket and re-resolution hands the same
 * concrete back; and a delegating LAST step has no caller step beneath it.
 * The fix serves the next unpaid concrete of the target's path on the same
 * delegating step (resolveDelegationExcluding), bounded by the path's
 * candidate count, writing no state beyond what each failure already writes.
 *
 * Mutation proofs (measured on the PR, cp backup + sha-verified restore):
 *  - the walk never walks (returns false)            ⇒ D1-D5, D7, D8 red
 *  - exclusion keyed per step index, not the request ⇒ D4 red (s0 paid twice)
 *  - the target nominal not excluded once paid       ⇒ D1-D5, D7, D8 red (sn re-paid)
 *  - the last-step "PAYG always serves" offer dropped ⇒ D7 red
 *  - the wiring guard dropped on the last-step branch ⇒ D6 red
 *  - `step.target` not refreshed by the walk         ⇒ D8 red (notice names sn)
 *  - a target step's own exclusion dropped           ⇒ D4 red
 *
 * Same harness contract as proxy-server-wall-surface-route.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { markStepFailed, resetFailoverForTests, setRoleNominalResolver } from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (see the port list in
// proxy-server-wall-surface-route.test.ts; 19917/20017 were free).
const PROXY_PORT = 19917;
const UPSTREAM_PORT = 20017;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR", "CLAUDISH_DEFAULT_PROVIDER",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
let failoverLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realConsoleLog = console.log.bind(console);

/** Per-endpoint answer; anything not listed is healthy. */
let answers: Record<string, () => Response> = {};

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
    chunk({ content: "Hello from the walk." }) +
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

/** Mistral's silent subscription 402 — a quota wall on status alone. */
function quotaWall(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

function rawStatus(status: number): Response {
  return new Response(JSON.stringify({ error: { message: `stub ${status}` } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The role nominals, as the proxy's own resolver injects them (modelMap). */
const NOMINALS = { haiku: "hn-ep@fake-hn", sonnet: "sn-ep@fake-sn" } as Record<string, string>;

/** The incident chain: haiku's LAST step delegates to sonnet, whose own last
 * step is the PAYG terminator. Haiku is config-armed (the request goes straight
 * to its cascade); ARM_AFTER=3 keeps a first delegated wall of sonnet's nominal
 * in GRACE — its bucket is not walled, which is the case where re-resolution
 * hands the same concrete back. */
const BASE_ENV = {
  CLAUDISH_FAILOVER_HAIKU: "h0-ep@fake-h0>role:sonnet",
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>pg-ep@fake-pg",
  CLAUDISH_FAILOVER_ACTIVE: "haiku",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "3",
} as Record<string, string>;

function resetCascade(extra: Record<string, string> = {}): void {
  resetFailoverForTests({ ...BASE_ENV, ...extra });
  setRoleNominalResolver((r) => NOMINALS[r]);
}

async function postHaiku(): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

const walks = () => failoverLog.filter((l) => l.includes("[Failover] DELEGATION-WALK haiku")).length;

beforeEach(() => {
  calls = { hn: 0, h0: 0, ht: 0, sn: 0, s0: 0, pg: 0, native: 0 };
  failoverLog = [];
  answers = {};
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
      customEndpoints: {
        "hn-ep": ep("hn"),
        "h0-ep": ep("h0"),
        "ht-ep": ep("ht"),
        "sn-ep": ep("sn"),
        "s0-ep": ep("s0"),
        "pg-ep": ep("pg"),
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("https://api.anthropic.com")) {
      calls.native += 1;
      return quotaWall();
    }
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 3);
    calls[which] = (calls[which] ?? 0) + 1;
    return (answers[which] ?? healthySSE)();
  }) as typeof fetch;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) if (line.includes("[Failover]")) failoverLog.push(line);
    return realStderrWrite(chunk, ...rest);
  }) as any;
  console.log = ((...args: any[]) => {
    const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    for (const line of text.split("\n")) if (line.includes("[Failover]")) failoverLog.push(line);
    realConsoleLog(...args);
  }) as any;
});

afterEach(async () => {
  (process.stderr as any).write = realStderrWrite;
  console.log = realConsoleLog;
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
    { ...NOMINALS },
    { quiet: true }
  );
}

// ---- the pins -------------------------------------------------------------------

describe("#609 — a role delegation walks the target's remaining path in-request", () => {
  test("D1 (incident shape): the target nominal walls in GRACE on the delegating LAST step → the walk reaches sonnet's PAYG, nothing paid twice", async () => {
    await spin();
    resetCascade();
    answers = { h0: quotaWall, sn: quotaWall, s0: quotaWall };

    const r = await postHaiku();
    // Pre-#609: 429 `every step walled — last: sn-ep@fake-sn` while pg lived.
    expect(r.status).toBe(200);
    expect(calls.h0).toBe(1);
    expect(calls.sn).toBe(1); // the grace-held nominal is never handed back
    expect(calls.s0).toBe(1);
    expect(calls.pg).toBe(1);
    expect(walks()).toBe(2); // sn → s0, s0 → pg — one countable line each
    expect(failoverLog.some((l) => l.includes("WALL-SURFACE"))).toBe(false);
  }, 30_000);

  test("D2: a NON-QUOTA failure of the delegated concrete on the LAST step walks on (it used to surface raw), writing no mark on that step", async () => {
    await spin();
    resetCascade();
    answers = { h0: quotaWall, sn: () => rawStatus(502) };

    const r = await postHaiku();
    expect(r.status).toBe(200); // pre-#609: the raw 502
    expect(calls.sn).toBe(1);
    expect(calls.s0).toBe(1);
    expect(calls.pg).toBe(0);
    // The last step's non-quota contract: nothing is marked on it.
    expect(failoverLog.some((l) => l.includes("step haiku[1]"))).toBe(false);
  }, 30_000);

  test("D3: an INTERMEDIATE delegation walks the target's path before the caller's next step", async () => {
    await spin();
    resetCascade({
      CLAUDISH_FAILOVER_HAIKU: "role:sonnet>ht-ep@fake-ht",
      CLAUDISH_FAILOVER_SONNET: "pg-ep@fake-pg",
    });
    answers = { sn: quotaWall };

    const r = await postHaiku();
    expect(r.status).toBe(200);
    expect(calls.sn).toBe(1);
    expect(calls.pg).toBe(1); // the target's own chain served
    expect(calls.ht).toBe(0); // the caller's tail is never reached
  }, 30_000);

  test("D4: the exclusion is the WHOLE request — a concrete paid on another step is never paid again inside the target's path", async () => {
    await spin();
    // Sonnet's step 0 is the same concrete haiku's step 0 just walled on.
    resetCascade({ CLAUDISH_FAILOVER_HAIKU: "s0-ep@fake-s0>role:sonnet" });
    answers = { s0: quotaWall, sn: quotaWall };

    const r = await postHaiku();
    expect(r.status).toBe(200);
    expect(calls.s0).toBe(1); // THE PIN — a per-step-index exclusion pays it twice
    expect(calls.sn).toBe(1);
    expect(calls.pg).toBe(1);
  }, 30_000);

  test("D5: a target path walled end to end still surfaces the #409 429, naming the last concrete and its status, each candidate paid once", async () => {
    await spin();
    resetCascade();
    answers = { h0: quotaWall, sn: quotaWall, s0: quotaWall, pg: quotaWall };

    const r = await postHaiku();
    expect(r.status).toBe(429);
    const body: any = await r.json();
    expect(body?.error?.type).toBe("rate_limit_error");
    expect(body?.error?.message).toContain("[Failover] haiku: every step walled");
    expect(body?.error?.message).toContain("pg-ep@fake-pg 402:");
    expect(calls.h0).toBe(1);
    expect(calls.sn).toBe(1);
    expect(calls.s0).toBe(1);
    expect(calls.pg).toBe(1);
  }, 30_000);

  test("D6: a WIRING fault of the delegated concrete on the last step surfaces unchanged — no walk hides a mistyped id", async () => {
    await spin();
    resetCascade();
    answers = { h0: quotaWall, sn: () => rawStatus(401) };

    const r = await postHaiku();
    expect(r.status).toBe(401);
    expect(calls.sn).toBe(1);
    expect(calls.s0).toBe(0);
    expect(calls.pg).toBe(0);
    expect(walks()).toBe(0);
  }, 30_000);

  test("D7: with every target step benched, the target's LAST model step is still offered — 'PAYG always serves' holds in-request", async () => {
    await spin();
    resetCascade();
    // Both sonnet steps benched by earlier requests (their TTL binds now).
    markStepFailed("sonnet", 0, "test: s0 benched by an earlier request");
    markStepFailed("sonnet", 1, "test: pg benched by an earlier request");
    answers = { h0: quotaWall, sn: quotaWall };

    const r = await postHaiku();
    expect(r.status).toBe(200);
    expect(calls.sn).toBe(1);
    expect(calls.s0).toBe(0); // benched, not the last: skipped
    expect(calls.pg).toBe(1); // benched, but the last bet
  }, 30_000);

  test("D8: the failover notice names the concrete that actually SERVED, not the one that failed", async () => {
    await spin();
    resetCascade();
    answers = { h0: quotaWall, sn: quotaWall, s0: quotaWall };

    const r = await postHaiku();
    expect(r.status).toBe(200);
    const text = JSON.stringify(await r.json());
    expect(text).toContain("pg-ep@fake-pg");
    expect(text).not.toContain("sn-ep@fake-sn");
  }, 30_000);
});
