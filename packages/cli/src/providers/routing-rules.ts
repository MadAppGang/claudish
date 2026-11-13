import { resolveSubscriptionRouting } from "../adapters/model-catalog.js";
import { credentials } from "../auth/credentials/authority.js";
import { openRouterKeyPresent } from "../auth/credentials/openrouter-key-presence.js";
import type { ReadinessResult } from "../auth/credentials/types.js";
import { type ResolvedDefaultProvider, resolveDefaultProvider } from "../default-provider.js";
import { isSubscriptionProvider } from "../handlers/shared/remote-provider-types.js";
import { log, logStderr } from "../logger.js";
import type { RecommendedModelsDoc } from "../model-loader.js";
import { loadConfig, loadLocalConfig } from "../profile-config.js";
import type { RoutingEntry, RoutingRules } from "../profile-config.js";
import { readAllModelsCache } from "./all-models-cache.js";
import { DISPLAY_NAMES, PROVIDER_TO_PREFIX } from "./auto-route.js";
import { bundledListLabel } from "./bundled-list-data.js";
import { catalogOrigin, getCatalogEntries, resolveExternalId } from "./catalog-client.js";
import type { ConnectionPrice } from "./connection-price.js";
import { FRESH_MS, LIVE_MS } from "./dynamic-models-catalog-store.js";
import {
  type AccountModelsList,
  type AccountModelsListSnapshot,
  isPersistedListProvider,
  readAccountModelsList,
  refreshAccountModelsList,
} from "./dynamic-models-catalog.js";
import { ensureEndpointsRegistered } from "./endpoint-registration.js";
import {
  type GatewayWireLists,
  gatewayWireIdFor,
  isGatewayBound,
  loadGatewayWireLists,
} from "./gateway-wire-lists.js";
import { type AvailabilityNetwork, providerServesModel } from "./model-availability.js";
import { discoverProviderServedIds } from "./model-discovery.js";
import { AUTO_ROUTE_PROVIDER, PROVIDER_SHORTCUTS } from "./model-parser.js";
import { parseModelSpec } from "./model-parser.js";
import {
  type NativeRoute,
  claudeSubscriptionSpecRefusal,
  proxyRouteDecision,
} from "./native-route.js";
import { PREDEFINED_ENDPOINTS } from "./predefined-catalog.js";
import { type RouteTier, getAllProviders, getProviderByName } from "./provider-definitions.js";
import {
  type RouteCandidate,
  catalogDeniesProvider,
  catalogMapsOnlyOptIn,
  catalogModelId,
  compareRouteCandidates,
  findCatalogEntry,
  gatherRouteCandidates,
} from "./route-candidates.js";
import { buildCredentialHint } from "./routing-hints.js";
import { shadowedEndpointRefusal } from "./shadowed-endpoint.js";
import {
  describeUnknownShortcut,
  isKnownProviderName,
  typedShortcutOf,
} from "./unknown-shortcut.js";

export interface RoutingRuleSources {
  globalRules: RoutingRules;
  localRules: RoutingRules;
  recommendedModels?: RecommendedModelsDoc;
}

/**
 * Load the user's effective routing rules. Two layers, both the user's own:
 *   1. Global config (~/.claudish/config.json)
 *   2. Local config (./.claudish.json)
 *
 * Local overwrites global by exact key match — no glob-vs-glob interleaving.
 *
 * THERE ARE NO BUILT-IN RULES. The providers that can serve a bare name are
 * GATHERED from the cloud models catalog (`route-candidates.ts`), which
 * publishes every tier — subscriptions, native APIs and gateways — for every
 * model; a hand-written table merged under the user's rules could only
 * approximate that. So the result here is frequently `{}`, and `explainBareName`
 * treats "no rule matched" as "ask the catalog" rather than as an error.
 *
 * What a user rule now MEANS is therefore stronger than it was: a match is used
 * VERBATIM and is never merged with, reordered by or appended to by anything —
 * including the fallback hop. `routing["*"] = []` is consequently still the
 * strict no-route switch it always was, and `routing["*"] = [...]` replaces the
 * fallback outright.
 *
 * `sources` keeps rule composition testable without reading machine config.
 * The recommended-model projection is not a routing-rule override.
 *
 * Prints nothing. It runs inside the config TUI and the `--probe` TUI, where a
 * stray stderr line lands in the middle of a frame, and on every `route()` call.
 * Problems in the rules are {@link routingRuleProblems}'s to report: the proxy
 * prints them once at startup, and `explainRoute` returns them as warnings.
 */
export function loadRoutingRules(sources?: RoutingRuleSources): RoutingRules {
  const { localRules: local, globalRules: global_ } = sources ?? loadRoutingRuleSources();
  return { ...global_, ...local };
}

/**
 * The two rule tables `loadRoutingRules` merges, read from this machine's config
 * and kept apart: global (`~/.claudish/config.json`, or the `--config` file) and
 * project (`./.claudish.json`). A caller that must say WHICH file a matched rule
 * came from (`explainRoute`) reads them here and merges them itself.
 */
export function loadRoutingRuleSources(): RoutingRuleSources {
  const localRules = loadLocalConfig()?.routing ?? {};
  const globalRules = loadConfig().routing ?? {};
  return { globalRules, localRules };
}

/**
 * Validate that every provider name a routing rules table references exists.
 * The `unknown-provider` problems of {@link routingRuleProblems}, thrown.
 *
 * Throws, so it is for a caller that wants a typo to be loud — a config
 * validator or a test — never the request path. `loadRoutingRules` deliberately
 * does not call it: a user whose hand-written rule names a provider claudish
 * dropped should get a degraded chain and a warning (`routingRuleProblems`), not
 * a crash on every request.
 *
 * Its subject used to be the shipped table, which is gone. What remains to
 * check is the USER's rules, which is the only table left.
 */
export function validateRoutingRulesAgainstProviders(rules: RoutingRules): void {
  // The scope is not part of the message; the table is checked as one file.
  const unknown = ruleTableProblems(rules, "global").filter(
    (problem) => problem.problem === "unknown-provider"
  );

  if (unknown.length > 0) {
    const lines = unknown.map((u) => {
      const entry = u.entry ?? "";
      return `  rule "${u.pattern}" → entry "${entry}" → unknown provider "${ruleEntryProvider(entry)}"`;
    });
    throw new Error(`[claudish] routing rules reference unknown providers:\n${lines.join("\n")}`);
  }
}

/** A problem in the user's routing rules that would make them silently misbehave. */
export interface RoutingRuleProblem {
  /** The config file the rule is in. */
  scope: RuleScope;
  /** The rule key as stored. */
  pattern: string;
  problem: "multiple-wildcards" | "case-collision" | "unknown-provider";
  /** `unknown-provider` only: the rule entry, as written, that names no provider. */
  entry?: string;
  /** `case-collision` only: the earlier key in the same file this one collides with. */
  collidesWith?: string;
}

/**
 * Every problem in the user's two rule files. It reads no file and prints
 * nothing, so a TUI can show the result and the proxy can print it once.
 *
 * `unknown-provider` asks the provider registry, so the CALLER registers the
 * custom and bundled endpoints first (`ensureEndpointsRegistered`); without that
 * every custom endpoint a rule names reads as a typo. A bundled endpoint is known
 * by its catalog row, since registration skips one whose key is absent: that rule
 * entry is `no-credential` when routed, not a typo.
 *
 * Each file is checked on its own, as the rules have always been: a key that
 * collides only with a key in the OTHER file is not reported.
 *
 * An empty chain is not a problem: `[]` is the user's explicit no-route.
 */
export function routingRuleProblems(sources: {
  globalRules: RoutingRules;
  localRules: RoutingRules;
}): RoutingRuleProblem[] {
  return [
    ...ruleTableProblems(sources.globalRules, "global"),
    ...ruleTableProblems(sources.localRules, "project"),
  ];
}

function ruleTableProblems(rules: RoutingRules, scope: RuleScope): RoutingRuleProblem[] {
  const problems: RoutingRuleProblem[] = [];
  // Track lower-cased keys to catch case-insensitive collisions. Matching is
  // case-insensitive, so two keys that differ only in case will silently
  // collapse to whichever the iteration order favors.
  const seenLower = new Map<string, string>();
  for (const key of Object.keys(rules)) {
    // Multi-wildcard patterns only use the first *, rest become literals
    if (key !== "*" && (key.match(/\*/g) || []).length > 1) {
      problems.push({ scope, pattern: key, problem: "multiple-wildcards" });
    }
    const lower = key.toLowerCase();
    const prior = seenLower.get(lower);
    if (prior !== undefined && prior !== key) {
      problems.push({ scope, pattern: key, problem: "case-collision", collidesWith: prior });
    } else {
      seenLower.set(lower, key);
    }
    for (const entry of rules[key] ?? []) {
      if (!isKnownProvider(ruleEntryProvider(entry))) {
        problems.push({ scope, pattern: key, problem: "unknown-provider", entry });
      }
    }
  }
  return problems;
}

/**
 * The claudish provider a rule entry names: the part before an optional
 * `@<wire id>`, with a shortcut (`or`) resolved, exactly as `buildRoutingChain`
 * resolves it.
 */
function ruleEntryProvider(entry: RoutingEntry): string {
  const atIdx = entry.indexOf("@");
  const providerRaw = atIdx === -1 ? entry : entry.slice(0, atIdx);
  return PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();
}

/** A built-in provider, a registered endpoint, or a bundled endpoint's catalog row. */
function isKnownProvider(provider: string): boolean {
  return (
    getProviderByName(provider) !== undefined ||
    PREDEFINED_ENDPOINTS.some((row) => row.name.toLowerCase() === provider)
  );
}

/** One line for a rule problem, without a "[claudish]" prefix (logStderr adds it). */
export function describeRoutingRuleProblem(problem: RoutingRuleProblem): string {
  switch (problem.problem) {
    case "multiple-wildcards":
      return (
        `routing pattern "${problem.pattern}" (${problem.scope}) has more than one * — ` +
        "only a single * is supported, so it may not match as expected."
      );
    case "case-collision":
      return (
        `routing patterns "${problem.collidesWith}" and "${problem.pattern}" (${problem.scope}) ` +
        "differ only in case. Matching ignores case, so one silently shadows the other: " +
        "pick one casing and remove the duplicate."
      );
    case "unknown-provider": {
      const entry = problem.entry ?? "";
      return (
        `routing rule "${problem.pattern}" (${problem.scope}) names "${entry}", but no ` +
        `provider "${ruleEntryProvider(entry)}" exists, so that entry never routes.`
      );
    }
  }
}

/**
 * Match a model name against routing rules. Case-INSENSITIVE — provider
 * docs and catalogs use mixed casing (`MiniMax-M2.5`, `GPT-4o`) but the
 * underlying APIs accept any case, so users get bitten when copy-paste
 * casing doesn't exactly match a lowercase rule key.
 *
 * Priority: exact → longest glob → "*" catch-all → null (the catalog decides).
 *
 * NOTE: only the rule LOOKUP is lowered. The original `modelName` casing is
 * preserved when the route is built and sent to provider APIs (some are
 * case-sensitive on their own model IDs).
 *
 * The chain of the key {@link matchRoutingRuleKey} returns, so the two cannot
 * disagree about which rule a name matches.
 */
export function matchRoutingRule(modelName: string, rules: RoutingRules): RoutingEntry[] | null {
  const key = matchRoutingRuleKey(modelName, rules);
  // Catch-all included: its chain may be an empty array, which the caller treats
  // as "no route".
  return key === null ? null : rules[key];
}

/**
 * The rule KEY a model name matches, spelled exactly as it is stored in
 * `rules`, or `null` when no rule matches.
 *
 * Priority, as {@link matchRoutingRule} applies it: an exact key compared
 * case-insensitively (the stored spelling is returned, not the model name), then
 * the longest matching glob, then `"*"`.
 *
 * A display needs the key, not the chain: two rules can name the same chain, and
 * "which rule decided this" is the question a user asks when a model goes
 * somewhere they did not expect. Returning the stored key also lets a caller
 * that knows where each key came from (global or project config) name the
 * scope.
 */
