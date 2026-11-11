/**
 * The bundled recommended list's data: the JSON and what names it.
 *
 * The JSON is imported here and nowhere else. Its inferred type stops at this
 * file: everything past it reads `unknown` and validates, which keeps a 245 KB
 * literal type out of the rest of the type check.
 *
 * This module imports no routing or catalog code, so `all-models-cache.ts` and
 * the routing displays can read it without a cycle. The readers built on it are
 * in `bundled-list.ts`.
 */
import { VERSION } from "../version.js";
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

export interface BundledProvenance {
  /** The claudish release this list shipped in. */
  version: string;
  generationId: string;
  fetchedAt: string;
}

/** Which release and catalog generation the bundled list came from, for a display to name. */
export function bundledProvenance(): BundledProvenance | null {
  const raw = bundledListRaw();
  if (!raw || typeof raw !== "object") return null;
  const { catalogGenerationId, bundle } = raw as {
    catalogGenerationId?: unknown;
    bundle?: { fetchedAt?: unknown };
  };
  if (typeof catalogGenerationId !== "string") return null;
  return {
    version: VERSION,
    generationId: catalogGenerationId,
    fetchedAt: typeof bundle?.fetchedAt === "string" ? bundle.fetchedAt : "",
  };
}

/** The day the list was fetched, `YYYY-MM-DD`; empty when the file does not say. */
export function bundledFetchDate(provenance: BundledProvenance): string {
  return provenance.fetchedAt.slice(0, 10);
}

/** `bundled recommended list (G, fetched YYYY-MM-DD)`: the words a routing display uses. */
export function bundledListLabel(): string {
  const provenance = bundledProvenance();
  if (!provenance) return "bundled recommended list";
  const fetched = bundledFetchDate(provenance);
  return `bundled recommended list (${provenance.generationId}${fetched ? `, fetched ${fetched}` : ""})`;
}
