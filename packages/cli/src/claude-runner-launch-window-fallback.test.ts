/**
 * Launch live-discovery bound: LIVE_DISCOVERY_BOUND_MS = 2,000 ms, used only
 * when neither the stored dynamic models catalog nor the cloud models catalog
 * has a window. The production timeout constant should be exported; these
 * behavior tests keep an independent budget so changing it cannot hide a stall.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupModelForProvider } from "./adapters/model-catalog.js";
import { credentials } from "./auth/credentials/authority.js";
import type { CredentialProvider } from "./auth/credentials/types.js";
import { computeMainThreadContextWindow, resolveContextWindowEnv } from "./claude-runner.js";
import { getConfigFileOverride, setConfigFileOverride } from "./config-override.js";
import {
  type DiskCacheV3,
  _clearAllModelsCacheMemo,
  writeAllModelsCache,
} from "./providers/all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./providers/catalog-client.js";
import { CATALOG_ROUTE_BINDINGS } from "./providers/catalog-route-bindings.js";
import {
  deriveAccountKey,
  writeStoredModelsList,
} from "./providers/dynamic-models-catalog-store.js";
import {
  _resetAccountModelsListsForTest,
  readAccountModelsList,
} from "./providers/dynamic-models-catalog.js";
import "./providers/model-discovery-builtins.js";
import * as discovery from "./providers/model-discovery.js";
import * as routing from "./providers/routing-rules.js";
import museCatalog from "./test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json";
import type { ClaudishConfig } from "./types.js";

const LIVE_DISCOVERY_BOUND_MS = 2_000;
const BOUND_MARGIN_MS = 750;
const FAST_LAUNCH_BUDGET_MS = 750;
const LIVE_WINDOW = 1_007_997;
const CONNECTION_WINDOW = 524_288;
const DEFAULT_WINDOW = 1_048_576;
const STORED_WINDOW = 262_144;
const PROVIDER = "meta-muse-code";
const ACCOUNT = "launch-window-test-account";
const CANONICAL_ID = "muse-wonder-full";
const WIRE_ID = "muse-wonder-full-1.0";
const realRoute = routing.route;
const originalFetcher = discovery.getModelDiscoveryFetcher("muse-code-models");
const originalFetch = globalThis.fetch;
const previousCredentials = new Map<string, CredentialProvider>();
const fetcher = mock<discovery.ModelDiscoveryFetcher>(() => new Promise(() => {}));

let dir: string;
let cachePath: string;
let previousConfig: string | null;
let previousDir: string | undefined;
let previousKey: string | undefined;
let pendingResult: Promise<discovery.FetcherResult> | undefined;
let routeSpy: ReturnType<typeof spyOn<typeof routing, "route">>;
let identitySpy: ReturnType<typeof spyOn<typeof credentials, "accountIdentity">>;
let readinessSpy: ReturnType<typeof spyOn<typeof credentials, "describeReadiness">>;
let authSpy: ReturnType<typeof spyOn<typeof credentials, "getRequestAuth">>;

function install(window: "none" | "connection" | "default"): void {
  const data = structuredClone(museCatalog) as DiskCacheV3;
  const model = data.entries.find((entry) => entry.modelId === CANONICAL_ID);
  if (!model) throw new Error("Expected Muse Wonder Full test data");
  delete model.contextWindow;
  for (const connection of model.aggregators ?? []) {
    delete connection.contextWindow;
    if (
      window === "connection" &&
      connection.route?.routeId === CATALOG_ROUTE_BINDINGS[PROVIDER]?.routeId &&
      connection.route?.routeProfileId === CATALOG_ROUTE_BINDINGS[PROVIDER]?.routeProfileId
    ) {
      connection.contextWindow = CONNECTION_WINDOW;
    }
  }
  if (window !== "none") model.contextWindow = DEFAULT_WINDOW;
  _clearAllModelsCacheMemo();
  writeAllModelsCache(data, cachePath);
  _setCatalogEntriesForTest(data.entries);
}

function launch(spec: string): Promise<number> {
  return computeMainThreadContextWindow({ model: spec } as ClaudishConfig, cachePath);
}

async function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`launch still awaiting discovery after ${ms}ms`), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-launch-window-fallback-"));
  cachePath = join(dir, "cloud-models-catalog.json");
  previousConfig = getConfigFileOverride();
  previousDir = process.env.CLAUDISH_DYNAMIC_CATALOG_DIR;
  previousKey = process.env.CLAUDISH_DYNAMIC_CATALOG_KEY;
  setConfigFileOverride(join(dir, "config.json"));
  process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = join(dir, "dynamic-models-catalog");
  process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = join(dir, "dynamic-models-catalog.key");

  for (const name of Object.keys(CATALOG_ROUTE_BINDINGS)) {
    const previous = credentials.get(name);
    if (!previous) continue;
    previousCredentials.set(name, previous);
    credentials.register({
      catalogName: name,
      isAvailable: async () => name === PROVIDER,
      getRequestAuth: async () => ({ headers: {} }),
    });
  }
  identitySpy = spyOn(credentials, "accountIdentity").mockImplementation(async (provider) =>
    provider === PROVIDER ? ACCOUNT : undefined
  );
  readinessSpy = spyOn(credentials, "describeReadiness").mockImplementation(async (provider) => ({
    readiness: provider === PROVIDER ? "present" : "absent",
  }));
  authSpy = spyOn(credentials, "getRequestAuth").mockResolvedValue({ headers: {} });
  globalThis.fetch = Object.assign(
    mock(async () => {
      throw new Error("Unexpected network in launch-window-fallback test");
    }),
    { preconnect: () => {} }
  ) as unknown as typeof fetch;
  fetcher.mockReset();
  // No timer or socket keeps an intentionally never-settling fetch alive.
  fetcher.mockImplementation(() => new Promise(() => {}));
  discovery.registerModelDiscoveryFetcher("muse-code-models", fetcher);
  discovery.invalidateModelDiscovery();
  _resetAccountModelsListsForTest();
  _resetCatalogClient();
  install("none");
  // Keep real routing, including its background network policy, but force all
  // cloud models catalog reads and routing rules into this test's own data.
  routeSpy = spyOn(routing, "route").mockImplementation((spec, _rules, _default, _cache, opts) =>
    realRoute(spec, {}, "", cachePath, opts)
  );
});

afterEach(async () => {
  // A red launch may return before the delayed fetch. Drain that finite fetch
  // and its write-through before removing its storage or restoring credentials.
  if (pendingResult) {
    await pendingResult;
    await Bun.sleep(0);
    pendingResult = undefined;
  }
  routeSpy.mockRestore();
  identitySpy.mockRestore();
  readinessSpy.mockRestore();
  authSpy.mockRestore();
  globalThis.fetch = originalFetch;
  if (originalFetcher) discovery.registerModelDiscoveryFetcher("muse-code-models", originalFetcher);
  discovery.invalidateModelDiscovery();
  _resetAccountModelsListsForTest();
  for (const previous of previousCredentials.values()) credentials.register(previous);
  previousCredentials.clear();
  _resetCatalogClient();
  _clearAllModelsCacheMemo();
  setConfigFileOverride(previousConfig);
  if (previousDir === undefined) delete process.env.CLAUDISH_DYNAMIC_CATALOG_DIR;
  else process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = previousDir;
  if (previousKey === undefined) delete process.env.CLAUDISH_DYNAMIC_CATALOG_KEY;
  else process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = previousKey;
  rmSync(dir, { recursive: true, force: true });
});

for (const [type, spec] of [
  ["bare", CANONICAL_ID],
  ["explicit", `muse@${WIRE_ID}`],
] as const) {
  describe(`${type} launch context window`, () => {
    test("uses the stored dynamic models catalog before the cloud window without fetching", async () => {
      install("connection");
      const key = deriveAccountKey(PROVIDER, ACCOUNT);
      expect(key.ok).toBe(true);
      if (!key.ok) throw new Error(key.reason);
      expect(
        writeStoredModelsList(PROVIDER, key.accountKey, [
          { id: WIRE_ID, contextWindow: STORED_WINDOW, reported: "chat" },
        ])
      ).toBe(true);

      expect(await withinBudget(launch(spec), FAST_LAUNCH_BUDGET_MS)).toBe(STORED_WINDOW);
      await Bun.sleep(0);
      expect(fetcher).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test("uses the connection window promptly while exactly one background refresh never settles", async () => {
      install("connection");
      expect(await readAccountModelsList(PROVIDER)).toBeNull();
      expect(lookupModelForProvider(WIRE_ID, PROVIDER, cachePath)).toBe(CONNECTION_WINDOW);

      expect(await withinBudget(launch(spec), FAST_LAUNCH_BUDGET_MS)).toBe(CONNECTION_WINDOW);
      await Bun.sleep(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith(PROVIDER);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test("uses a live window arriving after 50ms when the cloud models catalog has no window", async () => {
      expect(await readAccountModelsList(PROVIDER)).toBeNull();
      expect(lookupModelForProvider(CANONICAL_ID, PROVIDER, cachePath)).toBeUndefined();
      expect(lookupModelForProvider(WIRE_ID, PROVIDER, cachePath)).toBeUndefined();
      fetcher.mockImplementation(() => {
        pendingResult = Bun.sleep(50).then(() => ({
          kind: "models",
          models: [{ id: WIRE_ID, contextWindow: LIVE_WINDOW, reported: "chat" }],
        }));
        return pendingResult;
      });

      expect(await withinBudget(launch(spec), LIVE_DISCOVERY_BOUND_MS + BOUND_MARGIN_MS)).toBe(
        LIVE_WINDOW
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test("waits for the live-discovery bound then returns unknown when discovery never settles", async () => {
      expect(await readAccountModelsList(PROVIDER)).toBeNull();
      expect(lookupModelForProvider(WIRE_ID, PROVIDER, cachePath)).toBeUndefined();
      const start = performance.now();
      const window = await withinBudget(launch(spec), LIVE_DISCOVERY_BOUND_MS + BOUND_MARGIN_MS);
      const elapsed = performance.now() - start;

      expect(window).toBe(0);
      await Bun.sleep(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      // Returning immediately would discard a window discovery could still
      // supply within the allowed wait, just as waiting forever blocks launch.
      expect(elapsed).toBeGreaterThanOrEqual(LIVE_DISCOVERY_BOUND_MS - 250);
      expect(elapsed).toBeLessThan(LIVE_DISCOVERY_BOUND_MS + BOUND_MARGIN_MS);
    });

    test("uses the model default promptly when the routed connection has no window", async () => {
      install("default");
      expect(await readAccountModelsList(PROVIDER)).toBeNull();
      expect(lookupModelForProvider(WIRE_ID, PROVIDER, cachePath)).toBe(DEFAULT_WINDOW);

      expect(await withinBudget(launch(spec), FAST_LAUNCH_BUDGET_MS)).toBe(DEFAULT_WINDOW);
      await Bun.sleep(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test("returns unknown when live discovery answers without a window", async () => {
      fetcher.mockResolvedValue({
        kind: "models",
        models: [{ id: WIRE_ID, reported: "chat" }],
      });

      expect(await withinBudget(launch(spec), LIVE_DISCOVERY_BOUND_MS + BOUND_MARGIN_MS)).toBe(0);
      await Bun.sleep(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test("returns unknown when live discovery fails", async () => {
      fetcher.mockRejectedValue(new Error("Discovery unavailable in test"));

      expect(await withinBudget(launch(spec), LIVE_DISCOVERY_BOUND_MS + BOUND_MARGIN_MS)).toBe(0);
      await Bun.sleep(0);
      expect(fetcher).toHaveBeenCalledWith(PROVIDER);
    });
  });
}

test("resolveContextWindowEnv(0) leaves Claude Code's default with no variables or notice", () => {
  expect(resolveContextWindowEnv(0, {})).toEqual({ vars: {} });
});
