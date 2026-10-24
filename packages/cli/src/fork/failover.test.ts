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
import { readFileSync } from "node:fs";
import {
  initFailover,
  isFailoverActive,
  getFailoverRule,
  getActiveFailovers,
  armFailover,
  isQuotaExhaustion,
  isWiringError,
  roleFromModelName,
  buildFailoverNotice,
  appendFailoverNoticeToMessage,
  resetFailoverForTests,
  resolveFailoverTarget,
  resolveFailoverTargetForSession,
  getSessionDwellPinForTests,
  getDwellYieldTombstoneCountForTests,
  DWELL_TOMBSTONES_MAX,
  markStepFailed,
  parseResetAtFromBody,
  resetStepSuccess,
  onNominalSuccess,
  onNominalRefusal,
  burstRetryAfterMs,
  getArmGraceMs,
  isRecovering,
  consumeStreamNotice,
  extractSessionKey,
  providerBucketOf,
  classifyNominalBucket,
  nativeBucketFor,
  resolveConcreteTarget,
  resolveDelegationOwner,
  setRoleNominalResolver,
  setRoleNominalBucketResolver,
  earliestWalledReprobeAt,
  machineArmBucket,
  NATIVE_BUCKET,
} from "./failover.js";
import type { DelegationOwner } from "./failover.js";
import { route } from "../providers/routing-rules.js";
import { DEFAULT_ROUTING_RULES } from "../providers/default-routing-rules.js";

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

const FABLE_CASCADE = {
  CLAUDISH_FAILOVER_FABLE: "cx@gpt-6-astra>ds@deepseek-v4-flash-vision-exp",
  CLAUDISH_FAILOVER_FABLE_LABEL: "GPT-6 Astra>DeepSeek vision PAYG",
  CLAUDISH_FAILOVER_FABLE_DIRECTION: "lateral>degraded",
  CLAUDISH_FAILOVER_FABLE_NOTE: "Equivalent coding lane>Emergency PAYG lane",
} as NodeJS.ProcessEnv;

beforeEach(() => resetFailoverForTests());

describe("failover — inert by default", () => {
  it("does nothing at all with an empty environment", () => {
    initFailover({} as NodeJS.ProcessEnv);
    expect(isFailoverActive("opus")).toBe(false);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(isFailoverActive("haiku")).toBe(false);
    expect(isFailoverActive("fable")).toBe(false);
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

  it("parses and aligns a Fable cascade", () => {
    initFailover({ ...FABLE_CASCADE });
    const rule = getFailoverRule("fable")!;
    expect(rule.steps).toEqual([
      {
        target: "cx@gpt-6-astra",
        label: "GPT-6 Astra",
        direction: "lateral",
        note: "Equivalent coding lane",
        resetAt: undefined,
      },
      {
        target: "ds@deepseek-v4-flash-vision-exp",
        label: "DeepSeek vision PAYG",
        direction: "degraded",
        note: "Emergency PAYG lane",
        resetAt: undefined,
      },
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

  it("arms Fable and advances through its cascade", () => {
    initFailover({ ...FABLE_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "fable" });
    expect(isFailoverActive("fable")).toBe(true);
    expect(resolveFailoverTarget("fable").step?.target).toBe("cx@gpt-6-astra");
    expect(buildFailoverNotice("fable")).toContain("GPT-6 Astra");

    markStepFailed("fable", 0, "Astra quota wall");
    expect(resolveFailoverTarget("fable").step?.target).toBe(
      "ds@deepseek-v4-flash-vision-exp"
    );
    expect(consumeStreamNotice("fable", "fable-session")).toContain("2nd fallback");
  });

  it("auto-arms Fable and reports recovery after the nominal returns", () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      initFailover({ ...FABLE_CASCADE, CLAUDISH_FAILOVER_AUTO: "1" });
      expect(armFailover("fable", "HTTP 402")).toBe(true);
      expect(isFailoverActive("fable")).toBe(true);
      clock += 11 * 60 * 1000;
      expect(isFailoverActive("fable")).toBe(false);
      onNominalSuccess("fable");
      expect(isRecovering("fable")).toBe(true);
      expect(consumeStreamNotice("fable", "fable-recovery")).toContain(
        "back on the nominal Fable"
      );
    } finally {
      Date.now = realNow;
    }
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

// ── Machine-scoped config arm (`role@machine`) ─────────────────────────────────
//
// The operator diverts ONE machine's role to its cascade (a calibration load
// on our own vLLM from one machine) without moving any other machine: the
// role-wide form diverts every machine of the fleet.

describe("failover — machine-scoped config arm (role@machine)", () => {
  const HAIKU_LOCAL = {
    CLAUDISH_FAILOVER_HAIKU: "vllm-myia@qwen3.6-35b-a3b>role:sonnet",
    CLAUDISH_FAILOVER_HAIKU_LABEL: "Swift local>Sonnet role",
    CLAUDISH_FAILOVER_HAIKU_DIRECTION: "degraded>improved",
    CLAUDISH_FAILOVER_HAIKU_NOTE: "A much smaller model than the nominal.>",
    CLAUDISH_FAILOVER_SONNET: "mistral@glm-5.3",
  } as NodeJS.ProcessEnv;

  it("arms the role for that machine's bucket only — never role-wide", () => {
    initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_ACTIVE: "haiku@myia-po-2027" });
    const mine = machineArmBucket("haiku", "myia-po-2027");
    expect(mine).toBe("machine:myia-po-2027");
    expect(isFailoverActive("haiku", mine)).toBe(true);
    expect(resolveFailoverTarget("haiku", mine).step?.target).toBe("vllm-myia@qwen3.6-35b-a3b");
    // Every other reading of the role stays nominal.
    expect(isFailoverActive("haiku")).toBe(false);
    expect(isFailoverActive("haiku", "minimax-coding")).toBe(false);
    expect(machineArmBucket("haiku", "myia-po-2025")).toBeUndefined();
    expect(machineArmBucket("haiku", null)).toBeUndefined();
    expect(machineArmBucket("sonnet", "myia-po-2027")).toBeUndefined();
    expect(getActiveFailovers()).toEqual([]); // role-less notices never announce it
  });

  it("matches the machine header case-insensitively", () => {
    initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_ACTIVE: "haiku@MYIA-PO-2027" });
    expect(machineArmBucket("haiku", " Myia-Po-2027 ")).toBe("machine:myia-po-2027");
  });

  it("coexists with role-wide arms and ignores an empty machine or an unconfigured role", () => {
    initFailover({
      ...HAIKU_LOCAL,
      ...OPUS_TO_QWEN,
      CLAUDISH_FAILOVER_ACTIVE: "opus, haiku@m1 haiku@m2, haiku@, fable@m1",
    });
    expect(isFailoverActive("opus")).toBe(true);
    expect(machineArmBucket("haiku", "m1")).toBe("machine:m1");
    expect(machineArmBucket("haiku", "m2")).toBe("machine:m2");
    expect(isFailoverActive("haiku")).toBe(false); // `haiku@` is not a role-wide arm
    expect(machineArmBucket("fable", "m1")).toBeUndefined(); // no fable cascade
  });

  it("the session notice states the operator routing (not an exhaustion) and carries the step note", () => {
    initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_ACTIVE: "haiku@myia-po-2027" });
    const text = consumeStreamNotice("haiku", "s-po2027", machineArmBucket("haiku", "myia-po-2027"))!;
    expect(text).toContain("Swift local");
    expect(text).toContain("the operator routes the Haiku role of myia-po-2027 away from its nominal model");
    expect(text).not.toContain("temporarily exhausted");
    expect(text).toContain("A much smaller model than the nominal.");
    // Other machines' sessions get nothing.
    expect(consumeStreamNotice("haiku", "s-other", "minimax-coding")).toBeNull();
  });

  it("a real wall still reads as an exhaustion (wording unchanged off the config arm)", () => {
    initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_AUTO: "1" });
    armFailover("haiku", "HTTP 402", "minimax-coding");
    const text = consumeStreamNotice("haiku", "s-wall", "minimax-coding")!;
    expect(text).toContain("because the nominal Haiku model temporarily exhausted");
  });

  // ── #552 review, non-blocking pins ──

  const captureStderr = (fn: () => void): string[] => {
    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      fn();
    } finally {
      (process.stderr as any).write = realWrite;
    }
    return lines;
  };

  it("N: the startup banner names the live machine arm and its step", () => {
    const lines = captureStderr(() =>
      initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_ACTIVE: "haiku@myia-po-2027" })
    );
    const banner = lines.filter((l) => l.includes("[Failover] configured="));
    expect(banner.length).toBe(1);
    expect(banner[0]).toContain("haiku@myia-po-2027→Swift local");
  });

  it("T: a re-init without the arm drops the machine arm", () => {
    initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_ACTIVE: "haiku@myia-po-2027" });
    expect(machineArmBucket("haiku", "myia-po-2027")).toBe("machine:myia-po-2027");
    initFailover({ ...HAIKU_LOCAL });
    expect(machineArmBucket("haiku", "myia-po-2027")).toBeUndefined();
  });

  it("U: resetFailoverForTests() drops the machine arm", () => {
    initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_ACTIVE: "haiku@myia-po-2027" });
    resetFailoverForTests();
    expect(machineArmBucket("haiku", "myia-po-2027")).toBeUndefined();
  });

  it("W: the step note appears exactly once in the session notice", () => {
    initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_ACTIVE: "haiku@myia-po-2027" });
    const text = consumeStreamNotice("haiku", "s-note", machineArmBucket("haiku", "myia-po-2027"))!;
    expect(text.split("A much smaller model than the nominal.").length - 1).toBe(1);
  });

  it("the role-wide config arm reads as operator routing, with no machine named", () => {
    initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_ACTIVE: "haiku" });
    const text = consumeStreamNotice("haiku", "s-rolewide", "minimax-coding")!;
    expect(text).toContain("because the operator routes the Haiku role away from its nominal model");
    expect(text).not.toContain("temporarily exhausted");
  });

  it("a second @ in the machine is ignored with a log, never armed", () => {
    const lines = captureStderr(() =>
      initFailover({ ...HAIKU_LOCAL, CLAUDISH_FAILOVER_ACTIVE: "haiku@m1@m2, haiku@myia-po-2027@" })
    );
    expect(lines.filter((l) => l.includes("Ignoring malformed machine")).length).toBe(2);
    expect(machineArmBucket("haiku", "m1@m2")).toBeUndefined();
    expect(machineArmBucket("haiku", "m1")).toBeUndefined();
    expect(machineArmBucket("haiku", "myia-po-2027@")).toBeUndefined();
    expect(machineArmBucket("haiku", "myia-po-2027")).toBeUndefined();
    expect(isFailoverActive("haiku")).toBe(false);
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

// ── #261: a config-declared future resetAt CLOSES a healthy step ────────────────
// The 2026-09-25 hub shape: an operator closed the Qwen subscription steps until
// Monday via _RESET, deployed with a drained recreate — and the closure did
// nothing, 865 responses served on the closed step. Root cause: the config value
// only reached the walk through markStepFailed (extending an already-walled
// step's backoff), never closing a healthy one — and the recreate's
// initFailover wiped the very failure state that could have made it bite.
// These tests pin the closure semantics on the config plane alone (count===0).

describe("#261 — config resetAt closes a healthy step (closure gesture)", () => {
  const realNow = Date.now;
  // 1970-01-12: every ISO date below is deterministically future or past.
  const FUTURE = "2097-01-01T00:00:00Z";
  const PAST = "1970-01-01T00:00:00Z";
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    Date.now = () => clock;
  });
  afterEach(() => {
    Date.now = realNow;
  });

  it("skips a healthy closed step (count===0) — the recreate-wipe shape of 2026-09-25", () => {
    initFailover({
      ...OPUS_CASCADE,
      CLAUDISH_FAILOVER_ACTIVE: "opus",
      CLAUDISH_FAILOVER_OPUS_RESET: `${FUTURE}>>`,
    });
    const r = resolveFailoverTarget("opus");
    expect(r.stepIndex).toBe(1);
    expect(r.step?.target).toBe("gc@glm-5.2");
  });

  it("does NOT fall back to the LAST step when the operator closed it", () => {
    // "PAYG always serves" is a liveness bet; an explicit closure outranks it —
    // serving a closed last step is exactly the inert-closure bug.
    initFailover({
      ...OPUS_CASCADE,
      CLAUDISH_FAILOVER_ACTIVE: "opus",
      CLAUDISH_FAILOVER_OPUS_RESET: `${FUTURE}>${FUTURE}>${FUTURE}`,
    });
    expect(resolveFailoverTarget("opus")).toEqual({ step: null, stepIndex: -1 });
  });

  it("last-step fallback stands when only earlier steps are closed", () => {
    initFailover({
      ...OPUS_CASCADE,
      CLAUDISH_FAILOVER_ACTIVE: "opus",
      CLAUDISH_FAILOVER_OPUS_RESET: `${FUTURE}>${FUTURE}>`,
    });
    const r = resolveFailoverTarget("opus");
    expect(r.stepIndex).toBe(2);
    expect(r.step?.target).toBe("deepseek@deepseek-payg");
  });

  it("a PASSED reset reopens the step (closure is not permanent)", () => {
    initFailover({
      ...OPUS_CASCADE,
      CLAUDISH_FAILOVER_ACTIVE: "opus",
      CLAUDISH_FAILOVER_OPUS_RESET: `${PAST}>>`,
    });
    const r = resolveFailoverTarget("opus");
    expect(r.stepIndex).toBe(0);
    expect(r.step?.target).toBe("qwen-token-plan@qwen3.8-max");
  });

  it("the closure comes from config, not failure state — it survives the initFailover wipe", () => {
    // The recreate shape: failure state recorded, then initFailover clears it.
    // A closure that depended on failure state would reopen at every restart.
    const env = {
      ...OPUS_CASCADE,
      CLAUDISH_FAILOVER_ACTIVE: "opus",
      CLAUDISH_FAILOVER_OPUS_RESET: `${FUTURE}>>`,
    } as NodeJS.ProcessEnv;
    initFailover(env);
    markStepFailed("opus", 1, "step 1 wall"); // irrelevant step, just noise
    initFailover(env); // the recreate: stepFailures wiped
    const r = resolveFailoverTarget("opus");
    expect(r.stepIndex).toBe(1); // step 0 STILL closed (config plane), step 1 fresh
  });

  it("startup attests the closure — one countable marker line per closed step", () => {
    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      initFailover({
        ...OPUS_CASCADE,
        CLAUDISH_FAILOVER_ACTIVE: "opus",
        CLAUDISH_FAILOVER_OPUS_RESET: `${FUTURE}>>`,
      });
    } finally {
      (process.stderr as any).write = realWrite;
    }
    const closed = lines.filter((l) => l.includes("[Failover] CLOSED opus[0]"));
    expect(closed.length).toBe(1);
    expect(closed[0]).toContain(new Date(FUTURE).toISOString());
    expect(lines.some((l) => l.includes("CLOSED opus[1]"))).toBe(false);
  });

  it("a dwell pin holding on a step the operator just closed yields (live closure, no recreate)", () => {
    // The env-driven harness cannot deliver a closure to a LIVE pin (re-initing
    // wipes the pins), so the closure is applied to the live rule object — the
    // same in-place mutation a config reload would conceptually carry. The pin
    // must yield: serving the pinned step would route around the closure.
    resetFailoverForTests();
    initFailover({
      ...OPUS_CASCADE,
      CLAUDISH_FAILOVER_ACTIVE: "opus",
      CLAUDISH_FAILOVER_SESSION_DWELL_MS: "600000",
    });
    const first = resolveFailoverTargetForSession("opus", "sess-closure", undefined);
    expect(first.stepIndex).toBe(0); // pinned to step 0
    expect(getSessionDwellPinForTests("opus", "sess-closure")).toBeDefined();
    // The operator closes step 0 mid-session.
    getFailoverRule("opus")!.steps[0].resetAt = new Date(FUTURE);
    const second = resolveFailoverTargetForSession("opus", "sess-closure", undefined);
    expect(second.stepIndex).toBe(1); // pin yielded — never route around a closure
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

  it("two failure EPISODES extend the TTL to ~30 minutes", () => {
    markStepFailed("opus", 0, "one");
    clock += 11 * 60 * 1000; // bench elapsed — the re-probe fails: a second episode
    markStepFailed("opus", 0, "two");
    clock += 20 * 60 * 1000; // 20 min — within 30 min TTL
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
    clock += 15 * 60 * 1000; // 35 min total — past 30 min TTL
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
  });

  // #553: N requests in flight on one step that fail together are ONE episode.
  // Measured on the hub 20/10 00:19Z: Kimi (haiku[1]) count 2 → 4 (a 4 h bench)
  // within one second; the cascade then paid DeepSeek PAYG for those hours.
  it("#553: concurrent failures on a benched step climb ONE rung, not N", () => {
    for (let i = 0; i < 5; i++) markStepFailed("opus", 0, `in-flight ${i}`);
    clock += 9 * 60 * 1000;
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1); // still benched
    clock += 2 * 60 * 1000; // 11 min — first rung (10 min), not the fifth (24 h)
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
  });

  it("#553: a late in-flight failure refreshes the bench without escalating it", () => {
    markStepFailed("opus", 0, "first");
    clock += 5 * 60 * 1000; // a long stream selected before the bench dies now
    markStepFailed("opus", 0, "late in-flight");
    clock += 9 * 60 * 1000; // 14 min after the first, 9 after the refresh
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
    clock += 2 * 60 * 1000; // 11 min after the refresh — still the 10 min rung
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
  });

  it("#553: a failure while a known reset is pending is the same episode", () => {
    const resetAt = new Date(clock + 2 * 3600_000);
    markStepFailed("opus", 0, "wall with a reset", resetAt);
    clock = resetAt.getTime() - 5 * 60_000; // TTL rung long gone, the reset still binds
    markStepFailed("opus", 0, "in-flight while walled", resetAt);
    clock = resetAt.getTime() + 6 * 60_000; // reset passed, 11 min after the last failure
    // FIRST rung (10 min) from the last failure → probeable; a second rung (30 min)
    // would still hold the step here.
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
  });

  it("#553: a failure on a DIFFERENT concrete is a new episode", () => {
    markStepFailed("opus", 0, "on A", undefined, { concrete: "prov@model-a" });
    markStepFailed("opus", 0, "on B", undefined, { concrete: "prov@model-b" });
    clock += 11 * 60 * 1000; // past the first rung
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1); // second rung holds
    clock += 20 * 60 * 1000; // 31 min — past the second rung
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
  });

  it("#553: the held mark says so in the [Failover] line", () => {
    const realWrite = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      markStepFailed("opus", 0, "first");
      markStepFailed("opus", 0, "concurrent");
    } finally {
      process.stderr.write = realWrite;
    }
    const step = lines.filter((l) => l.includes("[Failover] step opus[0]"));
    expect(step.length).toBe(2);
    expect(step[0]).toContain("count=1 ttl=");
    expect(step[1]).toContain("count=1 (same episode) ttl=");
  });

  it("step failures survive the role-arm TTL cycle (the corrected invariant)", () => {
    // Re-arm implicitly via AUTO so we can cycle the role-arm TTL.
    resetFailoverForTests();
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_AUTO: "1" });
    expect(armFailover("opus", "weekly wall")).toBe(true);
    markStepFailed("opus", 0, "qwen weekly");
    clock += 11 * 60 * 1000; // first bench elapsed; the re-probe fails too
    markStepFailed("opus", 0, "qwen weekly"); // second episode: count=2 → 30 min TTL
    // Advance past the 10-min role-arm TTL; the role disarms then re-arms, but the
    // step's 30-min backoff must hold — Qwen must not be re-probed every 10 min.
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("opus")).toBe(false); // role-arm expired
    expect(armFailover("opus", "still walled")).toBe(true); // re-arm (nominal probe failed)
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1); // step 0 STILL skipped
  });
});

