/**
 * The response seam over synthetic Claude SSE streams (§5.3, §5.4, §11.3
 * "Seam"): the closed modes `intercept` and `buffer`, block re-indexing,
 * keepalive pings, the hold cap, upstream errors, client cancel, fail-open, the
 * observe tap and its inbox `stop`/`end` lines, `responseEnd`, and the
 * non-streaming JSON branch.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookEngine } from "./engine.js";
import { InboxFileSink, type InjectionSink, UnavailableSink } from "./injection/sinks.js";
import type { JournalEntry } from "./journal.js";
import { type HookDefinition, type ResponseView, type Severity, act } from "./public.js";
import { HookRegistry, type UserHookInput } from "./registry.js";
import { RequestHooks } from "./request-stage.js";
import { applyResponseSeam, planSeam, withHooks } from "./response-seam.js";
import type { SeamHooks } from "./seam-hooks.js";
import { PING_FRAME, closedTransform } from "./seam-transform.js";

const SESSION = "5b0c8f7e-2f7a-4d55-9d7e-2f2a1c7e9a10";

/* ───────────── fixtures ───────────── */

const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const messageStart = () =>
  frame("message_start", {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "m" },
  });
const start = (index: number, block: object) =>
  frame("content_block_start", { type: "content_block_start", index, content_block: block });
const textDelta = (index: number, text: string) =>
  frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
const jsonDelta = (index: number, partial_json: string) =>
  frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  });
const thinkingDelta = (index: number, thinking: string) =>
  frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  });
const signatureDelta = (index: number, signature: string) =>
  frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "signature_delta", signature },
  });
const stop = (index: number) => frame("content_block_stop", { type: "content_block_stop", index });
const messageDelta = (stop_reason = "end_turn") =>
  frame("message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null } });
const messageStop = () => frame("message_stop", { type: "message_stop" });

const textBlock = (index: number, text: string) => [
  start(index, { type: "text", text: "" }),
  textDelta(index, text),
  stop(index),
];
const toolBlock = (index: number, name: string, fragments: string[], id = `toolu_${index}`) => [
  start(index, { type: "tool_use", id, name, input: {} }),
  ...fragments.map((f) => jsonDelta(index, f)),
  stop(index),
];

const encoder = new TextEncoder();

/** A Claude SSE Response that yields `chunks` one per read, optionally waiting before some. */
function sse(
  chunks: string[],
  opts: { gates?: Map<number, Promise<void>>; onCancel?: () => void; errorAfter?: number } = {}
): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.errorAfter !== undefined && i === opts.errorAfter) {
        controller.error(new Error("upstream socket dropped"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      await opts.gates?.get(i);
      controller.enqueue(encoder.encode(chunks[i] as string));
      i++;
    },
    cancel() {
      opts.onCancel?.();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let n = 0;
function userHook(def: Omit<HookDefinition, "apiVersion">): UserHookInput {
  const full = { apiVersion: 1, ...def } as HookDefinition;
  return { id: `hook:t/${def.id}`, module: "/t.ts", moduleIndex: 0, exportIndex: n++, def: full };
}

function engineWith(hooks: UserHookInput[], severity?: Record<string, Severity>) {
  const journal: JournalEntry[] = [];
  const engine = new HookEngine({
    registry: new HookRegistry([], hooks, severity),
    config: {},
    hostMode: "pane-child",
    journalSink: (e) => journal.push(e),
    warn: () => {},
    drainTelemetryOutbox: false,
  });
  return { engine, journal };
}

function fakeContext(): any {
  const vars = new Map<string, unknown>();
  return { get: (k: string) => vars.get(k), set: (k: string, v: unknown) => vars.set(k, v) };
}

async function scopeOf(engine: HookEngine, sink: InjectionSink = new UnavailableSink(() => {})) {
  return new RequestHooks(engine, null, sink).beginAttempt(fakeContext(), {
    claudeRequest: {
      system: "base",
      messages: [{ role: "user", content: "hi" }],
      metadata: {
        user_id: JSON.stringify({ device_id: "d", account_uuid: "", session_id: SESSION }),
      },
    },
    route: { modelId: "glm-5", provider: "zai", native: false },
    model: "glm-5",
    stream: true,
  });
}

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

/** Every `data:` payload, pings excluded. */
function payloads(wire: string): any[] {
  return wire
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)))
    .filter((p) => p.type !== "ping");
}

