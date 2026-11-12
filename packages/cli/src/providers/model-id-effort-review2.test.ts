// Generation seam: readAllModelsCache supplies g-new; stubEffortRecommendations
// intercepts currentEffortRecommendations, readEffortRecommendations and the
// generation-pinned lookupModelEfforts(modelId, generationId), without disk I/O.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EffortLevel } from "../adapters/base-api-format.js";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import * as antigravityToken from "../auth/antigravity-token.js";
import * as antigravityUser from "../auth/antigravity-user.js";
import { credentials } from "../auth/credentials/authority.js";
import { GeminiRequestQueue } from "../handlers/shared/gemini-queue.js";
import * as allModelsCache from "./all-models-cache.js";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import { resolveDevinModelUid } from "./devin/model-id-resolver.js";
import * as dynamicModelsCatalog from "./dynamic-models-catalog.js";
import { providerServesModel } from "./model-availability.js";
import {
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import "./model-discovery-builtins.js";
import type { EffortTable } from "./effort-recommendations.js";
import { readModelIdEffort } from "./model-id-effort.js";
import { DevinModelResolver, devinModelsCatalogEntry } from "./model-resolvers/devin.js";
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

// The authority must load before the concrete credential's transport import.
const { AntigravityCredentialProvider } = await import(
  "../auth/credentials/antigravity-credential.js"
);

const BASE = "gemini-4-carbon";
const HIGH = `${BASE}-high`;
const MEDIUM = `${BASE}-medium`;
const LOW = `${BASE}-low`;
const PLAIN = "gemini-3.7-flash-tiered";
const BUILDERS = ["cached credential", "local builder"] as const;
type Builder = (typeof BUILDERS)[number];
type Envelope = {
  model: string;
  request: {
    generationConfig?: { thinkingConfig?: Record<string, unknown> };
  };
};
let entries: SlimModelEntry[];
let served: antigravityUser.AntigravityServedModels;
let recommendations: EffortTable | null;
let useLocalBuilder: boolean;
let restore: Array<() => void>;
const originalFetch = globalThis.fetch;
const discoveryBefore = getModelDiscoveryFetcher("antigravity");
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in per-attempt model-id effort tests");
});

function publish(next: SlimModelEntry[]): void {
  entries = next;
  _setCatalogEntriesForTest(entries);
}

async function transport(builder: Builder, requested = BASE) {
  useLocalBuilder = builder === "local builder";
  const ag = new AntigravityProviderTransport(requested);
  await ag.refreshAuth();
  return ag;
}

function dialectPayload(model: string, effort: EffortLevel) {
  const request = {
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 32_768,
    output_config: { effort },
  };
  const dialect = new GeminiAPIFormat(model);
  const payload = dialect.buildPayload(request, dialect.convertMessages(request), []);
  return { payload, request };
}

function capacityResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Model capacity exhausted",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "MODEL_CAPACITY_EXHAUSTED",
          },
        ],
      },
    }),
    { status: 429 }
  );
}

