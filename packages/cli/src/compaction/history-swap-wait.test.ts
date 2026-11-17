import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor } from "./history.js";
import type { RealTokenCount, ThreadObservation } from "./real-count.js";
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

const session = "swap-wait-session";
const model = "test-compaction-model";
const WINDOW = 200_000;

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };

let root: string;
const active: HistoryCompactor[] = [];
const pending: Array<() => void> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-swap-wait-"));
  startLogCapture();
});
afterEach(async () => {
  for (const release of pending.splice(0)) release();
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

/** A counter reporting scripted counts by message count, and a fixed observation. */
function scriptedCounter(byLength: Map<number, number>, observed: ThreadObservation) {
  return {
    count: (_s: string, _t: string, payload: { messages: unknown[] }) => ({
      tokens: byLength.get(payload.messages.length) ?? 1000,
      source: "usage",
    }),
    observe: () => ({ ...observed }),
    mark: () => ({
      sessionId: session,
      thread: "",
      messageCount: 0,
      lastMessageHash: "",
      chars: 0,
    }),
    record() {},
    tokensOfChars: (_s: string, chars: number) => Math.ceil(chars / 4),
  } as unknown as RealTokenCount;
}

/**
 * A compactor whose summary call answers only when the test calls
 * `release()`, so a summary stays in flight for as long as the test needs.
 */
function rig(byLength: Map<number, number>, observed: ThreadObservation, swapWaitMs = 5_000) {
  let release: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending.push(() => release());
  const h = new HistoryCompactor({
    store: new CompactionStore(root),
    client: new CompactionClient({
      apiKey: "FAKE_SWAP_WAIT_0000",
      model,
      warn() {},
      record() {},
      fetchImpl: (async () => {
        await answered;
        return Response.json({
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "WAITED_SUMMARY" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }) as unknown as typeof fetch,
    }),
    settings: { enabled: true, precomputeAt: 0.6, applyAt: 0.75 },
    contextWindowOf: () => WINDOW,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 30_000,
    swapWaitMs,
    counter: scriptedCounter(byLength, observed),
  });
  active.push(h);
  return { h, release: () => release() };
}

/** One human message, then `rounds` complete tool rounds of one agent turn. */
function longTurn(rounds: number): { model: string; messages: Message[] } {
  const messages: Message[] = [{ role: "user", content: "Read every file under src/" }];
  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t-${i}`, name: "Read", input: { file_path: `f${i}` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t-${i}`, content: `file ${i}` }],
    });
  }
  return { model, messages };
}

// Request A starts the summary at 125K (precomputeAt 120K). Request B is at
// 155K, past applyAt (150K); Claude Code compacts at 0.83 x 200K = 166K.
const counts = () =>
  new Map<number, number>([
    [1 + 2 * 6, 125_000],
    [1 + 2 * 8, 155_000],
  ]);

async function startSummary(r: ReturnType<typeof rig>) {
  const pass = await r.h.compactAsync(longTurn(6), session);
  expect(pass.precomputeStarted).toBe(true);
}

test("the last request before Claude Code's compaction point waits for the summary and swaps", async () => {
  // 20K per request: the next request (175K) would cross 166K.
  const r = rig(counts(), { gapMs: 7_000, growthPerRequest: 20_000 });
  await startSummary(r);
  setTimeout(() => r.release(), 30);
  const b = longTurn(8);
  const pass = await r.h.compactAsync(b, session);
  expect(pass.applied).toBe("swapped");
  expect(JSON.stringify(b.messages[0])).toContain("WAITED_SUMMARY");
  const line = (await capturedLines()).find((l) => l.includes("history waited"));
  expect(line).toContain("155000 tokens now, next request projected 175000");
});

test("a summary that never answers releases the request at the wait cap", async () => {
  const r = rig(counts(), { gapMs: 7_000, growthPerRequest: 20_000 }, 80);
  await startSummary(r);
  const started = Date.now();
  const pass = await r.h.compactAsync(longTurn(8), session);
  const waited = Date.now() - started;
  expect(pass.applied).toBe("none");
  expect(waited).toBeGreaterThanOrEqual(70);
  expect(waited).toBeLessThan(2_000);
  const line = (await capturedLines()).find((l) => l.includes("history waited"));
  expect(line).toContain("summary not ready");
});

test("slow growth never waits", async () => {
  // 1K per request: the next request (156K) stays under 166K.
  const r = rig(counts(), { gapMs: 7_000, growthPerRequest: 1_000 }, 5_000);
  await startSummary(r);
  const started = Date.now();
  const pass = await r.h.compactAsync(longTurn(8), session);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(pass.applied).toBe("none");
});

test("a request below applyAt never waits, even when the next one would cross", async () => {
  const byLength = counts();
  byLength.set(1 + 2 * 8, 140_000);
  // 140K + 30K = 170K would cross 166K, but no swap is allowed below 150K.
  const r = rig(byLength, { gapMs: 7_000, growthPerRequest: 30_000 }, 5_000);
  await startSummary(r);
  const started = Date.now();
  await r.h.compactAsync(longTurn(8), session);
  expect(Date.now() - started).toBeLessThan(1_000);
});
