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
import { DEFAULT_COMPACTION_SETTINGS } from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import {
  HARNESS_COMPACTION_PROMPT_START,
  isHarnessCompactionRequest,
} from "./harness-compaction.js";
import {
  HISTORY_PINNED_PROMPT_MARKER,
  HISTORY_SUMMARY_MARKER,
  HistoryCompactor,
  applySwap,
  isSwapPoint,
  summaryBoundary,
} from "./history.js";
import { CompactionStore, type HistorySwapRecord, toolOutputKey } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

const session = "inline-system-session";
const model = "test-compaction-model";

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

let dir: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-inline-system-"));
  startLogCapture();
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(dir, { recursive: true, force: true });
});

/** The reminder Claude Code 2.1.328 adds after every tool_result when an output style is set. */
const STYLE_REMINDER = {
  role: "system",
  content: [
    {
      type: "text",
      text: "composed output style is active. Remember to follow the specific guidelines for this style.",
    },
  ],
};

test("a compaction instruction followed by an inline system message is Claude Code's compaction request", () => {
  const messages = [
    { role: "user", content: "Fix the parser" },
    { role: "system", content: [{ type: "text", text: "session context" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t-1", name: "Read", input: {} }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t-1", content: "file text" },
        { type: "text", text: `${HARNESS_COMPACTION_PROMPT_START}\n\nSummarise.` },
      ],
    },
    STYLE_REMINDER,
  ];
  expect(isHarnessCompactionRequest(messages)).toBe(true);
});

