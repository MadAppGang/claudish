/**
 * Launcher catalog warm step.
 *
 * Owns the decision tree that runs once at CLI startup, before the proxy
 * server boots:
 *
 *   1. Decide whether the catalog needs warming at all (`shouldWarmCatalog`).
 *   2. Classify the on-disk cache state (`classifyCatalogState`).
 *   3. Drive the FR-4 hybrid-fallback state machine (`warmCatalogIfNeeded`).
 *
 * Architecture: ai-docs/sessions/dev-feature-catalog-warm-hardcoded-cleanup-XXX/architecture.md sections 2-5
 *
 * The launcher gate is "belt + suspenders" alongside the proxy-server's
 * background warm at `proxy-server.ts:535` (see Appendix B). The bg warm
 * is harmless if the launcher already populated the cache.
 */

import { type DiskCacheV2, readAllModelsCache } from "../providers/all-models-cache.js";
import { type RefreshOutcome, refreshCatalog } from "../providers/catalog-client.js";
import {
  type CatalogIncompatibility,
  catalogIncompatibilityMessage,
  readCatalogIncompatibility,
} from "../providers/catalog-compatibility.js";
import type { ClaudishConfig } from "../types.js";
import { VERSION } from "../version.js";

/**
 * Result returned by `warmCatalogIfNeeded`. The launcher reacts to this:
 *   - "ok"        → proceed to createProxyServer
 *   - "warned"    → proceed (warning already printed to stderr)
 *   - "skipped"   → proceed silently (local model or --models-skip-update)
 *   - "hard_fail" → exit 1 (error already printed to stderr)
 */
export type WarmOutcome = "ok" | "warned" | "skipped" | "hard_fail";

/**
 * Verbatim hard-fail copy from FR-4. Printed when the catalog is missing AND
 * the network refresh failed — claudish cannot route cloud models without it.
 *
 * "No cached copy found" is a claim about the disk, so this must never be the
 * message for a contract mismatch: there a copy exists and is merely unreadable,
 * the network is fine, and every line below sends the user to debug the wrong
 * thing. `warmCatalogIfNeeded` checks the sentinel before it can reach here for
 * exactly that reason — see the guard above `reportFetchFailure`.
 *
 * Trailing newline included so the message reads as one paragraph terminated
 * cleanly when written to stderr.
 */
const HARD_FAIL_MESSAGE =
  "Error: cannot reach model catalog and no cached copy found.\n" +
  "\n" +
  "To proceed:\n" +
  "  - Check network connection\n" +
  "  - Use a local model: claudish --model ollama@llama3.2 'task'\n" +
  "  - Skip catalog (advanced): claudish --models-skip-update 'task'\n" +
  "\n" +
  "Claudish will not launch without catalog data when using cloud models.\n";

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
 *
 * Returns `true` (warm) when:
 *   - No model is specified (auto-route path needs the catalog to pick).
 *   - The model is an aggregator/native prefix (`or@`, `g@`, ...) or bare ID.
 *
 * New aggregator/native prefixes added in the future automatically warm —
 * the default branch is the safer one.
 */
export function shouldWarmCatalog(args: {
  model?: string;
  skipModelsUpdate?: boolean;
}): boolean {
  if (args.skipModelsUpdate) return false;
  if (args.model === undefined) return true;

  const m = args.model.toLowerCase();
  for (const prefix of LOCAL_MODEL_PREFIXES) {
    if (m.startsWith(prefix)) return false;
  }
  return true;
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
  cache: DiskCacheV2 | null,
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
 * Minimal stderr spinner. Animates only when `process.stderr.isTTY` is true
 * (R6 in architecture.md — non-TTY contexts get one initial line, no `\r`
 * frames). Update interval capped at 250ms per FR-2.
 *
 * `quiet` short-circuits to a no-op stopper so the spinner respects the
 * documented `--quiet` semantic (Q2 in architecture.md §10) — no stderr
 * frames are emitted at all in quiet mode.
 *
 * Returns a `stop()` to clear the active frame and silence further updates.
 */
interface Spinner {
  stop(): void;
}

function startSpinner(label: string, quiet = false): Spinner {
  if (quiet) {
    // --quiet suppresses spinner frames entirely. The dispatcher already
    // skips the "preparing..." header in quiet mode; the spinner is the
    // last source of stderr noise during a successful refresh.
    return { stop: () => {} };
  }

  const isTty = Boolean(process.stderr.isTTY);
  if (!isTty) {
    // Non-TTY: print one line and return a no-op stopper. The caller has
    // already printed the "preparing model catalog..." header line above us;
    // we only want to add an extra line if we have something distinct to say.
    return { stop: () => {} };
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let stopped = false;
  const render = (): void => {
    if (stopped) return;
    process.stderr.write(`\r  ${frames[i]} ${label}`);
    i = (i + 1) % frames.length;
  };
  render();
  const handle = setInterval(render, 250);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      // Erase the spinner line: write CR + spaces wide enough to cover the
      // longest frame + label, then CR back to column 0.
      const wipe = " ".repeat(Math.max(0, label.length + 6));
      process.stderr.write(`\r${wipe}\r`);
    },
  };
}

