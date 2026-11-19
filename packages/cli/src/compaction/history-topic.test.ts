import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import type { HistorySettings } from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor } from "./history.js";
import { charsOf } from "./real-count.js";
import { CompactionStore } from "./store.js";
import {
  EmbedTopicDecider,
  HaikuTopicDecider,
  TOPIC_SYSTEM_PROMPT,
  type TopicDecider,
  ollamaEmbed,
} from "./topic.js";

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("Unexpected network access");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const session = "topic-session";
const model = "test-compaction-model";
const WINDOW = 200_000;

const FOLLOW_UP = "add a test for the fix you made earlier";
const NEW_TOPIC = "Write me a sourdough bread recipe for a weekend bake";

let root: string;
const active: HistoryCompactor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-topic-"));
  startLogCapture();
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((h) => h.whenIdle()));
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

function settings(decider: "haiku" | "embed"): HistorySettings {
  return {
    enabled: true,
    policy: "topic",
    precomputeAt: 0.6,
    applyAt: 0.75,
    topic: {
      decider,
      floorTokens: 30_000,
      minConfidence: 0.7,
      similarityBelow: 0.5,
      timeoutMs: 2000,
      embedModel: "nomic-embed-text",
    },
  };
}

/** A client that answers summaries with "SUMMARY" and topic calls with `topicAnswer`. */
function fakeClient(topicAnswer: string) {
  let topicCalls = 0;
  const client = new CompactionClient({
    apiKey: "FAKE_TOPIC_0000",
    model,
    warn() {},
    record() {},
    fetchImpl: (async (req: Request) => {
      const body = JSON.parse(await req.text()) as { system: string };
      const isTopic = body.system === TOPIC_SYSTEM_PROMPT;
      if (isTopic) topicCalls += 1;
      return Response.json({
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: isTopic ? topicAnswer : "SUMMARY" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }) as unknown as typeof fetch,
  });
  return { client, topicCalls: () => topicCalls };
}

function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((t) => [/pars|fix|test/i.test(t) ? 1 : 0, /bread|recipe|bake/i.test(t) ? 1 : 0, 0.05])
  );
}

function rig(opts: {
  history: HistorySettings;
  client: CompactionClient;
  decider: TopicDecider;
  firstChars: number;
}) {
  const compactor = new HistoryCompactor({
    store: new CompactionStore(root),
    client: opts.client,
    settings: opts.history,
    contextWindowOf: () => WINDOW,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
    topicDecider: opts.decider,
  });
  active.push(compactor);
  const messages: { role: string; content: unknown }[] = [
    { role: "user", content: `CONTEXT ${"w ".repeat(Math.floor(opts.firstChars / 2))}` },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "Fix the off-by-one in parse.ts" },
  ];
  return {
    compactor,
    async send(): Promise<void> {
      const payload = {
        model,
        metadata: { user_id: JSON.stringify({ session_id: session }) },
        messages: [...messages],
      };
      const result = await compactor.compactAsync(payload, session);
      if (result.mark) {
        compactor.recordUsage(result.mark, { input_tokens: Math.round(charsOf(payload) / 4) });
      }
    },
    say(prompt: string): void {
      messages.push(
        {
          role: "assistant",
          content: [{ type: "text", text: "Fixed: parse.ts checks the last index." }],
        },
        { role: "user", content: prompt }
      );
    },
  };
}

/**
 * The topic decision lines after the first request's: that request starts
 * the session above the floor before any summary exists, so it always holds
 * with "no ready summary to swap in".
 */
async function topicLines(): Promise<string[]> {
  const lines = (await capturedLines()).filter((l) =>
    /\[compaction\] topic decision (haiku|embed):/.test(l)
  );
  expect(lines[0] ?? "").toContain("reason=no ready summary to swap in");
  return lines.slice(1);
}

async function swapped(): Promise<boolean> {
  return (await capturedLines()).some((l) => l.includes("history swap in session"));
}

