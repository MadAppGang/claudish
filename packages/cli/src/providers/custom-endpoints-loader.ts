/**
 * Custom Endpoints Loader — reads `config.customEndpoints` and registers each
 * valid entry as a runtime ProviderDefinition + ProviderProfile.
 *
 * Phase 3 of the LiteLLM-demotion refactor. Users declare custom OpenAI- or
 * Anthropic-compatible endpoints in ~/.claudish/config.json and they become
 * first-class providers that work with `--model my-endpoint@some-model`.
 *
 * Validation: each entry is parsed via `CustomEndpointSchema` (Zod). Invalid
 * entries are collected into `result.errors` and reported to stderr — never
 * fatal, so one typo doesn't crash startup.
 *
 * Idempotency: calling twice with the same config is safe. The runtime
 * registry is a Map keyed on endpoint name, so re-registration overwrites.
 *
 * `registerEndpoint()` is the single validate→build→register sequence, and it
 * takes an optional `EndpointDefinitionOverrides`. User config never passes one
 * — the overrides exist so a BUNDLED endpoint can carry the vendor's own env
 * var and an optional base-URL override while travelling this exact path.
 * Every generated field falls back to today's expression when the argument is
 * absent, so the user-authored result is unchanged field for field.
 */

import { z } from "zod";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { LiteLLMAPIFormat } from "../adapters/litellm-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { credentials } from "../auth/credentials/authority.js";
import {
  type CustomEndpoint,
  type CustomEndpointComplex,
  CustomEndpointSchema,
  type CustomEndpointSimple,
} from "../config-schema.js";
import { realValue } from "../env-placeholder.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
import type { ModelHandler } from "../handlers/types.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import { clearEndpointUnavailable, recordEndpointUnavailable } from "./endpoint-diagnostics.js";
// Type-only, as in provider-definitions.ts: erased at compile time, so no
// runtime import cycle with model-discovery.ts.
import type { ModelDiscoveryDescriptor } from "./model-discovery.js";
import {
  type RouteTier,
  type TieredProviderDefinition,
  type TransportType,
  baseUrlOverrideCandidates,
  runtimeHandler,
} from "./provider-definitions.js";
import type { ProfileContext, ProviderProfile } from "./provider-profiles.js";
import { reservedNamespaceOwner } from "./reserved-namespace.js";
import { registerRuntimeProfile, registerRuntimeProvider } from "./runtime-providers.js";
import { AnthropicProviderTransport } from "./transport/anthropic-compat.js";
import { LiteLLMProviderTransport } from "./transport/litellm.js";
import { OpenAIProviderTransport } from "./transport/openai.js";

/**
 * Result of loading custom endpoints from a config object.
 */
export interface LoadResult {
  /** Number of endpoints successfully registered. */
  registered: number;
  /** Names of endpoints that failed validation, with their error messages. */
  errors: Array<{ name: string; message: string }>;
  /**
   * Entries refused for a reason that is NOT a validation failure — today only
   * a collision with a builtin provider's namespace (#191).
   *
   * Kept separate from `errors` because the two need different words. An
   * invalid entry is a typo in the user's JSON; a refused one is a perfectly
   * well-formed entry that claudish will not honour, and telling someone to
   * "fix the validation error" in that case sends them looking at the wrong
   * thing.
   */
  refused: Array<{ name: string; reason: string }>;
}

/**
 * The handful of generated fields a BUNDLED endpoint needs to differ on.
 *
 * A predefined catalog row compiles to exactly the `CustomEndpointComplex`
 * object a user would have hand-written, which is what lets the whole feature
 * reuse this already-tested request path instead of adding one. Four things a
 * hand-written entry cannot express are all that remain, and they all live
 * here: the vendor's own env var (`GROQ_API_KEY` rather than the synthesized
 * `CUSTOM_GROQ_KEY`), extra accepted spellings, a run-time base-URL override,
 * and the key-signup URL a missing-key error should point at.
 *
 * EVERY field falls back to today's exact expression when the overrides
 * argument is absent, so `loadCustomEndpoints` — which never passes it —
 * produces a definition and profile that behave identically. That is the
 * contract, and `custom-endpoints-loader.test.ts` passing unmodified is how it
 * is checked.
 *
 * "Identically", not "byte-identically" — the object is measurably different in
 * one harmless way: it now ALWAYS carries `apiKeyAliases` and `baseUrlEnvVars`
 * keys, valued `undefined`, where the old literals omitted them, and
 * `registerEndpoint` passes `aliases: undefined` to the authority (same as the
 * field being absent). `toEqual` ignores that; `toStrictEqual` would not, and
 * no current test uses it. The distinction is written down because an
 * overclaiming comment is how a future reader stops checking.
 */
