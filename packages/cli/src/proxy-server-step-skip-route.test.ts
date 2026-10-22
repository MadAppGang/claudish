/**
 * #431 route pins — a cascade step that cannot take THIS request skips
 * forward: context overflow (vLLM "maximum context length" 400, or the
 * learned-cap short-circuit) and a saturated endpoint limiter (bounded busy
 * wait) advance to the next step with NO failure mark and NO dwell pin on the
 * skipped step. The recovery turn stays the client's answer on the last step
 * and on the non-cascade path, exactly as before.
 *
 * The two vllm-lane asks (ai-01 #4154 relay, 23:27Z): on a 400 "maximum
 * context length", route THAT request onward — never a local retry of the
 * skipped step (pinned as exactly-one-upstream-call), and compaction is the
 * covered shape (CC compacts at 0.95 × its window = 266k/313.5k > Swift's
 * 262 144, and /compact is the stream:false caller — pinned as a JSON answer
 * that is the successor's, never the recovery notice "as its summary").
 *
 * Mutation proofs (one per guard — remove the guard, exactly its pins go red):
 *  - m1: delete the loop's skip-advance block ⇒ K1/K2/K3/K8/K11 red (the
 *    recovery turn / the busy wait becomes the client's answer).
 *  - m2: drop the skippedSteps threading into the resolutions ⇒ K1 red — the
 *    walk re-pays the skipped step (short-circuit) on every remaining attempt
 *    and surfaces the recovery turn while a healthy successor existed.
 *  - m3: remove the maxOutputTokens clamp ⇒ K7 red (32000 on the wire).
 *  - m4: remove the busy bound (ConcurrencyLimiter.run's budget) ⇒ K8 red
 *    (r2 waits for the holder and answers from s0, not s1).
 *  - m5: remove the kill-switch gate ⇒ K11 red (skip fires with
 *    CLAUDISH_FAILOVER_STEP_SKIP=0 where today's behavior is required).
 *  - m6 (CR B1): null the loop's recordServedStepForNotices call ⇒ K1/K2's
 *    "served by **s1**" name asserts red — the notices fall back to the
 *    general resolver, which announces the SKIPPED step's name.
 *  - m7 (CR S2/S3): restore the bound on the last step (drop the else-re-mark)
 *    ⇒ K12 red (bounded 529 at ~100 ms instead of the unbounded wait).
 *  - m8 (CR S5a): drop the stepIndex >= 0 term from the skip predicate ⇒ K13
 *    red (a nominal overflow diverts to step 0's answer).
 *  - m9 (CR S1): let the busy bound ride the 429-retry ladder ⇒ the gate
 *    asserts in K8 stay green (its holder never 429s) — pinned instead by the
 *    transport-level suite; the route-level contract is documented, not
 *    re-derived here.
 *  - m10 (#441): disable the contextLimit clamp ⇒ K15 red (the oversized ask
 *    ships 16384 on the wire, > the 8 400 bound).
 *  - m11 (#441): default an ABSENT contextLimit to 262144 ⇒ K15's
 *    absent-field assert red (a plain endpoint ships 8361, not the verbatim
 *    16384) — the byte-identical-when-absent property bites.
 *
 * Same harness contract as proxy-server-wall-surface-route.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import {
  resetFailoverForTests,
  setRoleNominalResolver,
  getSessionDwellPinForTests,
} from "./fork/failover.js";
import { resetOverflowCapsForTests } from "./handlers/shared/context-overflow.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (19700+, 19851/19951,
// 19863, 19871, 19883/19983, 19891/19991, 19895/19995, 19905/20005).
const PROXY_PORT = 20115;
const UPSTREAM_PORT = 20215;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Same hermeticism contract as proxy-server-wall-surface-route.test.ts, plus
// the #431 knobs (stripped per test so a previous test's setting cannot leak).
const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
  "CLAUDISH_FAILOVER_STEP_SKIP", "CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS",
  "CLAUDISH_CONTEXT_ADMISSION",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;
let calls: Record<string, number> = {};
/** Captured upstream request bodies by endpoint tag (nm/s0/s1/b0/b1/cap/capa). */
let upstreamBodies: Record<string, any[]> = {};
/** All countable markers — [Failover], [StepBusy], [ContextGuard] and [MediaCap] (both
 * console.log and stderr are hooked: `log(..., true)` reaches console.log
 * while logStderr reaches stderr). */
let markerLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realConsoleLog = console.log.bind(console);

/** The vLLM refusal, verbatim family (Swift v0.31): counts prompt + max_tokens
 * against --max-model-len and never trims. */
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

/** #575 — the engine's per-prompt image cap, verbatim from
 * `test-fixtures/upstream-errors/vllm-image-cap-400.json` (10 hits, 12–20/10). */
function vllmImageCap400(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "At most 4 image(s) may be provided in one prompt. (parameter=image)",
        type: "BadRequestError",
        param: "image",
        code: 400,
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

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

/** Mistral-style quota 402 — arms/holds the role the way the other route
 * tests do (status alone, no reset). */
function quotaWall402(): Response {
  return new Response(
    JSON.stringify({ detail: "Check your subscription on https://example.invalid/subscription" }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** The incident env: a 2-step sonnet cascade; K4 (last step) uses the 1-step
 * variant. AUTO arm from the start — attempt 0 IS step 0, no nominal detour. */
function cascadeEnv(steps: string): Record<string, string> {
  return {
    CLAUDISH_FAILOVER_SONNET: steps,
    CLAUDISH_FAILOVER_AUTO: "1",
    CLAUDISH_FAILOVER_ARM_AFTER: "1",
  };
}
const TWO_STEP = "s0-ep@fake-s0>s1-ep@fake-s1";

/** The sonnet nominal, as the proxy's own resolver would inject it. */
const SONNET_NOMINAL = "nom-ep@fake-nom";

/** Per-test upstream behaviors, keyed by endpoint tag. Default: everything
 * healthy. */
let upstreamAnswer: Record<string, () => Response | Promise<Response>> = {};

function resetCascade(env?: Record<string, string>): void {
  resetFailoverForTests(env ?? cascadeEnv(TWO_STEP));
  const nominals: Record<string, string | undefined> = { sonnet: SONNET_NOMINAL };
  setRoleNominalResolver((r) => nominals[r]);
}

async function postMessage(
  opts: {
    model?: string;
    session?: string;
    content?: string;
    /** K16 (#442 CR): raw Anthropic content blocks (e.g. a base64 image). */
    contentBlocks?: unknown[];
    stream?: boolean;
    maxTokens?: number;
  } = {}
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-5",
      max_tokens: opts.maxTokens ?? 64,
      stream: opts.stream ?? false,
      ...(opts.session ? { metadata: { user_id: opts.session } } : {}),
      messages: [{ role: "user", content: opts.contentBlocks ?? opts.content ?? "say hi" }],
    }),
  });
}

