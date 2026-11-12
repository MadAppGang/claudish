/**
 * Effort carried in the model ID: choosing the wire id for a base and an effort
 * level from the connection's `modelIdEffort` map in the cloud models catalog.
 *
 * Some providers (Devin, Antigravity) have no effort parameter; each level is a
 * separate model id. The catalog publishes, per connection, which id the base
 * (`externalModelId`) is sent as at each level. This module reads that map. It
 * never derives an id from a name: every id it can return is a map value, and
 * the provider's caller decides whether the account may send it.
 *
 * Pure: no network, no credential, no catalog read. The lookup that finds the
 * map is `lookupConnectionModelIdEffort` (`adapters/model-catalog.ts`).
 */

import { EFFORT_LEVELS, type EffortLevel, isEffortLevel } from "../adapters/base-api-format.js";
import type { ModelIdEffort, ModelIdEffortLevel } from "../model-loader.js";

/**
 * Trailing id segments that mark a speed premium (`-fast`, `-priority`). An id
 * carrying one costs more than its plain sibling and is never chosen
 * automatically; it is sent only when the request names it exactly.
 */
export const SPEED_PREMIUM_SUFFIXES: readonly string[] = ["fast", "priority"];

/** Whether a wire id ends in a speed-premium segment. */
export function namesSpeedPremium(wireId: string): boolean {
  const lower = wireId.trim().toLowerCase();
  return SPEED_PREMIUM_SUFFIXES.some((suffix) => lower.endsWith(`-${suffix}`));
}

/**
 * Validate a raw `modelIdEffort` value. A malformed map is `undefined` (no map),
 * never an error: the connection stays usable and the provider resolves as it
 * did before the catalog published maps. Entries with an unknown level, a `none`
 * key or a non-string id are dropped one by one.
 */
export function readModelIdEffort(raw: unknown): ModelIdEffort | undefined {
  const record = asRecord(raw);
  if (!record || record.via !== "model_id") return undefined;
  const rawValues = asRecord(record.values);
  if (!rawValues) return undefined;

  const values: ModelIdEffort["values"] = {};
  for (const [level, id] of Object.entries(rawValues)) {
    const wireId = nonEmptyString(id);
    if (wireId && isEffortLevel(level) && level !== "none") values[level] = wireId;
  }
  const off = nonEmptyString(record.off);
  if (Object.keys(values).length === 0 && !off) return undefined;

  const map: ModelIdEffort = { via: "model_id", values };
  const rawDefault = asRecord(record.default);
  if (rawDefault && typeof rawDefault.status === "string") {
    map.default = { ...rawDefault, status: rawDefault.status };
  }
  if (off) map.off = off;
  if (typeof record.baseServed === "boolean") map.baseServed = record.baseServed;
  return map;
}

/** A plain object, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A trimmed non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The map's levels in descending order (highest effort first). */
function levelsDescending(map: ModelIdEffort): ModelIdEffortLevel[] {
  return EFFORT_LEVELS.filter(
    (level): level is ModelIdEffortLevel => level !== "none" && map.values[level] !== undefined
  ).reverse();
}

/**
 * The level the catalog states as the base's default, when it states one: a
 * `default` whose status is not `unknown` and which names a `values` key.
 */
function statedDefaultLevel(map: ModelIdEffort): ModelIdEffortLevel | undefined {
  const stated = map.default;
  if (!stated || stated.status === "unknown") return undefined;
  for (const [field, value] of Object.entries(stated)) {
    if (field === "status" || typeof value !== "string") continue;
    if (isEffortLevel(value) && value !== "none" && map.values[value] !== undefined) return value;
  }
  return undefined;
}

/**
 * The map id for an effort level: `values[effort]` when listed, else the next
 * higher listed level, else the highest listed level. Undefined only for an
 * empty `values`.
 */
export function mapIdForEffort(map: ModelIdEffort, effort: ModelIdEffortLevel): string | undefined {
  const exact = map.values[effort];
  if (exact) return exact;
  const levels = levelsDescending(map);
  if (levels.length === 0) return undefined;
  const rank = EFFORT_LEVELS.indexOf(effort);
  const higher = levels.filter((level) => EFFORT_LEVELS.indexOf(level) > rank);
  // `levels` is descending, so the last higher level is the NEXT one up.
  const chosen = higher.length > 0 ? higher[higher.length - 1]! : levels[0]!;
  return map.values[chosen];
}

/** How a provider answers the questions the map cannot. */
export interface ModelIdEffortProvider {
  /**
   * The account's own spelling of `id` when its dynamic models catalog lists it
   * AND it may be chosen automatically (not a speed premium); else undefined.
   */
  sendable(id: string): string | undefined;
  /** The provider server's own default among `ids` (sendable, highest effort first). */
  serverDefault(ids: string[]): string | undefined;
  /** The provider's rule when its server names no default among `ids`. */
  fallback(ids: string[]): string;
}

/**
 * The wire id the map chooses for one request, or `undefined` when the map does
 * not decide it and the provider's existing resolution applies.
 *
 * - `none`: the published `off` id when the account may send it.
 * - an effort level: {@link mapIdForEffort}, when the account may send that id.
 *   An id the account does not list, or a speed premium, is not replaced by
 *   another map id: the existing resolution answers instead.
 * - no effort: the provider server's default among the sendable map ids, then
 *   the catalog's stated default, then the provider's fallback rule.
 */
export function chooseModelIdForEffort(
  map: ModelIdEffort,
  effort: EffortLevel | undefined,
  provider: ModelIdEffortProvider
): string | undefined {
  if (effort === "none") return map.off ? provider.sendable(map.off) : undefined;

  if (effort !== undefined) {
    const id = mapIdForEffort(map, effort);
    return id ? provider.sendable(id) : undefined;
  }

  const ids: string[] = [];
  for (const level of levelsDescending(map)) {
    const id = provider.sendable(map.values[level]!);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return undefined;

  const server = provider.serverDefault(ids);
  if (server) return server;
  const statedLevel = statedDefaultLevel(map);
  const stated = statedLevel ? provider.sendable(map.values[statedLevel]!) : undefined;
  if (stated) return stated;
  return provider.fallback(ids);
}
