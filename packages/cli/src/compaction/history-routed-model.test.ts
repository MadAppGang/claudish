import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../providers/catalog-client.js";
import { createProxyServer } from "../proxy-server.js";
import type { ProxyServer } from "../types.js";
import { DEFAULT_COMPACTION_SETTINGS } from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor, catalogContextWindow } from "./history.js";
import type { CompactionRuntime } from "./runtime.js";
import { CompactionStore } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

// Installed per file and restored: bun runs every test file in one process.
const realFetch = globalThis.fetch;
const localFetch = (input: RequestInfo | URL, init?: RequestInit) => realFetch(input, init);
beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error(`Unexpected network access: ${url.host}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const session = "routed-model-session";
const REQUESTED = "claude-sonnet-test-9";
const TARGET = "ollama@tiny-local-test";

let root: string;
let upstream: ReturnType<typeof Bun.serve>;
let proxy: ProxyServer | undefined;
const savedOllama = process.env.OLLAMA_BASE_URL;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-routed-"));
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ error: "test upstream" }, { status: 500 }),
  });
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${upstream.port}`;
});
afterEach(async () => {
  if (proxy) await proxy.shutdown();
  proxy = undefined;
  upstream.stop(true);
  if (savedOllama === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = savedOllama;
  _resetCatalogClient();
  rmSync(root, { recursive: true, force: true });
});

function runtime(windowOf: (model: unknown) => number | undefined) {
  const asked: unknown[] = [];
  let summaryCalls = 0;
  const client = new CompactionClient({
    apiKey: "FAKE_ROUTED_VALUE_0000",
    model: "test-compaction-model",
    warn() {},
    record() {},
    fetchImpl: (async () => {
      summaryCalls += 1;
      return Response.json({ error: { message: "test" } }, { status: 500 });
    }) as unknown as typeof fetch,
  });
  const store = new CompactionStore(root);
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    enabled: true,
    toolOutputs: { ...DEFAULT_COMPACTION_SETTINGS.toolOutputs, enabled: false },
    history: { enabled: true, precomputeAt: 0.6, applyAt: 0.8 },
  };
  const history = new HistoryCompactor({
    store,
    client,
    settings: settings.history,
    contextWindowOf: (model) => {
      asked.push(model);
      return windowOf(model);
    },
    autoCompactWindow: () => undefined,
  });
  const rt: CompactionRuntime = {
    settings,
    model: "test-compaction-model",
    client,
    store,
    toolOutputs: new ToolOutputCompactor({ store, client, settings: settings.toolOutputs }),
    history,
  };
  return { rt, asked, summaryCalls: () => summaryCalls, history };
}

function body() {
  return {
    model: REQUESTED,
    max_tokens: 16,
    metadata: {
      user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: session }),
    },
    messages: [
      { role: "user", content: "old ".repeat(9000) },
      { role: "assistant", content: "answer" },
      { role: "user", content: "next turn" },
    ],
  };
}

test("history takes its window from the routed target, not the requested Claude name", async () => {
  // The requested Claude name has a small window that this request would
  // pass; the target the proxy routes to has none, so history is off.
  const r = runtime((model) => (model === REQUESTED ? 10_000 : undefined));
  proxy = await createProxyServer(
    0,
    undefined,
    undefined,
    false,
    undefined,
    { sonnet: TARGET },
    {
      quiet: true,
      hooks: false,
      compaction: r.rt,
    }
  );
  await localFetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body()),
  });
  await r.history.whenIdle();
  expect(r.asked).toEqual([TARGET]);
  expect(r.summaryCalls()).toBe(0);
});

test("history uses the --model target when no role mapping applies", async () => {
  const r = runtime(() => undefined);
  proxy = await createProxyServer(0, undefined, TARGET, false, undefined, undefined, {
    quiet: true,
    hooks: false,
    compaction: r.rt,
  });
  await localFetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body()),
  });
  expect(r.asked).toEqual([TARGET]);
});

test("a [1m] suffix is looked up as the model it selects", () => {
  _resetCatalogClient();
  _setCatalogEntriesForTest([
    {
      modelId: REQUESTED,
      provider: "anthropic",
      aliases: [],
      contextWindow: 234_567,
      aggregators: [],
    } as never,
  ]);
  expect(catalogContextWindow(REQUESTED)).toBe(234_567);
  expect(catalogContextWindow(`${REQUESTED}[1m]`)).toBe(234_567);
  expect(catalogContextWindow(`${REQUESTED}[1M]`)).toBe(234_567);
});
