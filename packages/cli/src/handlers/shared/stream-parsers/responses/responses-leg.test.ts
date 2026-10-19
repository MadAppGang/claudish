import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import { collectSseMessage } from "../../collect-sse-message.js";
import { createResponsesStreamHandler } from "../openai-responses-sse.js";

const base = new URL("../../../../test-fixtures/sse-responses/", import.meta.url);
// All derived streams below use real events/arguments from the named captures, not invented protocol.
function capture(name: string): any[] {
  return readFileSync(new URL(name, base), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}
function upstream(events: any[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
}
function translated(
  events: any[],
  opts: Partial<Parameters<typeof createResponsesStreamHandler>[2]> = {}
) {
  return createResponsesStreamHandler({} as Context, upstream(events), {
    modelName: "capture-model",
    ...opts,
  });
}
async function folded(response: Response): Promise<any[]> {
  return (await response.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}
function toolArguments(events: any[]) {
  return events
    .filter((e) => e.type === "content_block_start" && e.content_block.type === "tool_use")
    .map((start) => {
      const deltas = events.filter(
        (e) =>
          e.type === "content_block_delta" &&
          e.index === start.index &&
          e.delta.type === "input_json_delta"
      );
      const stop = events.findIndex(
        (e) => e.type === "content_block_stop" && e.index === start.index
      );
      expect(stop).toBeGreaterThan(events.indexOf(start));
      for (const delta of deltas) expect(events.indexOf(delta)).toBeLessThan(stop);
      return {
        name: start.content_block.name,
        deltas,
        args: JSON.parse(deltas.map((d) => d.delta.partial_json).join("")),
      };
    });
}
const zero = () => capture("codex-zero-delta-multicall.sse");
const realCalls = () =>
  zero().filter((e) => e.type === "response.output_item.done" && e.item.type === "function_call");

describe("REQ-1/REQ-2 Responses final arguments", () => {
  test("REQ-1 TEST-1 emits one full argument delta per real zero-delta Read before stop", async () => {
    const calls = toolArguments(await folded(translated(zero())));
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.name)).toEqual(["Read", "Read", "Read"]);
    expect(calls.map((c) => c.deltas.length)).toEqual([1, 1, 1]);
    expect(calls.map((c) => c.args)).toEqual(realCalls().map((e) => JSON.parse(e.item.arguments)));
    expect(calls.map((c) => c.args.file_path.split("/").at(-1))).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("REQ-1 TEST-2 uses item.arguments when argument-done events are absent", async () => {
    const calls = toolArguments(
      await folded(
        translated(zero().filter((e) => e.type !== "response.function_call_arguments.done"))
      )
    );
    expect(calls.map((c) => c.args)).toEqual(realCalls().map((e) => JSON.parse(e.item.arguments)));
    expect(calls.map((c) => c.deltas.length)).toEqual([1, 1, 1]);
  });

  test("REQ-1 TEST-2 prefers argument-done over a different item final", async () => {
    // Derived from V0-1: first item final uses the second real Read arguments; argument-done stays unchanged.
    const source = zero();
    const finals = source.filter((e) => e.type === "response.output_item.done");
    finals[0].item.arguments = finals[1].item.arguments;
    const calls = toolArguments(await folded(translated(source)));
    expect(calls.map((c) => c.args)).toEqual(realCalls().map((e) => JSON.parse(e.item.arguments)));
    expect(calls.map((c) => c.deltas.length)).toEqual([1, 1, 1]);
  });

  test("REQ-2 TEST-3 buffers final real arguments before repair and JSON collection", async () => {
    const observed: string[] = [];
    const result = await collectSseMessage(
      translated(zero(), {
        shouldBufferTool: () => true,
        onToolCall: (_name, args) => {
          observed.push(args);
          return null;
        },
      }),
      "capture-model"
    );
    expect(observed.map((s) => JSON.parse(s))).toEqual(
      realCalls().map((e) => JSON.parse(e.item.arguments))
    );
    expect(result.content.filter((c) => c.type === "tool_use").map((c) => c.input)).toEqual(
      realCalls().map((e) => JSON.parse(e.item.arguments))
    );
    expect(result.stop_reason).toBe("tool_use");
  });
});

describe("REQ-6 Responses incremental argument compatibility", () => {
  test("REQ-6 TEST-4 preserves many deltas per Codex call without resending final arguments", async () => {
    // Derived from V0-1 final arguments and native toolsonly-turn1's real delta event envelope.
    const template = capture("gpt-5.6-sol-responses-toolsonly-turn1.sse").find(
      (e) => e.type === "response.function_call_arguments.delta"
    );
    const source = zero();
    const derived = source.flatMap((e) => {
      if (e.type !== "response.function_call_arguments.done") return [e];
      const split = Math.floor(e.arguments.length / 2);
      return [
        {
          ...template,
          item_id: e.item_id,
          output_index: e.output_index,
          delta: e.arguments.slice(0, split),
        },
        {
          ...template,
          item_id: e.item_id,
          output_index: e.output_index,
          delta: e.arguments.slice(split),
        },
        e,
      ];
    });
    const calls = toolArguments(await folded(translated(derived)));
    expect(calls.map((c) => c.deltas.length)).toEqual([2, 2, 2]);
    expect(calls.map((c) => c.args)).toEqual(realCalls().map((e) => JSON.parse(e.item.arguments)));
  });

  test("REQ-6 TEST-4 native one-delta plus done never duplicates arguments", async () => {
    const source = capture("gpt-5.6-sol-responses-toolsonly-turn1.sse");
    const calls = toolArguments(await folded(translated(source)));
    expect(calls.map((c) => c.deltas.length)).toEqual([1, 1, 1]);
    expect(calls.map((c) => c.args)).toEqual([
      { path: "a.ts" },
      { path: "b.ts" },
      { path: "c.ts" },
    ]);
  });

  test("REQ-6 TEST-5 emits only the missing suffix when final arguments extend a real delta", async () => {
    // Derived from native one-delta capture: shorten each actual delta, retain original final arguments.
    const source = capture("gpt-5.6-sol-responses-toolsonly-turn1.sse");
    for (const e of source)
      if (e.type === "response.function_call_arguments.delta") e.delta = e.delta.slice(0, 6);
    const calls = toolArguments(await folded(translated(source)));
    expect(calls.map((c) => c.args)).toEqual([
      { path: "a.ts" },
      { path: "b.ts" },
      { path: "c.ts" },
    ]);
    expect(calls.map((c) => c.deltas.length)).toEqual([2, 2, 2]);
  });

  test("REQ-6 TEST-5 does not append divergent final bytes to streamed arguments", async () => {
    // Derived from native capture: real first-call finals are replaced with real second-call finals.
    const source = capture("gpt-5.6-sol-responses-toolsonly-turn1.sse");
    const dones = source.filter((e) => e.type === "response.function_call_arguments.done");
    dones[0].arguments = dones[1].arguments;
    source.find((e) => e.type === "response.output_item.done").item.arguments = dones[1].arguments;
    const calls = toolArguments(await folded(translated(source)));
    expect(calls.map((c) => c.args)).toEqual([
      { path: "a.ts" },
      { path: "b.ts" },
      { path: "c.ts" },
    ]);
    expect(calls.map((c) => c.deltas.length)).toEqual([1, 1, 1]);
  });
});
