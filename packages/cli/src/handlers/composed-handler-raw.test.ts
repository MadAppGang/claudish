/**
 * The raw (unsafe) tier end to end: a ComposedHandler through `withHooks`, a
 * stubbed upstream replaying scripted provider events, and hook modules written
 * to a temp dir and loaded by the real loader. Assertions are on what the
 * client reads and what the transport receives.
 *
 * X-1 … X-8 are the architecture's §11.5 rows for transactional containment
 * and the parser commit; the rest cover `providerRequest` containment, warn
 * severity, and a replacement that succeeds or fails.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { HookEngine } from "../hooks/engine.js";
import type { JournalEntry } from "../hooks/journal.js";
import { loadUserHooks } from "../hooks/loader.js";
import { HookRegistry } from "../hooks/registry.js";
import { withHooks } from "../hooks/response-seam.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { stripPings } from "../test-fixtures/parser-goldens/golden-format.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;
const dir = mkdtempSync(join(tmpdir(), "claudish-raw-"));
const g = globalThis as Record<string, any>;

afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const encoder = new TextEncoder();

/* ───────────── upstream ───────────── */

interface Source {
  /** Chunks the source has handed out. */
  released: number;
  closed: boolean;
}

/** Stub fetch: answer with `chunks`, optionally one per `delayMs`, recording the request body. */
function stubUpstream(
  chunks: string[],
  opts: { delayMs?: number; json?: boolean } = {}
): { source: Source; bodies: any[] } {
  const source: Source = { released: 0, closed: false };
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    let i = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (opts.delayMs) await Bun.sleep(opts.delayMs);
          if (i >= chunks.length) {
            source.closed = true;
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[i++] as string));
          source.released = i;
        },
      }),
      {
        status: 200,
        headers: { "content-type": opts.json ? "application/json" : "text/event-stream" },
      }
    );
  }) as unknown as typeof fetch;
  return { source, bodies };
}

function transport(streamFormat: string): ProviderTransport {
  return {
    name: "test-provider",
    displayName: "Test",
    streamFormat,
    overrideStreamFormat: () => streamFormat,
    getEndpoint: () => "http://localhost/v1/chat/completions",
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

function context(): any {
  const vars = new Map<string, unknown>();
  return {
    req: {
      header: (name?: string) =>
        name === undefined ? {} : name === "x-claudish-no-recovery" ? "1" : undefined,
    },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
  };
}

const MODEL = "test-model";

function handler(format: "openai-sse" | "openai-responses-sse" | "anthropic-sse") {
  const adapter =
    format === "anthropic-sse" ? new AnthropicAPIFormat(MODEL) : new OpenAIAPIFormat(MODEL);
  return new ComposedHandler(transport(format), MODEL, MODEL, 8080, { adapter });
}

function payload(stream = true): any {
  return {
    model: MODEL,
    max_tokens: 64,
    stream,
    system: "You are a test.",
    messages: [{ role: "user", content: "Say something." }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } },
      },
    ],
  };
}

/* ───────────── hooks ───────────── */

let moduleSeq = 0;

/** Write `source` as a hook module, load it with the real loader, build an engine over it. */
async function loadHook(source: string, severity?: Record<string, "off" | "warn" | "fix">) {
  const name = `rawhook${++moduleSeq}`;
  // One directory per module: Bun's resolver caches a directory's entries on
  // first import, so a file written later into the same directory is not found.
  const moduleDir = mkdtempSync(join(dir, "m-"));
  const path = join(moduleDir, `${name}.ts`);
  writeFileSync(path, source);
  const loadWarnings: string[] = [];
  const loaded = await loadUserHooks({
    modules: [path],
    configDir: moduleDir,
    hostMode: "other",
    warn: (l) => loadWarnings.push(l),
  });
  const journal: JournalEntry[] = [];
  const engineWarnings: string[] = [];
  const engine = new HookEngine({
    registry: new HookRegistry([], loaded.hooks, severity),
    config: {},
    hostMode: "other",
    journalSink: (e) => journal.push(e),
    warn: (l) => engineWarnings.push(l),
    drainTelemetryOutbox: false,
  });
  return { name, engine, journal, loadWarnings, engineWarnings, loaded };
}

