/**
 * Provider Definitions — Single Source of Truth
 *
 * Every provider's identity (name, shortcuts, prefixes, patterns, API key info,
 * display name, transport type, capabilities) lives here. All other files derive
 * from these definitions instead of maintaining their own copies.
 *
 * Adding a new provider: add one entry to BUILTIN_PROVIDERS. No other file changes needed
 * for identity/routing — only transport and adapter wiring in provider-profiles.ts.
 */

import { VERTEX_SET_PROJECT_REMEDY } from "../auth/vertex-auth.js";
import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
import type { ModelHandler } from "../handlers/types.js";
import { getEndpoint as getConfigEndpoint } from "../profile-config.js";
// Type-only import — erased at compile time, so no runtime import cycle with
// model-discovery.ts (which imports getProviderByName from here).
import type { ModelDiscoveryDescriptor } from "./model-discovery.js";
// Type-only, like ModelDiscoveryDescriptor below: erased at compile time, so
// declaring the handler here costs nothing at module load. The 28 heavy imports
// in provider-profiles.ts arrive only when `lazyHandler`'s thunk is invoked.
import type { AsyncProviderProfile, ProfileContext, ProviderProfile } from "./provider-profiles.js";
import { getRuntimeProviders } from "./runtime-providers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportType =
  | "openai"
  | "anthropic"
  | "gemini"
  | "antigravity"
  | "devin"
  | "grok-subscription"
  | "openrouter"
  | "ollamacloud"
  | "kimi-coding"
  | "litellm"
  | "vertex"
  | "local"
  | "ollama"
  | "poe";

export type TokenStrategy = "delta-aware" | "accumulate-both" | undefined;

/**
 * WHICH KIND of way-to-call-a-model a provider is — the one routing fact the
 * cloud models catalog cannot publish.
 *
 * Everything else routing needs about a connection is in the catalog: the wire
 * id, the price, the context window, the vendor, and (since v3) the route
 * binding that names the transport. What the catalog does NOT say is how
 * claudish should PREFER one connection over another, because that depends on
 * how the user pays claudish's providers, not on what the model is. This field
 * is that statement, declared once per provider, and `route-candidates.ts`
 * orders by it.
 *
 * The five values, and the line between the two flat-rate ones:
 *
 *  - `subscription` — flat-rate, and the catalog publishes the plan's MEMBERSHIP
 *    (`subscriptionPlanIds[]`), so a candidate can be gathered from the catalog
 *    alone: `kimi-coding`, `glm-coding`, `qwen-token-plan`, `opencode-zen-go`.
 *  - `dynamic-subscription` — flat-rate, but the ACCOUNT's own list decides what
 *    it serves, so the catalog publishes no connection for it at all and a
 *    candidate can only come from a namespace claim plus the account's dynamic
 *    models catalog: `antigravity`, `grok-subscription`, `devin`,
 *    `sakana-subscription`. Measured on generation
 *    `g-20260921062451697-f490edba`: all four appear in the probe map as
 *    `client_model_selection_required` and publish zero `aggregators[]` rows.
 *  - `native` — the vendor's own metered endpoint (`openai`, `google`, `kimi`,
 *    `z-ai`, `qwen-payg`, …). Billed per token by the company that made the model.
 *  - `gateway` — a metered service reselling many vendors (`openrouter`, `poe`,
 *    `vertex`, `ollamacloud`, `litellm`, `opencode-zen`), plus every custom and
 *    bundled endpoint, which claudish cannot classify more precisely than "a
 *    metered endpoint someone else operates".
 *  - `fallback` — the last-resort hop. A POSITION, never a property: whichever
 *    provider `defaultProvider` names occupies it, so NO definition declares it
 *    and a provider that would otherwise be a `gateway` does not become one
 *    here.
 *
 * NOT a billing oracle, and must not be used as one. `SUBSCRIPTION_PROVIDERS`
 * (handlers/shared/remote-provider-types.ts) still decides whether a user is
 * quoted a per-token price, and the two tables deliberately disagree on
 * `openai-codex` and `native-anthropic`: both are CREDENTIAL-decided — a metered
 * key reaches the same provider name — so naming their flat-rate ROUTE here says
 * nothing about who pays for a given request. See `ai-docs/architecture/` and
 * CLAUDE.md's Invariants: a provider wrongly called flat-rate accrues $0 against
 * real spend, which is the one error this field must not be allowed to cause.
 *
 * Unrelated to `PredefinedEndpointEvidenceSchema.tier` ("live" | "probe"), which
 * records how a bundled row was VERIFIED. Different object, different question.
 */
export type RouteTier = "subscription" | "dynamic-subscription" | "native" | "gateway" | "fallback";

export interface ProviderCapabilities {
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  supportsJsonMode?: boolean;
  supportsReasoning?: boolean;
}

/**
 * Why a provider has no handler factory. A first-class value, not an omission.
 *
 * Eight builtins legitimately construct no handler through this path, for five
 * different reasons, and every one of them used to be expressed by simply not
 * appearing in a second table — which is indistinguishable from forgetting.
 * Naming the reason is what turns "is this a bug?" into an answered question.
 */
export type NoHandlerReason =
  /** Renamed before the request path sees it; the handler lives under the new name. */
  | "renamed-at-runtime"
  /** Served by a dedicated handler that predates this table (OpenRouter). */
  | "dedicated-handler"
  /** Resolved by the local-provider path, not `direct-api`. */
  | "local"
  /** No baseUrl — exists only so nativeModelPatterns can steer a bare name. */
  | "virtual"
  /** Transport exists, factory never written. A real gap, stated as one. */
  | "unimplemented";

/** A provider that deliberately builds no handler here, and says why. */
export interface NoHandler {
  kind: "none";
  reason: NoHandlerReason;
  /** Free text: what actually serves it, or what is missing. */
  note: string;
}

/**
 * Build a handler for one request — LAZILY.
 *
 * The laziness is the whole point of the shape. The construction code imports
 * every transport, every adapter and ComposedHandler (28 static imports);
 * provider IDENTITY is read by 33 files, most of which only want to know
 * whether `gk@` is a real prefix and will never open a socket. A thunk keeps
 * those two facts in ONE table without making the cheap question pay for the
 * expensive one.
 */
export type LazyHandlerFactory = (ctx: ProfileContext) => Promise<ModelHandler | null>;

/** Type-only view of the builder module. Erased at compile time — no runtime import. */
type ProfileBuilders = typeof import("./provider-profiles.js");

/**
 * Wrap a builder in a deferred import.
 *
 * `pick` is a typed accessor rather than a string key on purpose: a key would
 * be a third place to typo a provider name, which is the exact failure this
 * merge exists to remove.
 */
function lazyHandler(
  pick: (m: ProfileBuilders) => ProviderProfile | AsyncProviderProfile
): LazyHandlerFactory {
  return async (ctx) => pick(await import("./provider-profiles.js")).createHandler(ctx);
}

export interface ProviderDefinition {
  /**
   * How this provider builds a handler — or an explicit statement that it does
   * not, and why.
   *
   * REQUIRED, and that is the point of merging the two tables. Handler wiring
   * used to live in a separate `PROVIDER_PROFILES` map keyed by name, so adding
   * a builtin and forgetting the second entry produced a provider that silently
   * answered from OPENROUTER — CLAUDE.md names that this project's worst
   * failure class. As a required field the compiler refuses the half-add, which
   * is a stronger guarantee than any test: you cannot merge code that forgot.
   */
  createHandler: LazyHandlerFactory | NoHandler;
  /**
   * WHICH KIND of route this is — see {@link RouteTier}. Read at routing time by
   * `route-candidates.ts`; a provider with no tier can never become a gathered
   * candidate, which is the safe direction (it is skipped, never guessed at).
   *
   * Declared optional HERE and REQUIRED on every table that feeds routing:
   * `BUILTIN_PROVIDERS` and the custom-endpoint builder are both typed
   * {@link TieredProviderDefinition}, so adding a provider to either without a
   * tier does not compile — the same compiler-enforced completeness
   * `createHandler` gets, and for the same reason (a half-added provider
   * silently answering from somewhere else is this project's worst failure
   * class). The optionality exists only because four TEST files construct
   * `ProviderDefinition` literals for unrelated features, and a test's fixture
   * has no routing tier to declare. Promote it to required here once those
   * literals carry one.
   */
  tier?: RouteTier;
  /** Canonical provider name (lowercase, unique key) */
  name: string;
  /** Human-readable display name (proper capitalization) */
  displayName: string;
  /** Transport type for handler construction */
  transport: TransportType;
  /** Token counting strategy */
  tokenStrategy?: TokenStrategy;
  /** Base URL for the API (may be overridden by env var) */
  baseUrl: string;
  /** Environment variables that can override the base URL */
  baseUrlEnvVars?: string[];
  /**
   * This provider's TRANSPORT builds the request URL itself, so an empty
   * `baseUrl` is correct and complete rather than missing.
   *
   * Declared because "no base URL" otherwise means "not configured", and
   * `getRemoteProviders()` drops such a provider from the registry — after which
   * `resolveRemoteProvider("vertex@…")` returns null and the failure reads as a
   * missing credential, sending the user to find a key that was never the
   * problem. LiteLLM has the same empty `baseUrl` but a DIFFERENT cause: its URL
   * arrives from `LITELLM_BASE_URL`, so resolving `baseUrlEnvVars` rescues it.
   * No env var can ever rescue this case, because there is no single URL to
   * name: Vertex's endpoint is assembled per request from the project, the
   * location and the publisher
   * (`https://<location>-aiplatform.googleapis.com/v1/projects/<project>/…`).
   *
   * A capability, not a name check: anything whose transport composes its own
   * endpoint sets this, and nothing in the registry mentions "vertex".
   */
  buildsOwnEndpoint?: true;
  /** API path template (e.g., "/v1/chat/completions") */
  apiPath: string;
  /** Primary API key environment variable */
  apiKeyEnvVar: string;
  /** Alternative env vars to check */
  apiKeyAliases?: string[];
  /**
   * Env vars that hold a DIFFERENT tier's key for the SAME vendor — names a user
   * is likely to already have set, which this provider does NOT accept.
   *
   * Purely explanatory: nothing resolves, signs or gates on it. It exists because
   * "No API key for provider X. Set Y" is an unhelpful sentence to read while
   * holding a key from the same vendor, and the user's next move — exporting the
   * key they have under the name we asked for — produces a 401 they cannot
   * attribute. `describeMissingCredential` appends one clause naming the sibling
   * and, looked up LIVE from the catalog, which provider it does belong to.
   *
   * Declared today only by `opencode-zen-go`, which carried
   * `apiKeyAliases: ["OPENCODE_API_KEY"]` until 2026-09-02 and so has an
   * installed base of users for whom that key used to work. `sakana-subscription`
   * / `sakana`, `qwen-token-plan` / `qwen-payg` and `kimi-coding` / `kimi` are the same
   * two-tier shape and could adopt it; each is a user-visible message change and
   * belongs to whichever change is looking at that provider.
   */
  siblingKeyEnvVars?: string[];
  /** Human-readable API key description */
  apiKeyDescription: string;
  /** URL where user can obtain an API key */
  apiKeyUrl: string;
  /**
   * Auth scheme for the API key header.
   *
   * `"none"` means the provider takes NO credential — the transports emit no auth
   * header and the credential authority reports it available with nothing
   * configured. Only reachable from a user `customEndpoints` entry today; no
   * builtin declares it, and none should, since every hosted vendor authenticates.
   */
  authScheme?: "x-api-key" | "bearer" | "none";
  /**
   * Where the endpoint reads prompt-cache `cache_control`.
   *
   * Absent means on content blocks, which is where Anthropic reads the
   * breakpoints Claude Code places on its system prompt and latest turn.
   * `"top-level"` is an endpoint that honours only the request-level field
   * (Anthropic's automatic caching) and ignores block markers, so a request
   * carrying the client's breakpoints alone never writes a cache entry. The
   * Anthropic-compatible transport lifts them to that field.
   */
  cacheControlPlacement?: "top-level";
  /** Provider shortcuts (e.g., ["g", "gemini"] → "google") */
  shortcuts: string[];
  /** Legacy prefix patterns for backwards compat (e.g., ["g/", "gemini/"]) */
  legacyPrefixes: Array<{ prefix: string; stripPrefix: boolean }>;
  /** Native model patterns for auto-detection (when no provider prefix) */
  nativeModelPatterns?: Array<{ pattern: RegExp }>;
  /**
   * Opt in to live, per-subscription model discovery. When set, claudish calls
   * the provider's own authenticated model-listing endpoint to learn the real
   * dynamic models catalog and per-model context windows for THIS user's plan, instead of
   * trusting a static list. Required for subscription endpoints whose context
   * window varies by tier (see providers/model-discovery.ts).
   */
  modelDiscovery?: ModelDiscoveryDescriptor;
  /** Provider capabilities */
  capabilities?: ProviderCapabilities;
  /** Custom HTTP headers to include with requests */
  headers?: Record<string, string>;
  // `publicKeyFallback?: string` REMOVED (2026-08-22).
  //
  // It carried a hardcoded literal to send as the bearer token for a vendor's
  // "free tier" — only ever `"public"`, only ever for OpenCode Zen, and the
  // endpoint answers 401 to it. Two things made it worse than a dead value:
  // `isAvailable()` returned true on its mere PRESENCE without issuing any
  // request, so the provider advertised itself Ready and the failure only
  // appeared under a live test; and inventing a vendor's shared secret is
  // exactly what the catalog forbids ("a default is a rule, never a pinned id").
  //
  // `authScheme: "none"` is the correct — and now the only — way to express a
  // keyless endpoint. It states that NO credential is expected and sends no auth
  // header, rather than guessing one. See config-schema.ts and proxy-server.ts.
  /** OAuth credential file under ~/.claudish/ to check as fallback */
  oauthFallback?: string;
  /**
   * Slug for `claudish login {slug}` if this provider supports OAuth.
   * Single source of truth: keep this in sync with AUTH_PROVIDERS in
   * src/auth/auth-commands.ts.
   */
  oauthLoginSlug?: "codex" | "kimi" | "antigravity" | "grok";
  /** Whether this is a local provider (no API key needed) */
  isLocal?: boolean;
  /** Whether this provider supports direct API access (not just via OpenRouter) */
  isDirectApi?: boolean;
  /** Shortest @ prefix for handler creation (reverse of shortcuts) */
  shortestPrefix?: string;
  /** Short description for TUI display (e.g., "580+ models, default backend") */
  description?: string;
}