function indicesOf(wire: string, type: string): number[] {
  return payloads(wire)
    .filter((p) => p.type === type)
    .map((p) => p.index);
}

function blockStarts(wire: string): Array<{ index: number; type: string }> {
  return payloads(wire)
    .filter((p) => p.type === "content_block_start")
    .map((p) => ({ index: p.index, type: p.content_block.type }));
}

const tmpDirs: string[] = [];
function inboxPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudish-seam-"));
  tmpDirs.push(dir);
  return join(dir, "hook-inbox.jsonl");
}
function inboxLines(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

const repairHook = (tool: string, args: Record<string, unknown>) =>
  userHook({
    id: `repair-${tool}`,
    on: { toolCall: { tools: [tool], handle: () => [act.repairToolArgs(args, "test")] } },
  });

const rewriteHook = (id: string, handle: (view: ResponseView) => unknown) =>
  userHook({
    id,
    on: { responseRewrite: { handle: (ctx) => handle(ctx.response) as never } },
  });

/* ───────────── plan and identity ───────────── */

describe("seam plan", () => {
  it("is mode none with no tap when nothing claims the request, and returns the same object", async () => {
    const { engine } = engineWith([]);
    const scope = await scopeOf(engine);
    expect(planSeam(scope)).toEqual({ mode: "none", tap: false });
    const res = sse([messageStart()]);
    expect(await applyResponseSeam(res, scope)).toBe(res);
  });

  it("picks the strictest closed mode: buffer over intercept over none", async () => {
    const tool = repairHook("Write", {});
    const rewrite = rewriteHook("rw", () => []);
    expect(planSeam(await scopeOf(engineWith([tool]).engine)).mode).toBe("intercept");
    expect(planSeam(await scopeOf(engineWith([tool, rewrite]).engine)).mode).toBe("buffer");
  });

  it("a warn-severity toolCall or rewrite hook never holds: it goes to the tap", async () => {
    const tool = repairHook("Write", {});
    const rewrite = rewriteHook("rw", () => []);
    const { engine } = engineWith([tool, rewrite], { "hook:t/*": "warn" });
    expect(planSeam(await scopeOf(engine))).toEqual({ mode: "none", tap: true });
  });

  it("an unarmed toolCall hook and a declining rewrite hook leave the identity case", async () => {
    const tool = userHook({
      id: "unarmed",
      on: { toolCall: { tools: ["Write"], armed: () => false, handle: () => [] } },
    });
    const rewrite = userHook({
      id: "declines",
      on: { responseRewrite: { claims: () => false, handle: () => [] } },
    });
    const { engine } = engineWith([tool, rewrite]);
    const scope = await scopeOf(engine);
    expect(planSeam(scope)).toEqual({ mode: "none", tap: false });
  });
});

/* ───────────── intercept ───────────── */

describe("intercept mode", () => {
  it("repairs one named tool and leaves another tool and all text byte-identical", async () => {
    const { engine, journal } = engineWith([repairHook("Write", { file_path: "/fixed" })]);
    const scope = await scopeOf(engine);
    const before = [
      messageStart(),
      PING_FRAME,
      ...textBlock(0, "héllo wörld"),
      ...toolBlock(1, "Read", ['{"file_path":', '"/a"}']),
      ...toolBlock(2, "Write", ['{"file_path":"/wr', 'ong"}']),
      messageDelta("tool_use"),
      messageStop(),
    ];
    const out = await readAll(await applyResponseSeam(sse(before), scope));

    const expected = [
      ...before.slice(0, 9),
      start(2, { type: "tool_use", id: "toolu_2", name: "Write", input: {} }),
      jsonDelta(2, '{"file_path":"/fixed"}'),
      stop(2),
      messageDelta("tool_use"),
      messageStop(),
    ].join("");
    expect(out).toBe(expected);
    expect(
      journal.some(
        (e) => e.event === "toolCall" && e.decision === "repaired" && e.toolName === "Write"
      )
    ).toBe(true);
  });

  it("a hook that changes nothing still finishes the block with one delta of the model's arguments", async () => {
    const hook = userHook({ id: "noop", on: { toolCall: { tools: ["Write"], handle: () => [] } } });
    const { engine, journal } = engineWith([hook]);
    const out = await readAll(
      await applyResponseSeam(
        sse([...toolBlock(0, "Write", ['{"a":', "1}"]), messageStop()]),
        await scopeOf(engine)
      )
    );
    expect(payloads(out).filter((p) => p.type === "content_block_delta")).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"a":1}' },
      },
    ]);
    expect(journal.some((e) => e.hookId === "hook:t/noop" && e.decision === "ignored")).toBe(true);
  });

  it("does not call the hook for malformed arguments, and forwards them unchanged", async () => {
    let called = 0;
    const hook = userHook({
      id: "count",
      on: {
        toolCall: {
          tools: ["Write"],
          handle: () => {
            called++;
            return [];
          },
        },
      },
    });
    const { engine } = engineWith([hook]);
    const out = await readAll(
      await applyResponseSeam(sse(toolBlock(0, "Write", ['{"a":'])), await scopeOf(engine))
    );
    expect(called).toBe(0);
    expect(payloads(out)[1].delta.partial_json).toBe('{"a":');
  });

  it("a throwing hook fails open: the model's arguments go out", async () => {
    const hook = userHook({
      id: "boom",
      on: {
        toolCall: {
          tools: ["Write"],
          handle: () => {
            throw new Error("boom");
          },
        },
      },
    });
    const { engine, journal } = engineWith([hook]);
    const out = await readAll(
      await applyResponseSeam(sse(toolBlock(0, "Write", ['{"a":1}'])), await scopeOf(engine))
    );
    expect(payloads(out)[1].delta.partial_json).toBe('{"a":1}');
    expect(journal.some((e) => e.hookId === "hook:t/boom" && e.decision === "error")).toBe(true);
  });

  it('"*" holds every tool', async () => {
    const hook = userHook({
      id: "all",
      on: { toolCall: { tools: ["*"], handle: () => [act.repairToolArgs({ x: 1 }, "all")] } },
    });
    const { engine } = engineWith([hook]);
    const out = await readAll(
      await applyResponseSeam(sse(toolBlock(0, "Anything", ['{"y":2}'])), await scopeOf(engine))
    );
    expect(payloads(out)[1].delta.partial_json).toBe('{"x":1}');
  });

  it("forwards upstream pings while a hook is awaited", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hook = userHook({
      id: "slow",
      on: {
        toolCall: {
          tools: ["Write"],
          handle: async () => {
            await gate;
            return [];
          },
        },
      },
    });
    const { engine } = engineWith([hook]);
    const res = await applyResponseSeam(
      sse([...toolBlock(0, "Write", ['{"a":1}']), PING_FRAME, messageStop()]),
      await scopeOf(engine),
      { pingIntervalMs: 10_000 }
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes(PING_FRAME)) seen += decoder.decode((await reader.read()).value);
    // The ping arrived while the Write block was still held.
    expect(seen).not.toContain("content_block_stop");
    release();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      seen += decoder.decode(r.value);
    }
    expect(seen.indexOf(PING_FRAME)).toBeLessThan(seen.indexOf("content_block_stop"));
  });
});

