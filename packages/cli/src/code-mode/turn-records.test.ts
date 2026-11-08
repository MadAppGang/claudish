import { describe, expect, test } from "bun:test";
import { DEFAULT_TURN_RECORD_LIMITS, TurnRecords, turnAnchorFor } from "./turn-records";
import type { ResponsesItem } from "./types";

const KiB = 1024;
const MiB = 1024 * KiB;

// Deliberately opaque structural store values. These are not invented Responses events,
// upstream request bodies or protocol captures: TurnRecords promises JSON byte storage.
function payload(text: string): ResponsesItem[] {
  return [{ type: "T3-opaque-store-value", text }];
}
const bytes = (items: ResponsesItem[]) => Buffer.byteLength(JSON.stringify(items), "utf8");

describe("T3 turn record storage", () => {
  test("REQ-25 counts exact UTF-8 JSON bytes and returns the stored record", () => {
    const records = new TurnRecords();
    const items = payload("é🙂");

    expect(records.put("session", "anchor", items)).toBe(true);
    expect(records.get("session", "anchor")).toEqual({
      sessionKey: "session",
      anchor: "anchor",
      items,
      bytes: bytes(items),
    });
    expect(records.bytes).toBe(bytes(items));
    expect(records.size).toBe(1);
    expect(records.get("other-session", "anchor")).toBeUndefined();
    records.clear();
    expect(records.bytes).toBe(0);
    expect(records.size).toBe(0);
  });

  test("REQ-25 accepts exactly the per-record byte ceiling and refuses one extra byte", () => {
    const exact = payload("x".repeat(128));
    const limit = bytes(exact);
    const records = new TurnRecords({ limits: { maxRecordBytes: limit, maxBytes: 4 * limit } });

    expect(records.put("session", "exact", exact)).toBe(true);
    expect(records.put("session", "oversize", payload("x".repeat(129)))).toBe(false);
    expect(records.get("session", "oversize")).toBeUndefined();
    expect(records.get("session", "exact")?.items).toEqual(exact);
    expect(records.bytes).toBe(limit);
    expect(records.size).toBe(1);
  });

  test("REQ-25 evicts the least recently rendered record under the byte cap", () => {
    const items = payload("x".repeat(100));
    const records = new TurnRecords({
      limits: { maxBytes: 2 * bytes(items), maxRecordBytes: 1000 },
    });
    records.put("session", "first", items);
    records.put("session", "second", items);
    expect(records.get("session", "first")).toBeDefined();

    records.put("session", "third", items);

    expect(records.get("session", "first")).toBeDefined();
    expect(records.get("session", "second")).toBeUndefined();
    expect(records.get("session", "third")).toBeDefined();
    expect(records.isEvicted("session", "second")).toBe(true);
    expect(records.isEvicted("other-session", "second")).toBe(false);
    expect(records.bytes).toBe(2 * bytes(items));
  });

  test("REQ-25 separately enforces record count and FIFO eviction-id retention", () => {
    const records = new TurnRecords({ limits: { maxRecords: 1, maxEvictedIds: 2 } });
    for (let i = 0; i < 5; i++) expect(records.put("session", `anchor-${i}`, [])).toBe(true);

    expect(records.size).toBe(1);
    expect(records.get("session", "anchor-4")).toBeDefined();
    expect(records.isEvicted("session", "anchor-0")).toBe(false);
    expect(records.isEvicted("session", "anchor-2")).toBe(true);
    expect(records.isEvicted("session", "anchor-3")).toBe(true);
  });

  test("REQ-25 replacement updates byte totals rather than charging both versions", () => {
    const records = new TurnRecords();
    records.put("session", "same", payload("old"));
    const replacement = payload("new and longer é");

    expect(records.put("session", "same", replacement)).toBe(true);

    expect(records.size).toBe(1);
    expect(records.bytes).toBe(bytes(replacement));
    expect(records.get("session", "same")?.items).toEqual(replacement);
  });

  test("REQ-25 keeps bytes bounded for 2000 records with six scaled interstitial outputs each", () => {
    const items = Array.from({ length: 6 }, () => ({
      type: "T3-opaque-store-value",
      text: "x".repeat(KiB),
    }));
    const records = new TurnRecords({ limits: { maxBytes: 32 * KiB, maxRecordBytes: 8 * KiB } });
    for (let i = 0; i < 2000; i++) {
      expect(records.put("session", `anchor-${i}`, items)).toBe(true);
      expect(records.bytes).toBeLessThanOrEqual(32 * KiB);
    }

    expect(records.get("session", "anchor-1999")).toBeDefined();
    expect(records.isEvicted("session", "anchor-0")).toBe(true);
    expect(records.size).toBeLessThan(6);
  }, 20_000);

  test("REQ-25 enforces the real 32 MiB byte cap on six-MiB output records", () => {
    const items = Array.from({ length: 6 }, () => ({
      type: "T3-opaque-store-value",
      text: "x".repeat(MiB),
    }));
    const records = new TurnRecords();
    for (let i = 0; i < 8; i++) {
      expect(records.put("session", `anchor-${i}`, items)).toBe(true);
      expect(records.bytes).toBeLessThanOrEqual(32 * MiB);
    }

    expect(records.isEvicted("session", "anchor-0")).toBe(true);
    expect(records.get("session", "anchor-7")).toBeDefined();
    expect(records.size).toBe(5);
  }, 20_000);

  test("REQ-25 refuses a default over-eight-MiB record without retaining its data", () => {
    const records = new TurnRecords();

    expect(records.put("session", "oversize", payload("x".repeat(8 * MiB)))).toBe(false);

    expect(records.get("session", "oversize")).toBeUndefined();
    expect(records.size).toBe(0);
    expect(records.bytes).toBe(0);
  }, 20_000);

  test("REQ-28 exposes the documented turn-record limits", () => {
    expect(DEFAULT_TURN_RECORD_LIMITS).toEqual({
      maxRecords: 2000,
      maxBytes: 32 * MiB,
      maxRecordBytes: 8 * MiB,
      maxEvictedIds: 20_000,
    });
  });
});

