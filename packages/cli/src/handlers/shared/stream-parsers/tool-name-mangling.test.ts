import { describe, expect, it } from "bun:test";

import { createStreamingResponseHandler } from "./openai-sse.js";

const ctx: any = {
  body: (stream: any, init: any) => new Response(stream, init),
  json: () => {
    throw new Error("Unexpected no-body error path");
  },
};

const adapter = {
  getToolNameMap: () => new Map([["web_search", "WebSearch"]]),
  processTextContent: (text: string) => ({
    cleanedText: text,
    extractedToolCalls: [],
    wasTransformed: false,
  }),
};

const toolSchemas = [
  {
    name: "Read",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "WebSearch",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

const sseResponse = (frames: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

const dataFrame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

const textFrame = (content: string) =>
  dataFrame({ choices: [{ delta: { content }, finish_reason: null }] });

const finishFrame = (finishReason: "stop" | "tool_calls") =>
  dataFrame({ choices: [{ delta: {}, finish_reason: finishReason }] });

function toolUseStarts(wire: string): any[] {
  const starts: any[] = [];
  for (const frame of wire.split("\n\n")) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine || dataLine === "data: [DONE]") continue;
    try {
      const data = JSON.parse(dataLine.slice(6));
      if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
        starts.push(data.content_block);
      }
    } catch {}
  }
  return starts;
}

async function parseFrames(frames: string[]) {
  const observed: string[] = [];
  const response = createStreamingResponseHandler(
    ctx,
    sseResponse(frames),
    adapter,
    "test-model",
    null,
    undefined,
    toolSchemas,
    adapter.getToolNameMap(),
    undefined,
    { onToolCallObserved: (name) => observed.push(name) }
  );
  const wire = await response.text();

  return { observed, toolUses: toolUseStarts(wire) };
}

describe("openai-sse tool-name recovery", () => {
  it("does not dispatch malformed function-tag prose", async () => {
    const malformed =
      '<function=web_search_query_listOpposed["macos security add-generic-password -X hex password flag"]>';
    const result = await parseFrames([
      textFrame(malformed),
      finishFrame("stop"),
      "data: [DONE]\n\n",
    ]);

    expect(result.toolUses).toEqual([]);
    expect(result.observed).toEqual([]);
  });

  it("does not recover a second call from prose when a structured call exists", async () => {
    const result = await parseFrames([
      textFrame("I will use <function=web_search> for this."),
      dataFrame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_web_search_0",
                  type: "function",
                  function: { name: "web_search", arguments: '{"query":"x"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      finishFrame("tool_calls"),
      "data: [DONE]\n\n",
    ]);

    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe("WebSearch");
    expect(result.observed).toEqual(["WebSearch"]);
  });

  it("recovers an advertised Read call and rejects an unadvertised text call", async () => {
    const recovered = await parseFrames([
      textFrame("<function=Read><parameter=file_path>/x"),
      finishFrame("stop"),
      "data: [DONE]\n\n",
    ]);

    expect(recovered.toolUses).toHaveLength(1);
    expect(recovered.toolUses[0].name).toBe("Read");
    expect(recovered.observed).toEqual(["Read"]);

    const unadvertised = await parseFrames([
      textFrame("<function=Unadvertised><parameter=value>x"),
      finishFrame("stop"),
      "data: [DONE]\n\n",
    ]);
    expect(unadvertised.toolUses).toEqual([]);
    expect(unadvertised.observed).toEqual([]);
  });
});
