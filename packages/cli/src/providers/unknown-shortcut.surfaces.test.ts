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
  const { credentials } = await import("../auth/credentials/authority.js");
  const { describeUnknownShortcut } = await import("./unknown-shortcut.js");
  const { route, explainRoute } = await import("./routing-rules.js");
  const { routingFieldsFrom } = await import("../probe/probe-chain.js");
  const { preflightModel, renderPreflightReport } = await import("./preflight-chain.js");
  const { DROPPED_LABEL, describeDropped } = await import("./probe-runner.js");
  const { _setCatalogEntriesForTest, _resetCatalogClient } = await import("./catalog-client.js");
  const { BUILTIN_PROVIDERS, getProviderByName } = await import("./provider-definitions.js");
  const { PREDEFINED_ENDPOINTS } = await import("./predefined-catalog.js");
  const { registerRuntimeProvider, clearRuntimeRegistry } = await import("./runtime-providers.js");
  const { setConfigFileOverride } = await import("../profile-config.js");
  const { clearProviderCredentialEnv } = await import("../test-helpers/provider-credential-env.js");
  const restoreEnv = clearProviderCredentialEnv();
  setConfigFileOverride(join(process.env.HOME!, "config.json"));
  _setCatalogEntriesForTest(
    JSON.parse(
      readFileSync(
        join(import.meta.dir, "../test-fixtures/catalog-v3/rows-g-20260919013346169.json"),
        "utf8"
      )
    ).entries
  );
  const nativeFetch = globalThis.fetch;
  const upstreamCalls: string[] = [];
  let localUrl: string | undefined;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (localUrl && url.startsWith(localUrl + "/")) return nativeFetch(input, init);
    upstreamCalls.push(url);
    throw new Error("W2 forbids upstream network");
  }, nativeFetch);
  const { createProxyServer } = await import("../proxy-server.js");
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
    upstreamCalls.length = 0;
  });
  afterAll(() => {
    _resetCatalogClient();
    restoreEnv();
    clearRuntimeRegistry();
    globalThis.fetch = nativeFetch;
  });

  check(
    "G5 / 3.5-3.6: routing, proxy explicit spec, preflight and --probe share the unknown text before credentials",
    async () => {
      const model = "gemini-3.8-flash";
      const spec = `go@${model}`;
      const expected = describeUnknownShortcut("go", model);
      const plan = await route(spec, {});
      expect(plan).toMatchObject({ kind: "no-route", ...expected });
      const explanation = await explainRoute(spec, { rules: {} });
      expect(routingFieldsFrom(explanation).noRoute).toEqual(expected);
      expect(DROPPED_LABEL["unknown-provider"]).toBe("unknown provider shortcut");
      expect(describeDropped("unknown-provider")).toContain("unknown provider shortcut");
      const preflight = await preflightModel(spec, {
        explain: (target) => explainRoute(target, { rules: {} }),
        probe: async () => {
          throw new Error("Unknown shortcut must not probe");
        },
      });
      expect(preflight).toMatchObject({ kind: "no-route", ...expected });
      const report = renderPreflightReport([preflight], { probed: true });
      expect(report).toContain(expected.reason);
      expect(report).toContain("Drop or replace before running");

      const proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
        quiet: true,
        hooks: false,
      });
      localUrl = proxy.url;
      try {
        const response = await fetch(`${proxy.url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: spec, max_tokens: 1, messages: [] }),
        });
        expect(response.status).toBe(400);
        const error = await response.text();
        expect(error).toContain(expected.reason.replaceAll('"', '\\"'));
        expect(error).not.toContain("No credentials configured");
        expect(reads).toEqual([]);
        expect(upstreamCalls).toEqual([]);
      } finally {
        await proxy.shutdown();
        localUrl = undefined;
      }
    }
  );

  check(
    "G2 / 2.2b: proxy marks a thrown registered handler 500 without changing its error envelope",
    async () => {
      const provider = "w2-throws";
      const definition = getProviderByName("openai");
      if (!definition) throw new Error("Missing OpenAI definition");
      let handlerCalls = 0;
      registerRuntimeProvider({
        ...definition,
        name: provider,
        shortcuts: [provider],
        apiKeyEnvVar: "",
        createHandler: async () => ({
          handle: async () => {
            handlerCalls++;
            throw new Error("W2 handler boom");
          },
          shutdown: async () => {},
        }),
      });
      credentials.register({
        catalogName: provider,
        isAvailable: async () => true,
        getRequestAuth: async () => ({ headers: {} }),
      });
      const proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
        quiet: true,
        hooks: false,
      });
      localUrl = proxy.url;
      try {
        const response = await fetch(`${proxy.url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: `${provider}@w2`, max_tokens: 1, messages: [] }),
        });
        expect(handlerCalls).toBe(1);
        expect(response.status).toBe(500);
        expect(response.headers.get("x-claudish-unhandled-error")).toBe("1");
        // Contract correction: the /v1/messages catch keeps "Error: …"; only app.onError uses "Proxy error: …".
        expect(await response.json()).toEqual({
          type: "error",
          error: { type: "api_error", message: "Error: W2 handler boom" },
        });
        expect(upstreamCalls).toEqual([]);
      } finally {
        await proxy.shutdown();
        localUrl = undefined;
      }
    }
  );
}
