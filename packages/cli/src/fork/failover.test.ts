/**
 * Failover tests — cascade budget substitution, per-step backoff, onset + recovery
 * notices.
 *
 * Operational invariants:
 *  1. Zero configuration ⇒ zero behavior change (ships to machines that never set env).
 *  2. A plain rate limit must NOT burn the weekly budget switch — only genuine
 *     quota/credit exhaustion arms a failover.
 *  3. The notice never breaks a condensation, whatever the message looks like.
 *  4. Per-step backoff outlives the role-arm TTL — a weekly-walled step is not
 *     re-probed every 10 minutes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  initFailover,
  isFailoverActive,
  getFailoverRule,
  getActiveFailovers,
  armFailover,
  isQuotaExhaustion,
  roleFromModelName,
  buildFailoverNotice,
  appendFailoverNoticeToMessage,
  resetFailoverForTests,
  resolveFailoverTarget,
  markStepFailed,
  onNominalSuccess,
  isRecovering,
  consumeStreamNotice,
  extractSessionKey,
} from "./failover.js";

// 1-step config (backward-compatible: no ">" separator).
const OPUS_TO_QWEN = {
  CLAUDISH_FAILOVER_OPUS: "qwen-token-plan@qwen3.8-max",
  CLAUDISH_FAILOVER_OPUS_LABEL: "Qwen 3.8 Max",
  CLAUDISH_FAILOVER_OPUS_DIRECTION: "degraded",
  CLAUDISH_FAILOVER_OPUS_NOTE: "Extended thinking is disabled on this target.",
} as NodeJS.ProcessEnv;

// 3-step cascade: Opus → Qwen 3.8 → GLM-5.2 → DeepSeek PAYG.
const OPUS_CASCADE = {
  CLAUDISH_FAILOVER_OPUS: "qwen-token-plan@qwen3.8-max>gc@glm-5.2>deepseek@deepseek-payg",
  CLAUDISH_FAILOVER_OPUS_LABEL: "Qwen 3.8 Max>GLM-5.2>DeepSeek PAYG",
  CLAUDISH_FAILOVER_OPUS_DIRECTION: "degraded>degraded>improved",
} as NodeJS.ProcessEnv;

const HAIKU_TO_DEEPSEEK = {
  CLAUDISH_FAILOVER_HAIKU: "deepseek@deepseek-v4-flash",
  CLAUDISH_FAILOVER_HAIKU_LABEL: "DeepSeek v4 Flash",
  CLAUDISH_FAILOVER_HAIKU_DIRECTION: "improved",
} as NodeJS.ProcessEnv;

beforeEach(() => resetFailoverForTests());

describe("failover — inert by default", () => {
  it("does nothing at all with an empty environment", () => {
    initFailover({} as NodeJS.ProcessEnv);
    expect(isFailoverActive("opus")).toBe(false);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isFailoverActive("haiku")).toBe(false);
    expect(getActiveFailovers()).toEqual([]);
    expect(buildFailoverNotice()).toBeNull();
  });

  it("adds zero bytes to a condensation when nothing is armed", () => {
    initFailover({} as NodeJS.ProcessEnv);
    const msg = { content: [{ type: "text", text: "Summary of the session." }] };
    appendFailoverNoticeToMessage(msg);
    expect(msg.content[0].text).toBe("Summary of the session.");
  });

  it("configuring a target without arming it changes no routing", () => {
    initFailover({ ...OPUS_TO_QWEN });
    expect(getFailoverRule("opus")?.steps[0].target).toBe("qwen-token-plan@qwen3.8-max");
    expect(isFailoverActive("opus")).toBe(false);
    expect(buildFailoverNotice()).toBeNull();
  });
});

// ── Cascade parsing ────────────────────────────────────────────────────────────

describe("cascade parsing", () => {
  it("parses a 1-step config (no '>') into a single step", () => {
    initFailover({ ...OPUS_TO_QWEN });
    const rule = getFailoverRule("opus")!;
    expect(rule.steps).toHaveLength(1);
    expect(rule.steps[0]).toMatchObject({
      target: "qwen-token-plan@qwen3.8-max",
      label: "Qwen 3.8 Max",
      direction: "degraded",
      note: "Extended thinking is disabled on this target.",
    });
  });

  it("parses a 3-step cascade and aligns labels/directions", () => {
    initFailover({ ...OPUS_CASCADE });
    const rule = getFailoverRule("opus")!;
    expect(rule.steps.map((s) => s.target)).toEqual([
      "qwen-token-plan@qwen3.8-max",
      "gc@glm-5.2",
      "deepseek@deepseek-payg",
    ]);
    expect(rule.steps.map((s) => s.label)).toEqual([
      "Qwen 3.8 Max",
      "GLM-5.2",
      "DeepSeek PAYG",
    ]);
    expect(rule.steps.map((s) => s.direction)).toEqual([
      "degraded",
      "degraded",
      "improved",
    ]);
  });

  it("defaults a missing label to the target string", () => {
    initFailover({
      CLAUDISH_FAILOVER_SONNET: "ds@deepseek-v4-pro",
      CLAUDISH_FAILOVER_ACTIVE: "sonnet",
    });
    expect(getFailoverRule("sonnet")?.steps[0].label).toBe("ds@deepseek-v4-pro");
    // direction defaults to degraded (never flatter).
    expect(getFailoverRule("sonnet")?.steps[0].direction).toBe("degraded");
  });

  it("pads mismatched label count with defaults rather than mis-routing", () => {
    initFailover({
      CLAUDISH_FAILOVER_OPUS: "a@one>b@two>c@three",
      CLAUDISH_FAILOVER_OPUS_LABEL: "Only One Label",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
    });
    const steps = getFailoverRule("opus")!.steps;
    expect(steps[0].label).toBe("Only One Label");
    expect(steps[1].label).toBe("b@two"); // fell back to target
    expect(steps[2].label).toBe("c@three");
  });
});

// ── Manual + automatic arming ──────────────────────────────────────────────────

describe("failover — arming", () => {
  it("arms the roles named in CLAUDISH_FAILOVER_ACTIVE", () => {
    initFailover({
      ...OPUS_TO_QWEN,
      ...HAIKU_TO_DEEPSEEK,
      CLAUDISH_FAILOVER_ACTIVE: "opus,haiku",
    });
    expect(isFailoverActive("opus")).toBe(true);
    expect(isFailoverActive("haiku")).toBe(true);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(getActiveFailovers().map((a) => a.role)).toEqual(["opus", "haiku"]);
    // Resolved step is step 0 for each armed role.
    expect(getActiveFailovers().map((a) => a.stepIndex)).toEqual([0, 0]);
  });

  it("does not arm a role whose target is unconfigured", () => {
    initFailover({ CLAUDISH_FAILOVER_ACTIVE: "opus" });
    expect(isFailoverActive("opus")).toBe(false);
    expect(buildFailoverNotice()).toBeNull();
  });

  it("tolerates junk in the active list without arming anything unintended", () => {
    initFailover({ ...OPUS_TO_QWEN, CLAUDISH_FAILOVER_ACTIVE: "opus, bogus ,, " });
    expect(isFailoverActive("opus")).toBe(true);
    expect(getActiveFailovers()).toHaveLength(1);
  });

  it("treats 'none' as off", () => {
    initFailover({ ...OPUS_TO_QWEN, CLAUDISH_FAILOVER_ACTIVE: "none" });
    expect(isFailoverActive("opus")).toBe(false);
  });

  it("refuses to auto-arm unless CLAUDISH_FAILOVER_AUTO is set", () => {
    initFailover({ ...OPUS_TO_QWEN });
    expect(armFailover("opus", "HTTP 429")).toBe(false);
    expect(isFailoverActive("opus")).toBe(false);
  });

  it("arms once, and reports the transition only once", () => {
    initFailover({ ...OPUS_TO_QWEN, CLAUDISH_FAILOVER_AUTO: "1" });
    expect(armFailover("opus", "HTTP 429 weekly limit")).toBe(true);
    expect(armFailover("opus", "HTTP 429 weekly limit")).toBe(false);
  });

  it("cannot auto-arm a role with no configured cascade", () => {
    initFailover({ CLAUDISH_FAILOVER_AUTO: "1" });
    expect(armFailover("sonnet", "HTTP 402")).toBe(false);
  });
});

// ── Resolution walk ────────────────────────────────────────────────────────────

describe("resolveFailoverTarget — cascade walk", () => {
  it("returns nominal when the role is not armed", () => {
    initFailover({ ...OPUS_CASCADE });
    expect(resolveFailoverTarget("opus")).toEqual({ step: null, stepIndex: -1 });
  });

  it("returns step 0 when armed and nothing has failed", () => {
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
    const r = resolveFailoverTarget("opus");
    expect(r.stepIndex).toBe(0);
    expect(r.step?.target).toBe("qwen-token-plan@qwen3.8-max");
  });

  it("skips a TTL-failed step to the next one", () => {
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
    markStepFailed("opus", 0, "qwen weekly wall");
    const r = resolveFailoverTarget("opus");
    expect(r.stepIndex).toBe(1);
    expect(r.step?.target).toBe("gc@glm-5.2");
  });

  it("falls through to the LAST step when all are TTL-failed (PAYG always serves)", () => {
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
    markStepFailed("opus", 0, "x");
    markStepFailed("opus", 1, "y");
    markStepFailed("opus", 2, "z");
    const r = resolveFailoverTarget("opus");
    expect(r.stepIndex).toBe(2);
    expect(r.step?.target).toBe("deepseek@deepseek-payg");
  });
});

// ── Per-step backoff ───────────────────────────────────────────────────────────

describe("per-step backoff", () => {
  const realNow = Date.now;
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    Date.now = () => clock;
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
  });
  afterEach(() => {
    Date.now = realNow;
  });

  it("a single failure TTLs the step for ~10 minutes", () => {
    markStepFailed("opus", 0, "once");
    clock += 9 * 60 * 1000; // 9 min — within 10 min TTL
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1); // step 0 skipped
    clock += 2 * 60 * 1000; // 11 min total — past 10 min TTL
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0); // step 0 probed again
  });

  it("two failures extend the TTL to ~30 minutes", () => {
    markStepFailed("opus", 0, "one");
    markStepFailed("opus", 0, "two");
    clock += 20 * 60 * 1000; // 20 min — within 30 min TTL
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
    clock += 15 * 60 * 1000; // 35 min total — past 30 min TTL
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
  });

  it("step failures survive the role-arm TTL cycle (the corrected invariant)", () => {
    // Re-arm implicitly via AUTO so we can cycle the role-arm TTL.
    resetFailoverForTests();
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_AUTO: "1" });
    expect(armFailover("opus", "weekly wall")).toBe(true);
    markStepFailed("opus", 0, "qwen weekly");
    markStepFailed("opus", 0, "qwen weekly"); // count=2 → 30 min TTL
    // Advance past the 10-min role-arm TTL; the role disarms then re-arms, but the
    // step's 30-min backoff must hold — Qwen must not be re-probed every 10 min.
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("opus")).toBe(false); // role-arm expired
    expect(armFailover("opus", "still walled")).toBe(true); // re-arm (nominal probe failed)
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1); // step 0 STILL skipped
  });
});

// ── isQuotaExhaustion ──────────────────────────────────────────────────────────

describe("isQuotaExhaustion — narrow on purpose", () => {
  it("treats a plain per-minute rate limit as NOT exhaustion", () => {
    expect(isQuotaExhaustion(429, '{"error":{"message":"Rate limit exceeded, retry in 3s"}}')).toBe(false);
  });

  it("recognizes plan/quota exhaustion behind a 429", () => {
    expect(isQuotaExhaustion(429, "weekly usage limit reached")).toBe(true);
    expect(isQuotaExhaustion(429, '{"code":"insufficient_quota"}')).toBe(true);
    expect(isQuotaExhaustion(429, "Throttling.AllocationQuota")).toBe(true);
  });

  it("recognizes 402 payment-required on status alone", () => {
    expect(isQuotaExhaustion(402, "")).toBe(true);
  });

  it("recognizes provider-specific balance errors", () => {
    expect(isQuotaExhaustion(400, '{"error":{"message":"Insufficient Balance"}}')).toBe(true);
    expect(isQuotaExhaustion(500, "insufficient credit for this request")).toBe(true);
  });

  it("does NOT treat wiring mistakes as exhaustion", () => {
    expect(isQuotaExhaustion(401, "invalid api key")).toBe(false);
    expect(isQuotaExhaustion(404, "model not found")).toBe(false);
    expect(isQuotaExhaustion(500, "internal server error")).toBe(false);
  });
});

describe("roleFromModelName", () => {
  it("maps the names Claude Code actually sends", () => {
    expect(roleFromModelName("claude-opus-5")).toBe("opus");
    expect(roleFromModelName("claude-sonnet-5")).toBe("sonnet");
    expect(roleFromModelName("claude-3-5-haiku-20241022")).toBe("haiku");
  });

  it("returns null for anything else", () => {
    expect(roleFromModelName("glm-5.2")).toBeNull();
    expect(roleFromModelName("")).toBeNull();
    expect(roleFromModelName(undefined)).toBeNull();
  });
});

// ── Notices ───────────────────────────────────────────────────────────────────

describe("failover condensation notice", () => {
  it("names the role, the substitute, and the direction", () => {
    initFailover({
      ...OPUS_TO_QWEN,
      ...HAIKU_TO_DEEPSEEK,
      CLAUDISH_FAILOVER_ACTIVE: "opus,haiku",
    });
    const notice = buildFailoverNotice()!;
    expect(notice).toContain("opus");
    expect(notice).toContain("Qwen 3.8 Max");
    expect(notice).toContain("qwen-token-plan@qwen3.8-max");
    expect(notice).toContain("slightly weaker");
    expect(notice).toContain("DeepSeek v4 Flash");
    expect(notice).toContain("stronger");
    expect(notice).toContain("Extended thinking is disabled on this target.");
  });

  it("names depth + what is exhausted ahead at step > 0", () => {
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
    markStepFailed("opus", 0, "qwen weekly"); // → serving step 1 (GLM)
    const notice = buildFailoverNotice()!;
    expect(notice).toContain("2nd fallback");
    expect(notice).toContain("GLM-5.2");
    expect(notice).toContain("Qwen 3.8 Max ahead of it is also exhausted");
  });

  it("defaults an unspecified direction to 'degraded'", () => {
    initFailover({
      CLAUDISH_FAILOVER_SONNET: "some@model",
      CLAUDISH_FAILOVER_ACTIVE: "sonnet",
    });
    expect(buildFailoverNotice()).toContain("slightly weaker");
  });
});

describe("appendFailoverNoticeToMessage", () => {
  beforeEach(() => {
    initFailover({ ...OPUS_TO_QWEN, CLAUDISH_FAILOVER_ACTIVE: "opus" });
  });

  it("appends to the trailing text block rather than adding a new one", () => {
    const msg = { content: [{ type: "text", text: "Summary." }] };
    appendFailoverNoticeToMessage(msg);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].text.startsWith("Summary.")).toBe(true);
    expect(msg.content[0].text).toContain("Failover model active");
  });

  it("appends to the LAST text block when several are present", () => {
    const msg = {
      content: [
        { type: "text", text: "first" },
        { type: "tool_use", id: "t1", name: "X", input: {} },
        { type: "text", text: "last" },
      ],
    };
    appendFailoverNoticeToMessage(msg);
    expect(msg.content[0].text).toBe("first");
    expect((msg.content[2] as any).text).toContain("Failover model active");
  });

  it("pushes a block when the message has no text block at all", () => {
    const msg = { content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] };
    appendFailoverNoticeToMessage(msg);
    expect(msg.content).toHaveLength(2);
    expect((msg.content[1] as any).text).toContain("Failover model active");
  });

  it("never throws on a malformed message", () => {
    expect(() => appendFailoverNoticeToMessage(null)).not.toThrow();
    expect(() => appendFailoverNoticeToMessage({})).not.toThrow();
    expect(() => appendFailoverNoticeToMessage({ content: "not an array" })).not.toThrow();
    expect(() => appendFailoverNoticeToMessage({ content: [null, undefined] })).not.toThrow();
  });
});

// ── Stream notice (depth-aware) ────────────────────────────────────────────────

describe("consumeStreamNotice — depth-aware", () => {
  it("notifies once per session at the current depth, re-notifies when depth changes", () => {
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
    const first = consumeStreamNotice("opus", "sess-A");
    expect(first).toContain("1st fallback");
    expect(consumeStreamNotice("opus", "sess-A")).toBeNull(); // dedup at depth 0

    markStepFailed("opus", 0, "qwen died mid-session"); // now serving step 1
    const reNotify = consumeStreamNotice("opus", "sess-A");
    expect(reNotify).toContain("2nd fallback");
    expect(reNotify).toContain("Qwen 3.8 Max ahead of you");
    expect(consumeStreamNotice("opus", "sess-A")).toBeNull(); // dedup at depth 1
  });

  it("returns null without a stable session key (skip rather than spam)", () => {
    initFailover({ ...OPUS_TO_QWEN, CLAUDISH_FAILOVER_ACTIVE: "opus" });
    expect(consumeStreamNotice("opus", null)).toBeNull();
  });
});

describe("extractSessionKey", () => {
  it("parses the JSON user_id Claude Code sends", () => {
    const key = extractSessionKey({
      metadata: { user_id: '{"device_id":"d","account_uuid":"a","session_id":"sess-123"}' },
    });
    expect(key).toBe("sess-123");
  });

  it("falls back to the raw user_id string when it is not JSON", () => {
    expect(extractSessionKey({ metadata: { user_id: "plain-id" } })).toBe("plain-id");
  });

  it("returns null when there is nothing to key on", () => {
    expect(extractSessionKey({})).toBeNull();
    expect(extractSessionKey({ metadata: {} })).toBeNull();
  });
});

// ── Recovery ───────────────────────────────────────────────────────────────────

describe("recovery — nominal restored after failover", () => {
  const realNow = Date.now;
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    Date.now = () => clock;
  });
  afterEach(() => {
    Date.now = realNow;
  });

  it("transitions to recovering when the auto-arm TTL expires and nominal succeeds", () => {
    resetFailoverForTests();
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_AUTO: "1" });
    expect(armFailover("opus", "weekly wall")).toBe(true);
    // Serve step 0, then let the role-arm TTL elapse (seeds pendingRecovery).
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("opus")).toBe(false);
    expect(isRecovering("opus")).toBe(false); // not yet — nominal hasn't answered
    // The cascade loop calls onNominalSuccess when the nominal probe succeeds.
    onNominalSuccess("opus");
    expect(isRecovering("opus")).toBe(true);
  });

  it("condensation notice fires 3 times then clears", () => {
    resetFailoverForTests();
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_AUTO: "1" });
    armFailover("opus", "weekly wall");
    clock += 11 * 60 * 1000;
    isFailoverActive("opus"); // expire + seed pendingRecovery
    onNominalSuccess("opus");

    const n1 = buildFailoverNotice()!;
    expect(n1).toContain("back on the nominal Opus");
    expect(n1).toContain("Qwen 3.8 Max"); // prevLabel
    expect(buildFailoverNotice()).toContain("back on the nominal Opus"); // 2nd
    expect(buildFailoverNotice()).toContain("back on the nominal Opus"); // 3rd
    expect(buildFailoverNotice()).toBeNull(); // 4th — recovery spent
    expect(isRecovering("opus")).toBe(false);
  });

  it("stream recovery notice fires once per session", () => {
    resetFailoverForTests();
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_AUTO: "1" });
    armFailover("opus", "weekly wall");
    clock += 11 * 60 * 1000;
    isFailoverActive("opus");
    onNominalSuccess("opus");

    const a1 = consumeStreamNotice("opus", "sess-A");
    expect(a1).toContain("back on the nominal Opus");
    expect(consumeStreamNotice("opus", "sess-A")).toBeNull(); // dedup
    expect(consumeStreamNotice("opus", "sess-B")).toContain("back on the nominal Opus"); // other session
  });

  it("re-arming clears recovery state (we are back in failover)", () => {
    resetFailoverForTests();
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_AUTO: "1" });
    armFailover("opus", "weekly wall");
    clock += 11 * 60 * 1000;
    isFailoverActive("opus");
    onNominalSuccess("opus");
    expect(isRecovering("opus")).toBe(true);
    // Nominal walls again — the loop re-arms; recovery must clear so a stale
    // "you're back on nominal" notice doesn't mislead.
    expect(armFailover("opus", "walled again")).toBe(true);
    expect(isRecovering("opus")).toBe(false);
  });
});

// ── Auto-arm expiry (self-clearing failover) ───────────────────────────────────

describe("auto-arm expiry (self-clearing failover)", () => {
  const ENV = {
    CLAUDISH_FAILOVER_SONNET: "ds@deepseek-v4-flash",
    CLAUDISH_FAILOVER_SONNET_LABEL: "DeepSeek",
    CLAUDISH_FAILOVER_AUTO: "1",
  } as NodeJS.ProcessEnv;

  const realNow = Date.now;
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    Date.now = () => clock;
    initFailover(ENV);
  });
  afterEach(() => {
    Date.now = realNow;
  });

  it("holds the substitution while the wall is presumed up", () => {
    expect(armFailover("sonnet", "HTTP 429 quota")).toBe(true);
    clock += 9 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(true);
  });

  it("expires after the TTL so the next request probes the nominal model", () => {
    armFailover("sonnet", "HTTP 429 quota");
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(false);
  });

  it("re-arms when the wall is still up", () => {
    armFailover("sonnet", "HTTP 429 quota");
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(armFailover("sonnet", "HTTP 429 quota again")).toBe(true);
    expect(isFailoverActive("sonnet")).toBe(true);
  });

  it("does NOT expire a config-armed role (operator intent)", () => {
    initFailover({ ...ENV, CLAUDISH_FAILOVER_ACTIVE: "sonnet" });
    expect(isFailoverActive("sonnet")).toBe(true);
    clock += 24 * 60 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(true);
  });
});
