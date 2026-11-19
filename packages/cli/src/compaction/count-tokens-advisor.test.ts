import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _debug_resetTrackedAdvisorIds,
  getAdvisorCall,
  markAdvisorCallConsumed,
  recordAdvisorEventsFromResponseBody,
  rewriteAdvisorToolResults,
} from "../handlers/native-handler-advisor.js";
import { DEFAULT_COMPACTION_SETTINGS } from "./config.js";
import { applyStoredForms, compactRequest } from "./decorator.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor } from "./history.js";
import type { CompactionRuntime } from "./runtime.js";
import { CompactionStore } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

const session = "count-tokens-advisor-session";
const ADVICE_ID = "toolu_advisor_count_1";
const MODEL = "test-compaction-model";

let root: string;
let history: HistoryCompactor;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-count-advisor-"));
});
afterEach(async () => {
  await history?.whenIdle();
  _debug_resetTrackedAdvisorIds();
  rmSync(root, { recursive: true, force: true });
});

function runtime(): CompactionRuntime {
  const client = new CompactionClient({
    apiKey: "FAKE_COUNT_ADVISOR_0000",
    model: MODEL,
    warn() {},
    record() {},
    fetchImpl: (async () =>
      Response.json({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "SUMMARY" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as unknown as typeof fetch,
  });
  const store = new CompactionStore(root);
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    enabled: true,
    toolOutputs: { ...DEFAULT_COMPACTION_SETTINGS.toolOutputs, enabled: false },
  };
  history = new HistoryCompactor({
    store,
    client,
    settings: settings.history,
    contextWindowOf: () => 10_000,
    autoCompactWindow: () => undefined,
  });
  return {
    settings,
    model: MODEL,
    client,
    store,
    toolOutputs: new ToolOutputCompactor({ store, client, settings: settings.toolOutputs }),
    history,
  };
}

function base() {
  return {
    model: "claude-test-9",
    metadata: {
      user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: session }),
    },
    messages: [
      { role: "user", content: "old ".repeat(9000) } as Record<string, unknown>,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: ADVICE_ID, name: "advisor", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: ADVICE_ID,
            is_error: true,
            content: "<tool_use_error>Error: No such tool available: advisor</tool_use_error>",
          },
        ],
      },
      { role: "assistant", content: "noted" },
      { role: "user", content: "next turn" },
    ],
  };
}

function withHumanTurn() {
  const p = base();
  p.messages.push({ role: "assistant", content: "more" });
  p.messages.push({ role: "user", content: "continue" });
  return p;
}

/** What `/v1/messages` does before compaction: the advisor's stored results. */
function advisorPass(p: ReturnType<typeof base>) {
  rewriteAdvisorToolResults(p, (id) => getAdvisorCall(id, session)?.result, session);
  return p;
}

test("count_tokens replays a stored advisor result before the history swap, as /v1/messages does", async () => {
  recordAdvisorEventsFromResponseBody(
    { enabled: true, logPath: undefined },
    { content: [{ type: "tool_use", name: "advisor", id: ADVICE_ID, input: {} }] },
    session
  );
  expect(markAdvisorCallConsumed(ADVICE_ID, { text: "ADVICE", isError: false }, session)).toBe(
    true
  );
  const rt = runtime();
  await compactRequest(rt, advisorPass(base()));
  await history.whenIdle();
  const sent = advisorPass(withHumanTurn());
  await compactRequest(rt, sent);
  expect((sent.messages[0] as { content: string }).content).toContain("SUMMARY");

  const counted = withHumanTurn();
  applyStoredForms(rt, counted);
  expect(counted.messages).toEqual(sent.messages);
});