// ── #553 defect 2: own-capacity backoff class ──────────────────────────────────
//
// A step declared `!own` is OUR OWN capacity: it has no credit to exhaust, it
// saturates or is down, and retrying it is free. Its non-quota failures bench it on
// the short capped ladder (30 s → 2 m → 5 m) instead of the quota-sized one, whose
// first rung (10 min) sent the whole haiku lane to the paid steps for 10 minutes per
// episode (measured 19→20/10: 41 × 502 from our own vLLM front).

describe("#553 defect 2: own-capacity backoff", () => {
  const realNow = Date.now;
  let clock = 1_000_000;

  const OWN_CASCADE = {
    CLAUDISH_FAILOVER_OPUS: "vllm-myia@swift-1.5-27b:8!own>deepseek@deepseek-payg",
    CLAUDISH_FAILOVER_OPUS_LABEL: "own swift>DeepSeek PAYG",
  } as NodeJS.ProcessEnv;

  beforeEach(() => {
    clock = 1_000_000;
    Date.now = () => clock;
    initFailover({ ...OWN_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
  });
  afterEach(() => {
    Date.now = realNow;
  });

  it("pin 1 + 4: the class is stripped before the grammar, so concurrency still parses", () => {
    const step = getFailoverRule("opus")!.steps[0];
    expect(step.target).toBe("vllm-myia@swift-1.5-27b:8"); // suffix gone, `:8` kept
    expect(step.ownBackoff).toBe(true);
    expect(step.label).toBe("own swift"); // the label is the operator's own text
  });

  it("pin 1: a non-quota failure benches an own step 30s, then 2m, then 5m, capped", () => {
    markStepFailed("opus", 0, "own 502", undefined, { nonQuota: true });
    clock += 29_000; // 29 s — still benched
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
    clock += 2_000; // 31 s — the first rung is over, re-probe
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);

    markStepFailed("opus", 0, "own 502 again", undefined, { nonQuota: true }); // episode 2
    clock += 119_000; // 1 min 59 s — within the 2 min rung
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
    clock += 2_000;
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);

    markStepFailed("opus", 0, "own 502 third", undefined, { nonQuota: true }); // episode 3
    clock += 299_000;
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
    clock += 2_000;
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);

    markStepFailed("opus", 0, "own 502 fourth", undefined, { nonQuota: true }); // episode 4
    clock += 299_000; // CAP: the fourth episode is still 5 min, never a quota rung
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
    clock += 2_000;
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
  });

  it("pin 2: a QUOTA-shaped failure on an own step keeps the default ladder", () => {
    // Same step, no `nonQuota` flag: the classifier called it quota, and the
    // declaration must never overrule the classifier.
    markStepFailed("opus", 0, "quota wall on our own step");
    clock += 9 * 60_000; // 9 min — the own 30 s rung is long gone, the 10 min one holds
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
    clock += 2 * 60_000;
    expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
  });

  it("pin 3: the class does not travel through `role:` delegation", () => {
    initFailover({
      CLAUDISH_FAILOVER_OPUS: "role:sonnet!own",
      CLAUDISH_FAILOVER_SONNET: "vllm-myia@swift-1.5-27b>deepseek@deepseek-payg",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
    });
    // The DECLARING step carries the class…
    expect(getFailoverRule("opus")!.steps[0].ownBackoff).toBe(true);
    expect(getFailoverRule("opus")!.steps[0].roleRef).toBe("sonnet");
    // …the resolved role's own steps keep the default ladder.
    expect(getFailoverRule("sonnet")!.steps[0].ownBackoff).toBeUndefined();
  });

  it("pin 5: an unknown class warns, strips, and keeps the default ladder", () => {
    const realWrite = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      initFailover({
        CLAUDISH_FAILOVER_OPUS: "vllm-myia@swift-1.5-27b!fast>deepseek@deepseek-payg",
        CLAUDISH_FAILOVER_ACTIVE: "opus",
      });
    } finally {
      process.stderr.write = realWrite;
    }
    const step = getFailoverRule("opus")!.steps[0];
    expect(step.target).toBe("vllm-myia@swift-1.5-27b"); // stripped, still routable
    expect(step.ownBackoff).toBeUndefined();
    expect(lines.join("")).toContain("unknown step class '!fast'");
  });

  it("pin 6: CLAUDISH_FAILOVER_OWN_BACKOFF=0 reverts to the default ladder, suffix still parses", () => {
    const realWrite = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      initFailover({
        ...OWN_CASCADE,
        CLAUDISH_FAILOVER_OWN_BACKOFF: "0",
        CLAUDISH_FAILOVER_ACTIVE: "opus",
      });
    } finally {
      process.stderr.write = realWrite;
    }
    const step = getFailoverRule("opus")!.steps[0];
    expect(step.target).toBe("vllm-myia@swift-1.5-27b:8"); // parseable as ever
    expect(step.ownBackoff).toBeUndefined();
    expect(lines.join("")).toContain("'!own' declared but ignored");
    markStepFailed("opus", 0, "own 502", undefined, { nonQuota: true });
    clock += 9 * 60_000; // the default 10 min rung holds (not the own 30 s one)
    expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
  });

  it("pin 7: the wall-surface re-probe horizon reads the RECORDED ladder — an own bench is announced in 30 s, never 10 min", () => {
    // Third read site (review of 05:1xZ, blocking m3): `earliestWalledReprobeAt`
    // feeds the retry-after of the wall-surface 429 (proxy-server.ts:1944), and
    // Claude Code sleeps for what it announces. Re-deriving the ladder at read
    // time here would tell the client to wait 600 s through a bench that ends in
    // 30 — twenty times longer than the mark says.
    markStepFailed("opus", 0, "own 502", undefined, { nonQuota: true });
    expect(earliestWalledReprobeAt("opus")!.getTime() - clock).toBe(30_000);

    // The READ side takes the class from the failure RECORD, never from the
    // declaration: a mark the classifier called QUOTA on the same own step keeps
    // the 10-min rung, exactly like an ordinary step.
    markStepFailed("opus", 0, "quota-shaped on our own step");
    expect(earliestWalledReprobeAt("opus")!.getTime() - clock).toBe(600_000);
  });
});

// ── Reset-time awareness ───────────────────────────────────────────────────────
//
// A wall with a KNOWN lift date (Mistral subscription → Sept 1, Qwen plan →
// "reset at 08-25 22:28:00 UTC") must not burn a probe every 24h until then, and
// MUST be probed the moment it lifts so the recovered budget is consumed.

describe("reset-time awareness", () => {
  const realNow = Date.now;
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    Date.now = () => clock;
  });
  afterEach(() => {
    Date.now = realNow;
  });

  describe("parseResetAtFromBody", () => {
    it("parses the Qwen absolute form (MM-DD HH:mm:ss UTC, year implied)", () => {
      const year = new Date().getUTCFullYear();
      const got = parseResetAtFromBody(
        '{"code":"Throttling.AllocationQuota","message":"The 1-week quota is exhausted. The quota will reset at 08-25 22:28:00 UTC."}'
      );
      expect(got?.getTime()).toBe(Date.UTC(year, 7, 25, 22, 28, 0));
    });

    it("rolls a >1-day-past date forward one year (Dec→Jan rollover)", () => {
      clock = Date.UTC(new Date().getUTCFullYear(), 7, 15); // mid-August
      const got = parseResetAtFromBody("The quota will reset at 01-02 03:04:05 UTC");
      expect(got?.getTime()).toBe(Date.UTC(new Date().getUTCFullYear() + 1, 0, 2, 3, 4, 5));
    });

    it("parses the MiniMax relative form (days + hours)", () => {
      const got = parseResetAtFromBody("Weekly limit Resets in 2 days 13 hr Total quota");
      expect(got?.getTime()).toBe(clock + 2 * 24 * 3600_000 + 13 * 3600_000);
    });

    // Z.AI / GLM: four-digit year, and NO timezone marker. The branch reads it as
    // UTC but refuses any value the message's own stated window cannot justify, so
    // it is safe whichever offset Z.AI actually means. See parseResetAtFromBody.
    it("parses the GLM 1308 form (YYYY-MM-DD HH:mm:ss, no timezone) inside its stated window", () => {
      const got = parseResetAtFromBody(
        '{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 1970-01-01 03:16:40"}}'
      );
      expect(got?.getTime()).toBe(clock + 3 * 3600_000);
    });

    // NB: the two "declines" tests below also pass against the UN-fixed parser, which
    // returns undefined simply by not recognising the format. They are not proof of
    // this change — they pin the plausibility guard so a later, more permissive parse
    // cannot quietly start trusting a timestamp whose offset it cannot justify. The
    // two tests above are the ones that fail without the branch.
    it("declines a GLM reset further off than the window it declares (a non-UTC reading)", () => {
      // 12h ahead while the body says the window is 5h: unreachable under UTC, so the
      // timestamp means some other offset. Declining costs one wasted probe; trusting
      // it would skip a working lane for hours.
      const got = parseResetAtFromBody(
        '{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 1970-01-01 12:16:40"}}'
      );
      expect(got).toBeUndefined();
    });

    it("declines a GLM reset well in the past (skew tolerance is minutes, not hours)", () => {
      const got = parseResetAtFromBody(
        '{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 1969-12-31 23:46:40"}}'
      );
      expect(got).toBeUndefined();
    });

    it("bounds an unstated window at 7 days rather than trusting it outright", () => {
      expect(parseResetAtFromBody("Your limit will reset at 1970-01-02 00:16:40")?.getTime()).toBe(
        clock + 24 * 3600_000
      );
      expect(parseResetAtFromBody("Your limit will reset at 1970-01-10 00:16:40")).toBeUndefined();
    });

    it("returns undefined for silent bodies (Mistral 402, Anthropic cap, plain 429)", () => {
      expect(parseResetAtFromBody('{"detail":"Check your subscription on https://admin.mistral.ai/subscription"}')).toBeUndefined();
      expect(parseResetAtFromBody('{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}')).toBeUndefined();
      expect(parseResetAtFromBody('{"error":{"message":"Rate limit exceeded, retry in 3s"}}')).toBeUndefined();
      expect(parseResetAtFromBody("")).toBeUndefined();
    });
  });

  describe("config-declared resets (CLAUDISH_FAILOVER_<ROLE>_RESET)", () => {
    it("parses per-step dates, preserving empty positions", () => {
      initFailover({
        ...OPUS_CASCADE,
        CLAUDISH_FAILOVER_ACTIVE: "opus",
        CLAUDISH_FAILOVER_OPUS_RESET: "2026-09-01T00:00:00Z>",
      } as NodeJS.ProcessEnv);
      const rule = getFailoverRule("opus")!;
      expect(rule.steps[0].resetAt?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
      expect(rule.steps[1].resetAt).toBeUndefined();
      expect(rule.steps[2].resetAt).toBeUndefined();
    });

    it("warns and ignores an unparseable date", () => {
      initFailover({
        ...OPUS_CASCADE,
        CLAUDISH_FAILOVER_ACTIVE: "opus",
        CLAUDISH_FAILOVER_OPUS_RESET: "septembre",
      } as NodeJS.ProcessEnv);
      expect(getFailoverRule("opus")!.steps[0].resetAt).toBeUndefined();
    });
  });

  describe("skip-until-reset / consume-on-reset", () => {
    const SEPT1 = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01T00:00:00Z

    it("holds the step failed past the 24h backoff cap but before the reset", () => {
      initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
      markStepFailed("opus", 0, "subscription wall", SEPT1);
      clock += 2 * 24 * 3600_000; // 2 days — past even the 24h backoff cap, before Sept 1
      expect(resolveFailoverTarget("opus").stepIndex).toBe(1); // STILL skipped — the regression the 24h cap failed
    });

    it("re-probes the step the moment the reset passes (consume-on-reset)", () => {
      initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
      markStepFailed("opus", 0, "subscription wall", SEPT1);
      clock = SEPT1.getTime() + 60_000; // just past the reset
      expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
    });

    it("falls back to the config-declared reset when the body is silent", () => {
      initFailover({
        ...OPUS_CASCADE,
        CLAUDISH_FAILOVER_ACTIVE: "opus",
        CLAUDISH_FAILOVER_OPUS_RESET: "2026-09-01T00:00:00Z>",
      } as NodeJS.ProcessEnv);
      markStepFailed("opus", 0, "Mistral 402, silent body"); // no bodyResetAt → step.resetAt applies
      clock += 2 * 24 * 3600_000;
      expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
      clock = SEPT1.getTime() + 60_000;
      expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
    });

    it("body-parsed reset WINS over an earlier config-declared one", () => {
      initFailover({
        ...OPUS_CASCADE,
        CLAUDISH_FAILOVER_ACTIVE: "opus",
        CLAUDISH_FAILOVER_OPUS_RESET: "2026-09-01T00:00:00Z>",
      } as NodeJS.ProcessEnv);
      const aug25 = new Date(clock + 3 * 24 * 3600_000);
      markStepFailed("opus", 0, "qwen wall names its own date", aug25);
      // Past Aug 25 (body) but before Sept 1 (config): the live body knew better.
      clock = aug25.getTime() + 60_000;
      expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
    });

    it("resetStepSuccess clears the reset — a recovered step serves again immediately", () => {
      initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
      markStepFailed("opus", 0, "subscription wall", SEPT1);
      resetStepSuccess("opus", 0);
      expect(resolveFailoverTarget("opus").stepIndex).toBe(0); // not held by the stale reset date
    });

    // Production 2026-09-01: sonnet step0 (Mistral) reached count=96 in three hours
    // the morning after its declared 09-01 reset. A past resetAt returned false
    // outright, so the step was permanently EXEMPT from backoff: each wall re-marked
    // it and the very next request re-selected it. handleWithCascade then burned all
    // `steps.length + 1` attempts on the same dead step and surfaced its 402 to the
    // client — every sonnet lane in the fleet down, with two healthy steps beneath.
    it("re-probes ONCE after the reset, then backs off again when the wall is still up", () => {
      initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
      markStepFailed("opus", 0, "subscription wall", SEPT1);
      clock = SEPT1.getTime() + 60_000;
      expect(resolveFailoverTarget("opus").stepIndex).toBe(0); // the consume-on-reset probe

      // The probe fails: the subscription was NOT renewed (or was spent same-day).
      markStepFailed("opus", 0, "402 again, right after the declared reset", SEPT1);
      // The stale date must NOT exempt the step from backoff any more.
      expect(resolveFailoverTarget("opus").stepIndex).toBe(1);

      // And it stays skipped for the ordinary backoff rung, not forever. This is the
      // SECOND wall for this step, so the rung is BACKOFF_MS[1] = 30 min, not 10.
      clock += 29 * 60_000;
      expect(resolveFailoverTarget("opus").stepIndex).toBe(1);
      clock += 2 * 60_000; // past the 30-min rung
      expect(resolveFailoverTarget("opus").stepIndex).toBe(0);
    });

    it("a reset date already in the past never exempts a walled step from backoff", () => {
      initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
      const yesterday = new Date(clock - 24 * 3600_000);
      markStepFailed("opus", 0, "wall whose declared reset already elapsed", yesterday);
      expect(resolveFailoverTarget("opus").stepIndex).toBe(1); // backoff governs, not the stale date
    });
  });
});

// ── isQuotaExhaustion ──────────────────────────────────────────────────────────

