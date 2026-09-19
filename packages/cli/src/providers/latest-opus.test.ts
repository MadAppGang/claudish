import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SlimModelEntry } from "./all-models-cache.js";
import {
  _resetCatalogClient,
  _setCatalogEntriesForTest,
  getCatalogEntries,
  latestAnthropicTierModelId,
  latestOpusModelId,
} from "./catalog-client.js";

function catalogEntry(modelId: string, releaseDate?: string): SlimModelEntry {
  return {
    modelId,
    aliases: [],

    ...(releaseDate === undefined ? {} : { releaseDate }),
  };
}

beforeEach(() => {
  _resetCatalogClient();
});

afterEach(() => {
  _resetCatalogClient();
});

describe("latestOpusModelId", () => {
  test("newest releaseDate wins regardless of catalog order", () => {
    const older = catalogEntry("claude-opus-4-8", "2025-11-24");
    const newest = catalogEntry("claude-opus-5", "2026-08-01");

    for (const entries of [
      [older, newest],
      [newest, older],
    ]) {
      _setCatalogEntriesForTest(entries);
      expect(latestOpusModelId()).toBe("claude-opus-5");
    }
  });

  test("same releaseDate prefers the id without the -fast suffix", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-opus-5-fast", "2026-08-01"),
      catalogEntry("claude-opus-5", "2026-08-01"),
    ]);

    expect(latestOpusModelId()).toBe("claude-opus-5");
  });

  test("ignores non-Opus entries", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-sonnet-5", "2027-01-01"),
      catalogEntry("gpt-5.6-luna", "2027-01-02"),
      catalogEntry("claude-opus-4-8", "2025-11-24"),
    ]);

    expect(latestOpusModelId()).toBe("claude-opus-4-8");

    _setCatalogEntriesForTest([
      catalogEntry("claude-sonnet-5", "2027-01-01"),
      catalogEntry("gpt-5.6-luna", "2027-01-02"),
    ]);
    expect(latestOpusModelId()).toBeNull();
  });

  test("undated entries do not crash or outrank a dated entry", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-opus-99"),
      catalogEntry("claude-opus-5", "2026-08-01"),
    ]);

    expect(latestOpusModelId()).toBe("claude-opus-5");
  });

  test("a cold catalog returns null", () => {
    _setCatalogEntriesForTest(null);

    expect(getCatalogEntries()).toBeNull();
    expect(latestOpusModelId()).toBeNull();
    expect(latestOpusModelId() ?? "claude-opus-5").toBe("claude-opus-5");
  });

  test("never resurrects the dead hardcoded claude-opus-4-1 default", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-opus-4-5", "2025-08-05"),
      catalogEntry("claude-opus-4-8", "2025-11-24"),
      catalogEntry("claude-opus-5", "2026-08-01"),
    ]);

    // `claude-opus-4-1` is 404 on the live API and was the hardcoded default
    // that broke the native probe. It must not appear when the catalog omits it.
    const selected = latestOpusModelId();
    expect(selected).toBe("claude-opus-5");
    expect(selected).not.toBe("claude-opus-4-1");
  });
});

describe("latestAnthropicTierModelId", () => {
  test("sonnet returns the newest Sonnet model and never an Opus model", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-opus-5", "2027-01-01"),
      catalogEntry("claude-sonnet-4-5", "2025-09-29"),
      catalogEntry("claude-sonnet-5", "2026-08-01"),
    ]);

    const selected = latestAnthropicTierModelId("sonnet");
    expect(selected).toBe("claude-sonnet-5");
    expect(selected).not.toMatch(/^claude-opus-/i);
  });

  test("haiku returns the newest Haiku model and never an Opus model", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-opus-5", "2027-01-01"),
      catalogEntry("claude-haiku-4-5", "2025-10-15"),
      catalogEntry("claude-haiku-5", "2026-08-01"),
    ]);

    const selected = latestAnthropicTierModelId("haiku");
    expect(selected).toBe("claude-haiku-5");
    expect(selected).not.toMatch(/^claude-opus-/i);
  });

  test("latestOpusModelId agrees with the generic Opus selector", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-sonnet-5", "2027-01-01"),
      catalogEntry("claude-opus-4-8", "2025-11-24"),
      catalogEntry("claude-opus-5", "2026-08-01"),
    ]);

    expect(latestOpusModelId()).toBe("claude-opus-5");
    expect(latestOpusModelId()).toBe(latestAnthropicTierModelId("opus"));
  });

  test("returns null when the requested tier has no rows", () => {
    _setCatalogEntriesForTest([
      catalogEntry("claude-opus-5", "2026-08-01"),
      catalogEntry("claude-sonnet-5", "2026-08-01"),
    ]);

    expect(latestAnthropicTierModelId("haiku")).toBeNull();
    expect(latestAnthropicTierModelId("haiku") ?? "claude-haiku-fallback").toBe(
      "claude-haiku-fallback"
    );
  });
});
