import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StubPart } from "../../test-helpers/stub-upstream.ts";
import {
  events,
  type ProxyFixture,
  gatedProvider,
  hook,
  readUntil,
  startProxy,
  textOf,
  thinkingOf,
  toolInputs,
  until,
  waitJournal,
} from "./support.ts";

const fixtures: ProxyFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

async function rewrite(
  actions: unknown[],
  parts: StubPart[] = [{ text: "KEEP REMOVE-ME KEEP" }],
  fields = ""
) {
  const f = await startProxy({
    modules: [
      {
        name: "sample.ts",
        code: hook(`responseRewrite:{handle(){return ${JSON.stringify(actions)}}}`, fields),
      },
    ],
    script: [{ parts }],
  });
  fixtures.push(f);
  return f;
}
async function remainder(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let raw = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return raw + decoder.decode();
    raw += decoder.decode(next.value, { stream: true });
  }
}

describe("FR-2 / FR-4 response edits received by a Claude client (§4.4–4.6)", () => {
  test("S-1 add/remove/replace actions execute sequentially before the client receives text", async () => {
    const f = await rewrite([
      { type: "removeText", find: " REMOVE-ME" },
      { type: "replaceText", find: "KEEP", replace: "SAFE" },
      { type: "appendText", text: " HOOK-ADDED" },
      { type: "prependText", text: "START " },
    ]);
    const raw = await f.read();
    expect(textOf(raw)).toBe("START SAFE SAFE HOOK-ADDED");
    expect(raw).not.toContain("REMOVE-ME");
    // S-1: the contract (§4.8) assigns no specific decision value to an applied responseRewrite
    // action, so assert each action was journaled and none was refused, overridden or failed.
    await waitJournal(
      f.ws,
      (r) =>
        r.hookId === "hook:sample/test" &&
        r.event === "responseRewrite" &&
        r.action === "prependText"
    );
    const rows = f.ws
      .journal()
      .filter((r) => r.hookId === "hook:sample/test" && r.event === "responseRewrite");
    expect(rows.map((r) => r.action).sort()).toEqual([
      "appendText",
      "prependText",
      "removeText",
      "replaceText",
    ]);
    expect(
      rows.filter((r) =>
        ["warned", "invalid", "error", "timeout", "superseded", "disabled", "dropped"].includes(
          r.decision
        )
      )
    ).toEqual([]);
  }, 20000);

  test("S-2 append and prepend wrap existing text without changing reasoning", async () => {
    const f = await rewrite(
      [
        { type: "prependText", text: "<" },
        { type: "appendText", text: ">" },
      ],
      [{ thinking: "PRIVATE" }, { text: "ANSWER" }]
    );
    const raw = await f.read();
    expect({ text: textOf(raw), reasoning: thinkingOf(raw) }).toEqual({
      text: "<ANSWER>",
      reasoning: "PRIVATE",
    });
  }, 20000);

  for (const [name, action, original, expected] of [
    [
      "literal dollar value",
      { type: "replaceText", find: "PRICE", replace: "$500" },
      "PRICE PRICE",
      "$500 $500",
    ],
    [
      "regex capture expansion",
      { type: "replaceText", find: "item:(\\d+)", replace: "<$1>", regex: true },
      "item:1 item:2",
      "<1> <2>",
    ],
    [
      "regex removal",
      { type: "removeText", find: "\\s*REMOVE-ME", regex: true },
      "KEEP REMOVE-ME KEEP",
      "KEEP KEEP",
    ],
  ] as const) {
    test(`S-3 ${name} produces exact client text`, async () => {
      const f = await rewrite([action], [{ text: original }]);
      expect(textOf(await f.read())).toBe(expected);
    }, 20000);
  }

  test("S-4 dropping empty text reindexes the following tool to zero", async () => {
    const f = await rewrite(
      [{ type: "removeText", find: "ERASE" }],
      [{ text: "ERASE" }, { toolCall: { name: "Read", args: { file_path: "notes" } } }]
    );
    const raw = await f.read();
    expect(
      events(raw)
        .filter((e) => e.type === "content_block_start")
        .map((e) => ({ index: e.index, type: e.content_block?.type }))
    ).toEqual([{ index: 0, type: "tool_use" }]);
    expect(toolInputs(raw)).toEqual([{ name: "Read", input: { file_path: "notes" } }]);
  }, 20000);

  for (const action of ["appendText", "prependText"]) {
    test(`S-5/S-6 ${action} in a thinking/tool-only response inserts text at index 1`, async () => {
      const f = await rewrite(
        [{ type: action, text: "HOOK-ADDED" }],
        [
          { thinking: "THINK" },
          { toolCall: { name: "Read", args: { file_path: "a" } } },
          { toolCall: { name: "Write", args: { file_path: "b" } } },
        ]
      );
      const raw = await f.read();
      expect(
        events(raw)
          .filter((e) => e.type === "content_block_start")
          .map((e) => ({ index: e.index, type: e.content_block?.type }))
      ).toEqual([
        { index: 0, type: "thinking" },
        { index: 1, type: "text" },
        { index: 2, type: "tool_use" },
        { index: 3, type: "tool_use" },
      ]);
      expect({ text: textOf(raw), reasoning: thinkingOf(raw), tools: toolInputs(raw) }).toEqual({
        text: "HOOK-ADDED",
        reasoning: "THINK",
        tools: [
          { name: "Read", input: { file_path: "a" } },
          { name: "Write", input: { file_path: "b" } },
        ],
      });
    }, 20000);
  }

  test("S-6 append to thinking-only inserts text after the leading thinking block", async () => {
    const f = await rewrite([{ type: "appendText", text: "ANSWER" }], [{ thinking: "THINK" }]);
    const raw = await f.read();
    expect(
      events(raw)
        .filter((e) => e.type === "content_block_start")
        .map((e) => ({ index: e.index, type: e.content_block?.type }))
    ).toEqual([
      { index: 0, type: "thinking" },
      { index: 1, type: "text" },
    ]);
    expect(textOf(raw)).toBe("ANSWER");
  }, 20000);

  test("S-7 complete named tool arguments are repaired; other tool and text are unchanged", async () => {
    const f = await startProxy({
      modules: [
        {
          name: "sample.ts",
          code: hook(
            'toolCall:{tools:["Read"],handle(ctx){if(ctx.tool.args.file_path!=="wrong")throw new Error("incomplete args");return [{type:"repairToolArgs",args:{file_path:"correct"},reason:"normalise"}]}}'
          ),
        },
      ],
      script: [
        {
          parts: [
            { text: "UNCHANGED" },
            { toolCall: { name: "Read", args: { file_path: "wrong" } } },
            { toolCall: { name: "Write", args: { file_path: "other", content: "UNTOUCHED" } } },
          ],
          deltaChars: 2,
        },
      ],
    });
    fixtures.push(f);
    const raw = await f.read();
    expect({ text: textOf(raw), tools: toolInputs(raw) }).toEqual({
      text: "UNCHANGED",
      tools: [
        { name: "Read", input: { file_path: "correct" } },
        { name: "Write", input: { file_path: "other", content: "UNTOUCHED" } },
      ],
    });
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "repaired");
    const rows = f.ws
      .journal()
      .filter((r) => r.hookId === "hook:sample/test" && r.action === "repairToolArgs");
    expect(rows.map((r) => ({ tool: r.toolName, keys: r.argKeys }))).toEqual([
      { tool: "Read", keys: ["file_path"] },
    ]);
    expect(JSON.stringify(rows)).not.toContain("correct");
  }, 20000);

  for (const condition of ["unarmed", "observe", "warn"]) {
    test(`S-8 ${condition} tool hook never commits repairToolArgs`, async () => {
      const opts =
        condition === "unarmed"
          ? "armed(){return false},"
          : condition === "observe"
            ? "observe:true,"
            : "";
      const f = await startProxy({
        modules: [
          {
            name: "sample.ts",
            code: hook(
              `toolCall:{tools:["Read"],${opts}handle(){return [{type:"repairToolArgs",args:{file_path:"WRONG"},reason:"must not commit"}]}}`
            ),
          },
        ],
        hooks: condition === "warn" ? { severity: { "hook:sample/*": "warn" } } : {},
        script: [{ parts: [{ toolCall: { name: "Read", args: { file_path: "original" } } }] }],
      });
      fixtures.push(f);
      expect(toolInputs(await f.read())).toEqual([
        { name: "Read", input: { file_path: "original" } },
      ]);
    }, 20000);
  }

  test("S-9 responseEnd receives the final rewritten normalized response", async () => {
    const code = `import {writeFileSync} from "node:fs";import {join} from "node:path";
      ${hook('responseRewrite:{handle(){return [{type:"appendText",text:"-EDIT"}]}},responseEnd(ctx){writeFileSync(join(process.env.HOME,"end.json"),JSON.stringify(ctx.response))}')}`;
    const f = await startProxy({
      modules: [{ name: "sample.ts", code }],
      script: [{ parts: [{ thinking: "THINK" }, { text: "ANSWER" }] }],
    });
    fixtures.push(f);
    expect(textOf(await f.read())).toBe("ANSWER-EDIT");
    const file = join(f.ws.layout.home, "end.json");
    await until(() => existsSync(file), "responseEnd normalized output");
    const view = JSON.parse(readFileSync(file, "utf8"));
    expect({
      text: view.text,
      reasoning: view.reasoning,
      toolNames: view.toolNames,
      stopReason: view.stopReason,
    }).toEqual({ text: "ANSWER-EDIT", reasoning: "THINK", toolNames: [], stopReason: "end_turn" });
  }, 20000);

  for (const condition of ["throw", "timeout"]) {
    test(`S-10/S-11 ${condition} during rewrite forwards original text and another hook still applies`, async () => {
      const bad =
        condition === "throw"
          ? 'handle(){throw new Error("REWRITE-FAIL")}'
          : "handle(){return new Promise(()=>{})}";
      const f = await startProxy({
        modules: [
          { name: "bad.ts", code: hook(`responseRewrite:{${bad}}`, "timeoutMs:50,") },
          {
            name: "good.ts",
            code: hook('responseRewrite:{handle(){return [{type:"appendText",text:"-GOOD"}]}}'),
          },
        ],
      });
      fixtures.push(f);
      expect(textOf(await f.read())).toBe("original-GOOD");
      await waitJournal(
        f.ws,
        (r) =>
          r.hookId === "hook:bad/test" &&
          r.decision === (condition === "throw" ? "error" : "timeout")
      );
    }, 20000);
  }

  test("S-12 async responseEnd cannot delay message_stop reaching the client", async () => {
    const code = `import {writeFileSync,existsSync} from "node:fs";import {join} from "node:path";
      ${hook('async responseEnd(){writeFileSync(join(process.env.HOME,"end-started"),"YES");while(!existsSync(join(process.env.HOME,"release-end")))await Bun.sleep(10);writeFileSync(join(process.env.HOME,"end-finished"),"YES")}', "timeoutMs:5000,")}`;
    const f = await startProxy({ modules: [{ name: "sample.ts", code }] });
    fixtures.push(f);
    try {
      expect(textOf(await f.read())).toBe("original");
      await until(() => existsSync(join(f.ws.layout.home, "end-started")), "responseEnd start");
      expect(existsSync(join(f.ws.layout.home, "end-finished"))).toBe(false);
    } finally {
      writeFileSync(join(f.ws.layout.home, "release-end"), "GO");
    }
    await until(() => existsSync(join(f.ws.layout.home, "end-finished")), "released responseEnd");
  }, 20000);
});

