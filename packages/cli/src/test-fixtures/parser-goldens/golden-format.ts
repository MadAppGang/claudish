/**
 * Parser goldens — the format shared by the capture script and every test that
 * replays them.
 *
 * A golden is a snapshot of what the stream parsers emitted BEFORE the hook
 * system replaced their repair plumbing (captured at base 2e4ac246, phase P0).
 * The rewrite moves tool-argument repair out of the parsers and into the
 * response seam; these files are the contract that move must keep. So a golden
 * is self-contained and names no parser API: the provider wire input, the
 * repair rule as data, and the Claude SSE that reached the client.
 *
 * Never re-capture to make a parity test pass. A golden captured from the new
 * code proves the new code equals itself. `capture.ts` refuses to overwrite.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const GOLDENS_DIR = import.meta.dir;

/** The five parsers that carried repair plumbing at the capture base. */
export type GoldenParser =
  | "openai-sse"
  | "openai-responses-sse"
  | "anthropic-sse"
  | "gemini-sse"
  | "devin-connect";

/**
 * The repair rule the parser was armed with, as data.
 *
 * - `none`: no repair plumbing passed at all (the baseline a parser has with no
 *   rule armed).
 * - `replace`: the arguments of `tool` are withheld until the call completes and
 *   replaced by `args`; every other tool passes untouched.
 * - `throws`: `tool` is withheld, and the repair function throws for every call.
 *   The parser must emit the model's own arguments.
 */
export type GoldenRepair =
  | { kind: "none" }
  | { kind: "replace"; tool: string; args: string }
  | { kind: "throws"; tool: string };

/**
 * Provider wire input, one entry per network chunk in arrival order. Text
 * formats are stored as text; Devin's Connect-protobuf frames as base64.
 */
export type GoldenInput =
  | { encoding: "utf8"; chunks: string[] }
  | { encoding: "base64"; chunks: string[] };

/** Claude-format tool schemas the request carried (openai-sse buffers on these). */
export interface GoldenToolSchema {
  name: string;
  input_schema: Record<string, unknown>;
}

export interface ParserGolden {
  kind: "parser";
  id: string;
  /** Which `behavior-repair.test.ts` case (or devin addition) this captures. */
  source: string;
  parser: GoldenParser;
  modelName: string;
  toolSchemas?: GoldenToolSchema[];
  repair: GoldenRepair;
  input: GoldenInput;
  /** The Claude SSE the client received, through `normalizeWire`. */
  output: string;
  /**
   * Set when the captured output carries a defect of the pre-hook code. Such a
   * golden records what shipped, but a rewrite must not reproduce the defect
   * byte for byte. Its parity check compares `dataPayloads()` (the ordered JSON
   * payloads, independent of how `event:` lines frame them) instead of bytes.
   */
  defect?: string;
}

/**
 * A request as the Gemini middleware's `beforeRequest` saw it: the OpenAI-format
 * message list after Claude → OpenAI conversion. Only `messages` is touched by
 * the middleware, so only `messages` is recorded.
 */
export interface GeminiRequestSnapshot {
  before: unknown[];
  after: unknown[];
}

export interface GeminiMiddlewareScenario {
  id: string;
  description: string;
  /** Streams run, in order, through openai-sse with the middleware active. */
  streams: Array<{
    input: GoldenInput;
    /** Client SSE with the middleware active, through `normalizeWire`. */
    output: string;
    /** True when the same stream without the middleware emitted the same bytes. */
    outputUnchangedByMiddleware: boolean;
  }>;
  /** The next request after every stream above, before and after `beforeRequest`. */
  nextRequest: GeminiRequestSnapshot;
}

export interface GeminiMiddlewareGolden {
  kind: "gemini-middleware";
  id: string;
  /** The `modelId` and openai-sse `target` the middleware ran under. */
  modelId: string;
  toolSchemas: GoldenToolSchema[];
  /**
   * `shouldHandle(modelId)` per model id, and the `middleware_names` stats value
   * (`getActiveNames`) a handler for that model reports. The registration gate in
   * `ComposedHandler` uses the same substring rule as `shouldHandle`.
   */
  applicability: Array<{ modelId: string; shouldHandle: boolean; activeNames: string[] }>;
  scenarios: GeminiMiddlewareScenario[];
}

export type Golden = ParserGolden | GeminiMiddlewareGolden;

/** Golden file suffix. One file per golden id. */
export const GOLDEN_SUFFIX = ".golden.json";

export function goldenPath(id: string): string {
  return join(GOLDENS_DIR, `${id}${GOLDEN_SUFFIX}`);
}

export function readGolden(id: string): Golden {
  return JSON.parse(readFileSync(goldenPath(id), "utf8")) as Golden;
}

export function listGoldenIds(): string[] {
  return readdirSync(GOLDENS_DIR)
    .filter((f) => f.endsWith(GOLDEN_SUFFIX))
    .map((f) => f.slice(0, -GOLDEN_SUFFIX.length))
    .sort();
}

export function decodeInput(input: GoldenInput): Uint8Array[] {
  const encoder = new TextEncoder();
  return input.chunks.map((chunk) =>
    input.encoding === "utf8" ? encoder.encode(chunk) : Buffer.from(chunk, "base64")
  );
}

/** A provider response that delivers `input` chunk by chunk, then closes. */
export function inputResponse(input: GoldenInput): Response {
  const chunks = decodeInput(input);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    {
      headers: {
        "content-type":
          input.encoding === "utf8" ? "text/event-stream" : "application/connect+proto",
      },
    }
  );
}

/**
 * Replace the only clock- and random-derived values the parsers emit, so a
 * capture is reproducible:
 *
 * - message ids: `msg_<ms>` and `msg_<ms>_<random>`
 * - synthesized tool ids: `tool_<ms>_<n>`, `toolu_<ms>_<n>`, `tool_repaired_<ms>_<n>`
 *
 * Everything else, keep-alive `ping` events included, is kept byte for byte.
 * The capture script runs every case twice, apart in time, and refuses to write
 * a golden whose two normalized captures differ.
 */
export function normalizeWire(wire: string): string {
  return wire
    .replace(/"msg_\d+(?:_[a-z0-9]+)?"/g, '"msg_<ID>"')
    .replace(/\b(tool_repaired|toolu|tool)_\d{10,}_(\d+)\b/g, "$1_<TS>_$2");
}

const PING_FRAME = 'event: ping\ndata: {"type":"ping"}\n\n';

/** The wire without keep-alive pings, for comparisons where ping timing differs. */
export function stripPings(wire: string): string {
  return wire.replaceAll(PING_FRAME, "");
}

/**
 * Every `data:` payload in wire order, parsed, pings excluded. The comparison
 * for a golden with a `defect`: it holds the content and order of what was
 * sent while ignoring how the frames were delimited.
 */
export function dataPayloads(wire: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6);
    if (raw === "[DONE]") {
      payloads.push("[DONE]");
      continue;
    }
    const parsed = JSON.parse(raw) as { type?: string };
    if (parsed.type !== "ping") payloads.push(parsed);
  }
  return payloads;
}
