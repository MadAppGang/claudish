import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "../../auth/credentials/authority.js";
import { DevinCredentialProvider } from "../../auth/credentials/devin-credential.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../catalog-client.js";
import { deriveAccountKey, readStoredModelsList } from "../dynamic-models-catalog-store.js";
import {
  _resetAccountModelsListsForTest,
  readAccountModelsList,
  refreshAccountModelsList,
} from "../dynamic-models-catalog.js";
import { providerServesModel } from "../model-availability.js";
import {
  discoverProviderModelsCatalog,
  discoverProviderServedIds,
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "../model-discovery.js";
import "../model-discovery-builtins.js";
import {
  DEVIN_API_KEY_ENV,
  DEVIN_SERVER_URL_ENV,
  setDevinCredentialsPathForTesting,
} from "./devin-credentials.js";
import {
  MODEL_CONFIGS_PATH,
  TEAM_SETTINGS_PATH,
  _resetDevinModelCache,
  getServedDevinModels,
} from "./devin-models.js";
import { bytes, msg, vint } from "./proto-codec.js";

const KEY_A = "OPAQUE_TEST_ACCOUNT_A";
const KEY_B = "OPAQUE_TEST_ACCOUNT_B_NEW_LOGIN";
const realFetch = globalThis.fetch;
const originalProvider = credentials.get("devin")!;
const envNames = [
  DEVIN_API_KEY_ENV,
  DEVIN_SERVER_URL_ENV,
  "CLAUDISH_CONFIG",
  "CLAUDISH_ACCOUNTS_DIR",
  "CLAUDISH_DYNAMIC_CATALOG_DIR",
  "CLAUDISH_DYNAMIC_CATALOG_KEY",
] as const;
let directory: string;
let credentialPath: string;
let savedEnv: Map<string, string | undefined>;
let calls: Array<{ key: string; path: string }>;
let failB: boolean;

function replaceCredential(key: string): void {
  const next = join(directory, "next-credentials.toml");
  writeFileSync(next, `windsurf_api_key = "${key}"\n`);
  renameSync(next, credentialPath);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "claudish-devin-account-switch-"));
  credentialPath = join(directory, "credentials.toml");
  savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  delete process.env[DEVIN_API_KEY_ENV];
  delete process.env[DEVIN_SERVER_URL_ENV];
  process.env.CLAUDISH_CONFIG = join(directory, "config.json");
  process.env.CLAUDISH_ACCOUNTS_DIR = join(directory, "accounts");
  process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = join(directory, "dynamic-models-catalog");
  process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = join(directory, "dynamic-models-catalog.key");
  setDevinCredentialsPathForTesting(credentialPath);
  credentials.register(new DevinCredentialProvider());
  _resetDevinModelCache();
  _resetAccountModelsListsForTest();
  invalidateModelDiscovery();
  _setCatalogEntriesForTest([]);
  replaceCredential(KEY_A);
  calls = [];
  failB = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    const key = [KEY_A, KEY_B].find((value) => authorization === `Basic ${value}-${value}`);
    const path = new URL(String(input)).pathname;
    if (!key || (path !== MODEL_CONFIGS_PATH && path !== TEAM_SETTINGS_PATH)) {
      throw new Error("Unexpected discovery request");
    }
    calls.push({ key, path });
    if (key === KEY_B && failB) return new Response("unavailable", { status: 503 });
    const id = key === KEY_A ? "m-a" : "m-b";
    const body =
      path === MODEL_CONFIGS_PATH
        ? msg(bytes(1, msg(bytes(22, id), bytes(1, id), vint(18, 32_768))))
        : msg(bytes(7, id));
    return new Response(body);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  credentials.register(originalProvider);
  setDevinCredentialsPathForTesting(null);
  _resetDevinModelCache();
  _resetAccountModelsListsForTest();
  invalidateModelDiscovery();
  _resetCatalogClient();
  for (const name of envNames) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("Devin dynamic models catalog account switching", () => {
  test("a changed credential file fetches the new account's models within the cache TTL", async () => {
    expect((await getServedDevinModels()).map((model) => model.uid)).toEqual(["m-a"]);
    expect(calls.map((call) => call.key)).toEqual([KEY_A, KEY_A]);

    // An external login replaces the file without invalidating this process's caches.
    replaceCredential(KEY_B);
    const modelsB = await getServedDevinModels();

    expect(modelsB.map((model) => model.uid)).toEqual(["m-b"]);
    expect(
      calls
        .filter((call) => call.key === KEY_B)
        .map((call) => call.path)
        .sort()
    ).toEqual([MODEL_CONFIGS_PATH, TEAM_SETTINGS_PATH].sort());
  });

  test("removing the credential returns no models even while the old cache is live", async () => {
    expect((await getServedDevinModels()).map((model) => model.uid)).toEqual(["m-a"]);
    expect(calls).toHaveLength(2);
    rmSync(credentialPath);

    expect(await getServedDevinModels()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  for (const surface of ["models catalog", "served ids"] as const) {
    test(`generic discovery ${surface} refetches after an external Devin account switch`, async () => {
      const originalFetcher = getModelDiscoveryFetcher("devin-connect")!;
      let fetcherCalls = 0;
      registerModelDiscoveryFetcher("devin-connect", async (provider) => {
        fetcherCalls++;
        return originalFetcher(provider);
      });
      try {
        const discover = async () => {
          if (surface === "served ids") {
            return (await discoverProviderServedIds("devin")).served.map((model) => model.id);
          }
          const outcome = await discoverProviderModelsCatalog("devin");
          expect(outcome.kind).toBe("served");
          return outcome.kind === "served" ? outcome.models.map((model) => model.id) : [];
        };
        expect(await discover()).toEqual(["m-a"]);
        expect(fetcherCalls).toBe(1);
        const identityA = await credentials.accountIdentity("devin");
        replaceCredential(KEY_B);
        expect(await credentials.accountIdentity("devin")).not.toBe(identityA);

        const ids = await discover();
        expect({
          ids,
          fetcherCalls,
          requestsB: calls
            .filter((call) => call.key === KEY_B)
            .map((call) => call.path)
            .sort(),
        }).toEqual({
          ids: ["m-b"],
          fetcherCalls: 2,
          requestsB: [MODEL_CONFIGS_PATH, TEAM_SETTINGS_PATH].sort(),
        });
      } finally {
        registerModelDiscoveryFetcher("devin-connect", originalFetcher);
      }
    });
  }

  test("refresh stores only the new account's models under its account key", async () => {
    const bindingA = deriveAccountKey("devin", await credentials.accountIdentity("devin"));
    if (!bindingA.ok) throw new Error(bindingA.reason);
    const refreshedA = await refreshAccountModelsList("devin", "picker-open");
    expect(refreshedA).toMatchObject({ kind: "refreshed", outcome: { kind: "served" } });
    expect(
      readStoredModelsList("devin", bindingA.accountKey)?.models.map((model) => model.id)
    ).toEqual(["m-a"]);

    replaceCredential(KEY_B);
    const bindingB = deriveAccountKey("devin", await credentials.accountIdentity("devin"));
    if (!bindingB.ok) throw new Error(bindingB.reason);
    expect(bindingB.accountKey).not.toBe(bindingA.accountKey);
    const refreshedB = await refreshAccountModelsList("devin", "picker-open");
    expect(refreshedB).toMatchObject({ kind: "refreshed", outcome: { kind: "served" } });

    // Discard the outer memory so the subsequent read proves the persisted write.
    _resetAccountModelsListsForTest();
    invalidateModelDiscovery();
    const storedB = readStoredModelsList("devin", bindingB.accountKey);
    const readB = await readAccountModelsList("devin");
    const availabilityB = await providerServesModel("devin", "m-b", { network: "await" });
    const availabilityA = await providerServesModel("devin", "m-a", { network: "await" });

    expect({
      storedIds: storedB?.models.map((model) => model.id),
      readIds: readB?.models.map((model) => model.id),
      mayDeny: readB?.mayDeny,
      availabilityB,
      availabilityA,
    }).toEqual({
      storedIds: ["m-b"],
      readIds: ["m-b"],
      mayDeny: true,
      availabilityB: "serves",
      availabilityA: "not-served",
    });
  });

  test("a failed fetch for the new account never returns the previous account's models", async () => {
    expect((await getServedDevinModels()).map((model) => model.uid)).toEqual(["m-a"]);
    replaceCredential(KEY_B);
    failB = true;

    const modelsB = await getServedDevinModels({ force: true });

    expect(
      calls
        .filter((call) => call.key === KEY_B)
        .map((call) => call.path)
        .sort()
    ).toEqual([MODEL_CONFIGS_PATH, TEAM_SETTINGS_PATH].sort());
    expect(modelsB.map((model) => model.uid)).toEqual([]);
  });
});
