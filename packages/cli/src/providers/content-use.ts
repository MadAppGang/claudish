/**
 * Content-use opt-in wire ids, and the one place they are set aside.
 *
 * Some vendors publish a second wire id for one model whose use opts the
 * request's CONTENT into the vendor's product improvement:
 * `muse-spark-1.3-contributor` beside `muse-spark-1.3` on Meta's API, and
 * `…-contributor-free` beside the plain id on OpenCode Zen. The catalog maps
 * both as ordinary connections, so every reader that chooses a wire id for the
 * user (`externalIdFor`, the gatherer, a plan's wire id, the picker, a probe
 * pick) could choose the contributor one, and sometimes did: on generation
 * `g-20261015133900604-fb6199b5` OpenCode Go mapped only the contributor id for
 * `muse-spark-1.3`, so a bare `muse-spark-1.3` went to Go first, opted in.
 *
 * The project owner's decision (2026-10-16): a contributor id is NEVER chosen
 * implicitly, on any route. A user who types one exactly
 * (`meta@muse-spark-1.3-contributor`) gets it verbatim.
 *
 * Enforced where catalog data enters memory, not at each reader: every reader
 * found by `grep -rn aggregators` sits downstream of one of these points, and a
 * reader added later inherits the rule without knowing it exists.
 *
 *   - the slim catalog read from disk (`readAllModelsCache`) and the one just
 *     fetched (`refreshCatalog`, `_setCatalogEntriesForTest`) — {@link splitOptInConnections};
 *   - Firebase `ModelDoc`s (`fetchCatalogPage`) — {@link normaliseCatalogPayload};
 *   - hosted probe picks (`getProbeModel`), endpoint probe picks
 *     (`rankProbeCandidates`), dynamic models catalogs
 *     (`discoverProviderModelsCatalog`) and a resolver's expansion
 *     (`expandSelection`) — {@link isOptInWireId} directly.
 *
 * The opt-in rows are not deleted. They move to `optInConnections`, and only an
 * EXACT-id reader looks there ({@link allConnections}): the explicit-spec wire
 * lookup, `findConnection`'s exact step, the availability reverse lookup and the
 * registry validation.
 *
 * The connection's `contentUse` field wins: `contributor` opts in, `standard`
 * does not (2026-10-22). Missing fields and bare wire ids use the suffix rule,
 * the ONE wire-id name rule claudish keeps until every connection carries the
 * field (models-index M3).
 */
import type { AggregatorEntry } from "../model-loader.js";

/**
 * A wire id that opts the request's content into the vendor's product-improvement use.
 * Fallback for a connection without `contentUse`, or a reader holding only a wire id.
 */
export function isOptInWireId(wireId: string): boolean {
  return /-contributor(?:-free)?$/i.test(wireId.split("/").pop() ?? wireId);
}

/** Whether one catalog connection opts content in; its field wins over the suffix. */
function isOptInConnection(connection: AggregatorEntry): boolean {
  if ("contentUse" in connection) {
    if (connection.contentUse === "contributor") return true;
    if (connection.contentUse === "standard") return false;
  }
  return (
    typeof connection.externalModelId === "string" && isOptInWireId(connection.externalModelId)
  );
}

/**
 * The entry with its opt-in connections moved from `aggregators` to
 * `optInConnections`. Idempotent: an entry already split, or one with no opt-in
 * row, is returned unchanged (the same object), so a second pass costs nothing
 * and never loses the rows the first pass moved.
 */
export function splitOptInConnections<T extends { aggregators?: AggregatorEntry[] | null }>(
  entry: T
): T & { optInConnections?: AggregatorEntry[] } {
  const aggregators = entry.aggregators;
  if (!Array.isArray(aggregators) || !aggregators.some(isOptInConnection)) return entry;
  const existing = (entry as { optInConnections?: AggregatorEntry[] }).optInConnections ?? [];
  return {
    ...entry,
    aggregators: aggregators.filter((connection) => !isOptInConnection(connection)),
    optInConnections: [...existing, ...aggregators.filter(isOptInConnection)],
  };
}

/**
 * Every connection of an entry, opt-in rows included. For EXACT-id readers only:
 * a lookup that matches the wire id the user typed, or that validates every row.
 * A reader that CHOOSES a wire id reads `aggregators`, never this.
 */
export function allConnections(entry: {
  aggregators?: AggregatorEntry[] | null;
  optInConnections?: AggregatorEntry[];
}): AggregatorEntry[] {
  return [...(entry.aggregators ?? []), ...(entry.optInConnections ?? [])];
}

/**
 * {@link splitOptInConnections} over a catalog payload whose `models` array or
 * `model` object carries `ModelDoc`s. Any other payload (providers list,
 * recommendations) is returned unchanged.
 */
export function normaliseCatalogPayload<T>(data: T): T {
  if (!data || typeof data !== "object") return data;
  const payload = data as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...payload };
  if (Array.isArray(payload.models)) {
    next.models = payload.models.map((model) =>
      model && typeof model === "object"
        ? splitOptInConnections(model as { aggregators?: AggregatorEntry[] })
        : model
    );
    changed = true;
  }
  if (payload.model && typeof payload.model === "object") {
    next.model = splitOptInConnections(payload.model as { aggregators?: AggregatorEntry[] });
    changed = true;
  }
  return (changed ? next : data) as T;
}
