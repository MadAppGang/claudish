/**
 * #299 part B — a nominal's TRANSIENT OVERLOAD walks the role cascade once,
 * writing no FAILURE state, through the real `handleWithCascade` loop.
 *
 * Measured driver (2026-10-02, hub, MiniMax-M3 = the haiku nominal): MiniMax
 * answered HTTP 529 `overloaded_error` on up to 30 % of attempts. A 529 is not
 * a quota wall, so nothing armed and nothing walked — every 529 reached the
 * client, one cron conversation was retried 12 times against the same
 * overloaded provider, then dropped. Part A (already merged) makes a relay
 * pass a hub 529 through instead of replaying it locally; part B is the hub's
 * own local serving: when the resolved target is the role's NOMINAL and it
 * fails with a transient-overload class, try the FIRST SERVABLE cascade step
 * ONCE for this request only — no arm, no stepFailures mark, no bucket wall,
 * no dwell pin. Same separation as the #170 re-forward (`no markFail`).
 *
 * Mutation proof (one per branch — each comment names its branch):
 *  - remove the walk (predicate forced false) ⇒ W1/W2/W9-W14 red (measured 10/8)
 *    (client gets the original refusal, step never called);
 *  - let the walk arm (`onNominalRefusal` on the overload) ⇒ W1 red at exactly
 *    `expect(isFailoverActive("sonnet")).toBe(false)`;
 *  - drop the kill-switch read ⇒ W3 red (s0 called with the walk off);
 *  - shrink the predicate to `s === 529` ⇒ P2 (503) + P3 (429-overloaded) +
 *    P5/W9 (400 connection_error) red, P4/W7 (burst, negative control) stay
 *    green — the 503/429 forms are pinned on the predicate, see the P block;
 *  - drop the native-bucket exclusion ⇒ W8 red (s0 called on a native 529);
 *  - walk to `steps[0]` instead of the first servable step ⇒ W10/W11 red
 *    (walk pays a dead step / routes a role name);
 *  - drop the walled-bucket skip (`isBucketWalled(providerBucketOf(concrete))
 *    continue;`) ⇒ W12 red — the clause was written but unpinned until
 *    review of #326 point 3 (mutation stayed 179/0);
 *  - drop the step arg at the TTL check (`isStepTtlFailed(fails?.[i])` —
 *    compiles, the param is optional) ⇒ W13 red — the #261 rebase hazard:
 *    a HEALTHY step closed by a future config _RESET reads servable, the
 *    closure living in the step's resetAt, not in the failure record;
 *  - rethrow in the walk's `catch` ⇒ W14 red — the client gets a terminal
 *    HTTP 400 routing error instead of the retryable 529 (review of #326);
 *  - drop the budget skip (#348) ⇒ W15 red — the walk fires into a request
 *    whose patience is already spent; W16 pins the NEGATIVE result that no
 *    client-gone skip exists (abort undetectable pre-write on this stack —
 *    see the W16 comment's probe matrix; a `destroyed`-based predicate skips
 *    every walk, measured 11/22 red the moment it shipped);
 *  - drop the canonical bucketter for bare targets (#348) ⇒ W17 red — the
 *    wall on the route()-primary bucket is invisible to providerBucketOf;
 *  - drop the nominal-bucket skip (#348 part 3) ⇒ W18 red — the walk re-pays
 *    the same bucket whose capacity the 529 just refused.
 *
 * #28 Groupe A — characterization (G1/G2 + P7): bare 502/504 on the nominal
 * are OUTSIDE the walk class today, so no walk, no arm, the bare status
 * surfaces. Widen the class to 502/504 (pending coordinator decision) and
 * these three go RED — that is their job: the widening must land as a
 * deliberate choice, not as predicate drift.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { isOverloadWalkClass } from "./handlers/composed-handler.js";
import {
  armFailover,
  classifyNominalBucket,
  isBucketWalled,
  isFailoverActive,
  markStepFailed,
  providerBucketOf,
  resetFailoverForTests,
  setRoleNominalResolver,
} from "./fork/failover.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883).
const PROXY_PORT = 19895;
const UPSTREAM_PORT = 19995;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-role-failover-route.test.ts.
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
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
/** `[Failover]` lines off BOTH channels: `log(msg, true)` markers (WALK,
 *  STEP-ADVANCE…) go to stdout via console.log, `logStderr` lines (markStepFailed
 *  walls) carry the `[claudish]` prefix on stderr — the #274 file captured only
 *  the latter and would have been blind to this marker. */
let failoverLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realConsoleLog = console.log.bind(console);

/** Per-endpoint status override; unset ⇒ 200 healthy (s0/s1) or 529 (nm). */
let endpointStatus: Record<string, number> = {};
/** Per-endpoint artificial latency (ms) before answering — W15/W16 need the
 *  nominal to answer LATE so the walk branch can observe a spent budget or a
 *  client that left while the nominal was still working. */
