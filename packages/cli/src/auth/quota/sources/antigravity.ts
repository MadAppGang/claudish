/**
 * Antigravity (Gemini subscription) quota adapter.
 *
 * Antigravity offers two free usage readings, and neither consumes model quota,
 * which is what makes polling them legitimate under the rule "never spend quota
 * to measure quota". Codex, whose only fresh reading costs an inference
 * request, gets no `poll`.
 *
 * - Per MODEL: every record of the model list (`fetchAvailableModels`) carries
 *   the remaining fraction and reset time of the limit that model spends.
 * - Per GROUP: `retrieveUserQuotaSummary` returns the weekly and five-hour
 *   limits of each group of models, which is what the Antigravity CLI shows.
 *   A group names its models in prose only, so it cannot be tied to a model id.
 *
 * ## Which reading answers which question
 *
 * A session asks what the model it runs has left: that is the model's own
 * record, and nothing else. When the active model has no record, this reports
 * NOTHING rather than another model's figure; see `selectBucket` for the
 * measurement that forced that rule. The `claudish quota` listing has no
 * session and asks about the account: that is the group summary.
 */

import { log } from "../../../logger.js";
import {
  getValidAntigravityAccessToken,
  hasSharedAntigravityToken,
} from "../../antigravity-token.js";
import {
  type QuotaBucket,
  type QuotaSummaryGroup,
  getAntigravityTierDisplayName,
  retrieveModelQuota,
  retrieveUserQuotaSummary,
  setupAntigravityUser,
} from "../../antigravity-user.js";
import type { QuotaAdapter, QuotaPollContext } from "../adapter.js";
import { type PlanUsage, type QuotaCapability, type QuotaWindow, toUsedPct } from "../types.js";

/**
 * Shorten a model id for use as a window id, which the status line renders
 * verbatim in a tight one-line budget. "gemini-3.1-pro-preview-high" carries
 * far more than the bar can show; the family and tier are what identify it.
 */
export function shortenModelId(modelId: string): string {
  return modelId
    .replace(/^gemini-/, "")
    .replace(/-preview/, "")
    .replace(/-latest$/, "");
}

/**
 * Reasoning-tier suffixes the Antigravity backend appends to a model id.
 *
 * Longest-first, so "extra-low" is tested before "low" — otherwise
 * "…-extra-low" would strip to "…-extra" and match nothing.
 */
const REASONING_TIERS = ["extra-low", "medium", "tiered", "high", "low"] as const;

/** Used fraction of a bucket, or undefined when it reports no number. */
function usedPctOf(bucket: { remainingFraction?: number }): number | undefined {
  if (typeof bucket.remainingFraction !== "number") return undefined;
  return toUsedPct((1 - bucket.remainingFraction) * 100);
}

/**
 * Find the bucket for the model the session is actually running.
 *
 * ## Why there is no fallback
 *
 * An earlier version fell back to the most-consumed bucket when nothing
 * matched. Measured against a real Antigravity Ultra account on 2026-08-05,
 * the per-model quota call of that time returned buckets for only `gemini-2.5-flash`,
 * `-2.5-flash-lite`, `-2.5-pro` and `-3.1-flash-lite`, every one at 100%
 * remaining — a legacy Code Assist set that does not cover the Gemini 3.x
 * models an Antigravity subscription actually serves.
 *
 * With a fallback, a session on `gemini-3.6-flash` would have rendered
 * `2.5-flash:0%` — reporting ample quota for a model the user is not
 * spending. That is the same category of error MTL-76 exists to fix (showing
 * numbers for an account you are not using), so an unmatched model reports
 * NOTHING and the status line degrades silently, which it already handles.
 */
