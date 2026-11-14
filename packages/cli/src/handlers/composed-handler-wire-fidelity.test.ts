// Nothing Claude Code sends is dropped silently on the way to the wire.
//
// One request that holds every kind of piece Claude Code really sends goes
// through `ComposedHandler.handle` once per wire format, and the test reads the
// body claudish puts on the wire. Each piece carries its own marker string.
// For every format: each marker the format can carry is in the body, in
// conversation order, and every tool call keeps its own result. A marker the
// format cannot carry is listed in that format's `limits` with the reason; a
// marker that is missing and not listed fails the test, and so does a listed
// limit that stops being true.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Context } from "hono";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import type { BaseAPIFormat } from "../adapters/base-api-format.js";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { DevinAPIFormat } from "../adapters/devin-api-format.js";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import { LiteLLMAPIFormat } from "../adapters/litellm-api-format.js";
import { LocalModelAdapter } from "../adapters/local-adapter.js";
import { OllamaAPIFormat } from "../adapters/ollama-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { OpenRouterAPIFormat } from "../adapters/openrouter-api-format.js";
import * as logger from "../logger.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const WIRE_URL = "http://wire.test/v1";
// base64 of "IMAGE-MARK"; the marker is the encoded data itself.
const IMAGE_DATA = "SU1BR0UtTUFSSw==";

const M = {
  SYS_A: "SYS-BLOCK-A",
  SYS_B: "SYS-BLOCK-B",
  TOOL_DESC_READ: "TOOL-DESC-READ",
  TOOL_DESC_GREP: "TOOL-DESC-GREP",
  SCHEMA_DEEP: "SCHEMA-DEEP-MARK",
  USER_FIRST: "USER-FIRST",
  IMAGE: IMAGE_DATA,
  THINKING: "THINKING-MARK",
  ASSIST_TEXT: "ASSIST-BEFORE-TOOLS",
  RESULT_A: "RESULT-A",
  NOTIFY: "NOTIFY-BETWEEN-RESULTS",
  RESULT_B: "RESULT-B-ERROR",
  ASSIST_SECOND: "ASSIST-SECOND",
  INLINE_MID: "INLINE-SYSTEM-MID",
  USER_LAST: "USER-LAST",
} as const;
type Piece = keyof typeof M;

/**
 * The order the conversation markers must have inside the conversation part of
 * the body. The notification arrives between the two results, but step 2c
 * holds text that arrives inside an open tool round until the round's last
 * result (`inline-system.ts`), so on the wire it follows RESULT_B.
 */
const WIRE_ORDER: Piece[] = [
  "USER_FIRST",
  "ASSIST_TEXT",
  "RESULT_A",
  "RESULT_B",
  "NOTIFY",
  "ASSIST_SECOND",
  "INLINE_MID",
  "USER_LAST",
];

/** Everything Claude Code sends, one piece each, in its own shape. */
function fullRequest(model: string, extraBeforeLast: unknown[] = []) {
  return {
    model,
    max_tokens: 64,
    system: [
      { type: "text", text: M.SYS_A },
      { type: "text", text: M.SYS_B, cache_control: { type: "ephemeral" } },
    ],
    tools: [
      {
        name: "Read",
        description: M.TOOL_DESC_READ,
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            opts: {
              type: "object",
              properties: {
                ranges: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { deep: { type: "string", description: M.SCHEMA_DEEP } },
                  },
                },
              },
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "Grep",
        description: M.TOOL_DESC_GREP,
        input_schema: { type: "object", properties: { pattern: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: M.USER_FIRST },
          { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: M.THINKING, signature: "sig" },
          { type: "text", text: M.ASSIST_TEXT },
          { type: "text", text: "" },
          { type: "tool_use", id: "toolu_A", name: "Read", input: { file_path: "/a" } },
          { type: "tool_use", id: "toolu_B", name: "Grep", input: { pattern: "x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_A", content: M.RESULT_A }],
      },
      { role: "system", content: M.NOTIFY },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_B",
            is_error: true,
            content: [{ type: "text", text: M.RESULT_B }],
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: M.ASSIST_SECOND }] },
      { role: "system", content: [{ type: "text", text: M.INLINE_MID }] },
      ...extraBeforeLast,
      { role: "user", content: M.USER_LAST },
    ],
  };
}