export function matchRoutingRuleKey(modelName: string, rules: RoutingRules): string | null {
  const lowered = modelName.toLowerCase();

  // 1. Exact match (case-insensitive over rule keys)
  for (const key of Object.keys(rules)) {
    if (!key.includes("*") && key.toLowerCase() === lowered) return key;
  }

  // 2. Glob patterns (sorted longest-first = most specific)
  const globKeys = Object.keys(rules)
    .filter((k) => k !== "*" && k.includes("*"))
    .sort((a, b) => b.length - a.length);

  for (const pattern of globKeys) {
    if (globMatch(pattern, modelName)) return pattern;
  }

  // 3. Catch-all
  if (rules["*"] !== undefined) return "*";

  return null;
}

/**
 * Convert routing entries to Route objects.
 * Plain name "provider" uses originalModelName.
 * Explicit "provider@model" uses the specified model.
 *
 * An entry whose subscription plan does not include the model is dropped (see
 * {@link resolveRoutingEntries}, which keeps it, marked, for `explainRoute`).
 */
export function buildRoutingChain(
  entries: RoutingEntry[],
  originalModelName: string,
  cachePath?: string
): Route[] {
  return resolveRoutingEntries(entries, originalModelName, cachePath)
    .filter((resolved) => !resolved.exclusion)
    .map((resolved) => resolved.route);
}

/** One routing entry turned into a route, or kept only to say why it was not. */
interface ResolvedEntry {
  route: Route;
  /**
   * Set when the entry is excluded before any credential is read. `route` then
   * carries the name it would have been asked by, since no wire id was resolved.
   *
   * - `excluded-by-membership`: the entry's subscription plan publishes a
   *   membership that does not include the model.
   * - `excluded-by-content-use`: the provider maps the model only through a
   *   content-use opt-in wire id, which claudish never chooses (`content-use.ts`).
   * - `gateway-id-unknown`: the bundled recommended list keeps no connection for
   *   this gateway, and its models list has no exact id for the model.
   */
  exclusion?: PreFilterExclusion;
  /** With `gateway-id-unknown`: the models list could not be read at all. */
  gatewayListUnreadable?: true;
  /** With `gateway-id-unknown`: claudish has no models list to ask this gateway for. */
  gatewayHasNoList?: true;
}

/** The outcomes that remove a candidate before the credential filter runs. */
type PreFilterExclusion =
  | "excluded-by-membership"
  | "excluded-by-content-use"
  | "gateway-id-unknown";

/** Whether a candidate was removed before the credential filter, i.e. never reaches it. */
function isPreFilterExclusion(outcome: CandidateOutcome): boolean {
  return (
    outcome === "excluded-by-membership" ||
    outcome === "excluded-by-content-use" ||
    outcome === "gateway-id-unknown"
  );
}

/**
 * {@link buildRoutingChain}'s loop, keeping the entries plan membership excludes
 * instead of skipping them. `buildRoutingChain` drops those; `explainRoute`
 * reports them as `excluded-by-membership`. One loop, so the chain a request
 * uses and the chain a display explains cannot drift apart.
 */
function resolveRoutingEntries(
  entries: RoutingEntry[],
  originalModelName: string,
  cachePath?: string,
  opts: { gatewayLists?: GatewayWireLists } = {}
): ResolvedEntry[] {
  const resolved: ResolvedEntry[] = [];

  for (const entry of entries) {
    const atIdx = entry.indexOf("@");
    let providerRaw: string;
    let modelName: string;

    if (atIdx !== -1) {
      providerRaw = entry.slice(0, atIdx);
      modelName = entry.slice(atIdx + 1);
    } else {
      providerRaw = entry;
      modelName = originalModelName;
    }

    // Resolve shortcut
    const provider = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();

    // Subscription endpoints speak their own wire ids (Kimi Code serves `k3`,
    // not the catalog's `kimi-k3`). When the entry didn't pin a model
    // explicitly, translate via the catalog — and drop the candidate outright
    // when the plan doesn't include this model, so the chain falls through to a
    // provider that can actually serve it instead of erroring or silently
    // handing back a different model.
    let wireIdResolved = false;
    if (atIdx === -1) {
      const routing = resolveSubscriptionRouting(modelName, provider, cachePath);
      if (routing.kind === "not-served") {
        resolved.push({
          route: routeFor(provider, modelName),
          exclusion: "excluded-by-membership",
        });
        continue;
      }
      // The provider publishes this model ONLY through a content-use opt-in
      // wire id. Sending the plain name would ask a route for an id it never
      // published, and sending the opt-in id would choose it for the user
      // (`content-use.ts`). A `["zgo"]` rule for `gemini-4-argon` lands here.
      if (routing.kind !== "serves" && catalogMapsOnlyOptIn(provider, modelName, cachePath)) {
        resolved.push({
          route: routeFor(provider, modelName),
          exclusion: "excluded-by-content-use",
        });
        continue;
      }
      if (routing.kind === "serves") {
        modelName = routing.externalId;
        // Already the plan's wire id — do NOT resolve again below, or the
        // generic lookup would translate an external id a second time.
        wireIdResolved = true;
      }
    }

    // Every provider's wire id comes from the SAME catalog lookup
    // (`aggregators[]`), not a per-provider resolver. This is what makes
    // `ag@gemini-3.6-flash` reach `gemini-3.6-flash-high` and
    // `together-ai@glm-5` reach `zai-org/GLM-5` without either provider
    // needing bespoke code. No match → the name passes through unchanged.
    if (!wireIdResolved) {
      const externalId = resolveExternalId(modelName, provider, cachePath);
      if (externalId === null && atIdx === -1 && readsGatewayList(provider, cachePath)) {
        const answer = gatewayListAnswer(provider, modelName, opts.gatewayLists);
        if (answer.wireId === undefined) {
          resolved.push({
            route: routeFor(provider, modelName),
            exclusion: "gateway-id-unknown",
            ...(answer.unreadable ? { gatewayListUnreadable: true as const } : {}),
            ...(answer.noList ? { gatewayHasNoList: true as const } : {}),
          });
          continue;
        }
        modelName = answer.wireId;
      } else {
        modelName = externalId ?? modelName;
      }
    }

    resolved.push({ route: routeFor(provider, modelName) });
  }

  return resolved;
}

/**
 * A gateway-bound provider whose wire id can only come from its own models list:
 * the bundled recommended list is the catalog source and keeps no gateway
 * connections. A disk catalog publishes gateway connections, so a `cachePath`
 * never reaches this.
 */
function readsGatewayList(provider: string, cachePath: string | undefined): boolean {
  if (cachePath || catalogOrigin() !== "bundled") return false;
  const registry = readAllModelsCache()?.routeRegistry?.registry;
  return registry !== undefined && isGatewayBound(provider, registry);
}

/** The wire id `provider`'s list holds for the model, or why there is none. */
function gatewayListAnswer(
  provider: string,
  model: string,
  gatewayLists: GatewayWireLists | undefined
): { wireId?: string; unreadable?: boolean; noList?: boolean } {
  const list = gatewayLists?.get(provider);
  if (list === "no-list") return { noList: true };
  if (list === undefined || list === "unreadable") return { unreadable: true };
  const entries = getCatalogEntries();
  const entry = entries ? findCatalogEntry(entries, model) : undefined;
  return { wireId: gatewayWireIdFor(entry?.modelId ?? model, entry?.provider, list) };
}

/**
 * The gateways whose models list one decision must load: only gateway-bound
 * entries that name no model and have no bundled connection, so a chain with no
 * gateway hop asks nothing.
 */
function gatewayListsNeeded(
  entries: RoutingEntry[],
  model: string,
  cachePath: string | undefined
): string[] {
  const providers = entries
    .filter((entry) => !entry.includes("@"))
    .map(ruleEntryProvider)
    .filter(
      (provider) =>
        readsGatewayList(provider, cachePath) &&
        resolveExternalId(model, provider, cachePath) === null
    );
  return [...new Set(providers)];
}

/**
 * One provider plus the id it will actually be SENT → a `Route`.
 *
 * The ONE copy of the modelSpec rule, which has exactly one exception:
 * OpenRouter's ids are already vendor-qualified (`moonshotai/kimi-k3`), so they
 * are their own spec, while everyone else takes a provider prefix. Both callers
 * go through here — `buildRoutingChain`, which resolves a wire id from a user
 * rule, and the catalog-candidate adapter, which is HANDED one — so the rule
 * cannot drift between the two paths. `wireIdOf` is its inverse and would
 * silently disagree if a second copy appeared.
 */
function routeFor(provider: string, wireId: string): Route {
  const modelSpec =
    provider === "openrouter" ? wireId : `${PROVIDER_TO_PREFIX[provider] ?? provider}@${wireId}`;
  return { provider, modelSpec, displayName: DISPLAY_NAMES[provider] ?? provider };
}

/**
 * Single-wildcard glob: "kimi-*" matches "kimi-k2.5". Case-INSENSITIVE so
 * `MiniMax-M2.5` matches `minimax-*` and `GPT-4o` matches `gpt-*`. Provider
 * docs use mixed casing, model IDs in catalogs are usually lowercase, but
 * users routinely paste from docs and would otherwise hit the catch-all.
 */
function globMatch(pattern: string, value: string): boolean {
  const star = pattern.indexOf("*");
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (star === -1) return p === v;
  const prefix = p.slice(0, star);
  const suffix = p.slice(star + 1);
  return v.startsWith(prefix) && v.endsWith(suffix) && v.length >= prefix.length + suffix.length;
}

// ---------------------------------------------------------------------------
// route() — single routing entry point (plan §B.3)
// ---------------------------------------------------------------------------

/** A single resolved route candidate. */
export interface Route {
  /** Canonical provider name (e.g. "openai", "openrouter"). */
  provider: string;
  /** Ready-to-handle "provider@model" string for downstream handler creation. */
  modelSpec: string;
  /** Human-readable provider label. */
  displayName: string;
}

/**
 * Result of resolving a model spec.
 *
 *   - `kind: "ok"`        — at least one credentialed provider was found.
 *                           `primary` is the first; `fallbacks` follow in order.
 *   - `kind: "no-route"`  — either the explicit prefix had no credentials
 *                           configured, or the chain was empty after credential
 *                           filtering. `hint` is a multi-line message with
 *                           actionable suggestions.
 */
export type RoutePlan =
  | { kind: "ok"; primary: Route; fallbacks: Route[] }
  | { kind: "no-route"; reason: string; hint?: string };

/**
 * Check whether the user has credentials for a given canonical provider.
 *
 * Delegates to the credential authority's sync readiness oracle. The authority's
 * per-provider impls replicate every special case this function used to inline:
 *   - `native-anthropic` requires an explicit ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 *     (NativeAnthropicCredentialProvider).
 *   - `openai-codex` requires its codex-specific key or OAuth — the OPENAI_API_KEY
 *     alias is excluded (the Codex composite's API-key half has no aliases).
 *   - Local transports (ollama, lmstudio, vllm, mlx) require explicit enablement
 *     (LocalCredentialProvider → isLocalProviderEnabled).
 *   - OAuth-backed providers (kimi, antigravity) accept an OAuth file or env
 *     key; the oauthFallback affordance is honored by ApiKeyCredentialProvider.
 *     (A `publicKeyFallback` affordance also used to be honored here; it was
 *     removed — a keyless provider now declares `authScheme: "none"`.)
 *
 * Equivalence with the previous inline logic is pinned by
 * auth/credentials/equivalence.test.ts.
 */
export async function hasCredentialsForProvider(provider: string): Promise<boolean> {
  return credentials.isAvailable(provider);
}

// ---------------------------------------------------------------------------
// explainRoute() — the routing decision, every candidate, and why
// ---------------------------------------------------------------------------

/** Which config file a user rule came from. */
export type RuleScope = "global" | "project";