let endpointDelay: Record<string, number> = {};
/** Endpoints whose 429 body is a BURST (no overload wording) rather than an
 *  overload-shaped 429 — W7's negative control needs both spellings. */
let burst429: Record<string, boolean> = {};

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

/** MiniMax's real 02/10 shape: HTTP 529 with the `overloaded_error` code. */
function overload529(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "overloaded_error",
        code: "2064",
        message: "The server cluster is currently under high load",
      },
    }),
    { status: 529, headers: { "content-type": "application/json" } }
  );
}

function quotaWall(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** GLM Coding's real shape: a 429 whose body names the overload (isTransientOverload
 *  matches, so it is an overload — NOT a burst). */
function overload429(): Response {
  return new Response(
    JSON.stringify({
      error: { type: "rate_limit_error", message: "The server cluster is overloaded, try again later" },
    }),
    { status: 429, headers: { "content-type": "application/json" } }
  );
}

/** A per-minute BURST: same status, none of the overload wording — must NOT
 *  walk (and must NOT arm either: no quota/plan words). Carries a short
 *  Retry-After, as bursts do — that is also what keeps the transport's 429
 *  ladder fast in the test (1 s/retry instead of 2→30 s). */
function burst429Resp(): Response {
  return new Response(
    JSON.stringify({ error: { type: "rate_limit_error", message: "Too many requests — slow down" } }),
    { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } }
  );
}

/** The proxy's own synthesis of a transport failure to the nominal (#298 A):
 *  HTTP 400 + `"connection_error"` in the body (connection-error.ts). */
function connectionError400(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "connection_error", message: "Connection to the upstream failed" },
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

/** sonnet walks s0→s1; the nominal is a fake custom endpoint (never a real key). */
const WALK_ENV = {
  CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-s0>s1-ep@fake-s1",
  CLAUDISH_FAILOVER_AUTO: "1",
  CLAUDISH_FAILOVER_ARM_AFTER: "1",
} as Record<string, string>;

const SONNET_NOMINAL = "nom-ep@fake-nom";
const bucketOfNominal = () => {
  const nb = classifyNominalBucket(SONNET_NOMINAL, () => false);
  if (!("bucket" in nb)) throw new Error("route test: custom-endpoint nominal must classify to a bucket");
  return nb.bucket;
};

function resetWalk(extra: Record<string, string> = {}): void {
  resetFailoverForTests({ ...WALK_ENV, ...extra });
  setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOMINAL : undefined));
}

/** The three fake custom endpoints every test gets. Module scope so a test can
 *  rewrite the config BEFORE spin() with extra top-level fields — routing rules
 *  and endpoints both load at proxy startup, not per request (W17). */
function writeTestConfig(extra: Record<string, unknown> = {}): void {
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
        // W20: the TARGET side of a `role:opus` delegation (opus's nominal
        // and its own cascade step); the fetch stub checks these FIRST.
        "tr-ep": ep("tr"),
        "t2-ep": ep("t2"),
        // W21 (#367): kw = the delegation's KEYWORD-BEARING concrete target
        // (its own bucket kw-ep), d0 = the prefill divert target, h5 = the
        // walking role's 529 nominal.
        "kw-ep": ep("kw"),
        "d0-ep": ep("d0"),
        "h5-ep": ep("h5"),
      },
      ...extra,
    }),
    "utf-8"
  );
}

