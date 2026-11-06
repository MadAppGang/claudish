/**
 * Launcher catalog warm step.
 *
 * Runs once at CLI startup, before the proxy server boots:
 *
 *   1. Decide whether the launch may touch the catalog at all (`shouldWarmCatalog`).
 *   2. Classify the on-disk cache state (`classifyCatalogState`).
 *   3. Refresh only when the user asked for it (`warmCatalogIfNeeded`).
 *
 * A launch never waits for the catalog. The proxy refreshes the cloud models
 * catalog in the background as soon as it starts (`warmCatalog` in
 * `proxy-server.ts`), and a request that needs it waits there, per request.
 * Only `--models-refresh` fetches here, and a failed fetch is one warning line,
 * never an exit.
 */

import { type DiskCacheV3, readAllModelsCache } from "../providers/all-models-cache.js";
import { type RefreshOutcome, refreshCatalog } from "../providers/catalog-client.js";
import { MODEL_CATALOG_NAME } from "../providers/catalog-name.js";
import { parseModelSpec } from "../providers/model-parser.js";
import type { ClaudishConfig } from "../types.js";

/**
 * Result returned by `warmCatalogIfNeeded`. The launcher proceeds on every value:
 *   - "ok"      → nothing to report (no refresh requested, or it succeeded)
 *   - "warned"  → a requested refresh failed; one warning line is on stderr
 *   - "skipped" → local model, explicit `provider@model`, `--models-skip-update`,
 *                 or the refresh is disabled
 */
export type WarmOutcome = "ok" | "warned" | "skipped";

/**
 * Local-only model prefixes. When the user asks for one of these, the launcher
 * skips the catalog warm entirely (NFR-2): Ollama, LM Studio, and explicit
 * localhost URLs talk to in-process daemons that don't need the slim catalog.
 *
 * All comparisons are lower-case (the model spec is `toLowerCase()`'d before
 * the loop). The `http(s)://localhost` and `http(s)://127.0.0.1` prefixes are
 * deliberately limited to those two host literals — `ws://`, IPv6 `[::1]`,
 * and arbitrary local LAN IPs are not supported claudish model specs.
 */
const LOCAL_MODEL_PREFIXES = [
  "ollama@",
  "lmstudio@",
  "http://localhost",
  "http://127.0.0.1",
  "https://localhost",
  "https://127.0.0.1",
] as const;

/**
 * Pure trigger function. No I/O, no side effects.
 *
 * Returns `false` (skip warm) when:
 *   - The user passed `--models-skip-update` (hard skip, regardless of model).
 *   - The user passed a local-only model prefix (case-insensitive).
 *   - The user passed an explicit provider (`provider@model`): routing takes it
 *     as written, so nothing at launch depends on the catalog.
 *
 * Returns `true` (warm) when:
 *   - No model is specified (auto-route path needs the catalog to pick).
 *   - The model is a bare name that routing resolves.
 */
export function shouldWarmCatalog(args: {
  model?: string;
  skipModelsUpdate?: boolean;
}): boolean {
  if (args.skipModelsUpdate) return false;
  if (args.model === undefined) return true;
  if (isLocalModel(args.model)) return false;
  if (parseModelSpec(args.model).isExplicitProvider) return false;
  return true;
}

/** True when the model spec starts with a local-only prefix (case-insensitive). */
function isLocalModel(model: string): boolean {
  const m = model.toLowerCase();
  return LOCAL_MODEL_PREFIXES.some((prefix) => m.startsWith(prefix));
}

/**
 * Pure classifier. No I/O — caller passes the cache and `now` explicitly so
 * tests can drive the time axis deterministically.
 *
 * "missing" semantics cover three on-disk failure modes:
 *   1. The file doesn't exist (or readAllModelsCache returned null because
 *      the JSON was unparseable — both bubble up here as null).
 *   2. The file is parseable but contains zero entries AND zero models
 *      (defense against an empty-but-valid blob).
 *   3. `lastUpdated` is malformed (Date.parse → NaN) so we can't compute age.
 *
 * Otherwise, freshness is `ageMs < ttlMs` (strict <). At exactly the TTL
 * boundary we report "stale" — a refresh is preferable to letting cache age
 * silently drift past the policy.
 */
export function classifyCatalogState(
  cache: DiskCacheV3 | null,
  ttlHours: number,
  now: Date
): "fresh" | "stale" | "missing" {
  if (cache === null) return "missing";
  if (cache.entries.length === 0 && cache.models.length === 0) return "missing";

  const lastUpdatedMs = Date.parse(cache.lastUpdated);
  if (Number.isNaN(lastUpdatedMs)) return "missing";

  const ageMs = now.getTime() - lastUpdatedMs;
  const ttlMs = ttlHours * 3_600_000;
  return ageMs < ttlMs ? "fresh" : "stale";
}

