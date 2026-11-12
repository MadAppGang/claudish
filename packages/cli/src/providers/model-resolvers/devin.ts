/**
 * Devin's model resolver — 170 served uids into ~40 rows, and back again.
 *
 * ## What Devin actually publishes
 *
 * Devin encodes reasoning tier, speed premium, and context window in the model
 * *uid* rather than in request parameters, so `GetCliModelConfigs` answers with
 * 170 rows where a human recognises about 33 models. But it does NOT leave
 * those axes to be guessed: `model_family_metadata` (field 30) states, per uid,
 * the row it belongs to and the value it sits at on every knob. The field names
 * come from the `devin` binary's own serde strings, so they are the vendor's.
 *
 * This module therefore READS rather than parses. Uid spelling is a fallback,
 * used only for the 12 uids that declare no effort axis.
 *
 * ## The three rules, and the measurements behind them
 *
 * Measured against a real captured dynamic models catalog (see the session's `evidence.md`):
 *
 * 1. **Group by `model_family_label` x `contextWindow`.** Not by uid spelling:
 *    `-1m` appears on 7 uids while 97 natively-1M uids carry no suffix at all,
 *    so a spelling rule would be wrong on 93% of the cases it claims to cover.
 *    And NOT by the `1M Context` axis flag either — that flag means "the 1M
 *    upgrade is applied" and is absent on natively-1M models. `max_tokens` is
 *    the only thing that actually knows the window.
 *
 * 2. **The default within a row is `is_default_model_in_family`.** Verified
 *    well-formed: of 39 groups, 20 carry exactly one flag and NONE carries two.
 *    This replaces every rule we might invent, and the rules would have been
 *    wrong — Devin's default is curated, not cheapest
 *    (`claude-opus-4-6-thinking` x8 is the default over `claude-opus-4-6` x6).
 *    19 groups carry no flag, so a deterministic fallback is still required.
 *
 * 3. **A speed-premium variant is never selected automatically.** The
 *    `Fast Mode` axis's enabled flag is true for `-fast` AND `-priority` uids —
 *    i.e. it marks "a speed premium is engaged", which is the property that
 *    matters, since those cost ~2x (`gpt-5-6-sol-max` x200 vs
 *    `-max-priority` x400). Reaching one requires naming its uid exactly.
 *
 * ## Why context is a row here but a toggle in Devin's own CLI
 *
 * Devin toggles `1M Context` live. Claudish cannot: the window is written into
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` at process spawn and never revisited for the
 * life of the session. So an axis Devin treats as runtime is, for claudish, a
 * launch-time decision — which makes it a picker row. Effort is the opposite:
 * Claude Code sends it every request, so it stays runtime. The axes split
 * differently because the harness constraints differ, not because the model does.
 */

import { EFFORT_LEVELS, type EffortLevel, isEffortLevel } from "../../adapters/base-api-format.js";
import { lookupConnectionModelIdEffort } from "../../adapters/model-catalog.js";
import type { DevinModelConfig } from "../devin/devin-models.js";
import { SPEED_PREMIUM_SUFFIXES, chooseModelIdForEffort } from "../model-id-effort.js";
import type {
  ExpandContext,
  ModelChoice,
  ModelsCatalogEntry,
  ModelsCatalogVariant,
  ProviderModelResolver,
} from "./types.js";
import { groupKeyOf, nonEmpty } from "./types.js";

/** Axis keys Devin uses for the reasoning knob. Both appear in the dynamic models catalog. */
const EFFORT_AXIS_KEYS = ["effort", "reasoning effort"];

/** Axis key marking a speed premium. Its flag covers `-fast` AND `-priority`. */
const SPEED_AXIS_KEY = "fast mode";

/**
 * Uid suffixes that denote a speed premium, for the entries Devin declares no
 * axes for. Kept as a fallback only — the declared flag is the authority.
 */
const SPEED_SUFFIXES = SPEED_PREMIUM_SUFFIXES;

/**
 * Devin's effort vocabulary -> claudish's {@link EffortLevel}.
 *
 * Almost an identity after normalisation, because six of Devin's eight labels
 * already ARE canonical level names (`minimal` included). The single genuine
 * translation is `No Thinking`, which Devin uses interchangeably with `None`.
 */
