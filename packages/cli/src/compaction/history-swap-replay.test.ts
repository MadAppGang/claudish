import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { localTokenEstimate } from "../token-estimate.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor, messageHash, summaryMessageText } from "./history.js";
import { CompactionStore, type HistorySwapRecord, historyRecordKey } from "./store.js";

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

const session = "swap-replay-session";
const model = "test-compaction-model";
const SUMMARY = "SWAP_REPLAY_SUMMARY: the earlier work.";
const REMINDER = "<system-reminder>context that changes between requests</system-reminder>";

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };
type Payload = { model: string; messages: Message[] };

let root: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-swap-replay-"));
  startLogCapture();
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

/** A compactor whose context window the test sets per request. */
function rig(store = new CompactionStore(root)) {
  let calls = 0;
  let window = 10_000;
  const client = new CompactionClient({
    apiKey: "FAKE_SWAP_REPLAY_0000",
    model,
    warn() {},
    record() {},
    fetchImpl: (async () => {
      calls += 1;
      return Response.json({
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: SUMMARY }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }) as unknown as typeof fetch,
  });
  const h = new HistoryCompactor({
    store,
    client,
    settings: { enabled: true, precomputeAt: 0.6, applyAt: 0.8 },
    contextWindowOf: () => window,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
  });
  active.push(h);
  return {
    h,
    store,
    calls: () => calls,
    /** Size the window so that `p` sits at `ratio` of it. */
    windowAt(p: Payload, ratio: number) {
      window = Math.ceil(localTokenEstimate(p) / ratio);
    },
  };
}

/** The first 12 hex of one message's `messageHash`, as the log prints it. */
function shortHash(message: unknown): string {
  return messageHash(message).slice(0, 12);
}

/**
 * Four turns of work; the last message starts a new human turn whose text
 * sits beside a system reminder, as Claude Code sends it.
 */
function conversation(): Payload {
  return {
    model,
    messages: [
      { role: "user", content: `FIRST ${"old data ".repeat(3000)}` },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "OLD_THOUGHT", signature: "sig-0" },
          { type: "text", text: "First turn done" },
        ],
      },
      { role: "user", content: "Second request" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t-0", name: "Bash", input: { command: "ls" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t-0", content: "a.ts" }] },
      { role: "assistant", content: [{ type: "text", text: "Second turn done" }] },
      {
        role: "user",
        content: [
          { type: "text", text: REMINDER },
          { type: "text", text: "Third request: go on" },
        ],
      },
    ],
  };
}

function toolRound(p: Payload, n: number, thinking = false): Payload {
  const out = structuredClone(p);
  out.messages.push({
    role: "assistant",
    content: [
      ...(thinking
        ? [{ type: "thinking", thinking: `NEW_THOUGHT_${n}`, signature: `s-${n}` }]
        : []),
      { type: "tool_use", id: `r-${n}`, name: "Bash", input: { command: `echo ${n}` } },
    ],
  });
  out.messages.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `r-${n}`, content: `out ${n}` }],
  });
  return out;
}

/** Claude Code dropping the reminder block from the turn's human message. */
function withoutReminder(p: Payload, index: number): Payload {
  const out = structuredClone(p);
  const m = out.messages[index]!;
  m.content = (m.content as Block[]).filter((b) => b.text !== REMINDER);
  return out;
}

/**
 * Prepare a summary at the human message (the newest message), then swap on a
 * request with the same messages: boundary 6, end 7, one message in [b, end).
 */
async function swapAtNewestMessage(r: ReturnType<typeof rig>): Promise<Payload> {
  const p = conversation();
  r.windowAt(p, 0.7);
  expect(r.h.compact(structuredClone(p), session).precomputeStarted).toBe(true);
  await r.h.whenIdle();
  expect(r.calls()).toBe(1);
  const sent = structuredClone(p);
  r.windowAt(p, 0.9);
  const pass = r.h.compact(sent, session);
  expect(pass.applied).toBe("swapped");
  expect(pass.boundary).toBe(6);
  return sent;
}

function swapRecord(store: CompactionStore): HistorySwapRecord {
  const swaps = store
    .list(session)
    .map(([, rec]) => rec)
    .filter((rec): rec is HistorySwapRecord => rec.kind === "history-swap");
  expect(swaps).toHaveLength(1);
  return swaps[0]!;
}