/**
 * What became of one route candidate. `kept` is a hop of the routing chain;
 * every other value names the step that removed the candidate.
 */
export type CandidateOutcome =
  /** Passed the credential and availability filters: a hop of the routing chain. */
  | "kept"
  /** The credential filter found no credential. */
  | "no-credential"
  /** A SUBSCRIPTION's credential exists but could not be read (1Password, Keychain). */
  | "credential-unreadable"
  /** The account's dynamic models catalog denies the model. */
  | "not-served"
  /** The subscription plan's published membership does not include the model. */
  | "excluded-by-membership"
  /**
   * The provider maps the model only through a content-use opt-in wire id, which
   * claudish never chooses; typed exactly (`provider@<id>`), it is sent.
   */
  | "excluded-by-content-use"
  /**
   * An explicit spec's shortcut names no claudish provider (`isKnownProviderName`).
   * Decided before any credential is read.
   */
  | "unknown-provider"
  /**
   * The bundled recommended list keeps no connection for this gateway, and its
   * models list has no exact id for the model, or could not be read.
   */
  | "gateway-id-unknown";

/** One route candidate, where the chain placed it, and what became of it. */
export interface ExplainedCandidate {
  /** claudish provider. */
  provider: string;
  displayName: string;
  /** Exactly the `Route.modelSpec` a kept candidate becomes. */
  modelSpec: string;
  /**
   * The wire id this candidate sends. For `excluded-by-membership`, the name it
   * would have been asked by: no wire id is resolved for a plan that excludes it.
   */
  wireId: string;
  /**
   * `fallback` is the fallback hop's POSITION, appended after the catalog's own
   * candidates. It is independent of `outcome`: an uncredentialed fallback is
   * `no-credential` and is dropped like any other candidate.
   */
  position: "candidate" | "fallback";
  /** The definition's tier; absent for a name no definition carries. */
  tier?: RouteTier;
  /** Catalog-gathered candidates only: the model's own vendor's route. */
  isVendorOwn?: boolean;
  /** Catalog-gathered candidates only. */
  price?: ConnectionPrice;
  /** Catalog-gathered candidates only, when the catalog publishes one. */
  contextWindow?: number;
  outcome: CandidateOutcome;
  /** With `gateway-id-unknown`: the models list could not be read at all. */
  gatewayListUnreadable?: true;
  /** With `gateway-id-unknown`: claudish has no models list to ask this gateway for. */
  gatewayHasNoList?: true;
  /** Credential evidence, including typed account-list failures retained for signing. */
  credentialReadiness?: ReadinessResult;
  /**
   * Kept candidates whose availability was checked: `serves` when the account
   * confirmed the model, `unknown` when nothing denied it.
   */
  availability?: "serves" | "unknown";
  /**
   * `off-catalog`: a comparison candidate for a native name the catalog has no
   * entry for. Nothing published it; it is listed so a probe can ask the vendor's
   * own API about the name, whose answer (a 404 for a typo) is the evidence.
   */
  origin?: "off-catalog";
}

/** Why a target has no route. */
export type NoRouteCause =
  /** A user rule matched and nothing survived plan membership, a matched `[]` included. */
  | "rule-empty"
  /** No cloud models catalog could be read and no account's list carries the name. */
  | "catalog-unreadable"
  /** The catalog was read and gathered nothing, and no fallback hop survived. */
  | "catalog-empty"
  /**
   * Every candidate was removed before the credential filter, and at least one is a
   * gateway hop with no exact id (`gateway-id-unknown`): its models list lacks the
   * model, could not be read, or does not exist.
   */
  | "gateway-id-unknown"
  /** Every remaining candidate lacked a credential, or its credential could not be read. */
  | "no-credential"
  /** The account's dynamic models catalog denied every credentialed candidate. */
  | "not-served"
  /** An explicit spec's shortcut names no claudish provider (`describeUnknownShortcut`). */
  | "explicit-unknown-shortcut"
  /** An explicit spec's provider has no credential. */
  | "explicit-no-credential"
  /** An explicit spec's plan membership excludes the model, so no route could be built. */
  | "explicit-unbuildable"
  /** An explicit spec's provider does not serve the model. */
  | "explicit-not-served"
  /**
   * A spec refused before any routing: a `claude@` spec the Claude
   * subscription refuses (a marker, a `:N` suffix, a `+` chain hop, a name
   * Claude Code does not own), or a spec (as given, or a matched user rule's
   * entry) on a custom endpoint name a Claude builtin took over
   * (`shadowedEndpointRefusal`).
   */
  | "explicit-refused";

/**
 * The decision. It mirrors `RoutePlan.kind` field for field, which is what makes
 * {@link toRoutePlan} a 1:1 map: `hint` is present, possibly as `undefined`,
 * exactly where `route()` has always set it.
 */
export type RouteOutcome =
  | { kind: "ok" }
  | { kind: "no-route"; cause: NoRouteCause; reason: string; hint?: string };

/**
 * Why the fallback hop was not appended to a catalog-gathered chain. The first
 * condition that holds, in the order `buildCatalogChain` tests them.
 */
export type FallbackWithheld =
  /** `defaultProvider` is `""`. */
  | "disabled"
  /** No cloud models catalog: claudish never invents a hop without one. */
  | "catalog-unreadable"
  /** The bundled recommended list answered and no one set up a default provider. */
  | "bundled-no-default-provider"
  /** The catalog already gathered that provider. */
  | "already-gathered"
  /** The fallback's route is backend-owned and the catalog maps it no connection to this model. */
  | "catalog-denies";

/**
 * Something the user should know about a decision. `route()` prints the two
 * billing notices to stderr. `explainRoute` never writes; a display shows these
 * instead. A `rule-problem` comes only from `explainRoute` when it read the rule
 * files itself: it is about the config, not about this decision, and the proxy
 * prints it once at startup rather than per request.
 */
export type RouteWarning =
  | { type: "rule-problem"; problem: RoutingRuleProblem; message: string }
  | {
      type: "subscription-not-served";
      providers: string[];
      /** The claudish provider the request lands on. */
      usedInstead: string;
      message: string;
    }
  | {
      type: "subscription-credential-unreadable";
      providers: string[];
      /** The claudish provider the request lands on. */
      usedInstead: string;
      message: string;
    };

/** The routing decision for one target, with every candidate and why. */
export interface RouteExplanation {
  /** The target as passed. */
  requestedModel: string;
  /**
   * The name rules and the catalog were asked about: a known `vendor/` stripped,
   * `normalizeGlmSlug` applied. For an explicit target, the model part of the
   * spec (`anthropic/<id>` verbatim); for a native target, the target.
   */
  routedModel: string;
  /** Where the chain came from. ORIGIN only: `outcome` says whether it routed. */
  source: "native" | "explicit" | "user-rule" | "catalog";
  /** Explicit only: how the target named its provider. */
  via?: "model-spec" | "vendor-qualified-id" | "poe";
  /** User rule only: the rule key as stored, a matched `[]` included. */
  matchedPattern?: string;
  /** User rule only, when `explainRoute` loaded the rules itself. */
  ruleScope?: RuleScope;
  /** Catalog only: whether the cloud models catalog could be read and had the name. */
  catalog?: "found" | "absent" | "unreadable";
  /**
   * The catalog this decision read: a disk catalog or the bundled recommended
   * list. Absent when neither exists, or on a path that reads no catalog.
   */
  catalogSource?: "disk" | "bundled";
  /** Chain order. A dropped candidate stays where the chain placed it. `[]` for native. */
  candidates: ExplainedCandidate[];
  /** Catalog only, when the fallback hop was not appended. */
  fallbackWithheld?: FallbackWithheld;
  outcome: RouteOutcome;
  warnings: RouteWarning[];
  /** Native only: what the native passthrough sends, on Claude Code's own auth. */
  native?: NativeRoute;
  /**
   * A BARE native target explained with `comparison` only: the model's other
   * catalog routes, gathered with no user rule and no fallback hop, the native
   * provider removed before the credential filter, each with its outcome. Plus
   * one off-catalog `anthropic` candidate when the catalog has no entry for the
   * name. Display only: never a `RoutePlan`, never a hop of any request; a
   * launch of the name still takes the Claude subscription.
   */
  comparisonCandidates?: ExplainedCandidate[];
  /** With `comparisonCandidates`: whether the catalog could be read and had the name. */
  comparisonCatalog?: "found" | "absent" | "unreadable";
}

export interface ExplainRouteOptions {
  /**
   * Absent: the global and project rules are loaded here, so `ruleScope` is known
   * and their problems are returned as `rule-problem` warnings.
   */
  rules?: RoutingRules;
  /**
   * Absent: `route()`'s rule. With `rules` passed nothing is read
   * ({@link NO_READ_DEFAULT_PROVIDER}); otherwise
   * {@link effectiveDefaultProviderResolution}. `"resolve"` reads it even with
   * `rules` passed.
   */
  defaultProvider?: DefaultProviderArg;
  cachePath?: string;
  /** Absent: `"await"`. See {@link RouteNetwork}. */
  network?: RouteNetwork;
  /**
   * For a BARE native target (not `claude@`, not a tier alias): also list the
   * model's other catalog routes as `comparisonCandidates`, for a display that
   * compares them. The decision itself is unchanged.
   */
  comparison?: boolean;
}

/**
 * Whether routing may wait on a provider's discovery endpoint. `await` (the
 * default) is the request path and every diagnosis a user waits for (`--probe`).
 * `background` is a launch: availability answers from the account's stored
 * dynamic models catalog and from what this process holds, starts the refreshes,
 * and never waits for one.
 */
export type RouteNetwork = AvailabilityNetwork;

/** The `catalogSource` of a decision that reads `cachePath`'s file, else the default path's. */
function explanationCatalogSource(
  cachePath: string | undefined
): Pick<RouteExplanation, "catalogSource"> {
  const origin = cachePath ? (readAllModelsCache(cachePath) ? "disk" : "none") : catalogOrigin();
  return origin === "none" ? {} : { catalogSource: origin };
}

/** A route as an explained candidate. `gathered` is the catalog candidate it came from, if any. */
function explainCandidate(
  route: Route,
  position: ExplainedCandidate["position"],
  outcome: CandidateOutcome,
  gathered?: RouteCandidate
): ExplainedCandidate {
  const tier = gathered ? gathered.tier : getProviderByName(route.provider)?.tier;
  return {
    provider: route.provider,
    displayName: route.displayName,
    modelSpec: route.modelSpec,
    wireId: wireIdOf(route),
    position,
    ...(tier !== undefined ? { tier } : {}),
    ...(gathered ? { isVendorOwn: gathered.isVendorOwn, price: gathered.price } : {}),
    ...(gathered?.contextWindow !== undefined ? { contextWindow: gathered.contextWindow } : {}),
    outcome,
  };
}

/** The outcome of a resolved routing entry before any credential is read. */
function entryOutcome(resolved: ResolvedEntry): CandidateOutcome {
  return resolved.exclusion ?? "kept";
}

/** A resolved routing entry as an explained candidate, with why it was excluded. */
function explainEntry(
  resolved: ResolvedEntry,
  position: ExplainedCandidate["position"]
): ExplainedCandidate {
  const candidate = explainCandidate(resolved.route, position, entryOutcome(resolved));
  if (resolved.gatewayListUnreadable) candidate.gatewayListUnreadable = true;
  if (resolved.gatewayHasNoList) candidate.gatewayHasNoList = true;
  return candidate;
}

/** Unknown Codex account configuration must reach the handler's typed response. */
function isCodexAccountsFailure(provider: string, verdict?: ReadinessResult): boolean {
  return (
    provider === "openai-codex" &&
    verdict?.readiness === "failed" &&
    verdict.failureReason === "accounts-list"
  );
}

/**
 * Path 1: an explicit "provider@model" spec. Probe ONLY that provider's
 * credentials; never fall back silently.
 */