export function selectBucket(
  buckets: QuotaBucket[],
  activeModelId: string
): QuotaBucket | undefined {
  const usable = buckets.filter((b) => b.modelId && usedPctOf(b) !== undefined);
  if (usable.length === 0) return undefined;

  const exact = usable.find((b) => b.modelId === activeModelId);
  if (exact) return exact;

  // Only ONE inexact form is accepted: the routed spec is a bucket id plus a
  // reasoning-tier suffix ("gemini-3.1-flash-lite-high" for a
  // "gemini-3.1-flash-lite" bucket). That is the actual Antigravity id grammar.
  //
  // Loose prefix matching was tried and is dangerous. `startsWith` in either
  // direction made "gemini-2.5-flash-lite-high" match the *"gemini-2.5-flash"*
  // bucket, because the shorter sibling appears earlier in the array — reporting
  // 10% used when the model actually being spent was at 90%. It also matched
  // "gemini-2.5-p" to "gemini-2.5-pro" on a partial word, and let a bare
  // "gemini-2.5" bind to whichever variant happened to come first. Every one of
  // those reports a DIFFERENT model's quota, which is the precise failure this
  // adapter exists to avoid.
  for (const tier of REASONING_TIERS) {
    const suffix = `-${tier}`;
    if (!activeModelId.endsWith(suffix)) continue;
    const base = activeModelId.slice(0, -suffix.length);
    const match = usable.find((b) => b.modelId === base);
    if (match) return match;
  }

  // The other direction: the routed spec is a base id and the buckets are its
  // effort variants ("gemini-4-argon" for "gemini-4-argon-medium" and
  // "-high"). They are one model's limit only when every variant reports the
  // same number; variants that disagree report nothing.
  const variants = usable.filter((b) =>
    REASONING_TIERS.some((tier) => b.modelId === `${activeModelId}-${tier}`)
  );
  if (variants.length === 0) return undefined;
  const [first] = variants;
  const same = variants.every(
    (b) => b.remainingFraction === first.remainingFraction && b.resetTime === first.resetTime
  );
  return same ? { ...first, modelId: activeModelId } : undefined;
}

/** Build a window from one bucket. */
function windowFromBucket(bucket: QuotaBucket): QuotaWindow | undefined {
  const used = usedPctOf(bucket);
  if (used === undefined) return undefined;

  const window: QuotaWindow = {
    id: shortenModelId(bucket.modelId ?? "quota"),
    used_pct: used,
  };
  if (bucket.resetTime && !Number.isNaN(Date.parse(bucket.resetTime))) {
    window.resets_at = new Date(bucket.resetTime).toISOString();
  }
  return window;
}

/**
 * Turn a quota response into plan usage. Exported for testing.
 *
 * With an active model, reports that model's bucket ONLY (see `selectBucket`).
 * Without one — the `claudish quota` listing, which has no session context —
 * reports every bucket, since there the user is asking about the account
 * rather than about what a running session is spending.
 */
/**
 * The version encoded in a model id, as a comparable number, or `undefined`
 * when the id carries no model version.
 *
 * There are NO dates in a quota bucket, so "newest first" has to be read off
 * the version in the id. That makes the parser's rejections the important
 * part, not its accepted cases — a naive "first number wins" reads
 * `chat_20706` as version 20706 and pins Antigravity's tab-completion helper
 * permanently above every real model.
 *
 * Two rejections do that work:
 *   - the version must sit at the start or follow a `-`, so `chat_20706` /
 *     `tab_jump_…` (which use `_`, and are `tabModelIds` server-side, not agent
 *     models) never match;
 *   - a numeric run with a trailing letter is a size, not a version, so
 *     `gpt-oss-120b-medium` is not read as version 120.
 *
 * `-` and `.` are both accepted as separators because the vendors disagree:
 * `gemini-3.6-flash-high` is 3.6 and `claude-sonnet-4-6` is 4.6.
 *
 * THE INPUT IS A WINDOW ID, NOT A RAW MODEL ID. `windowFromBucket` runs
 * `shortenModelId` first, which strips the `gemini-` prefix — so what arrives
 * here is `3.6-flash-high`, with the version FIRST. An earlier revision
 * required a leading `-` and therefore failed to parse every gemini id,
 * dropping the whole family into the unversioned bucket where it sorted
 * alphabetically: 2.5-* above 3.6-*, i.e. exactly the complaint the sort
 * exists to fix, silently reintroduced.
 */
