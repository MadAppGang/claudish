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
  TOOL_REF: "DEFERRED-TOOL-REF",
  // base64 of "DOCUMENT-MARK"
  DOCUMENT: "RE9DVU1FTlQtTUFSSw==",
  TOOL_ADDITION: "TOOL-ADDITION-MARK",
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
            content: [
              { type: "text", text: M.RESULT_B },
              // What ToolSearch returns: a reference to a deferred tool.
              { type: "tool_reference", tool_name: M.TOOL_REF },
              // What Read returns for a PDF.
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: M.DOCUMENT },
              },
            ],
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: M.ASSIST_SECOND }] },
      {
        role: "system",
        content: [
          { type: "text", text: M.INLINE_MID },
          // A tool definition added mid-session.
          {
            type: "tool_addition",
            tool: {
              definition: {
                name: "DeferredTool",
                description: M.TOOL_ADDITION,
                input_schema: { type: "object", properties: {} },
              },
            },
          },
        ],
      },
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

/** Two calls of the same tool whose results arrive in the other order. */
function outOfOrderRequest(model: string) {
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
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_A", name: "Read", input: { file_path: "/a" } },
          { type: "tool_use", id: "toolu_B", name: "Read", input: { file_path: "/b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_B", content: "CONTENT-OF-B" },
          { type: "tool_result", tool_use_id: "toolu_A", content: "CONTENT-OF-A" },
        ],
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

/** One tool call as the wire carries it, with the result the wire binds to it. */
interface Pair {
  name: string;
  args: unknown;
  result: string;
}
/**
 * Reads every tool call from the body and binds each result to its call: by id
 * where the wire has ids, by position where it has none. A result with no call
 * fails; a call with no result has `result: ""`.
 */
type PairReader = (body: any) => Record<string, Pair>;

const flat = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function bindById(
  calls: { id: string; name: string; args: unknown }[],
  results: { id: string; text: string }[]
): Record<string, Pair> {
  const out: Record<string, Pair> = {};
  for (const c of calls) out[c.id] = { name: c.name, args: c.args, result: "" };
  for (const r of results) {
    expect(out[r.id]).toBeDefined();
    out[r.id].result += r.text;
  }
  return out;
}

const chatPairs: PairReader = (body) =>
  bindById(
    body.messages.flatMap((m: any) =>
      (m.tool_calls ?? []).map((c: any) => ({
        id: c.id,
        name: c.function.name,
        args: JSON.parse(c.function.arguments),
      }))
    ),
    body.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => ({ id: m.tool_call_id, text: flat(m.content) }))
  );

const responsesPairs: PairReader = (body) =>
  bindById(
    body.input
      .filter((i: any) => i.type === "function_call")
      .map((i: any) => ({ id: i.call_id, name: i.name, args: JSON.parse(i.arguments) })),
    body.input
      .filter((i: any) => i.type === "function_call_output")
      .map((i: any) => ({ id: i.call_id, text: flat(i.output) }))
  );

const anthropicPairs: PairReader = (body) => {
  const blocks = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
  return bindById(
    blocks
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => ({ id: b.id, name: b.name, args: b.input })),
    blocks
      .filter((b: any) => b.type === "tool_result")
      .map((b: any) => ({ id: b.tool_use_id, text: flat(b.content) }))
  );
};

const devinPairs: PairReader = (body) =>
  bindById(
    body.messages
      .filter((m: any) => m.toolCall)
      .map((m: any) => ({
        id: m.toolCall.id,
        name: m.toolCall.name,
        args: JSON.parse(m.toolCall.argumentsJson),
      })),
    body.messages
      .filter((m: any) => m.role === "tool_result")
      .map((m: any) => ({ id: m.toolCallId, text: m.text }))
  );

/**
 * Gemini's function responses carry the function NAME, not the call id, and
 * pair by position with the function calls of the model turn directly before
 * them. So every response of a round must sit in that one turn, and the n-th
 * response belongs to the n-th call. Keyed `<turn>:<position>`.
 */