/**
 * Launcher catalog warm dispatcher.
 *
 * Drives the FR-4 state machine end-to-end:
 *
 *   1. Trigger gate — if local model or `--models-skip-update`, return "skipped".
 *   2. Print the "preparing model catalog..." header (suppressed by `--quiet`).
 *   3. Classify on-disk cache state.
 *   4. Decide:
 *      - fresh && !forceUpdate → "ok" without fetching (lazy disk load happens
 *        later via _getEntries when the proxy first calls resolveSync).
 *      - else (stale, missing, or forceUpdate=true on fresh) → call
 *        `OpenRouterCatalogResolver.refreshCatalog(8000)`:
 *          - refreshed → print indexed-count line, return "ok".
 *          - incompatible → contract-mismatch message + return "warned".
 *          - fetch_failed:
 *              - a sentinel is already recorded → contract-mismatch message +
 *                return "warned" (the cache state is not what it looks like;
 *                see the guard at the call to `reportFetchFailure`).
 *              - prior state was "stale"   → WARN + return "warned".
 *              - prior state was "missing" → hard-fail message + return "hard_fail".
 *              - prior state was "fresh"   → treat as "warned" (we still have
 *                the fresh cache; the user explicitly asked to refresh it).
 *
 * Only ONE branch here ever returns "hard_fail", and it means one thing: there
 * is no catalog data on this machine at all and none can be fetched. An
 * unreadable catalog is a different failure with a different remedy, and it
 * never exits — routing decides that one per model name, where the explicit
 * `provider@model` carve-out lives.
 *
 * `--quiet` suppresses the preparing/indexed lines but never WARNINGs or
 * the hard-fail error (Q2 in architecture.md §10).
 */
export async function warmCatalogIfNeeded(
  config: ClaudishConfig,
  opts?: { now?: Date; ttlHours?: number }
): Promise<WarmOutcome> {
  if (
    !shouldWarmCatalog({
      model: config.model,
      skipModelsUpdate: config.skipModelsUpdate,
    })
  ) {
    return "skipped";
  }

  if (!config.quiet) {
    process.stderr.write(`claudish v${VERSION} — preparing model catalog...\n`);
  }

  const ttlHoursRaw =
    opts?.ttlHours ?? Number.parseFloat(process.env.CLAUDISH_CATALOG_TTL_HOURS ?? "24");
  const ttlHours = Number.isFinite(ttlHoursRaw) && ttlHoursRaw > 0 ? ttlHoursRaw : 24;
  const now = opts?.now ?? new Date();
  // This read is GATED: it returns null while a contract sentinel is set, so
  // `state` is "missing" for a cache that is sitting right there on disk. Two
  // consequences, both wanted, and both undone by "simplifying" this to an
  // ungated read. (1) A sentinel can never take the `fresh` early-return below,
  // so every launch under one attempts the refresh that would heal it. (2) Every
  // downstream branch that reasons from `state` has to be sentinel-aware — the
  // reason `reportFetchFailure` is guarded rather than trusted.
  const cache = readAllModelsCache();
  const state = classifyCatalogState(cache, ttlHours, now);

  // Fresh && !forceUpdate: don't fetch. _memCache lazy-loads on first
  // resolveSync call via _getEntries (see openrouter.ts). Do NOT call
  // ensureReady(0) here — timeout=0 races against fetch start before the
  // disk-backed entries populate.
  if (state === "fresh" && !config.forceUpdate) {
    return "ok";
  }

  const spinner = startSpinner("Fetching model catalog from Firebase...", config.quiet);
  let outcome: RefreshOutcome;
  try {
    outcome = await refreshCatalog(8000);
  } finally {
    spinner.stop();
  }

  if (outcome.kind === "refreshed") {
    if (!config.quiet) {
      process.stderr.write(
        `  Indexed ${outcome.modelCount} models, ${outcome.modelCount} entries.\n`
      );
    }
    return "ok";
  }

  return reportUnusableCatalog(outcome, state, cache, now);
}

/**
 * The refresh came back with no usable catalog. Decide which failure it was.
 *
 * Extracted from `warmCatalogIfNeeded` purely to hold that function at its
 * pre-existing complexity budget; the branch ORDER is the argument, and it is
 * "unreadable before unreachable" throughout — an unreadable catalog is the
 * finding that survives on disk, so it outranks whatever this one refresh did or
 * did not manage to fetch.
 */
