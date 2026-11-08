/**
 * Live divergence log.
 *
 * The offline corpus builder (corpus.ts) mines RECORDED transcripts. This is its
 * live counterpart: when the observer is enabled it appends what it saw during
 * real traffic to the same file, so both sources feed one dataset that new rules
 * can be written from.
 *
 * Every write is best-effort and fire-and-forget. A diagnostic log that can fail
 * a user's request would be worse than no log at all.
 */

import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../logger.js";

export interface LiveDivergence {
  source: "observer";
  ts: string;
  model: string;
  toolName: string;
  ruleId: string | null;
  confidence: number;
  note?: string;
  /** Path-like argument values only — never full arguments, never message text. */
  paths?: string[];
}

function defaultPath(): string {
  return join(homedir(), ".claudish", "behavior-divergences.jsonl");
}

/**
 * Append one observation. Never throws, never awaited by the request path.
 */
export async function recordLiveDivergence(
  entry: LiveDivergence,
  path: string = defaultPath()
): Promise<void> {
  try {
    await appendFile(path, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    // Directory missing, disk full, read-only home — all non-events here.
    log(`[hooks:observer] could not append divergence: ${err}`);
  }
}