async function explainExplicitSpec(
  requestedModel: string,
  modelSpec: string,
  model: string,
  provider: string,
  cachePath?: string,
  network: RouteNetwork = "await"
): Promise<RouteExplanation> {
  // FIRST, ahead of every credential read: a shortcut that names no provider is
  // answered as unknown, never as "no credentials". No authority lookup, readiness
  // probe or 1Password attempt runs for a name that cannot exist (D9). This check
  // must stay ahead of any credential read added to this function later.
  if (!isKnownProviderName(provider)) {
    return explainUnknownShortcut(requestedModel, modelSpec, model, provider, cachePath);
  }

  const readiness: ReadinessResult =
    provider === "openai-codex"
      ? await credentials.describeReadiness(provider)
      : { readiness: (await hasCredentialsForProvider(provider)) ? "present" : "absent" };
  const accountsFailed = isCodexAccountsFailure(provider, readiness);
  const credentialed = readiness.readiness === "present" || accountsFailed;

  // The one candidate is built whatever the credential says, so a display can
  // name what the spec asks for. Built AFTER the credential read, the order
  // route() has always used; building it is a catalog lookup and nothing else.
  const [resolved] = resolveRoutingEntries([modelSpec], model, cachePath);
  const candidate = explainCandidate(resolved.route, "candidate", entryOutcome(resolved));
  candidate.credentialReadiness = readiness;
  const explanation: RouteExplanation = {
    requestedModel,
    routedModel: model,
    source: "explicit",
    via: "model-spec",
    ...explanationCatalogSource(cachePath),
    candidates: [candidate],
    outcome: { kind: "ok" },
    warnings: [],
  };

  if (!credentialed) {
    candidate.outcome = "no-credential";
    explanation.outcome = {
      kind: "no-route",
      cause: "explicit-no-credential",
      reason: `No credentials configured for "${provider}".`,
      hint: buildCredentialHint(model, [provider]) ?? undefined,
    };
    return explanation;
  }

  if (resolved.exclusion) {
    explanation.outcome = {
      kind: "no-route",
      cause: "explicit-unbuildable",
      reason: `Could not build a route for "${modelSpec}".`,
    };
    return explanation;
  }

  // An explicit address is NEVER silently dropped — the user named this vendor,
  // so a "does not serve it" verdict is something to TELL them, not something to
  // route around. That is the difference from the bare path, where claudish
  // assembled the chain itself and may quietly pick another link.
  //
  // Without this the request still fails, just later and less clearly: OpenCode
  // Zen Go answers for a model it does not carry with HTTP 401, which reads as a
  // credential problem and sends the user to check a key that works.
  // Do not discover with an unknown account list or let cached discovery erase it.
  const availability = accountsFailed
    ? "unknown"
    : await providerServesModel(candidate.provider, candidate.wireId, { network });
  // Keeps the account's stored list current for the next decision; never
  // awaited, and a no-op when the availability check just fetched it.
  if (isPersistedListProvider(candidate.provider)) {
    void refreshAccountModelsList(candidate.provider, "route-explicit");
  }
  if (availability === "not-served") {
    candidate.outcome = "not-served";
    explanation.outcome = {
      kind: "no-route",
      cause: "explicit-not-served",
      reason: `${candidate.displayName} does not serve "${model}".`,
      hint:
        `Check the model id, or use a bare \`${model}\` to let claudish pick a provider ` +
        "that carries it.",
    };
    return explanation;
  }

  candidate.availability = availability;
  return explanation;
}

/**
 * An explicit spec whose shortcut names no claudish provider. The one candidate
 * names what was typed, with no tier and no catalog lookup; the outcome carries
 * `describeUnknownShortcut`'s wording, which every surface prints verbatim.
 */
function explainUnknownShortcut(
  requestedModel: string,
  modelSpec: string,
  model: string,
  provider: string,
  cachePath?: string
): RouteExplanation {
  const { reason, hint } = describeUnknownShortcut(
    typedShortcutOf(modelSpec),
    model,
    cachePath,
    modelSpec
  );
  return {
    requestedModel,
    routedModel: model,
    source: "explicit",
    via: "model-spec",
    candidates: [
      {
        provider,
        displayName: provider,
        modelSpec,
        wireId: model,
        position: "candidate",
        outcome: "unknown-provider",
      },
    ],
    outcome: { kind: "no-route", cause: "explicit-unknown-shortcut", reason, hint },
    warnings: [],
  };
}

/**
 * The provider that occupies the LAST hop, or null when the user disabled it.
 *
 * The fallback is a POSITION, not a property of any provider (see `RouteTier`).
 * Two ways to empty that position, and BOTH are preserved from the design this
 * replaced:
 *
 *   - `defaultProvider: ""` — an explicitly empty string. "No preference" is not
 *     the same thing: it resolves to `openrouter`, which is what the deleted
 *     `"*": ["openrouter"]` catch-all used to supply for 1,109 models. Only a
 *     deliberate empty string disables.
 *   - a user rule that matches — `routing["*"] = []` most explicitly. That
 *     never reaches here at all: a matched rule is used verbatim and this
 *     function is only consulted on the gathered path.
 */
function fallbackProviderFor(defaultProvider: ResolvedDefaultProvider): string | null {
  const named = defaultProvider.provider;
  if (named.length === 0) return null;
  return PROVIDER_SHORTCUTS[named.toLowerCase()] ?? named.toLowerCase();
}

/**
 * The provider the last hop takes when the user expressed no preference.
 *
 * A rule, not a pinned model id: it names the one gateway that resells nearly
 * every vendor, which is why the deleted table used it as its catch-all. It is
 * overridden by `defaultProvider` and emptied by `defaultProvider: ""`.
 */
export const DEFAULT_FALLBACK_PROVIDER = "openrouter";

/**
 * The `defaultProvider` this process routes with when no caller named one:
 * `CLAUDISH_DEFAULT_PROVIDER`, then `defaultProvider` in the config file, then an
 * OpenRouter key in any store, then `openrouter` (`resolveDefaultProvider`). May
 * be `""`, which disables the fallback hop.
 *
 * Read per call, like the rules. `route()` without overrides and `--probe`'s
 * chain both read it here, so the two cannot name different fallback hops. The
 * `--default-provider` flag arrives through the env variable (index.ts exports it).
 */
export function effectiveDefaultProviderResolution(): ResolvedDefaultProvider {
  return resolveDefaultProvider({
    config: loadConfig(),
    env: process.env,
    hasOpenRouterKey: openRouterKeyPresent,
  });
}

/** The provider {@link effectiveDefaultProviderResolution} names. May be `""`. */
export function effectiveDefaultProvider(): string {
  return effectiveDefaultProviderResolution().provider;
}

/**
 * The fallback argument of `route()` and `explainRoute`. A resolution says which
 * provider holds the last position and where that came from; `"resolve"` asks
 * for {@link effectiveDefaultProviderResolution}. A bare string is not accepted:
 * what a fallback may do depends on its source, and a string has none.
 */
export type DefaultProviderArg = ResolvedDefaultProvider | "resolve";

/**
 * The fallback of a caller that passed rules and no fallback. Nothing is read
 * from the machine, which is what keeps this machine's setting out of a call that
 * states its own rules.
 */
export const NO_READ_DEFAULT_PROVIDER: ResolvedDefaultProvider = {
  provider: DEFAULT_FALLBACK_PROVIDER,
  source: "hardcoded",
  legacyAutoPromoted: false,
};

/**
 * The one rule for what a `route()` or `explainRoute` call falls back to.
 * Resolved per decision and only for a bare name: an explicit spec never gets
 * here. Rules passed with no fallback read nothing; passing `"resolve"` is how a
 * caller with rules asks for the machine's setting.
 */
function resolveFallbackArg(
  arg: DefaultProviderArg | undefined,
  rulesPassed: boolean
): ResolvedDefaultProvider {
  if (arg === "resolve") return effectiveDefaultProviderResolution();
  if (arg !== undefined) return arg;
  return rulesPassed ? NO_READ_DEFAULT_PROVIDER : effectiveDefaultProviderResolution();
}

/** A chain assembled from the catalog, plus whether a catalog could be read. */
export interface CatalogChain {
  routes: Route[];
  /**
   * False means NO catalog was readable — not merely that it lacked this name.
   * A caller must treat that as "claudish cannot answer", never as "no provider
   * serves it": the two look identical in `routes` and only this tells them
   * apart.
   */
  catalogReadable: boolean;
}

/**
 * Steps 2 and 3 of the bare-name path: gather from the catalog, then append the
 * fallback hop. No credential or availability filtering — those belong to
 * `explainBareName`, which owns them, and duplicating either here would create
 * the second oracle `route-candidates.ts` exists to avoid.
 *
 * Exported for `route-candidates.test.ts`, which checks the gathered chain and
 * the fallback append apart from the two filters. No display calls it: `--probe`
 * and the config TUI render `explainRoute`, which runs these two steps
 * (`explainCatalogChain`) and then the filters, exactly as `route()` does.
 */
export function buildCatalogChain(
  model: string,
  defaultProvider: ResolvedDefaultProvider,
  cachePath?: string
): CatalogChain {
  const chain = explainCatalogChain(model, defaultProvider, cachePath);
  return {
    routes: chain.candidates
      .filter((candidate) => !isPreFilterExclusion(candidate.outcome))
      .map(routeOf),
    catalogReadable: chain.catalog !== "unreadable",
  };
}

/** {@link buildCatalogChain}'s two steps, with every candidate kept and the fallback's fate. */
interface CatalogChainExplanation {
  /** Gathered candidates, then the fallback hop; plan-excluded ones marked, not dropped. */
  candidates: ExplainedCandidate[];
  catalog: "found" | "absent" | "unreadable";
  fallbackWithheld?: FallbackWithheld;
}

function explainCatalogChain(
  model: string,
  defaultProvider: ResolvedDefaultProvider,
  cachePath: string | undefined,
  lists?: AccountModelsListSnapshot,
  gatewayLists?: GatewayWireLists
): CatalogChainExplanation {
  // Bundled endpoints (`together`, `fireworks`) have no provider DEFINITION
  // until this has run, and `gatherFromConnections` drops a connection whose
  // provider it cannot resolve — silently, because that is also what a provider
  // the user holds no key for looks like. An earlier preview ran without it and
  // blamed this redesign for 241 unroutable `together-ai` connections it had
  // not caused.
  //
  // Called HERE rather than trusted from a caller: six startup paths register
  // endpoints and this is reachable from all of them plus the MCP server, the
  // launcher's context-window probe and the TUI. Sync, config-only and latched,
  // so every call after the first is free.
  ensureEndpointsRegistered();

  const gathering = gatherRouteCandidates(model, cachePath, lists);
  // The gatherer's excluded candidates join the explanation with THEIR outcome,
  // never `kept`, at the position the chain order gives them. They are shown by
  // `--probe` and never become a hop: every filter below skips them.
  const ordered: Array<{ gathered: RouteCandidate; outcome: CandidateOutcome }> = [
    ...gathering.candidates.map((gathered) => ({ gathered, outcome: "kept" as const })),
    ...gathering.excluded.map(({ candidate, outcome }) => ({ gathered: candidate, outcome })),
  ].sort((a, b) => compareRouteCandidates(a.gathered, b.gathered));
  const candidates = ordered.map(({ gathered, outcome }) =>
    explainCandidate(routeFor(gathered.provider, gathered.wireId), "candidate", outcome, gathered)
  );
  const catalog = !gathering.catalogReadable
    ? "unreadable"
    : gathering.catalogMiss
      ? "absent"
      : "found";

  const fallback = fallbackProviderFor(defaultProvider);
  let fallbackWithheld: FallbackWithheld | undefined;
  if (!fallback) {
    fallbackWithheld = "disabled";
  } else if (!gathering.catalogReadable) {
    // NEVER invent a hop with no catalog: `openrouter@<name>` for a name nobody
    // published is a metered request billed for its own 404, and a name the
    // backend has since RENAMED looks identical.
    fallbackWithheld = "catalog-unreadable";
  } else if (gathering.catalogOrigin === "bundled" && defaultProvider.source === "hardcoded") {
    // The bundled list keeps no gateway connections, so a hop here would be
    // billed without the user having chosen that provider.
    fallbackWithheld = "bundled-no-default-provider";
  } else if (
    candidates.some((candidate) => candidate.provider === fallback && candidate.outcome === "kept")
  ) {
    // A KEPT candidate only: an excluded one is not in the chain, so the fallback
    // still gets its own say (and the catalog's denial, or its own exclusion).
    fallbackWithheld = "already-gathered";
  } else if (catalogDeniesProvider(fallback, model, cachePath)) {
    fallbackWithheld = "catalog-denies";
  } else {
    // Through `resolveRoutingEntries`, not `routeFor`: the fallback is named by
    // PROVIDER only, so its wire id still has to be resolved, and that
    // resolution (subscription plan ids, then the catalog's `aggregators[]`)
    // lives there. It legitimately yields nothing routable when a
    // subscription's plan does not include the model.
    for (const resolved of resolveRoutingEntries([fallback], model, cachePath, { gatewayLists })) {
      candidates.push(explainEntry(resolved, "fallback"));
    }
  }

  return { candidates, catalog, ...(fallbackWithheld ? { fallbackWithheld } : {}) };
}

