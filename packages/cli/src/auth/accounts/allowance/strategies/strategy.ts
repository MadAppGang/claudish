/**
 * The selection rules behind ONE interface (architecture §1.6, revision 2 item
 * 1). Every rule is a heuristic; none is claimed to be optimal, and only the
 * simulator tournament (§4) may promote a new default.
 *
 * `STRATEGIES` is the deployable registry: the same object the pool's ranker
 * calls (§2.3) and `simulate` drives for alerts, so the alert model is the
 * deployed strategy by construction. `DEPLOYABLE` is exactly the config enum
 * (§2.5); the simulator's baselines (`governing-fefo`, `water-fill`) are never
 * in it.
 */

import type { Strategy, StrategyName } from "../types.js";
import { ebr } from "./ebr.js";
import { lookahead } from "./lookahead.js";
import { sticky } from "./sticky.js";

export type { Strategy } from "../types.js";

export const DEPLOYABLE = ["sticky", "ebr", "lookahead"] as const satisfies readonly StrategyName[];

// A deployable name missing from the list above stops this compiling.
type UnlistedStrategy = Exclude<StrategyName, (typeof DEPLOYABLE)[number]>;
const deployableComplete: [UnlistedStrategy] extends [never] ? true : never = true;
void deployableComplete;

export const STRATEGIES: Readonly<Record<StrategyName, Strategy>> = { sticky, ebr, lookahead };