async function postMessage(
  model: string,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

beforeEach(() => {
  calls = { nm: 0, s0: 0, s1: 0, native: 0 };
  failoverLog = [];
  endpointStatus = {};
  endpointDelay = {};
  burst429 = {};
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
    // The native lane (W8): stubbed so the test NEVER touches the real
    // api.anthropic.com, credential or not.
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.native = (calls.native ?? 0) + 1;
      return overload529();
    }
    // W17/W18 delegation targets: prefix matches, not the 2-char which-code.
    for (const key of ["tr", "t2"] as const) {
      if (url.startsWith(`${UPSTREAM_BASE}/${key}/`)) {
        calls[key] = (calls[key] ?? 0) + 1;
        const st = endpointStatus[key] ?? 200;
        if (st === 0 || st === 200) return healthySSE();
        if (st === 402) return quotaWall();
        if (st === 529) return overload529();
        if (st === 429) return burst429[key] ? burst429Resp() : overload429();
        return new Response(JSON.stringify({ error: "stub failure" }), { status: st, headers: { "content-type": "application/json" } });
      }
    }
    if (!url.startsWith(UPSTREAM_BASE)) return realFetch(input, init);
    const which = url.slice(UPSTREAM_BASE.length + 1, UPSTREAM_BASE.length + 3);
    calls[which] = (calls[which] ?? 0) + 1;
    if (endpointDelay[which]) await new Promise((r) => setTimeout(r, endpointDelay[which]));
    const status = endpointStatus[which] ?? (which === "nm" ? 529 : 200);
    if (status === 402) return quotaWall();
    if (status === 529) return overload529();
    if (status === 429) return burst429[which] ? burst429Resp() : overload429();
    if (status === 400) return connectionError400();
    if (status >= 400) return new Response(JSON.stringify({ error: "stub failure" }), { status, headers: { "content-type": "application/json" } });
    return healthySSE();
  }) as typeof fetch;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]")) failoverLog.push(line);
    }
    return realStderrWrite(chunk, ...rest);
  }) as any;
  console.log = ((...args: any[]) => {
    const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    for (const line of text.split("\n")) {
      if (line.includes("[Failover]")) failoverLog.push(line);
    }
    // Re-emit so a failing run still shows the proxy's operator markers.
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

async function spin(
  map?: Record<string, string>,
  anthropicApiKey?: string
): Promise<void> {
  // Default: the proxy owns the modelMap — sonnet resolves to the fake custom
  // endpoint that answers 529, so the NOMINAL attempt reaches a real upstream
  // (a bare claude-* with no map would go to the NativeHandler and 403 on
  // shape A). W8 passes NO map + a stub sk-ant key so the nominal IS native.
  activeProxy = await createProxyServer(
    PROXY_PORT,
    undefined,
    undefined,
    false,
    anthropicApiKey,
    map ?? { sonnet: SONNET_NOMINAL },
    { quiet: true }
  );
}

// ---- the pins -------------------------------------------------------------------

describe("#299 B — nominal transient overload walks the cascade once, zero failure state", () => {
  test("W1: nominal 529 → step 0 serves; no arm, no bucket wall, one WALK marker", async () => {
    await spin();
    resetWalk();
    // nm answers 529; s0 answers 200.
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(1); // the overloaded nominal, paid once
    expect(calls.s0).toBe(1); // the walk's one attempt
    expect(calls.s1).toBe(0); // bounded — never deeper

    // THE PIN: no state changed. The 529 is not a wall, so the role is not
    // armed and the bucket is not walled — the NEXT request re-probes the
    // nominal instead of riding the cascade for a 10-min TTL.
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(bucketOfNominal())).toBe(false);

    // The countable marker, one per walk.
    expect(
      failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("529"))
    ).toBe(true);
  }, 30_000);

  test("W2: nominal 529 then step 0 ALSO fails → the client gets the ORIGINAL 529, no further walk", async () => {
    await spin();
    resetWalk();
    endpointStatus.s0 = 500; // the step fails too
    const r1 = await postMessage("claude-sonnet-5");
    // The original overload surfaces — never the step's own incident.
    expect(r1.status).toBe(529);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(0); // bounded to ONE walk
    // Still no state, even though the step failed.
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
  }, 30_000);

  test("W3: kill switch CLAUDISH_FAILOVER_OVERLOAD_WALK=0 → no walk, the 529 surfaces", async () => {
    await spin();
    resetWalk();
    // The kill switch is read per-request off process.env (like the other
    // per-request switches — CLAUDISH_NATIVE_MODEL_PIN): the fleet flips it
    // mid-flight and a cached value would need a proxy restart. So it is set
    // here directly, not through the initFailover env object.
    process.env.CLAUDISH_FAILOVER_OVERLOAD_WALK = "0";
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(529);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0); // never walked
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
  }, 30_000);

  test("W4 control: a QUOTA 402 on the nominal still ARMS (the walk is overload-only)", async () => {
    await spin();
    resetWalk();
    endpointStatus.nm = 402; // quota wall, not an overload
    const r1 = await postMessage("claude-sonnet-5");
    // The existing armed behavior: ARM_AFTER=1 arms on the first quota refusal
    // and the retry serves step 0 — but the role is now ARMED, the exact
    // contrast the overload walk must NOT produce.
    expect(r1.status).toBe(200);
    expect(calls.s0).toBe(1);
    expect(isFailoverActive("sonnet")).toBe(true);
    expect(isBucketWalled(bucketOfNominal())).toBe(true);
    // No WALK marker on this path — the quota branch is untouched.
    expect(failoverLog.some((l) => l.includes("WALK sonnet one-shot"))).toBe(false);
  }, 30_000);

  test("W7 negative: a 429 BURST (no overload wording) neither walks nor arms", async () => {
    await spin();
    resetWalk();
    endpointStatus.nm = 429;
    burst429.nm = true; // "Too many requests — slow down" + Retry-After: 1
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(429);
    expect(calls.s0).toBe(0); // never walked
    expect(calls.s1).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false); // and never armed either
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
    expect(failoverLog.some((l) => l.includes("WALK sonnet one-shot"))).toBe(false);
  }, 60_000);

  // #28 Groupe A — CHARACTERIZATION, not a fix: a BARE 502/504 from the
  // nominal is outside isOverloadWalkClass (503/429-worded/529/400-conn only),
  // so today the walk never fires, nothing arms, and the client eats the bare
  // status. A gateway 502/504 is exactly the "infrastructure died between us
  // and the provider" shape (nginx up, backend down; LB timeout), but unlike
  // 503/529 it carries no provider-authored signal — widening the class is a
  // policy decision (#28, coordinator pending), and these pins document the
  // current edge so a widening shows up as a deliberate red here, forced to
  // choose walk-vs-arm explicitly, instead of drifting in silently.
  test("G1 (#28 A): bare 502 on the nominal does NOT walk — the client sees the 502, zero state", async () => {
    await spin();
    resetWalk();
    endpointStatus.nm = 502; // stub branch `status >= 400`: bare JSON, no overload wording
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(502); // surfaced as-is
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0); // never walked
    expect(calls.s1).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
    expect(failoverLog.some((l) => l.includes("WALK sonnet one-shot"))).toBe(false);
  }, 30_000);

  test("G2 (#28 A): bare 504 on the nominal does NOT walk — same shape, timeout tier", async () => {
    await spin();
    resetWalk();
    endpointStatus.nm = 504;
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(504);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0);
    expect(calls.s1).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
    expect(failoverLog.some((l) => l.includes("WALK sonnet one-shot"))).toBe(false);
  }, 30_000);

  test("W8: a NATIVE-lane 529 does NOT walk — the client's own credential, announced substitutions only", async () => {
    // EMPTY modelMap (not undefined — `map ?? default` would restore it): bare
    // claude-sonnet-5 resolves to NativeHandler, whose bucket is
    // anthropic-native/<model>. The client SENDS an sk-ant- key (the ai-01
    // passthrough shape) so the #296 guard lets it through, and the fetch stub
    // answers 529 — no real network, ever.
    await spin({});
    resetWalk();
    const r1 = await postMessage("claude-sonnet-5", { "x-api-key": "sk-ant-test-walk" });
    expect(r1.status).toBe(529);
    expect(calls.native).toBe(1); // the nominal WAS reached and refused
    expect(calls.s0).toBe(0); // the walk is excluded on the native lane
    expect(calls.s1).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(failoverLog.some((l) => l.includes("WALK sonnet one-shot"))).toBe(false);
  }, 30_000);

  test("W9: HTTP 400 connection_error on the nominal walks (#298 A, clause from #302)", async () => {
    await spin();
    resetWalk();
    endpointStatus.nm = 400; // stub body: {"type":"connection_error",…}
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("400"))).toBe(true);
  }, 30_000);

  test("W10: step 0 already in per-step backoff → the walk serves the FIRST SERVABLE step (s1)", async () => {
    await spin();
    resetWalk();
    // A weekly wall on step 0's provider: the step is TTL-failed, so a walk to
    // steps[0] would be a round-trip at a target we know is dead.
    markStepFailed("sonnet", 0, "test: step 0 pre-failed (weekly wall)");
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0); // skipped — known dead
    expect(calls.s1).toBe(1); // the first SERVABLE step served the walk
    expect(isFailoverActive("sonnet")).toBe(false); // still no wall, no arm
    expect(failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("step 1"))).toBe(true);
  }, 30_000);

  test("W11: a role-step whose delegation cannot resolve is SKIPPED, never routed as a model id", async () => {
    await spin();
    // Cascade: step 0 = role:fable (no fable cascade, no nominal resolver for
    // fable ⇒ the delegation yields null), step 1 = a real endpoint.
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "role:fable>s1-ep@fake-s1" });
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200); // served by s1 — "fable" never hit the wire
    expect(calls.s0).toBe(0);
    expect(calls.s1).toBe(1);
    expect(failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("step 1"))).toBe(true);
  }, 30_000);

  // Review of #326 point 3 — the walled-bucket skip clause was written but
  // UNPINNED: ai-01's mutation deleting `if (isBucketWalled(providerBucketOf(
  // concrete))) continue;` ran 179/0. Distinct from W10, whose step 0 is dead
  // on the BACKOFF plane (a stepFailures record): here the step is HEALTHY on
  // that plane (no record, count 0) and dead on the WALL plane only — a
  // weekly wall on its provider bucket, armed exactly as production arms one.
  test("W12: step 0's provider bucket WALLED (healthy step, no failure record) → the walk serves step 1", async () => {
    await spin();
    resetWalk();
    // Bucket computed the way the walk computes it (providerBucketOf of the
    // concrete target), and the arm asserted so a silent no-op of the setup
    // fails HERE rather than as a misleading s0 count below. Requires
    // CLAUDISH_FAILOVER_AUTO=1 (WALK_ENV carries it — armFailover is a no-op
    // without it).
    const bucketOfStep0 = providerBucketOf("s0-ep@fake-s0");
    expect(armFailover("sonnet", "test: weekly wall on step 0's provider", bucketOfStep0)).toBe(true);
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(1); // the nominal's OWN bucket is unwalled — still probed first (#275: no contagion)
    expect(calls.s0).toBe(0); // skipped: walled bucket, exactly like the armed resolver
    expect(calls.s1).toBe(1); // the first SERVABLE step served the walk
    // The walk itself wrote no wall on the NOMINAL's bucket (the only wall
    // live is the test's own, on step 0's provider).
    expect(isBucketWalled(bucketOfNominal())).toBe(false);
    expect(failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("step 1"))).toBe(true);
  }, 30_000);

  // Review of #326 point 2 — the #261 rebase hazard: resolveTransientStep
  // called isStepTtlFailed(fails?.[i]) WITHOUT the step. The param is
  // optional so it compiles, and the #261 closure plane lives in the step's
  // resetAt, not in the failure record — a HEALTHY step closed by a future
  // config _RESET therefore read servable here while the armed resolver
  // would never select it. No rebase conflict could ever surface this; only
  // the pin can.
  test("W13: step 0 CLOSED by a future _RESET (healthy, never failed) → the walk serves step 1 (#261 rebase)", async () => {
    await spin();
    resetWalk({ CLAUDISH_FAILOVER_SONNET_RESET: "2097-01-01T00:00:00Z" });
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0); // closed by _RESET — never selected, failure-free or not
    expect(calls.s1).toBe(1);
    expect(isFailoverActive("sonnet")).toBe(false); // a closure is not a wall
    // The #261 startup attestation fired — proves the env date parsed (an
    // unparseable one would warn and fall back to open, and s0 would be 1).
    expect(failoverLog.some((l) => l.includes("[Failover] CLOSED sonnet[0]"))).toBe(true);
    expect(failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("step 1"))).toBe(true);
  }, 30_000);

  // The walk's `catch` is load-bearing, not defensive: a step whose provider
  // has no credential makes getHandlerForRequest THROW a RoutingError. Without
  // the catch that throw becomes HTTP 400 "could not be routed" — terminal for
  // Claude Code — where the original 529 would have been retried. The kimi
  // key vars are in SANDBOX_ENV_KEYS, so the throw is guaranteed and hermetic.
  test("W14: the walk step THROWS (no credential) → the ORIGINAL 529, no state", async () => {
    await spin();
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "kimi@fake-kimi>s1-ep@fake-s1" });
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(529);
    expect(calls.nm).toBe(1);
    expect(calls.s1).toBe(0); // bounded — the throw does not walk deeper
    expect(calls.native).toBe(0);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("step 0"))).toBe(true);
  }, 30_000);

  // Review of #331 (06/10) point 1 — the ONE-SHOT walk used bare
  // isStepTtlFailed at resolveTransientStep, the exact order resolveSkipping-
  // Failed was just fixed for. Setup: sonnet[0] = role:opus marked against
  // opus's nominal (tr) while that delegation still pointed there; since then
  // the wall crossed to opus's own step (t2), so the delegation resolves to t2
  // — the frozen concrete is LEFT, the step is probeable. Bare isStepTtlFailed
  // freezes it anyway: the walk then pays step 1 (s1) instead of serving the
  // delegation. RED under the mutation; green since stepTtlBinds replaced it.
  test("W20: a role-step frozen on a concrete its delegation LEFT is still servable by the walk", async () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      await spin({ sonnet: SONNET_NOMINAL, opus: "tr-ep@fake-tr" });
      resetWalk({
        CLAUDISH_FAILOVER_SONNET: "role:opus>s1-ep@fake-s1",
        CLAUDISH_FAILOVER_OPUS: "t2-ep@fake-t2",
      });
      // The step is marked WHILE the delegation resolves to the target's
      // nominal (tr) — the concrete the record must name.
      markStepFailed("sonnet", 0, "test: role-step walled on the target's nominal", undefined, {
        concrete: "tr-ep@fake-tr",
      });
      // The delegation ADVANCES: opus's nominal is walled (ttl 24h > the
      // clock advance, so the wall is still up), opus resolves its own step.
      expect(
        armFailover("opus", "test: the delegation's nominal walled since the mark", providerBucketOf("tr-ep@fake-tr"))
      ).toBe(true);
      clock += 1000; // between requests — a delegation CAN move here
      const r1 = await postMessage("claude-sonnet-5");
      expect(r1.status).toBe(200);
      expect(calls.nm).toBe(1);
      expect(calls.tr).toBeUndefined(); // the frozen concrete is never re-paid
      expect(calls.t2).toBe(1); // the delegation's CURRENT concrete served the walk
      expect(calls.s1).toBe(0); // …and the walk did NOT jump past the step
      expect(
        failoverLog.some(
          (l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("t2-ep@fake-t2") && l.includes("step 0")
        )
      ).toBe(true);
    } finally {
      Date.now = realNow;
    }
  }, 30_000);

  // #367 — the walk's delegated SUCCESS books the owner bucket from an
  // ALREADY-CONCRETE target. The site used nominalBucketOfModel, whose
  // request-side mapping re-maps a role-keyworded concrete onto
  // modelMap[role] — here the delegation's concrete `kw-ep@fake-sonnet-kw`
  // (its OWN bucket: kw-ep) re-mapped onto modelMap.sonnet = nom-ep@fake-nom
  // (keyword-free) — the same defect class as the #348 walk bucketer (W19),
  // on the walk's DELEGATED-success branch this time. The observable: a
  // pending (opus|nom-ep) recovery seeded by a direct opus divert under a
  // nom-ep wall gets consumed by a walk success that drew on kw-ep — a
  // FALSE "RECOVERED opus (nom-ep)" announced while the wall is live.
  // RED under nominalBucketOfModel-as-bucketer.
  test("W21: a role-keyworded delegation CONCRETE books the owner bucket as ITSELF (walk success)", async () => {
    // Proxy modelMap: sonnet/opus map to nom-ep (so the request-side bucket
    // of a claude-opus-* request IS nom-ep), haiku maps to a dedicated 529
    // nominal. The FAILOVER-side nominals come from the injected resolver
    // below — opus's is keyword-bearing, the divergence #367 pins.
    await spin({ sonnet: "nom-ep@fake-nom", opus: "nom-ep@fake-nom", haiku: "h5-ep@fake-h5" });
    resetWalk({
      CLAUDISH_FAILOVER_HAIKU: "role:opus",   // the walk's delegated step
      CLAUDISH_FAILOVER_OPUS: "role:sonnet",  // the prefill divert's step
    });
    setRoleNominalResolver((r) =>
      r === "opus" ? "kw-ep@fake-sonnet-kw"
      : r === "sonnet" ? "d0-ep@fake-d0"
      : r === "haiku" ? "h5-ep@fake-h5"
      : undefined
    );
    endpointStatus.h5 = 529; // the walking role's nominal overloads
    // opus's REQUEST-side nominal bucket (nom-ep, via the proxy modelMap)
    // walled: a direct opus request diverts and seeds a pending recovery.
    expect(armFailover("opus", "test: request-side nominal bucket walled", "nom-ep")).toBe(true);

    // Request 1 (prefill): opus diverts under the nom-ep wall → its step
    // role:sonnet → sonnet's (failover-side) nominal d0 → 200. Seeds
    // servedUnderWall(opus|nom-ep).
    const r1 = await postMessage("claude-opus-5");
    expect(r1.status).toBe(200);
    expect(calls.d0).toBe(1);

    // Request 2 (THE PIN): haiku's nominal 529s → the walk takes the first
    // servable step (role:opus → kw, healthy, bucket kw-ep ≠ the walled
    // nom-ep) → delegated success → owner-side onNominalSuccess on the
    // target's OWN bucket (kw-ep) — nothing pending there.
    const r2 = await postMessage("claude-haiku-5");
    expect(r2.status).toBe(200);
    expect(calls.kw).toBe(1);
    expect(failoverLog.some((l) => l.includes("[Failover] WALK haiku one-shot") && l.includes("kw-ep@fake-sonnet-kw"))).toBe(true);
    expect(failoverLog.find((l) => l.includes("RECOVERED opus"))).toBeUndefined(); // no false recovery
    expect(isBucketWalled("nom-ep")).toBe(true); // the wall is untouched

    // Control: opus still diverts — nothing really recovered.
    const r3 = await postMessage("claude-opus-5");
    expect(r3.status).toBe(200);
    expect(calls.d0).toBe(2);
    expect(calls.kw).toBe(1); // the walk target is not re-paid either
  }, 30_000);

  // ─── #348 — the walk is paid out of the client's REMAINING patience ──────────

  // A 429/503 overload reaches the walk only after the transport ladder and the
  // patient backoff have spent ~365 s; the relay's 360 s header deadline has
  // already expired under it and a direct client has < 235 s of its 600 s
  // budget left. The walk is therefore BOUNDED: past
  // CLAUDISH_FAILOVER_WALK_BUDGET_MS (default 300 s, read per request, 0=off)
  // the original overload surfaces instead of a walk nobody can wait for.
  test("W15: nominal 529 arriving PAST the walk budget → skip, original surfaces (one skip marker)", async () => {
    await spin();
    resetWalk();
    // Read per request like the kill switch — set directly on process.env.
    // 500 ms budget vs a nominal that takes 700 ms to answer its 529.
    process.env.CLAUDISH_FAILOVER_WALK_BUDGET_MS = "500";
    endpointDelay.nm = 700;
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(529); // the original overload, not a late walk
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(0); // never walked — the budget was spent
    expect(calls.s1).toBe(0);
    expect(
      failoverLog.some((l) => l.includes("[Failover] WALK sonnet skipped") && l.includes("budget"))
    ).toBe(true);
    expect(failoverLog.some((l) => l.includes("WALK sonnet one-shot"))).toBe(false);
    expect(isFailoverActive("sonnet")).toBe(false); // the skip writes no state either
  }, 30_000);

  // #348 NEGATIVE RESULT, pinned — a client abort is UNDETECTABLE at the walk
  // branch on this stack, so there is NO client-gone skip and this pin guards
  // against re-adding one. The proxy serves through @hono/node-server on
  // Bun's node:http, and by the cascade the body is consumed. Probe matrix
  // (2x2 healthy/aborted, body read, checked 400 ms after the abort):
  //  - adapter Request signal: false in BOTH (it arms only at the first
  //    write — and a first probe on raw Bun.serve, where it DOES flip, was
  //    the wrong stack; caught by this test before merge);
  //  - incoming.destroyed/close/complete: true in BOTH (Bun destroys the
  //    message once read — a predicate on `destroyed` skips EVERY walk,
  //    measured: 11/22 red the moment it shipped);
  //  - incoming.socket/outgoing.socket {destroyed, readyState}: open in BOTH;
  //  - events subscribed at entry (inc "aborted"/"close", socket "close",
  //    out "close"): identical in BOTH.
  // Consequence: the walk FIRES into an abandoned request (bounded by the
  // budget alone, one attempt by construction). If someone re-adds a
  // client-gone predicate, it must discriminate THIS test's aborted client
  // from a healthy one — no current signal does.
  test("W16: client abort is UNDETECTABLE pre-write → the walk proceeds (no client-gone skip exists)", async () => {
    await spin();
    resetWalk();
    endpointDelay.nm = 400; // the nominal is still working when the client leaves
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    try {
      await postMessage("claude-sonnet-5", {}, ac.signal);
    } catch {
      // expected — the client-side fetch rejects on abort; the SERVER handler
      // continues (that asymmetry is the point of this pin).
    }
    // Let the handler reach the walk branch after its late 529.
    await new Promise((r) => setTimeout(r, 600));
    expect(calls.nm).toBe(1); // the nominal attempt was already in flight
    expect(calls.s0).toBe(1); // the walk FIRED — no skip predicate may suppress it here
    expect(failoverLog.some((l) => l.includes("WALK sonnet one-shot"))).toBe(true);
    expect(failoverLog.some((l) => l.includes("WALK sonnet skipped"))).toBe(false);
  }, 30_000);

  // #348 part 2 — the W12 gap on the BARE-NAME plane: providerBucketOf("glm-5.3")
  // reads `glm`, but the wall production arms sits on the route() primary the
  // routing chain actually serves (the `glm-coding` plan bucket — here the
  // custom endpoint a user routing rule sends glm-5.3 to). The walk buckets
  // steps through the SAME canonical resolver as the nominal
  // (nominalBucketOfModel, injected), or the wall is invisible to it.
  test("W17: bare step-0 target WALLED on its route()-primary bucket → skipped, step 1 serves", async () => {
    // The routing rule must be in config.json BEFORE spin(): rules load at
    // startup. It sends bare glm-5.3 to s0-ep, making the canonical bucket of
    // the step `s0-ep` — providerBucketOf still reads `glm`.
    writeTestConfig({ routing: { "glm-5.3": ["s0-ep"] } });
    await spin();
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "glm-5.3>s1-ep@fake-s1" });
    // Wall the CANONICAL bucket of the bare step — armed exactly as production
    // arms a plan wall. Asserted so a silent no-op of the setup fails here,
    // not as a misleading s0 count below.
    expect(armFailover("sonnet", "test: wall on the bare step's canonical bucket", "s0-ep")).toBe(true);
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(1); // the nominal's own bucket (nom-ep) is unwalled — probed (#275: no contagion)
    expect(calls.s0).toBe(0); // skipped: its canonical bucket is walled, `glm` is not what serves it
    expect(calls.s1).toBe(1); // the first canonically-servable step
    expect(failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("step 1"))).toBe(true);
  }, 30_000);

  // #348 part 3 — a step on the NOMINAL's own bucket re-pays the exact
  // capacity the 529 just refused: same endpoint, same meter, same overload.
  // The walk skips it (nominalBucket injected) and takes the next step.
  test("W18: step 0 on the NOMINAL's own bucket → skipped, step 1 serves (the 529 already refused that capacity)", async () => {
    // The nominal IS s0 (bucket `s0-ep`); the cascade's step 0 sits on the
    // same bucket under a second model id — healthy, unwalled, and useless.
    await spin({ sonnet: "s0-ep@fake-nom" });
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-b>s1-ep@fake-s1" });
    endpointStatus.s0 = 529; // the bucket's capacity is the overloaded thing
    const r1 = await postMessage("claude-sonnet-5");
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("Hello from the cascade.");
    expect(calls.nm).toBe(0);
    expect(calls.s0).toBe(1); // the nominal's OWN attempt — exactly once, never re-paid by the walk
    expect(calls.s1).toBe(1); // step 0 skipped on the bucket plane; step 1 served
    expect(failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("step 1"))).toBe(true);
  }, 30_000);

  // Review of #348 (06/10) — BLOQUANT. The walk's injected bucketer was
  // nominalBucketOfModel, which runs resolveNominalTarget FIRST: a concrete
  // step target whose id carries a role keyword re-mapped onto
  // modelMap[role] — the NOMINAL's bucket — and the "same bucket as the
  // nominal" skip then jumped a healthy step drawing on a different meter.
  // Probe (ai-01, the harness's own shape): cascade `s0-ep@fake-sonnet-b >
  // s1-ep@fake-s1`, nominal nm → 529 — main served step 0 (s0=1), #354's
  // first cut served step 1 (s0 SKIPPED on a bucket it never drew on). The
  // fix buckets step targets through concreteStepBucketOf: classify + route,
  // no request-side mapping. RED under nominalBucketOfModel-as-bucketOf.
  test("W19: a role-keyworded STEP target buckets as ITSELF, not as the role's nominal (concrete-step bucketer)", async () => {
    await spin(); // modelMap.sonnet = nom-ep@fake-nom (the spin default)
    resetWalk({ CLAUDISH_FAILOVER_SONNET: "s0-ep@fake-sonnet-b>s1-ep@fake-s1" });
    const r1 = await postMessage("claude-sonnet-5"); // nominal nm answers 529 (default)
    expect(r1.status).toBe(200);
    expect(calls.nm).toBe(1);
    expect(calls.s0).toBe(1); // step 0 SERVED — its own bucket (s0-ep) ≠ the nominal's (nom-ep)
    expect(calls.s1).toBe(0);
    expect(failoverLog.some((l) => l.includes("[Failover] WALK sonnet one-shot") && l.includes("step 0"))).toBe(true);
  }, 30_000);
});

