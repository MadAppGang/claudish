/**
 * E2E tests for the flag passthrough feature.
 *
 * Validates the complete flow: parseArgs → arg-building logic (as in runClaudeWithProxy)
 * → final Claude Code args array, without requiring API keys or a running proxy server.
 *
 * Also validates settings merge behavior (mergeUserSettingsIfPresent logic) using
 * temp files.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli.js";
import type { ClaudishConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helper: buildClaudeArgs
//
// Replicates the arg-building section of runClaudeWithProxy (lines 252-284
// of claude-runner.ts) without creating real files or spawning processes.
// The tempSettingsPath is mocked to a fixed sentinel so tests can match it
// without knowing actual filesystem paths.
// ---------------------------------------------------------------------------

const MOCK_SETTINGS_PATH = "/mock/.claudish/settings-12345.json";

function buildClaudeArgs(config: ClaudishConfig): string[] {
  const claudeArgs: string[] = [];

  // Always starts with --settings <path>
  claudeArgs.push("--settings", MOCK_SETTINGS_PATH);

  if (config.interactive) {
    // Interactive mode
    if (config.autoApprove) {
      claudeArgs.push("--dangerously-skip-permissions");
    }
    if (config.dangerous) {
      claudeArgs.push("--dangerouslyDisableSandbox");
    }
    claudeArgs.push(...config.claudeArgs);
  } else {
    // Single-shot mode
    claudeArgs.push("-p");
    if (config.autoApprove) {
      claudeArgs.push("--dangerously-skip-permissions");
    }
    if (config.dangerous) {
      claudeArgs.push("--dangerouslyDisableSandbox");
    }
    if (config.jsonOutput) {
      claudeArgs.push("--output-format", "json");
    }
    claudeArgs.push(...config.claudeArgs);
  }

  return claudeArgs;
}

// ---------------------------------------------------------------------------
// Helper: mergeUserSettingsLogic
//
// Replicates the mergeUserSettingsIfPresent logic from claude-runner.ts
// for testing settings merge behavior.
// ---------------------------------------------------------------------------

const MOCK_STATUS_LINE = { type: "command", command: "echo claudish", padding: 0 };

function mergeUserSettingsLogic(
  config: ClaudishConfig,
  tempSettingsPath: string
): { merged: boolean; warned: boolean } {
  const idx = config.claudeArgs.indexOf("--settings");
  if (idx === -1 || !config.claudeArgs[idx + 1]) {
    return { merged: false, warned: false };
  }

  const userSettingsValue = config.claudeArgs[idx + 1];
  let warned = false;

  try {
    let userSettings: Record<string, unknown>;
    if (userSettingsValue.trimStart().startsWith("{")) {
      userSettings = JSON.parse(userSettingsValue);
    } else {
      const rawUserSettings = readFileSync(userSettingsValue, "utf-8");
      userSettings = JSON.parse(rawUserSettings);
    }

    userSettings.statusLine = MOCK_STATUS_LINE;
    writeFileSync(tempSettingsPath, JSON.stringify(userSettings, null, 2), "utf-8");
  } catch {
    warned = true;
  }

  // Always remove --settings from claudeArgs
  config.claudeArgs.splice(idx, 2);

  return { merged: !warned, warned };
}

// ---------------------------------------------------------------------------
// Group 1: E2E — Single-shot mode full pipeline
// ---------------------------------------------------------------------------

describe("Group 1: E2E — Single-shot mode full pipeline", () => {
  test("claudish --model grok 'hello' → --settings <path> -p hello", async () => {
    const config = await parseArgs(["--model", "grok", "hello"]);
    const args = buildClaudeArgs(config);

    expect(args[0]).toBe("--settings");
    expect(args[1]).toBe(MOCK_SETTINGS_PATH);
    expect(args[2]).toBe("-p");
    expect(args).toContain("hello");
    // No extra flags added
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--output-format");
  });

  test("claudish --model grok --agent detective --stdin --quiet 'task' → --stdin and --quiet consumed, --agent detective and task pass through", async () => {
    const config = await parseArgs([
      "--model",
      "grok",
      "--agent",
      "detective",
      "--stdin",
      "--quiet",
      "task",
    ]);
    expect(config.stdin).toBe(true);
    expect(config.quiet).toBe(true);

    const args = buildClaudeArgs(config);
    expect(args[0]).toBe("--settings");
    expect(args[2]).toBe("-p");
    expect(args).toContain("--agent");
    expect(args).toContain("detective");
    expect(args).toContain("task");
    // --stdin and --quiet must NOT appear in Claude Code args
    expect(args).not.toContain("--stdin");
    expect(args).not.toContain("--quiet");
  });

  test("claudish --model grok --effort high --permission-mode plan 'task' → correct passthrough", async () => {
    const config = await parseArgs([
      "--model",
      "grok",
      "--effort",
      "high",
      "--permission-mode",
      "plan",
      "task",
    ]);
    const args = buildClaudeArgs(config);

    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).toContain("task");
    expect(args[2]).toBe("-p");
  });

  test("claudish --model grok -y --agent test 'do it' → --dangerously-skip-permissions inserted", async () => {
    const config = await parseArgs(["--model", "grok", "-y", "--agent", "test", "do it"]);
    const args = buildClaudeArgs(config);

    expect(args[2]).toBe("-p");
    expect(args[3]).toBe("--dangerously-skip-permissions");
    expect(args).toContain("--agent");
    expect(args).toContain("test");
    expect(args).toContain("do it");
  });

  test("claudish --model grok -- --system-prompt '-verbose' 'task' → everything after -- passes through", async () => {
    const config = await parseArgs([
      "--model",
      "grok",
      "--",
      "--system-prompt",
      "-verbose",
      "task",
    ]);
    const args = buildClaudeArgs(config);

    expect(args[2]).toBe("-p");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("-verbose");
    expect(args).toContain("task");
  });

  test("claudish --model grok --json --add-dir /tmp 'task' → --output-format json and --add-dir /tmp in args", async () => {
    const config = await parseArgs(["--model", "grok", "--json", "--add-dir", "/tmp", "task"]);
    expect(config.jsonOutput).toBe(true);

    const args = buildClaudeArgs(config);
    expect(args[2]).toBe("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--add-dir");
    expect(args).toContain("/tmp");
    expect(args).toContain("task");
  });
});

// ---------------------------------------------------------------------------
// Group 2: E2E — Interactive mode full pipeline
// ---------------------------------------------------------------------------

describe("Group 2: E2E — Interactive mode full pipeline", () => {
  test("claudish --model grok -i --permission-mode plan → no -p, --permission-mode plan in args", async () => {
    const config = await parseArgs(["--model", "grok", "-i", "--permission-mode", "plan"]);
    expect(config.interactive).toBe(true);

    const args = buildClaudeArgs(config);
    expect(args[0]).toBe("--settings");
    expect(args[1]).toBe(MOCK_SETTINGS_PATH);
    // -p must NOT appear in interactive mode
    expect(args).not.toContain("-p");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
  });

  test("claudish --model grok -i -y --effort high → --dangerously-skip-permissions before --effort high", async () => {
    const config = await parseArgs(["--model", "grok", "-i", "-y", "--effort", "high"]);
    expect(config.interactive).toBe(true);
    expect(config.autoApprove).toBe(true);

    const args = buildClaudeArgs(config);
    expect(args).not.toContain("-p");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    // dangerously-skip-permissions must come before --effort in the array
    const skipIdx = args.indexOf("--dangerously-skip-permissions");
    const effortIdx = args.indexOf("--effort");
    expect(skipIdx).toBeLessThan(effortIdx);
  });

  test("claudish --model grok -i --agent researcher → --agent researcher in args, no -p", async () => {
    const config = await parseArgs(["--model", "grok", "-i", "--agent", "researcher"]);
    expect(config.interactive).toBe(true);

    const args = buildClaudeArgs(config);
    expect(args).not.toContain("-p");
    expect(args).toContain("--agent");
    expect(args).toContain("researcher");
  });

  test("claudish --model grok -i (no claudeArgs) → default to interactive, args only has --settings", async () => {
    const config = await parseArgs(["--model", "grok", "-i"]);
    expect(config.interactive).toBe(true);
    expect(config.claudeArgs).toEqual([]);

    const args = buildClaudeArgs(config);
    expect(args).toEqual(["--settings", MOCK_SETTINGS_PATH]);
  });
});

// ---------------------------------------------------------------------------
// Group 3: E2E — Settings merge
// ---------------------------------------------------------------------------

describe("Group 3: E2E — Settings merge", () => {
  const tmpDir = tmpdir();
  let userSettingsPath: string;
  let tempSettingsPath: string;

  beforeAll(() => {
    userSettingsPath = join(tmpDir, `claudish-test-user-settings-${Date.now()}.json`);
    tempSettingsPath = join(tmpDir, `claudish-test-temp-settings-${Date.now()}.json`);

    // Write initial claudish temp settings (simulating createTempSettingsFile output)
    writeFileSync(
      tempSettingsPath,
      JSON.stringify({ statusLine: MOCK_STATUS_LINE }, null, 2),
      "utf-8"
    );
  });

  afterAll(() => {
    for (const p of [userSettingsPath, tempSettingsPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  test("--settings <file> → user file merged with statusLine key injected", async () => {
    writeFileSync(userSettingsPath, JSON.stringify({ theme: "dark" }, null, 2), "utf-8");

    const config = await parseArgs(["--model", "grok", "--settings", userSettingsPath, "task"]);
    // --settings and its value should be in claudeArgs before merge
    expect(config.claudeArgs).toContain("--settings");
    expect(config.claudeArgs).toContain(userSettingsPath);

    const { merged, warned } = mergeUserSettingsLogic(config, tempSettingsPath);
    expect(merged).toBe(true);
    expect(warned).toBe(false);

    // Verify merged file has both theme and statusLine keys
    const result = JSON.parse(readFileSync(tempSettingsPath, "utf-8"));
    expect(result.theme).toBe("dark");
    expect(result.statusLine).toBeDefined();
    expect(result.statusLine.type).toBe("command");

    // --settings must be removed from claudeArgs after merge
    expect(config.claudeArgs).not.toContain("--settings");
    expect(config.claudeArgs).not.toContain(userSettingsPath);
    // The prompt "task" should remain
    expect(config.claudeArgs).toContain("task");
  });

  test("--settings '{\"debug\": true}' inline JSON → merge works with inline detection", async () => {
    // Re-write temp settings file to known state
    writeFileSync(
      tempSettingsPath,
      JSON.stringify({ statusLine: MOCK_STATUS_LINE }, null, 2),
      "utf-8"
    );

    const inlineJson = JSON.stringify({ debug: true });
    const config = await parseArgs(["--model", "grok", "--settings", inlineJson, "task"]);

    expect(config.claudeArgs).toContain("--settings");

    const { merged, warned } = mergeUserSettingsLogic(config, tempSettingsPath);
    expect(merged).toBe(true);
    expect(warned).toBe(false);

    const result = JSON.parse(readFileSync(tempSettingsPath, "utf-8"));
    expect(result.debug).toBe(true);
    expect(result.statusLine).toBeDefined();

    // --settings removed from claudeArgs
    expect(config.claudeArgs).not.toContain("--settings");
  });

  test("--settings /nonexistent.json → warns but does not crash, removes --settings from claudeArgs", async () => {
    // Re-write temp settings to known state
    writeFileSync(
      tempSettingsPath,
      JSON.stringify({ statusLine: MOCK_STATUS_LINE }, null, 2),
      "utf-8"
    );

    const config = await parseArgs([
      "--model",
      "grok",
      "--settings",
      "/nonexistent-path-that-does-not-exist.json",
      "task",
    ]);

    const { merged, warned } = mergeUserSettingsLogic(config, tempSettingsPath);
    expect(warned).toBe(true);
    expect(merged).toBe(false);

    // --settings removed from claudeArgs even on failure
    expect(config.claudeArgs).not.toContain("--settings");
    expect(config.claudeArgs).not.toContain("/nonexistent-path-that-does-not-exist.json");

    // Temp settings file untouched (still has original statusLine)
    const result = JSON.parse(readFileSync(tempSettingsPath, "utf-8"));
    expect(result.statusLine).toBeDefined();
  });

  test("no --settings flag → mergeUserSettingsLogic is a no-op, claudeArgs unchanged", async () => {
    const config = await parseArgs(["--model", "grok", "task"]);
    const originalArgs = [...config.claudeArgs];

    const { merged, warned } = mergeUserSettingsLogic(config, tempSettingsPath);
    expect(merged).toBe(false);
    expect(warned).toBe(false);

    // claudeArgs must not have been modified
    expect(config.claudeArgs).toEqual(originalArgs);
  });
});

// ---------------------------------------------------------------------------
// Group 4: E2E — Backward compatibility regression
// ---------------------------------------------------------------------------

describe("Group 4: E2E — Backward compatibility regression", () => {
  test("claudish --model grok 'prompt' → same single-shot output as before", async () => {
    const config = await parseArgs(["--model", "grok", "prompt"]);
    const args = buildClaudeArgs(config);

    // Exact shape: --settings <path> -p prompt
    expect(args).toEqual(["--settings", MOCK_SETTINGS_PATH, "-p", "prompt"]);
  });

  test("claudish --stdin --quiet --model grok → claudeArgs empty, stdin=true, quiet=true", async () => {
    const config = await parseArgs(["--stdin", "--quiet", "--model", "grok"]);
    expect(config.stdin).toBe(true);
    expect(config.quiet).toBe(true);
    expect(config.claudeArgs).toEqual([]);
  });

  test("claudish -y --model grok 'task' → autoApprove=true, claudeArgs=['task']", async () => {
    const config = await parseArgs(["-y", "--model", "grok", "task"]);
    expect(config.autoApprove).toBe(true);
    expect(config.claudeArgs).toEqual(["task"]);
  });
});

// ---------------------------------------------------------------------------
// Group 5: E2E — Edge cases
// ---------------------------------------------------------------------------

describe("Group 5: E2E — Edge cases", () => {
  test("multiple unknown flags with --stdin consumed → all unknown flags in claudeArgs", async () => {
    const config = await parseArgs([
      "--model",
      "grok",
      "--agent",
      "test",
      "--effort",
      "high",
      "--no-session-persistence",
      "--stdin",
      "task",
    ]);
    expect(config.stdin).toBe(true);
    // --stdin must NOT appear in claudeArgs
    expect(config.claudeArgs).not.toContain("--stdin");
    // All unknown flags must be in claudeArgs
    expect(config.claudeArgs).toContain("--agent");
    expect(config.claudeArgs).toContain("test");
    expect(config.claudeArgs).toContain("--effort");
    expect(config.claudeArgs).toContain("high");
    expect(config.claudeArgs).toContain("--no-session-persistence");
    expect(config.claudeArgs).toContain("task");
  });

  test("unknown boolean flag followed by known flag → unknown in claudeArgs, known consumed", async () => {
    const config = await parseArgs(["--model", "grok", "--no-session-persistence", "--quiet"]);
    expect(config.quiet).toBe(true);
    // --quiet must NOT appear in claudeArgs
    expect(config.claudeArgs).not.toContain("--quiet");
    expect(config.claudeArgs).toEqual(["--no-session-persistence"]);
  });

  test("claudish with no args → interactive mode, empty claudeArgs", async () => {
    const config = await parseArgs([]);
    expect(config.interactive).toBe(true);
    expect(config.claudeArgs).toEqual([]);

    const args = buildClaudeArgs(config);
    // Interactive mode with no claudeArgs: only --settings <path>
    expect(args).toEqual(["--settings", MOCK_SETTINGS_PATH]);
    expect(args).not.toContain("-p");
  });

  test("order preservation: unknown flags appear in claudeArgs in input order", async () => {
    const config = await parseArgs([
      "--model",
      "grok",
      "--agent",
      "detective",
      "--effort",
      "high",
      "my task",
    ]);
    // Verify order: --agent detective comes before --effort high comes before my task
    const agentIdx = config.claudeArgs.indexOf("--agent");
    const effortIdx = config.claudeArgs.indexOf("--effort");
    const taskIdx = config.claudeArgs.indexOf("my task");

    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(effortIdx).toBeGreaterThan(agentIdx);
    expect(taskIdx).toBeGreaterThan(effortIdx);
  });

  test("--json flag sets jsonOutput and produces --output-format json in single-shot args", async () => {
    const config = await parseArgs(["--model", "grok", "--json", "task"]);
    expect(config.jsonOutput).toBe(true);

    const args = buildClaudeArgs(config);
    const fmtIdx = args.indexOf("--output-format");
    expect(fmtIdx).toBeGreaterThan(-1);
    expect(args[fmtIdx + 1]).toBe("json");
    // --output-format json must come BEFORE the passthrough claudeArgs
    const taskIdx = args.indexOf("task");
    expect(fmtIdx).toBeLessThan(taskIdx);
  });
});
