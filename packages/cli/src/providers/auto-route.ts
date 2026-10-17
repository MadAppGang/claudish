/**
 * Lightweight provider-prefix tables.
 *
 * After commit 5 of the model-catalog and routing redesign, this file is no
 * longer the home of the routing chain logic — that lives in
 * `providers/routing-rules.ts` (`route()`), which gathers its candidates from
 * the cloud models catalog (`providers/route-candidates.ts`). What remains here
 * are the two derived lookup tables (canonical name → shortest @ prefix,
 * canonical name → display name) that the routing engine still needs, plus a
 * `FallbackRoute` type alias preserved for callers that imported it from here
 * pre-commit-5.
 *
 * Kept at the same path for import-stability across the codebase.
 */

import { getAllProviders } from "./provider-definitions.js";
import type { Route } from "./routing-rules.js";

/**
 * Reverse mapping: canonical provider name → shortest @ prefix for handler
 * creation. Derived from BUILTIN_PROVIDERS at module load.
 */
export const PROVIDER_TO_PREFIX: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const def of getAllProviders()) {
    if (def.shortestPrefix) {
      map[def.name] = def.shortestPrefix;
    }
  }
  return map;
})();

/** Display names — derived from BUILTIN_PROVIDERS. */
export const DISPLAY_NAMES: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const def of getAllProviders()) {
    map[def.name] = def.displayName;
  }
  return map;
})();

/**
 * Fallback route candidate. Identical shape to {@link Route} from
 * routing-rules.ts; kept as a type alias so existing imports
 * (`import type { FallbackRoute } from "./auto-route.js"`) keep working.
 */
export type FallbackRoute = Route;
