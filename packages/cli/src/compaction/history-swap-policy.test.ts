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

/**
 * The opening of the first user message after Claude Code 2.1.329 compacts:
 * block 2 of message 0, at offset 0, in all 9 compactions of a live session.
 */
const CONTINUED =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";

/**
 * `compacted`: the conversation opens with Claude Code's summary, as after its
 * compaction. `everySummary`: every Haiku summary succeeds, not only the first.
 * `summaryChars`: the summary's length. `routedModel`: the model spec the
 * proxy routes each request to. `pricesOf`: the rates lookup, Sonnet 5.5's by
 * default.
 */
function rig(
  history: HistorySettings,
  opts: {
    compacted?: boolean;
    everySummary?: boolean;
    summaryChars?: number;
    routedModel?: string;
    pricesOf?: (model: unknown, inputTokens: number) => typeof SONNET | undefined;
  } = {}
) {
  let calls = 0;
  let clock = 1_000_000;
  const summary = opts.summaryChars ? text(opts.summaryChars, "SUMMARY") : "SUMMARY";
  const client = new CompactionClient({
    apiKey: "FAKE_SWAP_POLICY_0000",
    model,
    warn() {},
    record() {},
    // The first summary is ready; later ones fail, so the first stays the newest.
    fetchImpl: (async () => {
      calls += 1;
      if (calls > 1 && !opts.everySummary) return new Response("{}", { status: 500 });
      return Response.json({
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: summary }],
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
    pricesOf: opts.pricesOf ?? (() => SONNET),
    haikuCostOf: () => 0,
  });
  active.push(compactor);
  const messages: Message[] = [
    // 74K tokens the summary replaces, then a 60K-token human turn.
    {
      role: "user",
      content: opts.compacted
        ? `${CONTINUED}\n\n${text(296_000, "PREFIX")}`
        : text(296_000, "PREFIX"),
    },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: text(240_000, "TAIL") },
  ];
  return {
    compactor,
    advance(ms: number) {
      clock += ms;
    },
    /** A copy of the conversation's messages. */
    messages(): Message[] {
      return [...messages];
    },
    /** Replaces the conversation, as Claude Code does when it compacts. */
    replace(list: Message[]): void {
      messages.splice(0, messages.length, ...list);
    },
    /** A request outside the main loop, with its own messages and no usage. */
    sendOther(list: Message[]): void {
      compactor.compact(
        { model, metadata: { user_id: JSON.stringify({ session_id: session }) }, messages: list },
        session
      );
    },
    /** One request; the upstream reports 4 characters a token of what was sent. */
    send(): void {
      const payload = {
        model,
        metadata: { user_id: JSON.stringify({ session_id: session }) },
        messages: [...messages],
      };
      const result = compactor.compact(payload, session, opts.routedModel);
      if (result.mark) {
        compactor.recordUsage(result.mark, { input_tokens: Math.round(charsOf(payload) / 4) });
      }
      clock += 10_000;
    },
    /** The next human turn: 2K tokens. */
    turn(chars = 8_000): void {
      messages.push(
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        { role: "user", content: text(chars, `TURN${messages.length}`) }
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

/**
 * A role mapping or `--model` routes Claude Code's `claude-*` request to
 * another model, and the body keeps Claude Code's name. The decision is
 * priced on the route: a Claude API spec on its inner model id, any other
 * provider on nothing, so a foreign route is never credited Claude cache
 * savings.
 */
test("cost: the decision is priced on the routed model, not on the request's own name", async () => {
  const cases: Array<[string | undefined, unknown]> = [
    ["glm@glm-5-turbo", undefined],
    ["anthropic@claude-opus-5-5", "claude-opus-5-5"],
    ["a@claude-opus-5-5", "claude-opus-5-5"],
    ["claude-opus-5-5", "claude-opus-5-5"],
    [undefined, model],
  ];
  for (const [routedModel, priced] of cases) {
    const asked: unknown[] = [];
    const r = rig(COST, {
      ...(routedModel !== undefined ? { routedModel } : {}),
      pricesOf: (name) => {
        asked.push(name);
        return SONNET;
      },
    });
    r.send();
    await r.compactor.whenIdle();
    r.turn();
    r.send();
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([priced]));
    await r.compactor.whenIdle();
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "compaction-swap-policy-"));
  }
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

test("cost: the compacted request after Claude Code's compaction is measured for the forced point", async () => {
  const r = rig(COST, { compacted: true });
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

test("cost: only the compacted request is measured, not one sent beside Claude Code's compaction request", async () => {
  const r = rig(COST);
  r.send();
  await r.compactor.whenIdle();
  r.turn();
  r.send();
  // 03:18:44.631Z: Claude Code precomputes its compaction beside the main loop,
  // on the history it has, while the main request goes on (03:18:44.629Z).
  r.sendOther([
    ...r.messages(),
    { role: "user", content: `${HARNESS_COMPACTION_PROMPT_START}\n\nSummarise.` },
  ]);
  // A subagent request in the same session starts its own short history.
  r.sendOther([{ role: "user", content: "Find every caller of parseConfig." }]);
  r.turn();
  r.send();
  const measuredLines = async () =>
    (await capturedLines()).filter((l) => l.includes("Claude Code's compaction measured"));
  expect(await measuredLines()).toEqual([]);

  // Claude Code applies its compaction: its summary opens the first message,
  // and a short tail of the conversation follows.
  r.replace([
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>context</system-reminder>" },
        { type: "text", text: "<system-reminder>output style</system-reminder>" },
        { type: "text", text: `${CONTINUED}\n\n${text(40_000, "SUMMARY")}` },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: text(8_000, "KEPT") },
  ]);
  r.send();
  const measured = await measuredLines();
  expect(measured).toHaveLength(1);
  const tokens = Number(measured[0].match(/the next request is (\d+) tokens/)?.[1]);
  expect(tokens).toBeGreaterThan(10_000);
  expect(tokens).toBeLessThan(20_000);
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

test("cost: a forced swap 7 requests after a forced swap, below nStar, holds", async () => {
  // The Opus bench burst in small: summaries of 30K tokens, turns of 15K
  // tokens, so a forced swap leaves room for only a few requests.
  const r = rig(COST, { everySummary: true, summaryChars: 120_000 });
  r.send();
  await r.compactor.whenIdle();
  for (let k = 0; k < 30; k++) {
    r.turn(k < 16 ? 8_000 : 60_000);
    r.send();
    await r.compactor.whenIdle();
  }
  const forced = (await decisions()).filter((l) => l.includes("reason=the next request crosses"));
  expect(forced.length).toBeGreaterThanOrEqual(2);
  expect(forced[0]).toContain("history decision cost: swap");
  expect(forced[0]).toContain("lastForcedSwapGap=none");
  expect(forced[1]).toContain("history decision cost: hold");
  expect(forced[1]).toContain("lastForcedSwapGap=7");
  expect(forced[1]).toContain(
    `the last forced swap left 7 requests, fewer than nStar ${field(forced[1], "nStar").toFixed(1)}`
  );
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
    // The client calls fetch with one Request: its signal is the call's abort.
    fetchImpl: (async (req: Request) => {
      calls += 1;
      if (calls > 1 && opts.hangLater) {
        return new Promise<Response>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => reject(new Error("aborted")));
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
