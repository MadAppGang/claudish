/**
 * Antigravity model-id resolution: the id a request for a name is SENT as, read
 * from the account's dynamic models catalog and the cloud models catalog's
 * family default. No hardcoded model ids.
 *
 * Pure: no network, no credential and no transport state, so route gathering
 * can ask it synchronously. The transport, the credential (which builds the
 * primary envelope), the availability check and route gathering all share it.
 */

import type { EffortLevel } from "../adapters/base-api-format.js";
import {
  lookupConnectionModelIdEffort,
  lookupFamilyDefaultVariant,
} from "../adapters/model-catalog.js";
import { chooseModelIdForEffort, namesSpeedPremium } from "./model-id-effort.js";

/**
 * The id the connection's effort map chooses, or undefined when no map applies
 * and {@link resolveAntigravityModelId} decides.
 */
function mappedAntigravityModelId(
  requested: string,
  served: { servedIds: string[]; defaultId: string | null },
  effort: EffortLevel | undefined
): string | undefined {
  const req = requested.trim();
  if (!effort && served.servedIds.includes(req)) return undefined;
  const map = lookupConnectionModelIdEffort(req, "antigravity");
  if (!map) return undefined;
  return chooseModelIdForEffort(map, effort, {
    sendable: (id) => (served.servedIds.includes(id) && !namesSpeedPremium(id) ? id : undefined),
    serverDefault: (ids) =>
      served.defaultId && ids.includes(served.defaultId) ? served.defaultId : undefined,
    // `ids` is ordered highest effort first.
    fallback: (ids) => ids[0]!,
  });
}

/**
 * Reasoning-tier RANK — a LAST-RESORT rule, used only when neither the backend
 * nor the catalog names a default.
 *
 * Two authorities come first: the Antigravity backend's own
 * `defaultAgentModelId` (per-account, from fetchAvailableModels), and the slim
 * catalog's `routeVariant.isDefault` (per-family, e.g. `gemini-3.6-flash-high`
 * for family `gemini-3.6-flash`). This ordering only matters when both are
 * silent — a genuinely cold path. Lower number = stronger tier.
 */
const REASONING_TIER_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  "extra-low": 3,
  tiered: 4,
};

/** Rank a reasoning-tier suffix (the part after the family name). */
function rankReasoningSuffix(suffix: string): number {
  const rank = REASONING_TIER_RANK[suffix.toLowerCase()];
  return rank === undefined ? Number.MAX_SAFE_INTEGER : rank;
}

/**
 * Rank a FULL served id by its reasoning-tier suffix, for display ordering
 * (strongest tier first). A bare family id with no recognised suffix ranks
 * last. Same rule as `rankReasoningSuffix`, applied to a whole id — the caller
 * has served ids, not pre-split family/suffix pairs.
 */
export function rankAntigravityModel(modelId: string): number {
  const dash = modelId.lastIndexOf("-");
  if (dash === -1) return Number.MAX_SAFE_INTEGER;
  // "extra-low" is the one two-word suffix, so try the last TWO segments first.
  const parts = modelId.split("-");
  if (parts.length >= 2) {
    const twoWord = rankReasoningSuffix(`${parts[parts.length - 2]}-${parts[parts.length - 1]}`);
    if (twoWord !== Number.MAX_SAFE_INTEGER) return twoWord;
  }
  return rankReasoningSuffix(modelId.slice(dash + 1));
}