/* ───────────── buffer ───────────── */

describe("buffer mode", () => {
  it("appendText on a tool-only response yields a text block BEFORE the tool_use", async () => {
    const { engine } = engineWith([rewriteHook("add", () => [act.appendText("ADDED")])]);
    const out = await readAll(
      await applyResponseSeam(
        sse([
          messageStart(),
          ...toolBlock(0, "Read", ['{"a":1}']),
          messageDelta("tool_use"),
          messageStop(),
        ]),
        await scopeOf(engine)
      )
    );
    expect(blockStarts(out)).toEqual([
      { index: 0, type: "text" },
      { index: 1, type: "tool_use" },
    ]);
    expect(payloads(out).find((p) => p.delta?.type === "text_delta")?.delta.text).toBe("ADDED");
  });

  it("re-index: appendText on [thinking, tool_use, tool_use] emits 0,1,2,3 with the text at 1", async () => {
    const { engine } = engineWith([rewriteHook("add", () => [act.appendText("T")])]);
    const out = await readAll(
      await applyResponseSeam(
        sse([
          messageStart(),
          start(0, { type: "thinking", thinking: "" }),
          thinkingDelta(0, "hmm"),
          signatureDelta(0, "SIG+/=="),
          stop(0),
          ...toolBlock(1, "A", ['{"q":"\\"x\\""}']),
          ...toolBlock(2, "B", ["{}"]),
          messageDelta("tool_use"),
          messageStop(),
        ]),
        await scopeOf(engine)
      )
    );
    expect(blockStarts(out)).toEqual([
      { index: 0, type: "thinking" },
      { index: 1, type: "text" },
      { index: 2, type: "tool_use" },
      { index: 3, type: "tool_use" },
    ]);
    expect(indicesOf(out, "content_block_stop")).toEqual([0, 1, 2, 3]);
    // Every other field is carried unchanged.
    const deltas = payloads(out).filter((p) => p.type === "content_block_delta");
    expect(deltas.find((d) => d.delta.type === "signature_delta")?.delta.signature).toBe("SIG+/==");
    expect(deltas.find((d) => d.index === 2)?.delta.partial_json).toBe('{"q":"\\"x\\""}');
  });

  it("re-index: removeText emptying block 0 of [text, tool_use] emits the tool at index 0", async () => {
    const { engine } = engineWith([rewriteHook("rm", () => [act.removeText("DROP")])]);
    const out = await readAll(
      await applyResponseSeam(
        sse([
          messageStart(),
          ...textBlock(0, "DROP"),
          ...toolBlock(1, "A", ['{"k":"v"}']),
          messageDelta(),
          messageStop(),
        ]),
        await scopeOf(engine)
      )
    );
    expect(blockStarts(out)).toEqual([{ index: 0, type: "tool_use" }]);
    expect(indicesOf(out, "content_block_delta")).toEqual([0]);
    expect(indicesOf(out, "content_block_stop")).toEqual([0]);
    expect(payloads(out).find((p) => p.type === "content_block_delta").delta.partial_json).toBe(
      '{"k":"v"}'
    );
  });

  it("replaceText and prependText rewrite the text, chunked into deltas of at most 1,024 units", async () => {
    const long = "a".repeat(3000);
    const { engine } = engineWith([
      rewriteHook("rw", () => [act.prependText("P:"), act.replaceText("KEEP REMOVE-ME", "KEEP")]),
    ]);
    const out = await readAll(
      await applyResponseSeam(
        sse([
          messageStart(),
          ...textBlock(0, `KEEP REMOVE-ME KEEP${long}`),
          messageDelta(),
          messageStop(),
        ]),
        await scopeOf(engine)
      )
    );
    const texts = payloads(out)
      .filter((p) => p.delta?.type === "text_delta")
      .map((p) => p.delta.text);
    expect(texts.join("")).toBe(`P:KEEP KEEP${long}`);
    expect(Math.max(...texts.map((t) => t.length))).toBeLessThanOrEqual(1024);
  });

  it("a leading thinking block streams live, before the rewrite hook has run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { engine } = engineWith([
      rewriteHook("slow", async () => {
        await gate;
        return [act.appendText("!")];
      }),
    ]);
    const res = await applyResponseSeam(
      sse([
        messageStart(),
        start(0, { type: "thinking", thinking: "" }),
        thinkingDelta(0, "think"),
        stop(0),
        ...textBlock(1, "answer"),
        messageDelta(),
        messageStop(),
      ]),
      await scopeOf(engine)
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"type":"content_block_stop","index":0')) {
      seen += decoder.decode((await reader.read()).value);
    }
    expect(seen).not.toContain("answer");
    release();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      seen += decoder.decode(r.value);
    }
    expect(seen).toContain('"text":"answer!"');
  });

  it("forwards upstream pings during the hold, ahead of the held events", async () => {
    const { engine } = engineWith([rewriteHook("rw", () => [act.appendText("!")])]);
    const out = await readAll(
      await applyResponseSeam(
        sse([
          messageStart(),
          start(0, { type: "text", text: "" }),
          PING_FRAME,
          textDelta(0, "x"),
          stop(0),
          messageDelta(),
          messageStop(),
        ]),
        await scopeOf(engine)
      )
    );
    expect(out.indexOf(PING_FRAME)).toBeLessThan(out.indexOf("content_block_start"));
  });

  it("emits its own ping each interval while awaiting responseRewrite after upstream close", async () => {
    const { engine } = engineWith([
      rewriteHook("slow", async () => {
        await Bun.sleep(260);
        return [];
      }),
    ]);
    const out = await readAll(
      await applyResponseSeam(
        sse([messageStart(), ...textBlock(0, "x"), messageDelta(), messageStop()]),
        await scopeOf(engine),
        { pingIntervalMs: 50 }
      )
    );
    const pings = out.split(PING_FRAME).length - 1;
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(out.indexOf(PING_FRAME)).toBeLessThan(out.indexOf("content_block_start"));
  });

  it("repairs a held tool block's arguments before the rewrite hooks see the response", async () => {
    let seen: ResponseView | undefined;
    const { engine } = engineWith([
      repairHook("Write", { file_path: "/fixed" }),
      rewriteHook("look", (view) => {
        seen = view;
        return [];
      }),
    ]);
    const out = await readAll(
      await applyResponseSeam(
        sse([
          messageStart(),
          ...toolBlock(0, "Write", ['{"file_path":"/x"}']),
          messageDelta("tool_use"),
          messageStop(),
        ]),
        await scopeOf(engine)
      )
    );
    expect(payloads(out).find((p) => p.type === "content_block_delta").delta.partial_json).toBe(
      '{"file_path":"/fixed"}'
    );
    expect(seen?.blocks).toEqual([
      { type: "tool_use", id: "toolu_0", name: "Write", input: { file_path: "/fixed" } },
    ]);
    expect(seen?.stopReason).toBe("tool_use");
  });

  it("past the hold cap it flushes everything unchanged and stops holding", async () => {
    const { engine, journal } = engineWith([rewriteHook("rw", () => [act.appendText("!")])]);
    const input = [messageStart(), ...textBlock(0, "x".repeat(500)), messageDelta(), messageStop()];
    const out = await readAll(
      await applyResponseSeam(sse(input), await scopeOf(engine), { holdCapBytes: 200 })
    );
    expect(out).toBe(input.join(""));
    expect(journal.some((e) => e.decision === "invalid" && e.detail === "buffer_cap")).toBe(true);
  });

  it("an upstream error event while holding flushes the held events unchanged, then the error", async () => {
    const { engine } = engineWith([rewriteHook("rw", () => [act.appendText("!")])]);
    const error = frame("error", {
      type: "error",
      error: { type: "overloaded_error", message: "x" },
    });
    const input = [
      messageStart(),
      start(0, { type: "text", text: "" }),
      textDelta(0, "partial"),
      error,
    ];
    const out = await readAll(await applyResponseSeam(sse(input), await scopeOf(engine)));
    expect(out).toBe(input.join(""));
  });

  it("a stream that ends while holding forwards what it held", async () => {
    const { engine } = engineWith([rewriteHook("rw", () => [act.appendText("!")])]);
    const input = [messageStart(), start(0, { type: "text", text: "" }), textDelta(0, "partial")];
    const out = await readAll(await applyResponseSeam(sse(input), await scopeOf(engine)));
    expect(out).toBe(input.join(""));
  });

  it("a citations text block is never rewritten, and the skip is journaled", async () => {
    const { engine, journal } = engineWith([
      rewriteHook("rw", () => [act.replaceText("cite", "X")]),
    ]);
    const input = [
      messageStart(),
      start(0, { type: "text", text: "" }),
      textDelta(0, "cite me"),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "citations_delta", citation: { cited_text: "c" } },
      }),
      stop(0),
      messageDelta(),
      messageStop(),
    ];
    const out = await readAll(await applyResponseSeam(sse(input), await scopeOf(engine)));
    expect(out).toBe(input.join(""));
    expect(journal.some((e) => e.decision === "invalid" && e.detail === "citations")).toBe(true);
  });

  it("splits a multi-byte character across chunks without corrupting it", async () => {
    const { engine } = engineWith([rewriteHook("rw", () => [act.appendText("!")])]);
    const whole = [
      messageStart(),
      ...textBlock(0, "snow ☃ man"),
      messageDelta(),
      messageStop(),
    ].join("");
    const bytes = encoder.encode(whole);
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte snowman
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const out = await readAll(await applyResponseSeam(res, await scopeOf(engine)));
    expect(payloads(out).find((p) => p.delta?.type === "text_delta").delta.text).toBe(
      "snow ☃ man!"
    );
  });
});