/**
 * A definition that MUST state its routing tier.
 *
 * Every table a routing decision reads is typed with this rather than with
 * `ProviderDefinition`, so "forgot the tier" is a compile error at the two
 * places a real provider is born — `BUILTIN_PROVIDERS` below and
 * `buildProviderDefinition` in custom-endpoints-loader.ts — instead of a silent
 * absence that drops the provider from every gathered chain.
 */
export type TieredProviderDefinition = ProviderDefinition & { tier: RouteTier };

// ---------------------------------------------------------------------------
// Built-in provider definitions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Handler factories — twelve builders shared across twenty-six providers.
//
// Declared once here rather than inline per entry because the mapping is
// many-to-one: `openaiProfile` alone serves x-ai, qwen, deepseek, mistralai and
// both Sakana products. Inlining would have copied the same thunk nine times,
// which is how tables drift.
// ---------------------------------------------------------------------------

const geminiHandler = lazyHandler((m) => m.geminiProfile);
const antigravityHandler = lazyHandler((m) => m.antigravityProfile);
const devinHandler = lazyHandler((m) => m.devinProfile);
const grokSubscriptionHandler = lazyHandler((m) => m.grokSubscriptionProfile);
const openaiHandler = lazyHandler((m) => m.openaiProfile);
const openaiCodexHandler = lazyHandler((m) => m.openaiCodexProfile);
const anthropicCompatHandler = lazyHandler((m) => m.anthropicCompatProfile);
const glmHandler = lazyHandler((m) => m.glmProfile);
const openCodeZenHandler = lazyHandler((m) => m.openCodeZenProfile);
const ollamaCloudHandler = lazyHandler((m) => m.ollamaCloudProfile);
const litellmHandler = lazyHandler((m) => m.litellmProfile);
const vertexHandler = lazyHandler((m) => m.vertexProfile);
const poeHandler = lazyHandler((m) => m.poeProfile);

/** Shorthand for the five documented reasons a provider builds nothing here. */
const noHandler = (reason: NoHandlerReason, note: string): NoHandler => ({
  kind: "none",
  reason,
  note,
});

/**
 * Handler for a provider registered at RUNTIME — a custom endpoint.
 *
 * Its builder cannot be named at compile time because the provider does not
 * exist until a config file is read, so this defers to the runtime profile
 * registry the loader populates. Still a required field on the definition, so a
 * custom endpoint that registers a provider and forgets its profile fails the
 * same way a builtin would: at the type level, not at request time.
 */
export function runtimeHandler(name: string): LazyHandlerFactory {
  return async (ctx) => {
    const { getRuntimeProfiles } = await import("./runtime-providers.js");
    const profile = getRuntimeProfiles().get(name);
    return profile ? profile.createHandler(ctx) : null;
  };
}

