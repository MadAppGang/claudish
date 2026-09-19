/**
 * S4-a absorption tests (Refs #28, sub-case anthropic-sse.ts).
 *
 * Per-commit decisions over the 6 upstream commits touching this parser
 * (base 980ea08 → upstream/main, measured 2026-09-19):
 *
 *  - bc2ead4  chore tsc+biome      → ÉCARTÉ (formatting only, zero behavior)
 *  - d1ebe49  Layer-4 tool repair  → ÉCARTÉ (layer absent from this fork)
 *  - c9e97c9  qwen `data:{` + event-line withholding → ADAPTÉ
 *              (bare-form tolerance already covered by our line normalization;
 *               the event:-line withholding is absorbed — it fixes a live
 *               defect: every suppression site below used to forward the
 *               `event:` header of the frame it dropped)
 *  - f94a07b  Layer-4 stage 2      → ÉCARTÉ (layer absent)
 *  - 5934fec  terminal tail on abandon → ADAPTÉ (dédup: our finalizeWithError
 *              already emits the tail; absorbed: JSON.stringify frames,
 *              sawMessageStop guard, derived stop_reason, onTokenUpdate on
 *              the abandon path)
 *  - b48042c  one index-mapping layer on BOTH branches → PRIS (adapté — it
 *              generalizes our own #127 repair, which only ever reached the
 *              passthrough branch; MiniMax, the provider the fixtures come
 *              from, takes the filtered branch)
 *
 * Every test in this file that asserts a FIX pins it: reverting the
 * corresponding hunk makes the test fail (verified pre-fix — the suite was
 * written first and run against the pre-fix source).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAnthropicPassthroughStream } from "./anthropic-sse.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../test-fixtures/sse-responses"
);

function mockContext() {
  const c: any = {
    req: {},
    body: (stream: ReadableStream, init?: any) => new Response(stream, init),
  };
  return c;
}

/** A Response whose body enqueues the given chunks then ends. */
const sseResponse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

/**
 * A Response whose body delivers the chunks one read at a time, then DIES
 * like an upstream socket reset (the next reader.read() rejects) — the replay
 * of a mid-stream socket death. Pull-based on purpose: controller.error()
 * DISCARDS anything still queued, so an enqueue-then-error stream delivers
 * nothing; delivering on pull means every chunk is read before the reset.
 */
const dyingResponse = (chunks: string[]) => {
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        const encoder = new TextEncoder();
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]));
        } else {
          controller.error(new Error("socket reset mid-stream"));
        }
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
};

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const stripPingFrames = (wire: string): string =>
  wire.replaceAll('event: ping\ndata: {"type":"ping"}\n\n', "");

type RunOpts = {
  adapter?: any;
  modelName?: string;
  onTokenUpdate?: (input: number, output: number) => void;
};

const run = async (response: Response, opts: RunOpts = {}): Promise<string> => {
  const text = await createAnthropicPassthroughStream(mockContext(), response, {
    modelName: opts.modelName ?? "test-model",
    adapter: opts.adapter,
    onTokenUpdate: opts.onTokenUpdate,
  }).text();
  return stripPingFrames(text);
};

const runFrames = (frames: string[], opts: RunOpts = {}) => run(sseResponse(frames), opts);

const messageStart = () =>
  frame("message_start", {
    type: "message_start",
    message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 0 } },
  });

const thinkingBlockStart = (index: number) =>
  frame("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "" },
  });

const textBlockStart = (index: number) =>
  frame("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });

const textDelta = (index: number, text: string) =>
  frame("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });

const blockStop = (index: number) =>
  frame("content_block_stop", { type: "content_block_stop", index });

const messageDelta = (stopReason: string) =>
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: { output_tokens: 4 },
  });

const messageStop = () => frame("message_stop", { type: "message_stop" });

/** Replay a whole fixture file (stripping its `# ` metadata lines). */
const runFixture = async (name: string, adapter?: any): Promise<string> => {
  const text = readFileSync(join(FIXTURES_DIR, name), "utf-8")
    .split("\n")
    .filter((l) => !l.startsWith("# "))
    .join("\n");
  return runFrames([text], { adapter });
};

