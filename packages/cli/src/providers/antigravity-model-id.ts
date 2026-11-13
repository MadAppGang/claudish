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
  carriesEffortInModelId,
  findModelIdEffortConnection,
  lookupFamilyDefaultVariant,
} from "../adapters/model-catalog.js";
import {
  type ConnectionMapDecision,
  type ModelIdChoice,
  chooseConnectionModelId,
  existingResolutionChoice,
} from "./model-id-effort-choice.js";

/**
 * The account's dynamic models catalog as model-id resolution reads it: every
 * served id, the backend's default, and the ids the backend declares are not
 * selectable (internal, role-bound, retired), which discovery also drops.
 */
export interface AntigravityServedSet {
  servedIds: string[];
  defaultId: string | null;
  excludedIds?: ReadonlySet<string>;
}

/**
 * The served ids a dynamic models catalog describes, for a reader that holds
 * the list but not the in-process list of the account's served and excluded
 * ids (`peekServedAntigravityModels`): the
 * listed ids plus the served ids the backend excludes, which discovery keeps
 * beside the list (`AccountModelsList.excludedIds`) rather than in it. Without
 * them a requested excluded id looks unlisted, the exact-id step of
 * {@link resolveAntigravityServedModel} cannot see it, and a family default
 * answers with a sibling instead. No backend default: only the in-process
 * list carries one.
 */
export function antigravityServedSetOfList(
  listedIds: readonly string[],
  excludedIds: readonly string[] = []
): AntigravityServedSet {
  const listed = new Set(listedIds);
  const servedIds = [...listedIds, ...excludedIds.filter((id) => !listed.has(id))];
  return excludedIds.length > 0
    ? { servedIds, defaultId: null, excludedIds: new Set(excludedIds) }
    : { servedIds, defaultId: null };
}

/** Whether the backend declares `id` not selectable for this account. */
function isExcluded(served: AntigravityServedSet, id: string): boolean {
  return served.excludedIds?.has(id) ?? false;
}

/**
 * Whether the account serves `id` and the backend does not exclude it: the test
 * for sending a requested id as itself. An excluded id is never sent that way,
 * so a mapped base the backend excludes goes through its map instead.
 */
function servesSelectable(served: AntigravityServedSet, id: string): boolean {
  return served.servedIds.includes(id) && !isExcluded(served, id);
}

/**
 * What the connection's effort map decides for `req`: the id it chooses, the
 * level it looked up when that id cannot be sent, or undefined when the
 * connection publishes no map. A map id is sendable only when the account
 * serves it and the backend does not exclude it. Its spelling decides nothing:
 * a `-fast` id the map names is sent like any other.
 */
function mappedAntigravityModelId(
  req: string,
  served: AntigravityServedSet,
  effort: EffortLevel | undefined
): ConnectionMapDecision | undefined {
  return chooseConnectionModelId(req, "antigravity", effort, {
    sendable: (id) => (servesSelectable(served, id) ? id : undefined),
  });
}

/**
 * Whether the id `sent` carries the effort, so the body must carry no effort
 * control beside it: `sent` is an id an Antigravity effort map lists (a level or
 * `off`). Decided by the id actually sent on an attempt, never by the requested
 * one: a mapped base that falls back to an unmapped id, or a capacity retry to
 * one, still needs the body's control.
 */
export function antigravityCarriesEffortInModelId(sent: string): boolean {
  return carriesEffortInModelId(sent.trim(), "antigravity");
}

/**
 * The Gemini body for an attempt that sends `sent`: without the effort controls
 * (`thinkingLevel`, `thinkingBudget`) when `sent` carries the effort; unchanged
 * otherwise. `includeThoughts` and every other field are kept. Never mutates
 * `inner`, so every attempt shapes the same original dialect payload.
 */
export function antigravityBodyForModelId<T>(inner: T, sent: string): T {
  const body = inner as
    | { generationConfig?: { thinkingConfig?: Record<string, unknown> } }
    | null
    | undefined;
  const thinking = body?.generationConfig?.thinkingConfig;
  if (!thinking || typeof thinking !== "object") return inner;
  if (!("thinkingLevel" in thinking) && !("thinkingBudget" in thinking)) return inner;
  if (!antigravityCarriesEffortInModelId(sent)) return inner;
  const { thinkingLevel: _level, thinkingBudget: _budget, ...kept } = thinking;
  const generationConfig: Record<string, unknown> = { ...body?.generationConfig };
  if (Object.keys(kept).length > 0) generationConfig.thinkingConfig = kept;
  else delete generationConfig.thinkingConfig;
  return { ...body, generationConfig } as T;
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
 * is `requested` (`chooseConnectionModelId`):
 *  - an effort level → `values[effort]`, else the next higher listed level,
 *    else the highest listed level;
 *  - `none` → the published `off` id;
 *  - no effort → the recommended-effort table's `default` level for this
 *    connection, else `medium`, then as an effort level. The backend's
 *    `defaultId` does not decide. A served base with no effort is sent as itself,
 *    unless the backend excludes it.
 * Only an id the account's dynamic models catalog lists and the backend does
 * not exclude is sent. Otherwise, and with no map, it is
 * {@link resolveAntigravityModelId} over the account's selectable ids (served
 * and not excluded), with the cloud models catalog's family default
 * (`lookupFamilyDefaultVariant`) as its second rule. No rule reads the id's
 * spelling: a `-fast` or `-priority` id is chosen or avoided only by that data
 * (the account's list, `excludedIds`, the effort map), never by its name.
 *
 * A requested id the account lists that is NOT a mapped base (an exact
 * `gemini-4-carbon-low`) is sent unchanged before any of that: at any effort,
 * and even when the backend excludes it, so neither the family default nor a
 * variant rule replaces it. Exclusion gates only the mapped-base shortcut (an
 * excluded base goes through its map) and every automatic choice.
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
  served: AntigravityServedSet,
  effort?: EffortLevel
): string {
  return chooseAntigravityServedModel(requested, served, effort).id;
}

/**
 * {@link resolveAntigravityServedModel} with what decided the id: the level the
 * choice used and its source, for the envelope builders' debug line.
 */
export function chooseAntigravityServedModel(
  requested: string,
  served: AntigravityServedSet,
  effort?: EffortLevel
): ModelIdChoice {
  const req = requested.trim();
  // An exact listed id that is no connection's base is a fixed model: sent as
  // itself at any effort, excluded or not, before any family rule can move it.
  const isMappedBase = findModelIdEffortConnection(req, "antigravity") !== undefined;
  if (!isMappedBase && served.servedIds.includes(req)) {
    return { id: req, effort, source: "exact id" };
  }
  // A mapped base the account lists, requested with no effort, is sent as
  // itself: the backend then serves it at its own default.
  if (isMappedBase && !effort && servesSelectable(served, req)) {
    return { id: req, effort: undefined, source: "served base" };
  }
  const decision = mappedAntigravityModelId(req, served, effort);
  if (decision?.usable) return decision.choice;
  if (servesSelectable(served, req)) return existingResolutionChoice(req, effort, decision);
  // An automatic choice is never an id the backend excludes.
  const selectable = served.servedIds.filter((id) => !isExcluded(served, id));
  const defaultId =
    served.defaultId && selectable.includes(served.defaultId) ? served.defaultId : null;
  const id = resolveAntigravityModelId(
    requested,
    selectable,
    defaultId,
    lookupFamilyDefaultVariant(requested, "antigravity")
  );
  return existingResolutionChoice(id, effort, decision);
}