/**
 * The no-route outcome for a bare name whose only remaining candidates were gateway
 * hops with no exact id. The reason says which of the three list states held, so
 * the user fixes the list or names an id, not a rule or a vendor key.
 */
function gatewayIdUnknownOutcome(model: string, withheld: ExplainedCandidate): RouteOutcome {
  const gateway = withheld.displayName;
  const reason = withheld.gatewayHasNoList
    ? `claudish reads no models list for ${gateway}, so it has no exact id for "${model}".`
    : withheld.gatewayListUnreadable
      ? `${gateway}'s models list could not be read, so claudish has no exact id for "${model}".`
      : `${gateway}'s models list has no exact id for "${model}".`;
  return {
    kind: "no-route",
    cause: "gateway-id-unknown",
    reason,
    hint:
      "Run `claudish --models-refresh` once online, or name the gateway's exact id " +
      `(${withheld.provider}@<id>).`,
  };
}

/** Why a bare name's chain is empty before any credential is read. */
type EmptyChainCause = "rule-empty" | "catalog-empty";

/**
 * The no-route outcome for a bare name whose chain is empty before any
 * credential is read. Two very different causes, and a user reading the message
 * needs to know which: their OWN rule named nothing (they asked for this), or
 * the catalog publishes no way to call the model (nobody serves it).
 */
function emptyChainOutcome(
  model: string,
  nativeProvider: string,
  cause: EmptyChainCause,
  cachePath?: string
): RouteOutcome {
  return {
    kind: "no-route",
    cause,
    reason:
      cause === "rule-empty"
        ? `A routing rule matched "${model}" and named no provider.`
        : `No provider in the catalog serves "${model}".`,
    hint: emptyChainHint(model, nativeProvider, cause, cachePath),
  };
}

/**
 * The hint for a bare name whose chain is empty before any credential is read:
 * a user rule that named no provider, or a catalog that gathered none.
 *
 * `nativeProvider` is the provider the parser attributed the name to, and its
 * credential line is offered when it IS one. `AUTO_ROUTE_PROVIDER` says the
 * parser attributed the name to nobody, so there is no credential to name. Before
 * it existed those names parsed as `native-anthropic`, and the hint told the user
 * to set ANTHROPIC_API_KEY for a model Anthropic does not serve.
 *
 * When the CATALOG gathered nothing for such a name, the `or@<model>` line is
 * also dropped if the catalog denies OpenRouter the model (`catalogDeniesProvider`,
 * the test that withholds the fallback append): it would send the user to a hop
 * nobody published. Not for a matched user rule, whose empty chain is the user's
 * own statement, and not for a name the parser attributes to a provider: that
 * one keeps the line whatever the catalog says, the same flaw, left to a
 * separate fix.
 */
function emptyChainHint(
  model: string,
  nativeProvider: string,
  cause: EmptyChainCause,
  cachePath?: string
): string | undefined {
  if (nativeProvider !== AUTO_ROUTE_PROVIDER) {
    return buildCredentialHint(model, [nativeProvider]) ?? undefined;
  }
  const suggestOpenRouter =
    cause === "rule-empty" || !catalogDeniesProvider("openrouter", model, cachePath);
  return buildCredentialHint(model, [], { suggestOpenRouter }) ?? undefined;
}

/** `route()`'s inputs for a bare name, resolved only once a name is known to be bare. */
interface BareRouting {
  rules: RoutingRules;
  defaultProvider: ResolvedDefaultProvider;
  /** Where a matched rule key came from, when the caller read the two rule files itself. */
  scopeOf?: (ruleKey: string) => RuleScope;
  /** Problems in those two files, when the caller read them itself. */
  ruleProblems?: RoutingRuleProblem[];
}

/** Rule problems as explanation warnings, each with its one-line message. */
function ruleProblemWarnings(problems: RoutingRuleProblem[] | undefined): RouteWarning[] {
  return (problems ?? []).map((problem) => ({
    type: "rule-problem",
    problem,
    message: describeRoutingRuleProblem(problem),
  }));
}

/**
 * Path 2: a bare model name.
 *
 *   1. a user rule matches?  → that chain, VERBATIM. Never merged, reordered or
 *                              appended to, including by the fallback. A match
 *                              of `[]` is a match: the user said "no route".
 *   2. otherwise             → the accounts' dynamic models catalogs
 *                              ({@link loadChainAccountLists}, which waits for
 *                              missing ones on the request path), then
 *                              `gatherRouteCandidates`, which reads every
 *                              connection the catalog publishes for this model,
 *                              adds the vendor claims and account-listed
 *                              candidates, and orders them by tier, vendor,
 *                              price, window.
 *   3. append the fallback   → last, deduped, disableable, and NOT appended when
 *                              the catalog positively denies it.
 *   4. credential filter     → {@link applyCandidateFilters}.
 *   5. availability filter   → {@link applyCandidateFilters}.
 *   6. primary + fallbacks   → {@link toRoutePlan}.
 *
 * Steps 2 and 5 share ONE deadline, {@link MISSING_LIST_WAIT_MS} from the start
 * of step 2: a candidate that survives gathering without its account's list
 * (a catalog connection or a vendor claim) reads `unknown` once it has passed,
 * rather than joining the same unfinished discovery with no bound.
 *
 * Steps 4 and 5 are deliberately NOT duplicated by step 2 — see the header of
 * `route-candidates.ts`. A gathered candidate is a claim about what the catalog
 * publishes, never a claim that this user can call it.
 */
async function explainBareName(
  requestedModel: string,
  model: string,
  nativeProvider: string,
  routing: BareRouting,
  cachePath?: string,
  network: RouteNetwork = "await",
  comparison?: ComparisonGathering
): Promise<RouteExplanation> {
  const deadline = startListDeadline();
  try {
    return await explainBareNameWithin(
      requestedModel,
      model,
      nativeProvider,
      routing,
      deadline.reached,
      cachePath,
      network,
      comparison
    );
  } finally {
    deadline.cancel();
  }
}

/**
 * How a comparison gathering differs from a routing decision's. Routing callers
 * pass none, so their chains are unchanged.
 */
interface ComparisonGathering {
  /**
   * Removed from the candidates BEFORE the credential filter, so their credential
   * provider is never asked. The native provider's can write a 1Password key into
   * `process.env.ANTHROPIC_API_KEY`, which would move a later native child onto
   * metered billing.
   */
  excludeProviders: ReadonlySet<string>;
  /**
   * Appended as an `off-catalog` candidate when the catalog was read and has no
   * entry for the name, so a probe still asks the vendor's own API about it.
   */
  offCatalogProvider: string;
}

/** {@link explainBareName}, under the routing decision's missing-list deadline. */
async function explainBareNameWithin(
  requestedModel: string,
  model: string,
  nativeProvider: string,
  routing: BareRouting,
  deadline: Promise<"deadline">,
  cachePath?: string,
  network: RouteNetwork = "await",
  comparison?: ComparisonGathering
): Promise<RouteExplanation> {
  // `null` and `[]` are DIFFERENT answers and the old `?? []` conflated them.
  // `[]` is a user rule that matched and named no provider — strict no-route,
  // and the one thing that must not then collect a fallback.
  const matchedKey = matchRoutingRuleKey(model, routing.rules);
  const matched = matchedKey === null ? null : routing.rules[matchedKey];

  let explanation: RouteExplanation;
  // A rule entry on a custom endpoint name a Claude builtin took over would
  // reach the builtin, not the user's endpoint: the rule is refused, naming
  // the rename. A plain entry names the provider for this model.
  const ruleShadowed =
    matchedKey !== null && matched !== null
      ? shadowedEndpointRefusal(
          matched.map((entry) => (entry.includes("@") ? entry : `${entry}@${model}`))
        )
      : null;
  if (matchedKey !== null && ruleShadowed !== null) {
    explanation = {
      requestedModel,
      routedModel: model,
      source: "user-rule",
      matchedPattern: matchedKey,
      ...(routing.scopeOf ? { ruleScope: routing.scopeOf(matchedKey) } : {}),
      ...explanationCatalogSource(cachePath),
      candidates: [],
      outcome: { kind: "no-route", cause: "explicit-refused", reason: ruleShadowed },
      warnings: ruleProblemWarnings(routing.ruleProblems),
    };
  } else if (matchedKey !== null && matched !== null) {
    const gatewayLists = await loadGatewayWireLists(
      gatewayListsNeeded(matched, model, cachePath),
      network,
      deadline
    );
    explanation = {
      requestedModel,
      routedModel: model,
      source: "user-rule",
      matchedPattern: matchedKey,
      ...(routing.scopeOf ? { ruleScope: routing.scopeOf(matchedKey) } : {}),
      ...explanationCatalogSource(cachePath),
      candidates: resolveRoutingEntries(matched, model, cachePath, { gatewayLists }).map(
        (resolved) => explainEntry(resolved, "candidate")
      ),
      outcome: { kind: "ok" },
      warnings: ruleProblemWarnings(routing.ruleProblems),
    };
  } else {
    const [accounts, gatewayLists] = await Promise.all([
      loadChainAccountLists(network, deadline),
      loadGatewayWireLists(fallbackListsNeeded(model, routing, cachePath), network, deadline),
    ]);
    const chain = explainCatalogChain(
      model,
      routing.defaultProvider,
      cachePath,
      accounts.lists,
      gatewayLists
    );
    refreshChainCandidateLists(chain.candidates, accounts);
    explanation = {
      requestedModel,
      routedModel: model,
      source: "catalog",
      catalog: chain.catalog,
      ...explanationCatalogSource(cachePath),
      candidates: chain.candidates,
      ...(chain.fallbackWithheld ? { fallbackWithheld: chain.fallbackWithheld } : {}),
      outcome: { kind: "ok" },
      warnings: ruleProblemWarnings(routing.ruleProblems),
    };
  }

  if (comparison) {
    explanation.candidates = explanation.candidates.filter(
      (candidate) => !comparison.excludeProviders.has(candidate.provider)
    );
    if (
      explanation.catalog === "absent" &&
      !explanation.candidates.some((c) => c.provider === comparison.offCatalogProvider)
    ) {
      explanation.candidates.push(offCatalogCandidate(comparison.offCatalogProvider, model));
    }
  }

  const remaining = explanation.candidates.filter(
    (candidate) => !isPreFilterExclusion(candidate.outcome)
  );

  // NO CATALOG MEANS LOCAL ONLY. With nothing readable, claudish knows no
  // provider serves this name and must say so rather than guess. An
  // account-listed candidate still counts — that is the account's own answer
  // about a plan the user holds, not an inference from a catalog it could not
  // read — so the check is on an EMPTY result, not on the catalog being
  // unreadable alone.
  // Local providers and explicit `provider@model` specs are unaffected: neither
  // comes through here.
  if (explanation.catalog === "unreadable" && remaining.length === 0) {
    explanation.outcome =
      explanation.catalogSource === "bundled"
        ? {
            kind: "no-route",
            cause: "catalog-unreadable",
            reason: `No cloud models catalog could be read, and "${model}" is not in the ${bundledListLabel()}.`,
            hint: "Run `claudish --models-refresh` once online, or name the provider explicitly (provider@model).",
          }
        : {
            kind: "no-route",
            cause: "catalog-unreadable",
            reason: `No model catalog available, so "${model}" cannot be routed by name.`,
            hint:
              "Run `claudish --models-refresh` to fetch the catalog, or name the provider " +
              `explicitly (e.g. \`openrouter@${model}\`).`,
          };
    return explanation;
  }

  if (remaining.length === 0) {
    // A gateway hop with no exact id was a candidate, so the chain is not empty
    // by the rule or the catalog: the gateway's models list is why it has no hop.
    const withheld = explanation.candidates.find(
      (candidate) => candidate.outcome === "gateway-id-unknown"
    );
    explanation.outcome = withheld
      ? gatewayIdUnknownOutcome(model, withheld)
      : emptyChainOutcome(
          model,
          nativeProvider,
          explanation.source === "user-rule" ? "rule-empty" : "catalog-empty",
          cachePath
        );
    return explanation;
  }

  // Only the catalog chain waited for missing lists, so only it inherits the
  // bound; a user rule's candidates are filtered exactly as before.
  await applyCandidateFilters(
    explanation,
    remaining,
    network,
    explanation.source === "catalog" ? deadline : undefined
  );
  return explanation;
}