/**
 * Format an age in milliseconds as a coarse human string ("5 minutes",
 * "3 hours", "2 days"). Bucketed at 60-minute and 24-hour boundaries.
 *
 * F11 mitigation: the minute-bucket uses `Math.max(1, ...)` so very young
 * ages (e.g. 12s after a clock skew) never render as "0 minutes".
 *
 * Pluralization: when the bucket value is exactly 1 we render the singular
 * ("1 minute" / "1 hour" / "1 day") so the WARNING line reads naturally at
 * the boundary.
 */
function humanizeAge(ageMs: number): string {
  const minutes = Math.max(1, Math.floor(ageMs / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;

  const days = Math.floor(ageMs / 86_400_000);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * Launcher catalog warm dispatcher.
 *
 *   1. Hard skips — `--models-skip-update` or a local model → "skipped",
 *      even with `--models-refresh`.
 *   2. `--models-refresh` outranks the explicit `provider@model` gate: it
 *      refreshes whatever provider was named. Without it, an explicit
 *      `provider@model` → "skipped" (`shouldWarmCatalog`).
 *   3. No `--models-refresh` → "ok", silently, whatever the cache state. The
 *      proxy's background refresh keeps the catalog current.
 *   4. `--models-refresh` → one `refreshCatalog` call, no spinner:
 *      - refreshed    → indexed-count line (suppressed by `--quiet`), "ok".
 *      - disabled     → "skipped" (nobody attempted a fetch).
 *      - incompatible / any other failure → one warning line, "warned".
 *
 * Warnings are printed even under `--quiet`.
 */
export async function warmCatalogIfNeeded(
  config: ClaudishConfig,
  opts?: { now?: Date; ttlHours?: number }
): Promise<WarmOutcome> {
  if (config.skipModelsUpdate) return "skipped";
  if (config.model !== undefined && isLocalModel(config.model)) return "skipped";
  if (
    !config.forceUpdate &&
    !shouldWarmCatalog({
      model: config.model,
      skipModelsUpdate: config.skipModelsUpdate,
    })
  ) {
    return "skipped";
  }

  if (!config.forceUpdate) return "ok";

  const ttlHoursRaw =
    opts?.ttlHours ?? Number.parseFloat(process.env.CLAUDISH_CATALOG_TTL_HOURS ?? "24");
  const ttlHours = Number.isFinite(ttlHoursRaw) && ttlHoursRaw > 0 ? ttlHoursRaw : 24;
  const now = opts?.now ?? new Date();
  const cache = readAllModelsCache();
  const state = classifyCatalogState(cache, ttlHours, now);

  const outcome: RefreshOutcome = await refreshCatalog(8000);

  if (outcome.kind === "refreshed") {
    if (!config.quiet) {
      process.stderr.write(
        `  Indexed ${outcome.modelCount} models, ${outcome.modelCount} entries.\n`
      );
    }
    return "ok";
  }

  return reportUnusableCatalog(outcome, state, cache, now, config.quiet === true);
}

/**
 * A requested refresh came back with no usable catalog. Print one line saying
 * which failure it was; the launch continues on whatever is cached.
 */
function reportUnusableCatalog(
  outcome: Exclude<RefreshOutcome, { kind: "refreshed" }>,
  state: ReturnType<typeof classifyCatalogState>,
  cache: DiskCacheV3 | null,
  now: Date,
  quiet: boolean
): WarmOutcome {
  if (outcome.kind === "incompatible") {
    process.stderr.write(
      `WARNING: The ${MODEL_CATALOG_NAME} contract v${outcome.serverContractVersion ?? "unknown"} is not supported by this build.\n`
    );
    return "warned";
  }

  // `disabled` is not a failure: nobody attempted a fetch, so a network
  // diagnosis would send the reader to debug a working connection. It reaches
  // here through `CLAUDISH_DISABLE_CATALOG_WARM=1`, which
  // `scripts/guard-real-config.ts` sets on the whole test run. "skipped" is the
  // same answer `--models-skip-update` produces.
  if (outcome.reason === "disabled") {
    if (!quiet) {
      process.stderr.write("  Catalog refresh disabled (CLAUDISH_DISABLE_CATALOG_WARM=1).\n");
    }
    return "skipped";
  }

  return reportFetchFailure(state, cache, now);
}

function reportFetchFailure(
  state: ReturnType<typeof classifyCatalogState>,
  cache: DiskCacheV3 | null,
  now: Date
): WarmOutcome {
  if (state === "stale") {
    const ageMs = now.getTime() - Date.parse(cache!.lastUpdated);
    const ageStr = humanizeAge(ageMs);
    process.stderr.write(
      `WARNING: Catalog stale (${ageStr}). Using cached version. Run \`claudish --models-refresh\` to retry.\n`
    );
    return "warned";
  }

  if (state === "fresh") {
    const ageMs = now.getTime() - Date.parse(cache!.lastUpdated);
    const ageStr = humanizeAge(ageMs);
    process.stderr.write(
      `WARNING: Catalog refresh failed (cache age ${ageStr}). Using cached version.\n`
    );
    return "warned";
  }

  process.stderr.write(
    `WARNING: Could not refresh the ${MODEL_CATALOG_NAME} and no cached copy exists; the proxy retries in the background.\n`
  );
  return "warned";
}
