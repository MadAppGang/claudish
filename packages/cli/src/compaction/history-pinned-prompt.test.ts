import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { HARNESS_COMPACTION_PROMPT_START } from "./harness-compaction.js";
import {
  HISTORY_PINNED_PROMPT_MARKER,
  HISTORY_SUMMARY_MARKER,
  HistoryCompactor,
  messagesHash,
  threadOf,
} from "./history.js";
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

const session = "pinned-prompt-session";
const model = "test-compaction-model";
const SUMMARY = "PINNED_SUMMARY: the item-2 list.";
const SPEC = "SPEC: item 2 must refuse an empty list with exit 64. Never accept an empty list.";

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };
type Payload = { model: string; messages: Message[] };

let root: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-pinned-"));
  startLogCapture();
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

function rig() {
  let window = 10_000;
  const make = () => {
    const h = new HistoryCompactor({
      store: new CompactionStore(root),
      client: new CompactionClient({
        apiKey: "FAKE_PINNED_PROMPT_0000",
        model,
        warn() {},
        record() {},
        fetchImpl: (async () =>
          Response.json({
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text: SUMMARY }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          })) as unknown as typeof fetch,
      }),
      settings: { enabled: true, precomputeAt: 0.6, applyAt: 0.75 },
      contextWindowOf: () => window,
      autoCompactWindow: () => undefined,
      summaryTimeoutMs: 1000,
    });
    active.push(h);
    return h;
  };
  return {
    h: make(),
    /** A new compactor on the same store folder: a proxy restart. */
    restart: make,
    windowAt(p: Payload, ratio: number) {
      window = Math.ceil(localTokenEstimate(p) / ratio);
    },
  };
}

/** One human message (the spec), then `rounds` complete tool rounds of one turn. */
function oneTurn(
  rounds: number,
  prompt: Message["content"] = [{ type: "text", text: SPEC }]
): Payload {
  const messages: Message[] = [{ role: "user", content: prompt }];
  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t-${i}`, name: "Bash", input: { command: `step ${i}` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t-${i}`, content: `out-${i} `.repeat(400) }],
    });
  }
  return { model, messages };
}

/** Prepare a summary at boundary 9 (6 rounds at 65%), then swap at 8 rounds and 80%. */
async function swapInsideTurn(r: ReturnType<typeof rig>, prompt?: Message["content"]) {
  const a = oneTurn(6, prompt);
  r.windowAt(a, 0.65);
  expect(r.h.compact(a, session).precomputeStarted).toBe(true);
  await r.h.whenIdle();
  const b = oneTurn(8, prompt);
  r.windowAt(b, 0.8);
  const pass = r.h.compact(b, session);
  return { b, pass };
}

test("a swap inside the turn keeps the turn's user prompt verbatim", async () => {
  const r = rig();
  const { b, pass } = await swapInsideTurn(r);
  expect(pass.applied).toBe("swapped");
  expect(pass.boundary).toBe(9);
  expect(JSON.stringify(b.messages)).toContain(SPEC);
  expect(b.messages[0]).toEqual({
    role: "user",
    content: [
      { type: "text", text: `${HISTORY_SUMMARY_MARKER}\n${SUMMARY}` },
      { type: "text", text: HISTORY_PINNED_PROMPT_MARKER },
      { type: "text", text: SPEC },
    ],
  });
  expect(b.messages[1]?.role).toBe("assistant");
});

test("the swap line names the pinned prompt with its length and sha256", async () => {
  const r = rig();
  const { pass } = await swapInsideTurn(r);
  expect(pass.applied).toBe("swapped");
  const line = (await capturedLines()).find((l) => l.includes("history swap in session"));
  const sha = createHash("sha256").update(SPEC).digest("hex").slice(0, 12);
  expect(line).toContain(
    `; the turn's prompt, message 0 (${SPEC.length} characters, sha256 ${sha}), kept verbatim after the summary`
  );
});

