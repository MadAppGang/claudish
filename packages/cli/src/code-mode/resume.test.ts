import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { accountKeyFromBinding, execKeyFor, sessionKeyFor } from "./ids.js";
import { buildCodeModeInput } from "./input-builder.js";
import { createCodeModeTurnHooks } from "./relay.js";
import { resumeFromToolResults } from "./resume.js";
import { loadQuickJSModule, resetQuickJSLoaderForTests } from "./sandbox/quickjs-loader.js";
import { ScriptStore } from "./script-store.js";
import type { CodeModeStores } from "./stores.js";
import { ToolNameTable } from "./tool-names.js";
import { TurnRecords } from "./turn-records.js";
import {
  type ClaudeContentBlock,
  type ClaudeMessage,
  type NestedToolUse,
  relayNestedInput,
} from "./types.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FORK = "22222222-2222-4222-8222-222222222222";
const CALL = "call_0123456789abcdef0123456789abcdef";
const tools = [
  {
    name: "Read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
];
const names = new ToolNameTable(["Read"]);
const binding = {
  auth: { arm: "oauth" as const, headers: { "chatgpt-account-id": "t4-account" } },
};
const accountKey = accountKeyFromBinding(binding)!;
const keys = (session = OWNER) => ({ accountKey, sessionKey: sessionKeyFor(session, accountKey)! });
const transcripts = (name: string) =>
  readFileSync(new URL(`../pane/test-fixtures/transcripts/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const blocksIn = (rows: ReturnType<typeof transcripts>): ClaudeContentBlock[] =>
  rows.flatMap((row) => (Array.isArray(row.message?.content) ? row.message.content : []));
const success = blocksIn(transcripts("tools-session.jsonl")).find(
  (b) => b.type === "tool_result" && b.is_error === false
)!;
const permissionBlocks = blocksIn(transcripts("permission-bash-esc.jsonl"));
const denial = permissionBlocks.find((b) => b.type === "tool_result" && b.is_error)!;
const interrupt = permissionBlocks.find(
  (b) => b.type === "text" && b.text?.startsWith("[Request interrupted by user")
)!;
const threeRounds =
  'text(await tools.Read({file_path:"f0"})); text(await tools.Read({file_path:"f1"})); text(await tools.Read({file_path:"f2"}));';
const storesToClear: CodeModeStores[] = [];

function makeStores(): CodeModeStores {
  const stores = { scripts: new ScriptStore({ now: () => 1000 }), turns: new TurnRecords() };
  storesToClear.push(stores);
  return stores;
}
afterEach(() => {
  for (const s of storesToClear.splice(0)) {
    s.scripts.clear();
    s.turns.clear();
  }
  resetQuickJSLoaderForTests();
});

// Derived message arrays: exact tool_result / interrupt block shapes from
// pane transcripts permission-bash-esc.jsonl and tools-session.jsonl, with local
// IDs/content replaced to answer each script. No protocol stream is fabricated.
function result(id: string, text = "LONGDONE"): ClaudeContentBlock {
  return { ...structuredClone(success), tool_use_id: id, content: text };
}
function assistant(uses: NestedToolUse[]): ClaudeMessage {
  return {
    role: "assistant",
    content: uses.map((b) => ({ type: "tool_use", id: b.id, name: b.name, input: b.input })),
  };
}
function answer(uses: NestedToolUse[], prefix = "r"): ClaudeMessage {
  return { role: "user", content: uses.map((b, i) => result(b.id, `${prefix}${i}`)) };
}
function request(messages: ClaudeMessage[], session = OWNER) {
  // Public resume signature leaves metadata unknown; use Claude Code's JSON
  // user_id form. The plan records this explicit contract assumption.
  return {
    messages,
    tools,
    metadata: {
      user_id: JSON.stringify({ device_id: "t4", account_uuid: "t4", session_id: session }),
    },
  };
}
function resume(messages: ClaudeMessage[], stores: CodeModeStores, session = OWNER) {
  return resumeFromToolResults(request(messages, session), binding, stores, undefined);
}
function output(messages: ClaudeMessage[], stores: CodeModeStores, session = OWNER) {
  return JSON.stringify(buildCodeModeInput(messages, stores, keys(session), { toolNames: names }));
}
function next(
  outcome: ReturnType<typeof resumeFromToolResults>
): [NestedToolUse, ...NestedToolUse[]] {
  expect(outcome.kind).toBe("reply");
  if (outcome.kind !== "reply") throw new Error("Expected a synthetic tool-use reply");
  return outcome.blocks;
}
async function begin(source = threeRounds) {
  const stores = makeStores();
  const module = await loadQuickJSModule();
  expect(module).toBeDefined();
  const hooks = createCodeModeTurnHooks({
    stores,
    ...keys(),
    shape: () => "classic",
    names,
    allTools: [],
    defaultMaxOutputTokens: 10000,
    previousMessage: undefined,
    loadModule: async () => module,
    limits: { cpuMs: 100 },
  });
  const step = await hooks.onExecCall({
    callId: CALL,
    input: source,
    precedingItems: [],
    truncated: false,
  });
  expect(step.kind).toBe("emit-tool-uses");
  if (step.kind !== "emit-tool-uses") throw new Error("Script did not block");
  const messages: ClaudeMessage[] = [
    { role: "user", content: "Read the files" },
    assistant(step.blocks),
    answer(step.blocks),
  ];
  return { stores, messages, blocks: step.blocks, hooks };
}
function addRound(
  messages: ClaudeMessage[],
  blocks: NestedToolUse[],
  prefix = "r"
): ClaudeMessage[] {
  return [...messages, assistant(blocks), answer(blocks, prefix)];
}
function lose(stores: CodeModeStores) {
  const record = stores.scripts.get(accountKey, execKeyFor(CALL))!;
  stores.scripts.transition(record, "evict");
}

describe("T4 resume table", () => {
  test("REQ-1 TEST-1 replies with the owner's next batch and TEST-2 continues after completion", async () => {
    const { stores, messages } = await begin(
      'text(await tools.Read({file_path:"f0"})); text(await tools.Read({file_path:"f1"}));'
    );
    const blocks = next(resume(messages, stores));
    expect(blocks).toEqual([
      {
        id: "toolu_cx_0123456789abcdef0123456789abcdef_1",
        name: "Read",
        input: { file_path: "f1" },
      },
    ]);
    const completed = addRound(messages, blocks, "last");
    expect(resume(completed, stores)).toEqual({ kind: "continue" });
    expect(output(completed, stores)).toContain("Script completed");
    expect(output(completed, stores)).toContain("last0");
  }, 20000);

  test("REQ-2 TEST-3 rejects a missing parallel result with no tool_result returned", async () => {
    const { stores, messages, blocks } = await begin(
      'const r=await Promise.allSettled([tools.Read({file_path:"a"}),tools.Read({file_path:"b"})]); r.forEach(x=>text(JSON.stringify(x)));'
    );
    messages[messages.length - 1] = { role: "user", content: [result(blocks[0].id)] };
    expect(resume(messages, stores)).toEqual({ kind: "continue" });
    expect(output(messages, stores)).toContain("no tool_result returned");
    expect(output(messages, stores)).toContain("rejected");
    expect(output(messages, stores)).toContain("LONGDONE");
  }, 20000);

  test("REQ-3 TEST-4 replays identical batch IDs on duplicate requests and keeps completion stable", async () => {
    const { stores, messages } = await begin();
    const first = next(resume(messages, stores));
    expect(next(resume(structuredClone(messages), stores))).toEqual(first);
    const round1 = addRound(messages, first);
    const second = next(resume(round1, stores));
    const completed = addRound(round1, second, "final");
    expect(resume(completed, stores)).toEqual({ kind: "continue" });
    const before = output(completed, stores);
    expect(resume(structuredClone(completed), stores)).toEqual({ kind: "continue" });
    expect(output(completed, stores)).toBe(before);
  }, 20000);

  test("REQ-4 TEST-5 terminates for the captured interrupt and preserves the denied result", async () => {
    const { stores, messages, blocks } = await begin();
    messages[messages.length - 1] = {
      role: "user",
      content: [
        { ...structuredClone(denial), tool_use_id: blocks[0].id },
        structuredClone(interrupt),
      ],
    };
    expect(resume(messages, stores)).toEqual({ kind: "continue" });
    const built = output(messages, stores);
    expect(built).toContain("Script terminated");
    expect(built).toContain("interrupted by the user");
    expect(built).toContain("The user doesn't want to proceed");
    expect(built).not.toContain("Script completed");
  }, 20000);

  test("REQ-1 TEST-33 passes a denial without an interrupt to the script as a plain rejected string", async () => {
    const { stores, messages, blocks } = await begin(
      'try { await tools.Read({file_path:"a"}); } catch(e) { text(typeof e); text(e); }'
    );
    messages[messages.length - 1] = {
      role: "user",
      content: [{ ...structuredClone(denial), tool_use_id: blocks[0].id }],
    };
    expect(resume(messages, stores)).toEqual({ kind: "continue" });
    expect(output(messages, stores)).toContain("Script completed");
    expect(output(messages, stores)).toContain('"string"');
    expect(output(messages, stores)).toContain("The user doesn't want to proceed");
    expect(output(messages, stores)).not.toContain("Script terminated");
  }, 20000);

  test.each(["empty", "omitted"])(
    "REQ-6 TEST-7 leaves a suspended batch alone when tools are %s",
    async (variant) => {
      const { stores, messages } = await begin();
      const req: { messages: ClaudeMessage[]; metadata: unknown; tools?: typeof tools } =
        request(messages);
      if (variant === "empty") req.tools = [];
      else delete req.tools;
      expect(resumeFromToolResults(req, binding, stores, undefined)).toEqual({ kind: "none" });
      expect(next(resume(messages, stores))[0].input).toEqual({ file_path: "f1" });
    },
    20000
  );

  test("REQ-7 TEST-8 gives a consumed-batch fork a tombstone without stealing the owner's next round", async () => {
    const { stores, messages } = await begin();
    const round1 = next(resume(messages, stores));
    expect(resume(messages, stores, FORK)).toEqual({ kind: "continue" });
    const forkOutput = output(messages, stores, FORK);
    expect(forkOutput).toContain("Script failed");
    expect(forkOutput).toContain("this script belongs to the session this one was forked from");
    expect(forkOutput).not.toContain("Script completed");
    const ownerRound1 = addRound(messages, round1, "owner");
    const round2 = next(resume(ownerRound1, stores));
    expect(round2[0].input).toEqual({ file_path: "f2" });
    const finished = addRound(ownerRound1, round2, "finished");
    expect(resume(finished, stores)).toEqual({ kind: "continue" });
    expect(output(finished, stores, FORK)).toBe(output(finished, stores));
  }, 20000);

  test("REQ-8 TEST-9 tombstones when earlier consumed results change", async () => {
    const { stores, messages } = await begin();
    const later = addRound(messages, next(resume(messages, stores)));
    const changed = structuredClone(later);
    (changed[2].content as ClaudeContentBlock[])[0].content = "changed first result";
    expect(resume(changed, stores)).toEqual({ kind: "continue" });
    expect(output(changed, stores)).toContain("Script failed");
    expect(output(changed, stores)).toContain("claudish lost this script's state");
  }, 20000);

  test("REQ-9 TEST-10 cannot resume another account's record", async () => {
    const { stores, messages } = await begin();
    const other = {
      auth: { arm: "oauth" as const, headers: { "chatgpt-account-id": "other-t4-account" } },
    };
    expect(resumeFromToolResults(request(messages), other, stores, undefined).kind).not.toBe(
      "reply"
    );
    expect(next(resume(messages, stores))[0].input).toEqual({ file_path: "f1" });
  }, 20000);

  test.each([{ type: "any" }, { type: "none" }, { type: "tool", name: "Read" }] as const)(
    "REQ-25 TEST-29 ignores a forced tool choice $type",
    async (choice) => {
      const { stores, messages } = await begin();
      expect(resumeFromToolResults(request(messages), binding, stores, choice)).toEqual({
        kind: "none",
      });
      expect(next(resume(messages, stores))[0].input).toEqual({ file_path: "f1" });
    },
    20000
  );

  test("REQ-25 TEST-30 leaves prefill and unrelated subagent history resumable", async () => {
    const { stores, messages } = await begin();
    resume(messages.slice(0, -1), stores);
    resume([{ role: "user", content: "An unrelated subagent prompt" }], stores);
    expect(next(resume(messages, stores))[0].input).toEqual({ file_path: "f1" });
  }, 20000);

  test("REQ-25 TEST-31 terminates when the conversation moves past the pending batch", async () => {
    const { stores, messages } = await begin();
    const moved = [
      ...messages.slice(0, -1),
      { role: "user", content: "Do something else instead" },
    ];
    resume(moved, stores);
    expect(output(moved, stores)).toContain("Script terminated");
    expect(output(moved, stores)).toContain("the conversation moved on without the tool results");
    expect(resume(messages, stores).kind).not.toBe("reply");
  }, 20000);
});

describe("T4 restart and replay", () => {
  test("REQ-5 REQ-10 TEST-6 TEST-11 creates a stable failed tombstone on the first answer after restart", async () => {
    const started = await begin();
    const stores = makeStores();
    expect(
      resumeFromToolResults(request(started.messages), binding, undefined, undefined, {
        createStores: () => stores,
      })
    ).toEqual({ kind: "continue" });
    const first = output(started.messages, stores);
    expect(first).toContain("Script failed");
    expect(first).toContain("claudish lost this script's state");
    expect(first).toContain("r0");
    const later: ClaudeMessage[] = [
      ...started.messages,
      { role: "assistant", content: "Recovered answer" },
      { role: "user", content: "Next question" },
    ];
    for (let i = 0; i < 2; i++) {
      resume(later, stores);
      const rendered = buildCodeModeInput(later, stores, keys()).filter(
        (x) => x.type === "custom_tool_call_output"
      );
      const original = buildCodeModeInput(started.messages, stores, keys()).filter(
        (x) => x.type === "custom_tool_call_output"
      );
      expect(rendered).toEqual(original);
      expect(JSON.stringify(rendered)).toContain("Script failed");
    }
  }, 20000);

  test("REQ-11 TEST-12 requests a missing module once and tombstones if loading is not allowed", async () => {
    const { stores, messages } = await begin();
    lose(stores);
    resetQuickJSLoaderForTests();
    expect(
      resumeFromToolResults(request(messages), binding, stores, undefined, {
        mayRequestModule: true,
      })
    ).toEqual({ kind: "needs-module" });
    expect(
      resumeFromToolResults(request(messages), binding, stores, undefined, {
        mayRequestModule: false,
      })
    ).toEqual({ kind: "continue" });
    expect(output(messages, stores)).toContain("Script failed");
    expect(
      resumeFromToolResults(request(messages), binding, stores, undefined, {
        mayRequestModule: true,
      }).kind
    ).not.toBe("needs-module");
  }, 20000);

  test("REQ-11 TEST-13 re-enters after loading a module and returns the next batch", async () => {
    const { stores, messages } = await begin();
    lose(stores);
    resetQuickJSLoaderForTests();
    expect(
      resumeFromToolResults(request(messages), binding, stores, undefined, {
        mayRequestModule: true,
      })
    ).toEqual({ kind: "needs-module" });
    expect(await loadQuickJSModule()).toBeDefined();
    expect(
      next(
        resumeFromToolResults(request(messages), binding, stores, undefined, {
          mayRequestModule: false,
        })
      )[0].input
    ).toEqual({ file_path: "f1" });
  }, 20000);

  test("REQ-12 TEST-14 replays two answered rounds and blocks on the third call", async () => {
    const { stores, messages } = await begin();
    const round1 = addRound(messages, next(resume(messages, stores)), "second");
    lose(stores);
    expect(next(resume(round1, stores))).toEqual([
      {
        id: "toolu_cx_0123456789abcdef0123456789abcdef_2",
        name: "Read",
        input: { file_path: "f2" },
      },
    ]);
  }, 20000);

  test("REQ-13 TEST-15 terminates interrupted replay without emitting the next call", async () => {
    const { stores, messages } = await begin();
    const round1 = addRound(messages, next(resume(messages, stores)), "second");
    (round1[round1.length - 1].content as ClaudeContentBlock[]).push(structuredClone(interrupt));
    lose(stores);
    expect(resume(round1, stores)).toEqual({ kind: "continue" });
    const rendered = output(round1, stores);
    expect(rendered).toContain("Script terminated");
    expect(rendered).toContain("interrupted by the user");
    expect(rendered).toContain("second0");
    expect(rendered).not.toContain("Script completed");
  }, 20000);

  test("REQ-14 TEST-16 replays recorded Layer 4 repairs instead of treating them as divergence", async () => {
    const { stores, messages, blocks } = await begin();
    const repair = (_name: string, args: string) =>
      JSON.stringify({ ...JSON.parse(args), repaired: true });
    relayNestedInput(blocks[0], repair);
    messages[1] = assistant(blocks);
    const second = next(resume(messages, stores));
    relayNestedInput(second[0], repair);
    const round1 = addRound(messages, second, "repaired-result");
    lose(stores);
    expect(next(resume(round1, stores))[0].input).toEqual({ file_path: "f2" });
  }, 20000);
});
