/**
 * The catalog's recommended reasoning effort per model and task type, kept in a
 * sidecar next to the cloud models catalog cache
 * (`cloud-models-catalog-v3.efforts.json`).
 *
 * Source: `data.recommendations.efforts` of `?catalog=recommended` (models-index
 * 2.3.0), an OPTIONAL field: `{ [canonical model id]: { [task type]: { effort,
 * basis, sendableOn, evidence, ... } } }`. Absent, malformed or not an object
 * means no recommendations. Task types, basis values and cell fields are open
 * sets: an unknown type or basis is kept, an unknown field ignored, never
 * rejected. `sendableOn` lists the connections allowed to send the effort; a
 * cell without one is skipped.
 *
 * Its own file for the reason the route registry has one
 * (`routeRegistryPathFor`): the recommended-models cache is discarded for
 * display reasons, and older claudish builds rewrite the main catalog file.
 *
 * Several generations are kept, newest first. A connection is pinned to the
 * generation its handler was built on, handlers are cached for the process,
 * and nothing rebuilds them on a generation change: a long session whose
 * catalog another process refreshed (a team slot's start) still finds the
 * efforts of its own generation, which its own startup warm wrote.
 *
 * Every proxy start warms, so writers run concurrently: each one reads, merges,
 * writes a temp file in the same directory and renames it over the target, so a
 * reader never sees a torn file. A lost update between two writers of different
 * generations can drop one entry; the lookup then reports `generation`, never a
 * wrong value.
 *
 * claudish never picks a task type itself. The MCP `list_models` tool shows this
 * table, and the calling agent, which knows its task, passes one effort per model
 * to `team`, `create_session` or `run_prompt` (ai-docs/architecture/wire.md
 * "Recommended effort").
 */
import { readFileSync, statSync } from "node:fs";
import { writeFileAtomic } from "../fs-atomic.js";
import { log } from "../logger.js";
import { ALL_MODELS_CACHE_PATH } from "./all-models-cache.js";

/**
 * One connection a recommendation may be sent on: its route binding, wire id,
 * and how the effort is encoded there. Only `request_parameter` is sendable;
 * `model_id_switch` is reserved by the backend for a later phase, and a missing
 * or other value means "not sendable on this connection".
 */
export interface EffortSendableOn {
  routeId: string;
  routeProfileId: string;
  externalModelId: string;
  encoding?: string;
}

/** The one `encoding` claudish sends: the effort is a request parameter. */
export const SENDABLE_ENCODING = "request_parameter";

/**
 * One recommendation: the catalog effort name, why (logged only), and the
 * connections it may be sent on (never empty).
 */
export interface EffortRecommendation {
  effort: string;
  basis?: string;
  sendableOn: readonly EffortSendableOn[];
}

/** A model's recommendations, keyed by task type. */
export type ModelEffortRecommendations = Readonly<Record<string, EffortRecommendation>>;

export interface CachedEffortRecommendations {
  contractVersion: 3;
  /** The sidecar's own layout ({@link SIDECAR_FORMAT}). */
  format: 2;
  generations: Readonly<
    Record<
      string,
      {
        writtenAt: number;
        efforts: Readonly<Record<string, ModelEffortRecommendations>>;
      }
    >
  >;
}

export type EffortLookup =
  | { ok: true; byTaskType: ModelEffortRecommendations }
  | { ok: false; reason: "no-sidecar" | "generation" | "model" | "declared"; detail: string };

const SIDECAR_CONTRACT_VERSION = 3;

/**
 * The sidecar layout. 2 added `sendableOn` per cell (models-index 2.3.0). A file
 * without it, written before, reads as no sidecar, never as cells with no
 * connection, and the next warm replaces it whole.
 */
const SIDECAR_FORMAT = 2;

/** Generations kept in the sidecar; the oldest `writtenAt` beyond this is evicted. */
const MAX_GENERATIONS = 4;

/** Where the efforts sidecar for the cache at `catalogPath` is kept. */
export function effortRecommendationsPathFor(catalogPath: string): string {
  return catalogPath.endsWith(".json")
    ? `${catalogPath.slice(0, -5)}.efforts.json`
    : `${catalogPath}.efforts.json`;
}

/** `~/.claudish/cloud-models-catalog-v3.efforts.json`. */
export const EFFORT_RECOMMENDATIONS_PATH = effortRecommendationsPathFor(ALL_MODELS_CACHE_PATH);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalise the backend's `efforts` field. Never throws: anything that is not
 * an object gives `{}`. Only `effort`, `basis` and `sendableOn` are kept
 * (`evidence`, `proposed`, `flags`, `unverifiedOn` and any other field are
 * dropped). A task entry without a non-empty string `effort`, or without one
 * well-formed `sendableOn` element, is skipped, and a model left with no entry
 * is skipped too, so a lookup reports it as absent. `basis` is kept verbatim
 * when it is a string, whatever its value.
 */