/* ───────────── wire ───────────── */

const openAiFrame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const anthropicFrame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function payloads(wire: string): any[] {
  const out: any[] = [];
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      out.push(JSON.parse(line.slice(6)));
    } catch {
      // not JSON
    }
  }
  return out;
}

function textOf(wire: string): string {
  return payloads(wire)
    .filter((p) => p.type === "content_block_delta" && p.delta?.type === "text_delta")
    .map((p) => p.delta.text)
    .join("");
}

function thinkingOf(wire: string): string {
  return payloads(wire)
    .filter((p) => p.type === "content_block_delta" && p.delta?.type === "thinking_delta")
    .map((p) => p.delta.thinking)
    .join("");
}

function stopReasonOf(wire: string): string | undefined {
  return payloads(wire).find((p) => p.type === "message_delta")?.delta?.stop_reason;
}

const responsesEvent = (data: Record<string, unknown>) =>
  `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

function responsesStream(deltas: string[]): string[] {
  return [
    responsesEvent({ type: "response.created", response: { id: "resp_1" } }),
    ...deltas.map((d) => responsesEvent({ type: "response.output_text.delta", delta: d })),
    responsesEvent({
      type: "response.completed",
      response: { id: "resp_1", usage: { input_tokens: 5, output_tokens: 3 } },
    }),
  ];
}

/** An 8-event Claude SSE message (anthropic-sse passthrough). */
function claudeMessage(text = "original answer"): string[] {
  const half = Math.floor(text.length / 2);
  return [
    anthropicFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_raw",
        type: "message",
        role: "assistant",
        content: [],
        model: MODEL,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
    anthropicFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, half) },
    }),
    anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(half) },
    }),
    anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    }),
    anthropicFrame("message_stop", { type: "message_stop" }),
    anthropicFrame("ping", { type: "ping" }),
  ];
}

/** The same upstream through the same route with no hooks: what "the original" is. */
async function originalWire(format: "anthropic-sse", chunks: string[]): Promise<string> {
  stubUpstream(chunks);
  return stripPings(await (await handler(format).handle(context(), payload())).text());
}

async function settle(ms = 20): Promise<void> {
  await Bun.sleep(ms);
}

/* ───────────── X-1 … X-5: providerChunk ───────────── */

describe("X-1: a providerChunk that mutates and then returns a rejecting promise", () => {
  it("openai-sse: the client gets the original text; invalid + error journaled; no unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = await loadHook(`
        export default {
          apiVersion: 1, id: "x1", unsafe: true,
          raw: {
            providerChunk(ctx) {
              if (ctx.delta && "content" in ctx.delta) ctx.delta.content = "CORRUPTED";
              return Promise.reject(new Error("x"));
            },
          },
        };`);
      stubUpstream([
        openAiFrame({ choices: [{ delta: { role: "assistant", content: "original" } }] }),
        openAiFrame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]);
      const wire = await (
        await withHooks(handler("openai-sse"), h.engine).handle(context(), payload())
      ).text();
      await settle();

      expect(textOf(wire)).toBe("original");
      expect(wire).not.toContain("CORRUPTED");
      const lines = h.journal.filter((e) => e.hookId === `hook:${h.name}/x1`);
      expect(
        lines.some((e) => e.decision === "invalid" && e.detail?.includes("async_return"))
      ).toBe(true);
      expect(lines.some((e) => e.decision === "error" && e.detail?.includes("x"))).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("openai-responses-sse: ctx.delta.delta = CORRUPTED never reaches the client", async () => {
    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "x1r", unsafe: true,
        raw: {
          providerChunk(ctx) {
            if (typeof ctx.delta?.delta === "string") ctx.delta.delta = "CORRUPTED";
            return Promise.reject(new Error("x"));
          },
        },
      };`);
    stubUpstream(responsesStream(["original"]));
    const wire = await (
      await withHooks(handler("openai-responses-sse"), h.engine).handle(context(), payload())
    ).text();
    await settle();
    expect(textOf(wire)).toBe("original");
    expect(wire).not.toContain("CORRUPTED");
  });
});

