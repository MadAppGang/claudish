import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  accountKeyFromBinding,
  decodeNestedId,
  encodeNestedId,
  execKeyFor,
  sessionKeyFor,
} from "./ids.js";

const hex = "c0d07fd9ccd84fe29372c0e72ed12869";
const callId = `call_${hex}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("nested ids", () => {
  test.each([0, 1, 32, 255, 9999])(
    "round trips sequence %i without changing the exec key",
    (seq) => {
      const id = encodeNestedId(callId, seq);
      expect(id).toBe(`toolu_cx_${hex}_${seq}`);
      expect(decodeNestedId(id)).toEqual({ execKey: hex, seq });
      expect(encodeNestedId(hex, seq)).toBe(id);
    }
  );

  test("hashes a non-Codex call id and accepts an already derived key", () => {
    const original = "a foreign call id";
    const key = sha256(original).slice(0, 32);
    expect(execKeyFor(original)).toBe(key);
    expect(execKeyFor(key)).toBe(key);
    expect(decodeNestedId(encodeNestedId(original, 2))).toEqual({ execKey: key, seq: 2 });
  });

  // [M] Anchors are part of the identity contract, not merely a format hint.
  test.each([
    "toolu_abc_p0",
    `toolu_${hex}_p0`,
    `toolu_cx_${hex}_0_suffix`,
    `prefix_toolu_cx_${hex}_0`,
    `toolu_other_${hex}_0`,
    `toolu_cx_${hex.toUpperCase()}_0`,
    `toolu_cx_${hex.slice(1)}_0`,
    `toolu_cx_${hex}0_0`,
    `toolu_cx_${hex}_10000`,
    `toolu_cx_${hex}_-1`,
    `toolu_cx_${hex}_1.5`,
    `toolu_cx_${hex}_`,
  ])("strictly rejects unrelated or extended id %s", (id) => {
    expect(decodeNestedId(id)).toBeUndefined();
  });
});

describe("account and session identity", () => {
  test("derives an account key only from this OAuth binding, case-insensitive header name", () => {
    const expected = sha256("openai-codex\0account-a");
    expect(
      accountKeyFromBinding({
        auth: { arm: "oauth", headers: { "chatgpt-account-id": "account-a" } },
      })
    ).toBe(expected);
    expect(
      accountKeyFromBinding({
        auth: { arm: "oauth", headers: { "ChatGPT-Account-ID": "account-a" } },
      })
    ).toBe(expected);
    expect(
      accountKeyFromBinding({
        auth: { arm: "api-key", headers: { "chatgpt-account-id": "account-a" } },
      })
    ).toBeUndefined();
    expect(accountKeyFromBinding({ auth: { arm: "oauth", headers: {} } })).toBeUndefined();
    expect(accountKeyFromBinding({ auth: null })).toBeUndefined();
    expect(accountKeyFromBinding(undefined)).toBeUndefined();
  });

  test("same session id on another account gets a different key", () => {
    expect(sessionKeyFor("session-a", "account-a")).toBe(sha256("session-a\0account-a"));
    expect(sessionKeyFor("session-a", "account-a")).not.toBe(
      sessionKeyFor("session-a", "account-b")
    );
    expect(sessionKeyFor("session-a", "account-a")).not.toBe(
      sessionKeyFor("session-b", "account-a")
    );
    expect(sessionKeyFor(undefined, "account-a")).toBeUndefined();
    expect(sessionKeyFor("session-a", undefined)).toBeUndefined();
  });
});