export interface EndpointDefinitionOverrides {
  /** Primary credential env var. Default: `CUSTOM_<SANITIZED_NAME>_KEY`. */
  apiKeyEnvVar?: string;
  /** Additional accepted env vars, tried after the primary. */
  apiKeyAliases?: string[];
  /** Env vars that override `baseUrl` at run time (R12). */
  baseUrlEnvVars?: string[];
  /** Where a user obtains a key. Default: `""`. */
  apiKeyUrl?: string;
  /** Credential label shown in the TUI. Default: `<name> (custom endpoint)`. */
  apiKeyDescription?: string;
  /** Picker/TUI description. Default: `Custom endpoint: <name>`. */
  description?: string;
}

/**
 * Validate → build definition → build profile → register in all three
 * registries. The ONE sequence, used by both the user-authored path below and
 * (from a later phase) the bundled catalog.
 *
 * It is extracted rather than inlined twice because the two paths registering
 * a provider slightly differently is the failure this codebase keeps paying
 * for: a definition without its profile silently routes to OpenRouter, and a
 * definition without its credential registration fails the routing pre-flight
 * before the handler that could have resolved the key is ever built. One
 * function means the catalog cannot drift from the path users already exercise.
 *
 * THROWS on invalid input (Zod or otherwise) — deliberately, so each caller
 * decides how to report it. Nothing here writes to stderr or exits.
 */
export function registerEndpoint(
  name: string,
  entry: unknown,
  ovr?: EndpointDefinitionOverrides
): void {
  const validated = CustomEndpointSchema.parse(entry);
  const def = buildProviderDefinition(name, validated, ovr);
  const profile = buildProviderProfile(validated, ovr);
  registerRuntimeProvider(def);
  registerRuntimeProfile(name, profile);
  // Register the custom endpoint in the credential authority too, so its key
  // (CUSTOM_<NAME>_KEY — including op:// values) resolves through the single
  // authority like every other provider, instead of an out-of-band env read.
  //
  // `declaredKey` closes over the endpoint's own `apiKey` field so a literal
  // or `${VAR}` declaration ALSO counts as a credential. The authority is the
  // routing pre-flight's oracle (hasCredentialsForProvider / getRequestAuth);
  // registering only the CUSTOM_<NAME>_KEY env var made every `${VAR}` and
  // literal endpoint look uncredentialed, so it was rejected before its
  // handler — which could have resolved the key — was ever constructed.
  credentials.registerApiKeyProvider({
    name: def.name,
    envVar: def.apiKeyEnvVar,
    aliases: def.apiKeyAliases,
    // Passed THROUGH, not narrowed here. This site used to inline
    // `=== "x-api-key" ? "x-api-key" : "bearer"`, which collapsed `"none"` into
    // bearer and left a keyless endpoint failing the routing pre-flight with
    // "CUSTOM_<NAME>_KEY is required" — a demand for a key the user had
    // correctly declared they do not have. The authority normalizes.
    authScheme: def.authScheme,
    declaredKey: () => resolveDeclaredEndpointKey(validated),
  });
  // This name now has a definition, a profile and a credential, so whatever
  // reason it was previously unavailable for is stale. Clearing here (rather
  // than at each recording site) means a re-registration — a fixed URL, a key
  // imported in the config TUI — cannot leave the user reading a dead reason.
  clearEndpointUnavailable(name);
}