describe("isQuotaExhaustion — narrow on purpose", () => {
  // #140: this body CONTAINS a wall keyword ("quota") — the old case matched no
  // keyword at all and passed trivially, giving apparent coverage on exactly
  // the property that was broken. The window, not the vocabulary, is what
  // disqualifies it.
  it("treats a per-minute burst that names 'quota' as NOT exhaustion", () => {
    expect(
      isQuotaExhaustion(
        429,
        "Quota exceeded for quota metric 'Generate requests per minute' and limit 'GenerateRequests per minute per project'"
      )
    ).toBe(false);
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

  // S4-0 boundary pin (#28): the upstream twin predicate
  // (handlers/shared/quota-exhaustion.ts — not in our tree) gates on
  // 401|403|429 because it feeds user-facing hints and chain-advance
  // warnings. OURS decides model substitution, where 401 is a wiring
  // mistake: substituting would hide a bad key behind a plausible-looking
  // answer. A wall-worded 401 must still never arm here — pinned so any
  // future unification "upward" fails on this line first.
  it("401 NEVER arms, even when the body carries wall wording (S4-0 asymmetry pin)", () => {
    expect(isQuotaExhaustion(401, "You've reached your usage limit for this billing cycle")).toBe(false);
    expect(isQuotaExhaustion(401, '{"error":{"message":"quota exceeded for this plan"}}')).toBe(false);
  });
});

// ── isWiringError ──────────────────────────────────────────────────────────────
//
// The gate on fail-forward. These cases are the ones that decide whether a
// misconfigured cascade step surfaces or becomes permanently invisible, so each
// assertion below is load-bearing rather than illustrative.

describe("isWiringError — what must never be advanced over", () => {
  it("treats auth/endpoint faults as wiring on status alone", () => {
    expect(isWiringError(401, "")).toBe(true);
    expect(isWiringError(403, "forbidden")).toBe(true);
    expect(isWiringError(404, "")).toBe(true);
  });

  it("recognizes a mistyped model id behind a 400 (GLM code 1500, real body)", () => {
    // Verbatim shape captured from GLM Coding. This is the case ai-01 raised:
    // pure wiring, and neither 401 nor 404.
    expect(
      isWiringError(
        400,
        '{"object":"error","message":"Invalid model: gc@glm-5.4","type":"invalid_model","code":"1500"}'
      )
    ).toBe(true);
  });

  it("recognizes the same fault however the provider words it", () => {
    expect(isWiringError(400, '{"error":{"message":"model not found"}}')).toBe(true);
    expect(isWiringError(400, "Unknown model: foo")).toBe(true);
  });

  it("does NOT claim a payload-shape 400 — those are worth advancing over", () => {
    // DeepSeek's real 400 (fixed in 911f426). Another provider may accept the same
    // payload, so this must fail-forward rather than surface.
    expect(
      isWiringError(400, '{"error":{"message":"reasoning_content must be passed back"}}')
    ).toBe(false);
  });

  it("does NOT claim transient upstream failures", () => {
    expect(isWiringError(500, "internal server error")).toBe(false);
    expect(isWiringError(502, "bad gateway")).toBe(false);
    expect(isWiringError(429, "rate limited")).toBe(false);
  });

  it("is disjoint from isQuotaExhaustion on every real wall body", () => {
    // A body must never be classified as both — quota is checked first in the
    // cascade, but an overlap would mean one of the two matchers is too broad.
    const walls = [
      [429, "Usage limit reached for 5 hour. Your limit will reset at 2026-08-19 16:47:38"],
      [429, "Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)"],
      [429, "Your token-plan 1-week quota has been exhausted. The quota will reset at 08-18 10:07:00 UTC."],
    ] as const;
    for (const [status, body] of walls) {
      expect(isQuotaExhaustion(status, body)).toBe(true);
      expect(isWiringError(status, body)).toBe(false);
    }
  });
});

// ── isQuotaExhaustion — CHARACTERIZATION against captured production bodies ────
//
// The cases above are synthetic: they state what we INTENDED the matcher to do.
// The cases below are what six providers actually sent the production hub over
// the seven days ending 2026-08-19, with their occurrence counts.
//
// This block passes by construction today. That is the point. It is a
// characterization harness, not a bug report: when the upstream sync lands
// (#200/#201, and the second predicate that arrived upstream with 3d4d8a9 in
// `handlers/shared/quota-exhaustion.ts`), it says whether the cascade still
// classifies REAL walls the same way — and names the provider that moved,
// instead of letting the cascade degrade in silence.
//
// Note for whoever does that sync: the two predicates live at DIFFERENT PATHS
// and therefore never conflict. git will happily keep both, and which one runs
// is decided at the call site in `composed-handler.ts`. There will be no merge
// marker to warn you.
//
// S4-0 reconciliation rules (#28, decided 2026-09-19) — do NOT unify:
//  - the two predicates answer DIFFERENT questions. Upstream's module feeds
//    user-facing hints, PAYG-hop warnings and per-provider terminality; ours
//    decides MODEL SUBSTITUTION (arming, cascade advance, relay deep-probe
//    liveness, retry-ladder skip) — the costliest decision, hence the
//    narrowness: 401/404 never arm, and the #140 window guard keeps a
//    per-minute burst from burning the weekly switch.
//  - absorbing the upstream module requires, BEFORE its first call site
//    runs on an arming path:
//      (a) a window guard (per minute/second/hour) on PLAN_LIMIT_PHRASES —
//          it still carries bare "quota", the exact defect #140 closed here;
//      (b) 401 out of its status gate, or the module restricted to
//          hint/warning call sites only;
//      (c) compound balance phrases ("credit balance", "insufficient
//          balance", "out of credits") preferred over our bare
//          credit/balance keywords — ours is the looser side of that
//          boundary (see the S4-0 disagreement table on #28).
//
// Deliberately NOT pinned: the only 402 in the capture store is a
// `"provider":"Mockwall"` simulated record. No real 402 exists on any production
// path — every wall across all six providers arrives as 429. Pinning a 402 as
// "real" would encode a fiction. Likewise there is no DeepSeek or Mistral wall
// here, and that is structural rather than a gap: DeepSeek is PAYG (it debits,
// it does not wall) and Mistral sits last in the sonnet cascade with credit
// remaining, so it receives no traffic. We invent neither.

/** GLM Coding Plan — 5-hour window wall. 978× / 7d. Verbatim. MUST arm. */
const GLM_1308_WINDOW_WALL =
  '{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-08-12 18:58:34"}}';

/** GLM Coding Plan — transient overload. 59× / 7d. Captured `error.message`. MUST NOT arm. */
const GLM_1305_OVERLOAD = "The service may be temporarily overloaded, please try again later";

/** GLM Coding Plan — plain per-request rate limit. 60× / 7d. Captured `error.message`. MUST NOT arm. */
const GLM_1302_RATE_LIMIT = "Rate limit reached for requests";

/** GLM Coding Plan — Fair Usage throttle. 1262× / 7d, the single most frequent. Captured `error.message`. MUST NOT arm. */
const GLM_1313_FAIR_USAGE =
  "Your account's current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited";

/** MiniMax Coding (haiku lane) — Token Plan wall. 666× / 7d. Verbatim. MUST arm. */
const MINIMAX_PLAN_WALL =
  '{"type":"error","error":{"type":"rate_limit_error","message":"Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)"},"request_id":"06cd2b0d6d5bff0be2821ef3b318dccd"}';

/** MiniMax Coding — cluster overload. 5× / 7d, arrives as 529. Verbatim. MUST NOT arm. */
const MINIMAX_OVERLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"The server cluster is currently under high load. Please retry after a short wait and thank you for your patience. (2064) (529)"},"request_id":"06cb511dd91128863d7ca1fbdedade75"}';

/** Qwen Token Plan — weekly quota wall. 51× / 7d. Verbatim. DashScope envelope. MUST arm. */
const QWEN_WEEKLY_WALL =
  '{"code":"Throttling.AllocationQuota","message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 08-18 10:07:00 UTC.","request_id":"fb4c609e-73a3-419f-8a3a-b4dbea11889e"}';

/**
 * Kimi Coding (kc@k3) — 5-hour rolling window spent. 2026-09-15, user-reported.
 * Verbatim upstream message; the client renders the 403 as "Failed to
 * authenticate", and a blanket `403 → wiring` rule compounded it, so the
 * cascade surfaced the error instead of advancing to DeepSeek Flash beneath.
 * MUST arm — a spent 5-hour window is a wall like any other.
 */
const KIMI_5H_WALL =
  '{"error":{"type":"invalid_request_error","message":"You\'ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota"}}';

/** A genuine auth 403 — no quota vocabulary. MUST NOT arm: swapping the model
 *  would hide a bad key behind a plausible-looking answer. */
const GENUINE_AUTH_403 = '{"error":{"type":"forbidden","message":"Invalid API key provided"}}';

/**
 * Anthropic — weekly usage cap on the subscription account. 2026-08-20, the
 * full opus exhaustion window (reset landed the next morning). The client
 * rendered: "Server is temporarily limiting requests (not your usage limit) ·
 * This request would exceed your account's rate limit. Please try again
 * later." — CC itself misread the cap as transient, and so did the cascade:
 * no quota keyword matched, the opus role never armed, and every session saw
 * the raw 429 instead of Qwen step 0. Verbatim upstream message. MUST arm.
 */
const ANTHROPIC_WEEKLY_CAP =
  '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';

/**
 * Anthropic — genuine per-minute limit. Same error.type as the weekly cap
 * above (see Trap 2), same "rate limit" vocabulary; the discriminator is the
 * named WINDOW ("tokens per minute"). MUST NOT arm — a burst must never burn
 * the weekly switch. Shape per Anthropic's documented rate-limit errors.
 */
const ANTHROPIC_PER_MINUTE =
  '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached for claude-opus-5 on tokens per minute (TPM): Limit 400000, Used 398800, Requested 3500. The limit will reset at 2026-08-21T09:00:00Z."}}';

describe("isQuotaExhaustion — captured production bodies (7d, 6 providers)", () => {
  it("ARMS on the four real plan walls", () => {
    expect(isQuotaExhaustion(429, GLM_1308_WINDOW_WALL)).toBe(true);
    expect(isQuotaExhaustion(429, MINIMAX_PLAN_WALL)).toBe(true);
    expect(isQuotaExhaustion(429, QWEN_WEEKLY_WALL)).toBe(true);
    expect(isQuotaExhaustion(429, ANTHROPIC_WEEKLY_CAP)).toBe(true);
  });

  it("does NOT arm on the five real transient bursts", () => {
    expect(isQuotaExhaustion(429, GLM_1305_OVERLOAD)).toBe(false);
    expect(isQuotaExhaustion(429, GLM_1302_RATE_LIMIT)).toBe(false);
    expect(isQuotaExhaustion(429, GLM_1313_FAIR_USAGE)).toBe(false);
    expect(isQuotaExhaustion(529, MINIMAX_OVERLOAD)).toBe(false);
    expect(isQuotaExhaustion(429, ANTHROPIC_PER_MINUTE)).toBe(false);
  });

  // ── Trap 3: the Anthropic cap shares vocabulary with its bursts ──
  //
  // "This request would exceed your account's rate limit" says "rate limit",
  // the one word the 429 branch exists to distrust. A future cleanup that
  // drops the account-vs-window clause as redundant would re-break the opus
  // cascade exactly as it broke on 2026-08-20. The two bodies differ ONLY in
  // account-vs-window phrasing — assert the matcher keys on that and nothing
  // looser ("exceed", "rate limit") that would sweep the per-minute body in.
  it("TRAP — the Anthropic cap and its per-minute burst share error.type and 'rate limit'; only the account-vs-window phrasing separates them", () => {
    expect(JSON.parse(ANTHROPIC_WEEKLY_CAP).error.type).toBe("rate_limit_error");
    expect(JSON.parse(ANTHROPIC_PER_MINUTE).error.type).toBe("rate_limit_error");
    expect(ANTHROPIC_WEEKLY_CAP.toLowerCase()).not.toContain("per minute");
    expect(ANTHROPIC_PER_MINUTE.toLowerCase()).toContain("per minute");
    // Sanity on the negative guards: a hypothetical body naming BOTH the
    // account and a window stays a burst — window wins.
    expect(
      isQuotaExhaustion(
        429,
        "This request would exceed your account's rate limit on tokens per minute"
      )
    ).toBe(false);
  });

  // ── Trap 1: broadening the matcher ──
  //
  // `usage limit` looks like it could safely be shortened to `usage`. It cannot:
  // GLM's Fair Usage throttle says "usage pattern" and "Fair Usage Policy", and
  // it fired 1262 times in seven days. Broadening would have burned the sonnet
  // budget switch 1262× on a throttle that clears on its own.
  it("TRAP — a real burst body contains 'usage' and must still NOT arm", () => {
    expect(GLM_1313_FAIR_USAGE.toLowerCase()).toContain("usage");
    expect(GLM_1313_FAIR_USAGE.toLowerCase()).not.toContain("usage limit");
    expect(isQuotaExhaustion(429, GLM_1313_FAIR_USAGE)).toBe(false);
  });

  // ── Trap 2: "cleaning up" to a structured criterion ──
  //
  // Substring matching on a message looks sloppy next to reading `error.type`.
  // But MiniMax labels its PLAN WALL `rate_limit_error` and its TRANSIENT
  // OVERLOAD `overloaded_error` — the structured field is not merely unhelpful
  // here, it points the wrong way. Keying on it would silently stop arming the
  // haiku failover, which is the lane MiniMax serves.
  it("TRAP — MiniMax labels its plan wall `rate_limit_error`, so error.type must not be the criterion", () => {
    expect(JSON.parse(MINIMAX_PLAN_WALL).error.type).toBe("rate_limit_error");
    expect(JSON.parse(MINIMAX_OVERLOAD).error.type).toBe("overloaded_error");
    // The verdicts are the opposite of what those labels suggest.
    expect(isQuotaExhaustion(429, MINIMAX_PLAN_WALL)).toBe(true);
    expect(isQuotaExhaustion(529, MINIMAX_OVERLOAD)).toBe(false);
  });

  // Documents why `allocationquota` sits in the 400/403/500 branch: the DashScope
  // envelope is the same whatever status carries it. Production sends it on 429;
  // this asserts the other branch would still recognize the same real body.
  it("recognizes the real Qwen envelope on the 400/403/500 branch too", () => {
    expect(isQuotaExhaustion(400, QWEN_WEEKLY_WALL)).toBe(true);
    expect(isQuotaExhaustion(403, QWEN_WEEKLY_WALL)).toBe(true);
  });

  // Kimi Coding's 5-hour window arrives as a 403 that ALSO matches isWiringError's
  // blanket `403 → wiring` rule. The cascade checks quota FIRST (proxy-server
  // handleWithCascade), so recognizing the wall here is what makes the step
  // advance to DeepSeek Flash within the same request instead of surfacing
  // "Failed to authenticate" to the client.
  it("arms on Kimi's 5-hour 403 wall, and keeps genuine auth 403s as wiring", () => {
    expect(isQuotaExhaustion(403, KIMI_5H_WALL)).toBe(true);
    // Both predicates fire on the spent window — the ORDER is the safety property.
    expect(isWiringError(403, KIMI_5H_WALL)).toBe(true);
    // A bare auth 403 names no quota: it must stay wiring (never advance).
    expect(isQuotaExhaustion(403, GENUINE_AUTH_403)).toBe(false);
    expect(isWiringError(403, GENUINE_AUTH_403)).toBe(true);
    expect(isQuotaExhaustion(403, "forbidden")).toBe(false);
  });
});

// ── #140: a per-minute burst that speaks quota vocabulary ──────────────────────
//
// Google's per-minute 429 bodies contain the word "quota", so the bare-keyword
// branch armed the weekly budget switch on a transient burst. Measured with a
// disposable probe by ai-01 (2026-09-18), control positives included: the four
// real walls still arm — the keywords carry their weight, the fix is a guard,
// not an amputation.

/** Google — per-minute request burst, verbatim probe body. Names "quota" AND a
 *  window; the window wins. MUST NOT arm. */
const GOOGLE_RPM_QUOTA_BURST =
  "Quota exceeded for quota metric 'Generate requests per minute' and limit 'GenerateRequests per minute per project'";

/**
 * Google — the #140 residue, pinned ON PURPOSE as arming. The same wording
 * serves per-minute AND per-day limits, so the body names NO window and is
 * structurally ambiguous: disambiguating it inside the classifier would
 * reproduce the original defect in the other direction (matching wide to catch
 * right is how the bare "quota" bug happened). The live protection sits one
 * layer up — Google sends `Retry-After` in seconds on its per-minute 429s, and
 * burstRetryAfterMs never lets a sub-ceiling retry-after arm (asserted below).
 */
const GOOGLE_RESOURCE_EXHAUSTED = "Resource has been exhausted (e.g. check quota).";

describe("isQuotaExhaustion — #140: per-minute bursts speaking quota vocabulary", () => {
  it("does NOT arm on Google's per-minute body — it names a window, the window wins", () => {
    expect(GOOGLE_RPM_QUOTA_BURST.toLowerCase()).toContain("quota");
    expect(GOOGLE_RPM_QUOTA_BURST.toLowerCase()).toContain("per minute");
    expect(isQuotaExhaustion(429, GOOGLE_RPM_QUOTA_BURST)).toBe(false);
  });

  it("the window guard covers every keyword of the branch, not just 'quota'", () => {
    expect(isQuotaExhaustion(429, "weekly usage limit reached on requests per minute")).toBe(false);
    expect(isQuotaExhaustion(429, "Your token-plan quota has been exhausted; requests per second limit hit")).toBe(false);
    expect(isQuotaExhaustion(429, "credit balance too low while calls per minute exceeded")).toBe(false);
    expect(isQuotaExhaustion(429, "plan limit reached — requests per hour")).toBe(false);
  });

  it("still arms on the four real walls: none of them names a window", () => {
    expect(isQuotaExhaustion(429, GLM_1308_WINDOW_WALL)).toBe(true);
    expect(isQuotaExhaustion(429, MINIMAX_PLAN_WALL)).toBe(true);
    expect(isQuotaExhaustion(429, QWEN_WEEKLY_WALL)).toBe(true);
    expect(isQuotaExhaustion(429, ANTHROPIC_WEEKLY_CAP)).toBe(true);
  });

  it("RESIDUE (pinned deliberately): the windowless Google body still arms in the classifier", () => {
    expect(GOOGLE_RESOURCE_EXHAUSTED.toLowerCase()).not.toMatch(/per (minute|second|hour)/);
    expect(isQuotaExhaustion(429, GOOGLE_RESOURCE_EXHAUSTED)).toBe(true);
  });

  it("RESIDUE covered one layer up: a sub-ceiling Retry-After keeps the ambiguous body from arming (#91 gate)", () => {
    initFailover({ ...OPUS_TO_QWEN, CLAUDISH_FAILOVER_AUTO: "1", CLAUDISH_FAILOVER_ARM_AFTER: "1" });
    for (let i = 0; i < 3; i++) {
      const v = onNominalRefusal("opus", "HTTP 429", "30", GOOGLE_RESOURCE_EXHAUSTED);
      expect(v.outcome).toBe("burst");
    }
    expect(isFailoverActive("opus")).toBe(false);
  });
});

