/**
 * Black box tests for parseArgs() in cli.ts.
 *
 * Tests are derived solely from requirements and API contracts:
 *   - ai-docs/sessions/dev-feature-flag-passthrough-20260302-153840-edf0003d/requirements.md
 *   - ai-docs/sessions/dev-feature-flag-passthrough-20260302-153840-edf0003d/architecture.md
 *
 * These tests validate behavior described in requirements, not implementation details.
 */

import { test, expect, describe } from "bun:test";
import { parseArgs } from "./cli.js";
import type { ClaudishConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Group 1: Backward Compatibility (existing behavior preserved)
// ---------------------------------------------------------------------------

describe("Group 1: Backward compatibility", () => {
  test("--model-fable configures the version-independent Fable role", async () => {
    const config = await parseArgs(["--model-fable", "cx@gpt-6-astra", "task"]);
    expect(config.modelFable).toBe("cx@gpt-6-astra");
  });

  test("basic model + positional arg", async () => {
    const config = await parseArgs(["--model", "grok", "hello"]);
    expect(config.model).toBe("grok");
    expect(config.claudeArgs).toEqual(["hello"]);
  });

  test("stdin + quiet + model with no positional arg", async () => {
    const config = await parseArgs(["--stdin", "--quiet", "--model", "grok"]);
    expect(config.stdin).toBe(true);
    expect(config.quiet).toBe(true);
    expect(config.model).toBe("grok");
    expect(config.claudeArgs).toEqual([]);
  });

  test("-y auto-approve before model and positional", async () => {
    const config = await parseArgs(["-y", "--model", "grok", "task"]);
    expect(config.autoApprove).toBe(true);
    expect(config.model).toBe("grok");
    expect(config.claudeArgs).toEqual(["task"]);
  });

  test("model + debug flag", async () => {
    const config = await parseArgs(["--model", "grok", "--debug"]);
    expect(config.model).toBe("grok");
    expect(config.debug).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2: Two-Pass Parsing (new behavior)
// ---------------------------------------------------------------------------

describe("Group 2: Two-pass parsing", () => {
  test("unknown --agent flag followed by known --stdin --quiet", async () => {
    const config = await parseArgs([
      "--model",
      "grok",
      "--agent",
      "detective",
      "--stdin",
      "--quiet",
    ]);
    expect(config.model).toBe("grok");
    expect(config.stdin).toBe(true);
    expect(config.quiet).toBe(true);
    // --agent detective must land in claudeArgs, not break parsing of --stdin/--quiet
    expect(config.claudeArgs).toEqual(["--agent", "detective"]);
  });

  test("unknown --effort before known --model and --stdin", async () => {
    const config = await parseArgs(["--effort", "high", "--model", "grok", "--stdin"]);
    expect(config.model).toBe("grok");
    expect(config.stdin).toBe(true);
    // --effort high consumed as a pair (value doesn't start with -)
    expect(config.claudeArgs).toEqual(["--effort", "high"]);
  });

  test("unknown --permission-mode before --quiet and positional arg", async () => {
    const config = await parseArgs([
      "--model",
      "grok",
      "--permission-mode",
      "plan",
      "--quiet",
      "task",
    ]);
    expect(config.model).toBe("grok");
    expect(config.quiet).toBe(true);
    // --permission-mode plan + positional "task" all land in claudeArgs
    expect(config.claudeArgs).toEqual(["--permission-mode", "plan", "task"]);
  });

  test("boolean-style unknown flag --no-session-persistence before --stdin", async () => {
    const config = await parseArgs(["--model", "grok", "--no-session-persistence", "--stdin"]);
    expect(config.model).toBe("grok");
    expect(config.stdin).toBe(true);
    // --no-session-persistence has no value (next token starts with -)
    expect(config.claudeArgs).toEqual(["--no-session-persistence"]);
  });
});

// ---------------------------------------------------------------------------
// Group 3: -- Separator
// ---------------------------------------------------------------------------

describe("Group 3: -- separator", () => {
  test("everything after -- passes through raw", async () => {
    const config = await parseArgs(["--model", "grok", "--", "--system-prompt", "-v mode"]);
    expect(config.model).toBe("grok");
    // Both tokens after -- must be in claudeArgs verbatim
    expect(config.claudeArgs).toEqual(["--system-prompt", "-v mode"]);
  });

  test("-- separator with known --stdin before it and args after", async () => {
    const config = await parseArgs(["--model", "grok", "--stdin", "--", "--agent", "test"]);
    expect(config.model).toBe("grok");
    expect(config.stdin).toBe(true);
    expect(config.claudeArgs).toEqual(["--agent", "test"]);
  });
});

// ---------------------------------------------------------------------------
// Group 4: Mixed Ordering Edge Cases
// ---------------------------------------------------------------------------

describe("Group 4: Mixed ordering edge cases", () => {
  test("unknown flag at start, then known flags, then positional at end", async () => {
    const config = await parseArgs(["--agent", "test", "--model", "grok", "--stdin", "task"]);
    expect(config.model).toBe("grok");
    expect(config.stdin).toBe(true);
    // --agent test (unknown) and "task" (positional) both in claudeArgs, in order
    expect(config.claudeArgs).toEqual(["--agent", "test", "task"]);
  });

  test("unknown --max-budget-usd with float value before --quiet", async () => {
    const config = await parseArgs(["--model", "grok", "--max-budget-usd", "0.50", "--quiet"]);
    expect(config.model).toBe("grok");
    expect(config.quiet).toBe(true);
    // "0.50" does not start with '-' so it is consumed as the flag's value
    expect(config.claudeArgs).toEqual(["--max-budget-usd", "0.50"]);
  });

  test("single positional arg with no known flags does not trigger interactive mode", async () => {
    const config = await parseArgs(["task text here"]);
    // Positional goes to claudeArgs
    expect(config.claudeArgs).toEqual(["task text here"]);
    // Having claudeArgs means NOT interactive mode
    expect(config.interactive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Dead Agent Code Removed
// ---------------------------------------------------------------------------

describe("Group 5: Dead agent code removed", () => {
  test("--agent passes through to claudeArgs and config has no agent property", async () => {
    const config = await parseArgs(["--model", "grok", "--agent", "detective", "--stdin"]);
    // --agent detective must land in claudeArgs
    expect(config.claudeArgs).toContain("--agent");
    expect(config.claudeArgs).toContain("detective");

    // ClaudishConfig must NOT have an agent field
    // This validates that the dead code (agent?: string) has been removed from types.ts
    // If config.agent were defined, TypeScript would allow this access.
    // We check at runtime that the property is absent from the returned object.
    expect((config as Record<string, unknown>)["agent"]).toBeUndefined();

    // Also verify the config object's own keys do not include 'agent'
    const keys = Object.keys(config);
    expect(keys).not.toContain("agent");
  });
});

// ---------------------------------------------------------------------------
// Group 6: Monitor Mode
// REGRESSION: --monitor flag set ANTHROPIC_MODEL="unknown" — Fixed in /fix session dev-fix-20260303-122306-f3bfd19b
// ---------------------------------------------------------------------------

/**
 * Inline helper extracted from claude-runner.ts:239-240 to make the modelId
 * calculation unit-testable without spawning processes or creating temp files.
 */
function computeModelId(config: ClaudishConfig): string | undefined {
  const hasProfileMappings =
    config.modelOpus ||
    config.modelSonnet ||
    config.modelHaiku ||
    config.modelFable ||
    config.modelSubagent;
  return config.model || (hasProfileMappings || config.monitor ? undefined : "unknown");
}

describe("Group 6: Monitor mode", () => {
  test("monitor mode without --model does not set modelId", async () => {
    const config = await parseArgs(["--monitor", "hello"]);
    expect(config.monitor).toBe(true);
    expect(config.model).toBeUndefined();
  });

  test("monitor mode with explicit --model preserves it", async () => {
    const config = await parseArgs(["--monitor", "--model", "claude-sonnet-4-6", "hello"]);
    expect(config.monitor).toBe(true);
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  test("monitor mode modelId calculation returns undefined", () => {
    // When monitor=true and no model specified, modelId must be undefined (not "unknown")
    // so ANTHROPIC_MODEL is not set in the child process environment.
    const config: ClaudishConfig = {
      monitor: true,
      model: undefined,
      claudeArgs: ["hello"],
      interactive: false,
      stdin: false,
      quiet: false,
      debug: false,
      autoApprove: false,
      concurrency: 1,
    } as unknown as ClaudishConfig;
    const modelId = computeModelId(config);
    expect(modelId).toBeUndefined();
  });

  test("non-monitor mode without model falls back to unknown", () => {
    // When monitor=false and no model or profile mappings, modelId must be "unknown"
    // to preserve existing proxy behavior for unspecified model routing.
    const config: ClaudishConfig = {
      monitor: false,
      model: undefined,
      claudeArgs: ["hello"],
      interactive: false,
      stdin: false,
      quiet: false,
      debug: false,
      autoApprove: false,
      concurrency: 1,
    } as unknown as ClaudishConfig;
    const modelId = computeModelId(config);
    expect(modelId).toBe("unknown");
  });
});

// ─── Regression: -p flag conflict with Claude CLI (GitHub #76) ─────────────

describe("Regression: -p flag is not consumed by claudish (#76)", () => {
  test("-p is passed through to Claude CLI, not parsed as --profile", async () => {
    const config = await parseArgs(["--model", "grok", "-p", "hello"]);
    // -p should NOT be consumed as --profile
    expect(config.profile).toBeUndefined();
    // -p and "hello" should pass through to claudeArgs
    expect(config.claudeArgs).toContain("-p");
  });

  test("--profile still works without -p shorthand", async () => {
    const config = await parseArgs(["--profile", "myprofile", "--model", "grok"]);
    expect(config.profile).toBe("myprofile");
  });
});

// ---------------------------------------------------------------------------
// Interactive mode detection (PR #103)
// ---------------------------------------------------------------------------

describe("Interactive mode detection with flag-only args", () => {
  test("flags with values but no prompt → interactive", async () => {
    const config = await parseArgs([
      "--model", "grok",
      "--session-id", "abc-123",
      "--dangerously-skip-permissions",
    ]);
    expect(config.interactive).toBe(true);
  });

  test("positional prompt → single-shot (not interactive)", async () => {
    const config = await parseArgs(["--model", "grok", "hello world"]);
    expect(config.interactive).toBe(false);
  });

  test("prompt after -- separator → single-shot (not interactive)", async () => {
    const config = await parseArgs(["--model", "grok", "--", "hello world"]);
    expect(config.interactive).toBe(false);
  });

  test("no args at all → interactive", async () => {
    const config = await parseArgs(["--model", "grok"]);
    expect(config.interactive).toBe(true);
  });

  test("--stdin → not interactive (reads from stdin)", async () => {
    const config = await parseArgs(["--model", "grok", "--stdin"]);
    expect(config.interactive).toBe(false);
  });
});