/** Read the assistant text out of a non-streaming (collected) response. */
async function responseText(r: Response): Promise<string> {
  const body: any = await r.json();
  return (body?.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("");
}

/** Concatenated text_delta payloads out of a streaming SSE response — the
 * stream-notice channel (block 0) lands in the same text, so name asserts
 * work identically on both channels. */
async function responseSseText(r: Response): Promise<string> {
  const raw = await r.text();
  let out = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === "[DONE]") continue;
    try {
      const ev = JSON.parse(jsonStr);
      if (ev?.type === "content_block_delta" && ev?.delta?.type === "text_delta") out += ev.delta.text ?? "";
    } catch {
      /* not json */
    }
  }
  return out;
}

beforeEach(() => {
  calls = {};
  upstreamBodies = {};
  markerLog = [];
  upstreamAnswer = {};
  resetOverflowCapsForTests();
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ep = (name: string, extra: Record<string, unknown> = {}) => ({
    kind: "simple",
    url: `${UPSTREAM_BASE}/${name}/v1`,
    format: "openai",
    apiKey: "test-key",
    ...extra,
  });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "nom-ep": ep("nm"),
        "s0-ep": ep("s0"),
        "s1-ep": ep("s1"),
        // K7: the AC2 clamp endpoints — one openai, one anthropic wire.
        "cap-ep": ep("cap", { maxOutputTokens: 8192 }),
        "cap-anthropic-ep": {
          kind: "simple",
          url: `${UPSTREAM_BASE}/capa/v1`,
          format: "anthropic",
          apiKey: "test-key",
          maxOutputTokens: 8192,
        },
        // K8/K9/K11b: the busy endpoints — s0-shaped but with their own names
        // so their limiters are built with maxConcurrency from the first use.
        "b0-ep": ep("b0", { maxConcurrency: 1 }),
        "b1-ep": ep("b1"),
        // K15 (#441): the dynamic contextLimit endpoints.
        "ctx-ep": ep("ctx", { contextLimit: 262144 }),
        "ctx-both-ep": ep("ctxb", { contextLimit: 262144, maxOutputTokens: 8000 }),
        // K22 (#565): a SMALL declared window that must not drive the census.
        "small-ep": ep("sm", { contextLimit: 32768 }),
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
    const tag = url
      .slice(UPSTREAM_BASE.length + 1)
      .split("/")[0]
      .slice(0, 4); // nm / s0 / s1 / b0 / b1 / cap / capa
    calls[tag] = (calls[tag] ?? 0) + 1;
    if (init?.body) {
      try {
        (upstreamBodies[tag] ??= []).push(JSON.parse(init.body));
      } catch {
        // not JSON — ignore
      }
    }
    const answer = upstreamAnswer[tag];
    if (answer) return answer();
    return okSse(`ok-from-${tag}`, `fake-${tag}`);
  }) as typeof fetch;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (
        line.includes("[Failover]") ||
        line.includes("[StepBusy]") ||
        line.includes("[ContextGuard]") ||
        line.includes("[ContextAdmission]") ||
        line.includes("[MediaCap]") // #575
      ) {
        markerLog.push(line);
      }
    }
    return realStderrWrite(chunk, ...rest);
  }) as any;
  console.log = ((...args: any[]) => {
    const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    for (const line of text.split("\n")) {
      if (
        line.includes("[Failover]") ||
        line.includes("[StepBusy]") ||
        line.includes("[ContextGuard]") ||
        line.includes("[ContextAdmission]") ||
        line.includes("[MediaCap]") // #575
      ) {
        markerLog.push(line);
      }
    }
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

// ---- the pins -------------------------------------------------------------------

describe("#431 — a cascade step that cannot take the request skips forward", () => {
  test("K1: vLLM context-overflow 400 on a non-last step → successor serves, no re-attempt, no failure mark, dwell yields", async () => {
    await spin();
    resetCascade();
    // The nominal must WALL for the cascade to engage (AUTO arms on a
    // qualifying refusal, it is not always-armed) — same contract as the
    // wall-surface harness.
    upstreamAnswer.nm = () => quotaWall402();
    // First a healthy s0 turn (pins the session at step 0), then the overflow.
    let s0Calls = 0;
    upstreamAnswer.s0 = () => (s0Calls++ === 0 ? okSse("ok-from-s0", "fake-s0") : vllmContextOverflow400());

    // 1. Healthy request from sess-one — served by s0, session pinned at 0.
    const r0 = await postMessage({ session: "sess-one" });
    expect(r0.status).toBe(200);
    expect(await responseText(r0)).toContain("ok-from-s0");
    expect(getSessionDwellPinForTests("sonnet", "sess-one")?.stepIndex).toBe(0);

    // 2. THE PIN: the oversized request is answered by the SUCCESSOR, never
    //    the recovery notice, never a second s0 round-trip.
    const big = "x".repeat(400_000); // est ≈ 100k+ tokens — over any 262k cap when doubled? est = len/4 ≈ 100k; the refusal is the upstream's word, not ours.
    const r1 = await postMessage({ session: "sess-one", content: `read: ${big}` });
    expect(r1.status).toBe(200);
    // CR B1: the condensation notice names the step that SERVED the turn. The
    // "served by **…**" anchor is load-bearing — the correct notice still
    // names s0 in its "ahead of it" enumeration, so a bare label assert would
    // pass on the defect too (the general resolver announced s0's name here).
    const t1 = await responseText(r1);
    expect(t1).toContain("ok-from-s1"); // (the armed failover notice rides block 0)
    expect(t1).toContain("served by **s1-ep@fake-s1**");
    expect(t1).not.toContain("served by **s0-ep@fake-s0**");
    // Exactly ONE overflow round-trip to s0 (the vllm ask: no local retry, no
    // re-attempt of the skipped step for the same request).
    expect(calls.s0).toBe(2); // healthy turn + the refused one
    expect(calls.s1).toBe(1);
    expect(calls.nm).toBe(1); // armed once, then the bucket wall holds
    // AC4: the countable marker, forceConsole, with the estimate and the cap.
    const skipLine = markerLog.find((l) => l.includes("[Failover] SKIP sonnet[0]"));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain("reason=context");
    expect(skipLine).toContain("est=");
    expect(skipLine).toContain("cap=262144");
    // AC1: no dwell pin on the SKIPPED step — the pin yielded at the skip and
    // re-pinned at the successor that now serves this session.
    const pin = getSessionDwellPinForTests("sonnet", "sess-one");
    expect(pin === null || pin.stepIndex !== 0).toBe(true);
    expect(
      markerLog.some((l) => l.includes("DWELL sonnet") && l.includes("skipped for this request"))
    ).toBe(true);

    // 2b. CR B1, STREAM channel: a follow-up streaming request of the same
    // session is served by s1 (dwell pin) — the block-0 notice names s1. The
    // "as " anchor matters: the correct notice enumerates s0 in its "ahead of
    // you" tail, exactly like the condensation one.
    const r1s = await postMessage({ session: "sess-one", stream: true, content: "streaming follow-up" });
    const sse1 = await responseSseText(r1s);
    expect(sse1).toContain("ok-from-s1");
    expect(sse1).toContain("as s1-ep@fake-s1");
    expect(sse1).not.toContain("as s0-ep@fake-s0");
    expect(calls.s1).toBe(2);

    // 3. No failure mark: a FRESH session's next request resolves step 0
    //    again (a markStepFailed would TTL-freeze it for 10 min). The learned
    //    cap must be reset first — the cap, not a mark, is what legitimately
    //    short-circuits an identical-size request.
    resetOverflowCapsForTests();
    upstreamAnswer.s0 = () => okSse("ok-from-s0-again", "fake-s0");
    const r2 = await postMessage({ session: "sess-two" });
    expect(await responseText(r2)).toContain("ok-from-s0-again");
    expect(calls.s0).toBe(3);
  }, 30_000);

  test("K2 (compaction, stream:false): the JSON answer is the successor's, never the recovery notice as the summary", async () => {
    await spin();
    resetCascade();
    upstreamAnswer.nm = () => quotaWall402();
    upstreamAnswer.s0 = () => vllmContextOverflow400();

    // /compact is the stream:false caller; CC's compact threshold (0.95 ×
    // 280k window) is above Swift's 262 144, so the compact request IS the
    // oversized one by construction.
    const r1 = await postMessage({ session: "sess-comp", stream: false, content: "summarize " + "y".repeat(400_000) });
    expect(r1.status).toBe(200);
    const text = await responseText(r1);
    expect(text).toContain("ok-from-s1");
    // CR B1: the appended notice names the SERVED step (same anchor rule as K1).
    expect(text).toContain("served by **s1-ep@fake-s1**");
    expect(text).not.toContain("served by **s0-ep@fake-s0**");
    // The recovery notice must not ride as the summary — the successor's own
    // words are the answer, and the marker proves the skip fired.
    expect(text).not.toContain("exceeded the serving model's maximum prompt size");
    expect(markerLog.some((l) => l.includes("[Failover] SKIP sonnet[0] reason=context"))).toBe(true);
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(1);
  }, 30_000);

  test("K3: the learned-cap short-circuit skips forward with ZERO upstream round-trips", async () => {
    await spin();
    resetCascade();
    upstreamAnswer.nm = () => quotaWall402();
    upstreamAnswer.s0 = () => vllmContextOverflow400();

    // First oversized request: pays one round-trip, learns the cap, skips.
    const r1 = await postMessage({ session: "sess-sc", content: "z".repeat(400_000) });
    expect(await responseText(r1)).toContain("ok-from-s1"); // notice rides block 0

    expect(calls.s0).toBe(1);

    // Second oversized request: same (provider, model) — the learned cap
    // short-circuits BEFORE any fetch, and the skip still advances.
    // A FRESH session: r1's dwell pin points at s1 and would bypass s0
    // entirely — the short-circuit is only consulted when step 0 is resolved.
    const r2 = await postMessage({ session: "sess-sc-2", content: "w".repeat(400_000) });
    expect(await responseText(r2)).toContain("ok-from-s1");
    expect(calls.s0).toBe(1); // unchanged — zero new round-trips
    expect(
      markerLog.some((l) => l.includes("[ContextGuard] short-circuit"))
    ).toBe(true);
    expect(markerLog.filter((l) => l.includes("[Failover] SKIP sonnet[0] reason=context")).length).toBe(2);
  }, 30_000);

  test("K4: overflow on the LAST step keeps the recovery turn (today's behavior), single round-trip", async () => {
    await spin();
    resetCascade(cascadeEnv("s0-ep@fake-s0")); // single-step cascade
    upstreamAnswer.nm = () => quotaWall402();
    upstreamAnswer.s0 = () => vllmContextOverflow400();

    const r1 = await postMessage({ session: "sess-last" });
    // The recovery turn IS the answer on the last step: HTTP 200, factual
    // notice, usage advanced so the client's gauge crosses its threshold.
    expect(r1.status).toBe(200);
    const body: any = await r1.json(); // read ONCE — a clone after the body is consumed is empty
    const text = (body?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
    expect(text).toContain("exceeded the serving model's maximum prompt size");
    expect(body?.usage?.input_tokens).toBeGreaterThan(0);
    // No retry loop: exactly one round-trip, no SKIP marker (nothing to skip TO).
    expect(calls.s0).toBe(1);
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);
  }, 30_000);

  test("K5: non-cascade path unchanged — the nominal's overflow is the recovery turn", async () => {
    await spin();
    resetCascade(); // cascade configured, but the request names a concrete model
    upstreamAnswer.nm = () => vllmContextOverflow400();

    const r1 = await postMessage({ model: "nom-ep@fake-nom", session: "sess-direct" });
    expect(r1.status).toBe(200);
    const text = await responseText(r1);
    expect(text).toContain("exceeded the serving model's maximum prompt size");
    expect(calls.nm).toBe(1);
    expect(calls.s0 ?? 0).toBe(0);
    expect(calls.s1 ?? 0).toBe(0);
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);
  }, 30_000);

  test("K7 (AC2): maxOutputTokens clamps max_tokens on the wire — openai and anthropic formats", async () => {
    await spin();
    resetFailoverForTests({}); // no cascade — the direct endpoint is the point
    setRoleNominalResolver(() => undefined);

    // OpenAI wire: 32000 → 8192 before it leaves.
    const r1 = await postMessage({ model: "cap-ep@fake-cap", maxTokens: 32000 });
    expect(r1.status).toBe(200);
    expect(upstreamBodies.cap?.length).toBe(1);
    expect(upstreamBodies.cap[0].max_tokens).toBe(8192);
    // Never clamps UP: a smaller ask passes verbatim.
    await postMessage({ model: "cap-ep@fake-cap", maxTokens: 100 }); // body inspected, answer unused
    expect(upstreamBodies.cap[1].max_tokens).toBe(100);

    // Anthropic wire: same clamp from the same field.
    upstreamAnswer.capa = () => vllmContextOverflow400();
    const r3 = await postMessage({ model: "cap-anthropic-ep@fake-capa", maxTokens: 32000 });
    expect(r3.status).toBe(200); // recovery turn — the clamp is the pin, not the answer
    expect(upstreamBodies.capa?.length).toBe(1);
    expect(upstreamBodies.capa[0].max_tokens).toBe(8192);
    // And an endpoint WITHOUT the field keeps the verbatim passthrough.
    await postMessage({ model: "s0-ep@fake-s0", maxTokens: 32000 }); // body inspected, answer unused
    expect(upstreamBodies.s0[0].max_tokens).toBe(32000);
  }, 30_000);

  test("K15 (#441): contextLimit clamps max_tokens to the window remainder — dynamic, composed, inert when absent", async () => {
    await spin();
    resetFailoverForTests({}); // direct endpoints, no cascade
    setRoleNominalResolver(() => undefined);

    // The RX95 compaction shape: ~249 850 prompt tokens (999 400 chars / 4,
    // the house estimator's convention) against a 262 144 Swift window —
    // vLLM refuses any prompt + max_tokens over the window without trimming
    // (vllm#110). Fleet-standard compact ask: max_tokens 16384.
    const rx95Prompt = "y".repeat(999_400);

    // 1. THE DoD PIN: the shipped max_tokens fits the remainder.
    //    262144 − est(~249 880) − max(2048, est/64 ≈ 3 905) ≈ 8 360 — the
    //    margin is PROPORTIONAL (pre-review #442): a fixed 2048 would ship
    //    ~10 246 and turn this assert red. Bounds [7 500, 8 400] absorb the
    //    envelope-JSON drift of the /4 estimate without touching either class.
    await postMessage({ model: "ctx-ep@fake-ctx", maxTokens: 16384, content: rx95Prompt });
    expect(upstreamBodies.ctx?.length).toBe(1);
    const shipped = upstreamBodies.ctx[0].max_tokens;
    expect(shipped).toBeLessThanOrEqual(8_400);
    expect(shipped).toBeGreaterThan(7_500);
    expect(shipped).toBeLessThan(16_384); // actually clamped

    // 2. Byte-identical when the field is absent: same oversized prompt on a
    //    plain endpoint ships max_tokens verbatim (pre-#441 behavior).
    await postMessage({ model: "s0-ep@fake-s0", maxTokens: 16384, content: rx95Prompt });
    expect(upstreamBodies.s0[0].max_tokens).toBe(16_384);

    // 3. Composition with the #431 static cap: smallest wins (8000 < ~10246).
    await postMessage({ model: "ctx-both-ep@fake-ctxb", maxTokens: 16384, content: rx95Prompt });
    expect(upstreamBodies.ctxb[0].max_tokens).toBe(8_000);

    // 4. Never clamps down a small ask: 100 < remainder → verbatim.
    await postMessage({ model: "ctx-ep@fake-ctx", maxTokens: 100, content: "say hi" });
    expect(upstreamBodies.ctx[1].max_tokens).toBe(100);

    // 5. Stand-down when the prompt leaves no output budget: the clamp must not
    //    fire (max_tokens verbatim); the upstream refusal + context-overflow
    //    recovery own it. #565 moved the boundary this case probes: a prompt
    //    ABOVE the window by more than the proportional margin is now refused
    //    at admission (K20) and never reaches the endpoint, so the stand-down
    //    is pinned in the band that still reaches upstream — est just under the
    //    window, where `contextLimit − est − max(2048, est/64)` goes negative
    //    (262 144 − 258 250 − 4 035 ≈ −141 body-only; ≈ −160 with the JSON
    //    wrapper, review 21/10 — same sign, same stand-down branch) but the census does not refuse.
    await postMessage({ model: "ctx-ep@fake-ctx", maxTokens: 16384, content: "z".repeat(1_033_000) });
    expect(upstreamBodies.ctx[2].max_tokens).toBe(16_384);
  }, 30_000);

  test("K16 (#442 CR): a base64 image does not eat the window — the clamp estimate allocates 1600/block, not base64/4", async () => {
    await spin();
    resetFailoverForTests({}); // direct endpoints, no cascade
    setRoleNominalResolver(() => undefined);

    // The review's measured shape (c.6114982206): "describe this screenshot"
    // + a ~1 MB base64 PNG — the /4 estimate charges ~250k for a block whose
    // real cost is ~1.5k (vision lane) or ~0 (described/stripped by the
    // vision fallback). With the fixed 1600-allocation the estimate stays
    // ~2k → the ask ships VERBATIM (no clamp), the turn is not truncated.
    //
    // Calibration note: the image is 1.00 MB (not the review's 1.03) so the
    // MUTATION stays visible — with the useful-floor guard in force, a
    // base64/4 estimate of ~258k yields dynamicCap ~113 < 4096 and the
    // stand-down would mask the bug (verbatim in BOTH worlds). At 1.00 MB
    // the mutated dynamicCap lands at ~8 200 ≥ 4 096: fix = verbatim 16384,
    // mutation = clamped ~8 200. The pin bites.
    const oneMbPng = "A".repeat(1_000_000);
    await postMessage({
      model: "ctx-ep@fake-ctx",
      maxTokens: 16384,
      contentBlocks: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: oneMbPng } },
        { type: "text", text: "describe this screenshot" },
      ],
    });
    expect(upstreamBodies.ctx?.length).toBe(1);
    // THE PIN: not clamped — an image block is worth MEDIA_BLOCK_TOKENS, not
    // its base64 length / 4.
    expect(upstreamBodies.ctx[0].max_tokens).toBe(16_384);
  }, 30_000);

  test("K17 (#442 CR): below a useful floor the clamp stands down — the refusal stays skippable", async () => {
    await spin();
    resetFailoverForTests({});
    setRoleNominalResolver(() => undefined);

    // est = 1_024_000/4 = 256_000 → margin = max(2048, 4000) = 4_000 →
    // dynamicCap = 262_144 − 256_000 − 4_000 = 2_144 ∈ [1, 4_096). The old
    // guard (dynamicCap ≥ 1) clamped 16384 → 2144: a truncated 200 standing
    // in for a recoverable refusal — the exact shape #431 closed (SKIP
    // reason=context must stay reachable on a non-last step; on /compact a
    // truncated "summary"). The floor min(asked, 4096) stands the clamp down.
    await postMessage({ model: "ctx-ep@fake-ctx", maxTokens: 16384, content: "w".repeat(1_024_000) });
    expect(upstreamBodies.ctx?.length).toBe(1);
    expect(upstreamBodies.ctx[0].max_tokens).toBe(16_384); // verbatim — floor stands down
  }, 30_000);

  test("K8 (AC3): saturated limiter on a non-last step → bounded wait, skip to the successor, no failure mark", async () => {
    await spin();
    resetCascade(cascadeEnv("b0-ep@fake-b0>b1-ep@fake-b1"));
    process.env.CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS = "100";
    upstreamAnswer.nm = () => quotaWall402();
    // Call #0 holds b0's single slot until released; later calls answer ok —
    // a per-call holder would leave EVERY later fetch pending forever.
    let holderResolve: ((r: Response) => void) | undefined;
    let b0Call = 0;
    upstreamAnswer.b0 = () =>
      b0Call++ === 0
        ? new Promise<Response>((resolve) => { holderResolve = resolve; })
        : Promise.resolve(okSse("ok-from-b0", "fake-b0"));

    const r1p = postMessage({ session: "sess-hold", content: "hold the slot" });
    // Let r1 reach b0 and take the slot (nm → armed → step 0 dispatch).
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.b0).toBe(1);

    const t0 = Date.now();
    const r2 = await postMessage({ session: "sess-two-busy" });
    const waited = Date.now() - t0;
    // THE PIN: r2 is served by the SUCCESSOR after a bounded wait — not held
    // for the holder's whole lease, not answered from b0.
    expect(await responseText(r2)).toContain("ok-from-b1");
    expect(waited).toBeLessThan(1000); // ~the 100 ms bound, never the 1.2 s lease
    expect(calls.b1).toBe(1);
    expect(
      markerLog.some((l) => l.includes("[Failover] SKIP sonnet[0] reason=busy") && l.includes("wait=100ms"))
    ).toBe(true);
    expect(markerLog.some((l) => l.includes("[StepBusy]"))).toBe(true);
    // No failure mark: a fresh session's request resolves b0 again once the
    // slot is free (a mark would TTL-freeze it for 10 min).
    holderResolve?.(okSse("ok-from-b0", "fake-b0"));
    await r1p;
    const r3 = await postMessage({ session: "sess-three-busy" });
    expect(await responseText(r3)).toContain("ok-from-b0");
    expect(calls.b0).toBe(2);
  }, 30_000);

  test("K9 (AC3): the nominal path keeps its unbounded FIFO — a saturated nominal waits, no busy 529", async () => {
    await spin();
    resetFailoverForTests({}); // NO cascade — the endpoint is the nominal target
    setRoleNominalResolver(() => undefined);
    process.env.CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS = "100";
    let holderResolve: ((r: Response) => void) | undefined;
    let b0Call = 0;
    upstreamAnswer.b0 = () =>
      b0Call++ === 0
        ? new Promise<Response>((resolve) => { holderResolve = resolve; })
        : Promise.resolve(okSse("ok-from-b0", "fake-b0"));

    const r1p = postMessage({ model: "b0-ep@fake-b0", content: "hold" });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.b0).toBe(1);

    // With the bound wrongly applied here, this would 529 at ~100 ms. It must
    // WAIT for the slot and serve — that is today's nominal behavior.
    let r2done = false;
    const r2p = postMessage({ model: "b0-ep@fake-b0", content: "waiter" }).then((r) => {
      r2done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(r2done).toBe(false); // still queued — no silent timeout
    holderResolve?.(okSse("ok-from-b0", "fake-b0"));
    const r2 = await r2p;
    expect(r2.status).toBe(200);
    expect(await responseText(r2)).toContain("ok-from-b0");
    expect(markerLog.some((l) => l.includes("[StepBusy]"))).toBe(false);
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);
    await r1p;
  }, 30_000);

  test("K11: kill switch CLAUDISH_FAILOVER_STEP_SKIP=0 restores today's behavior — context and busy", async () => {
    await spin();
    resetCascade();
    process.env.CLAUDISH_FAILOVER_STEP_SKIP = "0";
    upstreamAnswer.nm = () => quotaWall402();

    // Context: the overflow recovery turn IS the client's answer again.
    upstreamAnswer.s0 = () => vllmContextOverflow400();
    const r1 = await postMessage({ session: "sess-ks", content: "k".repeat(400_000) });
    expect(r1.status).toBe(200);
    expect(await responseText(r1)).toContain("exceeded the serving model's maximum prompt size");
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);

    // Busy: the marking is suppressed too — a step attempt keeps its
    // unbounded FIFO instead of a busy 529.
    process.env.CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS = "100";
    resetCascade(cascadeEnv("b0-ep@fake-b0>b1-ep@fake-b1"));
    resetOverflowCapsForTests();
    let holderResolve: ((r: Response) => void) | undefined;
    let b0Call = 0;
    upstreamAnswer.b0 = () =>
      b0Call++ === 0
        ? new Promise<Response>((resolve) => { holderResolve = resolve; })
        : Promise.resolve(okSse("ok-late-b0", "fake-b0"));
    const rh = postMessage({ session: "sess-ks-hold", content: "hold" });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.b0).toBe(1);
    let r2done = false;
    const r2p = postMessage({ session: "sess-ks-busy" }).then((r) => {
      r2done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(r2done).toBe(false); // still queued — the switch suppressed the bound
    holderResolve?.(okSse("ok-from-b0", "fake-b0"));
    const r2 = await r2p;
    expect(await responseText(r2)).toContain("ok-late-b0"); // waited for the slot — no skip
    expect(markerLog.some((l) => l.includes("reason=busy"))).toBe(false);
    await rh;
  }, 30_000);

  test("K12 (CR S2/S3): busy on the LAST step waits unbounded — no 529 skip, the turn itself is the answer", async () => {
    await spin();
    resetCascade(cascadeEnv("b0-ep@fake-b0")); // single-step: b0 IS the last step
    process.env.CLAUDISH_FAILOVER_STEP_BUSY_WAIT_MS = "100";
    upstreamAnswer.nm = () => quotaWall402();
    let holderResolve: ((r: Response) => void) | undefined;
    let b0Call = 0;
    upstreamAnswer.b0 = () =>
      b0Call++ === 0
        ? new Promise<Response>((resolve) => { holderResolve = resolve; })
        : Promise.resolve(okSse("ok-from-b0", "fake-b0"));

    const r1p = postMessage({ session: "sess-last-hold", content: "hold the slot" });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.b0).toBe(1);

    // Pre-CR marking armed the bound on the last step too: this 529'd at
    // ~100 ms with no successor to advance to — the skip predicate refusing
    // to advance is what kept it from looping, so the client just lost the
    // wait AND the turn. The last step keeps the unbounded FIFO (the re-mark
    // clears any bound an earlier attempt of the SAME request set).
    let r2done = false;
    const r2p = postMessage({ session: "sess-last-wait", content: "waiter" }).then((r) => {
      r2done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(r2done).toBe(false); // still queued — no bounded 529
    expect(markerLog.some((l) => l.includes("[StepBusy]"))).toBe(false);
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);
    holderResolve?.(okSse("ok-from-b0", "fake-b0"));
    const r2 = await r2p;
    expect(r2.status).toBe(200);
    expect(await responseText(r2)).toContain("ok-from-b0");
    await r1p;
  }, 30_000);

  test("K13 (CR S5a): overflow on the NOMINAL with a cascade configured — the recovery turn is the answer, the skip never fires", async () => {
    await spin();
    resetCascade(); // TWO_STEP configured — the request resolves the NOMINAL first
    upstreamAnswer.nm = () => vllmContextOverflow400();

    // The skip predicate requires stepIndex >= 0: a nominal (stepIndex -1)
    // overflow never advances, even with two healthy steps configured beneath
    // it. Without that guard the loop would divert a nominal context overflow
    // to step 0 — the client asked for the nominal and got a substitute with
    // no refusal to justify it.
    const r1 = await postMessage({ session: "sess-nom-ovf", content: "n".repeat(400_000) });
    expect(r1.status).toBe(200);
    expect(await responseText(r1)).toContain("exceeded the serving model's maximum prompt size");
    expect(calls.s0 ?? 0).toBe(0);
    expect(calls.s1 ?? 0).toBe(0);
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);
  }, 30_000);

  test("K25 (#575): the engine's image cap skips forward — no failure mark, no bench", async () => {
    await spin();
    resetCascade();
    upstreamAnswer.nm = () => quotaWall402();
    upstreamAnswer.s0 = () => vllmImageCap400();

    // Five screenshots: the cap counts BLOCKS, so the marker must report 5
    // against the engine's stated 4 — the number the client can act on.
    const five = Array.from({ length: 5 }, () => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A".repeat(1024) },
    }));
    const r1 = await postMessage({
      session: "sess-media",
      contentBlocks: [...five, { type: "text", text: "what do these show?" }],
    });
    // The successor's answer, never the engine's 400 — a 400 here would end the
    // agent turn on a shape the next step serves perfectly.
    expect(r1.status).toBe(200);
    expect(await responseText(r1)).toContain("ok-from-s1");
    expect(calls.s0).toBe(1);
    expect(calls.s1).toBe(1);
    const skipLine = markerLog.find((l) => l.includes("[Failover] SKIP sonnet[0]"));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain("reason=media");
    expect(skipLine).toContain("images=5");
    expect(skipLine).toContain("cap=4");
    expect(skipLine).toContain("param=image");
    expect(markerLog.some((l) => l.includes("[MediaCap]"))).toBe(true);

    // No failure mark (#553's bench is exactly what this class must not arm):
    // a FRESH session's next request resolves step 0 again.
    upstreamAnswer.s0 = () => okSse("ok-from-s0-again", "fake-s0");
    const r2 = await postMessage({ session: "sess-media-2" });
    expect(await responseText(r2)).toContain("ok-from-s0-again");
    expect(calls.s0).toBe(2);
  }, 30_000);

  test("K26 (#575): on the LAST step the 400 surfaces with the exact label and the skip header", async () => {
    await spin();
    resetCascade(cascadeEnv("s0-ep@fake-s0")); // single-step cascade — nothing to advance to
    upstreamAnswer.nm = () => quotaWall402();
    upstreamAnswer.s0 = () => vllmImageCap400();

    const r1 = await postMessage({
      session: "sess-media-last",
      contentBlocks: [
        ...Array.from({ length: 5 }, () => ({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "A".repeat(1024) },
        })),
        { type: "text", text: "what do these show?" },
      ],
    });
    expect(r1.status).toBe(400);
    // The marker rides the surface path too (harmless to a client that ignores
    // it, greppable for one that looks — same doctrine as the failover notice).
    expect(r1.headers.get("x-claudish-step-skip")).toContain("media");
    const body: any = await r1.json();
    const message = String(body?.error?.message ?? "");
    // The exact label replaced BOTH the engine's jargon and the generic
    // "Request format may be incompatible with provider" that sent the 20/10
    // diagnosis thread hunting a translation bug.
    expect(message).toContain("at most 4 image(s)");
    expect(message).toContain("carries 5");
    expect(message).not.toContain("Request format may be incompatible");
    // Single round-trip, no SKIP marker: there is no successor to advance to.
    expect(calls.s0).toBe(1);
    expect(markerLog.some((l) => l.includes("[Failover] SKIP"))).toBe(false);
  }, 30_000);
});

