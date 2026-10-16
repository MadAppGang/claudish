/**
 * Model Parser - Unified syntax for provider@model:concurrency
 *
 * New syntax: provider@model[:concurrency]
 * Examples:
 *   openrouter@<vendor>/<model>  - Explicit OpenRouter
 *   google@<model>               - Direct Google API
 *   g@<model>                    - Direct Google API (shortcut)
 *   ollama@<model>:3             - Ollama with concurrency 3
 *   ollama@<model>:0             - Ollama with no limits
 *   oc/<model>                   - Legacy prefix syntax (explicit, deprecated)
 *
 * Provider shortcuts (case-insensitive) are each definition's `shortcuts` in
 * BUILTIN_PROVIDERS ({@link PROVIDER_SHORTCUTS}); `claudish --help` lists them.
 *
 * A name with no provider is not ROUTED here. The parser's answer only decides
 * whether it reaches `route()`, which calculates the chain from the user's rules
 * and the cloud models catalog; `proxyRouteDecision` (native-route.ts) is that
 * gate. What each form parses to:
 *   URL, `provider@model`, legacy prefix -> that provider, explicit: no chain
 *   a `nativeModelPatterns` match        -> that provider, a known `vendor/`
 *                                           stripped (`openai/<id>` → `<id>`);
 *                                           not explicit, so still routed
 *   `anthropic/<id>`                     -> native-anthropic; the proxy sends the
 *                                           id to OpenRouter verbatim
 *   `poe:<id>`                           -> poe; the proxy's Poe step serves it
 *   an unknown `vendor/`                 -> `unknown`; routed
 *   Claude Code's own names (`opus`, `claude-*`), `""`, `@model`
 *                                        -> native-anthropic: Claude Code's own
 *                                           auth, never routed
 *   anything else (`o4-mini`)            -> {@link AUTO_ROUTE_PROVIDER}; routed
 */

/**
 * The parser's answer for a bare name it cannot attribute to anyone: no `/`, no
 * native pattern matched, and not a name Claude Code owns (`o4-mini`,
 * `no-such-model-xyz`). It is NOT a claudish provider, and nothing may look it up
 * as one: `route()` decides which provider serves the name, from the user's rules
 * and the cloud models catalog.
 *
 * Why not `"unknown"`: that value already means "a `vendor/` with no known vendor"
 * (`foo/bar`) to `getMissingKeyError` and the advisor label, and it keeps that
 * meaning. `auto-route` is the code's existing word for "routing chooses" (the
 * stats invocation mode), and no provider or provider shortcut carries the name.
 */
export const AUTO_ROUTE_PROVIDER = "auto-route";

/**
 * Parsed model specification
 */
export interface ParsedModel {
  /**
   * Normalized provider name (lowercase). For a name with no explicit provider
   * this may also be one of the parser's own values, none of them a provider:
   * `custom-url`, `unknown` (a `vendor/` with no known vendor), or
   * {@link AUTO_ROUTE_PROVIDER} (a bare name `route()` decides).
   */
  provider: string;
  /** Model name/ID (without provider prefix) */
  model: string;
  /** Original full model string */
  original: string;
  /** Concurrency limit for local providers (undefined = use default, 0 = no limit) */
  concurrency?: number;
  /** Whether this used legacy syntax (for deprecation warnings) */
  isLegacySyntax: boolean;
  /** Whether provider was explicitly specified (vs auto-detected) */
  isExplicitProvider: boolean;
  /** `+pro` / `+standard` on the spec (removed from `model`). See `wire-markers.ts`. */
  mode?: WireMode;
  /** `#<speed>` on the spec (removed from `model`). */
  speed?: WireSpeed;
}

/**
 * Provider shortcut mappings — derived from BUILTIN_PROVIDERS.
 * Re-exported for backward compatibility.
 */
import { isClaudeCodeModelName } from "./claude-code-aliases.js";
import {
  getLegacyPrefixPatterns as _getLegacyPrefixPatterns,
  getNativeModelPatterns as _getNativeModelPatterns,
  getShortcuts as _getShortcuts,
  isDirectApiProvider as _isDirectApiProvider,
  isLocalTransport,
} from "./provider-definitions.js";
import { type WireMarkers, splitWireMarkers } from "./wire-markers.js";
import type { WireMode, WireSpeed } from "./wire-request.js";

export const PROVIDER_SHORTCUTS: Record<string, string> = _getShortcuts();

/**
 * Local providers (no API key needed) — derived from BUILTIN_PROVIDERS.
 */
export const LOCAL_PROVIDERS = {
  has(name: string): boolean {
    return isLocalTransport(name);
  },
};

