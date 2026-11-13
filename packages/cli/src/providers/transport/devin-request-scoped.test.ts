import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Context } from "hono";
import type { DevinRequestPayload } from "../../adapters/devin-api-format.js";
import { credentials } from "../../auth/credentials/authority.js";
import { ComposedHandler } from "../../handlers/composed-handler.js";
import * as logger from "../../logger.js";
import * as allModelsCache from "../all-models-cache.js";
import type { DiskCacheV3 } from "../all-models-cache.js";
import * as devinCredentials from "../devin/devin-credentials.js";
import * as devinModels from "../devin/devin-models.js";
import * as resolver from "../devin/model-id-resolver.js";
import {
  FRAME_FLAG_END_OF_STREAM,
  FRAME_HEADER_BYTES,
  envelope,
  parseTLV,
  readString,
} from "../devin/proto-codec.js";
import { devinModel, stubEffortRecommendations } from "../test-helpers/model-id-effort.js";
import { DevinProviderTransport } from "./devin.js";
import type { ProviderTransport } from "./types.js";

const BASE = "synthetic-base";
const LOW = "alpha-low";
const HIGH = "beta-high";
const MESSAGE = "The requested model is unavailable";
const originalFetch = globalThis.fetch;
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in request-scoped Devin tests");
});
let restore: Array<() => void>;

type ScopedDevin = {
  serializeBody(
    payload: DevinRequestPayload,
    request?: unknown
  ): {
    body: Uint8Array<ArrayBuffer>;
    contentType: string;
  };
  getActiveModelName(request?: unknown): string | undefined;
  rewriteInStreamError(code: string, message: string, request?: unknown): string;
};

beforeEach(() => {
  noNetwork.mockClear();
  globalThis.fetch = noNetwork as unknown as typeof fetch;
  restore = [stubEffortRecommendations()];
  const spies = [
    spyOn(logger, "log").mockImplementation(() => {}),
    spyOn(logger, "logStderr").mockImplementation(() => {}),
    spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
      (): DiskCacheV3 => ({
        version: 3,
        lastUpdated: "2026-11-12T00:00:00.000Z",
        catalogGenerationId: "devin-request-scoped-test-data",
        entries: [],
        models: [],
        plans: [],
      })
    ),
    spyOn(devinCredentials, "readDevinApiKey").mockReturnValue("unit-test-key"),
    spyOn(credentials, "getRequestAuth").mockResolvedValue({ headers: {} }),
    spyOn(devinModels, "getServedDevinModels").mockResolvedValue([
      devinModel("beta-available", "high", { family: "beta-family" }),
      devinModel("alpha-available", "low", { family: "alpha-family" }),
    ]),
    // Isolate uid selection: neither resolved uid is served, so both errors rewrite.
    spyOn(resolver, "resolveDevinModelUid").mockImplementation((_base, effort) =>
      effort === "low" ? LOW : HIGH
    ),
  ];
  for (const spy of spies) restore.push(() => spy.mockRestore());
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  globalThis.fetch = originalFetch;
  expect(noNetwork).not.toHaveBeenCalled();
});

function request(effort: "low" | "high"): DevinRequestPayload {
  return {
    modelUid: BASE,
    effort,
    messages: [{ role: "user", text: `${effort}-body` }],
  };
}