/* ───────────── fail open ───────────── */

describe("fail open", () => {
  it("a throw inside the transform forwards what it held, and the rest, unchanged", async () => {
    const throwing = {
      intercepts: () => false,
      rewrite: () => {
        throw new Error("seam bug");
      },
      noteRewriteInvalid: () => {},
      recordRewrite: () => {},
    } as unknown as SeamHooks;
    const input = [messageStart(), ...textBlock(0, "keep"), messageDelta(), messageStop()];
    const out = await readAll(
      new Response(closedTransform(sse(input).body!, { mode: "buffer", hooks: throwing }))
    );
    expect(out).toBe(input.join(""));
  });

  it("an upstream read error forwards what was held, then errors the stream", async () => {
    const { engine } = engineWith([rewriteHook("rw", () => [])]);
    const res = await applyResponseSeam(
      sse([messageStart(), start(0, { type: "text", text: "" }), textDelta(0, "partial")], {
        errorAfter: 3,
      }),
      await scopeOf(engine)
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    let error: unknown;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        seen += decoder.decode(r.value);
      }
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain("upstream socket dropped");
    expect(seen).toContain('"text":"partial"');
  });
});

/* ───────────── tap, inbox and responseEnd ───────────── */

describe("observe tap", () => {
  const endHook = (onEnd: (view: ResponseView) => unknown = () => []) =>
    userHook({ id: "end", on: { responseEnd: (ctx) => onEnd(ctx.response) as never } });

  it("passes every chunk through unchanged and delivers chunk 1 before chunk 2 exists", async () => {
    const { engine } = engineWith([endHook()]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const chunks = [messageStart(), ...textBlock(0, "x"), messageDelta(), messageStop()];
    const res = await applyResponseSeam(
      sse(chunks, { gates: new Map([[1, gate]]) }),
      await scopeOf(engine)
    );
    const reader = res.body!.getReader();
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(500).then(() => "timeout" as const),
    ]);
    expect(first).not.toBe("timeout");
    expect(new TextDecoder().decode((first as ReadableStreamReadResult<Uint8Array>).value)).toBe(
      chunks[0]
    );
    release();
    const rest: string[] = [];
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      rest.push(new TextDecoder().decode(r.value));
    }
    // Same bytes, same chunking.
    expect(rest).toEqual(chunks.slice(1));
  });

  for (const mode of ["none", "intercept", "buffer"] as const) {
    it(`inbox stop is on disk when the client reads the message_stop chunk (mode ${mode})`, async () => {
      const path = inboxPath();
      const hooks = [endHook()];
      if (mode === "intercept") hooks.push(repairHook("Write", { a: 1 }));
      if (mode === "buffer") hooks.push(rewriteHook("rw", () => [act.appendText("!")]));
      const { engine } = engineWith(hooks);
      const scope = await scopeOf(engine);
      expect(planSeam(scope).mode).toBe(mode);
      const res = await applyResponseSeam(
        sse([
          messageStart(),
          ...textBlock(0, "x"),
          ...toolBlock(1, "Write", ["{}"]),
          messageDelta(),
          messageStop(),
        ]),
        scope,
        { sink: new InboxFileSink(path), req: "r1" }
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let atStop: any[] | null = null;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (decoder.decode(r.value).includes('"type":"message_stop"')) {
          atStop = inboxLines(path);
        }
      }
      expect(atStop).toEqual([{ v: 1, kind: "stop", req: "r1" }]);
      await until(() => inboxLines(path).length === 2);
      expect(inboxLines(path)[1]).toEqual({ v: 1, kind: "end", req: "r1" });
    });
  }

  it("responseEnd sees the bytes the client received (the rewrite included)", async () => {
    let seen: ResponseView | undefined;
    const { engine } = engineWith([
      rewriteHook("rw", () => [act.appendText(" HOOK-ADDED")]),
      endHook((view) => {
        seen = view;
        return [];
      }),
    ]);
    await readAll(
      await applyResponseSeam(
        sse([messageStart(), ...textBlock(0, "answer"), messageDelta(), messageStop()]),
        await scopeOf(engine)
      )
    );
    await until(() => seen !== undefined);
    expect(seen?.text).toBe("answer HOOK-ADDED");
    expect(seen?.stopReason).toBe("end_turn");
  });

  it("routes responseEnd actions: inject and annotate to the inbox, a system note to the next request", async () => {
    const path = inboxPath();
    const { engine, journal } = engineWith([
      endHook(() => [
        act.injectUserTurn("HOOK-PING"),
        act.annotateTurn("k", { n: 1 }),
        act.injectSystemNote("NEXT"),
      ]),
    ]);
    await readAll(
      await applyResponseSeam(
        sse([messageStart(), ...textBlock(0, "x"), messageDelta(), messageStop()]),
        await scopeOf(engine),
        { sink: new InboxFileSink(path, undefined, () => new Date(0)), req: "r9" }
      )
    );
    await until(() => inboxLines(path).some((l) => l.kind === "end"));
    expect(inboxLines(path)).toEqual([
      { v: 1, kind: "stop", req: "r9" },
      {
        v: 1,
        kind: "inject",
        req: "r9",
        hookId: "hook:t/end",
        text: "HOOK-PING",
        at: "1970-01-01T00:00:00.000Z",
      },
      {
        v: 1,
        kind: "annotate",
        req: "r9",
        hookId: "hook:t/end",
        key: "k",
        value: { n: 1 },
        at: "1970-01-01T00:00:00.000Z",
      },
      { v: 1, kind: "end", req: "r9" },
    ]);
    expect(engine.peekNotes(SESSION).map((n) => n.text)).toEqual(["NEXT"]);
    expect(
      journal.filter((e) => e.event === "responseEnd" && e.decision === "queued")
    ).toHaveLength(3);
  });

  it("with no session driver an injection is dropped `unavailable`, with one stderr line per process", async () => {
    const lines: string[] = [];
    const { engine, journal } = engineWith([endHook(() => [act.injectUserTurn("X")])]);
    const { resetUnavailableSinkReportForTests } = await import("./injection/sinks.js");
    resetUnavailableSinkReportForTests();
    for (let i = 0; i < 2; i++) {
      await readAll(
        await applyResponseSeam(
          sse([messageStart(), ...textBlock(0, "x"), messageDelta(), messageStop()]),
          await scopeOf(engine),
          { sink: new UnavailableSink((l) => lines.push(l)) }
        )
      );
    }
    await until(() => journal.filter((e) => e.decision === "dropped").length === 2);
    expect(journal.filter((e) => e.detail === "unavailable")).toHaveLength(2);
    expect(lines).toHaveLength(1);
  });

  it("a warn-severity responseEnd hook writes nothing but stop/end, and journals warned", async () => {
    const path = inboxPath();
    const { engine, journal } = engineWith([endHook(() => [act.injectUserTurn("X")])], {
      "hook:t/end": "warn",
    });
    await readAll(
      await applyResponseSeam(
        sse([messageStart(), ...textBlock(0, "x"), messageDelta(), messageStop()]),
        await scopeOf(engine),
        { sink: new InboxFileSink(path), req: "w" }
      )
    );
    await until(() => inboxLines(path).some((l) => l.kind === "end"));
    expect(inboxLines(path).map((l) => l.kind)).toEqual(["stop", "end"]);
    expect(journal.some((e) => e.event === "responseEnd" && e.decision === "warned")).toBe(true);
  });

  it("a client cancel writes end with aborted at once, and cancels the upstream", async () => {
    const path = inboxPath();
    let cancelled = false;
    const { engine } = engineWith([endHook()]);
    const res = await applyResponseSeam(
      sse([messageStart(), ...textBlock(0, "x"), messageDelta(), messageStop()], {
        gates: new Map([[2, new Promise<void>(() => {})]]),
        onCancel: () => {
          cancelled = true;
        },
      }),
      await scopeOf(engine),
      { sink: new InboxFileSink(path), req: "c" }
    );
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("client went away");
    expect(inboxLines(path)).toEqual([{ v: 1, kind: "end", req: "c", aborted: true }]);
    expect(cancelled).toBe(true);
  });

  it("a response that ends before message_stop writes only its end", async () => {
    const path = inboxPath();
    const { engine } = engineWith([endHook()]);
    await readAll(
      await applyResponseSeam(sse([messageStart(), ...textBlock(0, "x")]), await scopeOf(engine), {
        sink: new InboxFileSink(path),
        req: "t",
      })
    );
    expect(inboxLines(path)).toEqual([{ v: 1, kind: "end", req: "t", aborted: true }]);
  });

  it("observe-mode and warn-severity toolCall hooks see the delivered call and hold nothing", async () => {
    const seen: string[] = [];
    const observe = userHook({
      id: "obs",
      on: {
        toolCall: {
          tools: ["Write"],
          observe: true,
          handle: (ctx) => {
            seen.push(`obs:${JSON.stringify(ctx.tool.args)}`);
            return [act.warn("seen")];
          },
        },
      },
    });
    const warnRepair = userHook({
      id: "warned",
      on: {
        toolCall: {
          tools: ["Write"],
          handle: (ctx) => {
            seen.push(`warn:${ctx.tool.rawArgs}`);
            return [act.repairToolArgs({ changed: true }, "would repair")];
          },
        },
      },
    });
    const { engine, journal } = engineWith([observe, warnRepair], { "hook:t/warned": "warn" });
    const scope = await scopeOf(engine);
    expect(planSeam(scope)).toEqual({ mode: "none", tap: true });
    const input = [
      messageStart(),
      ...toolBlock(0, "Write", ['{"a":', "1}"]),
      messageDelta(),
      messageStop(),
    ];
    const out = await readAll(await applyResponseSeam(sse(input), scope));
    expect(out).toBe(input.join(""));
    await until(() => seen.length === 2);
    expect(seen.sort()).toEqual(['obs:{"a":1}', 'warn:{"a":1}']);
    await until(() => journal.some((e) => e.hookId === "hook:t/warned" && e.decision === "warned"));
  });
});

