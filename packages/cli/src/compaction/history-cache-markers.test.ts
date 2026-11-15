import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutCacheMarkers } from "../code-mode/hashes.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor, messagesHash, threadOf } from "./history.js";
import { CompactionStore } from "./store.js";

globalThis.fetch = (() => {
  throw new Error("Unexpected network access");
}) as unknown as typeof fetch;

const session = "marker-session";
const model = "test-compaction-model";
const SUMMARY = "MARKER_SUMMARY: the earlier work.";
const MARK = { type: "ephemeral" } as const;

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[]; cache_control?: unknown };
type Payload = { model: string; messages: Message[] };

let root: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-markers-"));
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  rmSync(root, { recursive: true, force: true });
});

function rig(store = new CompactionStore(root)) {
  let calls = 0;
  const client = new CompactionClient({
    apiKey: "FAKE_MARKER_VALUE_0000",
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
    contextWindowOf: () => 10_000,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
  });
  active.push(h);
  return { h, store, calls: () => calls };
}

/** Claude Code's shape: markers on the last two content blocks of the request only. */
function markLastTwo(p: Payload): Payload {
  const out = structuredClone(p);
  const blocks: Block[] = [];
  for (const m of out.messages) {
    if (typeof m.content === "string") m.content = [{ type: "text", text: m.content }];
    for (const b of m.content as Block[]) {
      delete b.cache_control;
      blocks.push(b);
    }
  }
  for (const b of blocks.slice(-2)) b.cache_control = MARK;
  return out;
}

function base(): Payload {
  return {
    model,
    messages: [
      { role: "user", content: "OLD_PREFIX " + "old data ".repeat(3100) },
      { role: "assistant", content: [{ type: "text", text: "Previous work complete" }] },
      { role: "user", content: "Start retained work" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "TAIL", signature: "sig1" },
          { type: "text", text: "Inspect file" },
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: "src/a.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read-1", content: "file content" }],
      },
    ],
  };
}

function withHumanTurn(p: Payload): Payload {
  const out = structuredClone(p);
  out.messages.push({ role: "user", content: "Continue " + "new ".repeat(2600) });
  return out;
}

function nextToolRound(p: Payload, n: number): Payload {
  const out = structuredClone(p);
  out.messages.push({
    role: "assistant",
    content: [{ type: "tool_use", id: `t-${n}`, name: "Bash", input: { command: `ls ${n}` } }],
  });
  out.messages.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `t-${n}`, content: `out ${n}` }],
  });
  return out;
}

test("hashes ignore cache_control on messages and blocks, but not inside a tool_use input", () => {
  const plain: Message[] = [
    { role: "user", content: [{ type: "text", text: "x" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "a", name: "T", input: { cache_control: 1 } }],
    },
  ];
  const marked = structuredClone(plain);
  marked[0]!.cache_control = MARK;
  (marked[0]!.content as Block[])[0]!.cache_control = MARK;
  expect(messagesHash(marked, 0, 2)).toBe(messagesHash(plain, 0, 2));
  expect(threadOf(marked)).toBe(threadOf(plain));
  const nested = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "a",
          content: [{ type: "text", text: "r", cache_control: MARK }],
        },
      ],
    },
  ];
  expect(messagesHash(nested, 0, 1)).toBe(messagesHash(withoutCacheMarkers(nested) as [], 0, 1));
  const inputChanged = structuredClone(plain);
  (inputChanged[1]!.content as Block[])[0]!.input = { cache_control: 2 };
  expect(messagesHash(inputChanged, 0, 2)).not.toBe(messagesHash(plain, 0, 2));
});

test("a summary prepared under one marker layout still swaps after the markers moved", async () => {
  const r = rig();
  // The precompute request carries markers inside the prefix it summarises,
  // on the first message (the thread) and on the message before the boundary.
  const first = markLastTwo(base());
  first.messages[0]!.cache_control = MARK;
  (first.messages[1]!.content as Block[])[0]!.cache_control = MARK;
  expect(r.h.compact(first, session).precomputeStarted).toBe(true);
  await r.h.whenIdle();
  expect(r.calls()).toBe(1);
  // Two tool rounds later, the human turn: every marker sits elsewhere.
  const later = withHumanTurn(nextToolRound(nextToolRound(base(), 1), 2));
  const swapping = markLastTwo(later);
  expect(r.h.compact(swapping, session).applied).toBe("swapped");
  expect(swapping.messages[0]!.content).toBe(
    `[claudish: summary of the earlier conversation]\n${SUMMARY}`
  );
});

test("a swap replays with the same content when the markers move, also after a store reload", async () => {
  const r = rig();
  r.h.compact(markLastTwo(base()), session);
  await r.h.whenIdle();
  const human = withHumanTurn(base());
  const swapped = markLastTwo(human);
  swapped.messages[0]!.cache_control = MARK;
  expect(r.h.compact(swapped, session).applied).toBe("swapped");
  const swappedContent = JSON.stringify(withoutCacheMarkers(swapped.messages));
  const swappedLength = swapped.messages.length;

  const reloaded = rig(new CompactionStore(root));
  let request = human;
  for (let n = 1; n <= 3; n++) {
    request = nextToolRound(request, n);
    for (const h of [r.h, reloaded.h]) {
      const sent = markLastTwo(request);
      expect(h.compact(sent, session).applied).toBe("replayed");
      const head = JSON.stringify(withoutCacheMarkers(sent.messages.slice(0, swappedLength)));
      expect(head).toBe(swappedContent);
      const counted = markLastTwo(request);
      expect(h.replay(counted, session)).toBe(true);
      expect(JSON.stringify(counted.messages)).toBe(JSON.stringify(sent.messages));
    }
  }
  expect(r.calls()).toBe(1);
});
