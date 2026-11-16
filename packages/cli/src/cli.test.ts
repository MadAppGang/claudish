/**
 * Black box tests for parseArgs() in cli.ts.
 *
 * Tests are derived solely from requirements and API contracts:
 *   - ai-docs/sessions/dev-feature-flag-passthrough-20260302-153840-edf0003d/requirements.md
 *   - ai-docs/sessions/dev-feature-flag-passthrough-20260302-153840-edf0003d/architecture.md
 *
 * These tests validate behavior described in requirements, not implementation details.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { parseArgs } from "./cli.js";

// ---------------------------------------------------------------------------
// Group 1: Backward Compatibility (existing behavior preserved)
// ---------------------------------------------------------------------------

describe("Group 1: Backward compatibility", () => {
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

  test("model + debug-claudish flag", async () => {
    const config = await parseArgs(["--model", "grok", "--debug-claudish"]);
    expect(config.model).toBe("grok");
    expect(config.debug).toBe(true);
  });
});

describe("--model route chains", () => {
  test("--model keeps the first candidate ordinary and exposes the full chain separately", async () => {
    const config = await parseArgs(["--model", "zgo@a+mm@b"]);

    // All existing downstream consumers read config.model, so they must keep
    // receiving one ordinary spec rather than the raw cross-process chain.
    expect(config.model).toBe("zgo@a");
    expect(config.modelChain).toEqual(["zgo@a", "mm@b"]);
  });

  test("a plain --model leaves the opt-in chain field absent", async () => {
    const config = await parseArgs(["--model", "gc@glm-5.2"]);

    expect(config.model).toBe("gc@glm-5.2");
    expect(config.modelChain).toBeUndefined();
  });

  test("-m parses a route chain identically to --model", async () => {
    const config = await parseArgs(["-m", "zgo@a+mm@b"]);

    expect(config.model).toBe("zgo@a");
    expect(config.modelChain).toEqual(["zgo@a", "mm@b"]);
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

// ---------------------------------------------------------------------------
// Group 6: Monitor Mode
// REGRESSION: --monitor flag set ANTHROPIC_MODEL="unknown" — Fixed in /fix session dev-fix-20260303-122306-f3bfd19b
// ---------------------------------------------------------------------------

describe("Group 6: Monitor mode", () => {
  test("monitor mode without --model does not set modelId", async () => {
    // parseArgs reads CLAUDISH_MODEL / ANTHROPIC_MODEL; keep the test hermetic
    // so host shell defaults don't leak into the assertion.
    const savedClaudish = process.env.CLAUDISH_MODEL;
    const savedAnthropic = process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDISH_MODEL;
    delete process.env.ANTHROPIC_MODEL;
    try {
      const config = await parseArgs(["--monitor", "hello"]);
      expect(config.monitor).toBe(true);
      expect(config.model).toBeUndefined();
    } finally {
      if (savedClaudish !== undefined) process.env.CLAUDISH_MODEL = savedClaudish;
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_MODEL = savedAnthropic;
    }
  });

  test("monitor mode with explicit --model preserves it", async () => {
    const config = await parseArgs(["--monitor", "--model", "claude-sonnet-4-6", "hello"]);
    expect(config.monitor).toBe(true);
    expect(config.model).toBe("claude-sonnet-4-6");
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
      "--model",
      "grok",
      "--session-id",
      "abc-123",
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

  // Regression: a passthrough -p/--print flag with NO positional prompt must
  // NOT default to interactive mode. Previously claudish flipped interactive=true,
  // ran the model picker, then forwarded a bare `-p` (no prompt) to the child
  // `claude`, which crashed with "Input must be provided either through stdin or
  // as a prompt argument when using --print". This affected EVERY provider
  // (OpenAI, Kimi Coding, …) launched via bare interactive `claudish`.
  test("bare -p flag without prompt → single-shot (not interactive)", async () => {
    const config = await parseArgs(["--model", "grok", "-p"]);
    expect(config._hasPrintFlag).toBe(true);
    expect(config.interactive).toBe(false);
    expect(config.claudeArgs).toContain("-p");
  });

  test("bare --print flag without prompt → single-shot (not interactive)", async () => {
    const config = await parseArgs(["--model", "grok", "--print"]);
    expect(config._hasPrintFlag).toBe(true);
    expect(config.interactive).toBe(false);
    expect(config.claudeArgs).toContain("--print");
  });

  test("-p with a positional prompt stays single-shot (#76 unchanged)", async () => {
    const config = await parseArgs(["--model", "grok", "-p", "hello"]);
    expect(config.interactive).toBe(false);
    expect(config.claudeArgs).toContain("-p");
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

// ---------------------------------------------------------------------------
// Global / persistent debug mode (CLAUDISH_DEBUG env + --no-debug-claudish)
// ---------------------------------------------------------------------------

describe("Persistent debug mode", () => {
  const KEY = "CLAUDISH_DEBUG";

  async function withEnv(value: string | undefined, fn: () => Promise<void>) {
    const prev = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  }

  test("CLAUDISH_DEBUG=1 enables debug and bumps log level to debug", async () => {
    await withEnv("1", async () => {
      const config = await parseArgs(["--model", "grok"]);
      expect(config.debug).toBe(true);
      expect(config.logLevel).toBe("debug");
    });
  });

  test("CLAUDISH_DEBUG=true enables debug", async () => {
    await withEnv("true", async () => {
      const config = await parseArgs(["--model", "grok"]);
      expect(config.debug).toBe(true);
    });
  });

  test("CLAUDISH_DEBUG=0 keeps debug off", async () => {
    await withEnv("0", async () => {
      const config = await parseArgs(["--model", "grok"]);
      expect(config.debug).toBe(false);
    });
  });

  test("--debug-claudish still works with CLAUDISH_DEBUG unset", async () => {
    await withEnv(undefined, async () => {
      const config = await parseArgs(["--model", "grok", "-d"]);
      expect(config.debug).toBe(true);
    });
  });

  test("--no-debug-claudish overrides CLAUDISH_DEBUG=1 for this run", async () => {
    await withEnv("1", async () => {
      const config = await parseArgs(["--model", "grok", "--no-debug-claudish"]);
      expect(config.debug).toBe(false);
    });
  });

  test("explicit --log-level wins over the debug auto-bump", async () => {
    await withEnv("1", async () => {
      const config = await parseArgs(["--model", "grok", "--log-level", "minimal"]);
      expect(config.debug).toBe(true);
      expect(config.logLevel).toBe("minimal");
    });
  });
});

describe("a refused lineup --model on stderr", () => {
  test("is printed through redactSecrets", async () => {
    const lines: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const exit = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    try {
      await expect(
        parseArgs(["--model", "or@sk-or-v1-ABCDEFGHIJKLMNOPQRSTUVWX+or@y", "--model", "or@"])
      ).rejects.toThrow("process.exit");
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
    const printed = lines.join("\n");
    expect(printed).toContain("[claudish] Error:");
    expect(printed).not.toContain("sk-or-v1-ABCDEFGHIJKLMNOPQRSTUVWX");
  });
});
