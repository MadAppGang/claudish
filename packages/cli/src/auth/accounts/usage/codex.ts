/**
 * Codex response headers → `UsageSnapshot`.
 *
 * Wraps `scrapeCodexHeaders` (the existing, measured scraper) and **restores the
 * stable slot id**, which that function deliberately throws away.
 *
 * ## Why the slot id has to be recovered here
 *
 * `windowFrom` replaces the slot's id with `formatWindowMinutes(minutes)`
 * whenever `window-minutes` is present, so production ids read `"5h"` / `"7d"`
 * and a slot reporting `minutes <= 0` is dropped entirely. Those formatted ids
 * are right for a status line and wrong for a THRESHOLD key: they change with the
 * user's plan, so `switchAtByWindow: {"7d": 0.8}` silently stops matching the
 * moment the vendor moves the window. Measured on a Pro account, the PRIMARY slot
 * was the seven-day window while the secondary reported zero — the opposite of
 * the long-standing assumption, which is exactly why the position and the
 * duration must both be carried:
 *
 * ```
 * {slot: "primary", displayId: "7d", lengthMinutes: 10080, usedFraction: 0.41}
 * ```
 *
 * `switchAtByWindow` keys on `slot`; the status line renders `displayId`.
 */

import { CODEX_WINDOW_SLOTS } from "../../quota/codex-window-slots.js";
import { scrapeCodexHeaders } from "../../quota/sources/codex.js";
import { formatWindowMinutes } from "../../quota/sources/codex.js";
import type { UsageSnapshot, UsageWindow } from "../types.js";

/**
 * Build a snapshot from a Codex response's headers.
 *
 * Returns null when the response carried no usable window — an error response,
 * or a proxy that stripped the headers. Absence is reported rather than a zero
 * invented, because a fabricated 0 % reads as "plenty of room left".
 */
export function snapshotFromCodexHeaders(
  headers: Headers,
  now: number = Date.now()
): UsageSnapshot | null {
  const windows: UsageWindow[] = [];

  for (const slot of CODEX_WINDOW_SLOTS) {
    const rawPct = headers.get(slot.pct);
    if (rawPct === null) continue;
    const pct = Number.parseFloat(rawPct);
    if (!Number.isFinite(pct)) continue;

    let lengthMinutes: number | undefined;
    let displayId: string = slot.fallbackId;
    const rawMinutes = headers.get(slot.minutes);
    if (rawMinutes !== null) {
      const minutes = Number.parseInt(rawMinutes, 10);
      // A zero-length window is a slot this plan does not use. Keeping it would
      // put a permanent 0 % window in the policy's input for a limit that does
      // not exist — and, worse, make the account look eternally empty.
      if (Number.isFinite(minutes) && minutes <= 0) continue;
      if (Number.isFinite(minutes)) {
        lengthMinutes = minutes;
        const formatted = formatWindowMinutes(minutes);
        if (formatted) displayId = formatted;
      }
    }

    // Codex reports resets as epoch SECONDS — not ms, not ISO.
    let resetAt: number | undefined;
    const rawReset = headers.get(slot.reset);
    if (rawReset !== null) {
      const seconds = Number.parseInt(rawReset, 10);
      if (Number.isFinite(seconds) && seconds > 0) resetAt = seconds * 1000;
    }

    windows.push({
      slot: slot.fallbackId,
      displayId,
      usedFraction: Math.max(0, Math.min(1, pct / 100)),
      ...(lengthMinutes === undefined ? {} : { lengthMinutes }),
      ...(resetAt === undefined ? {} : { resetAt }),
    });
  }

  if (windows.length === 0) return null;

  // The label comes from the existing scraper so there is one plan-label rule.
  const plan = scrapeCodexHeaders(headers);
  return {
    windows,
    observedAt: now,
    ...(plan?.label ? { label: plan.label } : {}),
  };
}
