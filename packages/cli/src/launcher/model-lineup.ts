/**
 * The /model lineup: the rows a launch with listing entries (`--model devin@`,
 * `--model 'or@*'`) hands Claude Code as its `modelPicker` setting, so every
 * model the listed claudish providers serve appears in Claude Code's own
 * `/model` list after Claude's own rows.
 *
 * Claude Code's `/model` does not read the proxy's `GET /v1/models` (measured on
 * 2.1.325: it asks a gateway only under `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`
 * and keeps only Claude-named ids). A `modelPicker` handed over through
 * `--settings` is listed, and each row's `model` goes to the wire verbatim, so a
 * row's `model` is a full claudish model spec the proxy routes as sent.
 *
 * Three layers here:
 *
 * - `lineupRowsForProvider`: pure. One provider's rows from what was fetched:
 *   the gateway rule (a gateway's `x@` lists only the recommended models it
 *   serves, `x@*` every chat model), the row filter and the de-duplication.
 * - `buildModelLineup`: every listed provider in parallel under ONE deadline.
 *   It never rejects: a provider that fails, or is still pending at the
 *   deadline, is `not-listed` with one sentence naming why, and the launch goes
 *   on without its rows.
 * - `lineupReport` and `modelPickerSetting`: pure. The launch's stderr lines and
 *   the overlay value.
 *
 * No model, plan membership, window or price is written here: every row comes
 * from the account's dynamic models catalog, a custom endpoint's declared
 * models, or the cloud models catalog.
 *
 * Reaches `picker/` not at all: the picker's readiness rule and row builders
 * live in `providers/picker-readiness.ts` and `model-selector.ts`, so no
 * renderer enters a launch's import graph.
 */

import { CLAUDE_CODE_DEFAULT_MAX_CONTEXT } from "../claude-runner.js";
import { log } from "../logger.js";
import { RECOMMENDATION_SECTIONS, type RecommendedModelsDoc } from "../model-loader.js";
import {
  type ModelInfo,
  type PickerDiscoveryOutcome,
  buildExplicitModelSpec,
  buildProviderChoices,
  displayBillingOf,
  formatContextLength,
  outcomeFromModelsCatalog,
  resolveProviderDisplayPrice,
  resolveProviderExternalId,
  servedModelsForProvider,
} from "../model-selector.js";
import { loadConfig } from "../profile-config.js";
import { readAllModelsCache } from "../providers/all-models-cache.js";
import { bundledListActive, bundledRecommendedModelsDoc } from "../providers/bundled-list.js";
import { ensureCatalogReady } from "../providers/catalog-client.js";
import {
  type AccountModelsList,
  liveOrStoredModelsCatalog,
  readAccountModelsList,
} from "../providers/dynamic-models-catalog.js";
import { createCatalogClient } from "../providers/model-catalog.js";
import {
  type ModelsCatalogOutcome,
  describeDiscoveryFailure,
  servedOutcomeOf,
} from "../providers/model-discovery.js";
import { parseModelSpec } from "../providers/model-parser.js";
import { nativeRouteFor } from "../providers/native-route.js";
import { pickerProviderReady } from "../providers/picker-readiness.js";
import {
  type RouteTier,
  describeMissingCredential,
  getDisplayName,
  getProviderByName,
} from "../providers/provider-definitions.js";
import { redactSecrets } from "../redact.js";
import type { ProviderListing } from "../types.js";

/** The whole lineup's time limit: every provider and the recommended list, in parallel. */
export const LINEUP_WAIT_MS = 6_000;

/** The most characters a row's label carries; longer ones end in "…". */
export const LINEUP_LABEL_MAX = 60;
/** The most characters a row's description carries; longer ones end in "…". */
export const LINEUP_DESCRIPTION_MAX = 100;

/** One row of Claude Code's `/model` list. */
export interface LineupRow {
  /** Full claudish model spec, sent to Claude Code and back to the proxy verbatim. */
  model: string;
  /** Display name, `redactSecrets` then truncated to {@link LINEUP_LABEL_MAX}. */
  label: string;
  /** `<provider> · <context> · <SUB | price | local>`, redacted then truncated. */
  description: string;
  /** claudish provider. Not sent to Claude Code. */
  provider: string;
  contextLength?: number;
}

export type LineupSource = "live" | "stored" | "catalog" | "bundled" | "declared";

export type ProviderLineupOutcome =
  | {
      kind: "listed";
      provider: string;
      count: number;
      source: LineupSource;
      /** When the stored list was fetched (ms since epoch); only for `stored`. */
      storedAt?: number;
      /** How many chat models a gateway serves, when its `x@` listed fewer. */
      servedTotal?: number;
    }
  | { kind: "not-listed"; provider: string; reason: string };

export interface ModelLineup {
  rows: LineupRow[];
  outcomes: ProviderLineupOutcome[];
}

