/**
 * #654 unit pins — the in-flight token budget per endpoint.
 *
 * AC1  inert without env (evaluate returns null; no knobs, no registry entry)
 * AC2  refusal shape: reason=sum|big, facts carry the numbers the marker logs
 * AC3  estimator is bytes/3.5 (mutation: /4 must turn the pin red)
 * AC4  a short request passes when only the big-concurrency cap is armed
 * AC5  an identical resubmission REPLACES its predecessor's estimate
 * AC5b resubmit=<k> counts copies, not in-flight leases (a 10× body reads 10)
 * lease lifecycle: commit/release/replace-no-op; stale sweep bounds a leak
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BIG_REQUEST_TOKENS,
  LEASE_MAX_AGE_MS,
  bodySignature,
  clearEndpointTokenBudgets,
  endpointBudgetSnapshot,
  endpointPrefixOf,
  estimateBudgetTokens,
  evaluateEndpointTokenBudget,
  formatBudgetFacts,
  readEndpointBudgetKnobs,
  withBudgetRelease,
} from "./endpoint-token-budget.js";

const scope = { machine: "m1", session: "s1" };

/** A payload whose serialized length is exactly `len` chars (JSON quotes). */
function payloadOfLen(len: number): unknown {
  return "x".repeat(len - 2);
}

beforeEach(() => {
  clearEndpointTokenBudgets();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CLAUDISH_ENDPOINT_")) delete process.env[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CLAUDISH_ENDPOINT_")) delete process.env[k];
  }
  clearEndpointTokenBudgets();
});

