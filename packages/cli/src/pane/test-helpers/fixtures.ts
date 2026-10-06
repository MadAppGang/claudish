/**
 * Loaders for the phase-2 real-capture fixtures (`pane/test-fixtures/`): screens and frames. Test-only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpanRun } from "../contract.js";
import type { MagmuxFrame, ScreenState } from "../screen-model.js";

export const FIXTURES = join(import.meta.dir, "..", "test-fixtures");

export function loadScreen(name: string): ScreenState {
  const j = JSON.parse(readFileSync(join(FIXTURES, "screens", `${name}.json`), "utf8")) as {
    rows: number;
    cols: number;
    alt: boolean;
    cursor: { x: number; y: number };
    lines: string[];
    spans: SpanRun[][];
  };
  return {
    seq: 1,
    cols: j.cols,
    rows: j.rows,
    cursor: { x: j.cursor.x, y: j.cursor.y },
    lines: j.lines,
    spans: j.spans,
    alt: j.alt,
    changedAt: 0,
    aboveBoxChangedAt: 0,
  };
}

export function loadFrames(name: string): MagmuxFrame[] {
  return readFileSync(join(FIXTURES, "frames", `${name}.ndjson`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MagmuxFrame);
}
