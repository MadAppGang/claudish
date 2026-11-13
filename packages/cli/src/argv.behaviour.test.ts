import { expect, test } from "bun:test";
import { isolatedFile } from "./test-helpers/claude-behaviour.js";
await isolatedFile(import.meta, async () => {
  const { parseArgs } = await import("./cli.js");
  const { launchSigningFor } = await import("./launcher/claude-launch.js");

  test("B-27 records tier sources and flag precedence", async () => {
    const names = ["CLAUDISH_MODEL_OPUS", "ANTHROPIC_DEFAULT_OPUS_MODEL"];
    const saved = names.map(n => process.env[n]);
    try {
      for (const n of names) delete process.env[n];
      expect((await parseArgs(["--model-haiku", "x"])).modelTierSources?.haiku).toBe("--model-haiku");
      process.env.CLAUDISH_MODEL_OPUS = "claude-opus-x";
      expect((await parseArgs([])).modelTierSources?.opus).toBe("CLAUDISH_MODEL_OPUS");
      expect((await parseArgs(["--model-opus", "flag-model"])).modelTierSources?.opus).toBe("--model-opus");
      delete process.env.CLAUDISH_MODEL_OPUS;
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-y";
      expect((await parseArgs([])).modelTierSources?.opus).toBe("ANTHROPIC_DEFAULT_OPUS_MODEL");
    } finally {
      names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; });
    }
  });

  test("B-41 consumes the hidden pin and overrides billing opt-in", async () => {
    const previous = process.env.CLAUDISH_ANTHROPIC_API_BILLING;
    process.env.CLAUDISH_ANTHROPIC_API_BILLING = "1";
    try {
      const pinned = await parseArgs(["--model", "claude-haiku-x", "--claude-subscription-pin"]);
      expect(pinned.claudeSubscriptionPin).toBe(true);
      expect(pinned.claudeArgs ?? []).not.toContain("--claude-subscription-pin");
      expect(launchSigningFor(pinned)).toEqual({ kind: "login-only" });
      expect(launchSigningFor(await parseArgs(["--model", "claude-haiku-x"]))).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CLAUDISH_ANTHROPIC_API_BILLING;
      else process.env.CLAUDISH_ANTHROPIC_API_BILLING = previous;
    }
  });
});
