/**
 * Requested model -> the uid the Devin backend actually serves.
 *
 * This is now a THIN DELEGATE over the shared model-resolver seam
 * (`providers/model-resolvers/`). The rules, and the measurements behind them,
 * live in `model-resolvers/devin.ts`; this file exists only so the transport can
 * keep passing a `DevinModelConfig[]` roster without knowing about the seam.
 *
 * ## Why the logic moved
 *
 * The previous implementation parsed the reasoning tier out of the uid SPELLING
 * and stripped only a `-fast` suffix. Measured against a real 170-uid roster,
 * that had two defects:
 *
 * - **The 1M variants were unreachable.** `glm-5-2-max-1m` does not end in a
 *   tier word, so it parsed as untiered and dropped out of ranking, while the
 *   exact-uid path returned `glm-5-2-1m` verbatim and ignored effort. No
 *   combination of family and effort could reach it.
 * - **`-priority` was invisible.** 32 uids carry it at ~2x the cost of the bare
 *   tier, and none of them parsed as tiered.
 *
 * Devin publishes what every uid IS — the row it belongs to, the level it sits
 * at, whether a speed premium is engaged — in `model_family_metadata`. The seam
 * reads that instead of guessing, and falls back to spelling only for the 12
 * uids that declare no effort axis.
 */

import type { EffortLevel } from "../../adapters/base-api-format.js";
import { devinRosterEntry } from "../model-resolvers/devin.js";
import { expandSelection } from "../model-resolvers/registry.js";
import type { DevinModelConfig } from "./devin-models.js";

/**
 * Resolve `requested` to a served uid against the LIVE roster.
 *
 * Total by construction: an unrecognised request is returned unchanged so the
 * backend can answer for itself, which is what lets the served-set-aware error
 * rewrite name what IS served rather than silently substituting a model.
 */
export function resolveDevinModelUid(
  requested: string,
  effort: EffortLevel | undefined,
  served: DevinModelConfig[]
): string {
  const trimmed = requested.trim();
  if (!trimmed || served.length === 0) return trimmed || requested;
  return expandSelection("devin", trimmed, served.map(devinRosterEntry), { effort });
}
