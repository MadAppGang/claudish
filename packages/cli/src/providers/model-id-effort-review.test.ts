// No-effort seams: lookupModelEfforts / bundledEffortRecommendations; disk reads are stubbed.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EffortLevel } from "../adapters/base-api-format.js";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import { lookupConnectionModelIdEffort } from "../adapters/model-catalog.js";
import * as antigravityToken from "../auth/antigravity-token.js";
import * as antigravityUser from "../auth/antigravity-user.js";
import { credentials } from "../auth/credentials/authority.js";
import { GeminiRequestQueue } from "../handlers/shared/gemini-queue.js";
import type { ModelIdEffort } from "../model-loader.js";
import * as allModelsCache from "./all-models-cache.js";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import { resolveDevinModelUid } from "./devin/model-id-resolver.js";
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
import type { EffortSendableOn, EffortTable } from "./effort-recommendations.js";
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
import type { ProviderTransport } from "./transport/types.js";

// Load the authority first: the concrete credential imports its transport.
const { AntigravityCredentialProvider } = await import(
  "../auth/credentials/antigravity-credential.js"
);

const BASE = "gemini-4-carbon";
const HIGH = `${BASE}-high`;
const MEDIUM = `${BASE}-medium`;
const LOW = `${BASE}-low`;
const OFF = `${BASE}-none`;
const RETIRED = "carbon-retired";
const BUILDERS = ["cached credential", "local builder"] as const;
type Builder = (typeof BUILDERS)[number];
type PinnableTransport = ProviderTransport & {
  setEffortOverride?: (level: EffortLevel) => void;
};
let recommendations: EffortTable | null;
let entries: SlimModelEntry[];
let served: antigravityUser.AntigravityServedModels;
let useLocalBuilder: boolean;
let restore: Array<() => void>;
const originalFetch = globalThis.fetch;
const discoveryBefore = getModelDiscoveryFetcher("antigravity");
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in model-id effort review tests");
});

function publish(map = effortMap({ high: HIGH, medium: MEDIUM, low: LOW }, { off: OFF })): void {
  entries = [catalogEntry(BASE, [connection("antigravity", BASE, map)])];
  _setCatalogEntriesForTest(entries);
}

async function transport(
  builder: Builder,
  pin?: EffortLevel,
  requested = BASE
): Promise<AntigravityProviderTransport> {
  useLocalBuilder = builder === "local builder";
  const result = new AntigravityProviderTransport(requested);
  if (pin !== undefined) (result as PinnableTransport).setEffortOverride?.(pin);
  await result.refreshAuth();
  return result;
}

function excludeRetired(): void {
  publish(effortMap({ high: RETIRED, low: LOW }));
  served = {
    servedIds: [RETIRED, LOW],
    defaultId: RETIRED,
    excludedIds: new Set([RETIRED]),
    meta: {},
  };
}

function accountList(models: DiscoveredModel[]): AccountModelsListSnapshot {
  return new Map([
    [
      "antigravity",
      { provider: "antigravity", models, fetchedAt: Date.now(), age: "live", mayDeny: true },
    ],
  ]);
}

