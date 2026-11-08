import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { accountKeyFromBinding, sessionKeyFor } from "./ids.js";
import { buildCodeModeInput } from "./input-builder.js";
import { createCodeModeTurnHooks } from "./relay.js";
import { resumeFromToolResults } from "./resume.js";
import { loadQuickJSModule, resetQuickJSLoaderForTests } from "./sandbox/quickjs-loader.js";
import { ScriptStore } from "./script-store.js";
import type { CodeModeStores } from "./stores.js";
import { ToolNameTable } from "./tool-names.js";
import { nestedResultFromToolResult } from "./tool-results.js";
import { transliterateRound } from "./transliterate.js";
import { TurnRecords } from "./turn-records.js";
import type { ClaudeContentBlock, ClaudeMessage, NestedToolUse, ResponsesItem } from "./types.js";

const session = "33333333-3333-4333-8333-333333333333";
const binding = {
  auth: { arm: "oauth" as const, headers: { "chatgpt-account-id": "t4-builder" } },
};
const accountKey = accountKeyFromBinding(binding)!;
const keys = { accountKey, sessionKey: sessionKeyFor(session, accountKey)! };
const tools = [
  {
    name: "Read",
    description: "Read a file",
    input_schema: { type: "object", properties: { file_path: { type: "string" } } },
  },
];
const names = new ToolNameTable(["Read"]);
const allStores: CodeModeStores[] = [];
const transcript = readFileSync(
  new URL("../pane/test-fixtures/transcripts/tools-session.jsonl", import.meta.url),
  "utf8"
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const capturedBlocks: ClaudeContentBlock[] = transcript.flatMap((row) =>
  Array.isArray(row.message?.content) ? row.message.content : []
);
const capturedResult = capturedBlocks.find(
  (b) => b.type === "tool_result" && b.is_error === false
)!;
const classicResult = capturedBlocks.find(
  (b) =>
    b.type === "tool_result" &&
    capturedBlocks.some((u) => u.type === "tool_use" && u.id === b.tool_use_id)
)!;
const classicUse = capturedBlocks.find(
  (b) => b.type === "tool_use" && b.id === classicResult.tool_use_id
)!;
const denialRows = readFileSync(
  new URL("../pane/test-fixtures/transcripts/permission-bash-esc.jsonl", import.meta.url),
  "utf8"
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const denial: ClaudeContentBlock = denialRows
  .flatMap((row) => (Array.isArray(row.message?.content) ? row.message.content : []))
  .find((b: ClaudeContentBlock) => b.type === "tool_result" && b.is_error);

function stores(): CodeModeStores {
  const s = { scripts: new ScriptStore({ now: () => 1000 }), turns: new TurnRecords() };
  allStores.push(s);
  return s;
}
afterEach(() => {
  setSystemTime();
  for (const s of allStores.splice(0)) {
    s.scripts.clear();
    s.turns.clear();
  }
  resetQuickJSLoaderForTests();
});
const req = (messages: ClaudeMessage[]) => ({
  messages,
  tools,
  metadata: {
    user_id: JSON.stringify({ device_id: "t4", account_uuid: "t4", session_id: session }),
  },
});
const assistant = (blocks: NestedToolUse[]): ClaudeMessage => ({
  role: "assistant",
  content: blocks.map((b) => ({ type: "tool_use", id: b.id, name: b.name, input: b.input })),
});
const answer = (blocks: NestedToolUse[], label: string): ClaudeMessage => ({
  role: "user",
  content: blocks.map((b, i) => ({
    ...structuredClone(capturedResult),
    tool_use_id: b.id,
    content: `${label}-${i}`,
  })),
});
const build = (messages: ClaudeMessage[], s: CodeModeStores) =>
  buildCodeModeInput(messages, s, keys, { toolNames: names });

// Derived Claude Code message arrays use the real tool_use/tool_result shapes in
// tools-session.jsonl and permission-bash-esc.jsonl. Only IDs and text are local.
async function history(intervening = false) {
  const s = stores();
  const module = await loadQuickJSModule();
  const hooks = createCodeModeTurnHooks({
    stores: s,
    ...keys,
    shape: () => "classic",
    names,
    allTools: [],
    defaultMaxOutputTokens: 10000,
    previousMessage: undefined,
    loadModule: async () => module,
    limits: { cpuMs: 100 },
  });
  const callId = "call_abcdef0123456789abcdef0123456789";
  const first = await hooks.onExecCall({
    callId,
    input:
      'text(await tools.Read({file_path:"first"})); text(await tools.Read({file_path:"second"}));',
    precedingItems: [],
    truncated: false,
  });
  if (first.kind !== "emit-tool-uses") throw new Error("Expected initial nested calls");
  const messages: ClaudeMessage[] = [
    { role: "user", content: [{ type: "text", text: "Read both files" }] },
    assistant(first.blocks),
    answer(first.blocks, "first-result"),
  ];
  const second = resumeFromToolResults(req(messages), binding, s, undefined);
  expect(second.kind).toBe("reply");
  if (second.kind !== "reply") throw new Error("Expected the second nested call");
  messages.push(assistant(second.blocks));
  if (intervening)
    messages.push({ role: "user", content: [{ type: "text", text: "intervening-user-message" }] });
  messages.push(answer(second.blocks, "second-result"));
  expect(resumeFromToolResults(req(messages), binding, s, undefined)).toEqual({ kind: "continue" });
  return { messages, s, callId };
}

describe("T4 code-mode history", () => {
  test("REQ-15 TEST-17 emits one call and one output across two completed rounds", async () => {
    const { messages, s, callId } = await history();
    const input = build(messages, s);
    const calls = input.filter((item) => item.type === "custom_tool_call");
    const outputs = input.filter((item) => item.type === "custom_tool_call_output");
    expect(calls).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: "custom_tool_call",
      call_id: callId,
      name: "exec",
      input:
        'text(await tools.Read({file_path:"first"})); text(await tools.Read({file_path:"second"}));',
    });
    expect(outputs[0].call_id).toBe(callId);
    expect(JSON.stringify(outputs)).toContain("first-result-0");
    expect(JSON.stringify(outputs)).toContain("second-result-0");
    expect(JSON.stringify(outputs)).toContain("Script completed");
    expect(input.some((i) => i.type === "function_call" || i.type === "function_call_output")).toBe(
      false
    );
  }, 20000);

  test("REQ-16 TEST-18 emits a delayed result after its intervening user message", async () => {
    const { messages, s } = await history(true);
    const input = build(messages, s);
    const intervening = input.findIndex(
      (i) => i.type === "message" && JSON.stringify(i).includes("intervening-user-message")
    );
    const output = input.findIndex((i) => i.type === "custom_tool_call_output");
    expect(intervening).toBeGreaterThanOrEqual(0);
    expect(output).toBeGreaterThan(intervening);
    expect(input.filter((i) => i.type === "custom_tool_call_output")).toHaveLength(1);
    expect(JSON.stringify(input[output])).toContain("second-result-0");
  }, 20000);

  test("REQ-20 TEST-23 builds byte-identical input despite elapsed time and repeated calls", async () => {
    const { messages, s } = await history();
    setSystemTime(new Date("2026-10-16T00:00:00.000Z"));
    const first = JSON.stringify(build(messages, s));
    setSystemTime(new Date("2026-10-17T00:00:00.000Z"));
    const second = JSON.stringify(build(structuredClone(messages), s));
    expect(second).toBe(first);
    expect(JSON.stringify(build(messages, s))).toBe(first);
  }, 20000);

  test("REQ-20 TEST-24 moving cache_control markers does not alter a completed script's output", async () => {
    const { messages, s } = await history();
    const first = structuredClone(messages);
    const second = structuredClone(messages);
    (first[0].content as ClaudeContentBlock[])[0].cache_control = { type: "ephemeral" };
    (second[2].content as ClaudeContentBlock[])[0].cache_control = { type: "ephemeral" };
    expect(JSON.stringify(build(first, s))).toBe(JSON.stringify(build(second, s)));
    expect(JSON.stringify(build(first, s))).toContain("Script completed");
  }, 20000);

  test.each(["toolu_cx_0123456789abcdef0123456789abcdef_0", classicResult.tool_use_id!])(
    "REQ-18 TEST-20 preserves an orphan result %s as user text, not an unattached output",
    (orphanId) => {
      const s = stores();
      const messages: ClaudeMessage[] = [
        {
          role: "user",
          content: [
            {
              ...structuredClone(capturedResult),
              tool_use_id: orphanId,
              content: "orphan-visible-text",
            },
          ],
        },
      ];
      const input = build(messages, s);
      expect(input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "[Tool Result]: orphan-visible-text" }],
        },
      ]);
    }
  );

  test("REQ-19 TEST-21 transliterates the captured classic round into one exec call and output", () => {
    const s = stores();
    const messages: ClaudeMessage[] = [
      { role: "assistant", content: [structuredClone(classicUse)] },
      { role: "user", content: [structuredClone(classicResult)] },
    ];
    const input = build(messages, s);
    const callId = "call_" + createHash("sha256").update(classicUse.id!).digest("hex").slice(0, 32);
    expect(input.filter((i) => i.type === "custom_tool_call")).toHaveLength(1);
    expect(input.filter((i) => i.type === "custom_tool_call_output")).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "custom_tool_call", call_id: callId, name: "exec" });
    expect(input[1]).toMatchObject({ type: "custom_tool_call_output", call_id: callId });
    expect(JSON.stringify(input[1])).toContain("Script completed");
    expect(JSON.stringify(input[1])).toContain(String(classicResult.content));
    expect(input.some((i) => i.type.startsWith("function_call"))).toBe(false);
  });

  test("REQ-19 TEST-22 uses bracket form for a classic tool missing from today's list", () => {
    const use = { ...structuredClone(classicUse), name: "mcp__missing-tool__read" };
    const result = transliterateRound(
      { uses: [use], results: new Map([[classicResult.tool_use_id!, classicResult]]) },
      { names }
    );
    expect(result.call.input).toContain('tools["mcp__missing-tool__read"]');
    expect(result.call.input).toContain("Promise.allSettled");
    expect(result.output.status).toBe("completed");
  });

  test("REQ-19 a classic denial is output data, with the exact captured rejection text", () => {
    const result = { ...structuredClone(denial), tool_use_id: classicUse.id };
    const round = transliterateRound({
      uses: [classicUse],
      results: new Map([[classicUse.id!, result]]),
    });
    expect(round.output.status).toBe("completed");
    expect(JSON.stringify(round.output.parts)).toContain("Error: The user doesn't want to proceed");
  });

  test("REQ-19 a classic prefill emits only the exec call without a fabricated result", () => {
    const input = build([{ role: "assistant", content: [structuredClone(classicUse)] }], stores());
    expect(input).toHaveLength(1);
    expect(input[0].type).toBe("custom_tool_call");
  });

  test("REQ-20 cache_control inside tool arguments is semantic and must not be stripped", () => {
    const firstUse = {
      ...structuredClone(classicUse),
      input: { config: { cache_control: "public" } },
    };
    const secondUse = { ...firstUse, input: { config: { cache_control: "no-store" } } };
    const first = build([{ role: "assistant", content: [firstUse] }], stores());
    const second = build([{ role: "assistant", content: [secondUse] }], stores());
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
    expect(first[0].input).toContain("public");
    expect(second[0].input).toContain("no-store");
  });

  test("REQ-15 TEST-34 renders an owner's completed run identically for a fork", async () => {
    const { messages, s } = await history();
    const forkKeys = {
      accountKey,
      sessionKey: sessionKeyFor("44444444-4444-4444-8444-444444444444", accountKey)!,
    };
    expect(buildCodeModeInput(messages, s, forkKeys, { toolNames: names })).toEqual(
      build(messages, s)
    );
  }, 20000);

  test.each(["parts", "string", "script-error"])(
    "REQ-19 uses the accepted exec item envelope from the real %s roundtrip capture",
    (shape) => {
      const captured = JSON.parse(
        readFileSync(
          new URL(`../test-fixtures/code-mode/roundtrip-${shape}.request.json`, import.meta.url),
          "utf8"
        )
      );
      const capturedItems: ResponsesItem[] = captured.body.input;
      const acceptedCall = capturedItems.find((i) => i.type === "custom_tool_call")!;
      const acceptedOutput = capturedItems.find((i) => i.type === "custom_tool_call_output")!;
      const input = build(
        [
          { role: "assistant", content: [structuredClone(classicUse)] },
          { role: "user", content: [structuredClone(classicResult)] },
        ],
        stores()
      );
      expect(Object.keys(input[0]).sort()).toEqual(Object.keys(acceptedCall).sort());
      expect(Object.keys(input[1]).sort()).toEqual(Object.keys(acceptedOutput).sort());
      expect(input[0].name).toBe(acceptedCall.name);
    }
  );

  test("REQ-15 TEST-35 preserves a recorded interstitial exec before the final exec group exactly once", async () => {
    const { messages, s, callId } = await history();
    const captured = JSON.parse(
      readFileSync(
        new URL("../test-fixtures/code-mode/roundtrip-parts.request.json", import.meta.url),
        "utf8"
      )
    );
    const interstitial: ResponsesItem[] = captured.body.input.slice(-2);
    const firstNestedId = (messages[1].content as ClaudeContentBlock[])[0].id!;
    s.turns.put(keys.sessionKey, firstNestedId, structuredClone(interstitial));

    const input = build(messages, s);
    expect(
      input.filter((item) => item.type === "custom_tool_call").map((item) => item.call_id)
    ).toEqual(["call_probe_1", callId]);
    expect(
      input.filter((item) => item.type === "custom_tool_call_output").map((item) => item.call_id)
    ).toEqual(["call_probe_1", callId]);
    expect(input.slice(1, 3)).toEqual(interstitial);
    expect(JSON.stringify(build(messages, s))).toBe(JSON.stringify(input));
  }, 20000);

  test("REQ-15 TEST-36 renders an already resolved script after a restart as completed, not failed", async () => {
    const { messages } = await history();
    const later: ClaudeMessage[] = [
      ...messages,
      { role: "assistant", content: "The read finished" },
      { role: "user", content: "Next request" },
    ];
    const restartedStores = stores();

    const input = build(later, restartedStores);
    const outputs = input.filter((item) => item.type === "custom_tool_call_output");
    expect(outputs).toHaveLength(1);
    expect(JSON.stringify(outputs)).toContain("Script completed");
    expect(JSON.stringify(outputs)).toContain("output unavailable after a claudish restart");
    expect(JSON.stringify(outputs)).not.toContain("Script failed");
    expect(JSON.stringify(build(later, restartedStores))).toBe(JSON.stringify(input));
  }, 20000);

  test("REQ-1 tool result conversion preserves captured success and denial semantics", () => {
    const ok = nestedResultFromToolResult(3, capturedResult);
    const denied = nestedResultFromToolResult(4, denial);
    expect(ok).toMatchObject({ seq: 3, ok: true, text: capturedResult.content });
    expect(denied).toMatchObject({ seq: 4, ok: false, text: denial.content });
  });
});

