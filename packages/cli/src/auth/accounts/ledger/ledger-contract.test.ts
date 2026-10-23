import { describe, expect, test } from "bun:test";
import {
  type ResponseRowInput,
  SELECT_REASONS,
  buildNoEligibleRow,
  buildResponseRow,
  parseRow,
  planClassOf,
  responseRowSchema,
  serializeRow,
  toEvent,
  windowKeyFor,
} from "./ledger-row.js";

const at = Date.UTC(2026, 9, 23, 12);
const input: ResponseRowInput = {
  provider: "openai-codex",
  requestId: "request-123",
  attempt: 0,
  at,
  accountId: "a1b2c3d4e5f6",
  label: "work",
  planClass: "pro",
  session: "s-123",
  model: "gpt-6-astra",
  reason: SELECT_REASONS[0],
  outcome: "ok",
  tokens: { input: 110000, cacheRead: 95000, cacheWrite: 700, output: 3000 },
  finalInput: 60000,
};

const api = { buildResponseRow, parseRow, planClassOf, serializeRow, toEvent, windowKeyFor };

describe("allowance ledger row contract (§2.1; L5–L7)", () => {
  test("plan class is a lower-cased closed set, never upstream text", () => {
    for (const plan of [
      "free",
      "plus",
      "pro",
      "team",
      "business",
      "enterprise",
      "other",
    ] as const) {
      expect(api.planClassOf(plan.toUpperCase())).toBe(plan);
    }
    for (const value of ["ultra", "header-signing-value-123", "prompt text", "x".repeat(5000)]) {
      expect(api.planClassOf(value)).toBe("other");
    }
    expect(api.planClassOf(undefined)).toBeNull();
    expect(api.planClassOf(null)).toBeNull();
  });

  test("schema v1 preserves this attempt's billed totals separately from final input", () => {
    const row = api.buildResponseRow(input)!;
    expect(row).toMatchObject({
      v: 1,
      kind: "response",
      id: "request-123:0:a1b2c3d4e5f6",
      at,
      provider: "openai-codex",
      accountId: input.accountId,
      label: "work",
      planClass: "pro",
      session: "s-123",
      model: "gpt-6-astra",
      reason: SELECT_REASONS[0],
      outcome: "ok",
      inTok: 110000,
      cacheReadTok: 95000,
      cacheWriteTok: 700,
      outTok: 3000,
      finalInTok: 60000,
      windows: null,
    });
    expect(api.toEvent(row)).toMatchObject({
      kind: "response",
      account: input.accountId,
      session: "s-123",
      tokens: input.tokens,
      finalInput: 60000,
      windows: null,
    });
  });

  test("attempt identity distinguishes A quota from B success", () => {
    const quota = api.buildResponseRow({
      ...input,
      accountId: "aaaaaaaaaaaa",
      outcome: "quota",
      tokens: null,
      finalInput: null,
    })!;
    const success = api.buildResponseRow({ ...input, attempt: 1, accountId: "bbbbbbbbbbbb" })!;
    expect(quota.id).toBe("request-123:0:aaaaaaaaaaaa");
    expect(success.id).toBe("request-123:1:bbbbbbbbbbbb");
    expect(quota).toMatchObject({
      outcome: "quota",
      inTok: 0,
      cacheReadTok: 0,
      cacheWriteTok: 0,
      outTok: 0,
      finalInTok: 0,
    });
    expect(success).toMatchObject({ outcome: "ok", inTok: 110000, outTok: 3000 });
  });

  test("string guards sanitize label, session, model and unknown reason", () => {
    for (const label of ["bad/label", "prompt text\n", "x".repeat(4096)]) {
      expect(api.buildResponseRow({ ...input, label })!.label).toBeNull();
    }
    for (const session of ["s 1", "s/1", "x".repeat(65), "", "prompt\ntext"]) {
      expect(api.buildResponseRow({ ...input, session })!.session).toBeNull();
    }
    expect(api.buildResponseRow({ ...input, session: "x".repeat(64) })!.session).toHaveLength(64);
    for (const model of ["a b", "x".repeat(81), "prompt\ntext"]) {
      expect(api.buildResponseRow({ ...input, model })!.model).toBe("other");
    }
    expect(api.buildResponseRow({ ...input, model: "x".repeat(80) })!.model).toHaveLength(80);
    expect(api.buildResponseRow({ ...input, reason: "invented" as never })!.reason).toBeNull();
    expect(api.buildResponseRow({ ...input, accountId: "../x" })).toBeNull();
  });

  test("prompt, project and raw plan text never survive the builder", () => {
    const secret = "header-signing-value-123";
    const row = api.buildResponseRow({
      ...input,
      planClass: api.planClassOf(secret),
      messages: [{ role: "user", content: "PRIVATE PROMPT TEXT" }],
      project: "PRIVATE PROJECT",
    } as ResponseRowInput)!;
    const text = api.serializeRow(row)!;
    expect(text).not.toContain(secret);
    expect(text).not.toContain("PRIVATE PROMPT TEXT");
    expect(text).not.toContain("PRIVATE PROJECT");
    expect(JSON.parse(text).planClass).toBe("other");
    expect(api.parseRow(text)).toEqual(row);
  });

  test("row parser rejects invalid versions, arbitrary plans, invalid windows and numeric corruption", () => {
    const valid = api.buildResponseRow(input)!;
    const window = {
      key: "len:10080",
      slot: "primary",
      lengthMinutes: 10080,
      usedFraction: 0.41,
      resetAt: at + 3600000,
      rejected: false,
      quantum: 0.01,
    };
    expect(api.parseRow(JSON.stringify({ ...valid, windows: [window] }))).not.toBeNull();
    for (const patch of [
      { v: 2 },
      { planClass: "ultra" },
      { reason: "unbounded" },
      { outcome: "invented" },
      { inTok: -1 },
      { windows: [{ ...window, usedFraction: 1.1 }] },
      { windows: [{ ...window, slot: "x y" }] },
      { windows: [{ ...window, key: "x".repeat(41) }] },
    ]) {
      expect(api.parseRow(JSON.stringify({ ...valid, ...patch }))).toBeNull();
    }
    expect(api.parseRow("{torn")).toBeNull();
  });

  test("serialization enforces the 4095-byte cap on schema-valid rows", () => {
    const valid = api.buildResponseRow(input)!;
    expect(Buffer.byteLength(api.serializeRow(valid)!)).toBeLessThan(4096);
    const oversized = responseRowSchema.parse({
      ...valid,
      model: "x".repeat(80),
      session: "s".repeat(64),
      windows: Array.from({ length: 16 }, (_, n) => ({
        key: ("w" + n + "x".repeat(40)).slice(0, 40),
        slot: ("s" + n + "x".repeat(40)).slice(0, 40),
        lengthMinutes: 10080,
        usedFraction: 0.1234567890123456,
        resetAt: Number.MAX_SAFE_INTEGER,
        rejected: false,
        quantum: 0.1234567890123456,
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(4095);
    expect(api.serializeRow(oversized!)).toBeNull();
  });

  test("positional window identity uses length and named windows use their name", () => {
    expect(
      api.windowKeyFor("openai-codex", { slot: "primary", lengthMinutes: 10080 } as never)
    ).toBe("len:10080");
    expect(api.windowKeyFor("openai-codex", { slot: "primary" } as never)).toBe("slot:primary");
    expect(api.windowKeyFor("native-anthropic", { slot: "seven_day_opus" } as never)).toBe(
      "seven_day_opus"
    );
  });

  test("no-eligible rows have only schema version, type, time and provider", () => {
    const row = buildNoEligibleRow("openai-codex", at);
    expect(row).toEqual({ v: 1, kind: "no-eligible", at, provider: "openai-codex" });
    expect(api.toEvent(row)).toEqual({ kind: "no-eligible", at });
  });
});
