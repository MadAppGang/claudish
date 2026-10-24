/**
 * Codex `usage_limit_reached`, parsed STRUCTURALLY rather than sniffed for
 * words.
 *
 * ## Why the wording predicate is not enough here
 *
 * `hasQuotaExhaustionWording` answers "does this body talk about a spent
 * allowance", which is the right question for the fallback chain and the wrong
 * one for a rotation decision. A rotation needs two facts the prose does not
 * reliably carry:
 *
 *  1. that this really is the plan window and not a per-minute throttle, and
 *  2. WHEN the window resets, so the terminal message can name a time and the
 *     account can be marked exhausted until exactly then.
 *
 * The Codex backend reports both as structured fields (`resets_in_seconds` /
 * `resets_at`), and it reports the whole thing INSIDE an HTTP 200 stream as
 * well as in an HTTP error body — the in-stream copy is the one that used to
 * become an `[API Error: usage_limit_reached]` assistant text block and freeze a
 * recoverable state into the transcript.
 *
 * ## Shape tolerance is deliberate
 *
 * The field has been observed at several depths (`error.*`, `detail.*`, the
 * top level) and the reset has been observed as both a relative second count
 * and an absolute epoch. Rather than pin one shape, this walks the small set of
 * documented containers and accepts either reset form. `resetsAt` is always
 * normalised to epoch MILLISECONDS, whichever way it arrived.
 *
 * D8 (a real captured frame including its metadata prefix; the Phase V gates are
 * in ai-docs/architecture/accounts.md) is what finally pins the wording; until
 * then `type`/`code` recognition leads and the prose test is the backstop, never
 * the other way round.
 */

/** What a parsed usage-limit report carries. */
export interface CodexUsageLimit {
  /** The code as reported, e.g. `usage_limit_reached`. */
  code: string;
  /** The vendor's own message — used verbatim in the surfaced error. */
  message: string;
  /** Seconds until the window resets, when the vendor said so. */
  resetsInSeconds?: number;
  /** Absolute reset time in epoch MILLISECONDS, normalised from any input form. */
  resetsAt?: number;
  /** Plan name when reported (`plus`, `pro`, …) — display only. */
  plan?: string;
}

/** Codes that mean "the plan window is spent", not "slow down". */
const USAGE_LIMIT_CODES = new Set([
  "usage_limit_reached",
  "usage_limit_exceeded",
  "plan_usage_limit_reached",
  "quota_exceeded",
]);

/**
 * Prose backstop.
 *
 * Narrow on purpose: it must not catch `rate_limit_exceeded`'s "please slow
 * down", which is a transient throttle that a rotation would waste an account
 * on. Note that it does NOT overlap the sniffer's retryable prose fallback
 * (`/overloaded|try again later|temporarily unavailable|please retry/i`) —
 * Codex's real wording is "Try again AFTER <time>", which matches no
 * alternative there. That near-miss is exactly why the quota test must run
 * FIRST rather than rely on ordering luck.
 */
const USAGE_LIMIT_PROSE = /\b(usage limit|weekly limit|monthly limit|plan limit)\b/i;

/** Seconds-since-epoch values below this are treated as a relative duration. */
const EPOCH_SECONDS_FLOOR = 10_000_000_000; // ≈ 1970+317y in ms, ≈ 2286 in s

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/**
 * Normalise whatever the vendor called a reset time into epoch milliseconds.
 *
 * Accepts an ISO string, epoch seconds or epoch milliseconds. The seconds/ms
 * discrimination uses magnitude: an epoch in seconds cannot plausibly exceed
 * 1e10 until the year 2286, and an epoch in ms is always above it.
 */
function normalizeResetAt(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    const parsedIso = Date.parse(value);
    if (Number.isFinite(parsedIso)) return parsedIso;
  }
  const n = firstNumber(value);
  if (n === undefined || n <= 0) return undefined;
  return n >= EPOCH_SECONDS_FLOOR ? n : n * 1000;
}

/**
 * Parse a usage-limit report out of an error body or an in-stream error event.
 *
 * Accepts a raw JSON string or an already-parsed object, and returns `null`
 * when this is not a usage-limit report — including for a plain rate limit,
 * which must stay retryable.
 */
export function parseCodexUsageLimit(input: string | unknown): CodexUsageLimit | null {
  let root: any = input;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return null;
    try {
      root = JSON.parse(text);
    } catch {
      // Not JSON: the prose backstop is all that is left. A bare string that
      // says "usage limit" IS the vendor telling us the window is spent, and
      // discarding it would leave the account unmarked.
      return USAGE_LIMIT_PROSE.test(text)
        ? { code: "usage_limit_reached", message: text.slice(0, 1000) }
        : null;
    }
  }
  if (!root || typeof root !== "object") return null;

  // The documented containers, innermost first. `response.error` is the
  // in-stream `response.failed` shape; `detail` is the HTTP-body shape.
  const containers = [
    root.error,
    root.response?.error,
    root.detail,
    root.error?.detail,
    root,
  ].filter((c: unknown) => c && typeof c === "object");

  for (const container of containers) {
    const code = firstString(container.code, container.type, root.code, root.type) ?? "";
    const message = firstString(container.message, container.detail, root.message) ?? "";
    const isLimit = USAGE_LIMIT_CODES.has(code) || USAGE_LIMIT_PROSE.test(message);
    if (!isLimit) continue;

    const resetsInSeconds = firstNumber(
      container.resets_in_seconds,
      container.resetsInSeconds,
      container.retry_after_seconds,
      root.resets_in_seconds
    );
    const resetsAt = normalizeResetAt(
      container.resets_at ?? container.resetsAt ?? root.resets_at ?? root.resetsAt
    );
    const plan = firstString(container.plan_type, container.plan, root.plan_type);

    return {
      code: code || "usage_limit_reached",
      message: message || "Codex usage limit reached",
      ...(resetsInSeconds !== undefined && resetsInSeconds > 0 ? { resetsInSeconds } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(plan !== undefined ? { plan } : {}),
    };
  }
  return null;
}

/**
 * The reset instant in epoch ms, from whichever field the vendor supplied.
 *
 * `resets_in_seconds` is relative to WHEN THE RESPONSE WAS READ, so it is
 * resolved against a caller-supplied `now` rather than a captured module clock —
 * that is also the seam a test uses to assert an exact `exhaustedUntil`.
 */
export function resolveUsageLimitResetAt(
  limit: CodexUsageLimit,
  now: number = Date.now()
): number | undefined {
  if (limit.resetsAt !== undefined) return limit.resetsAt;
  if (limit.resetsInSeconds !== undefined) return now + limit.resetsInSeconds * 1000;
  return undefined;
}
