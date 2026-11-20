import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import type { HistorySettings } from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import { HARNESS_COMPACTION_PROMPT_START } from "./harness-compaction.js";
import { HistoryCompactor } from "./history.js";
import { charsOf } from "./real-count.js";
import { CompactionStore } from "./store.js";

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("Unexpected network access");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const session = "swap-policy-session";
const model = "test-compaction-model";
const WINDOW = 200_000;
/** Sonnet 5.5 on the Claude API, per million tokens. */
const SONNET = { inputCostPer1M: 2, outputCostPer1M: 10, cacheReadCostPer1M: 0.1 };

type Message = { role: string; content: unknown };

let root: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-swap-policy-"));
  startLogCapture();
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

function text(chars: number, tag: string): string {
  return `${tag} ${"w ".repeat(Math.floor(chars / 2))}`;
}

function rig(history: HistorySettings) {
  let calls = 0;
  let clock = 1_000_000;
  const client = new CompactionClient({
    apiKey: "FAKE_SWAP_POLICY_0000",
    model,
    warn() {},
    record() {},
    // The first summary is ready; later ones fail, so the first stays the newest.
    fetchImpl: (async () => {
      calls += 1;
      if (calls > 1) return new Response("{}", { status: 500 });
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
  const compactor = new HistoryCompactor({
    store: new CompactionStore(root),
    client,
    settings: history,
    contextWindowOf: () => WINDOW,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
    now: () => clock,
    pricesOf: () => SONNET,
    haikuCostOf: () => 0,
  });
  active.push(compactor);
  const messages: Message[] = [
    // 74K tokens the summary replaces, then a 60K-token human turn.
    { role: "user", content: text(296_000, "PREFIX") },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: text(240_000, "TAIL") },
  ];
  return {
    compactor,
    advance(ms: number) {
      clock += ms;
    },
    /** One request; the upstream reports 4 characters a token of what was sent. */
    send(): void {
      const payload = {
        model,
        metadata: { user_id: JSON.stringify({ session_id: session }) },
        messages: [...messages],
      };
      const result = compactor.compact(payload, session);
      if (result.mark) {
        compactor.recordUsage(result.mark, { input_tokens: Math.round(charsOf(payload) / 4) });
      }
      clock += 10_000;
    },
    /** The next human turn: 2K tokens. */
    turn(): void {
      messages.push(
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        { role: "user", content: text(8_000, `TURN${messages.length}`) }
      );
    },
  };
}

const COST: HistorySettings = { enabled: true, policy: "cost", precomputeAt: 0.5, applyAt: 0.75 };

async function decisions(): Promise<string[]> {
  return (await capturedLines()).filter((l) => l.includes("history decision"));
}

function field(line: string, name: string): number {
  const m = line.match(new RegExp(`${name}=([0-9.]+)`));
  return m ? Number(m[1]) : Number.NaN;
}

test("cost: at the measured figures it holds, projected below nStar", async () => {
  const r = rig(COST);
  r.send();
  await r.compactor.whenIdle();
  for (let k = 0; k < 10; k++) {
    r.turn();
    r.send();
  }
  const lines = await decisions();
  const last = lines[lines.length - 1];
  expect(last).toContain("history decision cost: hold");
  const projected = field(last, "projected");
  const nStar = field(last, "nStar");
  expect(projected).toBeGreaterThanOrEqual(5);
  expect(projected).toBeLessThanOrEqual(7);
  expect(nStar).toBeGreaterThan(projected);
  expect(last).toMatch(/L=\d+, S=\d+, R=\d+, reason=projected \d+ < nStar/);
  expect((await capturedLines()).some((l) => l.includes("history swap in session"))).toBe(false);
});

test("cost: the same request after a gap longer than the cache TTL swaps", async () => {
  const r = rig(COST);
  r.send();
  await r.compactor.whenIdle();
  for (let k = 0; k < 9; k++) {
    r.turn();
    r.send();
  }
  r.turn();
  r.advance(301_000);
  r.send();
  const lines = await decisions();
  const last = lines[lines.length - 1];
  expect(last).toContain("history decision cost: swap");
  expect(last).toContain("reason=cold cache");
  expect((await capturedLines()).some((l) => l.includes("history swap in session"))).toBe(true);
});

test("cost: it swaps when the next request crosses Claude Code's compaction point", async () => {
  const r = rig(COST);
  r.send();
  await r.compactor.whenIdle();
  for (let k = 0; k < 20; k++) {
    r.turn();
    r.send();
  }
  const swaps = (await decisions()).filter((l) => l.includes(": swap"));
  expect(swaps.length).toBe(1);
  expect(swaps[0]).toContain("reason=the next request crosses Claude Code's compaction point");
});

test("cost: the first request after Claude Code's compaction is measured for the forced point", async () => {
  const r = rig(COST);
  r.compactor.compact(
    {
      model,
      metadata: { user_id: JSON.stringify({ session_id: session }) },
      messages: [
        { role: "user", content: "Fix the parser" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: `${HARNESS_COMPACTION_PROMPT_START}\n\nSummarise.` },
      ],
    },
    session
  );
  r.send();
  await r.compactor.whenIdle();
  for (let k = 0; k < 20; k++) {
    r.turn();
    r.send();
  }
  const lines = await capturedLines();
  const measured = lines.find((l) => l.includes("Claude Code's compaction measured"));
  const tokens = Number(measured?.match(/the next request is (\d+) tokens/)?.[1]);
  expect(tokens).toBeGreaterThan(130_000);
  const forced = (await decisions()).filter((l) => l.includes("reason=the next request crosses"));
  expect(forced.length).toBe(1);
  const growth = 2_002;
  expect(field(forced[0], "requestsAfterCcCompact")).toBe(
    Math.ceil((0.83 * WINDOW - tokens) / growth)
  );
  expect(forced[0]).toContain("history decision cost: swap");
});

test("threshold: the decision is logged, and the swap comes at applyAt as before", async () => {
  const r = rig({ enabled: true, policy: "threshold", precomputeAt: 0.6, applyAt: 0.75 });
  r.send();
  await r.compactor.whenIdle();
  for (let k = 0; k < 10; k++) {
    r.turn();
    r.send();
  }
  const lines = await decisions();
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("history decision threshold: swap");
  expect(lines[0]).toContain("reason=count reached applyAt 0.75");
});

/**
 * A session with a swap already active: the first summary is ready at once,
 * swapped in on a cold cache, and the turns that follow are sent after it.
 * `hangLater` makes every later summary wait 600 ms, then fail.
 */
function activeSwapRig(opts: { hangLater: boolean; swapWaitMs?: number }) {
  let calls = 0;
  let clock = 1_000_000;
  const client = new CompactionClient({
    apiKey: "FAKE_SWAP_POLICY_0000",
    model,
    warn() {},
    record() {},
    fetchImpl: (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls += 1;
      if (calls > 1 && opts.hangLater) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => reject(new Error("summary unavailable")), 600);
        });
      }
      return Response.json({
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: `SUMMARY_${calls}` }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }) as unknown as typeof fetch,
  });
  const compactor = new HistoryCompactor({
    store: new CompactionStore(root),
    client,
    settings: COST,
    contextWindowOf: () => WINDOW,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
    ...(opts.swapWaitMs !== undefined ? { swapWaitMs: opts.swapWaitMs } : {}),
    now: () => clock,
    pricesOf: () => SONNET,
    haikuCostOf: () => 0,
  });
  active.push(compactor);
  const messages: Message[] = [
    { role: "user", content: text(296_000, "PREFIX") },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: text(240_000, "TAIL") },
  ];
  const payloadOf = () => ({
    model,
    metadata: { user_id: JSON.stringify({ session_id: session }) },
    messages: [...messages],
  });
  const send = async () => {
    const payload = payloadOf();
    const result = await compactor.compactAsync(payload, session);
    if (result.mark) {
      compactor.recordUsage(result.mark, { input_tokens: Math.round(charsOf(payload) / 4) });
    }
    clock += 10_000;
    return result;
  };
  const turn = () => {
    messages.push(
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: text(8_000, `TURN${messages.length}`) }
    );
  };
  return {
    compactor,
    messages,
    send,
    turn,
    advance(ms: number) {
      clock += ms;
    },
    /** Swap the first summary in, then add turns until a second summary starts. */
    async untilSecondSummary() {
      await send();
      await compactor.whenIdle();
      clock += 301_000;
      turn();
      let last = await send();
      for (let k = 0; k < 40 && !last.precomputeStarted; k++) {
        turn();
        last = await send();
      }
      return last;
    },
  };
}