function toEffortLevel(label: string | undefined): EffortLevel | undefined {
  const normalised = label?.toLowerCase().replace(/[^a-z]/g, "");
  if (!normalised) return undefined;
  if (normalised === "nothinking") return "none";
  return isEffortLevel(normalised) ? normalised : undefined;
}

/** Trailing `-tier[-modifier…]` on a uid. The fallback when no axis is declared. */
function effortFromUid(uid: string): EffortLevel | undefined {
  for (const part of uid.toLowerCase().split("-").reverse()) {
    if (isEffortLevel(part)) return part;
    if (!SPEED_SUFFIXES.includes(part) && part !== "1m") break;
  }
  return undefined;
}

/** The reasoning level a config represents: declared first, spelling second. */
export function devinEffortOf(config: DevinModelConfig): EffortLevel | undefined {
  const axis = config.axes.find((a) => EFFORT_AXIS_KEYS.includes(a.key.toLowerCase()));
  return toEffortLevel(axis?.label) ?? effortFromUid(config.uid);
}

/** Whether a config carries a cost-premium speed modifier: declared first, spelling second. */
export function devinHasSpeedPremium(config: DevinModelConfig): boolean {
  const axis = config.axes.find((a) => a.key.toLowerCase() === SPEED_AXIS_KEY);
  if (axis) return axis.enabled;
  return SPEED_SUFFIXES.some((suffix) => config.uid.toLowerCase().endsWith(`-${suffix}`));
}

/**
 * Does this string NAME a reasoning tier?
 *
 * Deliberately about the SPELLING of what the user asked for, not about what
 * the dynamic models catalog says the uid is — it answers a question about intent. Typing
 * `claude-opus-5-xhigh` names a tier and must be honoured verbatim even at
 * effort `low`. Typing `glm-5-2-1m` names a *context* variant and leaves the
 * tier open, so it resolves against the effort of the turn — which is exactly
 * how `glm-5-2-max-1m` becomes reachable at all.
 *
 * A false positive (a family whose name happens to contain a level word) merely
 * honours the request verbatim, which is the safe direction.
 */
function namesEffortTier(id: string): boolean {
  return id
    .toLowerCase()
    .split("-")
    .some((part) => isEffortLevel(part));
}

/** The premium modifiers a uid carries, for display and for the never-auto-select rule. */
function modifiersOf(config: DevinModelConfig): string[] {
  const parts = config.uid.toLowerCase().split("-");
  const named = SPEED_SUFFIXES.filter((suffix) => parts.includes(suffix));
  if (named.length > 0) return named;
  // Declared premium with no recognisable suffix — still must not auto-select.
  return devinHasSpeedPremium(config) ? ["premium"] : [];
}

/** Normalise a Devin dynamic models catalog row into the seam's provider-neutral shape. */
export function devinModelsCatalogEntry(config: DevinModelConfig): ModelsCatalogEntry {
  return {
    wireId: config.uid,
    displayName: config.displayName,
    contextWindow: config.contextWindow,
    groupLabel: config.groupLabel,
    family: config.family,
    costFactor: config.creditMultiplier,
    costTier: config.costTier,
    isFamilyDefault: config.isFamilyDefault,
    isRecommended: config.isRecommended,
    axes: config.axes,
    offer: config.promo ? { kind: "promo", expiresAt: config.promo.expiresAt } : undefined,
  };
}

/** Rebuild the Devin-shaped view a rule needs from a neutral `ModelsCatalogEntry`. */
function asConfig(entry: ModelsCatalogEntry): DevinModelConfig {
  return {
    uid: entry.wireId,
    displayName: entry.displayName ?? entry.wireId,
    contextWindow: entry.contextWindow ?? 0,
    maxOutput: 0,
    family: entry.family ?? "",
    groupLabel: entry.groupLabel,
    axes: entry.axes ?? [],
    creditMultiplier: entry.costFactor,
    costTier: entry.costTier,
    isFamilyDefault: entry.isFamilyDefault ?? false,
    isRecommended: entry.isRecommended ?? false,
  };
}

/**
 * Order candidates for the default-of-last-resort: cheapest band, then cheapest
 * multiplier, then shortest id. Every tie is broken, so the answer is stable
 * across reorderings of the dynamic models catalog — a picker whose default
 * moves between runs reads as a bug even when both answers are defensible.
 */
