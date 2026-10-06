/**
 * Loaders for the phase-2 real-capture transcript fixtures, and a replay that feeds a
 * real transcript to a TranscriptFollower the way a pane session sees it. Test-only.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptFollower,
  type TranscriptView,
  type TurnDelivery,
  type Witness,
} from "../transcript-follower.js";
import { FIXTURES } from "./fixtures.js";

/** A raw transcript record or content block (untyped JSON written by Claude Code). */
// biome-ignore lint/suspicious/noExplicitAny: fixtures are raw JSON, read field by field in assertions
export type Rec = Record<string, any>;

export function transcriptLines(name: string): string[] {
  return readFileSync(join(FIXTURES, "transcripts", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);
}

export function transcriptRecords(name: string): Rec[] {
  return transcriptLines(name).map((l) => JSON.parse(l));
}

/** Text of a user record (string content or text blocks). */
export function textOf(r: Rec): string {
  const c = r.message?.content;
  if (typeof c === "string") return c;
  return (c ?? [])
    .filter((b: Rec) => b?.type === "text")
    .map((b: Rec) => b.text)
    .join("");
}

export interface ReplayTurn {
  /** index of the record the turn's offset is marked BEFORE (normally the witness record) */
  at: number;
  witness: Witness;
  delivery?: TurnDelivery | null;
}

/**
 * Replays a real transcript into a temp file the way a pane session sees it: for each
 * turn, every earlier line is appended and polled, the offset is marked (`size()`),
 * the turn opened, and then the rest is appended. Returns the follower and the views
 * taken right after each turn's lines were all applied.
 */
export function replay(
  name: string,
  turns: ReplayTurn[],
  opts: { upTo?: number; subagents?: string; now?: () => number } = {}
): { follower: TranscriptFollower; views: TranscriptView[]; dir: string; cleanup: () => void } {
  const lines = transcriptLines(name);
  const dir = mkdtempSync(join(tmpdir(), "pane-fixture-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "");
  const follower = new TranscriptFollower(path, opts.subagents ?? join(dir, "none"), {
    now: opts.now,
  });
  const views: TranscriptView[] = [];
  const end = Math.min(opts.upTo ?? lines.length, lines.length);
  let i = 0;
  const sorted = [...turns].sort((a, b) => a.at - b.at);
  for (let k = 0; k < sorted.length; k++) {
    const t = sorted[k]!;
    for (; i < t.at && i < end; i++) appendFileSync(path, `${lines[i]}\n`);
    follower.poll();
    follower.openTurn({
      index: k + 1,
      offset: follower.size(),
      witness: t.witness,
      delivery: t.delivery ?? null,
    });
    const stop = Math.min(sorted[k + 1]?.at ?? end, end);
    for (; i < stop; i++) appendFileSync(path, `${lines[i]}\n`);
    follower.poll();
    views.push(follower.view());
  }
  if (sorted.length === 0) {
    for (; i < end; i++) appendFileSync(path, `${lines[i]}\n`);
    follower.poll();
  }
  return { follower, views, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Index of the first record satisfying `pred` at or after `from`. */
export function indexOf(name: string, pred: (r: Rec) => boolean, from = 0): number {
  const recs = transcriptRecords(name);
  for (let i = from; i < recs.length; i++) if (pred(recs[i]!)) return i;
  return -1;
}

/** Index of the user record whose text equals `text` exactly (a witness). */
export function witnessIndex(name: string, text: string, from = 0): number {
  return indexOf(
    name,
    (r) => r.type === "user" && !r.isMeta && textOf(r).trim() === text.trim(),
    from
  );
}
