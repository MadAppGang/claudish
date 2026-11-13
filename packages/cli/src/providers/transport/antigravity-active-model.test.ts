import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Context } from "hono";
import type { EffortLevel } from "../../adapters/base-api-format.js";
import * as antigravityToken from "../../auth/antigravity-token.js";
import * as antigravityUser from "../../auth/antigravity-user.js";
import { credentials } from "../../auth/credentials/authority.js";
import { ComposedHandler } from "../../handlers/composed-handler.js";
import { GeminiRequestQueue } from "../../handlers/shared/gemini-queue.js";
import * as logger from "../../logger.js";
import * as allModelsCache from "../all-models-cache.js";
import type { DiskCacheV3 } from "../all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../catalog-client.js";
import * as dynamicModelsCatalog from "../dynamic-models-catalog.js";
import { invalidateModelDiscovery } from "../model-discovery.js";
import {
  catalogEntry,
  connection,
  effortMap,
  stubEffortRecommendations,
} from "../test-helpers/model-id-effort.js";
import { AntigravityProviderTransport } from "./antigravity.js";
import type { ProviderTransport } from "./types.js";

// Load the authority before the concrete credential imports its transport.
const { AntigravityCredentialProvider } = await import(
  "../../auth/credentials/antigravity-credential.js"
);

const BASE = "claude-opus-5-5";
const HIGH = `${BASE}-high`;
const MEDIUM = `${BASE}-medium`;
const LOW = `${BASE}-low`;
const originalFetch = globalThis.fetch;
type Envelope = { model: string; request: unknown };
type ActiveModelTransport = { getActiveModelName(request?: unknown): string | undefined };

let restore: Array<() => void>;
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in active model tests");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function capacityResponse() {
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

