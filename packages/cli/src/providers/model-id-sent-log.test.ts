import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EffortLevel } from "../adapters/base-api-format.js";
import * as antigravityToken from "../auth/antigravity-token.js";
import * as antigravityUser from "../auth/antigravity-user.js";
import { credentials } from "../auth/credentials/authority.js";
import { GeminiRequestQueue } from "../handlers/shared/gemini-queue.js";
import * as logger from "../logger.js";
import * as allModelsCache from "./all-models-cache.js";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import * as dynamicModelsCatalog from "./dynamic-models-catalog.js";
import type { EffortTable } from "./effort-recommendations.js";
import { invalidateModelDiscovery } from "./model-discovery.js";
import { DevinModelResolver, devinModelsCatalogEntry } from "./model-resolvers/devin.js";
import {
  catalogEntry,
  connection,
  devinModel,
  effortMap,
  stubEffortRecommendations,
} from "./test-helpers/model-id-effort.js";
import { AntigravityProviderTransport } from "./transport/antigravity.js";

// Load the authority before the concrete credential imports its transport.
const { AntigravityCredentialProvider } = await import(
  "../auth/credentials/antigravity-credential.js"
);

const BASE = "claude-opus-5-5";
const CANONICAL = "claude-opus-5.5";
const LOW = `${BASE}-low`;
const MEDIUM = `${BASE}-medium`;
const HIGH = `${BASE}-high`;
const GENERATION = "sent-model-id-test-data";
const BUILDERS = ["cached credential", "local builder"] as const;
type Builder = (typeof BUILDERS)[number];
type Source = "request" | "catalog default" | "medium fallback" | "exact id" | "no map";
type Envelope = { model: string; request: unknown };
const originalFetch = globalThis.fetch;
const TOKEN = "unit-test-token";
const BODY_TEXT = "private-body-test-data";

let entries: SlimModelEntry[];
let recommendations: EffortTable | null;
let served: antigravityUser.AntigravityServedModels;
let useLocalBuilder: boolean;
let restore: Array<() => void>;
let logSpy: ReturnType<typeof spyOn<typeof logger, "log">>;
let stderrSpy: ReturnType<typeof spyOn<typeof logger, "logStderr">>;

const noNetwork = mock(async () => {
  throw new Error("Unexpected network in sent model id tests");
});

function publish(
  provider: "antigravity" | "devin",
  values = { high: HIGH, medium: MEDIUM, low: LOW }
) {
  entries = [catalogEntry(CANONICAL, [connection(provider, BASE, effortMap(values))])];
  _setCatalogEntriesForTest(entries);
}

function recommend(effort: EffortLevel, otherConnection = false) {
  const mappedConnection = entries[0]!.aggregators![0]!;
  recommendations = {
    generationId: GENERATION,
    efforts: {
      [CANONICAL]: {
        default: {
          effort,
          sendableOn: [
            {
              ...mappedConnection.route!,
              externalModelId: otherConnection ? "other-connection-base" : BASE,
              encoding: "model_id_switch",
            },
          ],
        },
      },
    },
  };
}

function sendingLines(spy = logSpy) {
  return spy.mock.calls
    .map(([line]) => line)
    .filter((line) => /^\[(Antigravity|Devin)\] sending model /.test(line));
}

function expectedLine(
  provider: "Antigravity" | "Devin",
  sentId: string,
  requested: string,
  effort: EffortLevel | undefined,
  source: Source
) {
  return `[${provider}] sending model ${sentId} for ${requested} (effort ${effort ?? "none given"}, from ${source})`;
}

function expectDebugLines(expected: string[]) {
  expect(sendingLines()).toEqual(expected);
  expect(sendingLines(stderrSpy)).toEqual([]);
  for (const line of sendingLines()) {
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(BODY_TEXT);
    expect(line).not.toContain("Authorization");
  }
}

beforeEach(() => {
  recommendations = null;
  useLocalBuilder = false;
  served = { servedIds: [HIGH, MEDIUM, LOW], defaultId: HIGH, meta: {} };
  noNetwork.mockClear();
  globalThis.fetch = noNetwork as unknown as typeof fetch;
  _resetCatalogClient();
  invalidateModelDiscovery("antigravity");
  publish("antigravity");

  logSpy = spyOn(logger, "log").mockImplementation(() => {});
  stderrSpy = spyOn(logger, "logStderr").mockImplementation(() => {});
  restore = [
    () => logSpy.mockRestore(),
    () => stderrSpy.mockRestore(),
    stubEffortRecommendations(() => recommendations),
  ];
  const disk = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
    (): DiskCacheV3 => ({
      version: 3,
      lastUpdated: "2026-11-12T00:00:00.000Z",
      catalogGenerationId: GENERATION,
      entries,
      models: [],
      plans: [],
    })
  );
  const token = spyOn(antigravityToken, "getValidAntigravityAccessToken").mockResolvedValue(TOKEN);
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
  const queue = spyOn(GeminiRequestQueue.getInstance(), "enqueue").mockImplementation(
    async (fetchFn) => fetchFn()
  );
  for (const spy of [disk, token, user, models, peek, agent, auth, lists, refresh, queue]) {
    restore.push(() => spy.mockRestore());
  }
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  invalidateModelDiscovery("antigravity");
  _resetCatalogClient();
  globalThis.fetch = originalFetch;
  expect(noNetwork).not.toHaveBeenCalled();
});

