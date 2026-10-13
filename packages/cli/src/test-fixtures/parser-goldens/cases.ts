/**
 * The cases captured into the parser goldens.
 *
 * Every case of `handlers/shared/stream-parsers/behavior-repair.test.ts`, with
 * its exact input frames and repair rule, plus the Devin parser (which carried
 * the same plumbing but had no repair test) and the Gemini thought-signature
 * middleware. Only `capture.ts` and the drift check in `parser-goldens.test.ts`
 * read this file; replays read the self-contained golden files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bytes, envelope, msg } from "../../providers/devin/proto-codec.js";
import type { GoldenInput, GoldenRepair, GoldenToolSchema, ParserGolden } from "./golden-format.js";

// ── Constants copied from behavior-repair.test.ts ────────────────────────────
export const TARGET_TOOL = "target_tool";
export const UNTARGETED_TOOL = "untargeted_tool";
export const ORIGINAL_VALUE = "model-original";
export const REPAIRED_VALUE = "behavior-repaired";
export const ORIGINAL_ARGS = JSON.stringify({ value: ORIGINAL_VALUE });
export const REPAIRED_ARGS = JSON.stringify({ value: REPAIRED_VALUE });

const MODEL = "test-model";

const REPLACE: GoldenRepair = { kind: "replace", tool: TARGET_TOOL, args: REPAIRED_ARGS };
const THROWS: GoldenRepair = { kind: "throws", tool: TARGET_TOOL };
const NONE: GoldenRepair = { kind: "none" };

const toolSchemas: GoldenToolSchema[] = [TARGET_TOOL, UNTARGETED_TOOL].map((name) => ({
  name,
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
}));

const dataFrame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const anthropicFrame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const utf8 = (chunks: string[]): GoldenInput => ({ encoding: "utf8", chunks });

function openAiToolFrames(name: string, args = ORIGINAL_ARGS): GoldenInput {
  return utf8([
    dataFrame({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_openai_0",
                type: "function",
                function: { name, arguments: args },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    dataFrame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);
}

function responsesToolFrames(name: string, fragments = [ORIGINAL_ARGS]): GoldenInput {
  const item = {
    type: "function_call",
    id: "fc_responses_item_0",
    call_id: "responses_call_0",
    name,
  };
  return utf8([
    dataFrame({ type: "response.output_item.added", item }),
    ...fragments.map((delta) =>
      dataFrame({
        type: "response.function_call_arguments.delta",
        call_id: item.call_id,
        item_id: item.id,
        delta,
      })
    ),
    dataFrame({ type: "response.output_item.done", item }),
    dataFrame({
      type: "response.completed",
      response: { usage: { input_tokens: 5, output_tokens: 3 } },
    }),
  ]);
}

function anthropicToolFrames(name: string, fragments = [ORIGINAL_ARGS]): GoldenInput {
  return utf8([
    anthropicFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_anthropic_0", name, input: {} },
    }),
    ...fragments.map((partial_json) =>
      anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json },
      })
    ),
    anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
  ]);
}

function geminiToolFrames(name: string): GoldenInput {
  return utf8([
    dataFrame({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name, args: { value: ORIGINAL_VALUE } } }],
          },
          finishReason: "STOP",
        },
      ],
    }),
  ]);
}

/**
 * Devin Connect frames: a tool-call header (`6 → 1` id, `6 → 2` name), then one
 * frame per argument fragment (`6 → 3`), then the `{}` end-of-stream frame.
 */
function devinToolFrames(name: string, fragments: string[]): GoldenInput {
  const frames = [
    envelope(bytes(6, msg(bytes(1, "call_devin_0"), bytes(2, name)))),
    ...fragments.map((fragment) => envelope(bytes(6, msg(bytes(3, fragment))))),
    envelope(new TextEncoder().encode("{}"), 2),
  ];
  return { encoding: "base64", chunks: frames.map((f) => Buffer.from(f).toString("base64")) };
}

type ParserCase = Omit<ParserGolden, "kind" | "output">;

const ANTHROPIC_BYTE_FRAGMENTS = ['{"value":"byte-', 'identical"}'];
const FRAGMENTED_ORIGINAL = ['{"value":"model-', 'original"}'];
const INCREMENTAL_FRAGMENTS = ['{"value":"incremental-', 'delivery"}'];