describe("X-2: any thenable return is invalid, and five trip the breaker", () => {
  it("8 chunks: the client text is the original's; 5 invalid, then disabled with one stderr line", async () => {
    g.__x2calls = 0;
    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "x2", unsafe: true,
        raw: {
          providerChunk(ctx) {
            globalThis.__x2calls++;
            if (ctx.delta && "content" in ctx.delta) ctx.delta.content = "CORRUPTED";
            return Promise.resolve();
          },
        },
      };`);
    const parts = ["c1 ", "c2 ", "c3 ", "c4 ", "c5 ", "c6 ", "c7 ", "c8"];
    stubUpstream([
      ...parts.map((p) => openAiFrame({ choices: [{ delta: { content: p } }] })),
      openAiFrame({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const wire = await (
      await withHooks(handler("openai-sse"), h.engine).handle(context(), payload())
    ).text();
    await settle();

    expect(textOf(wire)).toBe(parts.join(""));
    const lines = h.journal.filter((e) => e.hookId === `hook:${h.name}/x2`);
    expect(lines.filter((e) => e.decision === "invalid")).toHaveLength(5);
    expect(lines.filter((e) => e.decision === "disabled")).toHaveLength(1);
    expect(h.engineWarnings).toHaveLength(1);
    expect(h.engineWarnings[0]).toContain("disabled");
    // Chunks 6 to 8 passed without a hook call.
    expect(g.__x2calls).toBe(5);
  });
});

describe("X-3: a declared async providerChunk is rejected at load", () => {
  it("the load warns once, registers the other hook, and never calls the async one", async () => {
    g.__x3calls = { sync: 0, async: 0 };
    const h = await loadHook(`
      export default [
        { apiVersion: 1, id: "async-one", unsafe: true,
          raw: { async providerChunk() { globalThis.__x3calls.async++; } } },
        { apiVersion: 1, id: "sync-one", unsafe: true,
          raw: { providerChunk() { globalThis.__x3calls.sync++; } } },
      ];`);
    const mustBeSync = h.loadWarnings.filter((l) =>
      l.includes("raw.providerChunk must be synchronous")
    );
    expect(mustBeSync).toHaveLength(1);
    expect(h.loaded.hooks.map((u) => u.id)).toEqual([`hook:${h.name}/sync-one`]);

    stubUpstream([
      openAiFrame({ choices: [{ delta: { content: "hi" } }] }),
      openAiFrame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    await (await withHooks(handler("openai-sse"), h.engine).handle(context(), payload())).text();
    expect(g.__x3calls.async).toBe(0);
    expect(g.__x3calls.sync).toBeGreaterThan(0);
  });
});

const X4_HOOK = `
  export default {
    apiVersion: 1, id: "x4", unsafe: true,
    raw: {
      providerChunk(ctx) {
        delete ctx.delta.reasoning_content;
        if ("content" in ctx.delta) ctx.delta.content = "rewritten";
        if (ctx.chunk.choices[0].finish_reason === "length") ctx.chunk.choices[0].finish_reason = "stop";
      },
    },
  };`;

function x4Upstream() {
  return stubUpstream([
    openAiFrame({ choices: [{ delta: { reasoning_content: "R" } }] }),
    openAiFrame({ choices: [{ delta: { content: "original" } }] }),
    openAiFrame({ choices: [{ delta: {}, finish_reason: "length" }] }),
    "data: [DONE]\n\n",
  ]);
}

describe("X-4: the parser reads the committed chunk (openai-sse)", () => {
  it("a deletion, a delta edit and a finish_reason change all reach the client", async () => {
    const h = await loadHook(X4_HOOK);
    x4Upstream();
    const wire = await (
      await withHooks(handler("openai-sse"), h.engine).handle(context(), payload())
    ).text();
    expect(thinkingOf(wire)).toBe("");
    expect(textOf(wire)).toBe("rewritten");
    expect(stopReasonOf(wire)).toBe("end_turn");
    expect(h.journal.some((e) => e.hookId === `hook:${h.name}/x4` && e.decision === "raw")).toBe(
      true
    );
  });

  it("control: the same hook at warn commits nothing", async () => {
    const h = await loadHook(X4_HOOK, { "hook:*": "warn" });
    x4Upstream();
    const wire = await (
      await withHooks(handler("openai-sse"), h.engine).handle(context(), payload())
    ).text();
    expect(thinkingOf(wire)).toBe("R");
    expect(textOf(wire)).toBe("original");
    expect(stopReasonOf(wire)).toBe("max_tokens");
    const warned = h.journal.filter((e) => e.decision === "warned");
    // Once per hook and stage, not once per chunk.
    expect(warned).toHaveLength(1);
  });
});

describe("X-5: the parser reads the committed event (openai-responses-sse)", () => {
  it("upper-casing ctx.delta.delta reaches the client", async () => {
    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "x5", unsafe: true,
        raw: {
          providerChunk(ctx) {
            if (typeof ctx.delta.delta === "string") ctx.delta.delta = ctx.delta.delta.toUpperCase();
          },
        },
      };`);
    stubUpstream(responsesStream(["orig", "inal"]));
    const wire = await (
      await withHooks(handler("openai-responses-sse"), h.engine).handle(context(), payload())
    ).text();
    expect(textOf(wire)).toBe("ORIGINAL");
  });
});