/**
 * The shape of a captured Claude Code request (a 15-hour session over `ag@`):
 * one Read call, its string result, then a background-task notification as a
 * `role: "system"` message, which is the last message of that request. The
 * text here is synthetic.
 */
function taskNotificationRequest(model: string) {
  return {
    model,
    max_tokens: 64,
    system: "BASE-SYSTEM",
    tools: [
      {
        name: "Read",
        description: "Reads a file.",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } },
      },
    ],
    messages: [
      { role: "user", content: "TASK-USER-ASK" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_R", name: "Read", input: { file_path: "/f" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_R", content: "TASK-READ-RESULT" }],
      },
      {
        role: "system",
        content:
          "<task-notification>\nBackground task TASK-DONE-MARK completed with exit code 0.\n</task-notification>",
      },
    ],
  };
}

function makeContext(): Context {
  return {
    req: { header: () => ({}) },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context;
}

function transportNamed(name: string): ProviderTransport {
  return {
    name,
    displayName: name,
    streamFormat: "openai-sse",
    getEndpoint: () => WIRE_URL,
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

/**
 * Sends one request and returns the parsed body sent to the wire endpoint. A
 * non-vision route first calls the vision proxy; only the call to the
 * transport's endpoint is the wire body.
 */
async function wireBody(format: Format, request: unknown): Promise<any> {
  const sent: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ error: { message: "stop" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const adapter = format.adapter?.();
  const handler = new ComposedHandler(
    transportNamed(format.provider),
    format.model,
    format.model,
    8080,
    adapter ? { adapter } : {}
  );
  await handler.handle(makeContext(), request);
  const wire = sent.filter((s) => s.url === WIRE_URL);
  expect(wire.length).toBeGreaterThan(0);
  return JSON.parse(wire[0].body);
}

/** Tool call key (id, or name where the wire has no id) → the result text it got. */
type PairReader = (body: any) => Record<string, string>;

const flat = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

const chatPairs: PairReader = (body) => {
  const callIds = new Set(
    body.messages.flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.id))
  );
  const out: Record<string, string> = {};
  for (const m of body.messages) {
    if (m.role !== "tool") continue;
    expect(callIds.has(m.tool_call_id)).toBe(true);
    out[m.tool_call_id] = flat(m.content);
  }
  return out;
};

const responsesPairs: PairReader = (body) => {
  const callIds = new Set(
    body.input.filter((i: any) => i.type === "function_call").map((i: any) => i.call_id)
  );
  const out: Record<string, string> = {};
  for (const item of body.input) {
    if (item.type !== "function_call_output") continue;
    expect(callIds.has(item.call_id)).toBe(true);
    out[item.call_id] = flat(item.output);
  }
  return out;
};

/**
 * Gemini's function responses carry the function NAME, not the call id, and
 * pair with the function calls of the model turn directly before them. So the
 * reader also requires every response of a round to sit in that one turn.
 */
const geminiPairs: PairReader = (body) => {
  const out: Record<string, string> = {};
  body.contents.forEach((content: any, i: number) => {
    const calls = content.parts.filter((p: any) => p.functionCall);
    if (content.role !== "model" || calls.length === 0) return;
    const next = body.contents[i + 1];
    const responses = next.parts.filter((p: any) => p.functionResponse);
    expect(next.role).toBe("user");
    expect(responses.map((p: any) => p.functionResponse.name)).toEqual(
      calls.map((p: any) => p.functionCall.name)
    );
    for (const p of responses) out[p.functionResponse.name] = flat(p.functionResponse.response);
  });
  return out;
};

const anthropicPairs: PairReader = (body) => {
  const out: Record<string, string> = {};
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === "tool_result") out[b.tool_use_id] = flat(b.content);
  }
  return out;
};

const devinPairs: PairReader = (body) => {
  const callIds = new Set(
    body.messages.filter((m: any) => m.toolCall).map((m: any) => m.toolCall.id)
  );
  const out: Record<string, string> = {};
  for (const m of body.messages) {
    if (m.role !== "tool_result") continue;
    expect(callIds.has(m.toolCallId)).toBe(true);
    out[m.toolCallId] = m.text;
  }
  return out;
};