async function serializePair(scoped = true) {
  const concrete = new DevinProviderTransport(BASE);
  await concrete.refreshAuth();
  const transport = concrete as unknown as ScopedDevin;
  const a = request("low");
  const b = request("high");
  const sent = [a, b].map((payload) => {
    const { body } = scoped
      ? transport.serializeBody(payload, payload)
      : transport.serializeBody(payload);
    return parseTLV(body.subarray(FRAME_HEADER_BYTES))
      .filter((field) => field.no === 21)
      .map(readString);
  });
  expect(sent).toEqual([[LOW], [HIGH]]);
  return { transport, a, b };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Devin request-scoped resolved uid", () => {
  test("A's error names A's uid and prioritizes A's families after B serializes", async () => {
    const { transport, a, b } = await serializePair();
    const message = transport.rewriteInStreamError("permission_denied", MESSAGE, a);

    expect(message).toContain(`\`${LOW}\` is not served`);
    expect(message).not.toContain(`\`${HIGH}\``);
    expect(message).toContain("Available families: alpha-family, beta-family.");
    expect(message).toContain(`(Upstream said: ${MESSAGE})`);
    expect(transport.rewriteInStreamError("permission_denied", MESSAGE, b)).toContain(
      `\`${HIGH}\` is not served`
    );
  });

  test("active model names retain each request's resolved uid after B serializes", async () => {
    const { transport, a, b } = await serializePair();

    expect(transport.getActiveModelName(a)).toBe(LOW);
    expect(transport.getActiveModelName(b)).toBe(HIGH);
  });

  test("ComposedHandler shares one exact object across hooks without transformPayload", async () => {
    const headersStarted = deferred();
    const releaseHeaders = deferred();
    const serialized = new Map<string, { payload: object; request: unknown }>();
    const enqueued: unknown[] = [];
    const active: unknown[] = [];
    const rewritten: unknown[] = [];
    const marker = (value: unknown) => (JSON.stringify(value).includes("A-body") ? "A" : "B");
    const transport: ProviderTransport & {
      rewriteInStreamError(code: string, message: string, request?: unknown): string;
    } = {
      name: "sakana",
      displayName: "Sakana Fugu",
      streamFormat: "connect-proto",
      overrideStreamFormat: () => "connect-proto",
      getEndpoint: () => "http://localhost/devin-request-test",
      getHeaders: async (inbound) => {
        if (marker(inbound) === "A") {
          headersStarted.resolve();
          await releaseHeaders.promise;
        }
        return {};
      },
      serializeBody: (payload: object, value?: unknown) => {
        serialized.set(marker(payload), { payload, request: value });
        return { body: JSON.stringify(payload), contentType: "application/json" };
      },
      enqueueRequest: async (fetchFn, opts) => {
        enqueued.push(opts?.request);
        return fetchFn();
      },
      getActiveModelName: (value) => {
        active.push(value);
        return undefined;
      },
      rewriteInStreamError: (_code, message, value) => {
        rewritten.push(value);
        return message;
      },
    };
    globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
      if (input !== transport.getEndpoint() || typeof init?.body !== "string") {
        throw new Error("Unexpected fetch outside the composed request");
      }
      return new Response(
        envelope(
          new TextEncoder().encode(
            JSON.stringify({ error: { code: "permission_denied", message: MESSAGE } })
          ),
          FRAME_FLAG_END_OF_STREAM
        ),
        { headers: { "Content-Type": "application/connect+proto" } }
      );
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
      stream: true,
      messages: [{ role: "user", content: text }],
    });

    const pendingA = handler.handle(context(), inbound("A-body"));
    await headersStarted.promise;
    let responseB: Response;
    try {
      responseB = await handler.handle(context(), inbound("B-body"));
    } finally {
      releaseHeaders.resolve();
    }
    const responseA = await pendingA;
    expect(responseA.status).toBe(400);
    expect(responseB.status).toBe(400);
    expect(transport.transformPayload).toBeUndefined();
    expect(serialized.size).toBe(2);
    expect(enqueued).toHaveLength(2);
    expect(active).toHaveLength(2);
    expect(rewritten).toHaveLength(2);
    const a = serialized.get("A")!;
    const b = serialized.get("B")!;
    expect(a.payload).not.toBe(b.payload);
    for (const [index, entry] of [b, a].entries()) {
      expect(entry.request).toBe(entry.payload);
      expect(enqueued[index]).toBe(entry.payload);
      expect(active[index]).toBe(entry.payload);
      expect(rewritten[index]).toBe(entry.payload);
    }
  });

  test("calls without a request keep the most recently serialized uid", async () => {
    const { transport, a } = await serializePair(false);

    expect(transport.getActiveModelName()).toBe(HIGH);
    const message = transport.rewriteInStreamError("permission_denied", MESSAGE);
    expect(message).toContain(`\`${HIGH}\` is not served`);
    expect(message).toContain("Available families: beta-family, alpha-family.");
    expect(message).not.toContain(`\`${LOW}\``);

    transport.serializeBody(a);
    expect(transport.getActiveModelName()).toBe(LOW);
    expect(transport.rewriteInStreamError("permission_denied", MESSAGE)).toContain(
      `\`${LOW}\` is not served`
    );
  });
});
