/**
 * Raw tier units: the ResponseRecorder, `statsNames`, the Gemini built-in's
 * per-route cache, and the seam plan for a raw-only request. The end-to-end
 * containment rows (X-1 … X-8) are in handlers/composed-handler-raw.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { createGeminiThoughtSignatureHook } from "./builtins/gemini-thought-signature.js";
import { builtinHooks } from "./builtins/index.js";
import { HookEngine } from "./engine.js";
import type { JournalEntry } from "./journal.js";
import type { HookDefinition, RouteInfo } from "./public.js";
import { RawRequest, ResponseRecorder, statsNames } from "./raw.js";
import { HookRegistry, type UserHookInput } from "./registry.js";
import { HookRequestScope } from "./request-stage.js";
import { planSeam } from "./response-seam.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function engineOf(
  builtins: ReturnType<typeof builtinHooks>,
  users: UserHookInput[] = [],
  journal: JournalEntry[] = []
): HookEngine {
  return new HookEngine({
    registry: new HookRegistry(builtins, users, undefined),
    config: {},
    hostMode: "other",
    journalSink: (e) => journal.push(e),
    warn: () => {},
    drainTelemetryOutbox: false,
  });
}

const route = (modelId: string, provider = "openrouter"): RouteInfo => ({
  modelId,
  provider,
  native: false,
});

function rawFor(engine: HookEngine, r: RouteInfo): RawRequest {
  return new RawRequest(
    engine,
    r,
    { model: r.modelId, provider: r.provider },
    { model: r.modelId, stream: true, systemText: "", messages: [], tools: [] }
  );
}

/** A source that hands out `n` chunks, counting pulls. */
function countingSource(n: number) {
  const state = { pulls: 0 };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        state.pulls++;
        if (i >= n) c.close();
        else c.enqueue(encoder.encode(`chunk-${i++};`));
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, state };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = "";
  const reader = stream.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) return out;
    out += decoder.decode(r.value);
  }
}

describe("ResponseRecorder", () => {
  it("drains its input to the end with no reader at all", async () => {
    const { stream, state } = countingSource(8);
    const recorder = new ResponseRecorder(stream);
    recorder.replay(); // a replay nobody reads
    await recorder.ended;
    expect(state.pulls).toBe(9); // 8 chunks + the pull that closed it
    expect(recorder.done).toBe(true);
  });

  it("serves independent replays from byte 0; cancelling one leaves the other", async () => {
    const { stream } = countingSource(4);
    const recorder = new ResponseRecorder(stream);
    const a = recorder.replay();
    const b = recorder.replay();
    const readerA = a.stream.getReader();
    await readerA.read();
    await readerA.cancel();
    expect(await readAll(b.stream)).toBe("chunk-0;chunk-1;chunk-2;chunk-3;");
  });

  it("a replay created later still starts at byte 0 while retaining", async () => {
    const { stream } = countingSource(3);
    const recorder = new ResponseRecorder(stream);
    await recorder.ended;
    expect(await readAll(recorder.replay().stream)).toBe("chunk-0;chunk-1;chunk-2;");
  });

  it("a replay of an errored input errors after the bytes it had", async () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ === 0) c.enqueue(encoder.encode("first"));
        else c.error(new Error("upstream broke"));
      },
    });
    const recorder = new ResponseRecorder(stream);
    const reader = recorder.replay().stream.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe("first");
    await expect(reader.read()).rejects.toThrow("upstream broke");
  });
});