beforeEach(() => {
  noNetwork.mockClear();
  globalThis.fetch = noNetwork as unknown as typeof fetch;
  _resetCatalogClient();
  invalidateModelDiscovery("antigravity");
  const entries = [
    catalogEntry("claude-opus-5.5", [
      connection("antigravity", BASE, effortMap({ high: HIGH, medium: MEDIUM, low: LOW })),
    ]),
  ];
  const served = { servedIds: [HIGH, MEDIUM, LOW], defaultId: HIGH, meta: {} };
  _setCatalogEntriesForTest(entries);
  const log = spyOn(logger, "log").mockImplementation(() => {});
  const stderr = spyOn(logger, "logStderr").mockImplementation(() => {});
  const disk = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
    (): DiskCacheV3 => ({
      version: 3,
      lastUpdated: "2026-11-12T00:00:00.000Z",
      catalogGenerationId: "active-model-test-data",
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
  const models = spyOn(antigravityUser, "getServedAntigravityModels").mockResolvedValue(served);
  const peek = spyOn(antigravityUser, "peekServedAntigravityModels").mockReturnValue(served);
  const agent = spyOn(antigravityUser, "buildAntigravityUserAgent").mockReturnValue(
    "unit-test-agent"
  );
  const auth = spyOn(credentials, "getRequestAuth").mockImplementation(async (provider, ctx) => {
    if (provider !== "antigravity") throw new Error(`Unexpected credential request: ${provider}`);
    return new AntigravityCredentialProvider().getRequestAuth(ctx);
  });
  const lists = spyOn(dynamicModelsCatalog, "readAccountModelsList").mockResolvedValue(null);
  const refresh = spyOn(dynamicModelsCatalog, "refreshAccountModelsList").mockResolvedValue({
    kind: "skipped",
    reason: "no-credential",
  });
  const queue = spyOn(GeminiRequestQueue.getInstance(), "enqueue").mockImplementation(
    async (fetchFn) => fetchFn()
  );
  restore = [stubEffortRecommendations()];
  for (const spy of [
    log,
    stderr,
    disk,
    token,
    user,
    models,
    peek,
    agent,
    auth,
    lists,
    refresh,
    queue,
  ]) {
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

function transform(transport: AntigravityProviderTransport, text: string, effort: EffortLevel) {
  return transport.transformPayload(
    { contents: [{ role: "user", parts: [{ text }] }] },
    { output_config: { effort } }
  ) as Envelope;
}

async function setupTransport(retryB: boolean) {
  const transport = new AntigravityProviderTransport(BASE);
  await transport.refreshAuth();
  const endpoint = transport.getEndpoint();
  const sent: Envelope[] = [];
  let primaryCount = 0;
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    if (input !== endpoint || init?.method !== "POST" || typeof init.body !== "string") {
      throw new Error("Unexpected fetch outside the Antigravity request");
    }
    sent.push(JSON.parse(init.body) as Envelope);
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const send = (request: Envelope) =>
    transport.enqueueRequest(
      async () => {
        sent.push(request);
        primaryCount++;
        return primaryCount === 1 || retryB
          ? capacityResponse()
          : new Response("ok", { status: 200 });
      },
      { request }
    );
  // Exercise the request argument without requiring the interface change first.
  const active = transport as unknown as ActiveModelTransport;
  return { transport, sent, send, active };
}

describe("Antigravity request-scoped active model", () => {
  test("A retains its retry id after B enqueues without a retry", async () => {
    const { transport, sent, send, active } = await setupTransport(false);
    const requestA = transform(transport, "A-body", "high");
    expect((await send(requestA)).status).toBe(200);
    expect(sent.map(({ model }) => model)).toEqual([HIGH, MEDIUM]);
    expect(active.getActiveModelName(requestA)).toBe(MEDIUM);

    const requestB = transform(transport, "B-body", "medium");
    expect((await send(requestB)).status).toBe(200);
    expect(sent.map(({ model }) => model)).toEqual([HIGH, MEDIUM, MEDIUM]);
    expect(active.getActiveModelName(requestB)).toBeUndefined();
    expect(active.getActiveModelName(requestA)).toBe(MEDIUM);
  });

  test("A and B retain their own distinct successful retry ids", async () => {
    const { transport, sent, send, active } = await setupTransport(true);
    const requestA = transform(transport, "A-body", "high");
    expect((await send(requestA)).status).toBe(200);
    expect(active.getActiveModelName(requestA)).toBe(MEDIUM);

    const requestB = transform(transport, "B-body", "medium");
    expect((await send(requestB)).status).toBe(200);
    expect(sent.map(({ model }) => model)).toEqual([HIGH, MEDIUM, MEDIUM, HIGH]);
    expect(active.getActiveModelName(requestB)).toBe(HIGH);
    expect(active.getActiveModelName(requestA)).toBe(MEDIUM);
  });

  test("ComposedHandler reads each active model with its own exact transformed object", async () => {
    const headersStarted = deferred<void>();
    const releaseHeaders = deferred<void>();
    const transformed = new Map<string, object>();
    const activeReads: unknown[] = [];
    const marker = (value: unknown) => (JSON.stringify(value).includes("A-body") ? "A" : "B");
    const transport: ProviderTransport = {
      name: "sakana",
      displayName: "Sakana Fugu",
      streamFormat: "openai-sse",
      getEndpoint: () => "http://localhost/v1/chat/completions",
      transformPayload: (payload, inbound) => {
        const result = { ...payload };
        transformed.set(marker(inbound), result);
        return result;
      },
      getHeaders: async (inbound) => {
        if (marker(inbound) === "A") {
          headersStarted.resolve();
          await releaseHeaders.promise;
        }
        return {};
      },
      enqueueRequest: async (fetchFn) => fetchFn(),
      getActiveModelName: (request?: unknown) => {
        activeReads.push(request);
        return undefined;
      },
    };
    globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
      if (input !== transport.getEndpoint() || typeof init?.body !== "string") {
        throw new Error("Unexpected fetch outside the composed request");
      }
      return new Response(JSON.stringify({ error: { message: "Rejected parameter" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handler = new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8080, {});
    const context = () =>
      ({
        req: { header: () => ({}) },
        header: () => {},
        body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
        json: (body: unknown, status?: number) =>
          new Response(JSON.stringify(body), { status: status ?? 200 }),
      }) as unknown as Context;
    const inbound = (text: string) => ({
      model: "fugu-ultra",
      max_tokens: 16,
      messages: [{ role: "user", content: text }],
    });

    const pendingA = handler.handle(context(), inbound("A-body"));
    await headersStarted.promise;
    try {
      await handler.handle(context(), inbound("B-body"));
    } finally {
      releaseHeaders.resolve();
    }
    await pendingA;

    expect(transformed.size).toBe(2);
    expect(transformed.get("A")).not.toBe(transformed.get("B"));
    expect(activeReads).toHaveLength(2);
    expect(activeReads[0]).toBe(transformed.get("B"));
    expect(activeReads[1]).toBe(transformed.get("A"));
  });
});