/** Parse a parser-emitted wire into its data payloads, in order. */
const parseEmitted = (wire: string): any[] =>
  wire
    .split("\n\n")
    .flatMap((f) => f.split("\n"))
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .filter((d) => d !== '{"type":"ping"}')
    .map((d) => JSON.parse(d));

/** Every data payload in the wire must parse — pins JSON.stringify frames. */
const allDataParses = (wire: string): boolean =>
  wire
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .every((l) => {
      try {
        JSON.parse(l.slice(6));
        return true;
      } catch {
        return false;
      }
    });

/**
 * No frame may carry an `event:` header without a `data:` body.
 *
 * This is the shape that kills Claude Code with `Could not parse message into
 * JSON: From chunk: ["event:content_block_start"]` — a filter that drops a
 * data line must drop the event line that introduced it.
 */
const noOrphanEventHeaders = (wire: string): string[] => {
  const orphans: string[] = [];
  for (const f of wire.split("\n\n")) {
    const lines = f.split("\n").filter((l) => l.trim());
    const hasEvent = lines.some((l) => l.startsWith("event:"));
    const hasData = lines.some((l) => l.startsWith("data:"));
    if (hasEvent && !hasData) orphans.push(f);
  }
  return orphans;
};

// ── b48042c: one index-mapping layer, both branches ─────────────────────