describe("statsNames", () => {
  it("names the Gemini built-in on gemini and google/ models only", () => {
    const engine = engineOf(builtinHooks({}));
    expect(statsNames(engine, route("google/gemini-3.1-pro-preview"))).toEqual([
      "GeminiThoughtSignature",
    ]);
    expect(statsNames(engine, route("gemini-2.5-flash", "google"))).toEqual([
      "GeminiThoughtSignature",
    ]);
    expect(statsNames(engine, route("gpt-5.6-sol"))).toEqual([]);
    expect(statsNames(null, route("gemini-2.5-flash"))).toEqual([]);
  });

  it("with a catalog connection, selects the Gemini built-in from the catalog data, not the name (0d40e396)", () => {
    const engine = engineOf(builtinHooks({}));
    const names = (modelId: string, wireApi: string | null, vendor: string | null) =>
      statsNames(engine, route(modelId), { wireApi, vendor });
    // a Google model behind a gateway, under an id with neither `gemini` nor `google/`
    expect(names("or-7f3a2c", "chat-completions", "google")).toEqual(["GeminiThoughtSignature"]);
    // a Gemini-API wire, vendor unpublished
    expect(names("opaque-id", "gemini", null)).toEqual(["GeminiThoughtSignature"]);
    // a connection that is neither: the name is not asked again
    expect(names("gemini-lookalike", "chat-completions", "openai")).toEqual([]);
    expect(names("google/whatever", null, null)).toEqual([]);
  });

  it("the raw tier of a connected attempt runs the Gemini built-in by the same rule", () => {
    const engine = engineOf(builtinHooks({}));
    const facts = { model: "x", stream: true, systemText: "", messages: [], tools: [] };
    const meta = { model: "or-7f3a2c", provider: "openrouter" };
    const google = new RawRequest(engine, route("or-7f3a2c"), meta, facts, {
      wireApi: "chat-completions",
      vendor: "google",
    });
    expect(google.hooks("providerRequest").map((a) => a.hook.id)).toEqual([
      "gemini/thought-signature",
    ]);
    const other = new RawRequest(engine, route("gemini-lookalike"), meta, facts, {
      wireApi: "chat-completions",
      vendor: "openai",
    });
    expect(other.hooks("providerRequest")).toEqual([]);
    // no connection: the name globs decide
    expect(rawFor(engine, route("gemini-2.5-flash")).hooks("providerRequest")).toHaveLength(1);
  });

  it("never names a user hook, and an off built-in is not active", () => {
    const user: UserHookInput = {
      id: "hook:u/raw",
      module: "/u.ts",
      moduleIndex: 0,
      exportIndex: 0,
      def: {
        apiVersion: 1,
        id: "raw",
        unsafe: true,
        raw: { providerChunk() {} },
      } as HookDefinition,
    };
    const engine = engineOf([], [user]);
    expect(statsNames(engine, route("gemini-2.5-flash"))).toEqual([]);

    const off = new HookEngine({
      registry: new HookRegistry(builtinHooks({}), [], { "gemini/*": "off" }),
      config: {},
      hostMode: "other",
      journalSink: () => {},
      warn: () => {},
      drainTelemetryOutbox: false,
    });
    expect(statsNames(off, route("gemini-2.5-flash"))).toEqual([]);
  });
});

describe("Gemini built-in: the cache is per route", () => {
  const reasoningChunk = (sig: string, callId: string) => ({
    choices: [
      {
        delta: {
          reasoning_details: [{ type: "reasoning.text", signature: sig }],
          tool_calls: [{ index: 0, id: callId, function: { name: "Read", arguments: "" } }],
        },
      },
    ],
  });
  const assistantCall = (callId: string) => ({
    role: "assistant",
    content: "",
    tool_calls: [{ id: callId, type: "function", function: { name: "Read", arguments: "{}" } }],
  });

  async function streamThrough(engine: HookEngine, r: RouteInfo, chunk: unknown): Promise<void> {
    const tap = rawFor(engine, r).streamTap();
    expect(tap).toBeDefined();
    tap?.chunk(chunk, (c: any) => c.choices?.[0]?.delta);
    await tap?.streamEnd();
  }

  it("two models' signatures never mix, and each lands on its own call", async () => {
    const engine = engineOf([createGeminiThoughtSignatureHook()]);
    const a = route("google/gemini-3.1-pro-preview");
    const b = route("gemini-2.5-flash", "google");
    await streamThrough(engine, a, reasoningChunk("SIG-A", "call_a"));
    await streamThrough(engine, b, reasoningChunk("SIG-B", "call_b"));

    const messages = [assistantCall("call_a"), assistantCall("call_b")];
    const forA = await rawFor(engine, a).providerRequest({
      claudeRequest: {},
      messages: structuredClone(messages),
      tools: [],
    });
    const forB = await rawFor(engine, b).providerRequest({
      claudeRequest: {},
      messages: structuredClone(messages),
      tools: [],
    });
    const sigs = (m: any) => m.reasoning_details?.map((d: any) => d.signature) ?? null;
    expect(forA.messages.map(sigs)).toEqual([["SIG-A"], null]);
    expect(forB.messages.map(sigs)).toEqual([null, ["SIG-B"]]);
  });

  it("the client stream is not changed: a committed chunk equals the parsed one", () => {
    const engine = engineOf([createGeminiThoughtSignatureHook()]);
    const tap = rawFor(engine, route("gemini-2.5-flash")).streamTap();
    const chunk = reasoningChunk("SIG", "call_x");
    const out = tap?.chunk(chunk, (c: any) => c.choices?.[0]?.delta);
    expect(out).toEqual(chunk);
  });

  it("at warn it computes but never sends: the request stays as it is at off", async () => {
    const journal: JournalEntry[] = [];
    const engine = new HookEngine({
      registry: new HookRegistry([createGeminiThoughtSignatureHook()], [], { "gemini/*": "warn" }),
      config: {},
      hostMode: "other",
      journalSink: (e) => journal.push(e),
      warn: () => {},
      drainTelemetryOutbox: false,
    });
    const r = route("gemini-2.5-flash");
    await streamThrough(engine, r, reasoningChunk("SIG", "call_w"));
    const out = await rawFor(engine, r).providerRequest({
      claudeRequest: {},
      messages: [assistantCall("call_w")],
      tools: [],
    });
    expect((out.messages[0] as any).reasoning_details).toBeUndefined();
    expect(journal.some((e) => e.decision === "warned" && e.event === "raw")).toBe(true);
    expect(journal.some((e) => e.decision === "raw")).toBe(false);
  });
});

