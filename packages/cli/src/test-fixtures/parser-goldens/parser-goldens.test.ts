/**
 * Parser parity: the parsers plus the hook response seam reproduce the goldens
 * captured from the pre-hook parsers (P0, base 2e4ac246).
 *
 * Tool-argument repair moved out of five parsers into one seam above them.
 * Every parser golden replays through the new parser + seam (`drive-seam.ts`)
 * to its recorded output, byte for byte after normalization, except the one
 * golden that recorded a defect of the old code, which is compared by its data
 * payloads. The Gemini middleware golden still replays through `middleware/`
 * (`drive-gemini-middleware.ts`) until the raw tier replaces it.
 */

import { describe, expect, it } from "bun:test";

import {
  GEMINI_APPLICABILITY_MODELS,
  GEMINI_GOLDEN_ID,
  GEMINI_SCENARIOS,
  GEMINI_TOOL_SCHEMAS,
  ORIGINAL_ARGS,
  ORIGINAL_VALUE,
  PARSER_CASES,
  REPAIRED_ARGS,
  REPAIRED_VALUE,
} from "./cases.js";
import { runGeminiCapture } from "./drive-gemini-middleware.js";
import { runParserCase } from "./drive-seam.js";
import {
  type GeminiMiddlewareGolden,
  type ParserGolden,
  dataPayloads,
  listGoldenIds,
  readGolden,
  stripPings,
} from "./golden-format.js";

const parserGolden = (id: string) => readGolden(id) as ParserGolden;
const geminiGolden = () => readGolden(GEMINI_GOLDEN_ID) as GeminiMiddlewareGolden;

/** `partial_json` of every `input_json_delta`, in order. */
function inputJsonDeltas(wire: string): string[] {
  return dataPayloads(wire)
    .filter((p: any) => p?.type === "content_block_delta" && p.delta?.type === "input_json_delta")
    .map((p: any) => p.delta.partial_json);
}

describe("parser goldens: coverage and drift", () => {
  it("has exactly one golden file per case", () => {
    const expected = [...PARSER_CASES.map((c) => c.id), GEMINI_GOLDEN_ID].sort();
    expect(listGoldenIds()).toEqual(expected);
  });

  it("stores the same input and repair rule cases.ts defines", () => {
    for (const c of PARSER_CASES) {
      const { kind, output, ...stored } = parserGolden(c.id);
      expect(kind).toBe("parser");
      expect(stored).toEqual(JSON.parse(JSON.stringify(c)));
    }
  });

  it("stores the same Gemini inputs cases.ts defines", () => {
    const golden = geminiGolden();
    expect(golden.applicability.map((a) => a.modelId)).toEqual(GEMINI_APPLICABILITY_MODELS);
    expect(golden.toolSchemas).toEqual(GEMINI_TOOL_SCHEMAS);
    expect(golden.scenarios.map((s) => s.id)).toEqual(GEMINI_SCENARIOS.map((s) => s.id));
    for (const [i, s] of GEMINI_SCENARIOS.entries()) {
      expect(golden.scenarios[i]!.streams.map((x) => x.input)).toEqual(s.streams);
      expect(golden.scenarios[i]!.nextRequest.before).toEqual(s.nextRequestMessages as any[]);
    }
  });
});

describe("parser goldens: parser + response seam reproduce them", () => {
  for (const c of PARSER_CASES) {
    it(c.id, async () => {
      const golden = parserGolden(c.id);
      const replay = await runParserCase(golden);
      if (golden.defect) {
        // The old wire framed the repaired delta and the stop wrongly; the seam
        // must send the same payloads, in order, each under its own event name.
        expect(dataPayloads(replay)).toEqual(dataPayloads(golden.output));
        expect(replay).not.toContain("event: content_block_stop\nevent: content_block_delta\n");
        expect(replay).toContain(
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}'
        );
      } else {
        expect(replay).toBe(golden.output);
      }
    });
  }

  it("Gemini thought-signature middleware", async () => {
    const golden = geminiGolden();
    const replay = await runGeminiCapture(
      golden.id,
      golden.modelId,
      golden.toolSchemas,
      golden.applicability.map((a) => a.modelId),
      golden.scenarios.map((s) => ({
        id: s.id,
        description: s.description,
        streams: s.streams.map((x) => x.input),
        nextRequestMessages: s.nextRequest.before,
      }))
    );
    expect(replay).toEqual(golden);
  });

  it("can fail: the targeted input without its rule does not reproduce the repaired golden", async () => {
    const golden = parserGolden("openai-sse.targeted-repaired");
    const unarmed = await runParserCase({ ...golden, repair: { kind: "none" } });
    expect(unarmed).not.toBe(golden.output);
    expect(unarmed).toContain(ORIGINAL_VALUE);
  });
});

