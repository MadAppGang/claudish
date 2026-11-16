import { expect, test } from "bun:test";
import { contractConfig, isolatedFile } from "../test-helpers/claude-behaviour.js";
import { useSandbox } from "../test-helpers/model-lineup-blind.js";

await isolatedFile(import.meta, async () => {
  const sandbox = useSandbox();
  const { parseModelFlags } = await import("../providers/model-parser.js");
  const {
    decideModelListings,
    decideClaudeLaunch,
    launchSigningFor,
    subscriptionCause,
    claudeRowsAsPicked,
  } = await import("./claude-launch.js");
  const {
    startsOnClaudeSubscription,
    hasNativeAnthropicMapping,
    isProxyAuthMode,
    shouldHideIncidentalAnthropicKey,
  } = await import("../claude-runner.js");

  function parsed(values: string[]) {
    const result = parseModelFlags(values);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  }
  const listing = {
    provider: "devin",
    typed: "devin@",
    scope: "recommended" as const,
    pinnedSpecs: [],
  };
  const safe = {
    settingsFindings: () => [],
    unreadableSettings: () => [],
    classifierPassthrough: () => false,
  };

  // REQ-1, REQ-5, REQ-7
  test("TEST-07 resolves shortcut order with start first, then listings, then pin-only providers", () => {
    const flags = parsed([
      "google@old-pin",
      "devin@",
      "or@",
      "openrouter@*",
      "ollama@start",
      "lmstudio@",
    ]);
    const config = contractConfig({ model: flags.start, claudeArgs: [], monitor: false });

    expect(decideModelListings(config, flags, safe)).toEqual({ ok: true });
    expect(config.modelListings?.map((row) => row.provider)).toEqual([
      "ollama",
      "devin",
      "openrouter",
      "lmstudio",
      "google",
    ]);
    expect(config.modelListings?.filter((row) => row.provider === "openrouter")).toHaveLength(1);
    expect(config.modelListings?.find((row) => row.provider === "openrouter")?.scope).toBe("all");
    expect(config.modelListings?.[0]?.pinnedSpecs[0]).toBe("ollama@start");
    expect(config.modelListings?.at(-1)?.pinnedSpecs).toContain("google@old-pin");
  });

  test.each(["nosuchprovider@", "claude@", "custom-url@"])(
    "TEST-08 refuses unsupported listing %s",
    (value) => {
      const flags = parsed([value]);
      const config = contractConfig({ claudeArgs: [], monitor: false });
      const result = decideModelListings(config, flags, safe);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected listing refusal");
      expect(result.message).toMatch(/claude|custom-url|nosuchprovider/i);
    }
  );

  // REQ-8, REQ-27
  test("TEST-09 listing-only launch starts on Claude default with login-only native policy", () => {
    const config = contractConfig({ modelListings: [listing], claudeArgs: [], monitor: false });
    expect(startsOnClaudeSubscription(config)).toBe(true);
    expect(hasNativeAnthropicMapping(config)).toBe(true);
    expect(isProxyAuthMode(config)).toBe(false);
    expect(
      shouldHideIncidentalAnthropicKey(config, { ANTHROPIC_API_KEY: "incidental-test-value" })
    ).toBe(true);
    expect(launchSigningFor(config, { wantsApiBilling: () => false })).toEqual({
      kind: "login-only",
    });
    expect(claudeRowsAsPicked(config)).toBe(true);
    expect(subscriptionCause(config)).toContain("--model devin@ names no start model");
    expect(subscriptionCause(config)).toContain("Claude's default model");
  });

  test("TEST-10 Claude subscription start with listings is bare, pinned and never monitor", () => {
    const config = contractConfig({
      model: "claude@opus",
      modelListings: [listing],
      monitor: false,
      anthropicApiBilling: true,
      claudeArgs: [],
    });
    expect(
      decideClaudeLaunch(config, { paneChild: false, shadowedEndpointRefusal: () => null })
    ).toEqual({ ok: true });
    expect(config.model).toBe("opus");
    expect(config.claudeSubscriptionPin).toBe(true);
    expect(config.monitor).toBe(false);
    expect(config.claudeLaunch).toBeUndefined();
    expect(launchSigningFor(config, { wantsApiBilling: () => true })).toEqual({
      kind: "login-only",
    });
    expect(claudeRowsAsPicked(config)).toBe(true);
  });

  // REQ-9
  test.each([
    { model: "ollama@start", monitor: true },
    { model: "anthropic@claude-opus-5", monitor: false },
  ])("TEST-11 refuses a lineup whose launch forwards every request to Anthropic: %j", (fields) => {
    const flags = parsed([fields.model, "devin@"]);
    const config = contractConfig({ ...fields, claudeArgs: [] });
    const result = decideModelListings(config, flags, safe);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected incompatible-launch refusal");
    expect(result.message).toMatch(/monitor|anthropic|Claude API/i);
  });

  // REQ-27, REQ-28
  test("TEST-12 listing-only default does not replace profile tier posture", () => {
    const foreign = contractConfig({
      modelListings: [listing],
      modelOpus: "ollama@tier",
      claudeArgs: [],
      monitor: false,
    });
    expect(startsOnClaudeSubscription(foreign)).toBe(false);
    expect(isProxyAuthMode(foreign)).toBe(true);
    expect(claudeRowsAsPicked(foreign)).toBe(false);

    const native = contractConfig({
      modelListings: [listing],
      modelHaiku: "claude-haiku-4-5",
      claudeArgs: [],
      monitor: false,
    });
    expect(startsOnClaudeSubscription(native)).toBe(false);
    expect(hasNativeAnthropicMapping(native)).toBe(true);
    expect(isProxyAuthMode(native)).toBe(false);
  });

  // REQ-25: this is a public injected finding, not a simulated network failure.
  test.each([true, false])(
    "TEST-13 base-URL refusal respects kept-login policy %s",
    (keepsLogin) => {
      const flags = parsed(["ollama@start", "devin@"]);
      const config = contractConfig({ model: flags.start, claudeArgs: [], monitor: false });
      const where = sandbox().settingsFile;
      const result = decideModelListings(config, flags, {
        ...safe,
        keepsLogin: () => keepsLogin,
        settingsFindings: () => [{ where, kind: "base-url" }],
      });
      expect(result.ok).toBe(!keepsLogin);
      if (!result.ok) {
        expect(result.message).toContain(where);
        expect(result.message).toContain("ANTHROPIC_BASE_URL");
      }
    }
  );
});
