/**
 * Types for remote API providers (OpenRouter, Gemini, OpenAI)
 *
 * These types define the common interface for cloud API providers
 * that use streaming HTTP APIs.
 */

/**
 * Configuration for a remote API provider
 */
export interface RemoteProviderConfig {
  /** Provider name (e.g., "openrouter", "gemini", "openai") */
  name: string;
  /** Base URL for the API */
  baseUrl: string;
  /** API path (e.g., "/v1/chat/completions") */
  apiPath: string;
  /** Environment variable name for API key */
  apiKeyEnvVar: string;
  /** HTTP headers to include with requests */
  headers?: Record<string, string>;
}

/**
 * Pricing information for a model
 */
export interface ModelPricing {
  /** Cost per 1M input tokens in USD */
  inputCostPer1M: number;
  /** Cost per 1M output tokens in USD */
  outputCostPer1M: number;
  /** Whether this pricing is an estimate (not from official sources) */
  isEstimate?: boolean;
  /**
   * Whether this model is free.
   *
   * CONSUMER-ONLY *on this interface* as of the FREE_PROVIDERS deletion below:
   * `getModelPricing` no longer sets `ModelPricing.isFree` on any path. It
   * survives because callers may still hand in a pricing object of their own,
   * and because `token-tracker.ts` reads it — where it is OR-ed with a zero-cost
   * check, so an unset flag changes nothing there.
   *
   * NOT a dead field in the tree, and do not grep `isFree` and conclude it is:
   * `ModelInfo.isFree` is a DIFFERENT field, still written by
   * `buildDiscoveredModelRows` (`model-selector.ts`) as `isFree: flatRate` for
   * every subscription-or-local discovered picker row. That producer is
   * deliberate (it feeds the picker's SUB rendering, not pricing) and it does not
   * re-enter `getModelPricing`. `opencode-zen-go` rows started carrying it when
   * FR-2 made `isSubscriptionProvider("opencode-zen-go")` true — the accepted
   * R-13 collapse, not a resurrection here.
   *
   * Do not resurrect a producer for THIS field without the measurement the
   * tombstone below names. A `$0` that is not a measured `$0` is the
   * money-losing direction, and this flag is the quiet way to reintroduce one.
   */
  isFree?: boolean;
  /** Whether this model uses a subscription service (e.g., Kimi Coding) */
  isSubscription?: boolean;
}

/**
 * Remote provider definition (used by provider registry)
 */
export interface RemoteProvider {
  name: string;
  baseUrl: string;
  apiPath: string;
  apiKeyEnvVar: string;
  /** Prefixes that route to this provider (e.g., ["g/", "gemini/"]) */
  prefixes: string[];
  /** Optional custom headers */
  headers?: Record<string, string>;
  /** Auth scheme for the API key header (defaults to "x-api-key") */
  authScheme?: "x-api-key" | "bearer" | "none";
  /**
   * Optional stream-format override surfaced via ProviderTransport.overrideStreamFormat().
   * When the transport's wire format differs from what the model's dialect would
   * pick (e.g. an Anthropic-compatible endpoint serving a Qwen-named model —
   * QwenModelDialect inherits openai-sse, but the wire is anthropic-sse), this
   * lets the customEndpoint config plumb the truth through to the parser.
   * Mirrors the StreamFormat union declared at providers/transport/types.ts.
   */
  streamFormatOverride?:
    | "anthropic-sse"
    | "openai-sse"
    | "openai-responses-sse"
    | "gemini-sse"
    | "ollama-jsonl";
}

/**
 * Resolved remote provider with model name
 */
export interface ResolvedRemoteProvider {
  provider: RemoteProvider;
  modelName: string;
  /** Whether this used legacy prefix syntax (for deprecation warnings) */
  isLegacySyntax?: boolean;
}

/**
 * Per-provider default pricing (fallback when dynamic cache has no data).
 * These are rough estimates — dynamic pricing from OpenRouter is preferred.
 * Prices are in USD per 1M tokens.
 */
export const PROVIDER_DEFAULTS: Record<string, ModelPricing> = {
  gemini: { inputCostPer1M: 0.5, outputCostPer1M: 2.0, isEstimate: true },
  openai: { inputCostPer1M: 2.0, outputCostPer1M: 8.0, isEstimate: true },
  minimax: { inputCostPer1M: 0.12, outputCostPer1M: 0.48, isEstimate: true },
  kimi: { inputCostPer1M: 0.32, outputCostPer1M: 0.48, isEstimate: true },
  glm: { inputCostPer1M: 0.16, outputCostPer1M: 0.8, isEstimate: true },
  ollamacloud: { inputCostPer1M: 1.0, outputCostPer1M: 4.0, isEstimate: true },
};