/**
 * Text-only wires write calls and results as text with no id. Calls and
 * results can only pair by order: each `[Tool Call: X]` in the order the calls
 * were made, each `[Tool Result]: …` in the same order.
 */
const textPairs: PairReader = (body) => {
  const text = body.messages.map((m: any) => flat(m.content)).join("\n");
  const calls = [...text.matchAll(/\[Tool Call: (\w+)\]/g)].map((m) => m[1]);
  const results = text.split("[Tool Result]: ").slice(1);
  expect(results.length).toBe(calls.length);
  const out: Record<string, string> = {};
  calls.forEach((name, i) => {
    out[name] = results[i];
  });
  return out;
};

/** What a format does with a role or block type it was never written for. */
type UnknownOutcome = "on-wire" | "dropped-silently" | "dropped-with-log";

interface Format {
  label: string;
  provider: string;
  model: string;
  adapter?: () => BaseAPIFormat;
  /** The conversation part of the body: where the order is checked. */
  conversation: (body: any) => unknown;
  pairs: PairReader;
  /** The result each call must get, keyed as `pairs` keys it. */
  expectedPairs: Record<string, string>;
  /** Markers this format does not carry, each with the reason. */
  limits: Partial<Record<Piece, string>>;
  /** Text that stands in for a piece the format cannot carry. */
  standIns?: string[];
  /** Whether the error flag of an `is_error` tool result is on the wire. */
  carriesErrorFlag: boolean;
  /** Whether the empty text block reaches the wire as an empty text part. */
  sendsEmptyText: boolean;
  unknown: {
    developerRole: UnknownOutcome;
    userBlock: UnknownOutcome;
    assistantBlock: UnknownOutcome;
  };
}

const BY_ID = { toolu_A: M.RESULT_A, toolu_B: M.RESULT_B };
const BY_NAME = { Read: M.RESULT_A, Grep: M.RESULT_B };

// Every Chat Completions converter shares `convertMessagesToOpenAI`.
const CHAT_UNKNOWN = {
  developerRole: "dropped-silently",
  userBlock: "dropped-silently",
  assistantBlock: "dropped-silently",
} as const;

const chat = (
  label: string,
  provider: string,
  model: string,
  adapter?: () => BaseAPIFormat
): Format => ({
  label,
  provider,
  model,
  adapter,
  conversation: (b) => b.messages.slice(1),
  pairs: chatPairs,
  expectedPairs: BY_ID,
  limits: {},
  carriesErrorFlag: false,
  sendsEmptyText: false,
  unknown: CHAT_UNKNOWN,
});

const NO_THINKING_TEXT =
  "a thinking block is the model's own earlier reasoning; this wire takes none back as text";
const NO_IMAGES = "the route takes no image input";

