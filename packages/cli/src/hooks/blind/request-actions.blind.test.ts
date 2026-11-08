import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ProxyFixture,
  hook,
  startProxy,
  textOf,
  until,
  userRows,
  waitJournal,
} from "./support.ts";

const fixtures: ProxyFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const snapshotModule = `import {writeFileSync} from "node:fs";import {join} from "node:path";
export default {apiVersion:1,id:"snapshot",unsafe:true,raw:{providerRequest(ctx){
  writeFileSync(join(process.env.HOME,"request-snapshot.json"),JSON.stringify(ctx.claudeRequest));
}}};`;
const disabledBuiltins = { "plan-mode/*": "off", "session-context/*": "off" };

async function setup(actions: unknown[], fields = "", severity: Record<string, string> = {}) {
  const f = await startProxy({
    modules: [
      { name: "sample.ts", code: hook(`request(){return ${JSON.stringify(actions)}}`, fields) },
      { name: "snapshot.ts", code: snapshotModule },
    ],
    hooks: { severity: { ...disabledBuiltins, ...severity } },
  });
  fixtures.push(f);
  return f;
}
function snapshot(f: ProxyFixture): { system?: unknown; messages: unknown; tools?: unknown } {
  return JSON.parse(readFileSync(join(f.ws.layout.home, "request-snapshot.json"), "utf8"));
}
const readTool = {
  name: "Read",
  description: "reads files",
  input_schema: { type: "object", properties: { file_path: { type: "string" } } },
};
const writeTool = {
  name: "Write",
  description: "writes files",
  input_schema: { type: "object", properties: { file_path: { type: "string" } } },
};

