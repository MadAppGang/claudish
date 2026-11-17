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
import { isClaudeCodeModelName, normalizeNativeModelSpec } from "./claude-code-aliases.js";
import {
  BUILTIN_PROVIDERS,
  getLegacyPrefixPatterns as _getLegacyPrefixPatterns,
  getNativeModelPatterns as _getNativeModelPatterns,
  getShortcuts as _getShortcuts,
  isDirectApiProvider as _isDirectApiProvider,
  isLocalTransport,
} from "./provider-definitions.js";
import { type WireMarkers, splitWireMarkers } from "./wire-markers.js";
import type { WireMode, WireSpeed } from "./wire-request.js";

export const PROVIDER_SHORTCUTS: Record<string, string> = _getShortcuts();

const PROVIDER_PREFIX = /^[^@]+@/;

/**
 * Whether a model spec names its provider: text before its first "@".
 *
 * A bare `includes("@")` is wrong because a wire id may itself start with "@"
 * (OpenRouter presets: `@preset/example`). That id names no provider, while
 * `or@@preset/example` does.
 */
export function hasProviderPrefix(spec: string): boolean {
  return PROVIDER_PREFIX.test(spec);
}

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
 * True when a model spec routes to the raw-URL `custom-url` provider: some element of
 * its chain (`a+b+c`) resolves to `custom-url` (`https://host/…`, `custom-url@https://…`),
 * so claudish would connect to the host in the spec. Parsed with `parseModelSpec` itself,
 * not a prefix test, so it stays faithful to what routing does.
 *
 * The ONE check for a model chosen by a checkout rather than by the user: a working
 * directory's `.env` (`dotenv-allowlist.ts`) and a project `.claudish.json` profile
 * (`project-models.ts`) both refuse such a spec.
 */
export function modelSpecNamesRawUrl(modelSpec: string): boolean {
  return parseModelChain(modelSpec).some(
    (element) => parseModelSpec(element.trim()).provider === "custom-url"
  );
}

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

/**
 * Split a `:N` request cap off `model` when `provider` is local. Anywhere else a
 * trailing `:<digits>` belongs to the model id (an Ollama Cloud wire id such as
 * `deepseek-v4-pro:0813`), and the launch refuses a `:N` no provider honours.
 */
function splitLocalConcurrency(
  provider: string,
  model: string
): { model: string; concurrency?: number } {
  const match = LOCAL_PROVIDERS.has(provider) ? model.match(/^(.+):(\d+)$/) : null;
  if (!match) return { model };
  return { model: match[1] as string, concurrency: Number.parseInt(match[2] as string, 10) };
}

/** The provider shortcuts whose `:N` is a request cap, e.g. `ollama@, lmstudio@`. */
export function concurrencyProviderShortcuts(): string {
  return BUILTIN_PROVIDERS.filter((def) => def.isLocal)
    .map((def) => `${def.name}@`)
    .join(", ");
}

/**
 * The refusal for a spec whose trailing `:N` no provider honours, or null.
 * `:N` caps concurrent requests only on a local provider; on any other
 * provider, or a bare name, it would be dropped or sent as part of the model
 * id. A `:<digits>` the catalog knows as a model id (`knowsModelId`) is that
 * model, not a suffix.
 */
