import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "../auth/credentials/authority.js";
import * as logger from "../logger.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import {
  type DiscoveredModel,
  type FetcherResult,
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import "./model-discovery-builtins.js";

const realLogger = { ...logger };
const lines: string[] = [];
const capture = (...args: unknown[]) => {
  lines.push(args.map(String).join(" "));
};
mock.module("../logger.js", () => ({ ...realLogger, log: capture, logStderr: capture }));
afterAll(() => {
  mock.module("../logger.js", () => realLogger);
});

const real = {
  identity: credentials.accountIdentity,
  readiness: credentials.describeReadiness,
  auth: credentials.getRequestAuth,
  devin: credentials.get("devin"),
  fetch: globalThis.fetch,
  fetcher: getModelDiscoveryFetcher("devin-connect"),
};
const models: DiscoveredModel[] = [
  {
    id: "swe-1-7-medium",
    displayName: "SWE-1.7",
    contextWindow: 200000,
    family: "swe-1-7",
    isFamilyDefault: true,
    reported: "chat",
  },
];
let home: string;
let identity: string | undefined;
let result: () => Promise<FetcherResult>;
let fetcher: ReturnType<typeof mock>;
let catalog: typeof import("./dynamic-models-catalog.js") | undefined;
let env: { dir?: string; key?: string };
const unsubscribers: Array<() => void> = [];
const options = () => ({
  dir: join(home, "dynamic-models-catalog"),
  keyPath: join(home, "dynamic-models-catalog.key"),
});
const loadCatalog = async () => {
  catalog = await import("./dynamic-models-catalog.js");
  catalog._resetAccountModelsListsForTest();
  return catalog;
};
const seed = async (age = 0) => {
  const store = await import("./dynamic-models-catalog-store.js");
  const key = store.deriveAccountKey("devin", identity, options());
  expect(key.ok).toBe(true);
  if (!key.ok) throw new Error(key.reason);
  expect(
    store.writeStoredModelsList("devin", key.accountKey, models, {
      ...options(),
      now: () => Date.now() - age,
    })
  ).toBe(true);
  return { store, key: key.accountKey };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudish-account-models-"));
  env = {
    dir: process.env.CLAUDISH_DYNAMIC_CATALOG_DIR,
    key: process.env.CLAUDISH_DYNAMIC_CATALOG_KEY,
  };
  process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = options().dir;
  process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = options().keyPath;
  identity = "A";
  lines.length = 0;
  _setCatalogEntriesForTest([]);
  invalidateModelDiscovery();
  credentials.accountIdentity = mock(async (provider: string) =>
    provider === "devin" ? identity : undefined
  );
  credentials.describeReadiness = mock(async (provider: string) => ({
    readiness: provider === "devin" && identity ? ("present" as const) : ("absent" as const),
  }));
  credentials.getRequestAuth = mock(async () => ({
    headers: { Authorization: "Bearer offline-test" },
  }));
  credentials.register({
    catalogName: "devin",
    isAvailable: async () => Boolean(identity),
    accountIdentity: async () => identity,
    getRequestAuth: async () => ({ headers: {} }),
    login: mock(async () => {}),
    logout: mock(async () => {}),
  });
  result = async () => ({ kind: "models", models });
  fetcher = mock(async () => result());
  registerModelDiscoveryFetcher("devin-connect", fetcher);
  globalThis.fetch = mock(async () => {
    throw new Error("Network forbidden");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  catalog?._resetAccountModelsListsForTest();
  catalog = undefined;
  invalidateModelDiscovery();
  _resetCatalogClient();
  if (real.identity) credentials.accountIdentity = real.identity;
  else Reflect.deleteProperty(credentials, "accountIdentity");
  credentials.describeReadiness = real.readiness;
  credentials.getRequestAuth = real.auth;
  if (real.devin) credentials.register(real.devin);
  if (real.fetcher) registerModelDiscoveryFetcher("devin-connect", real.fetcher);
  globalThis.fetch = real.fetch;
  if (env.dir === undefined) delete process.env.CLAUDISH_DYNAMIC_CATALOG_DIR;
  else process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = env.dir;
  if (env.key === undefined) delete process.env.CLAUDISH_DYNAMIC_CATALOG_KEY;
  else process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = env.key;
  rmSync(home, { recursive: true, force: true });
});

describe("account-bound dynamic models catalog", () => {
  test("16. provider rule", async () => {
    const { isPersistedListProvider } = await loadCatalog();
    for (const provider of [
      "devin",
      "antigravity",
      "grok-subscription",
      "sakana-subscription",
      "meta-muse-code",
    ]) {
      expect(isPersistedListProvider(provider)).toBe(true);
    }
    for (const provider of ["openrouter", "google", "kimi", "ollama", "lmstudio"]) {
      expect(isPersistedListProvider(provider)).toBe(false);
    }
  });

  test("17. write-through", async () => {
    const api = await loadCatalog();
    expect((await api.refreshAccountModelsList("devin", "picker-open", options())).kind).toBe(
      "refreshed"
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    api._resetAccountModelsListsForTest();
    invalidateModelDiscovery();
    expect(await api.readAccountModelsList("devin", options())).toMatchObject({
      models,
      age: "live",
      mayDeny: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("18. bound to the account", async () => {
    const api = await loadCatalog();
    await api.refreshAccountModelsList("devin", "picker-open", options());
    identity = "B";
    credentials.invalidate("devin");
    expect(await api.readAccountModelsList("devin", options())).toBeNull();
    identity = "A";
    credentials.invalidate("devin");
    expect(await api.readAccountModelsList("devin", options())).toMatchObject({ models });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("19. identity changed during the fetch", async () => {
    const api = await loadCatalog();
    result = async () => {
      identity = "B";
      return { kind: "models", models };
    };
    await api.refreshAccountModelsList("devin", "picker-open", options());
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const account of ["A", "B"]) {
      identity = account;
      api._resetAccountModelsListsForTest();
      invalidateModelDiscovery();
      expect(await api.readAccountModelsList("devin", options())).toBeNull();
    }
    expect(existsSync(join(options().dir, "devin.json"))).toBe(false);
  });

  test("20. failures keep disk", async () => {
    const api = await loadCatalog();
    const { store, key } = await seed(2 * 3600000);
    const path = join(options().dir, "devin.json");
    const before = readFileSync(path);
    for (const kind of [
      "unreachable",
      "http-error",
      "malformed",
      "incomplete",
      "empty-models-catalog",
    ] as const) {
      result = async () => ({ kind: "failed", failure: { kind } });
      invalidateModelDiscovery();
      const refreshed = await api.refreshAccountModelsList("devin", "availability", {
        ...options(),
        minAgeMs: 0,
      });
      expect(refreshed).toMatchObject({
        kind: "refreshed",
        outcome: { kind: "failed", failure: { kind } },
      });
      expect(readFileSync(path)).toEqual(before);
      expect(store.readStoredModelsList("devin", key, options())?.models).toEqual(models);
    }
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  test("21. unauthorized deletes", async () => {
    const api = await loadCatalog();
    await seed();
    const changed = mock(() => {});
    unsubscribers.push(api.onAccountModelsListChanged(changed));
    result = async () => ({ kind: "failed", failure: { kind: "unauthorized", status: 401 } });
    await api.refreshAccountModelsList("devin", "availability", { ...options(), minAgeMs: 0 });
    api._resetAccountModelsListsForTest();
    invalidateModelDiscovery();
    expect(await api.readAccountModelsList("devin", options())).toBeNull();
    expect(changed).toHaveBeenCalledWith("devin", null);
  });

  test("22. single flight", async () => {
    const api = await loadCatalog();
    let release!: (value: FetcherResult) => void;
    const pending = new Promise<FetcherResult>((resolve) => {
      release = resolve;
    });
    result = () => pending;
    const first = api.refreshAccountModelsList("devin", "picker-open", options());
    const second = api.refreshAccountModelsList("devin", "route-explicit", options());
    try {
      await Bun.sleep(10);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      release({ kind: "models", models });
    }
    expect((await first).kind).toBe("refreshed");
    expect((await second).kind).toBe("refreshed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("23. too recent across processes", async () => {
    const api = await loadCatalog();
    const { store } = await seed(60000);
    expect(
      await api.refreshAccountModelsList("devin", "picker-open", {
        ...options(),
        minAgeMs: store.LIVE_MS,
      })
    ).toEqual({ kind: "skipped", reason: "too-recent" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("24. no credential", async () => {
    const api = await loadCatalog();
    identity = undefined;
    expect(await api.refreshAccountModelsList("devin", "picker-open", options())).toEqual({
      kind: "skipped",
      reason: "no-credential",
    });
    expect(await api.readAccountModelsList("devin", options())).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(options().keyPath)).toBe(false);
  });

  test("25. login and logout forget", async () => {
    const api = await loadCatalog();
    for (const action of ["login", "logout"] as const) {
      await seed();
      await api.readAccountModelsList("devin", options());
      await credentials[action]("devin");
      expect(existsSync(join(options().dir, "devin.json"))).toBe(false);
      expect(await api.readAccountModelsList("devin", options())).toBeNull();
    }
  });

  test("26. change event", async () => {
    const api = await loadCatalog();
    const changed = mock(() => {});
    unsubscribers.push(api.onAccountModelsListChanged(changed));
    await api.refreshAccountModelsList("devin", "picker-open", options());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(
      "devin",
      expect.objectContaining({ provider: "devin", models, age: "live", mayDeny: true })
    );
  });

  test("27. nothing leaks to logs or disk", async () => {
    const api = await loadCatalog();
    const store = await import("./dynamic-models-catalog-store.js");
    identity = "sk-LEAK-7f3a";
    const derived = store.deriveAccountKey("devin", identity, options());
    expect(derived.ok).toBe(true);
    if (!derived.ok) throw new Error(derived.reason);
    await api.refreshAccountModelsList("devin", "picker-open", options());
    api._resetAccountModelsListsForTest();
    invalidateModelDiscovery();
    expect(await api.readAccountModelsList("devin", options())).toMatchObject({
      models,
      age: "live",
      mayDeny: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const line of lines) {
      expect(line).not.toContain(identity);
      expect(line).not.toContain(derived.accountKey);
    }
    const files = readdirSync(home, { recursive: true, withFileTypes: true }).filter((file) =>
      file.isFile()
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(join(file.parentPath, file.name), "utf8");
      expect(bytes).not.toContain(identity);
    }
  });

  test("28. sweep reads no 1Password", async () => {
    const api = await loadCatalog();
    api.sweepAccountModelsLists("route-bare", options());
    await Bun.sleep(20);
    const readiness = credentials.describeReadiness as ReturnType<typeof mock>;
    expect(readiness.mock.calls.length).toBeGreaterThan(0);
    const providers = (await import("./provider-definitions.js")).BUILTIN_PROVIDERS.filter(
      (provider) => api.isPersistedListProvider(provider.name)
    ).map((provider) => provider.name);
    for (const provider of providers) {
      expect(readiness).toHaveBeenCalledWith(
        provider,
        expect.objectContaining({ allowOpPrompt: false })
      );
    }
    for (const call of readiness.mock.calls) expect(call[1]?.allowOpPrompt).toBe(false);
  });
});
