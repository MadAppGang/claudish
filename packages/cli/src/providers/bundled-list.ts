/**
 * The bundled recommended list: a release-generated subset of the cloud models
 * catalog, shipped inside claudish for the case where no catalog can be read.
 * `readAllModelsCache` decides when it answers.
 *
 * The JSON is imported here and nowhere else. Its inferred type stops at this
 * file: everything past it reads `unknown` and validates, which keeps a 245 KB
 * literal type out of the rest of the type check.
 */
import shipped from "./bundled-recommended-list.json" with { type: "json" };

/** `undefined`: the shipped file. `null`: no bundled list at all. */
let rawOverride: unknown | null | undefined;

/** The bundled list's raw JSON, before validation; `null` when there is none. */
export function bundledListRaw(): unknown | null {
  return rawOverride === undefined ? (shipped as unknown) : rawOverride;
}

/** Replace the raw JSON for this process; `undefined` restores the shipped file. */
export function _setBundledListRawForTest(raw: unknown | null | undefined): void {
  rawOverride = raw;
}
