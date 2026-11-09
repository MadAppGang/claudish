import { expect, jest, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "../auth/credentials/authority.js";
import { writeAllModelsCache } from "./all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import { _resetAccountModelsListsForTest } from "./dynamic-models-catalog.js";
import {
  type FetcherResult,
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import "./model-discovery-builtins.js";
import { gatherRouteCandidates } from "./route-candidates.js";
import { MISSING_LIST_WAIT_MS, explainRoute, route } from "./routing-rules.js";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

test("the missing-list deadline also bounds availability for a surviving vendor claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudish-availability-deadline-"));
  const cachePath = join(directory, "cloud-models-catalog-v3.json");
  const envNames = ["CLAUDISH_DYNAMIC_CATALOG_DIR", "CLAUDISH_DYNAMIC_CATALOG_KEY"] as const;
  const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  const original = {
    identity: credentials.accountIdentity,
    readiness: credentials.describeReadiness,
    available: credentials.isAvailable,
    fetch: globalThis.fetch,
    fetcher: getModelDiscoveryFetcher("antigravity")!,
  };
  let releaseDiscovery!: (value: FetcherResult) => void;
  const discovery = new Promise<FetcherResult>((resolve) => {
    releaseDiscovery = resolve;
  });
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const work: Promise<unknown>[] = [];
  const forbiddenFetch = mock(async () => {
    throw new Error("Network forbidden");
  });

  try {
    process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = join(directory, "dynamic-models-catalog");
    process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = join(directory, "dynamic-models-catalog.key");
    credentials.accountIdentity = async (provider) =>
      provider === "antigravity" ? "test-account-a" : undefined;
    credentials.describeReadiness = async (provider) => ({
      readiness: provider === "antigravity" ? "present" : "absent",
    });
    credentials.isAvailable = async (provider) => provider === "antigravity";
    globalThis.fetch = forbiddenFetch as unknown as typeof fetch;
    _resetAccountModelsListsForTest();
    invalidateModelDiscovery();
    const entries = [
      {
        modelId: "test-google-chat",
        provider: "google",
        aliases: [],
        inputModalities: ["text"],
        outputModalities: ["text"],
        aggregators: [],
      },
    ];
    _setCatalogEntriesForTest(entries);
    writeAllModelsCache(
      {
        version: 3,
        catalogGenerationId: "test-deadline-generation",
        lastUpdated: new Date().toISOString(),
        entries,
        models: [],
        plans: [],
      },
      cachePath
    );
    expect(gatherRouteCandidates("test-google-chat", cachePath).candidates).toContainEqual(
      expect.objectContaining({ provider: "antigravity", source: "vendor-claim" })
    );
    const fetcher = mock(async () => {
      signalStarted();
      return discovery;
    });
    registerModelDiscoveryFetcher("antigravity", fetcher);
    jest.useFakeTimers();
    const began = Date.now();
    let elapsed = Number.POSITIVE_INFINITY;
    const plan = route("test-google-chat", {}, "", cachePath, { network: "await" }).then(
      (result) => {
        elapsed = Date.now() - began;
        return result;
      }
    );
    const explanation = explainRoute("test-google-chat", {
      rules: {},
      defaultProvider: "",
      cachePath,
      network: "await",
    });
    work.push(plan, explanation);
    await started;
    await flushMicrotasks();

    // Discovery stays pending throughout the entire routing budget.
    jest.advanceTimersByTime(MISSING_LIST_WAIT_MS + 749);
    await flushMicrotasks();
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(MISSING_LIST_WAIT_MS + 750);
    expect(await plan).toMatchObject({ kind: "ok", primary: { provider: "antigravity" } });
    expect((await explanation).candidates).toContainEqual(
      expect.objectContaining({
        provider: "antigravity",
        outcome: "kept",
        availability: "unknown",
      })
    );
  } finally {
    releaseDiscovery({ kind: "failed", failure: { kind: "unreachable" } });
    await Promise.allSettled(work);
    jest.useRealTimers();
    credentials.accountIdentity = original.identity;
    credentials.describeReadiness = original.readiness;
    credentials.isAvailable = original.available;
    globalThis.fetch = original.fetch;
    registerModelDiscoveryFetcher("antigravity", original.fetcher);
    _resetAccountModelsListsForTest();
    invalidateModelDiscovery();
    _resetCatalogClient();
    for (const name of envNames) {
      const value = savedEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