describe("FR-2 / FR-6 request actions through config and real provider path (§4.4–4.6)", () => {
  test("R-1 injectSystemNote sets an absent system prompt", async () => {
    const f = await setup([{ type: "injectSystemNote", text: "SYSTEM-NOTE" }]);
    expect(textOf(await f.read())).toBe("original");
    expect(snapshot(f).system).toBe("SYSTEM-NOTE");
  }, 20000);

  test("R-2 identical system notes become one new paragraph", async () => {
    const f = await setup([
      { type: "injectSystemNote", text: "NOTE" },
      { type: "injectSystemNote", text: "NOTE" },
    ]);
    await f.read({ system: "BASE" });
    expect(snapshot(f).system).toBe("BASE\n\nNOTE");
  }, 20000);

  test("R-2 array system retains existing blocks and appends one note block", async () => {
    const f = await setup([{ type: "injectSystemNote", text: "NOTE" }]);
    await f.read({ system: [{ type: "text", text: "BASE" }] });
    // R-2: asserted on what the provider received — the existing system content is kept and the
    // note appears once, after it. The raw claudeRequest shape on a converting route is not fixed
    // by the contract.
    const sys = (
      f.stub.requests[0]!.body as { messages: Array<{ role: string; content: unknown }> }
    ).messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(sys).toContain("BASE");
    expect(sys.split("NOTE").length - 1).toBe(1);
    expect(sys.indexOf("NOTE")).toBeGreaterThan(sys.indexOf("BASE"));
  }, 20000);

  test("R-3 appendUserText normalizes string content and deduplicates text", async () => {
    const f = await setup([
      { type: "appendUserText", text: "TAIL" },
      { type: "appendUserText", text: "TAIL" },
    ]);
    await f.read({ messages: [{ role: "user", content: "BASE" }] });
    expect(snapshot(f).messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "BASE" },
          { type: "text", text: "TAIL" },
        ],
      },
    ]);
  }, 20000);

  test("R-4 appendUserText lands after the final user's tool_result without editing it", async () => {
    const f = await setup([{ type: "appendUserText", text: "TAIL" }]);
    const messages = [
      { role: "user", content: "HEAD" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "notes" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "UNCHANGED" }] },
    ];
    await f.read({ tools: [readTool], messages });
    expect(snapshot(f).messages).toEqual([
      messages[0],
      messages[1],
      {
        role: "user",
        content: [...(messages[2]!.content as object[]), { type: "text", text: "TAIL" }],
      },
    ]);
  }, 20000);

  test("R-5 literal replacement inserts $500 verbatim, defaults to user, and replaces all matches", async () => {
    const f = await setup([{ type: "replaceMessageText", find: "PRICE", replace: "$500" }]);
    await f.read({
      messages: [
        { role: "user", content: "PRICE PRICE" },
        { role: "assistant", content: "PRICE" },
        { role: "user", content: "PRICE" },
      ],
    });
    expect(snapshot(f).messages).toEqual([
      { role: "user", content: "$500 $500" },
      { role: "assistant", content: "PRICE" },
      { role: "user", content: "$500" },
    ]);
  }, 20000);

  test("R-6 regex replacement expands captures and explicit assistant role", async () => {
    const f = await setup([
      {
        type: "replaceMessageText",
        find: "item:(\\d+)",
        replace: "<$1>",
        regex: true,
        roles: ["assistant"],
      },
    ]);
    await f.read({
      messages: [
        { role: "user", content: "item:3" },
        { role: "assistant", content: "item:5 item:6" },
        { role: "user", content: "NEXT" },
      ],
    });
    expect(snapshot(f).messages).toEqual([
      { role: "user", content: "item:3" },
      { role: "assistant", content: "<5> <6>" },
      { role: "user", content: "NEXT" },
    ]);
  }, 20000);

  test("R-7 text edits preserve tool, thinking and media blocks byte-for-byte", async () => {
    const f = await setup([
      {
        type: "replaceMessageText",
        find: "SECRET",
        replace: "EDITED",
        roles: ["user", "assistant"],
      },
    ]);
    const protectedAssistant = [
      { type: "thinking", thinking: "SECRET", signature: "c2ln" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "SECRET" } },
    ];
    const protectedUser = [
      { type: "tool_result", tool_use_id: "t1", content: "SECRET" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "U0VDUkVU" } },
    ];
    await f.read({
      tools: [readTool],
      messages: [
        { role: "user", content: "SECRET" },
        { role: "assistant", content: [{ type: "text", text: "SECRET" }, ...protectedAssistant] },
        { role: "user", content: [...protectedUser, { type: "text", text: "SECRET" }] },
      ],
    });
    expect(snapshot(f).messages).toEqual([
      { role: "user", content: "EDITED" },
      { role: "assistant", content: [{ type: "text", text: "EDITED" }, ...protectedAssistant] },
      { role: "user", content: [...protectedUser, { type: "text", text: "EDITED" }] },
    ]);
  }, 20000);

  test("R-8 removal that empties a whole message is reverted and journaled invalid", async () => {
    const f = await setup([{ type: "removeMessageText", find: "ONLY" }]);
    await f.read({ messages: [{ role: "user", content: "ONLY" }] });
    expect(snapshot(f).messages).toEqual([{ role: "user", content: "ONLY" }]);
    await waitJournal(
      f.ws,
      (r) =>
        r.hookId === "hook:sample/test" &&
        r.decision === "invalid" &&
        (r.detail ?? "").includes("empty_message")
    );
  }, 20000);

  // REQ R-9 (Revision 2.2, hook chain). §4.4.1 rule 3: "its non-`warn` actions are applied in the
  // order the hook returned them, each over the working state every earlier action produced".
  // §4.6 replaceToolSchema: "Several apply in chain order, each replacing the current schema".
  // §4.6 tool-description sequence: "Every description action on a tool applies, in chain order,
  // each over the description the earlier ones produced: an append extends it, a replace replaces
  // it". §4.8: `superseded` "occurs only for a duplicate note or appended user text, an action on a
  // tool an earlier step removed, a second removal, and a description action on a tool a later step
  // removed" — none of which applies here, so every action is `matched`.
  test("R-9 schema and description actions apply in order, each over the last, on both tool copies", async () => {
    const firstSchema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    };
    const secondSchema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };
    const f = await setup([
      { type: "replaceToolSchema", tool: "Read", inputSchema: firstSchema },
      { type: "replaceToolSchema", tool: "Read", inputSchema: secondSchema },
      { type: "replaceToolDescription", tool: "Read", description: "FIRST" },
      { type: "rewriteToolDescription", tool: "Read", append: "-APPENDED" },
    ]);
    await f.read({ tools: [readTool] });
    expect(snapshot(f).tools).toEqual([
      { ...readTool, input_schema: secondSchema, description: "FIRST-APPENDED" },
    ]);
    const body = f.stub.requests[0]!.body as {
      tools: Array<{ function: { description: string; parameters: unknown } }>;
    };
    expect(body.tools[0]!.function).toMatchObject({
      description: "FIRST-APPENDED",
      parameters: secondSchema,
    });
    const matched = () =>
      userRows(f.ws)
        .filter((r) => r.decision === "matched")
        .map((r) => r.action)
        .sort();
    await until(() => matched().length >= 4, "four matched journal rows for R-9");
    expect(matched()).toEqual([
      "replaceToolDescription",
      "replaceToolSchema",
      "replaceToolSchema",
      "rewriteToolDescription",
    ]);
    expect(userRows(f.ws).filter((r) => r.decision === "superseded")).toEqual([]);
  }, 20000);

  test("R-10 removeTool is refused for a tool_use in conversation history", async () => {
    const f = await setup([{ type: "removeTool", tool: "Read" }]);
    await f.read({
      tools: [readTool],
      messages: [
        { role: "user", content: "READ" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "OK" }] },
      ],
    });
    expect(snapshot(f).tools).toEqual([readTool]);
    await waitJournal(
      f.ws,
      (r) =>
        r.hookId === "hook:sample/test" &&
        r.decision === "invalid" &&
        (r.detail ?? "").includes("tool_in_history")
    );
  }, 20000);

  test("R-11 removing an unused tool supersedes later description changes", async () => {
    const f = await setup([
      { type: "removeTool", tool: "Write" },
      { type: "replaceToolDescription", tool: "Write", description: "LATE" },
    ]);
    await f.read({ tools: [readTool, writeTool] });
    expect(snapshot(f).tools).toEqual([readTool]);
    await waitJournal(
      f.ws,
      (r) =>
        r.hookId === "hook:sample/test" &&
        r.action === "replaceToolDescription" &&
        r.decision === "superseded"
    );
  }, 20000);

  for (const action of [
    { type: "appendText", text: "WRONG-EVENT" },
    { type: "replaceToolDescription", tool: "Missing", description: "NEW" },
    { type: "replaceToolSchema", tool: "Read", inputSchema: { type: "array" } },
    { type: "replaceMessageText", find: "HELLO", replace: "WRONG", flags: "g" },
    { type: "replaceMessageText", find: "[", replace: "WRONG", regex: true },
  ]) {
    test(`R-12 invalid ${JSON.stringify(action)} is ignored and attributed in schema-2 journal`, async () => {
      const f = await setup([action]);
      expect(textOf(await f.read({ tools: [readTool] }))).toBe("original");
      expect(snapshot(f).messages).toEqual([{ role: "user", content: "HELLO" }]);
      expect(snapshot(f).tools).toEqual([readTool]);
      await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "invalid");
      expect(userRows(f.ws).filter((r) => r.decision === "invalid")).toContainEqual(
        expect.objectContaining({
          schema: 2,
          hookId: "hook:sample/test",
          ruleId: "hook:sample/test",
          event: "request",
          action: action.type,
        })
      );
    }, 20000);
  }
});