describe("S4-a: anthropic-sse index mapping (b48042c)", () => {
  it("passes sequential indices through untouched (passthrough branch)", async () => {
    const out = await runFrames([
      messageStart(),
      textBlockStart(0),
      textDelta(0, "hello"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]);
    expect(out).toContain('"index":0');
    expect(out).not.toContain('"index":1');
    expect(out).toContain('"stop_reason":"end_turn"');
  });

  it("remaps a jumping content_block_start to the next sequential index (z.ai shape)", async () => {
    const out = await runFrames([
      messageStart(),
      textBlockStart(0),
      textDelta(0, "first"),
      blockStop(0),
      textBlockStart(2),
      textDelta(2, "second"),
      blockStop(2),
      messageDelta("end_turn"),
      messageStop(),
    ]);
    expect(out).toContain('"index":1');
    expect(out).not.toContain('"index":2');
    expect(out).toContain("second");
  });

  it("drops an orphan delta instead of re-attaching it to another block", async () => {
    const out = await runFrames([
      messageStart(),
      textBlockStart(0),
      textDelta(0, "ok"),
      textDelta(5, "orphan"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]);
    expect(out).toContain('"index":0');
    expect(out).not.toContain('"index":5');
    expect(out).not.toContain("orphan");
  });

  it("absorbs MiniMax's implicit signature block and keeps the stream sequential (passthrough branch)", async () => {
    const out = await runFrames([
      messageStart(),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "EoMC" },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      textBlockStart(1),
      textDelta(1, "real content"),
      blockStop(1),
      messageDelta("end_turn"),
      messageStop(),
    ]);
    expect(out).not.toContain("signature_delta");
    expect(out).toContain('"index":0');
    expect(out).not.toContain('"index":1');
    expect(out).toContain("real content");
  });
});

describe.each([
  { reqN: "r10324", textFragment: "Search-4-LocalSearch", toolFragment: "check_twin_parity.py" },
  { reqN: "r10416", textFragment: "QuantConnect", toolFragment: "config.json" },
])("S4-a: production fixture MiniMax-M3 implicit signature ($reqN)", ({ reqN, textFragment, toolFragment }) => {
  it("renumbers the whole stream sequentially and drops the implicit signature block (passthrough branch)", async () => {
    const events = parseEmitted(
      await runFixture(`minimax-m3-anthropic-implicit-signature-${reqN}.sse`)
    );

    expect(
      events.filter((e) => e.type === "content_block_delta" && e.delta?.type === "signature_delta")
    ).toHaveLength(0);

    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts.map((e) => [e.index, e.content_block.type])).toEqual([
      [0, "text"],
      [1, "tool_use"],
    ]);

    const textDeltas = events.filter((e) => e.delta?.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(5);
    expect(new Set(textDeltas.map((e) => e.index))).toEqual(new Set([0]));
    expect(textDeltas.map((e) => e.delta.text).join("")).toContain(textFragment);

    const toolDeltas = events.filter((e) => e.delta?.type === "input_json_delta");
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1);
    expect(new Set(toolDeltas.map((e) => e.index))).toEqual(new Set([1]));
    const toolInput = JSON.parse(toolDeltas.map((e) => e.delta.partial_json).join(""));
    expect(JSON.stringify(toolInput)).toContain(toolFragment);

    expect(events.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual([0, 1]);
    expect(events.at(-1)?.type).toBe("message_stop");
    const stopReason = events.find((e) => e.type === "message_delta")?.delta?.stop_reason;
    expect(stopReason).toBe("tool_use");
    expect(events.filter((e) => typeof e.index === "number" && e.index > 1)).toHaveLength(0);
  });
});

describe("S4-a: index mapping applies on the thinking-filtered path too (b48042c)", () => {
  it("only emits deltas and stops for sequentially opened blocks", async () => {
    // Without the adapter this exercises the unfiltered branch and proves
    // nothing about the MiniMax path used in production
    // (MiniMaxModelDialect.shouldFilterThinking() === true).
    const adapter = { shouldFilterThinking: () => true } as any;
    const events = parseEmitted(
      await runFixture("minimax-m3-anthropic-implicit-signature-r10324.sse", adapter)
    );
    const openedIndices = new Set<number>();
    const violations: any[] = [];

    for (const event of events) {
      if (event.type === "content_block_start") {
        openedIndices.add(event.index);
      } else if (
        (event.type === "content_block_delta" || event.type === "content_block_stop") &&
        !openedIndices.has(event.index)
      ) {
        violations.push(event);
      }
    }

    expect(
      violations,
      `Frames referenced unopened content block indices:\n${JSON.stringify(violations, null, 2)}`
    ).toHaveLength(0);
    expect([...openedIndices]).toEqual([0, 1]);
  });
});

// ── c9e97c9 + b48042c final round: event-line withholding ──────────────

describe("S4-a: no orphan event headers (c9e97c9 + b48042c)", () => {
  it("filtered path: a suppressed thinking block takes its event lines with it", async () => {
    const adapter = { shouldFilterThinking: () => true } as any;
    const wire = await runFrames(
      [
        messageStart(),
        thinkingBlockStart(0),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "secret" },
        }),
        blockStop(0),
        textBlockStart(1),
        textDelta(1, "visible"),
        blockStop(1),
        messageDelta("end_turn"),
        messageStop(),
      ],
      { adapter }
    );
    const orphans = noOrphanEventHeaders(wire);
    expect(orphans, `Orphan event headers:\n${orphans.join("\n---\n")}`).toEqual([]);
    // And the suppression itself still works.
    expect(wire).not.toContain("thinking_delta");
    expect(wire).toContain("visible");
    expect(wire).toContain('"index":0');
    expect(wire).not.toContain('"index":1');
  });

  it("passthrough path: a suppressed server_tool_use block takes its event lines with it", async () => {
    const wire = await runFrames([
      messageStart(),
      textBlockStart(0),
      textDelta(0, "answer"),
      blockStop(0),
      frame("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "server_tool_use", name: "webReader", input: { url: "https://example.com" } },
      }),
      blockStop(1),
      frame("content_block_start", {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_result", tool_use_id: "t1" },
      }),
      blockStop(2),
      messageDelta("end_turn"),
      messageStop(),
    ]);
    const orphans = noOrphanEventHeaders(wire);
    expect(orphans, `Orphan event headers:\n${orphans.join("\n---\n")}`).toEqual([]);
    expect(wire).not.toContain("server_tool_use");
    expect(wire).not.toContain("tool_result");
    expect(wire).toContain("answer");
  });

  it("passthrough path: a dropped orphan frame leaves no header behind", async () => {
    const wire = await runFrames([
      messageStart(),
      textBlockStart(0),
      textDelta(0, "ok"),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 7,
        delta: { type: "text_delta", text: "orphan" },
      }),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]);
    const orphans = noOrphanEventHeaders(wire);
    expect(orphans, `Orphan event headers:\n${orphans.join("\n---\n")}`).toEqual([]);
    expect(wire).not.toContain("orphan");
  });
});

