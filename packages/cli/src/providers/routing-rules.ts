import { resolveSubscriptionRouting } from "../adapters/model-catalog.js";
import { credentials } from "../auth/credentials/authority.js";
import { isSubscriptionProvider } from "../handlers/shared/remote-provider-types.js";
import { log, logStderr } from "../logger.js";
import type { RecommendedModelsDoc } from "../model-loader.js";
import { loadConfig, loadLocalConfig } from "../profile-config.js";
import type { RoutingEntry, RoutingRules } from "../profile-config.js";
import { DISPLAY_NAMES, PROVIDER_TO_PREFIX } from "./auto-route.js";
import { resolveExternalId } from "./catalog-client.js";
import { DEFAULT_ROUTING_RULES } from "./default-routing-rules.js";
import { providerServesModel } from "./model-availability.js";
import { PROVIDER_SHORTCUTS } from "./model-parser.js";
import { parseModelSpec } from "./model-parser.js";
import { getProviderByName } from "./provider-definitions.js";
import { buildCredentialHint } from "./routing-hints.js";

/**
 * Pure merge — defaults < global < local. Exposed for testability so callers
 * can verify merge semantics without touching the disk.
 */
export function mergeRoutingRules(
  defaults: RoutingRules,
  global_: RoutingRules,
  local: RoutingRules
): RoutingRules {
  return { ...defaults, ...global_, ...local };
}

export interface RoutingRuleSources {
  globalRules: RoutingRules;
  localRules: RoutingRules;
  recommendedModels?: RecommendedModelsDoc;
}

/**
 * Load effective routing rules. Layers:
 *   1. DEFAULT_ROUTING_RULES (built-in, see default-routing-rules.ts)
 *   2. Global config (~/.claudish/config.json)
 *   3. Local config (./.claudish.json)
 *
 * Local rules overwrite global rules overwrite defaults — same key wins.
 * User patterns OVERWRITE default patterns by exact key match (no glob-vs-glob
 * interleaving).
 *
 * Always returns a non-null `RoutingRules` because defaults are baked in.
 * To get strict no-fallback mode, set `routing["*"] = []` in user config.
 *
 * ── The catalog does NOT belong here. Do not add it back. ──────────────────
 *
 * v9.0.1 merged `buildCatalogRoutingRules(...)` into this dictionary and it
 * deleted providers from every chain it touched. The mechanism, in two facts
 * that are individually harmless:
 *
 *   - catalog keys are EXACT model ids (`grok-4.6`); default and user keys are
 *     GLOBS (`grok-*`);
 *   - `matchRoutingRule` below returns on the first exact hit, before it ever
 *     looks at a glob.
 *
 * So one catalog key makes the matching glob unreachable for that model, and
 * every provider the catalog did not name is gone. `buildCatalogRoutingRules`
 * reads `subscriptions[]`, which enumerates PLAN-backed routes only — never a
 * vendor's metered API, never OpenRouter — so its list is structurally
 * incomplete. Measured on a real cache: `grok-4.6` became
 * `["opencode-zen-go@grok-4.6"]`, leaving a user holding XAI_API_KEY and
 * OPENROUTER_API_KEY with no route at all. A user's own `grok-*` rule was
 * shadowed the same way, silently.
 *
 * Catalog knowledge reaches routing through two other call sites, and they are
 * NOT equally safe. Be precise about which:
 *
 *   - `providerServesModel` in `routeBare` IS safe. It is three-valued and drops
 *     a candidate only on `not-served`; `unknown` keeps it exactly where it was.
 *   - `resolveSubscriptionRouting` in `buildRoutingChain` is NOT, as of v9.0.1.
 *     Its `hasPublishedProviderRoster` check (model-catalog.ts:335) is evaluated
 *     at PROVIDER granularity across the whole cache, so one model publishing a
 *     plan membership makes every OTHER model's silence authoritative. Measured
 *     on the live cache: only `glm-5.3` and `glm-5.3-flash` list
 *     `z-ai-glm-coding-plan`, so `glm-4.7` resolves to
 *     `["glm@glm-4.7", "openrouter@z-ai/glm-4.7"]` — both subscriptions deleted,
 *     and a GLM Coding Plan holder is billed per token. Same shape for
 *     `qwen-cloud` on `qwen3-coder-plus`. At v9.0.0 this could not happen: the
 *     old code tested `subscriptionPlans.includes(providerUid)`, which was false
 *     for every provider, so it returned `unknown` and kept the candidate.
 *
 * That second one is a LIVE defect, not fixed here. This change restores the
 * routing-rule COMPOSITION to v9.0.0; it deliberately retains v9.0.1's
 * subscription-availability join, gap included. Do not read this file's fix as
 * "v9.0.3 == v9.0.0 routing" — see ai-docs/reports/ for the follow-up.
 *
 * `sources` keeps this composition boundary testable without reading machine
 * config or the recommended-models cache. `sources.recommendedModels` is
 * optional and deliberately unused: a regression test hands it a shadowing entry
 * and asserts it never reaches the output. That test alone is not a sufficient
 * guard, because the v9.0.1 bug read the cache AMBIENTLY rather than through
 * this seam — the guard that survives a cold CI checkout is the import-shape
 * test in routing-rules.test.ts, which fails on any VALUE import from
 * model-loader.js. Keep this file's model-loader import `import type`.
 */
