/**
 * #274 (review 29/09) — route-level pin of the DELEGATED bookkeeping through
 * the real `handleWithCascade` loop.
 *
 * The coordinator's throwaway probe measured three defects in the proxy-side
 * 38 lines that no unit test could see (they sit in exactly the code no test
 * executed):
 *  - S1: a delegated wall of the TARGET's nominal never armed the target's
 *    bucket (`isRoleNominalServing` compared against the DELEGATING role's
 *    own nominal — never equal), so delegated traffic hammered the walled
 *    nominal until DIRECT target traffic happened to arm it.
 *  - S2: the reverse target→step lookup returned the DELEGATING step itself
 *    (a role-step's `target` is refreshed in place), so the owner was never
 *    marked and a direct request re-paid the walled step.
 *  - S4: the delegating step was marked TWICE off a single failure
 *    (count=1 ttl=10min, then count=2 ttl=30min).
 *
 * This file drives the REAL /v1/messages route in-process (same harness
 * contract as proxy-server-cascade-revisit.test.ts) with a delegation cascade
 * `opus = role:sonnet` on fake custom endpoints, and pins all three.
 *
 * Mutation proof (one per branch — each comment names its branch):
 *  - quota path, `delegation?.owner.nominal` branch: force it to false (or
 *    delete the onNominalRefusal call) ⇒ S1 goes red (bucket never walls,
 *    second opus request re-pays the nominal instead of joining sonnet's
 *    cascade).
 *  - quota path, owner-step branch: delete the markStepFailed(owner…) call ⇒
 *    S2 goes red (s0 called twice by the direct sonnet request).
 *  - S4: re-add a second markStepFailed of the delegating step ⇒ the captured
 *    wall log shows two `opus[0]` lines with count=1 then count=2.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  armFailover,
  classifyNominalBucket,
  isBucketWalled,
  markStepFailed,
  resetFailoverForTests,
  setRoleNominalResolver,
} from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871).
const PROXY_PORT = 19883;
const UPSTREAM_PORT = 19983;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-cascade-revisit.test.ts.
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
let calls: Record<string, number> = {};
/** Wall log lines captured off stderr for the S4 single-increment pin. */
let wallLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

/** `nom` walls by default (S1/S4); `s0` walls by default (S2). Flipped per test. */
let wallEndpoints: Set<string> = new Set(["nom"]);

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
    chunk({ content: "Hello from the cascade." }) +
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

function quotaWall(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** The delegation env: opus = a single role:sonnet step; sonnet walks s0→s1. */
const DELEGATION_ENV = {
  CLAUDISH_FAILOVER_OPUS: "role:sonnet",
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

/** The sonnet nominal, as the proxy's own resolver would inject it. */
const SONNET_NOMINAL = "nom-ep@fake-nom";
const bucketOfNominal = () => {
  const nb = classifyNominalBucket(SONNET_NOMINAL, () => false);
  if (!("bucket" in nb)) throw new Error("route test: custom-endpoint nominal must classify to a bucket");
  return nb.bucket;
};

function resetDelegation(
  extra: Record<string, string> = {},
  nominals: Record<string, string | undefined> = { sonnet: SONNET_NOMINAL }
): void {
  resetFailoverForTests({ ...DELEGATION_ENV, ...extra });
  // resetFailoverForTests clears the injected resolver — re-inject, as
  // createProxyServer does at startup (the proxy owns the modelMap).
  setRoleNominalResolver((r) => nominals[r]);
}

async function postMessage(model: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0, or: 0, mm: 0 };
  wallLog = [];
  wallEndpoints = new Set(["nm"]);
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
        "or-ep": ep("or"),
        // #367: the `--model` default's bucket -- never called, only bucketed.
        "mm-ep": ep("mm"),
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
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 3);
    calls[which] = (calls[which] ?? 0) + 1;
    if (wallEndpoints.has(which)) return quotaWall();
    return healthySSE();
  }) as typeof fetch;
  // Capture the failover wall log (logStderr) without silencing the harness.
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    // All [Failover] lines, not just "walled" ones: the re-review tests pin the
    // RECOVERED line too (a false recovery is the worst regression of the
    // delegated success path).
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]")) wallLog.push(line);
    }
    return realStderrWrite(chunk, ...rest);
  }) as any;
});