describe("FR-4 streaming untouched unless a fix hook claims it", () => {
  const unheld = [
    ["no modules", undefined, {}],
    [
      "claims false",
      hook(
        'responseRewrite:{claims(){return false},handle(){return [{type:"appendText",text:"BAD"}]}}'
      ),
      {},
    ],
    [
      "claims throws",
      hook(
        'responseRewrite:{claims(){throw new Error("CLAIM-FAIL")},handle(){return [{type:"appendText",text:"BAD"}]}}'
      ),
      {},
    ],
    [
      "warn severity",
      hook('responseRewrite:{handle(){return [{type:"appendText",text:"BAD"}]}}'),
      { severity: { "hook:sample/*": "warn" } },
    ],
  ] as const;
  for (const [condition, code, hooks] of unheld) {
    test(`S-13 ${condition} delivers FIRST while the upstream is still held open`, async () => {
      const gate = gatedProvider();
      const f = await startProxy({
        endpointUrl: gate.url,
        modules: code ? [{ name: "sample.ts", code }] : [],
        hooks,
      });
      fixtures.push(f);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const res = await f.fetch();
        expect(res.status).toBe(200);
        reader = res.body!.getReader();
        const prefix = await readUntil(reader, (raw) => textOf(raw) === "FIRST");
        expect(gate.released).toBe(false);
        expect(textOf(prefix)).toBe("FIRST");
        gate.release();
        const raw = prefix + (await remainder(reader));
        expect(textOf(raw)).toBe("FIRSTSECOND");
        if (condition === "no modules") {
          await until(
            () => f.ws.debug().includes("mode=none raw=0 tap=0"),
            "identity seam diagnostic"
          );
          expect(f.ws.debug()).toContain("mode=none raw=0 tap=0");
        }
        if (condition === "warn severity")
          await waitJournal(
            f.ws,
            (r) => r.hookId === "hook:sample/test" && r.decision === "warned"
          );
      } finally {
        gate.release();
        await reader?.cancel().catch(() => {});
        gate.stop();
      }
    }, 20000);
  }

  test("S-14 claimed buffer forwards pings but no text before the provider completes", async () => {
    const gate = gatedProvider();
    const f = await startProxy({
      endpointUrl: gate.url,
      modules: [
        {
          name: "sample.ts",
          code: hook('responseRewrite:{handle(){return [{type:"appendText",text:"-EDIT"}]}}'),
        },
      ],
    });
    fixtures.push(f);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await f.fetch();
      expect(res.status).toBe(200);
      reader = res.body!.getReader();
      const prefix = await readUntil(reader, (raw) => events(raw).some((e) => e.type === "ping"));
      expect({ text: textOf(prefix), released: gate.released }).toEqual({
        text: "",
        released: false,
      });
      gate.release();
      const raw = prefix + (await remainder(reader));
      expect(textOf(raw)).toBe("FIRSTSECOND-EDIT");
      await until(() => f.ws.debug().includes("mode=buffer"), "buffer seam diagnostic");
      expect(f.ws.debug()).toContain("mode=buffer");
    } finally {
      gate.release();
      await reader?.cancel().catch(() => {});
      gate.stop();
    }
  }, 20000);

  test("S-15 seam emits a ping while awaiting rewrite after the upstream already closed", async () => {
    const code = `import {existsSync,writeFileSync} from "node:fs";import {join} from "node:path";
      ${hook('responseRewrite:{async handle(){writeFileSync(join(process.env.HOME,"rewrite-started"),"YES");while(!existsSync(join(process.env.HOME,"release-rewrite")))await Bun.sleep(5);return [{type:"appendText",text:"-EDIT"}]}}', "timeoutMs:5000,")}`;
    const f = await startProxy({ modules: [{ name: "sample.ts", code }] });
    fixtures.push(f);
    const res = await f.fetch();
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      await until(
        () => existsSync(join(f.ws.layout.home, "rewrite-started")),
        "rewrite called after provider end"
      );
      const prefix = await readUntil(reader, (raw) => events(raw).some((e) => e.type === "ping"));
      expect(textOf(prefix)).toBe("");
      writeFileSync(join(f.ws.layout.home, "release-rewrite"), "GO");
      expect(textOf(prefix + (await remainder(reader)))).toBe("original-EDIT");
    } finally {
      writeFileSync(join(f.ws.layout.home, "release-rewrite"), "GO");
      await reader.cancel().catch(() => {});
    }
  }, 20000);

  test("S-16 multi-byte network split preserves emoji and CJK through rewrite", async () => {
    const f = await startProxy({
      modules: [
        {
          name: "sample.ts",
          code: hook('responseRewrite:{handle(){return [{type:"appendText",text:" ✓"}]}}'),
        },
      ],
      script: [{ parts: [{ text: "答え 🍐 東京" }], splitMultibyte: true, deltaChars: 1 }],
    });
    fixtures.push(f);
    expect(textOf(await f.read())).toBe("答え 🍐 東京 ✓");
  }, 20000);

  test("S-17 no-modules negative control retains REMOVE-ME and never adds the marker", async () => {
    const f = await startProxy({
      modules: [],
      script: [{ parts: [{ text: "KEEP REMOVE-ME KEEP" }] }],
    });
    fixtures.push(f);
    const raw = await f.read();
    expect(textOf(raw)).toBe("KEEP REMOVE-ME KEEP");
    expect(raw).not.toContain("HOOK-ADDED");
    expect(f.ws.journal().filter((r) => r.hookId.startsWith("hook:"))).toEqual([]);
  }, 20000);
});
