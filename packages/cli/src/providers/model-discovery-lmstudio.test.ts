/**
 * LM Studio's dynamic models catalog, read through the public discovery entry.
 *
 * LM Studio's OpenAI-compatible `/v1/models` rows carry only `id`, `object` and
 * `owned_by`, so a row there says nothing about whether it is a chat model, and
 * the picker had to ask the cloud models catalog — which does not list a build
 * someone loaded into their own LM Studio. LM Studio's native `/api/v0/models`
 * states a `type` for every row; that is the list the claudish provider
 * `lmstudio` reads.
 *
 * Offline: global `fetch` is replaced per test, the credential authority is
 * spied on and must never be asked, and the discovery cache is cleared around
 * every test.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { credentials } from "../auth/credentials/authority.js";
import { outcomeFromModelsCatalog } from "../model-selector.js";
import {
  type DiscoveredModel,
  discoverProviderModelsCatalog,
  invalidateModelDiscovery,
} from "./model-discovery.js";
import { _clearChatCapabilityIndex, isReportedChatCapable } from "./transport/probe-discovery.js";

const realFetch = globalThis.fetch;
const ENV_NAMES = ["LMSTUDIO_BASE_URL", "LMSTUDIO_API_KEY"] as const;

// Ids the cloud models catalog cannot know: local builds and a private name.
const NATIVE_ROWS = [
  {
    id: "ornith-1.0-35b",
    object: "model",
    type: "llm",
    publisher: "local",
    state: "loaded",
    max_context_length: 262144,
    loaded_context_length: 213176,
  },
  {
    id: "my-local-build-xyz",
    object: "model",
    type: "vlm",
    publisher: "local",
    state: "not-loaded",
    max_context_length: 131072,
  },
  {
    id: "my-local-embedder-xyz",
    object: "model",
    type: "embeddings",
    publisher: "local",
    state: "not-loaded",
    max_context_length: 8192,
  },
  {
    id: "my-local-av-xyz",
    object: "model",
    type: "AudioVideo",
    publisher: "local",
    state: "not-loaded",
  },
];

// What LM Studio's OpenAI-compatible list really answers: no type, no window.
const OPENAI_ROWS = NATIVE_ROWS.map((row) => ({
  id: row.id,
  object: "model",
  owned_by: "organization_owner",
}));

interface Recorded {
  url: string;
  headers: Headers;
}

let requests: Recorded[];
let savedEnv: Record<string, string | undefined>;
let authoritySpy: ReturnType<typeof spyOn>;

/** Install a fetch that records every request and answers by path. */
function serve(answer: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    return answer(url);
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** LM Studio as it is today: both lists present. */
function lmStudioServer(url: string): Response {
  if (url.endsWith("/api/v0/models")) return json({ object: "list", data: NATIVE_ROWS });
  if (url.endsWith("/v1/models")) return json({ object: "list", data: OPENAI_ROWS });
  return new Response("not found", { status: 404 });
}

function servedModels(
  outcome: Awaited<ReturnType<typeof discoverProviderModelsCatalog>>
): DiscoveredModel[] {
  expect(outcome.kind).toBe("served");
  return outcome.kind === "served" ? outcome.models : [];
}

function byId(models: DiscoveredModel[], id: string): DiscoveredModel | undefined {
  return models.find((model) => model.id === id);
}

beforeEach(() => {
  // The chat-capability index is memoized per process, and this file fills it from ids the cloud models catalog does not list.
  _clearChatCapabilityIndex();
  invalidateModelDiscovery();
  requests = [];
  savedEnv = {};
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  authoritySpy = spyOn(credentials, "getRequestAuth").mockImplementation(async () => {
    throw new Error("a local claudish provider must not ask the credential authority");
  });
  globalThis.fetch = mock(async () => {
    throw new Error("Unexpected fetch call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  _clearChatCapabilityIndex();
  invalidateModelDiscovery();
  globalThis.fetch = realFetch;
  authoritySpy.mockRestore();
  for (const name of ENV_NAMES) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("lmstudio dynamic models catalog: the native list and its type", () => {
  // REGRESSION: LM Studio picker hides models the cloud models catalog does not list

  test("reads /api/v0/models and takes each row's chat statement from its type", async () => {
    serve(lmStudioServer);

    const models = servedModels(await discoverProviderModelsCatalog("lmstudio"));

    expect(requests.length).toBe(1);
    expect(requests[0]?.url).toBe("http://localhost:1234/api/v0/models");
    expect(models.map((m) => m.id)).toEqual([
      "ornith-1.0-35b",
      "my-local-build-xyz",
      "my-local-embedder-xyz",
      "my-local-av-xyz",
    ]);
    expect(byId(models, "ornith-1.0-35b")?.reported).toBe("chat");
    expect(byId(models, "my-local-build-xyz")?.reported).toBe("chat");
    expect(byId(models, "my-local-embedder-xyz")?.reported).toBe("not-chat");
    expect(byId(models, "my-local-av-xyz")?.reported).toBeUndefined();
  });

  test("the chat-model filter keeps llm and vlm rows the cloud models catalog does not list, and drops the embeddings row", async () => {
    serve(lmStudioServer);

    const models = servedModels(await discoverProviderModelsCatalog("lmstudio"));
    const kept = models.filter((m) => isReportedChatCapable(m.id, m.reported)).map((m) => m.id);

    expect(kept.sort()).toEqual(["my-local-build-xyz", "ornith-1.0-35b"]);
  });

  test("the picker builds a row for every chat model LM Studio reports", async () => {
    serve(lmStudioServer);

    const outcome = outcomeFromModelsCatalog(
      "lmstudio",
      "LM Studio",
      await discoverProviderModelsCatalog("lmstudio"),
      []
    );

    expect(outcome.kind).toBe("rows");
    if (outcome.kind !== "rows") return;
    expect(outcome.servedCount).toBe(4);
    expect(outcome.chatCount).toBe(2);
    expect(outcome.rows.map((row) => row.id).sort()).toEqual([
      "my-local-build-xyz",
      "ornith-1.0-35b",
    ]);
  });

  test("context window: loaded_context_length when the row has it, else max_context_length", async () => {
    serve(lmStudioServer);

    const models = servedModels(await discoverProviderModelsCatalog("lmstudio"));

    expect(byId(models, "ornith-1.0-35b")?.contextWindow).toBe(213176);
    expect(byId(models, "my-local-build-xyz")?.contextWindow).toBe(131072);
    expect(byId(models, "my-local-av-xyz")?.contextWindow).toBeUndefined();
  });
});

describe("lmstudio dynamic models catalog: fallback and failure kinds", () => {
  // REGRESSION: LM Studio picker hides models the cloud models catalog does not list

  test("a 404 on /api/v0/models retries /v1/models once and is served without a chat statement", async () => {
    serve((url) =>
      url.endsWith("/v1/models")
        ? json({ object: "list", data: OPENAI_ROWS })
        : new Response("Unexpected endpoint", { status: 404 })
    );

    const models = servedModels(await discoverProviderModelsCatalog("lmstudio"));

    expect(requests.map((r) => r.url)).toEqual([
      "http://localhost:1234/api/v0/models",
      "http://localhost:1234/v1/models",
    ]);
    expect(models.length).toBe(4);
    expect(models.map((m) => m.reported)).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("a thrown fetch is unreachable, with exactly one request and no /v1 retry", async () => {
    serve(() => {
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    });

    const outcome = await discoverProviderModelsCatalog("lmstudio");

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.kind).toBe("unreachable");
    expect(outcome.failure.endpoint).toBe("http://localhost:1234/api/v0/models");
    expect(requests.map((r) => r.url)).toEqual(["http://localhost:1234/api/v0/models"]);
  });

  test("a 401 is unauthorized, with no /v1 retry", async () => {
    serve(() => new Response('{"error":"invalid api key"}', { status: 401 }));

    const outcome = await discoverProviderModelsCatalog("lmstudio");

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.kind).toBe("unauthorized");
    expect(outcome.failure.status).toBe(401);
    expect(outcome.failure.endpoint).toBe("http://localhost:1234/api/v0/models");
    expect(requests.map((r) => r.url)).toEqual(["http://localhost:1234/api/v0/models"]);
  });
});

describe("lmstudio dynamic models catalog: base URL and key from the environment", () => {
  // REGRESSION: LM Studio picker hides models the cloud models catalog does not list

  test("LMSTUDIO_API_KEY is sent as a Bearer header on the /api/v0/models request, without the credential authority", async () => {
    process.env.LMSTUDIO_API_KEY = "lm-test-key-123";
    serve(lmStudioServer);

    await discoverProviderModelsCatalog("lmstudio");

    const native = requests.find((r) => r.url.endsWith("/api/v0/models"));
    expect(native?.url).toBe("http://localhost:1234/api/v0/models");
    expect(native?.headers.get("Authorization")).toBe("Bearer lm-test-key-123");
    expect(authoritySpy).toHaveBeenCalledTimes(0);
  });

  test("LMSTUDIO_BASE_URL sends the request to that host", async () => {
    process.env.LMSTUDIO_BASE_URL = "http://studio.lan.invalid:4321/";
    serve(lmStudioServer);

    await discoverProviderModelsCatalog("lmstudio");

    expect(requests.map((r) => r.url)).toEqual(["http://studio.lan.invalid:4321/api/v0/models"]);
  });
});
