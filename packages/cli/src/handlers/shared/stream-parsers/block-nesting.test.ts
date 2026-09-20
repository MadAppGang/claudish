/**
 * The one-open-content-block invariant, asserted over every REAL OpenAI
 * chat-completions capture in the tree.
 *
 * Anthropic's streaming wire allows exactly one open content block at a time.
 * `openai-sse.ts` used to spell that rule by hand at every emit site; it now
 * runs through `block-writer.ts`. This file is the gate on the rule itself
 * rather than on any one site: a `content_block_start` while another block is
 * open, or a block left open at `message_stop`, fails here regardless of which
 * path emitted it.
 *
 * Captures are DISCOVERED, not listed — any `.sse` fixture carrying a
 * `"choices"` key is an OpenAI chat-completions capture and is replayed. A new
 * capture is therefore covered the moment it lands, which is the point: the
 * sites this invariant protects are not all reachable from today's captures.
 *
 * Every fixture here came from a real provider response via
 * `test-fixtures/extract-sse-from-log.ts`. Nothing in this file is hand-written
 * SSE. (S4-b ccca029, adapted to this fork's 11-argument handler signature.)
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultAPIFormat } from "../../../adapters/base-api-format.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test-fixtures",
  "sse-responses"
);

/**
 * Tool schemas turn the parser's BUFFERED path on, which is a different set of
 * emit sites from the streaming one. Both are exercised for every capture.
 */
const TOOL_SCHEMAS = [
  {
    name: "Read",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "Bash",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function openAiCaptures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".sse"))
    .filter((f) => readFileSync(join(FIXTURES_DIR, f), "utf-8").includes('"choices"'))
    .sort();
}

function fixtureToResponse(path: string): Response {
  const bytes = new TextEncoder().encode(readFileSync(path, "utf-8"));
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function mockContext(): any {
  return {
    req: {},
    body(stream: ReadableStream, init?: any) {
      return new Response(stream, init);
    },
  };
}

async function replay(fixture: string, toolSchemas?: any[]): Promise<any[]> {
  const response = createStreamingResponseHandler(
    mockContext(),
    fixtureToResponse(join(FIXTURES_DIR, fixture)),
    new DefaultAPIFormat("test-model") as any,
    "test-model",
    null,
    undefined,
    toolSchemas,
    undefined,
    undefined,
    undefined,
    undefined
  );

  const events: any[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      let dataStr = "";
      for (const line of part.split("\n").filter((l) => l.trim())) {
        if (line.startsWith("data: ")) dataStr += line.slice(6);
      }
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        events.push(JSON.parse(dataStr));
      } catch {}
    }
  }
  return events;
}

/**
 * Walk the event stream and return every violation as a readable string, so a
 * failure names WHICH rule broke and where rather than just a count.
 */
function nestingViolations(events: any[]): string[] {
  const problems: string[] = [];
  let open: number | null = null;
  const stopped = new Set<number>();
  const started = new Set<number>();

  events.forEach((d, i) => {
    if (d?.type === "content_block_start") {
      if (open !== null) {
        problems.push(
          `event ${i}: content_block_start index=${d.index} while index=${open} is still open`
        );
      }
      if (started.has(d.index)) {
        problems.push(`event ${i}: index=${d.index} started twice`);
      }
      started.add(d.index);
      open = d.index;
    } else if (d?.type === "content_block_delta") {
      if (open !== d.index) {
        problems.push(
          `event ${i}: content_block_delta index=${d.index} but the open block is ${open ?? "none"}`
        );
      }
    } else if (d?.type === "content_block_stop") {
      if (open !== d.index) {
        problems.push(
          `event ${i}: content_block_stop index=${d.index} but the open block is ${open ?? "none"}`
        );
      }
      if (stopped.has(d.index)) {
        problems.push(`event ${i}: index=${d.index} stopped twice`);
      }
      stopped.add(d.index);
      open = null;
    } else if (d?.type === "message_stop" && open !== null) {
      problems.push(`event ${i}: message_stop with index=${open} still open`);
    }
  });

  if (open !== null) problems.push(`stream ended with index=${open} still open`);
  return problems;
}

describe("openai-sse: exactly one content block open at a time", () => {
  const captures = openAiCaptures();

  test("the capture set is non-empty (a silent zero here would pass every case below)", () => {
    expect(captures.length).toBeGreaterThan(0);
  });

  for (const fixture of captures) {
    for (const mode of ["no schemas (streaming path)", "schemas (buffered path)"] as const) {
      test(`${fixture} — ${mode}`, async () => {
        const events = await replay(
          fixture,
          mode === "schemas (buffered path)" ? TOOL_SCHEMAS : undefined
        );
        expect(nestingViolations(events)).toEqual([]);
      });
    }
  }
});