describe("roleFromModelName", () => {
  it("maps the names Claude Code actually sends", () => {
    expect(roleFromModelName("claude-opus-5")).toBe("opus");
    expect(roleFromModelName("claude-sonnet-5")).toBe("sonnet");
    expect(roleFromModelName("claude-3-5-haiku-20241022")).toBe("haiku");
    expect(roleFromModelName("claude-fable-5-1")).toBe("fable");
  });

  it("returns null for anything else (no aliases configured)", () => {
    expect(roleFromModelName("glm-5.2")).toBeNull();
    expect(roleFromModelName("mmc@MiniMax-M3")).toBeNull();
    expect(roleFromModelName("")).toBeNull();
    expect(roleFromModelName(undefined)).toBeNull();
  });

  it("honors CLAUDISH_FAILOVER_ROLE_MODELS aliases for nominal-by-name clients", () => {
    initFailover({
      CLAUDISH_FAILOVER_ROLE_MODELS: "glm-5.2:sonnet,minimax-m3:haiku,story-latest:fable",
    } as NodeJS.ProcessEnv);
    expect(roleFromModelName("glm-5.2")).toBe("sonnet");
    expect(roleFromModelName("gc@glm-5.2")).toBe("sonnet");
    expect(roleFromModelName("mmc@MiniMax-M3")).toBe("haiku");
    expect(roleFromModelName("MiniMax-M3")).toBe("haiku");
    expect(roleFromModelName("vendor@story-latest")).toBe("fable");
    // Role keywords still win; unmatched names stay null.
    expect(roleFromModelName("claude-sonnet-4-6")).toBe("sonnet");
    expect(roleFromModelName("deepseek-v4-flash")).toBeNull();
  });

  it("skips malformed aliases and resets them on re-init", () => {
    initFailover({
      CLAUDISH_FAILOVER_ROLE_MODELS: "glm-5.2:sonnet,bogus:rolenope,::x,deepseek",
    } as NodeJS.ProcessEnv);
    expect(roleFromModelName("glm-5.2")).toBe("sonnet");
    expect(roleFromModelName("deepseek-v4-flash")).toBeNull();
    // Re-init without the alias clears it.
    initFailover({} as NodeJS.ProcessEnv);
    expect(roleFromModelName("glm-5.2")).toBeNull();
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

  it("scopes to the requesting role — a sonnet compact carries no haiku failover", () => {
    // Cluster state: haiku armed (MiniMax walled → DeepSeek), sonnet nominal.
    initFailover({
      ...HAIKU_TO_DEEPSEEK,
      CLAUDISH_FAILOVER_ACTIVE: "haiku",
    });
    // Unscoped (legacy/aggregate view) still reports every armed role…
    expect(buildFailoverNotice()).toContain("DeepSeek v4 Flash");
    // …but a sonnet session's condensation must NOT be told its requests
    // are substituted when they are served by the nominal sonnet model.
    expect(buildFailoverNotice("sonnet")).toBeNull();
    const msg = { content: [{ type: "text", text: "Summary." }] };
    appendFailoverNoticeToMessage(msg, "sonnet");
    expect(msg.content[0].text).toBe("Summary.");
    // The haiku session's own condensation still gets its notice.
    expect(buildFailoverNotice("haiku")).toContain("DeepSeek v4 Flash");
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

  it("names the steps still downstream of the serving step, none on the terminal step", () => {
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
    markStepFailed("opus", 0, "qwen walled mid-session"); // serving step 1 (GLM-5.2)
    const mid = consumeStreamNotice("opus", "sess-rem-mid");
    expect(mid).toContain("Remaining fallbacks: DeepSeek PAYG");

    markStepFailed("opus", 1, "glm walled mid-session"); // serving terminal step 2 (PAYG)
    const term = consumeStreamNotice("opus", "sess-rem-term");
    expect(term).toContain("3rd fallback");
    expect(term).not.toContain("Remaining fallbacks");
  });

  it("notices state capability only — no behavioral instructions (doctrine 2026-08-23)", () => {
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" }); // directions: degraded>degraded>improved
    markStepFailed("opus", 0, "qwen walled mid-session"); // serving step 1 (degraded)
    const degraded = consumeStreamNotice("opus", "sess-doctrine-degraded");
    expect(degraded).toContain("Capability note:");
    expect(degraded).not.toMatch(
      /be more conservative|fewer risks|Resume your normal|Scale back|take on tasks you deferred|clean up/i
    );

    markStepFailed("opus", 1, "glm walled mid-session"); // serving terminal step 2 (improved)
    const improved = consumeStreamNotice("opus", "sess-doctrine-improved");
    expect(improved).toContain("stronger than the nominal");
    expect(improved).not.toMatch(/use the extra capability|loose ends/i);
  });

  it("does not re-announce a depth already announced when the resolver drops back to it", () => {
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "opus" });
    expect(consumeStreamNotice("opus", "sess-osc")).toContain("1st fallback");
    markStepFailed("opus", 0, "qwen walled mid-session"); // now serving step 1
    expect(consumeStreamNotice("opus", "sess-osc")).toContain("2nd fallback");
    // A re-probed step whose failure state is cleared resolves again — without the
    // announced-depth SET the notice fired on every oscillation (observed as a
    // per-turn spam of the same fallback warning).
    resetStepSuccess("opus", 0);
    expect(consumeStreamNotice("opus", "sess-osc")).toBeNull();
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

  // #34 — recovery notices must speak capability ("working scope"), never posture.
  // "risk appetite" reads as a safety-rule instruction and "clean up ... decisions"
  // as an order to undo prior work: both are indistinguishable from an injection.
  it("recovery notices contain no posture vocabulary (no risk appetite, no undo directive)", () => {
    resetFailoverForTests();
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_AUTO: "1" });
    armFailover("opus", "weekly wall");
    clock += 11 * 60 * 1000;
    isFailoverActive("opus");
    onNominalSuccess("opus");

    const banned = [/risk appetite/i, /clean up (any )?over-conservative/i, /recalibrate upward/i];
    for (const text of [buildFailoverNotice()!, consumeStreamNotice("opus", "sess-guard")!]) {
      for (const re of banned) expect(text).not.toMatch(re);
    }
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

  it("RACE: already-armed armFailover() must not read as failure (concurrent disarm-window requests)", () => {
    // Production 2026-08-20 20:05Z: the 10-min disarm probe opened the window;
    // request A resolved pre-arm (NativeHandler), request B armed the role from
    // ITS cascade; A's own armFailover then returned false (already armed) and
    // handleWithCascade surfaced the raw 429 — the client died on "API Error".
    // The loop now treats false-but-active as success; this test pins the
    // primitive so neither side regresses: false CAN mean already-armed, and
    // isFailoverActive is the discriminator the loop relies on.
    resetFailoverForTests();
    initFailover({ ...OPUS_CASCADE, CLAUDISH_FAILOVER_AUTO: "1" });
    // Request B arms first.
    expect(armFailover("opus", "HTTP 429 from claude-opus")).toBe(true);
    // Request A's late arm attempt loses the race…
    expect(armFailover("opus", "HTTP 429 from claude-opus")).toBe(false);
    // …but the loop's discriminator must see an active failover and retry
    // into the cascade rather than surfacing the 429.
    expect(isFailoverActive("opus")).toBe(true);
    expect(resolveFailoverTarget("opus").step?.target).toBe("qwen-token-plan@qwen3.8-max");
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

// #91 point 3 — hysteresis on the re-probe. A flat 10-minute arm TTL oscillates
// for as long as a real wall holds: disarm → probe (a live user request) → 429 →
// re-arm, ~6 provider switches per hour, cold prompt-cache on both ends every
// time (measured: 107 arms ≈ 214 model transitions per 24 h). The TTL now grows
// with each disarm→re-arm cycle (10 m → 20 m → 40 m, capped) and resets on any
// nominal success — fresh episode.
describe("#91 point 3 — arm-TTL hysteresis (the re-probe backoff)", () => {
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

  it("the FIRST arm holds the base 10 min (no escalation from nothing)", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    clock += 9 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(true);
    clock += 2 * 60 * 1000; // 11 min — past base TTL
    expect(isFailoverActive("sonnet")).toBe(false);
  });

  it("a disarm→re-arm escalates the next arm to 20 min, then caps at 40 min", () => {
    // Episode 1: base 10 min.
    expect(armFailover("sonnet", "wall")).toBe(true);
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(false); // disarm #1
    expect(armFailover("sonnet", "still walled")).toBe(true); // re-arm → 20 min
    clock += 15 * 60 * 1000; // 15 min — would have expired a base arm
    expect(isFailoverActive("sonnet")).toBe(true);
    clock += 6 * 60 * 1000; // 21 min total — past 20 min
    expect(isFailoverActive("sonnet")).toBe(false); // disarm #2
    expect(armFailover("sonnet", "still walled")).toBe(true); // re-arm → 40 min (cap)
    clock += 35 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(true);
    clock += 6 * 60 * 1000; // 41 min — past 40 min
    expect(isFailoverActive("sonnet")).toBe(false); // disarm #3
    expect(armFailover("sonnet", "still walled")).toBe(true); // stays capped at 40 min
    clock += 39 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(true);
    clock += 2 * 60 * 1000; // 41 min
    expect(isFailoverActive("sonnet")).toBe(false);
  });

  it("a nominal success resets the escalation — the next episode starts at 10 min", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(false); // disarm #1
    expect(armFailover("sonnet", "still walled")).toBe(true); // 20 min
    clock += 21 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(false); // disarm #2 — but the wall lifted:
    onNominalSuccess("sonnet"); // the probe SUCCEEDED → fresh episode
    expect(armFailover("sonnet", "a NEW wall hours later")).toBe(true); // back to base
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(false); // base 10 min held
  });

  it("a re-arm long after the last disarm is a fresh episode (escalation decayed)", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(false); // disarm #1
    clock += 45 * 60 * 1000; // > ARM_TTL_MAX_MS with no re-arm — episode is over
    expect(armFailover("sonnet", "a new wall, much later")).toBe(true); // base, not 20 min
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(false); // base 10 min held
  });

  it("bounded switches: with a wall held for an hour, at most 2 re-arms (was ~6)", () => {
    let arms = 0;
    let switches = 0;
    const min = (n: number) => n * 60 * 1000;
    expect(armFailover("sonnet", "wall")).toBe(true);
    arms++;
    for (let t = 0; t < 60 * 60 * 1000; t += min(1)) {
      clock += min(1);
      if (!isFailoverActive("sonnet")) {
        // Disarmed at the TTL boundary: the wall still holds, the next request
        // re-arms (that re-arm is one more provider switch).
        if (armFailover("sonnet", "wall holds")) {
          arms++;
          switches++;
        }
      }
    }
    // 60 min of wall: base 10 + escalated 20 + part of the 40 → 2 re-arms, 3 arms.
    // Pre-#91-point-3 this was ~6 arms in the same hour (flat 10-min TTL).
    expect(arms).toBeLessThanOrEqual(3);
    expect(switches).toBeLessThanOrEqual(2);
  });
});

// #91 point 4 — per-session dwell. Every provider switch re-colds the prompt
// cache at BOTH ends; the role-level dampers (points 1-3) bound how often
// switches happen, this bounds how often ONE CONVERSATION rides them: a session
// keeps its resolved step for at least CLAUDISH_FAILOVER_SESSION_DWELL_MS
// (default 10 min, 0 = off), so the disarm→nominal→re-arm oscillation moves
// traffic only BETWEEN conversations, never under one.
describe("#91 point 4 — per-session dwell", () => {
  const ENV = {
    CLAUDISH_FAILOVER_SONNET: "ds@deepseek-v4-flash>ds@deepseek-payg",
    CLAUDISH_FAILOVER_SONNET_LABEL: "Flash>PAYG",
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

  it("a session holds its step across the disarm/re-arm oscillation (the anti-flap core)", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0); // pinned
    // The session stays active (renewing the sliding dwell) while the role
    // disarms at its TTL — a fresh walk would serve the nominal…
    clock += 9 * 60 * 1000;
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0); // renewal
    clock += 2 * 60 * 1000; // t=11min: role-arm TTL (10 min) has elapsed
    expect(isFailoverActive("sonnet")).toBe(false);
    // …but the pinned session still gets its step: one conversation, one switch.
    const held = resolveFailoverTargetForSession("sonnet", "sess-A");
    expect(held.stepIndex).toBe(0);
    expect(held.step?.target).toBe("ds@deepseek-v4-flash");
    // A DIFFERENT session (no pin) probes the nominal as designed.
    expect(resolveFailoverTargetForSession("sonnet", "sess-B").stepIndex).toBe(-1);
  });

  it("an idle session's dwell expires: it re-resolves at the fresh walk", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
    clock += 9 * 60 * 1000;
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0); // pin until t=19min
    clock += 2 * 60 * 1000; // role disarmed at 10min
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0); // still held
    // The session goes IDLE; its pin (renewed at t=9min, expires t=19min) lapses.
    clock += 11 * 60 * 1000; // t=20min > pin.until
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(-1);
    // Re-arm; the next resolve re-pins at the current walk.
    expect(armFailover("sonnet", "still walled")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
  });

  it("the pin YIELDS when the pinned step itself walls (genuine advancement, not oscillation)", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
    // Step 0 walls twice → 30-min step TTL: the walk advances past it.
    markStepFailed("sonnet", 0, "flash weekly");
    markStepFailed("sonnet", 0, "flash weekly");
    const advanced = resolveFailoverTargetForSession("sonnet", "sess-A");
    expect(advanced.stepIndex).toBe(1); // pin yielded, re-pinned at step 1
    expect(advanced.step?.target).toBe("ds@deepseek-payg");
  });

  it("nominal is never pinned — arming does not feed a session back into the wall", () => {
    // Session resolves while healthy (nominal, no pin).
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(-1);
    expect(armFailover("sonnet", "wall")).toBe(true);
    // No nominal pin means the armed walk serves step 0 immediately.
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
  });

  it("inert with CLAUDISH_FAILOVER_SESSION_DWELL_MS=0 (today's behaviour)", () => {
    resetFailoverForTests({ ...ENV, CLAUDISH_FAILOVER_SESSION_DWELL_MS: "0" });
    Date.now = () => clock;
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
    clock += 11 * 60 * 1000;
    expect(isFailoverActive("sonnet")).toBe(false);
    // Dwell off: the session follows the role state to nominal immediately.
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(-1);
  });

  it("an in-flight session does not change provider more than once per dwell period", () => {
    // The acceptance criterion, end to end: the role-level state machine churns
    // (disarm at the base arm TTL of 10 min, escalation, re-arm) for 25 minutes
    // while the session makes a request every minute — its resolved target must
    // be IDENTICAL throughout. Pre-dwell this oscillation flipped the serving
    // model under the conversation at every state transition.
    expect(armFailover("sonnet", "wall")).toBe(true);
    const seen = new Set<string>();
    for (let t = 0; t < 25; t++) {
      clock += 60 * 1000;
      isFailoverActive("sonnet"); // drives the role-level state machine
      seen.add(resolveFailoverTargetForSession("sonnet", "sess-A").step?.target || "nominal");
    }
    expect(seen.size).toBe(1); // step 0 the whole way: one switch (the arm), zero after
  });
});

