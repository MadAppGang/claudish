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
import { HistoryCompactor, projectedTokens } from "./history.js";
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

const session = "projected-start-session";
const model = "test-compaction-model";
const WINDOW = 200_000;

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };

let root: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-projected-"));
  startLogCapture();
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A counter that reports scripted figures: the token count of a request by
 * its message count, and the growth and gap the policy reads.
 */
function scriptedCounter(byLength: Map<number, number>, observed: () => ThreadObservation) {
  return {
    count: (_s: string, _t: string, payload: { messages: unknown[] }) => ({
      tokens: byLength.get(payload.messages.length) ?? 1000,
      source: "usage",
    }),
    observe: () => ({ ...observed() }),
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

function rig(byLength: Map<number, number>, observed: () => ThreadObservation) {
  let calls = 0;
  const h = new HistoryCompactor({
    store: new CompactionStore(root),
    client: new CompactionClient({
      apiKey: "FAKE_PROJECTED_START_0000",
      model,
      warn() {},
      record() {},
      fetchImpl: (async () => {
        calls += 1;
        return Response.json({
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "PROJECTED_SUMMARY" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }) as unknown as typeof fetch,
    }),
    settings: { enabled: true, precomputeAt: 0.6, applyAt: 0.75 },
    contextWindowOf: () => WINDOW,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
    counter: scriptedCounter(byLength, observed),
  });
  active.push(h);
  return { h, calls: () => calls };
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

// Bench E1 cost t1: the history grew 42,284 -> 162,022 in 4 requests over 27 s.
const T1 = [42_284, 80_000, 119_000, 162_022];
const lengthOf = (rounds: number) => 1 + 2 * rounds;

/**
 * The four t1 requests in order, each read with the observation the counter
 * would hold before it: none before the first, then `later` (growth needs
 * two measured responses, so the first request never has it).
 */
function t1Requests(later: ThreadObservation) {
  const byLength = new Map<number, number>();
  T1.forEach((tokens, i) => byLength.set(lengthOf(10 + 4 * i), tokens));
  let current: ThreadObservation = {};
  const r = rig(byLength, () => current);
  const started: number[] = [];
  T1.forEach((_, i) => {
    current = i === 0 ? {} : later;
    if (r.h.compact(longTurn(10 + 4 * i), session).precomputeStarted) started.push(i + 1);
  });
  return { r, started };
}

test("fast growth starts the summary on request 2 of the t1 sequence", async () => {
  // About 38K tokens per request, 7 s apart.
  const { started } = t1Requests({ gapMs: 7_000, growthPerRequest: 38_000 });
  expect(started[0]).toBe(2);
  const line = (await capturedLines()).find((l) => l.includes("summary started early"));
  expect(line).toContain("80000 tokens now, projected 194000 in 3 requests");
});

test("slow growth starts the summary at precomputeAt, as before", () => {
  // One request a minute and 500 tokens each: a summary is ready long before the next one.
  const { started } = t1Requests({ gapMs: 60_000, growthPerRequest: 500 });
  expect(started[0]).toBe(4);
});

test("no measured growth starts the summary at precomputeAt", () => {
  const { started } = t1Requests({ gapMs: 7_000 });
  expect(started[0]).toBe(4);
});

test("a failed summary's time is not the latency that projects the next start", async () => {
  // The first summary fails at once with HTTP 500. Timed, it would read as a
  // latency of a few milliseconds: one request ahead, so the next thread's
  // summary would not start early.
  let calls = 0;
  const byLength = new Map<number, number>([
    [lengthOf(10), 125_000],
    [lengthOf(14), 80_000],
  ]);
  let current: ThreadObservation = {};
  const h = new HistoryCompactor({
    store: new CompactionStore(root),
    client: new CompactionClient({
      apiKey: "FAKE_PROJECTED_START_0000",
      model,
      warn() {},
      record() {},
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { type: "error", error: { type: "api_error", message: "test failure" } },
            { status: 500 }
          );
        }
        return Response.json({
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "PROJECTED_SUMMARY" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }) as unknown as typeof fetch,
    }),
    settings: { enabled: true, precomputeAt: 0.6, applyAt: 0.75 },
    contextWindowOf: () => WINDOW,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
    counter: scriptedCounter(byLength, () => current),
  });
  active.push(h);

  expect(h.compact(longTurn(10), session).precomputeStarted).toBe(true);
  await h.whenIdle();
  expect(calls).toBe(1);

  const other = longTurn(14);
  other.messages[0] = { role: "user", content: "Another conversation in the same session" };
  current = { gapMs: 7_000, growthPerRequest: 38_000 };
  expect(h.compact(other, session).precomputeStarted).toBe(true);
  const line = (await capturedLines()).find((l) => l.includes("summary started early"));
  expect(line).toContain("80000 tokens now, projected 194000 in 3 requests");
});

test("the projection covers the summary's latency in requests", () => {
  expect(projectedTokens(80_000, { gapMs: 7_000, growthPerRequest: 38_000 }, 15_000)).toEqual({
    tokens: 80_000 + 3 * 38_000,
    requests: 3,
  });
  expect(projectedTokens(80_000, { gapMs: 7_000 }, 15_000)).toEqual({
    tokens: 80_000,
    requests: 0,
  });
  // A request every 100 ms is still projected over a bounded number of requests.
  expect(projectedTokens(80_000, { gapMs: 100, growthPerRequest: 1_000 }, 15_000).requests).toBe(8);
});
