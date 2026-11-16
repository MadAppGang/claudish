import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setConfigFileOverride } from "../config-override.js";
import { HookEngine } from "../hooks/engine.js";
import {
  type HookDefinition,
  type RouteInfo,
  type Severity,
  act,
  defineHook,
} from "../hooks/public.js";
import { HookRegistry, type UserHookInput } from "../hooks/registry.js";
import { withHooks } from "../hooks/response-seam.js";
import { NativeHandler } from "./native-handler.js";

let dir: string;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-native-toolcall-"));
  const file = join(dir, "config.json");
  writeFileSync(file, "{}");
  setConfigFileOverride(file);
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  setConfigFileOverride(null);
  rmSync(dir, { recursive: true, force: true });
});

const MODEL = "claude-opus-4-8";

function userHook(def: HookDefinition, index: number): UserHookInput {
  return {
    id: `hook:context-tools/${def.id}`,
    module: join(dir, "context-tools.ts"),
    moduleIndex: 0,
    exportIndex: index,
    def,
  };
}

function engineWith(definitions: HookDefinition[]): HookEngine {
  return new HookEngine({
    registry: new HookRegistry([], definitions.map(userHook), undefined),
    config: {},
    hostMode: "other",
    journalSink: () => {},
    warn: () => {},
    drainTelemetryOutbox: false,
  });
}

interface SseEvent {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    input?: unknown;
    text?: string;
  };
  delta?: {
    type?: string;
    partial_json?: string;
    text?: string;
    stop_reason?: string;
  };
}

function frame(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function upstreamSse(): string {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_native_test",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Checking status." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_bash_test", name: "Bash", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"command":"git ' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: 'status"}' },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ]
    .map(frame)
    .join("");
}

function stubUpstream(fragmented: boolean): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  // Replace fetch completely: no provider request or credential ever leaves this process.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: unknown,
    init?: RequestInit
  ) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const bytes = new TextEncoder().encode(upstreamSse());
    const width = fragmented ? 7 : bytes.length;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += width) {
          controller.enqueue(bytes.slice(offset, offset + width));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch);
  return bodies;
}

function parseEvents(raw: string): SseEvent[] {
  return raw.split(/\r?\n\r?\n/).flatMap((part) => {
    const data = part
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data) as SseEvent];
  });
}

function toolCalls(events: SseEvent[]): Array<{ id: string; name: string; input: unknown }> {
  const calls = new Map<number, { id: string; name: string; input: unknown; json: string }>();
  for (const event of events) {
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      if (event.index === undefined || !event.content_block.id || !event.content_block.name) {
        throw new Error("Tool start is missing its index, id or name");
      }
      if (calls.has(event.index)) throw new Error("Duplicate tool start index");
      calls.set(event.index, {
        id: event.content_block.id,
        name: event.content_block.name,
        input: event.content_block.input,
        json: "",
      });
    }
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      const call = event.index === undefined ? undefined : calls.get(event.index);
      if (!call) throw new Error("Tool argument delta arrived without a tool start");
      call.json += event.delta.partial_json ?? "";
    }
  }
  return [...calls.values()].map(({ id, name, input, json }) => ({
    id,
    name,
    input: json ? JSON.parse(json) : input,
  }));
}

function responseText(events: SseEvent[]): string {
  return events
    .map((event) => {
      if (event.type === "content_block_start" && event.content_block?.type === "text") {
        return event.content_block.text ?? "";
      }
      return event.delta?.type === "text_delta" ? (event.delta.text ?? "") : "";
    })
    .join("");
}

describe("native streamed Bash tool-call hooks", () => {
  for (const routes of ["all", "foreign"] as const) {
    for (const fragmented of [false, true]) {
      const req = routes === "all" ? "REQ-6" : "REQ-7";
      const outcome = routes === "all" ? "repairs" : "leaves unchanged";
      const chunking = fragmented ? "fragmented SSE" : "single-chunk SSE";
      test(`${req}: routes=${routes} ${outcome} native Bash arguments in ${chunking}`, async () => {
        const requestRoutes: RouteInfo[] = [];
        const calls: Array<{ route: RouteInfo; severity: Severity; args: unknown }> = [];
        const observeRoute = defineHook({
          apiVersion: 1,
          id: "observe-route",
          routes: "all",
          on: {
            request(ctx) {
              requestRoutes.push(ctx.route);
            },
          },
        });
        const rewriteBash = defineHook({
          apiVersion: 1,
          id: "rewrite-bash",
          routes,
          // Omission exercises the public default severity, fix.
          on: {
            toolCall: {
              tools: ["Bash"],
              handle(ctx) {
                calls.push({
                  route: ctx.route,
                  severity: ctx.severity,
                  args: { ...ctx.tool.args },
                });
                return [act.repairToolArgs({ ...ctx.tool.args, command: "rtk git status" }, "r")];
              },
            },
          },
        });
        const outgoing = stubUpstream(fragmented);
        const handler = withHooks(
          new NativeHandler("test-only-native-key"),
          engineWith([observeRoute, rewriteBash])
        );
        const app = new Hono();
        app.post("/v1/messages", async (context) =>
          handler.handle(context, await context.req.json())
        );

        try {
          const response = await app.request("http://127.0.0.1/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": "test-only-inbound-key",
            },
            body: JSON.stringify({
              model: MODEL,
              stream: true,
              max_tokens: 64,
              messages: [{ role: "user", content: "Check the working tree." }],
              tools: [
                {
                  name: "Bash",
                  description: "Run a shell command.",
                  input_schema: {
                    type: "object",
                    properties: { command: { type: "string" } },
                    required: ["command"],
                  },
                },
              ],
            }),
          });
          const events = parseEvents(await response.text());

          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain("text/event-stream");
          expect(outgoing).toHaveLength(1);
          expect(outgoing[0].stream).toBe(true);
          expect(requestRoutes).toEqual([{ modelId: MODEL, provider: "anthropic", native: true }]);
          expect(toolCalls(events)).toEqual([
            {
              id: "toolu_bash_test",
              name: "Bash",
              input: { command: routes === "all" ? "rtk git status" : "git status" },
            },
          ]);
          expect(responseText(events)).toBe("Checking status.");
          expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1);
          expect(events.find((event) => event.type === "message_delta")?.delta?.stop_reason).toBe(
            "tool_use"
          );
          if (routes === "all") {
            expect(calls).toEqual([
              {
                route: { modelId: MODEL, provider: "anthropic", native: true },
                severity: "fix",
                args: { command: "git status" },
              },
            ]);
          } else {
            expect(calls).toEqual([]);
          }
        } finally {
          await handler.shutdown();
        }
      });
    }
  }
});
