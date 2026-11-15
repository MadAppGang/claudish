import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../proxy-server.js";
import { redactSigningValues } from "../redact.js";
import { DEFAULT_COMPACTION_SETTINGS } from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor } from "./history.js";
import { type CompactionRuntime, prepareCompaction } from "./runtime.js";
import { CompactionStore } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

const KEY = "FAKE-shutdown-value-0123456789abc";
const MODEL = "claude-test-shutdown-9";
const session = "shutdown-session";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-shutdown-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fetch that answers only when its request is aborted. */
function hangingFetch() {
  let started = 0;
  let aborted = 0;
  const fetchImpl = ((request: Request) => {
    started += 1;
    return new Promise<Response>((_, reject) => {
      request.signal.addEventListener("abort", () => {
        aborted += 1;
        reject(new Error("aborted"));
      });
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, started: () => started, aborted: () => aborted };
}

function bigPayload() {
  return {
    model: MODEL,
    messages: [
      { role: "user", content: "old ".repeat(9000) },
      { role: "assistant", content: "answer" },
      { role: "user", content: "next turn" },
    ],
  };
}

test("shutdown aborts a background summary, records nothing, and releases the key's lease", async () => {
  const upstream = hangingFetch();
  const runtime = await prepareCompaction({
    settings: { ...DEFAULT_COMPACTION_SETTINGS, enabled: true, model: MODEL },
    credentials: {
      resolveForUse: async () => ({ state: "present", key: KEY, source: "test" }),
    },
    storeRoot: root,
    warn() {},
    record() {},
    fetchImpl: upstream.fetchImpl,
  });
  if (!runtime) throw new Error("runtime expected");
  expect(redactSigningValues(`x ${KEY} y`)).not.toContain(KEY);

  expect(runtime.history.compact(bigPayload(), session, "test@window").precomputeStarted).toBe(
    false
  );
  // A window is needed to start a summary: use a compactor on the same client.
  const history = new HistoryCompactor({
    store: runtime.store,
    client: runtime.client,
    settings: runtime.settings.history,
    contextWindowOf: () => 10_000,
    autoCompactWindow: () => undefined,
  });
  (runtime as { history: HistoryCompactor }).history = history;
  expect(history.compact(bigPayload(), session).precomputeStarted).toBe(true);
  await Bun.sleep(5);
  expect(upstream.started()).toBe(1);

  expect(typeof runtime.shutdown).toBe("function");
  await runtime.shutdown?.();
  expect(upstream.aborted()).toBe(1);
  expect(runtime.store.list(session)).toEqual([]);
  expect(new CompactionStore(root).list(session)).toEqual([]);
  expect(redactSigningValues(`x ${KEY} y`)).toContain(KEY);
  // Nothing starts after shutdown.
  expect(history.compact(bigPayload(), session).precomputeStarted).toBe(false);
});

test("the proxy's shutdown shuts the compaction runtime down", async () => {
  let shutdowns = 0;
  const client = new CompactionClient({
    apiKey: "FAKE_PROXY_SHUTDOWN_0000",
    model: MODEL,
    warn() {},
    record() {},
    fetchImpl: hangingFetch().fetchImpl,
  });
  const store = new CompactionStore(root);
  const settings = { ...DEFAULT_COMPACTION_SETTINGS, enabled: true };
  const runtime: CompactionRuntime = {
    settings,
    model: MODEL,
    client,
    store,
    toolOutputs: new ToolOutputCompactor({ store, client, settings: settings.toolOutputs }),
    history: new HistoryCompactor({ store, client, settings: settings.history }),
    shutdown: async () => {
      shutdowns += 1;
    },
  };
  const proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
    quiet: true,
    hooks: false,
    compaction: runtime,
  });
  await proxy.shutdown();
  expect(shutdowns).toBe(1);
});