/**
 * Validate and register all customEndpoints from a config.
 *
 * Invalid entries are collected into `result.errors` and skipped. Entries whose
 * NAME collides with a builtin provider are collected into `result.refused` and
 * skipped — see below.
 *
 * ── Why a name collision is refused rather than merged (#191) ───────────────
 *
 * `credentials.registerApiKeyProvider` is a plain `Map.set` with no guard, so
 * before this check an entry keyed `openrouter` landed in a split state:
 *
 *   definition (`getProviderByName`)   → BUILTIN wins, baseUrl stays openrouter.ai
 *   profile (`PROVIDER_PROFILES[name]`) → BUILTIN wins
 *   credential (`registerApiKeyProvider`) → the CUSTOM ENDPOINT, last write, no check
 *
 * So the user got neither half of what they asked for. Their endpoint was
 * shadowed AND the builtin's credential was replaced, with real requests to
 * openrouter.ai signed by `CUSTOM_OPENROUTER_KEY`, and nothing anywhere
 * reporting either.
 *
 * Refusing is strictly better than any merge. There is no reading of
 * "customEndpoints.openrouter" under which sending the user's key to the
 * builtin's URL is what they meant, and the bundled catalog has refused exactly
 * this since it shipped — so the two paths now agree instead of one being
 * guarded and the other not.
 *
 * The refusal is LOUD by design. A provider that fails to appear is diagnosable
 * from one warning line; a provider that appears and signs requests to someone
 * else's host with your key is not diagnosable at all.
 */
export function loadCustomEndpoints(config: ClaudishProfileConfig): LoadResult {
  const result: LoadResult = { registered: 0, errors: [], refused: [] };
  const raw = config.customEndpoints;
  if (!raw || typeof raw !== "object") return result;

  for (const [name, entry] of Object.entries(raw)) {
    const owner = reservedNamespaceOwner(name);
    if (owner) {
      const reason =
        `'${name}' is already claimed by builtin provider '${owner}' ` +
        "(as its name, a shortcut, or a legacy prefix)";
      result.refused.push({ name, reason });
      recordEndpointUnavailable(name, `custom endpoint was skipped because ${reason}`);
      continue;
    }
    try {
      registerEndpoint(name, entry);
      result.registered++;
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((i) => i.message).join(", ")
          : err instanceof Error
            ? err.message
            : String(err);
      result.errors.push({ name, message });
    }
  }

  return result;
}

/**
 * The routing tier of EVERY endpoint that arrives from config — user-authored or
 * bundled.
 *
 * `gateway`, and deliberately the weakest true thing claudish can say. A row
 * carries CONNECTION FACTS ONLY (see predefined-endpoint-schema.ts): a URL, a
 * path, a wire format and the vendor's env var. Nothing in it distinguishes
 * Together AI reselling forty vendors from Cohere serving its own models, so
 * classifying one as `native` would be a guess, and guessing UPWARDS would sort a
 * third-party endpoint ahead of the vendor's own. `gateway` is the last tier
 * before the fallback, so an endpoint claudish cannot classify sorts last among
 * the ones it can — which is the recoverable direction.
 *
 * Not `fallback`: that tier is a POSITION held by whichever provider
 * `defaultProvider` names, and no definition may claim it.
 *
 * Exported for the route-binding guard: a bundled row gets a definition only when
 * it registers, which needs its key, so a hermetic test reads the tier here.
 */
export const CUSTOM_ENDPOINT_TIER: RouteTier = "gateway";

/**
 * The models-list descriptor for an endpoint that speaks OpenAI, and
 * `undefined` for one that does not.
 *
 * DERIVED FROM THE DECLARED WIRE FORMAT, never configured. `format: "openai"`
 * (or `transport: "openai"`) is already the user's statement that this host
 * speaks the OpenAI API, and `GET /models` is part of that API — published as a
 * sibling of `/chat/completions`. So the path is one RULE applied to the path
 * the endpoint already declares (`/v1/chat/completions` → `/v1/models`,
 * `/chat/completions` → `/models`, `/api/v2/chat/completions` →
 * `/api/v2/models`), not a pinned URL the way a hardcoded model list would be.
 * All 27 bundled rows in `predefined-catalog.ts` travel this same function and
 * land on the path their vendor serves.
 *
 * Until now a custom endpoint declared no discovery at all, so `hasDiscovery`
 * was false in the picker and NOTHING EVER ASKED THE HOST what it serves. The
 * provider row read `0 models` and `⏎` opened an empty list — the founding
 * defect of `picker.md`, in the one place where the endpoint itself could have
 * answered. That row's other phrasing, `lists its own models`, was written for
 * this exact case ("a self-hosted vLLM", `rows.tsx:315`) and was unreachable.
 *
 * An endpoint that does not serve the path is now a `failed` outcome naming the
 * URL and the status, which is strictly more than the silent empty list it
 * replaces.
 *
 * Only `openai`. The `anthropic` transport's own `/v1/models` wants an
 * `anthropic-version` header and answers `created_at` where
 * `openai-models-list` reads `created`; `litellm` and `gemini` are different
 * shapes again. Each is its own change with its own live verification.
 */
