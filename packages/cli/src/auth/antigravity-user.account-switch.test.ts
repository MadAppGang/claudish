import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../providers/catalog-client.js";
import {
  deriveAccountKey,
  writeStoredModelsList,
} from "../providers/dynamic-models-catalog-store.js";
import {
  _resetAccountModelsListsForTest,
  readAccountModelsList,
} from "../providers/dynamic-models-catalog.js";
import { providerServesModel } from "../providers/model-availability.js";
import {
  discoverProviderModelsCatalog,
  discoverProviderServedIds,
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "../providers/model-discovery.js";
import { credentials } from "./credentials/authority.js";
import "../providers/model-discovery-builtins.js";
import { _resetAgyClientVersion } from "./antigravity-client-version.js";
import {
  type AntigravityToken,
  type AntigravityTokenDeps,
  _resetAntigravityTokenState,
  antigravityTokenLineageMaterial,
  currentAntigravityTokenLineage,
  deleteSharedAntigravityToken,
  getValidAntigravityAccessToken,
  readSharedAntigravityToken,
} from "./antigravity-token.js";
import {
  _resetAntigravityServedModelsCache,
  antigravityHost,
  getAntigravityTierDisplayName,
  getAntigravityTierFullName,
  getServedAntigravityModels,
  peekServedAntigravityModels,
  resetAntigravityUserCache,
  setupAntigravityUser,
} from "./antigravity-user.js";

const realFetch = globalThis.fetch;
const originalProvider = credentials.get("antigravity")!;
const originalFetcher = getModelDiscoveryFetcher("antigravity")!;
const NOW = Date.parse("2026-11-06T12:00:00Z");
const envNames = [
  "CLAUDISH_CONFIG",
  "CLAUDISH_ACCOUNTS_DIR",
  "CLAUDISH_DYNAMIC_CATALOG_DIR",
  "CLAUDISH_DYNAMIC_CATALOG_KEY",
] as const;
let directory: string;
let savedEnv: Map<string, string | undefined>;
let store: string | null;
let deps: AntigravityTokenDeps;
let calls: Array<{ account: string; action: string; project?: string }>;
let modelIds: Record<string, string>;

function encodedAccount(
  account: string,
  withRefreshToken = true,
  overrides: Partial<AntigravityToken> = {}
): string {
  return (
    "go-keyring-base64:" +
    Buffer.from(
      JSON.stringify({
        token: {
          access_token: `offline-access-${account}`,
          ...(withRefreshToken ? { refresh_token: `offline-lineage-${account}` } : {}),
          token_type: "Bearer",
          expiry: new Date(NOW + 3_600_000).toISOString(),
          ...overrides,
        },
      })
    ).toString("base64")
  );
}

function resetState(): void {
  _resetAgyClientVersion();
  _resetAntigravityTokenState();
  resetAntigravityUserCache();
  _resetAntigravityServedModelsCache();
  _resetAccountModelsListsForTest();
  invalidateModelDiscovery();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "claudish-antigravity-account-switch-"));
  savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.CLAUDISH_CONFIG = join(directory, "config.json");
  process.env.CLAUDISH_ACCOUNTS_DIR = join(directory, "accounts");
  process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = join(directory, "dynamic-models-catalog");
  process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = join(directory, "dynamic-models-catalog.key");
  resetState();
  _setCatalogEntriesForTest([]);
  store = encodedAccount("a");
  deps = {
    readStore: () => store,
    writeStore: () => {
      throw new Error("Unexpected token write");
    },
    deleteStore: () => {
      store = null;
    },
    runAgyRefresh: () => {
      throw new Error("Unexpected token refresh");
    },
    readAgyVersion: () => "1.3.5",
    now: () => NOW,
  };
  // Only the identity read is needed; signing must never reach the real store.
  credentials.register({
    catalogName: "antigravity",
    accountIdentity: async () => {
      const token = readSharedAntigravityToken(deps);
      const lineage = token ? antigravityTokenLineageMaterial(token) : undefined;
      return lineage ? `${lineage}\n${antigravityHost()}` : undefined;
    },
    isAvailable: async () => store !== null,
    getRequestAuth: async () => {
      throw new Error("Unexpected credential signing");
    },
  });
  calls = [];
  modelIds = { a: "m-a", b: "m-b" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("Authorization");
    const account = ["a", "b"].find((id) => authorization === `Bearer offline-access-${id}`);
    const action = new URL(String(input)).pathname.split(":").at(-1);
    if (!account || (action !== "loadCodeAssist" && action !== "fetchAvailableModels")) {
      throw new Error("Unexpected Antigravity request");
    }
    const body = JSON.parse(String(init?.body));
    calls.push({ account, action, project: body.project });
    if (action === "loadCodeAssist") {
      return Response.json({
        cloudaicompanionProject: `project-${account}`,
        paidTier: { id: `tier-${account}`, name: `Account ${account}` },
      });
    }
    if (body.project !== `project-${account}`) {
      return new Response("wrong account project", { status: 403 });
    }
    const id = modelIds[account]!;
    return Response.json({
      models: { [id]: {} },
      defaultAgentModelId: id,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  credentials.register(originalProvider);
  registerModelDiscoveryFetcher("antigravity", originalFetcher);
  resetState();
  _resetCatalogClient();
  for (const name of envNames) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

async function warmAccountA(): Promise<void> {
  const accessToken = await getValidAntigravityAccessToken(deps);
  expect(accessToken).toBe("offline-access-a");
  const setup = await setupAntigravityUser(accessToken);
  expect(setup).toEqual({ projectId: "project-a", tierId: "tier-a" });
  const models = await getServedAntigravityModels(accessToken, setup.projectId);
  expect(models.servedIds).toEqual([modelIds.a!]);
  expect(peekServedAntigravityModels()?.servedIds).toEqual([modelIds.a!]);
}

async function storeAccountBModels(): Promise<void> {
  store = encodedAccount("b");
  const binding = deriveAccountKey("antigravity", await credentials.accountIdentity("antigravity"));
  if (!binding.ok) throw new Error(binding.reason);
  expect(writeStoredModelsList("antigravity", binding.accountKey, [{ id: modelIds.b! }])).toBe(
    true
  );
  const list = await readAccountModelsList("antigravity");
  expect(list?.models.map((model) => model.id)).toEqual([modelIds.b!]);
  expect(list?.mayDeny).toBe(true);
}

function holdAccountAResponse(action: string): { started: Promise<void>; release: () => void } {
  const fetchResponse = globalThis.fetch;
  let announce!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchResponse(input, init);
    if (
      !held &&
      new Headers(init?.headers).get("Authorization") === "Bearer offline-access-a" &&
      new URL(String(input)).pathname.endsWith(`:${action}`)
    ) {
      held = true;
      announce();
      await gate;
    }
    return response;
  }) as typeof fetch;
  return { started, release };
}

describe("Antigravity dynamic models catalog account switching", () => {
  test("a new stored token lineage replaces the cached project, tier and models", async () => {
    await warmAccountA();
    // A different process changes the store; the client version stays the same.
    store = encodedAccount("b");
    const accessToken = await getValidAntigravityAccessToken(deps);
    expect(accessToken).toBe("offline-access-b");

    const setup = await setupAntigravityUser(accessToken);
    const models = await getServedAntigravityModels(accessToken, setup.projectId);

    expect({ ...setup, servedIds: models.servedIds, defaultId: models.defaultId }).toEqual({
      projectId: "project-b",
      tierId: "tier-b",
      servedIds: ["m-b"],
      defaultId: "m-b",
    });
    expect(calls.filter((call) => call.account === "b")).toEqual([
      { account: "b", action: "loadCodeAssist", project: undefined },
      { account: "b", action: "fetchAvailableModels", project: "project-b" },
    ]);
  });

  test("the cache peek is empty immediately after a new token is issued, before setup", async () => {
    await warmAccountA();
    store = encodedAccount("b");
    expect(await getValidAntigravityAccessToken(deps)).toBe("offline-access-b");

    expect(peekServedAntigravityModels()).toBeNull();
    expect(calls.filter((call) => call.account === "b")).toEqual([]);
  });

  test("a served read after a lineage change fetches the new account without setup", async () => {
    await warmAccountA();
    store = encodedAccount("b");
    const accessToken = await getValidAntigravityAccessToken(deps);

    const models = await getServedAntigravityModels(accessToken, "project-b");

    expect({ servedIds: models.servedIds, defaultId: models.defaultId }).toEqual({
      servedIds: ["m-b"],
      defaultId: "m-b",
    });
    expect(calls.filter((call) => call.account === "b")).toEqual([
      { account: "b", action: "fetchAvailableModels", project: "project-b" },
    ]);
  });

  test("a shared-token identity read hides the previous account's cached models without issuing a token", async () => {
    modelIds = { a: "gemini-switch-high", b: "gemini-switch-low" };
    await warmAccountA();
    const issuedA = currentAntigravityTokenLineage();
    await storeAccountBModels();

    expect(peekServedAntigravityModels()).toBeNull();
    expect(calls.filter((call) => call.account === "b")).toEqual([]);
    expect(issuedA).not.toBeNull();
  });

  test("availability resolves a family against the stored account's models after an external login", async () => {
    modelIds = { a: "gemini-switch-high", b: "gemini-switch-low" };
    await warmAccountA();
    await storeAccountBModels();

    expect(await providerServesModel("antigravity", "gemini-switch")).toBe("serves");
    expect(calls.filter((call) => call.account === "b")).toEqual([]);
  });

  for (const logout of ["delete", "reset"] as const) {
    test(`the cache peek is empty after shared-token logout via ${logout}`, async () => {
      await warmAccountA();
      if (logout === "delete") deleteSharedAntigravityToken(deps);
      else {
        store = null;
        _resetAntigravityTokenState();
      }
      expect(readSharedAntigravityToken(deps)).toBeNull();

      expect(peekServedAntigravityModels()).toBeNull();
    });
  }

  test("access-only token records have distinct lineages and do not share project, tier or models", async () => {
    store = encodedAccount("a", false);
    await warmAccountA();
    const lineageA = currentAntigravityTokenLineage();
    store = encodedAccount("b", false);
    const accessToken = await getValidAntigravityAccessToken(deps);
    const lineageB = currentAntigravityTokenLineage();
    expect(accessToken).toBe("offline-access-b");
    expect(lineageA).not.toBeNull();
    expect(lineageB).not.toBeNull();

    const setup = await setupAntigravityUser(accessToken);
    const models = await getServedAntigravityModels(accessToken, setup.projectId);

    expect({
      sameLineage: lineageA === lineageB,
      ...setup,
      servedIds: models.servedIds,
      defaultId: models.defaultId,
    }).toEqual({
      sameLineage: false,
      projectId: "project-b",
      tierId: "tier-b",
      servedIds: ["m-b"],
      defaultId: "m-b",
    });
  });

  test("a late served-model response from the old account cannot replace the new account's cache", async () => {
    const accessA = await getValidAntigravityAccessToken(deps);
    const setupA = await setupAntigravityUser(accessA);
    const deferred = holdAccountAResponse("fetchAvailableModels");
    const pendingA = getServedAntigravityModels(accessA, setupA.projectId);
    try {
      await deferred.started;
      store = encodedAccount("b");
      const accessB = await getValidAntigravityAccessToken(deps);
      const setupB = await setupAntigravityUser(accessB);
      expect((await getServedAntigravityModels(accessB, setupB.projectId)).servedIds).toEqual([
        "m-b",
      ]);
      deferred.release();
      await pendingA;

      const laterB = await getServedAntigravityModels(accessB, setupB.projectId);
      expect({
        servedIds: laterB.servedIds,
        defaultId: laterB.defaultId,
        peek: peekServedAntigravityModels()?.servedIds,
      }).toEqual({ servedIds: ["m-b"], defaultId: "m-b", peek: ["m-b"] });
    } finally {
      deferred.release();
      await pendingA;
    }
  });

  test("a late setup response from the old account cannot replace the new account's project or tier", async () => {
    const accessA = await getValidAntigravityAccessToken(deps);
    const deferred = holdAccountAResponse("loadCodeAssist");
    const pendingA = setupAntigravityUser(accessA);
    try {
      await deferred.started;
      store = encodedAccount("b");
      const accessB = await getValidAntigravityAccessToken(deps);
      expect(await setupAntigravityUser(accessB)).toEqual({
        projectId: "project-b",
        tierId: "tier-b",
      });
      expect((await getServedAntigravityModels(accessB, "project-b")).servedIds).toEqual(["m-b"]);
      deferred.release();
      await pendingA;

      const laterSetupB = await setupAntigravityUser(accessB);
      const laterB = await getServedAntigravityModels(accessB, laterSetupB.projectId);
      expect({
        ...laterSetupB,
        fullTier: getAntigravityTierFullName(),
        servedIds: laterB.servedIds,
        peek: peekServedAntigravityModels()?.servedIds,
      }).toEqual({
        projectId: "project-b",
        tierId: "tier-b",
        fullTier: "Account b",
        servedIds: ["m-b"],
        peek: ["m-b"],
      });
    } finally {
      deferred.release();
      await pendingA;
    }
  });

  test("a delayed setup followed by discovery cannot cache the old token's models for the new account", async () => {
    const accessA = await getValidAntigravityAccessToken(deps);
    const deferred = holdAccountAResponse("loadCodeAssist");
    const pendingA = (async () => {
      const setupA = await setupAntigravityUser(accessA);
      return getServedAntigravityModels(accessA, setupA.projectId);
    })();
    try {
      await deferred.started;
      store = encodedAccount("b");
      expect(readSharedAntigravityToken(deps)?.access_token).toBe("offline-access-b");
      const lineageB = currentAntigravityTokenLineage();
      const accessB = await getValidAntigravityAccessToken(deps);
      expect(await setupAntigravityUser(accessB)).toEqual({
        projectId: "project-b",
        tierId: "tier-b",
      });
      deferred.release();
      await pendingA;

      const peekAfterA = peekServedAntigravityModels();
      const setupB = await setupAntigravityUser(accessB);
      const laterB = await getServedAntigravityModels(accessB, setupB.projectId);
      expect({
        ...setupB,
        servedIds: laterB.servedIds,
        defaultId: laterB.defaultId,
        peekContainsA: peekAfterA?.servedIds.includes("m-a") ?? false,
        peek: peekServedAntigravityModels()?.servedIds,
        sameLineage: currentAntigravityTokenLineage() === lineageB,
        discoveryProjectsB: calls
          .filter((call) => call.account === "b" && call.action === "fetchAvailableModels")
          .map((call) => call.project),
      }).toEqual({
        projectId: "project-b",
        tierId: "tier-b",
        servedIds: ["m-b"],
        defaultId: "m-b",
        peekContainsA: false,
        peek: ["m-b"],
        sameLineage: true,
        discoveryProjectsB: ["project-b"],
      });
    } finally {
      deferred.release();
      await pendingA;
    }
  });

  test("an empty shared-store read during token resolution clears the previous account's cached models", async () => {
    await warmAccountA();
    store = null;

    await expect(getValidAntigravityAccessToken(deps)).rejects.toThrow(
      "No Antigravity session found"
    );

    expect({
      lineage: currentAntigravityTokenLineage(),
      peek: peekServedAntigravityModels(),
    }).toEqual({ lineage: null, peek: null });
  });

  test("an unusable token left by refresh moves the observed lineage away from the previous account", async () => {
    await warmAccountA();
    const lineageA = currentAntigravityTokenLineage();
    store = encodedAccount("a", true, { expiry: new Date(NOW - 60_000).toISOString() });
    let refreshes = 0;
    deps.runAgyRefresh = () => {
      refreshes++;
      store = encodedAccount("b", true, { expiry: new Date(NOW - 60_000).toISOString() });
      return { kind: "ran" };
    };

    await expect(getValidAntigravityAccessToken(deps)).rejects.toThrow(
      "without producing a valid token"
    );

    expect({
      refreshes,
      sameLineage: currentAntigravityTokenLineage() === lineageA,
      peek: peekServedAntigravityModels(),
    }).toEqual({ refreshes: 1, sameLineage: false, peek: null });
  });

  test("same-refresh-token renewal reuses setup and discovery caches without extra calls", async () => {
    let fetcherCalls = 0;
    registerModelDiscoveryFetcher("antigravity", async () => {
      fetcherCalls++;
      const accessToken = await getValidAntigravityAccessToken(deps);
      const { projectId } = await setupAntigravityUser(accessToken);
      const models = await getServedAntigravityModels(accessToken, projectId);
      return { kind: "models", models: models.servedIds.map((id) => ({ id })) };
    });
    const initial = await discoverProviderModelsCatalog("antigravity");
    expect(initial.kind).toBe("served");
    expect(calls.map((call) => call.action)).toEqual(["loadCodeAssist", "fetchAvailableModels"]);
    const lineage = currentAntigravityTokenLineage();
    const identity = await credentials.accountIdentity("antigravity");
    store = encodedAccount("a", true, { access_token: "offline-access-a-renewed" });

    const renewed = await getValidAntigravityAccessToken(deps);
    expect(renewed).toBe("offline-access-a-renewed");
    expect(currentAntigravityTokenLineage()).toBe(lineage);
    expect(await credentials.accountIdentity("antigravity")).toBe(identity);
    const setup = await setupAntigravityUser(renewed);
    expect(setup).toEqual({ projectId: "project-a", tierId: "tier-a" });
    expect((await getServedAntigravityModels(renewed, setup.projectId)).servedIds).toEqual(["m-a"]);
    expect(await discoverProviderModelsCatalog("antigravity")).toEqual(initial);
    expect(fetcherCalls).toBe(1);
    expect(calls.map((call) => call.action)).toEqual(["loadCodeAssist", "fetchAvailableModels"]);
  });

  for (const [label, readTier] of [
    ["display", getAntigravityTierDisplayName],
    ["full", getAntigravityTierFullName],
  ] as const) {
    test(`the ${label} tier getter hides the old account's tier before new setup`, async () => {
      await warmAccountA();
      expect(readTier()).toBe("Account a");
      store = encodedAccount("b");
      await getValidAntigravityAccessToken(deps);

      expect(readTier()).toBe("Antigravity");
      expect(calls.filter((call) => call.account === "b")).toEqual([]);
    });
  }

  for (const surface of ["models catalog", "served ids"] as const) {
    test(`generic discovery ${surface} refetches after an external Antigravity account switch`, async () => {
      let fetcherCalls = 0;
      registerModelDiscoveryFetcher("antigravity", async () => {
        fetcherCalls++;
        const accessToken = await getValidAntigravityAccessToken(deps);
        const { projectId } = await setupAntigravityUser(accessToken);
        const models = await getServedAntigravityModels(accessToken, projectId);
        return { kind: "models", models: models.servedIds.map((id) => ({ id })) };
      });
      const discover = async () => {
        if (surface === "served ids") {
          return (await discoverProviderServedIds("antigravity")).served.map((model) => model.id);
        }
        const outcome = await discoverProviderModelsCatalog("antigravity");
        expect(outcome.kind).toBe("served");
        return outcome.kind === "served" ? outcome.models.map((model) => model.id) : [];
      };
      expect(await discover()).toEqual(["m-a"]);
      expect(fetcherCalls).toBe(1);
      store = encodedAccount("b");

      const ids = await discover();
      expect({
        ids,
        fetcherCalls,
        requestsB: calls.filter((call) => call.account === "b").map((call) => call.action),
      }).toEqual({
        ids: ["m-b"],
        fetcherCalls: 2,
        requestsB: ["loadCodeAssist", "fetchAvailableModels"],
      });
    });
  }
});