// FREE_PROVIDERS REMOVED. It held ["opencode-zen","zen"] — one provider under two
// spellings — on the strength of a keyless tier that no longer exists: Zen needs a
// real OPENCODE_API_KEY (provider-definitions.ts:773-775) and its public-token
// affordance was measured returning 401 and deleted (:756-762).
//
// Reporting $0 for metered usage is the direction that costs the user money
// (routing.md:181-183), so a dead free-tier entry is worse than no entry. Zen now
// falls through to the dynamic lookup and then to the estimate at the bottom of
// getModelPricing, which is flagged isEstimate:true — a visible guess rather than
// an invisible zero.
//
// RE-ENTRY TEST, if a genuinely free provider appears: a MEASURED 200 from a real
// request with NO credential, dated, with the log cited — the standard :756-762
// met. A vendor's marketing page is not evidence; that is exactly what the
// public-token literal was built on.
//
// Do NOT resurrect this by adding a rate for Zen to PROVIDER_DEFAULTS. That is
// pinned vendor pricing and CLAUDE.md forbids it.

// Subscription providers — display "SUB" instead of cost.
//
// Membership is decided by BILLING, not by whether the provider happens to
// declare `modelDiscovery`. That distinction is what let three flat-rate plans
// sit outside this set for so long: a provider WITH discovery renders through
// `buildDiscoveredModelRows`, which asks this question, while a provider
// WITHOUT it renders through the catalog path, which (until now) did not — so a
// missing entry was invisible on one path and merely wrong on the other.
//
// Exported for the drift test only: every member must be a `BUILTIN_PROVIDERS[].name`.
// Shortcut spellings are deliberately NOT enumerated here — a second hand-written
// spelling table would drift from the shortcuts in `provider-definitions.ts`, and
// every call site passes the canonical uid (measured: six sites). Read membership
// through `isSubscriptionProvider` below, never by testing this set directly.
export const SUBSCRIPTION_PROVIDERS = new Set([
  "minimax-coding",
  "kimi-coding",
  "glm-coding",
  "qwen-cloud",
  // Devin bills one flat subscription across every vendor's models it serves.
  // Without this the picker prints an invented per-token price and TokenTracker
  // accrues fictional cost.
  "devin",
  // Antigravity is billed by the user's Antigravity plan (free / Pro / Ultra) —
  // the whole reason `ag@` exists as a separate provider from the metered `g@`.
  // It has no `modelDiscovery`, so it rendered the catalog's N/A instead.
  "antigravity",
  // The `-subscription` in the name is the whole point: `sc@` is the flat-rate
  // Sakana plan, distinct from the metered `sakana@`. Left out, the picker
  // showed Sakana's per-token rate against a plan that does not charge one —
  // the same confusion that made sc@ bill PAYG once before.
  "sakana-subscription",
  // Grok Build is billed by the user's SuperGrok / X Premium+ plan. Unlike
  // `openai-codex` below, this is NOT dual-mode: its only credential is the
  // Grok CLI's OIDC token, and it deliberately does not alias the metered
  // XAI_API_KEY (that key belongs to the separate `x-ai` provider). So the
  // flat-rate answer is unambiguous for every credential that can reach it.
  "grok-subscription",
  // OpenCode Zen Go is the paid "Lite Plan" (provider-definitions.ts), not a
  // metered gateway. Its key OPENCODE_GO_API_KEY buys the plan.
  //
  // WHAT JUSTIFIES THE FLAT-RATE CLASSIFICATION, restated 2026-09-02 because the
  // reason changed. It used to be a NAME plus a claim: `-go` is the plan, and
  // the metered Zen key it aliased was said to be refused by /zen/go with a 401.
  // The experiment this comment prescribed has been RUN, and it REFUTED the
  // claim (provider-definitions.ts has the three probes; raw capture in
  // ai-docs/reports/data/measurements-20260902.txt):
  //
  //     CONTROL  Zen Go key -> /zen/go/v1/chat/completions -> 200
  //     CROSS    Zen Go key -> /zen/v1/chat/completions    -> 200   <- claim said 401
  //     BOGUS    fake key   -> /zen/v1/chat/completions    -> 401 AuthError
  //
  // So OpenCode does not tier-lock keys, at least in the direction measurable
  // from this machine. That did not make this line wrong; it made the ALIAS
  // wrong, because the alias was the only way a metered credential could reach a
  // provider classified flat-rate by name. It was removed the same day.
  //
  // With the alias gone, `zgo@` answers to ONE credential, OPENCODE_GO_API_KEY,
  // which is minted by the Lite Plan subscription. Every credential that can
  // reach this provider is a plan credential — the same unambiguous shape as
  // `grok-subscription` above — and that, not the name and not the disproven
  // 401, is what makes membership here safe.
  //
  // Still NOT measured, and it is the money-losing direction: a real ZEN-TIER
  // key against /zen/go. None exists on this machine. It no longer threatens
  // this line (that key cannot satisfy `zgo@` any more), but it would matter
  // again the moment anyone re-adds an alias or a shared credential here.
  //
  // Its metered sibling `opencode-zen` deliberately stays OUT.
  "opencode-zen-go",
]);