function byCost(a: ModelsCatalogEntry, b: ModelsCatalogEntry): number {
  const tier = (a.costTier ?? Number.MAX_SAFE_INTEGER) - (b.costTier ?? Number.MAX_SAFE_INTEGER);
  if (tier !== 0) return tier;
  const cost =
    (a.costFactor ?? Number.MAX_SAFE_INTEGER) - (b.costFactor ?? Number.MAX_SAFE_INTEGER);
  if (cost !== 0) return cost;
  const length = a.wireId.length - b.wireId.length;
  return length !== 0 ? length : a.wireId.localeCompare(b.wireId);
}

/**
 * The entry a group resolves to when no effort is requested — also the id the
 * picker shows for that row.
 *
 * Order: the vendor's own default (the cheapest, when a pool spanning several
 * groups carries more than one) -> cheapest **tier-less** non-premium ->
 * cheapest non-premium -> cheapest anything.
 *
 * The tier-less preference is load-bearing, not cosmetic. A representative that
 * names a tier gets honoured verbatim by `expand` (that is the whole point of
 * the explicit-tier rule), so choosing one would silently pin the row's effort
 * forever. Measured: the 1M GLM group has no vendor default and its cheapest
 * member is `glm-5-2-none-1m`, so picking "GLM-5.2 (1M)" from the picker would
 * have locked the session to no-thinking. `glm-5-2-1m` is the right face for
 * that row precisely because it leaves the tier open.
 *
 * The last two steps exist because a group whose every member names a tier, or
 * whose every member is premium, must still resolve to something — dropping it
 * from the picker would be worse than an imperfect representative.
 */
function defaultOf(group: ModelsCatalogEntry[]): ModelsCatalogEntry {
  const declared = group.filter((entry) => entry.isFamilyDefault).sort(byCost)[0];
  if (declared) return declared;
  const plain = group.filter((entry) => !devinHasSpeedPremium(asConfig(entry)));
  const pool = plain.length > 0 ? plain : group;
  const tierless = pool.filter((entry) => !namesEffortTier(entry.wireId));
  return [...(tierless.length > 0 ? tierless : pool)].sort(byCost)[0]!;
}

/** Group key: the vendor's row label, then the window — the two facts D1 rests on. */
function keyOf(entry: ModelsCatalogEntry): string {
  return `${groupKeyOf(entry)} ${entry.contextWindow ?? 0}`;
}