afterEach(async () => {
  (process.stderr as any).write = realStderrWrite;
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

async function spin(defaultModel?: string): Promise<void> {
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    defaultModel,
    false,
    undefined,
    undefined,
    { quiet: true }
  );
}

// ---- the pins -------------------------------------------------------------------

describe("#274 review — delegated bookkeeping through the real cascade loop", () => {
  test("S1: a delegated wall of the TARGET's nominal arms the target's bucket; the NEXT opus request joins sonnet's cascade", async () => {
    await spin();
    resetDelegation({ CLAUDISH_FAILOVER_ACTIVE: "opus" });

    // Request 1: opus (config-armed) → its only step is role:sonnet → sonnet
    // is healthy, so the delegation serves sonnet's NOMINAL — which walls.
    // opus[0] is the loop's LAST step, so this request surfaces the 402 (the
    // delegating cascade is 1 step deep; deeper walks happen on the next
    // request's resolution). The pin is what the wall LEFT BEHIND:
    const r1 = await postMessage("claude-opus-5");
    expect(r1.status).toBe(402);
    expect(calls.nm).toBe(1); // paid exactly once

    // THE PIN: the delegated wall went through the TARGET's grace/arm
    // semantics — sonnet's nominal bucket is now walled (never armed by the
    // first cut: isRoleNominalServing could never be true, so EVERY opus
    // request re-paid the walled nominal forever — calls.nm=2 here and the
    // second request below would return 402 too).
    expect(isBucketWalled(bucketOfNominal())).toBe(true);

    // Request 2: the delegation resolves into sonnet's own cascade (s0
    // healthy) instead of hammering the walled nominal.
    wallEndpoints.delete("nm");
    const r2 = await postMessage("claude-opus-5");
    expect(r2.status).toBe(200);
    expect(calls.nm).toBe(1); // never re-paid
    expect(calls.s0).toBe(1); // joined the target's walk
  }, 30_000);

  test("S2: a delegated wall of the TARGET's STEP marks the owning step — a direct sonnet request skips it", async () => {
    await spin();
    resetDelegation({ CLAUDISH_FAILOVER_ACTIVE: "opus,sonnet" });
    // Sonnet's nominal bucket is ALREADY walled: the delegation serves
    // sonnet's step 0 (the shared walk state), and s0 walls.
    armFailover("sonnet", "test: nominal pre-walled", bucketOfNominal());
    wallEndpoints.delete("nm");
    wallEndpoints.add("s0");

    // Request 1 (opus → delegation → sonnet s0): walls, and the OWNER
    // (sonnet[0]) is marked — visible in the wall log as a sonnet[0] line.
    const r1 = await postMessage("claude-opus-5");
    expect(r1.status).toBe(402); // opus[0] is the last step — the wall surfaces
    expect(calls.s0).toBe(1);
    expect(wallLog.some((l) => l.includes("step sonnet[0]") && l.includes("s0-ep@fake-s0"))).toBe(true);

    // Request 2 (DIRECT sonnet): the cascade must skip the s0 that request 1
    // just walled on the owner's side, and land on s1. Without the owner mark
    // (first cut: the reverse lookup found the delegating step back, never
    // sonnet[0]) this request re-pays s0 — calls.s0 becomes 2.
    const r2 = await postMessage("claude-sonnet-5");
    expect(r2.status).toBe(200);
    expect(calls.s0).toBe(1); // paid exactly once, by the delegated request
    expect(calls.s1).toBe(1);
  }, 30_000);

  test("S4: a single delegated failure increments the delegating step exactly once (no 10→30min double rung)", async () => {
    await spin();
    resetDelegation({ CLAUDISH_FAILOVER_ACTIVE: "opus" });

    const r1 = await postMessage("claude-opus-5");
    expect(r1.status).toBe(402);
    expect(calls.nm).toBe(1);

    // THE PIN: exactly ONE wall line for opus[0], at count=1. The first cut
    // marked the delegating step, then the owning lookup found the step
    // ITSELF and marked it again — count=1 ttl=10min followed by count=2
    // ttl=30min off one failure.
    const opusWalls = wallLog.filter((l) => l.includes("step opus[0]"));
    expect(opusWalls.length).toBe(1);
    expect(opusWalls[0]).toContain("count=1");
    expect(opusWalls[0]).not.toContain("count=2");
  }, 30_000);

  test("last-resort shape: target nominal AND full target cascade walled → each walk step is paid once across requests, then the 402 repeats", async () => {
    await spin();
    resetDelegation({ CLAUDISH_FAILOVER_ACTIVE: "opus" });
    // nom, s0 and s1 all wall: each request advances the delegation one step
    // deeper into the target's walk and surfaces the wall; no step is ever
    // re-paid. (This is the review's S1 last-step symptom — legitimate ONLY
    // when nothing healthier remains.)
    wallEndpoints.add("s0");
    wallEndpoints.add("s1");

    const r1 = await postMessage("claude-opus-5");
    expect(r1.status).toBe(402);
    expect(calls.nm).toBe(1);
    const r2 = await postMessage("claude-opus-5");
    expect(r2.status).toBe(402);
    expect(calls.s0).toBe(1);
    const r3 = await postMessage("claude-opus-5");
    expect(r3.status).toBe(402);
    expect(calls.s1).toBe(1);
    // All three attempts were real walls, and the bucket stays armed.
    expect(isBucketWalled(bucketOfNominal())).toBe(true);
  }, 30_000);
});

// ── #331 — the delegating step's TTL binds only its walled CONCRETE ────────────
// The measured freeze (hub po-2025, 2026-10-04): `haiku[1]` = `role:sonnet`
// accumulated 408 walls with its TTL escalated to the 24 h cap, while sonnet's
// own resolution had long advanced — the delegating step's backoff measured ONE
// concrete the delegation happened to serve, and nothing ever re-resolved it.
// The fix threads the failed attempt's CONCRETE into markStepFailed and makes
// the TTL bind only while the delegation keeps resolving there. This pin runs
// the incident through the real cascade loop, hub shape (no nominal resolver:
// the delegation resolves straight into the target's cascade).
describe("#331 — the delegation follows the target's advance, no 24 h freeze", () => {
  test("R1: haiku's role:sonnet step walled on sonnet's s0 → the NEXT request follows sonnet's advance to s1 (not the direct tail)", async () => {
    await spin();
    // haiku: delegation first, a direct PAYG tail behind it (the post-incident
    // mitigation shape). No sonnet nominal: the delegation lands on sonnet[0].
    resetDelegation(
      {
        CLAUDISH_FAILOVER_ACTIVE: "haiku",
        CLAUDISH_FAILOVER_HAIKU: "role:sonnet>or-ep@fake-or",
      },
      {}
    );
    wallEndpoints.add("s0"); // sonnet's s0 walls — the trigger of the incident

    // Request 1: haiku → delegation → sonnet s0 → 402, marked BOTH sides with
    // the concrete. In-request re-resolution: the delegation now resolves s1
    // (sonnet[0] was owner-marked) — with #331 the step is probeable and the
    // loop follows it; pre-#331 the step froze on the s0 wall and the request
    // fell through to the direct tail instead.
    const r1 = await postMessage("claude-haiku-4-5");
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1); // paid exactly once
    expect(calls.s1).toBe(1); // the delegation followed sonnet's advance IN-request
    expect(calls.or).toBe(0); // the direct tail never paid — the freeze never engaged
    // The delegating step's wall line exists (the mark that USED to freeze it).
    expect(wallLog.some((l) => l.includes("step haiku[0]") && l.includes("count=1"))).toBe(true);

    // Request 2: same session-less resolution — the delegation still resolves
    // s1 and serves it; the direct tail stays untouched across requests.
    const r2 = await postMessage("claude-haiku-4-5");
    expect(r2.status).toBe(200);
    expect(calls.s1).toBe(2); // the delegation kept following sonnet's walk
    expect(calls.or).toBe(0); // pre-#331: 2 (every request paid the tail)
  }, 30_000);

  // Review of #331 (06/10) point 2 — the #263 revisit re-mark used to carry
  // NO concrete, so a role-step re-marked on that path bound for its whole
  // backoff (count++ ⇒ up to 24 h) however far the delegation advanced later.
  // The fix passes `{ concrete: attemptConcreteNow }`; this pin exercises the
  // delegation-advance state that fix protects (R1's driver, walked one
  // request further): a role-step marked against the delegation's concrete
  // must NOT keep binding once the delegation serves a different one. The
  // concrete-less mutation re-freezes the step: the delegation is skipped at
  // EVERY later resolution and the direct tail pays instead (calls.or grows).
  // The dedicated revisit drive (a mid-request TTL expiry of the delegation's
  // wall) is NOT pinned: its scheduling is real-clock — said so on the PR.
  test("V1: a role-step marked against the delegation's OLD concrete serves the NEW one once the delegation advanced", async () => {
    await spin();
    resetDelegation(
      {
        CLAUDISH_FAILOVER_ACTIVE: "haiku",
        CLAUDISH_FAILOVER_HAIKU: "role:sonnet>or-ep@fake-or",
      },
      {}
    );
    wallEndpoints.add("s0"); // sonnet's s0 walls — R1's trigger
    // Request 1 = R1's: haiku[0] (role:sonnet) pays s0's wall once — marked
    // BOTH sides WITH the concrete (every mark site now carries it) — and the
    // in-request re-resolution follows the advance: s1 serves.
    const r1 = await postMessage("claude-haiku-4-5");
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1); // paid exactly once
    expect(calls.s1).toBe(1); // the in-request follow
    expect(calls.or).toBe(0);
    expect(wallLog.some((l) => l.includes("step haiku[0]") && l.includes("count=1"))).toBe(true);
    // Request 2 is THE PIN: the delegation sits on s1 ≠ the record's s0, so
    // stepTtlBinds must NOT bind haiku[0] — s1 is served again. Under the
    // pre-fix revisit re-mark (no concrete — T3's shape) the record binds
    // unconditionally: haiku[0] is skipped for its whole backoff and the
    // direct tail pays (calls.or = 1). R1 stops one request earlier, so this
    // is the seam its two-request version cannot reach.
    const r2 = await postMessage("claude-haiku-4-5");
    expect(r2.status).toBe(200);
    expect(calls.s1).toBe(2);
    expect(calls.or).toBe(0);
    // And request 3 keeps it true — a one-request remission would be a dwell
    // artifact, not the binding predicate.
    const r3 = await postMessage("claude-haiku-4-5");
    expect(r3.status).toBe(200);
    expect(calls.s1).toBe(3);
    expect(calls.or).toBe(0);
  }, 30_000);
});