/* ───────────── X-6 … X-8: response ───────────── */

// Starts on the same line as the expression it is spliced after: a line break
// right after \`return\` would return undefined.
const NEVER_CLOSING = `new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { globalThis.__replacementCancels++; },
  }), { headers: { "content-type": "text/event-stream" } })`;

describe("X-6: an ignored view and a never-closing replacement", () => {
  it("the original is drained by claudish and forwarded from its first byte after the deadline", async () => {
    const chunks = claudeMessage();
    const expected = await originalWire("anthropic-sse", chunks);

    g.__replacementCancels = 0;
    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "x6", unsafe: true, timeoutMs: 300,
        raw: { response() { return ${NEVER_CLOSING}; } },
      };`);
    const { source } = stubUpstream(chunks);
    const res = await withHooks(handler("anthropic-sse"), h.engine).handle(context(), payload());

    const started = Date.now();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    let firstOriginalAt = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      const text = decoder.decode(r.value);
      if (!firstOriginalAt && stripPings(text).length > 0) firstOriginalAt = Date.now() - started;
      wire += text;
    }

    // The source was drained to its end with nobody reading the hook's view.
    expect(source.released).toBe(chunks.length);
    expect(source.closed).toBe(true);
    // Pings while the replacement was held, then the original from its first byte.
    expect(wire.startsWith("event: ping\n")).toBe(true);
    expect(stripPings(wire)).toBe(expected);
    expect(firstOriginalAt).toBeGreaterThanOrEqual(250);
    expect(wire).not.toContain("event: error");
    await settle();
    expect(g.__replacementCancels).toBe(1);
    expect(
      h.journal.some(
        (e) => e.hookId === `hook:${h.name}/x6` && e.decision === "timeout" && e.event === "raw"
      )
    ).toBe(true);
  });
});

describe("X-7: a partly read view, then a never-closing replacement", () => {
  it("behaves as X-6", async () => {
    const chunks = claudeMessage();
    const expected = await originalWire("anthropic-sse", chunks);

    g.__replacementCancels = 0;
    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "x7", unsafe: true, timeoutMs: 300,
        raw: {
          async response(ctx) {
            const reader = ctx.response.body.getReader();
            await reader.read();
            await reader.read();
            return ${NEVER_CLOSING};
          },
        },
      };`);
    const { source } = stubUpstream(chunks);
    const res = await withHooks(handler("anthropic-sse"), h.engine).handle(context(), payload());
    const wire = await res.text();

    expect(source.released).toBe(chunks.length);
    expect(source.closed).toBe(true);
    expect(wire.startsWith("event: ping\n")).toBe(true);
    expect(stripPings(wire)).toBe(expected);
    expect(wire).not.toContain("event: error");
    await settle();
    expect(g.__replacementCancels).toBe(1);
    expect(h.journal.some((e) => e.decision === "timeout" && e.event === "raw")).toBe(true);
  });
});

