import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLogCapture, stopLogCapture } from "../recovery/test-helpers/capture-log.js";
import { localTokenEstimate } from "../token-estimate.js";
import { CompactionClient } from "./haiku-client.js";
import {
  HARNESS_COMPACTION_PROMPT_START,
  harnessCompactionNote,
  isHarnessCompactionRequest,
} from "./harness-compaction.js";
import { HistoryCompactor, isHumanTurnStart, lastHumanTurnStart } from "./history.js";
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

const session = "harness-compaction-session";
const model = "test-compaction-model";

/**
 * The summary instruction Claude Code 2.1.326 sends, trimmed: its first and
 * last lines as measured, the middle left out.
 */
const COMPACTION_PROMPT = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "",
  "- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.",
  "- Your entire response must be plain text: an <analysis> block followed by a <summary> block.",
  "",
  "Your task is to create a detailed summary of the conversation so far.",
  "",
  "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.",
].join("\n");

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };
type Payload = { model: string; messages: Message[] };

let root: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-harness-"));
  startLogCapture();
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

function rig() {
  let window = 10_000;
  const store = new CompactionStore(root);
  const client = new CompactionClient({
    apiKey: "FAKE_HARNESS_COMPACTION_0000",
    model,
    warn() {},
    record() {},
    fetchImpl: (async () =>
      Response.json({
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "HARNESS_SUMMARY" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      })) as unknown as typeof fetch,
  });
  const h = new HistoryCompactor({
    store,
    client,
    settings: { enabled: true, precomputeAt: 0.6, applyAt: 0.75 },
    contextWindowOf: () => window,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
  });
  active.push(h);
  return {
    h,
    swaps: () => [...store.list(session)].filter(([, r]) => r.kind === "history-swap").length,
    windowAt(p: Payload, ratio: number) {
      window = Math.ceil(localTokenEstimate(p) / ratio);
    },
  };
}

/** One human message, then `rounds` complete tool rounds of one agent turn. */
function longTurn(rounds: number): Payload {
  const messages: Message[] = [{ role: "user", content: "Refactor nativeRouteFor everywhere" }];
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

/** `/compact` after a tool round: the instruction is a text block beside the tool_result. */
function withCompactBlock(p: Payload): Payload {
  const last = p.messages[p.messages.length - 1] as { content: Block[] };
  last.content.push({ type: "text", text: COMPACTION_PROMPT });
  return p;
}

/** Auto compaction at a turn start: the instruction is the whole user message. */
function withCompactMessage(p: Payload): Payload {
  p.messages.push({ role: "assistant", content: [{ type: "text", text: "Done." }] });
  p.messages.push({ role: "user", content: COMPACTION_PROMPT });
  return p;
}

async function readySummary(r: ReturnType<typeof rig>) {
  const a = longTurn(6);
  r.windowAt(a, 0.65);
  expect(r.h.compact(a, session).precomputeStarted).toBe(true);
  await r.h.whenIdle();
}

test("the measured instruction start is the signal", () => {
  expect(COMPACTION_PROMPT.startsWith(HARNESS_COMPACTION_PROMPT_START)).toBe(true);
  expect(isHarnessCompactionRequest(withCompactBlock(longTurn(2)).messages)).toBe(true);
  expect(isHarnessCompactionRequest(withCompactMessage(longTurn(2)).messages)).toBe(true);
  expect(isHarnessCompactionRequest(longTurn(2).messages)).toBe(false);
  const quoted = longTurn(0);
  quoted.messages[0] = {
    role: "user",
    content: `Why does it say "${HARNESS_COMPACTION_PROMPT_START}"?`,
  };
  expect(isHarnessCompactionRequest(quoted.messages)).toBe(false);
});

test("Claude Code's /compact request after a tool round records no swap", async () => {
  const r = rig();
  await readySummary(r);
  const b = withCompactBlock(longTurn(8));
  r.windowAt(b, 0.8);
  const before = JSON.stringify(b.messages);
  const pass = r.h.compact(b, session);
  expect(pass.applied).toBe("none");
  expect(pass.precomputeStarted).toBe(false);
  expect(JSON.stringify(b.messages)).toBe(before);
  expect(r.swaps()).toBe(0);
});

test("Claude Code's auto compaction request at a turn start records no swap", async () => {
  const r = rig();
  await readySummary(r);
  const b = withCompactMessage(longTurn(8));
  r.windowAt(b, 0.8);
  const pass = await r.h.compactAsync(b, session);
  expect(pass.applied).toBe("none");
  expect(r.swaps()).toBe(0);
});

test("an active swap is replayed on Claude Code's compaction request", async () => {
  const r = rig();
  await readySummary(r);
  const b = longTurn(8);
  r.windowAt(b, 0.8);
  expect(r.h.compact(b, session).applied).toBe("swapped");
  const sent = JSON.stringify(b.messages);

  const c = withCompactBlock(longTurn(8));
  r.windowAt(c, 0.8);
  const pass = r.h.compact(c, session);
  expect(pass.applied).toBe("replayed");
  expect(JSON.stringify(c.messages.slice(0, -1))).toBe(
    JSON.stringify(JSON.parse(sent).slice(0, -1))
  );
  expect(r.swaps()).toBe(1);
});

test("the compaction instruction does not start a human turn", () => {
  const p = withCompactMessage(longTurn(2));
  const last = p.messages[p.messages.length - 1];
  expect(isHumanTurnStart(last)).toBe(false);
  expect(lastHumanTurnStart(p.messages)).toBe(0);
});

test("a fallback-credit request without the instruction gets one debug note", () => {
  const beta = "claude-code-20250219,fallback-credit-2026-06-01,effort-2025-11-24";
  expect(harnessCompactionNote(longTurn(2).messages, beta)).toContain(
    "fallback-credit-2026-06-01 without Claude Code's compaction instruction"
  );
  expect(harnessCompactionNote(withCompactBlock(longTurn(2)).messages, beta)).toContain(
    "Claude Code's compaction request"
  );
  expect(harnessCompactionNote(longTurn(2).messages, "claude-code-20250219")).toBeUndefined();
});
