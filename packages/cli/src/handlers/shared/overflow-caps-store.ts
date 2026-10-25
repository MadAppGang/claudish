/**
 * #651 — durable store for LEARNED context caps.
 *
 * Until now `overflowCaps` (context-overflow.ts) lived in memory only: the hub
 * learned 229 645 for the vllm lane after the real wall at 07:20:58Z, and the
 * next recreate forgot it — reopening the lethal band between the engine's real
 * limit (262 144) and the reported floor (280 000) until the next refusal
 * re-learned it. Measured 2026-10-24 on the post-Gate-5b container: a `400
 * "Input too large"` 52 min after the recreate, with ZERO `learned` lines in
 * 18 821 log lines, because the engine's plain 400 is not the refusal shape
 * that teaches the cap.
 *
 * Where it lives: the CONFIG bind is mounted READ-ONLY in the container (the
 * host config directory → `/root/.claudish`), so this file must never default
 * to `~/.claudish` there. Persistence is therefore OPT-IN by path
 * (`CLAUDISH_OVERFLOW_CAPS_PATH`), and the compose default points it at the
 * writable `claudish-model-cache` volume next to `all-models.json`. Unset =
 * memory only, byte-identical to today (and keeps every unit test hermetic).
 *
 * Shape — keyed by (provider, model) exactly as the in-memory map is:
 *   { "version": 1,
 *     "caps": { "Vllm-myia::swift-1.5-27b": { "cap": 229645,
 *                                              "at": "2026-10-24T07:21:04.000Z",
 *                                              "evidence": "HTTP 400 input_tokens=…" } } }
 *
 * Expiry (#660 r1): a restored record is bounded by its own `at` stamp —
 * `CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS`, default 24 h (the effective pre-#651
 * lifetime, since the watchdog restarts the hub nightly), `0` = no expiry. A
 * record whose `at` cannot be parsed is not restored at all: its age cannot be
 * bounded, and the cost of not restoring is one relearning round-trip, never a
 * refused request. Rationale: a cap only ever moves DOWN (`rememberOverflowCap`
 * overwrites unconditionally and anything at/above the cap is short-circuited,
 * so the engine can never show the cap was wrong), and the overflow classifier
 * cannot always tell WHERE an overflow came from — vLLM uses the same wording
 * when the COMPLETION budget is what overflowed. Persistence alone would turn
 * such a mis-taught cap into a permanent refusal, and a cap below what the
 * client compacts down to re-creates the `/compact` loop #565 exists to avoid.
 * The timestamp and the evidence line are kept so a wrong entry can be
 * identified rather than guessed at.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PersistedOverflowCap {
  /** Rejected prompt estimate, in `estimatePayloadTokens` units. */
  cap: number;
  /** ISO-8601 — when the refusal that taught the cap was observed. */
  at: string;
  /** What produced it (upstream status + any stated counts). */
  evidence?: string;
  /**
   * #674 — the WINDOW the refusal itself states, when the body carries one
   * (vLLM: "This model's maximum context length is 262144 tokens"). Not an
   * estimate: the engine's own number, same trust class as a `deriveContextLimit`
   * probe, but observed on live traffic instead of at startup. Feeds the #676
   * corroboration only — never a refusal path of its own — and rides the same
   * record, TTL and purge as the cap. Latest statement wins (a rebuilt engine
   * with a different `max_model_len` says so on its next refusal).
   */
  statedLimit?: number;
}

/** One entry of the on-disk file. `at` is stamped when the cap is (re)learned; a restored record keeps its original stamp, which is exactly what the TTL is measured against (#660 r1). */
export type OverflowCapRecord = PersistedOverflowCap;

/**
 * The store path, or `undefined` when persistence is off.
 *
 * Explicit path only: an unset/empty variable means memory-only (compose
 * injects every listed name as "", #310 — "" must read as off, never as the
 * filesystem root).
 */
export function overflowCapsPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = (env.CLAUDISH_OVERFLOW_CAPS_PATH ?? "").trim();
  return explicit.length > 0 ? explicit : undefined;
}

function isValidEntry(value: unknown): value is PersistedOverflowCap {
  if (!value || typeof value !== "object") return false;
  const cap = (value as PersistedOverflowCap).cap;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0;
}

/**
 * Read the file. A missing, unreadable, corrupt or foreign-version file yields
 * an EMPTY map — never a throw, never a partial guess: this runs at startup and
 * a durable-state file must not be able to stop the proxy from booting.
 */
export function readOverflowCapsFile(path: string): Map<string, OverflowCapRecord> {
  const out = new Map<string, OverflowCapRecord>();
  const parsed = (() => {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as unknown;
    } catch {
      return undefined; // absent or unparseable — indistinguishable by design
    }
  })();
  // A foreign version is not ours to interpret: a future shape read with this
  // reader could mean something else, and a wrong cap refuses served requests.
  if ((parsed as { version?: unknown })?.version !== 1) return out;
  const caps = (parsed as { caps?: unknown })?.caps;
  if (!caps || typeof caps !== "object") return out;
  for (const [key, value] of Object.entries(caps as Record<string, unknown>)) {
    if (!key.includes("::")) continue; // only `provider::model` keys are ours
    if (!isValidEntry(value)) continue;
    out.set(key, {
      cap: Math.floor(value.cap),
      at: typeof (value as PersistedOverflowCap).at === "string" ? (value as PersistedOverflowCap).at : "",
      evidence: typeof (value as PersistedOverflowCap).evidence === "string" ? (value as PersistedOverflowCap).evidence : undefined,
      // #674 — keep only a finite positive statement; anything else means "not
      // stated" and must not smuggle NaN into a window comparison.
      statedLimit:
        Number.isFinite((value as PersistedOverflowCap).statedLimit) &&
        (value as PersistedOverflowCap).statedLimit! > 0
          ? Math.floor((value as PersistedOverflowCap).statedLimit!)
          : undefined,
    });
  }
  return out;
}

/**
 * Atomically replace the file (temp + rename, so a crash mid-write cannot leave
 * a truncated store). Returns false on any filesystem failure — a lost write
 * degrades to today's in-memory behaviour, which is never worse than the bug
 * this store fixes.
 */
export function writeOverflowCapsFile(path: string, records: ReadonlyMap<string, OverflowCapRecord>): boolean {
  const payload = { version: 1 as const, caps: Object.fromEntries(records) };
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    return false;
  }
}