function openaiModelsDiscovery(
  wireFormat: string,
  apiPath: string
): ModelDiscoveryDescriptor | undefined {
  const chat = "/chat/completions";
  if (wireFormat !== "openai" || !apiPath.endsWith(chat)) return undefined;
  return { path: `${apiPath.slice(0, -chat.length)}/models`, format: "openai-models-list" };
}

/**
 * Build a ProviderDefinition for a custom endpoint so it appears in lookups
 * (getProviderByName, getAllProviders, etc.). The definition is minimal —
 * real handler construction happens in the profile.
 *
 * `ovr` is absent for user-authored endpoints; every field below then evaluates
 * to the same expression it always did.
 */
function buildProviderDefinition(
  name: string,
  ep: CustomEndpoint,
  ovr?: EndpointDefinitionOverrides
): TieredProviderDefinition {
  const apiKeyEnvVar = ovr?.apiKeyEnvVar ?? customEndpointKeyEnvVar(name);
  const apiKeyAliases = ovr?.apiKeyAliases;
  const baseUrlEnvVars = ovr?.baseUrlEnvVars;
  const apiKeyUrl = ovr?.apiKeyUrl ?? "";

  if (ep.kind === "simple") {
    return {
      createHandler: runtimeHandler(name),
      tier: CUSTOM_ENDPOINT_TIER,
      name,
      displayName: name,
      transport: ep.format as TransportType,
      baseUrl: stripTrailingSlash(ep.url),
      baseUrlEnvVars,
      apiPath: "/chat/completions",
      apiKeyEnvVar,
      apiKeyAliases,
      apiKeyDescription: ovr?.apiKeyDescription ?? `${name} (custom endpoint)`,
      apiKeyUrl,
      shortcuts: [name],
      legacyPrefixes: [],
      isDirectApi: true,
      shortestPrefix: name,
      description: ovr?.description ?? `Custom endpoint: ${name}`,
      // Was a hardcoded "bearer", which silently discarded the `authScheme` the
      // simple schema now accepts — so `authScheme: "none"` validated, registered,
      // and then demanded a key anyway. Bearer stays the DEFAULT (that is what
      // every simple endpoint got before), but a declared scheme now survives.
      authScheme: ep.authScheme ?? "bearer",
      modelDiscovery: openaiModelsDiscovery(ep.format, "/chat/completions"),
    };
  }

  const apiPath = ep.apiPath ?? "/v1/chat/completions";
  return {
    createHandler: runtimeHandler(name),
    tier: CUSTOM_ENDPOINT_TIER,
    name,
    displayName: ep.displayName,
    transport: ep.transport as TransportType,
    baseUrl: stripTrailingSlash(ep.baseUrl),
    baseUrlEnvVars,
    apiPath,
    apiKeyEnvVar,
    apiKeyAliases,
    apiKeyDescription: ovr?.apiKeyDescription ?? `${ep.displayName} (custom endpoint)`,
    apiKeyUrl,
    shortcuts: [name],
    legacyPrefixes: [],
    isDirectApi: true,
    shortestPrefix: name,
    description: ovr?.description ?? `Custom endpoint: ${ep.displayName}`,
    headers: ep.headers,
    authScheme: ep.authScheme ?? "bearer",
    modelDiscovery: openaiModelsDiscovery(ep.transport, apiPath),
  };
}

/**
 * Build a ProviderProfile for a custom endpoint that creates a ComposedHandler
 * on demand. Modeled after litellmProfile in provider-profiles.ts.
 *
 * `ovr` is absent for user-authored endpoints, and the base URL is then the
 * endpoint's own field, read exactly as before.
 */
