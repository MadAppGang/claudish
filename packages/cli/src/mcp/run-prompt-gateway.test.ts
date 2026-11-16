import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { childRecord, standIn, temp } from "../test-helpers/claude-behaviour.js";
import { runPromptViaClaudeCode } from "./run-prompt-claude-code.js";

describe("run_prompt's print child and harnessGateway", () => {
  test("the claudish it starts is told to ignore harnessGateway", async () => {
    const home = temp();
    try {
      const env = { ...standIn(home), HOME: home, PATH: process.env.PATH ?? "" };
      await runPromptViaClaudeCode("claude-haiku-x", "hi", undefined, {
        parentEnv: env,
        settingsFindings: () => [],
      });
      expect(childRecord(home).env.CLAUDISH_HARNESS_GATEWAY_OFF).toBe("1");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