test("a swap that pins nothing names no prompt in its line", async () => {
  const r = rig();
  const turns = (n: number): Payload => {
    const messages: Message[] = [];
    for (let i = 0; i < n; i++) {
      messages.push({ role: "user", content: `request ${i} `.repeat(300) });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `answer ${i} `.repeat(300) }],
      });
    }
    messages.push({ role: "user", content: `request ${n}` });
    return { model, messages };
  };
  const a = turns(5);
  r.windowAt(a, 0.65);
  r.h.compact(a, session);
  await r.h.whenIdle();
  const b = turns(6);
  r.windowAt(b, 0.8);
  expect(r.h.compact(b, session).applied).toBe("swapped");
  const line = (await capturedLines()).find((l) => l.includes("history swap in session"));
  expect(line).toBeDefined();
  expect(line).not.toContain("the turn's prompt");
});

test("the pinned prompt is replayed byte for byte, across requests and a restart", async () => {
  const r = rig();
  const { b } = await swapInsideTurn(r);
  // The bytes up to and including the pinned prompt: the whole first message.
  const head = JSON.stringify(b.messages[0]);
  const sent = JSON.stringify(b.messages);

  const c = oneTurn(9);
  // Claude Code moves its cache marker to the newest message; the spec carries one here.
  (c.messages[0]?.content as Block[])[0] = {
    type: "text",
    text: SPEC,
    cache_control: { type: "ephemeral" },
  };
  r.windowAt(c, 0.8);
  expect(r.h.compact(c, session).applied).toBe("replayed");
  expect(JSON.stringify(c.messages[0])).toBe(head);
  expect(JSON.stringify(c.messages.slice(0, b.messages.length - 1))).toBe(
    JSON.stringify(JSON.parse(sent).slice(0, -1))
  );

  const d = oneTurn(10);
  r.windowAt(d, 0.8);
  expect(r.restart().compact(d, session).applied).toBe("replayed");
  expect(JSON.stringify(d.messages[0])).toBe(head);
});

test("an image block of the pinned prompt is kept", async () => {
  const r = rig();
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" },
  };
  const { b, pass } = await swapInsideTurn(r, [{ type: "text", text: SPEC }, image]);
  expect(pass.applied).toBe("swapped");
  expect((b.messages[0]?.content as Block[]).slice(1)).toEqual([
    { type: "text", text: HISTORY_PINNED_PROMPT_MARKER },
    { type: "text", text: SPEC },
    image,
  ]);
});

/**
 * A text turn ends, then the user sends a screenshot with no text. A swap
 * inside that turn pins the screenshot, the turn's real prompt, and never
 * the earlier text prompt.
 */
test("an image-only prompt starts a turn and is the prompt a swap inside it pins", async () => {
  const r = rig();
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" },
  };
  const withEarlierTurn = (rounds: number): Payload => {
    const turn = oneTurn(rounds, [image]);
    turn.messages.unshift(
      { role: "user", content: [{ type: "text", text: SPEC }] },
      { role: "assistant", content: [{ type: "text", text: "Spec noted." }] }
    );
    return turn;
  };
  const a = withEarlierTurn(6);
  r.windowAt(a, 0.65);
  expect(r.h.compact(a, session).precomputeStarted).toBe(true);
  await r.h.whenIdle();
  const b = withEarlierTurn(8);
  r.windowAt(b, 0.8);
  const pass = r.h.compact(b, session);
  expect(pass.applied).toBe("swapped");
  expect((b.messages[0]?.content as Block[]).slice(1)).toEqual([
    { type: "text", text: HISTORY_PINNED_PROMPT_MARKER },
    image,
  ]);
});

test("a swap at a human turn start keeps today's form", async () => {
  const r = rig();
  const turns = (n: number): Payload => {
    const messages: Message[] = [];
    for (let i = 0; i < n; i++) {
      messages.push({ role: "user", content: `request ${i} `.repeat(300) });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `answer ${i} `.repeat(300) }],
      });
    }
    messages.push({ role: "user", content: `request ${n}` });
    return { model, messages };
  };
  const a = turns(5);
  r.windowAt(a, 0.65);
  r.h.compact(a, session);
  await r.h.whenIdle();
  const b = turns(6);
  r.windowAt(b, 0.8);
  expect(r.h.compact(b, session).applied).toBe("swapped");
  expect(b.messages[0]).toEqual({ role: "user", content: `${HISTORY_SUMMARY_MARKER}\n${SUMMARY}` });
});

