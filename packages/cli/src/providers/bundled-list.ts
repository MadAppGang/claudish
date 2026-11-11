/**
 * The bundled recommended list: a release-generated subset of the cloud models
 * catalog, shipped inside claudish for the case where no catalog can be read.
 * `readAllModelsCache` decides when it answers.
 *
 * The JSON and what names it are in `bundled-list-data.ts`. This module holds the
 * readers built on it, which need the routing and catalog code the data module
 * must stay free of.
 */
import { log } from "../logger.js";
import { type RecommendedModelsDoc, projectRecommendations } from "../model-loader.js";
import { readBundledList } from "./all-models-cache.js";
import { bundledFetchDate, bundledListRaw, bundledProvenance } from "./bundled-list-data.js";
import { catalogOrigin } from "./catalog-client.js";

export {
  type BundledProvenance,
  bundledFetchDate,
  bundledListLabel,
  bundledListRaw,
  bundledProvenance,
} from "./bundled-list-data.js";
// The setter that also drops the parsed list, so routing and provenance read one list.
export { _setBundledListForTest } from "./all-models-cache.js";
export { bundledEffortRecommendations } from "./effort-recommendations.js";

/** True when this process reads the bundled recommended list as its catalog. */
export function bundledListActive(): boolean {
  return catalogOrigin() === "bundled";
}

/** The recommendations the bundled list was generated with, or null when it has none. */
function bundledRecommendations() {
  const raw = bundledListRaw() as { bundle?: { recommendations?: unknown } } | null;
  const recommendations = raw?.bundle?.recommendations;
  return recommendations && typeof recommendations === "object"
    ? (recommendations as Parameters<typeof projectRecommendations>[0])
    : null;
}

/**
 * The bundled list as a recommended-models doc, the shape `list_models` renders.
 * Pure: with no per-model rich data every price is "N/A", and the timestamps are
 * the day the list was fetched. An unreadable bundle gives a doc with no models.
 */
export function bundledRecommendedModelsDoc(): RecommendedModelsDoc {
  const cache = readBundledList();
  const recommendations = bundledRecommendations();
  const provenance = bundledProvenance();
  if (cache && recommendations) {
    try {
      const fetchedAt = provenance ? Date.parse(provenance.fetchedAt) : Number.NaN;
      return projectRecommendations(
        recommendations,
        {
          catalogGenerationId: cache.catalogGenerationId,
          entries: cache.entries,
          plans: cache.plans,
        },
        [],
        Number.isFinite(fetchedAt) ? new Date(fetchedAt) : undefined
      );
    } catch (err) {
      log(
        `[catalog] bundled recommended list: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { version: provenance?.generationId ?? "", lastUpdated: "", models: [] };
}

/** The sentence that says a listing is the bundled recommended list, and which one. */
export function bundledListNote(): string {
  const provenance = bundledProvenance();
  if (!provenance) {
    return "No cloud models catalog could be read; this list is the bundled recommended list.";
  }
  const fetched = bundledFetchDate(provenance);
  return (
    `No cloud models catalog could be read; this list is the one bundled with claudish ${provenance.version} ` +
    `(bundled recommended list, generation ${provenance.generationId}${fetched ? `, fetched ${fetched}` : ""}).`
  );
}
