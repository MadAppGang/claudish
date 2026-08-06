/**
 * Requested model → the uid the Devin backend actually serves.
 *
 * Pure and exported for testing, mirroring `resolveAntigravityModelId`. It is
 * resolved against the LIVE roster (`getServedDevinModels`) — there is no
 * hardcoded model list, no family table, and no pinned tier per model.
 *
 * ## Why this replaces a reasoning parameter entirely
 *
 * Devin encodes the reasoning tier in the uid SUFFIX. There is no effort field
 * in the request:
 *
 * ```
 * claude-opus-5-low      claude-opus-5-medium     claude-opus-5-xhigh
 * claude-opus-5-max-fast kimi-k3-high             glm-5-2 (no tier)
 * ```
 *
 * Claude Code already sends `output_config.effort` in exactly claudish's
 * {@link EffortLevel} vocabulary, so `dv@claude-opus-5` + effort `high` must
 * resolve to `claude-opus-5-high`. For this provider that IS the reasoning
 * knob — `applyNativeReasoning` has nothing to set.
 *
 * Note families are dotted (`glm-5.2`, `gpt-5.6-luna`) while uids are dashed
 * (`glm-5-2`, `gpt-5-6-luna-medium`), so both spellings are accepted as a family
 * request.
 *
 * The only literals here are the effort-tier ordering (imported, not restated)
 * and the `-fast` modifier — rules, not a roster.
 */

import { EFFORT_LEVELS, type EffortLevel, isEffortLevel } from "../../adapters/base-api-format.js";
import type { DevinModelConfig } from "./devin-models.js";

/** The `-fast` modifier that can follow a tier (e.g. `claude-opus-5-max-fast`). */
const FAST_SUFFIX = "-fast";

/**
 * Trailing tier suffix, built FROM the effort vocabulary so the two can never
 * drift. Longest-first so `-xhigh` is never mis-read as `-high`.
 */
const TIER_SUFFIX_RE = new RegExp(
  `-(${[...EFFORT_LEVELS].sort((a, b) => b.length - a.length).join("|")})$`,
  "i"
);

/** The reasoning tier a uid encodes, and whether it is a `-fast` variant. */
export interface DevinUidTier {
  /** null when the uid carries no recognised tier (e.g. `glm-5-2`). */
  tier: EffortLevel | null;
  fast: boolean;
}

/** Split a uid's trailing tier/`-fast` modifiers off. Pure. */
export function parseDevinUidTier(uid: string): DevinUidTier {
  let base = uid.trim();
  let fast = false;
  if (base.toLowerCase().endsWith(FAST_SUFFIX)) {
    fast = true;
    base = base.slice(0, -FAST_SUFFIX.length);
  }
  const match = base.match(TIER_SUFFIX_RE);
  const candidate = match?.[1]?.toLowerCase();
  return { tier: isEffortLevel(candidate) ? candidate : null, fast };
}

/** Position in the ascending effort ordering; -1 for an unrecognised level. */
function effortIndex(level: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(level);
}

/**
 * Resolve `requested` to a served uid.
 *
 * 1. **Exact uid hit** — the served roster contains it → return it verbatim. An
 *    explicit tier always beats the effort signal (`dv@claude-opus-5-xhigh` is
 *    honoured even at effort `low`).
 * 2. **Family hit** — a served row whose `family` equals `requested`, or whose
 *    uid extends `requested-`:
 *    a. `-fast` variants are excluded unless they are the only ones (asking for
 *       one explicitly lands on rule 1);
 *    b. with an effort, pick the variant whose tier is NEAREST it, breaking ties
 *       UPWARD — the same rule as `clampToAdvertisedEffort`, for the same reason:
 *       under-driving a model is the worse failure;
 *    c. with no effort, target the top of the vocabulary, which selects the
 *       strongest served tier (matching `resolveAntigravityModelId`'s behaviour
 *       when the backend offers no default).
 * 3. **No match** — return `requested` unchanged and let the backend answer.
 *    The served-set-aware error rewrite turns that into an actionable message
 *    naming what IS served; guessing here would hide it.
 */
export function resolveDevinModelUid(
  requested: string,
  effort: EffortLevel | undefined,
  served: DevinModelConfig[]
): string {
  const req = requested.trim();
  if (!req || served.length === 0) return req || requested;

  // 1. exact uid (case-insensitively, but always return the roster's spelling)
  const lower = req.toLowerCase();
  const exact = served.find((model) => model.uid.toLowerCase() === lower);
  if (exact) return exact.uid;

  // 2. family — by declared family name, or by uid prefix
  const prefix = `${lower}-`;
  const candidates = served.filter(
    (model) => model.family.toLowerCase() === lower || model.uid.toLowerCase().startsWith(prefix)
  );
  if (candidates.length === 0) return req; // 3. pass through

  const nonFast = candidates.filter((model) => !parseDevinUidTier(model.uid).fast);
  const pool = nonFast.length > 0 ? nonFast : candidates;
  if (pool.length === 1) return pool[0]!.uid;

  const tiered = pool
    .map((model) => ({ model, tier: parseDevinUidTier(model.uid).tier }))
    .filter(
      (entry): entry is { model: DevinModelConfig; tier: EffortLevel } => entry.tier !== null
    );
  // No variant advertises a tier — nothing to rank on; keep the roster's order.
  if (tiered.length === 0) return pool[0]!.uid;

  // No effort signal → target the top of the vocabulary = the strongest tier.
  const target = effort ? effortIndex(effort) : EFFORT_LEVELS.length - 1;

  let best = tiered[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of tiered) {
    const distance = Math.abs(effortIndex(entry.tier) - target);
    // `>` on a tie resolves upward (see rule 2b).
    if (
      distance < bestDistance ||
      (distance === bestDistance && effortIndex(entry.tier) > effortIndex(best.tier))
    ) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best.model.uid;
}