function buildProviderProfile(
  ep: CustomEndpoint,
  ovr?: EndpointDefinitionOverrides
): ProviderProfile {
  return {
    createHandler(ctx: ProfileContext): ModelHandler | null {
      // The key is resolved through the credential authority (proxy-server passes
      // it as ctx.apiKey via getRequestAuth — env → config → op://, lazy SDK).
      // Fall back to the literal/${VAR} resolver only when the authority yielded
      // nothing (e.g. a plain ${VAR} apiKey the authority's env read also covers,
      // or a non-routed construction path). This is the single source of truth —
      // an op:// custom apiKey now resolves correctly instead of signing the
      // literal "op://…" string.
      const apiKey = ctx.apiKey || resolveCustomEndpointApiKey(ep);
      // Resolved per handler build rather than captured at registration, so a
      // base URL exported after startup is honoured without a restart.
      const declaredBaseUrl = ep.kind === "simple" ? ep.url : ep.baseUrl;
      const resolved = classifyEndpointBaseUrl(declaredBaseUrl, ovr?.baseUrlEnvVars);
      if (!resolved.ok) {
        const reason = describeBadBaseUrlOverride(resolved, declaredBaseUrl);
        console.error(`[claudish] ${reason}`);
        // The caller of createHandler() sees only `null`, and the routing
        // pre-flight renders that as "no credential" — the wrong cause, which
        // sends the user hunting for a key they already have. Record the real
        // one so the error can name it.
        recordEndpointUnavailable(ctx.provider.name, `its ${reason}`);
        return null;
      }
      const baseUrl = resolved.url;
      if (ep.kind === "simple") {
        return buildSimpleHandler(ep, ctx, apiKey, baseUrl);
      }
      return buildComplexHandler(ep, ctx, apiKey, baseUrl);
    },
  };
}

/** A resolved base URL, or the override that made resolution impossible. */
export type EndpointBaseUrl =
  | { ok: true; url: string }
  | { ok: false; envVar: string; value: string; source: "config" | "env" };

/**
 * The base URL to actually use: an override when one is declared AND set,
 * otherwise the endpoint's own.
 *
 * The override chain is NOT re-implemented here. It is
 * `baseUrlOverrideCandidates()` — the same function `getEffectiveBaseUrl()`
 * uses — so `config.endpoints[VAR]` (what the config TUI's URL editor and
 * `claudish config` actually persist) and `process.env[VAR]` are consulted in
 * one order, decided in one place. An earlier revision walked `process.env`
 * only: the TUI writes BOTH the config entry and the env var, so it looked
 * right for the rest of the session and diverged after a restart, at which
 * point the TUI kept DISPLAYING the saved private URL while requests went to
 * the bundled public host.
 *
 * Reports `ok: false` — meaning "build no handler, register nothing" — when an
 * override IS set to a concrete value that is not an http(s) URL. It
 * deliberately does NOT fall back to the bundled default in that case: a
 * base-URL override exists so a customer can point a gateway-shaped vendor at
 * their own instance, and silently sending that instance's prompts, file
 * contents and API key to the PUBLIC vendor hostname turns a typo into a
 * data-egress incident. Absence with an exact reason beats a wrong destination.
 * That rule applies to a CONFIG-sourced value exactly as it does to an
 * env-sourced one — the hazard is the destination, not the storage.
 *
 * An UNEXPANDED `${VAR}` placeholder means the variable is unset, not wrong, so
 * `realValue()` drops it and the NEXT candidate (or the declared URL) stands —
 * the override was never really set. Without that distinction the strict rule
 * would bite exactly the user it is meant to protect, since a declarative host
 * passes placeholders through verbatim.
 *
 * I/O-free in the sense that matters: `new URL()` parses, it does not connect,
 * and nothing here writes to stderr — the two callers (registration gate and
 * handler build) want to phrase the same fact differently, so the phrasing
 * stays with them. It does read `~/.claudish/config.json` via
 * `getConfigEndpoint`, but ONLY for an endpoint that declares
 * `baseUrlEnvVars`; a row without one still touches nothing.
 */