/** `1000000` -> `"1M"`, `200000` -> `"200K"`. Only used to disambiguate sibling rows. */
function formatWindow(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`.replace(".0M", "M")
    : `${Math.round(tokens / 1000)}K`;
}

export class DevinModelResolver implements ProviderModelResolver {
  readonly provider = "devin";

  collapse(modelsCatalog: ModelsCatalogEntry[]): ModelChoice[] {
    const groups = new Map<string, ModelsCatalogEntry[]>();
    for (const entry of modelsCatalog) {
      const key = keyOf(entry);
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }

    // A label with sibling rows at different windows needs the window shown to
    // be distinguishable; a label with only one row does not, and adding it
    // there would be noise on 36 of 39 families.
    const windowsPerLabel = new Map<string, Set<number>>();
    for (const entry of modelsCatalog) {
      const label = groupKeyOf(entry);
      const seen = windowsPerLabel.get(label) ?? new Set<number>();
      seen.add(entry.contextWindow ?? 0);
      windowsPerLabel.set(label, seen);
    }

    const choices: ModelChoice[] = [];
    for (const group of groups.values()) {
      const chosen = defaultOf(group);
      const label = groupKeyOf(chosen);
      const ambiguous = (windowsPerLabel.get(label)?.size ?? 1) > 1;
      const window = chosen.contextWindow ?? 0;

      const variants: ModelsCatalogVariant[] = group.map((entry) => {
        const config = asConfig(entry);
        return {
          wireId: entry.wireId,
          effort: devinEffortOf(config),
          modifiers: modifiersOf(config),
          costFactor: entry.costFactor,
        };
      });

      choices.push({
        id: chosen.wireId,
        displayName: ambiguous && window > 0 ? `${label} (${formatWindow(window)})` : label,
        contextWindow: chosen.contextWindow,
        variants,
        costFactor: chosen.costFactor,
        offer: chosen.offer,
        isRecommended: chosen.isRecommended,
      });
    }
    return choices;
  }

  /**
   * A selection + this turn's effort -> the uid to send.
   *
   * 0. **The connection's effort map** (`modelIdEffort`), read from the cloud
   *    models catalog for the connection whose `externalModelId` is exactly the
   *    selection: `values[effort]`, else the next higher listed level, else the
   *    highest; `off` for `none`; with no effort, the vendor's family default
   *    among the map's ids, else the cheapest. Only an id the dynamic models
   *    catalog lists and that carries no speed premium is sent; otherwise the
   *    rules below decide. A listed base with no effort is sent as itself.
   * 1. **An exact uid** is honoured verbatim when the turn carries no effort, or
   *    when the uid NAMES a tier — `dv@claude-opus-5-xhigh` stays xhigh even at
   *    effort `low`, and so does a row's representative that names a tier
   *    (`claude-opus-5-5-medium` is always medium). Otherwise it identifies a
   *    group and re-resolves within it,
   *    which is what makes `dv@glm-5-2-1m` at effort `max` reach
   *    `glm-5-2-max-1m`; before this it was reachable by no request at all.
   * 2. **An exact vendor label or family id** resolves within the group it
   *    names — `claude-opus-5`, `glm-5.2`, `GLM-5.2`.
   * 3. **A base with effort siblings** — a name that is neither listed nor a
   *    family/label resolves only to listed `<base>-<effort>` ids, where the
   *    whole remainder is ONE effort name. `claude-opus-5` never reaches
   *    `claude-opus-5-5-high`; anything else falls to rule 4.
   * 4. **No usable match** passes through unchanged so the backend can answer.
   *    The error rewrite checks the dynamic models catalog and turns that into a
   *    message naming what IS served; guessing here would hide it.
   */
  expand(selection: string, modelsCatalog: ModelsCatalogEntry[], ctx: ExpandContext): string {
    const requested = selection.trim();
    if (!requested || modelsCatalog.length === 0) return requested || selection;

    const groups = new Map<string, ModelsCatalogEntry[]>();
    for (const entry of modelsCatalog) {
      const key = keyOf(entry);
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }

    const lower = requested.toLowerCase();
    const exact = modelsCatalog.find((entry) => entry.wireId.toLowerCase() === lower);

    // 0. The connection's effort map, when the catalog publishes one for this
    //    exact base on Devin's route.
    const mapped = mappedWireId(requested, exact, modelsCatalog, ctx.effort);
    if (mapped) return mapped;

    if (exact) {
      if (!ctx.effort) return exact.wireId;
      // An id that names a tier is that tier, at any effort — the group's
      // representative included.
      if (namesEffortTier(exact.wireId)) return exact.wireId;
      return pickForEffort(groups.get(keyOf(exact))!, ctx.effort).wireId;
    }

    // 2. An exact vendor label or family id. Unambiguous by construction — it
    //    names one model, even when that model spans two context groups.
    const named = modelsCatalog.filter((entry) => {
      const label = nonEmpty(entry.groupLabel)?.toLowerCase();
      const family = nonEmpty(entry.family)?.toLowerCase();
      return label === lower || family === lower;
    });

    // 3. Otherwise only the base's effort siblings: listed ids that are exactly
    //    `<base>-<effort>`. A uid prefix is not enough — `claude-opus-5-` also
    //    prefixes `claude-opus-5-5-high`, a different model, and `claude-opus`
    //    prefixes four of them. A request with no effort sibling falls to rule 4:
    //    the backend's error, rewritten against the dynamic models catalog,
    //    names what is served.
    const pool = named.length > 0 ? named : effortSiblings(lower, modelsCatalog);
    if (pool.length === 0) return requested;
    // Effort siblings pick among themselves, across whatever groups they sit in
    // and never among the other members of those groups: every sibling is the
    // requested base, so the answer is always `<base>-<effort>`.
    if (named.length === 0) return pickForEffort(pool, ctx.effort).wireId;

    // One label, possibly several context groups (GLM-5.2 is 200K and 1M): take
    // the group the vendor itself defaults to, else the cheapest. Sorted, not
    // first-match — `byCost` breaks every tie, so the answer cannot depend on
    // the order the dynamic models catalog happened to arrive in.
    const chosen =
      pool.filter((entry) => entry.isFamilyDefault).sort(byCost)[0] ?? pool.slice().sort(byCost)[0];
    return pickForEffort(groups.get(keyOf(chosen!))!, ctx.effort).wireId;
  }
}

/**
 * Rule 0 of `expand`: the uid the connection's effort map chooses, or undefined
 * when no map applies and the other rules decide.
 *
 * A listed base requested with no effort is left to rule 1 (sent as itself): the
 * provider then serves it at its own default.
 */
function mappedWireId(
  requested: string,
  exact: ModelsCatalogEntry | undefined,
  modelsCatalog: ModelsCatalogEntry[],
  effort: EffortLevel | undefined
): string | undefined {
  if (exact && !effort) return undefined;
  const map = lookupConnectionModelIdEffort(requested, "devin");
  if (!map) return undefined;

  const byId = new Map<string, ModelsCatalogEntry>();
  for (const entry of modelsCatalog) {
    const key = entry.wireId.toLowerCase();
    if (!byId.has(key)) byId.set(key, entry);
  }
  const entryOf = (id: string) => byId.get(id.toLowerCase());
  const entriesOf = (ids: string[]) =>
    ids.map(entryOf).filter((entry): entry is ModelsCatalogEntry => entry !== undefined);

  return chooseModelIdForEffort(map, effort, {
    sendable: (id) => {
      const entry = entryOf(id);
      return entry && !devinHasSpeedPremium(asConfig(entry)) ? entry.wireId : undefined;
    },
    serverDefault: (ids) =>
      entriesOf(ids)
        .filter((entry) => entry.isFamilyDefault)
        .sort(byCost)[0]?.wireId,
    fallback: (ids) => entriesOf(ids).sort(byCost)[0]?.wireId ?? ids[0]!,
  });
}

/**
 * The listed entries whose uid is exactly `<base>-<effort>`: the whole
 * remainder after `base-` is one effort name. `base` is lowercased.
 */
function effortSiblings(base: string, modelsCatalog: ModelsCatalogEntry[]): ModelsCatalogEntry[] {
  const prefix = `${base}-`;
  return modelsCatalog.filter((entry) => {
    const wireId = entry.wireId.toLowerCase();
    return wireId.startsWith(prefix) && isEffortLevel(wireId.slice(prefix.length));
  });
}

/**
 * The member of one group closest to the requested effort.
 *
 * Ties resolve UPWARD, matching `clampToAdvertisedEffort`: under-driving a
 * model is the worse failure. Premium variants are excluded entirely — they
 * cost ~2x and are reachable only by naming their uid.
 */
function pickForEffort(
  group: ModelsCatalogEntry[],
  effort: EffortLevel | undefined
): ModelsCatalogEntry {
  if (!effort) return defaultOf(group);

  const plain = group.filter((entry) => !devinHasSpeedPremium(asConfig(entry)));
  const pool = plain.length > 0 ? plain : group;

  const tiered = pool
    .map((entry) => ({ entry, effort: devinEffortOf(asConfig(entry)) }))
    .filter(
      (row): row is { entry: ModelsCatalogEntry; effort: EffortLevel } => row.effort !== undefined
    );
  if (tiered.length === 0) return defaultOf(group);

  const target = EFFORT_LEVELS.indexOf(effort);
  const ranked = tiered.slice().sort((a, b) => {
    const distanceA = Math.abs(EFFORT_LEVELS.indexOf(a.effort) - target);
    const distanceB = Math.abs(EFFORT_LEVELS.indexOf(b.effort) - target);
    if (distanceA !== distanceB) return distanceA - distanceB;

    const levelA = EFFORT_LEVELS.indexOf(a.effort);
    const levelB = EFFORT_LEVELS.indexOf(b.effort);
    if (levelA !== levelB) return levelB - levelA; // equidistant -> resolve upward

    // Same distance AND same level: the variants differ on some OTHER axis.
    // Real case — Claude Opus 4.6 declares `Effort=High` on both its plain and
    // its `-thinking` uid, which differ only in `Thinking` and in price (×6 vs
    // ×8). Falling back to first-encountered made the answer depend on the
    // order the dynamic models catalog arrived in, across 21 (label, effort) pairs and three
    // families, for swings up to 50%.
    const defaultA = a.entry.isFamilyDefault ? 0 : 1;
    const defaultB = b.entry.isFamilyDefault ? 0 : 1;
    if (defaultA !== defaultB) return defaultA - defaultB; // the vendor's own pick

    return byCost(a.entry, b.entry); // then cheapest; total, so never order-dependent
  });
  return ranked[0]!.entry;
}