/** Every slow thing `buildModelLineup` asks; the defaults are the real ones. */
export interface LineupDeps {
  /** `pickerProviderReady`: the one picker readiness rule. */
  ready(provider: string): Promise<boolean>;
  /** `readAccountModelsList`: the account's stored dynamic models catalog, no network. */
  storedList(provider: string): Promise<AccountModelsList | null>;
  /** `liveOrStoredModelsCatalog(provider, "launch-lineup")`. */
  liveList(provider: string): Promise<ModelsCatalogOutcome>;
  /**
   * `servedModelsForProvider`: the catalog's local served-by index, read through
   * `readAllModelsCache` (the bundled recommended list when no disk catalog exists
   * and the backend is settled as unreachable).
   */
  catalogRows(provider: string): ModelInfo[];
  /** `bundledListActive`: the catalog read is the bundled recommended list. */
  catalogIsBundled(): boolean;
  /** `ensureCatalogReady`, bounded by the remaining deadline. */
  ensureCatalog(ms: number): Promise<void>;
  /**
   * The bundled doc when active, else `getRecommendedModels`; null when neither
   * answers. Takes no signal: `getRecommendedModels` cannot be cancelled, so a
   * fetch that loses the deadline race runs on unread until the process exits.
   */
  recommended(): Promise<RecommendedModelsDoc | null>;
  /**
   * A custom endpoint's declared `customEndpoints.<name>.models`: the ids when
   * `provider` is a custom endpoint (`[]` when it declares none), null when it
   * is not one.
   */
  declaredModels(provider: string): string[] | null;
  /** The provider's routing tier; a custom endpoint is a `gateway`. */
  tier(provider: string): RouteTier;
  /** Whether the provider declares a model discovery endpoint. */
  hasDiscovery(provider: string): boolean;
  now(): number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The two masks `redactSecrets` writes; a cut never lands inside one. */
const REDACTION_MARKERS = ["***REDACTED***", "[redacted]"];

/**
 * `redactSecrets`, THEN truncate to `max` characters ending in "…". A cut that
 * would fall inside a redaction marker moves to the marker's start, so a
 * truncated string never shows half a mask (which would read as a value).
 */
export function redactAndTruncate(text: string, max: number): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= max) return redacted;
  let cut = max - 1;
  for (const marker of REDACTION_MARKERS) {
    let at = redacted.indexOf(marker);
    while (at >= 0 && at < cut) {
      if (at + marker.length > cut) {
        cut = at;
        break;
      }
      at = redacted.indexOf(marker, at + marker.length);
    }
  }
  return `${redacted.slice(0, cut).trimEnd()}…`;
}

/** The `(provider, model-with-markers)` identity of a spec, for de-duplication. */
function rowKey(spec: string): string {
  const parsed = parseModelSpec(spec);
  return [
    parsed.provider,
    parsed.model,
    parsed.mode ?? "",
    parsed.speed ?? "",
    parsed.concurrency ?? "",
  ].join("\u0000");
}

/**
 * The spec a row sends for `wireId` on `provider`: the picker's spelling
 * (`buildExplicitModelSpec`) when it parses back to the provider, else the
 * provider's own name before the id. Every row round-trips `parseModelSpec`.
 */
export function lineupSpecFor(provider: string, wireId: string): string {
  const spec = buildExplicitModelSpec(provider, wireId);
  const parsed = parseModelSpec(spec);
  if (parsed.isExplicitProvider && parsed.provider === provider) return spec;
  return `${provider}@${wireId}`;
}

/** The provider's display name, as the picker names it. */
export function lineupProviderName(provider: string): string {
  try {
    const choice = buildProviderChoices().find((c) => c.value === provider);
    if (choice) return choice.name;
  } catch {
    // The picker's list is derived from definitions; a fault there falls back.
  }
  return getDisplayName(provider);
}

/** `local`, `SUB`, or the provider's per-token price; undefined when none is known. */
function priceLabel(provider: string, isLocal: boolean, model: ModelInfo): string | undefined {
  if (isLocal) return "local";
  if (displayBillingOf(provider) === "sub") return "SUB";
  const price = resolveProviderDisplayPrice(provider, model);
  return price && price !== "N/A" ? price : undefined;
}

function rowFrom(
  provider: string,
  providerName: string,
  isLocal: boolean,
  spec: string,
  model: ModelInfo | undefined,
  fallbackLabel: string
): LineupRow {
  const contextLength =
    model?.contextLength && model.contextLength > 0 ? model.contextLength : undefined;
  const parts = [providerName];
  if (contextLength) parts.push(`${formatContextLength(contextLength)} context`);
  const price = model ? priceLabel(provider, isLocal, model) : isLocal ? "local" : undefined;
  if (price) parts.push(price);
  else if (!model && displayBillingOf(provider) === "sub") parts.push("SUB");
  return {
    model: spec,
    label: redactAndTruncate(model?.name || fallbackLabel, LINEUP_LABEL_MAX),
    description: redactAndTruncate(parts.join(" · "), LINEUP_DESCRIPTION_MAX),
    provider,
    ...(contextLength ? { contextLength } : {}),
  };
}

