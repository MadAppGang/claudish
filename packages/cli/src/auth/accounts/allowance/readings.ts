/**
 * `UsageSnapshot` → `WindowReading[]` (architecture §1.4), the one mapping the
 * ledger, the pool's ranker and the model all use, so a window has the same
 * key wherever it is read.
 *
 * **Window key.** A Codex slot is POSITIONAL (`primary`/`secondary`), so its key
 * is its length, `len:<minutes>`: primary = 7 d on Pro is a measured fact, and
 * keying by slot would break when the vendor swaps the slots. A named window
 * (Anthropic) is keyed by its name, because two per-model weekly windows can
 * share one length. With no length known, `slot:<slot>`.
 */

import type { AccountProvider, UsageSnapshot, UsageWindow } from "../types.js";
import { DEFAULT_ALLOWANCE_CONFIG } from "./constants.js";
import type { WindowKey, WindowReading } from "./types.js";

/** A window's `slot` and a named window key; anything else is dropped, never stored. */
const WINDOW_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,40}$/;

export function windowKey(provider: AccountProvider, window: UsageWindow): WindowKey {
  if (provider === "openai-codex") {
    return window.lengthMinutes !== undefined && Number.isInteger(window.lengthMinutes)
      ? `len:${window.lengthMinutes}`
      : `slot:${window.slot}`;
  }
  return window.slot;
}

/**
 * A snapshot's windows as readings, or null when it has none (no usable
 * snapshot, which is no information, §1.4). A window whose slot fails the name
 * pattern is dropped. `quantum` defaults to Codex's whole percent; Anthropic's
 * readings are exact.
 */
export function readingsFromSnapshot(
  provider: AccountProvider,
  usage: UsageSnapshot | null | undefined,
  quantumCodex: number = DEFAULT_ALLOWANCE_CONFIG.QUANTUM_CODEX
): WindowReading[] | null {
  if (!usage || usage.windows.length === 0) return null;
  const quantum = provider === "openai-codex" ? quantumCodex : 0;
  const readings: WindowReading[] = [];
  for (const window of usage.windows) {
    if (!WINDOW_NAME_PATTERN.test(window.slot)) continue;
    const length = window.lengthMinutes;
    readings.push({
      key: windowKey(provider, window),
      slot: window.slot,
      lengthMinutes: length !== undefined && Number.isInteger(length) && length > 0 ? length : null,
      usedFraction: Number.isFinite(window.usedFraction)
        ? Math.max(0, Math.min(1, window.usedFraction))
        : 0,
      resetAt:
        window.resetAt !== undefined && Number.isFinite(window.resetAt) && window.resetAt >= 0
          ? window.resetAt
          : null,
      rejected: window.rejected === true,
      quantum,
    });
  }
  return readings.length > 0 ? readings : null;
}
