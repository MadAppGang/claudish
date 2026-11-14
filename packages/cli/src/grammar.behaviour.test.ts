import { expect, test } from "bun:test";
import { KEY, MODEL, contractConfig, isolatedFile } from "./test-helpers/claude-behaviour.js";

await isolatedFile(import.meta, async () => {
  const n = await import("./providers/native-route.js");
  const l = await import("./launcher/claude-launch.js");
  const runner = await import("./claude-runner.js");
  const { parseModelSpec } = await import("./providers/model-parser.js");
  const { getProviderByName, readAtUseKeyEnvVars } = await import(
    "./providers/provider-definitions.js"
  );
  const { serveSubscriptionSlotRefusal } = await import("./serve-command.js");
  const p = await import("./auth/claudish-placeholder.js");
  const { realValueFor } = await import("./env-placeholder.js");
  type Config = Parameters<typeof l.decideClaudeLaunch>[0];
  const decide = (c: Config, paneChild = false) =>
    l.decideClaudeLaunch(c, { paneChild, shadowedEndpointRefusal: () => null });

  test("B-20 parses API shortcuts and declares read-at-use authentication", () => {
    for (const prefix of ["anthropic", "a", "api"]) {
      expect(parseModelSpec(prefix + "@X")).toMatchObject({
        provider: "anthropic",
        model: "X",
        isExplicitProvider: true,
      });
    }
    expect(parseModelSpec("claude@X")).toMatchObject({
      provider: "native-anthropic",
      model: "X",
      isExplicitProvider: true,
    });
    expect(getProviderByName("anthropic")).toMatchObject({
      displayName: "Claude API",
      shortcuts: ["anthropic", "a", "api"],
      authScheme: "x-api-key",
      vaultKeyReadAtUse: true,
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      baseUrl: "https://api.anthropic.com",
      apiPath: "/v1/messages",
      transport: "anthropic",
      shortestPrefix: "anthropic",
      legacyPrefixes: [],
      isDirectApi: true,
    });
    expect(getProviderByName("anthropic")?.apiKeyAliases ?? []).toEqual([]);
    expect(getProviderByName("native-anthropic")?.shortcuts).toEqual(["claude"]);
    expect(readAtUseKeyEnvVars().has("ANTHROPIC_API_KEY")).toBe(true);
  });

  test("B-21 recognizes only Claude-owned subscription specs as native", () => {
    expect(n.proxyRouteDecision("claude@" + MODEL)).toMatchObject({
      type: "native",
      route: { provider: "native-anthropic", displayName: "Claude subscription" },
    });
    expect(n.nativeRouteFor("claude@" + MODEL)).not.toBeNull();
    expect(n.proxyRouteDecision("claude@gpt-6")).toMatchObject({
      type: "explicit",
      provider: "native-anthropic",
    });
    expect(n.nativeRouteFor("claude@gpt-6")).toBeNull();
    expect(n.proxyRouteDecision("anthropic@" + MODEL)).toMatchObject({
      type: "explicit",
      provider: "anthropic",
    });
  });

  test("B-22 refuses subscription markers concurrency foreign names and chains", () => {
    for (const [spec, text] of [
      ["claude@" + MODEL + "#fast", "speed and mode markers cannot apply"],
      ["claude@" + MODEL + ":3", "takes no :N concurrency suffix"],
      ["claude@gpt-6", "claude@ serves Claude Code's own Claude models; gpt-6 is not one"],
      ["claude@" + MODEL + "+openrouter@x", "cannot be a hop of a + chain"],
    ])
      expect(n.claudeSubscriptionSpecRefusal(spec)).toContain(text);
    for (const spec of ["claude@" + MODEL, "claude@opus", "anthropic@x", "gpt-6"])
      expect(n.claudeSubscriptionSpecRefusal(spec)).toBeNull();
    expect(n.claudeSubscriptionInner("claude@" + MODEL)).toBe(MODEL);
    expect(n.claudeSubscriptionInner("claude@gpt-6")).toBe("claude@gpt-6");
  });

  test("B-23 selects API monitor launches and refuses modifiers", () => {
    for (const prefix of ["anthropic", "a", "api"]) {
      const c: Config = contractConfig({ model: prefix + "@" + MODEL });
      expect(decide(c)).toEqual({ ok: true });
      expect(c).toMatchObject({ model: prefix + "@" + MODEL, monitor: true, claudeLaunch: "api" });
    }
    for (const suffix of ["#fast", "+pro", "#bogus", ":3"]) {
      const c: Config = contractConfig({ model: "anthropic@" + MODEL + suffix });
      const out = decide(c);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("modifier unexpectedly accepted");
      expect(out.message).toContain(
        suffix === ":3"
          ? "a :N concurrency suffix cannot apply"
          : "a Claude launch talks to Anthropic through Claude Code itself"
      );
      expect(c.monitor).toBeUndefined();
      expect(c.claudeLaunch).toBeUndefined();
    }
  });

  test("B-24 selects subscription monitor launches and refuses chains", () => {
    const c: Config = contractConfig({ model: "claude@" + MODEL });
    expect(decide(c)).toEqual({ ok: true });
    expect(c).toMatchObject({
      monitor: true,
      claudeLaunch: "subscription",
      model: "claude@" + MODEL,
    });
    expect(decide(contractConfig({ model: "claude@gpt-6" }))).toMatchObject({
      ok: false,
      message: expect.stringContaining("gpt-6 is not one"),
    });
    expect(
      decide(contractConfig({ model: c.model, modelChain: [c.model!, "openrouter@x"] }))
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("cannot be a hop of a + chain"),
    });
  });

  test("B-25 pins pane subscriptions while leaving API hops proxied", () => {
    const c: Config = contractConfig({ model: "claude@" + MODEL });
    expect(decide(c, true)).toEqual({ ok: true });
    expect(c).toEqual(contractConfig({ model: MODEL, claudeSubscriptionPin: true }));
    for (const c of [
      contractConfig({ model: "anthropic@" + MODEL }),
      contractConfig({ model: "anthropic@" + MODEL, modelHaiku: "grok@y" }),
    ]) {
      const original = { ...c };
      expect(decide(c, true)).toEqual({ ok: true });
      expect(c).toEqual(original);
    }
    const tier: Config = contractConfig({ model: "claude@" + MODEL, modelHaiku: "grok@y" });
    expect(decide(tier, true)).toEqual({ ok: true });
    expect(tier).toMatchObject({ model: MODEL, claudeSubscriptionPin: true, modelHaiku: "grok@y" });
    expect(tier.monitor).toBeUndefined();
  });

  test("B-26 refuses top-level role mappings with source-specific remedies", () => {
    const a: Config = contractConfig({
      model: "anthropic@claude-x",
      modelHaiku: "claude@claude-y",
      modelTierSources: { haiku: "--model-haiku" },
    });
    const out = decide(a);
    expect(out).toMatchObject({ ok: false });
    if (out.ok) throw new Error("tier unexpectedly accepted");
    for (const text of [
      "claude@claude-y",
      "--model-haiku",
      "does not use role mappings",
      "Claude API launch",
    ])
      expect(out.message).toContain(text);
    expect(a.monitor).toBeUndefined();
    expect(a.claudeLaunch).toBeUndefined();
    const b = decide(
      contractConfig({
        model: "claude@claude-x",
        modelOpus: "grok@g",
        modelSonnet: "s",
        modelTierSources: { opus: 'profile "work"', sonnet: "CLAUDISH_MODEL_SONNET" },
      })
    );
    expect(b).toMatchObject({ ok: false });
    if (b.ok) throw new Error("tiers unexpectedly accepted");
    expect(b.message).toContain('remove the opus mapping from profile "work"');
    expect(b.message).toContain("unset CLAUDISH_MODEL_SONNET");
    expect(
      decide(contractConfig({ model: "claude@claude-x", modelHaiku: "grok@g" }))
    ).toMatchObject({ ok: false, message: expect.stringContaining("remove the haiku mapping") });
    expect(decide(contractConfig({ model: "claude@claude-x" }))).toEqual({ ok: true });
  });

  test("B-49 keeps bare and vendor-qualified routing unchanged", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    try {
      for (const key of [undefined, KEY]) {
        if (key) process.env.ANTHROPIC_API_KEY = key;
        else delete process.env.ANTHROPIC_API_KEY;
        expect(n.proxyRouteDecision(MODEL).type).toBe("native");
        expect(n.nativeRouteFor(MODEL)?.provider).toBe("native-anthropic");
        expect(n.proxyRouteDecision("anthropic/" + MODEL)).toMatchObject({
          type: "explicit",
          via: "vendor-qualified-id",
          provider: "openrouter",
        });
      }
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });

  test("B-61 selects login-only signing for Claude tiers without opt-in", () => {
    const off = { wantsApiBilling: () => false };
    const on = { wantsApiBilling: () => true };
    expect(l.launchSigningFor(contractConfig({ modelHaiku: "claude-haiku-x" }), off)).toEqual({
      kind: "login-only",
    });
    expect(
      l.launchSigningFor(contractConfig({ modelHaiku: "claude-haiku-x" }), on)
    ).toBeUndefined();
    expect(
      l.launchSigningFor(contractConfig({ model: "grok@g", modelSonnet: "sonnet" }), off)
    ).toEqual({ kind: "login-only" });
    expect(l.launchSigningFor(contractConfig({ model: "grok@g" }), off)).toBeUndefined();
    const pinned: Config = contractConfig({ modelOpus: "claude@claude-opus-x" });
    expect(decide(pinned)).toEqual({ ok: true });
    expect(l.launchSigningFor(pinned, on)).toEqual({ kind: "login-only" });
    expect(l.advisorKeyLookupAllowed(contractConfig(), off)).toBe(false);
    expect(l.advisorKeyLookupAllowed(contractConfig(), on)).toBe(true);
    for (const c of [
      { model: "grok@g" },
      { modelChain: ["grok@g", "a@x"] },
      { modelHaiku: "haiku" },
    ])
      expect(l.advisorKeyLookupAllowed(contractConfig(c), off)).toBe(true);
  });

  test("B-62 pins pane subscriptions against every billing opt-in", () => {
    for (const env of [
      { ANTHROPIC_API_KEY: KEY },
      { ANTHROPIC_API_KEY: KEY, CLAUDISH_ANTHROPIC_API_BILLING: "1" },
    ]) {
      const c: Config = contractConfig({ model: "claude@" + MODEL, anthropicApiBilling: true });
      expect(decide(c, true)).toEqual({ ok: true });
      expect(c).toMatchObject({ model: MODEL, claudeSubscriptionPin: true });
      expect(l.launchSigningFor(c)).toEqual({ kind: "login-only" });
      expect(runner.wantsAnthropicApiBilling(c, env)).toBe(false);
      expect(runner.shouldHideIncidentalAnthropicKey(c, env)).toBe(true);
    }
  });

  test("B-64 refuses settings credentials but only warns about base URLs", () => {
    const a = "/tmp/s/settings.json";
    const b = "/tmp/s/other.json";
    const explicit = l.subscriptionSettingsCheck([{ where: a, kind: "api-key" }], {
      bareName: false,
    });
    expect(explicit.refusal).toStartWith("Claude subscription: " + a + " sets ANTHROPIC_API_KEY");
    expect(explicit.refusal).toContain(
      "Remove it from " + a + ", or use anthropic@<id> for the Claude API."
    );
    expect(explicit.refusal).not.toContain("--anthropic-api-billing");
    expect(
      l.subscriptionSettingsCheck([{ where: a, kind: "api-key" }], { bareName: true }).refusal
    ).toContain(", or pass --anthropic-api-billing");
    expect(
      l.subscriptionSettingsCheck([{ where: a, kind: "auth-token" }], { bareName: false }).refusal
    ).toContain("sets ANTHROPIC_AUTH_TOKEN, which Claude Code would send instead of your login");
    const url = l.subscriptionSettingsCheck([{ where: a, kind: "base-url" }], { bareName: false });
    expect(url.refusal).toBeNull();
    expect(url.notices).toHaveLength(1);
    expect(url.notices[0]).toContain(
      "sets ANTHROPIC_BASE_URL, so this session's requests bypass claudish"
    );
    const multi = l.subscriptionSettingsCheck(
      [
        { where: a, kind: "api-key" },
        { where: b, kind: "auth-token" },
      ],
      { bareName: false, cause: "a pinned tier" }
    );
    expect(multi.refusal).toStartWith("Claude subscription, a pinned tier:");
    expect(multi.refusal).toContain("Remove them from " + a + ", " + b);
  });

  test("B-76 refuses subscription serve slots without falling to the API", () => {
    const slots = new Map([["opus", { model: "claude-opus-x" }]]);
    expect(serveSubscriptionSlotRefusal(slots, false)).toContain('slot "opus"');
    expect(serveSubscriptionSlotRefusal(slots, false)).toContain('"provider": "anthropic"');
    expect(serveSubscriptionSlotRefusal(slots, true)).toBeNull();
    for (const opt of [false, true]) {
      expect(
        serveSubscriptionSlotRefusal(
          new Map([["opus", { model: "claude-opus-x", provider: "claude" }]]),
          opt
        )
      ).not.toBeNull();
      expect(
        serveSubscriptionSlotRefusal(
          new Map([["opus", { model: "claude-opus-x", provider: "anthropic" }]]),
          opt
        )
      ).toBeNull();
    }
  });

  test("B-94 recognizes only variable-specific placeholders and concrete values", () => {
    expect(
      p.isClaudishPlaceholderCredential("ANTHROPIC_API_KEY", p.CLAUDISH_PLACEHOLDER_API_KEY)
    ).toBe(true);
    expect(
      p.isClaudishPlaceholderCredential("ANTHROPIC_API_KEY", p.CLAUDISH_PLACEHOLDER_AUTH_TOKEN)
    ).toBe(false);
    expect(p.isClaudishPlaceholderCredential("ANTHROPIC_API_KEY", undefined)).toBe(false);
    expect(realValueFor("ANTHROPIC_API_KEY", p.CLAUDISH_PLACEHOLDER_API_KEY)).toBeUndefined();
    expect(realValueFor("ANTHROPIC_API_KEY", "${X}")).toBeUndefined();
    expect(realValueFor("ANTHROPIC_API_KEY", KEY)).toBe(KEY);
  });

  test("B-96 labels native team routes as the Claude subscription", () => {
    for (const spec of [MODEL, "claude@" + MODEL, "haiku", "opus", "internal"])
      expect(n.nativeRouteFor(spec)?.displayName).toBe("Claude subscription");
  });
});
