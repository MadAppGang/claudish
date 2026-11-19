import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS } from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import {
  HARNESS_COMPACTION_PROMPT_START,
  isHarnessCompactionRequest,
} from "./harness-compaction.js";
import { CompactionStore, toolOutputKey } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

const session = "inline-system-session";
const model = "test-compaction-model";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-inline-system-"));
});
afterEach(() => {
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
