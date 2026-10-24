/**
 * #619 / #625 route pins — the dwell pin yields BACK to an earlier cascade step
 * once that step is verifiably serving again, and only on evidence that
 * POST-DATES the pin.
 *
 * #619: a session pinned deeper in the cascade (because its own request could
 * not be taken by step 0) used to stay there for as long as it kept talking,
 * even after step 0 came back — the cheap capacity was lost for the whole
 * conversation. `stepRecoveredAt` records the first verified success after a
 * step's mark; past `CLAUDISH_FAILOVER_RECOVERY_GRACE_MS` a later-pinned
 * session yields and re-resolves back onto it.
 *
 * #625 (review): the stamp is evidence about the STEP, not about THIS pin. A
 * session that pins at step 1 AFTER step 0 recovered has no evidence that its
 * own path is better served by step 0 — the stamp predates its pin, so it must
 * not move it. Every yield would otherwise let one recovered step collapse the
 * dwell of every session that pins afterwards.
 *
 * Mutation proofs (remove the guard, exactly its pin goes red):
 *  - d1: delete the `recoveredStepForPin` branch ⇒ R1 red (the session stays on
 *    step 1 after the grace, `ok-from-s1` where `ok-from-s0` is expected).
 *  - d2 (#625): drop the `stamp <= pinnedAt` continue ⇒ R2 red (a session that
 *    pinned after the recovery stamp is yanked back to step 0 — evidence that
 *    predates its pin).
 *  - d3: drop the grace comparison ⇒ R1's in-grace assert red (the pin yields
 *    immediately: `ok-from-s0` inside the grace, where the one-switch-per-dwell
 *    rule holds it on s1).
 *
 * Same hermetic harness contract as proxy-server-step-skip-route.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  getSessionDwellPinForTests,
  markStepFailed,
  resetFailoverForTests,
  resetStepSuccess,
  setRoleNominalResolver,
} from "./fork/failover.js";
import { resetOverflowCapsForTests } from "./handlers/shared/context-overflow.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (20115 used by the
// step-skip suite; 19700+ and 198xx by the older ones).
const PROXY_PORT = 20125;
const UPSTREAM_PORT = 20225;
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
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  // The dwell knobs this suite drives — stripped so a host setting cannot leak.
  "CLAUDISH_FAILOVER_RECOVERY_GRACE_MS",
  "CLAUDISH_FAILOVER_SESSION_DWELL_MS",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
let markerLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realConsoleLog = console.log.bind(console);

/** Minimal healthy openai-wire SSE answer carrying `text`. */
function okSse(text: string, model: string): Response {
  const chunk = (delta: any, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body =
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop") +
    `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":${JSON.stringify(model)}, "choices":[{"index":0,"delta":{},"finish_reason":"stop","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}]}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** The vLLM refusal (verbatim family) — the vehicle for an #431 context skip,
 * which is how a session gets PINNED on a later step in the first place. */
function vllmContextOverflow400(): Response {
  return new Response(
    JSON.stringify({
      object: "error",
      message:
        "This model's maximum context length is 262144 tokens. However, you requested 294816 tokens (294816 in the prompt and 0 in the completion), which exceeds the maximum context length.",
      type: "BadRequestError",
      param: null,
      code: 400,
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

/** Mistral-style quota 402 — arms the role the way the other route tests do. */
function quotaWall402(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

const TWO_STEP = "s0-ep@fake-s0>s1-ep@fake-s1";
const SONNET_NOMINAL = "nom-ep@fake-nom";

/** A short grace so the suite measures the ORDER (in-grace vs past-grace), not
 * a wall-clock budget; the semantics under test are the same at 120 s. */
const GRACE_MS = 150;

function cascadeEnv(steps: string, graceMs = GRACE_MS): Record<string, string> {
  return {
    CLAUDISH_FAILOVER_SONNET: steps,
    CLAUDISH_FAILOVER_AUTO: "1",
    CLAUDISH_FAILOVER_ARM_AFTER: "1",
    CLAUDISH_FAILOVER_RECOVERY_GRACE_MS: String(graceMs),
  };
}

let upstreamAnswer: Record<string, () => Response | Promise<Response>> = {};

function resetCascade(env?: Record<string, string>): void {
  resetFailoverForTests(env ?? cascadeEnv(TWO_STEP));
  const nominals: Record<string, string | undefined> = { sonnet: SONNET_NOMINAL };
  setRoleNominalResolver((r) => nominals[r]);
}

async function postMessage(
  opts: { model?: string; session?: string; content?: string; stream?: boolean } = {}
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-5",
      max_tokens: 64,
      stream: opts.stream ?? false,
      ...(opts.session ? { metadata: { user_id: opts.session } } : {}),
      messages: [{ role: "user", content: opts.content ?? "say hi" }],
    }),
  });
}

async function responseText(r: Response): Promise<string> {
  const body: any = await r.json();
  return (body?.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("");
}

/** An oversized prompt: est ≈ 100k tokens, above no declared window here but
 * refused by the fake upstream — the skip is the upstream's word, not ours. */
const OVERSIZED = `read: ${"x".repeat(400_000)}`;

beforeEach(() => {
  calls = {};
  markerLog = [];
  upstreamAnswer = {};
  resetOverflowCapsForTests();
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
        "nom-ep": ep("nm"),
        "s0-ep": ep("s0"),
        "s1-ep": ep("s1"),
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
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.native = (calls.native ?? 0) + 1;
      return new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "account usage limit" } }),
        { status: 429, headers: { "content-type": "application/json" } }
      );
    }
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const tag = url.slice(UPSTREAM_BASE.length + 1).split("/")[0].slice(0, 2);
    calls[tag] = (calls[tag] ?? 0) + 1;
    const answer = upstreamAnswer[tag];
    if (answer) return answer();
    return okSse(`ok-from-${tag}`, `fake-${tag}`);
  }) as typeof fetch;
  const hook = (text: string) => {
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]")) markerLog.push(line);
    }
  };
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    hook(typeof chunk === "string" ? chunk : String(chunk));
    return realStderrWrite(chunk, ...rest);
  }) as any;
  console.log = ((...args: any[]) => {
    hook(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
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
    { sonnet: SONNET_NOMINAL },
    { quiet: true }
  );
}

/** Drive one session onto step 1: a healthy turn pins it at 0, then the SAME
 * session's oversized turn is refused by step 0 and skipped forward (#431). */
async function pinOnStepOne(session: string, s0: { mode: "ok" | "overflow" }) {
  const r0 = await postMessage({ session });
  expect(r0.status).toBe(200);
  expect(await responseText(r0)).toContain("ok-from-s0");
  expect(getSessionDwellPinForTests("sonnet", session)?.stepIndex).toBe(0);

  s0.mode = "overflow";
  upstreamAnswer.s0 = () => (s0.mode === "ok" ? okSse("ok-from-s0", "fake-s0") : vllmContextOverflow400());
  const r1 = await postMessage({ session, content: OVERSIZED });
  expect(r1.status).toBe(200);
  expect(await responseText(r1)).toContain("ok-from-s1");
  const pin = getSessionDwellPinForTests("sonnet", session);
  expect(pin?.stepIndex).toBe(1);
  expect(pin?.pinnedAt).toBeDefined();
  return pin!;
}

describe("#619 — a dwell pin yields back to a recovered earlier step", () => {
  test("R1: pinned on step 1, step 0 comes back → the grace holds the switch, then the session returns", async () => {
    await spin();
    resetCascade();
    upstreamAnswer.nm = () => quotaWall402();
    const s0 = { mode: "ok" as "ok" | "overflow" };
    upstreamAnswer.s0 = () => (s0.mode === "ok" ? okSse("ok-from-s0", "fake-s0") : vllmContextOverflow400());

    await pinOnStepOne("sess-619", s0);

    // Step 0 is verifiably serving again: a real success on another request
    // (the walk's success hook, inlined — the same two calls it makes).
    markStepFailed("sonnet", 0, "#619 route pin: step 0 had failed before");
    resetStepSuccess("sonnet", 0);
    s0.mode = "ok";

    // Inside the grace the pin HOLDS: one provider switch per dwell, never a
    // ping-pong between a freshly returned step and the one carrying us.
    const r2 = await postMessage({ session: "sess-619" });
    expect(r2.status).toBe(200);
    expect(await responseText(r2)).toContain("ok-from-s1");
    expect(getSessionDwellPinForTests("sonnet", "sess-619")?.stepIndex).toBe(1);

    // Past the grace the session comes back to step 0 — it is no longer
    // punished for a failure it has since survived.
    await new Promise((r) => setTimeout(r, GRACE_MS + 80));
    const r3 = await postMessage({ session: "sess-619" });
    expect(r3.status).toBe(200);
    expect(await responseText(r3)).toContain("ok-from-s0");
    expect(getSessionDwellPinForTests("sonnet", "sess-619")?.stepIndex).toBe(0);
    // The yield really fired on the #619 branch (not a coincidental resolve).
    // The wording is load-bearing: the #431 skip ALSO logs "yielded — step 0",
    // so a looser assert would pass on the skip alone and measure nothing.
    expect(markerLog.some((l) => l.includes("DWELL sonnet") && l.includes("step 0") && l.includes("recovered"))).toBe(true);
  }, 30_000);

  test("R2 (#625): a pin created AFTER the recovery stamp outlives it — evidence must post-date the pin", async () => {
    await spin();
    resetCascade();
    upstreamAnswer.nm = () => quotaWall402();
    const s0 = { mode: "ok" as "ok" | "overflow" };
    upstreamAnswer.s0 = () => (s0.mode === "ok" ? okSse("ok-from-s0", "fake-s0") : vllmContextOverflow400());

    // Step 0 recovers FIRST — the stamp predates every pin below.
    markStepFailed("sonnet", 0, "#625 route pin: step 0 had failed before");
    resetStepSuccess("sonnet", 0);

    // A session that pins on step 1 afterwards (its own oversized request is
    // refused by step 0 — a request-scoped skip, not evidence about its path).
    await pinOnStepOne("sess-625", s0);
    s0.mode = "ok";

    // The reviewer's measured flap (5 follow-up requests, each re-skipping the
    // step it was yielded to). With the ordering guard NONE of them pays that
    // attempt: every one is served by s1, and step 0 sees no new round-trip.
    await new Promise((r) => setTimeout(r, GRACE_MS + 80));
    for (let i = 0; i < 5; i++) {
      const r = await postMessage({ session: "sess-625" });
      expect(r.status).toBe(200);
      expect(await responseText(r)).toContain("ok-from-s1");
      expect(getSessionDwellPinForTests("sonnet", "sess-625")?.stepIndex).toBe(1);
    }
    // Two s0 round-trips for the whole scenario: the healthy turn and the one
    // refusal that created the pin. A flapping pin would add one per follow-up
    // (media would re-send the prompt, context would pay a learned-cap-less
    // 400, busy would pay the full STEP_BUSY_WAIT_MS).
    expect(calls.s0).toBe(2);
    expect(calls.s1).toBe(6); // 1 pinning turn + 5 follow-ups
    // Exactly ONE "skipped" yield in the whole run — the pinning request's.
    expect(
      markerLog.filter((l) => l.includes("DWELL sonnet") && l.includes("skipped for this request")).length
    ).toBe(1);
    expect(
      markerLog.some((l) => l.includes("DWELL sonnet") && l.includes("step 0") && l.includes("recovered"))
    ).toBe(false);

    // The positive direction — pin FIRST, recovery AFTER ⇒ the session does
    // yield — is R1's job. Asserting it here would require a stamp newer than
    // the pin, which is precisely the case the guard must let through; running
    // it twice would measure the same branch twice and invite a flaky margin.
  }, 30_000);
});