export function loadRoutingRules(sources?: RoutingRuleSources): RoutingRules {
  const local = sources ? sources.localRules : (loadLocalConfig()?.routing ?? {});
  const global_ = sources ? sources.globalRules : (loadConfig().routing ?? {});

  validateRoutingRules(local);
  validateRoutingRules(global_);

  return mergeRoutingRules(DEFAULT_ROUTING_RULES, global_, local);
}

/**
 * Drop catalog entries naming a provider this client cannot execute.
 *
 * NO PRODUCTION CALLER as of v9.0.3 — `loadRoutingRules` no longer consumes the
 * catalog, for the reasons documented there. Kept because the filter itself is
 * correct and the catalog-driven routing redesign will need it; its test pins
 * the behaviour meanwhile.
 *
 * Note what the premise of the original comment got wrong, since it is the same
 * mistake that shipped the v9.0.1 regression: the backend does not own route
 * PREFERENCE. It owns availability — who serves a model, under what id. Order is
 * the user's, then claudish's defaults.
 */
export function retainKnownCatalogRoutingRules(rules: RoutingRules): RoutingRules {
  const retained: RoutingRules = {};
  for (const [modelId, entries] of Object.entries(rules)) {
    const knownEntries = entries.filter((entry) => {
      const providerRaw = entry.split("@", 1)[0]?.toLowerCase() ?? "";
      const provider = PROVIDER_SHORTCUTS[providerRaw] ?? providerRaw;
      return getProviderByName(provider) !== undefined;
    });
    if (knownEntries.length > 0) retained[modelId] = knownEntries;
  }
  return retained;
}

/** Warn about config issues that would silently misbehave. */
function validateRoutingRules(rules: RoutingRules): void {
  // Track lower-cased keys to catch case-insensitive collisions. Matching is
  // case-insensitive, so two keys that differ only in case will silently
  // collapse to whichever the iteration order favors. Warn the user.
  const seenLower = new Map<string, string>();
  for (const key of Object.keys(rules)) {
    // Multi-wildcard patterns only use the first *, rest become literals
    if (key !== "*" && (key.match(/\*/g) || []).length > 1) {
      console.error(
        `[claudish] Warning: routing pattern "${key}" has multiple wildcards — only single * is supported. This pattern may not match as expected.`
      );
    }
    const lower = key.toLowerCase();
    const prior = seenLower.get(lower);
    if (prior !== undefined && prior !== key) {
      console.error(
        `[claudish] Warning: routing patterns "${prior}" and "${key}" collide case-insensitively. Matching is case-insensitive, so one will silently shadow the other. Pick one casing and remove the duplicate.`
      );
    } else {
      seenLower.set(lower, key);
    }
    // Empty chain is valid — explicit no-fallback mode (route() returns
    // no-route). No warning needed; user opted in.
  }
}