/**
 * Providers that support direct API access — derived from BUILTIN_PROVIDERS.
 */
export const DIRECT_API_PROVIDERS = {
  has(name: string): boolean {
    return _isDirectApiProvider(name);
  },
};

/**
 * Native model prefixes — derived from BUILTIN_PROVIDERS.
 */
export const NATIVE_MODEL_PATTERNS = _getNativeModelPatterns();

/**
 * Legacy prefix patterns — derived from BUILTIN_PROVIDERS.
 */
export const LEGACY_PREFIX_PATTERNS = _getLegacyPrefixPatterns();

/**
 * Separator for a ROUTE CHAIN — an ordered list of explicit specs to try in turn:
 *
 *   zgo@minimax-m2.5+mm@MiniMax-M2.5+or@minimax/minimax-m2.5
 *
 * Why a chain form exists at all: `team` and `create_session` spawn child
 * claudish processes with an EXPLICIT spec rather than the bare name, because a
 * bare name makes the child re-resolve credentials and open its own 1Password SDK
 * client — and that handshake is arbitrated machine-wide, so N children racing it
 * means N-1 denials or N sequential dialogs (see `auth/credentials/prehydrate.ts`).
 * Explicitness is what buys one dialog per run. But an explicit spec is also a
 * chain of ONE, so those children had no fallback: `isRetryableError` is reachable
 * only from `FallbackHandler`, which is only built for a name the child routes
 * itself. A spent subscription, a rotated key, or a capability rejection killed the
 * model outright, where the same request served interactively would have fallen
 * through. This form carries the parent's whole chain across the process boundary
 * with every element still explicit, so both properties hold at once.
 *
 * `+` rather than `,` (already the advisor/team list separator) or `|` (needs shell
 * quoting when a user copies a spawn line out of a log). Verified against the live
 * catalog: 0 of 764 model ids contain a `+`.
 */
export const MODEL_CHAIN_SEPARATOR = "+";

/**
 * Split a `--model` value into its ordered candidates.
 *
 * A string with no separator yields a one-element array, so callers can treat
 * every model value as a chain without branching. Empty segments are dropped —
 * a trailing separator is a formatting artifact, not a request for a null
 * candidate.
 */