// #276 — non-quota death of a dwell-pinned step must not deepen the pin.
// Measured 2026-09-28 (hub po-2025): armed 11:05Z, a session dwell-pinned to
// cascade step 2 (qwen-token-plan@deepseek-v4.1-flash) received the wrapped
// content-filter false positive `HTTP 400 {"code":"InvalidParameter", …
// "data_inspection_failed"}` at 12:31Z. The non-quota fail-forward advanced the
// walk AND the resolution re-pinned the session at the NEXT step — the PAYG
// tail — where the renewed dwell held it for hours while the nominal sat
// healthy at 47%: no pinned session ever probed the nominal, so no recovery
// stamp (#294) ever landed either. The pin was the only thing outliving the
// 10-min bucket wall, and it did.
describe("#276 — non-quota step death forfeits the dwell", () => {
  const ENV = {
    CLAUDISH_FAILOVER_SONNET: "ds@deepseek-v4-flash>ds@deepseek-payg",
    CLAUDISH_FAILOVER_SONNET_LABEL: "Flash>PAYG",
    CLAUDISH_FAILOVER_AUTO: "1",
    // 1 h: the pin must not be what outlives the 10-min bucket wall — the
    // incident shape (a default 10-min dwell would lapse with the wall and
    // hide the defect).
    CLAUDISH_FAILOVER_SESSION_DWELL_MS: "3600000",
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

  it("measured case: successor serves unpinned; after the wall expires the session returns to the NOMINAL, not the PAYG tail", () => {
    expect(armFailover("sonnet", "HTTP 429 weekly limit")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-276").stepIndex).toBe(0);
    expect(getSessionDwellPinForTests("sonnet", "sess-276")?.stepIndex).toBe(0);
    // The 12:31Z shape: non-quota, non-wiring (400 data_inspection_failed).
    markStepFailed("sonnet", 0, "HTTP 400 (non-quota) from step 0", undefined, { nonQuota: true });
    // While the wall holds, the walk still fail-forwards to step 1 (PAYG) —
    // but the dwell is FORFEITED, not re-pinned: the step is broken, not walled.
    const advanced = resolveFailoverTargetForSession("sonnet", "sess-276");
    expect(advanced.stepIndex).toBe(1);
    expect(advanced.step?.target).toBe("ds@deepseek-payg");
    expect(getSessionDwellPinForTests("sonnet", "sess-276")).toBeNull();
    // The SIBLING resolution of the same cascade attempt (the loop resolves
    // twice per attempt — swap + loop read) must not re-pin either: that is
    // the tombstone's job, and without it the fix is erased in-request.
    expect(resolveFailoverTargetForSession("sonnet", "sess-276").stepIndex).toBe(1);
    expect(getSessionDwellPinForTests("sonnet", "sess-276")).toBeNull();
    // The wall expires (10-min TTL). An unpinned session rejoins the general
    // resolution: nominal. Without the forfeit, the re-pinned step-1 pin (1 h)
    // holds past the expiry — the measured defect.
    clock += 11 * 60 * 1000;
    expect(resolveFailoverTargetForSession("sonnet", "sess-276").stepIndex).toBe(-1);
  });

  it("negative: a QUOTA death still re-pins the successor — the dwell holds past the wall expiry (genuine advancement)", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-q").stepIndex).toBe(0);
    markStepFailed("sonnet", 0, "flash weekly"); // quota-class — no flag
    const advanced = resolveFailoverTargetForSession("sonnet", "sess-q");
    expect(advanced.stepIndex).toBe(1);
    expect(getSessionDwellPinForTests("sonnet", "sess-q")?.stepIndex).toBe(1); // re-pinned deeper
    clock += 11 * 60 * 1000;
    // The pin holds through the wall expiry — the anti-flap core, untouched.
    expect(resolveFailoverTargetForSession("sonnet", "sess-q").stepIndex).toBe(1);
  });

  it("negative: a wiring fault never marks the step — the pin holds, nothing arms", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-w").stepIndex).toBe(0);
    // 401/404 surface BEFORE markStepFailed on the proxy site (STEP-WIRING) —
    // the step record and the pin are untouched by design.
    expect(isWiringError(401, "")).toBe(true);
    expect(isWiringError(404, "")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-w").stepIndex).toBe(0);
    expect(getSessionDwellPinForTests("sonnet", "sess-w")?.stepIndex).toBe(0);
  });

  it("the forfeit is bounded: after one dwell window, ordinary dwell resumes", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-b").stepIndex).toBe(0);
    markStepFailed("sonnet", 0, "HTTP 400 (non-quota) from step 0", undefined, { nonQuota: true });
    expect(resolveFailoverTargetForSession("sonnet", "sess-b").stepIndex).toBe(1);
    expect(getSessionDwellPinForTests("sonnet", "sess-b")).toBeNull();
    // t=+9 min: wall, step-0 backoff and forfeit all still hold.
    clock += 9 * 60 * 1000;
    expect(resolveFailoverTargetForSession("sonnet", "sess-b").stepIndex).toBe(1);
    expect(getSessionDwellPinForTests("sonnet", "sess-b")).toBeNull();
    // t=+61 min: forfeit (one dwell window) and every backoff lapsed. Re-arm
    // and the session re-pins like any other — the forfeit is not permanent.
    clock += 52 * 60 * 1000;
    expect(armFailover("sonnet", "re-armed")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-b").stepIndex).toBe(0);
    expect(getSessionDwellPinForTests("sonnet", "sess-b")?.stepIndex).toBe(0);
  });

  // ── review of #316 (mutations Ma / Mc / bound) ─────────────────────────────
  //
  // Ma: the isStepTtlFailed guard inside pinnedDiedNonQuota. The nonQuota flag
  // outlives the step's backoff (only a success or a re-mark clears the record),
  // so a role-step whose DELEGATION died while carrying a stale flag must take
  // the ordinary dead-delegation path — re-resolve and RE-PIN — not forfeit.
  it("Ma: a STALE nonQuota flag + a dead delegation ⇒ re-resolve and re-pin, not forfeit", () => {
    initFailover({
      CLAUDISH_FAILOVER_OPUS: "role:sonnet>ds@deepseek-payg",
      CLAUDISH_FAILOVER_AUTO: "1",
      CLAUDISH_FAILOVER_SESSION_DWELL_MS: "3600000",
    });
    // Opus's nominal gets its OWN bucket (a legacy "*" arm would wall sonnet's
    // nominal too and the delegation would be skipped from the start).
    const OPUS_BUCKET = "opus-nom-bucket";
    const nominals: Record<string, string | undefined> = {
      opus: "ep-a@fake-opus-nom",
      sonnet: "ds@deepseek-v4-flash",
    };
    setRoleNominalResolver((r) => nominals[r]);
    expect(armFailover("opus", "wall", OPUS_BUCKET)).toBe(true);
    expect(resolveFailoverTargetForSession("opus", "sess-ma", OPUS_BUCKET).stepIndex).toBe(0);
    expect(getSessionDwellPinForTests("opus", "sess-ma")?.stepIndex).toBe(0);
    // Step 0 dies non-quota at t0; nothing re-visits it, so at t+11 its backoff
    // has lapsed while the record still carries the flag.
    markStepFailed("opus", 0, "HTTP 400 (non-quota) from step 0", undefined, { nonQuota: true });
    clock += 10 * 60 * 1000;
    expect(armFailover("opus", "still walled", OPUS_BUCKET)).toBe(true); // stay armed past the wall TTL
    clock += 1 * 60 * 1000; // t+11: backoff lapsed, flag stale
    // The delegation DIES: sonnet has neither a nominal nor a cascade anymore.
    setRoleNominalResolver((r) => (r === "sonnet" ? undefined : nominals[r]));
    const r = resolveFailoverTargetForSession("opus", "sess-ma", OPUS_BUCKET);
    expect(r.stepIndex).toBe(1); // re-resolved at the PAYG step…
    expect(r.step?.target).toBe("ds@deepseek-payg");
    expect(getSessionDwellPinForTests("opus", "sess-ma")?.stepIndex).toBe(1); // …and RE-PINNED
  });

  // Mc: the back-at-nominal branch clears the tombstone, so a re-arm INSIDE the
  // forfeit window re-establishes ordinary dwell instead of serving unpinned.
  it("Mc: a return to the nominal clears the tombstone — a re-arm within the window pins", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-mc").stepIndex).toBe(0);
    markStepFailed("sonnet", 0, "HTTP 400 (non-quota) from step 0", undefined, { nonQuota: true });
    expect(resolveFailoverTargetForSession("sonnet", "sess-mc").stepIndex).toBe(1); // forfeited
    expect(getSessionDwellPinForTests("sonnet", "sess-mc")).toBeNull();
    expect(getDwellYieldTombstoneCountForTests("sonnet")).toBe(1);
    clock += 11 * 60 * 1000; // the wall lapses
    expect(resolveFailoverTargetForSession("sonnet", "sess-mc").stepIndex).toBe(-1); // nominal
    expect(getDwellYieldTombstoneCountForTests("sonnet")).toBe(0); // cleared with the pin
    // Re-arm WITHIN the forfeit window (it runs to t0+60 min): the session
    // must pin at the walk again — a stale tombstone would serve it unpinned.
    expect(armFailover("sonnet", "re-armed")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-mc").stepIndex).toBe(0);
    expect(getSessionDwellPinForTests("sonnet", "sess-mc")?.stepIndex).toBe(0);
  });

  // Bound (review of #316): an entry otherwise leaves only when its OWN session
  // resolves again, so a conversation that ends right after its forfeit leaves
  // its entry for the process lifetime. Lapsed entries are swept on the write
  // past DWELL_TOMBSTONES_MAX.
  it("the forfeit map is bounded: lapsed entries are swept on the write past the cap", () => {
    expect(armFailover("sonnet", "wall")).toBe(true);
    // Exactly DWELL_TOMBSTONES_MAX sessions (one more would trip the PIN map's
    // own DWELL_PINS_MAX prune and evict a pin before its forfeit).
    for (let i = 0; i < DWELL_TOMBSTONES_MAX; i++) {
      expect(resolveFailoverTargetForSession("sonnet", `sess-cap-${i}`).stepIndex).toBe(0);
    }
    markStepFailed("sonnet", 0, "HTTP 400 (non-quota) from step 0", undefined, { nonQuota: true });
    for (let i = 0; i < DWELL_TOMBSTONES_MAX; i++) {
      expect(resolveFailoverTargetForSession("sonnet", `sess-cap-${i}`).stepIndex).toBe(1);
    }
    // Nothing lapsed yet — live forfeits are never evicted.
    expect(getDwellYieldTombstoneCountForTests("sonnet")).toBe(DWELL_TOMBSTONES_MAX);
    // Everything lapses (one dwell window); the NEXT forfeit — the N+1th
    // write, now writing into a map at the cap — sweeps the lapsed entries first.
    clock += 61 * 60 * 1000;
    expect(armFailover("sonnet", "re-armed")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-sweep").stepIndex).toBe(0);
    markStepFailed("sonnet", 0, "HTTP 400 (non-quota) from step 0", undefined, { nonQuota: true });
    expect(resolveFailoverTargetForSession("sonnet", "sess-sweep").stepIndex).toBe(1);
    expect(getDwellYieldTombstoneCountForTests("sonnet")).toBe(1);
  });
});

// Nominal-recovery yield — the exit the dwell lacked (measured 2026-10-01,
// minimax wall 19:23→20:08Z): new sessions returned to the nominal within ~2 min
// of the wall lifting, but conversations pinned by the dwell rode the fallback
// for as long as they lived, because the pin only ever yielded on step-death.
// The yield fires on a VERIFIED recovery (onNominalSuccess — a real nominal
// request succeeded; a TTL expiry only STARTS a probe and proves nothing) held
// for recoveryGraceMs (default 2 min), and any re-arm voids the marker.
describe("dwell — nominal-recovery yield", () => {
  const ENV = {
    CLAUDISH_FAILOVER_SONNET: "ds@deepseek-v4-flash>ds@deepseek-payg",
    CLAUDISH_FAILOVER_SONNET_LABEL: "Flash>PAYG",
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

  /** Arm, pin the session at step 0, keep the pin alive across the wall's TTL
   * expiry. Leaves the clock at t=11min with the wall expired and NO nominal
   * request served yet. */
  function pinThenLift(session: string, bucket?: string): void {
    expect(armFailover("sonnet", "wall", bucket ?? "*")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", session, bucket).stepIndex).toBe(0);
    clock += 9 * 60 * 1000;
    expect(resolveFailoverTargetForSession("sonnet", session, bucket).stepIndex).toBe(0); // renew
    clock += 2 * 60 * 1000; // t=11min: wall TTL (10 min) expired
    expect(isFailoverActive("sonnet", bucket)).toBe(false);
  }

  /** pinThenLift + one served nominal request (the verified recovery). */
  function pinThenRecover(session: string, bucket?: string): void {
    pinThenLift(session, bucket);
    onNominalSuccess("sonnet", bucket ?? "*"); // the probe SUCCEEDED
  }

  it("a live pin YIELDS to the nominal once a verified recovery is older than the grace", () => {
    pinThenRecover("sess-A");
    clock += 60 * 1000; // t=12min: 1 min after the recovery — grace is 2 min
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0); // held
    clock += 2 * 60 * 1000; // t=14min: 3 min after the recovery
    const yielded = resolveFailoverTargetForSession("sonnet", "sess-A");
    expect(yielded.stepIndex).toBe(-1); // back at the nominal
    expect(yielded.step).toBeNull();
    // The yield removed the pin: nominal is never re-pinned, later resolves stay.
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(-1);
  });

  it("a TTL expiry alone does NOT un-pin — only a served nominal request does", () => {
    // Same shape as pinThenRecover minus the onNominalSuccess: the wall expires,
    // a NEW session walks to the nominal, but no nominal request has been
    // SERVED yet, so the pinned conversation must keep its step.
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
    clock += 9 * 60 * 1000;
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0); // renew
    clock += 2 * 60 * 1000; // t=11min: wall TTL expired, pin (until t=19min) live
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(resolveFailoverTargetForSession("sonnet", "sess-B").stepIndex).toBe(-1); // fresh walk probes
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0); // pin holds
    clock += 3 * 60 * 1000; // t=14min: no recovery ever verified — still holds
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
  });

  it("a re-arm voids the marker: the pin re-holds until the nominal proves itself again", () => {
    pinThenRecover("sess-A");
    clock += 3 * 60 * 1000; // t=14min: past the grace — but the wall came back first
    expect(armFailover("sonnet", "refused again")).toBe(true);
    const held = resolveFailoverTargetForSession("sonnet", "sess-A");
    expect(held.stepIndex).toBe(0); // re-held: no provider switch back into the wall
    expect(held.step?.target).toBe("ds@deepseek-v4-flash");
    // The marker is gone for real: with the wall holding, repeated resolves
    // (each renewing the sliding dwell) keep serving the step, grace or not.
    clock += 6 * 60 * 1000; // t=20min
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
    clock += 6 * 60 * 1000; // t=26min
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
  });

  it("bucket-scoped: a sibling bucket's recovery cannot un-pin this bucket's sessions", () => {
    // The mixed state of 2026-09-28 (native sonnet walled while z.ai served
    // nominal successes): role-keyed, every request of the still-walled bucket
    // would yield, re-resolve to the fallback step and re-pin — a two-log-line
    // loop per request for as long as the mixed state held.
    expect(armFailover("sonnet", "wall", "native-bucket")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-N", "native-bucket").stepIndex).toBe(0);
    clock += 9 * 60 * 1000;
    expect(resolveFailoverTargetForSession("sonnet", "sess-N", "native-bucket").stepIndex).toBe(0); // renew
    clock += 3 * 60 * 1000; // t=12min: wall TTL (10 min) expired → probeable
    onNominalSuccess("sonnet", "zai-coding"); // the SIBLING bucket recovers
    clock += 3 * 60 * 1000; // t=15min: sibling grace elapsed, native pin live (until t=19)
    // native-bucket never verified a recovery: the pin holds.
    expect(resolveFailoverTargetForSession("sonnet", "sess-N", "native-bucket").stepIndex).toBe(0);
    // Its OWN nominal now succeeds → its sessions yield too.
    onNominalSuccess("sonnet", "native-bucket");
    clock += 3 * 60 * 1000; // t=18min: own grace elapsed
    expect(resolveFailoverTargetForSession("sonnet", "sess-N", "native-bucket").stepIndex).toBe(-1);
  });

  // Coordinator probes (review of the first cut, 01/10). The stamp must age
  // from the FIRST post-arm success only, and never be written under a live
  // wall — otherwise the fix fails under exactly the traffic it targets.
  it("P1 — a BUSY nominal releases the pins: the stamp is not refreshed by later successes", () => {
    // The post-lift state measured on the hub: the nominal serves someone every
    // ~10 s (minimax 23-29 responses / 5 min). If every success re-stamped, the
    // grace would measure since the LAST success and no pinned session would
    // EVER yield while the nominal is busy — the defect the review caught.
    pinThenLift("sess-A");
    const perMinute: number[] = [];
    for (let s = 0; s <= 300; s += 10) {
      onNominalSuccess("sonnet"); // other sessions' requests, every 10 s
      clock += 10 * 1000;
      if (s % 60 === 0) perMinute.push(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex);
    }
    // Held through the 2-min grace (minutes 0-1), yielded from minute 2 on —
    // the recovery is measured from the FIRST success, not the last.
    expect(perMinute).toEqual([0, 0, -1, -1, -1, -1]);
  });

  it("P2 — control: a busy nominal that then goes QUIET still yields (grace from the first success)", () => {
    pinThenLift("sess-A");
    for (let s = 0; s <= 300; s += 10) {
      onNominalSuccess("sonnet");
      clock += 10 * 1000;
      resolveFailoverTargetForSession("sonnet", "sess-A"); // renewing reads
    }
    clock += 3 * 60 * 1000; // quiet: no success for 3 min (>> grace)
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(-1);
  });

  it("P3 — an in-flight success under a LIVE wall never stamps: no yield lines while the wall holds", () => {
    // The false-recovery shape measured 19:23:33Z: ARMED, then a success 458 ms
    // later from a request admitted before the arm. A stamp written there would
    // age under the wall (the bucket diverts every new request, nothing
    // refreshes it), past the grace every pinned request would yield →
    // re-resolve to the same armed step → re-pin, and at the wall's TTL expiry
    // the stale stamp would mass-un-pin with NO verified post-lift success.
    const writes: string[] = [];
    const origWrite = process.stderr.write;
    const realWrite = process.stderr.write.bind(process.stderr) as (c: string) => boolean;
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown) => {
      const s = String(chunk);
      writes.push(s);
      return realWrite(s);
    };
    try {
      expect(armFailover("sonnet", "wall", "minimax")).toBe(true);
      expect(resolveFailoverTargetForSession("sonnet", "sess-A", "minimax").stepIndex).toBe(0);
      clock += 500;
      onNominalSuccess("sonnet", "minimax"); // the in-flight request lands
      expect(isFailoverActive("sonnet", "minimax")).toBe(true); // wall STILL holds
      for (let i = 0; i < 6; i++) {
        clock += 30 * 1000; // 3 min of pinned traffic, well past the grace
        expect(resolveFailoverTargetForSession("sonnet", "sess-A", "minimax").stepIndex).toBe(0);
      }
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
    const yields = writes.filter((w) => w.includes("DWELL sonnet") && w.includes("yielded")).length;
    expect(yields).toBe(0); // not one yield under a live wall
  });
});

// #619 — a dwell pin never yields to a recovered EARLIER cascade step. Measured
// 2026-10-23 on the hub: the local engine behind haiku[0] (swift-1.5-27b)
// rebooted 07:46Z and decoded again 07:54Z, but zero hub traffic reached it
// until ~08:18Z — the sessions re-pinned past its bench never came back, while
// session-less canaries served on it in 0.3-0.85 s and the conversations kept
// paying the deeper lane. The fix: a per-step recovery stamp (first success
// after the mark, voided by the next mark) lets those pins yield after the
// same #294 grace.
describe("#619 — dwell pin yields to a recovered EARLIER cascade step", () => {
  const ENV = {
    CLAUDISH_FAILOVER_SONNET: "vllm@swift-1.5-27b>ds@deepseek-v4-flash>ds@deepseek-payg",
    CLAUDISH_FAILOVER_SONNET_LABEL: "swift>Flash>PAYG",
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

  /** The measured shape: step 0 (the local engine) dies non-quota twice (10 min
   * then 30 min bench — the reboot ladder), the session forfeits its dwell
   * (#276) and re-pins to step 1 while step 0's bench still holds, keeps
   * talking (the sliding pin outlives the bench — the defect's premise), then
   * step 0 recovers: a session-less request walks to it and SUCCEEDS. Leaves
   * the pin on step 1 (live) and returns the recovery-stamp instant. The wall
   * is re-armed at each expiry — in the measured incident the nominal's wall
   * (a weekly plan) held for hours, and a disarmed wall would send the
   * unpinned walks to the nominal instead of the cascade. */
  function rebindPastBenchedStep0(session: string): number {
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", session).stepIndex).toBe(0); // pinned to step 0
    markStepFailed("sonnet", 0, "engine down", undefined, { nonQuota: true }); // count=1, bench 10 min
    expect(resolveFailoverTargetForSession("sonnet", session).stepIndex).toBe(1); // #276 forfeit, unpinned walk
    clock += 10 * 60 * 1000 + 1; // tombstone lapsed; step 0's first bench elapsed; wall TTL elapsed
    markStepFailed("sonnet", 0, "engine still down", undefined, { nonQuota: true }); // count=2, bench 30 min
    expect(armFailover("sonnet", "refused again")).toBe(true); // re-arm (TTL now 20 min) — the plan wall still holds
    expect(resolveFailoverTargetForSession("sonnet", session).stepIndex).toBe(1); // re-pinned at step 1
    expect(getSessionDwellPinForTests("sonnet", session)?.stepIndex).toBe(1);
    // The active session keeps talking — each resolve renews the pin for one
    // dwell, so it rides step 1 straight through step 0's bench. Renewals end
    // at t≈+37 min (pin until ≈+47 min); step 0's bench (set at +10 min) lapses
    // at ≈+40 min.
    for (let i = 0; i < 3; i++) {
      clock += 9 * 60 * 1000;
      expect(resolveFailoverTargetForSession("sonnet", session).stepIndex).toBe(1);
    }
    clock += 4 * 60 * 1000; // ≈+41 min: step 0 probeable again; wall re-armed below
    expect(armFailover("sonnet", "still walled")).toBe(true); // expired since +30 min (next TTL 40 min)
    expect(resolveFailoverTargetForSession("sonnet", "fresh-probe").stepIndex).toBe(0); // a session-less request walks to it
    resetStepSuccess("sonnet", 0); // … and SUCCEEDS → the verified recovery, stamped now
    return clock;
  }

  it("a pin on a LATER step yields to the recovered step once the grace elapses, and re-pins there", () => {
    rebindPastBenchedStep0("sess-A");
    clock += 60 * 1000; // 1 min after the recovery — the grace (2 min) has NOT elapsed
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(1); // held
    clock += 2 * 60 * 1000; // 3 min after the recovery
    const back = resolveFailoverTargetForSession("sonnet", "sess-A");
    expect(back.stepIndex).toBe(0); // back on the recovered capacity
    expect(back.step?.target).toBe("vllm@swift-1.5-27b");
    expect(getSessionDwellPinForTests("sonnet", "sess-A")?.stepIndex).toBe(0); // re-pinned there
    // … and it STAYS there — ordinary dwell at the new step.
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
  });

  it("a BUSY recovered step must not push the stamp — the grace measures from the FIRST success", () => {
    // The #294 P1 rule, one plane down. The recovered step keeps serving other
    // traffic every 10 s; a stamp refreshed by every success would hold every
    // deeper pin forever. These calls are no-ops in real code (the record was
    // cleared by the recovery) — the mutation that stamps on every success
    // turns this exact loop into an eternal hold.
    rebindPastBenchedStep0("sess-A");
    const perMinute: number[] = [];
    for (let s = 0; s <= 300; s += 10) {
      resetStepSuccess("sonnet", 0); // other sessions' successes on the recovered step
      clock += 10 * 1000;
      if (s % 60 === 0) perMinute.push(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex);
    }
    // Held through the 2-min grace (minutes 0-1), back on step 0 from minute 2
    // on — measured from the FIRST success, not the last.
    expect(perMinute).toEqual([1, 1, 0, 0, 0, 0]);
  });

  // #625 review: the stamp is evidence about a pin only if it POST-DATES it.
  // A session pinned to step 1 AFTER step 0 already recovered pinned with that
  // recovery on the table (here: its own request skipped step 0, #431) — the
  // old stamp is not news and must not yank it. Red under the mutant that drops
  // the `stamp <= pinnedAt` guard.
  it("a pin created AFTER the recovered step's stamp outlives it (evidence must post-date the pin)", () => {
    rebindPastBenchedStep0("sess-A"); // step 0's stamp lands at +41 min; sess-A pinned at 1 since +10 min
    clock += 3 * 60 * 1000; // +44: past the grace, so the stamp is fully "old news"
    expect(
      resolveFailoverTargetForSession("sonnet", "sess-B", undefined, new Set([0])).stepIndex
    ).toBe(1); // a fresh session that skips step 0 (#431) pins at step 1 — NOW
    const pinB = getSessionDwellPinForTests("sonnet", "sess-B");
    expect(pinB?.stepIndex).toBe(1);
    expect(pinB?.pinnedAt).toBe(clock);
    clock += 5 * 60 * 1000; // +49: the pin is live (until +54), the stamp is 8 min old
    expect(resolveFailoverTargetForSession("sonnet", "sess-B").stepIndex).toBe(1); // holds
    // Control, same instant: sess-A pinned BEFORE the stamp still yields to it —
    // the guard discriminates on the pin's instant, not on the stamp's age.
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0);
  });

  it("a step that recovered and was MARKED again does not un-pin anyone — the mark voids the stamp", () => {
    rebindPastBenchedStep0("sess-A");
    clock += 3 * 60 * 1000; // 3 min — past the grace
    markStepFailed("sonnet", 0, "flaked again"); // count=1 again, bench 10 min — stamp voided
    clock += 50 * 1000;
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(1); // benched: trivially holds (renews the pin)
    // Past the new bench with NO success since the mark: the step is probeable,
    // but nothing verified its recovery — the pin must hold. Against the
    // "stamp not voided by a new mark" mutation this resolve yields to step 0.
    clock += 9 * 60 * 1000 + 20 * 1000; // new bench (+54 min) elapsed; pin (renewed at +44:50) still live
    const held = resolveFailoverTargetForSession("sonnet", "sess-A");
    expect(held.stepIndex).toBe(1);
    expect(held.step?.target).toBe("ds@deepseek-v4-flash");
  });

  it("an operator CLOSURE on the recovered step does not un-pin anyone (the #261 plane)", () => {
    // A closure is the one binding plane that writes NO failure record — the
    // mark-side voiding cannot cover it, so the yield's own stepTtlBinds read
    // is what holds. Against the "yield ignoring stepTtlBinds" mutation this
    // test emits the forbidden yield line.
    markStepFailed("sonnet", 0, "bench"); // record — the success below is a *recovery*
    resetStepSuccess("sonnet", 0); // → stamp live from t0
    getFailoverRule("sonnet")!.steps[0].resetAt = new Date(clock + 60 * 60 * 1000); // operator closes step 0 for 1 h
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(1); // walk skips the CLOSED step → pin at 1
    const writes: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr) as (c: string) => boolean;
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown) => {
      const s = String(chunk);
      writes.push(s);
      return realWrite(s);
    };
    try {
      clock += 3 * 60 * 1000; // stamp 3 min old — past the grace, but the step is CLOSED
      expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(1);
      clock += 3 * 60 * 1000;
      expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(1);
    } finally {
      (process.stderr as unknown as { write: typeof realWrite }).write = realWrite;
    }
    expect(writes.filter((w) => w.includes("DWELL sonnet") && w.includes("yielded — step 0")).length).toBe(0);
  });

  it("nominal recovery still outranks a recovered earlier step (#294 unchanged)", () => {
    // BOTH stamps must be aged past their grace at the SAME resolve, and that
    // resolve must be the first one after them (an earlier resolve would yield
    // to whichever plane fired first and mask the ordering). A reordering that
    // lets the step plane yield first lands the session on step 0, not the
    // nominal.
    expect(armFailover("sonnet", "wall")).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(0); // pinned to step 0
    markStepFailed("sonnet", 0, "engine down", undefined, { nonQuota: true });
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(1); // forfeited, walks to 1
    clock += 10 * 60 * 1000 + 1; // wall + tombstone + first bench elapsed
    markStepFailed("sonnet", 0, "engine still down", undefined, { nonQuota: true }); // count=2, bench 30 min
    expect(armFailover("sonnet", "refused again")).toBe(true); // wall until +30 min
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(1); // re-pinned at step 1
    clock += 9 * 60 * 1000 + 30_000; // ≈+19.5 min: renewal (pin until ≈+29.5)
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(1);
    clock += 10 * 60 * 1000 + 1_000; // ≈+29.5 min: renewal (pin until ≈+39.5); step 0 still benched
    expect(resolveFailoverTargetForSession("sonnet", "sess-A").stepIndex).toBe(1);
    clock += 31 * 1000; // ≈+30 min: wall TTL elapsed → the nominal is probeable
    onNominalSuccess("sonnet"); // the verified NOMINAL recovery — stamped now
    clock += 3 * 60 * 1000 + 1_000; // nominal grace elapsed
    resetStepSuccess("sonnet", 0); // NOW step 0 serves too — record cleared, stamp fresh but instantly aged below
    clock += 3 * 60 * 1000 + 2_000; // step stamp (3 min) and nominal stamp (6 min) both past the grace
    const r = resolveFailoverTargetForSession("sonnet", "sess-A");
    expect(r.stepIndex).toBe(-1); // the nominal, never a cascade step
  });

  it("a recovered step THIS request skipped (#431) is not a yield target", () => {
    rebindPastBenchedStep0("sess-A");
    clock += 3 * 60 * 1000; // past the grace
    // Step 0 recovered, but THIS conversation's request already skipped it
    // (context overflow): yielding would re-resolve straight back to step 1
    // — pure churn. The pin holds.
    const r = resolveFailoverTargetForSession("sonnet", "sess-A", undefined, new Set([0]));
    expect(r.stepIndex).toBe(1);
  });
});

