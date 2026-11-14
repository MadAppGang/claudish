import { describe, expect, test } from "bun:test";
import { configKeySavedStatus, outrankedKeyNote } from "./config-save.js";

describe("configKeySavedStatus", () => {
  const note = outrankedKeyNote("TEST_API_KEY", ["environment"]);

  test("a plain config.json save keeps the outranked-key note", () => {
    expect(configKeySavedStatus("Test Provider", "TEST_API_KEY", note)).toBe(
      `Key saved for Test Provider (TEST_API_KEY).${note}`
    );
  });

  test("the Keychain-failure fallback names the failure and keeps the note", () => {
    const status = configKeySavedStatus("Test Provider", "TEST_API_KEY", note, "locked");
    expect(status).toBe(`Keychain write failed (locked) — saved to config.json instead.${note}`);
    expect(status).toContain("exported in your shell");
  });
});
