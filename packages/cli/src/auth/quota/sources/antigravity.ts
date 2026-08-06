/**
 * Antigravity (Gemini subscription) quota adapter.
 *
 * Antigravity is the only provider claudish supports that offers a real usage
 * API: `retrieveUserQuota` returns one bucket per served model, each with a
 * remaining fraction and a reset time. Crucially the call is FREE — it is a
 * metadata request that consumes no model quota — which is what makes polling
 * it legitimate under the rule "never spend quota to measure quota". Codex,
 * whose only fresh reading costs an inference request, gets no `poll`.
 *
 * ## Buckets are per-model, windows are not
 *
 * The status line renders a list of `{id, used_pct, resets_at}` windows, but
 * Antigravity reports per-MODEL capacity, not per time-window. Those are
 * different axes, so this adapter picks rather than aggregates: it reports the
 * bucket for the model the session is actually running. Averaging every served
 * model would produce a number describing nothing the user is spending, and
 * showing all of them would flood a one-line status bar.
 *
 * When the active model has no bucket, this reports NOTHING rather than
 * substituting another model's figure — see `selectBucket` for the measurement
 * that forced that rule.
 *
 * ## Import isolation (deliberate)
 *
 * `setupAntigravityUser` / `retrieveUserQuota` / `getAntigravityTierDisplayName`
 * currently live in `gemini-oauth.ts`. The `worktree-gemini-fix` branch deletes
 * that file and re-homes them in `antigravity-user.ts`. Every one of those
 * imports is confined to THIS module so that landing becomes a one-line edit
 * rather than a hunt across the quota subsystem.
 */

import { log } from "../../../logger.js";
import {
  getValidAntigravityAccessToken,
  hasSharedAntigravityToken,
} from "../../antigravity-token.js";
// ↓↓↓ the only gemini-oauth.js dependency in the quota subsystem — see above ↓↓↓
import {
  type QuotaBucket,
  getAntigravityTierDisplayName,
  retrieveUserQuota,
  setupAntigravityUser,
} from "../../gemini-oauth.js";
// ↑↑↑ on worktree-gemini-fix these move to ../../antigravity-user.js ↑↑↑
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
function usedPctOf(bucket: QuotaBucket): number | undefined {
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
 * `retrieveUserQuota` returned buckets for only `gemini-2.5-flash`,
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
  return undefined;
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
  }

  if (windows.length === 0) return undefined;

  return {
    label: getAntigravityTierDisplayName(),
    windows,
    source: "provider",
    observed_at: new Date().toISOString(),
  };
}

/** Shared by `poll` and `fetchExplicit` — both read the same free endpoint. */
async function fetchPlan(ctx?: QuotaPollContext): Promise<PlanUsage | undefined> {
  try {
    const accessToken = await getValidAntigravityAccessToken();
    const { projectId } = await setupAntigravityUser(accessToken);
    const quota = await retrieveUserQuota(accessToken, projectId);
    if (!quota?.buckets?.length) return undefined;
    return planFromBuckets(quota.buckets, ctx?.modelId);
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