const NEW_ANSWER = '{"topic":"new","confidence":0.92,"reason":"baking, not the parser"}';
const RELATED_ANSWER = '{"topic":"related","confidence":0.9,"reason":"refers to the fix"}';

test("haiku: a clear topic change swaps the history for its summary", async () => {
  const fake = fakeClient(NEW_ANSWER);
  const r = rig({
    history: settings("haiku"),
    client: fake.client,
    decider: new HaikuTopicDecider(fake.client, 2000),
    firstChars: 160_000,
  });
  await r.send();
  await r.compactor.whenIdle();
  r.say(NEW_TOPIC);
  await r.send();
  const lines = await topicLines();
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain(
    "topic decision haiku: new, confidence=0.92, similarity=unknown, action=swap"
  );
  expect(await swapped()).toBe(true);
});

test("haiku: a follow-up that refers back holds", async () => {
  const fake = fakeClient(RELATED_ANSWER);
  const r = rig({
    history: settings("haiku"),
    client: fake.client,
    decider: new HaikuTopicDecider(fake.client, 2000),
    firstChars: 160_000,
  });
  await r.send();
  await r.compactor.whenIdle();
  r.say(FOLLOW_UP);
  await r.send();
  const lines = await topicLines();
  expect(lines[0]).toContain("topic decision haiku: related, confidence=0.9");
  expect(lines[0]).toContain("action=hold");
  expect(await swapped()).toBe(false);
});

test("embed: a follow-up that refers back holds, a clear topic change swaps", async () => {
  const fake = fakeClient(NEW_ANSWER);
  const r = rig({
    history: settings("embed"),
    client: fake.client,
    decider: new EmbedTopicDecider(fakeEmbed, 0.5),
    firstChars: 160_000,
  });
  await r.send();
  await r.compactor.whenIdle();
  r.say(FOLLOW_UP);
  await r.send();
  expect(await swapped()).toBe(false);
  r.say(NEW_TOPIC);
  await r.send();
  const lines = await topicLines();
  expect(lines[0]).toMatch(
    /topic decision embed: related, confidence=1, similarity=[01]\.\d+, action=hold/
  );
  expect(lines[1]).toMatch(
    /topic decision embed: new, confidence=1, similarity=0\.\d+, action=swap/
  );
  expect(await swapped()).toBe(true);
  expect(fake.topicCalls()).toBe(0);
});

test("embed: Ollama unreachable holds and says why", async () => {
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const fake = fakeClient(NEW_ANSWER);
  const embed = ollamaEmbed({
    baseUrl: `http://127.0.0.1:${port}`,
    model: "nomic-embed-text",
    timeoutMs: 2000,
    fetchImpl: realFetch,
  });
  const r = rig({
    history: settings("embed"),
    client: fake.client,
    decider: new EmbedTopicDecider(embed, 0.5),
    firstChars: 160_000,
  });
  await r.send();
  await r.compactor.whenIdle();
  r.say(NEW_TOPIC);
  await r.send();
  const lines = await topicLines();
  expect(lines[0]).toContain("topic decision embed: unknown");
  expect(lines[0]).toContain("action=hold");
  expect(lines[0]).toContain(`Ollama at http://127.0.0.1:${port} is unreachable`);
  expect(await swapped()).toBe(false);
});

test("below the floor no topic decision is made", async () => {
  const fake = fakeClient(NEW_ANSWER);
  const r = rig({
    history: settings("haiku"),
    client: fake.client,
    decider: new HaikuTopicDecider(fake.client, 2000),
    firstChars: 40_000,
  });
  await r.send();
  await r.compactor.whenIdle();
  r.say(NEW_TOPIC);
  await r.send();
  const all = (await capturedLines()).filter((l) => l.includes("[compaction] topic decision"));
  expect(all).toEqual([]);
  expect(fake.topicCalls()).toBe(0);
  expect(await swapped()).toBe(false);
});