function reportUnusableCatalog(
  outcome: Exclude<RefreshOutcome, { kind: "refreshed" }>,
  state: ReturnType<typeof classifyCatalogState>,
  cache: DiskCacheV2 | null,
  now: Date
): WarmOutcome {
  // The server answered in a contract this build cannot read. This is NOT a
  // fetch failure and must not fall into the branches below, every one of which
  // says some version of "using cached version" — the cached version is exactly
  // what `readAllModelsCache` has just stopped handing out, so that line would
  // be false at the moment it matters most.
  //
  // "warned", not "hard_fail", and the distinction is the point: hard_fail exits
  // the CLI, which would strand a user running an explicit `gk@grok-code-fast`.
  // That spec names its own provider, infers no subscription, and is safe. So
  // the launcher says it once, plainly, and proceeds; the bare-name path fails
  // loudly per-request in `routeBare` with this same text. Printed regardless of
  // `--quiet`, like every other warning here.
  if (outcome.kind === "incompatible") {
    // `refreshCatalog` has already recorded the finding; the fallback only
    // covers a sentinel whose disk write failed, where the message still has to
    // name the version the server just reported.
    return reportIncompatibleCatalog(
      readCatalogIncompatibility() ?? {
        detectedAt: new Date().toISOString(),
        serverContractVersion: outcome.serverContractVersion,
      }
    );
  }

  // The refresh never got an answer — offline, DNS, a corporate proxy, or just
  // slower than the 8s budget. Before classifying that against the cache, ask
  // whether an EARLIER run already recorded a contract mismatch, because if it
  // did, `state` is a lie: `readAllModelsCache()` refuses to hand out a cache
  // while the sentinel is set, so a present-but-unreadable catalog classifies as
  // "missing" and `reportFetchFailure` would hard-fail with "no cached copy
  // found" — false, unactionable, and pointing at the network when the remedy is
  // `claudish update`.
  //
  // Exiting is wrong on its own terms too. `hard_fail` ends the launch before
  // routing runs, so an explicit `gk@grok-4` dies with it — and that spec names
  // its own provider, infers no subscription and substitutes nothing, so there
  // is nothing to protect it from. Deciding per name is the routing gate's job
  // and it already does it: `routeBare` throws, `routeExplicit` proceeds. The
  // launcher's job is to say so once, and get out of the way.
  const recorded = readCatalogIncompatibility();
  if (recorded !== null) return reportIncompatibleCatalog(recorded);

  return reportFetchFailure(state, cache, now);
}

/**
 * Announce a catalog this build cannot read, and let the launch proceed.
 *
 * "warned", not "hard_fail", and the distinction is the point: hard_fail exits
 * the CLI, which would strand a user running an explicit `gk@grok-code-fast`.
 * That spec names its own provider, so claudish infers no subscription and
 * substitutes nothing — there is no mis-billing to protect them from. The
 * launcher therefore says it once, plainly, and proceeds; the bare-name path
 * fails loudly per request in `routeBare` with this same text.
 *
 * Both callers reach this with the RECORD rather than the refresh outcome, so
 * the two paths in — the server answered in a contract we cannot read, and a
 * previous run already found that out — print the identical text. The second is
 * the common one after a cutover: most launches never get an answer at all.
 *
 * Printed regardless of `--quiet`, like every other warning in this file.
 */
function reportIncompatibleCatalog(recorded: CatalogIncompatibility): WarmOutcome {
  process.stderr.write(`${catalogIncompatibilityMessage(recorded)}\n`);
  return "warned";
}

/**
 * The fetch-failed decision tree, keyed on what was already on disk.
 *
 * Split out of `warmCatalogIfNeeded` unchanged. Every branch here ends in some
 * form of "using cached version" or "no cached copy found", which is what makes
 * it the wrong home for a contract mismatch: there, the cached version is
 * precisely what stopped being usable while still sitting on disk. Keeping the
 * two apart is the whole reason `incompatible` is not a `fetch_failed` variant.
 *
 * PRECONDITION, and the caller enforces it: no sentinel is set. `state` is
 * computed from the GATED `readAllModelsCache()`, so under a sentinel it reads
 * "missing" for a cache that exists — every branch below would then be
 * describing a different failure than the one that happened.
 */
function reportFetchFailure(
  state: ReturnType<typeof classifyCatalogState>,
  cache: DiskCacheV2 | null,
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
    // forceUpdate path: refresh requested but failed. The fresh cache is
    // still usable — warn but proceed. Use the same human-readable copy as
    // the stale branch so the user sees a single, consistent error format.
    const ageMs = now.getTime() - Date.parse(cache!.lastUpdated);
    const ageStr = humanizeAge(ageMs);
    process.stderr.write(
      `WARNING: Catalog refresh failed (cache age ${ageStr}). Using cached version.\n`
    );
    return "warned";
  }

  // state === "missing" + fetch failed → hard fail.
  process.stderr.write(HARD_FAIL_MESSAGE);
  return "hard_fail";
}