/**
 * The longest a request waits for missing account lists before its routing
 * chain is built. All providers are asked in parallel under this one bound.
 */
export const MISSING_LIST_WAIT_MS = 5_000;

/**
 * The gateway the catalog branch's fallback hop needs a list from. None for a
 * bundled miss or a fallback that will be withheld, so neither pays for a fetch.
 */
function fallbackListsNeeded(
  model: string,
  routing: BareRouting,
  cachePath: string | undefined
): string[] {
  const fallback = fallbackProviderFor(routing.defaultProvider);
  if (!fallback || routing.defaultProvider.source === "hardcoded") return [];
  if (catalogModelId(model, cachePath) === undefined) return [];
  return gatewayListsNeeded([fallback], model, cachePath);
}

/** One routing decision's missing-list deadline: resolves once, then stays resolved. */
interface ListDeadline {
  reached: Promise<"deadline">;
  /** Clears the timer when the decision ends before the deadline. */
  cancel(): void;
}

function startListDeadline(): ListDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), MISSING_LIST_WAIT_MS);
    timer.unref?.();
  });
  return { reached, cancel: () => clearTimeout(timer) };
}

/** The accounts' dynamic models catalogs one routing decision gathers from. */
interface ChainAccountLists {
  /** The lists the gatherer reads, for providers whose credential reads present. */
  lists: AccountModelsListSnapshot;
  /** Providers whose list this decision already refreshed or started refreshing. */
  refreshed: ReadonlySet<string>;
}

/**
 * The accounts' dynamic models catalogs, for every provider that keeps one and
 * whose credential reads present (no 1Password prompt). Read BEFORE the chain is
 * gathered, and the chain is built once from what this returns: nothing
 * rebuilds it when a list lands later.
 *
 * A provider with no list for its current account, or only an expired one, is
 * MISSING. On the request path (`await`) the chain waits for every missing list
 * in parallel, bounded by {@link MISSING_LIST_WAIT_MS}; a list that fails or
 * runs out of time is left out and the chain is built without it. A launch
 * (`background`) starts those fetches and never waits for one.
 *
 * A stored list older than a day is refreshed for the next decision, not awaited:
 * it may still add and confirm candidates now.
 */
async function loadChainAccountLists(
  network: RouteNetwork,
  deadline: Promise<"deadline">
): Promise<ChainAccountLists> {
  const providers = getAllProviders()
    .map((def) => def.name)
    .filter(isPersistedListProvider);
  const refreshed = new Set<string>();

  const listFor = async (provider: string): Promise<AccountModelsList | null> => {
    try {
      const { readiness } = await credentials.describeReadiness(provider, {
        allowOpPrompt: false,
      });
      if (readiness !== "present") return null;
      const stored = await readAccountModelsList(provider);
      if (stored) {
        if (Date.now() - stored.fetchedAt >= FRESH_MS) {
          refreshed.add(provider);
          void refreshAccountModelsList(provider, "route-bare", { minAgeMs: FRESH_MS });
        }
        return stored;
      }
      refreshed.add(provider);
      return await fetchMissingList(provider, network, deadline);
    } catch {
      return null;
    }
  };

  const found = await Promise.all(providers.map(listFor));
  const lists = new Map<string, AccountModelsList>();
  providers.forEach((provider, i) => {
    const list = found[i];
    if (list) lists.set(provider, list);
  });
  return { lists, refreshed };
}

/**
 * A missing list: fetched now. `await` waits for it until `deadline`;
 * `background` starts the fetch and answers `null` at once.
 */
async function fetchMissingList(
  provider: string,
  network: RouteNetwork,
  deadline: Promise<"deadline">
): Promise<AccountModelsList | null> {
  const fetching = refreshAccountModelsList(provider, "cold-account");
  if (network === "background") return null;
  const result = await Promise.race([fetching, deadline]);
  if (result === "deadline") return null;
  if (result.kind === "skipped" && result.reason === "no-credential") {
    return unboundAccountList(provider, deadline);
  }
  return readAccountModelsList(provider);
}

/**
 * The list of an account whose credential reads present but yields no identity
 * material to bind a stored list to: plain discovery, held in this process's
 * memory only and never written, the fallback `providerServesModel` also takes.
 * Without it such an account's subscription would drop out of every gathered
 * chain. `null` when discovery fails, answers nothing, or outlasts `deadline`.
 */
async function unboundAccountList(
  provider: string,
  deadline: Promise<"deadline">
): Promise<AccountModelsList | null> {
  const discovered = await Promise.race([discoverProviderServedIds(provider), deadline]);
  if (discovered === "deadline") return null;
  const models = [...discovered.served, ...discovered.optIn];
  if (models.length === 0) return null;
  const list: AccountModelsList = {
    provider,
    models,
    fetchedAt: Date.now(),
    age: "live",
    mayDeny: true,
  };
  if (discovered.excludedIds?.length) list.excludedIds = discovered.excludedIds;
  return list;
}

/**
 * Start a refresh, never awaited, of each list a gathered chain reads from, so
 * the next decision sees what the account serves now. Skips a provider whose
 * list this decision already asked for: a failed fetch is not repeated at once.
 */
function refreshChainCandidateLists(
  candidates: readonly ExplainedCandidate[],
  accounts: ChainAccountLists
): void {
  const providers = new Set(
    candidates
      .filter((candidate) => candidate.outcome === "kept")
      .map((candidate) => candidate.provider)
  );
  for (const provider of providers) {
    if (!accounts.lists.has(provider) || accounts.refreshed.has(provider)) continue;
    void refreshAccountModelsList(provider, "route-candidate", { minAgeMs: LIVE_MS });
  }
}

/**
 * Steps 4 and 5 of the bare-name path, recorded on each candidate: the
 * credential filter, then the availability filter. Sets the outcome and the two
 * billing warnings. Prints nothing; `route()` prints from the explanation.
 */
async function applyCandidateFilters(
  explanation: RouteExplanation,
  candidates: ExplainedCandidate[],
  network: RouteNetwork = "await",
  deadline?: Promise<"deadline">
): Promise<void> {
  const model = explanation.routedModel;
  const credentialed: ExplainedCandidate[] = [];
  const skipped: string[] = [];
  const skippedFailed: string[] = [];

  // ── ONE CREDENTIAL READ PER CANDIDATE PER ROUTING DECISION ────────────────
  //
  // Resolve each candidate's credentials concurrently (each call funnels through
  // the SDK serialization queue internally), but keep the original chain ORDER
  // when partitioning into credentialed / skipped.
  //
  // A SUBSCRIPTION candidate is described ONCE, and both facts come from that
  // single answer: whether it joins the chain, and — when it does not — whether
  // its credential was ABSENT or FAILED to resolve. Reading twice (a boolean to
  // partition, then `describeReadiness` to ask why) is the trap: the authority
  // memoizes a resolved key but deliberately NOT a failure, so the two reads
  // can disagree, and a credential that recovered between them would fall out
  // of both partitions and erase the evidence of the failure that removed it.
  //
  // Other non-subscription candidates keep the boolean. Codex always needs the
  // full verdict: typed account-list failure is retained, not counted as skipped,
  // even if the process's last signed-arm record currently predicts metered.
  const verdicts = await Promise.all(
    candidates.map(async (candidate): Promise<ReadinessResult> => {
      // Codex needs typed readiness even if an earlier request recorded metered.
      if (candidate.provider === "openai-codex" || isSubscriptionProvider(candidate.provider)) {
        return credentials.describeReadiness(candidate.provider);
      }
      const present = await hasCredentialsForProvider(candidate.provider);
      return { readiness: present ? "present" : "absent" };
    })
  );
  candidates.forEach((candidate, i) => {
    const verdict = verdicts[i];
    candidate.credentialReadiness = verdict;
    if (verdict.readiness === "present" || isCodexAccountsFailure(candidate.provider, verdict)) {
      credentialed.push(candidate);
      return;
    }
    skipped.push(candidate.provider);
    // Measured causes of a real, present subscription key reading as "no key":
    // a concurrent 1Password handshake denial and its 15-second suppression
    // window, a locked Mac, a disabled or denied Keychain backend, and a stale
    // `.env` shadowing the op:// chain. Each one used to route a paid
    // subscription onto a metered provider with NOTHING printed.
    if (verdict.readiness === "failed") {
      skippedFailed.push(candidate.provider);
      candidate.outcome = "credential-unreadable";
    } else {
      candidate.outcome = "no-credential";
    }
  });

  if (credentialed.length === 0) {
    explanation.outcome = {
      kind: "no-route",
      cause: "no-credential",
      reason:
        skipped.length > 0
          ? `No credentialed providers in chain for "${model}" (tried: ${skipped.join(", ")}).`
          : `No providers available for "${model}".`,
      hint: buildCredentialHint(model, skipped) ?? undefined,
    };
    return;
  }

  // AVAILABILITY filter — drop a candidate only when a source positively says
  // it does not carry this model.
  //
  // This runs AFTER the credential filter, not before, and the order is not
  // cosmetic: `providerServesModel` may hit the provider's own discovery endpoint,
  // which needs that provider's credential. Asking about a provider the user
  // cannot authenticate to would be a guaranteed-failing round-trip.
  //
  // Only "not-served" removes anything. "unknown" — no source covers this
  // provider, the catalog is cold, the discovery endpoint was briefly down — keeps
  // the candidate exactly where it was. That asymmetry is the whole safety
  // property: reading absence of evidence as denial would drop every provider
  // neither source covers, which is almost entirely the SUBSCRIPTION providers,
  // and would move users off plans they pay for onto metered hops.
  const availability = await Promise.all(
    credentialed.map((candidate) =>
      isCodexAccountsFailure(candidate.provider, candidate.credentialReadiness)
        ? "unknown"
        : providerServesModel(candidate.provider, candidate.wireId, { network, deadline })
    )
  );
  const serving: ExplainedCandidate[] = [];
  const notServing: string[] = [];
  credentialed.forEach((candidate, i) => {
    const verdict = availability[i];
    if (verdict === "not-served") {
      notServing.push(candidate.provider);
      candidate.outcome = "not-served";
    } else {
      serving.push(candidate);
      candidate.availability = verdict;
    }
  });

  if (serving.length === 0) {
    // Every credentialed provider positively denied carrying this model. That is
    // strong evidence — "unknown" never lands here — so a clear no-route beats
    // sending a request that each of them would reject in turn.
    explanation.outcome = {
      kind: "no-route",
      cause: "not-served",
      reason: `No provider serves "${model}" (checked: ${notServing.join(", ")}).`,
      hint: buildCredentialHint(model, notServing) ?? undefined,
    };
    return;
  }

  // Warn only when the skip changes how the user is billed. A subscription
  // provider dropped in favour of a metered one is a cost change they did not
  // choose — claudish assembled this chain — which is the same reason
  // fallback-handler announces advancing past a spent plan. Every other skip is
  // routine and goes only to the debug log (`emitRouteNotices`).
  if (notServing.length > 0) {
    const droppedSubscription = notServing.filter((p) => isSubscriptionProvider(p));
    if (droppedSubscription.length > 0 && !isSubscriptionProvider(serving[0].provider)) {
      explanation.warnings.push({
        type: "subscription-not-served",
        providers: droppedSubscription,
        usedInstead: serving[0].provider,
        message:
          `${droppedSubscription.join(", ")} does not serve ${model} — ` +
          `using ${serving[0].displayName}, which bills per token.`,
      });
    }
  }

  // A subscription dropped because its credential FAILED gets its own warning,
  // never folded into "does not serve": the remedy differs (unlock the keychain
  // or 1Password, not "pick another model"), and "no key" would tell the user
  // to buy a subscription they already hold. Same billing condition as above —
  // raised only when the request lands on a metered provider.
  if (skippedFailed.length > 0 && !isSubscriptionProvider(serving[0].provider)) {
    explanation.warnings.push({
      type: "subscription-credential-unreadable",
      providers: skippedFailed,
      usedInstead: serving[0].provider,
      message:
        `${skippedFailed.join(", ")}: the credential could not be READ (not "no key") — ` +
        `using ${serving[0].displayName}, which bills per token.`,
    });
  }
}

