import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import type { ModelHandler } from "../handlers/types.js";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { localTokenEstimate } from "../token-estimate.js";
import { DEFAULT_COMPACTION_SETTINGS } from "./config.js";
import { CompactionHandler } from "./decorator.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor } from "./history.js";
import type { CompactionRuntime } from "./runtime.js";
import { CompactionStore } from "./store.js";

// Installed per file and restored: bun runs every test file in one process.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("Unexpected network access");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const session = "real-count-session";
const model = "test-compaction-model";
const WINDOW = 200_000;
/** What the upstream reports for the first request: 163,004 prompt tokens. */
const USAGE = {
  input_tokens: 4,
  cache_read_input_tokens: 160_000,
  cache_creation_input_tokens: 3_000,
};
const REAL = 163_004;

type Message = { role: string; content: unknown };
type Payload = { model: string; metadata: { user_id: string }; messages: Message[] };

let root: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-real-count-"));
  startLogCapture();
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

function sse(usage: Record<string, number>): Response {
  const body = [
    "event: message_start",
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { ...usage, output_tokens: 1 } } })}`,
    "",
    "event: message_delta",
    `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 50 } })}`,
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
    "",
  ].join("\n");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function rig() {
  let calls = 0;
  const client = new CompactionClient({
    apiKey: "FAKE_REAL_COUNT_0000",
    model,
    warn() {},
    record() {},
    fetchImpl: (async () => {
      calls += 1;
      return Response.json({
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "SUMMARY" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }) as unknown as typeof fetch,
  });
  const store = new CompactionStore(root);
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    enabled: true,
    toolOutputs: { ...DEFAULT_COMPACTION_SETTINGS.toolOutputs, enabled: false },
    history: { enabled: true, precomputeAt: 0.6, applyAt: 0.75 },
  };
  const history = new HistoryCompactor({
    store,
    client,
    settings: settings.history,
    contextWindowOf: () => WINDOW,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
  });
  active.push(history);
  const runtime = { settings, model, client, store, history } as unknown as CompactionRuntime;
  const inner: ModelHandler = {
    handle: async () => sse(USAGE),
    shutdown: async () => {},
  };
  const handler = new CompactionHandler(inner, runtime);
  return {
    history,
    calls: () => calls,
    /** One request through the decorator, its response read to the end as Claude Code reads it. */
    async send(p: Payload): Promise<void> {
      const vars = new Map<string, unknown>();
      const c = {
        get: (k: string) => vars.get(k),
        set: (k: string, v: unknown) => vars.set(k, v),
      } as unknown as Context;
      const res = await handler.handle(c, p);
      await res.text();
    },
  };
}

/** About 420,000 characters of JSON: 105K tokens at 4 characters a token. */
function conversation(first: string): Payload {
  return {
    model,
    metadata: { user_id: JSON.stringify({ session_id: session }) },
    messages: [
      { role: "user", content: `${first} ${"lorem ".repeat(70_000)}` },
      { role: "assistant", content: [{ type: "text", text: "Read it." }] },
      { role: "user", content: "Go on" },
    ],
  };
}

function next(p: Payload, text: string): Payload {
  return {
    ...p,
    messages: [
      ...p.messages,
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: text },
    ],
  };
}

test("the previous response's usage, not chars / 4, decides the summary start", async () => {
  const r = rig();
  const first = conversation("FIRST");
  // The local estimate stays under the 60% mark (120,000 tokens) ...
  expect(localTokenEstimate(next(first, "Then this"))).toBeLessThan(0.6 * WINDOW);

  await r.send(first);
  await r.send(next(first, "Then this"));
  await r.history.whenIdle();

  // ... while the upstream measured 163,004 tokens for the first request alone.
  const lines = await capturedLines();
  expect(lines.some((l) => l.includes("history summary started"))).toBe(true);
  expect(r.calls()).toBe(1);
  const count = lines.find((l) => l.includes("history count"));
  expect(count).toContain(`(usage ${REAL} + `);
  expect(count).toContain(`of ${WINDOW} tokens`);
});

test("a thread with no usage yet is measured with the session's measured ratio", async () => {
  const r = rig();
  await r.send(conversation("FIRST"));
  // Another thread of the same session (a subagent): no usage for it yet.
  await r.send(conversation("SUBAGENT"));
  await r.history.whenIdle();

  const lines = await capturedLines();
  const count = lines.find((l) => l.includes("history count") && l.includes("calibrated"));
  expect(count).toBeDefined();
  expect(lines.some((l) => l.includes("history summary started"))).toBe(true);
});