/** A declared model id as a row source. */
function declaredModelInfo(id: string, providerName: string): ModelInfo {
  return { id, name: id, description: "", provider: providerName };
}

/** The `*` scope hint, quoted for zsh. */
function allScopeHint(listing: ProviderListing): string {
  const at = listing.typed.indexOf("@");
  const shortcut = at > 0 ? listing.typed.slice(0, at) : listing.provider;
  return `'${shortcut}@*'`;
}

/** Why a discovery outcome holds no rows, in one sentence. */
function discoveryEmptyReason(outcome: PickerDiscoveryOutcome): string | undefined {
  switch (outcome.kind) {
    case "rows":
      return undefined;
    case "failed":
      return describeDiscoveryFailure(outcome.failure);
    case "empty-models-catalog":
      return describeDiscoveryFailure(outcome.failure);
    case "all-filtered":
      return outcome.servedCount === 1
        ? "it serves 1 model, not a chat model"
        : `it serves ${outcome.servedCount} models, none of them a chat model`;
    case "collapsed-empty":
      return "its model list yielded no rows";
    case "unsupported":
      return "it publishes no model list";
  }
}

/**
 * One provider's rows. Pure.
 *
 * - Source: a custom endpoint's declared models when it declares some (either
 *   scope); else the discovered rows (`discovered`, a non-null outcome); else
 *   the catalog rows. A discovery outcome without rows lists nothing: the
 *   catalog does not stand in for an account's entitlement.
 * - Gateway `x@` (`tier === "gateway"`, scope `recommended`): only recommended
 *   models it serves, in `recommendedIds` order. A discovered row matches by the
 *   wire id `resolveProviderExternalId` gives for a recommended catalog row,
 *   never by canonical id. `recommendedIds: null` lists only the pinned rows.
 * - `supportsTools === false` is dropped; rows are de-duplicated by
 *   `(provider, model-with-markers)`.
 * - Pinned specs come first, as typed, even when the list failed. A pinned spec
 *   that collides with a listed row keeps its string and takes the row's label.
 *
 * `declared`: null when the provider is not a custom endpoint, `[]` when it is
 * one that declares no models.
 */
export function lineupRowsForProvider(input: {
  listing: ProviderListing;
  tier: RouteTier;
  isLocal: boolean;
  discovered: PickerDiscoveryOutcome | null;
  catalogRows: ModelInfo[];
  recommendedIds: readonly string[] | null;
  declared: readonly string[] | null;
}): { rows: LineupRow[]; emptyReason?: string } {
  const { listing, tier, declared } = input;
  const source = candidateSource(input);
  let { candidates, emptyReason } = source;

  const isGatewayRecommended =
    tier === "gateway" && listing.scope === "recommended" && declared === null;
  if (isGatewayRecommended && candidates.length > 0) {
    const narrowed = recommendedCandidates(input, candidates);
    candidates = narrowed.candidates;
    emptyReason = narrowed.emptyReason ?? emptyReason;
  }

  const rows = assembleRows(
    input,
    candidates.filter((m) => m.supportsTools !== false)
  );
  if (rows.length > 0) return { rows };
  return { rows, emptyReason: emptyReason ?? "it lists no chat models" };
}

/** The rows a provider offers before the gateway rule: declared, discovered or catalog. */
function candidateSource(input: {
  listing: ProviderListing;
  discovered: PickerDiscoveryOutcome | null;
  catalogRows: ModelInfo[];
  declared: readonly string[] | null;
}): { candidates: ModelInfo[]; emptyReason?: string } {
  const { listing, discovered, catalogRows, declared } = input;
  const provider = listing.provider;
  if (declared && declared.length > 0) {
    const providerName = lineupProviderName(provider);
    return { candidates: declared.map((id) => declaredModelInfo(id, providerName)) };
  }
  const isCustomEndpoint = declared !== null;
  if (isCustomEndpoint && listing.scope === "recommended") {
    return {
      candidates: [],
      emptyReason: `declare models for ${provider}, or use ${allScopeHint(listing)}`,
    };
  }
  if (discovered) {
    return discovered.kind === "rows"
      ? { candidates: [...discovered.rows] }
      : { candidates: [], emptyReason: discoveryEmptyReason(discovered) };
  }
  if (isCustomEndpoint) return { candidates: [], emptyReason: `${provider} has no model list` };
  return { candidates: [...catalogRows] };
}