/**
 * Match a model name against routing rules. Case-INSENSITIVE — provider
 * docs and catalogs use mixed casing (`MiniMax-M2.5`, `GPT-4o`) but the
 * underlying APIs accept any case, so users get bitten when copy-paste
 * casing doesn't exactly match a lowercase rule key.
 *
 * Priority: exact → longest glob → "*" catch-all → null (use default chain).
 *
 * NOTE: only the rule LOOKUP is lowered. The original `modelName` casing is
 * preserved when the route is built and sent to provider APIs (some are
 * case-sensitive on their own model IDs).
 */
export function matchRoutingRule(modelName: string, rules: RoutingRules): RoutingEntry[] | null {
  const lowered = modelName.toLowerCase();

  // 1. Exact match (case-insensitive over rule keys)
  for (const [key, entries] of Object.entries(rules)) {
    if (!key.includes("*") && key.toLowerCase() === lowered) return entries;
  }

  // 2. Glob patterns (sorted longest-first = most specific)
  const globKeys = Object.keys(rules)
    .filter((k) => k !== "*" && k.includes("*"))
    .sort((a, b) => b.length - a.length);

  for (const pattern of globKeys) {
    if (globMatch(pattern, modelName)) return rules[pattern];
  }

  // 3. Catch-all (may be an empty array — caller treats that as "no route")
  if (rules["*"] !== undefined) return rules["*"];

  return null;
}

/**
 * Convert routing entries to Route objects.
 * Plain name "provider" uses originalModelName.
 * Explicit "provider@model" uses the specified model.
 */
export function buildRoutingChain(
  entries: RoutingEntry[],
  originalModelName: string,
  cachePath?: string
): Route[] {
  const routes: Route[] = [];

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
      if (routing.kind === "not-served") continue;
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
      modelName = resolveExternalId(modelName, provider) ?? modelName;
    }

    // Build modelSpec. OpenRouter's ids are already vendor-qualified, so they
    // are their own spec; everyone else takes a provider prefix.
    let modelSpec: string;
    if (provider === "openrouter") {
      modelSpec = modelName;
    } else {
      const prefix = PROVIDER_TO_PREFIX[provider] ?? provider;
      modelSpec = `${prefix}@${modelName}`;
    }

    const displayName = DISPLAY_NAMES[provider] ?? provider;
    routes.push({ provider, modelSpec, displayName });
  }

  return routes;
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

/**
 * Path 1: an explicit "provider@model" spec. Probe ONLY that provider's
 * credentials; never fall back silently.
 */
async function routeExplicit(
  modelSpec: string,
  model: string,
  provider: string,
  cachePath?: string
): Promise<RoutePlan> {
  if (!(await hasCredentialsForProvider(provider))) {
    return {
      kind: "no-route",
      reason: `No credentials configured for "${provider}".`,
      hint: buildCredentialHint(model, [provider]) ?? undefined,
    };
  }

  const built = buildRoutingChain([modelSpec], model, cachePath)[0];
  if (!built) {
    return {
      kind: "no-route",
      reason: `Could not build a route for "${modelSpec}".`,
    };
  }

  // An explicit address is NEVER silently dropped — the user named this vendor,
  // so a "does not serve it" verdict is something to TELL them, not something to
  // route around. That is the difference from the bare path, where claudish
  // assembled the chain itself and may quietly pick another link.
  //
  // Without this the request still fails, just later and less clearly: OpenCode
  // Zen Go answers for a model it does not carry with HTTP 401, which reads as a
  // credential problem and sends the user to check a key that works.
  if ((await providerServesModel(built.provider, wireIdOf(built))) === "not-served") {
    return {
      kind: "no-route",
      reason: `${built.displayName} does not serve "${model}".`,
      hint:
        `Check the model id, or use a bare \`${model}\` to let claudish pick a provider ` +
        "that carries it.",
    };
  }

  return { kind: "ok", primary: built, fallbacks: [] };
}

/**
 * Path 2: a bare model name. Consult rules, build candidates, filter to those
 * with credentials, and return ok/no-route accordingly.
 *
 * If `defaultProvider` is set and not already present in the matched chain, it
 * is appended as a final entry — a safety net that catches models whose chain
 * has no credentialed providers. Deduped: if the chain already lists the
 * default provider, no second copy is added.
 */