async function exhaustPrimary(ag: AntigravityProviderTransport, envelope: Envelope) {
  const sent: Envelope[] = [];
  const capacity = capacityResponse();
  // One mock handles the primary, all capacity candidates and later primaries.
  const fetchMock = mock(async (_input: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Envelope);
    return sent.length === 1 ? capacity : new Response("ok", { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const queue = spyOn(GeminiRequestQueue.getInstance(), "enqueue").mockImplementation(
    async (fetchFn) => fetchFn()
  );
  restore.push(() => queue.mockRestore());
  const send = (body: Envelope) =>
    ag.enqueueRequest(() =>
      fetch(ag.getEndpoint(), { method: "POST", body: JSON.stringify(body) })
    );
  const response = await send(envelope);
  return { sent, capacity, response, fetchMock, send };
}

beforeEach(() => {
  recommendations = null;
  restore = [stubEffortRecommendations(() => recommendations)];
  useLocalBuilder = false;
  served = { servedIds: [HIGH, MEDIUM, LOW], defaultId: HIGH, meta: {} };
  noNetwork.mockClear();
  globalThis.fetch = noNetwork as unknown as typeof fetch;
  _resetCatalogClient();
  invalidateModelDiscovery();
  publish([
    catalogEntry(BASE, [
      connection("antigravity", BASE, effortMap({ high: HIGH, medium: MEDIUM, low: LOW })),
    ]),
  ]);
  const disk = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
    (): DiskCacheV3 => ({
      version: 3,
      lastUpdated: "2026-11-12T00:00:00.000Z",
      catalogGenerationId: "g-new",
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
  const models = spyOn(antigravityUser, "getServedAntigravityModels").mockImplementation(
    async () => served
  );
  const peek = spyOn(antigravityUser, "peekServedAntigravityModels").mockImplementation(
    () => served
  );
  const agent = spyOn(antigravityUser, "buildAntigravityUserAgent").mockReturnValue(
    "unit-test-agent"
  );
  const auth = spyOn(credentials, "getRequestAuth").mockImplementation(async (provider, ctx) => {
    if (provider !== "antigravity") throw new Error(`Unexpected credential request: ${provider}`);
    return useLocalBuilder
      ? { headers: {} }
      : new AntigravityCredentialProvider().getRequestAuth(ctx);
  });
  const lists = spyOn(dynamicModelsCatalog, "readAccountModelsList").mockResolvedValue(null);
  const refresh = spyOn(dynamicModelsCatalog, "refreshAccountModelsList").mockResolvedValue({
    kind: "skipped",
    reason: "no-credential",
  });
  for (const spy of [disk, token, user, models, peek, agent, auth, lists, refresh]) {
    restore.push(() => spy.mockRestore());
  }
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  if (discoveryBefore) registerModelDiscoveryFetcher("antigravity", discoveryBefore);
  invalidateModelDiscovery();
  _resetCatalogClient();
  globalThis.fetch = originalFetch;
  expect(noNetwork).not.toHaveBeenCalled();
});

describe("R1: effort controls follow the id sent on each attempt", () => {
  for (const builder of BUILDERS) {
    test(`${builder}: R1a unserved map value keeps low thinkingLevel on the unmapped id`, async () => {
      const base = "gemini-3.7-flash";
      publish([
        catalogEntry(base, [connection("antigravity", base, effortMap({ high: `${base}-high` }))]),
      ]);
      served = { servedIds: [PLAIN], defaultId: PLAIN, meta: {} };
      const { payload, request } = dialectPayload(base, "low");
      expect(payload.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
      const before = structuredClone(payload);
      const ag = await transport(builder, base);
      const envelope = ag.transformPayload(payload, request);
      expect(envelope.model).toBe(PLAIN);
      expect(envelope.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
      expect(payload).toEqual(before);
    });

    test(`${builder}: R1b capacity retry to an unmapped id restores the original effort control`, async () => {
      served = { servedIds: [LOW, PLAIN], defaultId: LOW, meta: {} };
      const { payload, request } = dialectPayload(BASE, "low");
      const original = structuredClone(payload.generationConfig.thinkingConfig);
      expect(original).toEqual({ thinkingBudget: 1024 });
      const ag = await transport(builder);
      const envelope = ag.transformPayload(payload, request);
      expect(envelope.model).toBe(LOW);
      expect(envelope.request.generationConfig.thinkingConfig ?? {}).toEqual({});
      const { sent, response, fetchMock } = await exhaustPrimary(ag, envelope);
      expect(response.status).toBe(200);
      expect(sent.map((body) => body.model)).toEqual([LOW, PLAIN]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sent[1]!.request.generationConfig?.thinkingConfig).toEqual(original);
    });

    test(`${builder}: R1c capacity retry to a mapped low id removes the original high control`, async () => {
      served = { servedIds: [PLAIN, LOW], defaultId: PLAIN, meta: {} };
      const { payload, request } = dialectPayload(PLAIN, "high");
      const original = structuredClone(payload.generationConfig.thinkingConfig);
      expect(original).toEqual({ thinkingLevel: "high" });
      const ag = await transport(builder, PLAIN);
      const envelope = ag.transformPayload(payload, request);
      expect(envelope.model).toBe(PLAIN);
      expect(envelope.request.generationConfig.thinkingConfig).toEqual(original);
      const { sent, response, fetchMock } = await exhaustPrimary(ag, envelope);
      expect(response.status).toBe(200);
      expect(sent.map((body) => body.model)).toEqual([PLAIN, LOW]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sent[1]!.request.generationConfig?.thinkingConfig ?? {}).toEqual({});
    });

    test(`${builder}: R1d a later primary success clears the previous active retry id`, async () => {
      served = { servedIds: [LOW, PLAIN], defaultId: LOW, meta: {} };
      const ag = await transport(builder);
      const { payload, request } = dialectPayload(BASE, "low");
      const first = ag.transformPayload(payload, request);
      const { sent, response, send } = await exhaustPrimary(ag, first);
      expect(response.status).toBe(200);
      expect(ag.getActiveModelName()).toBe(PLAIN);
      const second = ag.transformPayload(payload, request);
      expect(second.model).toBe(LOW);
      expect((await send(second)).status).toBe(200);
      expect(sent.map((body) => body.model)).toEqual([LOW, PLAIN, LOW]);
      // A primary may report its sent id, or no override; it must not report the old retry.
      expect(ag.getActiveModelName() ?? second.model).toBe(LOW);
    });
  }
});

describe("R2: speed suffixes do not override effort maps or family defaults", () => {
  for (const builder of BUILDERS) {
    test(`${builder}: exact carbon-high-fast stays fixed and base high selects carbon-high-fast`, async () => {
      const base = "carbon";
      const premium = "carbon-high-fast";
      const ordinary = "carbon-low";
      publish([
        catalogEntry(base, [
          connection("antigravity", base, effortMap({ high: premium, low: ordinary })),
        ]),
        {
          ...catalogEntry(premium, [connection("antigravity", premium)]),
          routeVariant: {
            kind: "preset",
            baseModelId: base,
            familyId: base,
            provider: "antigravity",
            isDefault: true,
          },
        },
      ]);
      served = { servedIds: [premium, ordinary], defaultId: premium, meta: {} };
      const exact = await transport(builder, premium);
      expect(
        exact.transformPayload({ contents: [] }, { output_config: { effort: "high" } }).model
      ).toBe(premium);
      const ag = await transport(builder, base);
      expect(
        ag.transformPayload({ contents: [] }, { output_config: { effort: "high" } }).model
      ).toBe(premium);
    });

    test(`${builder}: a served -fast family default is selected without an effort map`, async () => {
      const base = "carbon";
      const selected = "carbon-high-fast";
      publish([
        catalogEntry(base, [connection("antigravity", base)]),
        {
          ...catalogEntry(selected, [connection("antigravity", selected)]),
          routeVariant: {
            kind: "preset",
            baseModelId: base,
            familyId: base,
            provider: "antigravity",
            isDefault: true,
          },
        },
      ]);
      served = { servedIds: [selected, "carbon-low"], defaultId: selected, meta: {} };
      const ag = await transport(builder, base);
      expect(ag.transformPayload({ contents: [] }, {}).model).toBe(selected);
    });
  }
});

describe("R3: an excluded served base resolves through its selectable map", () => {
  const base = "gemini-3.1-pro";
  const medium = `${base}-medium`;
  function arrange() {
    // Distinct canonical id makes route gathering exercise account-listed candidates.
    publish([
      catalogEntry("pro-canonical-chat", [
        connection("antigravity", base, effortMap({ high: `${base}-high`, medium })),
      ]),
    ]);
    served = {
      servedIds: [base, medium],
      excludedIds: new Set([base]),
      defaultId: base,
      meta: {},
    };
  }

  test("no effort skips the excluded base and selects medium", () => {
    arrange();
    expect(resolveAntigravityServedModel(base, served)).toBe(medium);
  });

  test("availability and account-listed candidates agree with the selectable medium id", async () => {
    arrange();
    if (!discoveryBefore) throw new Error("Antigravity discovery was not registered");
    const discovery = await discoveryBefore("antigravity");
    expect(discovery.kind).toBe("models");
    const models = discovery.kind === "models" ? discovery.models : [];
    expect(models.map((row) => row.id)).toEqual([medium]);
    registerModelDiscoveryFetcher("antigravity", async () => ({ kind: "models", models }));
    const candidate = gatherRouteCandidates(
      base,
      undefined,
      new Map([
        [
          "antigravity",
          {
            provider: "antigravity",
            models,
            fetchedAt: Date.now(),
            age: "live",
            mayDeny: true,
          },
        ],
      ])
    ).candidates.some((row) => row.provider === "antigravity" && row.source === "account-listed");
    expect({ availability: await providerServesModel("antigravity", base), candidate }).toEqual({
      availability: "serves",
      candidate: true,
    });
  });
});

describe("R4: default-task recommendations belong to the connection generation", () => {
  const surfaces = ["Devin expand", "Devin uid", "Antigravity resolver", ...BUILDERS] as const;
  for (const surface of surfaces) {
    test(`${surface}: matching g-new selects high; only g-old falls back to medium`, async () => {
      const provider = surface.startsWith("Devin") ? "devin" : "antigravity";
      const canonical = "carbon-canonical-chat";
      const mapped = connection(provider, BASE, effortMap({ high: HIGH, medium: MEDIUM }));
      publish([catalogEntry(canonical, [mapped])]);
      const table = (generationId: string): EffortTable => ({
        generationId,
        efforts: {
          [canonical]: {
            default: {
              effort: "high",
              sendableOn: [
                {
                  ...mapped.route!,
                  externalModelId: BASE,
                  encoding: "model_id_switch",
                },
              ],
            },
          },
        },
      });
      const models = [devinModel(HIGH, "high", { isDefault: true }), devinModel(MEDIUM, "medium")];
      const choose = async () => {
        if (surface === "Devin expand") {
          return new DevinModelResolver().expand(BASE, models.map(devinModelsCatalogEntry), {});
        }
        if (surface === "Devin uid") return resolveDevinModelUid(BASE, undefined, models);
        if (surface === "Antigravity resolver") return resolveAntigravityServedModel(BASE, served);
        return (await transport(surface)).transformPayload({ contents: [] }).model;
      };
      recommendations = table("g-new");
      expect(await choose()).toBe(HIGH);
      recommendations = table("g-old");
      expect(await choose()).toBe(MEDIUM);
    });
  }
});

describe("R6: parsed defaults and excluded capacity candidates are asserted explicitly", () => {
  test("R6a readModelIdEffort preserves the exact map including string default low", () => {
    const map = { ...effortMap({ high: HIGH, medium: MEDIUM, low: LOW }), default: "low" };
    const parsed = readModelIdEffort(map);
    expect(parsed?.default).toBe("low");
    expect(parsed).toEqual(map);
  });

  for (const builder of BUILDERS) {
    for (const suffix of ["fast", "priority"]) {
      test(`${builder}: an excluded -${suffix} id is never a capacity candidate`, async () => {
        const excluded = `carbon-high-${suffix}`;
        served = {
          servedIds: [LOW, excluded],
          defaultId: LOW,
          excludedIds: new Set([excluded]),
          meta: {},
        };
        const ag = await transport(builder);
        const envelope = ag.transformPayload(
          { contents: [] },
          { output_config: { effort: "low" } }
        );
        expect(envelope.model).toBe(LOW);
        const { sent, response, capacity, fetchMock } = await exhaustPrimary(ag, envelope);
        expect({ sent: sent.map((body) => body.model), status: response.status }).toEqual({
          sent: [LOW],
          status: 429,
        });
        expect(response).toBe(capacity);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    }

    test(`${builder}: R6b an excluded ordinary id is never a capacity candidate`, async () => {
      const excluded = "carbon-retired";
      served = {
        servedIds: [LOW, excluded],
        defaultId: LOW,
        excludedIds: new Set([excluded]),
        meta: {},
      };
      const ag = await transport(builder);
      const envelope = ag.transformPayload({ contents: [] }, { output_config: { effort: "low" } });
      expect(envelope.model).toBe(LOW);
      const { sent, response, capacity, fetchMock } = await exhaustPrimary(ag, envelope);
      expect({ sent: sent.map((body) => body.model), status: response.status }).toEqual({
        sent: [LOW],
        status: 429,
      });
      expect(response).toBe(capacity);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
});
