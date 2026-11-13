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
import { log } from "../logger.js";
import type { ModelIdEffortLevel } from "../model-loader.js";
import {
  DEFAULT_TASK_TYPE,
  type EffortRecommendation,
  MODEL_ID_ENCODING,
  bundledEffortRecommendations,
  lookupModelEfforts,
} from "./effort-recommendations.js";
import { type ModelIdEffortProvider, chooseModelIdForEffort } from "./model-id-effort.js";

/** The level a mapped base is sent at when nothing in the table names one. */
const NO_EFFORT_FALLBACK_LEVEL: ModelIdEffortLevel = "medium";

/**
 * What decided the id a request is sent as:
 * - `request`: the request's effort (Claude Code's, `--effort` or
 *   `--effort-override`) through the connection's map;
 * - `catalog default`: no effort; the recommended-effort table's `default`
 *   cell for this connection gave the level;
 * - `medium fallback`: no effort and no usable `default` cell;
 * - `exact id`: the requested id, sent unchanged;
 * - `no map`: no map decided; the provider's existing resolution chose the id.
 */
export type ModelIdSource =
  | "request"
  | "catalog default"
  | "medium fallback"
  | "exact id"
  | "no map";

/** The id one request is sent as, the effort level the choice used, and its source. */
export interface ModelIdChoice {
  id: string;
  /** The level the choice used; undefined when the id depended on none. */
  effort: EffortLevel | undefined;
  source: ModelIdSource;
}

/**
 * Write the debug line naming the id a request is sent as. Model ids and the
 * level only: never a header, a credential or body text.
 */
export function logModelIdChoice(label: string, requested: string, choice: ModelIdChoice): void {
  log(
    `[${label}] sending model ${choice.id} for ${requested} ` +
      `(effort ${choice.effort ?? "none given"}, from ${choice.source})`
  );
}

/**
 * The table's `default` cell for `found`'s canonical model id, from the efforts
 * table of the SAME generation as the catalog the connection was read from:
 * the bundled list's own table for the bundled list, else the sidecar's row
 * for that generation. Another generation never answers, so a miss is
 * undefined rather than the newest table held.
 */
function defaultCell(found: ModelIdEffortConnection): EffortRecommendation | undefined {
  if (found.origin === "bundled") {
    const table = bundledEffortRecommendations();
    if (table?.generationId !== found.catalogGenerationId) return undefined;
    return table.efforts[found.modelId]?.[DEFAULT_TASK_TYPE];
  }
  const lookup = lookupModelEfforts(found.modelId, found.catalogGenerationId);
  return lookup.ok ? lookup.byTaskType[DEFAULT_TASK_TYPE] : undefined;
}

/**
 * The level a request with no effort is sent at on `found`, and its source: the
 * `default` cell of its own generation's table for the connection's canonical
 * model id when that cell may be sent on this connection as a model-id switch,
 * else `medium`.
 */
function noEffortLevel(found: ModelIdEffortConnection): {
  level: ModelIdEffortLevel;
  source: "catalog default" | "medium fallback";
} {
  const fallback = { level: NO_EFFORT_FALLBACK_LEVEL, source: "medium fallback" } as const;
  const cell = defaultCell(found);
  const route = found.connection.route;
  if (!cell || !route) return fallback;
  const level = cell.effort.toLowerCase();
  if (!isEffortLevel(level) || level === "none") return fallback;
  const namesThisConnection = cell.sendableOn.some(
    (on) =>
      on.routeId === route.routeId &&
      on.routeProfileId === route.routeProfileId &&
      on.externalModelId === found.connection.externalModelId &&
      on.encoding === MODEL_ID_ENCODING
  );
  return namesThisConnection ? { level, source: "catalog default" } : fallback;
}

/**
 * The wire id the effort map of `requested`'s own connection on `provider`
 * chooses at `effort`, with the level it used and that level's source, or
 * undefined when no map applies or the map's id is not sendable, and the
 * provider's existing resolution decides.
 */
export function chooseConnectionModelId(
  requested: string,
  provider: string,
  effort: EffortLevel | undefined,
  account: ModelIdEffortProvider
): ModelIdChoice | undefined {
  const found = findModelIdEffortConnection(requested, provider);
  if (!found) return undefined;
  const decided = effort ? { level: effort, source: "request" as const } : noEffortLevel(found);
  const id = chooseModelIdForEffort(found.map, decided.level, account);
  return id ? { id, effort: decided.level, source: decided.source } : undefined;
}