/* ───────────── JSON branch ───────────── */

describe("non-streaming JSON branch", () => {
  const jsonResponse = (message: object) =>
    new Response(JSON.stringify(message), {
      status: 200,
      headers: { "content-type": "application/json", "x-upstream": "kept" },
    });

  it("repairs tool_use.input, rewrites text, keeps status and headers, and writes stop before returning", async () => {
    const path = inboxPath();
    let seen: ResponseView | undefined;
    const { engine } = engineWith([
      repairHook("Write", { file_path: "/fixed" }),
      rewriteHook("rm", () => [act.removeText("\\s*REMOVE-ME", { regex: true })]),
      userHook({
        id: "end",
        on: {
          responseEnd: (ctx) => {
            seen = ctx.response;
          },
        },
      }),
    ]);
    const res = await applyResponseSeam(
      jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "KEEP REMOVE-ME KEEP" },
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/wrong" } },
        ],
        stop_reason: "tool_use",
      }),
      await scopeOf(engine),
      { sink: new InboxFileSink(path), req: "j" }
    );
    expect(inboxLines(path)).toEqual([{ v: 1, kind: "stop", req: "j" }]);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("kept");
    const body = await res.json();
    expect(body.content).toEqual([
      { type: "text", text: "KEEP KEEP" },
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/fixed" } },
    ]);
    await until(() => inboxLines(path).length === 2);
    expect(seen?.text).toBe("KEEP KEEP");
  });

  it("inserts a text block before the first tool_use when the message has no text", async () => {
    const { engine } = engineWith([rewriteHook("add", () => [act.appendText("A")])]);
    const res = await applyResponseSeam(
      jsonResponse({
        content: [
          { type: "thinking", thinking: "t", signature: "s" },
          { type: "tool_use", id: "t1", name: "R", input: {} },
        ],
      }),
      await scopeOf(engine)
    );
    expect((await res.json()).content.map((b: any) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
  });

  it("passes a body that is not a message through unchanged", async () => {
    const { engine } = engineWith([rewriteHook("add", () => [act.appendText("A")])]);
    const res = await applyResponseSeam(
      new Response("not json", { headers: { "content-type": "application/json" } }),
      await scopeOf(engine)
    );
    expect(await res.text()).toBe("not json");
  });
});

/* ───────────── through withHooks ───────────── */

describe("withHooks applies the seam", () => {
  it("an accepted response with a claiming hook is rewritten; a non-2xx one is not", async () => {
    const { engine } = engineWith([rewriteHook("add", () => [act.appendText("!")])]);
    const terminal = (status: number) => ({
      async handle(c: any, body: any) {
        const hooks = (await import("./request-stage.js")).requestHooksOf(c);
        await hooks?.beginAttempt(c, {
          claudeRequest: structuredClone(body),
          route: { modelId: "m", provider: "p", native: false },
          model: "m",
          stream: true,
        });
        return status === 200
          ? sse([messageStart(), ...textBlock(0, "hi"), messageDelta(), messageStop()])
          : new Response("{}", { status });
      },
      shutdown: async () => {},
    });
    const ok = await withHooks(terminal(200), engine).handle(fakeContext(), {
      messages: [{ role: "user", content: "x" }],
    });
    expect(await ok.text()).toContain('"text":"hi!"');
    const failed = await withHooks(terminal(500), engine).handle(fakeContext(), {
      messages: [{ role: "user", content: "x" }],
    });
    expect(await failed.text()).toBe("{}");
  });
});
