/**
 * Shared helpers for ~/.claudish/all-models.json
 *
 * This file is written and read by four independent consumers:
 *   - providers/catalog-resolvers/openrouter.ts (v2 authoritative — Firebase slim catalog)
 *   - cli.ts (fetchRemoteModels + printAllModels)
 *   - mcp-server.ts (loadAllModels)
 *   - model-selector.ts (fetchAllModels + shouldRefreshForFreeModels)
 *
 * Historically each consumer wrote its own v1-shape `{lastUpdated, models}` blob,
 * clobbering the v2 `entries` array that the OpenRouter catalog resolver relies on.
 *
 * This module provides a single normalized v2 read/write API:
 *   - `readAllModelsCache()` returns a v2 shape (normalizing v1 files on the fly)
 *   - `writeAllModelsCache(partial)` merges with the existing file so callers that
 *     only supply `models` do NOT destroy the Firebase `entries` catalog.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { AggregatorEntry } from "../model-loader.js";

/**
 * Slim catalog entry from the Firebase queryModels?catalog=slim endpoint.
 * Contains model name resolution data plus optional model metadata.
 *
 * The slim catalog includes `aggregators` per entry — verified live against
 * `?catalog=slim` (see `models-index/functions/src/query-handler.ts:267-269`).
 * This is the multi-aggregator routing index used by `CatalogClient` to
 * answer "which vendors serve model X?" without a Firebase round-trip.
 */
export interface SlimModelEntry {
  modelId: string;
  aliases: string[];
  sources: Record<string, { externalId: string }>;
  /** Official/curated release date in ISO date format, when Firebase has one */
  releaseDate?: string;
  /** Context window in tokens (present when Firebase has it) */
  contextWindow?: number;
  /** Whether model supports vision/image input (present when Firebase has it) */
  supportsVision?: boolean;
  /**
   * Multi-aggregator routing index. Each entry is `{provider, externalId, confidence}`.
   * Populated by Firebase ingest from per-source data. Optional — older cache
   * files may not include this field.
   */
  aggregators?: AggregatorEntry[];
}

/**
 * Disk cache format (version 2).
 * Contains both the slim Firebase data (for resolver) and a backward-compatible
 * models array (for existing consumers in cli.ts/mcp-server.ts that expect {id: string}).
 */
export interface DiskCacheV2 {
  version: 2;
  lastUpdated: string;
  entries: SlimModelEntry[];
  /** Backward-compatible: [{id: "vendor/model"}] for legacy consumers */
  models: Array<{ id: string }>;
  /**
   * What the last refresh actually covered (#635 AC4). Optional because every
   * writer before it omitted the field; a cache without it says nothing about
   * its own completeness, which is the honest reading — not "complete".
   */
  coverage?: CatalogCoverage;
}

/**
 * How much of the server-side catalog a refresh actually collected.
 *
 * MEASURED 2026-10-24: the live v3 endpoint answers `data.total = 1002` for
 * `limit = 1000` and hands back a `nextCursor`. The resolver read page 1 only
 * and wrote it out as the whole catalog, so two models were permanently
 * invisible and nothing in the file could distinguish "the catalog is 1000
 * entries" from "we stopped at 1000". `coverage` is that distinction, persisted.
 */
export interface CatalogCoverage {
  /** Pages successfully fetched this refresh (1 when the server offered no cursor). */
  pages: number;
  /** Distinct models collected across those pages. */
  fetched: number;
  /** `data.total` reported by the server, null when it reported none. */
  serverTotal: number | null;
  /** True only when the walk reached the server's own end (no cursor left). */
  complete: boolean;
}

/**
 * Cache path. In a container the config bind (`~/.claudish`) is deliberately
 * read-only — it carries provider API keys — so the refresh cannot persist
 * there (EROFS, `docs/reference/ops-scripts.md`). `CLAUDISH_MODEL_CACHE_PATH`
 * points it at a writable volume instead; empty/unset keeps the historical
 * `~/.claudish/all-models.json`.
 *
 * Read PER CALL, never captured in a module constant: the house rule for
 * runtime knobs, and here it is load-bearing. A constant evaluated at import
 * splits the cache in two the moment the variable moves — the writers land on
 * the override while a reader that memoized the old path (catalog-query's
 * mtime watch) keeps stat-ing the historical file and reports "unchanged"
 * forever.
 */
export function allModelsCachePath(): string {
  return (process.env.CLAUDISH_MODEL_CACHE_PATH ?? "").trim() || join(homedir(), ".claudish", "all-models.json");
}

/**
 * Read the cache from disk, normalizing legacy v1 files to a v2 shape.
 *
 * Returns null if the file doesn't exist or is unparseable.
 * A legacy v1 file `{lastUpdated, models}` is normalized to
 * `{version: 2, lastUpdated, entries: [], models}` so callers can treat both
 * the same way.
 *
 * @param path Override the cache path. Defaults to `allModelsCachePath()`.
 *             Only tests should pass this.
 */
export function readAllModelsCache(path: string = allModelsCachePath()): DiskCacheV2 | null {
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  const lastUpdated =
    typeof data.lastUpdated === "string" ? data.lastUpdated : new Date(0).toISOString();
  const models = Array.isArray(data.models) ? (data.models as Array<{ id: string }>) : [];
  const entries = Array.isArray(data.entries) ? (data.entries as SlimModelEntry[]) : [];

  const coverage = isCatalogCoverage(data.coverage) ? data.coverage : undefined;

  return {
    version: 2,
    lastUpdated,
    entries,
    models,
    ...(coverage ? { coverage } : {}),
  };
}

/** Structural guard: a hand-edited or foreign `coverage` must not be trusted. */
function isCatalogCoverage(value: unknown): value is CatalogCoverage {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.pages === "number" &&
    typeof c.fetched === "number" &&
    (c.serverTotal === null || typeof c.serverTotal === "number") &&
    typeof c.complete === "boolean"
  );
}

/**
 * Write the cache to disk in v2 format, preserving any existing `entries`
 * or `models` the caller did not explicitly supply.
 *
 * This is the critical anti-clobber behavior: legacy writers that only know
 * about `models` will merge on top of the existing v2 `entries`, leaving the
 * OpenRouter Firebase catalog intact.
 *
 * @param data Partial DiskCacheV2. Any omitted fields are filled from the
 *             existing file (if present) rather than reset to defaults.
 * @param path Override the cache path. Defaults to `allModelsCachePath()`.
 *             Only tests should pass this.
 */
export function writeAllModelsCache(
  data: Partial<DiskCacheV2>,
  path: string = allModelsCachePath()
): void {
  const existing = readAllModelsCache(path);

  const entriesReplaced = data.entries != null;
  const coverage = data.coverage ?? (entriesReplaced ? undefined : existing?.coverage);

  const merged: DiskCacheV2 = {
    version: 2,
    lastUpdated: data.lastUpdated ?? new Date().toISOString(),
    entries: data.entries ?? existing?.entries ?? [],
    models: data.models ?? existing?.models ?? [],
    // Coverage describes the `entries` it was measured on. Carrying a stale
    // measurement over a REPLACED entries array would assert a completeness
    // nobody measured — the exact trap #635 AC4 exists to close.
    ...(coverage ? { coverage } : {}),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged), "utf-8");
}