/**
 * Resolve a user-supplied model id to the id the Antigravity backend serves,
 * using ONLY the account's dynamic models catalog (from fetchAvailableModels). No
 * pinned model ids — the served ids and the default come from the account's own
 * subscription.
 *
 * Rules (pure, exported for testing):
 *  1. Exact hit — `servedIds` contains `requested` → return it.
 *  2. CATALOG — the slim catalog's `routeVariant.isDefault` names this family's
 *     default variant (e.g. `gemini-3.1-pro-high` for `gemini-3.1-pro-preview`).
 *     Taken when that id is actually served. This is the ONLY rule that can
 *     bridge a catalog id whose stem differs from the backend's — the served id
 *     `gemini-3.1-pro-high` does not extend `gemini-3.1-pro-preview-`, so the
 *     prefix rule below cannot see it, and the request 404s.
 *  3. Family variants — served ids that are exactly `requested-<tier>`, where
 *     the whole remainder is one reasoning tier of `REASONING_TIER_RANK` (e.g.
 *     `gemini-3.6-flash-high` or `-extra-low` for `gemini-3.6-flash`). A longer
 *     id that merely extends the name (`gemini-3.6-flash-tts`,
 *     `gemini-3.6-flash-lite-tts`, `gemini-3.6-flash-5-high`) is a different
 *     model and never a variant. The tier is matched as spelled, like the
 *     requested id itself. If any exist:
 *       - if the backend `defaultId` is one of them → return `defaultId`;
 *       - else the strongest reasoning tier by suffix RANK.
 *  4. Otherwise — return `requested` unchanged and let the backend 404, which
 *     the 404 rewrite (F1–F7) checks against the dynamic models catalog and
 *     turns into an actionable error.
 *
 * `catalogDefault` is injected rather than looked up inside, so the function
 * stays pure and testable.
 */
export function resolveAntigravityModelId(
  requested: string,
  servedIds: string[],
  defaultId: string | null,
  catalogDefault?: string | null
): string {
  const req = requested.trim();

  if (servedIds.includes(req)) return req;

  if (catalogDefault && servedIds.includes(catalogDefault)) return catalogDefault;

  const familyPrefix = `${req}-`;
  const variants = servedIds.filter(
    (id) =>
      id.startsWith(familyPrefix) &&
      Object.hasOwn(REASONING_TIER_RANK, id.slice(familyPrefix.length))
  );
  if (variants.length > 0) {
    if (defaultId && variants.includes(defaultId)) return defaultId;
    let best = variants[0];
    let bestRank = rankReasoningSuffix(best.slice(familyPrefix.length));
    for (const variant of variants.slice(1)) {
      const rank = rankReasoningSuffix(variant.slice(familyPrefix.length));
      if (rank < bestRank) {
        best = variant;
        bestRank = rank;
      }
    }
    return best;
  }

  return req;
}

/**
 * The id a request for `requested` at `effort` is SENT as.
 *
 * First the connection's effort map (`modelIdEffort`), when the cloud models
 * catalog publishes one for the Antigravity connection whose `externalModelId`
 * is exactly `requested`:
 *  - an effort level → `values[effort]`, else the next higher listed level,
 *    else the highest listed level;
 *  - `none` → the published `off` id;
 *  - no effort → the backend's `defaultId` when it is one of the map's ids, else
 *    the highest listed level. A served base with no effort is sent as itself.
 * Only an id the account's dynamic models catalog lists, and that carries no
 * speed premium, is sent. Otherwise, and with no map, it is
 * {@link resolveAntigravityModelId} over the account's full dynamic models
 * catalog (`servedIds`), with the cloud models catalog's family default
 * (`lookupFamilyDefaultVariant`) as its second rule. A requested id that is not
 * a mapped base (an exact `gemini-4-carbon-low`) is never re-resolved by effort.
 *
 * The ONE resolution the transport, the credential (which builds the primary
 * envelope), the routing availability check (`providerServesModel`) and route
 * gathering share. The check used to match the requested id exactly, so
 * `ag@gemini-3.8-flash` read as not served on an account serving only
 * `gemini-3.8-flash-tiered`, which the transport would have sent, and a bare
 * name lost its `ag@` hop.
 */
export function resolveAntigravityServedModel(
  requested: string,
  served: { servedIds: string[]; defaultId: string | null },
  effort?: EffortLevel
): string {
  const mapped = mappedAntigravityModelId(requested, served, effort);
  if (mapped) return mapped;
  return resolveAntigravityModelId(
    requested,
    served.servedIds,
    served.defaultId,
    lookupFamilyDefaultVariant(requested, "antigravity")
  );
}