/**
 * #565 — admission census over DECLARED windows.
 *
 * Incident 2026-10-20: a 1.2k-message `/compact` turn (~1.1M tokens) reached the
 * hub and came back as MiniMax's opaque `400 Input too large` — a diagnosis
 * thread went looking for a remap that did not exist. No lane here has a window
 * near that size, so the request was doomed at admission; the proxy can say so
 * itself, with numbers, before paying the round-trip.
 *
 * Mutation proofs:
 *  - n1: drop the census block ⇒ K20 red (the request reaches the endpoint).
 *  - n2: weigh the SMALLEST declared window instead of the largest ⇒ K22 red
 *    (a servable 100k prompt is refused because a 32k step sits on the path).
 *  - n3: stop counting a bare/native target as an undeclared candidate ⇒ K24
 *    red (a bare claude-* nominal is overruled by a cascade step's declared
 *    bound).
 *  - n4: drop the kill-switch gate ⇒ K23 red.
 *  - n5 (hub 22/10): ignore the undeclared count (weigh the declared subset)
 *    ⇒ K25 red — the CoursIA-2 shape, refused while its nominal could serve.
 *  - n6: collect a `role:` step as its last-refreshed `target` instead of its
 *    target role's whole path ⇒ K26 red (a doomed, fully-declared delegation
 *    pays its round-trips); n6b: skip the target role's nominal ⇒ K26b red.
 */