export function classifyEndpointBaseUrl(
  declared: string,
  baseUrlEnvVars?: string[]
): EndpointBaseUrl {
  for (const candidate of baseUrlOverrideCandidates(baseUrlEnvVars)) {
    const value = realValue(candidate.value)?.trim();
    if (!value) continue;
    if (!isHttpUrl(value)) {
      return { ok: false, envVar: candidate.envVar, value, source: candidate.source };
    }
    return { ok: true, url: stripTrailingSlash(value) };
  }
  return { ok: true, url: stripTrailingSlash(declared) };
}

/**
 * One sentence describing a bad override, shared by both callers so the stderr
 * warning and the routing error cannot drift into two different explanations of
 * the same fact.
 *
 * The `source` decides only the NOUN and the remedy — "unset it" is not
 * actionable advice for a value that lives in a config file the user edited in
 * a TUI. Absent or `"env"` renders the original sentence byte for byte, which
 * is what the recorded validation run and its stderr transcript pin.
 */
export function describeBadBaseUrlOverride(
  bad: { envVar: string; value: string; source?: "config" | "env" },
  declared: string
): string {
  const where =
    bad.source === "config"
      ? `config.endpoints["${bad.envVar}"] is set to '${bad.value}'`
      : `${bad.envVar} is set to '${bad.value}'`;
  const remedy =
    bad.source === "config"
      ? "Fix or remove it (claudish config -> Providers)."
      : "Fix or unset it.";
  return (
    `${where}, which is not a valid http(s) URL. ` +
    `${remedy} (Not falling back to ${declared} — the override was set on purpose.)`
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildSimpleHandler(
  ep: CustomEndpointSimple,
  ctx: ProfileContext,
  apiKey: string,
  baseUrl: string
): ModelHandler | null {
  const finalModel = ep.modelPrefix ? `${ep.modelPrefix}${ctx.modelName}` : ctx.modelName;

  if (ep.format === "openai") {
    const remoteProvider: RemoteProvider = {
      name: ctx.provider.name,
      baseUrl,
      apiPath: "/chat/completions",
      apiKeyEnvVar: ctx.provider.apiKeyEnvVar,
      prefixes: ctx.provider.prefixes ?? [],
      headers: ctx.provider.headers,
      authScheme: "bearer",
    };
    const transport = new OpenAIProviderTransport(remoteProvider, finalModel, apiKey);
    const adapter = new OpenAIAPIFormat(finalModel);
    return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
      adapter,
      tokenStrategy: "delta-aware",
      ...ctx.sharedOpts,
    });
  }

  // anthropic
  const remoteProvider: RemoteProvider = {
    name: ctx.provider.name,
    baseUrl,
    apiPath: "/v1/messages",
    apiKeyEnvVar: ctx.provider.apiKeyEnvVar,
    prefixes: ctx.provider.prefixes ?? [],
    headers: ctx.provider.headers,
    authScheme: ctx.provider.authScheme ?? "x-api-key",
  };
  const transport = new AnthropicProviderTransport(remoteProvider, apiKey);
  const adapter = new AnthropicAPIFormat(finalModel, ctx.provider.name);
  return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
    adapter,
    ...ctx.sharedOpts,
  });
}