test("a tool_result followed by an inline system message is decided on its first sighting", async () => {
  let calls = 0;
  const client = new CompactionClient({
    apiKey: "FAKE_INLINE_SYSTEM_0000",
    model,
    warn() {},
    record() {},
    fetchImpl: (async () => {
      calls += 1;
      return Response.json({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "src/worker.ts:42 E_FAIL" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch,
  });
  const store = new CompactionStore(join(dir, "store"));
  const compactor = new ToolOutputCompactor({
    store,
    client,
    settings: { ...DEFAULT_COMPACTION_SETTINGS.toolOutputs, timeoutMs: 1000 },
  });
  const output = "src/worker.ts:42 E_FAIL command=bun test count=123\n".repeat(400);
  const payload = {
    model,
    messages: [
      { role: "user", content: "Run the tests" },
      { role: "system", content: [{ type: "text", text: "session context" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t-1", name: "Bash", input: { command: "bun test" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t-1", content: output }] },
      STYLE_REMINDER,
    ],
  };

  const pass = await compactor.compact(payload, session);

  expect(calls).toBe(1);
  expect(pass.compressed).toBe(1);
  expect(store.get(session, toolOutputKey(session, "t-1", output))).toMatchObject({
    form: "compressed",
  });
});

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };
type Payload = { model: string; messages: Message[] };

const PROMPT = "Refactor nativeRouteFor everywhere";
const CONTEXT = {
  role: "system",
  content: [{ type: "text", text: `SESSION_CONTEXT ${"cwd and git status ".repeat(40)}` }],
};
const SUMMARY = "INLINE_SYSTEM_SUMMARY: the refactor so far.";

/**
 * The shape Claude Code 2.1.328 sends with an output style set: the prompt,
 * the session context, then per tool round the assistant message (thinking,
 * then a tool_use), its tool_result, and the style reminder. Round `i` starts
 * at message `2 + 3i`.
 */
function styledTurn(rounds: number): Payload {
  const messages: Message[] = [{ role: "user", content: PROMPT }, structuredClone(CONTEXT)];
  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: `THOUGHT_${i}`, signature: `sig-${i}` },
        { type: "tool_use", id: `t-${i}`, name: "Bash", input: { command: `step ${i}` } },
      ],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t-${i}`, content: `out-${i} `.repeat(400) }],
    });
    messages.push(structuredClone(STYLE_REMINDER));
  }
  return { model, messages };
}

test("a tool round that ends in an inline system message is a swap point", () => {
  const p = styledTurn(6);
  expect(isSwapPoint(p.messages)).toBe(true);
  expect(summaryBoundary(p.messages)).toBe(14);
});

test("a long styled turn swaps mid-turn and keeps its inline system messages verbatim", async () => {
  const inputs: string[] = [];
  let window = 10_000;
  const h = new HistoryCompactor({
    store: new CompactionStore(join(dir, "history")),
    client: new CompactionClient({
      apiKey: "FAKE_INLINE_SYSTEM_0000",
      model,
      warn() {},
      record() {},
      fetchImpl: (async (_url: unknown, init?: { body?: unknown }) => {
        inputs.push(String(init?.body ?? ""));
        return Response.json({
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: SUMMARY }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }) as unknown as typeof fetch,
    }),
    settings: { enabled: true, precomputeAt: 0.6, applyAt: 0.75 },
    contextWindowOf: () => window,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
  });
  active.push(h);
  const windowAt = (p: Payload, ratio: number) => {
    window = Math.ceil(localTokenEstimate(p) / ratio);
  };

  const a = styledTurn(6);
  windowAt(a, 0.65);
  expect(h.compact(a, session).precomputeStarted).toBe(true);
  await h.whenIdle();
  expect(inputs.length).toBe(1);
  expect(inputs[0]).not.toContain("SESSION_CONTEXT");
  expect(inputs[0]).not.toContain("output style is active");

  const b = styledTurn(8);
  windowAt(b, 0.8);
  const pass = h.compact(b, session);
  expect(pass.applied).toBe("swapped");
  expect(pass.boundary).toBe(14);

  const sent = b.messages;
  expect(sent[0]).toEqual({
    role: "user",
    content: [
      { type: "text", text: `${HISTORY_SUMMARY_MARKER}\n${SUMMARY}` },
      { type: "text", text: HISTORY_PINNED_PROMPT_MARKER },
      { type: "text", text: PROMPT },
    ],
  });
  // Each distinct inline system message of [0, 14) once, in first-seen order.
  expect(sent[1]).toEqual(CONTEXT);
  expect(sent[2]).toEqual(STYLE_REMINDER);
  expect(sent[3]?.role).toBe("assistant");
  expect(sent.length).toBe(3 + (2 + 3 * 8 - 14));
  expect(JSON.stringify(sent)).not.toContain("THOUGHT_");

  const lines = await capturedLines();
  expect(lines.some((l) => l.includes("history swap") && l.includes("mid-turn"))).toBe(true);
  const contextChars = (CONTEXT.content[0] as { text: string }).text.length;
  const reminderChars = (STYLE_REMINDER.content[0] as { text: string }).text.length;
  expect(
    lines.some(
      (l) =>
        l.includes("history swap") &&
        l.endsWith(
          `; 2 inline system messages kept verbatim (${contextChars}, ${reminderChars} characters)`
        )
    )
  ).toBe(true);

  // The next request of the turn replays the same bytes.
  const c = styledTurn(9);
  windowAt(c, 0.8);
  expect(h.compact(c, session).applied).toBe("replayed");
  expect(JSON.stringify(c.messages.slice(0, sent.length))).toBe(JSON.stringify(sent));
});

/** True when every run of inline system messages ends before an assistant message or ends the array. */
function systemOrderValid(messages: readonly Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== "system") continue;
    const next = messages[i + 1];
    if (next !== undefined && next.role !== "system" && next.role !== "assistant") return false;
  }
  return true;
}

function swapRecord(boundary: number, end: number): HistorySwapRecord {
  return {
    kind: "history-swap",
    thread: "t",
    prefixHash: "p",
    tailHash: "t",
    boundary,
    end,
    summary: SUMMARY,
  } as HistorySwapRecord;
}

test("a swap at a human-turn start places the kept system messages where the API accepts them", () => {
  // Turn 1 of three rounds, then turn 2's prompt with its trailing reminder.
  const turn1 = styledTurn(3).messages;
  const promptAt = turn1.length;
  const first: Message[] = [
    ...turn1,
    { role: "user", content: "Now list the exports" },
    STYLE_REMINDER,
  ];
  const swap = swapRecord(promptAt, first.length);

  const sentFirst = applySwap(first, swap) as Message[];
  expect(systemOrderValid(sentFirst)).toBe(true);
  expect(sentFirst.filter((m) => JSON.stringify(m) === JSON.stringify(CONTEXT)).length).toBe(1);

  // The next request of turn 2 adds the assistant's tool round.
  const second: Message[] = [
    ...first,
    { role: "assistant", content: [{ type: "tool_use", id: "t-x", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t-x", content: "ok" }] },
    STYLE_REMINDER,
  ];
  const sentSecond = applySwap(second, swap) as Message[];
  expect(systemOrderValid(sentSecond)).toBe(true);
  expect(JSON.stringify(sentSecond.slice(0, sentFirst.length))).toBe(JSON.stringify(sentFirst));
});
