import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFakeClaudeWrapper } from "../../pane/test-helpers/hermetic-env.ts";
import { startStubUpstream, stubEndpointConfig } from "../../test-helpers/stub-upstream.ts";
import {
  events,
  ENTRY,
  type JournalRow,
  type ProxyFixture,
  Workspace,
  hook,
  readUntil,
  startProxy,
  textOf,
  toolInputs,
  until,
  userRows,
  waitJournal,
} from "./support.ts";

const fixtures: ProxyFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const disabledBuiltins = { "plan-mode/*": "off", "session-context/*": "off" };
const traceImports = `import {appendFileSync,existsSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const record=(kind,value)=>appendFileSync(join(process.env.HOME,"chain-seen.jsonl"),JSON.stringify({kind,value})+"\\n");`;
const traced = (on: string, fields = "") => `${traceImports}\n${hook(on, fields)}`;
const id = (name: string) => `hook:${name}/test`;
const readTool = {
  name: "Read",
  description: "ORIGINAL-DESCRIPTION",
  input_schema: { type: "object", properties: { file_path: { type: "string" } } },
};

type ProxyOptions = NonNullable<Parameters<typeof startProxy>[0]>;
type TraceRow = { kind: string; value: any };
type ProviderMessage = { role: string; content: string | Array<{ type: string; text?: string }> };
type ProviderBody = {
  messages: ProviderMessage[];
  tools?: Array<{
    type: string;
    function: { name: string; description?: string; parameters?: unknown };
  }>;
};

async function setup(opts: ProxyOptions = {}): Promise<ProxyFixture> {
  const f = await startProxy({
    ...opts,
    hooks: {
      ...opts.hooks,
      severity: { ...disabledBuiltins, ...(opts.hooks?.severity as object) },
    },
  });
  fixtures.push(f);
  return f;
}

