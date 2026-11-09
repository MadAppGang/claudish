import { describe, expect, test } from "bun:test";
import { INTERACTIVE_PROBE_TIMEOUT_MS, pinProbeModelSpec } from "./probe-runner.js";

describe("interactive provider probes", () => {
  test("leave enough time for refreshable OAuth and provider retry budgets", () => {
    expect(INTERACTIVE_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  test("pins provider-qualified probe model specs", () => {
    expect(pinProbeModelSpec({ provider: "grok-subscription", modelSpec: "grok-4.5" })).toBe(
      "grok-subscription@grok-4.5"
    );
  });

  test("pins a wire id that starts with @, such as an OpenRouter preset", () => {
    expect(pinProbeModelSpec({ provider: "openrouter", modelSpec: "@preset/example" })).toBe(
      "openrouter@@preset/example"
    );
  });

  test("leaves a model spec that already names its provider unchanged", () => {
    expect(
      pinProbeModelSpec({ provider: "openrouter", modelSpec: "openrouter@@preset/example" })
    ).toBe("openrouter@@preset/example");
    expect(
      pinProbeModelSpec({ provider: "openrouter", modelSpec: "or@deepseek/deepseek-v4" })
    ).toBe("or@deepseek/deepseek-v4");
  });
});