/**
 * The id a route would actually SEND, extracted from its `modelSpec`.
 *
 * `buildRoutingChain` emits `provider@model` for everyone except OpenRouter,
 * whose ids are already vendor-qualified and are their own spec. Availability
 * must be asked about the wire id, never the name the user typed — comparing the
 * typed name would test the wrong side of an `externalId` mapping, and that
 * mapping is exactly what a dynamic models catalog settles (OpenCode Zen Go serves
 * `deepseek-v4-pro`, while the catalog id carries a date suffix).
 */
function wireIdOf(route: Route): string {
  if (route.provider === "openrouter") return route.modelSpec;
  const at = route.modelSpec.indexOf("@");
  return at === -1 ? route.modelSpec : route.modelSpec.slice(at + 1);
}

/**
 * Rewrite a dash-slugified GLM version to its canonical dotted form
 * (`glm-5-2` → `glm-5.2`), so a client that slugifies dots still finds the
 * catalog entry instead of missing it and falling through to the fallback hop.
 *
 * Anchored and deliberately narrow. The second group must be ALL digits to the
 * end (or to a `-suffix`), which is what keeps dash-native open-model ids
 * intact: `glm-4-9b` and `glm-4-flash` are untouched because "9b" and "flash"
 * are not pure digits.
 *
 * Applied ONLY on the bare-name path, to keep the rewrite's blast radius as
 * small as the problem it solves.
 *
 * To be precise about why that is a choice and not a load-bearing guard:
 * the explicit path forwards the ORIGINAL `modelSpec` to buildRoutingChain, which
 * re-parses it and takes the model from the entry itself, ignoring the `model`
 * argument for any entry containing "@". So normalizing the explicit path would
 * currently be a no-op rather than a bug. Restricting it here means that stays
 * true even if buildRoutingChain's precedence ever changes.
 *
 * That matters because Devin re-serves other vendors' models under uids that
 * legitimately contain dashes, `glm-5-2` and `glm-5-2-1m` among them (see
 * providers/devin/model-id-resolver.ts). Those are matched against Devin's LIVE
 * dynamic models catalog, so a `dv@glm-5-2` that ever became `dv@glm-5.2` would
 * request a uid that does not exist.
 *
 * The bare path is still safe to rewrite. A Devin candidate for a bare name
 * comes only from the account's own dynamic models catalog, and it carries the
 * REQUESTED name as its wire id: the Devin transport resolves `glm-5.2` onto the
 * account's own uid (`glm-5-2`) itself, the same resolution that found the row
 * in the list. No dashed uid is ever rewritten into a request.
 */
export function normalizeGlmSlug(model: string): string {
  return model.replace(
    /^glm-(\d+)-(\d+)(-.*)?$/i,
    (_m, major, minor, suffix) => `glm-${major}.${minor}${suffix ?? ""}`
  );
}

/**
 * Resolve a model name to a provider chain.
 *
 * Two paths:
 *   1. Explicit prefix (`provider@model`): the caller named the vendor. We
 *      probe ONLY that vendor's credentials; missing credentials → no-route
 *      with a credential hint. **No silent fallback** — `defaultProvider` is
 *      not consulted because the user named a specific vendor.
 *   2. Bare name: a matching USER rule wins verbatim; otherwise the chain is
 *      gathered from the cloud models catalog and the fallback hop is appended
 *      last. Then the credential and availability filters. Empty filtered chain
 *      → no-route with hints. See `explainBareName`.
 *
 * Rules and the default provider are loaded fresh each call (via `loadRoutingRules()`
 * and `effectiveDefaultProviderResolution()`) unless overrides are supplied; see
 * `resolveFallbackArg` for what each combination reads. Tests should pass overrides
 * to avoid disk and environment lookups.
 *
 * DERIVED from the explanation. `explainRoutePlan` makes the decision; this
 * prints the notices a request's user must see and returns the kept candidates.
 * `explainRoute` runs the same function, so a display cannot show a chain this
 * does not use.
 */
export async function route(...args: Parameters<typeof routeExplained>): Promise<RoutePlan> {
  return (await routeExplained(...args)).plan;
}

/**
 * {@link route}, with the explanation its plan was derived from, for a caller
 * that has to say why a name did not route.
 */
export async function routeExplained(
  modelSpec: string,
  rulesOverride?: RoutingRules,
  defaultProviderOverride?: DefaultProviderArg,
  cachePath?: string,
  opts: { network?: RouteNetwork } = {}
): Promise<{ plan: RoutePlan; explanation: RouteExplanation }> {
  const explanation = await explainRoutePlan(
    modelSpec,
    () => ({
      rules: rulesOverride ?? loadRoutingRules(),
      defaultProvider: resolveFallbackArg(defaultProviderOverride, rulesOverride !== undefined),
    }),
    cachePath,
    modelSpec,
    opts.network
  );
  emitRouteNotices(explanation);
  return { plan: toRoutePlan(explanation), explanation };
}

/** A spec refused before any routing (`explicit-refused`), with the refusal as its reason. */
function refusedExplanation(target: string, reason: string): RouteExplanation {
  return {
    requestedModel: target,
    routedModel: target,
    source: "explicit",
    via: "model-spec",
    candidates: [],
    outcome: { kind: "no-route", cause: "explicit-refused", reason },
    warnings: [],
  };
}

/**
 * The decision `route()` returns, explained. `route()` and `explainRoute` both
 * call this, which is what keeps the chain a display shows and the chain a
 * request uses the same.
 *
 * An explicit spec is decided BEFORE `bareRouting` runs, so it never loads the
 * rules or reads the default provider, exactly as `route()` never has.
 */
async function explainRoutePlan(
  modelSpec: string,
  bareRouting: () => BareRouting,
  cachePath: string | undefined,
  requestedModel: string = modelSpec,
  network: RouteNetwork = "await"
): Promise<RouteExplanation> {
  const parsed = parseModelSpec(modelSpec);

  if (parsed.isExplicitProvider) {
    const shadowed = shadowedEndpointRefusal([modelSpec]);
    if (shadowed) return refusedExplanation(requestedModel, shadowed);
    // Not normalized here — see normalizeGlmSlug's note on explicit specs.
    return explainExplicitSpec(
      requestedModel,
      modelSpec,
      parsed.model,
      parsed.provider,
      cachePath,
      network
    );
  }

  return explainBareName(
    requestedModel,
    normalizeGlmSlug(parsed.model),
    parsed.provider,
    bareRouting(),
    cachePath,
    network
  );
}

/**
 * The routing decision for `target`, without making it: the provider a request
 * would use, every candidate the chain considered and what removed it, and why.
 * For `--probe` and the config TUI.
 *
 * A `claude@` spec the Claude subscription refuses, and a spec on a custom
 * endpoint name a Claude builtin took over, are answered first, as a no-route
 * (`explicit-refused`), exactly as the proxy refuses them.
 *
 * It starts where the proxy starts, at `proxyRouteDecision`. A `native` target is
 * answered there (no candidates: Claude Code's own auth serves it). `poe:<id>` and
 * `anthropic/<id>` are the explicit targets the proxy serves without `route()`.
 * A `bare` target and a `provider@model` spec run the function `route()` runs,
 * `explainRoutePlan`, with the target the proxy hands `route()` (a bare target's
 * parsed model), so the chain shown is the chain a request uses.
 *
 * Never writes to stderr: the billing notices `route()` prints are on `warnings`.
 */
export async function explainRoute(
  target: string,
  opts: ExplainRouteOptions = {}
): Promise<RouteExplanation> {
  // Checked on the spec as given, as every launch checks it: `proxyRouteDecision`
  // reads `claude@<id>#fast` as the native `<id>`, which no launch serves.
  // So is a spec on a custom endpoint name a Claude builtin took over, which
  // `proxyRouteDecision` would read as that builtin (`claude@<id>` as native).
  const refusal = claudeSubscriptionSpecRefusal(target) ?? shadowedEndpointRefusal([target]);
  if (refusal) return refusedExplanation(target, refusal);
  const decision = proxyRouteDecision(target);

  if (decision.type === "native") {
    const explanation: RouteExplanation = {
      requestedModel: target,
      routedModel: target,
      source: "native",
      candidates: [],
      outcome: { kind: "ok" },
      warnings: [],
      native: decision.route,
    };
    if (opts.comparison && isComparableNativeTarget(target, decision.route)) {
      const compared = await explainComparison(decision.route, opts);
      explanation.comparisonCandidates = compared.candidates;
      explanation.comparisonCatalog = compared.catalog;
    }
    return explanation;
  }
  if (decision.type === "poe") {
    return explainUnroutedExplicit(target, "poe", "poe", decision.model);
  }
  if (decision.type === "explicit" && decision.via === "vendor-qualified-id") {
    return explainUnroutedExplicit(
      target,
      "vendor-qualified-id",
      decision.provider,
      decision.model
    );
  }

  const routeTarget = decision.type === "explicit" ? decision.spec : decision.model;
  return explainRoutePlan(
    routeTarget,
    () => bareRoutingFor(opts),
    opts.cachePath,
    target,
    opts.network
  );
}

/**
 * Whether a native target gets comparison routes: a BARE name only. `claude@<id>`
 * names one route itself, and a tier alias (`opus`) is a selector whose concrete
 * id Claude Code chooses at run time, so no catalog route can be compared for it.
 */
function isComparableNativeTarget(target: string, native: NativeRoute): boolean {
  return !native.isTierAlias && !parseModelSpec(target).isExplicitProvider;
}

/** No fallback hop: a comparison lists what the catalog publishes, nothing more. */
const NO_FALLBACK: ResolvedDefaultProvider = {
  provider: "",
  source: "hardcoded",
  legacyAutoPromoted: false,
};

/**
 * The catalog routes of a bare native name, for display beside the Claude
 * subscription. Gathered by the bare-name path with no user rule (a rule for
 * `claude-*` steers routed names, and this name is never routed) and no fallback,
 * attributed to no provider (`AUTO_ROUTE_PROVIDER`, as any unattributed bare name),
 * with the native provider removed before the credential filter.
 */
