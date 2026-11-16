import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../config-override.js";
import { configKeySavedStatus, outrankedKeyNote } from "./config-save.js";

describe("outrankedKeyNote", () => {
  afterEach(() => {
    setConfigFileOverride(null);
  });

  // REGRESSION: the note named ~/.claudish/config.json while --config pointed at another file
  test("names the --config file, not ~/.claudish/config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-config-save-"));
    const file = join(dir, "c.json");
    try {
      setConfigFileOverride(file);
      const note = outrankedKeyNote("TEST_API_KEY", ["config"]);
      expect(note).toContain(file);
      expect(note).not.toContain("~/.claudish/config.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // REGRESSION: the note used a singular verb for two outranking sources
  test("agrees in number with two outranking sources", () => {
    const note = outrankedKeyNote("TEST_API_KEY", ["environment", "config"]);
    expect(note).toContain("which outrank it");
    expect(note).not.toContain("which outranks it");
  });
});

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