// #91 — damp the nominal/substitute flap: grace before arming, and a short
// retry-after means burst, not wall. One transient 429 must cost a few seconds
// of patience, never a 10-minute model exile plus two cold prompt caches.
describe("#91 — grace before arming + retry-after burst discrimination", () => {
  // Anthropic weekly-cap wording: passes isQuotaExhaustion via the
  // "exceed your account" branch — the exact false-positive #91 point 2 targets.
  const WALL_BODY = JSON.stringify({
    error: { message: "This request would exceed your account's rate limit. Please try again later." },
  });

  const AUTO_ON = {
    ...OPUS_TO_QWEN,
    CLAUDISH_FAILOVER_AUTO: "1",
  } as NodeJS.ProcessEnv;

  it("a single isolated qualifying refusal does not arm the role (ARM_AFTER=2 default)", () => {
    initFailover({ ...AUTO_ON });
    const v = onNominalRefusal("opus", "HTTP 429 from claude-opus-5", null, WALL_BODY);
    expect(v.outcome).toBe("grace");
    if (v.outcome === "grace") expect(v.count).toBe(1);
    expect(isFailoverActive("opus")).toBe(false);
  });

  it("the second CONSECUTIVE qualifying refusal arms the role", () => {
    initFailover({ ...AUTO_ON });
    onNominalRefusal("opus", "HTTP 429 from claude-opus-5", null, WALL_BODY);
    const v2 = onNominalRefusal("opus", "HTTP 429 from claude-opus-5", null, WALL_BODY);
    expect(v2.outcome).toBe("armed");
    expect(isFailoverActive("opus")).toBe(true);
  });

  it("a nominal success voids the refusal run (fresh episode)", () => {
    initFailover({ ...AUTO_ON });
    onNominalRefusal("opus", "HTTP 429 from claude-opus-5", null, WALL_BODY);
    onNominalSuccess("opus");
    const v2 = onNominalRefusal("opus", "HTTP 429 from claude-opus-5", null, WALL_BODY);
    expect(v2.outcome).toBe("grace");
    expect(isFailoverActive("opus")).toBe(false);
  });

  it("ARM_AFTER=1 restores the pre-#91 arm-on-first-refusal", () => {
    initFailover({ ...AUTO_ON, CLAUDISH_FAILOVER_ARM_AFTER: "1" });
    const v = onNominalRefusal("opus", "HTTP 429 from claude-opus-5", null, WALL_BODY);
    expect(v.outcome).toBe("armed");
    expect(isFailoverActive("opus")).toBe(true);
  });

  it("a 429 carrying a short retry-after never arms, however often it repeats", () => {
    initFailover({ ...AUTO_ON, CLAUDISH_FAILOVER_ARM_AFTER: "1" });
    for (let i = 0; i < 3; i++) {
      const v = onNominalRefusal("opus", "HTTP 429 from claude-opus-5", "30", WALL_BODY);
      expect(v.outcome).toBe("burst");
    }
    expect(isFailoverActive("opus")).toBe(false);
  });

  it("a retry-after ABOVE the ceiling is a wall signal, not a burst", () => {
    initFailover({ ...AUTO_ON, CLAUDISH_FAILOVER_ARM_AFTER: "1" });
    const v = onNominalRefusal("opus", "HTTP 429 from claude-opus-5", "3600", WALL_BODY);
    expect(v.outcome).toBe("armed");
  });

  it("burstRetryAfterMs — header seconds, body-named delays, walls stay walls", () => {
    initFailover({ ...AUTO_ON });
    // Header forms.
    expect(burstRetryAfterMs("30", WALL_BODY)).toBe(30_000);
    expect(burstRetryAfterMs("0", WALL_BODY)).toBe(0);
    expect(burstRetryAfterMs("119.5", WALL_BODY)).toBe(119_500);
    expect(burstRetryAfterMs("120", WALL_BODY)).toBe(null); // at ceiling = wall
    expect(burstRetryAfterMs("3600", WALL_BODY)).toBe(null);
    expect(burstRetryAfterMs(null, WALL_BODY)).toBe(null); // no signal → body predicate
    // Body-named RELATIVE delays.
    expect(burstRetryAfterMs(null, "Rate limited. Please retry in 45 seconds.")).toBe(45_000);
    expect(burstRetryAfterMs(null, "try again in 1 minute")).toBe(60_000);
    expect(burstRetryAfterMs(null, "Resets in 2 days 13 hr")).toBe(null); // > ceiling: wall
    // ABSOLUTE resets are walls by design — parseResetAtFromBody owns them.
    expect(burstRetryAfterMs(null, "The quota will reset at 08-25 22:28:00 UTC")).toBe(null);
    expect(burstRetryAfterMs(null, "Usage limit reached for 5 hour. Your limit will reset at 2026-09-11 20:04:03")).toBe(null);
  });

  it("ARM_GRACE_MS is parsed from env and reset by the test seam", () => {
    initFailover({ ...AUTO_ON, CLAUDISH_FAILOVER_ARM_GRACE_MS: "2500" });
    expect(getArmGraceMs()).toBe(2500);
    resetFailoverForTests();
    expect(getArmGraceMs()).toBe(0);
    initFailover({ ...AUTO_ON, CLAUDISH_FAILOVER_ARM_GRACE_MS: "bogus" });
    expect(getArmGraceMs()).toBe(0); // invalid falls back, never NaN
  });

  it("an already-armed role reports armed (concurrent-request race preserved)", () => {
    initFailover({ ...AUTO_ON, CLAUDISH_FAILOVER_ACTIVE: "opus" });
    const v = onNominalRefusal("opus", "HTTP 429 from claude-opus-5", null, WALL_BODY);
    expect(v.outcome).toBe("armed");
  });
});

// ── #275: per-model maxing, provider-scoped contagion ───────────────────────────
// The wall is a property of the provider BUCKET (the meter), never of the role: a
// refusal walls bucket(M); only requests whose own nominal sits in a walled bucket
// divert. Incident replay (hub, 2026-09-28): gpt-6-sol (bucket cx, OpenAI Pro)
// walled, the role-keyed arm exiled EVERY sonnet request — including those served
// by a healthy z.ai nominal — and the fleet walked Mistral(402)→Kimi(403)→PAYG.

const SONNET_CASCADE = {
  CLAUDISH_FAILOVER_SONNET: "mistral@zai-glm-5-3>kc@k3>ds@deepseek-flash",
  CLAUDISH_FAILOVER_SONNET_LABEL: "Mistral GLM>Kimi K3>DeepSeek PAYG",
  CLAUDISH_FAILOVER_SONNET_DIRECTION: "degraded>lateral>degraded",
} as NodeJS.ProcessEnv;

const OPUS_FABLE_CASCADES = {
  CLAUDISH_FAILOVER_OPUS: "gc@glm-5.3>kc@k3",
  CLAUDISH_FAILOVER_OPUS_LABEL: "GLM Coding>Kimi K3",
  CLAUDISH_FAILOVER_FABLE: "cx@gpt-6-sol>ds@deepseek-flash",
  CLAUDISH_FAILOVER_FABLE_LABEL: "GPT-6 Sol>DeepSeek PAYG",
} as NodeJS.ProcessEnv;

const S275_AUTO = { CLAUDISH_FAILOVER_AUTO: "1" } as NodeJS.ProcessEnv;
const S275_WALL_BODY = JSON.stringify({
  error: { type: "usage_limit_reached", message: "You've reached your weekly usage limit." },
});

describe("#275 — per-bucket walls, provider-scoped contagion", () => {
  let clock = 1_000_000;
  const realNow = Date.now;
  beforeEach(() => {
    Date.now = () => clock;
  });
  afterEach(() => {
    Date.now = realNow;
  });
  it("providerBucketOf (last resort, route() empty): canonical provider, per-model native, vendor prefix for unknown slash forms", () => {
    expect(providerBucketOf("gc@glm-5.3")).toBe("glm-coding");
    expect(providerBucketOf("qwen-token-plan@deepseek-v4.1-flash")).toBe("qwen-token-plan");
    expect(providerBucketOf("openrouter/qwen/qwen3-coder")).toBe("openrouter");
    expect(providerBucketOf("claude-sonnet-4-6")).toBe(`${NATIVE_BUCKET}/claude-sonnet-4-6`);
    expect(providerBucketOf("some-unknown-vendor/model-x")).toBe("some-unknown-vendor");
  });

  it("a wall on bucket cx does not divert a request whose nominal is gc (the incident)", () => {
    initFailover({ ...S275_AUTO, ...SONNET_CASCADE });
    // Sol (cx, OpenAI Pro) walls through a sonnet-role request:
    expect(onNominalRefusal("sonnet", "HTTP 429 from gpt-6-sol", null, S275_WALL_BODY, "cx").outcome).toBe("grace");
    expect(onNominalRefusal("sonnet", "HTTP 429 from gpt-6-sol", null, S275_WALL_BODY, "cx").outcome).toBe("armed");
    // The z.ai-nominal request of the SAME role is NOT diverted:
    const healthy = resolveFailoverTargetForSession("sonnet", "sess-zai", "gc");
    expect(healthy.step).toBeNull();
    expect(healthy.stepIndex).toBe(-1);
    // The cx-nominal request diverts to marche 1 (never the nominal — #274 ruling):
    const walled = resolveFailoverTargetForSession("sonnet", "sess-sol", "cx");
    expect(walled.stepIndex).toBe(0);
    expect(walled.step?.target).toBe("mistral@zai-glm-5-3");
  });

  it("provider contagion: one cx wall diverts both roles whose nominal sits in cx", () => {
    initFailover({ ...S275_AUTO, ...OPUS_FABLE_CASCADES });
    expect(armFailover("fable", "HTTP 429 from cx@gpt-6-sol", "cx")).toBe(true);
    // fable's own cx-nominal requests divert:
    expect(resolveFailoverTargetForSession("fable", "s-f", "cx").stepIndex).toBe(0);
    // an opus-role request whose nominal is ALSO cx (routing mapped it there) diverts
    // to OPUS's own cascade — the wall is the provider's, the cascade is the role's:
    const viaOpus = resolveFailoverTargetForSession("opus", "s-o", "cx");
    expect(viaOpus.stepIndex).toBe(0);
    expect(viaOpus.step?.target).toBe("gc@glm-5.3");
    // and a gc-nominal opus request is untouched:
    expect(resolveFailoverTargetForSession("opus", "s-o2", "gc").step).toBeNull();
  });

  it("a native wall never diverts glm-coding-nominal requests — the live 28/09 specimen", () => {
    initFailover({ ...S275_AUTO, ...SONNET_CASCADE });
    const nativeSonnet = nativeBucketFor("claude-sonnet-4-6");
    expect(armFailover("sonnet", "HTTP 429 from claude-sonnet-4-6", nativeSonnet)).toBe(true);
    expect(resolveFailoverTargetForSession("sonnet", "s1", "glm-coding").step).toBeNull();
    expect(resolveFailoverTargetForSession("sonnet", "s2", nativeSonnet).stepIndex).toBe(0);
  });

  it("config-arm (CLAUDISH_FAILOVER_ACTIVE) diverts every bucket of the role", () => {
    initFailover({ ...SONNET_CASCADE, CLAUDISH_FAILOVER_ACTIVE: "sonnet" });
    expect(resolveFailoverTargetForSession("sonnet", "s1", "gc").stepIndex).toBe(0);
    expect(resolveFailoverTargetForSession("sonnet", "s2", NATIVE_BUCKET).stepIndex).toBe(0);
  });

  it("ARM_AFTER grace runs are per bucket: gc refusals do not count toward a cx wall", () => {
    initFailover({ ...S275_AUTO, ...SONNET_CASCADE });
    expect(onNominalRefusal("sonnet", "HTTP 429 A", null, S275_WALL_BODY, "cx").outcome).toBe("grace");
    expect(onNominalRefusal("sonnet", "HTTP 429 B", null, S275_WALL_BODY, "gc").outcome).toBe("grace");
    // First refusal of cx — the gc refusal did not advance its counter:
    expect(onNominalRefusal("sonnet", "HTTP 429 C", null, S275_WALL_BODY, "cx").outcome).toBe("armed");
  });

  it("a nominal success from a healthy bucket does NOT clear step backoff while a sibling wall holds", () => {
    initFailover({ ...S275_AUTO, ...SONNET_CASCADE });
    armFailover("sonnet", "weekly wall", NATIVE_BUCKET);
    // diverted native request watches step 0 wall (Mistral 402):
    markStepFailed("sonnet", 0, "HTTP 402 forfait");
    // a gc-nominal request succeeds — the wall on anthropic-native still holds:
    onNominalSuccess("sonnet", "gc");
    const stillWalled = resolveFailoverTargetForSession("sonnet", "s-native", NATIVE_BUCKET);
    // step 0 stays backoff'd — the next diverted request advances, it does not
    // re-pay a doomed Mistral probe (the probe-storm guard):
    expect(stillWalled.stepIndex).toBe(1);
    // and once no wall remains anywhere, the steps reset (fresh episode):
    clock += 11 * 60 * 1000;
    isFailoverActive("sonnet"); // expire the wall
    onNominalSuccess("sonnet", "gc");
    const fresh = resolveFailoverTargetForSession("sonnet", "s-native2", NATIVE_BUCKET);
    expect(fresh.step).toBeNull();
  });

  it("recovery is per (role, bucket): the gc sessions learn nothing of a cx recovery", () => {
    initFailover({ ...S275_AUTO, ...SONNET_CASCADE });
    armFailover("sonnet", "weekly wall", "cx");
    // cx session diverted and notified:
    expect(consumeStreamNotice("sonnet", "s-cx", "cx")).toContain("Mistral GLM");
    clock += 11 * 60 * 1000;
    isFailoverActive("sonnet", "cx"); // expire the wall
    onNominalSuccess("sonnet", "cx");
    expect(isRecovering("sonnet")).toBe(true);
    // the recovery stream notice fires for the cx session, NOT for a gc session:
    expect(consumeStreamNotice("sonnet", "s-cx", "cx")).toContain("back on the nominal");
    expect(consumeStreamNotice("sonnet", "s-gc", "gc")).toBeNull();
    // condensation notice scoped to (role, bucket) too:
    expect(buildFailoverNotice("sonnet", "gc")).toBeNull();
    expect(buildFailoverNotice("sonnet", "cx")).toContain("back on the nominal");
  });

  it("TTL expiry and re-arm escalation are per bucket", () => {
    initFailover({ ...S275_AUTO, ...SONNET_CASCADE });
    armFailover("sonnet", "wall", "cx");
    clock += 5 * 60 * 1000;
    armFailover("sonnet", "wall", "gc"); // armed 5 min later — its TTL outlives cx's
    clock += 6 * 60 * 1000; // t+11: cx (10-min TTL) expired, gc (armed t+5) still holds
    // expiring cx does not expire gc:
    expect(isFailoverActive("sonnet", "cx")).toBe(false);
    expect(isFailoverActive("sonnet", "gc")).toBe(true);
    // re-arming cx escalates ONLY cx (ARM_AFTER=2: two fresh refusals after expiry):
    onNominalRefusal("sonnet", "still walled", null, S275_WALL_BODY, "cx");
    const v = onNominalRefusal("sonnet", "still walled", null, S275_WALL_BODY, "cx");
    expect(v.outcome).toBe("armed");
    clock += 21 * 60 * 1000;
    expect(isFailoverActive("sonnet", "gc")).toBe(false); // its 10-min TTL elapsed
  });
});

