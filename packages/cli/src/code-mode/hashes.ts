/**
 * The two hashes that tie a script's stored output to the history that
 * produced it. One implementation, used by the resume step (5r) when it
 * consumes a batch and by the input builder when it renders history, so both
 * compute the same key from the same results.
 *
 *  - `batchHash(k)` = sha256 over the canonical `(tool_use_id, is_error,
 *    content)` of batch k's nested results, in nested-call order; a missing
 *    result canonicalises as `(tool_use_id, "missing")`.
 *  - `completionKey` = sha256 over `batchHash(0) ‖ … ‖ batchHash(last)` of the
 *    batches the script consumed, in order.
 *
 * Identical history ⇒ identical key; a rewind that changed any batch's results
 * ⇒ a different key, so a stale output is never rendered for new results.
 */

import { createHash } from "node:crypto";
import { decodeNestedId } from "./ids.js";

/** One nested call of a batch and Claude Code's tool_result for it, if any. */
export interface BatchResultEntry {
  toolUseId: string;
  result?: { isError: boolean; content: unknown };
}

/** JSON with object keys sorted at every depth: a stable serialisation for hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",");
  return `{${body}}`;
}

/** Nested-call order: by decoded seq, then by id for anything that does not decode. */
function compareIds(a: string, b: string): number {
  const da = decodeNestedId(a);
  const db = decodeNestedId(b);
  if (da && db && da.seq !== db.seq) return da.seq - db.seq;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** sha256 hex of one batch's canonical results. */
export function batchHash(entries: readonly BatchResultEntry[]): string {
  const ordered = [...entries].sort((a, b) => compareIds(a.toolUseId, b.toolUseId));
  const hash = createHash("sha256");
  for (const entry of ordered) {
    const canonical = entry.result
      ? canonicalJson([entry.toolUseId, entry.result.isError === true, entry.result.content ?? ""])
      : canonicalJson([entry.toolUseId, "missing"]);
    hash.update(canonical);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** sha256 hex over the batch hashes of every batch the script consumed, in order. */
export function completionKey(batchHashes: readonly string[]): string {
  const hash = createHash("sha256");
  for (const h of batchHashes) {
    hash.update(h);
    hash.update("\n");
  }
  return hash.digest("hex");
}