/**
 * A gateway's `x@`: only the recommended models it serves, in recommendation
 * order. Discovered rows match by the wire id a recommended catalog row gives
 * for this provider; catalog rows match by canonical id.
 */
function recommendedCandidates(
  input: {
    listing: ProviderListing;
    discovered: PickerDiscoveryOutcome | null;
    catalogRows: ModelInfo[];
    recommendedIds: readonly string[] | null;
  },
  candidates: ModelInfo[]
): { candidates: ModelInfo[]; emptyReason?: string } {
  const { listing, discovered, catalogRows, recommendedIds } = input;
  if (recommendedIds === null) {
    return {
      candidates: [],
      emptyReason: `recommended list unavailable; ${allScopeHint(listing)} lists every model it serves`,
    };
  }
  const rank = new Map<string, number>();
  if (discovered?.kind === "rows") {
    const catalogById = new Map(catalogRows.map((m) => [m.id, m]));
    recommendedIds.forEach((id, i) => {
      const row = catalogById.get(id);
      if (!row) return;
      const wire = resolveProviderExternalId(listing.provider, row);
      if (!rank.has(wire)) rank.set(wire, i);
    });
  } else {
    recommendedIds.forEach((id, i) => {
      if (!rank.has(id)) rank.set(id, i);
    });
  }
  const kept = candidates
    .filter((m) => rank.has(m.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  if (kept.length > 0) return { candidates: kept };
  return {
    candidates: [],
    emptyReason: `it serves none of the recommended models; ${allScopeHint(listing)} lists every model it serves`,
  };
}

/** Pinned specs first, then the listed rows, de-duplicated by `(provider, model-with-markers)`. */
function assembleRows(
  input: {
    listing: ProviderListing;
    isLocal: boolean;
    discovered: PickerDiscoveryOutcome | null;
    declared: readonly string[] | null;
  },
  candidates: ModelInfo[]
): LineupRow[] {
  const { listing, isLocal, discovered, declared } = input;
  const provider = listing.provider;
  const providerName = lineupProviderName(provider);
  // A discovered or declared row's id is already the wire id; a catalog row's
  // wire id is its connection's for this provider.
  const idIsWire = discovered?.kind === "rows" || (declared !== null && declared.length > 0);

  const listed = new Map<string, { spec: string; model: ModelInfo }>();
  for (const m of candidates) {
    const spec = lineupSpecFor(provider, idIsWire ? m.id : resolveProviderExternalId(provider, m));
    const key = rowKey(spec);
    if (!listed.has(key)) listed.set(key, { spec, model: m });
  }

  const rows: LineupRow[] = [];
  const seen = new Set<string>();
  for (const pinned of listing.pinnedSpecs) {
    const key = rowKey(pinned);
    if (seen.has(key)) continue;
    seen.add(key);
    const match = listed.get(key)?.model;
    rows.push(
      rowFrom(provider, providerName, isLocal, pinned, match, parseModelSpec(pinned).model)
    );
  }
  for (const [key, { spec, model }] of listed) {
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(rowFrom(provider, providerName, isLocal, spec, model, model.id));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The time-limited builder
// ---------------------------------------------------------------------------

type Stage = "credential" | "list" | "recommended";

function stageSentence(stage: Stage, deadlineMs: number): string {
  const seconds = `${Math.round(deadlineMs / 1000)} s`;
  switch (stage) {
    case "credential":
      return `no answer within ${seconds} while resolving its credential (a 1Password unlock may be waiting)`;
    case "list":
      return `no answer within ${seconds} while fetching its model list`;
    case "recommended":
      return `no answer within ${seconds} while reading the recommended list`;
  }
}

/** Why a provider that is not ready lists nothing. Never names an API key for a login-backed provider. */
export function notReadyReason(provider: string): string {
  const def = getProviderByName(provider);
  if (def?.oauthLoginSlug) {
    return `not signed in — run \`claudish login ${def.oauthLoginSlug}\``;
  }
  if (def && def.apiKeyEnvVar === "" && def.isLocal !== true) {
    return `no ${lineupProviderName(provider)} sign-in found on this machine`;
  }
  return describeMissingCredential(provider);
}

/** The `Check <ENV>` line a credential failure earns, or undefined. */
function credentialCheck(provider: string, outcome: PickerDiscoveryOutcome): string | undefined {
  if (outcome.kind !== "failed") return undefined;
  const kind = outcome.failure.kind;
  if (kind !== "unauthorized" && kind !== "no-credentials") return undefined;
  const envVar = getProviderByName(provider)?.apiKeyEnvVar;
  return envVar
    ? `check ${envVar} (a value in your shell overrides stored credentials)`
    : undefined;
}

/** Recommended canonical ids, in recommendation-tier order, then priority. */
export function recommendedIdsOf(doc: RecommendedModelsDoc): string[] {
  const tierIndex = new Map<string, number>(
    RECOMMENDATION_SECTIONS.map((s, i) => [s.recommendationTier, i])
  );
  const ranked = doc.models
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => tierIndex.has(m.recommendationTier))
    .sort(
      (a, b) =>
        (tierIndex.get(a.m.recommendationTier) ?? 0) -
          (tierIndex.get(b.m.recommendationTier) ?? 0) ||
        (a.m.priority ?? 0) - (b.m.priority ?? 0) ||
        a.i - b.i
    );
  const ids: string[] = [];
  for (const { m } of ranked) if (!ids.includes(m.id)) ids.push(m.id);
  return ids;
}

function defaultDeps(): LineupDeps {
  // The lineup's rows read the catalog routing reads (`readAllModelsCache`):
  // the disk catalog of any age, else the bundled recommended list once the
  // backend is settled as unreachable. The client's own default is the
  // disk-only reader, which lists nothing offline. Readiness waits
  // (`ensureCatalogReady`) keep reading the disk only. Read on each call, never
  // memoized, so nothing outlives the bundled-list condition.
  let catalog: ReturnType<typeof createCatalogClient> | null = null;
  const catalogOf = () => {
    catalog ??= createCatalogClient({ readSlimCache: () => readAllModelsCache() });
    return catalog;
  };
  return {
    ready: (provider) => pickerProviderReady(provider),
    storedList: (provider) => readAccountModelsList(provider),
    liveList: (provider) => liveOrStoredModelsCatalog(provider, "launch-lineup"),
    catalogRows: (provider) => {
      try {
        return servedModelsForProvider(provider, catalogOf());
      } catch {
        return [];
      }
    },
    catalogIsBundled: () => bundledListActive(),
    ensureCatalog: (ms) => ensureCatalogReady(Math.max(0, ms)).catch(() => undefined),
    recommended: async () => {
      if (bundledListActive()) return bundledRecommendedModelsDoc();
      try {
        const { getRecommendedModels } = await import("../model-loader.js");
        const doc = await getRecommendedModels();
        if (doc) return doc;
      } catch {
        // Falls through: the bundled list may have become the catalog meanwhile.
      }
      return bundledListActive() ? bundledRecommendedModelsDoc() : null;
    },
    declaredModels: (provider) => {
      try {
        const endpoints = loadConfig().customEndpoints ?? {};
        if (!Object.prototype.hasOwnProperty.call(endpoints, provider)) return null;
        const models = (endpoints[provider] as { models?: unknown }).models;
        return Array.isArray(models)
          ? models.filter((m): m is string => typeof m === "string")
          : [];
      } catch {
        return null;
      }
    },
    tier: (provider) => getProviderByName(provider)?.tier ?? "gateway",
    hasDiscovery: (provider) => Boolean(getProviderByName(provider)?.modelDiscovery),
    now: () => Date.now(),
  };
}

/** A promise that settles to `fallback` after `ms`, or to the value when it lands first. */
function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

const TIMED_OUT = Symbol("timed-out");

/**
 * Every listed provider's rows, in parallel, resolved by `deadlineMs` from the
 * start. Never rejects. A provider still pending at the deadline is
 * `not-listed`, naming the stage it was waiting on; a list that lands later is
 * stored for the next launch by the refresh itself, never added to this one.
 */
export async function buildModelLineup(
  listings: readonly ProviderListing[],
  opts: { deadlineMs?: number; deps?: Partial<LineupDeps> } = {}
): Promise<ModelLineup> {
  const deadlineMs = opts.deadlineMs ?? LINEUP_WAIT_MS;
  const deps: LineupDeps = { ...defaultDeps(), ...opts.deps };
  const startedAt = deps.now();
  const remaining = () => Math.max(0, deadlineMs - (deps.now() - startedAt));

  const tiers = new Map(listings.map((l) => [l.provider, safeTier(deps, l.provider)]));
  const needsRecommended = listings.some(
    (l) =>
      tiers.get(l.provider) === "gateway" &&
      l.scope === "recommended" &&
      safeDeclared(deps, l.provider) === null
  );
  const recommendedPromise: Promise<RecommendedModelsDoc | null> | null = needsRecommended
    ? deps.recommended().catch(() => null)
    : null;

  const stages = new Map<string, Stage>();
  const settled = new Map<string, { rows: LineupRow[]; outcome: ProviderLineupOutcome }>();

  const one = async (listing: ProviderListing): Promise<void> => {
    const provider = listing.provider;
    const notListed = (reason: string) =>
      settled.set(provider, { rows: [], outcome: { kind: "not-listed", provider, reason } });
    try {
      stages.set(provider, "credential");
      const ready = await deps.ready(provider).catch(() => false);
      if (!ready) {
        notListed(notReadyReason(provider));
        return;
      }

      const tier = tiers.get(provider) ?? "gateway";
      const isLocal = getProviderByName(provider)?.isLocal === true;
      const declared = safeDeclared(deps, provider);

      stages.set(provider, "list");
      let discovered: PickerDiscoveryOutcome | null = null;
      let source: LineupSource = "catalog";
      let storedAt: number | undefined;

      if (declared && declared.length > 0) {
        source = "declared";
      } else if (deps.hasDiscovery(provider) && (declared === null || listing.scope === "all")) {
        // A custom endpoint that declares no models lists nothing on `<name>@`
        // (only `<name>@*` lists what it discovers), so it is never asked.
        const asked = await discoverFor(provider, deps, remaining());
        discovered = asked.discovered;
        source = asked.source;
        storedAt = asked.storedAt;
        if (discovered.kind !== "rows" && listing.pinnedSpecs.length === 0) {
          const check = credentialCheck(provider, discovered);
          const reason = discoveryEmptyReason(discovered) ?? "it lists no chat models";
          notListed(check ? `${reason}; ${check}` : reason);
          return;
        }
      } else if (declared === null) {
        await deps.ensureCatalog(remaining());
      }

      const catalogRows = declared === null ? deps.catalogRows(provider) : [];
      // Named right after the rows are read, so `bundled` says where these rows came from.
      if (source === "catalog" && declared === null && deps.catalogIsBundled()) source = "bundled";

      let recommendedIds: string[] | null = null;
      if (tier === "gateway" && listing.scope === "recommended" && declared === null) {
        stages.set(provider, "recommended");
        const doc = recommendedPromise ? await within(recommendedPromise, remaining(), null) : null;
        recommendedIds = doc ? recommendedIdsOf(doc) : null;
      }

      const built = lineupRowsForProvider({
        listing,
        tier,
        isLocal,
        discovered,
        catalogRows,
        recommendedIds,
        declared,
      });
      if (built.rows.length === 0) {
        notListed(built.emptyReason ?? "it lists no chat models");
        return;
      }
      const servedTotal =
        tier === "gateway" && listing.scope === "recommended" && declared === null
          ? discovered?.kind === "rows"
            ? discovered.rows.length
            : catalogRows.length
          : undefined;
      settled.set(provider, {
        rows: built.rows,
        outcome: {
          kind: "listed",
          provider,
          count: built.rows.length,
          source,
          ...(storedAt !== undefined ? { storedAt } : {}),
          ...(servedTotal !== undefined && servedTotal > built.rows.length ? { servedTotal } : {}),
        },
      });
    } catch (err) {
      notListed(redactSecrets(err instanceof Error ? err.message : String(err)));
    } finally {
      stages.delete(provider);
    }
  };

  const all = Promise.all(listings.map(one)).then(() => undefined);
  const result = await within(all, remaining(), TIMED_OUT);
  if (result === TIMED_OUT) log(`[model-lineup] deadline of ${deadlineMs} ms reached`);

  const rows: LineupRow[] = [];
  const outcomes: ProviderLineupOutcome[] = [];
  for (const listing of listings) {
    const done = settled.get(listing.provider);
    if (done) {
      rows.push(...done.rows);
      outcomes.push(done.outcome);
      continue;
    }
    const stage = stages.get(listing.provider) ?? "credential";
    outcomes.push({
      kind: "not-listed",
      provider: listing.provider,
      reason: stageSentence(stage, deadlineMs),
    });
  }
  return { rows, outcomes };
}

/**
 * A discovery provider's list: the account's stored list when there is one
 * (a fresher one is fetched for the next launch, not awaited), else the live
 * answer. The catalog warms beside it, for the rows' prices and wire ids.
 */
async function discoverFor(
  provider: string,
  deps: LineupDeps,
  remainingMs: number
): Promise<{
  discovered: PickerDiscoveryOutcome;
  source: "stored" | "live";
  storedAt?: number;
}> {
  const catalogWarm = deps.ensureCatalog(remainingMs);
  const stored = await deps.storedList(provider).catch(() => null);
  let outcome: ModelsCatalogOutcome;
  if (stored) {
    outcome = servedOutcomeOf(stored.models);
    void deps.liveList(provider).catch(() => undefined);
  } else {
    outcome = await deps.liveList(provider);
  }
  await catalogWarm;
  const discovered = outcomeFromModelsCatalog(
    provider,
    lineupProviderName(provider),
    outcome,
    deps.catalogRows(provider)
  );
  return stored
    ? { discovered, source: "stored", storedAt: stored.fetchedAt }
    : { discovered, source: "live" };
}

function safeTier(deps: LineupDeps, provider: string): RouteTier {
  try {
    return deps.tier(provider);
  } catch {
    return "gateway";
  }
}

function safeDeclared(deps: LineupDeps, provider: string): string[] | null {
  try {
    return deps.declaredModels(provider);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report and overlay value
// ---------------------------------------------------------------------------

/**
 * The context window the session is sized for, one rule for every launch: the
 * user's own `CLAUDE_CODE_MAX_CONTEXT_TOKENS` when set (a user value always
 * wins), else the main thread's window claudish computed when above 0, else
 * the window Claude Code assumes for an id it does not recognize.
 */
export function sessionWindow(env: NodeJS.ProcessEnv, computedWindow: number): number {
  const raw = env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  const user = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(user) && user > 0) return user;
  if (computedWindow > 0) return computedWindow;
  return CLAUDE_CODE_DEFAULT_MAX_CONTEXT;
}

export type LineupPosture = "claude-start" | "claude-model-start" | "foreign-start" | "tiers";

const PREFIX = "[claudish] ";

/**
 * The restore promise, printed by the launch only once the restore watch has
 * registered this session (`ModelSettingWatch.registered`); an inert watch
 * reports its own cause instead.
 */
export const MODEL_RESTORE_PROMISE = `/model: Enter saves a pick as Claude Code's default; claudish puts your setting back at exit ("s" picks for this session only)`;

/**
 * The launch's stderr lines for the lineup. Pure. Printed before Claude Code
 * takes the screen, in quiet mode too: a provider whose rows are missing must
 * say why.
 */
export function lineupReport(
  lineup: ModelLineup,
  ctx: {
    sizedFor: number;
    settingsNotices: string[];
    posture: LineupPosture;
    inheritedModelVars: Array<{ name: string; value: string }>;
  }
): string[] {
  const listed = lineup.outcomes.filter(
    (o): o is Extract<ProviderLineupOutcome, { kind: "listed" }> => o.kind === "listed"
  );
  const lines: string[] = [summaryLine(lineup.rows.length, listed)];
  for (const o of lineup.outcomes) {
    if (o.kind !== "not-listed") continue;
    lines.push(
      `${PREFIX}/model: ${lineupProviderName(o.provider)} not listed — ${redactSecrets(o.reason)}`
    );
  }
  for (const o of listed) {
    if (o.source !== "bundled") continue;
    lines.push(
      `${PREFIX}/model: ${lineupProviderName(o.provider)} list is partial (the cloud models catalog was unreachable; it lists recommended models only)`
    );
  }
  const windowLine = smallerWindowLine(lineup.rows, ctx.sizedFor);
  if (windowLine) lines.push(windowLine);
  for (const notice of ctx.settingsNotices) lines.push(`${PREFIX}/model: ${redactSecrets(notice)}`);
  if (ctx.posture === "foreign-start") {
    lines.push(
      `${PREFIX}/model: this session starts on a foreign model, so a Claude row runs that start model`
    );
  } else if (ctx.posture === "tiers") {
    lines.push(
      `${PREFIX}/model: Claude rows run your mapped tiers; an unmapped Claude row is not served on this launch`
    );
  }
  for (const { name, value } of ctx.inheritedModelVars) {
    const shown = redactSecrets(value);
    lines.push(
      name === "ANTHROPIC_MODEL"
        ? `${PREFIX}starts on ${shown} from ANTHROPIC_MODEL in your environment`
        : `${PREFIX}${name}=${shown} from your environment still applies`
    );
  }
  return lines;
}

/** `/model lists 52 models after Claude's own: Devin 31 · OpenRouter 10 (recommended; 'or@*' lists 312)`. */
function summaryLine(
  rowCount: number,
  listed: ReadonlyArray<Extract<ProviderLineupOutcome, { kind: "listed" }>>
): string {
  if (rowCount === 0) {
    return `${PREFIX}/model lists no claudish models this session; Claude's own models only`;
  }
  const parts = listed.map((o) => {
    const name = lineupProviderName(o.provider);
    if (o.servedTotal === undefined) return `${name} ${o.count}`;
    return `${name} ${o.count} (recommended; '${shortestShortcut(o.provider)}@*' lists ${o.servedTotal})`;
  });
  const noun = rowCount === 1 ? "model" : "models";
  return `${PREFIX}/model lists ${rowCount} ${noun} after Claude's own: ${parts.join(" · ")}`;
}

/** How many listed rows are smaller than the window the session is sized for, and the smallest; null when none. */
function smallerWindowLine(rows: readonly LineupRow[], sizedFor: number): string | null {
  const smaller = rows.filter((r) => r.contextLength !== undefined && r.contextLength < sizedFor);
  if (smaller.length === 0) return null;
  const smallest = smaller.reduce((a, b) =>
    (a.contextLength ?? 0) <= (b.contextLength ?? 0) ? a : b
  );
  const verb = smaller.length === 1 ? "model has" : "models have";
  return (
    `${PREFIX}/model: ${smaller.length} listed ${verb} a smaller context window than this session ` +
    `assumes (${formatContextLength(sizedFor)}; smallest: ${smallest.label} ${formatContextLength(smallest.contextLength)})`
  );
}

function shortestShortcut(provider: string): string {
  const def = getProviderByName(provider);
  return def?.shortestPrefix || def?.shortcuts?.[0] || provider;
}

/** What the settings layers say about `modelPicker` and `availableModels`. */
export interface ModelPickerSources {
  /** The highest non-managed layer that sets `modelPicker`. */
  user: { where: string; options: unknown[]; replaceBuiltInOptions?: unknown } | null;
  /** The managed settings file, when it sets `modelPicker`. */
  managed: string | null;
  /** Every layer (managed included) that sets `availableModels`. */
  availableModels: string[];
}

/**
 * One `modelPicker.options` entry. claudish's own rows carry exactly `model`,
 * `label` and `description`; a user's row keeps every field it was written
 * with (`behavesAs` included).
 */
export interface ModelPickerOption {
  model: string;
  label: string;
  description?: string;
  [field: string]: unknown;
}

/**
 * A user's own `modelPicker` row, passed through with its fields intact.
 * Claude Code takes `modelPicker` from the highest layer and merges nothing,
 * so a field dropped here is gone for the whole session: a row's `behavesAs`
 * decides the request shape Claude Code sends for its model. Only `model` is
 * required; a missing or non-string `label` becomes the model.
 */
function userOption(entry: unknown): ModelPickerOption | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const { model, label } = record;
  if (typeof model !== "string" || model.length === 0) return null;
  return { ...record, model, label: typeof label === "string" ? label : model };
}

/**
 * Whether a `modelPicker` row's `model` is an explicit claudish model spec the
 * proxy can route as sent: `provider@model` on a provider claudish knows
 * (builtin or a registered custom endpoint). A Claude name, a `claude@` spec,
 * a raw URL, a legacy prefix and an unknown `x@` are not.
 */
function isRoutableClaudishSpec(model: string): boolean {
  if (nativeRouteFor(model) !== null) return false;
  const parsed = parseModelSpec(model);
  if (!parsed.isExplicitProvider || parsed.isLegacySyntax) return false;
  if (parsed.provider === "custom-url" || parsed.provider === "native-anthropic") return false;
  return getProviderByName(parsed.provider) !== undefined;
}

/**
 * The user's own `modelPicker` rows the proxy must route as picked, beside the
 * lineup's rows: every option of the overlay value that is not a lineup row and
 * whose `model` is an explicit claudish model spec. Without them a foreign-start
 * launch replaces such a pick with the start model. A Claude row keeps its own
 * rule (role mapping, the start model, or the native passthrough), and a row
 * that names no claudish provider is left to that same rule. Pure.
 */
export function routedUserRows(
  options: readonly ModelPickerOption[],
  rows: readonly LineupRow[]
): Array<{ model: string; label: string }> {
  const listed = new Set(rows.map((row) => row.model));
  const out: Array<{ model: string; label: string }> = [];
  for (const option of options) {
    if (listed.has(option.model) || !isRoutableClaudishSpec(option.model)) continue;
    listed.add(option.model);
    out.push({ model: option.model, label: option.label });
  }
  return out;
}

/**
 * The overlay's `modelPicker` value and its notices. Pure. The user's own rows
 * (from the highest layer that sets them) come first, each with every field it
 * was written with; claudish's rows after, de-duplicated by `model`. claudish's
 * own rows NEVER carry `behavesAs`, and the value NEVER carries
 * `replaceBuiltInOptions`: Claude's own rows stay, and no listed model's
 * behaviour is assumed.
 */
export function modelPickerSetting(
  rows: readonly LineupRow[],
  sources: ModelPickerSources
): { setting: { options: ModelPickerOption[] }; notices: string[] } {
  const options: ModelPickerOption[] = [];
  const seen = new Set<string>();
  for (const entry of sources.user?.options ?? []) {
    const option = userOption(entry);
    if (!option || seen.has(option.model)) continue;
    seen.add(option.model);
    options.push(option);
  }
  for (const row of rows) {
    if (seen.has(row.model)) continue;
    seen.add(row.model);
    options.push({ model: row.model, label: row.label, description: row.description });
  }
  const notices: string[] = [];
  if (sources.user && sources.user.replaceBuiltInOptions === true) {
    notices.push(
      `${sources.user.where} sets modelPicker.replaceBuiltInOptions; claudish keeps Claude's own rows in /model for this session`
    );
  }
  if (sources.managed) {
    notices.push(
      `${sources.managed} sets modelPicker, which Claude Code applies over claudish's rows; listed models may be missing from /model`
    );
  }
  for (const where of sources.availableModels) {
    notices.push(`${where} sets availableModels, which may hide listed models from /model`);
  }
  return { setting: { options }, notices };
}
