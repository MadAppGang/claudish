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
import { HISTORY_SUMMARY_MARKER, HistoryCompactor } from "./history.js";
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

const session = "mid-turn-session";
const model = "test-compaction-model";
const SUMMARY = "MID_TURN_SUMMARY: the refactor so far.";

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };
type Payload = { model: string; messages: Message[] };

let root: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-mid-turn-"));
  startLogCapture();
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

function rig() {
  let calls = 0;
  let window = 10_000;
  const client = new CompactionClient({
    apiKey: "FAKE_MID_TURN_0000",
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
    store: new CompactionStore(root),
    client,
    settings: { enabled: true, precomputeAt: 0.6, applyAt: 0.75 },
    contextWindowOf: () => window,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
  });
  active.push(h);
  return {
    h,
    calls: () => calls,
    /** Size the window so that `p` sits at `ratio` of it. */
    windowAt(p: Payload, ratio: number) {
      window = Math.ceil(localTokenEstimate(p) / ratio);
    },
  };
}

/**
 * One human message, then `rounds` tool rounds of one long agent turn. Round
 * `i` is the assistant message at `2i + 1` (thinking, then a tool_use) and its
 * tool_result at `2i + 2`. No human turn starts after message 0.
 */
function longTurn(rounds: number): Payload {
  const messages: Message[] = [{ role: "user", content: "Refactor nativeRouteFor everywhere" }];
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
  }
  return { model, messages };
}

/** Every tool_result in `messages` answers a tool_use in the message right before it. */
function pairingIntact(messages: readonly Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      const prev = messages[i - 1];
      if (!prev || prev.role !== "assistant" || !Array.isArray(prev.content)) return false;
      if (!prev.content.some((u) => u.type === "tool_use" && u.id === b.tool_use_id)) return false;
    }
  }
  return true;
}

test("a long turn that crosses applyAt swaps at a complete tool round, with no human turn start", async () => {
  const r = rig();

  // 6 rounds at 65%: a summary starts at a round end inside the turn,
  // keeping the newest 2 rounds out of it (boundary 9: rounds 4 and 5 stay).
  const a = longTurn(6);
  r.windowAt(a, 0.65);
  const passA = r.h.compact(a, session);
  expect(passA.precomputeStarted).toBe(true);
  await r.h.whenIdle();
  expect(r.calls()).toBe(1);

  // 8 rounds at 80%: the request ends with a tool_result, every tool_use answered.
  const b = longTurn(8);
  r.windowAt(b, 0.8);
  const passB = r.h.compact(b, session);
  expect(passB.applied).toBe("swapped");
  expect(passB.boundary).toBe(9);

  const sent = b.messages;
  expect(sent[0]).toEqual({ role: "user", content: `${HISTORY_SUMMARY_MARKER}\n${SUMMARY}` });
  expect(sent[1]?.role).toBe("assistant");
  expect(pairingIntact(sent)).toBe(true);
  expect(JSON.stringify(sent)).not.toContain("THOUGHT_");
  expect(sent.length).toBe(1 + (17 - 9));

  const lines = await capturedLines();
  expect(lines.some((l) => l.includes("history swap") && l.includes("mid-turn"))).toBe(true);

  // The next request of the same turn replays the same bytes.
  const c = longTurn(9);
  r.windowAt(c, 0.8);
  const passC = r.h.compact(c, session);
  expect(passC.applied).toBe("replayed");
  expect(JSON.stringify(c.messages.slice(0, sent.length))).toBe(JSON.stringify(sent));
});

test("a tool round with an unanswered tool_use is not a swap point", async () => {
  const r = rig();
  const a = longTurn(6);
  r.windowAt(a, 0.65);
  r.h.compact(a, session);
  await r.h.whenIdle();

  const b = longTurn(8);
  // The last assistant message asks for two tools; only one result came back.
  const asking = b.messages[b.messages.length - 2] as { content: Block[] };
  asking.content.push({ type: "tool_use", id: "t-extra", name: "Bash", input: { command: "x" } });
  r.windowAt(b, 0.8);
  const pass = r.h.compact(b, session);
  expect(pass.applied).toBe("none");
});