import { execKeyFor } from "./ids.js";
import {
  LOST_SCRIPT_NOTE,
  RESTART_OUTPUT_NOTE,
  SESSION_ENDED_NOTE,
  UNKNOWN_OUTCOME_NOTE,
} from "./input-builder.js";

describe("T6 D1 system-transparent captured histories", () => {
  test.each(["cc-2.1.303-inbound-trailing-system.jsonl", "cc-2.1.304-inbound-system.jsonl"])(
    "%s renders byte-identically with inline system messages removed",
    (name) => {
      const rows = readFileSync(
        new URL(`../test-fixtures/code-mode/${name}`, import.meta.url),
        "utf8"
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const row of rows) {
        const messages: ClaudeMessage[] = row.body.messages;
        expect(messages.some((message) => message.role === "system")).toBe(true);
        const s = stores();
        expect(JSON.stringify(build(messages, s))).toBe(
          JSON.stringify(
            build(
              messages.filter((message) => message.role === "user" || message.role === "assistant"),
              s
            )
          )
        );
      }
    }
  );
});

describe("T6 D2 interrupted restart outcomes", () => {
  function restart(name = "v7-restart-interrupted-transcript.jsonl"): ClaudeMessage[] {
    const rows = readFileSync(
      new URL(`../test-fixtures/code-mode/${name}`, import.meta.url),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const end = rows.findIndex((row) => row.type === "user" && row.message?.content === "continue");
    expect(end).toBeGreaterThan(0);
    // Derived from V7-1/V7-2: merge streamed same-role rows through continue,
    // use the captured expanded initial user blob, and append the last system blob.
    const messages: ClaudeMessage[] = [];
    for (const row of rows.slice(0, end + 1)) {
      if (row.type !== "user" && row.type !== "assistant") continue;
      const message = structuredClone(row.message) as ClaudeMessage;
      const previous = messages.at(-1);
      if (previous?.role === message.role) {
        const blocks = (value: ClaudeMessage["content"]): ClaudeContentBlock[] =>
          typeof value === "string" ? [{ type: "text", text: value }] : value;
        previous.content = [...blocks(previous.content), ...blocks(message.content)];
      } else messages.push({ role: message.role, content: message.content });
    }
    const blobs = rows.slice(0, end + 1).filter((row) => row.type === "api-request-blob");
    messages[0] = structuredClone(blobs.find((row) => row.message.role === "user").message);
    messages.push(
      structuredClone(blobs.filter((row) => row.message.role === "system").at(-1).message)
    );
    return messages;
  }
  function scriptOutput(messages: ClaudeMessage[], s: CodeModeStores, callId: string) {
    const outputs = build(messages, s).filter(
      (item) => item.type === "custom_tool_call_output" && item.call_id === callId
    );
    expect(outputs).toHaveLength(1);
    const parts = outputs[0].output as { text: string }[];
    expect(parts[0].text).toMatch(/^Script (completed|terminated)\n/);
    return parts.map((part) => part.text).join("\n");
  }
  const interruptedId = "call_63b8e2084908445dbc16594bf8b0ce83";
  const resultMessage = (messages: ClaudeMessage[]) =>
    messages.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            block.type === "tool_result" &&
            String(block.content).startsWith("[Tool call interrupted")
        )
    )!;

  test.each([
    ["v7-restart-interrupted-transcript.jsonl", interruptedId],
    ["v7-restart-one-transcript.jsonl", "call_317cbe12bc434f129471d5c14bbbf6bd"],
  ])("%s terminates interrupted calls after restart", (name, callId) => {
    const messages = restart(name);
    const s = stores();
    expect(resumeFromToolResults(req(messages), binding, s, undefined)).toEqual({ kind: "none" });
    const rendered = scriptOutput(messages, s, callId);
    expect(rendered).toContain("Script terminated");
    expect(rendered).toContain(SESSION_ENDED_NOTE);
    expect(rendered).not.toContain("Script completed");
    const results = resultMessage(messages).content as ClaudeContentBlock[];
    expect(results.filter((block) => block.type === "tool_result")).toHaveLength(2);
    for (const result of results)
      expect(rendered).toContain(JSON.stringify(String(result.content)).slice(1, -1));
    if (name === "v7-restart-one-transcript.jsonl") {
      const completed = scriptOutput(messages, s, "call_c8ba165203294f6aa8cee74973a68799");
      expect(completed).toContain("Script completed");
      expect(completed).toContain(RESTART_OUTPUT_NOTE);
    }
  });

  test("interrupt-marker text in non-error results remains completed", () => {
    const messages = restart();
    // Derived V7-2 control: preserve marker text, change only the error flag.
    for (const result of resultMessage(messages).content as ClaudeContentBlock[])
      result.is_error = false;
    const rendered = scriptOutput(messages, stores(), interruptedId);
    expect(rendered).toContain("Script completed");
    expect(rendered).toContain(RESTART_OUTPUT_NOTE);
    expect(rendered).not.toContain(SESSION_ENDED_NOTE);
  });

  test("a missing result without a record renders an unknown outcome", () => {
    const messages = restart("v7-restart-one-transcript.jsonl");
    // Derived V7-1: drop one result from the completed date/whoami batch.
    // Neither surviving success result is a session-ended marker.
    const completedId = "call_c8ba165203294f6aa8cee74973a68799";
    const message = messages.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) =>
          block.tool_use_id?.includes("c8ba165203294f6aa8cee74973a68799")
        )
    )!;
    message.content = (message.content as ClaudeContentBlock[]).slice(0, 1);
    const rendered = scriptOutput(messages, stores(), completedId);
    expect(rendered).toContain("Script terminated");
    expect(rendered).toContain(UNKNOWN_OUTCOME_NOTE);
    expect(rendered).not.toContain("Script completed");
  });

  test("unconsumed session-ended results terminate a live suspended record", async () => {
    const messages = restart();
    const uses = messages.find(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "tool_use")
    )!.content as ClaudeContentBlock[];
    // Derived script from V7-2's captured Bash calls; it suspends locally and
    // never executes Bash. Claude Code's interrupted results remain unconsumed.
    const source = `await Promise.allSettled([${uses.map((use) => `tools.Bash(${JSON.stringify(use.input)})`).join(",")}]);`;
    const s = stores();
    const module = await loadQuickJSModule();
    const hooks = createCodeModeTurnHooks({
      stores: s,
      ...keys,
      shape: () => "classic",
      names: new ToolNameTable(["Bash"]),
      allTools: [],
      defaultMaxOutputTokens: 10000,
      previousMessage: undefined,
      loadModule: async () => module,
      limits: { cpuMs: 100 },
    });
    const step = await hooks.onExecCall({
      callId: interruptedId,
      input: source,
      precedingItems: [],
      truncated: false,
    });
    expect(step.kind).toBe("emit-tool-uses");
    expect(s.scripts.get(accountKey, execKeyFor(interruptedId))?.state).toBe("suspended");
    const rendered = scriptOutput(messages, s, interruptedId);
    expect(rendered).toContain("Script terminated");
    expect(rendered).toContain(SESSION_ENDED_NOTE);
    expect(rendered).not.toContain(LOST_SCRIPT_NOTE);
    expect(rendered).not.toContain("Script completed");
    expect(rendered).not.toContain("Script failed");
  }, 20000);
});