function trace(ws: Workspace): TraceRow[] {
  const path = join(ws.layout.home, "chain-seen.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s))
    : [];
}
function provider(f: ProxyFixture, n = 0): ProviderBody {
  expect(f.stub.requests[n]).toBeDefined();
  return f.stub.requests[n]!.body as ProviderBody;
}
function contentText(content: ProviderMessage["content"]): string {
  if (typeof content === "string") return content;
  expect(content.map((b) => b.type)).toEqual(content.map(() => "text"));
  return content.map((b) => b.text ?? "").join("\n\n");
}
function systemText(f: ProxyFixture, n = 0): string {
  return provider(f, n)
    .messages.filter((m) => m.role === "system")
    .map((m) => contentText(m.content))
    .join("\n\n");
}
// §4.6: hooks edit the Claude-format system prompt ("appended … as a new paragraph"); Stage A
// runs "before conversion". What conversion to the provider format adds is not fixed by the hook
// contract (this route prepends its own leading paragraph). So the provider text must END with
// exactly the hook-controlled text, at a paragraph boundary, and no paragraph before it may be
// one of the hook-controlled paragraphs (or one listed in `absent`).
function expectSystem(f: ProxyFixture, expected: string, n = 0, absent: string[] = []): void {
  const text = systemText(f, n);
  if (!text.endsWith(expected)) expect(text).toBe(expected); // prints the whole provider text
  const head = text.slice(0, text.length - expected.length);
  const hookParagraphs = new Set([...expected.split("\n\n"), ...absent]);
  expect({
    boundary: head === "" || head.endsWith("\n\n"),
    hookParagraphsBeforeIt: head.split("\n\n").filter((p) => hookParagraphs.has(p)),
  }).toEqual({ boundary: true, hookParagraphsBeforeIt: [] });
}
// §4.8 does not say a journal line is on disk by the time the client has the response; wait for
// the expected number of rows, then assert on them exactly.
async function settle(ws: Workspace, event: string, count: number): Promise<void> {
  await until(
    () =>
      ws.journal().filter((r) => r.hookId.startsWith("hook:") && r.event === event).length >= count,
    `${count} ${event} journal rows`
  );
}
function rows(ws: Workspace, event: string): JournalRow[] {
  const selected = ws.journal().filter((r) => r.hookId.startsWith("hook:") && r.event === event);
  for (const r of selected)
    expect({ schema: r.schema, ruleId: r.ruleId }).toEqual({ schema: 2, ruleId: r.hookId });
  return selected;
}
function decisions(ws: Workspace, event: string): string[][] {
  return rows(ws, event).map((r) => [r.hookId, r.decision]);
}
function actions(ws: Workspace, event: string) {
  return rows(ws, event).map((r) => ({ hookId: r.hookId, action: r.action, decision: r.decision }));
}
const applied = (name: string, action: string, decision = "matched") => ({
  hookId: id(name),
  action,
  decision,
});
// §4.8 fixes the fields of a journal line, not the order of lines, and in runs 1–2 the lines of
// one dispatch landed in varying order (even one hook's own actions). Chain ORDER is proven by the
// traces, ctx.prior and the provider payload; journal rows are compared as an exact multiset.
const bag = <T>(xs: T[]): T[] =>
  [...xs].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

// support.startProxy has no extra-argv/environment seam. This variant uses the same
// Workspace, fake Claude and stub APIs only, for the public flag and inbox env contract.
async function launchProxy(
  opts: ProxyOptions,
  flags: string[] = [],
  inbox = false
): Promise<ProxyFixture> {
  const ws = new Workspace();
  const stub = startStubUpstream({
    format: "openai-sse",
    script: opts.script ?? [{ parts: [{ text: "original" }] }],
  });
  try {
    const modules = (opts.modules ?? []).map((m) => ws.module(m.name, m.code));
    ws.save({
      ...stubEndpointConfig(stub),
      ...opts.config,
      hooks: {
        ...opts.hooks,
        modules,
        severity: { ...disabledBuiltins, ...(opts.hooks?.severity as object) },
      },
    });
    const sessionId = randomUUID();
    ws.sessionIds.push(sessionId);
    const dump = join(ws.layout.tmp, "claude-env.json");
    const extra: Record<string, string> = {
      CLAUDE_PATH: writeFakeClaudeWrapper(ws.layout.tmp),
      FAKE_CLAUDE_DUMP: dump,
      CONTRACT_FAKE_MAX_MS: "60000",
    };
    if (inbox) {
      extra.CLAUDISH_HOOK_INBOX = ws.file("hook-inbox.jsonl", "");
      extra.CLAUDISH_HOOK_SESSION = JSON.stringify({ kind: "channel", id: "0123abcd", role: null });
    }
    const p = ws.track(
      [
        process.execPath,
        "--no-env-file",
        ENTRY,
        "--config",
        ws.configFile,
        "-i",
        "--model",
        "stub@fake-model",
        "-y",
        "--quiet",
        "--session-id",
        sessionId,
        "--debug-claudish",
        ...flags,
      ],
      extra
    );
    await until(() => existsSync(dump) || p.closed, "the configured fake Claude environment");
    if (!existsSync(dump))
      throw new Error(`Launcher exited before Claude started: ${p.stderr}\n${p.stdout}`);
    const env = JSON.parse(readFileSync(dump, "utf8")).env as Record<string, string>;
    const base = env.ANTHROPIC_BASE_URL;
    if (!base || !/^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(base))
      throw new Error(`Not a loopback proxy: ${String(base)}`);
    const send = (body: Record<string, unknown> = {}) =>
      fetch(`${base.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": env.ANTHROPIC_API_KEY ?? "test-placeholder",
        },
        body: JSON.stringify({
          model: "stub@fake-model",
          max_tokens: 1024,
          stream: true,
          messages: [{ role: "user", content: "HELLO" }],
          metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
          ...body,
        }),
      });
    const f: ProxyFixture = {
      ws,
      process: p,
      stub,
      sessionId,
      fetch: send,
      async read(body) {
        const res = await send(body);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")?.includes("text/event-stream")).toBe(true);
        const raw = await res.text();
        expect(events(raw).filter((e) => e.type === "message_stop")).toHaveLength(1);
        return raw;
      },
      async close() {
        stub.stop();
        await ws.close();
      },
    };
    fixtures.push(f);
    return f;
  } catch (error) {
    stub.stop();
    await ws.close();
    throw error;
  }
}

describe("hook chain: each step sees earlier applied actions (§4.4.1 / §4.6)", () => {
  test("C-1 request B sees A's system note and both reach the provider", async () => {
    const f = await setup({
      modules: [
        { name: "a.ts", code: hook('request(){return [{type:"injectSystemNote",text:"A-NOTE"}]}') },
        {
          name: "b.ts",
          code: traced(
            'request(ctx){record("B",ctx.request.systemText);return [{type:"injectSystemNote",text:"B-NOTE"}]}'
          ),
        },
      ],
    });
    expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
    expect(trace(f.ws)).toEqual([{ kind: "B", value: "BASE\n\nA-NOTE" }]);
    expectSystem(f, "BASE\n\nA-NOTE\n\nB-NOTE");
    await settle(f.ws, "request", 2);
    expect(bag(actions(f.ws, "request"))).toEqual(
      bag([applied("a", "injectSystemNote"), applied("b", "injectSystemNote")])
    );
  }, 30000);

  test("C-2 B sees appended message blocks and edits A's text before conversion", async () => {
    const f = await setup({
      modules: [
        { name: "a.ts", code: hook('request(){return [{type:"appendUserText",text:"A"}]}') },
        {
          name: "b.ts",
          code: traced(
            'request(ctx){record("B",ctx.request.messages);return [{type:"replaceMessageText",find:"A",replace:"B"},{type:"removeMessageText",find:"HOME"}]}'
          ),
        },
      ],
    });
    // §4.6: a literal find "replaces all occurrences" in "every text block", so the base text must
    // not contain "A" ("HEAD" became "HEBD" in the first run).
    expect(textOf(await f.read({ messages: [{ role: "user", content: "HOME" }] }))).toBe(
      "original"
    );
    expect(trace(f.ws)).toEqual([
      {
        kind: "B",
        value: [
          {
            role: "user",
            content: [
              { type: "text", text: "HOME" },
              { type: "text", text: "A" },
            ],
          },
        ],
      },
    ]);
    // Dropping HOME leaves precisely one block: no provider-specific join separator to guess.
    expect(
      provider(f)
        .messages.filter((m) => m.role === "user")
        .map((m) => contentText(m.content))
    ).toEqual(["B"]);
    await settle(f.ws, "request", 3);
    expect(bag(actions(f.ws, "request"))).toEqual(
      bag([
        applied("a", "appendUserText"),
        applied("b", "replaceMessageText"),
        applied("b", "removeMessageText"),
      ])
    );
  }, 30000);

  for (const reverse of [false, true]) {
    test(`C-3 response B sees earlier text; ${reverse ? "reversed-order negative control" : "append then replace"}`, async () => {
      const modules = [
        {
          name: "a.ts",
          code: hook('responseRewrite:{handle(){return [{type:"appendText",text:"-A"}]}}'),
        },
        {
          name: "b.ts",
          code: traced(
            'responseRewrite:{handle(ctx){record("B",{text:ctx.response.text,blocks:ctx.response.blocks});return [{type:"replaceText",find:"-A",replace:"-B"}]}}'
          ),
        },
      ];
      const f = await setup({
        modules: reverse ? modules.reverse() : modules,
        script: [{ parts: [{ text: "seed-A" }] }],
      });
      expect(textOf(await f.read())).toBe(reverse ? "seed-B-A" : "seed-B-B");
      const seen = reverse ? "seed-A" : "seed-A-A";
      expect(trace(f.ws)).toEqual([
        { kind: "B", value: { text: seen, blocks: [{ type: "text", text: seen }] } },
      ]);
      const ordered = reverse ? ["b", "a"] : ["a", "b"];
      await settle(f.ws, "responseRewrite", 2);
      expect(bag(decisions(f.ws, "responseRewrite"))).toEqual(
        bag(ordered.map((name) => [id(name), "matched"]))
      );
      expect(bag(actions(f.ws, "responseRewrite"))).toEqual(
        bag(ordered.map((name) => applied(name, name === "a" ? "appendText" : "replaceText")))
      );
    }, 30000);
  }

  test("C-4 repairs compose; args change but rawArgs stays the model's JSON", async () => {
    const originalArgs = { file_path: "MODEL-PATH" };
    const f = await setup({
      modules: [
        {
          name: "a.ts",
          code: traced(
            'toolCall:{tools:["Read"],handle(ctx){record("A",{args:ctx.tool.args,rawArgs:ctx.tool.rawArgs,prior:ctx.prior});return [{type:"repairToolArgs",args:{file_path:"/a"},reason:"first"}]}}'
          ),
        },
        {
          name: "b.ts",
          code: traced(
            'toolCall:{tools:["Read"],handle(ctx){record("B",{args:ctx.tool.args,rawArgs:ctx.tool.rawArgs,prior:ctx.prior});return [{type:"repairToolArgs",args:{file_path:"/b"},reason:"second"}]}}'
          ),
        },
      ],
      script: [{ parts: [{ toolCall: { name: "Read", args: originalArgs } }], deltaChars: 2 }],
    });
    const raw = await f.read({ tools: [readTool] });
    expect(textOf(raw)).toBe("");
    expect(toolInputs(raw)).toEqual([{ name: "Read", input: { file_path: "/b" } }]);
    expect(trace(f.ws)).toEqual([
      {
        kind: "A",
        value: { args: originalArgs, rawArgs: JSON.stringify(originalArgs), prior: [] },
      },
      {
        kind: "B",
        value: {
          args: { file_path: "/a" },
          rawArgs: JSON.stringify(originalArgs),
          prior: [
            {
              hookId: id("a"),
              action: { type: "repairToolArgs", args: { file_path: "/a" }, reason: "first" },
            },
          ],
        },
      },
    ]);
    await settle(f.ws, "toolCall", 2);
    expect(bag(actions(f.ws, "toolCall"))).toEqual(
      bag([applied("a", "repairToolArgs", "repaired"), applied("b", "repairToolArgs", "repaired")])
    );
    expect(rows(f.ws, "toolCall").map((r) => ({ tool: r.toolName, keys: r.argKeys }))).toEqual([
      { tool: "Read", keys: ["file_path"] },
      { tool: "Read", keys: ["file_path"] },
    ]);
  }, 30000);

  for (const summarize of [false, true]) {
    test(`C-5 description replace then append composes${summarize ? " under --summarize-tools" : " without summarisation"}`, async () => {
      const f = await launchProxy(
        {
          modules: [
            {
              name: "a.ts",
              code: hook(
                'request(){return [{type:"replaceToolDescription",tool:"Read",description:"X"}]}'
              ),
            },
            {
              name: "b.ts",
              code: traced(
                'request(ctx){record("B",ctx.request.tools);return [{type:"rewriteToolDescription",tool:"Read",append:"Y"}]}'
              ),
            },
          ],
        },
        summarize ? ["--summarize-tools"] : []
      );
      expect(textOf(await f.read({ tools: [readTool] }))).toBe("original");
      expect(trace(f.ws)).toEqual([{ kind: "B", value: [{ ...readTool, description: "X" }] }]);
      expect(
        provider(f).tools?.map((t) => ({
          name: t.function.name,
          description: t.function.description,
        }))
      ).toEqual([{ name: "Read", description: "XY" }]);
      await settle(f.ws, "request", 2);
      expect(bag(actions(f.ws, "request"))).toEqual(
        bag([applied("a", "replaceToolDescription"), applied("b", "rewriteToolDescription")])
      );
    }, 30000);
  }

  test("C-6 later schema replacement sees the earlier schema and wins on the provider payload", async () => {
    const first = {
      type: "object",
      properties: { first: { type: "integer" } },
      required: ["first"],
    };
    const second = {
      type: "object",
      properties: { second: { type: "string" } },
      required: ["second"],
    };
    const f = await setup({
      modules: [
        {
          name: "a.ts",
          code: hook(
            `request(){return [{type:"replaceToolSchema",tool:"Read",inputSchema:${JSON.stringify(first)}}]}`
          ),
        },
        {
          name: "b.ts",
          code: traced(
            `request(ctx){record("B",ctx.request.tools);return [{type:"replaceToolSchema",tool:"Read",inputSchema:${JSON.stringify(second)}}]}`
          ),
        },
      ],
    });
    expect(textOf(await f.read({ tools: [readTool] }))).toBe("original");
    expect(trace(f.ws)).toEqual([{ kind: "B", value: [{ ...readTool, input_schema: first }] }]);
    expect(
      provider(f).tools?.map((t) => ({ name: t.function.name, schema: t.function.parameters }))
    ).toEqual([{ name: "Read", schema: second }]);
    await settle(f.ws, "request", 2);
    expect(bag(actions(f.ws, "request"))).toEqual(
      bag([applied("a", "replaceToolSchema"), applied("b", "replaceToolSchema")])
    );
  }, 30000);

  test("C-7 removed tools disappear from B's view and a later append is tool_removed", async () => {
    const keep = {
      name: "Keep",
      description: "KEEP",
      input_schema: { type: "object", properties: {} },
    };
    const f = await setup({
      modules: [
        { name: "a.ts", code: hook('request(){return [{type:"removeTool",tool:"Read"}]}') },
        {
          name: "b.ts",
          code: traced(
            'request(ctx){record("B",{names:ctx.request.tools.map(t=>t.name),prior:ctx.prior});return [{type:"rewriteToolDescription",tool:"Read",append:"LATE"}]}'
          ),
        },
      ],
    });
    expect(textOf(await f.read({ tools: [readTool, keep] }))).toBe("original");
    expect(trace(f.ws)).toEqual([
      {
        kind: "B",
        value: {
          names: ["Keep"],
          prior: [{ hookId: id("a"), action: { type: "removeTool", tool: "Read" } }],
        },
      },
    ]);
    expect(provider(f).tools?.map((t) => t.function)).toEqual([
      { name: "Keep", description: "KEEP", parameters: keep.input_schema },
    ]);
    await settle(f.ws, "request", 2);
    expect(bag(actions(f.ws, "request"))).toEqual(
      bag([applied("a", "removeTool"), applied("b", "rewriteToolDescription", "superseded")])
    );
    expect(userRows(f.ws, id("b")).map((r) => r.detail)).toEqual(["tool_removed"]);
  }, 30000);
});

describe("hook chain: failure, severity, order and prior (§4.4.1 / §4.5 / §4.8)", () => {
  for (const [target, failure, decision] of [
    ["C-8", "throw", "error"],
    ["C-9", "timeout", "timeout"],
    ["C-10", "invalid", "invalid"],
  ] as const) {
    test(`${target} ${failure} in the middle leaves A's change visible to C`, async () => {
      const middle =
        failure === "throw"
          ? 'request(ctx){record("B-start",Date.now());throw new Error("MIDDLE-FAIL")}'
          : failure === "invalid"
            ? 'request(ctx){record("B-start",Date.now());return "not-an-array"}'
            : 'request(ctx){record("B-start",Date.now());return new Promise(resolve=>ctx.signal.addEventListener("abort",()=>{record("B-aborted",Date.now());setTimeout(()=>{record("B-late",true);resolve([{type:"injectSystemNote",text:"LATE"}])},100)},{once:true}))}';
      const f = await setup({
        modules: [
          {
            name: "a.ts",
            code: traced('request(){record("A",true);return [{type:"injectSystemNote",text:"A"}]}'),
          },
          { name: "b.ts", code: traced(middle, "timeoutMs:500,") },
          {
            name: "c.ts",
            code: traced(
              'request(ctx){record("C",{at:Date.now(),system:ctx.request.systemText,prior:ctx.prior});return [{type:"injectSystemNote",text:"C"}]}'
            ),
          },
        ],
      });
      expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
      expectSystem(f, "BASE\n\nA\n\nC", 0, ["LATE"]);
      await settle(f.ws, "request", 3);
      const beforeLate = trace(f.ws);
      const c = beforeLate.find((r) => r.kind === "C")!;
      expect({ system: c.value.system, prior: c.value.prior }).toEqual({
        system: "BASE\n\nA",
        prior: [{ hookId: id("a"), action: { type: "injectSystemNote", text: "A" } }],
      });
      if (failure === "timeout") {
        await until(
          () => trace(f.ws).some((r) => r.kind === "B-late"),
          "the discarded late result"
        );
        const seen = trace(f.ws);
        expect(seen.map((r) => r.kind)).toEqual(["A", "B-start", "B-aborted", "C", "B-late"]);
        expect(c.value.at).toBeGreaterThanOrEqual(seen.find((r) => r.kind === "B-aborted")!.value);
        expect(
          userRows(f.ws, id("b"))
            .filter((r) => r.decision === "timeout")
            .map((r) => r.detail === "event_budget")
        ).toEqual([false]);
      } else expect(beforeLate.map((r) => r.kind)).toEqual(["A", "B-start", "C"]);
      expect(bag(decisions(f.ws, "request"))).toEqual(
        bag([
          [id("a"), "matched"],
          [id("b"), decision],
          [id("c"), "matched"],
        ])
      );
      // The late timeout result has had a chance to resolve; it still applied nowhere.
      expectSystem(f, "BASE\n\nA\n\nC", 0, ["LATE"]);
    }, 30000);
  }

  test("C-11 a warn middle hook contributes neither working text nor prior actions", async () => {
    const f = await setup({
      modules: [
        { name: "a.ts", code: hook('request(){return [{type:"injectSystemNote",text:"A"}]}') },
        {
          name: "b.ts",
          code: traced(
            'request(ctx){record("B",{system:ctx.request.systemText,prior:ctx.prior});return [{type:"injectSystemNote",text:"WARN-EDIT"}]}'
          ),
        },
        {
          name: "c.ts",
          code: traced(
            'request(ctx){record("C",{system:ctx.request.systemText,prior:ctx.prior});return [{type:"injectSystemNote",text:"C"}]}'
          ),
        },
      ],
      hooks: { severity: { "hook:b/test": "warn" } },
    });
    expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
    const value = {
      system: "BASE\n\nA",
      prior: [{ hookId: id("a"), action: { type: "injectSystemNote", text: "A" } }],
    };
    expect(trace(f.ws)).toEqual([
      { kind: "B", value },
      { kind: "C", value },
    ]);
    expectSystem(f, "BASE\n\nA\n\nC", 0, ["WARN-EDIT"]);
    await settle(f.ws, "request", 3);
    expect(bag(actions(f.ws, "request"))).toEqual(
      bag([
        applied("a", "injectSystemNote"),
        applied("b", "injectSystemNote", "warned"),
        applied("c", "injectSystemNote"),
      ])
    );
  }, 30000);

  test("C-12 a fast post hook starts only after the slow pre hook returns, despite export order", async () => {
    const code = `${traceImports}
      export default [
        {apiVersion:1,id:"post",order:"post",on:{request(ctx){record("post-start",ctx.request.systemText);return [{type:"injectSystemNote",text:"POST"}]}}},
        {apiVersion:1,id:"pre",order:"pre",timeoutMs:5000,on:{async request(){record("pre-start",true);while(!existsSync(join(process.env.HOME,"release-pre")))await Bun.sleep(10);record("pre-return",true);return [{type:"injectSystemNote",text:"PRE"}]}}}
      ];`;
    const f = await setup({ modules: [{ name: "ordered.ts", code }] });
    const request = f.read({ system: "BASE" });
    try {
      await until(() => trace(f.ws).some((r) => r.kind === "pre-start"), "the pre hook's gate");
      expect(trace(f.ws)).toEqual([{ kind: "pre-start", value: true }]);
    } finally {
      writeFileSync(join(f.ws.layout.home, "release-pre"), "GO");
    }
    expect(textOf(await request)).toBe("original");
    expect(trace(f.ws)).toEqual([
      { kind: "pre-start", value: true },
      { kind: "pre-return", value: true },
      { kind: "post-start", value: "BASE\n\nPRE" },
    ]);
    expectSystem(f, "BASE\n\nPRE\n\nPOST");
    await settle(f.ws, "request", 2);
    expect(bag(decisions(f.ws, "request"))).toEqual(
      bag([
        ["hook:ordered/pre", "matched"],
        ["hook:ordered/post", "matched"],
      ])
    );
  }, 30000);

  test("C-13 prior is empty for the first step and lists only applied actions, in order", async () => {
    const f = await setup({
      modules: [
        {
          name: "a.ts",
          code: traced(
            'request(ctx){record("A",ctx.prior);return [{type:"injectSystemNote",text:"A"},{type:"injectSystemNote",text:"A"},{type:"warn",message:"ADVISORY"},{type:"removeTool",tool:"Missing"}]}'
          ),
        },
        {
          name: "b.ts",
          code: traced(
            'request(ctx){record("B",ctx.prior);return [{type:"appendUserText",text:"B"}]}'
          ),
        },
        { name: "c.ts", code: traced('request(ctx){record("C",ctx.prior)}') },
      ],
    });
    expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
    const a = { hookId: id("a"), action: { type: "injectSystemNote", text: "A" } };
    const b = { hookId: id("b"), action: { type: "appendUserText", text: "B" } };
    expect(trace(f.ws)).toEqual([
      { kind: "A", value: [] },
      { kind: "B", value: [a] },
      { kind: "C", value: [a, b] },
    ]);
    expectSystem(f, "BASE\n\nA");
    await settle(f.ws, "request", 5);
    expect(bag(actions(f.ws, "request"))).toEqual(
      bag([
        applied("a", "injectSystemNote"),
        applied("a", "injectSystemNote", "superseded"),
        applied("a", "warn", "warned"),
        applied("a", "removeTool", "invalid"),
        applied("b", "appendUserText"),
      ])
    );
    expect(
      userRows(f.ws, id("a"))
        .filter((r) => r.decision === "superseded")
        .map((r) => r.detail)
    ).toEqual(["duplicate"]);
  }, 30000);
});

