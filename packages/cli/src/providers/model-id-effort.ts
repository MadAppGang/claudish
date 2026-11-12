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
 * map is `findModelIdEffortConnection` (`adapters/model-catalog.ts`); the level
 * a request with no effort is sent at is decided in `model-id-effort-choice.ts`.
 */

import { EFFORT_LEVELS, type EffortLevel, isEffortLevel } from "../adapters/base-api-format.js";
import type { ModelIdEffort, ModelIdEffortLevel } from "../model-loader.js";

/**
 * Trailing uid segments that mark a Devin speed premium (`-fast`, `-priority`),
 * read by Devin's resolver only for an entry its discovery data declares no
 * axes for. Antigravity reads no spelling: its id choice comes from the
 * account's list, `excludedIds` and the effort map alone.
 */
export const SPEED_PREMIUM_SUFFIXES: readonly string[] = ["fast", "priority"];

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
  const statedDefault = nonEmptyString(record.default);
  const rawDefault = asRecord(record.default);
  if (statedDefault) map.default = statedDefault;
  else if (rawDefault && typeof rawDefault.status === "string") {
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

/** How a provider answers the question the map cannot. */
export interface ModelIdEffortProvider {
  /**
   * The account's own spelling of `id` when this provider may send it; else
   * undefined. Eligibility is provider-specific. Antigravity checks only that
   * the account's dynamic models catalog lists the id and the backend does not
   * exclude it (`excludedIds`). Devin also refuses a speed premium, read from
   * its discovery data (the `Fast Mode` axis flag, with
   * {@link SPEED_PREMIUM_SUFFIXES} as its fallback).
   */
  sendable(id: string): string | undefined;
}

/**
 * The wire id the map chooses for one request at `effort`, or `undefined` when
 * the map does not decide it and the provider's existing resolution applies.
 *
 * - `none`: the published `off` id when the account may send it.
 * - an effort level: {@link mapIdForEffort}, when the account may send that id.
 *   An id the provider's `sendable` refuses is not replaced by another map id:
 *   the existing resolution answers instead.
 *
 * A request with no effort is given its level by the caller before it gets
 * here (`model-id-effort-choice.ts`); this function never invents one.
 */
export function chooseModelIdForEffort(
  map: ModelIdEffort,
  effort: EffortLevel,
  provider: ModelIdEffortProvider
): string | undefined {
  if (effort === "none") return map.off ? provider.sendable(map.off) : undefined;
  const id = mapIdForEffort(map, effort);
  return id ? provider.sendable(id) : undefined;
}
