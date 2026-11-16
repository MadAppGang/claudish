import { expect, test } from "bun:test";
import { isolatedFile } from "./test-helpers/claude-behaviour.js";
import { useSandbox } from "./test-helpers/model-lineup-blind.js";

await isolatedFile(import.meta, async () => {
  useSandbox();
  const { parseArgs } = await import("./cli.js");

  // REQ-2, REQ-3: the earlier chain must not survive a later --model.
  test("TEST-03 starts the final full spec and clears the stale routing chain", async () => {
    const config = await parseArgs(["--model", "a@x+b@y", "--model", "google@z"]);
    expect(config.model).toBe("google@z");
    expect(config.modelChain).toBeUndefined();
    expect(config._modelFlags).toBeUndefined();
    expect(config.modelListings).toBeUndefined();
  });

  // REQ-26
  test.each([
    ['{"ANTHROPIC_MODEL":"or@x"}', undefined],
    ['{"ANTHROPIC_MODEL":"or@different"}', "or@x"],
    [undefined, "or@x"],
    ["{not-json", "or@x"],
  ])("TEST-04 reads only user-owned ANTHROPIC_MODEL with record %s", async (record, expected) => {
    process.env.ANTHROPIC_MODEL = "or@x";
    if (record === undefined) delete process.env.CLAUDISH_SET_MODEL_VARS;
    else process.env.CLAUDISH_SET_MODEL_VARS = record;
    const config = await parseArgs([]);
    expect(config.model).toBe(expected);
  });

  test("TEST-04 gives CLAUDISH_MODEL and argv precedence over inherited model provenance", async () => {
    process.env.ANTHROPIC_MODEL = "or@x";
    process.env.CLAUDISH_SET_MODEL_VARS = '{"ANTHROPIC_MODEL":"or@x"}';
    process.env.CLAUDISH_MODEL = "ollama@user-export";

    expect((await parseArgs([])).model).toBe("ollama@user-export");
    expect((await parseArgs(["--model", "ollama@argv"])).model).toBe("ollama@argv");
  });
});