test("cost: with a swap active, R is what the new swap removes from the request as sent", async () => {
  const r = activeSwapRig({ hangLater: false });
  const before = await r.untilSecondSummary();
  await r.compactor.whenIdle();
  const swapLines = async () =>
    (await capturedLines()).filter((l) => l.includes("history swap in session"));
  expect((await swapLines()).length).toBe(1);

  r.advance(301_000);
  r.turn();
  // The request as sent before this swap: the previous one plus the new turn.
  const sentBefore = (before.estimate ?? 0) + Math.ceil(charsOf(r.messages.slice(-2)) / 4);
  const pass = await r.send();
  expect(pass.applied).toBe("swapped");
  const afterSwap = pass.estimate ?? 0;

  const lines = await capturedLines();
  const decision = lines.filter((l) => l.includes("history decision cost: swap")).pop() ?? "";
  expect((await swapLines()).length).toBe(2);
  expect(decision).toContain("reason=cold cache");
  expect(afterSwap).toBeLessThan(sentBefore);
  expect(Math.abs(field(decision, "R") - (sentBefore - afterSwap))).toBeLessThan(0.02 * sentBefore);
});

test("cost: a request whose swapped form is far below Claude Code's point does not wait", async () => {
  const r = activeSwapRig({ hangLater: true, swapWaitMs: 300 });
  await r.untilSecondSummary();
  r.turn();
  // Unswapped, the history is past Claude Code's compaction point.
  expect(charsOf(r.messages) / 4).toBeGreaterThan(0.83 * WINDOW);
  const result = await r.send();
  expect(result.estimate ?? 0).toBeLessThan(0.6 * WINDOW);
  expect((await capturedLines()).some((l) => l.includes("history waited"))).toBe(false);
});