beforeEach(() => {
  recommendations = null;
  restore = [stubEffortRecommendations(() => recommendations)];
  useLocalBuilder = false;
  served = { servedIds: [HIGH, MEDIUM, LOW, OFF], defaultId: HIGH, meta: {} };
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
  // Intercept persisted lists before availability can ask for a credential identity.
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

describe("A: none reaches the published off id through both envelope builders", () => {
  for (const builder of BUILDERS) {
    const cases: Array<{ name: string; pin?: EffortLevel; request: unknown }> = [
      {
        name: "pinned none outranks request high",
        pin: "none",
        request: { output_config: { effort: "high" } },
      },
      { name: "output_config none", request: { output_config: { effort: "none" } } },
      { name: "thinking disabled", request: { thinking: { type: "disabled" } } },
      { name: "zero thinking budget", request: { thinking: { budget_tokens: 0 } } },
    ];
    for (const item of cases) {
      test(`${builder}: ${item.name} sends off`, async () => {
        const ag = await transport(builder, item.pin);
        expect(ag.transformPayload({ contents: [] }, item.request).model).toBe(OFF);
      });
    }
    test(`${builder}: pinned high outranks thinking disabled`, async () => {
      const ag = await transport(builder, "high");
      expect(ag.transformPayload({ contents: [] }, { thinking: { type: "disabled" } }).model).toBe(
        HIGH
      );
    });
  }
});

describe("B: excluded account ids cannot supply an effort map selection", () => {
  for (const builder of BUILDERS) {
    for (const effort of ["high", undefined] as const) {
      test(`${builder}: ${effort ?? "no effort"} falls back without the retired id`, async () => {
        excludeRetired();
        const ag = await transport(builder);
        const envelope = ag.transformPayload(
          { contents: [] },
          effort ? { output_config: { effort } } : {}
        );
        expect(envelope.model).toBe(LOW);
      });
    }
  }

  test("availability and account-listed routing agree with the selectable transport id", async () => {
    excludeRetired();
    // A different canonical model id makes this an account-listed candidate,
    // not a connection candidate that has not reached availability filtering.
    entries = [catalogEntry("carbon-effort-map", entries[0]!.aggregators!)];
    _setCatalogEntriesForTest(entries);
    if (!discoveryBefore) throw new Error("Antigravity discovery was not registered");
    const discovery = await discoveryBefore("antigravity");
    expect(discovery.kind).toBe("models");
    const selectable = discovery.kind === "models" ? discovery.models : [];
    expect(selectable.map((row) => row.id)).toEqual([LOW]);
    registerModelDiscoveryFetcher("antigravity", async () => ({
      kind: "models",
      models: selectable,
    }));
    const ag = await transport("cached credential");
    const model = ag.transformPayload({ contents: [] }, {}).model;
    const availability = await providerServesModel("antigravity", BASE);
    const candidate = gatherRouteCandidates(
      BASE,
      undefined,
      accountList(selectable)
    ).candidates.some((row) => row.provider === "antigravity" && row.source === "account-listed");
    expect({ model, availability, candidate }).toEqual({
      model: LOW,
      availability: "serves",
      candidate: true,
    });
  });
});

describe("C: an exact connection without a map blocks case-folded sibling maps", () => {
  function mixedCaseConnections(): void {
    entries = [
      catalogEntry(BASE, [
        connection("antigravity", BASE),
        connection("antigravity", BASE.toUpperCase(), effortMap({ low: "case-sibling-low" })),
      ]),
    ];
    served.servedIds.push("case-sibling-low");
    _setCatalogEntriesForTest(entries);
  }

  test("lookup does not borrow the folded sibling map when the exact connection exists", () => {
    mixedCaseConnections();
    expect(lookupConnectionModelIdEffort(BASE, "antigravity")).toBeUndefined();
  });

  test("the transport never sends the folded sibling id for the exact unmapped base", async () => {
    mixedCaseConnections();
    const ag = await transport("cached credential");
    expect(ag.transformPayload({ contents: [] }, { output_config: { effort: "low" } }).model).toBe(
      HIGH
    );
  });

  test("one folded connection may supply its map when no exact connection exists", async () => {
    const map = effortMap({ low: "case-sibling-low" });
    entries = [catalogEntry(BASE, [connection("antigravity", BASE.toUpperCase(), map)])];
    _setCatalogEntriesForTest(entries);
    served.servedIds.push("case-sibling-low");
    expect(lookupConnectionModelIdEffort("Gemini-4-Carbon", "antigravity")).toEqual(map);
    const ag = await transport("cached credential", undefined, "Gemini-4-Carbon");
    expect(ag.transformPayload({ contents: [] }, { output_config: { effort: "low" } }).model).toBe(
      "case-sibling-low"
    );
  });
});

describe("D: omitting the request recomputes the no-effort model id", () => {
  for (const builder of BUILDERS) {
    test(`${builder}: a low request does not change the next no-argument default`, async () => {
      const ag = await transport(builder);
      expect(
        ag.transformPayload({ contents: [] }, { output_config: { effort: "low" } }).model
      ).toBe(LOW);
      expect(ag.transformPayload({ contents: [] }).model).toBe(MEDIUM);
    });
  }
});

describe("E: a mapped base uses the canonical default-task effort, else medium", () => {
  const CANONICAL = "carbon-canonical-chat";
  const MAX = "carbon-reasoning-maximum";
  const SURFACES = [
    "Devin expand",
    "Devin uid",
    "Antigravity resolver",
    "Antigravity cached credential",
    "Antigravity local builder",
  ] as const;
  type Surface = (typeof SURFACES)[number];
  type Case = {
    name: string;
    expected: string;
    values?: ModelIdEffort["values"];
    tableEffort?: string;
    mismatch?: Partial<EffortSendableOn>;
    tableKey?: string;
    catalogDefault?: string;
    noServerDefault?: boolean;
    serverDefault?: string;
    missingId?: string;
    effort?: EffortLevel;
    input?: "output_config" | "thinking" | "pin";
  };

  const cases: Case[] = [
    {
      name: "E1 matching canonical default high selects high",
      tableEffort: "high",
      expected: HIGH,
    },
    {
      name: "E2 default xhigh moves up to max, not down to high",
      tableEffort: "xhigh",
      values: { max: MAX, high: HIGH },
      serverDefault: HIGH,
      expected: MAX,
    },
    ...[
      { routeId: "other-route" },
      { routeProfileId: "other-profile" },
      { externalModelId: "other-wire-id" },
      { encoding: "request_parameter" },
    ].map(
      (mismatch): Case => ({
        name: `E3 mismatched ${Object.keys(mismatch)[0]} falls back to medium`,
        tableEffort: "high",
        mismatch,
        expected: MEDIUM,
      })
    ),
    {
      name: "E3 a wire-id table row cannot replace the canonical row",
      tableEffort: "high",
      tableKey: BASE,
      expected: MEDIUM,
    },
    { name: "E4 no table row chooses medium", noServerDefault: true, expected: MEDIUM },
    {
      name: "E4 no table row and no medium moves up to high",
      values: { high: HIGH, low: LOW },
      expected: HIGH,
    },
    { name: "E5 provider server low default cannot replace medium", expected: MEDIUM },
    {
      name: "E6 catalog string default low cannot replace medium",
      catalogDefault: "low",
      expected: MEDIUM,
    },
    {
      name: "E7 user low overrides table high",
      tableEffort: "high",
      effort: "low",
      expected: LOW,
    },
    {
      name: "E8 unlisted table-selected max keeps existing resolution",
      tableEffort: "max",
      values: { max: MAX, medium: MEDIUM, low: LOW },
      missingId: MAX,
      expected: LOW,
    },
  ];

  function arrange(surface: Surface, item: Case) {
    const provider = surface.startsWith("Devin") ? "devin" : "antigravity";
    const values = item.values ?? { high: HIGH, medium: MEDIUM, low: LOW };
    const map = {
      ...effortMap(values),
      ...(item.catalogDefault ? { default: item.catalogDefault } : {}),
    } as ModelIdEffort;
    const mappedConnection = connection(provider, BASE, map);
    entries = [catalogEntry(CANONICAL, [mappedConnection])];
    _setCatalogEntriesForTest(entries);
    const sendableOn: EffortSendableOn = {
      ...mappedConnection.route!,
      externalModelId: BASE,
      encoding: "model_id_switch",
      ...item.mismatch,
    };
    recommendations = item.tableEffort
      ? {
          generationId: "model-id-effort-test-data",
          efforts: {
            [item.tableKey ?? CANONICAL]: {
              default: { effort: item.tableEffort, sendableOn: [sendableOn] },
            },
          },
        }
      : { generationId: "model-id-effort-test-data", efforts: {} };
    const ids = [...new Set([HIGH, MEDIUM, LOW, ...Object.values(values)])].filter(
      (id): id is string => typeof id === "string" && id !== item.missingId
    );
    served = {
      servedIds: ids,
      defaultId: item.noServerDefault ? null : (item.serverDefault ?? LOW),
      meta: {},
    };
    return ids.map((id) =>
      devinModel(id, id === MAX ? "max" : id === HIGH ? "high" : id === MEDIUM ? "medium" : "low", {
        isDefault: !item.noServerDefault && id === (item.serverDefault ?? LOW),
        cost: id === LOW ? 1 : id === MEDIUM ? 3 : 5,
      })
    );
  }

  async function chosen(surface: Surface, item: Case): Promise<string> {
    const models = arrange(surface, item);
    if (surface === "Devin expand") {
      return new DevinModelResolver().expand(BASE, models.map(devinModelsCatalogEntry), {
        effort: item.effort,
      });
    }
    if (surface === "Devin uid") return resolveDevinModelUid(BASE, item.effort, models);
    if (surface === "Antigravity resolver") {
      return resolveAntigravityServedModel(BASE, served, item.effort);
    }
    const builder =
      surface === "Antigravity cached credential" ? "cached credential" : "local builder";
    const ag = await transport(builder, item.input === "pin" ? item.effort : undefined);
    const request =
      item.input === "thinking"
        ? { thinking: { type: "enabled", budget_tokens: 1024 } }
        : item.effort
          ? { output_config: { effort: item.effort } }
          : {};
    return ag.transformPayload({ contents: [] }, request).model;
  }

  for (const surface of SURFACES) {
    for (const item of cases) {
      test(`${surface}: ${item.name}`, async () => {
        expect(await chosen(surface, item)).toBe(item.expected);
      });
    }
  }

  for (const surface of ["Antigravity cached credential", "Antigravity local builder"] as const) {
    for (const input of ["thinking", "pin"] as const) {
      test(`${surface}: E7 user low from ${input} overrides table high`, async () => {
        expect(
          await chosen(surface, {
            name: "user low",
            tableEffort: "high",
            effort: "low",
            input,
            expected: LOW,
          })
        ).toBe(LOW);
      });
    }
  }

  test("E6 the map reader accepts a string default without losing its values", () => {
    const map = { ...effortMap({ high: HIGH, medium: MEDIUM, low: LOW }), default: "low" };
    expect(readModelIdEffort(map)?.values).toEqual(map.values);
  });
});

describe("F: capacity retries treat served speed suffixes as ordinary ids", () => {
  for (const suffix of ["fast", "priority"]) {
    test(`only a served -${suffix} candidate remains: retry it successfully`, async () => {
      const premium = `${BASE}-high-${suffix}`;
      publish(effortMap({ high: premium, low: LOW }));
      served = { servedIds: [LOW, premium], defaultId: LOW, meta: {} };
      const ag = await transport("cached credential");
      const envelope = ag.transformPayload({ contents: [] }, { output_config: { effort: "low" } });
      expect(envelope.model).toBe(LOW);
      const capacity = new Response(
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
      const sent: string[] = [];
      // Both the primary closure and every retry use this sole fetch mock.
      const fetchMock = mock(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        sent.push(body.model);
        return sent.length === 1 ? capacity : new Response("ok", { status: 200 });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const queue = spyOn(GeminiRequestQueue.getInstance(), "enqueue").mockImplementation(
        async (fetchFn) => fetchFn()
      );
      restore.push(() => queue.mockRestore());
      const response = await ag.enqueueRequest(() =>
        fetch(ag.getEndpoint(), {
          method: "POST",
          body: JSON.stringify(envelope),
        })
      );
      expect({ sent, status: response.status, original: response === capacity }).toEqual({
        sent: [LOW, premium],
        status: 200,
        original: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  }
});

describe("G: model-id effort connections do not send body effort controls", () => {
  for (const builder of BUILDERS) {
    for (const base of [BASE, "gemini-3.8-flash"]) {
      test(`${builder}: ${base} removes budget or level from the full dialect envelope`, async () => {
        const high = `${base}-high`;
        const low = `${base}-low`;
        entries = [catalogEntry(base, [connection("antigravity", base, effortMap({ high, low }))])];
        _setCatalogEntriesForTest(entries);
        served = { servedIds: [high, low], defaultId: high, meta: {} };
        const request = {
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 32_768,
          output_config: { effort: "low" },
        };
        const dialect = new GeminiAPIFormat(base);
        const payload = dialect.buildPayload(request, dialect.convertMessages(request), []);
        const before = payload.generationConfig.thinkingConfig;
        expect(before).toEqual(base === BASE ? { thinkingBudget: 1024 } : { thinkingLevel: "low" });
        const ag = await transport(builder, undefined, base);
        const envelope = ag.transformPayload(payload, request);
        expect(envelope.model).toBe(low);
        expect(envelope.request.generationConfig.thinkingConfig ?? {}).toEqual({});
      });
    }

    test(`${builder}: an exact low id at high effort drops body controls but keeps includeThoughts`, async () => {
      const request = {
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32_768,
        output_config: { effort: "high" },
      };
      const dialect = new GeminiAPIFormat(LOW);
      const payload = dialect.buildPayload(request, dialect.convertMessages(request), []);
      // Exercise a dialect's optional thought visibility independently of effort.
      payload.generationConfig.thinkingConfig.includeThoughts = true;
      const ag = await transport(builder, undefined, LOW);
      const envelope = ag.transformPayload(payload, request);
      expect(envelope.model).toBe(LOW);
      expect(envelope.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
    });

    test(`${builder}: a plain id without a map keeps its full thinkingConfig`, async () => {
      const plain = "gemini-plain-chat";
      entries = [catalogEntry(plain, [connection("antigravity", plain)])];
      _setCatalogEntriesForTest(entries);
      served = { servedIds: [plain], defaultId: plain, meta: {} };
      const request = {
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32_768,
        output_config: { effort: "low" },
      };
      const dialect = new GeminiAPIFormat(plain);
      const payload = dialect.buildPayload(request, dialect.convertMessages(request), []);
      payload.generationConfig.thinkingConfig.includeThoughts = true;
      const before = structuredClone(payload.generationConfig.thinkingConfig);
      const ag = await transport(builder, undefined, plain);
      const envelope = ag.transformPayload(payload, request);
      expect(envelope.model).toBe(plain);
      expect(envelope.request.generationConfig.thinkingConfig).toEqual(before);
      expect(before).toEqual({ thinkingBudget: 1024, includeThoughts: true });
    });
  }
});
