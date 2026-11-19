import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { DEFAULT_COMPACTION_SETTINGS } from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor } from "./history.js";
import { CompactionStore } from "./store.js";

const FOREIGN = "glm@glm-test-unsized";
const SIZED = "glm@glm-test-sized";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-unknown-window-"));
  startLogCapture();
});
afterEach(() => {
  stopLogCapture();
  rmSync(root, { recursive: true, force: true });
});

function compactor(): HistoryCompactor {
  const client = new CompactionClient({
    apiKey: "FAKE_UNKNOWN_WINDOW_0000",
    model: "test-compaction-model",
    warn() {},
    record() {},
    fetchImpl: (async () =>
      Response.json({ error: { message: "test" } }, { status: 500 })) as unknown as typeof fetch,
  });
  return new HistoryCompactor({
    store: new CompactionStore(root),
    client,
    settings: { ...DEFAULT_COMPACTION_SETTINGS.history, enabled: true },
    contextWindowOf: (model) => (model === SIZED ? 1_000 : undefined),
    autoCompactWindow: () => undefined,
  });
}

function payload(turn: string) {
  return {
    model: "claude-sonnet-test-9",
    max_tokens: 16,
    messages: [
      { role: "user", content: "old ".repeat(9000) },
      { role: "assistant", content: "answer" },
      { role: "user", content: turn },
    ],
  };
}

const offLines = async () =>
  (await capturedLines()).filter((l) => l.includes("[compaction]") && l.includes("history off"));

test("a routed model with no catalog window logs once per session that history is off", async () => {
  const history = compactor();
  history.compact(payload("one"), "session-a", FOREIGN);
  history.compact(payload("two"), "session-a", FOREIGN);
  history.compact(payload("one"), "session-b", FOREIGN);
  await history.whenIdle();
  const lines = await offLines();
  expect(lines.length).toBe(2);
  expect(lines[0]).toContain("session session-a");
  expect(lines[0]).toContain(`the catalog publishes no context window for ${FOREIGN}`);
  expect(lines[1]).toContain("session session-b");
});

test("a routed model with a catalog window logs no history-off line", async () => {
  const history = compactor();
  history.compact(payload("one"), "session-c", SIZED);
  await history.whenIdle();
  expect(await offLines()).toEqual([]);
  expect((await capturedLines()).some((l) => l.includes("history count"))).toBe(true);
});
