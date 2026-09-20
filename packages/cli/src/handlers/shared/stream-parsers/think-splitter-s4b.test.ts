/**
 * S4-b lot C — `<think>…</think>` in content becomes a thinking block
 * (d4cba87, item 3).
 *
 * Upstream shipped this untested on its positive path (no capture in the tree
 * contains a `<think>` tag, and the caller ruled real captures only). Our
 * harness mandate is stricter — tests first, non-vacuity cited — so the
 * splitter's positive path is covered at UNIT level (it is a pure function;
 * no `.sse` fixture is invented) and at parser level with constructed frames,
 * the repo's established convention (tool-name-mangling, tool-recovery-trust).
 *
 * The two deliberate narrowings are pinned:
 *  1. open tag at position 0 only — a `<think>` mid-text is a model writing
 *     ABOUT tags and must survive verbatim;
 *  2. open tag disarmed once real `reasoning_content` arrived — but the CLOSE
 *     tag stays armed, for providers whose chat template opens `<think>`
 *     server-side and leaks the bare `</think>` into content.
 *
 * Non-vacuity: written before the implementation.
 */

import { describe, expect, test } from "bun:test";
import { createThinkTagSplitter } from "./think-tag-splitter.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

/** Push the whole input in the given chunk sizes and collect the reassembly. */
function splitAll(input: string, chunkSize: number) {
  const s = createThinkTagSplitter();
  let thinking = "";
  let text = "";
  for (let i = 0; i < input.length; i += chunkSize) {
    const r = s.push(input.slice(i, i + chunkSize));
    thinking += r.thinking;
    text += r.text;
  }
  const f = s.flush();
  thinking += f.thinking;
  text += f.text;
  return { thinking, text };
}

describe("S4-b lot C: think-tag splitter unit (d4cba87)", () => {
  test("a leading <think> block routes its content to thinking, the rest to text", () => {
    const r = splitAll("<think>plan the answer</think>The answer is 4.", 1000);
    expect(r.thinking).toBe("plan the answer");
    expect(r.text).toBe("The answer is 4.");
  });

  test("every chunk-boundary split of the same stream reassembles identically (tags never torn)", () => {
    const input = "<think>reason here</think>visible answer";
    for (let n = 1; n <= input.length; n++) {
      const r = splitAll(input, n);
      expect(`${r.thinking}|${r.text}`).toBe("reason here|visible answer");
    }
  });

  test("a partial close tag held at a chunk boundary is released, never dropped", () => {
    const s = createThinkTagSplitter();
    const a = s.push("<think>reasoning</thi");
    const b = s.push("nk>after");
    const f = s.flush();
    expect(a.thinking + b.thinking + f.thinking).toBe("reasoning");
    expect(a.text + b.text + f.text).toBe("after");
  });

  test("narrowing 1: <think> anywhere but position 0 is ordinary text", () => {
    const r = splitAll("Here is how to use <think> tags in XML: <think>not reasoning</think>", 1000);
    expect(r.thinking).toBe("");
    expect(r.text).toBe("Here is how to use <think> tags in XML: <think>not reasoning</think>");
  });

  test("narrowing 2: real reasoning on its own field disarms the open tag", () => {
    const s = createThinkTagSplitter();
    s.disarmOpen();
    const r = s.push("<think>this is me writing about tags</think>answer");
    expect(r.thinking).toBe("");
    expect(r.text).toBe("<think>this is me writing about tags</think>answer");
  });

  test("narrowing 2, the other arm: the orphan close stays armed after disarm", () => {
    const s = createThinkTagSplitter();
    s.disarmOpen();
    const r = s.push("</think>the actual answer");
    expect(r.text).toBe("the actual answer"); // the leaked close is REMOVED
  });

  test("an orphan close at position 0 (server-side opened tag) is removed", () => {
    const r = splitAll("</think>answer text", 1000);
    expect(r.thinking).toBe("");
    expect(r.text).toBe("answer text");
  });

  test("an unterminated <think> runs to the end of the turn as thinking (flush)", () => {
    const s = createThinkTagSplitter();
    const a = s.push("<think>never closed");
    expect(a.thinking).toBe("never closed");
    expect(a.text).toBe("");
    const f = s.flush();
    expect(f.thinking).toBe("");
    expect(f.text).toBe("");
  });

  test("a tag-less stream is the identity function (control)", () => {
    const r = splitAll("just a normal answer", 3);
    expect(r.thinking).toBe("");
    expect(r.text).toBe("just a normal answer");
  });

  test("an undecided partial prefix at the very end is released as text by flush", () => {
    const s = createThinkTagSplitter();
    const a = s.push("<thi"); // could still be <think>
    expect(a.text).toBe("");
    const f = s.flush();
    expect(f.text).toBe("<thi");
  });
});