/** The adapters are those the provider profiles, the wire handler and the handler set build. */
const FORMATS: Format[] = [
  chat("Chat Completions (no adapter: DefaultAPIFormat)", "sakana", "fugu-ultra"),
  chat("Chat Completions (OpenAIAPIFormat)", "openai", "gpt-6", () => new OpenAIAPIFormat("gpt-6")),
  chat(
    "OpenRouter (OpenRouterAPIFormat)",
    "openrouter",
    "vendor/model",
    () => new OpenRouterAPIFormat("vendor/model", { vendor: "" })
  ),
  chat(
    "LiteLLM (LiteLLMAPIFormat)",
    "litellm",
    "model",
    () => new LiteLLMAPIFormat("model", "http://wire.test")
  ),
  chat(
    "local (LocalModelAdapter)",
    "ollama",
    "llama4",
    () => new LocalModelAdapter("llama4", "ollama")
  ),
  {
    label: "local, simple mode (LocalModelAdapter on mlx)",
    provider: "mlx",
    model: "llama4",
    adapter: () => new LocalModelAdapter("llama4", "mlx"),
    conversation: (b) => b.messages.slice(1),
    pairs: textPairs,
    expectedPairs: BY_NAME,
    limits: {
      THINKING: NO_THINKING_TEXT,
      IMAGE: "simple mode sends string content only",
    },
    carriesErrorFlag: false,
    sendsEmptyText: false,
    unknown: CHAT_UNKNOWN,
  },
  {
    label: "Gemini (GeminiAPIFormat)",
    provider: "gemini",
    model: "gemini-4-carbon",
    adapter: () => new GeminiAPIFormat("gemini-4-carbon"),
    conversation: (b) => b.contents,
    pairs: geminiPairs,
    expectedPairs: BY_NAME,
    limits: {
      THINKING:
        "Gemini continues its reasoning from the thoughtSignature on each functionCall, not from thought text",
    },
    carriesErrorFlag: false,
    sendsEmptyText: true,
    unknown: {
      developerRole: "dropped-silently",
      userBlock: "dropped-silently",
      assistantBlock: "dropped-silently",
    },
  },
  {
    label: "Responses (CodexAPIFormat)",
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    adapter: () => new CodexAPIFormat("gpt-6.1-sol"),
    conversation: (b) => b.input,
    pairs: responsesPairs,
    expectedPairs: BY_ID,
    limits: {
      THINKING:
        "Responses replays the encrypted reasoning items it cached (reasoning-cache.ts), not thinking text",
    },
    carriesErrorFlag: false,
    sendsEmptyText: false,
    unknown: CHAT_UNKNOWN,
  },
  {
    label: "Anthropic-shaped (AnthropicAPIFormat)",
    provider: "kimi-coding",
    model: "kimi-k3",
    adapter: () => new AnthropicAPIFormat("kimi-k3"),
    conversation: (b) => b.messages,
    pairs: anthropicPairs,
    expectedPairs: BY_ID,
    limits: {},
    carriesErrorFlag: true,
    sendsEmptyText: true,
    unknown: { developerRole: "on-wire", userBlock: "on-wire", assistantBlock: "on-wire" },
  },
  {
    label: "Devin (DevinAPIFormat)",
    provider: "devin",
    model: "swe-1.7",
    adapter: () => new DevinAPIFormat("swe-1.7"),
    // The first message is the relocated system prompt.
    conversation: (b) => b.messages.slice(1),
    pairs: devinPairs,
    expectedPairs: BY_ID,
    limits: {
      THINKING: NO_THINKING_TEXT,
      IMAGE: `${NO_IMAGES} (DevinAPIFormat.supportsVision); the handler puts a note in its place`,
      TOOL_DESC_READ:
        "the backend rejects Claude Code's Read description; claudish's own text replaces it (providers/devin/tool-descriptions.ts)",
    },
    standIns: ["[image omitted: this model does not accept image input]"],
    carriesErrorFlag: false,
    sendsEmptyText: false,
    unknown: CHAT_UNKNOWN,
  },
  {
    label: "Ollama Cloud (OllamaAPIFormat)",
    provider: "ollama-cloud",
    model: "llama4",
    adapter: () => new OllamaAPIFormat("llama4"),
    conversation: (b) => b.messages.slice(1),
    pairs: textPairs,
    expectedPairs: BY_NAME,
    limits: {
      THINKING: NO_THINKING_TEXT,
      IMAGE: `${NO_IMAGES} (OllamaAPIFormat.supportsVision)`,
      TOOL_DESC_READ: "OllamaAPIFormat.convertTools sends no tool definitions",
      TOOL_DESC_GREP: "OllamaAPIFormat.convertTools sends no tool definitions",
      SCHEMA_DEEP: "OllamaAPIFormat.convertTools sends no tool definitions",
    },
    carriesErrorFlag: false,
    sendsEmptyText: false,
    unknown: {
      developerRole: "dropped-silently",
      userBlock: "dropped-silently",
      assistantBlock: "dropped-silently",
    },
  },
];

function expectInOrder(haystack: string, markers: string[]) {
  let at = -1;
  for (const marker of markers) {
    const next = haystack.indexOf(marker, at + 1);
    if (next <= at) throw new Error(`"${marker}" is not after the marker before it`);
    at = next;
  }
}

