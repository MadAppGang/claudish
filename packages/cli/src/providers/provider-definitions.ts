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

import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
import { getEndpoint as getConfigEndpoint } from "../profile-config.js";
// Type-only import — erased at compile time, so no runtime import cycle with
// model-discovery.ts (which imports getProviderByName from here).
import type { ModelDiscoveryDescriptor } from "./model-discovery.js";
import { getRuntimeProviders } from "./runtime-providers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportType =
  | "openai"
  | "anthropic"
  | "gemini"
  | "gemini-oauth"
  | "antigravity"
  | "devin"
  | "openrouter"
  | "ollamacloud"
  | "kimi-coding"
  | "litellm"
  | "vertex"
  | "local"
  | "ollama"
  | "poe";

export type TokenStrategy = "delta-aware" | "accumulate-both" | undefined;

export interface ProviderCapabilities {
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  supportsJsonMode?: boolean;
  supportsReasoning?: boolean;
}

export interface ProviderDefinition {
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
  /** API path template (e.g., "/v1/chat/completions") */
  apiPath: string;
  /** Primary API key environment variable */
  apiKeyEnvVar: string;
  /** Alternative env vars to check */
  apiKeyAliases?: string[];
  /** Human-readable API key description */
  apiKeyDescription: string;
  /** URL where user can obtain an API key */
  apiKeyUrl: string;
  /** Auth scheme for the API key header */
  authScheme?: "x-api-key" | "bearer";
  /** Provider shortcuts (e.g., ["g", "gemini"] → "google") */
  shortcuts: string[];
  /** Legacy prefix patterns for backwards compat (e.g., ["g/", "gemini/"]) */
  legacyPrefixes: Array<{ prefix: string; stripPrefix: boolean }>;
  /** Native model patterns for auto-detection (when no provider prefix) */
  nativeModelPatterns?: Array<{ pattern: RegExp }>;
  /**
   * Opt in to live, per-subscription model discovery. When set, claudish calls
   * the provider's own authenticated model-listing endpoint to learn the real
   * roster and per-model context windows for THIS user's plan, instead of
   * trusting a static list. Required for subscription endpoints whose context
   * window varies by tier (see providers/model-discovery.ts).
   */
  modelDiscovery?: ModelDiscoveryDescriptor;
  /** Provider capabilities */
  capabilities?: ProviderCapabilities;
  /** Custom HTTP headers to include with requests */
  headers?: Record<string, string>;
  /** Fallback API key value for auth-less access (e.g., "public" for free tiers) */
  publicKeyFallback?: string;
  /** OAuth credential file under ~/.claudish/ to check as fallback */
  oauthFallback?: string;
  /**
   * Slug for `claudish login {slug}` if this provider supports OAuth.
   * Multiple catalog entries can share a slug — e.g. `google` and
   * `gemini-codeassist` both map to `"gemini"` because one OAuth flow
   * covers the whole family.
   * Single source of truth: keep this in sync with AUTH_PROVIDERS in
   * src/auth/auth-commands.ts.
   */
  oauthLoginSlug?: "gemini" | "codex" | "kimi" | "antigravity";
  /** Whether this is a local provider (no API key needed) */
  isLocal?: boolean;
  /** Whether this provider supports direct API access (not just via OpenRouter) */
  isDirectApi?: boolean;
  /** Shortest @ prefix for handler creation (reverse of shortcuts) */
  shortestPrefix?: string;
  /** Short description for TUI display (e.g., "580+ models, default backend") */
  description?: string;
}

