import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { sseResponseToJson } from "../handlers/shared/collect-sse-message.js";
import {
  createResponsesStreamHandler,
  createSyntheticToolUseReply,
} from "../handlers/shared/stream-parsers/openai-responses-sse.js";
import type { StallClock } from "../handlers/shared/stream-parsers/responses/stall-guard.js";
import { HookEngine } from "../hooks/engine.js";
import { UnavailableSink } from "../hooks/injection/sinks.js";
import { type HookDefinition, act } from "../hooks/public.js";
import { HookRegistry } from "../hooks/registry.js";
import { RequestHooks } from "../hooks/request-stage.js";
import { applyResponseSeam } from "../hooks/response-seam.js";
import { accountKeyFromBinding, sessionKeyFor } from "./ids.js";
import { createCodeModeTurnHooks } from "./relay.js";
import { loadQuickJSModule, resetQuickJSLoaderForTests } from "./sandbox/quickjs-loader.js";
import { ScriptStore } from "./script-store.js";
import type { CodeModeStores } from "./stores.js";
import { ToolNameTable } from "./tool-names.js";
import { TurnRecords } from "./turn-records.js";
import type { CodeModeTurnHooks, ResponsesItem } from "./types.js";

const turn1 = readFileSync(
  new URL("../test-fixtures/sse-responses/codex-exec-turn1.sse", import.meta.url),
  "utf8"
);
const turn2 = readFileSync(
  new URL("../test-fixtures/sse-responses/codex-exec-turn2.sse", import.meta.url),
  "utf8"
);
const classic = readFileSync(
  new URL(
    "../test-fixtures/sse-responses/gpt-5.6-sol-responses-toolsonly-turn1.sse",
    import.meta.url
  ),
  "utf8"
);
const roundtrip = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/code-mode/roundtrip-parts.request.json", import.meta.url),
    "utf8"
  )
);
const storesToClear: CodeModeStores[] = [];
const session = "55555555-5555-4555-8555-555555555555";
const binding = { auth: { arm: "oauth" as const, headers: { "chatgpt-account-id": "t4-relay" } } };
const accountKey = accountKeyFromBinding(binding)!;
const keys = { accountKey, sessionKey: sessionKeyFor(session, accountKey)! };
const modelName = "capture-model";

type Event = {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string; input?: Record<string, unknown> };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: { input_tokens: number; output_tokens: number } };
  usage?: { input_tokens: number; output_tokens: number };
  error?: { type: string; message: string };
};
function frames(wire: string): string[] {
  return wire.split(/\r?\n\r?\n/).filter((block) => block.includes("data: "));
}
function data(frame: string): Record<string, unknown> {
  const line = frame.split(/\r?\n/).find((l) => l.startsWith("data: "))!;
  return JSON.parse(line.slice(6));
}
function wire(frames: string[]): string {
  return frames.join("\n\n") + "\n\n";
}
const execFrames = frames(turn1);
const execStart = execFrames.findIndex((f) => {
  const e = data(f);
  return (
    e.type === "response.output_item.added" &&
    (e.item as { type?: string })?.type === "custom_tool_call"
  );
});
const midExec = wire(execFrames.slice(0, execStart + 4));
function clock(): StallClock {
  const pending = new Set<() => void>();
  return {
    now: () => 1000,
    setTimeout: (fn) => {
      pending.add(fn);
      return fn;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as () => void);
    },
  };
}
function upstream(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
async function stream(
  response: Response,
  codeMode: CodeModeTurnHooks,
  extra: Partial<Parameters<typeof createResponsesStreamHandler>[2]> = {}
) {
  const app = new Hono();
  app.get("/", (c) =>
    createResponsesStreamHandler(c, response, {
      modelName,
      codeMode,
      retry: {
        stall: { thresholdMs: 0 },
        stallClock: clock(),
        issueLeg: async () => {
          throw new Error("Unexpected upstream continuation in a blocking-exec test");
        },
      },
      ...extra,
    })
  );
  const result = await app.fetch(new Request("http://t4.invalid/"));
  return frames(await result.text()).map((f) => data(f) as unknown as Event);
}
function toolUses(events: Event[]) {
  const uses = new Map<number, { id: string; name: string; json: string }>();
  for (const e of events) {
    if (e.type === "content_block_start" && e.content_block?.type === "tool_use")
      uses.set(e.index!, { id: e.content_block.id!, name: e.content_block.name!, json: "" });
    if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
      const use = uses.get(e.index!);
      if (use) use.json += e.delta.partial_json ?? "";
    }
  }
  return [...uses.values()].map(({ id, name, json }) => ({
    id,
    name,
    input: JSON.parse(json || "{}"),
  }));
}
async function hooks() {
  const stores = { scripts: new ScriptStore({ now: () => 1000 }), turns: new TurnRecords() };
  storesToClear.push(stores);
  const module = await loadQuickJSModule();
  expect(module).toBeDefined();
  return createCodeModeTurnHooks({
    stores,
    ...keys,
    shape: () => "classic",
    names: new ToolNameTable(["exec_command"]),
    allTools: [],
    defaultMaxOutputTokens: 10000,
    previousMessage: undefined,
    loadModule: async () => module,
    limits: { cpuMs: 100 },
  });
}
afterEach(() => {
  for (const s of storesToClear.splice(0)) {
    s.scripts.clear();
    s.turns.clear();
  }
  resetQuickJSLoaderForTests();
});