// ── #275 request-side half: classifyNominalBucket (PR #277 review) ─────────────
// The wall tests above inject bucket strings by hand; these pin what PRODUCTION
// derives per request, under a hub-like env (no Anthropic credential, the
// subscription meters credentialed) — the exact profile where the v1
// implementation mis-bucketed every bare claude-* as `openrouter` and created a
// NEW cross-role native contagion.
describe("#275 — classifyNominalBucket (request-side bucket derivation)", () => {
  const noOverride = (_model: string) => false;
  // Hub profile: OpenRouter + the two subscription meters credentialed, NO
  // Anthropic key (native passthrough bills the CLIENT's credential).
  const HUB_LIKE = {
    OPENROUTER_API_KEY: "or-test",
    GLM_CODING_API_KEY: "gc-test",
    OPENAI_CODEX_API_KEY: "cx-test",
  };
  const ENV_KEYS = [...Object.keys(HUB_LIKE), "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, HUB_LIKE);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved = {};
  });

  it("bare claude-* never buckets openrouter: per-model native buckets, so two native models never share a wall", () => {
    const sonnet = classifyNominalBucket("claude-sonnet-4-6", noOverride);
    const opus = classifyNominalBucket("claude-opus-5-5", noOverride);
    expect(sonnet).toEqual({ bucket: `${NATIVE_BUCKET}/claude-sonnet-4-6` });
    expect(opus).toEqual({ bucket: `${NATIVE_BUCKET}/claude-opus-5-5` });
    // the blocker this pins: without the 2c-native guard, route() under this
    // exact env answers `openrouter` for every bare claude-* (credential
    // filtering drops native-anthropic), walling ALL native roles together.
    expect((sonnet as { bucket: string }).bucket).not.toBe("openrouter");
    expect((sonnet as { bucket: string }).bucket).not.toBe(
      (opus as { bucket: string }).bucket
    );
    // with an Anthropic key present the guard holds identically — route() is
    // never consulted for the native lane, whatever the credentials:
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(classifyNominalBucket("claude-fable-5-1", noOverride)).toEqual({
      bucket: `${NATIVE_BUCKET}/claude-fable-5-1`,
    });
  });

  it("a user routing override beats the native heuristic (mirrors 2c / #3401): the chain decides", () => {
    const decision = classifyNominalBucket("claude-sonnet-4-6", (m) => m === "claude-sonnet-4-6");
    expect(decision).toEqual({ routeModel: "claude-sonnet-4-6" });
  });

  it("one meter, one bucket, whatever the spelling: gc@ ≡ bare glm-*, cx@ ≡ bare gpt-6-*", () => {
    // Explicit spellings canonicalize through parseModelSpec:
    expect(classifyNominalBucket("gc@glm-5.3", noOverride)).toEqual({ bucket: "glm-coding" });
    expect(classifyNominalBucket("cx@gpt-6-sol", noOverride)).toEqual({ bucket: "openai-codex" });
    expect(classifyNominalBucket("or@deepseek/deepseek-r1", noOverride)).toEqual({
      bucket: "openrouter",
    });
    // Bare spellings hand the decision to route(); under the hub-like env its
    // primary is the SAME canonical provider — the two spellings of one meter
    // converge on one bucket:
    expect(classifyNominalBucket("glm-5.3", noOverride)).toEqual({ routeModel: "glm-5.3" });
    const bareGlm = route("glm-5.3", DEFAULT_ROUTING_RULES);
    expect(bareGlm.kind).toBe("ok");
    expect((bareGlm as { primary: { provider: string } }).primary.provider).toBe("glm-coding");
    expect(classifyNominalBucket("gpt-6-astra", noOverride)).toEqual({ routeModel: "gpt-6-astra" });
    const bareAstra = route("gpt-6-astra", DEFAULT_ROUTING_RULES);
    expect(bareAstra.kind).toBe("ok");
    expect((bareAstra as { primary: { provider: string } }).primary.provider).toBe("openai-codex");
  });

  it("bare non-claude names hand the decision to the routing chain (routeModel)", () => {
    expect(classifyNominalBucket("deepseek-v4.1-flash", noOverride)).toEqual({
      routeModel: "deepseek-v4.1-flash",
    });
    expect(classifyNominalBucket("qwen/qwen3-coder", noOverride)).toEqual({
      routeModel: "qwen3-coder", // the vendor prefix is stripped by parseModelSpec
    });
  });
});

// ── #274 — role-as-failover-step ───────────────────────────────────────────────
// A cascade step of the form `role:sonnet` delegates to another ROLE. Resolution:
// the target's nominal when healthy, else the target's own resolved cascade step
// (shared walk state). The delegation graph is proven acyclic at load; the dwell
// pin pins the concrete resolved step, never the role reference.

describe("#274 — role-as-failover-step (parsing + acyclicity)", () => {
  it("parses a `role:<r>` step into a delegation (roleRef set, target = placeholder until resolution)", () => {
    initFailover({ CLAUDISH_FAILOVER_OPUS: "role:sonnet" } as NodeJS.ProcessEnv);
    const step = getFailoverRule("opus")!.steps[0];
    expect(step.roleRef).toBe("sonnet");
    expect(step.target).toBe("sonnet"); // placeholder — replaced at resolution
    expect(step.label).toBe("role:sonnet"); // label defaults to the raw step string
  });

  it("is case-insensitive and space-tolerant on the role: prefix", () => {
    initFailover({ CLAUDISH_FAILOVER_OPUS: " ROLE : Sonnet " } as NodeJS.ProcessEnv);
    expect(getFailoverRule("opus")!.steps[0].roleRef).toBe("sonnet");
  });

  it("a model target is never misparsed as a delegation (colon inside a model name)", () => {
    initFailover({ CLAUDISH_FAILOVER_OPUS: "ollama@llama3.2:3b" } as NodeJS.ProcessEnv);
    const step = getFailoverRule("opus")!.steps[0];
    expect(step.roleRef).toBeUndefined();
    expect(step.target).toBe("ollama@llama3.2:3b");
  });

  it("an unknown role name is treated as a model target (never a silent delegation)", () => {
    initFailover({ CLAUDISH_FAILOVER_OPUS: "role:banana" } as NodeJS.ProcessEnv);
    const step = getFailoverRule("opus")!.steps[0];
    expect(step.roleRef).toBeUndefined();
    expect(step.target).toBe("role:banana");
  });

  it("refuses a self-delegation cycle at load", () => {
    initFailover({ CLAUDISH_FAILOVER_OPUS: "role:opus" } as NodeJS.ProcessEnv);
    expect(getFailoverRule("opus")).toBeUndefined();
  });

  it("refuses a two-role cycle (opus→fable→opus), keeping the acyclic role", () => {
    initFailover({
      CLAUDISH_FAILOVER_OPUS: "role:fable",
      CLAUDISH_FAILOVER_FABLE: "role:opus",
      CLAUDISH_FAILOVER_SONNET: "deepseek@deepseek-payg",
    } as NodeJS.ProcessEnv);
    expect(getFailoverRule("opus")).toBeUndefined();
    expect(getFailoverRule("fable")).toBeUndefined();
    expect(getFailoverRule("sonnet")).toBeDefined(); // model-only chain is untouched
  });

  it("accepts a terminating delegation chain (haiku→sonnet, sonnet model-only)", () => {
    initFailover({
      CLAUDISH_FAILOVER_HAIKU: "kc@kimi-for-coding>role:sonnet",
      CLAUDISH_FAILOVER_SONNET: "ds@deepseek-flash",
    } as NodeJS.ProcessEnv);
    expect(getFailoverRule("haiku")!.steps[1].roleRef).toBe("sonnet");
    expect(getFailoverRule("sonnet")!.steps[0].target).toBe("ds@deepseek-flash");
  });
});

describe("#274 — role-step resolution", () => {
  const env274 = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    ({
      CLAUDISH_FAILOVER_OPUS: "role:sonnet",
      CLAUDISH_FAILOVER_OPUS_LABEL: "Rôle Sonnet",
      CLAUDISH_FAILOVER_SONNET: "mistral@glm-5.3>ds@deepseek-flash",
      CLAUDISH_FAILOVER_SONNET_LABEL: "Mistral GLM>DeepSeek Flash",
      ...extra,
    } as NodeJS.ProcessEnv);

  it("resolves to the target role's NOMINAL when that bucket is healthy", () => {
    initFailover(env274({ CLAUDISH_FAILOVER_ACTIVE: "opus" }));
    setRoleNominalResolver((r) => (r === "sonnet" ? "gc@glm-5.3" : undefined));
    const { step, stepIndex } = resolveFailoverTarget("opus");
    expect(stepIndex).toBe(0);
    expect(step!.roleRef).toBe("sonnet");
    expect(step!.target).toBe("gc@glm-5.3"); // concrete, not the role keyword
  });

  it("joins the target's own resolved cascade step when its nominal bucket is walled", () => {
    initFailover(env274({ CLAUDISH_FAILOVER_ACTIVE: "opus", CLAUDISH_FAILOVER_AUTO: "1" }));
    setRoleNominalResolver((r) => (r === "sonnet" ? "gc@glm-5.3" : undefined));
    // Wall the sonnet nominal's bucket (gc@ → glm-coding): the delegation must
    // join sonnet's own cascade, not serve the walled nominal.
    armFailover("sonnet", "test wall", "glm-coding");
    const { step, stepIndex } = resolveFailoverTarget("opus");
    expect(stepIndex).toBe(0);
    expect(step!.target).toBe("mistral@glm-5.3"); // sonnet's cascade step 0
  });

  it("advances to the target's next cascade step when its step 0 is TTL-failed (shared walk state)", () => {
    initFailover(env274({ CLAUDISH_FAILOVER_ACTIVE: "opus", CLAUDISH_FAILOVER_AUTO: "1" }));
    setRoleNominalResolver((r) => (r === "sonnet" ? "gc@glm-5.3" : undefined));
    armFailover("sonnet", "test wall", "glm-coding");
    markStepFailed("sonnet", 0, "mistral walled");
    const { step } = resolveFailoverTarget("opus");
    expect(step!.target).toBe("ds@deepseek-flash"); // sonnet step 1
  });

  it("a delegation that cannot serve is skipped (no nominal resolver, no target cascade)", () => {
    initFailover({
      CLAUDISH_FAILOVER_OPUS: "role:sonnet>ds@deepseek-payg",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
    } as NodeJS.ProcessEnv);
    // No setRoleNominalResolver and no CLAUDISH_FAILOVER_SONNET: the role-step
    // cannot resolve concrete — the cascade falls through to the next step.
    const { step, stepIndex } = resolveFailoverTarget("opus");
    expect(stepIndex).toBe(1);
    expect(step!.target).toBe("ds@deepseek-payg");
  });

  it("a fully-delegated cascade with no servable delegate yields no substitution (never a placeholder)", () => {
    initFailover({
      CLAUDISH_FAILOVER_OPUS: "role:sonnet",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
    } as NodeJS.ProcessEnv);
    const { step, stepIndex } = resolveFailoverTarget("opus");
    expect(step).toBeNull();
    expect(stepIndex).toBe(-1);
  });

  it("resolveConcreteTarget returns the model target as-is for a model step", () => {
    initFailover({ ...OPUS_CASCADE });
    const step = getFailoverRule("opus")!.steps[1];
    expect(resolveConcreteTarget("opus", step)).toBe("gc@glm-5.2");
  });

  // The hub shape: modelMap.sonnet is the BARE `glm-5.3`, which classifies to
  // no bucket on its own (route() decides it — `glm-coding`). Before the
  // injected bucket resolver, the delegation served that nominal even with its
  // bucket walled (hub 08/10→20/10: 15 of 31 `Sonnet role` walls landed while
  // glm-coding was already armed).
  describe("bare routing-chain nominal (hub shape)", () => {
    afterEach(() => setRoleNominalBucketResolver(null));

    it("joins the target's cascade when the resolver-named bucket is walled", () => {
      initFailover(env274({ CLAUDISH_FAILOVER_ACTIVE: "opus", CLAUDISH_FAILOVER_AUTO: "1" }));
      setRoleNominalResolver((r) => (r === "sonnet" ? "glm-5.3" : undefined));
      setRoleNominalBucketResolver((m) => (m === "glm-5.3" ? "glm-coding" : undefined));
      armFailover("sonnet", "test wall", "glm-coding");
      const { step, stepIndex } = resolveFailoverTarget("opus");
      expect(stepIndex).toBe(0);
      expect(step!.target).toBe("mistral@glm-5.3"); // sonnet's cascade step 0, never the walled glm-5.3
      const d = resolveDelegationOwner("opus", step!);
      expect(d!.owner).toEqual({ role: "sonnet", nominal: false, stepIndex: 0 });
    });

    it("serves the nominal while the resolver-named bucket is healthy", () => {
      initFailover(env274({ CLAUDISH_FAILOVER_ACTIVE: "opus" }));
      setRoleNominalResolver((r) => (r === "sonnet" ? "glm-5.3" : undefined));
      setRoleNominalBucketResolver((m) => (m === "glm-5.3" ? "glm-coding" : undefined));
      armFailover("sonnet", "a sibling bucket's wall", "minimax-coding");
      const { step } = resolveFailoverTarget("opus");
      expect(step!.target).toBe("glm-5.3");
    });

    it("without a bucket resolver the bare nominal is served (no bucket to test)", () => {
      initFailover(env274({ CLAUDISH_FAILOVER_ACTIVE: "opus", CLAUDISH_FAILOVER_AUTO: "1" }));
      setRoleNominalResolver((r) => (r === "sonnet" ? "glm-5.3" : undefined));
      armFailover("sonnet", "test wall", "glm-coding");
      const { step } = resolveFailoverTarget("opus");
      expect(step!.target).toBe("glm-5.3");
    });

    // #554 point 3: the full reset must drop an injected bucket resolver. A
    // stale one names `glm-coding` here, so the delegation would join sonnet's
    // cascade instead of serving the bare nominal (the case just above).
    it("resetFailoverForTests() drops an injected bucket resolver", () => {
      setRoleNominalBucketResolver((m) => (m === "glm-5.3" ? "glm-coding" : undefined));
      resetFailoverForTests();
      initFailover(env274({ CLAUDISH_FAILOVER_ACTIVE: "opus", CLAUDISH_FAILOVER_AUTO: "1" }));
      setRoleNominalResolver((r) => (r === "sonnet" ? "glm-5.3" : undefined));
      armFailover("sonnet", "test wall", "glm-coding");
      const { step } = resolveFailoverTarget("opus");
      expect(step!.target).toBe("glm-5.3");
    });
  });
});