describe("parser goldens: each records the behaviour it is named for", () => {
  const repaired = [
    "openai-sse.targeted-repaired",
    "openai-responses-sse.targeted-repaired",
    "anthropic-sse.targeted-fragmented-repaired",
    "gemini-sse.targeted-repaired",
    "devin-connect.targeted-fragmented-repaired",
  ];
  const original = [
    "openai-sse.untargeted-unchanged",
    "openai-sse.repair-throws",
    "openai-responses-sse.untargeted-unchanged",
    "anthropic-sse.untargeted-unchanged",
    "gemini-sse.untargeted-unchanged",
    "devin-connect.repair-throws",
  ];

  for (const id of repaired) {
    it(`${id}: one complete repaired argument object`, () => {
      const { output } = parserGolden(id);
      expect(inputJsonDeltas(output)).toEqual([REPAIRED_ARGS]);
      expect(output).not.toContain(ORIGINAL_VALUE);
    });
  }

  for (const id of original) {
    it(`${id}: the model's own arguments`, () => {
      const { output } = parserGolden(id);
      expect(inputJsonDeltas(output).join("")).toBe(ORIGINAL_ARGS);
      expect(output).not.toContain(REPAIRED_VALUE);
    });
  }

  it("openai-sse.repair-throws still ends the message", () => {
    expect(parserGolden("openai-sse.repair-throws").output).toContain('"type":"message_stop"');
  });

  for (const id of [
    "openai-responses-sse.untargeted-incremental",
    "devin-connect.untargeted-incremental",
  ]) {
    it(`${id}: untargeted fragments stay incremental`, () => {
      expect(inputJsonDeltas(parserGolden(id).output)).toEqual([
        '{"value":"incremental-',
        'delivery"}',
      ]);
    });
  }

  it("anthropic-sse: an armed rule leaves an untargeted tool byte-identical once pings are stripped", () => {
    const baseline = parserGolden("anthropic-sse.byte-identical.baseline").output;
    const armed = parserGolden("anthropic-sse.byte-identical.armed").output;
    expect(stripPings(armed)).toBe(stripPings(baseline));
  });

  it("anthropic-sse targeted repair: the recorded defect is real and its payloads are intact", () => {
    const golden = parserGolden("anthropic-sse.targeted-fragmented-repaired");
    expect(golden.defect).toBeDefined();
    expect(golden.output).toContain("event: content_block_stop\nevent: content_block_delta\n");
    expect(dataPayloads(golden.output).map((p: any) => p.type)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ]);
    expect(PARSER_CASES.filter((c) => c.defect).map((c) => c.id)).toEqual([golden.id]);
  });

  it("Gemini: applicability is the gemini / google/ substring rule", () => {
    expect(geminiGolden().applicability).toEqual([
      {
        modelId: "google/gemini-3.1-pro-preview",
        shouldHandle: true,
        activeNames: ["GeminiThoughtSignature"],
      },
      { modelId: "gemini-2.5-flash", shouldHandle: true, activeNames: ["GeminiThoughtSignature"] },
      {
        modelId: "google/gemma-3-27b-it",
        shouldHandle: true,
        activeNames: ["GeminiThoughtSignature"],
      },
      { modelId: "gpt-5.6-sol", shouldHandle: false, activeNames: [] },
      { modelId: "claude-opus-5", shouldHandle: false, activeNames: [] },
    ]);
  });

  it("Gemini: the middleware never changes the client stream", () => {
    for (const s of geminiGolden().scenarios) {
      for (const stream of s.streams) expect(stream.outputUnchangedByMiddleware).toBe(true);
    }
  });

  it("Gemini: each turn's reasoning_details land on its own assistant message only", () => {
    const byId = Object.fromEntries(geminiGolden().scenarios.map((s) => [s.id, s]));
    const signatures = (m: any) => m.reasoning_details?.map((d: any) => d.signature);
    const changed = (id: string) => {
      const { before, after } = byId[id]!.nextRequest;
      return after
        .map((m, i) => [i, m] as const)
        .filter(([i, m]) => JSON.stringify(m) !== JSON.stringify(before[i]))
        .map(([i, m]) => [i, signatures(m)]);
    };

    expect(changed("tool-call-with-reasoning")).toEqual([[2, ["SIG-A-0", "SIG-A-1"]]]);
    expect(changed("two-turns")).toEqual([
      [2, ["SIG-A-0", "SIG-A-1"]],
      [4, ["SIG-B-0", "SIG-B-1"]],
    ]);
    expect(changed("reasoning-without-tool-call")).toEqual([]);
    expect(changed("no-prior-stream")).toEqual([]);
  });
});
