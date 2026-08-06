/**
 * Quota/plan-usage types.
 *
 * These describe the plan a session is actually SPENDING. Claude Code's own
 * status line renders Anthropic's 5h/7d rate limits, which under claudish
 * describe an account the session is not using at all — you watch Anthropic
 * consumption while spending a Codex or Antigravity subscription. The `plan`
 * key these types serialize into the token file is what lets a status line
 * show the right numbers.
 *
 * ## The consumer contract is FROZEN
 *
 * `magus/plugins/statusline/scripts/statusline.sh` already ships a reader for
 * this shape: it pulls `.plan.label` and `.plan.windows[].{id,used_pct,resets_at}`
 * out of `$CLAUDISH_TOKEN_FILE`, suppresses Anthropic's segment whenever
 * claudish is routing, and degrades silently when `.plan` is absent.
 *
 * Two consequences that are easy to get wrong:
 *
 * 1. `windows` is arbitrary-length with arbitrary ids. Nothing may assume
 *    "5h"/"7d" — a provider may expose one window, three, or none.
 * 2. **The consumer ignores keys it does not know.** Adding a `stale: true`
 *    flag would therefore render stale data as FRESH. Staleness has to be
 *    enforced on the producer side by OMITTING `plan` entirely, which is why
 *    `observed_at` below is deliberately not serialized.
 */

/** One rate-limit window of a subscription plan. */
export interface QuotaWindow {
  /** Arbitrary id, rendered verbatim by the status line (e.g. "5h", "7d"). */
  id: string;
  /** 0..100. The status line highlights >= 80 and inverts at >= 100. */
  used_pct: number;
  /** ISO 8601. Omitted when the window rolls continuously or the reset is unknown. */
  resets_at?: string;
}

/** Plan usage for the provider a session is actually spending. */
export interface PlanUsage {
  /** Human label, e.g. "Codex Pro". Rendered next to the windows. */
  label: string;
  windows: QuotaWindow[];
  /** Frozen enum in the consumer contract. */
  source: "provider";
  /**
   * ISO 8601, when these numbers were measured. PRODUCER-SIDE ONLY — never
   * serialized, because the frozen consumer would ignore it while still
   * rendering the values as current. Used purely to decide whether to omit.
   */
  observed_at: string;
}

/**
 * How — or whether — a provider can report its plan usage.
 *
 * The negative case is a first-class value rather than an absent registry
 * entry. Six of the eight subscription providers claudish supports expose no
 * usage surface at all; representing that by omission makes it
 * indistinguishable from an unimplemented feature, and guarantees the research
 * gets repeated.
 */
export type QuotaCapability =
  /**
   * A free, side-effect-free usage API. Pollable on a TTL off the request
   * path — it consumes no model quota, so measuring costs nothing.
   */
  | { kind: "endpoint" }
  /**
   * Usage rides the headers of real inference responses. Scraped from traffic
   * that is happening anyway; never probed, because a dedicated request would
   * spend the very quota it measures.
   */
  | { kind: "headers" }
  /** Researched and proven absent. Carries the evidence for that verdict. */
  | { kind: "none"; evidence: ProbeRecord }
  /** Not yet researched. */
  | { kind: "unknown" };

/**
 * Why a provider is believed to have no usage surface.
 *
 * Kept next to the registry entry rather than in a document so the verdict is
 * read at the point of decision, and so "is this still true?" has a date and a
 * list of what was actually tried attached to it.
 */
export interface ProbeRecord {
  /** ISO date the probe ran. */
  researched_at: string;
  /** What was tried and what came back. */
  probed: Array<{ what: string; result: string }>;
  conclusion: "no-surface" | "found-headers" | "found-endpoint" | "inconclusive";
  /** What would justify re-probing. */
  recheck_if?: string;
}

/** How long scraped/polled usage stays valid before `plan` is omitted. */
export const PLAN_TTL_MS = 15 * 60 * 1000;

/**
 * Minimum gap between polls of an "endpoint" provider.
 *
 * Comfortably shorter than PLAN_TTL_MS so a session in steady use always holds
 * a fresh reading, while a provider's usage API is still only touched a few
 * times an hour.
 */
export const PLAN_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** True when a reading is too old to publish. */
export function isPlanStale(plan: PlanUsage, now = Date.now()): boolean {
  const observed = Date.parse(plan.observed_at);
  if (Number.isNaN(observed)) return true;
  return now - observed > PLAN_TTL_MS;
}

/** Clamp to the 0..100 the status line expects; NaN becomes undefined. */
export function toUsedPct(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Epoch seconds → ISO 8601, or undefined when the input is not usable. */
export function epochSecondsToIso(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const ms = seconds * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