export const BUILTIN_PROVIDERS: TieredProviderDefinition[] = [
  // ── Google Gemini (direct API) ─────────────────────────────────────
  {
    createHandler: geminiHandler,
    tier: "native",
    name: "google",
    displayName: "Gemini",
    transport: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    baseUrlEnvVars: ["GEMINI_BASE_URL"],
    apiPath: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
    apiKeyEnvVar: "GEMINI_API_KEY",
    apiKeyDescription: "Google Gemini API Key",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    shortcuts: ["g", "gemini"],
    shortestPrefix: "g",
    legacyPrefixes: [
      { prefix: "g/", stripPrefix: true },
      { prefix: "gemini/", stripPrefix: true },
    ],
    nativeModelPatterns: [{ pattern: /^google\//i }, { pattern: /^gemini-/i }],
    isDirectApi: true,
    description: "Direct Gemini API (g@, google@)",
    // No oauthLoginSlug: the Gemini direct API takes GEMINI_API_KEY. The
    // Gemini SUBSCRIPTION flow is `antigravity` below, which authenticates with
    // the shared agy token — a different product, not an OAuth mode of this one.
  },

  // ── Antigravity (shared OAuth token — subscription) ────────────────
  // The individuals/Ultra subscription flow. Auth = the SHARED Antigravity
  // token (the `agy` keychain item), NOT a GEMINI_API_KEY.
  {
    createHandler: antigravityHandler,
    tier: "dynamic-subscription",
    name: "antigravity",
    displayName: "Antigravity",
    transport: "antigravity",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    apiPath: "/v1internal:streamGenerateContent?alt=sse",
    apiKeyEnvVar: "",
    apiKeyDescription: "Antigravity (shared OAuth token)",
    apiKeyUrl: "https://antigravity.google/",
    // Dedicated login: `claudish login antigravity` (OAuth PKCE → shared keychain
    // store). NOT the gemini-cli login, which mints a token the Antigravity
    // backend rejects for generation.
    oauthLoginSlug: "antigravity",
    shortcuts: ["ag", "antigravity"],
    shortestPrefix: "ag",
    legacyPrefixes: [
      { prefix: "ag/", stripPrefix: true },
      { prefix: "antigravity/", stripPrefix: true },
    ],
    // THE NAMESPACE CLAIM, not an auto-detect win. `google` declares the same
    // `/^gemini-/i` and is defined ABOVE, so `getNativeModelPatterns()` — which
    // is first-wins on array order — still answers `google` for a bare
    // `gemini-3.6-flash`, exactly as before. What this adds is the one thing
    // `route-candidates.ts` needs: `google/antigravity-subscription` sits in the
    // probe map as `client_model_selection_required` and publishes ZERO
    // `aggregators[]` rows, so gathering from the catalog alone can never see
    // this plan. Without a claim here, the 5 Gemini models a seat actually
    // serves (measured on generation g-20260921062451697-f490edba) would move
    // off a flat-rate plan onto the metered `google` hop — the one ordering
    // error that costs money.
    //
    // The family, not a list of ids: which VARIANTS a seat serves is per-account
    // and drifts (`v1internal:fetchAvailableModels`), and the AVAILABILITY
    // filter asks the account itself. This only says "Gemini is the namespace
    // this plan sells", which is the provider's product definition.
    //
    // Deliberately NOT `/^claude-/i`: the Antigravity backend does serve Claude
    // ids, but a bare Claude name must never reach `route()` at all
    // (`nativeRouteFor` handles it first — see CLAUDE.md's Invariants).
    nativeModelPatterns: [{ pattern: /^gemini-/i }],
    // Not a GET — an OAuth POST to v1internal:fetchAvailableModels, so `path`
    // is ignored. Declared so the picker prefers the per-subscription dynamic
    // models catalog and, more importantly, its per-model `maxTokens`: the backend and
    // the shared catalog disagree by 4x on claude-sonnet-4-6 (250K vs 1M).
    modelDiscovery: { path: "", format: "antigravity" },
    isDirectApi: true,
    description: "Antigravity subscription (ag@)",
  },

  // ── Devin (Cognition/Codeium subscription) ─────────────────────────
  // Auth is the Devin CLI's own session token, read verbatim from
  // ~/.local/share/devin/credentials.toml (or WINDSURF_API_KEY). One flat
  // subscription serving several vendors' models over a Connect-protobuf rpc.
  {
    createHandler: devinHandler,
    tier: "dynamic-subscription",
    name: "devin",
    displayName: "Devin",
    transport: "devin",
    baseUrl: "https://server.codeium.com",
    baseUrlEnvVars: ["WINDSURF_API_SERVER_URL"],
    apiPath: "/exa.api_server_pb.ApiServerService/GetChatMessage",
    // MUST stay empty — this is load-bearing, not an oversight. proxy-server
    // only runs its credential-extraction block for a NON-empty apiKeyEnvVar,
    // and that block extracts the key by stripping `Bearer ` from
    // `auth.headers.Authorization`. Devin's artifact is
    // `authorization: Basic <k>-<k>` (lowercase header, Basic scheme), so the
    // extraction would yield "" -> `return null` -> the handler is never built
    // and the model SILENTLY falls through to OpenRouter. A wrong provider
    // quietly succeeding is worse than a crash. Empty makes proxy-server skip
    // the block and lets the transport pull its own artifact from the credential
    // authority — exactly the Antigravity pattern.
    apiKeyEnvVar: "",
    apiKeyDescription: "Devin CLI session token (~/.local/share/devin/credentials.toml)",
    apiKeyUrl: "https://devin.ai/",
    shortcuts: ["dv", "devin"],
    shortestPrefix: "dv",
    legacyPrefixes: [
      { prefix: "dv/", stripPrefix: true },
      { prefix: "devin/", stripPrefix: true },
    ],
    // EXACTLY ONE pattern, and it is Cognition's OWN family.
    //
    // The rule this narrows: Devin's RE-SERVED uids collide head-on with other
    // providers' namespaces — `claude-opus-5-medium` matches native-anthropic's
    // /^claude-/i, `gpt-5-6-luna-medium` matches OpenAI's, `glm-5-2` matches
    // GLM's, `kimi-k3-high` matches Kimi's — so those must never auto-detect as
    // Devin, and Devin must never be prepended to their chains. That reasoning
    // is intact: access to another vendor's model through the plan stays
    // EXPLICIT (`dv@claude-opus-5`), same as Alibaba Token Plan.
    //
    // `swe-*` is different in kind: it is Cognition's own model line, no other
    // provider in the catalog carries it, and it collides with nothing. The
    // pattern is Devin's namespace claim: `gatherFromNamespaceClaims`
    // (route-candidates.ts) makes Devin a route candidate for a bare `swe-*`
    // name, which the catalog cannot list because the account decides what the
    // seat serves. It was added when `parseModelSpec` still sent every
    // unrecognised bare name to native-anthropic: `swe-1.7` never reached
    // routing, was silently rewritten to `claude-opus-4-1` and answered by a
    // different vendor's model, probing byte-identically to a nonsense string
    // while `dv@swe-1.7` served fine.
    //
    // Do NOT extend this list to Devin's re-served families.
    nativeModelPatterns: [{ pattern: /^swe-/i }],
    modelDiscovery: { path: "", format: "devin-connect" },
    isDirectApi: true,
    description: "Devin subscription (dv@, devin@)",
  },

  // NOTE: the `gemini-codeassist` provider was REMOVED here. Google retired
  // "Code Assist for individuals" for gemini-cli's OAuth client
  // (UNSUPPORTED_CLIENT), so it could not authenticate for any consumer account.
  // The Gemini subscription flow is `antigravity` above; `g@`/`google@` remains
  // the direct pay-per-use API.

  // ── OpenAI (direct API) ────────────────────────────────────────────
  {
    createHandler: openaiHandler,
    tier: "native",
    name: "openai",
    displayName: "OpenAI",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.openai.com",
    baseUrlEnvVars: ["OPENAI_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENAI_API_KEY",
    apiKeyDescription: "OpenAI API Key",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    shortcuts: ["oai"],
    shortestPrefix: "oai",
    legacyPrefixes: [{ prefix: "oai/", stripPrefix: true }],
    nativeModelPatterns: [
      { pattern: /^openai\//i },
      { pattern: /^gpt-/i },
      { pattern: /^o1(-|$)/i },
      { pattern: /^o3(-|$)/i },
      { pattern: /^chatgpt-/i },
    ],
    isDirectApi: true,
    description: "Direct OpenAI API (oai@)",
  },

  // ── OpenAI Codex (Responses API — ChatGPT Plus/Pro subscription) ────
  {
    createHandler: openaiCodexHandler,
    // The ROUTE is the ChatGPT plan, and the catalog publishes its membership
    // (`openai/codex-subscription`), so this is where routing should prefer it.
    // It is NOT a billing statement: `openai-codex` is CREDENTIAL-decided
    // (`CREDENTIAL_DECIDED_PROVIDERS`) because an `OPENAI_CODEX_API_KEY` reaches
    // the same name against api.openai.com and bills the developer — measured,
    // `"payer": "developer"`. So this provider must still never be derived into
    // `SUBSCRIPTION_PROVIDERS`; the name check there short-circuits the probe.
    tier: "subscription",
    name: "openai-codex",
    displayName: "OpenAI Codex",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.openai.com",
    baseUrlEnvVars: ["OPENAI_CODEX_BASE_URL"],
    apiPath: "/v1/responses",
    apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
    apiKeyAliases: ["OPENAI_API_KEY"],
    apiKeyDescription: "OpenAI Codex API Key (ChatGPT Plus/Pro subscription)",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    oauthFallback: "codex-oauth.json",
    oauthLoginSlug: "codex",
    shortcuts: ["cx", "codex"],
    shortestPrefix: "cx",
    legacyPrefixes: [{ prefix: "cx/", stripPrefix: true }],
    nativeModelPatterns: [{ pattern: /codex$/i }],
    isDirectApi: true,
    description: "OpenAI Codex (cx@, codex@)",
  },

  // ── OpenRouter ─────────────────────────────────────────────────────
  {
    createHandler: noHandler(
      "dedicated-handler",
      "Served by OpenRouterHandler, which predates this table. proxy-server returns null here on purpose so the request falls through to it."
    ),
    tier: "gateway",
    name: "openrouter",
    displayName: "OpenRouter",
    transport: "openrouter",
    baseUrl: "https://openrouter.ai",
    apiPath: "/api/v1/chat/completions",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    apiKeyDescription: "OpenRouter API Key",
    apiKeyUrl: "https://openrouter.ai/keys",
    shortcuts: ["or"],
    shortestPrefix: "or",
    legacyPrefixes: [{ prefix: "or/", stripPrefix: true }],
    nativeModelPatterns: [{ pattern: /^openrouter\//i }],
    headers: {
      "HTTP-Referer": "https://claudish.com",
      "X-Title": "Claudish - OpenRouter Proxy",
    },
    isDirectApi: true,
    description: "580+ models, default backend (or@)",
  },

  // ── xAI / Grok (OpenAI-compatible) ──────────────────────────────────
  {
    createHandler: openaiHandler,
    tier: "native",
    name: "x-ai",
    displayName: "xAI",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.x.ai",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "XAI_API_KEY",
    apiKeyDescription: "xAI API Key",
    apiKeyUrl: "https://console.x.ai/",
    // Canonical name is "x-ai" (matches the Firebase catalog slug). The bare
    // "xai" and "grok" forms remain as input aliases so existing `xai@...`
    // commands and scripts keep routing.
    shortcuts: ["x-ai", "xai", "grok"],
    shortestPrefix: "x-ai",
    legacyPrefixes: [{ prefix: "xai/", stripPrefix: true }],
    nativeModelPatterns: [{ pattern: /^x-ai\//i }, { pattern: /^grok-/i }],
    isDirectApi: true,
  },

  // ── Grok Build subscription (SuperGrok / X Premium+) ───────────────
  //
  // Same models as `x-ai` above, different BILLING: this one is covered by the
  // user's Grok subscription, while `x-ai` is metered per token against
  // XAI_API_KEY. The same subscription-vs-metered split claudish already models
  // for GLM (gc@/glm@), MiniMax (mmc@/mm@), Qwen (qtoken@/qpay@) and Sakana (sc@/sakana@).
  //
  // Full protocol write-up: ai-docs/reports/grok-subscription/protocol-spec.md
  {
    createHandler: grokSubscriptionHandler,
    tier: "dynamic-subscription",
    name: "grok-subscription",
    displayName: "Grok Build (subscription)",
    transport: "grok-subscription",
    tokenStrategy: "delta-aware",
    // The proxy the Grok CLI itself talks to. GROK_PROXY_URL is the CLI's own
    // override, so it is honoured here too.
    baseUrl: "https://cli-chat-proxy.grok.com",
    baseUrlEnvVars: ["GROK_PROXY_URL"],
    apiPath: "/v1/chat/completions",
    // MUST stay empty — load-bearing, not an oversight. proxy-server only runs
    // its credential-extraction block for a NON-empty apiKeyEnvVar, and that
    // block would happily extract this bearer token and then CACHE it, past the
    // six-hour life it actually has. Empty makes proxy-server skip the block, so
    // every request goes through the credential authority, which is the only
    // place expiry is checked and a refresh happens.
    apiKeyEnvVar: "",
    apiKeyDescription:
      "Grok subscription OAuth (`claudish login grok`, or an existing `grok login`)",
    apiKeyUrl: "https://x.ai/cli",
    // claudish drives its OWN device-authorization flow — xAI registered this
    // as a PUBLIC client (no secret), so unlike Antigravity there is no
    // rotating app secret forcing us through the vendor CLI.
    oauthLoginSlug: "grok",
    oauthFallback: "grok-oauth.json",
    // `grok@` deliberately stays with the metered `x-ai` provider so no existing
    // command silently changes meaning. `gk@` is the new, explicit spelling.
    shortcuts: ["gk", "grok-subscription"],
    shortestPrefix: "gk",
    legacyPrefixes: [{ prefix: "gk/", stripPrefix: true }],
    // THE NAMESPACE CLAIM. `x-ai` declares the same `/^grok-/i` and is defined
    // ABOVE, so `getNativeModelPatterns()` — first-wins on array order — still
    // answers `x-ai` for a bare `grok-4.6`, and this provider does NOT win
    // auto-detection. A claim is not an auto-detect: it exists so
    // `route-candidates.ts` can emit a candidate the CATALOG cannot publish.
    // `x-ai/supergrok-subscription` sits in the probe map as
    // `client_model_selection_required` with ZERO `aggregators[]` rows, so
    // gathering would otherwise put a SuperGrok seat's 2 models (measured on
    // generation g-20260921062451697-f490edba) on the metered `x-ai` hop and
    // bill per token for what the plan already covers.
    //
    // Safe as a bare name for the reason the routing chain relied on before:
    // these ids are xAI's OWN, so — unlike Devin's re-served uids — there is no
    // other vendor's namespace to collide with. Which grok ids a seat serves
    // stays ACCOUNT-SCOPED, so the claim names the family and the availability
    // filter asks `/v1/models`.
    nativeModelPatterns: [{ pattern: /^grok-/i }],
    // The dynamic models catalog is ACCOUNT-SCOPED and drifts, so it is discovered, never
    // pinned. `/v1/models` is genuinely authenticated here (401 without a token,
    // unlike Alibaba's coding-intl model list where a 200 proves nothing), and it
    // answers the standard OpenAI `{object, data:[{id}]}` shape. Discovery falls
    // back to the credential authority when `apiKeyEnvVar` is empty, which also
    // supplies the mandatory client-version headers.
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    isDirectApi: true,
    description: "Grok on your SuperGrok or X Premium+ plan (gk@)",
  },

  // ── MiniMax (Anthropic-compatible) ─────────────────────────────────
  {
    createHandler: anthropicCompatHandler,
    tier: "native",
    name: "minimax",
    displayName: "MiniMax",
    transport: "anthropic",
    // The two MiniMax hosts are REGIONS, and a key works only on the host of the
    // platform that issued it: api.minimax.io for the international platform
    // (platform.minimax.io), api.minimaxi.com for the China platform
    // (minimaxi.com). Metered and coding-plan keys follow the same rule.
    //
    // The default is the international host. Measured 2026-09-19 with a fresh
    // international metered key: api.minimax.io answered 200 on /v1/models,
    // /anthropic/v1/messages and /v1/chat/completions, and api.minimaxi.com
    // answered 401 "invalid api key (2049)" on all three. This entry pointed at
    // minimaxi.com from 2026-08-11 (b7173d2), so every international metered key
    // failed. A China-platform key needs MINIMAX_BASE_URL=https://api.minimaxi.com.
    // The catalog publishes one profile, `minimax/direct-api`, with no region, so
    // the host is claudish's choice rather than a contract value.
    baseUrl: "https://api.minimax.io",
    baseUrlEnvVars: ["MINIMAX_BASE_URL"],
    apiPath: "/anthropic/v1/messages",
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    apiKeyEnvVar: "MINIMAX_API_KEY",
    apiKeyDescription: "MiniMax API Key",
    apiKeyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    authScheme: "bearer",
    shortcuts: ["mm", "mmax"],
    shortestPrefix: "mm",
    legacyPrefixes: [
      { prefix: "mmax/", stripPrefix: true },
      { prefix: "mm/", stripPrefix: true },
    ],
    nativeModelPatterns: [
      { pattern: /^minimax\//i },
      { pattern: /^minimax-/i },
      { pattern: /^abab-/i },
    ],
    isDirectApi: true,
    description: "MiniMax API (mm@, mmax@)",
  },

  // ── MiniMax Coding Plan ────────────────────────────────────────────
  {
    createHandler: anthropicCompatHandler,
    tier: "subscription",
    name: "minimax-coding",
    displayName: "MiniMax Coding",
    transport: "anthropic",
    baseUrl: "https://api.minimax.io",
    baseUrlEnvVars: ["MINIMAX_CODING_BASE_URL"],
    apiPath: "/anthropic/v1/messages",
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    apiKeyEnvVar: "MINIMAX_CODING_API_KEY",
    apiKeyDescription: "MiniMax Coding Plan API Key",
    apiKeyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    authScheme: "bearer",
    shortcuts: ["mmc"],
    shortestPrefix: "mmc",
    legacyPrefixes: [{ prefix: "mmc/", stripPrefix: true }],
    isDirectApi: true,
    description: "MiniMax Coding Plan (mmc@)",
  },

  // ── Kimi Coding Plan (must be before Kimi — kimi-for-coding$ is more specific than kimi-*)
  {
    createHandler: anthropicCompatHandler,
    tier: "subscription",
    name: "kimi-coding",
    displayName: "Kimi Coding",
    transport: "kimi-coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    apiPath: "/messages",
    apiKeyEnvVar: "KIMI_CODING_API_KEY",
    apiKeyDescription: "Kimi Coding API Key",
    apiKeyUrl: "https://kimi.com/code (get key from membership page, or run: claudish login kimi)",
    oauthFallback: "kimi-oauth.json",
    oauthLoginSlug: "kimi",
    shortcuts: ["kc"],
    shortestPrefix: "kc",
    legacyPrefixes: [{ prefix: "kc/", stripPrefix: true }],
    // Namespace ownership only — WHICH models exist is discovered live, never
    // listed here. `kimi-for-coding` is K2.7 Coding (+ `-highspeed`); `k3*`
    // covers K3 and its context-capped SKUs (k3-256k).
    nativeModelPatterns: [{ pattern: /^kimi-for-coding/i }, { pattern: /^k3(-|$)/i }],
    // The coding endpoint serves several models whose context windows depend on
    // the subscriber's tier (k3 is 1M only on Allegretto+). Ask the endpoint
    // itself — the call is authenticated, so it answers for THIS user's plan.
    modelDiscovery: { path: "/models", format: "openai-models-list" },
    isDirectApi: true,
    description: "Kimi Coding Plan (kc@)",
  },

  // ── Kimi / Moonshot (Anthropic-compatible) ─────────────────────────
  {
    createHandler: anthropicCompatHandler,
    tier: "native",
    name: "kimi",
    displayName: "Kimi",
    transport: "anthropic",
    baseUrl: "https://api.moonshot.ai",
    baseUrlEnvVars: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
    apiPath: "/anthropic/v1/messages",
    // "only effective at the top level; cache_control markers inside the
    // messages array are ignored", and a request without it only reads the
    // cache: https://platform.kimi.ai/docs/api/messages
    cacheControlPlacement: "top-level",
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    apiKeyAliases: ["KIMI_API_KEY"],
    apiKeyDescription: "Kimi/Moonshot API Key",
    apiKeyUrl: "https://platform.moonshot.cn/",
    shortcuts: ["kimi", "moon", "moonshot"],
    shortestPrefix: "kimi",
    legacyPrefixes: [
      { prefix: "kimi/", stripPrefix: true },
      { prefix: "moonshot/", stripPrefix: true },
    ],
    nativeModelPatterns: [
      { pattern: /^moonshot(ai)?\//i },
      { pattern: /^moonshot-/i },
      { pattern: /^kimi-/i },
    ],
    isDirectApi: true,
    description: "Kimi API (kimi@, moon@)",
  },

  // ── GLM / Zhipu (OpenAI-compatible) ────────────────────────────────
  {
    createHandler: glmHandler,
    tier: "native",
    name: "glm",
    displayName: "GLM",
    transport: "openai",
    tokenStrategy: "delta-aware",
    // api.z.ai is the international mirror — same models, same auth,
    // dramatically better reachability from outside CN than open.bigmodel.cn.
    baseUrl: "https://api.z.ai",
    baseUrlEnvVars: ["ZHIPU_BASE_URL", "GLM_BASE_URL"],
    apiPath: "/api/paas/v4/chat/completions",
    modelDiscovery: { path: "/api/paas/v4/models", format: "openai-models-list" },
    apiKeyEnvVar: "ZHIPU_API_KEY",
    apiKeyAliases: ["GLM_API_KEY"],
    apiKeyDescription: "GLM/Zhipu API Key",
    apiKeyUrl: "https://z.ai/",
    shortcuts: ["glm", "zhipu"],
    shortestPrefix: "glm",
    legacyPrefixes: [
      { prefix: "glm/", stripPrefix: true },
      { prefix: "zhipu/", stripPrefix: true },
    ],
    nativeModelPatterns: [
      { pattern: /^zhipu\//i },
      { pattern: /^glm-/i },
      { pattern: /^chatglm-/i },
    ],
    isDirectApi: true,
    description: "GLM API (glm@, zhipu@)",
  },

  // ── GLM Coding Plan ────────────────────────────────────────────────
  {
    createHandler: glmHandler,
    tier: "subscription",
    name: "glm-coding",
    displayName: "GLM Coding",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.z.ai",
    apiPath: "/api/coding/paas/v4/chat/completions",
    modelDiscovery: { path: "/api/coding/paas/v4/models", format: "openai-models-list" },
    apiKeyEnvVar: "GLM_CODING_API_KEY",
    apiKeyAliases: ["ZAI_CODING_API_KEY"],
    apiKeyDescription: "GLM Coding Plan API Key",
    apiKeyUrl: "https://z.ai/subscribe",
    shortcuts: ["gc"],
    shortestPrefix: "gc",
    legacyPrefixes: [{ prefix: "gc/", stripPrefix: true }],
    isDirectApi: true,
    description: "GLM Coding Plan (gc@)",
  },

  // ── Z.AI (Anthropic-compatible GLM API) ────────────────────────────
  {
    createHandler: anthropicCompatHandler,
    tier: "native",
    name: "z-ai",
    displayName: "Z.AI",
    transport: "anthropic",
    baseUrl: "https://api.z.ai",
    baseUrlEnvVars: ["ZAI_BASE_URL"],
    apiPath: "/api/anthropic/v1/messages",
    apiKeyEnvVar: "ZAI_API_KEY",
    apiKeyDescription: "Z.AI API Key",
    apiKeyUrl: "https://z.ai/",
    // Canonical name is "z-ai" (matches the Firebase catalog slug). Bare "zai"
    // stays as an input alias for existing `zai@...` commands.
    shortcuts: ["z-ai", "zai"],
    shortestPrefix: "z-ai",
    legacyPrefixes: [{ prefix: "zai/", stripPrefix: true }],
    nativeModelPatterns: [{ pattern: /^z-ai\//i }, { pattern: /^zai\//i }],
    isDirectApi: true,
    description: "Z.AI API (z-ai@)",
  },

  // ── OllamaCloud ────────────────────────────────────────────────────
  {
    createHandler: ollamaCloudHandler,
    tier: "gateway",
    name: "ollamacloud",
    displayName: "OllamaCloud",
    transport: "ollamacloud",
    tokenStrategy: "accumulate-both",
    baseUrl: "https://ollama.com",
    baseUrlEnvVars: ["OLLAMACLOUD_BASE_URL"],
    apiPath: "/api/chat",
    apiKeyEnvVar: "OLLAMA_API_KEY",
    apiKeyDescription: "OllamaCloud API Key",
    apiKeyUrl: "https://ollama.com/account",
    shortcuts: ["oc", "llama", "lc", "meta"],
    shortestPrefix: "oc",
    legacyPrefixes: [{ prefix: "oc/", stripPrefix: true }],
    nativeModelPatterns: [
      { pattern: /^ollamacloud\//i },
      { pattern: /^meta-llama\//i },
      { pattern: /^llama-/i },
      { pattern: /^llama3/i },
    ],
    isDirectApi: true,
    description: "Cloud Ollama (oc@, llama@)",
  },

  // ── OpenCode Zen ───────────────────────────────────────────────────
  {
    createHandler: openCodeZenHandler,
    tier: "gateway",
    name: "opencode-zen",
    displayName: "OpenCode Zen",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://opencode.ai/zen",
    baseUrlEnvVars: ["OPENCODE_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    apiKeyDescription: "OpenCode Zen API Key",
    apiKeyUrl: "https://opencode.ai/",
    // publicKeyFallback REMOVED (was `"public"`).
    //
    // It sent the literal string "public" as the bearer token on the theory that
    // Zen's free tier accepts a shared sentinel. Measured 2026-08-22: the
    // endpoint answers `401 — Missing API key`. Whether it ever worked or was
    // withdrawn, it does not work now.
    //
    // Leaving it in was worse than a dead credential, because `isAvailable()`
    // returns TRUE on the mere presence of a publicKeyFallback without issuing a
    // request — so the provider advertised itself as Ready, sorted above the
    // "not configured" divider, and only revealed the 401 when someone pressed
    // `t`. A row that asserts readiness it has never verified is a worse defect
    // than a row that admits it has no key.
    //
    // It also violated the catalog's own rule (CLAUDE.md): never hardcode a
    // value discovered from a vendor — a default is a rule, not a pinned id.
    //
    // Zen remains reachable with a real OPENCODE_API_KEY, and `zengo@`
    // (opencode-zen-go) is unaffected. If Zen documents a genuine keyless tier
    // again, the right shape is live discovery, not another literal.
    shortcuts: ["zen"],
    shortestPrefix: "zen",
    legacyPrefixes: [{ prefix: "zen/", stripPrefix: true }],
    isDirectApi: true,
    description: "OpenCode Zen (zen@)",
  },

  // ── OpenCode Zen Go (lite plan) ────────────────────────────────────
  {
    createHandler: openCodeZenHandler,
    tier: "subscription",
    name: "opencode-zen-go",
    displayName: "OpenCode Zen Go",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://opencode.ai/zen/go",
    baseUrlEnvVars: ["OPENCODE_GO_BASE_URL"],
    apiPath: "/v1/chat/completions",
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    // Zen Go is a separate paid tier from the METERED Zen plan. This block used
    // to claim "keys for one tier are not accepted by the other (401)" and kept
    // `apiKeyAliases: ["OPENCODE_API_KEY"]` — the metered Zen key — on the
    // strength of it.
    //
    // ("the free Zen plan" is what it also said. Zen's keyless tier is dead —
    // measured 401, see the publicKeyFallback removal ~40 lines above — so Zen is
    // the metered tier and calling it free contradicted its own file.)
    //
    // THE 401 CLAIM IS FALSE. Measured 2026-09-02 on `minimax-m3`, a model BOTH
    // tiers serve, one POST to chat/completions per row
    // (ai-docs/reports/data/measurements-20260902.txt):
    //
    //   CONTROL  Zen Go key -> https://opencode.ai/zen/go/v1/chat/completions -> 200
    //   CROSS    Zen Go key -> https://opencode.ai/zen/v1/chat/completions    -> 200
    //   BOGUS    fake key   -> https://opencode.ai/zen/v1/chat/completions    -> 401
    //                         {"type":"error","error":{"type":"AuthError",…}}
    //
    // The bogus row is what makes the cross-tier 200 mean something: that endpoint
    // does authenticate, so it ACCEPTED the other tier's key rather than waving
    // everything through. The two answered with different response-id shapes
    // (`06e71dee…` vs `chatcmpl-76bdafac…`), i.e. different upstreams honouring one
    // key. So keys are NOT tier-locked in the direction that was measurable here,
    // and the symmetric claim the alias rested on is disproven.
    //
    // WHAT IS NOT MEASURED, stated plainly: a ZEN-TIER key against /zen/go. No
    // Zen-tier key exists on this machine. That is the direction that costs money —
    // `opencode-zen-go` is classified flat-rate BY NAME
    // (remote-provider-types.ts SUBSCRIPTION_PROVIDERS), so a Zen-tier key
    // satisfying `zgo@` would be metered usage reported as SUB and $0.
    //
    // Hence the alias is GONE (2026-09-02). It was justified by a claim now known
    // to be false, and it made that money-losing case reachable with no evidence
    // that the endpoint would refuse it. `zgo@` now requires its own key; a user
    // holding only OPENCODE_API_KEY gets `siblingKeyEnvVars` named in the
    // missing-credential sentence instead of a silent `SUB` label.
    apiKeyEnvVar: "OPENCODE_GO_API_KEY",
    siblingKeyEnvVars: ["OPENCODE_API_KEY"],
    apiKeyDescription: "OpenCode Zen Go (Lite Plan) API Key",
    apiKeyUrl: "https://opencode.ai/",
    shortcuts: ["zengo", "zgo"],
    shortestPrefix: "zengo",
    legacyPrefixes: [
      { prefix: "zengo/", stripPrefix: true },
      { prefix: "zgo/", stripPrefix: true },
    ],
    isDirectApi: true,
    description: "OpenCode Zen Go plan (zengo@)",
  },

  // ── Vertex AI ──────────────────────────────────────────────────────
  {
    createHandler: vertexHandler,
    // Account-SELECTED but METERED: which publishers a project may call is a GCP
    // fact the catalog cannot know (it sits in the probe map as
    // `client_model_selection_required`, beside the flat-rate four), yet every
    // call is billed per token. `dynamic-subscription` would say the opposite
    // about money, so the tier follows the BILLING and the selection stays a
    // fact about entitlement, settled by the availability filter. Consequence,
    // stated so it is not mistaken for an oversight: Vertex gets no namespace
    // claim, so a model only Vertex serves stays reachable by `v@model`.
    tier: "gateway",
    name: "vertex",
    displayName: "Vertex AI",
    transport: "vertex",
    baseUrl: "",
    // The transport composes the endpoint from project + location + publisher,
    // so the empty baseUrl above is the finished answer. Without this the
    // registry filter drops Vertex entirely (see `buildsOwnEndpoint`).
    buildsOwnEndpoint: true,
    apiPath: "",
    // Not an API key: the project ID, paired with Application Default
    // Credentials. It stays on `apiKeyEnvVar` because that is what makes the
    // credential authority resolve Vertex at all, and what names the remedy in
    // "no credential" messages. VERTEX_API_KEY (Express) was REMOVED from
    // `apiKeyAliases` on 2026-09-21 along with the mode itself. Claudish also
    // resolves the project from the ADC file and `gcloud config` — see
    // `resolveVertexConfig` — so an unset VERTEX_PROJECT is not fatal.
    apiKeyEnvVar: "VERTEX_PROJECT",
    apiKeyDescription: "Vertex AI project ID (with Application Default Credentials)",
    apiKeyUrl: "https://console.cloud.google.com/vertex-ai",
    shortcuts: ["v", "vertex"],
    shortestPrefix: "v",
    legacyPrefixes: [
      { prefix: "v/", stripPrefix: true },
      { prefix: "vertex/", stripPrefix: true },
    ],
    isDirectApi: true,
    description: "Vertex AI on Application Default Credentials (v@, vertex@)",
  },

  // ── LiteLLM ────────────────────────────────────────────────────────
  {
    createHandler: litellmHandler,
    // A proxy in front of many vendors, whose own URL the user supplies: a
    // gateway in every sense the tier means, even when the instance is theirs.
    tier: "gateway",
    name: "litellm",
    displayName: "LiteLLM",
    transport: "litellm",
    baseUrl: "",
    baseUrlEnvVars: ["LITELLM_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "LITELLM_API_KEY",
    apiKeyDescription: "LiteLLM API Key",
    apiKeyUrl: "https://docs.litellm.ai/",
    shortcuts: ["litellm", "ll"],
    shortestPrefix: "ll",
    legacyPrefixes: [
      { prefix: "litellm/", stripPrefix: true },
      { prefix: "ll/", stripPrefix: true },
    ],
    isDirectApi: true,
    description: "LiteLLM proxy (ll@, litellm@)",
  },

  // ── Poe ────────────────────────────────────────────────────────────
  {
    createHandler: poeHandler,
    tier: "gateway",
    name: "poe",
    displayName: "Poe",
    transport: "poe",
    baseUrl: "https://api.poe.com",
    apiPath: "/v1/chat/completions",
    // The catalog has no verified probe pick for Poe, so the account's own list
    // is the only source of one. Measured 2026-09-19: /v1/models answers 200
    // with 341 models.
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    apiKeyEnvVar: "POE_API_KEY",
    apiKeyDescription: "Poe API Key",
    apiKeyUrl: "https://poe.com/api_key",
    shortcuts: ["poe"],
    shortestPrefix: "poe",
    legacyPrefixes: [],
    nativeModelPatterns: [{ pattern: /^poe:/i }],
    isDirectApi: true,
    description: "Poe API (poe@)",
  },

  // ── Ollama (local) ─────────────────────────────────────────────────
  //
  // THE FOUR LOCAL PROVIDERS ARE `native`, and the tier is inert for them.
  //
  // Inert first, because that is what makes the choice cheap: a local server is
  // bound to no catalog route (`ollama/cloud` belongs to `ollamacloud`, not to
  // this entry), so no catalog connection can ever name one, and only a
  // `dynamic-subscription` may claim a namespace — so no local provider can be
  // gathered as a remote candidate at all. Local models reach a request the way
  // they always have: an explicit `ollama@llama3.2`, or the local-provider path.
  //
  // `native` among the four remaining values because the request goes to the
  // endpoint that runs the model, with no reseller and no plan in between —
  // which is what `native` means minus the metering. `gateway` would be false
  // (nothing is resold, nothing is billed) and `subscription` would be worse: it
  // claims a plan with a published membership, and would sort a local server
  // ahead of a subscription the user actually pays for if the tier ever stopped
  // being inert.
  {
    createHandler: noHandler(
      "local",
      "Built by the local-provider path; never reaches direct-api."
    ),
    tier: "native",
    name: "ollama",
    displayName: "Ollama",
    transport: "local",
    baseUrl: "http://localhost:11434",
    baseUrlEnvVars: ["OLLAMA_BASE_URL", "OLLAMA_HOST"],
    apiPath: "/api/chat",
    // Optional: Ollama supports auth when exposed over the network (e.g.
    // via reverse proxy). Empty by default; user sets OLLAMA_API_KEY if
    // their deployment requires it.
    apiKeyEnvVar: "OLLAMA_API_KEY",
    apiKeyDescription: "Ollama API Key (optional — leave blank for localhost)",
    apiKeyUrl: "",
    shortcuts: ["ollama"],
    shortestPrefix: "ollama",
    legacyPrefixes: [
      { prefix: "ollama/", stripPrefix: true },
      { prefix: "ollama:", stripPrefix: true },
    ],
    isLocal: true,
    // The daemon knows exactly which models are pulled; nothing else can. Path
    // is unused by the `ollama-tags` fetcher, which owns its own endpoint.
    modelDiscovery: { path: "/api/tags", format: "ollama-tags" },
    description: "Local Ollama (ollama@)",
  },

  // ── LM Studio (local) ──────────────────────────────────────────────
  {
    createHandler: noHandler(
      "local",
      "Built by the local-provider path; never reaches direct-api."
    ),
    tier: "native",
    name: "lmstudio",
    displayName: "LM Studio",
    transport: "local",
    baseUrl: "http://localhost:1234",
    baseUrlEnvVars: ["LMSTUDIO_BASE_URL"],
    apiPath: "/v1/chat/completions",
    // Optional: LM Studio supports API key auth when "Reachable on local
    // network" is enabled in its server settings. Empty by default; user
    // sets LMSTUDIO_API_KEY if their server requires it.
    apiKeyEnvVar: "LMSTUDIO_API_KEY",
    apiKeyDescription: "LM Studio API Key (optional — leave blank for localhost)",
    apiKeyUrl: "https://lmstudio.ai/docs/local-server",
    shortcuts: ["lms", "lmstudio", "mlstudio"],
    shortestPrefix: "lms",
    legacyPrefixes: [
      { prefix: "lmstudio/", stripPrefix: true },
      { prefix: "lmstudio:", stripPrefix: true },
      { prefix: "mlstudio/", stripPrefix: true },
      { prefix: "mlstudio:", stripPrefix: true },
    ],
    isLocal: true,
    // LM Studio serves an OpenAI-compatible list of the models it has loaded.
    // Previously unlisted, so the picker made users type a name from memory.
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    description: "Local LM Studio (lms@)",
  },

  // ── vLLM (local) ───────────────────────────────────────────────────
  {
    createHandler: noHandler(
      "local",
      "Built by the local-provider path; never reaches direct-api."
    ),
    tier: "native",
    name: "vllm",
    displayName: "vLLM",
    transport: "local",
    baseUrl: "http://localhost:8000",
    baseUrlEnvVars: ["VLLM_BASE_URL"],
    apiPath: "/v1/chat/completions",
    // Optional: vLLM accepts an API key when started with --api-key.
    apiKeyEnvVar: "VLLM_API_KEY",
    apiKeyDescription: "vLLM API Key (optional — set if --api-key is configured)",
    apiKeyUrl: "",
    shortcuts: ["vllm"],
    shortestPrefix: "vllm",
    legacyPrefixes: [
      { prefix: "vllm/", stripPrefix: true },
      { prefix: "vllm:", stripPrefix: true },
    ],
    isLocal: true,
    description: "Local vLLM (vllm@)",
  },

  // ── MLX (local) ────────────────────────────────────────────────────
  {
    createHandler: noHandler(
      "local",
      "Built by the local-provider path; never reaches direct-api."
    ),
    tier: "native",
    name: "mlx",
    displayName: "MLX",
    transport: "local",
    baseUrl: "http://localhost:8080",
    baseUrlEnvVars: ["MLX_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "MLX_API_KEY",
    apiKeyDescription: "MLX API Key (optional)",
    apiKeyUrl: "",
    shortcuts: ["mlx"],
    shortestPrefix: "mlx",
    legacyPrefixes: [
      { prefix: "mlx/", stripPrefix: true },
      { prefix: "mlx:", stripPrefix: true },
    ],
    isLocal: true,
    description: "Local MLX (mlx@)",
  },

  // ── DeepSeek (OpenAI-compatible direct API) ─────────────────────────
  {
    createHandler: openaiHandler,
    tier: "native",
    name: "deepseek",
    displayName: "DeepSeek",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.deepseek.com",
    baseUrlEnvVars: ["DEEPSEEK_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    apiKeyDescription: "DeepSeek API Key",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    shortcuts: ["ds"],
    shortestPrefix: "ds",
    legacyPrefixes: [{ prefix: "ds/", stripPrefix: true }],
    nativeModelPatterns: [{ pattern: /^deepseek\//i }, { pattern: /^deepseek-/i }],
    isDirectApi: true,
    description: "DeepSeek API (ds@)",
  },

  // ── Mistral (OpenAI-compatible direct API) ─────────────────────────
  // The catalog carries 13 mistralai-served models; 5 of them
  // (labs-leanstral-1-5, ministral-3-3b/3-8b-instruct, mistral-medium-3.5,
  // mistral-small-4.0-2603) are served by NO other provider claudish can
  // reach, so without this they are simply unroutable.
  //
  // NOTE on ids: Mistral's own wire ids are floating aliases
  // (`mistral-large-latest`, `ministral-8b-latest`) that silently move to a new
  // model on each release. The catalog carries them as `aggregators[].externalId`
  // against pinned catalog ids (`mistral-large-2512`), and the generic
  // externalId resolution translates one to the other — so a user typing the
  // pinned id still reaches the alias, and no per-provider code is needed here.
  {
    createHandler: openaiHandler,
    tier: "native",
    name: "mistralai",
    displayName: "Mistral",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.mistral.ai",
    baseUrlEnvVars: ["MISTRAL_BASE_URL"],
    apiPath: "/v1/chat/completions",
    // Without this, Test All had ONE candidate and no way past it. The catalog's
    // probe pick is `labs-leanstral-1-5`, and a Labs model answers `403 "… is a
    // Labs model. To use Labs models, an admin must enable them in your
    // organization settings"` for any account that has not enabled Labs
    // (measured 2026-09-19). The account's own list answers 200 with 53 models,
    // only 2 of them Labs, so endpoint discovery can walk to a model the account
    // can actually call.
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    apiKeyEnvVar: "MISTRAL_API_KEY",
    apiKeyDescription: "Mistral API Key",
    apiKeyUrl: "https://console.mistral.ai/api-keys",
    shortcuts: ["mistral"],
    shortestPrefix: "mistral",
    legacyPrefixes: [{ prefix: "mistral/", stripPrefix: true }],
    // `ministral-` and `codestral-` are distinct product lines, not prefixes of
    // `mistral-`, so each needs its own pattern. Anchored to avoid catching
    // unrelated ids that merely contain the substring.
    nativeModelPatterns: [
      { pattern: /^mistralai\//i },
      { pattern: /^mistral-/i },
      { pattern: /^ministral-/i },
      { pattern: /^codestral-/i },
    ],
    isDirectApi: true,
    description: "Direct Mistral API (mistral@)",
  },

  // ── Sakana Fugu (OpenAI-compatible direct API / token plan) ────────
  {
    createHandler: openaiHandler,
    tier: "native",
    name: "sakana",
    displayName: "Sakana Fugu",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.sakana.ai",
    baseUrlEnvVars: ["SAKANA_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "SAKANA_API_KEY",
    apiKeyDescription: "Sakana Fugu API Key",
    apiKeyUrl: "https://console.sakana.ai/get-started",
    shortcuts: ["sakana", "fugu"],
    shortestPrefix: "fugu",
    legacyPrefixes: [
      { prefix: "sakana/", stripPrefix: true },
      { prefix: "fugu/", stripPrefix: true },
    ],
    nativeModelPatterns: [{ pattern: /^fugu/i }, { pattern: /^sakana\//i }],
    isDirectApi: true,
    description: "Sakana Fugu API (sakana@, fugu@)",
  },

  // ── Sakana Fugu Subscription Plan ──────────────────────────────────
  // A general-purpose subscription (NOT coding-specific) — usable for any task.
  // Same endpoint as the API/token plan (api.sakana.ai — the only endpoint
  // Sakana exposes), but the BILLING MODE is fixed at KEY CREATION: the Sakana
  // console lets you mint a key as either a "subscription" key or an "API usage"
  // (pay-as-you-go) key. They are GENUINELY DIFFERENT keys — a PAYG key draws
  // from prepaid credits, a subscription key from the monthly plan allowance —
  // so this provider has its OWN env var (SAKANA_SUBSCRIPTION_API_KEY) with NO
  // alias back to SAKANA_API_KEY. Aliasing caused sc@ to fall back to the PAYG
  // key and bill prepaid credits ("Prepaid credit balance is exhausted") despite
  // an active subscription. (Sakana's public API reference shows only one
  // SAKANA_API_KEY because the wire is identical; the subscription-vs-API
  // distinction lives in the key, set at creation in the console.)
  {
    createHandler: openaiHandler,
    // Flat-rate, but `sakana/fugu-subscription` publishes no connection — it sits
    // in the probe map as `client_model_selection_required`, so what the plan
    // serves is settled by this key's own `/v1/models`, not by the catalog.
    tier: "dynamic-subscription",
    name: "sakana-subscription",
    displayName: "Sakana Fugu Subscription",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.sakana.ai",
    baseUrlEnvVars: ["SAKANA_BASE_URL"],
    apiPath: "/v1/chat/completions",
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    // Primary env var matches Sakana's own term ("subscription"). The old
    // SAKANA_CODING_API_KEY is kept only as a back-compat alias. NEITHER aliases
    // the API-usage SAKANA_API_KEY — that's the PAYG key and would bill prepaid
    // credits.
    apiKeyEnvVar: "SAKANA_SUBSCRIPTION_API_KEY",
    apiKeyAliases: ["SAKANA_CODING_API_KEY"],
    apiKeyDescription: "Sakana Fugu Subscription API Key",
    apiKeyUrl: "https://console.sakana.ai/get-started",
    shortcuts: ["sc"],
    shortestPrefix: "sc",
    legacyPrefixes: [{ prefix: "sc/", stripPrefix: true }],
    // THE NAMESPACE CLAIM. `sakana` above declares the same `/^fugu/i` (plus
    // `/^sakana\//i`, which `parseModelSpec` strips to a bare `fugu…` before
    // routing ever sees it) and is defined FIRST, so auto-detection is
    // unchanged. This claim is what lets `route-candidates.ts` emit a
    // subscription candidate at all: `sakana/fugu-subscription` is
    // `client_model_selection_required` in the probe map with ZERO
    // `aggregators[]` rows, and without it the 8 Fugu models a plan serves
    // (measured on generation g-20260921062451697-f490edba) would silently move
    // onto the metered `sakana` key — which draws PREPAID CREDITS, a different
    // wallet from the subscription, and has already billed a user once.
    //
    // `/^fugu/i` rather than `/^fugu-/i`: the bare id `fugu` is a real model, so
    // a hyphen-anchored rule would miss the family's own head.
    nativeModelPatterns: [{ pattern: /^fugu/i }],
    isDirectApi: true,
    description: "Sakana Fugu Subscription (sc@)",
  },

  // ── Alibaba Token Plan (must be before Qwen — /^qwen/i would swallow it) ──
  // Alibaba Token Plan: subscription credits on its own host and credential.
  {
    createHandler: anthropicCompatHandler,
    tier: "subscription",
    name: "qwen-token-plan",
    displayName: "Alibaba Token Plan",
    transport: "anthropic",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
    baseUrlEnvVars: ["QWEN_TOKEN_PLAN_BASE_URL"],
    apiPath: "/apps/anthropic/v1/messages",
    apiKeyEnvVar: "QWEN_TOKEN_PLAN_API_KEY",
    siblingKeyEnvVars: ["QWEN_CODING_PLAN_API_KEY", "DASHSCOPE_API_KEY"],
    apiKeyDescription: "Alibaba Model Studio Token Plan API Key (subscription credits)",
    apiKeyUrl: "https://docs.qwencloud.com/token-plan/overview",
    authScheme: "bearer",
    shortcuts: ["qtoken"],
    shortestPrefix: "qtoken",
    legacyPrefixes: [],
    nativeModelPatterns: [{ pattern: /^qwen3\.\d/i }],
    modelDiscovery: { path: "/compatible-mode/v1/models", format: "openai-models-list" },
    isDirectApi: true,
    description: "Alibaba Token Plan subscription (qtoken@)",
  },

  // Alibaba Coding Plan: request-based subscription on its own host and credential.
  {
    createHandler: anthropicCompatHandler,
    tier: "subscription",
    name: "qwen-coding",
    displayName: "Alibaba Coding Plan",
    transport: "anthropic",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com",
    baseUrlEnvVars: ["QWEN_CODING_PLAN_BASE_URL"],
    apiPath: "/apps/anthropic/v1/messages",
    apiKeyEnvVar: "QWEN_CODING_PLAN_API_KEY",
    siblingKeyEnvVars: ["QWEN_TOKEN_PLAN_API_KEY", "DASHSCOPE_API_KEY"],
    apiKeyDescription: "Alibaba Model Studio Coding Plan API Key (subscription requests)",
    apiKeyUrl: "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
    authScheme: "bearer",
    shortcuts: ["qcode"],
    shortestPrefix: "qcode",
    legacyPrefixes: [],
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    isDirectApi: true,
    description: "Alibaba Coding Plan subscription (qcode@)",
  },

  // Alibaba PAYG: token-metered access on its own host and credential.
  {
    createHandler: anthropicCompatHandler,
    tier: "native",
    name: "qwen-payg",
    displayName: "Alibaba PAYG",
    transport: "anthropic",
    baseUrl: "https://dashscope-intl.aliyuncs.com",
    baseUrlEnvVars: ["DASHSCOPE_BASE_URL"],
    apiPath: "/apps/anthropic/v1/messages",
    apiKeyEnvVar: "DASHSCOPE_API_KEY",
    siblingKeyEnvVars: ["QWEN_TOKEN_PLAN_API_KEY", "QWEN_CODING_PLAN_API_KEY"],
    apiKeyDescription: "Alibaba Model Studio PAYG API Key",
    apiKeyUrl: "https://www.alibabacloud.com/help/en/model-studio/get-api-key",
    authScheme: "bearer",
    shortcuts: ["qpay"],
    shortestPrefix: "qpay",
    legacyPrefixes: [],
    modelDiscovery: { path: "/compatible-mode/v1/models", format: "openai-models-list" },
    isDirectApi: true,
    description: "Alibaba Model Studio PAYG (qpay@)",
  },

  // ── Qwen (auto-routed, no direct API) ──────────────────────────────
  {
    // VIRTUAL, and it must say so: no baseUrl, no apiPath, no apiKeyEnvVar.
    // The entry exists so a bare `qwen*` name has a provider to be steered
    // FROM; `qwen-payg` is what actually calls dashscope.
    //
    // It used to carry `openaiHandler` and a comment arguing it was unreachable
    // anyway, because `providerForCatalogRoute` returned only the FIRST provider
    // bound to `qwen/dashscope-direct` and `qwen-payg` is the earlier key. v10.0.0
    // made the gatherer take ALL of them (now `routingProvidersForRoute`) — the
    // z-ai/glm key-silo fix — and deleted the premise. This became a gathered
    // candidate, so `--probe qwen3.8-max` printed a `Qwen ✗ key missing` hop and
    // sent the reader looking for a key that no environment variable can hold.
    // `route()` never yielded it (the credential filter drops it), so the damage
    // was confined to the display; `reason: "virtual"` is what keeps it that way.
    createHandler: noHandler(
      "virtual",
      "No baseUrl. Exists only so nativeModelPatterns can steer a bare qwen* name; qwen-payg serves dashscope."
    ),
    // The vendor's own namespace, so `native`.
    tier: "native",
    name: "qwen",
    displayName: "Qwen",
    transport: "openai",
    baseUrl: "",
    apiPath: "",
    apiKeyEnvVar: "",
    apiKeyDescription: "Qwen (auto-routed via OpenRouter)",
    apiKeyUrl: "",
    shortcuts: [],
    shortestPrefix: "qwen",
    legacyPrefixes: [],
    nativeModelPatterns: [{ pattern: /^qwen/i }],
    description: "Qwen (auto-routed via OpenRouter)",
  },

  // ── Native Anthropic (Claude Code auth) ────────────────────────────
  {
    createHandler: noHandler(
      "virtual",
      "No baseUrl. Exists only so nativeModelPatterns can steer a bare claude-* name to the native path."
    ),
    // The route IS the Claude Code subscription — the catalog's
    // `anthropic/claude-code-subscription` profile — so `subscription` is the
    // only honest tier for it. Two things it does NOT mean, both of which this
    // project has been bitten by: it is not a billing statement (an explicit
    // ANTHROPIC_API_KEY reaches this same name and is metered, which is why
    // deriving `SUBSCRIPTION_PROVIDERS` from tier must exclude it alongside
    // `openai-codex`), and it is not a claim that this provider is routable —
    // `nativeRouteFor()` must intercept a bare Claude name BEFORE `route()`,
    // because there is no credential store here for the credential filter to
    // consult and the chain would degrade to OpenRouter.
    tier: "subscription",
    name: "native-anthropic",
    displayName: "Anthropic (Native)",
    transport: "anthropic",
    baseUrl: "",
    apiPath: "",
    apiKeyEnvVar: "",
    apiKeyDescription: "Anthropic (Native Claude Code auth)",
    apiKeyUrl: "",
    shortcuts: [],
    shortestPrefix: "",
    legacyPrefixes: [],
    nativeModelPatterns: [{ pattern: /^anthropic\//i }, { pattern: /^claude-/i }],
    description: "Native Claude Code auth",
  },
];

// ---------------------------------------------------------------------------
// Lazy-cached derived accessors
// ---------------------------------------------------------------------------

let _shortcutsCache: Record<string, string> | null = null;
let _legacyPrefixCache: Array<{
  prefix: string;
  provider: string;
  stripPrefix: boolean;
}> | null = null;
let _nativeModelPatternsCache: Array<{ pattern: RegExp; provider: string }> | null = null;
let _providerByNameCache: Map<string, ProviderDefinition> | null = null;
let _directApiProvidersCache: Set<string> | null = null;
let _localProvidersCache: Set<string> | null = null;

function ensureProviderByNameCache(): Map<string, ProviderDefinition> {
  if (!_providerByNameCache) {
    _providerByNameCache = new Map();
    for (const def of BUILTIN_PROVIDERS) {
      _providerByNameCache.set(def.name, def);
    }
  }
  return _providerByNameCache;
}

/**
 * Get the shortcuts → canonical provider name mapping.
 * Replaces PROVIDER_SHORTCUTS in model-parser.ts.
 *
 * Builtin shortcuts are cached on first access. Runtime providers merge their
 * shortcuts fresh each call (the registry is small and startup-only, so the
 * extra allocation is negligible and avoids cache-invalidation complexity).
 */
export function getShortcuts(): Record<string, string> {
  if (!_shortcutsCache) {
    _shortcutsCache = {};
    for (const def of BUILTIN_PROVIDERS) {
      for (const shortcut of def.shortcuts) {
        _shortcutsCache[shortcut] = def.name;
      }
    }
  }
  const runtime = getRuntimeProviders();
  if (runtime.size === 0) return _shortcutsCache;
  const merged: Record<string, string> = { ..._shortcutsCache };
  for (const def of runtime.values()) {
    for (const shortcut of def.shortcuts) {
      merged[shortcut] = def.name;
    }
  }
  return merged;
}

/**
 * Get legacy prefix patterns for backwards compatibility.
 * Replaces LEGACY_PREFIX_PATTERNS in model-parser.ts.
 */
export function getLegacyPrefixPatterns(): Array<{
  prefix: string;
  provider: string;
  stripPrefix: boolean;
}> {
  if (!_legacyPrefixCache) {
    _legacyPrefixCache = [];
    for (const def of BUILTIN_PROVIDERS) {
      for (const lp of def.legacyPrefixes) {
        _legacyPrefixCache.push({
          prefix: lp.prefix,
          provider: def.name,
          stripPrefix: lp.stripPrefix,
        });
      }
    }
  }
  return _legacyPrefixCache;
}

/**
 * Get native model patterns for auto-detection.
 * Replaces NATIVE_MODEL_PATTERNS in model-parser.ts.
 *
 * Order follows the definition order in BUILTIN_PROVIDERS.
 * kimi-coding's pattern (kimi-for-coding$) comes before kimi's (kimi-*) because
 * kimi-coding is defined earlier in BUILTIN_PROVIDERS.
 */
export function getNativeModelPatterns(): Array<{ pattern: RegExp; provider: string }> {
  if (!_nativeModelPatternsCache) {
    _nativeModelPatternsCache = [];
    for (const def of BUILTIN_PROVIDERS) {
      if (def.nativeModelPatterns) {
        for (const np of def.nativeModelPatterns) {
          _nativeModelPatternsCache.push({
            pattern: np.pattern,
            provider: def.name,
          });
        }
      }
    }
  }
  return _nativeModelPatternsCache;
}

/**
 * Get a provider definition by canonical name.
 * Consults the builtin cache first, then the runtime registry for custom
 * endpoints registered at startup via `custom-endpoints-loader.ts`.
 */
export function getProviderByName(name: string): ProviderDefinition | undefined {
  const builtin = ensureProviderByNameCache().get(name);
  if (builtin) return builtin;
  return getRuntimeProviders().get(name);
}

/**
 * Get API key info for a provider.
 * Replaces API_KEY_INFO in provider-resolver.ts.
 */
export function getApiKeyInfo(providerName: string): {
  envVar: string;
  description: string;
  url: string;
  aliases?: string[];
  oauthFallback?: string;
} | null {
  const def = getProviderByName(providerName);
  if (!def) return null;
  return {
    envVar: def.apiKeyEnvVar,
    description: def.apiKeyDescription,
    url: def.apiKeyUrl,
    aliases: def.apiKeyAliases,
    oauthFallback: def.oauthFallback,
  };
}

/**
 * The one-sentence remedy for "this provider produced no handler".
 *
 * Derived entirely from the provider DEFINITION — runtime-aware, so a bundled
 * or user-declared endpoint gets the same treatment as a builtin — rather than
 * from the hand-maintained builtin-only `API_KEY_MAP`, which is the second-table
 * coupling that produces silent mis-routes elsewhere in this codebase.
 *
 * Three shapes, because "no credential" has three different causes and naming
 * the wrong one sends the user somewhere expensive:
 *
 * 1. **A LOCAL provider** (`ollama`, `lmstudio`, `vllm`, `mlx`) is not gated on
 *    a key at all. `LocalCredentialProvider.isAvailable()` is literally
 *    `isLocalProviderEnabled(name)` — i.e. `config.localProviders` contains the
 *    name — and its optional bearer token can never block a handler
 *    (`getRequestAuth` returns empty headers when there is none). So the actual
 *    cause is "not enabled in config", and leading with "Set OLLAMA_API_KEY"
 *    names a variable the user almost certainly should not set. The key clause
 *    survives, in parentheses, for the gateway case that really does want one.
 *
 * 2. **A provider with an `oauthFallback`** is DUAL-MODE: `openai-codex` is a
 *    ChatGPT Plus/Pro subscription OR a metered `OPENAI_API_KEY`, `kimi-coding`
 *    a Kimi membership OR a key. Telling a subscriber to go and buy metered API
 *    access is the more expensive of the two asymmetric errors — the same
 *    reasoning that keeps `openai-codex` out of `SUBSCRIPTION_PROVIDERS` — so
 *    the sign-in path is named FIRST and the key path second. The provider NAME
 *    is a valid `claudish login` argument (`auth-commands.ts` `findProvider`
 *    matches on `registryKeys`, which carry the canonical names), so no second
 *    name table is introduced here.
 *
 * 3. Everything else keeps today's text exactly.
 *
 * Orthogonal to all three: a provider declaring `siblingKeyEnvVars` gains one
 * trailing clause naming the same vendor's OTHER key. See that field.
 */
export function describeMissingCredential(providerName: string): string {
  const info = getApiKeyInfo(providerName);
  const keyNames = info?.envVar ? [info.envVar, ...(info.aliases ?? [])].join(" or ") : undefined;
  const signup = info?.url ? ` Get one at ${info.url}.` : "";
  const def = getProviderByName(providerName);
  const sibling = describeSiblingKeys(def);

  if (providerName === "vertex") {
    return (
      `No Google Cloud project for provider "vertex". ${VERTEX_SET_PROJECT_REMEDY}. ` +
      "Application Default Credentials already handles the credential; Vertex takes no API key."
    );
  }

  if (isLocalTransport(providerName)) {
    const where = def ? ` Claudish will use ${getEffectiveBaseUrl(def)}.` : "";
    const keyClause = keyNames
      ? ` (Only set ${keyNames} if your local server requires a bearer token.)`
      : "";
    return (
      `Provider "${providerName}" is a LOCAL server and is not enabled. ` +
      "Enable it in `claudish config` (Providers tab), or add " +
      `"localProviders": ["${providerName}"] to ~/.claudish/config.json.${where}${keyClause}${sibling}`
    );
  }

  if (def?.oauthFallback) {
    const keyClause = keyNames
      ? ` Or set ${keyNames} (env, config, or 1Password import) to use a metered API key instead.${signup}`
      : "";
    return (
      `No credential for provider "${providerName}". Sign in with ` +
      `\`claudish login ${providerName}\` to use your existing subscription.${keyClause}${sibling}`
    );
  }

  return keyNames
    ? `No API key for provider "${providerName}". Set ${keyNames} (env, config, or 1Password import).${signup}${sibling}`
    : `No API key for provider "${providerName}".${sibling}`;
}

/**
 * The trailing clause for a provider that declares `siblingKeyEnvVars`.
 *
 * Empty string for everyone else, so the three sentences above are unchanged for
 * every provider that declares none.
 *
 * The OWNER of each sibling variable is looked up live from the catalog rather
 * than written into the definition beside it. A second spelling of "which
 * provider does OPENCODE_API_KEY belong to" is exactly the two-table coupling
 * that produced the mis-routes this file's other comments record, and the answer
 * is already in the catalog as `apiKeyEnvVar`. A variable no provider claims
 * (a rename, a removal) degrades to the bare name instead of asserting a
 * provider that no longer exists.
 *
 * Exported because the SECOND place a user meets this fact is a 401 — they set
 * the sibling key, and the vendor's other host rejected it with wording that
 * attributes nothing (`invalid access token or token expired`). The recovery
 * hint in `composed-handler.ts` appends this same sentence there, rather than
 * writing a second one, so the "no key" copy and the "wrong key" copy can never
 * disagree about which variable belongs to which plan.
 */
export function describeSiblingKeys(def: ProviderDefinition | undefined): string {
  const vars = def?.siblingKeyEnvVars ?? [];
  if (vars.length === 0) return "";
  const all = getAllProviders();
  const named = vars.map((v) => {
    const owner = all.find((p) => p.name !== def?.name && p.apiKeyEnvVar === v);
    return owner ? `${v} (${owner.name})` : v;
  });
  return ` Note: ${named.join(" or ")} is a DIFFERENT plan's key and is not accepted here.`;
}

/**
 * Get display name for a provider.
 * Replaces PROVIDER_DISPLAY_NAMES in provider-resolver.ts.
 */
export function getDisplayName(providerName: string): string {
  const def = getProviderByName(providerName);
  return def?.displayName || providerName.charAt(0).toUpperCase() + providerName.slice(1);
}

/** Where a base-URL override came from, so a caller can phrase the remedy. */
export interface BaseUrlOverrideCandidate {
  /** The variable / `config.endpoints` key that supplied it. */
  envVar: string;
  /** The raw value, exactly as stored. Not validated and not trimmed. */
  value: string;
  source: "config" | "env";
}

/**
 * Every base-URL override that is present, in precedence order.
 *
 * THE one oracle for "where does this provider actually point". It exists
 * because there were briefly two: `getEffectiveBaseUrl` walked
 * `config.endpoints` → env → default, while the custom-endpoint classifier
 * walked env only. The config TUI's URL editor writes BOTH `setEndpoint()` and
 * `process.env`, so the second oracle looked correct for the rest of the
 * session and diverged only after a restart — at which point the TUI still
 * DISPLAYED the saved private URL while requests went to the bundled public
 * host. UI says private, wire says public, which is the data-egress failure the
 * R12 skip-not-fallback rule exists to prevent, inverted.
 *
 * Returned as a LIST rather than a single winner because the two callers apply
 * different policy to it: `getEffectiveBaseUrl` takes the first and is done,
 * while `classifyEndpointBaseUrl` must skip an unexpanded `${VAR}` placeholder
 * (which means "unset", not "wrong") and continue to the next candidate. A
 * single-winner API would force the placeholder rule to live in one of them
 * only — i.e. two oracles again.
 *
 * Precedence, unchanged: config.endpoints[VAR] for every var in order, then
 * process.env[VAR] for every var in order. So `config.endpoints.OLLAMA_HOST`
 * beats `process.env.LMSTUDIO_BASE_URL` — config wins as a TIER, matching the
 * `apiKeys` rule, not per-variable.
 */
export function baseUrlOverrideCandidates(
  baseUrlEnvVars?: readonly string[]
): BaseUrlOverrideCandidate[] {
  const found: BaseUrlOverrideCandidate[] = [];
  if (!baseUrlEnvVars || baseUrlEnvVars.length === 0) return found;
  // Config wins over env (matches the apiKeys precedence rule).
  for (const envVar of baseUrlEnvVars) {
    const fromConfig = getConfigEndpoint(envVar);
    if (fromConfig) found.push({ envVar, value: fromConfig, source: "config" });
  }
  for (const envVar of baseUrlEnvVars) {
    const value = process.env[envVar];
    if (value) found.push({ envVar, value, source: "env" });
  }
  return found;
}

/**
 * Get the effective base URL for a provider.
 *
 * Resolution precedence (highest to lowest):
 *   1. config.endpoints[envVar] from ~/.claudish/config.json — primary,
 *      TUI-editable, scoped to the user's profile.
 *   2. process.env[envVar] — fallback for CI/scripted environments.
 *   3. def.baseUrl — static default (e.g. http://localhost:1234).
 *
 * Each candidate env var name in `baseUrlEnvVars` is consulted in order
 * for both config and env steps, so an explicit `LMSTUDIO_BASE_URL` setting
 * wins over a generic `OLLAMA_HOST`.
 */
export function getEffectiveBaseUrl(def: ProviderDefinition): string {
  return baseUrlOverrideCandidates(def.baseUrlEnvVars)[0]?.value ?? def.baseUrl;
}

/**
 * Check if a provider name is a local provider (no API key needed).
 * Replaces LOCAL_PROVIDERS set in model-parser.ts.
 */
export function isLocalTransport(providerName: string): boolean {
  if (!_localProvidersCache) {
    _localProvidersCache = new Set();
    for (const def of BUILTIN_PROVIDERS) {
      if (def.isLocal) {
        _localProvidersCache.add(def.name);
      }
    }
  }
  const lower = providerName.toLowerCase();
  if (_localProvidersCache.has(lower)) return true;
  // Runtime fallback — custom endpoints may declare isLocal
  const runtimeDef = getRuntimeProviders().get(providerName);
  return !!runtimeDef?.isLocal;
}

/**
 * Check if a provider supports direct API access.
 * Replaces DIRECT_API_PROVIDERS set in model-parser.ts.
 */
export function isDirectApiProvider(providerName: string): boolean {
  if (!_directApiProvidersCache) {
    _directApiProvidersCache = new Set();
    for (const def of BUILTIN_PROVIDERS) {
      if (def.isDirectApi) {
        _directApiProvidersCache.add(def.name);
      }
    }
  }
  const lower = providerName.toLowerCase();
  if (_directApiProvidersCache.has(lower)) return true;
  // Runtime fallback — custom endpoints are direct API by default
  const runtimeDef = getRuntimeProviders().get(providerName);
  return !!runtimeDef?.isDirectApi;
}

/**
 * Convert a ProviderDefinition to the RemoteProvider shape used by existing consumers.
 */
export function toRemoteProvider(def: ProviderDefinition): RemoteProvider {
  const baseUrl = getEffectiveBaseUrl(def);

  // Handle opencode-zen-go special case: transform base URL
  let effectiveBaseUrl = baseUrl;
  if (def.name === "opencode-zen-go" && def.baseUrlEnvVars) {
    const envOverride = process.env[def.baseUrlEnvVars[0]];
    if (envOverride) {
      effectiveBaseUrl = envOverride.replace("/zen", "/zen/go");
    }
  }

  return {
    name: def.name === "google" ? "gemini" : def.name,
    baseUrl: effectiveBaseUrl,
    apiPath: def.apiPath,
    apiKeyEnvVar: def.apiKeyEnvVar,
    prefixes: def.legacyPrefixes.map((lp) => lp.prefix),
    headers: def.headers,
    authScheme: def.authScheme,
    cacheControlPlacement: def.cacheControlPlacement,
  };
}

/**
 * Get all provider definitions (builtin + runtime-registered).
 *
 * Fast path: when no runtime providers are registered, returns BUILTIN_PROVIDERS
 * directly (no allocation). Once any custom endpoint is loaded, returns a fresh
 * array that concatenates builtin and runtime definitions.
 */
export function getAllProviders(): ProviderDefinition[] {
  const runtime = getRuntimeProviders();
  if (runtime.size === 0) return BUILTIN_PROVIDERS;
  return [...BUILTIN_PROVIDERS, ...runtime.values()];
}

/**
 * Get the shortest prefix for a provider (for @ syntax handler creation).
 * Replaces PROVIDER_TO_PREFIX in auto-route.ts.
 */
export function getShortestPrefix(providerName: string): string {
  const def = getProviderByName(providerName);
  return def?.shortestPrefix || providerName;
}

/**
 * Get API key env var info for a provider (for auto-route).
 * Replaces API_KEY_ENV_VARS in auto-route.ts.
 */
export function getApiKeyEnvVars(
  providerName: string
): { envVar: string; aliases?: string[] } | null {
  const def = getProviderByName(providerName);
  if (!def) return null;
  return {
    envVar: def.apiKeyEnvVar,
    aliases: def.apiKeyAliases,
  };
}

// NOTE: the sync readiness oracles isProviderAvailable / isProviderAvailableByName
// were DELETED in the async-credential-layer refactor. Provider readiness is now
// resolved on demand through the credential authority (auth/credentials/authority.ts
// → isAvailable), the single source of truth that also pulls from 1Password. The
// model selector calls credentials.isAvailable() directly.