async function explainComparison(
  native: NativeRoute,
  opts: ExplainRouteOptions
): Promise<{ candidates: ExplainedCandidate[]; catalog: "found" | "absent" | "unreadable" }> {
  const compared = await explainBareName(
    native.modelSpec,
    native.modelSpec,
    AUTO_ROUTE_PROVIDER,
    { rules: {}, defaultProvider: NO_FALLBACK },
    opts.cachePath,
    opts.network,
    { excludeProviders: new Set([native.provider]), offCatalogProvider: CLAUDE_API_PROVIDER }
  );
  const catalog = compared.catalog ?? "unreadable";
  return { candidates: catalog === "unreadable" ? [] : compared.candidates, catalog };
}

/** The claudish provider of the Claude API: Anthropic's metered API on the user's key. */
const CLAUDE_API_PROVIDER = "anthropic";

/** A candidate nothing published: `provider@model`, for a probe to ask about. */
function offCatalogCandidate(provider: string, model: string): ExplainedCandidate {
  const candidate = explainCandidate(routeFor(provider, model), "candidate", "kept");
  candidate.origin = "off-catalog";
  return candidate;
}

/**
 * The two explicit targets the proxy serves without `route()`: `poe:<id>` (its Poe
 * step) and `anthropic/<id>` (OpenRouter, the id sent verbatim). One candidate,
 * with the credential check the proxy applies and nothing else: the proxy runs no
 * availability check for either, so neither does this.
 *
 * Known gap, deferred: with no Poe credential the proxy's Poe step declines and
 * the request falls through to the native handler, while this says
 * `no-credential`.
 */
async function explainUnroutedExplicit(
  requestedModel: string,
  via: "poe" | "vendor-qualified-id",
  provider: string,
  wireId: string
): Promise<RouteExplanation> {
  // `credentials.isAvailable`, the gate the proxy's Poe step uses too.
  const credentialed = await hasCredentialsForProvider(provider);
  const tier = getProviderByName(provider)?.tier;
  return {
    requestedModel,
    routedModel: wireId,
    source: "explicit",
    via,
    candidates: [
      {
        provider,
        displayName: DISPLAY_NAMES[provider] ?? provider,
        // The target itself: the proxy carries it verbatim past its gate.
        modelSpec: requestedModel,
        wireId,
        position: "candidate",
        ...(tier !== undefined ? { tier } : {}),
        outcome: credentialed ? "kept" : "no-credential",
      },
    ],
    outcome: credentialed
      ? { kind: "ok" }
      : {
          kind: "no-route",
          cause: "explicit-no-credential",
          reason: `No credentials configured for "${provider}".`,
          hint: buildCredentialHint(wireId, [provider]) ?? undefined,
        },
    warnings: [],
  };
}

/**
 * `route()`'s inputs for a bare name, as `explainRoute` resolves them. With no
 * `rules` passed it reads both rule files itself, which is what lets it name a
 * matched rule's scope; they merge exactly as `loadRoutingRules` merges them.
 */
function bareRoutingFor(opts: ExplainRouteOptions): BareRouting {
  if (opts.rules !== undefined) {
    return {
      rules: opts.rules,
      defaultProvider: resolveFallbackArg(opts.defaultProvider, true),
    };
  }
  const sources = loadRoutingRuleSources();
  return {
    rules: loadRoutingRules(sources),
    defaultProvider: resolveFallbackArg(opts.defaultProvider, false),
    // The project file overwrites the global one key by key, so a key the project
    // file holds is the project's rule.
    scopeOf: (ruleKey) => (Object.hasOwn(sources.localRules, ruleKey) ? "project" : "global"),
    ruleProblems: ruleProblemsAfterRegistration(sources),
  };
}

/**
 * {@link routingRuleProblems} once the custom and bundled endpoints are
 * registered, so a rule naming one is not reported as unknown. Latched, so
 * free after the first call.
 */
function ruleProblemsAfterRegistration(sources: RoutingRuleSources): RoutingRuleProblem[] {
  ensureEndpointsRegistered();
  return routingRuleProblems(sources);
}

/**
 * The `RoutePlan` an explanation stands for: every `kept` candidate in chain
 * order, whatever its position, or the no-route verbatim. An uncredentialed
 * fallback is not kept, so it never becomes a handler that answers 401.
 *
 * Throws for a native explanation: `RoutePlan` has no native case, and
 * `route()` never produces one.
 */
export function toRoutePlan(explanation: RouteExplanation): RoutePlan {
  const { outcome } = explanation;
  if (outcome.kind === "no-route") {
    // `hint` is copied only where it is present (present as `undefined`
    // included), so the plan is the object route() has always returned.
    return "hint" in outcome
      ? { kind: "no-route", reason: outcome.reason, hint: outcome.hint }
      : { kind: "no-route", reason: outcome.reason };
  }
  const [primary, ...fallbacks] = explanation.candidates
    .filter((candidate) => candidate.outcome === "kept")
    .map(routeOf);
  if (!primary) {
    throw new Error(
      `toRoutePlan: "${explanation.requestedModel}" (${explanation.source}) has no kept candidate, so it has no RoutePlan.`
    );
  }
  return { kind: "ok", primary, fallbacks };
}

function routeOf(candidate: ExplainedCandidate): Route {
  return {
    provider: candidate.provider,
    modelSpec: candidate.modelSpec,
    displayName: candidate.displayName,
  };
}

/**
 * What `route()` writes for a decision, in the order it always has: the
 * `[routing] … skipped` debug line, then each billing warning through
 * `logStderr`. Only for a decision that routed; a no-route writes nothing.
 */
function emitRouteNotices(explanation: RouteExplanation): void {
  if (explanation.outcome.kind !== "ok") return;
  const notServing = explanation.candidates
    .filter((candidate) => candidate.outcome === "not-served")
    .map((candidate) => candidate.provider);
  if (notServing.length > 0) {
    log(
      `[routing] ${explanation.routedModel}: skipped ${notServing.join(", ")} — does not serve this model`
    );
  }
  for (const warning of explanation.warnings) {
    // A rule problem is about the config, not this request: the proxy prints
    // those once at startup, never per request.
    if (warning.type === "rule-problem") continue;
    // No "[claudish]" in the message: logStderr adds the prefix itself.
    logStderr(warning.message);
  }
}

/**
 * The label a display shows for a hop's tier. Strings only: a display picks the
 * colour from `C.*` at render time, never from a module-level constant.
 */
export const TIER_LABEL: Record<RouteTier, string> = {
  subscription: "subscription",
  "dynamic-subscription": "subscription · account decides models",
  native: "native API",
  gateway: "gateway",
  fallback: "fallback",
};

/**
 * A hop's label: the fallback POSITION overrides the tier of whichever provider
 * holds it. The one copy of the rule: `describeRouteExplanation` words its
 * "… first" with it, and `--probe` and the config TUI label their rows with it.
 */
export function hopLabel(candidate: {
  position?: ExplainedCandidate["position"];
  tier?: RouteTier;
}): string {
  if (candidate.position === "fallback") return TIER_LABEL.fallback;
  return candidate.tier ? TIER_LABEL[candidate.tier] : "unregistered provider";
}

/**
 * One line saying where a routing decision came from. `--probe` and the config
 * TUI both show it, so the same decision is never worded two ways.
 */
export function describeRouteExplanation(explanation: RouteExplanation): string {
  // The catalog branch names the bundled list itself; the other two read it for
  // wire data, and the line must still say which catalog that was.
  const source =
    explanation.source !== "catalog" && explanation.catalogSource === "bundled"
      ? ` · ${bundledListLabel()}`
      : "";
  const line = `${describeOrigin(explanation)}${source}`;
  // Only where routing chose the provider: an explicit spec names the model
  // part of what the user typed, which is no news.
  const routed = explanation.source === "user-rule" || explanation.source === "catalog";
  return routed && explanation.requestedModel !== explanation.routedModel
    ? `${line} · asked as ${explanation.routedModel}`
    : line;
}

function describeOrigin(explanation: RouteExplanation): string {
  switch (explanation.source) {
    case "native":
      return describeNativeOrigin(explanation);
    case "explicit": {
      const name = explanation.candidates[0]?.displayName ?? explanation.routedModel;
      return explanation.via === "vendor-qualified-id"
        ? `explicit · ${name} · vendor-qualified id sent verbatim`
        : `explicit · ${name}`;
    }
    case "user-rule": {
      const scope = explanation.ruleScope ? ` (${explanation.ruleScope})` : "";
      return `user rule "${explanation.matchedPattern}"${scope}`;
    }
    case "catalog":
      return describeCatalogOrigin(explanation);
  }
}

/**
 * A native target's line. It names the Claude subscription a launch of the name
 * uses, and says whether the model's other routes are listed beside it, for
 * comparison only.
 */
function describeNativeOrigin(explanation: RouteExplanation): string {
  const head = `${explanation.native?.displayName ?? "native"} · Claude Code's own login · not probed`;
  if (explanation.native?.isTierAlias) return `${head} · probe a concrete id to compare routes`;
  if (explanation.comparisonCatalog === "unreadable") {
    return `${head} · catalog unreadable — other routes not listed`;
  }
  if (explanation.comparisonCandidates !== undefined) {
    return `${head} · other routes listed for comparison, not used by a launch of this name`;
  }
  return head;
}

function describeCatalogOrigin(explanation: RouteExplanation): string {
  if (explanation.catalog === "unreadable") {
    const refresh = "run claudish --models-refresh";
    const head =
      explanation.catalogSource === "bundled"
        ? "no cloud models catalog · not in the bundled recommended list"
        : "no cloud models catalog";
    // An account's own list gathers with no catalog: say what became of its
    // candidate rather than implying nothing routes.
    return explanation.candidates.length > 0
      ? `${head} · ${firstHopPhrase(explanation)} · ${refresh}`
      : `${head} · ${refresh}`;
  }
  if (explanation.catalog === "absent") return describeAbsentEntry(explanation);
  if (explanation.catalogSource === "bundled") {
    return `${bundledListLabel()} · ${firstHopPhrase(explanation)}`;
  }
  return `catalog · ${firstHopPhrase(explanation)}`;
}

/**
 * What became of a lone fallback hop the filters dropped. The line names the
 * outcome the candidate has, so a dropped hop is never described as the route.
 */
const DROPPED_FALLBACK_PHRASE: Record<Exclude<CandidateOutcome, "kept">, string> = {
  "no-credential": "has no credential",
  "credential-unreadable": "has a credential that could not be read",
  "not-served": "does not serve it",
  "excluded-by-membership": "is outside its plan's membership",
  "excluded-by-content-use": "maps it only through a contributor (content-use opt-in) id",
  "unknown-provider": "is not a known provider shortcut",
  "gateway-id-unknown": "has no exact id for it in its models list",
};

/**
 * A readable catalog with no entry for the name. The only candidates are
 * account-listed ones and the fallback hop, and each gets words for its outcome.
 */
function describeAbsentEntry(explanation: RouteExplanation): string {
  const head = `catalog has no entry for "${explanation.routedModel}"`;
  const withheld = explanation.fallbackWithheld;
  if (explanation.candidates.some((candidate) => candidate.position === "candidate")) {
    // An account's list gathered something the catalog does not list.
    // `already-gathered` is not news here: the fallback's provider is that candidate.
    const noFallback =
      withheld && withheld !== "already-gathered" ? ` · no fallback (${withheld})` : "";
    return `${head} · ${firstHopPhrase(explanation)}${noFallback}`;
  }
  if (withheld) return `${head} · no fallback (${withheld})`;
  const fallback = explanation.candidates.find((candidate) => candidate.position === "fallback");
  // The appended fallback always resolves to one candidate; this guards the words.
  if (!fallback) return `${head} · ${firstHopPhrase(explanation)}`;
  return fallback.outcome === "kept"
    ? `${head} · fallback only`
    : `${head} · fallback ${fallback.displayName} ${DROPPED_FALLBACK_PHRASE[fallback.outcome]}`;
}

function firstHopPhrase(explanation: RouteExplanation): string {
  if (explanation.outcome.kind === "no-route") return `no route (${explanation.outcome.cause})`;
  const first = explanation.candidates.find((candidate) => candidate.outcome === "kept");
  return first ? `${hopLabel(first)} first` : "no route";
}
