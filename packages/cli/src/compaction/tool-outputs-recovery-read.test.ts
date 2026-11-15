import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { CompactionClient } from "./haiku-client.js";
import { CompactionStore, toolOutputKey } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

const session = "recovery-read-session";
const sibling = "recovery-read-sibling";
const model = "test-compaction-model";
const original = "src/worker.ts:42 E_FAIL command=bun test count=123\n".repeat(400);
const storedKey = "a".repeat(64);

let root: string;
beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "compaction-recovery-read-")), "store");
  startLogCapture();
});
afterEach(() => {
  stopLogCapture();
  rmSync(join(root, ".."), { recursive: true, force: true });
});

function rig(skipTools: string[] = []) {
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
    apiKey: "FAKE_RECOVERY_READ_0000",
    model,
    fetchImpl,
    warn() {},
    record() {},
  });
  const store = new CompactionStore(root);
  // Read is skipped by default; the recovery-read rule must hold without that.
  const settings = { enabled: true, minTokens: 4000, timeoutMs: 1000, maxRatio: 0.6, skipTools };
  const compactor = new ToolOutputCompactor({ store, client, settings });
  return { store, compactor, calls: () => calls };
}

function readPayload(filePath: string) {
  return {
    model,
    messages: [
      { role: "user", content: "Read the full output" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: filePath } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read-1", content: original }],
      },
    ],
  };
}

const recoveryLine = (key: string) => `[compaction] session ${session}: recovery read ${key}`;

test("a Read of this session's recovery file is never compressed nor recorded, and logged once", async () => {
  const r = rig();
  const path = r.store.writeRecovery(session, storedKey, original);
  const first = readPayload(path);
  const untouched = structuredClone(first);

  await r.compactor.compact(first, session);

  expect(r.calls()).toBe(0);
  expect(first).toEqual(untouched);
  expect(r.store.get(session, toolOutputKey(session, "read-1", original))).toBeUndefined();

  // A later request: the Read is no longer in the last message.
  const later = structuredClone(untouched) as ReturnType<typeof readPayload> & {
    messages: Array<{ role: string; content: unknown }>;
  };
  later.messages.push({ role: "assistant", content: [{ type: "text", text: "Read it." }] });
  later.messages.push({ role: "user", content: "Continue" });
  const laterUntouched = structuredClone(later);
  await r.compactor.compact(later, session);

  expect(r.calls()).toBe(0);
  expect(later).toEqual(laterUntouched);
  expect(r.store.get(session, toolOutputKey(session, "read-1", original))).toBeUndefined();
  const lines = (await capturedLines()).filter((l) => l.includes("recovery read"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEndWith(recoveryLine(storedKey));
});

test("a Read of the recovery file through the session folder's real path is not compressed", async () => {
  const r = rig();
  r.store.writeRecovery(session, storedKey, original);
  const real = join(realpathSync(r.store.sessionDir(session)), `${storedKey}.txt`);
  const p = readPayload(real);
  const untouched = structuredClone(p);

  await r.compactor.compact(p, session);

  expect(r.calls()).toBe(0);
  expect(p).toEqual(untouched);
  expect(r.store.get(session, toolOutputKey(session, "read-1", original))).toBeUndefined();
});

test("a Read of a sibling session's recovery file is still compressed", async () => {
  const r = rig();
  const path = r.store.writeRecovery(sibling, storedKey, original);
  const p = readPayload(path);

  await r.compactor.compact(p, session);

  expect(r.calls()).toBe(1);
  expect(r.store.get(session, toolOutputKey(session, "read-1", original))?.kind).toBe(
    "tool-output"
  );
  const lines = (await capturedLines()).filter((l) => l.includes("recovery read"));
  expect(lines).toHaveLength(0);
});

test("a recovery read is logged also when Read is in skipTools", async () => {
  const r = rig(["Read"]);
  const path = r.store.writeRecovery(session, storedKey, original);

  await r.compactor.compact(readPayload(path), session);

  expect(r.calls()).toBe(0);
  const lines = (await capturedLines()).filter((l) => l.includes("recovery read"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEndWith(recoveryLine(storedKey));
});
