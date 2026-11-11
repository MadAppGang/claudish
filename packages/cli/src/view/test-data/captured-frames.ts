/**
 * Frames captured from real magmux 0.19.0 panes (9c45e07), test-only. `fake-child-session` is a
 * claudish pane running the fake interactive child, watched over its read-only view socket: a
 * keyframe, a delta, then the keyframe a `resync` produced. `sgr-runs` is a headless magmux pane
 * that printed bold, indexed, truecolor, reverse, dim, strike, a wide glyph on a background and a
 * styled blank row. Paths on screen were replaced with `/tmp/pane-test-REDACTED`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameMessage } from "../magmux-frame.js";

interface Row {
  capture: string;
  frame?: FrameMessage;
  watch_reply?: { ok: boolean; result: { rows: number; cols: number; pane: number } };
}

const ROWS: Row[] = readFileSync(join(import.meta.dir, "magmux-0.19.0-frames.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

export type Capture = "fake-child-session" | "sgr-runs";

export function capturedFrames(capture: Capture): FrameMessage[] {
  return ROWS.filter((r) => r.capture === capture && r.frame).map((r) => r.frame as FrameMessage);
}

export function capturedWatchReply(capture: Capture): { rows: number; cols: number } {
  const r = ROWS.find((x) => x.capture === capture && x.watch_reply);
  if (!r?.watch_reply) throw new Error(`no watch reply in ${capture}`);
  return r.watch_reply.result;
}