describe("T3 turn anchors", () => {
  // Structural Claude Code message arrays, as specified in architecture.md §5.8.
  const assistant = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "same answer" }],
  };
  const previous = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "question" }],
  };

  test("REQ-26 cache_control on the previous message does not change the anchor", () => {
    const marked = {
      ...previous,
      cache_control: { type: "ephemeral" },
      content: previous.content.map((block) => ({
        ...block,
        cache_control: { type: "ephemeral" },
      })),
    };

    expect(turnAnchorFor("session", assistant, marked)).toBe(
      turnAnchorFor("session", assistant, previous)
    );
  });

  test("REQ-26 different previous prompts and different sessions do not share text anchors", () => {
    const anchor = turnAnchorFor("session", assistant, previous);
    expect(
      turnAnchorFor("session", assistant, {
        role: "user",
        content: [{ type: "text", text: "another question" }],
      })
    ).not.toBe(anchor);
    expect(turnAnchorFor("another-session", assistant, previous)).not.toBe(anchor);
    expect(turnAnchorFor("session", assistant, undefined)).not.toBe(anchor);
  });

  test("REQ-26 uses the first tool_use id rather than text or the previous message", () => {
    const message = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "explanation" },
        { type: "tool_use" as const, id: "T3-first-tool", name: "X", input: {} },
        { type: "tool_use" as const, id: "T3-second-tool", name: "Y", input: {} },
      ],
    };

    expect(turnAnchorFor("session", message, previous)).toBe("T3-first-tool");
  });

  test("REQ-26 canonicalizes trimmed text blocks joined by newlines", () => {
    const split = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "  first  " },
        { type: "text" as const, text: " second " },
      ],
    };
    const joined = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "first\nsecond" }],
    };

    expect(turnAnchorFor("session", split, previous)).toBe(
      turnAnchorFor("session", joined, previous)
    );
  });
});