export const PARSER_CASES: ParserCase[] = [
  // ── openai-sse ──
  {
    id: "openai-sse.targeted-repaired",
    source: "openai-sse behavior repair > rewrites arguments for a targeted tool",
    parser: "openai-sse",
    modelName: MODEL,
    toolSchemas,
    repair: REPLACE,
    input: openAiToolFrames(TARGET_TOOL),
  },
  {
    id: "openai-sse.untargeted-unchanged",
    source: "openai-sse behavior repair > passes an untargeted tool through unchanged",
    parser: "openai-sse",
    modelName: MODEL,
    toolSchemas,
    repair: REPLACE,
    input: openAiToolFrames(UNTARGETED_TOOL),
  },
  {
    id: "openai-sse.repair-throws",
    source: "openai-sse behavior repair > emits the model arguments when a repair rule throws",
    parser: "openai-sse",
    modelName: MODEL,
    toolSchemas,
    repair: THROWS,
    input: openAiToolFrames(TARGET_TOOL),
  },
  // ── openai-responses-sse ──
  {
    id: "openai-responses-sse.targeted-repaired",
    source: "openai-responses-sse behavior repair > rewrites arguments for a targeted tool",
    parser: "openai-responses-sse",
    modelName: MODEL,
    repair: REPLACE,
    input: responsesToolFrames(TARGET_TOOL),
  },
  {
    id: "openai-responses-sse.untargeted-unchanged",
    source: "openai-responses-sse behavior repair > passes an untargeted tool through unchanged",
    parser: "openai-responses-sse",
    modelName: MODEL,
    repair: REPLACE,
    input: responsesToolFrames(UNTARGETED_TOOL),
  },
  {
    id: "openai-responses-sse.untargeted-incremental",
    source:
      "openai-responses-sse behavior repair > keeps untargeted argument fragments incremental",
    parser: "openai-responses-sse",
    modelName: MODEL,
    repair: REPLACE,
    input: responsesToolFrames(UNTARGETED_TOOL, INCREMENTAL_FRAGMENTS),
  },
  // ── anthropic-sse ──
  {
    id: "anthropic-sse.targeted-fragmented-repaired",
    source:
      "anthropic-sse behavior repair > reassembles fragmented targeted arguments, repairs them, and emits one delta",
    parser: "anthropic-sse",
    modelName: MODEL,
    repair: REPLACE,
    input: anthropicToolFrames(TARGET_TOOL, FRAGMENTED_ORIGINAL),
    defect:
      "createToolRepairInterceptor's flush() returns `<content_block_delta frame>` + the stop frame's `data:` line, " +
      "but enqueueData() has already written the held `event: content_block_stop` line before it. The wire reads " +
      "`event: content_block_stop\\nevent: content_block_delta\\ndata: <delta>\\n\\ndata: <stop>\\n\\n`: per the SSE " +
      "spec the delta is dispatched (last `event:` wins) and the stop payload arrives as an UNNAMED event, which a " +
      "client dispatching on event names drops, leaving the tool_use block unclosed. Compare dataPayloads(), not bytes.",
  },
  {
    id: "anthropic-sse.untargeted-unchanged",
    source: "anthropic-sse behavior repair > passes an untargeted tool through unchanged",
    parser: "anthropic-sse",
    modelName: MODEL,
    repair: REPLACE,
    input: anthropicToolFrames(UNTARGETED_TOOL),
  },
  {
    id: "anthropic-sse.byte-identical.baseline",
    source:
      "anthropic-sse behavior repair > is byte-identical for an untargeted tool after generated pings are stripped (baseline, no rule)",
    parser: "anthropic-sse",
    modelName: MODEL,
    repair: NONE,
    input: anthropicToolFrames(UNTARGETED_TOOL, ANTHROPIC_BYTE_FRAGMENTS),
  },
  {
    id: "anthropic-sse.byte-identical.armed",
    source:
      "anthropic-sse behavior repair > is byte-identical for an untargeted tool after generated pings are stripped (rule armed)",
    parser: "anthropic-sse",
    modelName: MODEL,
    repair: REPLACE,
    input: anthropicToolFrames(UNTARGETED_TOOL, ANTHROPIC_BYTE_FRAGMENTS),
  },
  // ── gemini-sse ──
  {
    id: "gemini-sse.targeted-repaired",
    source: "gemini-sse behavior repair > rewrites arguments for a targeted tool",
    parser: "gemini-sse",
    modelName: MODEL,
    repair: REPLACE,
    input: geminiToolFrames(TARGET_TOOL),
  },
  {
    id: "gemini-sse.untargeted-unchanged",
    source: "gemini-sse behavior repair > passes an untargeted tool through unchanged",
    parser: "gemini-sse",
    modelName: MODEL,
    repair: REPLACE,
    input: geminiToolFrames(UNTARGETED_TOOL),
  },
  // ── devin-connect (no repair test existed; same rule, same three outcomes) ──
  {
    id: "devin-connect.targeted-fragmented-repaired",
    source: "devin addition: fragmented targeted arguments are withheld, repaired, one delta",
    parser: "devin-connect",
    modelName: MODEL,
    repair: REPLACE,
    input: devinToolFrames(TARGET_TOOL, FRAGMENTED_ORIGINAL),
  },
  {
    id: "devin-connect.untargeted-incremental",
    source: "devin addition: an untargeted tool streams its fragments unchanged",
    parser: "devin-connect",
    modelName: MODEL,
    repair: REPLACE,
    input: devinToolFrames(UNTARGETED_TOOL, INCREMENTAL_FRAGMENTS),
  },
  {
    id: "devin-connect.repair-throws",
    source: "devin addition: the model arguments are emitted when the repair rule throws",
    parser: "devin-connect",
    modelName: MODEL,
    repair: THROWS,
    input: devinToolFrames(TARGET_TOOL, FRAGMENTED_ORIGINAL),
  },
];

