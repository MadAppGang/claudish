// No-effort seams: lookupModelEfforts / bundledEffortRecommendations; disk reads are stubbed.
/**
 * The transport decodes effort from the Claude request and passes it to the
 * credential's transformPayload(payload, { effort }) for each request.
 *
 * Load the authority before the concrete credential provider to avoid its
 * existing import cycle. All credential, discovery and disk I/O is intercepted.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as antigravityToken from "../auth/antigravity-token.js";
import * as antigravityUser from "../auth/antigravity-user.js";
import { credentials } from "../auth/credentials/authority.js";
import * as allModelsCache from "./all-models-cache.js";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import * as devinCredentials from "./devin/devin-credentials.js";
import * as devinModels from "./devin/devin-models.js";
import { resolveDevinModelUid } from "./devin/model-id-resolver.js";
import { parseTLV, readString } from "./devin/proto-codec.js";
import * as dynamicModelsCatalog from "./dynamic-models-catalog.js";
import type { AccountModelsListSnapshot } from "./dynamic-models-catalog.js";
import { providerServesModel } from "./model-availability.js";
import {
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import type { DiscoveredModel } from "./model-discovery.js";
import "./model-discovery-builtins.js";
import { gatherRouteCandidates } from "./route-candidates.js";
import {
  catalogEntry,
  connection,
  devinModel,
  effortMap,
  stubEffortRecommendations,
} from "./test-helpers/model-id-effort.js";
import {
  AntigravityProviderTransport,
  resolveAntigravityServedModel,
} from "./transport/antigravity.js";
import { DevinProviderTransport } from "./transport/devin.js";
import type { ProviderTransport } from "./transport/types.js";

const { AntigravityCredentialProvider } = await import(
  "../auth/credentials/antigravity-credential.js"
);

const BASE = "gemini-4-carbon";
const HIGH = `${BASE}-high`;
const LOW = `${BASE}-low`;
let entries: SlimModelEntry[];
let agServed: antigravityUser.AntigravityServedModels;
let dvServed: devinModels.DevinModelConfig[];
let restore: Array<() => void> = [];
const originalFetch = globalThis.fetch;
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in model-id parity tests");
});
const discoveryBefore = new Map(
  ["devin", "antigravity"].map((provider) => [
    provider,
    getModelDiscoveryFetcher(provider === "devin" ? "devin-connect" : provider),
  ])
);

function publish(): void {
  _setCatalogEntriesForTest(entries);
}

beforeEach(() => {
  entries = [
    catalogEntry(BASE, [
      connection("devin", BASE, effortMap({ high: HIGH, low: LOW })),
      connection("antigravity", BASE, effortMap({ high: HIGH, low: LOW })),
    ]),
  ];
  agServed = { servedIds: [HIGH, LOW], defaultId: HIGH, meta: {} };
  dvServed = [devinModel(HIGH, "high", { isDefault: true }), devinModel(LOW, "low")];
  restore = [stubEffortRecommendations()];
  noNetwork.mockClear();
  globalThis.fetch = noNetwork as unknown as typeof fetch;
  _resetCatalogClient();
  invalidateModelDiscovery();
  publish();

  const disk = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
    (): DiskCacheV3 => ({
      version: 3,
      lastUpdated: "2026-11-12T00:00:00.000Z",
      catalogGenerationId: "model-id-effort-test-data",
      entries,
      models: [],
      plans: [],
    })
  );
  const token = spyOn(antigravityToken, "getValidAntigravityAccessToken").mockResolvedValue(
    "unit-test-token"
  );
  const user = spyOn(antigravityUser, "setupAntigravityUser").mockResolvedValue({
    projectId: "unit-test-project",
    tierId: "free-tier",
  });
  const ag = spyOn(antigravityUser, "getServedAntigravityModels").mockImplementation(
    async () => agServed
  );
  const peek = spyOn(antigravityUser, "peekServedAntigravityModels").mockImplementation(
    () => agServed
  );
  const dv = spyOn(devinModels, "getServedDevinModels").mockImplementation(async () => dvServed);
  const key = spyOn(devinCredentials, "readDevinApiKey").mockReturnValue("unit-test-key");
  // The persisted-list seam prevents credential identity and store I/O. These
  // tests exercise the injected live discovery path, not persistence.
  const lists = spyOn(dynamicModelsCatalog, "readAccountModelsList").mockResolvedValue(null);
  const refresh = spyOn(dynamicModelsCatalog, "refreshAccountModelsList").mockResolvedValue({
    kind: "skipped",
    reason: "no-credential",
  });
  const auth = spyOn(credentials, "getRequestAuth").mockImplementation(async (provider, ctx) =>
    provider === "antigravity"
      ? new AntigravityCredentialProvider().getRequestAuth(ctx)
      : { headers: {} }
  );
  for (const spy of [disk, token, user, ag, peek, dv, key, lists, refresh, auth]) {
    restore.push(() => spy.mockRestore());
  }
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  for (const provider of ["devin", "antigravity"]) {
    const original = discoveryBefore.get(provider);
    if (!original) throw new Error(`Missing discovery registration for ${provider}`);
    registerModelDiscoveryFetcher(provider === "devin" ? "devin-connect" : provider, original);
  }
  invalidateModelDiscovery();
  _resetCatalogClient();
  globalThis.fetch = originalFetch;
  expect(noNetwork).not.toHaveBeenCalled();
});

describe("rule 9: one model-id decision per provider", () => {
  test("Antigravity credential receives low effort and builds the low envelope", async () => {
    const auth = await new AntigravityCredentialProvider().getRequestAuth({ model: BASE });
    expect(auth.transformPayload?.({ contents: [] }, { effort: "low" }).model).toBe(LOW);
  });

  test("Antigravity delegated envelope and standalone credential both send low", async () => {
    const standalone = await new AntigravityCredentialProvider().getRequestAuth({ model: BASE });
    const transport = new AntigravityProviderTransport(BASE);
    await transport.refreshAuth();
    const contract: ProviderTransport = transport;
    const envelope = contract.transformPayload!(
      { contents: [] },
      { output_config: { effort: "low" } }
    );
    expect({
      credential: standalone.transformPayload?.({ contents: [] }, { effort: "low" }).model,
      transport: envelope.model,
    }).toEqual({ credential: LOW, transport: LOW });
  });

  test("Antigravity local envelope uses the same low id as the credential", async () => {
    const standalone = await new AntigravityCredentialProvider().getRequestAuth({ model: BASE });
    // An artifact without a transform exercises the transport's local builder.
    const auth = spyOn(credentials, "getRequestAuth").mockResolvedValue({ headers: {} });
    restore.push(() => auth.mockRestore());
    const transport = new AntigravityProviderTransport(BASE);
    await transport.refreshAuth();
    const contract: ProviderTransport = transport;
    expect({
      credential: standalone.transformPayload?.({ contents: [] }, { effort: "low" }).model,
      local: contract.transformPayload!({ contents: [] }, { output_config: { effort: "low" } })
        .model,
    }).toEqual({ credential: LOW, local: LOW });
  });

  test("Antigravity exact low uid stays fixed through credential and transport at high effort", async () => {
    const standalone = await new AntigravityCredentialProvider().getRequestAuth({ model: LOW });
    const transport = new AntigravityProviderTransport(LOW);
    await transport.refreshAuth();
    const contract: ProviderTransport = transport;
    expect({
      credential: standalone.transformPayload?.({ contents: [] }, { effort: "high" }).model,
      transport: contract.transformPayload!({ contents: [] }, { output_config: { effort: "high" } })
        .model,
    }).toEqual({ credential: LOW, transport: LOW });
  });

  test("Devin protobuf field 21 agrees with the map-aware resolver", async () => {
    const mapped = "carbon-low-route";
    entries = [
      catalogEntry(BASE, [connection("devin", BASE, effortMap({ low: mapped, high: HIGH }))]),
    ];
    dvServed.push(
      devinModel(mapped, "low", { groupLabel: "Carbon alternate", family: "carbon-route" })
    );
    publish();
    const transport = new DevinProviderTransport(BASE);
    await transport.refreshAuth();
    const serialized = transport.serializeBody({ modelUid: BASE, effort: "low", messages: [] });
    expect(serialized.body).toBeInstanceOf(Uint8Array);
    const fields = parseTLV((serialized.body as Uint8Array).subarray(5));
    const field = fields.find((item) => item.no === 21)!;
    expect({
      resolver: resolveDevinModelUid(BASE, "low", dvServed),
      transport: readString(field),
    }).toEqual({ resolver: mapped, transport: mapped });
  });

  for (const provider of ["devin", "antigravity"] as const) {
    test(`${provider}: availability retains a base mapped to the account's differently spelled id`, async () => {
      const mapped = "carbon-account-selection";
      // The canonical model id differs from the requested wire id. A lookup
      // must find externalModelId, not require a canonical-id/alias match.
      entries = [
        catalogEntry("gemini-4-carbon-preview", [
          connection(provider, BASE, effortMap({ high: mapped })),
        ]),
      ];
      agServed = { servedIds: [mapped], defaultId: mapped, meta: {} };
      dvServed = [
        devinModel(mapped, "high", {
          family: "carbon-account-family",
          groupLabel: "Carbon account family",
          isDefault: true,
        }),
      ];
      publish();
      const model: DiscoveredModel =
        provider === "devin"
          ? {
              id: mapped,
              family: "carbon-account-family",
              groupLabel: "Carbon account family",
              isFamilyDefault: true,
              reported: "chat",
            }
          : { id: mapped, reported: "chat" };
      registerModelDiscoveryFetcher(
        provider === "devin" ? "devin-connect" : provider,
        async () => ({ kind: "models", models: [model] })
      );
      expect(await providerServesModel(provider, BASE)).toBe("serves");
    });

    test(`${provider}: account-listed candidate uses the same base mapping as transport`, () => {
      const mapped = "carbon-account-selection";
      entries = [
        catalogEntry("gemini-4-carbon-preview", [
          connection(provider, BASE, effortMap({ high: mapped })),
        ]),
      ];
      publish();
      const model: DiscoveredModel = {
        id: mapped,
        family: "carbon-account-family",
        groupLabel: "Carbon account family",
        isFamilyDefault: true,
        contextWindow: 200_000,
        reported: "chat",
      };
      const lists: AccountModelsListSnapshot = new Map([
        [
          provider,
          {
            provider,
            models: [model],
            fetchedAt: Date.now(),
            age: "live",
            mayDeny: true,
          },
        ],
      ]);
      const candidates = gatherRouteCandidates(BASE, undefined, lists).candidates;
      expect(candidates).toContainEqual(
        expect.objectContaining({
          provider,
          wireId: BASE,
          source: "account-listed",
          contextWindow: 200_000,
        })
      );
    });
  }

  test("Antigravity no-effort credential and local transport move medium up to high, not server low", async () => {
    agServed.defaultId = LOW;
    const standalone = await new AntigravityCredentialProvider().getRequestAuth({ model: BASE });
    const auth = spyOn(credentials, "getRequestAuth").mockResolvedValue({ headers: {} });
    restore.push(() => auth.mockRestore());
    const transport = new AntigravityProviderTransport(BASE);
    await transport.refreshAuth();
    expect({
      credential: standalone.transformPayload?.({ contents: [] }).model,
      local: transport.transformPayload({ contents: [] }).model,
      resolver: resolveAntigravityServedModel(BASE, agServed),
    }).toEqual({ credential: HIGH, local: HIGH, resolver: HIGH });
  });
});