export function parseModelVersion(modelId: string): number | undefined {
  // Start-of-string or after a `-`, so underscore-delimited pseudo-models
  // cannot match; and a non-alphanumeric (or end) after the digits so `120b`
  // reads as a size rather than version 120.
  const match = modelId.match(/(?:^|-)(\d+(?:[.-]\d+)*)(?![0-9a-z])/i);
  if (!match) return undefined;
  const [major, minor] = match[1].split(/[.-]/);
  const value = Number(`${major}.${(minor ?? "0").slice(0, 3)}`);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Order windows newest-first, with unversioned ids last.
 *
 * Cross-vendor comparison is by raw version number, which is not a real
 * chronology — nothing says Claude 4.6 shipped after Gemini 3.6. It is kept
 * anyway because the alternative is a hardcoded vendor ranking, and the
 * property the listing actually needs is that a user's current models sit
 * above their retired ones. Within a vendor, which is where the confusion
 * was, the order is exactly right.
 */
export function compareModelRecency(a: QuotaWindow, b: QuotaWindow): number {
  const va = parseModelVersion(a.id);
  const vb = parseModelVersion(b.id);
  if (va === undefined && vb === undefined) return a.id.localeCompare(b.id);
  if (va === undefined) return 1;
  if (vb === undefined) return -1;
  if (vb !== va) return vb - va;
  // Same family: keep it deterministic rather than leaving Array.sort's
  // stability to decide (e.g. 3.6-flash-high / -low / -medium / -tiered).
  return a.id.localeCompare(b.id);
}

export function planFromBuckets(
  buckets: QuotaBucket[],
  activeModelId?: string
): PlanUsage | undefined {
  const windows: QuotaWindow[] = [];

  if (activeModelId) {
    const bucket = selectBucket(buckets, activeModelId);
    if (!bucket) return undefined;
    const w = windowFromBucket(bucket);
    if (w) windows.push(w);
  } else {
    for (const b of buckets) {
      const w = windowFromBucket(b);
      if (w) windows.push(w);
    }
    // Newest first. The account-wide listing is 24 windows deep, and in id
    // order the models a user actually runs (3.6-*, 3.5-*) sit below ones they
    // never will (2.5-*), so the useful half is off the bottom of the box.
    windows.sort(compareModelRecency);
  }

  if (windows.length === 0) return undefined;

  return {
    label: getAntigravityTierDisplayName(),
    windows,
    source: "provider",
    observed_at: new Date().toISOString(),
  };
}

/**
 * Turn the group summary into plan usage: one window per limit of each group,
 * in the server's order, named by the group and the limit's window
 * ("Gemini Models weekly"). A limit with no number is left out. Exported for
 * testing.
 */
export function planFromSummary(groups: QuotaSummaryGroup[]): PlanUsage | undefined {
  const windows: QuotaWindow[] = [];
  for (const group of groups) {
    for (const bucket of group.buckets ?? []) {
      const used = usedPctOf(bucket);
      if (used === undefined) continue;
      const name = [group.displayName, bucket.window].filter(Boolean).join(" ");
      const window: QuotaWindow = { id: name || bucket.bucketId || "quota", used_pct: used };
      if (bucket.resetTime && !Number.isNaN(Date.parse(bucket.resetTime))) {
        window.resets_at = new Date(bucket.resetTime).toISOString();
      }
      windows.push(window);
    }
  }
  if (windows.length === 0) return undefined;
  return {
    label: getAntigravityTierDisplayName(),
    windows,
    source: "provider",
    observed_at: new Date().toISOString(),
  };
}

/** Shared by `poll` and `fetchExplicit`: both take the same free reading. */
async function fetchPlan(ctx?: QuotaPollContext): Promise<PlanUsage | undefined> {
  try {
    const accessToken = await getValidAntigravityAccessToken();
    const { projectId } = await setupAntigravityUser(accessToken);
    if (!ctx?.modelId) {
      const summary = await retrieveUserQuotaSummary(accessToken, projectId);
      if (!summary?.groups?.length) return undefined;
      return planFromSummary(summary.groups);
    }
    const quota = await retrieveModelQuota(accessToken, projectId);
    if (!quota?.buckets.length) return undefined;
    return planFromBuckets(quota.buckets, ctx.modelId);
  } catch (err) {
    // Non-fatal by construction: a quota reading is never worth failing a
    // session or a command over.
    log(`[quota:antigravity] fetch failed: ${err}`);
    return undefined;
  }
}

export const antigravityQuotaAdapter: QuotaAdapter = {
  providerId: "antigravity",
  label: "Antigravity",

  capability(): QuotaCapability {
    return { kind: "endpoint" };
  },

  isAvailable(): boolean {
    try {
      return hasSharedAntigravityToken();
    } catch {
      return false;
    }
  },

  /**
   * Free metadata call, run on a TTL off the request path. This is NOT the old
   * step-5b behaviour: that awaited a fetch before every upstream request and
   * could add up to 2s of latency per turn.
   */
  poll(ctx?: QuotaPollContext): Promise<PlanUsage | undefined> {
    return fetchPlan(ctx);
  },

  /** Same endpoint — there is no more authoritative reading to pay for. */
  fetchExplicit(ctx?: QuotaPollContext): Promise<PlanUsage | undefined> {
    return fetchPlan(ctx);
  },
};