// ── Gemini thought-signature middleware ──────────────────────────────────────

export const GEMINI_GOLDEN_ID = "gemini-thought-signature.openai-sse";
export const GEMINI_MODEL = "google/gemini-3.1-pro-preview";

/** Model ids whose applicability is recorded; the gate is a substring rule. */
export const GEMINI_APPLICABILITY_MODELS = [
  "google/gemini-3.1-pro-preview",
  "gemini-2.5-flash",
  "google/gemma-3-27b-it",
  "gpt-5.6-sol",
  "claude-opus-5",
];

export const GEMINI_TOOL_SCHEMAS: GoldenToolSchema[] = [
  {
    name: "Read",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
];

/** Shape of an OpenRouter Gemini chunk, as in the `gemini-3.1-pro-or-*` captures. */
function geminiChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return dataFrame({
    id: "gen-golden",
    object: "chat.completion.chunk",
    model: GEMINI_MODEL,
    provider: "Google",
    choices: [{ index: 0, delta, finish_reason: finishReason, native_finish_reason: null }],
  });
}

const reasoningText = (signature: string, index: number) => ({
  type: "reasoning.text",
  text: "",
  signature,
  format: "google-gemini-v1",
  index,
});

/**
 * One turn: text, reasoning_details split across two chunks, one Read call
 * whose arguments arrive in two fragments, then `tool_calls` and usage.
 */
function geminiToolTurn(callId: string, signatures: [string, string], path: string): GoldenInput {
  return utf8([
    geminiChunk({ role: "assistant", content: "Reading it." }),
    geminiChunk({
      role: "assistant",
      content: "",
      reasoning_details: [reasoningText(signatures[0], 0)],
    }),
    geminiChunk({
      role: "assistant",
      content: "",
      reasoning_details: [reasoningText(signatures[1], 1)],
      tool_calls: [
        { index: 0, id: callId, type: "function", function: { name: "Read", arguments: "" } },
      ],
    }),
    geminiChunk({
      role: "assistant",
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: path }) } }],
    }),
    dataFrame({
      id: "gen-golden",
      object: "chat.completion.chunk",
      model: GEMINI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
    }),
    "data: [DONE]\n\n",
  ]);
}

/** A recorded OpenRouter Gemini stream, split into its SSE events. */
function recordedFixture(file: string): GoldenInput {
  const text = readFileSync(join(import.meta.dir, "..", "sse-responses", file), "utf8");
  const events = text.split(/(?<=\n\n)/).filter((e) => e.length > 0);
  return utf8(events);
}

/** The follow-up request, in the OpenAI message format `beforeRequest` receives. */
function followUpMessages(callIds: string[]): unknown[] {
  const messages: unknown[] = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Read the file." },
  ];
  for (const id of callIds) {
    messages.push(
      {
        role: "assistant",
        content: "Reading it.",
        tool_calls: [
          {
            id,
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ file_path: `/tmp/${id}` }) },
          },
        ],
      },
      { role: "tool", tool_call_id: id, content: `contents of ${id}` }
    );
  }
  messages.push({ role: "user", content: "Thanks." });
  return messages;
}

export interface GeminiScenarioCase {
  id: string;
  description: string;
  streams: GoldenInput[];
  nextRequestMessages: unknown[];
}

export const GEMINI_SCENARIOS: GeminiScenarioCase[] = [
  {
    id: "tool-call-with-reasoning",
    description:
      "reasoning_details accumulated across two chunks are cached against the turn's tool_call id and injected into the matching assistant message of the next request; an assistant tool call with no cached id is left alone",
    streams: [geminiToolTurn("call_gem_a", ["SIG-A-0", "SIG-A-1"], "/tmp/a")],
    nextRequestMessages: followUpMessages(["call_gem_a", "call_unknown"]),
  },
  {
    id: "two-turns",
    description:
      "two streams cache two entries; each assistant message receives the reasoning_details of its own turn only",
    streams: [
      geminiToolTurn("call_gem_a", ["SIG-A-0", "SIG-A-1"], "/tmp/a"),
      geminiToolTurn("call_gem_b", ["SIG-B-0", "SIG-B-1"], "/tmp/b"),
    ],
    nextRequestMessages: followUpMessages(["call_gem_a", "call_gem_b"]),
  },
  {
    id: "reasoning-without-tool-call",
    description:
      "a recorded OpenRouter Gemini stream with reasoning_details and no tool call caches nothing; the next request is unchanged",
    streams: [recordedFixture("gemini-3.1-pro-or-maxtokens-truncated.sse")],
    nextRequestMessages: followUpMessages(["call_gem_a"]),
  },
  {
    id: "no-prior-stream",
    description: "with an empty cache, beforeRequest leaves the request unchanged",
    streams: [],
    nextRequestMessages: followUpMessages(["call_gem_a"]),
  },
];