describe("X-8: nothing returned", () => {
  it("the original streams as it arrives, byte for byte, with no failure journaled", async () => {
    const chunks = claudeMessage();
    const expected = await originalWire("anthropic-sse", chunks);

    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "x8", unsafe: true,
        raw: { response() { return undefined; } },
      };`);
    const { source } = stubUpstream(chunks, { delayMs: 50 });
    const res = await withHooks(handler("anthropic-sse"), h.engine).handle(context(), payload());

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    let releasedAtFirstChunk = -1;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      const text = decoder.decode(r.value);
      if (releasedAtFirstChunk < 0 && stripPings(text).length > 0) {
        releasedAtFirstChunk = source.released;
      }
      wire += text;
    }

    expect(releasedAtFirstChunk).toBeGreaterThan(0);
    expect(releasedAtFirstChunk).toBeLessThan(3);
    expect(stripPings(wire)).toBe(expected);
    expect(h.journal.some((e) => ["error", "timeout", "invalid"].includes(e.decision))).toBe(false);
  });
});

/* ───────────── the hook's view never shares bytes with the fallback ───────────── */

describe("a raw response hook that edits the bytes it read in place", () => {
  /** Reads the first chunk of ctx.response, overwrites it in place, then ends with `tail`. */
  const editor = (id: string, tail: string, async = true) => `
    export default {
      apiVersion: 1, id: "${id}", unsafe: true,
      raw: {
        ${async ? "async " : ""}response(ctx) {
          const reader = ctx.response.body.getReader();
          return reader.read().then((r) => {
            if (r.value) r.value.fill(0x58);
            ${tail}
          });
        },
      },
    };`;

  for (const [name, tail, severity] of [
    ["throws (fix)", `throw new Error("edited, then failed");`, "fix"],
    ["returns nothing (fix)", "return undefined;", "fix"],
    ["returns a replacement (warn)", `return new Response("event: ping\\n\\n");`, "warn"],
  ] as const) {
    it(`${name}: the client receives the original bytes`, async () => {
      const chunks = claudeMessage();
      const expected = await originalWire("anthropic-sse", chunks);
      const h = await loadHook(editor(`cr3${name.length}`, tail), { "hook:*": severity });
      stubUpstream(chunks, { delayMs: 20 });
      const wire = await (
        await withHooks(handler("anthropic-sse"), h.engine).handle(context(), payload())
      ).text();
      expect(wire).not.toContain("XXXX");
      expect(stripPings(wire)).toBe(expected);
    });
  }
});

describe("a raw response hook that edits Buffer chunks it read in place", () => {
  // The first hook re-emits the response as Node Buffers, which is what the second
  // hook's recorder then retains. `Buffer#slice` is a view, so a copy taken with it
  // would let the second hook's in-place edit reach the fallback bytes.
  // The editor overwrites EVERY chunk it reads: the first one or more are the keepalive
  // pings "buffers" emits while it holds its replacement, and only later ones are copies
  // of the Buffers the editor's recorder retains.
  const pair = (tail: string) => `
    export default [
      {
        apiVersion: 1, id: "buffers", unsafe: true,
        raw: {
          response(ctx) {
            const toBuffers = new TransformStream({
              transform(chunk, c) { c.enqueue(Buffer.from(chunk)); },
            });
            return new Response(ctx.response.body.pipeThrough(toBuffers), ctx.response);
          },
        },
      },
      {
        apiVersion: 1, id: "editor", unsafe: true,
        raw: {
          async response(ctx) {
            const reader = ctx.response.body.getReader();
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              r.value.fill(0x58);
            }
            ${tail}
          },
        },
      },
    ];`;

  for (const [name, tail] of [
    ["throws", `throw new Error("edited, then failed");`],
    ["returns nothing", "return undefined;"],
  ] as const) {
    it(`${name}: the client receives the original bytes`, async () => {
      const chunks = claudeMessage();
      const expected = await originalWire("anthropic-sse", chunks);
      const h = await loadHook(pair(tail), { "hook:*": "fix" });
      stubUpstream(chunks, { delayMs: 20 });
      const wire = await (
        await withHooks(handler("anthropic-sse"), h.engine).handle(context(), payload())
      ).text();
      expect(wire).not.toContain("XXXX");
      expect(stripPings(wire)).toBe(expected);
    });
  }
});

/* ───────────── a warn replacement built from ctx.response ───────────── */

describe("at warn, a replacement that streams ctx.response is read to the original's end", () => {
  it("the replacement sees every byte of the original, and the client the original", async () => {
    const chunks = claudeMessage();
    const expected = await originalWire("anthropic-sse", chunks);
    g.__cr20bytes = -1;
    const h = await loadHook(
      `export default {
        apiVersion: 1, id: "tee", unsafe: true,
        raw: {
          response(ctx) {
            let n = 0;
            const count = new TransformStream({
              transform(chunk, c) { n += chunk.byteLength; c.enqueue(chunk); },
              flush() { globalThis.__cr20bytes = n; },
            });
            return new Response(ctx.response.body.pipeThrough(count));
          },
        },
      };`,
      { "hook:*": "warn" }
    );
    stubUpstream(chunks, { delayMs: 20 });
    const wire = await (
      await withHooks(handler("anthropic-sse"), h.engine).handle(context(), payload())
    ).text();
    expect(stripPings(wire)).toBe(expected);
    await settle(100);
    // the client got the original whole at warn, so its wire is exactly what the view held
    expect(g.__cr20bytes).toBe(new TextEncoder().encode(wire).byteLength);
  });
});

/* ───────────── response: replacement outcomes ───────────── */

describe("raw response replacements", () => {
  it("a replacement that closes cleanly is what the client receives, and responseEnd sees it", async () => {
    const replacement = claudeMessage("REPLACED");
    g.__x9seen = null;
    const h = await loadHook(`
      const frames = ${JSON.stringify(replacement)};
      export default [
        { apiVersion: 1, id: "swap", unsafe: true,
          raw: { response() { return new Response(frames.join("")); } } },
        { apiVersion: 1, id: "end",
          on: { responseEnd(ctx) { globalThis.__x9seen = ctx.response.text; } } },
      ];`);
    stubUpstream(claudeMessage("original answer"));
    const res = await withHooks(handler("anthropic-sse"), h.engine).handle(context(), payload());
    const wire = await res.text();
    expect(textOf(wire)).toBe("REPLACED");
    expect(stripPings(wire)).toBe(stripPings(replacement.join("")));
    await settle(50);
    expect(g.__x9seen).toBe("REPLACED");
  });

  it("a replacement that errors after its first chunk: the client gets the original, no event: error", async () => {
    const chunks = claudeMessage();
    const expected = await originalWire("anthropic-sse", chunks);
    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "broken", unsafe: true,
        raw: {
          response() {
            let n = 0;
            return new Response(new ReadableStream({
              pull(c) {
                if (n++ === 0) c.enqueue(new TextEncoder().encode("event: ping\\n\\n"));
                else c.error(new Error("replacement broke"));
              },
            }));
          },
        },
      };`);
    stubUpstream(chunks);
    const wire = await (
      await withHooks(handler("anthropic-sse"), h.engine).handle(context(), payload())
    ).text();
    expect(stripPings(wire)).toBe(expected);
    expect(wire).not.toContain("event: error");
    expect(h.journal.some((e) => e.decision === "error" && e.event === "raw")).toBe(true);
  });

  it("at warn a replacement is read and discarded, and the original is forwarded", async () => {
    const chunks = claudeMessage();
    const expected = await originalWire("anthropic-sse", chunks);
    const h = await loadHook(
      `export default {
        apiVersion: 1, id: "warned", unsafe: true,
        raw: { response() { return new Response("event: ping\\n\\n"); } },
      };`,
      { "hook:*": "warn" }
    );
    stubUpstream(chunks);
    const wire = await (
      await withHooks(handler("anthropic-sse"), h.engine).handle(context(), payload())
    ).text();
    expect(stripPings(wire)).toBe(expected);
    await settle();
    expect(h.journal.some((e) => e.decision === "warned" && e.event === "raw")).toBe(true);
  });

  it("stream:false: a replacement JSON message is what the client receives", async () => {
    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "jsonswap", unsafe: true,
        raw: {
          async response(ctx) {
            const message = await ctx.response.json();
            message.content = [{ type: "text", text: "FROM HOOK" }];
            return new Response(JSON.stringify(message), { headers: { "content-type": "application/json" } });
          },
        },
      };`);
    stubUpstream(claudeMessage("original answer"));
    const res = await withHooks(handler("anthropic-sse"), h.engine).handle(
      context(),
      payload(false)
    );
    const message = await res.json();
    expect(message.content).toEqual([{ type: "text", text: "FROM HOOK" }]);
  });
});