const geminiPairs: PairReader = (body) => {
  const out: Record<string, Pair> = {};
  body.contents.forEach((content: any, turn: number) => {
    const calls = content.parts.filter((p: any) => p.functionCall);
    if (content.role !== "model" || calls.length === 0) return;
    const next = body.contents[turn + 1];
    expect(next?.role).toBe("user");
    const responses = next.parts.filter((p: any) => p.functionResponse);
    expect(responses).toHaveLength(calls.length);
    calls.forEach((call: any, i: number) => {
      expect(responses[i].functionResponse.name).toBe(call.functionCall.name);
      out[`${turn}:${i}`] = {
        name: call.functionCall.name,
        args: call.functionCall.args,
        result: flat(responses[i].functionResponse.response),
      };
    });
  });
  return out;
};

/**
 * Text-only wires write calls and results as text with no id. Calls and
 * results can only pair by order: the n-th `[Tool Call: X]: {args}` with the
 * n-th `[Tool Result]: …`. Keyed by position.
 */
const textPairs: PairReader = (body) => {
  const text = body.messages.map((m: any) => flat(m.content)).join("\n");
  const calls = [...text.matchAll(/\[Tool Call: (\w+)\]: (\{[^\n]*\})/g)];
  // A result runs to the end of its paragraph, never into a later turn.
  const results = body.messages
    .flatMap((m: any) => flat(m.content).split("\n\n"))
    .filter((p: string) => p.startsWith("[Tool Result]: "))
    .map((p: string) => p.slice("[Tool Result]: ".length));
  expect(results).toHaveLength(calls.length);
  const out: Record<string, Pair> = {};
  calls.forEach((call, i) => {
    out[String(i)] = { name: call[1], args: JSON.parse(call[2]), result: results[i] };
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
  expectedPairs: Record<string, Pair>;
  /** Markers this format does not carry, each with the reason. */
  limits: Partial<Record<Piece, string>>;
  /** Text that stands in for a piece the format cannot carry. */
  standIns?: string[];
  /** `true`, or the reason results pair by arrival order on this wire. */
  outOfOrder: true | string;
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

const CALL_A: Pair = { name: "Read", args: { file_path: "/a" }, result: M.RESULT_A };
const CALL_B: Pair = { name: "Grep", args: { pattern: "x" }, result: M.RESULT_B };
const BY_ID = { toolu_A: CALL_A, toolu_B: CALL_B };
// The calls are in `contents[1]`, the second turn.
const BY_GEMINI_TURN = { "1:0": CALL_A, "1:1": CALL_B };
const BY_POSITION = { "0": CALL_A, "1": CALL_B };

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
  outOfOrder: true,
  carriesErrorFlag: false,
  sendsEmptyText: false,
  unknown: CHAT_UNKNOWN,
});

/** Limits of the handler, before any adapter runs. */
const EVERY_FORMAT_LIMITS: Partial<Record<Piece, string>> = {
  TOOL_ADDITION:
    "step 2c moves only the text of an inline system message (inline-system.ts); a tool_addition block is not carried",
};

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
    expectedPairs: BY_POSITION,
    limits: {
      THINKING: NO_THINKING_TEXT,
      IMAGE: "simple mode sends string content only",
    },
    outOfOrder:
      "REPORTED: a [Tool Result] text carries no call id or name, so results pair with calls by order",
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
    expectedPairs: BY_GEMINI_TURN,
    limits: {
      THINKING:
        "Gemini continues its reasoning from the thoughtSignature on each functionCall, not from thought text",
      TOOL_REF:
        "REPORTED: convertUserParts keeps only the text and image items of a tool_result and drops the rest with no log",
      DOCUMENT:
        "REPORTED: convertUserParts keeps only the text and image items of a tool_result and drops the rest with no log",
    },
    outOfOrder: true,
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
    outOfOrder: true,
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
    limits: {
      TOOL_REF:
        "stripUnsupportedContentTypes removes tool_reference on purpose: Anthropic-compatible hosts do not know the block",
    },
    outOfOrder: true,
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
    outOfOrder: true,
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
    expectedPairs: BY_POSITION,
    limits: {
      THINKING: NO_THINKING_TEXT,
      IMAGE:
        "REPORTED: OllamaAPIFormat.processUserMessage skips a top-level image with no note and no log, before the handler's vision check could put one in its place",
      TOOL_DESC_READ: "OllamaAPIFormat.convertTools sends no tool definitions",
      TOOL_DESC_GREP: "OllamaAPIFormat.convertTools sends no tool definitions",
      SCHEMA_DEEP: "OllamaAPIFormat.convertTools sends no tool definitions",
    },
    outOfOrder:
      "REPORTED: a [Tool Result] text carries no call id or name, so results pair with calls by order",
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
          const reason = { ...EVERY_FORMAT_LIMITS, ...format.limits }[piece];
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
        for (const [key, expected] of Object.entries(format.expectedPairs)) {
          expect({ name: pairs[key].name, args: pairs[key].args }).toEqual({
            name: expected.name,
            args: expected.args,
          });
          expect(pairs[key].result).toContain(expected.result);
        }
        // Each result is bound to one call only.
        expect(pairs[Object.keys(format.expectedPairs)[0]].result).not.toContain(M.RESULT_B);
      });

      test(`results that arrive out of call order ${format.outOfOrder === true ? "still reach their own call" : "pair by position (stated limit)"}`, async () => {
        const body = await wireBody(format, outOfOrderRequest(format.model));
        const pairs = Object.values(format.pairs(body));
        // Which content each call got: "A", "B" or "?".
        const got = (path: string) => {
          const result =
            pairs.find((p) => (p.args as { file_path?: string }).file_path === path)?.result ?? "";
          return result.includes("CONTENT-OF-A")
            ? "A"
            : result.includes("CONTENT-OF-B")
              ? "B"
              : "?";
        };
        if (format.outOfOrder === true) {
          expect([got("/a"), got("/b")]).toEqual(["A", "B"]);
        } else {
          // The limit must still be true: the text has no id, so order decides.
          expect([got("/a"), got("/b")]).toEqual(["B", "A"]);
        }
      });

      test("cache_control on the system prompt is on no wire (stated limit)", async () => {
        // transformOpenAIToClaude (step 1) joins a block-form system prompt into
        // one string before any adapter runs, so its cache breakpoint is gone on
        // every route (adapters.md, "keeps the SHAPE of system").
        const body = await wireBody(format, fullRequest(format.model));
        expect(JSON.stringify(body)).not.toContain("cache_control");
      });

      test(`the is_error flag is ${format.carriesErrorFlag ? "kept" : "not on this wire; the result text is"}`, async () => {
        const body = await wireBody(format, fullRequest(format.model));
        expect(JSON.stringify(body).includes('"is_error":true')).toBe(format.carriesErrorFlag);
        expect(JSON.stringify(format.pairs(body))).toContain(M.RESULT_B);
      });

      test(`the empty text block ${format.sendsEmptyText ? "reaches" : "does not reach"} the wire`, async () => {
        const body = await wireBody(format, fullRequest(format.model));
        // An empty text part, or a message whose whole content is empty.
        expect(/"(text|content)":""/.test(JSON.stringify(body))).toBe(format.sendsEmptyText);
      });

      test("a task notification after a tool result follows that result (captured shape)", async () => {
        const body = await wireBody(format, taskNotificationRequest(format.model));
        const conversation = JSON.stringify(format.conversation(body));
        expectInOrder(conversation, ["TASK-USER-ASK", "TASK-READ-RESULT", "TASK-DONE-MARK"]);
        const pairs = Object.values(format.pairs(body));
        expect(pairs).toHaveLength(1);
        expect(pairs[0].name).toBe("Read");
        expect(pairs[0].result).toContain("TASK-READ-RESULT");
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