/**
 * Providers whose billing depends on WHICH CREDENTIAL answered, not on the name.
 *
 * `openai-codex` is the only member and the reason this tier exists. It is
 * genuinely dual-mode, but NOT for the reason previously recorded here. The old
 * comment said `apiKeyAliases: ["OPENAI_API_KEY"]` (provider-definitions.ts:412)
 * "means a plain metered OpenAI key authenticates `cx@` just as well". That is
 * false at sign time: the authority registers the Codex composite FIRST
 * (authority.ts:157) and blocks the generic API-key provider from taking the name
 * (:192-205), and the composite's fallback declares no aliases at all
 * (codex-credential.ts:79-82). There is a checked-in test —
 * equivalence.test.ts:302-305, "OPENAI_API_KEY alias alone → false (excluded)".
 * That alias is consumed only by display/hint code (tui/providers.ts,
 * keychain-command.ts, getApiKeyInfo).
 *
 * The real dual mode is two HOSTS, which is a code fact, not an inference:
 *   OAuth (codex-oauth.json) -> chatgpt.com/backend-api/codex/responses
 *                               (codex-credential.ts:17, :54)
 *   OPENAI_CODEX_API_KEY     -> api.openai.com/v1/responses
 *                               (provider-definitions.ts:408, :410)
 * Whether that second host bills per token is MEASURED, 2026-09-02. A platform
 * key against exactly the host and path the api-key arm signs:
 *
 *     POST https://api.openai.com/v1/responses  -> 200
 *     { …, "billing": { "payer": "developer" }, … }
 *
 * The response says who pays, in its own field, and it is the developer holding
 * the key — not a ChatGPT plan. So the api-key arm answering METERED is now a
 * measurement rather than an inference from the host name and the console URL.
 * Raw capture: ai-docs/reports/data/measurements-20260902.txt.
 *
 * The probe's shape does not change: it was already the safe expression of the
 * uncertainty (a wrong inference cost a subscriber a cosmetic over-estimate,
 * never a hidden bill), and the measurement removes the uncertainty rather than
 * the reason for the design. What is NOT proven by one 200 is that every
 * account type answers `"payer": "developer"` here; a ChatGPT-plan-backed key,
 * if such a thing exists, was not tested.
 *
 * Membership here means "ask the probe". A provider is METERED until the probe
 * says otherwise. `openai-codex` must NEVER also be added to
 * SUBSCRIPTION_PROVIDERS above — the name check runs first, so that would
 * short-circuit the probe and report SUB to every API-key user.
 *
 * Exported for the disjointness test only; ask `isSubscriptionProvider`.
 */
export const CREDENTIAL_DECIDED_PROVIDERS = new Set(["openai-codex"]);

/**
 * The sync oracle answering "did the FLAT-RATE credential sign for this provider?".
 *
 * Same shape and same reason as registerDynamicPricingLookup below: this module is
 * a zero-import leaf and must not reach into the auth stack. Null until the auth
 * layer registers one (auth/credentials/billing-probe.ts, installed as a side
 * effect of importing auth/credentials/authority.ts), and null means metered.
 */
let _subscriptionCredentialProbe: ((provider: string) => boolean) | null = null;

