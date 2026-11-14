/**
 * `parseArgs` captures the launch's ANTHROPIC_API_KEY as `anthropicApiKey`.
 * claudish's own placeholder, left in the environment by a proxied parent
 * session, is not a key: captured, it would be sent to api.anthropic.com.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CLAUDISH_PLACEHOLDER_API_KEY } from "./auth/claudish-placeholder.js";
import { parseArgs } from "./cli.js";

describe("parseArgs anthropicApiKey", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });

  test("claudish's placeholder is not captured without --monitor or --advisor", async () => {
    process.env.ANTHROPIC_API_KEY = CLAUDISH_PLACEHOLDER_API_KEY;
    const config = await parseArgs(["--model", "or@deepseek/deepseek-r1", "hello"]);
    expect(config.anthropicApiKey).toBeUndefined();
  });

  test("a real key is captured", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-placeholder-test-not-real-0123";
    const config = await parseArgs(["--model", "or@deepseek/deepseek-r1", "hello"]);
    expect(config.anthropicApiKey).toBe("sk-ant-placeholder-test-not-real-0123");
  });
});