// ── #331 — a role: step's TTL binds only its walled CONCRETE ───────────────────
// Measured freeze (hub po-2025, 2026-10-04): `haiku[1]` = `role:sonnet` walled
// 408 times, TTL escalated to the 24 h cap, while sonnet's own resolution had
// long advanced — the delegating step's backoff measured ONE concrete the
// delegation happened to resolve to, and `resolveSkippingFailed` tested it
// BEFORE ever re-resolving the delegation. The fix (decision of record, issue
// #331): markStepFailed records the concrete (`StepFailure.concrete`) and the
// TTL of a `role:` step binds only while the delegation keeps resolving to
// that same concrete — at the walk, at the dwell pin's servable test, and at
// the last-step fallback. Intra-request advancement is unchanged: within one
// request the resolution cannot move.
describe("#331 — a role: step's TTL binds only its walled concrete", () => {
  const env331 = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    ({
      CLAUDISH_FAILOVER_HAIKU: "mm@minimax-m3>role:sonnet>ds@deepseek-payg",
      CLAUDISH_FAILOVER_SONNET: "mistral@glm-5.3>kimi@kimi-k3",
      CLAUDISH_FAILOVER_ACTIVE: "haiku",
      CLAUDISH_FAILOVER_AUTO: "1",
      ...extra,
    } as NodeJS.ProcessEnv);
  // No setRoleNominalResolver: a proxy started without a modelMap — the
  // delegation resolves straight into sonnet's cascade steps. (The hub runs
  // WITH the profile's modelMap: see "bare routing-chain nominal" above.)

  it("T1: delegation ADVANCED past the walled concrete → the delegating step is probeable again (the 24 h freeze)", () => {
    initFailover(env331());
    markStepFailed("haiku", 0, "minimax walled");
    // The measured shape: the delegated attempt on mistral walled BOTH sides —
    // the delegating step (with its concrete) and sonnet's own step 0.
    markStepFailed("haiku", 1, "HTTP 429 from mistral via delegation", undefined, {
      concrete: "mistral@glm-5.3",
    });
    markStepFailed("sonnet", 0, "mistral walled");
    const { step, stepIndex } = resolveFailoverTarget("haiku");
    expect(stepIndex).toBe(1); // NOT frozen, NOT the last-step fallback — probeable in the walk
    expect(step!.target).toBe("kimi@kimi-k3"); // the delegation re-resolved to sonnet's step 1
  });

  it("T2: delegation still on the walled concrete → the freeze holds (advancement unchanged)", () => {
    initFailover(env331());
    markStepFailed("haiku", 0, "minimax walled");
    markStepFailed("haiku", 1, "HTTP 429 from kimi via delegation", undefined, {
      concrete: "kimi@kimi-k3",
    });
    markStepFailed("sonnet", 0, "mistral walled"); // sonnet's own walk state: resolves kimi
    const { step, stepIndex } = resolveFailoverTarget("haiku");
    expect(stepIndex).toBe(2); // frozen on its CURRENT concrete — the PAYG tail serves
    expect(step!.target).toBe("ds@deepseek-payg");
  });

  it("T3: a record WITHOUT a concrete keeps the freeze (pre-#331 shape, #263 revisit re-mark)", () => {
    initFailover(env331());
    markStepFailed("haiku", 0, "minimax walled");
    markStepFailed("haiku", 1, "re-selected after a concurrent clear"); // no concrete
    markStepFailed("sonnet", 0, "mistral walled");
    const { stepIndex } = resolveFailoverTarget("haiku");
    expect(stepIndex).toBe(2); // conservative: absent concrete binds
  });

  it("T4: a dwell pin on a role-step whose walled concrete the delegation LEFT holds (still servable)", () => {
    initFailover(env331({ CLAUDISH_FAILOVER_SESSION_DWELL_MS: "600000" }));
    markStepFailed("haiku", 0, "minimax walled");
    // Pin: the delegation resolves sonnet[0] (mistral) — the session dwells on
    // the delegating step riding it.
    const first = resolveFailoverTargetForSession("haiku", "sess-331");
    expect(first.stepIndex).toBe(1);
    expect(first.step!.target).toBe("mistral@glm-5.3");
    // The mistral wall lands on both sides; sonnet advances to kimi.
    markStepFailed("haiku", 1, "HTTP 429 from mistral via delegation", undefined, {
      concrete: "mistral@glm-5.3",
    });
    markStepFailed("sonnet", 0, "mistral walled");
    const second = resolveFailoverTargetForSession("haiku", "sess-331");
    expect(second.stepIndex).toBe(1); // the pin HOLDS…
    expect(second.step!.target).toBe("kimi@kimi-k3"); // …riding the delegation's NEW concrete
  });

  it("T5: a LAST-step delegation frozen on its current concrete surfaces the refusal (the 408-retry shape)", () => {
    initFailover({
      CLAUDISH_FAILOVER_HAIKU: "role:sonnet", // the production cascade shape
      CLAUDISH_FAILOVER_SONNET: "mistral@glm-5.3>kimi@kimi-k3",
      CLAUDISH_FAILOVER_ACTIVE: "haiku",
      CLAUDISH_FAILOVER_AUTO: "1",
    } as NodeJS.ProcessEnv);
    // The refusal came through the delegation while it resolved mistral, and
    // the delegation STILL resolves mistral (the owner-side mark landed on the
    // nominal plane, not on sonnet[0] — mechanism (a) of the issue). Pre-#331
    // the fallback re-served this step on EVERY request, each refusal
    // re-marking it: the 408-wall counter. Now the refusal surfaces once.
    markStepFailed("haiku", 0, "HTTP 429 from mistral via delegation", undefined, {
      concrete: "mistral@glm-5.3",
    });
    const { step, stepIndex } = resolveFailoverTarget("haiku");
    expect(step).toBeNull();
    expect(stepIndex).toBe(-1);
  });

  it("T6: a #261 config closure still binds a role-step regardless of the delegation", () => {
    // Close ONLY step 1 (position-preserved: one empty entry then the date).
    initFailover(env331({ CLAUDISH_FAILOVER_HAIKU_RESET: ">2097-01-01T00:00:00Z" }));
    markStepFailed("haiku", 0, "minimax walled");
    const { step, stepIndex } = resolveFailoverTarget("haiku");
    expect(stepIndex).toBe(2); // the operator closure speaks louder than the delegation
    expect(step!.target).toBe("ds@deepseek-payg");
  });
});

describe("#274 — dwell pin pins the concrete step, never the role reference", () => {
  const envDwell = (): NodeJS.ProcessEnv =>
    ({
      CLAUDISH_FAILOVER_OPUS: "role:sonnet>ds@deepseek-payg",
      CLAUDISH_FAILOVER_SONNET: "mistral@glm-5.3>ds@deepseek-flash",
      CLAUDISH_FAILOVER_ACTIVE: "opus",
      CLAUDISH_FAILOVER_SESSION_DWELL_MS: "600000",
    } as NodeJS.ProcessEnv);

  it("holds a pinned role-step while the target's own cascade step stays servable", () => {
    initFailover({ ...envDwell(), CLAUDISH_FAILOVER_AUTO: "1" } as NodeJS.ProcessEnv);
    setRoleNominalResolver((r) => (r === "sonnet" ? "gc@glm-5.3" : undefined));
    // Wall sonnet's nominal bucket so the delegation joins sonnet's cascade.
    armFailover("sonnet", "wall", "glm-coding");
    const first = resolveFailoverTargetForSession("opus", "sess-1", "openai-codex");
    expect(first.stepIndex).toBe(0);
    expect(first.step!.target).toBe("mistral@glm-5.3");
    // Sonnet step 0 TTL-fails mid-dwell: the pin must YIELD to genuine
    // advancement and re-pin at the delegate's next concrete step.
    markStepFailed("sonnet", 0, "mistral walled");
    const second = resolveFailoverTargetForSession("opus", "sess-1", "openai-codex");
    expect(second.stepIndex).toBe(0); // same delegating step…
    expect(second.step!.target).toBe("ds@deepseek-flash"); // …but re-resolved concrete
  });

  it("findCascadeStepForTarget is GONE — the owner comes from the resolution (review 29/09)", () => {
    // The reverse target→step lookup found the DELEGATING step back (its target
    // is refreshed in place), never the true owner. Resolution-derived owners
    // are pinned below and in the route test; the export must not exist.
    const source = readFileSync(new URL("./failover.ts", import.meta.url), "utf-8");
    expect(source.includes("function findCascadeStepForTarget")).toBe(false);
  });
});

// ── #274 review (29/09) — ownership derived from the resolution itself ─────────
// S1/S2/S3 of the coordinator's probe: the owner of the concrete model a
// delegation resolves to must be the TARGET's nominal bucket or the TARGET's
// step — never the delegating step itself, never another role's delegation.
describe("#274 — resolveDelegationOwner (ownership from resolution)", () => {
  const envReview = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    ({
      // The operator's target shape (probe 29/09): opus delegates to sonnet's
      // nominal gc@glm-5.3; sonnet walks Mistral→Kimi; haiku ends on sonnet.
      CLAUDISH_FAILOVER_OPUS: "cx@gpt-6-sol>role:sonnet",
      CLAUDISH_FAILOVER_SONNET: "mistral@glm-5.3>kimi@kimi-k3",
      CLAUDISH_FAILOVER_HAIKU: "mm@minimax-m3>kimi@kimi-k2.8>role:sonnet",
      CLAUDISH_FAILOVER_AUTO: "1",
      ...extra,
    } as NodeJS.ProcessEnv);
  const modelMap = { opus: "claude-opus-5-5", sonnet: "gc@glm-5.3", haiku: "mm@minimax-m3" };

  /** The opus delegation step (index 1) resolved. */
  function opusDelegation(): { concrete: string; owner: DelegationOwner } | null {
    const rule = getFailoverRule("opus")!;
    return resolveDelegationOwner("opus", rule.steps[1]);
  }

  it("S1: healthy target nominal → owner is the TARGET's nominal, not the delegating role's", () => {
    initFailover({ ...envReview(), CLAUDISH_FAILOVER_ACTIVE: "opus" } as NodeJS.ProcessEnv);
    setRoleNominalResolver((r) => (modelMap as Record<string, string>)[r]);
    // opus walled (Sol), sonnet healthy → opus[1] serves sonnet's nominal.
    armFailover("opus", "probe: sol wall", "openai-codex");
    markStepFailed("opus", 0, "probe: sol wall");
    const d = opusDelegation();
    expect(d).not.toBeNull();
    expect(d!.concrete).toBe("gc@glm-5.3");
    expect(d!.owner).toEqual({ role: "sonnet", nominal: true });
  });

  it("S2: target bucket walled → owner is the TARGET's cascade step 0, never the delegating step", () => {
    initFailover({ ...envReview(), CLAUDISH_FAILOVER_ACTIVE: "opus" } as NodeJS.ProcessEnv);
    setRoleNominalResolver((r) => (modelMap as Record<string, string>)[r]);
    armFailover("opus", "probe: sol wall", "openai-codex");
    markStepFailed("opus", 0, "probe: sol wall");
    // Sonnet's own bucket walls → the delegation joins sonnet's cascade.
    armFailover("sonnet", "probe: glm wall", "glm-coding");
    const d = opusDelegation();
    expect(d).not.toBeNull();
    expect(d!.concrete).toBe("mistral@glm-5.3");
    expect(d!.owner).toEqual({ role: "sonnet", nominal: false, stepIndex: 0 });
  });

  it("S3: nested delegation resolves to the TERMINAL owner (sonnet step 0), not haiku's or opus's delegation step", () => {
    initFailover({ ...envReview(), CLAUDISH_FAILOVER_ACTIVE: "haiku" } as NodeJS.ProcessEnv);
    setRoleNominalResolver((r) => (modelMap as Record<string, string>)[r]);
    armFailover("haiku", "probe: minimax wall", "minimax-coding");
    markStepFailed("haiku", 0, "probe");
    markStepFailed("haiku", 1, "probe");
    armFailover("sonnet", "probe: glm wall", "glm-coding");
    const rule = getFailoverRule("haiku")!;
    const d = resolveDelegationOwner("haiku", rule.steps[2]);
    expect(d).not.toBeNull();
    expect(d!.concrete).toBe("mistral@glm-5.3");
    expect(d!.owner).toEqual({ role: "sonnet", nominal: false, stepIndex: 0 });
  });

  it("a model step has no delegation to own (null)", () => {
    initFailover({ ...envReview(), CLAUDISH_FAILOVER_ACTIVE: "opus" } as NodeJS.ProcessEnv);
    setRoleNominalResolver((r) => (modelMap as Record<string, string>)[r]);
    const rule = getFailoverRule("opus")!;
    expect(resolveDelegationOwner("opus", rule.steps[0])).toBeNull();
  });
});

// ── #274 re-review 01/10 — the two unpinned UNIT branches ──────────────────────
// (ii) the dwell pin on a role-step: a pinned session keeps the DELEGATION step
//      and its concrete refreshes to the target's CURRENT walk (never frozen).
// (ii-b) adopted from the coordinator's probe (re-review 3): the pin HOLDS even
//      when the delegating role's own earlier step becomes probeable — no
//      provider switch inside the dwell. (The removed `wasNominal` yield broke
//      exactly that, and its flag survived delegated successes for hours.)
// (iii) nested delegation: the owner recorded is the TERMINAL role's coordinate.
describe("#274 re-review — dwell pin on role-steps + nested delegation owner", () => {
  // Known-provider vocabulary (buckets already pinned by the tests above):
  // gc@glm-5.3 → glm-coding, cx@gpt-6-sol → openai-codex.
  const SONNET_NOM = "gc@glm-5.3";
  const OPUS_NOM = "cx@gpt-6-sol";

  it("(ii) a pinned session keeps the delegation step while its target's nominal walls — the concrete is refreshed to the target's CURRENT walk, not frozen at the walled nominal", () => {
    const realNow = Date.now;
    let clock = 1_000_000_000_000;
    Date.now = () => clock;
    try {
      initFailover({
        CLAUDISH_FAILOVER_OPUS: "role:sonnet",
        CLAUDISH_FAILOVER_SONNET: "kimi@kimi-k3>ds@deepseek-flash",
        CLAUDISH_FAILOVER_AUTO: "1",
        CLAUDISH_FAILOVER_ACTIVE: "opus",
        // The pin must OUTLIVE the step's first backoff rung (10 min) — the
        // yield's window is exactly "pin live + pinned step probeable again".
        CLAUDISH_FAILOVER_SESSION_DWELL_MS: "3600000",
      } as NodeJS.ProcessEnv);
      setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOM : r === "opus" ? OPUS_NOM : undefined));

      // Pin the session on the delegation step while the target nominal is healthy.
      const p1 = resolveFailoverTargetForSession("opus", "sess-yn");
      expect(p1.stepIndex).toBe(0);
      expect(p1.step?.target).toBe(SONNET_NOM);

      // The route's own failure shape (proxy-server.ts delegated-owner branch):
      // a qualifying wall of the delegated TARGET NOMINAL marks the delegating step.
      markStepFailed("opus", 0, "test: delegated wall of the target nominal");
      armFailover("sonnet", "test: target nominal walled", "glm-coding");
      markStepFailed("sonnet", 0, "test: kimi walled");

      // Past the step's first rung (10 min): pin still live (dwell 1 h), pinned
      // step probeable — the re-resolution must land on the target's walk.
      clock += 11 * 60_000;
      // Refresh the target-side walls (they TTL out on the same 10-min scale).
      armFailover("sonnet", "test: target nominal still walled", "glm-coding");
      markStepFailed("sonnet", 0, "test: kimi still walled");

      const p2 = resolveFailoverTargetForSession("opus", "sess-yn");
      // Same delegation step, but re-RESOLVED: the concrete the session sees is
      // sonnet's CURRENT walk state (deepseek), not the stale walled nominal
      // the pin froze on. Deleting the whole `pinnedStep?.roleRef` block
      // (failover.ts:851) keeps the pin and returns target === gc@glm-5.3 —
      // this assert goes red.
      expect(p2.stepIndex).toBe(0);
      expect(p2.step?.target).toBe("ds@deepseek-flash");
    } finally {
      Date.now = realNow;
    }
  });

  // (ii-b) adopted from the coordinator's probe (re-review 3, c.5938875564),
  // adapted to the post-deletion 4-arg markStepFailed: same state, earlier step
  // made probeable. This is the pin for the DELETION itself.
  it("(ii-b) a pinned delegation step HOLDS when the delegating role's earlier step becomes probeable — no provider switch inside the dwell", () => {
    const realNow = Date.now;
    let clock = 1_000_000_000_000;
    Date.now = () => clock;
    try {
      initFailover({
        CLAUDISH_FAILOVER_OPUS: "kimi@kimi-k3>role:sonnet",
        CLAUDISH_FAILOVER_SONNET: "ds@deepseek-flash",
        CLAUDISH_FAILOVER_AUTO: "1",
        CLAUDISH_FAILOVER_ACTIVE: "opus",
        CLAUDISH_FAILOVER_SESSION_DWELL_MS: "3600000",
      } as NodeJS.ProcessEnv);
      setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOM : r === "opus" ? OPUS_NOM : undefined));

      // opus step 0 (kimi) walls → the session lands on the delegation step 1
      // and pins there.
      markStepFailed("opus", 0, "test: kimi walled");
      const p1 = resolveFailoverTargetForSession("opus", "sess-probe");
      expect(p1.stepIndex).toBe(1);
      expect(p1.step?.target).toBe(SONNET_NOM);

      // The delegated TARGET NOMINAL walls: the delegating step is marked, the
      // owning side arms sonnet (route shape, proxy-server.ts delegated branch).
      markStepFailed("opus", 1, "test: delegated target nominal walled");
      armFailover("sonnet", "test: sonnet nominal walled", "glm-coding");

      // Past every 10-min rung: the pin (1 h) still live, opus step 0 probeable
      // again, sonnet's walk sitting on ds@deepseek-flash.
      clock += 11 * 60_000;
      armFailover("sonnet", "test: sonnet nominal still walled", "glm-coding");
      const p2 = resolveFailoverTargetForSession("opus", "sess-probe");
      // The pin HOLDS on step 1 and its concrete is the delegation's CURRENT
      // resolution (deepseek) — never a switch back to the now-probeable kimi
      // step 0. Reintroducing a yield on the pinned step's failure record (the
      // removed wasNominal branch did exactly that) makes this assert go red.
      expect(p2.stepIndex).toBe(1);
      expect(p2.step?.target).toBe("ds@deepseek-flash");
    } finally {
      Date.now = realNow;
    }
  });

  it("(iii) a two-hop delegation records the TERMINAL role's coordinate as owner (haiku → role:opus → role:sonnet)", () => {
    initFailover({
      CLAUDISH_FAILOVER_HAIKU: "role:opus",
      CLAUDISH_FAILOVER_OPUS: "role:sonnet",
      CLAUDISH_FAILOVER_SONNET: "kimi@kimi-k3>ds@deepseek-flash",
      CLAUDISH_FAILOVER_AUTO: "1",
      CLAUDISH_FAILOVER_ACTIVE: "haiku",
    } as NodeJS.ProcessEnv);
    setRoleNominalResolver((r) => (r === "sonnet" ? SONNET_NOM : r === "opus" ? OPUS_NOM : undefined));
    // Both intermediate nominals walled + the terminal walk's step 0 failed:
    // the owner must be sonnet[1], reached through the failover.ts:622
    // recursion — never the intermediate {opus, 0}.
    armFailover("opus", "test: opus nominal walled", "openai-codex");
    armFailover("sonnet", "test: sonnet nominal walled", "glm-coding");
    markStepFailed("sonnet", 0, "test: kimi walled");

    const haikuStep = getFailoverRule("haiku")!.steps[0];
    const d = resolveDelegationOwner("haiku", haikuStep);
    expect(d).not.toBeNull();
    expect(d!.concrete).toBe("ds@deepseek-flash");
    expect(d!.owner).toEqual({ role: "sonnet", nominal: false, stepIndex: 1 });
    // Mutation (failover.ts:622 recursion disabled): the owner comes back as
    // the INTERMEDIATE {opus, 0} with the unresolved placeholder concrete —
    // both asserts go red.
  });
});