/**
 * Install a probe; RETURNS the previous one.
 *
 * The return value is not a convenience. A test that installs a fake and then
 * calls this with `null` does not restore — it UNINSTALLS the production probe for
 * the rest of the Bun process, and every sibling test file in that run then sees
 * FR-3 unwired, failing in an order-dependent way that is expensive to attribute.
 * Capture the return value and restore THAT.
 *
 * The probe is only half the run-scoped state behind this answer. The other half
 * is the signed-arm record (`auth/credentials/billing-probe.ts`), which
 * `OpenAICodexTransport.refreshAuth()` writes on EVERY call — so a test that only
 * meant to pin a transport endpoint or header also decides billing for every
 * later file in the run. `clearSignedArm(provider)` in `afterEach` is
 * review-blocking on the same footing as `register(null)`; the measured leak is
 * in that file's `clearSignedArm` comment.
 */
export function registerSubscriptionCredentialProbe(
  fn: ((provider: string) => boolean) | null
): ((provider: string) => boolean) | null {
  const previous = _subscriptionCredentialProbe;
  _subscriptionCredentialProbe = fn;
  return previous;
}

/**
 * Whether a provider bills a flat subscription rather than per token.
 *
 * The single sanctioned answer to that question — `getModelPricing` below uses
 * it, and so does the interactive picker, which renders "SUB" instead of a
 * per-token figure. Showing a dollar rate for a flat-rate plan would be
 * actively misleading, so both surfaces must agree on one list.
 *
 * NOT a pure function of its argument for CREDENTIAL_DECIDED_PROVIDERS: the
 * answer there depends on which credential actually signed. Do not memoize it.
 */
export function isSubscriptionProvider(provider: string): boolean {
  const p = provider.toLowerCase();
  if (SUBSCRIPTION_PROVIDERS.has(p)) return true;
  if (!CREDENTIAL_DECIDED_PROVIDERS.has(p)) return false;
  return _subscriptionCredentialProbe?.(p) === true;
}

/** Map provider aliases to canonical names used in PROVIDER_DEFAULTS */
const PROVIDER_ALIAS: Record<string, string> = {
  google: "gemini",
  oai: "openai",
  mm: "minimax",
  moonshot: "kimi",
  zhipu: "glm",
  "minimax-coding": "minimax", // Use MiniMax pricing as fallback (though subscription overrides)
  "glm-coding": "glm", // Use GLM pricing as fallback (though subscription overrides)
  oc: "ollamacloud",
};

/**
 * Registered dynamic pricing lookup function.
 * Set by pricing-cache.ts at startup via registerDynamicPricingLookup().
 * This avoids circular ESM imports between this module and pricing-cache.
 */
let _dynamicLookup: ((provider: string, modelName: string) => ModelPricing | undefined) | null =
  null;

/**
 * Register a dynamic pricing lookup function.
 * Called by pricing-cache.ts during warmup to inject its lookup.
 */
export function registerDynamicPricingLookup(
  fn: (provider: string, modelName: string) => ModelPricing | undefined
): void {
  _dynamicLookup = fn;
}

/**
 * Get pricing for a model.
 * Lookup order:
 *   1. Subscription providers → zero cost, isSubscription: true. Via
 *      `isSubscriptionProvider`, so this step also covers the credential-decided
 *      tier: a member of CREDENTIAL_DECIDED_PROVIDERS lands here only when the
 *      registered probe says the flat-rate arm signed, and falls through to
 *      steps 2-3 otherwise.
 *   2. Dynamic pricing cache (if registered, populated from OpenRouter API)
 *   3. Provider default (isEstimate: true)
 *
 * There is no longer a free-provider step. Its only member's keyless tier was
 * measured dead — see the FREE_PROVIDERS tombstone above for the re-entry test a
 * genuinely free provider would have to meet. A provider that charges nothing but
 * is not listed here lands on step 3's estimate, which is a visible guess.
 */
export function getModelPricing(provider: string, modelName: string): ModelPricing {
  const p = provider.toLowerCase();

  // 1. Subscription providers
  if (isSubscriptionProvider(p)) {
    return { inputCostPer1M: 0, outputCostPer1M: 0, isSubscription: true };
  }

  // 2. Dynamic pricing cache
  if (_dynamicLookup) {
    const dynamic = _dynamicLookup(p, modelName);
    if (dynamic) return dynamic;
  }

  // 3. Provider defaults with alias resolution
  const canonical = PROVIDER_ALIAS[p] || p;
  return (
    PROVIDER_DEFAULTS[canonical] || { inputCostPer1M: 1.0, outputCostPer1M: 4.0, isEstimate: true }
  );
}

/**
 * Calculate cost based on token usage
 */
export function calculateCost(
  provider: string,
  modelName: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = getModelPricing(provider, modelName);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return inputCost + outputCost;
}