describe("hook chain: budgets, signals and dispatch independence (§4.4.1 / §4.5)", () => {
  test("C-14 event budget clips step 3, skips step 4, and five budget timeouts do not disable step 3", async () => {
    const modules = ["a", "b", "c"].map((name) => ({
      name: `${name}.ts`,
      code: traced(
        `async request(ctx){
        const probe=ctx.request.systemText.startsWith("PROBE"), started=Date.now();
        record("${name}-start",{probe,at:started});
        ctx.signal.addEventListener("abort",()=>record("${name}-abort",{probe,elapsed:Date.now()-started}),{once:true});
        if(!probe)await Bun.sleep(2000);
        record("${name}-return",{probe});
        return [{type:"injectSystemNote",text:"${name.toUpperCase()}"}];
      }`,
        "timeoutMs:5000,"
      ),
    }));
    modules.push({
      name: "d.ts",
      code: traced(
        'request(ctx){record("d-start",{probe:ctx.request.systemText.startsWith("PROBE")});return [{type:"injectSystemNote",text:"D"}]}',
        "timeoutMs:5000,"
      ),
    });
    const f = await setup({ modules });
    for (let n = 0; n < 5; n++) {
      const sentAt = Date.now();
      expect(textOf(await f.read({ system: `BASE-${n}` }))).toBe("original");
      expectSystem(f, `BASE-${n}\n\nA\n\nB`, n, ["C", "D"]);
      // Broad bounds, measured at the upstream, not completion/startup or a thin 5 s cutoff.
      expect(f.stub.requests[n]!.at - sentAt).toBeGreaterThanOrEqual(4000);
      expect(f.stub.requests[n]!.at - sentAt).toBeLessThan(14000);
    }
    await settle(f.ws, "request", 20);
    expect(bag(decisions(f.ws, "request"))).toEqual(
      bag(
        Array.from({ length: 5 }, () => [
          [id("a"), "matched"],
          [id("b"), "matched"],
          [id("c"), "timeout"],
          [id("d"), "skipped"],
        ]).flat()
      )
    );
    expect(
      userRows(f.ws, id("c")).map((r) => ({ decision: r.decision, detail: r.detail }))
    ).toEqual(Array.from({ length: 5 }, () => ({ decision: "timeout", detail: "event_budget" })));
    expect(
      userRows(f.ws, id("d")).map((r) => ({ decision: r.decision, detail: r.detail }))
    ).toEqual(Array.from({ length: 5 }, () => ({ decision: "skipped", detail: "event_budget" })));
    expect(trace(f.ws).filter((r) => r.kind === "d-start")).toEqual([]);
    const aborted = trace(f.ws).filter((r) => r.kind === "c-abort");
    expect(aborted).toHaveLength(5);
    for (const r of aborted) {
      expect(r.value.probe).toBe(false);
      expect(r.value.elapsed).toBeGreaterThanOrEqual(0);
      expect(r.value.elapsed).toBeLessThan(3500);
    }
    // A sixth, fast dispatch proves C still runs after the fifth timeout.
    expect(textOf(await f.read({ system: "PROBE" }))).toBe("original");
    expectSystem(f, "PROBE\n\nA\n\nB\n\nC\n\nD", 5);
    await settle(f.ws, "request", 24);
    expect(bag(decisions(f.ws, "request").slice(-4))).toEqual(
      bag(["a", "b", "c", "d"].map((name) => [id(name), "matched"]))
    );
    expect(
      trace(f.ws)
        .filter((r) => r.kind === "c-start")
        .map((r) => r.value.probe)
    ).toEqual([false, false, false, false, false, true]);
    expect(rows(f.ws, "request").filter((r) => r.decision === "disabled")).toEqual([]);
    await until(
      () => trace(f.ws).filter((r) => r.kind === "c-return").length === 6,
      "all discarded late C returns"
    );
    expect(userRows(f.ws, id("c")).map((r) => r.decision)).toEqual([
      "timeout",
      "timeout",
      "timeout",
      "timeout",
      "timeout",
      "matched",
    ]);
  }, 90000);

  test("C-15 five own-timeout failures disable a hook; later steps and the sixth request still succeed", async () => {
    const f = await setup({
      modules: [
        {
          name: "a.ts",
          code: traced(
            'request(ctx){record("A-call",true);return new Promise(()=>ctx.signal.addEventListener("abort",()=>record("A-abort",true),{once:true}))}',
            "timeoutMs:200,"
          ),
        },
        { name: "b.ts", code: hook('request(){return [{type:"injectSystemNote",text:"B"}]}') },
      ],
    });
    for (let n = 0; n < 6; n++) {
      expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
      expectSystem(f, "BASE\n\nB", n);
    }
    await waitJournal(f.ws, (r) => r.hookId === id("a") && r.decision === "disabled");
    // Journal line order is not part of the contract (§4.8; session decision 2026-10-15): the fifth
    // timeout and the disable come from one request, so wait for all six A rows and compare them as
    // an exact multiset.
    await until(() => userRows(f.ws, id("a")).length >= 6, "six A journal rows");
    expect(trace(f.ws)).toEqual(
      Array.from({ length: 5 }, () => [
        { kind: "A-call", value: true },
        { kind: "A-abort", value: true },
      ]).flat()
    );
    expect(bag(userRows(f.ws, id("a")).map((r) => r.decision))).toEqual(
      bag(["timeout", "timeout", "timeout", "timeout", "timeout", "disabled"])
    );
    expect(
      userRows(f.ws, id("a"))
        .filter((r) => r.decision === "timeout")
        .map((r) => r.detail === "event_budget")
    ).toEqual([false, false, false, false, false]);
    await until(() => userRows(f.ws, id("b")).length >= 6, "six B journal rows");
    expect(userRows(f.ws, id("b")).map((r) => r.decision)).toEqual(Array(6).fill("matched"));
    expect(
      f.ws.diagnostics(f.process).split(`hook ${id("a")} disabled after 5 consecutive failures`)
    ).toHaveLength(2);
  }, 30000);

  test("C-16 A timing out does not abort B's separate signal at B's return", async () => {
    const f = await setup({
      modules: [
        {
          name: "a.ts",
          code: traced(
            'request(ctx){return new Promise(()=>ctx.signal.addEventListener("abort",()=>record("A",ctx.signal.aborted),{once:true}))}',
            "timeoutMs:200,"
          ),
        },
        {
          name: "b.ts",
          code: traced(
            'async request(ctx){await Bun.sleep(100);record("B",{aborted:ctx.signal.aborted,prior:ctx.prior,system:ctx.request.systemText});return [{type:"injectSystemNote",text:"B"}]}',
            "timeoutMs:2000,"
          ),
        },
      ],
    });
    expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
    expect(trace(f.ws)).toEqual([
      { kind: "A", value: true },
      { kind: "B", value: { aborted: false, prior: [], system: "BASE" } },
    ]);
    expectSystem(f, "BASE\n\nB");
    await settle(f.ws, "request", 2);
    expect(bag(decisions(f.ws, "request"))).toEqual(
      bag([
        [id("a"), "timeout"],
        [id("b"), "matched"],
      ])
    );
  }, 30000);

  test("C-17 client cancel aborts a running rewrite and never invokes or journals its successor", async () => {
    const f = await setup({
      modules: [
        {
          name: "a.ts",
          code: traced(
            'responseRewrite:{handle(ctx){if(ctx.request.systemText==="CONTROL")return [{type:"appendText",text:"-A"}];record("A-start",true);return new Promise(resolve=>ctx.signal.addEventListener("abort",()=>{record("A-abort",ctx.signal.aborted);setTimeout(()=>{record("A-late",true);resolve([{type:"appendText",text:"-LATE"}])},100)},{once:true}))}}',
            "timeoutMs:8000,"
          ),
        },
        {
          name: "b.ts",
          code: traced(
            'responseRewrite:{handle(ctx){record("B",ctx.request.systemText);return [{type:"appendText",text:"-B"}]}}'
          ),
        },
      ],
    });
    const res = await f.fetch({ system: "CANCEL" });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      const prefix = await readUntil(reader, (raw) =>
        events(raw).some((e) => e.type === "message_start")
      );
      expect(textOf(prefix)).toBe("");
      await until(
        () => trace(f.ws).some((r) => r.kind === "A-start"),
        "the cancellable rewrite step"
      );
      await reader.cancel();
      await until(
        () => trace(f.ws).some((r) => r.kind === "A-late"),
        "dispatch abort and the discarded late rewrite"
      );
      expect(trace(f.ws)).toEqual([
        { kind: "A-start", value: true },
        { kind: "A-abort", value: true },
        { kind: "A-late", value: true },
      ]);
      expect(rows(f.ws, "responseRewrite")).toEqual([]);
      // This successor does run on a fresh dispatch: its absence above is cancellation, not filtering.
      expect(textOf(await f.read({ system: "CONTROL" }))).toBe("original-A-B");
      expect(trace(f.ws)).toEqual([
        { kind: "A-start", value: true },
        { kind: "A-abort", value: true },
        { kind: "A-late", value: true },
        { kind: "B", value: "CONTROL" },
      ]);
      await settle(f.ws, "responseRewrite", 2);
      expect(bag(actions(f.ws, "responseRewrite"))).toEqual(
        bag([applied("a", "appendText"), applied("b", "appendText")])
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
  }, 30000);

  test("C-23 a second tool call's whole chain completes while the first call's first step is gated", async () => {
    const f = await setup({
      modules: [
        {
          name: "a.ts",
          code: traced(
            'toolCall:{tools:["Read","Write"],async handle(ctx){record("A-start",ctx.tool.name);if(ctx.tool.name==="Read"){ctx.signal.addEventListener("abort",()=>record("A-abort","Read"),{once:true});while(!existsSync(join(process.env.HOME,"release-tool"))&&!ctx.signal.aborted)await Bun.sleep(10);record("A-return","Read")}return [{type:"repairToolArgs",args:{file_path:ctx.tool.args.file_path+"-A"},reason:"A"}]}}',
            "timeoutMs:5000,"
          ),
        },
        {
          name: "b.ts",
          code: traced(
            'toolCall:{tools:["Read","Write"],handle(ctx){record("B",{name:ctx.tool.name,args:ctx.tool.args,prior:ctx.prior});return [{type:"repairToolArgs",args:{file_path:ctx.tool.args.file_path+"-B"},reason:"B"}]}}'
          ),
        },
      ],
      script: [
        {
          parts: [
            { toolCall: { name: "Read", args: { file_path: "FIRST" } } },
            { toolCall: { name: "Write", args: { file_path: "SECOND" } } },
          ],
        },
      ],
    });
    const request = f.read();
    try {
      await until(
        () => trace(f.ws).some((r) => r.kind === "B" && r.value.name === "Write"),
        "the independent Write chain"
      );
      expect(trace(f.ws).map((r) => r.kind)).toEqual(["A-start", "A-start", "B"]);
      expect(
        trace(f.ws)
          .filter((r) => r.kind === "A-start")
          .map((r) => r.value)
      ).toEqual(["Read", "Write"]);
      expect(trace(f.ws).find((r) => r.kind === "B")!.value).toEqual({
        name: "Write",
        args: { file_path: "SECOND-A" },
        prior: [
          {
            hookId: id("a"),
            action: { type: "repairToolArgs", args: { file_path: "SECOND-A" }, reason: "A" },
          },
        ],
      });
    } finally {
      writeFileSync(join(f.ws.layout.home, "release-tool"), "GO");
    }
    const raw = await request;
    expect(textOf(raw)).toBe("");
    expect(toolInputs(raw)).toEqual([
      { name: "Read", input: { file_path: "FIRST-A-B" } },
      { name: "Write", input: { file_path: "SECOND-A-B" } },
    ]);
    expect(trace(f.ws).map((r) => r.kind)).toEqual(["A-start", "A-start", "B", "A-return", "B"]);
    expect(
      trace(f.ws)
        .filter((r) => r.kind === "B")
        .map((r) => r.value)
    ).toEqual([
      {
        name: "Write",
        args: { file_path: "SECOND-A" },
        prior: [
          {
            hookId: id("a"),
            action: { type: "repairToolArgs", args: { file_path: "SECOND-A" }, reason: "A" },
          },
        ],
      },
      {
        name: "Read",
        args: { file_path: "FIRST-A" },
        prior: [
          {
            hookId: id("a"),
            action: { type: "repairToolArgs", args: { file_path: "FIRST-A" }, reason: "A" },
          },
        ],
      },
    ]);
    await settle(f.ws, "toolCall", 4);
    expect(
      bag(
        rows(f.ws, "toolCall").map((r) => ({
          hookId: r.hookId,
          decision: r.decision,
          tool: r.toolName,
        }))
      )
    ).toEqual(
      bag([
        { hookId: id("a"), decision: "repaired", tool: "Write" },
        { hookId: id("b"), decision: "repaired", tool: "Write" },
        { hookId: id("a"), decision: "repaired", tool: "Read" },
        { hookId: id("b"), decision: "repaired", tool: "Read" },
      ])
    );
  }, 30000);
});

describe("hook chain: responseEnd hand-off and stored-note step zero", () => {
  // C-18 first draft drove the inbox from an `-i` launcher. The inbox is a pane-child sink
  // ("set by the owner for every pane child", §4.10); in a no-surface launcher injections are
  // "dropped `unavailable`" (§4.7 rule 8). So this test uses the hand-off that host does accept:
  // a responseEnd note "queued for the next request" (§4.4.1 rule 5). Inbox order is C-18b.
  test("C-18 responseEnd B sees A's queued note in prior; injections a no-surface launcher drops are not listed", async () => {
    const f = await setup({
      modules: [
        {
          name: "a.ts",
          code: traced(
            'responseEnd(ctx){record("A",ctx.prior);return [{type:"injectSystemNote",text:"A-END"},{type:"injectUserTurn",text:"X"}]}'
          ),
        },
        {
          name: "b.ts",
          code: traced(
            'responseEnd(ctx){record("B",ctx.prior);return [{type:"injectUserTurn",text:"Y"}]}'
          ),
        },
      ],
    });
    expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
    await until(
      () => trace(f.ws).some((r) => r.kind === "B"),
      "the responseEnd chain's second step"
    );
    expect(trace(f.ws)).toEqual([
      { kind: "A", value: [] },
      {
        kind: "B",
        value: [{ hookId: id("a"), action: { type: "injectSystemNote", text: "A-END" } }],
      },
    ]);
    await settle(f.ws, "responseEnd", 3);
    const end = rows(f.ws, "responseEnd");
    expect(
      bag(
        end
          .filter((r) => r.action === "injectUserTurn")
          .map((r) => ({ hookId: r.hookId, decision: r.decision, detail: r.detail }))
      )
    ).toEqual(
      bag([
        { hookId: id("a"), decision: "dropped", detail: "unavailable" },
        { hookId: id("b"), decision: "dropped", detail: "unavailable" },
      ])
    );
    expect(end.filter((r) => r.action === "injectSystemNote").map((r) => r.hookId)).toEqual([
      id("a"),
    ]);
    // §4.7 rule 8: "one stderr line per process the first time it happens" — two drops, one line.
    // Once the launcher handed the screen over, `[claudish] …` lines go to diag-<pid>.log (guide,
    // Logging), whose line prefix is not fixed; match the guide's message text, as C-15 does.
    expect(
      f.ws
        .diagnostics(f.process)
        .split(
          "hook injection dropped: this claudish process has no Claude Code session to deliver it to"
        )
    ).toHaveLength(2);
    // The queued note is real: the session's next request carries it.
    expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
    expectSystem(f, "BASE\n\nA-END", 1, ["X", "Y"]);
  }, 30000);
  test.todo(
    "C-18b inbox inject lines follow responseEnd chain order: needs a pane-child host (CLAUDISH_HOOK_INBOX is set by the owner, §4.10)"
  );

  test("C-20 a pending responseEnd note is visible to the next request's first hook as step zero", async () => {
    const f = await setup({
      modules: [
        {
          name: "request.ts",
          code: traced(
            'request(ctx){record("request",{system:ctx.request.systemText,prior:ctx.prior})}'
          ),
        },
        {
          name: "end.ts",
          code: `${traceImports}\nlet calls=0;${hook('responseEnd(ctx){if(++calls===1)return [{type:"injectSystemNote",text:"PENDING"}]}')}`,
        },
      ],
    });
    expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
    await waitJournal(
      f.ws,
      (r) => r.hookId === id("end") && r.event === "responseEnd" && r.action === "injectSystemNote"
    );
    expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
    expect(trace(f.ws)).toEqual([
      { kind: "request", value: { system: "BASE", prior: [] } },
      {
        kind: "request",
        value: {
          system: "BASE\n\nPENDING",
          prior: [
            {
              hookId: "behavior/pending-correction",
              action: { type: "injectSystemNote", text: "PENDING" },
            },
          ],
        },
      },
    ]);
    expectSystem(f, "BASE", 0, ["PENDING"]);
    expectSystem(f, "BASE\n\nPENDING", 1);
    // A third request proves the note was consumed, rather than put in global state.
    expect(textOf(await f.read({ system: "BASE" }))).toBe("original");
    expect(trace(f.ws).slice(-1)).toEqual([
      { kind: "request", value: { system: "BASE", prior: [] } },
    ]);
    expectSystem(f, "BASE", 2, ["PENDING"]);
    await waitJournal(f.ws, (r) => r.hookId === "behavior/pending-correction");
    expect(
      f.ws
        .journal()
        .filter((r) => r.hookId === "behavior/pending-correction")
        .map((r) => ({ hookId: r.hookId, event: r.event, action: r.action, decision: r.decision }))
    ).toEqual([
      {
        hookId: "behavior/pending-correction",
        event: "request",
        action: "injectSystemNote",
        decision: "matched",
      },
    ]);
  }, 30000);

  // These targets need inputs/interfaces the supplied contract does not define.
  // Named TODOs keep them visible without guessing a host API or passing a weaker test.
  test.todo(
    "C-19 sessionIdle prior, duplicate merge and one hook-caused turn: needs a documented session owner/driver setup"
  );
  test.todo(
    "C-21 harness.planModeActive stays true after removing the marker: needs the exact plan-mode request marker"
  );
  test.todo(
    "C-22 pre precedes and normal follows the plan-mode built-in: needs the plan marker/path format and exact ExitPlanMode append"
  );
});

describe("hook chain: controls and the array-system coverage target", () => {
  test("C-24 one hook preserves the single-hook semantics; no modules is the negative control", async () => {
    const single = await setup({
      modules: [
        {
          name: "single.ts",
          code: traced(
            'request(ctx){record("request-prior",ctx.prior);return [{type:"injectSystemNote",text:"ONE"}]},responseRewrite:{handle(ctx){record("rewrite-prior",ctx.prior);return [{type:"appendText",text:"-ONE"}]}}'
          ),
        },
      ],
    });
    expect(textOf(await single.read({ system: "BASE" }))).toBe("original-ONE");
    expectSystem(single, "BASE\n\nONE");
    expect(trace(single.ws)).toEqual([
      { kind: "request-prior", value: [] },
      { kind: "rewrite-prior", value: [] },
    ]);
    await settle(single.ws, "request", 1);
    await settle(single.ws, "responseRewrite", 1);
    expect(rows(single.ws, "request")).toHaveLength(1);
    expect(bag(actions(single.ws, "request"))).toEqual(
      bag([applied("single", "injectSystemNote")])
    );
    expect(bag(actions(single.ws, "responseRewrite"))).toEqual(
      bag([applied("single", "appendText")])
    );
    expect(
      single.ws
        .journal()
        .filter((r) => r.hookId.startsWith("hook:"))
        .map((r) => ({ event: r.event, hookId: r.hookId, action: r.action, decision: r.decision }))
    ).toEqual([
      { event: "request", ...applied("single", "injectSystemNote") },
      { event: "responseRewrite", ...applied("single", "appendText") },
    ]);
    const none = await setup({ modules: [] });
    expect(textOf(await none.read({ system: "BASE" }))).toBe("original");
    expectSystem(none, "BASE");
    expect(none.ws.journal().filter((r) => r.hookId.startsWith("hook:"))).toEqual([]);
  }, 45000);

  test("C-25 extra target: array system keeps every existing block and adds the same note only once", async () => {
    const f = await setup({
      modules: [
        { name: "a.ts", code: hook('request(){return [{type:"injectSystemNote",text:"NOTE"}]}') },
        {
          name: "b.ts",
          code: traced(
            'request(ctx){record("B",ctx.request.systemText);return [{type:"injectSystemNote",text:"NOTE"}]}'
          ),
        },
      ],
    });
    expect(
      textOf(
        await f.read({
          system: [
            { type: "text", text: "BLOCK-1" },
            { type: "text", text: "BLOCK-2" },
          ],
        })
      )
    ).toBe("original");
    // Conversion's separator for array-system blocks is not fixed by §4.6. Compare
    // the entire ordered text list, not a substring or the raw clone's incidental shape.
    expect(trace(f.ws).map((r) => ({ kind: r.kind, text: r.value.split(/\n+/) }))).toEqual([
      { kind: "B", text: ["BLOCK-1", "BLOCK-2", "NOTE"] },
    ]);
    // Same rule as expectSystem: the provider text ends with the three blocks, NOTE once, and the
    // paragraphs conversion put before them are none of these.
    const blocks = systemText(f).split(/\n+/);
    expect(blocks.slice(-3)).toEqual(["BLOCK-1", "BLOCK-2", "NOTE"]);
    expect(blocks.slice(0, -3).filter((p) => ["BLOCK-1", "BLOCK-2", "NOTE"].includes(p))).toEqual(
      []
    );
    await settle(f.ws, "request", 2);
    expect(bag(actions(f.ws, "request"))).toEqual(
      bag([applied("a", "injectSystemNote"), applied("b", "injectSystemNote", "superseded")])
    );
    expect(userRows(f.ws, id("b")).map((r) => r.detail)).toEqual(["duplicate"]);
  }, 30000);
});
