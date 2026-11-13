import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { isolatedFile, MODEL, KEY, LOGIN, temp, cleanEnv, put, catalog, cli } from "./test-helpers/claude-behaviour.js";
await isolatedFile(import.meta, async () => {
  const { credentials } = await import("./auth/credentials/authority.js");
  const { keySourcesSearched } = await import("./auth/credentials/key-sources.js");
  const { ApiKeyCredentialProvider } = await import("./auth/credentials/api-key-credential.js");
  const { recordKeychainHydratedVar } = await import("./auth/credentials/keychain-source.js");
  const { recordOpHydratedVars } = await import("./providers/onepassword.js");
  const { outrankedKeyNote } = await import("./tui/config-save.js");
  const { CLAUDISH_PLACEHOLDER_API_KEY } = await import("./auth/claudish-placeholder.js");
  const { writeAllModelsCache } = await import("./providers/all-models-cache.js");

  async function inCase(id: string, config: unknown = {}) {
    if (process.env.T_CREDENTIAL_CASE === id) return true;
    const home = temp();
    try {
      put(join(home, ".claudish", "config.json"), { version: "1.0.0", defaultProfile: "default", profiles: {}, ...config as object });
      const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path, "-t", id], {
        cwd: home, env: { ...cleanEnv(home), T_CLAUDE_BEHAVIOUR_FILE: import.meta.path, T_CREDENTIAL_CASE: id },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stdout + stderr).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
    return false;
  }
  async function envKeys(run: () => Promise<void>) {
    const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
    const saved = names.map(n => process.env[n]);
    names.forEach(n => delete process.env[n]); credentials.invalidate();
    try { await run(); } finally {
      names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; });
      credentials.invalidate();
    }
  }

  test("B-17 signs the API with x-api-key and never a bearer", async () => {
    await envKeys(async () => {
      process.env.ANTHROPIC_API_KEY = KEY;
      process.env.ANTHROPIC_AUTH_TOKEN = LOGIN;
      credentials.invalidate("anthropic");
      const auth = await credentials.getRequestAuth("anthropic", { model: MODEL });
      expect(Object.keys(auth.headers)).toEqual(["x-api-key"]);
      expect(auth.headers["x-api-key"]).toBe(KEY);
      expect(auth.arm).toBe("api-key");
      delete process.env.ANTHROPIC_API_KEY; credentials.invalidate("anthropic");
      expect(await credentials.resolveForUse("anthropic")).toMatchObject({ state: "absent" });
    });
  });

  test("B-89 reports credential origins readiness and searched stores", async () => {
    await envKeys(async () => {
      process.env.ANTHROPIC_API_KEY = KEY; credentials.invalidate("anthropic");
      expect(await credentials.resolveForUse("anthropic")).toEqual({ state: "present", key: KEY, source: "environment" });
      expect(credentials.describeOrigin("anthropic")).toEqual({ source: "environment", masked: "sk-a...0000" });
      expect(await credentials.describeReadiness("anthropic")).toMatchObject({ readiness: "present" });
      process.env.ANTHROPIC_API_KEY = CLAUDISH_PLACEHOLDER_API_KEY; credentials.invalidate("anthropic");
      expect(await credentials.describeReadiness("anthropic")).toMatchObject({ readiness: "absent" });
      expect(await credentials.resolveForUse("native-anthropic")).toMatchObject({ state: "absent", searched: expect.any(Array) });
      expect(keySourcesSearched()).toEqual(["environment", "~/.claudish/config.json"]);
      expect(keySourcesSearched({ compact: true })).toEqual(["env", "config"]);
    });
  });

  test("B-90 replaces keys without hydrating env and detects outranking sources", async () => {
    if (!await inCase("B-90")) return;
    const A = "sk-ant-test-fake-A000", B = "sk-ant-test-fake-B000", C = "sk-ant-test-fake-C000";
    process.env.ANTHROPIC_API_KEY = A;
    const provider = new ApiKeyCredentialProvider({ catalogName: "anthropic", envVar: "ANTHROPIC_API_KEY", authScheme: "x-api-key", readAtUse: true });
    provider.replaceKey(B, "macOS Keychain");
    expect((await provider.getRequestAuth({ model: MODEL })).headers["x-api-key"]).toBe(B);
    expect(provider.describeOrigin()).toEqual({ source: "macOS Keychain", masked: "sk-a...B000" });
    expect(process.env.ANTHROPIC_API_KEY).toBe(A);
    provider.invalidate();
    expect((await provider.getRequestAuth({ model: MODEL })).headers["x-api-key"]).toBe(A);
    expect(provider.sourcesOutranking(B, "macOS Keychain")).toEqual(["environment"]);
    process.env.ANTHROPIC_API_KEY = B;
    expect(provider.sourcesOutranking(B, "macOS Keychain")).toEqual([]);
    process.env.ANTHROPIC_API_KEY = A;
    recordKeychainHydratedVar("ANTHROPIC_API_KEY");
    expect(provider.sourcesOutranking(B, "macOS Keychain")).toEqual([]);
    recordOpHydratedVars(["ANTHROPIC_API_KEY"]);
    expect(provider.sourcesOutranking(B, "macOS Keychain")).toEqual([]);
    delete process.env.ANTHROPIC_API_KEY;
    put(join(process.env.HOME!, ".claudish", "config.json"), { version: "1.0.0", profiles: {}, apiKeys: { ANTHROPIC_API_KEY: C } });
    expect(provider.sourcesOutranking(B, "macOS Keychain")).toEqual(["config"]);
    expect(provider.sourcesOutranking(B, "config")).toEqual([]);
    const notifications: Array<string | undefined> = [];
    const unsubscribe = credentials.onInvalidate(name => { notifications.push(name); });
    try {
      credentials.replaceKey("anthropic", B, "macOS Keychain");
      expect(notifications).toContain("anthropic");
      expect((await credentials.getRequestAuth("anthropic", { model: MODEL })).headers["x-api-key"]).toBe(B);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally { unsubscribe(); credentials.invalidate("anthropic"); }
  }, 30_000);

  test("B-91 explains shell and config keys outranking saved vault keys", () => {
    expect(outrankedKeyNote("ANTHROPIC_API_KEY", [])).toBe("");
    expect(outrankedKeyNote("ANTHROPIC_API_KEY", ["environment"])).toContain("the ANTHROPIC_API_KEY exported in your shell");
    expect(outrankedKeyNote("ANTHROPIC_API_KEY", ["config"])).toContain("ANTHROPIC_API_KEY in ~/.claudish/config.json apiKeys");
    const both = outrankedKeyNote("ANTHROPIC_API_KEY", ["environment", "config"]);
    expect(both).toContain("the ANTHROPIC_API_KEY exported in your shell and ANTHROPIC_API_KEY in ~/.claudish/config.json apiKeys");
  });

  test("B-95 rejects placeholder keys stored in config and in probe planning", async () => {
    if (!await inCase("B-95", { apiKeys: { ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY } })) return;
    credentials.invalidate("anthropic");
    expect(await credentials.resolveForUse("anthropic")).toMatchObject({ state: "absent" });
    const home = temp();
    try {
      put(join(home, ".claudish", "config.json"), { version: "1.0.0", profiles: {}, apiKeys: { ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY } });
      writeAllModelsCache(catalog() as Parameters<typeof writeAllModelsCache>[0], join(home, ".claudish", "cloud-models-catalog-v3.json"));
      const result = await cli(home, ["--probe", MODEL, "--json", "--no-probe"]);
      expect(result.code, result.stderr).toBe(0);
      const records = JSON.parse(result.stdout);
      expect(records).toHaveLength(1);
      expect(records[0].dropped).toContainEqual(expect.objectContaining({ provider: "anthropic", outcome: "no-credential" }));
      expect(records[0].chain.some((x: { provider: string }) => x.provider === "anthropic")).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30_000);
});