describe("seam plan", () => {
  it("a request whose only consumer is a raw response hook plans mode=none raw=1 tap=0", async () => {
    const user: UserHookInput = {
      id: "hook:u/resp",
      module: "/u.ts",
      moduleIndex: 0,
      exportIndex: 0,
      def: {
        apiVersion: 1,
        id: "resp",
        unsafe: true,
        raw: { response() {} },
      } as HookDefinition,
    };
    const engine = engineOf([], [user]);
    const scope = await HookRequestScope.begin(engine, null, {
      claudeRequest: { messages: [{ role: "user", content: "hi" }] },
      route: route("glm-5"),
      model: "glm-5",
      stream: true,
    });
    expect(planSeam(scope)).toEqual({ mode: "none", raw: 1, tap: false });
  });
});

describe("a client cancel while a raw response hook fails", () => {
  /** Every `controller.error()` any ReadableStream in this process makes, while installed. */
  function spyControllerErrors() {
    let ctor: { prototype: { error(e?: unknown): void } } | null = null;
    new ReadableStream({
      start(c) {
        ctor = (c as unknown as { constructor: typeof ctor }).constructor;
      },
    });
    const proto = (ctor as unknown as { prototype: { error(e?: unknown): void } }).prototype;
    const original = proto.error;
    const seen: unknown[] = [];
    proto.error = function (this: unknown, e?: unknown) {
      seen.push(e);
      return original.call(this, e);
    };
    const restore = () => {
      proto.error = original;
    };
    return { seen, restore };
  }

  for (const [name, fail] of [
    ["throws", "throw"],
    ["times out", "timeout"],
  ] as const) {
    it(`the hook ${name} after the cancel: no fallback is read, no controller.error is raised`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const user: UserHookInput = {
        id: "hook:u/cr5",
        module: "/u.ts",
        moduleIndex: 0,
        exportIndex: 0,
        def: {
          apiVersion: 1,
          id: "cr5",
          unsafe: true,
          timeoutMs: 200,
          raw: {
            response: () =>
              fail === "throw"
                ? gate.then(() => {
                    throw new Error("failed after the cancel");
                  })
                : new Promise(() => {}),
          },
        } as HookDefinition,
      };
      const engine = engineOf([], [user]);
      const raw = rawFor(engine, route("glm-5"));
      const input = new Response(countingSource(4).stream, {
        headers: { "content-type": "application/json" },
      });
      const spy = spyControllerErrors();
      try {
        const reader = (raw.responseStages(input).body as ReadableStream<Uint8Array>).getReader();
        const pending = reader.read(); // a pull waiting for the decision
        await Bun.sleep(30); // the pull is running, parked on the undecided stage
        await reader.cancel("client went away");
        await pending.catch(() => undefined);
        release();
        await Bun.sleep(fail === "timeout" ? 400 : 50);
        expect(spy.seen).toEqual([]);
      } finally {
        spy.restore();
      }
    });
  }
});