describe("T4 code-mode relay through the public Responses handler", () => {
  test("REQ-21 TEST-25 relays the real exec as exactly two nested tool_use blocks, never exec", async () => {
    const events = await stream(upstream(turn1), await hooks());
    expect(toolUses(events)).toEqual([
      {
        id: "toolu_cx_c0d07fd9ccd84fe29372c0e72ed12869_0",
        name: "exec_command",
        input: { cmd: "cat README.md; wc -l README.md", max_output_tokens: 3000 },
      },
      {
        id: "toolu_cx_c0d07fd9ccd84fe29372c0e72ed12869_1",
        name: "exec_command",
        input: { cmd: "cat notes.txt; wc -l notes.txt", max_output_tokens: 3000 },
      },
    ]);
    expect(events.filter((e) => e.type === "message_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message_stop")).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.find((e) => e.type === "message_delta")?.delta?.stop_reason).toBe("tool_use");
    expect(events.find((e) => e.type === "message_delta")?.usage).toMatchObject({
      input_tokens: 30678,
      output_tokens: 134,
    });
  }, 20000);

  test("REQ-21 the captured answer turn keeps text and finishes without inventing tools", async () => {
    const events = await stream(upstream(turn2), await hooks());
    expect(toolUses(events)).toEqual([]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.find((e) => e.type === "message_delta")?.delta?.stop_reason).toBe("end_turn");
    expect(
      events.some(
        (e) => e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text
      )
    ).toBe(true);
  }, 20000);

  test.each(["body end", "socket error"])(
    "REQ-22 TEST-26 emits SSE error when %s cuts the real exec input",
    async (how) => {
      // Derived solely by cutting codex-exec-turn1.sse after real input deltas.
      const bytes = new TextEncoder().encode(midExec);
      let sent = false;
      const body =
        how === "body end"
          ? midExec
          : new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!sent) {
                  sent = true;
                  controller.enqueue(bytes);
                } else controller.error(new Error("injected socket drop"));
              },
            });
      const events = await stream(upstream(body), await hooks());
      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(toolUses(events)).toEqual([]);
      expect(
        events.some((e) => e.type === "message_delta" && e.delta?.stop_reason === "tool_use")
      ).toBe(false);
    },
    20000
  );

  test("REQ-23 TEST-27 refuses a tool_use finish over a cut-off classic block beside a blocking exec", async () => {
    // Derived event sequence: untouched added+delta frames for the first classic
    // call in gpt-5.6-sol-responses-toolsonly-turn1.sse, followed by untouched
    // exec and terminal frames of codex-exec-turn1.sse. Omit classic done frames
    // to model a cut-off block; do not fabricate protocol events.
    const ordinary = frames(classic);
    const start = ordinary.findIndex((f) => {
      const e = data(f);
      return (
        e.type === "response.output_item.added" &&
        (e.item as { type?: string })?.type === "function_call"
      );
    });
    const heldExec = execFrames.filter((f) => {
      const e = data(f);
      return (
        e.type === "response.completed" ||
        String(e.type).includes("custom_tool_call_input") ||
        (e.item as { type?: string })?.type === "custom_tool_call"
      );
    });
    const mixed = wire([...ordinary.slice(0, start + 2), ...heldExec]);
    const events = await stream(upstream(mixed), await hooks());
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(
      events.some((e) => e.type === "message_delta" && e.delta?.stop_reason === "tool_use")
    ).toBe(false);
  }, 20000);

  test("REQ-24 TEST-28 records an exec output even when a complete classic call shares its leg", async () => {
    // Derived from the first COMPLETE classic call's verbatim frames and real
    // exec frames. The public runtime seam supplies the accepted G roundtrip's
    // verbatim exec call/output pair to model an interstitial completed exec.
    const ordinary = frames(classic);
    const start = ordinary.findIndex((f) => {
      const e = data(f);
      return (
        e.type === "response.output_item.added" &&
        (e.item as { type?: string })?.type === "function_call"
      );
    });
    const end = ordinary.findIndex(
      (f, i) => i > start && data(f).type === "response.output_item.done"
    );
    const heldExec = execFrames.filter((f) => {
      const e = data(f);
      return (
        e.type === "response.completed" ||
        String(e.type).includes("custom_tool_call_input") ||
        (e.item as { type?: string })?.type === "custom_tool_call"
      );
    });
    const appendItems: ResponsesItem[] = roundtrip.body.input.slice(-2);
    let recorded: ResponsesItem[] = [];
    const codeMode: CodeModeTurnHooks = {
      onExecCall: () => ({ kind: "continue", appendItems: structuredClone(appendItems) }),
      onTurnEnd: (record) => {
        recorded = record.items;
      },
      onTurnAbandoned: () => {},
    };
    const events = await stream(
      upstream(wire([...ordinary.slice(0, end + 1), ...heldExec])),
      codeMode
    );
    expect(toolUses(events)).toEqual([
      { id: expect.any(String), name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(events.find((e) => e.type === "message_delta")?.delta?.stop_reason).toBe("tool_use");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(
      recorded.filter((i) => i.type === "custom_tool_call" || i.type === "custom_tool_call_output")
    ).toEqual(appendItems);
  }, 20000);

  test("REQ-26 TEST-32 synthetic replies share repair, prior usage and the JSON exit", async () => {
    // Tool-argument repair runs at the hook response seam (`withHooks` wraps the
    // handler's Response, a 5r synthetic reply included), so the reply goes
    // through the seam exactly as a driver batch does.
    const def = {
      apiVersion: 1,
      id: "repair-read",
      on: {
        toolCall: {
          tools: ["Read"],
          handle: (ctx) => [act.repairToolArgs({ ...ctx.tool.args, repaired: true }, "test")],
        },
      },
    } satisfies HookDefinition;
    const engine = new HookEngine({
      registry: new HookRegistry(
        [],
        [{ id: "hook:t/repair", module: "/t.ts", moduleIndex: 0, exportIndex: 0, def }],
        undefined
      ),
      config: {},
      hostMode: "other",
      journalSink: () => {},
      warn: () => {},
      drainTelemetryOutbox: false,
    });
    const vars = new Map<string, unknown>();
    const context = {
      get: (k: string) => vars.get(k),
      set: (k: string, v: unknown) => vars.set(k, v),
    };
    const scope = await new RequestHooks(engine, null, new UnavailableSink(() => {})).beginAttempt(
      context as never,
      {
        claudeRequest: { messages: [{ role: "user", content: "read" }] },
        route: { modelId: modelName, provider: "openai-codex", native: false },
        model: modelName,
        stream: true,
      }
    );
    const sse = await applyResponseSeam(
      createSyntheticToolUseReply(
        [
          {
            id: "toolu_cx_0123456789abcdef0123456789abcdef_1",
            name: "Read",
            input: { file_path: "f1" },
          },
        ],
        { modelName, priorInputTokens: 1234 }
      ),
      scope
    );
    const json = await sseResponseToJson(sse, modelName);
    expect(json.status).toBe(200);
    const body = await json.json();
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      model: modelName,
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_cx_0123456789abcdef0123456789abcdef_1",
          name: "Read",
          input: { file_path: "f1", repaired: true },
        },
      ],
      usage: { input_tokens: 1234, output_tokens: 0 },
    });
  }, 20000);
});
