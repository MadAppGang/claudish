/**
 * The bundled recommended list: a release-generated subset of the cloud models
 * catalog, shipped inside claudish for the case where no catalog can be read.
 * `readAllModelsCache` decides when it answers.
 *
 * The JSON and what names it are in `bundled-list-data.ts`.
 */
export {
  type BundledProvenance,
  _setBundledListRawForTest,
  bundledFetchDate,
  bundledListLabel,
  bundledListRaw,
  bundledProvenance,
} from "./bundled-list-data.js";