// ─── predicate pins ───────────────────────────────────────────────────────────
//
// The 503 and 429-with-overloaded-body clauses CANNOT be produced at route
// level in a sane test: a 429 first climbs the transport's own 5-rung ladder
// (2s→30s, openai.ts), then ComposedHandler's patient backoff retries the
// same provider for ~5 min, and what finally reaches the cascade is the
// CONVERTED 529 — the documented design ("the 429/503 overload forms convert
// to 529 above", composed-handler.ts). Those clauses are the defense-in-depth
// for whatever path bypasses the patient backoff, so they are pinned HERE, on
// the exported predicate itself — which is also exactly what the shrink
// mutation (isOverloadWalkClass = s => s === 529) attacks.

describe("#299 B — isOverloadWalkClass pins every clause the walk answers to", () => {
  test("P1: a bare 529 is the walk class (the post-backoff shape)", () => {
    expect(isOverloadWalkClass(529, "")).toBe(true);
    expect(isOverloadWalkClass(529, '{"error":{"type":"overloaded_error"}}')).toBe(true);
  });

  test("P2: 503 by status alone is the walk class", () => {
    expect(isOverloadWalkClass(503, "")).toBe(true);
    expect(isOverloadWalkClass(503, "service unavailable")).toBe(true);
  });

  test("P3: a 429 whose body names the overload is the walk class", () => {
    expect(isOverloadWalkClass(429, "The server cluster is overloaded")).toBe(true);
    expect(isOverloadWalkClass(429, "try again later")).toBe(true);
    expect(isOverloadWalkClass(429, "concurrency limit reached")).toBe(true);
  });

  test("P4: a 429 BURST (no overload wording) is NOT the walk class", () => {
    expect(isOverloadWalkClass(429, "Too many requests — slow down")).toBe(false);
    expect(isOverloadWalkClass(429, "")).toBe(false);
  });

  test("P5: HTTP 400 + connection_error is the walk class (#298 A, from #302)", () => {
    expect(isOverloadWalkClass(400, '{"type":"error","error":{"type":"connection_error"}}')).toBe(true);
  });

  test("P6: any other 400 is NOT the walk class (it is the user's own bad request)", () => {
    expect(isOverloadWalkClass(400, '{"type":"error","error":{"type":"invalid_request_error"}}')).toBe(false);
    expect(isOverloadWalkClass(400, "")).toBe(false);
  });

  test("P7 (#28 A): bare 502/504 are NOT the walk class — by status AND by body", () => {
    expect(isOverloadWalkClass(502, "")).toBe(false);
    expect(isOverloadWalkClass(504, "")).toBe(false);
    // No provider-authored signal on these tiers: even overload-style wording
    // cannot rescue them — the wording branch only exists at 429, the
    // status branch only at 503/529. See G1/G2 for the end-to-end shape.
    expect(isOverloadWalkClass(502, "The server cluster is overloaded")).toBe(false);
    expect(isOverloadWalkClass(504, "gateway timeout — try again later")).toBe(false);
  });
});
