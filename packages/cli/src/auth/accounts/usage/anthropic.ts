/**
 * Anthropic response headers → `UsageSnapshot`.
 *
 * ```
 * anthropic-ratelimit-unified-<window>-utilization   0..1 (or a percentage)
 * anthropic-ratelimit-unified-<window>-reset         epoch seconds or ISO
 * anthropic-ratelimit-unified-status                 "allowed" | "rejected" | …
 * anthropic-ratelimit-unified-<window>-status        per-window, when present
 * anthropic-ratelimit-unified-reset                  the account-level reset
 * ```
 *
 * ## The window set is DISCOVERED, never pinned
 *
 * `5h` and `7d` are what today's accounts report, and nothing here depends on
 * that: the header names are scanned for the `-utilization` suffix and whatever
 * window names appear become the snapshot's windows. Hardcoding the pair would
 * make a vendor-side window change look like "this account reports no usage",
 * which is indistinguishable from an account claudish has never contacted — and
 * the repo has a standing rule against pinning a hardcoded model list for exactly
 * this reason.
 *
 * These unified headers are also the ONLY report of a claude.ai plan window that
 * exists. `NativeHandler` used to drop them wholesale, which made a quota 429
 * indistinguishable from a per-minute one; Phase 0 fixed the passthrough (item
 * (f) in ai-docs/architecture/accounts.md), and this module is what turns them
 * into something the policy can rank.
 *
 * ## The window's LENGTH comes out of its name
 *
 * Anthropic sends no length header; the duration is encoded inside the window
 * name, which is also the stable `slot`. `UsageWindow.lengthMinutes` is one
 * field for both vendors — Codex reads it from `x-codex-<slot>-window-minutes`
 * (`usage/codex.ts`) — so leaving Anthropic's as an unparsed token would make a
 * cross-vendor consumer re-parse a display string, and a string comparison gets
 * it exactly backwards: `"30d" < "5h"` lexically. That is the same "positions
 * are not durations" hazard the `slot`/`displayId` split exists to prevent,
 * mirrored.
 */

import type { UsageSnapshot, UsageWindow } from "../types.js";

const PREFIX = "anthropic-ratelimit-unified-";
const UTILIZATION = /^anthropic-ratelimit-unified-(.+)-utilization$/;

/**
 * Minutes encoded by a DISCOVERED window name, or `undefined`.
 *
 * Nothing here pins a fixed list of window names: any `<count><unit>` name yields a length,
 * and an unrecognised shape yields `undefined` rather than a guess.
 * `lengthMinutes` is optional precisely so "the vendor did not say" stays
 * distinguishable from a fabricated duration — inventing one would be the
 * discovery rule's own failure mode, one level down.
 */
const NAME_UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10_080 };
const WINDOW_NAME = /^(\d+)([mhdw])$/;

function lengthMinutesFromName(windowName: string): number | undefined {
  const match = WINDOW_NAME.exec(windowName);
  if (!match) return undefined;
  const count = Number.parseInt(match[1] as string, 10);
  const unit = NAME_UNIT_MINUTES[match[2] as string];
  if (!Number.isFinite(count) || count <= 0 || unit === undefined) return undefined;
  return count * unit;
}

/**
 * Parse a utilization value into a 0..1 fraction.
 *
 * Anthropic documents a fraction; a value above 1 is read as a percentage rather
 * than clamped to "full", because mistaking 41 (%) for 4100 % would exhaust a
 * healthy account on its first response.
 */
function toFraction(raw: string): number | null {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  const fraction = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, fraction));
}

/** Epoch ms from either an ISO 8601 string or epoch seconds. */
function toResetMs(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * True when Anthropic says this response was REJECTED for quota.
 *
 * The status header is what separates a plan-window rejection from an ordinary
 * per-minute 429, and only the former is a reason to switch accounts.
 */
export function isUnifiedQuotaRejection(status: number, headers: Headers): boolean {
  return status === 429 && headers.get(`${PREFIX}status`)?.trim() === "rejected";
}

/**
 * One discovered window, or null when its utilization value is unusable.
 *
 * Split out of `snapshotFromAnthropicHeaders` so neither function carries both
 * the discovery loop and the per-window derivation.
 */
function windowFrom(
  headers: Headers,
  windowName: string,
  rawUtilization: string,
  accountStatus: string | undefined
): UsageWindow | null {
  const usedFraction = toFraction(rawUtilization);
  if (usedFraction === null) return null;

  const lengthMinutes = lengthMinutesFromName(windowName);
  const perWindowStatus = headers.get(`${PREFIX}${windowName}-status`)?.trim();
  const resetAt = toResetMs(
    headers.get(`${PREFIX}${windowName}-reset`) ?? headers.get(`${PREFIX}reset`)
  );

  return {
    // Anthropic's window NAME is already stable ("5h", "7d"), so slot and
    // displayId coincide — unlike Codex, where the position and the formatted
    // duration are two different things.
    slot: windowName,
    displayId: windowName,
    ...(lengthMinutes === undefined ? {} : { lengthMinutes }),
    usedFraction,
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(perWindowStatus === "rejected" ||
    (accountStatus === "rejected" && perWindowStatus === undefined && usedFraction >= 1)
      ? { rejected: true }
      : {}),
  };
}

/** Build a snapshot from an Anthropic response's headers, or null if silent. */
export function snapshotFromAnthropicHeaders(
  headers: Headers,
  now: number = Date.now()
): UsageSnapshot | null {
  const accountStatus = headers.get(`${PREFIX}status`)?.trim();

  // `forEach` rather than `entries()`: the latter is not in the DOM lib this
  // project typechecks against, and a cast would hide a real portability
  // question behind an assertion.
  const utilization: Array<[string, string]> = [];
  headers.forEach((value, name) => {
    if (UTILIZATION.test(name.toLowerCase())) utilization.push([name.toLowerCase(), value]);
  });

  const windows: UsageWindow[] = [];
  for (const [name, value] of utilization) {
    const windowName = UTILIZATION.exec(name)?.[1];
    if (windowName === undefined) continue;
    const window = windowFrom(headers, windowName, value, accountStatus);
    if (window !== null) windows.push(window);
  }

  if (windows.length === 0) return null;

  const label = headers.get(`${PREFIX}representative-claim`)?.trim();
  return {
    windows,
    observedAt: now,
    ...(label ? { label } : {}),
  };
}

/**
 * When does the rejected window reset?
 *
 * Preference order: the window the vendor flagged as rejected, then the account
 * level reset, then the earliest window reset. `undefined` means the caller must
 * synthesize an estimate and SAY that it did.
 */
export function rejectedResetAt(headers: Headers): number | undefined {
  const snapshot = snapshotFromAnthropicHeaders(headers);
  const rejected = snapshot?.windows.find((w) => w.rejected)?.resetAt;
  if (rejected !== undefined) return rejected;
  const accountLevel = toResetMs(headers.get(`${PREFIX}reset`));
  if (accountLevel !== undefined) return accountLevel;
  const earliest = (snapshot?.windows ?? [])
    .map((w) => w.resetAt)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b)[0];
  return earliest;
}