export function parseEffortRecommendations(
  raw: unknown
): Record<string, ModelEffortRecommendations> {
  const out: Record<string, ModelEffortRecommendations> = {};
  if (!isRecord(raw)) return out;
  for (const [modelId, byTask] of Object.entries(raw)) {
    const entries = modelId ? parseModelEntries(byTask) : {};
    if (Object.keys(entries).length > 0) out[modelId] = entries;
  }
  return out;
}

/** One model's task entries; malformed ones are skipped. */
function parseModelEntries(byTask: unknown): Record<string, EffortRecommendation> {
  const entries: Record<string, EffortRecommendation> = {};
  if (!isRecord(byTask)) return entries;
  for (const [taskType, entry] of Object.entries(byTask)) {
    if (!taskType || !isRecord(entry)) continue;
    if (typeof entry.effort !== "string" || entry.effort === "") continue;
    const sendableOn = parseSendableOn(entry.sendableOn);
    if (sendableOn.length === 0) continue;
    entries[taskType] =
      typeof entry.basis === "string"
        ? { effort: entry.effort, basis: entry.basis, sendableOn }
        : { effort: entry.effort, sendableOn };
  }
  return entries;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * A cell's `sendableOn`: the elements naming a route binding and a wire id as
 * non-empty strings. `encoding` is kept when it is a string (any value; the
 * decision reads it) and omitted otherwise. Other fields are dropped.
 */
function parseSendableOn(raw: unknown): EffortSendableOn[] {
  if (!Array.isArray(raw)) return [];
  const out: EffortSendableOn[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { routeId, routeProfileId, externalModelId, encoding } = item;
    if (!nonEmptyString(routeId) || !nonEmptyString(routeProfileId)) continue;
    if (!nonEmptyString(externalModelId)) continue;
    out.push(
      typeof encoding === "string"
        ? { routeId, routeProfileId, externalModelId, encoding }
        : { routeId, routeProfileId, externalModelId }
    );
  }
  return out;
}

/**
 * The sidecar as stored, re-normalised; null when absent, not a sidecar, or of
 * an older format (so it reads as "no recommendations", never as a wrong one).
 */
function parseSidecar(raw: unknown): CachedEffortRecommendations | null {
  if (!isRecord(raw) || raw.contractVersion !== SIDECAR_CONTRACT_VERSION) return null;
  if (raw.format !== SIDECAR_FORMAT) return null;
  if (!isRecord(raw.generations)) return null;
  const generations: Record<
    string,
    { writtenAt: number; efforts: Record<string, ModelEffortRecommendations> }
  > = {};
  for (const [generationId, generation] of Object.entries(raw.generations)) {
    if (!generationId || !isRecord(generation)) continue;
    if (typeof generation.writtenAt !== "number" || !Number.isFinite(generation.writtenAt)) {
      continue;
    }
    generations[generationId] = {
      writtenAt: generation.writtenAt,
      efforts: parseEffortRecommendations(generation.efforts),
    };
  }
  return { contractVersion: SIDECAR_CONTRACT_VERSION, format: SIDECAR_FORMAT, generations };
}

function statOrNull(path: string): { mtimeMs: number; size: number } | null {
  try {
    const { mtimeMs, size } = statSync(path);
    return { mtimeMs, size };
  } catch {
    return null;
  }
}

function readSidecarFile(path: string): CachedEffortRecommendations | null {
  try {
    return parseSidecar(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    // A corrupt file reads as none: list_models drops the effort table. Say why.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log(`[effort] unreadable ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

/** The `format` of a sidecar file this build does not read, or undefined. */
function foreignSidecarFormat(path: string): unknown {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (isRecord(raw) && raw.format !== SIDECAR_FORMAT) return raw.format ?? "none";
  } catch {
    // Absent or unreadable: nothing of another build's to replace.
  }
  return undefined;
}

// A sidecar of another format is replaced, and that is said once per process:
// two builds of different formats sharing ~/.claudish discard each other's
// generations on every write, and the log line is how that shows.
let _foreignFormatLogged = false;

// The request path looks recommendations up per request: parsed results are
// memoized per path, keyed by the file's mtime and size, so a rewrite (by this
// process or another) is seen on the next read.
const _readMemo = new Map<string, { key: string; sidecar: CachedEffortRecommendations | null }>();

export function _clearEffortRecommendationsMemo(): void {
  _readMemo.clear();
  _foreignFormatLogged = false;
}

/** The sidecar at `path`, or null when it is absent, unreadable or malformed. */
export function readEffortRecommendations(
  path: string = EFFORT_RECOMMENDATIONS_PATH
): CachedEffortRecommendations | null {
  const stat = statOrNull(path);
  if (!stat) {
    _readMemo.delete(path);
    return null;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const memo = _readMemo.get(path);
  if (memo && memo.key === key) return memo.sidecar;
  const sidecar = readSidecarFile(path);
  _readMemo.set(path, { key, sidecar });
  return sidecar;
}

/**
 * Record generation `generationId`'s efforts (`raw` is the backend's
 * `recommendations.efforts`, possibly absent). An absent or non-object field is
 * written as `efforts: {}`, so the generation says "none" rather than missing.
 * Replaces that generation's entry, keeps the newest {@link MAX_GENERATIONS} by
 * `writtenAt`, and writes through a temp file renamed over the target. Throws on
 * a write failure; the caller decides whether that matters.
 */
export function writeEffortRecommendations(
  generationId: string,
  raw: unknown,
  path: string = EFFORT_RECOMMENDATIONS_PATH
): void {
  const existing = readSidecarFile(path);
  if (!existing && !_foreignFormatLogged) {
    const foreign = foreignSidecarFormat(path);
    if (foreign !== undefined) {
      _foreignFormatLogged = true;
      log(
        `[effort] replacing a sidecar of format ${String(foreign)} with format ${SIDECAR_FORMAT} at ${path}; its generations are dropped`
      );
    }
  }
  const merged: CachedEffortRecommendations["generations"] = {
    ...(existing?.generations ?? {}),
    [generationId]: { writtenAt: Date.now(), efforts: parseEffortRecommendations(raw) },
  };
  const kept = Object.entries(merged)
    .sort(([, a], [, b]) => b.writtenAt - a.writtenAt)
    .slice(0, MAX_GENERATIONS);
  const sidecar: CachedEffortRecommendations = {
    contractVersion: SIDECAR_CONTRACT_VERSION,
    format: SIDECAR_FORMAT,
    generations: Object.fromEntries(kept),
  };

  writeFileAtomic(path, JSON.stringify(sidecar));
  _readMemo.delete(path);
}

/**
 * The recommendations for `modelId` (the connection's canonical model id,
 * exactly: never a base model, family or sibling) at the connection's
 * generation. A miss names why: `declared` (a custom endpoint or off-catalog
 * fallback has no catalog generation), `no-sidecar`, `generation` (the sidecar
 * does not hold the connection's generation) or `model` (no entry for it).
 */
export function lookupModelEfforts(
  modelId: string,
  generationId: string,
  path: string = EFFORT_RECOMMENDATIONS_PATH
): EffortLookup {
  if (generationId === "declared") {
    return { ok: false, reason: "declared", detail: "declared wire: no catalog generation" };
  }
  const sidecar = readEffortRecommendations(path);
  if (!sidecar) {
    return {
      ok: false,
      reason: "no-sidecar",
      detail: `no efforts sidecar (or one of an older format) at ${path}`,
    };
  }
  const generation = sidecar.generations[generationId];
  if (!generation) {
    const held = Object.keys(sidecar.generations);
    return {
      ok: false,
      reason: "generation",
      detail: `efforts sidecar holds ${held.length > 0 ? held.join(", ") : "no generation"}, not ${generationId}`,
    };
  }
  const byTaskType = generation.efforts[modelId];
  if (!byTaskType) {
    return {
      ok: false,
      reason: "model",
      detail: `no recommended efforts for ${modelId} in ${generationId}`,
    };
  }
  return { ok: true, byTaskType };
}

/**
 * The newest generation the sidecar holds (by `writtenAt`), or null when there is
 * no sidecar or it holds none. For display: `list_models` shows the table the
 * last catalog refresh wrote.
 */
export function latestEffortRecommendations(path: string = EFFORT_RECOMMENDATIONS_PATH): {
  generationId: string;
  efforts: Readonly<Record<string, ModelEffortRecommendations>>;
} | null {
  const sidecar = readEffortRecommendations(path);
  if (!sidecar) return null;
  const newest = Object.entries(sidecar.generations).sort(
    ([, a], [, b]) => b.writtenAt - a.writtenAt
  )[0];
  return newest ? { generationId: newest[0], efforts: newest[1].efforts } : null;
}
