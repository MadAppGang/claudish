import { expect, test } from "bun:test";
import { isolatedFile, MODEL, KEY, contractConfig } from "./test-helpers/claude-behaviour.js";

await isolatedFile(import.meta, async () => {
  const { prepareClaudeLaunch, decideClaudeLaunch } = await import("./launcher/claude-launch.js");
  const { childAuthControl, claudeLaunchAuthLine, shouldHideIncidentalAnthropicKey } = await import("./claude-runner.js");
  const { applyHostManagedMarker } = await import("./host-routing-env.js");
  const { CLAUDISH_PLACEHOLDER_API_KEY, CLAUDISH_PLACEHOLDER_AUTH_TOKEN } = await import("./auth/claudish-placeholder.js");
  const { redactSigningValues, redactSecrets, redactForClient } = await import("./redact.js");
  type Config = Parameters<typeof prepareClaudeLaunch>[0];
  type Deps = NonNullable<Parameters<typeof prepareClaudeLaunch>[1]>;
  const config = (): Config => contractConfig({ model: "anthropic@" + MODEL, claudeLaunch: "api", monitor: true, interactive: false });
  const deps = (key = KEY): Deps => ({
    env: {}, settingsFindings: () => [], managedForcesClaudeAi: () => false,
    settingsForcingClaudeAi: () => [], wireIdFor: n => n,
    claudeCodeCredential: () => ({ kind: "login" }), settingsLoginToken: () => "absent",
    credentials: { resolveForUse: async () => ({ state: "present", key, source: "macOS Keychain" }) },
  });

  test("B-31 prepares a read-at-use API key without hydrating env", async () => {
    for (const interactive of [false, true]) {
      const c = { ...config(), interactive }, d = deps();
      d.credentials = { resolveForUse: async (name, opts) => {
        if (name !== "anthropic" || opts?.allowOpPrompt !== interactive)
          return { state: "failed", reason: "incorrect credential-use policy" };
        return { state: "present", key: KEY, source: "macOS Keychain" };
      } };
      const result = await prepareClaudeLaunch(c, d);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      try {
        expect(result.banner).toEqual(["[claudish] Monitor mode · Claude API · ANTHROPIC_API_KEY from macOS Keychain · signed by claudish"]);
        expect(result.signing?.kind).toBe("launch-key");
        if (result.signing?.kind !== "launch-key") throw new Error("missing launch-key signing");
        expect(result.signing.key()).toBe(KEY);
        expect(c.claudeLaunchModel).toBe(MODEL);
        expect(c.claudeLaunchKeySource).toBe("macOS Keychain");
        expect(c.anthropicApiKey).toBeUndefined();
        expect(d.env).toEqual({});
      } finally { result.lease?.release(); }
    }
  });

  test("B-32 refuses absent locked and policy-blocked API keys", async () => {
    const cases: Array<[Partial<Deps>, string[]]> = [
      [{ credentials: { resolveForUse: async () => ({ state: "absent", searched: ["environment", "config", "macOS Keychain"] }) } }, ["looked in environment, config, macOS Keychain"]],
      [{ credentials: { resolveForUse: async () => ({ state: "failed", reason: "item locked" }) } }, ["The Anthropic API key for the Claude API could not be read: item locked"]],
      [{ managedForcesClaudeAi: () => true, credentials: { resolveForUse: async () => { throw new Error("policy must prevent vault access"); } } }, ["managed Claude Code settings force the claude.ai login method"]],
      [{ settingsForcingClaudeAi: () => ["--settings"] }, ['--settings sets forceLoginMethod: "claudeai"']],
      [{ settingsForcingClaudeAi: () => ["--settings (occurrence 1)", "--settings (occurrence 2)"] }, ["--settings (occurrence 1)", "--settings (occurrence 2)", "set"]],
    ];
    for (const [overrides, fragments] of cases) {
      const result = await prepareClaudeLaunch(config(), { ...deps(), ...overrides });
      expect(result.ok).toBe(false);
      if (result.ok) { result.lease?.release(); throw new Error("refusal unexpectedly accepted"); }
      for (const text of fragments) expect(result.message).toContain(text);
    }
  });

  test("B-33 takes no redaction lease when wire lookup fails", async () => {
    const key = "plainfakevalue0123456789";
    await expect(prepareClaudeLaunch(config(), {
      ...deps(key), wireIdFor: () => { throw new Error("wire unavailable"); },
    })).rejects.toThrow("wire unavailable");
    expect(redactSigningValues("a " + key)).toBe("a " + key);
  });

  test("B-34 redacts the launch key only while its lease is held", async () => {
    const key = "plainfakevalue0123456789";
    const result = await prepareClaudeLaunch(config(), deps(key));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.lease).toBeDefined();
    try {
      for (const redact of [redactSigningValues, redactSecrets, redactForClient]) {
        expect(redact("a " + key)).toContain("[redacted]");
        expect(redact("a " + key)).not.toContain(key);
      }
    } finally { result.lease?.release(); }
    expect(redactSigningValues("a " + key)).toBe("a " + key);
  });

  test("B-35 prepares the subscription on an injected login", async () => {
    const c: Config = contractConfig({ model: "claude@" + MODEL, claudeLaunch: "subscription", monitor: true });
    const env = { ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY };
    const out = await prepareClaudeLaunch(c, { ...deps(), env });
    expect(out).toMatchObject({
      ok: true, banner: ["[claudish] Monitor mode · Claude subscription · Claude Code's own login"],
      signing: { kind: "login-only" },
    });
    expect(c.claudeLaunchModel).toBe(MODEL);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("B-46 reports API proxy auth as uncontrolled child auth", () => {
    expect(childAuthControl(config(), {}, {
      home: "/test-home", cwd: "/test-cwd", readFile: () => { throw new Error("ENOENT"); },
    })).toEqual({ controlled: false, reason: "proxy-auth", where: "environment" });
  });

  test("B-47 marks host management without changing first-party trust", () => {
    for (const trust of [undefined, "0", "1"]) {
      const env: Record<string, string | undefined> = {};
      if (trust !== undefined) env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = trust;
      applyHostManagedMarker(env);
      expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
      expect(env.CLAUDISH_SET_HOST_ROUTING_VARS).toBe("marker");
      expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe(trust);
    }
  });

  test("B-48 reports child auth without exposing values", () => {
    const api = claudeLaunchAuthLine("api", {
      ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    }, "macOS Keychain");
    for (const text of ["launch=api", "ANTHROPIC_API_KEY=absent", "ANTHROPIC_AUTH_TOKEN=placeholder", "host-managed=1", "forceLoginMethod=console", "signer=proxy(macOS Keychain)"]) expect(api).toContain(text);
    const sub = claudeLaunchAuthLine("subscription", { ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: "plainfakevalue0123456789" });
    expect(sub).toContain("signer=login-only");
    expect(sub).not.toContain("forceLoginMethod");
    for (const text of [api, sub]) for (const secret of [KEY, CLAUDISH_PLACEHOLDER_AUTH_TOKEN, "plainfakevalue0123456789"]) expect(text).not.toContain(secret);
  });

  test("B-63 pins a subscription tier and explains the ignored opt-in", async () => {
    const c: Config = contractConfig({ modelOpus: "claude@claude-opus-x", anthropicApiBilling: true });
    expect(decideClaudeLaunch(c, { paneChild: false, shadowedEndpointRefusal: () => null })).toEqual({ ok: true });
    expect(c.claudeSubscriptionPin).toBe(true);
    expect(c.monitor).toBeUndefined();
    expect(shouldHideIncidentalAnthropicKey(c, { ANTHROPIC_API_KEY: KEY })).toBe(true);
    const out = await prepareClaudeLaunch(c, { ...deps(), wantsApiBilling: c => !c.claudeSubscriptionPin });
    expect(out).toMatchObject({ ok: true, signing: { kind: "login-only" } });
    if (!out.ok) throw new Error(out.message);
    expect(out.banner.join("\n")).toContain("the API-billing opt-in does not apply: claude@ names the Claude subscription");
  });
});
