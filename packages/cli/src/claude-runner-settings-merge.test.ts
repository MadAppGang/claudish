import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeUserSettingsIfPresent } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

/**
 * Pin of the REAL mergeUserSettingsIfPresent (#500 follow-up, queue grain 6):
 * the fork modified this function and it had no direct test — the ~160 lines
 * removed with the upstream test adoption covered an in-file replica. These
 * tests exercise the production function itself.
 */

const STATUS_LINE = { type: "command", command: "claudish-status", padding: 0 };

function makeConfig(claudeArgs: string[]): ClaudishConfig {
  // Minimal shape the function touches: claudeArgs (+ quiet to silence the
  // catch-branch warning). Cast: the full ClaudishConfig is not needed here.
  return { claudeArgs, quiet: true } as unknown as ClaudishConfig;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "claudish-merge-pin-"));
}

describe("mergeUserSettingsIfPresent (real function pin)", () => {
  test("no --settings in args: no-op on the temp file and the args", () => {
    const dir = tempDir();
    try {
      const temp = join(dir, "temp-settings.json");
      writeFileSync(temp, '{"statusLine":{"type":"command","command":"original"}}', "utf-8");
      const config = makeConfig(["-p", "--verbose"]);
      mergeUserSettingsIfPresent(config, temp, STATUS_LINE, false);
      expect(JSON.parse(readFileSync(temp, "utf-8"))).toEqual({
        statusLine: { type: "command", command: "original" },
      });
      expect(config.claudeArgs).toEqual(["-p", "--verbose"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file-based --settings: merged into the temp file, statusLine overridden, defaults applied, args spliced", () => {
    const dir = tempDir();
    try {
      const user = join(dir, "user-settings.json");
      writeFileSync(user, JSON.stringify({ model: "sonnet", statusLine: { type: "command", command: "user-own" } }), "utf-8");
      const temp = join(dir, "temp-settings.json");
      writeFileSync(temp, '{"statusLine":{"type":"command","command":"original"}}', "utf-8");

      const config = makeConfig(["--settings", user, "-p"]);
      mergeUserSettingsIfPresent(config, temp, STATUS_LINE, false);

      const merged = JSON.parse(readFileSync(temp, "utf-8"));
      expect(merged.model).toBe("sonnet"); // user keys preserved
      expect(merged.statusLine).toEqual(STATUS_LINE); // claudish statusLine wins
      expect(merged.disableClaudeAiConnectors).toBe(true); // defaulted
      expect(merged.forceLoginMethod).toBeUndefined(); // no proxyAuthMode
      expect(config.claudeArgs).toEqual(["-p"]); // --settings + value removed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("proxyAuthMode: forceLoginMethod defaulted to console, existing value preserved", () => {
    const dir = tempDir();
    try {
      const temp = join(dir, "temp-settings.json");
      writeFileSync(temp, "{}", "utf-8");

      // absent → defaulted
      const c1 = makeConfig(["--settings", '{"env":{}}', "-p"]);
      mergeUserSettingsIfPresent(c1, temp, STATUS_LINE, true);
      expect(JSON.parse(readFileSync(temp, "utf-8")).forceLoginMethod).toBe("console");

      // present → preserved
      writeFileSync(temp, "{}", "utf-8");
      const c2 = makeConfig(["--settings", '{"forceLoginMethod":"claudeai"}', "-p"]);
      mergeUserSettingsIfPresent(c2, temp, STATUS_LINE, true);
      expect(JSON.parse(readFileSync(temp, "utf-8")).forceLoginMethod).toBe("claudeai");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("existing disableClaudeAiConnectors=false is NOT overridden", () => {
    const dir = tempDir();
    try {
      const temp = join(dir, "temp-settings.json");
      writeFileSync(temp, "{}", "utf-8");
      const config = makeConfig(["--settings", '{"disableClaudeAiConnectors":false}', "-p"]);
      mergeUserSettingsIfPresent(config, temp, STATUS_LINE, false);
      expect(JSON.parse(readFileSync(temp, "utf-8")).disableClaudeAiConnectors).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inline JSON --settings: parsed and merged, not treated as a file path", () => {
    const dir = tempDir();
    try {
      const temp = join(dir, "temp-settings.json");
      writeFileSync(temp, '{"statusLine":{"type":"command","command":"original"}}', "utf-8");
      // The value is JSON itself (leading '{'), not a path — if the inline
      // detection ever regresses to readFileSync-only, this looks like a
      // nonexistent file named '{"model":...}' and the merge silently no-ops.
      const config = makeConfig(["--settings", '{"model":"glm-5.3","env":{"A":"1"}}', "-p"]);
      mergeUserSettingsIfPresent(config, temp, STATUS_LINE, false);
      const merged = JSON.parse(readFileSync(temp, "utf-8"));
      expect(merged.model).toBe("glm-5.3");
      expect(merged.env).toEqual({ A: "1" });
      expect(merged.statusLine).toEqual(STATUS_LINE);
      expect(config.claudeArgs).toEqual(["-p"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed inline JSON: catch branch — temp keeps its content, --settings still spliced, never throws", () => {
    const dir = tempDir();
    try {
      const temp = join(dir, "temp-settings.json");
      const original = '{"statusLine":{"type":"command","command":"original"}}';
      writeFileSync(temp, original, "utf-8");
      const config = makeConfig(["--settings", '{"model":', "-p"]);
      expect(() => mergeUserSettingsIfPresent(config, temp, STATUS_LINE, false)).not.toThrow();
      expect(readFileSync(temp, "utf-8")).toBe(original);
      expect(config.claudeArgs).toEqual(["-p"]); // splice happens on every path
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable settings path: temp file keeps its own content, --settings still spliced, never throws", () => {
    const dir = tempDir();
    try {
      const temp = join(dir, "temp-settings.json");
      const original = '{"statusLine":{"type":"command","command":"original"}}';
      writeFileSync(temp, original, "utf-8");
      const config = makeConfig(["--settings", join(dir, "does-not-exist.json"), "-p"]);
      expect(() => mergeUserSettingsIfPresent(config, temp, STATUS_LINE, false)).not.toThrow();
      expect(readFileSync(temp, "utf-8")).toBe(original);
      expect(config.claudeArgs).toEqual(["-p"]); // ALWAYS removed — see the splice comment
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
