import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// REGRESSION: #85, #88, #99 — keystrokes dropped in interactive claudish since v6.0.0.
// Root cause: telemetry consent prompt attached readline to process.stdin AFTER
// Claude Code was spawned with stdio: "inherit", creating a race between parent
// and child for each keystroke. Fixed in /dev:fix session dev-fix-20260415-125818.
//
// Prior art: commit 9d16c9d (Jan 2026) fixed a related class of stdin leak for #19
// and was silently lost during the v6.0.0 three-layer refactor. This test guards
// against that same regression vector for the telemetry consent code path.

const CONFIG_PATH = join(homedir(), ".claudish", "config.json");
const BACKUP_PATH = join(homedir(), ".claudish", "config.json.telemetry-test.bak");

function backupConfig() {
  if (existsSync(CONFIG_PATH)) {
    writeFileSync(BACKUP_PATH, readFileSync(CONFIG_PATH, "utf-8"));
    unlinkSync(CONFIG_PATH);
  }
}

function restoreConfig() {
  if (existsSync(BACKUP_PATH)) {
    writeFileSync(CONFIG_PATH, readFileSync(BACKUP_PATH, "utf-8"));
    unlinkSync(BACKUP_PATH);
  } else if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH);
  }
}

describe("telemetry consent prompt gating", () => {
  beforeEach(() => {
    backupConfig();
    delete require.cache[require.resolve("./telemetry.ts")];
    delete require.cache[require.resolve("./profile-config.ts")];
  });

  afterEach(() => {
    restoreConfig();
  });

  it("does NOT attach readline to process.stdin when Claude Code is running", async () => {
    const telemetry = await import(`./telemetry.ts?t=${Date.now()}`);

    const origIsInteractive = process.stdin.isTTY;
    const origStderrTTY = process.stderr.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

    const listenerCountBefore =
      process.stdin.listenerCount("data") +
      process.stdin.listenerCount("keypress") +
      process.stdin.listenerCount("line");

    telemetry.initTelemetry({
      interactive: true,
      model: "test",
      noTools: false,
      stdin: false,
      quiet: true,
    } as never);

    telemetry.setClaudeCodeRunning(true);

    telemetry.reportError({
      error: new Error("simulated provider failure"),
      providerName: "openrouter",
      providerDisplayName: "OpenRouter",
      streamFormat: "openai-sse",
      modelId: "test-model",
      isStreaming: false,
      retryAttempted: false,
      isInteractive: true,
    });

    await new Promise((r) => setTimeout(r, 50));

    const listenerCountAfter =
      process.stdin.listenerCount("data") +
      process.stdin.listenerCount("keypress") +
      process.stdin.listenerCount("line");

    telemetry.setClaudeCodeRunning(false);
    Object.defineProperty(process.stdin, "isTTY", { value: origIsInteractive, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: origStderrTTY, configurable: true });

    expect(listenerCountAfter).toBe(listenerCountBefore);
  });
});