async function routeBare(
  model: string,
  nativeProvider: string,
  rules: RoutingRules,
  defaultProvider?: string,
  cachePath?: string
): Promise<RoutePlan> {
  const matched = matchRoutingRule(model, rules) ?? [];
  const entries = [...matched];

  if (defaultProvider && defaultProvider.length > 0) {
    const canonicalDefault =
      PROVIDER_SHORTCUTS[defaultProvider.toLowerCase()] ?? defaultProvider.toLowerCase();
    const alreadyPresent = entries.some((e) => {
      const atIdx = e.indexOf("@");
      const providerRaw = atIdx === -1 ? e : e.slice(0, atIdx);
      const canonical = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();
      return canonical === canonicalDefault;
    });
    if (!alreadyPresent) entries.push(defaultProvider);
  }

  if (entries.length === 0) {
    return {
      kind: "no-route",
      reason: `No routing rule matched "${model}".`,
      hint: buildCredentialHint(model, [nativeProvider]) ?? undefined,
    };
  }

  const candidates = buildRoutingChain(entries, model, cachePath);
  const credentialed: Route[] = [];
  const skipped: string[] = [];

  // Resolve each candidate's credentials concurrently (each call funnels through
  // the SDK serialization queue internally), but keep the original chain ORDER
  // when partitioning into credentialed / skipped.
  const checks = await Promise.all(
    candidates.map((candidate) => hasCredentialsForProvider(candidate.provider))
  );
  candidates.forEach((candidate, i) => {
    if (checks[i]) {
      credentialed.push(candidate);
    } else {
      skipped.push(candidate.provider);
    }
  });

  if (credentialed.length === 0) {
    return {
      kind: "no-route",
      reason:
        skipped.length > 0
          ? `No credentialed providers in chain for "${model}" (tried: ${skipped.join(", ")}).`
          : `No providers available for "${model}".`,
      hint: buildCredentialHint(model, skipped) ?? undefined,
    };
  }

  // AVAILABILITY filter — drop a candidate only when a source positively says
  // it does not carry this model.
  //
  // This runs AFTER the credential filter, not before, and the order is not
  // cosmetic: `providerServesModel` may hit the provider's own roster endpoint,
  // which needs that provider's credential. Asking about a provider the user
  // cannot authenticate to would be a guaranteed-failing round-trip.
  //
  // Only "not-served" removes anything. "unknown" — no source covers this
  // provider, the catalog is cold, the roster endpoint was briefly down — keeps
  // the candidate exactly where it was. That asymmetry is the whole safety
  // property: reading absence of evidence as denial would drop every provider
  // neither source covers, which is almost entirely the SUBSCRIPTION providers,
  // and would move users off plans they pay for onto metered hops.
  const availability = await Promise.all(
    credentialed.map((candidate) => providerServesModel(candidate.provider, wireIdOf(candidate)))
  );
  const serving: Route[] = [];
  const notServing: string[] = [];
  credentialed.forEach((candidate, i) => {
    if (availability[i] === "not-served") {
      notServing.push(candidate.provider);
    } else {
      serving.push(candidate);
    }
  });

  if (serving.length === 0) {
    // Every credentialed provider positively denied carrying this model. That is
    // strong evidence — "unknown" never lands here — so a clear no-route beats
    // sending a request that each of them would reject in turn.
    return {
      kind: "no-route",
      reason: `No provider serves "${model}" (checked: ${notServing.join(", ")}).`,
      hint: buildCredentialHint(model, notServing) ?? undefined,
    };
  }

  if (notServing.length > 0) {
    log(`[routing] ${model}: skipped ${notServing.join(", ")} — does not serve this model`);
    // Say it OUT LOUD only when the skip changes how the user is billed. A
    // subscription provider dropped in favour of a metered one is a cost change
    // they did not choose — claudish assembled this chain — which is the same
    // reason fallback-handler announces advancing past a spent plan. Every other
    // skip is routine and stays in the debug log.
    const droppedSubscription = notServing.filter((p) => isSubscriptionProvider(p));
    if (droppedSubscription.length > 0 && !isSubscriptionProvider(serving[0].provider)) {
      logStderr(
        `[claudish] ${droppedSubscription.join(", ")} does not serve ${model} — ` +
          `using ${serving[0].displayName}, which bills per token.`
      );
    }
  }

  const [primary, ...fallbacks] = serving;
  return { kind: "ok", primary, fallbacks };
}