export function parseModelChain(modelSpec: string): string[] {
  const parts = modelSpec
    .split(MODEL_CHAIN_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  // `+` also marks a request mode (`cx@gpt-6-sol+pro`, see `wire-markers.ts`).
  // A segment that is ONLY a mode word, optionally followed by `#<speed>` or
  // `:N`, is that marker on the spec before it, never a chain element: every
  // element a chain carries is an explicit `provider@model` spec.
  const merged: string[] = [];
  for (const part of parts) {
    if (merged.length > 0 && MODE_MARKER_SEGMENT.test(part)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}+${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged.length > 0 ? merged : [modelSpec];
}

const MODE_MARKER_SEGMENT = /^(pro|standard)(#[a-z]+)?(:\d+)?$/i;

/**
 * Parse a model specification string
 *
 * Supports both new and legacy syntax:
 * - New: provider@model[:concurrency]
 * - Legacy: prefix/model or prefix:model
 *
 * NOTE: this parses ONE spec. A chain value (`a+b+c`) must be split with
 * {@link parseModelChain} first — the CLI does that at the argument boundary, so
 * everything downstream of arg parsing still sees a single spec.
 *
 * @param modelSpec - The model specification string
 * @returns Parsed model information
 */
export function parseModelSpec(modelSpec: string): ParsedModel {
  // Mode and speed markers are not part of any model id: strip them first, so
  // every consumer (routing, --probe, validation) sees the model alone. An
  // invalid marker is left in place and fails as an unknown model, or is
  // refused with its own message by the proxy, which splits markers strictly.
  let markers: WireMarkers | undefined;
  try {
    markers = splitWireMarkers(modelSpec);
  } catch {
    markers = undefined;
  }
  if (markers && (markers.mode || markers.speed)) {
    const parsed = parseModelSpecWithoutMarkers(markers.spec);
    return {
      ...parsed,
      original: modelSpec,
      ...(markers.mode ? { mode: markers.mode } : {}),
      ...(markers.speed ? { speed: markers.speed } : {}),
    };
  }
  return parseModelSpecWithoutMarkers(modelSpec);
}

function parseModelSpecWithoutMarkers(modelSpec: string): ParsedModel {
  const original = modelSpec;

  // Check for URL-style model (http:// or https://)
  if (modelSpec.startsWith("http://") || modelSpec.startsWith("https://")) {
    return {
      provider: "custom-url",
      model: modelSpec,
      original,
      isLegacySyntax: false,
      isExplicitProvider: true,
    };
  }

  // Check for new @ syntax: provider@model[:concurrency]
  const atMatch = modelSpec.match(/^([^@]+)@(.+)$/);
  if (atMatch) {
    const providerPart = atMatch[1].toLowerCase();
    let modelPart = atMatch[2];
    let concurrency: number | undefined;

    // Check for concurrency suffix on local providers
    const concurrencyMatch = modelPart.match(/^(.+):(\d+)$/);
    if (concurrencyMatch) {
      modelPart = concurrencyMatch[1];
      concurrency = Number.parseInt(concurrencyMatch[2], 10);
    }

    // Resolve provider shortcut
    const provider = PROVIDER_SHORTCUTS[providerPart] || providerPart;

    return {
      provider,
      model: modelPart,
      original,
      concurrency,
      isLegacySyntax: false,
      isExplicitProvider: true,
    };
  }

  // Check for legacy prefix patterns
  const lowerSpec = modelSpec.toLowerCase();
  for (const { prefix, provider, stripPrefix } of LEGACY_PREFIX_PATTERNS) {
    if (lowerSpec.startsWith(prefix)) {
      const model = stripPrefix ? modelSpec.slice(prefix.length) : modelSpec;

      // Check for concurrency suffix on local providers
      let concurrency: number | undefined;
      let modelName = model;
      if (LOCAL_PROVIDERS.has(provider)) {
        const concurrencyMatch = model.match(/^(.+):(\d+)$/);
        if (concurrencyMatch) {
          modelName = concurrencyMatch[1];
          concurrency = Number.parseInt(concurrencyMatch[2], 10);
        }
      }

      return {
        provider,
        model: modelName,
        original,
        concurrency,
        isLegacySyntax: true,
        isExplicitProvider: true,
      };
    }
  }

  // No explicit provider - try to detect native provider from model name
  for (const { pattern, provider } of NATIVE_MODEL_PATTERNS) {
    if (pattern.test(modelSpec)) {
      // For patterns that match "provider/model", strip the provider prefix
      const slashIndex = modelSpec.indexOf("/");
      const model = slashIndex > 0 ? modelSpec.slice(slashIndex + 1) : modelSpec;

      return {
        provider,
        model,
        original,
        isLegacySyntax: false,
        isExplicitProvider: false,
      };
    }
  }

  // Unknown vendor/model format - require explicit provider
  // Use openrouter@vendor/model if you want OpenRouter
  if (modelSpec.includes("/")) {
    return {
      provider: "unknown",
      model: modelSpec,
      original,
      isLegacySyntax: false,
      isExplicitProvider: false,
    };
  }

  // No "/" and no pattern matched. Claude Code's own names (`opus`, `opusplan`,
  // `sonnet[1m]`, `best`) are served on its own auth by the native passthrough.
  // `""` and `@model` are not model names at all: they keep the native answer
  // they always had, and the harness rejects them. Every other bare name
  // (`o4-mini`, a typo) is routed: the native passthrough serves none of them,
  // so sending one there only ever earned an Anthropic 404.
  return {
    provider: lastResortProvider(modelSpec),
    model: modelSpec,
    original,
    isLegacySyntax: false,
    isExplicitProvider: false,
  };
}

/**
 * The provider for a bare name no `/` and no pattern claimed: native-anthropic
 * for Claude Code's names and for `""` / `@model`, else {@link AUTO_ROUTE_PROVIDER}.
 * Trimmed, as `isClaudeCodeModelName` is, so a whitespace-only value counts as
 * empty.
 */
function lastResortProvider(modelSpec: string): string {
  const name = modelSpec.trim();
  const isNative = name === "" || name.startsWith("@") || isClaudeCodeModelName(name);
  return isNative ? "native-anthropic" : AUTO_ROUTE_PROVIDER;
}

/**
 * Check if a provider is a local provider
 */
export function isLocalProviderName(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Check if a provider supports direct API access
 */
export function isDirectApiProvider(provider: string): boolean {
  return DIRECT_API_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Get deprecation warning for legacy syntax
 */
export function getLegacySyntaxWarning(parsed: ParsedModel): string | null {
  if (!parsed.isLegacySyntax) {
    return null;
  }

  const newSyntax = `${parsed.provider}@${parsed.model}`;
  return (
    `Deprecation warning: "${parsed.original}" uses legacy prefix syntax.\n` +
    `  Consider using: ${newSyntax}`
  );
}

/**
 * Format a model spec in the new syntax
 */
export function formatModelSpec(provider: string, model: string, concurrency?: number): string {
  let spec = `${provider}@${model}`;
  if (concurrency !== undefined) {
    spec += `:${concurrency}`;
  }
  return spec;
}