function buildComplexHandler(
  ep: CustomEndpointComplex,
  ctx: ProfileContext,
  apiKey: string,
  baseUrl: string
): ModelHandler | null {
  const finalModel = ep.modelPrefix ? `${ep.modelPrefix}${ctx.modelName}` : ctx.modelName;
  const apiPath = ep.apiPath ?? "/v1/chat/completions";

  switch (ep.transport) {
    case "litellm": {
      const transport = new LiteLLMProviderTransport(baseUrl, apiKey, finalModel);
      const adapter = new LiteLLMAPIFormat(finalModel, baseUrl);
      return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
        adapter,
        ...ctx.sharedOpts,
      });
    }
    case "openai": {
      const remoteProvider: RemoteProvider = {
        name: ctx.provider.name,
        baseUrl,
        apiPath,
        apiKeyEnvVar: ctx.provider.apiKeyEnvVar,
        prefixes: ctx.provider.prefixes ?? [],
        headers: ep.headers,
        authScheme: ep.authScheme ?? "bearer",
        streamFormatOverride: ep.streamFormat,
      };
      const transport = new OpenAIProviderTransport(remoteProvider, finalModel, apiKey);
      const adapter = new OpenAIAPIFormat(finalModel);
      return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
        adapter,
        tokenStrategy: "delta-aware",
        ...ctx.sharedOpts,
      });
    }
    case "anthropic": {
      const remoteProvider: RemoteProvider = {
        name: ctx.provider.name,
        baseUrl,
        apiPath,
        apiKeyEnvVar: ctx.provider.apiKeyEnvVar,
        prefixes: ctx.provider.prefixes ?? [],
        headers: ep.headers,
        authScheme: ep.authScheme ?? "x-api-key",
        streamFormatOverride: ep.streamFormat,
      };
      const transport = new AnthropicProviderTransport(remoteProvider, apiKey);
      const adapter = new AnthropicAPIFormat(finalModel, ctx.provider.name);
      return new ComposedHandler(transport, ctx.targetModel, finalModel, ctx.port, {
        adapter,
        ...ctx.sharedOpts,
      });
    }
    case "gemini":
    case "ollamacloud": {
      // Phase 3 supports openai/anthropic/litellm transports. Gemini and
      // ollamacloud need dedicated transport classes that accept URL+key
      // directly — those signatures aren't currently available. Deferred.
      console.error(
        `[claudish] Custom endpoint '${ep.displayName}' uses transport='${ep.transport}' which is not yet supported by runtime registration. Use transport in {openai, anthropic, litellm}.`
      );
      return null;
    }
  }
}

/**
 * Resolve a custom endpoint's API key, expanding ${VAR_NAME} env var references.
 *
 * Resolution order:
 *  1. `${VAR_NAME}` → process.env[VAR_NAME] (empty string if unset).
 *  2. Anything else → returned as-is (a literal key).
 *
 * NOTE: `op://...` apiKeys are NOT resolved here. They are pre-resolved at
 * startup (index.ts `applyCustomEndpointOpKeys()`) via the SDK into the
 * `CUSTOM_<NAME>_KEY` env var, which `createHandler` reads FIRST. This keeps
 * this function synchronous (handler construction can't await the async SDK).
 * A bare `op://...` literal that reaches here (no pre-resolved env value) is
 * returned verbatim — which the upstream provider will reject as an invalid key.
 *
 * Exported for unit testing.
 */
export function resolveCustomEndpointApiKey(ep: CustomEndpoint): string {
  // Absent for `authScheme: "none"`, where the schema requires it to be omitted.
  // An empty string is the correct answer there: every transport treats a falsy
  // key as "emit no auth header".
  const literal = ep.apiKey ?? "";
  const match = literal.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/i);
  if (match) {
    return process.env[match[1]] ?? "";
  }
  return literal;
}

/**
 * The endpoint's CONFIG-DECLARED key, shaped for the credential authority's
 * sync chain (env → aliases → config.apiKeys → declared).
 *
 * Returns `undefined` — meaning "no declared key, keep resolving" — for:
 *  - an `op://` ref: the authority's ASYNC op-source step owns those (it resolves
 *    them into CUSTOM_<NAME>_KEY). Returning the literal ref here would satisfy
 *    the sync chain and short-circuit that step, signing requests with the
 *    string "op://…" → 401.
 *  - an unset `${VAR}`: resolveCustomEndpointApiKey yields "" — genuinely no
 *    credential, so the endpoint must stay unavailable.
 *
 * Exported for unit testing.
 */
export function resolveDeclaredEndpointKey(ep: CustomEndpoint): string | undefined {
  const declared = ep.apiKey?.trim();
  if (!declared) return undefined;
  if (declared.startsWith("op://")) return undefined;
  return resolveCustomEndpointApiKey(ep) || undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The synthesized `CUSTOM_<NAME>_KEY` env var for an endpoint name.
 *
 * Exported because a BUNDLED endpoint carries the vendor's own variable as its
 * primary and this spelling as an ALIAS, so the user-authored form keeps
 * working for a name that also ships. The two must be produced by one function
 * or a rename in either place silently stops honouring the other's variable.
 */
export function customEndpointKeyEnvVar(name: string): string {
  return `CUSTOM_${sanitizeEnvName(name)}_KEY`;
}

function sanitizeEnvName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