/**
 * The id a route would actually SEND, extracted from its `modelSpec`.
 *
 * `buildRoutingChain` emits `provider@model` for everyone except OpenRouter,
 * whose ids are already vendor-qualified and are their own spec. Availability
 * must be asked about the wire id, never the name the user typed — comparing the
 * typed name would test the wrong side of an `externalId` mapping, and that
 * mapping is exactly what a roster settles (OpenCode Zen Go serves
 * `deepseek-v4-pro`, while the catalog id carries a date suffix).
 */
function wireIdOf(route: Route): string {
  const at = route.modelSpec.indexOf("@");
  return at === -1 ? route.modelSpec : route.modelSpec.slice(at + 1);
}

/**
 * Resolve a model name to a provider chain.
 *
 * Two paths:
 *   1. Explicit prefix (`provider@model`): the caller named the vendor. We
 *      probe ONLY that vendor's credentials; missing credentials → no-route
 *      with a credential hint. **No silent fallback** — `defaultProvider` is
 *      not consulted because the user named a specific vendor.
 *   2. Bare name: consult routing rules (defaults + user overrides), append
 *      `defaultProvider` as a final fallback if set and not already present,
 *      build the candidate chain, filter to credentialed entries, return the
 *      filtered chain. Empty filtered chain → no-route with hints.
 *
 * Rules and the default provider are loaded fresh each call (via `loadRoutingRules()`
 * and `loadConfig()`) unless overrides are supplied. Tests should pass overrides
 * to avoid disk lookups.
 */
/**
 * Rewrite a dash-slugified GLM version to its canonical dotted form
 * (`glm-5-2` → `glm-5.2`), so a client that slugifies dots still matches the
 * routing rule instead of falling through to `defaultProvider`.
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
 * routeExplicit forwards the ORIGINAL `modelSpec` to buildRoutingChain, which
 * re-parses it and takes the model from the entry itself, ignoring the `model`
 * argument for any entry containing "@". So normalizing the explicit path would
 * currently be a no-op rather than a bug. Restricting it here means that stays
 * true even if buildRoutingChain's precedence ever changes.
 *
 * That matters because Devin re-serves other vendors' models under uids that
 * legitimately contain dashes, `glm-5-2` and `glm-5-2-1m` among them (see
 * providers/devin/model-id-resolver.ts). Those are matched against Devin's LIVE
 * served set, so a `dv@glm-5-2` that ever became `dv@glm-5.2` would request a
 * uid that does not exist. Bare names cannot reach Devin at all — it declares
 * no nativeModelPatterns and has no DEFAULT_ROUTING_RULES entry — so the bare
 * path is the only place this rewrite can apply and the only place it needs to.
 */
export function normalizeGlmSlug(model: string): string {
  return model.replace(
    /^glm-(\d+)-(\d+)(-.*)?$/i,
    (_m, major, minor, suffix) => `glm-${major}.${minor}${suffix ?? ""}`
  );
}

export async function route(
  modelSpec: string,
  rulesOverride?: RoutingRules,
  defaultProviderOverride?: string,
  cachePath?: string
): Promise<RoutePlan> {
  const parsed = parseModelSpec(modelSpec);

  if (parsed.isExplicitProvider) {
    // Not normalized here — see normalizeGlmSlug's note on explicit specs.
    return routeExplicit(modelSpec, parsed.model, parsed.provider, cachePath);
  }

  const rules = rulesOverride ?? loadRoutingRules();
  // When tests pass an explicit `rulesOverride`, treat the rule set as the
  // authoritative source of truth and do not read `loadConfig().defaultProvider`
  // off disk — that would leak the host machine's config into unit tests.
  // Production callers (via `loadRoutingRules()`) get the disk-loaded default.
  const defaultProvider =
    defaultProviderOverride !== undefined
      ? defaultProviderOverride
      : rulesOverride !== undefined
        ? undefined
        : loadConfig().defaultProvider;
  return routeBare(
    normalizeGlmSlug(parsed.model),
    parsed.provider,
    rules,
    defaultProvider,
    cachePath
  );
}

// route() is now async; routeBare returns a Promise which is awaited by the caller.