// ---------------------------------------------------------------------------
// Built-in provider definitions
// ---------------------------------------------------------------------------

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  // ── Google Gemini (direct API) ─────────────────────────────────────
  {
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
    // No oauthLoginSlug: the bare Gemini direct API takes GEMINI_API_KEY.
    // OAuth login (`claudish login gemini`) targets the gemini-codeassist
    // subscription endpoint below, not this one.
  },

  // ── Antigravity (shared OAuth token — subscription) ────────────────
  // The individuals/Ultra subscription flow. Auth = the SHARED Antigravity
  // token (the `agy` keychain item), NOT a GEMINI_API_KEY. `go@` is retained as
  // a DEPRECATED alias that routes here (see model-parser.ts).
  {
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
    // "go" is the DEPRECATED alias — kept last so ag@ is the canonical prefix.
    shortcuts: ["ag", "antigravity", "go"],
    shortestPrefix: "ag",
    legacyPrefixes: [
      { prefix: "ag/", stripPrefix: true },
      { prefix: "antigravity/", stripPrefix: true },
      { prefix: "go/", stripPrefix: true },
    ],
    isDirectApi: true,
    description: "Antigravity subscription (ag@; go@ deprecated)",
  },

  // ── Devin (Cognition/Codeium subscription) ─────────────────────────
  // Auth is the Devin CLI's own session token, read verbatim from
  // ~/.local/share/devin/credentials.toml (or WINDSURF_API_KEY). One flat
  // subscription serving several vendors' models over a Connect-protobuf rpc.
  {
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
    // NO nativeModelPatterns, and no DEFAULT_ROUTING_RULES entry either. Devin's
    // uids collide head-on with other providers' namespaces —
    // `claude-opus-5-medium` matches native-anthropic's /^claude-/i,
    // `gpt-5-6-luna-medium` matches OpenAI's, `glm-5-2` matches GLM's,
    // `kimi-k3-high` matches Kimi's — so a bare name must never auto-detect as
    // Devin, and Devin must never be prepended to those chains. Same reasoning
    // as Qwen Plan, which also serves other vendors' models: access to the plan
    // stays EXPLICIT (`dv@claude-opus-5`). Users who want otherwise can add a
    // rule in ~/.claudish/config.json.
    modelDiscovery: { path: "", format: "devin-connect" },
    isDirectApi: true,
    description: "Devin subscription (dv@, devin@)",
  },

  // ── Gemini Code Assist (OAuth) ─────────────────────────────────────
  // The legacy gemini-cli OAuth subscription target. Still reachable via the
  // `gemini-*` default routing chain; no longer owns a user-facing `@` prefix
  // (the `go@` alias now routes to the Antigravity provider above).
  {
    name: "gemini-codeassist",
    displayName: "Gemini Code Assist",
    transport: "gemini-oauth",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    apiPath: "/v1internal:streamGenerateContent?alt=sse",
    apiKeyEnvVar: "",
    apiKeyDescription: "Gemini Code Assist (OAuth)",
    apiKeyUrl: "https://cloud.google.com/code-assist",
    oauthLoginSlug: "gemini",
    shortcuts: [],
    shortestPrefix: "gemini-codeassist",
    legacyPrefixes: [],
    isDirectApi: true,
    description: "Gemini Code Assist OAuth (routing fallback for gemini-*)",
  },

  // ── OpenAI (direct API) ────────────────────────────────────────────
  {
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

  // ── MiniMax (Anthropic-compatible) ─────────────────────────────────
  {
    name: "minimax",
    displayName: "MiniMax",
    transport: "anthropic",
    baseUrl: "https://api.minimax.io",
    baseUrlEnvVars: ["MINIMAX_BASE_URL"],
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "MINIMAX_API_KEY",
    apiKeyDescription: "MiniMax API Key",
    apiKeyUrl: "https://www.minimaxi.com/",
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
    name: "minimax-coding",
    displayName: "MiniMax Coding",
    transport: "anthropic",
    baseUrl: "https://api.minimax.io",
    baseUrlEnvVars: ["MINIMAX_CODING_BASE_URL"],
    apiPath: "/anthropic/v1/messages",
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
    name: "kimi",
    displayName: "Kimi",
    transport: "anthropic",
    baseUrl: "https://api.moonshot.ai",
    baseUrlEnvVars: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
    apiPath: "/anthropic/v1/messages",
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
    name: "glm",
    displayName: "GLM",
    transport: "openai",
    tokenStrategy: "delta-aware",
    // api.z.ai is the international mirror — same models, same auth,
    // dramatically better reachability from outside CN than open.bigmodel.cn.
    baseUrl: "https://api.z.ai",
    baseUrlEnvVars: ["ZHIPU_BASE_URL", "GLM_BASE_URL"],
    apiPath: "/api/paas/v4/chat/completions",
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
    name: "glm-coding",
    displayName: "GLM Coding",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.z.ai",
    apiPath: "/api/coding/paas/v4/chat/completions",
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

  // ── OpenCode Zen (free anonymous + paid) ───────────────────────────
  {
    name: "opencode-zen",
    displayName: "OpenCode Zen",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://opencode.ai/zen",
    baseUrlEnvVars: ["OPENCODE_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    apiKeyDescription: "OpenCode Zen (Free)",
    apiKeyUrl: "https://opencode.ai/",
    publicKeyFallback: "public",
    shortcuts: ["zen"],
    shortestPrefix: "zen",
    legacyPrefixes: [{ prefix: "zen/", stripPrefix: true }],
    isDirectApi: true,
    description: "OpenCode Zen (zen@) - free models",
  },

  // ── OpenCode Zen Go (lite plan) ────────────────────────────────────
  {
    name: "opencode-zen-go",
    displayName: "OpenCode Zen Go",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://opencode.ai/zen/go",
    baseUrlEnvVars: ["OPENCODE_GO_BASE_URL"],
    apiPath: "/v1/chat/completions",
    // Zen Go is a separate paid tier from the free Zen plan — keys for one
    // tier are not accepted by the other (401). Old single OPENCODE_API_KEY
    // kept as an alias for backward compat, but new users should set
    // OPENCODE_GO_API_KEY explicitly to avoid confusion.
    apiKeyEnvVar: "OPENCODE_GO_API_KEY",
    apiKeyAliases: ["OPENCODE_API_KEY"],
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
    name: "vertex",
    displayName: "Vertex AI",
    transport: "vertex",
    baseUrl: "",
    apiPath: "",
    apiKeyEnvVar: "VERTEX_PROJECT",
    apiKeyAliases: ["VERTEX_API_KEY"],
    apiKeyDescription: "Vertex AI API Key",
    apiKeyUrl: "https://console.cloud.google.com/vertex-ai",
    shortcuts: ["v", "vertex"],
    shortestPrefix: "v",
    legacyPrefixes: [
      { prefix: "v/", stripPrefix: true },
      { prefix: "vertex/", stripPrefix: true },
    ],
    isDirectApi: true,
    description: "Vertex AI Express (v@, vertex@)",
  },

  // ── LiteLLM ────────────────────────────────────────────────────────
  {
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
    name: "poe",
    displayName: "Poe",
    transport: "poe",
    baseUrl: "https://api.poe.com",
    apiPath: "/v1/chat/completions",
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
  {
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
    description: "Local Ollama (ollama@)",
  },

  // ── LM Studio (local) ──────────────────────────────────────────────
  {
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
    description: "Local LM Studio (lms@)",
  },

  // ── vLLM (local) ───────────────────────────────────────────────────
  {
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

  // ── Sakana Fugu (OpenAI-compatible direct API / token plan) ────────
  {
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
    name: "sakana-subscription",
    displayName: "Sakana Fugu Subscription",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.sakana.ai",
    baseUrlEnvVars: ["SAKANA_BASE_URL"],
    apiPath: "/v1/chat/completions",
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
    isDirectApi: true,
    description: "Sakana Fugu Subscription (sc@)",
  },

  // ── Qwen Plan (must be before Qwen — /^qwen/i would swallow it) ──
  // Alibaba Cloud Model Studio's subscription ("Qwen Plan"), served over
  // a NATIVE Anthropic-compatible endpoint (it exists so Claude Code can point
  // at it directly), so responses arrive as real Anthropic SSE — `thinking`
  // blocks included — and ride the anthropic-sse passthrough parser.
  //
  // baseUrl is the BARE HOST with `/apps/anthropic` folded into apiPath, the
  // same shape as minimax-coding. That's deliberate: modelDiscovery's path is
  // `/compatible-mode/v1/models`, which is a SIBLING of `/apps/anthropic`, not
  // a child. Folding the prefix into apiPath keeps both on one origin so a
  // single baseUrl override (QWEN_CLOUD_PLAN_BASE_URL) redirects messages AND
  // discovery together.
  //
  // NO apiKeyAliases, and specifically none onto DASHSCOPE_API_KEY /
  // QWEN_API_KEY. Like the sakana-subscription precedent, the BILLING MODE is
  // fixed when the key is minted: a plan key authenticates ONLY against
  // token-plan.ap-southeast-1.maas.aliyuncs.com. Probed live 2026-08-02, the
  // sibling Alibaba hosts reject it outright — coding-intl.dashscope.aliyuncs.com
  // → 401 invalid_api_key; dashscope.aliyuncs.com (Beijing) and
  // dashscope-intl.aliyuncs.com → 403 invalid api-key. An alias could only ever
  // send the wrong key to the wrong host, or bill the wrong plan.
  //
  // The ROSTER is discovered, never listed. Alibaba's docs claim this host has
  // no model-list endpoint and then name the wrong models: the docs say
  // qwen3.6-plus/qwen3.6-flash, but qwen3.6-plus answers 403 "Access to model
  // denied" while qwen3.7-plus answers 200. `/compatible-mode/v1/models` does
  // exist (OpenAI-shaped list) and is authenticated, so it reports what THIS
  // subscription is entitled to — including the non-Qwen models the plan also
  // carries (glm-5.2, deepseek-v4-*). Ask the endpoint; hardcode nothing.
  //
  // nativeModelPatterns is NAMESPACE ownership only, not a pinned roster.
  // Alibaba Model Studio names releases with DOTTED versions (qwen3.7-plus,
  // qwen3.8-max-preview) whereas OpenRouter/HuggingFace use hyphenated ones
  // (qwen3-coder-next). `/^qwen3\.\d/i` is therefore a structural discriminator
  // between the two naming worlds, and it keeps working as new dotted versions
  // ship. This entry MUST stay above `qwen` below, whose `/^qwen/i` matches
  // first-wins on array order and would otherwise claim these names.
  {
    name: "qwen-cloud",
    displayName: "Qwen Plan",
    transport: "anthropic",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
    baseUrlEnvVars: ["QWEN_CLOUD_PLAN_BASE_URL"],
    apiPath: "/apps/anthropic/v1/messages",
    // The DISPLAY name is "Qwen Plan", but the env var deliberately keeps the
    // longer QWEN_CLOUD_PLAN_ prefix (same for QWEN_CLOUD_PLAN_BASE_URL) for
    // back-compat with existing setups — do NOT rename it to match the label.
    apiKeyEnvVar: "QWEN_CLOUD_PLAN_API_KEY",
    apiKeyDescription: "Qwen Plan API Key",
    apiKeyUrl: "https://www.alibabacloud.com/help/en/model-studio/claude-code",
    authScheme: "bearer",
    shortcuts: ["qc"],
    shortestPrefix: "qc",
    legacyPrefixes: [{ prefix: "qc/", stripPrefix: true }],
    nativeModelPatterns: [{ pattern: /^qwen3\.\d/i }],
    modelDiscovery: { path: "/compatible-mode/v1/models", format: "openai-models-list" },
    isDirectApi: true,
    description: "Qwen Plan (qc@)",
  },

  // ── Qwen (auto-routed, no direct API) ──────────────────────────────
  {
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
 * Get display name for a provider.
 * Replaces PROVIDER_DISPLAY_NAMES in provider-resolver.ts.
 */
export function getDisplayName(providerName: string): string {
  const def = getProviderByName(providerName);
  return def?.displayName || providerName.charAt(0).toUpperCase() + providerName.slice(1);
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
  if (def.baseUrlEnvVars) {
    // Config wins over env (matches the apiKeys precedence rule).
    for (const envVar of def.baseUrlEnvVars) {
      const fromConfig = getConfigEndpoint(envVar);
      if (fromConfig) return fromConfig;
    }
    for (const envVar of def.baseUrlEnvVars) {
      const value = process.env[envVar];
      if (value) return value;
    }
  }
  return def.baseUrl;
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