test("Claude Code's compaction request replays the real prompt, not its own instruction", async () => {
  const r = rig();
  await swapInsideTurn(r);
  const c = oneTurn(8);
  const last = c.messages[c.messages.length - 1]?.content as Block[];
  last.push({ type: "text", text: `${HARNESS_COMPACTION_PROMPT_START}\n\nSummarise.` });
  r.windowAt(c, 0.8);
  expect(r.h.compact(c, session).applied).toBe("replayed");
  const head = JSON.stringify(c.messages[0]);
  expect(head).toContain(SPEC);
  expect(head).not.toContain(HARNESS_COMPACTION_PROMPT_START);
});

test("a prompt that keeps the request past Claude Code's compaction point holds the swap", async () => {
  const r = rig();
  // About 38K tokens of prompt against 5K of tool rounds: after the swap the
  // request still holds the prompt and 2 rounds, above 0.83 of the window.
  const big = `${SPEC} ${"detail of the spec ".repeat(8000)}`;
  const a = oneTurn(6, big);
  r.windowAt(a, 0.65);
  r.h.compact(a, session);
  await r.h.whenIdle();
  const b = oneTurn(8, big);
  r.windowAt(b, 0.95);
  const pass = r.h.compact(b, session);
  expect(pass.applied).toBe("none");
  const decision = (await capturedLines()).find((l) => l.includes("history decision threshold"));
  expect(decision).toBeDefined();
  expect(decision).toContain("history decision threshold: hold");
  // S is the summary message as sent: the summary and the pinned prompt.
  const s = Number(/ S=(\d+),/.exec(decision ?? "")?.[1]);
  expect(s).toBeGreaterThan(localTokenEstimate({ content: big }) * 0.8);
  expect(decision).toContain("the current turn's prompt");
});

test("the system prompt counts: a pinned swap that stays past the compaction point holds", async () => {
  const r = rig();
  // About 20K tokens of system prompt and 20K of pinned prompt. Without the
  // system prompt the swapped request would be about 23K tokens, under 0.83
  // of the window; with it, about 43K, above.
  const system = "fixed system prompt ".repeat(4000);
  const prompt = `${SPEC} ${"detail of the spec ".repeat(4200)}`;
  const withSystem = (rounds: number) => ({ ...oneTurn(rounds, prompt), system });
  const a = withSystem(6);
  r.windowAt(a, 0.65);
  r.h.compact(a, session);
  await r.h.whenIdle();
  const b = withSystem(8);
  r.windowAt(b, 0.95);
  const pass = r.h.compact(b, session);
  expect(pass.applied).toBe("none");
  const decision = (await capturedLines()).find((l) => l.includes("history decision threshold"));
  expect(decision).toContain("history decision threshold: hold");
  expect(decision).toContain("the current turn's prompt");
});

test("a swap recorded without a pinned prompt replays its old form", async () => {
  const r = rig();
  const b = oneTurn(8);
  const record: HistorySwapRecord = {
    kind: "history-swap",
    thread: threadOf(b.messages),
    prefixHash: messagesHash(b.messages, 0, 9),
    tailHash: messagesHash(b.messages, 9, 17),
    boundary: 9,
    end: 17,
    summary: SUMMARY,
    decidedAt: new Date(0).toISOString(),
  };
  new CompactionStore(root).put(
    session,
    historyRecordKey("history-swap", session, record.prefixHash),
    record
  );
  r.windowAt(b, 0.5);
  expect(r.restart().compact(b, session).applied).toBe("replayed");
  expect(b.messages[0]).toEqual({ role: "user", content: `${HISTORY_SUMMARY_MARKER}\n${SUMMARY}` });
});
