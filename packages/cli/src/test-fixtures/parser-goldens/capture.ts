/**
 * Capture the parser goldens from the CURRENT code.
 *
 *   bun run src/test-fixtures/parser-goldens/capture.ts            (from packages/cli)
 *
 * Writes one `<id>.golden.json` per case in `cases.ts`. It refuses to overwrite
 * an existing golden: the goldens are the pre-rewrite contract, and capturing
 * them again from rewritten code would make every parity check vacuous. To
 * re-capture deliberately (only ever from the pre-hook parsers), delete the file
 * first and say why in the commit.
 *
 * Every case is captured twice, 25 ms apart, so a clock- or random-derived value
 * that `normalizeWire` misses shows up as a mismatch and nothing is written.
 */

import { existsSync, writeFileSync } from "node:fs";

import {
  GEMINI_APPLICABILITY_MODELS,
  GEMINI_GOLDEN_ID,
  GEMINI_MODEL,
  GEMINI_SCENARIOS,
  GEMINI_TOOL_SCHEMAS,
  PARSER_CASES,
} from "./cases.js";
import { runGeminiCapture, runParserCase } from "./drive-current.js";
import { type Golden, goldenPath } from "./golden-format.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function twice<T>(label: string, run: () => Promise<T>): Promise<T> {
  const first = await run();
  await pause(25);
  const second = await run();
  const a = JSON.stringify(first);
  const b = JSON.stringify(second);
  if (a !== b) {
    throw new Error(`${label}: two captures differ — a nondeterministic value is not normalized`);
  }
  return first;
}

async function main(): Promise<void> {
  const goldens: Golden[] = [];

  for (const c of PARSER_CASES) {
    const output = await twice(c.id, () => runParserCase(c));
    goldens.push({ kind: "parser", ...c, output });
  }

  goldens.push(
    await twice(GEMINI_GOLDEN_ID, () =>
      runGeminiCapture(
        GEMINI_GOLDEN_ID,
        GEMINI_MODEL,
        GEMINI_TOOL_SCHEMAS,
        GEMINI_APPLICABILITY_MODELS,
        GEMINI_SCENARIOS
      )
    )
  );

  const existing = goldens.filter((g) => existsSync(goldenPath(g.id)));
  if (existing.length > 0) {
    console.error(
      `refusing to overwrite ${existing.length} existing golden(s): ${existing.map((g) => g.id).join(", ")}`
    );
    process.exit(1);
  }

  for (const golden of goldens) {
    writeFileSync(goldenPath(golden.id), `${JSON.stringify(golden, null, 2)}\n`);
    console.log(`wrote ${golden.id}`);
  }
}

await main();