describe("endpoint-token-budget #654", () => {
  // ── AC1: inert without env ─────────────────────────────────────────────
  test("AC1 — no knobs ⇒ evaluate returns null (inert by default)", () => {
    expect(evaluateEndpointTokenBudget("vllm-myia", payloadOfLen(3_500), scope, {})).toBeNull();
    expect(evaluateEndpointTokenBudget("vllm-myia", payloadOfLen(3_500), scope, process.env)).toBeNull();
    expect(endpointBudgetSnapshot()).toEqual({});
  });

  test("AC1 — knob parsing: garbage and 0-Σ are inert, names normalize", () => {
    expect(readEndpointBudgetKnobs("vllm-myia", { CLAUDISH_ENDPOINT_TOKEN_BUDGET_VLLM_MYIA: "abc" })).toBeNull();
    expect(readEndpointBudgetKnobs("vllm-myia", { CLAUDISH_ENDPOINT_TOKEN_BUDGET_VLLM_MYIA: "0" })).toBeNull();
    expect(readEndpointBudgetKnobs("vllm-myia", { CLAUDISH_ENDPOINT_TOKEN_BUDGET_VLLM_MYIA: " 550000 " })).toEqual({
      sumBudget: 550000,
      bigLimit: undefined,
    });
    expect(readEndpointBudgetKnobs("qwen-token-plan", { CLAUDISH_ENDPOINT_BIG_LIMIT_QWEN_TOKEN_PLAN: "3" })).toEqual({
      sumBudget: undefined,
      bigLimit: 3,
    });
    // bigLimit 0 is an explicit operator cap (block every >100K), not unset
    expect(readEndpointBudgetKnobs("ep", { CLAUDISH_ENDPOINT_BIG_LIMIT_EP: "0" })).toEqual({
      sumBudget: undefined,
      bigLimit: 0,
    });
  });

  test("endpointPrefixOf — @-shaped targets only", () => {
    expect(endpointPrefixOf("vllm-myia@swift-1.5-27b:8!own")).toBe("vllm-myia");
    expect(endpointPrefixOf("glm-5.3")).toBeNull();
    expect(endpointPrefixOf(undefined)).toBeNull();
    expect(endpointPrefixOf("@weird")).toBeNull();
  });

  // ── AC3: the estimator ──────────────────────────────────────────────────
  test("AC3 — estimator divides bytes by 3.5 (serialized length)", () => {
    // serialized = 3502 chars (JSON quotes) ⇒ ceil(3502/3.5) = 1001.
    // A /4 estimator reads 876 — this pin is the mutation target.
    expect(estimateBudgetTokens(payloadOfLen(3502))).toBe(1001);
    expect(estimateBudgetTokens(undefined)).toBe(0);
    expect(estimateBudgetTokens(null)).toBe(0);
  });

  test("AC3 — the measured anchor: 914,723 B ⇒ 261,350 (real tokens 262,145, /4 said 228,680)", () => {
    expect(estimateBudgetTokens(payloadOfLen(914_723))).toBe(261_350);
  });

  // ── AC2: refusal shape + lease lifecycle ────────────────────────────────
  test("AC2 — a single request already over Σ refuses alone", () => {
    const env = { CLAUDISH_ENDPOINT_TOKEN_BUDGET_EP: "999" };
    const d = evaluateEndpointTokenBudget("ep", payloadOfLen(3_500), scope, env)!; // est 1000 > 999
    expect(d.refused).toBe(true);
    expect(d.reason).toBe("sum");
    expect(d.facts.sum).toBe(0);
  });

  test("AC2 — a second in-flight request over Σ refuses with reason=sum", () => {
    const env = { CLAUDISH_ENDPOINT_TOKEN_BUDGET_EP: "1500" };
    const p = payloadOfLen(3_500); // est 1000; two ⇒ 2000 > 1500
    const d1 = evaluateEndpointTokenBudget("ep", p, scope, env)!;
    expect(d1.refused).toBe(false);
    const r1 = d1.commit();
    expect(endpointBudgetSnapshot()["ep"]).toEqual({ count: 1, sum: 1000, big: 0 });
    const d2 = evaluateEndpointTokenBudget("ep", p, { machine: "m1", session: "s2" }, env)!;
    expect(d2.refused).toBe(true);
    expect(d2.reason).toBe("sum");
    expect(d2.facts.sum).toBe(1000);
    expect(d2.facts.sumBudget).toBe(1500);
    r1();
    const d3 = evaluateEndpointTokenBudget("ep", p, { machine: "m1", session: "s2" }, env)!;
    expect(d3.refused).toBe(false);
  });

  test("AC2 — refusal detail formats as the marker line", () => {
    const env = { CLAUDISH_ENDPOINT_TOKEN_BUDGET_EP: "1000", CLAUDISH_ENDPOINT_BIG_LIMIT_EP: "1" };
    const pBig = payloadOfLen(355_000); // est 101,429 > BIG_REQUEST_TOKENS
    expect(estimateBudgetTokens(pBig)).toBeGreaterThan(BIG_REQUEST_TOKENS);
    const d = evaluateEndpointTokenBudget("ep", pBig, scope, env)!;
    expect(d.refused).toBe(true);
    const line = formatBudgetFacts(d.facts, d.refused, d.reason);
    expect(line).toContain("est=101429");
    expect(line).toContain("sum=0/1000");
    expect(line).toContain("big=0/1");
    expect(line).toContain("reason=sum");
  });

  // ── AC4: the alternative cap ────────────────────────────────────────────
  test("AC4 — only the big cap armed: a big refusal never blocks a short request", () => {
    const env = { CLAUDISH_ENDPOINT_BIG_LIMIT_EP: "1" };
    const pBig = payloadOfLen(355_000);
    const pShort = payloadOfLen(3_500);
    const d1 = evaluateEndpointTokenBudget("ep", pBig, scope, env)!;
    expect(d1.refused).toBe(false);
    const r1 = d1.commit(); // one big in flight
    const d2 = evaluateEndpointTokenBudget("ep", pBig, { machine: "m1", session: "s2" }, env)!;
    expect(d2.refused).toBe(true);
    expect(d2.reason).toBe("big");
    expect(d2.facts.bigInFlight).toBe(1);
    const d3 = evaluateEndpointTokenBudget("ep", pShort, { machine: "m1", session: "s3" }, env)!;
    expect(d3.refused).toBe(false); // AC4 — the short request passes
    r1();
  });

  // ── AC5 / AC5b: resubmission replaces, never adds ───────────────────────
  test("AC5 — an identical resubmission REPLACES the predecessor's estimate (Σ stays one)", () => {
    const env = { CLAUDISH_ENDPOINT_TOKEN_BUDGET_EP: "1500" };
    const p = payloadOfLen(3_500); // est 1000 — one fits, two would not
    const d1 = evaluateEndpointTokenBudget("ep", p, scope, env)!;
    const r1 = d1.commit();
    const d2 = evaluateEndpointTokenBudget("ep", p, scope, env)!; // same machine+session+body
    expect(d2.facts.replaced).toBe(true);
    expect(d2.facts.resubmit).toBe(2);
    expect(d2.refused).toBe(false); // NOT double-counted: 1000 ≤ 1500
    const r2 = d2.commit();
    expect(endpointBudgetSnapshot()["ep"]).toEqual({ count: 1, sum: 1000, big: 0 });
    r1(); // the predecessor's late release is a no-op — its lease was replaced
    expect(endpointBudgetSnapshot()["ep"]).toEqual({ count: 1, sum: 1000, big: 0 });
    r2();
    expect(endpointBudgetSnapshot()["ep"]).toBeUndefined();
  });

  test("AC5 — a DIFFERENT body still adds its own estimate", () => {
    const env = { CLAUDISH_ENDPOINT_TOKEN_BUDGET_EP: "1500" };
    const d1 = evaluateEndpointTokenBudget("ep", payloadOfLen(3_500), scope, env)!;
    d1.commit();
    const d2 = evaluateEndpointTokenBudget("ep", payloadOfLen(3_600), scope, env)!; // est 1029
    expect(d2.facts.replaced).toBe(false);
    expect(d2.refused).toBe(true); // 1000 + 1029 > 1500
    expect(d2.reason).toBe("sum");
  });

  test("AC5 — a different session is a different signature", () => {
    const env = { CLAUDISH_ENDPOINT_TOKEN_BUDGET_EP: "1500" };
    const p = payloadOfLen(3_500);
    evaluateEndpointTokenBudget("ep", p, scope, env)!.commit();
    const d2 = evaluateEndpointTokenBudget("ep", p, { machine: "m1", session: "other" }, env)!;
    expect(d2.facts.replaced).toBe(false);
    expect(d2.refused).toBe(true);
  });

  test("AC5b — resubmit counts COPIES (a 10× body reads 10), not in-flight leases", () => {
    const env = { CLAUDISH_ENDPOINT_TOKEN_BUDGET_EP: "1000000" };
    const p = payloadOfLen(3_500);
    let last = evaluateEndpointTokenBudget("ep", p, scope, env)!;
    let release = last.commit();
    for (let k = 2; k <= 10; k++) {
      const d = evaluateEndpointTokenBudget("ep", p, scope, env)!;
      expect(d.facts.resubmit).toBe(k);
      expect(d.facts.replaced).toBe(true);
      const prevRelease = release;
      release = d.commit();
      prevRelease(); // no-op (replaced)
      expect(endpointBudgetSnapshot()["ep"].count).toBe(1);
      last = d;
    }
    expect(last.facts.resubmit).toBe(10);
    release();
    // predecessor gone ⇒ a later identical body is fresh demand again
    const dAfter = evaluateEndpointTokenBudget("ep", p, scope, env)!;
    expect(dAfter.facts.resubmit).toBe(1);
    expect(dAfter.facts.replaced).toBe(false);
  });

  // ── lease hygiene ───────────────────────────────────────────────────────
  test("stale sweep — a lease older than LEASE_MAX_AGE_MS stops counting and warns", () => {
    const env = { CLAUDISH_ENDPOINT_TOKEN_BUDGET_EP: "1500" };
    const t0 = 1_000_000;
    const onStale: string[] = [];
    const warn = (m: string) => onStale.push(m);
    evaluateEndpointTokenBudget("ep", payloadOfLen(3_500), scope, env, t0, warn)!.commit();
    // A second DIFFERENT body past the TTL: the first lease is swept first,
    // so it no longer weighs (0 + 1029 ≤ 1500 admits where 1000+1029 would not).
    const d2 = evaluateEndpointTokenBudget(
      "ep",
      payloadOfLen(3_600),
      { machine: "m1", session: "s2" },
      env,
      t0 + LEASE_MAX_AGE_MS + 1,
      warn
    )!;
    expect(d2.facts.sum).toBe(0);
    expect(d2.refused).toBe(false);
    expect(onStale.join("\n")).toContain("dropped 1 stale lease");
    expect(onStale.join("\n")).toContain("1000");
  });

  test("bodySignature — deterministic, payload-sensitive", () => {
    expect(bodySignature({ a: 1 })).toBe(bodySignature({ a: 1 }));
    expect(bodySignature({ a: 1 })).not.toBe(bodySignature({ a: 2 }));
    expect(typeof bodySignature({})).toBe("string");
  });

  // ── withBudgetRelease: the lease dies with the response body ────────────
  test("withBudgetRelease — releases on full read, cancel, upstream error (clean close); bodyless releases at once", async () => {
    // full read
    let n1 = 0;
    const body1 = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hi"));
        c.close();
      },
    });
    const res1 = withBudgetRelease(new Response(body1, { status: 201, headers: { "x-probe": "kept" } }), () => n1++);
    expect(res1.status).toBe(201); // status and headers survive the wrap
    expect(res1.headers.get("x-probe")).toBe("kept");
    await res1.text();
    expect(n1).toBe(1);

    // consumer cancel — the case pipeThrough(TransformStream) misses
    let n2 = 0;
    const body2 = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hi"));
        // never closed
      },
    });
    const res2 = withBudgetRelease(new Response(body2), () => n2++);
    const reader2 = res2.body!.getReader();
    await reader2.read();
    await reader2.cancel();
    expect(n2).toBe(1);

    // upstream stream error (#663 r1 — never-hang): the wrapper CLOSES, it
    // never errors the client-facing controller — `controller.error()` is
    // forbidden in production sources, the inner layer owns message_stop, and
    // this wrapper's only job is the lease. A client reading to the end sees
    // a terminated stream, never a broken pipe.
    let n3 = 0;
    const body3 = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("boom"));
      },
    });
    const res3 = withBudgetRelease(new Response(body3), () => n3++);
    await expect(res3.text()).resolves.toBe(""); // clean close — no throw
    expect(n3).toBe(1); // …and the lease released

    // bodyless response: nothing to track, release immediately
    let n4 = 0;
    withBudgetRelease(new Response(null), () => n4++);
    expect(n4).toBe(1);
  });

  // ── #663 r1: the error case at the raw-reader level, bytes kept ─────────
  test("withBudgetRelease — an upstream error after bytes: reader keeps them and completes done, lease released", async () => {
    // The `.text()` pin above proves the clean close end-to-end; this one
    // pins the reader contract directly — the old `controller.error()` shape
    // failed HERE (the second read() rejected with "boom"): the client keeps
    // what arrived before the error, then completes normally.
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("partial"));
      },
      pull(c) {
        c.error(new Error("boom-late"));
      },
    });
    const res = withBudgetRelease(new Response(body), () => n++);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("partial");
    const second = await reader.read(); // the upstream error surfaces as done
    expect(second.done).toBe(true);
    expect(n).toBe(1);
  });
});
