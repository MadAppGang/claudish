import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import { createResponsesStreamHandler } from "../openai-responses-sse.js";
import { ClaudeSseSink } from "./claude-sse-sink.js";
import { isParallelWrapperName, parseParallelWrapper } from "./parallel-wrapper.js";
import { parseResponsesLeg } from "./responses-leg.js";

const base = new URL("../../../../test-fixtures/sse-responses/", import.meta.url);
const text = (name: string) => readFileSync(new URL(name, base), "utf8");
function events(wire: string): any[] {
  return wire
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}
const valid = () => text("codex-parallel-valid-DERIVED.sse");
const expected = () =>
  events(text("codex-zero-delta-multicall.sse"))
    .filter((e) => e.type === "response.output_item.done")
    .map((e) => JSON.parse(e.item.arguments));

describe("REQ-3 parallel wrapper expansion", () => {
  test("REQ-3 TEST-6 expands the labelled derived wrapper into three mapped Read calls with _pN ids", async () => {
    const response = createResponsesStreamHandler({} as Context, new Response(valid()), {
      modelName: "capture-model",
      toolNameMap: new Map([["Read", "ReadDecoded"]]),
    });
    const output = events(await response.text());
    const starts = output.filter(
      (e) => e.type === "content_block_start" && e.content_block.type === "tool_use"
    );
    expect(starts).toHaveLength(3);
    expect(starts.map((e) => e.content_block.name)).toEqual([
      "ReadDecoded",
      "ReadDecoded",
      "ReadDecoded",
    ]);
    const callId = events(valid()).find((e) => e.type === "response.output_item.done").item.call_id;
    expect(starts.map((e) => e.content_block.id)).toEqual(
      [0, 1, 2].map((k) => `toolu_${callId.replace(/^fc_/, "")}_p${k}`)
    );
    expect(new Set(starts.map((e) => e.content_block.id)).size).toBe(3);
    expect(
      starts.map((s) => {
        const deltas = output.filter(
          (e) => e.type === "content_block_delta" && e.index === s.index
        );
        expect(deltas).toHaveLength(1);
        return JSON.parse(deltas[0].delta.partial_json);
      })
    ).toEqual(expected());
  });

  test.each([
    "parallel",
    "multi_tool_use.parallel",
    "functions.parallel",
    "functions.multi_tool_use.parallel",
  ])("REQ-3 TEST-7 recognizes %s only when not declared", (name) => {
    expect(isParallelWrapperName(name, [])).toBe(true);
    expect(isParallelWrapperName(name, [name.replace(/^functions\./, "")])).toBe(false);
    expect(isParallelWrapperName("Read", [])).toBe(false);
  });

  test("REQ-3 TEST-7 a declared tool literally named parallel is emitted without expansion", async () => {
    const response = createResponsesStreamHandler({} as Context, new Response(valid()), {
      modelName: "capture-model",
      declaredToolNames: ["parallel"],
    });
    const output = events(await response.text());
    const starts = output.filter(
      (e) => e.type === "content_block_start" && e.content_block.type === "tool_use"
    );
    expect(starts.map((e) => e.content_block.name)).toEqual(["parallel"]);
    expect(starts[0].content_block.id).not.toContain("_p0");
    const args = JSON.parse(
      output
        .filter((e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta")
        .map((e) => e.delta.partial_json)
        .join("")
    );
    expect(args.tool_uses.map((u: any) => u.parameters)).toEqual(expected());
  });
});

test("REQ-20 TEST-25 degenerate usage drain is bounded to 10000 ms on the injected clock", async () => {
  // Derived from V0-21: retain the real wrapper but withhold its metadata/terminal usage.
  const source = events(text("codex-parallel-degenerate-stall.sse"));
  const end = source.findIndex((e) => e.type === "response.output_item.done");
  const bytes = new TextEncoder().encode(
    source
      .slice(0, end + 1)
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join("")
  );
  let cancelled = false;
  let now = 0;
  let timer: { at: number; fn: () => void } | undefined;
  const clock = {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      timer = { at: now + ms, fn };
      return 1;
    },
    clearTimeout() {
      timer = undefined;
    },
  };
  let sink!: ClaudeSseSink;
  const downstream = new ReadableStream<Uint8Array>({
    start(c) {
      sink = new ClaudeSseSink(c, { modelName: "capture-model" });
    },
  });
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    })
  );
  let settled = false;
  const result = parseResponsesLeg(response, {
    sink,
    modelName: "capture-model",
    declaredToolNames: [],
    streamMetadata: new Map(),
    drainClock: clock,
  }).then((outcome) => {
    settled = true;
    return outcome;
  });
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(timer?.at).toBe(10000);
  now = 9999;
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(settled).toBe(false);
  now = 10000;
  if (!timer) throw new Error("Expected usage drain timer");
  timer.fn();
  const outcome = await result;
  expect(outcome.kind).toBe("degenerate-wrapper");
  if (outcome.kind !== "degenerate-wrapper") throw new Error("Expected bounded degenerate outcome");
  expect(outcome.usage).toBeUndefined();
  expect(cancelled).toBe(true);
  sink.close();
  expect(await new Response(downstream).text()).toBe("");
}, 1000);

describe("REQ-4 malformed wrappers remain invisible", () => {
  for (const name of [
    "codex-parallel-degenerate-stall.sse",
    "codex-parallel-degenerate-stall-2.sse",
    "codex-parallel-degenerate-loop.sse",
  ]) {
    test(`REQ-4 REQ-15 TEST-8 ${name} yields a degenerate outcome with reason and terminal usage`, async () => {
      const chunks: Uint8Array[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const sink = new ClaudeSseSink(controller, { modelName: "capture-model" });
          void (async () => {
            try {
              const outcome = await parseResponsesLeg(new Response(text(name)), {
                sink,
                modelName: "capture-model",
                declaredToolNames: [],
                streamMetadata: new Map(),
                drainClock: { now: () => 0, setTimeout: () => 1, clearTimeout: () => {} },
              });
              expect(outcome.kind).toBe("degenerate-wrapper");
              if (outcome.kind !== "degenerate-wrapper")
                throw new Error("Expected degenerate outcome");
              expect(outcome.reason).toBe("unparseable");
              expect(outcome.bytes).toBeGreaterThan(0);
              expect(outcome.usage?.outputTokens).toBeGreaterThan(0);
              if (name === "codex-parallel-degenerate-stall.sse") {
                expect(outcome.usage).toMatchObject({ inputTokens: 39429, outputTokens: 32000 });
              }
              sink.close();
            } catch (error) {
              controller.error(error);
            }
          })();
        },
      });
      const reader = stream.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      const output = events(chunks.map((c) => new TextDecoder().decode(c)).join(""));
      expect(
        output.filter(
          (e) => e.type === "content_block_start" && e.content_block.type === "tool_use"
        )
      ).toEqual([]);
      const rawArgs = events(text(name)).find(
        (e) => e.type === "response.function_call_arguments.done"
      ).arguments;
      expect(parseParallelWrapper(rawArgs, (s) => s)).toEqual({ ok: false, reason: "unparseable" });
    });
  }
});
