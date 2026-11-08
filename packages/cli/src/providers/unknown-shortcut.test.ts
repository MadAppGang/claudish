import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME must be set before imports: Bun caches homedir() at process startup.
if (process.env.CLAUDISH_W2_TEST_CHILD !== import.meta.path) {
  test("W2: isolated HOME child", () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-w2-"));
    try {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_W2_TEST_CHILD: import.meta.path,
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
        },
        timeout: 18_000,
      });
      const output =
        new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
      console.info(output);
      expect(child.exitCode, output).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const check = (name: string, run: () => unknown) =>
    test(name, async () => {
      await run();
    }, 10_000);

  const { afterAll, beforeEach } = await import("bun:test");
  const { readFileSync } = await import("node:fs");
  const { isKnownProviderName, suggestProviderShortcuts, describeUnknownShortcut } = await import(
    "./unknown-shortcut.js"
  );
  const { BUILTIN_PROVIDERS } = await import("./provider-definitions.js");
  const { PREDEFINED_ENDPOINTS } = await import("./predefined-catalog.js");
  const { PROVIDER_SHORTCUTS } = await import("./model-parser.js");
  const { gatherRouteCandidates } = await import("./route-candidates.js");
  const { explainRoute, route } = await import("./routing-rules.js");
  const { _setCatalogEntriesForTest, _resetCatalogClient } = await import("./catalog-client.js");
  const { credentials } = await import("../auth/credentials/authority.js");
  const { setConfigFileOverride, loadConfig, saveConfig } = await import("../profile-config.js");
  const { ensureEndpointsRegistered } = await import("./endpoint-registration.js");
  const { clearProviderCredentialEnv } = await import("../test-helpers/provider-credential-env.js");
  const restoreEnv = clearProviderCredentialEnv();
  setConfigFileOverride(join(process.env.HOME!, "config.json"));
  saveConfig({
    ...loadConfig(),
    keychain: { enabled: false },
    onepassword: [],
    customEndpoints: {
      "w2-custom": {
        kind: "simple",
        url: "http://127.0.0.1:1",
        format: "openai",
        authScheme: "none",
        wire: { api: "chat-completions" },
      },
    },
  });
  ensureEndpointsRegistered({ force: true });
  const capture = join(
    import.meta.dir,
    "../test-fixtures/catalog-v3/rows-g-20260919013346169.json"
  );
  _setCatalogEntriesForTest(JSON.parse(readFileSync(capture, "utf8")).entries);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => {
    throw new Error("W2 forbids upstream network");
  }, originalFetch);
  const reads: string[] = [];
  for (const name of new Set([
    "go",
    ...BUILTIN_PROVIDERS.map((provider) => provider.name),
    ...PREDEFINED_ENDPOINTS.map((provider) => provider.name),
  ])) {
    credentials.register({
      catalogName: name,
      isAvailable: async () => {
        reads.push(name);
        return false;
      },
      describeReadiness: async () => {
        reads.push(name);
        return { readiness: "absent" };
      },
      getRequestAuth: async () => {
        reads.push(name);
        throw new Error("W2 must not sign");
      },
    });
  }
  beforeEach(() => {
    reads.length = 0;
  });
  afterAll(() => {
    _resetCatalogClient();
    restoreEnv();
    globalThis.fetch = originalFetch;
  });

  check(
    "G4 / 3.1: every declared name and shortcut is known without a key, including bundled and custom endpoints",
    () => {
      for (const provider of BUILTIN_PROVIDERS) {
        expect(isKnownProviderName(provider.name), provider.name).toBe(true);
        for (const shortcut of provider.shortcuts)
          expect(isKnownProviderName(shortcut), shortcut).toBe(true);
      }
      for (const provider of PREDEFINED_ENDPOINTS)
        expect(isKnownProviderName(provider.name), provider.name).toBe(true);
      expect(isKnownProviderName("custom-url")).toBe(true);
      expect(isKnownProviderName("w2-custom")).toBe(true);
      expect(isKnownProviderName("go")).toBe(false);
      expect(isKnownProviderName("w2-unregistered")).toBe(false);
      expect(reads).toEqual([]);
    }
  );

  check(
    "G4 / 3.2: unknown shortcut is not missing credentials and suggests a provider gathered for this model",
    async () => {
      const model = "gemini-3.8-flash";
      const explanation = await explainRoute(`go@${model}`, { rules: {} });
      expect(explanation.outcome).toMatchObject({
        kind: "no-route",
        cause: "explicit-unknown-shortcut",
        reason: 'Unknown provider shortcut "go" in "go@gemini-3.8-flash".',
      });
      expect(explanation.candidates).toHaveLength(1);
      expect(explanation.candidates[0]?.outcome).toBe("unknown-provider");
      const expected = describeUnknownShortcut("go", model);
      expect(explanation.outcome).toMatchObject(expected);
      if (explanation.outcome.kind !== "no-route") throw new Error("Expected unknown shortcut");
      expect(explanation.outcome.reason).not.toContain("No credentials configured");
      const suggestions = suggestProviderShortcuts(model);
      expect(suggestions.length).toBeGreaterThan(0);
      const gathered = gatherRouteCandidates(model).candidates.map(
        (candidate) => candidate.provider
      );
      expect(suggestions.some((suggestion) => gathered.includes(suggestion.provider))).toBe(true);
      for (const suggestion of suggestions)
        expect(explanation.outcome.hint).toContain(`${suggestion.shortcut}@${model}`);
      expect(reads).toEqual([]);
    }
  );

  check("G4 / 3.2b: the reason retains the typed shortcut and complete +pro spec", async () => {
    const explanation = await explainRoute("go@gemini-3.8-flash+pro", { rules: {} });
    expect(explanation.outcome).toMatchObject({
      kind: "no-route",
      cause: "explicit-unknown-shortcut",
      reason: 'Unknown provider shortcut "go" in "go@gemini-3.8-flash+pro".',
    });
    expect(reads).toEqual([]);
  });

  check(
    "G4 / 3.3: suggestions are exactly gathered providers and resolve through the shortcut table, with no fixed model list",
    () => {
      const entries: { modelId: string }[] = JSON.parse(readFileSync(capture, "utf8")).entries;
      for (const entry of entries) {
        const gathered = gatherRouteCandidates(entry.modelId).candidates;
        const suggestions = suggestProviderShortcuts(entry.modelId);
        expect(
          new Set(suggestions.map((suggestion) => suggestion.provider)),
          entry.modelId
        ).toEqual(new Set(gathered.map((candidate) => candidate.provider)));
        for (const suggestion of suggestions) {
          expect(PROVIDER_SHORTCUTS[suggestion.shortcut], suggestion.shortcut).toBe(
            suggestion.provider
          );
          expect(suggestion.displayName.length).toBeGreaterThan(0);
          expect(suggestion.label.length).toBeGreaterThan(0);
        }
      }
      expect(reads).toEqual([]);
    }
  );

  check(
    "G4 / 3.4: known bundled groq without a key remains a credential failure, never unknown",
    async () => {
      const explanation = await explainRoute("groq@w2-model", { rules: {} });
      expect(explanation.outcome).toMatchObject({
        kind: "no-route",
        cause: "explicit-no-credential",
      });
      expect(JSON.stringify(explanation.outcome)).not.toContain("Unknown provider shortcut");
      expect(reads).toContain("groq");
    }
  );

  check(
    "G5 / 3.6: both explainRoute and route reject an unknown shortcut before any credential lookup",
    async () => {
      await explainRoute("go@gemini-3.8-flash", { rules: {} });
      const plan = await route("go@gemini-3.8-flash", {});
      expect(plan).toMatchObject({
        kind: "no-route",
        ...describeUnknownShortcut("go", "gemini-3.8-flash"),
      });
      expect(reads).toEqual([]);
    }
  );
}