// ─── Parser-level: constructed frames ────────────────────────────────────────

const SSE_HEADERS: Record<string, string> = { "Content-Type": "text/event-stream" };

function mockContext() {
  return { req: {}, body: (stream: ReadableStream, init?: any) => new Response(stream, init) };
}

function sseResponse(raw: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
  return new Response(stream, { headers: new Headers(SSE_HEADERS) });
}

async function runRaw(raw: string): Promise<any[]> {
  const response = createStreamingResponseHandler(
    mockContext(),
    sseResponse(raw),
    { processTextContent: (t: string) => ({ cleanedText: t, wasTransformed: false }) } as any,
    "test-model",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined
  ) as Response;
  let output = "";
  await response.body!.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk, { stream: true });
      },
    })
  );
  const events: any[] = [];
  for (const part of output.split("\n\n")) {
    let dataStr = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("data: ")) dataStr += line.slice(6);
    }
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      events.push(JSON.parse(dataStr));
    } catch {}
  }
  return events;
}

function frame(delta: any, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "x",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

describe("S4-b lot C: think-splitter in the parser (d4cba87)", () => {
  test("content-wrapped reasoning becomes a thinking block, then text — in order", async () => {
    const events = await runRaw(
      frame({ content: "<think>the plan</think>" }) +
        frame({ content: "the answer" }) +
        frame({}, "stop") +
        "data: [DONE]\n\n"
    );
    const kinds = events
      .filter((e) => e.type === "content_block_start")
      .map((e) => e.content_block?.type);
    expect(kinds).toEqual(["thinking", "text"]);
    const thinking = events
      .filter((e) => e.delta?.type === "thinking_delta")
      .map((e) => e.delta.thinking)
      .join("");
    expect(thinking).toBe("the plan");
    const text = events
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("the answer"); // tags absent from the answer
  });

  test("the thinking half never reaches accumulatedText (no text-recovery pollution)", async () => {
    // Reasoning prose mentions a function tag; if it entered accumulatedText,
    // hold-back/recovery would act on it. It must not.
    const events = await runRaw(
      frame({ content: "<think>I would call <function=Read> here</think>" }) +
        frame({ content: " done" }) +
        frame({}, "stop") +
        "data: [DONE]\n\n"
    );
    const text = events
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe(" done"); // the <function=Read> prose lives in thinking only
  });

  test("a reasoning field disarms the splitter: <think> prose stays visible text", async () => {
    const events = await runRaw(
      frame({ reasoning: "genuine reasoning" }) +
        frame({ content: "about <think> tags" }) +
        frame({}, "stop") +
        "data: [DONE]\n\n"
    );
    const text = events
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("about <think> tags");
  });

  test("an orphan </think> leaking at the head of content is stripped", async () => {
    const events = await runRaw(
      frame({ reasoning: "genuine reasoning" }) +
        frame({ content: "</think>visible answer" }) +
        frame({}, "stop") +
        "data: [DONE]\n\n"
    );
    const text = events
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("visible answer");
  });
});