describe("every piece Claude Code sends reaches the wire, or a stated limit says why not", () => {
  for (const format of FORMATS) {
    describe(format.label, () => {
      test("every marker the format can carry is in the body, in conversation order", async () => {
        const body = await wireBody(format, fullRequest(format.model));
        const text = JSON.stringify(body);
        for (const piece of Object.keys(M) as Piece[]) {
          const reason = format.limits[piece];
          // A stated limit must still be true: a fix that starts carrying the
          // piece updates this table, so nobody widens it by accident.
          expect({ piece, onWire: text.includes(M[piece]), reason }).toEqual({
            piece,
            onWire: reason === undefined,
            reason,
          });
        }
        for (const standIn of format.standIns ?? []) expect(text).toContain(standIn);
        const conversation = JSON.stringify(format.conversation(body));
        expectInOrder(
          conversation,
          WIRE_ORDER.map((p) => M[p])
        );
      });

      test("every tool call keeps its own result", async () => {
        const body = await wireBody(format, fullRequest(format.model));
        const pairs = format.pairs(body);
        expect(Object.keys(pairs).sort()).toEqual(Object.keys(format.expectedPairs).sort());
        for (const [call, result] of Object.entries(format.expectedPairs)) {
          expect(pairs[call]).toContain(result);
        }
      });

      test(`the is_error flag is ${format.carriesErrorFlag ? "kept" : "not on this wire; the result text is"}`, async () => {
        const body = await wireBody(format, fullRequest(format.model));
        expect(JSON.stringify(body).includes('"is_error":true')).toBe(format.carriesErrorFlag);
        expect(JSON.stringify(format.pairs(body))).toContain(M.RESULT_B);
      });

      test(`the empty text block ${format.sendsEmptyText ? "reaches" : "does not reach"} the wire`, async () => {
        const body = await wireBody(format, fullRequest(format.model));
        expect(/"text":""/.test(JSON.stringify(body))).toBe(format.sendsEmptyText);
      });

      test("a task notification after a tool result follows that result (captured shape)", async () => {
        const body = await wireBody(format, taskNotificationRequest(format.model));
        const conversation = JSON.stringify(format.conversation(body));
        expectInOrder(conversation, ["TASK-USER-ASK", "TASK-READ-RESULT", "TASK-DONE-MARK"]);
        const pairs = format.pairs(body);
        expect(Object.values(pairs).join("")).toContain("TASK-READ-RESULT");
        expect(Object.keys(pairs)).toHaveLength(1);
      });

      test("an unknown role and an unknown block type: on the wire, or dropped with or without a log", async () => {
        const logged = spyOn(logger, "log");
        try {
          const body = await wireBody(
            format,
            fullRequest(format.model, [
              { role: "developer", content: "DEVELOPER-ROLE-MARK" },
              {
                role: "user",
                content: [
                  { type: "something_new", text: "NEW-USER-BLOCK-MARK" },
                  { type: "text", text: "TEXT-AFTER-NEW-USER-BLOCK" },
                ],
              },
              {
                role: "assistant",
                content: [
                  { type: "something_new", text: "NEW-ASSISTANT-BLOCK-MARK" },
                  { type: "text", text: "TEXT-AFTER-NEW-ASSISTANT-BLOCK" },
                ],
              },
            ])
          );
          const text = JSON.stringify(body);
          const lines = logged.mock.calls.map((call) => String(call[0]));
          const outcome = (marker: string, name: string): UnknownOutcome => {
            if (text.includes(marker)) return "on-wire";
            return lines.some((l) => l.includes(name)) ? "dropped-with-log" : "dropped-silently";
          };
          // The known text beside each unknown piece always arrives.
          expect(text).toContain("TEXT-AFTER-NEW-USER-BLOCK");
          expect(text).toContain("TEXT-AFTER-NEW-ASSISTANT-BLOCK");
          expect({
            developerRole: outcome("DEVELOPER-ROLE-MARK", "developer"),
            userBlock: outcome("NEW-USER-BLOCK-MARK", "something_new"),
            assistantBlock: outcome("NEW-ASSISTANT-BLOCK-MARK", "something_new"),
          }).toEqual(format.unknown);
        } finally {
          logged.mockRestore();
        }
      });
    });
  }
});
