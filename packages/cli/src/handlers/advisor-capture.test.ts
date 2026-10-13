import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenRouterAPIFormat } from "../adapters/openrouter-api-format.js";
import {
  _debug_getTrackedAdvisorIds,
  _debug_resetTrackedAdvisorIds,
  createAdvisorStreamScanner,
} from "./native-handler-advisor.js";
import { createStreamingResponseHandler } from "./shared/stream-parsers/openai-sse.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-fixtures",
  "sse-responses"
);
const advisorFixture = "grok-4.6-openai-advisor-turn1.sse";
const noAdvisorFixture = "gemini-3.1-pro-or-maxtokens-truncated.sse";
const cfg = { enabled: true, logPath: undefined };
type StreamingHandlerContext = Parameters<typeof createStreamingResponseHandler>[0];

interface ClaudeEvent {
  event: string;
  data: {
    type?: unknown;
    content_block?: {
      type?: unknown;
      name?: unknown;
      id?: unknown;
    };
  };
}

function fixtureToResponse(name: string): Response {
  const bytes = readFileSync(join(fixturesDir, name));
  return new Response(new Blob([bytes]).stream(), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function createMockContext(): StreamingHandlerContext {
  const context = {
    body(stream: ReadableStream, init?: ResponseInit) {
      return new Response(stream, init);
    },
  };
  return context as unknown as StreamingHandlerContext;
}

function parsedResponse(name: string): Response {
  return createStreamingResponseHandler(
    createMockContext(),
    fixtureToResponse(name),
    new OpenRouterAPIFormat("x-ai/grok-4.6", { vendor: "x-ai" }),
    "x-ai/grok-4.6",
    null,
    undefined,
    undefined
  );
}

function parseClaudeEvents(sse: string): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  for (const frame of sse.split("\n\n")) {
    let event = "";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    const dataText = dataLines.join("\n");
    if (!dataText || dataText === "[DONE]") continue;
    events.push({ event, data: JSON.parse(dataText) });
  }
  return events;
}

function advisorIdProducedByParser(sse: string): string {
  const ids = parseClaudeEvents(sse)
    .filter(
      (event) =>
        event.data?.type === "content_block_start" &&
        event.data?.content_block?.type === "tool_use" &&
        event.data?.content_block?.name === "advisor"
    )
    .map((event) => event.data.content_block?.id)
    .filter((id): id is string => typeof id === "string");

  expect(ids).toHaveLength(1);
  return ids[0];
}

async function readParsedSse(name: string, onChunk?: (chunk: string) => void): Promise<string> {
  const reader = parsedResponse(name).body!.getReader();
  const decoder = new TextDecoder();
  let sse = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    sse += chunk;
    onChunk?.(chunk);
  }

  const tail = decoder.decode();
  sse += tail;
  if (tail) onChunk?.(tail);
  return sse;
}

function pushFixedChunks(sse: string, size: number, sessionId: string): void {
  const scanner = createAdvisorStreamScanner(cfg, sessionId);
  for (let offset = 0; offset < sse.length; offset += size) {
    scanner.push(sse.slice(offset, offset + size));
  }
}

afterEach(() => {
  _debug_resetTrackedAdvisorIds();
});

describe("advisor capture from parsed OpenAI SSE", () => {
  it("records the parser-produced non-Anthropic advisor tool-use id", async () => {
    const sessionId = "advisor-capture-parser-stream-001";
    const scanner = createAdvisorStreamScanner(cfg, sessionId);
    const parsedSse = await readParsedSse(advisorFixture, (chunk) => scanner.push(chunk));
    const parserProducedId = advisorIdProducedByParser(parsedSse);

    expect(parserProducedId).toMatch(
      /^call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/i
    );
    expect(parserProducedId.startsWith("toolu_")).toBe(false);
    expect(_debug_getTrackedAdvisorIds(sessionId)).toEqual([parserProducedId]);
  });

  it.each([
    [16, "advisor-capture-split-16-002"],
    [64, "advisor-capture-split-64-003"],
  ])(
    "records the same id when parser output is split into %i-byte chunks",
    async (size, sessionId) => {
      const parsedSse = await readParsedSse(advisorFixture);
      const parserProducedId = advisorIdProducedByParser(parsedSse);

      pushFixedChunks(parsedSse, size, sessionId);

      expect(_debug_getTrackedAdvisorIds(sessionId)).toEqual([parserProducedId]);
    }
  );

  it("records the same id when a chunk boundary lands on a newline inside an SSE event", async () => {
    const sessionId = "advisor-capture-split-newline-004";
    const parsedSse = await readParsedSse(advisorFixture);
    const parserProducedId = advisorIdProducedByParser(parsedSse);
    const splitAt = parsedSse.indexOf("\n") + 1;
    const scanner = createAdvisorStreamScanner(cfg, sessionId);

    expect(splitAt).toBeGreaterThan(1);
    expect(parsedSse[splitAt]).not.toBe("\n");
    scanner.push(parsedSse.slice(0, splitAt));
    scanner.push(parsedSse.slice(splitAt));

    expect(_debug_getTrackedAdvisorIds(sessionId)).toEqual([parserProducedId]);
  });

  it("records nothing for a real fixture without an advisor tool call", async () => {
    const sessionId = "advisor-capture-no-advisor-005";
    const scanner = createAdvisorStreamScanner(cfg, sessionId);

    await readParsedSse(noAdvisorFixture, (chunk) => scanner.push(chunk));

    expect(_debug_getTrackedAdvisorIds(sessionId)).toEqual([]);
  });
});
