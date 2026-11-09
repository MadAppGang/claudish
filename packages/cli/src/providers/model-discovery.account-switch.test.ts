import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKeyCredentialProvider } from "../auth/credentials/api-key-credential.js";
import { credentials } from "../auth/credentials/authority.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import {
  _resetAccountModelsListsForTest,
  isPersistedListProvider,
} from "./dynamic-models-catalog.js";
import { providerServesModel } from "./model-availability.js";
import {
  discoverProviderModelsCatalog,
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  peekDiscoveredModels,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import "./model-discovery-builtins.js";
import { getProviderByName } from "./provider-definitions.js";

const realFetch = globalThis.fetch;
const originalProviders = ["devin", "minimax", "mistralai"].map((name) => credentials.get(name)!);
const originalDevinFetcher = getModelDiscoveryFetcher("devin-connect")!;
const envNames = [
  "CLAUDISH_CONFIG",
  "CLAUDISH_ACCOUNTS_DIR",
  "CLAUDISH_DYNAMIC_CATALOG_DIR",
  "CLAUDISH_DYNAMIC_CATALOG_KEY",
  "MISTRAL_API_KEY",
  "MISTRAL_BASE_URL",
  "MINIMAX_BASE_URL",
] as const;
let directory: string;
let savedEnv: Map<string, string | undefined>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "claudish-discovery-account-switch-"));
  savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.CLAUDISH_CONFIG = join(directory, "config.json");
  process.env.CLAUDISH_ACCOUNTS_DIR = join(directory, "accounts");
  process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = join(directory, "dynamic-models-catalog");
  process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = join(directory, "dynamic-models-catalog.key");
  delete process.env.MISTRAL_BASE_URL;
  delete process.env.MINIMAX_BASE_URL;
  invalidateModelDiscovery();
  _resetAccountModelsListsForTest();
  _setCatalogEntriesForTest([]);
  globalThis.fetch = mock(async () => {
    throw new Error("Unexpected network request");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const provider of originalProviders) credentials.register(provider);
  registerModelDiscoveryFetcher("devin-connect", originalDevinFetcher);
  invalidateModelDiscovery();
  _resetAccountModelsListsForTest();
  _resetCatalogClient();
  for (const name of envNames) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("model discovery account cache boundaries", () => {
  test("background availability cannot deny from the previous API key after invalidation", async () => {
    const def = getProviderByName("mistralai")!;
    const provider = new ApiKeyCredentialProvider({
      catalogName: def.name,
      envVar: def.apiKeyEnvVar,
      aliases: def.apiKeyAliases,
    });
    credentials.register(provider);
    process.env.MISTRAL_API_KEY = "offline-account-a";
    const requests: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      if (
        authorization !== "Bearer offline-account-a" &&
        authorization !== "Bearer offline-account-b"
      ) {
        throw new Error("Unexpected discovery credential");
      }
      requests.push(authorization);
      return Response.json({
        data: [{ id: authorization === "Bearer offline-account-a" ? "m-a" : "m-b" }],
      });
    }) as typeof fetch;
    expect(isPersistedListProvider("mistralai")).toBe(false);
    const initial = await discoverProviderModelsCatalog("mistralai");
    expect(initial.kind === "served" ? initial.models.map((model) => model.id) : []).toEqual([
      "m-a",
    ]);
    expect(await provider.accountIdentity()).toBe("key:offline-account-a");

    process.env.MISTRAL_API_KEY = "offline-account-b";
    const invalidation = spyOn(provider, "invalidate");
    try {
      credentials.invalidate("mistralai");
      expect(invalidation).toHaveBeenCalledTimes(1);
      expect(await provider.accountIdentity()).toBe("key:offline-account-b");
      const background = await providerServesModel("mistralai", "m-b", { network: "background" });
      const foreground = await providerServesModel("mistralai", "m-b");
      expect(foreground).toBe("serves");
      expect(requests).toContain("Bearer offline-account-b");
      expect(background).not.toBe("not-served");
    } finally {
      invalidation.mockRestore();
    }
  });

  test.each(["openrouter", "openai"])(
    "%s discovery without a descriptor never reads the account identity",
    async (provider) => {
      expect(getProviderByName(provider)?.modelDiscovery).toBeUndefined();
      const identity = spyOn(credentials, "accountIdentity").mockResolvedValue("offline-account-a");
      try {
        const outcome = await discoverProviderModelsCatalog(provider);
        expect({ outcome, identityReads: identity.mock.calls.length }).toEqual({
          outcome: { kind: "unsupported", reason: "no-descriptor" },
          identityReads: 0,
        });
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally {
        identity.mockRestore();
      }
    }
  );

  test.each(["minimax", "mistralai"])(
    "%s discovery cache hits do not read an identity for an unstored list",
    async (provider) => {
      expect(getProviderByName(provider)?.modelDiscovery).toBeDefined();
      expect(isPersistedListProvider(provider)).toBe(false);
      const accountIdentity = mock(async () => "offline-account-a");
      credentials.register({
        catalogName: provider,
        accountIdentity,
        isAvailable: async () => true,
        getRequestAuth: async () => ({ headers: { Authorization: "Bearer offline-account-a" } }),
      });
      const fetchStub = mock(async () => Response.json({ data: [{ id: "m-a" }] }));
      globalThis.fetch = fetchStub as unknown as typeof fetch;
      const initial = await discoverProviderModelsCatalog(provider);
      expect(initial.kind).toBe("served");
      expect(fetchStub).toHaveBeenCalledTimes(1);
      accountIdentity.mockClear();

      expect(await discoverProviderModelsCatalog(provider)).toEqual(initial);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(accountIdentity).not.toHaveBeenCalled();
    }
  );

  test("discovery does not cache an answer when a defined account identity changes during fetch", async () => {
    let identity: string | undefined = "offline-account-a";
    credentials.register({
      catalogName: "devin",
      accountIdentity: async () => identity,
      isAvailable: async () => true,
      getRequestAuth: async () => {
        throw new Error("Unexpected credential signing");
      },
    });
    let fetcherCalls = 0;
    registerModelDiscoveryFetcher("devin-connect", async () => {
      fetcherCalls++;
      const id = identity === "offline-account-a" ? "m-a" : "m-b";
      identity = "offline-account-b";
      return { kind: "models", models: [{ id }] };
    });
    expect(isPersistedListProvider("devin")).toBe(true);
    const first = await discoverProviderModelsCatalog("devin");
    expect(first.kind).toBe("served");
    const heldAfterSwitch = peekDiscoveredModels("devin")?.map((model) => model.id);

    const second = await discoverProviderModelsCatalog("devin");
    expect({
      heldAfterSwitch,
      fetcherCalls,
      nextIds: second.kind === "served" ? second.models.map((model) => model.id) : [],
    }).toEqual({ heldAfterSwitch: undefined, fetcherCalls: 2, nextIds: ["m-b"] });
  });

  test("discovery caches the first identity established by its fetch under the new identity", async () => {
    let identity: string | undefined;
    credentials.register({
      catalogName: "devin",
      accountIdentity: async () => identity,
      isAvailable: async () => true,
      getRequestAuth: async () => {
        throw new Error("Unexpected credential signing");
      },
    });
    let fetcherCalls = 0;
    registerModelDiscoveryFetcher("devin-connect", async () => {
      fetcherCalls++;
      identity = "offline-account-b";
      return { kind: "models", models: [{ id: "m-b" }] };
    });
    const initial = await discoverProviderModelsCatalog("devin");
    expect(initial.kind).toBe("served");
    expect(fetcherCalls).toBe(1);

    const next = await discoverProviderModelsCatalog("devin");
    expect(next).toEqual(initial);
    expect(fetcherCalls).toBe(1);
  });
});