// ── 5934fec (adapté): abandon tail hardening ────────────────────────────

describe("S4-a: abandoned-stream tail (5934fec adapted)", () => {
  it("a mid-stream socket death ends the turn with a terminal message_stop (never-hang pin)", async () => {
    let tokens: [number, number] | null = null;
    const wire = await run(dyingResponse([messageStart(), textBlockStart(0), textDelta(0, "partial an")]), {
      onTokenUpdate: (i, o) => {
        tokens = [i, o];
      },
    });
    // The delivered prefix was forwarded — the mid-stream branch ran, not the
    // synthetic-message branch (msg_1 is the upstream id; a synthetic tail
    // would carry a msg_<timestamp> id and NO forwarded text).
    expect(wire).toContain("msg_1");
    expect(wire).toContain("partial an");
    const events = wire
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => {
        try {
          return JSON.parse(l.slice(6));
        } catch {
          return null;
        }
      });
    const stops = events.filter((e) => e?.type === "message_stop");
    expect(stops).toHaveLength(1);
    // The open block is closed before the terminal pair.
    const stopIdx = events.findIndex((e) => e?.type === "content_block_stop");
    expect(stopIdx).toBeGreaterThan(-1);
    // Exactly one message_start — the upstream one, no synthetic duplicate.
    expect(events.filter((e) => e?.type === "message_start")).toHaveLength(1);
    // onTokenUpdate ran despite the abandon — the token file sees the turn.
    expect(tokens).not.toBeNull();
  });

  it("a socket death AFTER message_stop emits no second terminal pair", async () => {
    const wire = await run(
      dyingResponse([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "complete"),
        blockStop(0),
        messageDelta("end_turn"),
        messageStop(),
      ])
    );
    const stops = wire.split("\n").filter((l) => l.startsWith('data: {"type":"message_stop"}'));
    expect(stops).toHaveLength(1);
  });

  it("the tail preserves an upstream-reported stop_reason instead of forcing end_turn", async () => {
    // A turn that lost only its terminal frames may still have delivered a
    // complete tool_use block — reporting end_turn makes the client discard
    // the tool call.
    const wire = await run(
      dyingResponse([
        messageStart(),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        }),
        blockStop(0),
        messageDelta("tool_use"),
      ])
    );
    const tailDelta = wire
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)))
      // findLast, not find: the FORWARDED upstream message_delta (tool_use)
      // precedes the tail's synthetic one — the assertion must land on the
      // tail, which is where the hardcoded end_turn lived.
      .filter((e) => e.type === "message_delta" && e.delta?.stop_reason)
      .at(-1);
    expect(tailDelta?.delta?.stop_reason).toBe("tool_use");
  });

  it("every synthetic frame parses as JSON even when the model name carries quotes/backslashes", async () => {
    // Custom endpoints allow arbitrary model names; a hand-built literal with
    // an interpolated name produces unparseable JSON and turns a recoverable
    // truncation into a hard client failure.
    const evilName = 'my"custom\\model';
    const wire = await run(dyingResponse([messageStart(), textBlockStart(0), textDelta(0, "x")]), {
      modelName: evilName,
    });
    expect(allDataParses(wire)).toBe(true);
    expect(wire).toContain('"stop_reason"');

    const emptyWire = await run(sseResponse([]), { modelName: evilName });
    expect(allDataParses(emptyWire)).toBe(true);
  });
});
