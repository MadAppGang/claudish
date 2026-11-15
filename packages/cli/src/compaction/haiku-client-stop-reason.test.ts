import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor } from "./history.js";
import { CompactionStore, toolOutputKey } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

globalThis.fetch = (() => {
  throw new Error("Unexpected network access");
}) as unknown as typeof fetch;

const model = "test-compaction-model";
const session = "stop-reason-session";
const REFUSAL = "I cannot help with that request.";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-stop-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function answer(stop: unknown, text = REFUSAL): Response {
  return Response.json({
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    ...(stop === undefined ? {} : { stop_reason: stop }),
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function client(reply: () => Response) {
  let calls = 0;
  const c = new CompactionClient({
    apiKey: "FAKE_STOP_VALUE_0000",
    model,
    warn() {},
    record() {},
    fetchImpl: (async () => {
      calls += 1;
      return reply();
    }) as unknown as typeof fetch,
  });
  return { c, calls: () => calls };
}

const request = { system: "s", user: "u", maxTokens: 10, timeoutMs: 1000, purpose: "test" };

test("only end_turn and stop_sequence answers are accepted", async () => {
  for (const stop of ["end_turn", "stop_sequence"]) {
    const result = await client(() => answer(stop, "fine")).c.complete(request);
    expect(result).toMatchObject({ ok: true, text: "fine" });
  }
  for (const stop of ["refusal", "pause_turn", "tool_use", "max_tokens", undefined, 7]) {
    const result = await client(() => answer(stop)).c.complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/stop_reason|max_tokens/);
  }
});

test("a refusal keeps the tool output original, final across requests", async () => {
  const original = "src/a.ts:1 E_FAIL\n".repeat(2000);
  const k = client(() => answer("refusal"));
  const store = new CompactionStore(root);
  const compactor = new ToolOutputCompactor({
    store,
    client: k.c,
    settings: { enabled: true, minTokens: 4000, timeoutMs: 1000, maxRatio: 0.6 },
  });
  const payload = () => ({
    model,
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: original }] },
    ],
  });
  for (let i = 0; i < 2; i++) {
    const p = payload();
    await compactor.compact(p, session);
    expect((p.messages[2]!.content as Array<{ content: unknown }>)[0]!.content).toBe(original);
  }
  expect(store.get(session, toolOutputKey(session, "t1", original))).toMatchObject({
    form: "original",
  });
  expect(k.calls()).toBe(1);
});

test("a refusal records the history summary failed, never retried", async () => {
  const k = client(() => answer("refusal"));
  const store = new CompactionStore(root);
  const h = new HistoryCompactor({
    store,
    client: k.c,
    settings: { enabled: true, precomputeAt: 0.6, applyAt: 0.8 },
    contextWindowOf: () => 10_000,
    autoCompactWindow: () => undefined,
    summaryTimeoutMs: 1000,
  });
  const payload = () => ({
    model,
    messages: [
      { role: "user", content: "OLD " + "old data ".repeat(3100) },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ],
  });
  expect(h.compact(payload(), session).precomputeStarted).toBe(true);
  await h.whenIdle();
  const records = store.list(session).map(([, r]) => r);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ kind: "history-summary", form: "failed" });
  expect(h.compact(payload(), session).precomputeStarted).toBe(false);
  await h.whenIdle();
  expect(k.calls()).toBe(1);
});
