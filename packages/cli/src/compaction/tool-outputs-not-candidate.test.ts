import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { CompactionClient } from "./haiku-client.js";
import { CompactionStore } from "./store.js";
import { ToolOutputCompactor, estimateTokens } from "./tool-outputs.js";

const session = "not-candidate-session";
const model = "test-compaction-model";
const large = "src/worker.ts:42 E_FAIL command=bun test count=123\n".repeat(400);
const small = "src/worker.ts:42 E_FAIL\n".repeat(100);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-not-candidate-"));
  startLogCapture();
});
afterEach(() => {
  stopLogCapture();
  rmSync(dir, { recursive: true, force: true });
});

function rig() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "src/worker.ts:42 E_FAIL" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }) as unknown as typeof fetch;
  const client = new CompactionClient({
    apiKey: "FAKE_NOT_CANDIDATE_0000",
    model,
    fetchImpl,
    warn() {},
    record() {},
  });
  const store = new CompactionStore(join(dir, "store"));
  const settings = { enabled: true, minTokens: 4000, timeoutMs: 1000, maxRatio: 0.6 };
  return { compactor: new ToolOutputCompactor({ store, client, settings }), calls: () => calls };
}

function payload(name: string, result: Record<string, unknown>, earlier = false) {
  const round = [
    { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name, input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", ...result }] },
  ];
  const after = earlier
    ? [
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        { role: "user", content: "Next" },
      ]
    : [];
  return { model, messages: [{ role: "user", content: "Look" }, ...round, ...after] };
}

const notCompressed = async () =>
  (await capturedLines()).filter(
    (l) => l.includes(": tool_result tool-1 (") && l.includes("not compressed")
  );

test("a fresh output below minTokens is logged with its estimate", async () => {
  const r = rig();
  await r.compactor.compact(payload("Bash", { content: small }), session);
  expect(r.calls()).toBe(0);
  const lines = await notCompressed();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEndWith(
    `[compaction] session ${session}: tool_result tool-1 (Bash) not compressed: ${estimateTokens(small)} tokens, below minTokens 4000`
  );
});

test("a fresh output of a skipTools tool is logged", async () => {
  const r = rig();
  await r.compactor.compact(payload("Read", { content: large }), session);
  expect(r.calls()).toBe(0);
  const lines = await notCompressed();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEndWith(
    `[compaction] session ${session}: tool_result tool-1 (Read) not compressed: Read is in skipTools`
  );
});

test("a fresh error output is logged", async () => {
  const r = rig();
  await r.compactor.compact(payload("Bash", { content: large, is_error: true }), session);
  const lines = await notCompressed();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEndWith("not compressed: is_error");
});

test("an output outside the last message is not logged again", async () => {
  const r = rig();
  await r.compactor.compact(payload("Bash", { content: small }, true), session);
  expect(await notCompressed()).toHaveLength(0);
});

test("a compressed output logs no not-compressed line", async () => {
  const r = rig();
  await r.compactor.compact(payload("Bash", { content: large }), session);
  expect(r.calls()).toBe(1);
  expect(await notCompressed()).toHaveLength(0);
});
