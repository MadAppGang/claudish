/**
 * Failover tests — budget-driven role substitution and its condensation notice.
 *
 * The invariants that matter operationally:
 *  1. Zero configuration ⇒ zero behavior change (this ships to machines that
 *     will never set the env).
 *  2. A plain rate limit must NOT burn the weekly budget switch — only genuine
 *     quota/credit exhaustion arms a failover.
 *  3. The notice never breaks a condensation, whatever the message looks like.
 */

import { describe, it, expect, beforeEach } from "bun:test";
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
} from "./failover.js";

const OPUS_TO_QWEN = {
  CLAUDISH_FAILOVER_OPUS: "qwen-token-plan@qwen3.8-max",
  CLAUDISH_FAILOVER_OPUS_LABEL: "Qwen 3.8 Max",
  CLAUDISH_FAILOVER_OPUS_DIRECTION: "degraded",
  CLAUDISH_FAILOVER_OPUS_NOTE: "Extended thinking is disabled on this target.",
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
    expect(getFailoverRule("opus")?.target).toBe("qwen-token-plan@qwen3.8-max");
    expect(isFailoverActive("opus")).toBe(false);
    expect(buildFailoverNotice()).toBeNull();
  });
});

describe("failover — manual arming", () => {
  it("arms the roles named in CLAUDISH_FAILOVER_ACTIVE", () => {
    initFailover({
      ...OPUS_TO_QWEN,
      ...HAIKU_TO_DEEPSEEK,
      CLAUDISH_FAILOVER_ACTIVE: "opus,haiku",
    });
    expect(isFailoverActive("opus")).toBe(true);
    expect(isFailoverActive("haiku")).toBe(true);
    expect(isFailoverActive("sonnet")).toBe(false);
    expect(getActiveFailovers().map((a) => a.rule.role)).toEqual(["opus", "haiku"]);
  });

  it("does not arm a role whose target is unconfigured", () => {
    // The dangerous case: operator lists the role but forgets the target, and
    // believes a failover is protecting them.
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
});

describe("failover — automatic arming", () => {
  it("refuses to auto-arm unless CLAUDISH_FAILOVER_AUTO is set", () => {
    initFailover({ ...OPUS_TO_QWEN });
    expect(armFailover("opus", "HTTP 429")).toBe(false);
    expect(isFailoverActive("opus")).toBe(false);
  });

  it("arms once, and reports the transition only once", () => {
    initFailover({ ...OPUS_TO_QWEN, CLAUDISH_FAILOVER_AUTO: "1" });
    expect(armFailover("opus", "HTTP 429 weekly limit")).toBe(true);
    expect(isFailoverActive("opus")).toBe(true);
    // Second call must not re-log / re-stamp `since`.
    expect(armFailover("opus", "HTTP 429 weekly limit")).toBe(false);
  });

  it("cannot auto-arm a role with no configured target", () => {
    initFailover({ CLAUDISH_FAILOVER_AUTO: "1" });
    expect(armFailover("sonnet", "HTTP 402")).toBe(false);
  });
});

describe("isQuotaExhaustion — narrow on purpose", () => {
  it("treats a plain per-minute rate limit as NOT exhaustion", () => {
    // Arming on this would swap the model for the rest of the process because a
    // burst hit a 60-second window. That is the failure mode this guards.
    expect(isQuotaExhaustion(429, '{"error":{"message":"Rate limit exceeded, retry in 3s"}}')).toBe(
      false
    );
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
    // Swapping models here would hide a bad key or a bad model id.
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

describe("failover notice", () => {
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

  it("defaults an unspecified direction to 'degraded' rather than flattering the substitute", () => {
    initFailover({
      CLAUDISH_FAILOVER_SONNET: "some@model",
      CLAUDISH_FAILOVER_ACTIVE: "sonnet",
    });
    expect(buildFailoverNotice()).toContain("slightly weaker");
  });

  it("falls back to the target string when no label is given", () => {
    initFailover({
      CLAUDISH_FAILOVER_SONNET: "ds@deepseek-v4-pro",
      CLAUDISH_FAILOVER_ACTIVE: "sonnet",
    });
    expect(getFailoverRule("sonnet")?.label).toBe("ds@deepseek-v4-pro");
  });
});

describe("appendFailoverNoticeToMessage", () => {
  beforeEach(() => {
    initFailover({ ...OPUS_TO_QWEN, CLAUDISH_FAILOVER_ACTIVE: "opus" });
  });

  it("appends to the trailing text block rather than adding a new one", () => {
    // A condensation result is a single summary; clients that read content[0]
    // must still see the notice.
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
    // A thrown error here would turn a working condensation into a failed one —
    // and a session that cannot condense eventually stalls.
    expect(() => appendFailoverNoticeToMessage(null)).not.toThrow();
    expect(() => appendFailoverNoticeToMessage({})).not.toThrow();
    expect(() => appendFailoverNoticeToMessage({ content: "not an array" })).not.toThrow();
    expect(() => appendFailoverNoticeToMessage({ content: [null, undefined] })).not.toThrow();
  });
});
