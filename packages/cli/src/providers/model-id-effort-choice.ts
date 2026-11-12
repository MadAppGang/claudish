/**
 * The one model-id choice for a connection that carries the effort in the model
 * id (`modelIdEffort`), shared by every Devin and Antigravity path: the
 * resolvers, the transport, the credential that builds the primary envelope,
 * the availability check and route gathering.
 *
 * The level comes from the request: the `--effort` pin or the effort Claude
 * Code sends. With no level, claudish decides (ai-docs/architecture/wire.md
 * "Recommended effort"):
 *  a. the recommended-effort table's `default` task type for the connection's
 *     CANONICAL model id, when that cell's `sendableOn` names this connection
 *     (route binding, `externalModelId`, encoding `model_id_switch`);
 *  b. else `medium`.
 * The level then goes through the map: `values[level]`, else the next higher
 * listed level, else the highest. The provider server's own default and the
 * catalog's `modelIdEffort.default` do not decide.
 */

import type { EffortLevel } from "../adapters/base-api-format.js";
import { isEffortLevel } from "../adapters/base-api-format.js";
import {
  type ModelIdEffortConnection,
  findModelIdEffortConnection,
} from "../adapters/model-catalog.js";
import type { ModelIdEffortLevel } from "../model-loader.js";
import {
  DEFAULT_TASK_TYPE,
  MODEL_ID_ENCODING,
  currentEffortRecommendations,
} from "./effort-recommendations.js";
import { type ModelIdEffortProvider, chooseModelIdForEffort } from "./model-id-effort.js";

/** The level a mapped base is sent at when nothing in the table names one. */
const NO_EFFORT_FALLBACK_LEVEL: ModelIdEffortLevel = "medium";

/**
 * The level a request with no effort is sent at on `found`: the table's
 * `default` cell for the connection's canonical model id when that cell may be
 * sent on this connection as a model-id switch, else `medium`.
 */
export function noEffortLevel(found: ModelIdEffortConnection): ModelIdEffortLevel {
  const cell = currentEffortRecommendations()?.efforts[found.modelId]?.[DEFAULT_TASK_TYPE];
  const route = found.connection.route;
  if (!cell || !route) return NO_EFFORT_FALLBACK_LEVEL;
  const level = cell.effort.toLowerCase();
  if (!isEffortLevel(level) || level === "none") return NO_EFFORT_FALLBACK_LEVEL;
  const namesThisConnection = cell.sendableOn.some(
    (on) =>
      on.routeId === route.routeId &&
      on.routeProfileId === route.routeProfileId &&
      on.externalModelId === found.connection.externalModelId &&
      on.encoding === MODEL_ID_ENCODING
  );
  return namesThisConnection ? level : NO_EFFORT_FALLBACK_LEVEL;
}

/**
 * The wire id the effort map of `requested`'s own connection on `provider`
 * chooses at `effort`, or undefined when no map applies or the map's id is not
 * sendable, and the provider's existing resolution decides.
 */
export function chooseConnectionModelId(
  requested: string,
  provider: string,
  effort: EffortLevel | undefined,
  account: ModelIdEffortProvider
): string | undefined {
  const found = findModelIdEffortConnection(requested, provider);
  if (!found) return undefined;
  return chooseModelIdForEffort(found.map, effort ?? noEffortLevel(found), account);
}