describe("FR-6 / FR-8 / FR-9 severity, isolation and ordering", () => {
  test("R-18 a successful handler resets the consecutive-failure breaker", async () => {
    const code = `import {appendFileSync} from "node:fs";import {join} from "node:path";
      let calls=0;${hook('request(){calls++;appendFileSync(join(process.env.HOME,"calls"),String(calls)+"\\n");if(calls===5)return [];throw new Error("FAIL")}')}`;
    const f = await startProxy({ modules: [{ name: "sample.ts", code }] });
    fixtures.push(f);
    for (let n = 0; n < 9; n++) expect(textOf(await f.read())).toBe("original");
    expect(userRows(f.ws).filter((r) => r.decision === "disabled")).toEqual([]);
    for (let n = 0; n < 2; n++) expect(textOf(await f.read())).toBe("original");
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "disabled");
    expect(readFileSync(join(f.ws.layout.home, "calls"), "utf8").trim().split("\n")).toEqual(
      Array.from({ length: 10 }, (_, n) => String(n + 1))
    );
    expect(userRows(f.ws).filter((r) => r.decision === "error")).toHaveLength(9);
  }, 30000);

  for (const [name, severity, expected] of [
    [
      "model scope beats unscoped exact",
      { "hook:sample/test": "fix", "fake-*:hook:sample/*": "warn" },
      "",
    ],
    [
      "model-scoped exact beats model-scoped glob",
      {
        "hook:sample/test": "off",
        "fake-*:hook:sample/*": "warn",
        "fake-model:hook:sample/test": "fix",
      },
      "NOTE",
    ],
  ] as const) {
    test(`R-19 ${name} uses the bare routed model`, async () => {
      const f = await setup([{ type: "injectSystemNote", text: "NOTE" }], "", severity);
      await f.read();
      expect(snapshot(f).system ?? "").toBe(expected);
      if (!expected)
        await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "warned");
    }, 20000);
  }

  test("R-20 frozen request view cannot reorder what reaches the provider", async () => {
    const f = await startProxy({
      modules: [
        { name: "sample.ts", code: hook("request(ctx){ctx.request.messages.reverse()}") },
        { name: "snapshot.ts", code: snapshotModule },
      ],
      hooks: { severity: disabledBuiltins },
    });
    fixtures.push(f);
    const messages = [
      { role: "user", content: "FIRST" },
      { role: "assistant", content: "MIDDLE" },
      { role: "user", content: "LAST" },
    ];
    expect(textOf(await f.read({ messages }))).toBe("original");
    expect(snapshot(f).messages).toEqual(messages);
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "error");
  }, 20000);
  for (const severity of ["off", "warn", "fix"]) {
    test(`R-13 ${severity} controls invocation, request changes and warn journal`, async () => {
      const code = `import {appendFileSync} from "node:fs";import {join} from "node:path";
        ${hook('request(){appendFileSync(join(process.env.HOME,"calls"),"CALL\\n");return [{type:"injectSystemNote",text:"NOTE"}]}')}`;
      const f = await startProxy({
        modules: [
          { name: "sample.ts", code },
          { name: "snapshot.ts", code: snapshotModule },
        ],
        hooks: { severity: { ...disabledBuiltins, "hook:sample/*": severity } },
      });
      fixtures.push(f);
      expect(textOf(await f.read())).toBe("original");
      expect(snapshot(f).system ?? "").toBe(severity === "fix" ? "NOTE" : "");
      const calls = join(f.ws.layout.home, "calls");
      expect(existsSync(calls)).toBe(severity !== "off");
      if (severity === "warn")
        await waitJournal(
          f.ws,
          (r) =>
            r.hookId === "hook:sample/test" &&
            r.action === "injectSystemNote" &&
            r.decision === "warned"
        );
    }, 20000);
  }

  test("R-14 throwing request handler preserves upstream request and client response", async () => {
    const f = await startProxy({
      modules: [
        { name: "sample.ts", code: hook('request(){throw new Error("REQUEST-FAIL")}') },
        { name: "snapshot.ts", code: snapshotModule },
      ],
      hooks: { severity: disabledBuiltins },
    });
    fixtures.push(f);
    expect(textOf(await f.read())).toBe("original");
    expect(snapshot(f).messages).toEqual([{ role: "user", content: "HELLO" }]);
    await waitJournal(
      f.ws,
      (r) => r.hookId === "hook:sample/test" && r.event === "request" && r.decision === "error"
    );
  }, 20000);

  test("R-15 request timeout aborts signal and discards an action returned afterwards", async () => {
    const code = `import {writeFileSync} from "node:fs";import {join} from "node:path";
      ${hook('request(ctx){return new Promise(resolve=>{ctx.signal.addEventListener("abort",()=>{writeFileSync(join(process.env.HOME,"aborted"),"YES");setTimeout(()=>resolve([{type:"injectSystemNote",text:"LATE"}]),30)},{once:true})})}', "timeoutMs:50,")}`;
    const f = await startProxy({
      modules: [
        { name: "sample.ts", code },
        { name: "snapshot.ts", code: snapshotModule },
      ],
      hooks: { severity: disabledBuiltins },
    });
    fixtures.push(f);
    expect(textOf(await f.read())).toBe("original");
    expect(snapshot(f).system ?? "").toBe("");
    await until(() => existsSync(join(f.ws.layout.home, "aborted")), "aborted timeout signal");
    expect(readFileSync(join(f.ws.layout.home, "aborted"), "utf8")).toBe("YES");
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "timeout");
  }, 20000);

  test("R-16 five consecutive failures disable the hook and the sixth request still succeeds", async () => {
    const code = `import {appendFileSync} from "node:fs";import {join} from "node:path";
      ${hook('request(){appendFileSync(join(process.env.HOME,"calls"),"CALL\\n");throw new Error("FAIL")}')}`;
    const f = await startProxy({ modules: [{ name: "sample.ts", code }] });
    fixtures.push(f);
    for (let n = 0; n < 6; n++) expect(textOf(await f.read())).toBe("original");
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "disabled");
    expect(readFileSync(join(f.ws.layout.home, "calls"), "utf8").trim().split("\n")).toEqual(
      Array(5).fill("CALL")
    );
    expect(userRows(f.ws).filter((r) => r.decision === "error")).toHaveLength(5);
    expect(
      (f.ws.diagnostics(f.process).match(/disabled after 5 consecutive failures/g) ?? []).length
    ).toBe(1);
  }, 30000);

  // REQ R-17 (Revision 2.2, hook chain). §4.4.1: "The applicable hooks of a dispatch run as a
  // hook chain: one at a time, in effective order (§6)". Rule 2: "Hook N is called only after hook
  // N−1's step has ended (returned, thrown, rejected, timed out, or been skipped). Its context is
  // built at that moment, from the dispatch's working state: the event's input plus every action
  // steps 0…N−1 applied." Rule 5: `ctx.prior` "lists, in order and with their hook ids, the actions
  // earlier steps of this dispatch applied". hooks-user-guide.md Order: "`order` (`pre`, then
  // `normal`, then `post`), then built-in hooks before yours, then the order of `hooks.modules`,
  // then export order." chain-test-targets.md 12: "the `post` hook starts only after the `pre` hook
  // returns". The post hook is exported first, so only `order` can put pre ahead of it.
  test("R-17 a post hook starts only after the held pre hook returns, and sees its note", async () => {
    const code = `import {appendFileSync,existsSync,writeFileSync} from "node:fs";import {join} from "node:path";
      const home=process.env.HOME;
      const mark=s=>appendFileSync(join(home,"marks"),s+" "+Date.now()+"\\n");
      export default [
        {apiVersion:1,id:"post",order:"post",on:{request(ctx){mark("POST-START");writeFileSync(join(home,"post-view.json"),JSON.stringify({systemText:ctx.request.systemText,prior:ctx.prior}));return [{type:"injectSystemNote",text:"POST"}]}}},
        {apiVersion:1,id:"pre",order:"pre",timeoutMs:5000,on:{async request(ctx){mark("PRE-START");writeFileSync(join(home,"pre-view.json"),JSON.stringify({prior:ctx.prior}));while(!existsSync(join(home,"release")))await Bun.sleep(5);mark("PRE-RETURN");return [{type:"injectSystemNote",text:"PRE"}]}}}
      ];`;
    const f = await startProxy({
      modules: [
        { name: "ordered.ts", code },
        { name: "snapshot.ts", code: snapshotModule },
      ],
      hooks: { severity: disabledBuiltins },
    });
    fixtures.push(f);
    const home = f.ws.layout.home;
    const marksFile = join(home, "marks");
    const marks = () =>
      existsSync(marksFile)
        ? readFileSync(marksFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const [name, at] = line.split(" ");
              return { name: name!, at: Number(at) };
            })
        : [];
    const request = f.read({ system: "BASE" });
    try {
      await until(() => marks().some((m) => m.name === "PRE-START"), "the pre hook to start");
      // Hold pre for a full second (well inside the 5,000 ms budget): post must not start meanwhile.
      await Bun.sleep(1000);
      expect(marks().map((m) => m.name)).toEqual(["PRE-START"]);
    } finally {
      writeFileSync(join(home, "release"), "GO");
    }
    expect(textOf(await request)).toBe("original");
    const seen = marks();
    expect(seen.map((m) => m.name)).toEqual(["PRE-START", "PRE-RETURN", "POST-START"]);
    expect(seen[2]!.at).toBeGreaterThanOrEqual(seen[1]!.at);
    const pre = JSON.parse(readFileSync(join(home, "pre-view.json"), "utf8")) as {
      prior: Array<{ hookId: string }>;
    };
    expect(pre.prior.filter((p) => p.hookId.startsWith("hook:"))).toEqual([]);
    const post = JSON.parse(readFileSync(join(home, "post-view.json"), "utf8")) as {
      systemText: string;
      prior: Array<{ hookId: string; action: { type: string; text?: string } }>;
    };
    expect(post.systemText).toContain("BASE");
    expect(post.systemText).toContain("PRE");
    expect(post.prior).toContainEqual(
      expect.objectContaining({
        hookId: "hook:ordered/pre",
        action: expect.objectContaining({ type: "injectSystemNote", text: "PRE" }),
      })
    );
    expect(snapshot(f).system).toBe("BASE\n\nPRE\n\nPOST");
  }, 30000);
});