export function concurrencySuffixRefusal(
  spec: string,
  knowsModelId: (id: string) => boolean
): string | null {
  if (/^https?:\/\//.test(spec)) return null;
  const parsed = parseModelSpec(spec);
  if (parsed.concurrency !== undefined) return null;
  if (!/:\d+$/.test(parsed.model) || knowsModelId(parsed.model)) return null;
  return `${spec}: a :N concurrency suffix works only on a local provider (${concurrencyProviderShortcuts()}). Remove the :N, or run the model on one of those.`;
}

function parseModelSpecWithoutMarkers(modelSpec: string): ParsedModel {
  const original = modelSpec;

  // Check for URL-style model (http:// or https://)
  if (modelSpec.startsWith("http://") || modelSpec.startsWith("https://")) {
    // `custom-url` is a raw-URL provider: claudish connects to the host in the spec. The
    // credential authority has no notion of where a model spec came from, so it cannot
    // deny a repo-chosen host on its own. The guarantee that a spec reaching here was not
    // chosen by an unreviewed checkout is enforced at the two places a checkout can name
    // a model, both through `modelSpecNamesRawUrl`: the working directory's `.env`
    // (`dotenv-allowlist.ts` refuses a `CLAUDISH_MODEL`/`CLAUDISH_MODEL_*` that resolves to
    // `custom-url`) and a project `.claudish.json` profile (`project-models.ts` drops such
    // a tier). A custom URL model must come from the shell, a flag or the user's own config.
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
    // Resolve provider shortcut
    const provider = PROVIDER_SHORTCUTS[providerPart] || providerPart;
    const { model, concurrency } = splitLocalConcurrency(provider, atMatch[2]);

    return {
      provider,
      model,
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
      const { model: modelName, concurrency } = splitLocalConcurrency(
        provider,
        stripPrefix ? modelSpec.slice(prefix.length) : modelSpec
      );

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

/**
 * A listing entry: a `--model` value that names a claudish provider and no
 * model, so the launch lists that provider's models in Claude Code's `/model`.
 * `devin@` lists every chat model a vendor's own provider or a subscription
 * serves (a gateway: its recommended ones); `or@*` lists every chat model.
 */
export interface ListingEntry {
  /** The provider shortcut as typed, lowercased; resolved after endpoint registration. */
  shortcut: string;
  scope: "recommended" | "all";
}

const LISTING_ENTRY = /^([^@\s/:+#]+)@(\*)?$/;

/** `devin@` → {shortcut:"devin", scope:"recommended"}, `or@*` → scope "all"; anything else null. */
export function parseListingEntry(value: string): ListingEntry | null {
  const match = LISTING_ENTRY.exec(value.trim());
  if (!match) return null;
  return { shortcut: (match[1] as string).toLowerCase(), scope: match[2] ? "all" : "recommended" };
}

/** Every `--model` value of one argv, split and classified. */
export interface ParsedModelFlags {
  /** The LAST full spec, native selectors normalized. */
  start?: string;
  /** Only when the deciding value was a routing chain (no listing entry). */
  chain?: string[];
  /** Every earlier full spec on a lineup launch, argv order. */
  pinned: string[];
  /** Listing entries in flag order; one per shortcut, `*` winning. */
  listings: ListingEntry[];
  /** True when at least one listing entry was given. */
  hasLineup: boolean;
}

export type ModelFlagsResult =
  | { ok: true; value: ParsedModelFlags }
  | { ok: false; message: string };

/**
 * A `--model` value as a refusal message may show it. A raw URL can carry a
 * credential in its userinfo, path or query, so each URL element of the value
 * is shown as "<a raw URL at ORIGIN>" and nothing past the host.
 */
function modelValueForMessage(value: string): string {
  return parseModelChain(value)
    .map((element) => {
      const parsed = parseModelSpec(element);
      if (parsed.provider !== "custom-url") return element;
      try {
        return `<a raw URL at ${new URL(parsed.model).origin}>`;
      } catch {
        return "<a raw URL>";
      }
    })
    .join("+");
}

/**
 * Why a full spec cannot be a pinned row of a lineup launch, or null. Reads the
 * parser only: a pinned row must name a claudish provider explicitly, and that
 * provider must be one whose models can be listed.
 */
function pinnedSpecRefusal(spec: string): string | null {
  const parsed = parseModelSpec(spec);
  if (parsed.provider === "custom-url") {
    return `--model ${modelValueForMessage(spec)}: a raw URL cannot be listed in /model. Declare the endpoint under customEndpoints and list it by name (--model <name>@).`;
  }
  if (parsed.provider === "native-anthropic") {
    return `--model ${spec}: a Claude model cannot be listed beside the start model, because Claude Code lists Claude's own models in /model already. Drop it, or give it as the last --model to start on it.`;
  }
  if (!parsed.isExplicitProvider) {
    if (parsed.provider === "unknown") {
      return `--model ${spec}: "${spec}" names no claudish provider to list. Use <provider>@${spec}, for example openrouter@${spec}.`;
    }
    return `--model ${spec}: a bare model name names no provider to list. Use <provider>@${spec}, or give it as the last --model to start on it.`;
  }
  return null;
}

/**
 * Split and classify every `--model` value of one argv. Pure: no provider
 * registry is read, so it runs before endpoint registration.
 *
 * With no listing entry the answer is today's: the LAST value decides,
 * `start` is its first element and `chain` its elements when it is a routing
 * chain; earlier values are ignored. With a listing entry the launch has a
 * lineup: the last full spec starts it, every earlier full spec is a pinned
 * row, and a routing chain or a full spec that cannot be a row is refused.
 */
export function parseModelFlags(values: readonly string[]): ModelFlagsResult {
  const listings: ListingEntry[] = [];
  const fullSpecs: string[][] = [];
  const raw: string[] = [];
  for (const value of values) {
    const entry = parseListingEntry(value);
    if (entry) {
      const earlier = listings.find((l) => l.shortcut === entry.shortcut);
      if (earlier) {
        if (entry.scope === "all") earlier.scope = "all";
      } else {
        listings.push(entry);
      }
      continue;
    }
    fullSpecs.push(parseModelChain(value).map(normalizeNativeModelSpec));
    raw.push(value);
  }

  if (listings.length === 0) {
    const last = fullSpecs[fullSpecs.length - 1];
    if (!last) return { ok: true, value: { pinned: [], listings: [], hasLineup: false } };
    return {
      ok: true,
      value: {
        start: last[0],
        ...(last.length > 1 ? { chain: last } : {}),
        pinned: [],
        listings: [],
        hasLineup: false,
      },
    };
  }

  for (let i = 0; i < fullSpecs.length; i++) {
    if ((fullSpecs[i] as string[]).length > 1) {
      return {
        ok: false,
        message: `--model ${modelValueForMessage(raw[i] as string)}: a + routing chain cannot be combined with a listing entry. Give one model per --model.`,
      };
    }
  }
  const specs = fullSpecs.map((chain) => chain[0] as string);
  const pinned = specs.slice(0, -1);
  for (const spec of pinned) {
    const refusal = pinnedSpecRefusal(spec);
    if (refusal) return { ok: false, message: refusal };
  }
  return {
    ok: true,
    value: {
      ...(specs.length > 0 ? { start: specs[specs.length - 1] } : {}),
      pinned,
      listings,
      hasLineup: true,
    },
  };
}
