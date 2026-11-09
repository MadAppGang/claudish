import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "../auth/credentials/authority.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import {
  _resetAccountModelsListsForTest,
  refreshAccountModelsList,
} from "./dynamic-models-catalog.js";
import { providerServesModel } from "./model-availability.js";
import {
  type FetcherResult,
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import "./model-discovery-builtins.js";

test("account B cannot be denied by account A's unfinished discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudish-account-refresh-"));
  const credentialPath = join(directory, "credential");
  const envNames = ["CLAUDISH_DYNAMIC_CATALOG_DIR", "CLAUDISH_DYNAMIC_CATALOG_KEY"] as const;
  const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  const originalProvider = credentials.get("devin")!;
  const originalFetcher = getModelDiscoveryFetcher("devin-connect")!;
  const originalFetch = globalThis.fetch;
  let releaseA!: (value: FetcherResult) => void;
  const discoveryA = new Promise<FetcherResult>((resolve) => {
    releaseA = resolve;
  });
  let signalStarted!: () => void;
  const startedA = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const work: Promise<unknown>[] = [];
  const forbiddenFetch = mock(async () => {
    throw new Error("Network forbidden");
  });

  try {
    process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = join(directory, "dynamic-models-catalog");
    process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = join(directory, "dynamic-models-catalog.key");
    writeFileSync(credentialPath, "account-a");
    credentials.register({
      catalogName: "devin",
      isAvailable: async () => true,
      accountIdentity: async () => readFileSync(credentialPath, "utf8"),
      getRequestAuth: async () => ({ headers: {} }),
    });
    globalThis.fetch = forbiddenFetch as unknown as typeof fetch;
    _resetAccountModelsListsForTest();
    invalidateModelDiscovery();
    _setCatalogEntriesForTest([]);
    registerModelDiscoveryFetcher("devin-connect", async () => {
      if (readFileSync(credentialPath, "utf8") === "account-a") {
        signalStarted();
        return discoveryA;
      }
      return { kind: "models", models: [{ id: "account-b-only", reported: "chat" }] };
    });
    const firstRefresh = refreshAccountModelsList("devin", "picker-open");
    work.push(firstRefresh);
    await startedA;

    writeFileSync(credentialPath, "account-b");
    const availabilityB = providerServesModel("devin", "account-b-only", { network: "await" });
    work.push(availabilityB);
    // Let B reach the refresh while A's discovery is still pending.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    releaseA({ kind: "models", models: [{ id: "account-a-only", reported: "chat" }] });
    const verdict = await availabilityB;
    await firstRefresh;

    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(verdict).not.toBe("not-served");
  } finally {
    releaseA({ kind: "failed", failure: { kind: "unreachable" } });
    await Promise.allSettled(work);
    credentials.register(originalProvider);
    registerModelDiscoveryFetcher("devin-connect", originalFetcher);
    globalThis.fetch = originalFetch;
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
