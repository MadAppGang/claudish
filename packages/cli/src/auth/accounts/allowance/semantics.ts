/**
 * Semantics first, then epochs (architecture §1.4, R4).
 *
 * A window's semantics are decided from how its `resetAt` moves, BEFORE any
 * epoch is cut: a sliding window's `resetAt` moves forward with every request,
 * so cutting epochs first would make every reading a new epoch and calibration
 * would never close a span.
 *
 * - A pair of consecutive readings is *stable* when `|ΔresetAt| ≤ EPOCH_TOL`,
 *   and *sliding evidence* when `resetAt` moves forward by more than EPOCH_TOL
 *   while the earlier `resetAt` has not passed. A pair that straddles an
 *   earlier `resetAt` already passed says nothing about either and is ignored.
 * - `sliding`: at least 2 evidence pairs and at least half of the pairs are
 *   evidence, over the last 20 pairs.
 * - `fixed-start`: at least 3 consecutive stable pairs and no evidence.
 * - `unknown`: otherwise; it simulates as `fixed-start`.
 *
 * `first-use` is not classified in v1 (R21).
 */

import type { AllowanceConfig, ReadingPoint, Semantics } from "./types.js";

/** Pairs inspected, newest last. */
const SEMANTICS_PAIRS = 20;
/** Float slack on fraction comparisons. */
const EPS = 1e-9;

type PairKind = "stable" | "sliding" | "other";

function pairKind(a: ReadingPoint, b: ReadingPoint, tolMs: number): PairKind | "ignored" {
  if (a.resetAt !== null && a.resetAt <= b.at) return "ignored";
  if (a.resetAt === null || b.resetAt === null) return "other";
  const delta = b.resetAt - a.resetAt;
  if (Math.abs(delta) <= tolMs) return "stable";
  if (delta > tolMs) return "sliding";
  return "other";
}

/** The semantics of one window from its readings (ascending `at`). */
export function classifySemantics(
  readings: readonly ReadingPoint[],
  cfg: Pick<AllowanceConfig, "EPOCH_TOL_MS">
): Semantics {
  const first = Math.max(0, readings.length - 1 - SEMANTICS_PAIRS);
  const kinds: PairKind[] = [];
  for (let i = first + 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    if (!a || !b) continue;
    const kind = pairKind(a, b, cfg.EPOCH_TOL_MS);
    if (kind !== "ignored") kinds.push(kind);
  }
  const evidence = kinds.filter((k) => k === "sliding").length;
  if (evidence >= 2 && evidence * 2 >= kinds.length) return "sliding";
  if (evidence === 0) {
    let run = 0;
    for (const kind of kinds) {
      run = kind === "stable" ? run + 1 : 0;
      if (run >= 3) return "fixed-start";
    }
  }
  return "unknown";
}

/**
 * Does `next` start a new epoch after a reading of the epoch whose current
 * `resetAt` is `epochResetAt`? Yes when that reset has passed, when `resetAt`
 * jumps beyond it by more than EPOCH_TOL, or when `usedFraction` drops by more
 * than 2 quanta with no reset passed (a banked or vendor reset).
 */
export function startsEpoch(
  prev: ReadingPoint,
  epochResetAt: number | null,
  next: ReadingPoint,
  quantum: number,
  cfg: Pick<AllowanceConfig, "EPOCH_TOL_MS">
): boolean {
  if (epochResetAt !== null && epochResetAt <= next.at) return true;
  if (
    epochResetAt !== null &&
    next.resetAt !== null &&
    next.resetAt - epochResetAt > cfg.EPOCH_TOL_MS
  )
    return true;
  return prev.usedFraction - next.usedFraction > 2 * quantum + EPS;
}

/**
 * The epoch index of every reading (ascending `at`). A sliding window has no
 * epochs: every reading is in epoch 0. Burn and calibration never cross an
 * epoch, so 98 % → 2 % across a reset is not a negative burn.
 */
export function epochOf(
  readings: readonly ReadingPoint[],
  semantics: Semantics,
  quantum: number,
  cfg: Pick<AllowanceConfig, "EPOCH_TOL_MS">
): number[] {
  const out: number[] = [];
  let epoch = 0;
  let epochResetAt: number | null = null;
  let prev: ReadingPoint | null = null;
  for (const reading of readings) {
    if (
      prev !== null &&
      semantics !== "sliding" &&
      startsEpoch(prev, epochResetAt, reading, quantum, cfg)
    ) {
      epoch++;
      epochResetAt = reading.resetAt;
    } else {
      // Inside an epoch `resetAt` is stable within tolerance; track the latest.
      epochResetAt = reading.resetAt ?? epochResetAt;
    }
    out.push(epoch);
    prev = reading;
  }
  return out;
}
