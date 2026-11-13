import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Context } from "hono";
import type { BaseAPIFormat, EffortLevel } from "../../adapters/base-api-format.js";
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
type RequestOptions = { signal?: AbortSignal; request?: unknown };

let restore: Array<() => void>;
let logSpy: ReturnType<typeof spyOn<typeof logger, "log">>;
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in request-scoped retry tests");
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
  logSpy = spyOn(logger, "log").mockImplementation(() => {});
  const stderr = spyOn(logger, "logStderr").mockImplementation(() => {});
  const disk = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
    (): DiskCacheV3 => ({
      version: 3,
      lastUpdated: "2026-11-12T00:00:00.000Z",
      catalogGenerationId: "request-scoped-retry-test-data",
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
    logSpy,
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

function transform(transport: AntigravityProviderTransport, text: string, effort?: EffortLevel) {
  return transport.transformPayload(
    { contents: [{ role: "user", parts: [{ text }] }] },
    effort ? { output_config: { effort } } : {}
  ) as Envelope;
}

async function setupTransport(
  options: { holdPrimary?: boolean; exhaustFirstRetry?: boolean } = {}
) {
  const transport = new AntigravityProviderTransport(BASE);
  await transport.refreshAuth();
  const endpoint = transport.getEndpoint();
  const headers = await transport.getHeaders();
  const sent: Envelope[] = [];
  const primaryStarted = deferred<void>();
  const primaryResponse = deferred<Response>();
  const fetchMock = mock(async (input: unknown, init?: RequestInit) => {
    if (input !== endpoint || init?.method !== "POST" || typeof init.body !== "string") {
      throw new Error("Unexpected fetch outside the Antigravity request");
    }
    sent.push(JSON.parse(init.body) as Envelope);
    if (sent.length === 1) {
      primaryStarted.resolve();
      return options.holdPrimary ? primaryResponse.promise : capacityResponse();
    }
    if (sent.length === 2 && options.exhaustFirstRetry) return capacityResponse();
    return new Response("ok", { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const send = (envelope: Envelope, scoped = true) => {
    // The optional request field can be exercised before the interface gains it.
    const opts: RequestOptions | undefined = scoped ? { request: envelope } : undefined;
    return transport.enqueueRequest(
      () => fetch(endpoint, { method: "POST", headers, body: JSON.stringify(envelope) }),
      opts
    );
  };
  return { transport, sent, send, primaryStarted, primaryResponse };
}

function expectOwnRetry(sent: Envelope[]) {
  expect(JSON.stringify(sent[1]!.request)).toContain("A-body");
  expect(JSON.stringify(sent[1]!.request)).not.toContain("B-body");
  const lines = logSpy.mock.calls
    .map(([line]) => line)
    .filter((line) => line.startsWith("[Antigravity] sending model "));
  expect(lines.at(-1)).toBe(
    `[Antigravity] sending model ${sent[1]!.model} for ${BASE} (effort high, from request)`
  );
}

describe("Antigravity request-scoped capacity retries", () => {
  test("retry retains A's body and request effort when B transforms before A enqueues", async () => {
    const { transport, sent, send } = await setupTransport();
    const requestA = transform(transport, "A-body", "high");
    const requestB = transform(transport, "B-body");
    expect(requestA.model).toBe(HIGH);
    expect(requestB.model).toBe(MEDIUM);

    const response = await send(requestA);

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
    expectOwnRetry(sent);
  });

  test("retry retains A's body and request effort when B transforms during A's primary fetch", async () => {
    const { transport, sent, send, primaryStarted, primaryResponse } = await setupTransport({
      holdPrimary: true,
    });
    const requestA = transform(transport, "A-body", "high");
    const pendingA = send(requestA);
    await primaryStarted.promise;
    transform(transport, "B-body");
    primaryResponse.resolve(capacityResponse());
    const response = await pendingA;

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
    expectOwnRetry(sent);
  });

  test("retry candidates exclude A's high sent id rather than B's medium sent id", async () => {
    const { transport, sent, send } = await setupTransport({ exhaustFirstRetry: true });
    const requestA = transform(transport, "A-body", "high");
    transform(transport, "B-body");

    const response = await send(requestA);
    const retryIds = sent.slice(1).map(({ model }) => model);

    expect(response.status).toBe(200);
    expect(sent[0]!.model).toBe(HIGH);
    expect(retryIds).not.toContain(HIGH);
    expect(retryIds).toContain(MEDIUM);
    expect(retryIds).toEqual([MEDIUM, LOW]);
  });

  test("ComposedHandler passes each request's exact transformed object on primary and parameter-recovery enqueues", async () => {
    const headersStarted = deferred<void>();
    const releaseHeaders = deferred<void>();
    const transformed = new Map<string, object>();
    const enqueued: unknown[] = [];
    const attempts = new Map<string, number>();
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
      enqueueRequest: async (fetchFn, opts?: RequestOptions) => {
        enqueued.push(opts?.request);
        return fetchFn();
      },
    };
    globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
      if (input !== transport.getEndpoint() || typeof init?.body !== "string") {
        throw new Error("Unexpected fetch outside the composed request");
      }
      const key = marker(JSON.parse(init.body));
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      return new Response(JSON.stringify({ error: { message: "Rejected parameter" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handler = new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8080, {});
    const adapterSeam = handler as unknown as {
      getAdapter(): BaseAPIFormat;
      modelAdapter?: BaseAPIFormat;
    };
    const adapter = adapterSeam.getAdapter();
    adapter.recoverFromRejection = (payload: object) => ({
      payload: { ...payload },
      note: "remove rejected parameter",
    });
    adapterSeam.modelAdapter = adapter;
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
    expect(attempts).toEqual(
      new Map([
        ["B", 2],
        ["A", 2],
      ])
    );
    expect(enqueued).toHaveLength(4);
    for (const [index, key] of ["B", "B", "A", "A"].entries()) {
      expect(enqueued[index]).toBe(transformed.get(key));
    }
  });

  test("enqueue without request preserves the most recent transform's payload", async () => {
    const { transport, sent, send } = await setupTransport();
    const requestA = transform(transport, "A-body", "high");
    transform(transport, "B-body");

    const response = await send(requestA, false);

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1]!.request)).toContain("B-body");
    expect(JSON.stringify(sent[1]!.request)).not.toContain("A-body");
    expect(sent[1]!.model).toBe(HIGH);
  });
});