test("a swap replays on the next tool round when the newest human message changed", async () => {
  const r = rig();
  const atSwap = await swapAtNewestMessage(r);
  const record = swapRecord(r.store);
  expect(record.boundary).toBe(6);
  expect(record.end).toBe(7);

  const before = conversation();
  const next = withoutReminder(toolRound(before, 1), 6);
  const sent = structuredClone(next);
  const pass = r.h.compact(sent, session);

  expect(pass.applied).toBe("replayed");
  expect(pass.boundary).toBe(6);
  // The summary that replaced [0, b) is byte-identical to the swap request's.
  expect(JSON.stringify(sent.messages[0])).toBe(JSON.stringify(atSwap.messages[0]));
  expect(sent.messages[0]!.content).toBe(summaryMessageText(SUMMARY));
  // Then the current [b, end) and everything after it.
  expect(sent.messages.slice(1)).toEqual(next.messages.slice(6));
  expect(r.calls()).toBe(1);

  // A block removed from message 6 is a real content change: it is logged.
  const lines = (await capturedLines()).filter((l) => l.includes("tail changed"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEndWith(
    `[compaction] session ${session}: history replayed at 6, tail changed: recorded [${shortHash(before.messages[6])}] current [${shortHash(next.messages[6])}]`
  );
  expect(lines[0]).not.toContain("Third request");
});

/**
 * Claude Code 2.1.325's shape, captured from its requests: the turn's prompt
 * is one text block carrying the cache marker while it is the newest
 * message, and a plain string on every later request.
 */
function promptAsNewest(p: Payload): Payload {
  const out = structuredClone(p);
  out.messages[6] = {
    role: "user",
    content: [{ type: "text", text: "Third request: go on", cache_control: { type: "ephemeral" } }],
  };
  return out;
}

function promptAsString(p: Payload): Payload {
  const out = structuredClone(p);
  out.messages[6] = { role: "user", content: "Third request: go on" };
  return out;
}

test("a prompt sent as a marked text block, then as a string, is not a tail change", async () => {
  const r = rig();
  const p = promptAsNewest(conversation());
  r.windowAt(p, 0.7);
  expect(r.h.compact(structuredClone(p), session).precomputeStarted).toBe(true);
  await r.h.whenIdle();
  r.windowAt(p, 0.9);
  expect(r.h.compact(structuredClone(p), session).applied).toBe("swapped");

  for (let n = 1; n <= 3; n++) {
    const next = promptAsString(toolRound(p, n));
    expect(r.h.compact(structuredClone(next), session).applied).toBe("replayed");
  }
  const lines = (await capturedLines()).filter((l) => l.includes("tail changed"));
  expect(lines).toHaveLength(0);
});

test("a changed text of the swap request's newest message is a tail change", async () => {
  const r = rig();
  const p = promptAsNewest(conversation());
  r.windowAt(p, 0.7);
  r.h.compact(structuredClone(p), session);
  await r.h.whenIdle();
  r.windowAt(p, 0.9);
  expect(r.h.compact(structuredClone(p), session).applied).toBe("swapped");

  const next = toolRound(p, 1);
  next.messages[6] = { role: "user", content: "Third request: go on, edited" };
  expect(r.h.compact(structuredClone(next), session).applied).toBe("replayed");
  const lines = (await capturedLines()).filter((l) => l.includes("tail changed"));
  expect(lines).toHaveLength(1);
});

test("a change to a tail message before the swap request's newest one logs a tail change", async () => {
  const r = rig();
  // A summary at boundary 2, then a swap at the human turn of message 6:
  // [b, end) = messages 2..6.
  const p = conversation();
  const early = structuredClone(p);
  early.messages.splice(3);
  r.windowAt(early, 0.7);
  expect(r.h.compact(structuredClone(early), session).precomputeStarted).toBe(true);
  await r.h.whenIdle();
  r.windowAt(p, 0.9);
  expect(r.h.compact(structuredClone(p), session).applied).toBe("swapped");

  const next = toolRound(p, 1);
  next.messages[5] = { role: "assistant", content: [{ type: "text", text: "Edited turn" }] };
  expect(r.h.compact(structuredClone(next), session).applied).toBe("replayed");

  const lines = (await capturedLines()).filter((l) => l.includes("tail changed"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("current [");
  expect(lines[0]).toContain(shortHash(next.messages[5]));
  expect(lines[0]).not.toContain("Edited turn");
});

test("a swap with an unchanged tail replays and logs no tail change", async () => {
  const r = rig();
  const atSwap = await swapAtNewestMessage(r);
  const sent = toolRound(conversation(), 1);
  expect(r.h.compact(sent, session).applied).toBe("replayed");
  expect(JSON.stringify(sent.messages[0])).toBe(JSON.stringify(atSwap.messages[0]));
  const lines = (await capturedLines()).filter((l) => l.includes("tail changed"));
  expect(lines).toHaveLength(0);
});

test("a request shorter than the swap's end (a rewind into [b, end)) does not replay", async () => {
  const r = rig();
  await swapAtNewestMessage(r);
  const rewound = conversation();
  rewound.messages.splice(6);
  const sent = structuredClone(rewound);
  r.windowAt(rewound, 0.5);
  expect(r.h.compact(sent, session).applied).toBe("none");
  expect(sent).toEqual(rewound);
  expect(r.h.replay(structuredClone(rewound), session)).toBe(false);
});

test("a changed prefix does not replay", async () => {
  const r = rig();
  await swapAtNewestMessage(r);
  const changed = toolRound(conversation(), 1);
  changed.messages[2] = { role: "user", content: "Second request, edited" };
  const sent = structuredClone(changed);
  r.windowAt(changed, 0.5);
  expect(r.h.compact(sent, session).applied).toBe("none");
  expect(sent).toEqual(changed);
  expect(r.h.replay(structuredClone(changed), session)).toBe(false);
});

test("a fresh store reading the same records replays with a changed tail", async () => {
  const r = rig();
  const atSwap = await swapAtNewestMessage(r);
  const restarted = rig(new CompactionStore(root));
  const next = withoutReminder(toolRound(conversation(), 1), 6);
  const sent = structuredClone(next);
  const pass = restarted.h.compact(sent, session);
  expect(pass.applied).toBe("replayed");
  expect(pass.boundary).toBe(6);
  expect(JSON.stringify(sent.messages[0])).toBe(JSON.stringify(atSwap.messages[0]));
  expect(restarted.calls()).toBe(0);
});

test("count_tokens replays a swap with a changed tail, sending what the request sends", async () => {
  const r = rig();
  await swapAtNewestMessage(r);
  const next = withoutReminder(toolRound(conversation(), 1), 6);
  const sent = structuredClone(next);
  expect(r.h.compact(sent, session).applied).toBe("replayed");
  const counted = structuredClone(next);
  expect(r.h.replay(counted, session)).toBe(true);
  expect(JSON.stringify(counted.messages)).toBe(JSON.stringify(sent.messages));
});

test("every replay strips thinking from the current [b, end) and keeps it after end", async () => {
  const r = rig();
  // A summary at boundary 2, then a swap at the human turn of message 6:
  // [b, end) = messages 2..6, holding thinking in the assistant message 3.
  const p = conversation();
  p.messages[1] = { role: "assistant", content: [{ type: "text", text: "First turn done" }] };
  p.messages[3] = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "TAIL_THOUGHT", signature: "sig-3" },
      { type: "redacted_thinking", data: "REDACTED" },
      { type: "tool_use", id: "t-0", name: "Bash", input: { command: "ls" } },
    ],
  };
  const early = structuredClone(p);
  early.messages.splice(3);
  r.windowAt(early, 0.7);
  expect(r.h.compact(structuredClone(early), session).precomputeStarted).toBe(true);
  await r.h.whenIdle();
  const atSwap = structuredClone(p);
  r.windowAt(p, 0.9);
  const swapPass = r.h.compact(atSwap, session);
  expect(swapPass.applied).toBe("swapped");
  expect(swapPass.boundary).toBe(2);

  let request = p;
  for (let n = 1; n <= 2; n++) {
    request = toolRound(request, n, true);
    // The human message of [b, end) changes on each request.
    const current = n === 1 ? withoutReminder(request, 6) : request;
    const sent = structuredClone(current);
    const pass = r.h.compact(sent, session);
    expect(pass.applied).toBe("replayed");
    expect(pass.boundary).toBe(2);
    expect(JSON.stringify(sent.messages[0])).toBe(JSON.stringify(atSwap.messages[0]));
    // Message 3 of the current request, without thinking.
    expect(sent.messages[2]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t-0", name: "Bash", input: { command: "ls" } }],
    });
    expect(JSON.stringify(sent.messages)).not.toContain("TAIL_THOUGHT");
    expect(JSON.stringify(sent.messages)).not.toContain("REDACTED");
    expect(sent.messages[5]).toEqual(current.messages[6]!);
    // Messages after end, unchanged, thinking kept.
    expect(sent.messages.slice(6)).toEqual(current.messages.slice(7));
    expect(JSON.stringify(sent.messages)).toContain(`NEW_THOUGHT_${n}`);
  }
});