/* ───────────── providerRequest ───────────── */

describe("raw providerRequest containment", () => {
  const upstream = () =>
    stubUpstream([
      openAiFrame({ choices: [{ delta: { content: "ok" } }] }),
      openAiFrame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);

  it("a committed edit reaches the transport, after stage B's tool description", async () => {
    const h = await loadHook(`
      export default [
        { apiVersion: 1, id: "desc",
          on: { request: () => [{ type: "rewriteToolDescription", tool: "Read", append: " STAGE-B" }] } },
        { apiVersion: 1, id: "edit", unsafe: true,
          raw: {
            providerRequest(ctx) {
              const fn = ctx.tools.find((t) => (t.function?.name ?? t.name) === "Read");
              globalThis.__sawStageB = (fn.function?.description ?? fn.description).includes("STAGE-B");
              ctx.messages.push({ role: "user", content: "RAW-ADDED" });
            },
          } },
      ];`);
    const { bodies } = upstream();
    await (await withHooks(handler("openai-sse"), h.engine).handle(context(), payload())).text();
    expect(g.__sawStageB).toBe(true);
    expect(JSON.stringify(bodies[0].messages)).toContain("RAW-ADDED");
  });

  it("a hook that empties messages and then throws changes nothing", async () => {
    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "empties", unsafe: true,
        raw: { providerRequest(ctx) { ctx.messages.length = 0; ctx.tools.length = 0; throw new Error("boom"); } },
      };`);
    const { bodies } = upstream();
    await (await withHooks(handler("openai-sse"), h.engine).handle(context(), payload())).text();
    expect(JSON.stringify(bodies[0].messages)).toContain("Say something.");
    expect(bodies[0].tools).toHaveLength(1);
    expect(h.journal.some((e) => e.decision === "error" && e.event === "raw")).toBe(true);
  });

  it("a hook that times out and mutates afterwards changes nothing", async () => {
    const h = await loadHook(`
      export default {
        apiVersion: 1, id: "late", unsafe: true, timeoutMs: 50,
        raw: {
          async providerRequest(ctx) {
            await new Promise((r) => setTimeout(r, 150));
            ctx.messages.push({ role: "user", content: "LATE" });
          },
        },
      };`);
    const { bodies } = upstream();
    await (await withHooks(handler("openai-sse"), h.engine).handle(context(), payload())).text();
    await settle(200);
    expect(JSON.stringify(bodies[0].messages)).not.toContain("LATE");
    expect(h.journal.some((e) => e.decision === "timeout" && e.event === "raw")).toBe(true);
  });

  it("at warn the hook runs on copies that never reach the transport", async () => {
    g.__warnRan = false;
    const h = await loadHook(
      `export default {
        apiVersion: 1, id: "warnreq", unsafe: true,
        raw: { providerRequest(ctx) { globalThis.__warnRan = true; ctx.messages.push({ role: "user", content: "WARN-ONLY" }); } },
      };`,
      { "hook:*": "warn" }
    );
    const { bodies } = upstream();
    await (await withHooks(handler("openai-sse"), h.engine).handle(context(), payload())).text();
    expect(g.__warnRan).toBe(true);
    expect(JSON.stringify(bodies[0].messages)).not.toContain("WARN-ONLY");
    expect(h.journal.some((e) => e.decision === "warned" && e.event === "raw")).toBe(true);
  });
});