describe("#565 — a request no declared window can take is refused at admission", () => {
  test("K20: oversized prompt on a path where EVERY candidate declares → labeled recovery turn, ZERO upstream calls", async () => {
    // The nominal declares 262 144, the step 32 768: nothing on the path is
    // invisible to the census, so the request is doomed on every candidate.
    await spin({ sonnet: "ctx-ep@fake-ctx" });
    resetCascade(cascadeEnv("small-ep@fake-sm"));

    const r = await postMessage({ session: "sess-adm", content: "x".repeat(1_200_000) }); // est ≈ 300k
    expect(r.status).toBe(200); // the recoverable turn, never a bare 400 (#79)
    const text = await responseText(r);
    expect(text).toContain("[claudish] Input of ~");
    expect(text).toContain("exceeds every declared context window");
    expect(text).toContain("262144");
    expect(text).toContain("ctx-ep");
    // The whole point: not one round-trip, on any candidate.
    expect(calls.nm ?? 0).toBe(0);
    expect(calls.ctx ?? 0).toBe(0);
    expect(calls.sm ?? 0).toBe(0);
    // Countable marker, forceConsole.
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(true);
  }, 30_000);

  test("K20b (stream:true): the same refusal is a well-formed SSE turn ending in message_stop", async () => {
    await spin({ sonnet: "ctx-ep@fake-ctx" });
    resetCascade(cascadeEnv("small-ep@fake-sm"));

    const r = await postMessage({ session: "sess-adm-s", stream: true, content: "x".repeat(1_200_000) });
    expect(r.status).toBe(200);
    const raw = await r.text();
    expect(raw).toContain("event: message_start");
    expect(raw).toContain("event: message_stop"); // never-hang invariant
    expect(raw).toContain("exceeds every declared context window");
    expect(calls.ctx ?? 0).toBe(0);
  }, 30_000);

  test("K20c (/v1/chat/completions): the translated ingress refuses at admission too — zero upstream calls, [DONE]-terminated", async () => {
    await spin();
    resetCascade(cascadeEnv("ctx-ep@fake-ctx>s1-ep@fake-s1"));

    // The both-ingresses claim was structurally verified (shared handleWithCascade)
    // but never RUN for the OpenAI wire — review 21/10, non-blocking 3.
    const r = await realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ctx-ep@fake-ctx",
        stream: true,
        messages: [{ role: "user", content: "x".repeat(1_200_000) }], // est ≈ 300k
      }),
    });
    expect(r.status).toBe(200);
    const raw = await r.text();
    // A well-formed OpenAI SSE stream that TERMINATES — never a hung stream.
    expect(raw).toContain("data: ");
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(raw).toContain("exceeds every declared context window");
    // The whole point survives the translation: no round-trip on any candidate.
    expect(calls.ctx ?? 0).toBe(0);
    expect(calls.s1 ?? 0).toBe(0);
    expect(calls.nm ?? 0).toBe(0);
  }, 30_000);

  test("K25 (hub 22/10): an UNDECLARED candidate on the path stands the census down — the nominal serves", async () => {
    // The shape that blocked a CoursIA-2 session at ~270k tokens: the nominal
    // declares nothing, a non-last step declares 262 144, the last step
    // declares nothing. Refusing on the declared subset vetoed two candidates
    // the census could not see — and `/compact` with them.
    await spin();
    resetCascade(cascadeEnv("ctx-ep@fake-ctx>s1-ep@fake-s1"));

    const r = await postMessage({ session: "sess-adm-undecl", content: "x".repeat(1_200_000) }); // est ≈ 300k
    expect(r.status).toBe(200);
    expect(await responseText(r)).not.toContain("exceeds every declared context window");
    expect(calls.nm ?? 0).toBe(1); // the undeclared nominal got its chance
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(false);
  }, 30_000);

  test("K26: a `role:` step is weighed as its target's WHOLE path — fully declared and too small, it is refused", async () => {
    // sonnet: ctx-ep (262 144) > small-ep (32 768) > role:haiku, whose nominal
    // is ctx-ep again and which has no cascade of its own. Every candidate the
    // delegation can reach declares a window, so the request is doomed. A
    // census that counted the role step as one opaque candidate would stand
    // down and pay three round-trips to learn it.
    await spin({ sonnet: "ctx-ep@fake-ctx", haiku: "ctx-ep@fake-ctx" });
    resetCascade(cascadeEnv("small-ep@fake-sm>role:haiku"));

    const r = await postMessage({ session: "sess-adm-role", content: "x".repeat(1_200_000) }); // est ≈ 300k
    expect(r.status).toBe(200);
    expect(await responseText(r)).toContain("exceeds every declared context window");
    expect(calls.ctx ?? 0).toBe(0);
    expect(calls.sm ?? 0).toBe(0);
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(true);
  }, 30_000);

  test("K26b: a `role:` step whose target path holds an undeclared candidate stands the census down", async () => {
    // Same path, but haiku's nominal declares nothing: the delegation can reach
    // a candidate the census cannot see.
    await spin({ sonnet: "ctx-ep@fake-ctx", haiku: "s1-ep@fake-s1" });
    resetCascade(cascadeEnv("small-ep@fake-sm>role:haiku"));

    const r = await postMessage({ session: "sess-adm-role-open", content: "x".repeat(1_200_000) });
    expect(r.status).toBe(200);
    expect(await responseText(r)).not.toContain("exceeds every declared context window");
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(false);
  }, 30_000);

  test("K22: the LARGEST declared window decides — a servable prompt is not refused by a small step", async () => {
    // Every candidate declares (nominal 262 144, step 32 768), so the census
    // really weighs — an undeclared one would stand it down before n2 matters.
    await spin({ sonnet: "ctx-ep@fake-ctx" });
    resetCascade(cascadeEnv("small-ep@fake-sm"));
    const r = await postMessage({ session: "sess-adm-ok", content: "q".repeat(400_000) }); // est ≈ 100k
    expect(r.status).toBe(200);
    // Served, not refused: the 100k prompt fits ctx-ep's 262 144, so the
    // census weighs the largest window and lets the request through.
    expect(await responseText(r)).not.toContain("exceeds every declared context window");
    expect(calls.ctx ?? 0).toBe(1); // not armed ⇒ the nominal serves, as today
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(false);
  }, 30_000);

  test("K23: kill switch CLAUDISH_CONTEXT_ADMISSION=0 restores today's behaviour", async () => {
    // K20's fully-declared path, which the census would refuse.
    await spin({ sonnet: "ctx-ep@fake-ctx" });
    resetCascade(cascadeEnv("small-ep@fake-sm"));
    process.env.CLAUDISH_CONTEXT_ADMISSION = "0";

    const r = await postMessage({ session: "sess-adm-off", content: "x".repeat(1_200_000) });
    expect(r.status).toBe(200);
    expect(await responseText(r)).not.toContain("exceeds every declared context window");
    expect(calls.ctx ?? 0).toBe(1); // the doomed round-trip happens again — today's behaviour
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(false);
  }, 30_000);

  test("K24: a NATIVE nominal is never overruled by a cascade step's declared bound", async () => {
    // An EMPTY modelMap: `claude-sonnet-5` stays a bare string, so the nominal
    // target is the native lane — whose window (1M on the Claude 5 family)
    // declares nothing and dwarfs the 262 144 on this role's cascade step. The
    // census must therefore stand down: the client named a model that can take
    // the prompt, and a smaller substitute step must not veto it. Both steps
    // declare, so the native nominal is the ONLY undeclared candidate.
    await spin({});
    resetCascade(cascadeEnv("ctx-ep@fake-ctx>small-ep@fake-sm"));
    const r = await postMessage({ model: "claude-sonnet-5", session: "sess-adm-native", content: "x".repeat(1_200_000) });
    expect(await responseText(r)).not.toContain("exceeds every declared context window");
    expect(markerLog.some((l) => l.includes("[ContextAdmission] REFUSE"))).toBe(false);
  }, 30_000);
});