test("the swap record keeps one hash per message of [b, end)", async () => {
  const r = rig();
  await swapAtNewestMessage(r);
  const record = swapRecord(r.store) as HistorySwapRecord & { tailMessageHashes?: string[] };
  expect(record.tailMessageHashes).toHaveLength(1);
  expect(record.tailMessageHashes![0]!.slice(0, 12)).toBe(shortHash(conversation().messages[6]));
});

test("an older record without per-message hashes logs the recorded tail as unknown", async () => {
  const r = rig();
  await swapAtNewestMessage(r);
  const record = swapRecord(r.store);
  const older = new CompactionStore(mkdtempSync(join(tmpdir(), "compaction-swap-older-")));
  try {
    const { tailMessageHashes: _dropped, ...legacy } = record as HistorySwapRecord & {
      tailMessageHashes?: string[];
    };
    older.put(session, historyRecordKey("history-swap", session, record.prefixHash), legacy);
    const o = rig(older);
    const next = withoutReminder(toolRound(conversation(), 1), 6);
    expect(o.h.compact(structuredClone(next), session).applied).toBe("replayed");
    const lines = (await capturedLines()).filter((l) => l.includes("tail changed"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEndWith(
      `history replayed at 6, tail changed: recorded [unknown] current [${shortHash(next.messages[6])}]`
    );
  } finally {
    rmSync(older.root, { recursive: true, force: true });
  }
});