// ---- re-review 01/10: the three unpinned branches --------------------------------
//
// (i) the SUCCESS path of a delegation. The wall path is pinned by S1-S4 above;
//     the success half is the one with the worst failure mode: clearing the
//     DELEGATING role's bucket on a delegated success seeds a false
//     "RECOVERED opus → nominal", flips traffic back onto the still-walled
//     nominal, and can resetAllStepFailures(opus).
//
// (ii) nested delegation — failover.ts:622's recursion must return the
//     TERMINAL role's coordinate as owner, never the intermediate role-step.

describe("#274 re-review — delegated success and nested delegation", () => {
  const bucketOf = (model: string): string => {
    const nb = classifyNominalBucket(model, () => false);
    if (!("bucket" in nb)) throw new Error(`route test: ${model} must classify to a bucket`);
    return nb.bucket;
  };
  const OPUS_NOMINAL = "or-ep@fake-or";

  test("I1: a delegated SUCCESS on the target's nominal does not clear the delegating role's wall nor seed a false RECOVERED", async () => {
    await spin();
    // opus is walled on ITS OWN bucket (or-ep) and config-armed; sonnet is
    // healthy. Every opus request therefore delegates to sonnet's NOMINAL.
    resetDelegation({ CLAUDISH_FAILOVER_ACTIVE: "opus" }, { sonnet: SONNET_NOMINAL, opus: OPUS_NOMINAL });
    armFailover("opus", "test: opus nominal pre-walled", bucketOf(OPUS_NOMINAL));
    wallEndpoints = new Set([]);

    // R1: the delegation serves sonnet's nominal, which answers 200.
    const r1 = await postMessage("claude-opus-5");
    expect(r1.status).toBe(200);
    expect(calls.or).toBe(0); // the walled nominal is never paid
    expect(calls.nm).toBe(1); // the delegated success

    // THE PIN: the success cleared the TARGET's side only. opus never
    // recovered — no RECOVERED line, and its wall still holds.
    expect(wallLog.find((l) => l.includes("RECOVERED opus"))).toBeUndefined();
    expect(isBucketWalled(bucketOf(OPUS_NOMINAL))).toBe(true);

    // Mutation (:1138 → onNominalSuccess(role, bucket)): the success clears
    // the DELEGATING role's bucket instead — servedUnderWall(opus|bucket) was
    // filled by the swap's own resolution, so the mutation logs
    // "RECOVERED opus" here and the first pin above goes red.

    // R2 (control): opus is still walled, so the request delegates again —
    // the walled nominal is still never paid.
    const r2 = await postMessage("claude-opus-5");
    expect(r2.status).toBe(200);
    expect(calls.or).toBe(0);
    expect(calls.nm).toBe(2);
  }, 30_000);

  test("I2: a delegated SUCCESS on the target's STEP exercises the owner-side reset (behavioral pin)", async () => {
    await spin();
    resetDelegation({ CLAUDISH_FAILOVER_ACTIVE: "opus,sonnet" });
    // Target nominal walled + target step 0 already failed: the delegation
    // serves sonnet's step 1 (s1), whose owner coordinate is {sonnet, 1}.
    armFailover("sonnet", "test: nominal pre-walled", bucketOfNominal());
    markStepFailed("sonnet", 0, "test: s0 pre-walled");
    wallEndpoints = new Set([]);

    const r1 = await postMessage("claude-opus-5");
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(0); // skipped by the owner's own walk state
    expect(calls.s1).toBe(1); // the delegated success, on the owner's step

    // A DIRECT sonnet request joins the same walk (s0 skipped), landing on s1.
    const r2 = await postMessage("claude-sonnet-5");
    expect(r2.status).toBe(200);
    expect(calls.s1).toBe(2);
    expect(calls.nm).toBe(0);
    // NOTE (measured, reported on the PR): the mutation
    // resetStepSuccess(owner…) → resetStepSuccess(role, stepIndex) is NOT
    // observable at this layer: a marked step is TTL-failed for 10 min and is
    // only ever served again through the last-step fallback, which by
    // definition has no successor to distinguish a reset from a skip. The
    // owner-half of the success branch is covered here for real (the branch
    // runs), but its mutation pin lives in the unit layer's reasoning, not in
    // a behavioral assert.
  }, 30_000);

  test("N1: a TWO-HOP delegation records the wall on the TERMINAL role's step (haiku → role:opus → role:sonnet → s0)", async () => {
    await spin();
    resetDelegation(
      {
        CLAUDISH_FAILOVER_ACTIVE: "haiku,sonnet",
        CLAUDISH_FAILOVER_HAIKU: "role:opus",
        CLAUDISH_FAILOVER_OPUS: "role:sonnet",
      },
      { sonnet: SONNET_NOMINAL, opus: OPUS_NOMINAL }
    );
    // Both intermediate nominals walled: haiku's only step resolves opus's
    // only step, which resolves sonnet's step 0 — the recursion at
    // failover.ts:622 must hand back sonnet[0] as the owner.
    armFailover("opus", "test: opus nominal pre-walled", bucketOf(OPUS_NOMINAL));
    armFailover("sonnet", "test: sonnet nominal pre-walled", bucketOfNominal());
    wallEndpoints = new Set(["s0"]);

    const r1 = await postMessage("claude-haiku-4-5");
    expect(r1.status).toBe(402); // haiku[0] is the last step — the wall surfaces
    expect(calls.s0).toBe(1);
    expect(calls.or).toBe(0); // never routed through the intermediates' nominals
    expect(calls.nm).toBe(0);

    // THE PIN: the wall was recorded on the TERMINAL owner (sonnet[0]) — the
    // wall log names sonnet[0] and never opus[0].
    expect(wallLog.some((l) => l.includes("step sonnet[0]") && l.includes("s0-ep@fake-s0"))).toBe(true);
    expect(wallLog.some((l) => l.includes("step opus[0]"))).toBe(false);
    // Mutation (failover.ts:622 recursion disabled): the owner comes back as
    // the INTERMEDIATE {opus, 0} — the log names opus[0] and both pins go red.

    // Control: a direct sonnet request now skips the s0 that r1's wall marked.
    wallEndpoints.delete("s0");
    const r2 = await postMessage("claude-sonnet-5");
    expect(r2.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(1);
  }, 30_000);
});

// ── #367 — the owner-side bucket of an ALREADY-CONCRETE delegation target ─────
//
// The delegated bookkeeping computed `ownerBucket` through
// nominalBucketOfModel(delegation.concrete) — which runs the REQUEST-side
// mapping (resolveNominalTarget) FIRST. With a `--model` default configured
// and no proxy modelMap, a keyword-free concrete (the resolver-injected
// nominal `nom-ep@fake-nom`) re-maps onto the DEFAULT model: the refusal
// armed `mm-ep` and the success consumed a pending (sonnet|mm-ep) recovery
// instead of the target's own bucket (`nom-ep`). Same defect class as the
// #348 walk bucketer (W19): the target is already concrete — classify it,
// don't re-map it. RED under nominalBucketOfModel-as-bucketer.
describe("#367 — owner-side buckets of concrete delegation targets", () => {
  // The shape both pins share: NO proxy modelMap, a `--model` default on
  // mm-ep@fake-mm, and the delegation target = the resolver's sonnet nominal
  // (nom-ep@fake-nom, keyword-free). Buggy nominalBucketOfModel maps it to
  // mm-ep; the concrete bucket is nom-ep.
  test("B1: a delegated REFUSAL arms the target's OWN bucket (nom-ep), not the --model default's (mm-ep)", async () => {
    await spin("mm-ep@fake-mm");
    resetDelegation({ CLAUDISH_FAILOVER_ACTIVE: "opus" });
    // nm walls by default (beforeEach) — the delegated refusal surface.

    // Request 1: opus (config-armed) → role:sonnet → sonnet's nominal (nm)
    // walls 402. opus[0] is the last step, so the wall surfaces — as a 429
    // rate_limit_error since #409 (a walled LAST step is relabeled into the
    // vocabulary the client already retries; the body names the original 402,
    // role and concrete). Pre-#409 this surfaced the provider's 402 verbatim,
    // which this pin originally asserted.
    const r1 = await postMessage("claude-opus-5");
    expect(r1.status).toBe(429);
    const r1Body = await r1.json();
    expect(JSON.stringify(r1Body)).toContain("402"); // the original status is named, wall not silent
    expect(calls.nm).toBe(1);
    expect(calls.mm).toBe(0); // the default model is never CALLED — only mis-bucketed

    // THE PIN: the delegated wall armed the TARGET's own bucket. Under
    // nominalBucketOfModel it armed mm-ep instead — and every later opus
    // request re-paid the walled nominal forever (the S1 failure mode,
    // relocated to the wrong bucket).
    expect(isBucketWalled(bucketOfNominal())).toBe(true); // nom-ep
    expect(isBucketWalled("mm-ep")).toBe(false); // an innocent bucket, never armed

    // Control (S1's second half): the NEXT opus request joins sonnet's
    // cascade instead of hammering the walled nominal.
    wallEndpoints.delete("nm");
    const r2 = await postMessage("claude-opus-5");
    expect(r2.status).toBe(200);
    expect(calls.nm).toBe(1); // never re-paid
    expect(calls.s0).toBe(1); // the delegation walked into the target's cascade
  }, 30_000);

  test("B2: a delegated SUCCESS must not consume a pending recovery on a bucket the target never drew on", async () => {
    await spin("mm-ep@fake-mm");
    resetDelegation({ CLAUDISH_FAILOVER_ACTIVE: "opus" });
    // Sonnet's REQUEST-side nominal bucket is mm-ep (the --model default maps
    // every name to it): wall it, so a direct sonnet request diverts to s0
    // and seeds servedUnderWall(sonnet|mm-ep) — a pending recovery.
    armFailover("sonnet", "test: request-side nominal bucket walled", "mm-ep");
    wallEndpoints = new Set([]);

    // Request 1 (prefill): sonnet diverts under the mm-ep wall → s0 → 200.
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);

    // Request 2: opus (config-armed) → role:sonnet → sonnet's FAILOVER-side
    // nominal (nm) is healthy → the delegation serves it → owner-side
    // onNominalSuccess fires on the target's bucket.
    const r2 = await postMessage("claude-opus-5");
    expect(r2.status).toBe(200);
    expect(calls.nm).toBe(1);

    // THE PIN: the success booked against nom-ep (nothing pending there) —
    // NO "RECOVERED sonnet" line. Under nominalBucketOfModel the owner
    // bucket is mm-ep: the pending (sonnet|mm-ep) recovery is consumed and
    // a FALSE "RECOVERED sonnet (mm-ep)" is announced while the wall is
    // still live.
    expect(wallLog.find((l) => l.includes("RECOVERED sonnet"))).toBeUndefined();
    expect(isBucketWalled("mm-ep")).toBe(true); // the wall is untouched

    // Control: sonnet's own traffic still diverts — nothing really recovered.
    const r3 = await postMessage("claude-sonnet-5");
    expect(r3.status).toBe(200);
    expect(calls.s0).toBe(2);
    expect(calls.nm).toBe(1); // the walled request-side bucket is never re-paid
  }, 30_000);
});