async function sendAntigravity(
  builder: Builder,
  options: { requested?: string; effort?: EffortLevel; capacityRetry?: boolean } = {}
) {
  const requested = options.requested ?? BASE;
  useLocalBuilder = builder === "local builder";
  const ag = new AntigravityProviderTransport(requested);
  await ag.refreshAuth();
  const sent: Envelope[] = [];
  const endpoint = ag.getEndpoint();
  const fetchMock = mock(async (input: unknown, init?: RequestInit) => {
    if (input !== endpoint || init?.method !== "POST" || typeof init.body !== "string") {
      throw new Error("Unexpected fetch outside the Antigravity request");
    }
    sent.push(JSON.parse(init.body) as Envelope);
    if (options.capacityRetry && sent.length === 1) {
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
    return new Response("ok", { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const envelope = ag.transformPayload(
    { contents: [{ role: "user", parts: [{ text: BODY_TEXT }] }] },
    options.effort ? { output_config: { effort: options.effort } } : {}
  );
  const headers = await ag.getHeaders();
  const response = await ag.enqueueRequest(() =>
    fetch(endpoint, { method: "POST", headers, body: JSON.stringify(envelope) })
  );
  expect(response.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(options.capacityRetry ? 2 : 1);
  return sent.map(({ model }) => model);
}

describe("Antigravity sent model id debug log", () => {
  for (const builder of BUILDERS) {
    test(`${builder}: request high logs the mapped high id`, async () => {
      expect(await sendAntigravity(builder, { effort: "high" })).toEqual([HIGH]);
      expectDebugLines([expectedLine("Antigravity", HIGH, BASE, "high", "request")]);
    });

    test(`${builder}: matching default medium logs catalog default`, async () => {
      recommend("medium");
      expect(await sendAntigravity(builder)).toEqual([MEDIUM]);
      expectDebugLines([expectedLine("Antigravity", MEDIUM, BASE, "medium", "catalog default")]);
    });

    test(`${builder}: another connection's default high logs medium fallback`, async () => {
      recommend("high", true);
      expect(await sendAntigravity(builder)).toEqual([MEDIUM]);
      expectDebugLines([expectedLine("Antigravity", MEDIUM, BASE, "medium", "medium fallback")]);
    });

    test(`${builder}: exact low id at request high logs exact id`, async () => {
      expect(await sendAntigravity(builder, { requested: LOW, effort: "high" })).toEqual([LOW]);
      expectDebugLines([expectedLine("Antigravity", LOW, LOW, "high", "exact id")]);
    });

    test(`${builder}: unmapped flash logs its served tiered id with none given`, async () => {
      const requested = "gemini-3.8-flash";
      const tiered = `${requested}-tiered`;
      entries = [catalogEntry(requested, [connection("antigravity", requested)])];
      _setCatalogEntriesForTest(entries);
      served = { servedIds: [tiered], defaultId: null, meta: {} };
      expect(await sendAntigravity(builder, { requested })).toEqual([tiered]);
      expectDebugLines([expectedLine("Antigravity", tiered, requested, undefined, "no map")]);
    });

    test(`${builder}: capacity retry logs both sent ids with the primary source`, async () => {
      const retryId = "gemini-3.8-flash-tiered";
      served = { servedIds: [MEDIUM, retryId], defaultId: MEDIUM, meta: {} };
      recommend("medium");
      expect(await sendAntigravity(builder, { capacityRetry: true })).toEqual([MEDIUM, retryId]);
      expectDebugLines([
        expectedLine("Antigravity", MEDIUM, BASE, "medium", "catalog default"),
        expectedLine("Antigravity", retryId, BASE, "medium", "catalog default"),
      ]);
    });

    test(`${builder}: exactly one sending line for one request`, async () => {
      expect(await sendAntigravity(builder, { effort: "high" })).toEqual([HIGH]);
      expect(sendingLines()).toHaveLength(1);
      expect(sendingLines(stderrSpy)).toHaveLength(0);
    });
  }
});

describe("Devin expansion sent model id debug log", () => {
  const UIDS = {
    high: "devin-opus-reasoning-c",
    medium: "devin-opus-reasoning-b",
    low: "devin-opus-reasoning-a",
  };

  function expand(effort?: EffortLevel) {
    const models = (["high", "medium", "low"] as const).map((level) =>
      devinModel(UIDS[level], level, {
        family: BASE,
        groupLabel: "Claude Opus 5.5",
        isDefault: level === "high",
      })
    );
    return new DevinModelResolver().expand(BASE, models.map(devinModelsCatalogEntry), { effort });
  }

  beforeEach(() => {
    publish("devin", UIDS);
  });

  test("request low logs the mapped Devin uid", () => {
    expect(expand("low")).toBe(UIDS.low);
    expectDebugLines([expectedLine("Devin", UIDS.low, BASE, "low", "request")]);
  });

  test("matching default high logs catalog default", () => {
    recommend("high");
    expect(expand()).toBe(UIDS.high);
    expectDebugLines([expectedLine("Devin", UIDS.high, BASE, "high", "catalog default")]);
  });

  test("absent default logs medium fallback", () => {
    expect(expand()).toBe(UIDS.medium);
    expectDebugLines([expectedLine("Devin", UIDS.medium, BASE, "medium", "medium fallback")]);
  });
});
