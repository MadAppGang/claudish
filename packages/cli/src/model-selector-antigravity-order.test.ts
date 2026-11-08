import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { _resetAgyClientVersion } from "./auth/antigravity-client-version.js";
import * as tokenModule from "./auth/antigravity-token.js";
import type { AntigravityTokenDeps } from "./auth/antigravity-token.js";
import {
  _resetAntigravityServedModelsCache,
  resetAntigravityUserCache,
} from "./auth/antigravity-user.js";
import { credentials } from "./auth/credentials/authority.js";
import { buildDiscoveredModelOutcome } from "./model-selector.js";
import type { CatalogClient } from "./providers/model-catalog.js";
import {
  type DiscoveredModel,
  discoverProviderModelsCatalog,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./providers/model-discovery.js";
import type { ProviderDefinition } from "./providers/provider-definitions.js";
import { clearRuntimeRegistry, registerRuntimeProvider } from "./providers/runtime-providers.js";
import { _clearChatCapabilityIndex } from "./providers/transport/probe-discovery.js";

const capture = JSON.parse(
  readFileSync(
    new URL("./auth/fixtures/antigravity-fetchAvailableModels-1.3.5.json", import.meta.url),
    "utf8"
  )
);
const agentIds: string[] = capture.agentModelSorts[0].groups[0].modelIds;
const realFetch = globalThis.fetch;
const realGetToken = tokenModule.getValidAntigravityAccessToken;
const realGetRequestAuth = credentials.getRequestAuth;
let tokenSpy: ReturnType<typeof spyOn> | undefined;
const NOW = Date.parse("2026-10-14T00:00:00Z");
const deps: AntigravityTokenDeps = {
  readStore: () =>
    "go-keyring-base64:" +
    Buffer.from(
      JSON.stringify({
        token: {
          access_token: "offline-discovery-token",
          token_type: "Bearer",
          refresh_token: "offline-refresh",
          expiry: new Date(NOW + 3_600_000).toISOString(),
        },
      })
    ).toString("base64"),
  writeStore: () => {
    throw new Error("Unexpected token write");
  },
  deleteStore: () => {
    throw new Error("Unexpected token deletion");
  },
  runAgyRefresh: () => {
    throw new Error("Unexpected agy refresh");
  },
  readAgyVersion: () => "1.3.5",
  now: () => NOW,
};
const catalog: CatalogClient = {
  async modelsByVendor() {
    return [];
  },
  async vendorsForModel() {
    return null;
  },
  async searchModels() {
    return [];
  },
  servedByVendor() {
    return [];
  },
};

function resetState(): void {
  _resetAgyClientVersion();
  _resetAntigravityServedModelsCache();
  resetAntigravityUserCache();
  tokenModule._resetAntigravityTokenState();
  invalidateModelDiscovery();
  _clearChatCapabilityIndex();
  clearRuntimeRegistry();
}

beforeEach(() => {
  resetState();
  // Substitute only the token dependency boundary. The registered production
  // fetchAntigravityModelsCatalog still performs setup, parsing and exclusions.
  tokenSpy = spyOn(tokenModule, "getValidAntigravityAccessToken").mockImplementation(() =>
    realGetToken(deps)
  );
  credentials.getRequestAuth = mock(async () => ({
    headers: { Authorization: "Bearer offline-discovery-token" },
  }));
  globalThis.fetch = mock(async () => {
    throw new Error("Unexpected network request");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  tokenSpy?.mockRestore();
  tokenSpy = undefined;
  credentials.getRequestAuth = realGetRequestAuth;
  globalThis.fetch = realFetch;
  resetState();
});

function stubAntigravityFetch() {
  const fetchStub = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("User-Agent")).toStartWith("antigravity/cli/1.3.5 ");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer offline-discovery-token");
    const url = String(input);
    if (url.endsWith("/v1internal:loadCodeAssist")) {
      return Response.json({
        currentTier: "offline-tier",
        cloudaicompanionProject: "offline-project",
      });
    }
    if (url.endsWith("/v1internal:fetchAvailableModels")) {
      expect(JSON.parse(String(init?.body))).toEqual({ project: "offline-project" });
      return Response.json(capture);
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  });
  globalThis.fetch = fetchStub as unknown as typeof fetch;
  return fetchStub;
}

const PROVIDER = "test-antigravity-picker-order";
const FORMAT = "test-antigravity-picker-order-format";
function discoverForPicker(models: DiscoveredModel[]): void {
  const definition: ProviderDefinition = {
    name: PROVIDER,
    displayName: "Offline picker order",
    transport: "openai",
    baseUrl: "https://picker-order.invalid",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OFFLINE_PICKER_ORDER_KEY",
    apiKeyDescription: "Offline only",
    apiKeyUrl: "https://picker-order.invalid/key",
    shortcuts: [],
    legacyPrefixes: [],
    modelDiscovery: { path: "", format: FORMAT as "ollama-tags" },
    createHandler: { kind: "none", reason: "virtual", note: "Offline test" },
    isDirectApi: true,
  };
  registerRuntimeProvider(definition);
  registerModelDiscoveryFetcher(FORMAT, async () => ({
    kind: "models",
    models,
    endpoint: "https://picker-order.invalid/models",
  }));
}

describe("Antigravity discovery and picker order", () => {
  test("B9: production discovery places all 13 agy ids but retains other selectable ids for routing", async () => {
    const fetchStub = stubAntigravityFetch();
    const result = await discoverProviderModelsCatalog("antigravity");
    expect(result.kind).toBe("served");
    if (result.kind !== "served") throw new Error(JSON.stringify(result));
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(agentIds).toHaveLength(13);
    expect(
      result.models
        .filter((m) => typeof m.providerOrder === "number")
        .map((m) => [m.id, m.providerOrder])
    ).toEqual(agentIds.map((id, index) => [id, index]));
    const older = result.models.find((m) => m.id === "gemini-2.5-pro");
    expect(older).toBeDefined();
    expect(older).not.toHaveProperty("providerOrder");
    const unplaced = result.models.filter((m) => !agentIds.includes(m.id));
    expect(unplaced.length).toBeGreaterThan(0);
    for (const model of unplaced) expect(model).not.toHaveProperty("providerOrder");
    expect(result.models.some((m) => /^(chat_|tab_)/.test(m.id))).toBe(false);
    expect(result.models.map((m) => m.id)).not.toContain("gemini-3.1-flash-image");
    // Check every captured internal id individually; an empty list cannot pass.
    for (const id of Object.keys(capture.models).filter((id) => /^(chat_|tab_)/.test(id))) {
      expect(result.models.map((m) => m.id)).not.toContain(id);
    }
  });

  test("B10: real Antigravity picker shows exactly the 13 published ids in order", async () => {
    stubAntigravityFetch();
    const result = await buildDiscoveredModelOutcome("antigravity", "Antigravity", catalog);
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error(JSON.stringify(result));
    expect(result.rows.map((r) => r.id)).toEqual(agentIds);
    expect(result.providerOrdered).toBe(true);
    expect(result.servedCount).toBeGreaterThan(result.rows.length);
  });

  test("B10: shuffled mixed discovery uses only placed rows, ordered by providerOrder", async () => {
    discoverForPicker([
      {
        id: "offline-newest-unplaced",
        releaseDate: "2026-10-14",
        reported: "chat",
        ignoreCatalogReleaseDate: true,
      },
      {
        id: "offline-placed-second",
        providerOrder: 1,
        releaseDate: "2026-10-10",
        reported: "chat",
        ignoreCatalogReleaseDate: true,
      },
      {
        id: "offline-placed-first",
        providerOrder: 0,
        releaseDate: "2026-01-01",
        reported: "chat",
        ignoreCatalogReleaseDate: true,
      },
    ]);
    const result = await buildDiscoveredModelOutcome(PROVIDER, "Offline picker order", catalog);
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error(JSON.stringify(result));
    expect(result.rows.map((r) => r.id)).toEqual(["offline-placed-first", "offline-placed-second"]);
    expect(result.providerOrdered).toBe(true);
  });

  test("B10: no providerOrder keeps all rows newest-first and omits providerOrdered", async () => {
    discoverForPicker([
      {
        id: "offline-old",
        releaseDate: "2026-01-01",
        reported: "chat",
        ignoreCatalogReleaseDate: true,
      },
      {
        id: "offline-new",
        releaseDate: "2026-10-14",
        reported: "chat",
        ignoreCatalogReleaseDate: true,
      },
      {
        id: "offline-middle",
        releaseDate: "2026-06-01",
        reported: "chat",
        ignoreCatalogReleaseDate: true,
      },
    ]);
    const result = await buildDiscoveredModelOutcome(PROVIDER, "Offline picker order", catalog);
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error(JSON.stringify(result));
    expect(result.rows.map((r) => r.id)).toEqual(["offline-new", "offline-middle", "offline-old"]);
    expect(result).not.toHaveProperty("providerOrdered");
  });
});
