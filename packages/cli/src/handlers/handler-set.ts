/**
 * The handler getters a proxy routes through, and their caches.
 *
 * Moved verbatim out of `createProxyServer` (where they were closures) so
 * more than one independent set can exist in a process: the session's own,
 * and the advisor's (`requestRole: "advisor"`), whose handlers write no
 * status-line token file, keep their own token counters and never share a
 * cached handler with a main request. Each set owns its caches; nothing here
 * is module state.
 *
 * Construction effects are the getters' own, unchanged: a remote handler
 * resolves its credential VALUE through the authority when first built, and a
 * profile factory may wait for the route registry. Nothing is built until a
 * getter is called.
 */

import { LocalModelAdapter } from "../adapters/local-adapter.js";
import { OpenRouterAPIFormat } from "../adapters/openrouter-api-format.js";
import { credentials } from "../auth/credentials/authority.js";
import { log, logStderr } from "../logger.js";
import { type ResolvedConnection, resolveConnection } from "../providers/connection-resolver.js";
import { declaredConnection, declaredWire } from "../providers/declared-wire.js";
import { parseModelSpec } from "../providers/model-parser.js";
import { createHandlerForProvider } from "../providers/provider-profiles.js";
import {
  createUrlProvider,
  parseUrlModel,
  resolveProvider,
} from "../providers/provider-registry.js";
import { resolveModelProvider } from "../providers/provider-resolver.js";
import { resolveRemoteProvider } from "../providers/remote-provider-registry.js";
import { LocalTransport } from "../providers/transport/local.js";
import { OpenRouterProviderTransport } from "../providers/transport/openrouter.js";
import { PoeProvider } from "../providers/transport/poe.js";
import { RefusingHandler } from "../providers/wire-handler.js";
import { ComposedHandler, type ComposedHandlerOptions } from "./composed-handler.js";
import type { ModelHandler } from "./types.js";

/** Request-shaping options every handler of a set receives. */
export type RequestShapingOpts = Pick<
  ComposedHandlerOptions,
  "effortOverride" | "modelParams" | "proOnUltracode" | "codeMode"
>;

export interface HandlerSetOptions {
  /** The session port; a handler's token tracker keys its file by it. */
  port: number;
  /** Whether the session is interactive (gates the consent prompt). */
  isInteractive?: boolean;
  /** Keeps the `[Auto-route]` notice off stderr. */
  quiet?: boolean;
  /** Summarize tool descriptions for local models. */
  summarizeTools?: boolean;
  /** Spread into every handler this set builds. */
  requestShapingOpts?: RequestShapingOpts;
  /** `"advisor"` for the advisor's set (`ComposedHandlerOptions.requestRole`); absent for the session's. */
  requestRole?: "advisor";
}

type InvocationMode = ComposedHandlerOptions["invocationMode"];

export interface HandlerSet {
  /** OpenRouter handler for a target model (a `RefusingHandler` when its wire is not chat). */
  openRouter(targetModel: string, invocationMode?: InvocationMode): ModelHandler;
  /** Legacy `poe:` handler; null without a Poe credential. */
  poe(targetModel: string, invocationMode?: InvocationMode): Promise<ModelHandler | null>;
  /** Local handler (`ollama/`, `lmstudio@`, a URL); null when the spec is not local. */
  local(targetModel: string, invocationMode?: InvocationMode): ModelHandler | null;
  /** Remote (direct API or profile) handler; null when none can be built. */
  remote(targetModel: string, invocationMode?: InvocationMode): Promise<ModelHandler | null>;
  readonly openRouterHandlers: Map<string, ModelHandler>;
  readonly localProviderHandlers: Map<string, ModelHandler>;
  readonly remoteProviderHandlers: Map<string, ModelHandler>;
  readonly poeHandlers: Map<string, ModelHandler>;
}

export function createHandlerSet(opts: HandlerSetOptions): HandlerSet {
  const { port } = opts;
  const options = {
    isInteractive: opts.isInteractive,
    quiet: opts.quiet,
    summarizeTools: opts.summarizeTools,
  };
  // The role rides the same spread as the shaping options, which every
  // construction site below (and `sharedOpts`) already applies.
  const requestShapingOpts: Pick<
    ComposedHandlerOptions,
    "effortOverride" | "modelParams" | "proOnUltracode" | "codeMode" | "requestRole"
  > = {
    ...opts.requestShapingOpts,
    ...(opts.requestRole ? { requestRole: opts.requestRole } : {}),
  };

  const openRouterHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> OpenRouter Handler
  const localProviderHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Local Provider Handler
  const remoteProviderHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Gemini/OpenAI Handler
  const poeHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Poe Handler

  // The catalog connection behind a gateway handler built here rather than by
  // a profile (OpenRouter, the legacy `poe:` prefix). Both speak Chat
  // Completions only, so a known wire on another API — or an unsupported one —
  // is refused rather than sent a chat body; an unknown wire keeps the
  // gateway's own handler.
  const chatWireConnection = (
    provider: string,
    modelId: string
  ): { connection?: ResolvedConnection; refusal?: string } => {
    const resolution = resolveConnection(provider, modelId);
    if (!resolution.ok) return {};
    const { connection } = resolution;
    const where = `${connection.route.routeId}/${connection.route.routeProfileId} · ${connection.externalModelId}`;
    if (connection.wire.status === "unsupported") {
      return {
        refusal: `${where} speaks ${connection.wire.protocol}, which claudish does not implement`,
      };
    }
    if (connection.wire.status !== "known") return {};
    if (connection.wire.api !== "chat-completions") {
      return {
        refusal: `${where} is published on ${connection.wire.api}, which this gateway handler does not speak`,
      };
    }
    return { connection };
  };

  // Helper to get or create OpenRouter handler for a target model
  const getOpenRouterHandler = (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): ModelHandler => {
    // For explicit @ syntax: strip provider prefix (openrouter@google/gemini → google/gemini)
    // For already-resolved vendor/model IDs (qwen/qwen3.5-plus-02-15): use as-is to preserve
    // the vendor prefix that OpenRouter requires. parseModelSpec() would otherwise strip it
    // (e.g. "qwen/" is a native pattern match → model becomes "qwen3.5-plus-02-15").
    const parsed = parseModelSpec(targetModel);
    const modelId = targetModel.includes("@") ? parsed.model : targetModel;

    if (!openRouterHandlers.has(modelId)) {
      const wired = chatWireConnection("openrouter", modelId);
      if (wired.refusal) {
        openRouterHandlers.set(modelId, new RefusingHandler(wired.refusal));
        return openRouterHandlers.get(modelId)!;
      }
      // The OpenRouter key is resolved through the credential authority inside
      // the transport's getHeaders() (single source of truth) — the legacy
      // openrouterApiKey param is no longer the signing source.
      const orProvider = new OpenRouterProviderTransport("", modelId);
      // A model the catalog does not publish on OpenRouter still gets a wire:
      // the documented default (chat, max_tokens, no reasoning field), never
      // the name-picked dialect.
      const connection =
        wired.connection ??
        declaredConnection(
          "openrouter",
          modelId,
          "https://openrouter.ai/api/v1",
          declaredWire("chat-completions", undefined)
        );
      const orAdapter = new OpenRouterAPIFormat(modelId, { vendor: connection.vendor ?? "" });
      openRouterHandlers.set(
        modelId,
        new ComposedHandler(orProvider, modelId, modelId, port, {
          adapter: orAdapter,
          isInteractive: options.isInteractive,
          invocationMode,
          ...requestShapingOpts,
          connection,
        })
      );
    }
    return openRouterHandlers.get(modelId)!;
  };

  // Helper to get or create Poe handler for a target model
  const getPoeHandler = async (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): Promise<ModelHandler | null> => {
    // Gate on the authority (env → config → op://), not a raw env read.
    if (!(await credentials.isAvailable("poe"))) {
      log(`[Proxy] Poe credentials not available, cannot use Poe model: ${targetModel}`);
      return null;
    }
    // Strip "poe:" prefix to get the actual model name for the API
    const modelId = targetModel.replace(/^poe:/, "");
    if (!poeHandlers.has(modelId)) {
      const wired = chatWireConnection("poe", modelId);
      if (wired.refusal) {
        poeHandlers.set(modelId, new RefusingHandler(wired.refusal));
        return poeHandlers.get(modelId)!;
      }
      const connection =
        wired.connection ??
        declaredConnection(
          "poe",
          modelId,
          "https://api.poe.com/v1",
          declaredWire("chat-completions", undefined)
        );
      // The transport resolves its key through the authority in getHeaders().
      const poeTransport = new PoeProvider();
      poeHandlers.set(
        modelId,
        new ComposedHandler(poeTransport, modelId, modelId, port, {
          isInteractive: options.isInteractive,
          invocationMode,
          ...requestShapingOpts,
          connection,
        })
      );
    }
    return poeHandlers.get(modelId)!;
  };

  // Helper to get or create Local Provider handler for a target model
  const getLocalProviderHandler = (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): ModelHandler | null => {
    if (localProviderHandlers.has(targetModel)) {
      return localProviderHandlers.get(targetModel)!;
    }

    // Check for prefix-based local provider (ollama/, lmstudio/, etc.)
    const resolved = resolveProvider(targetModel);
    if (resolved) {
      const provider = new LocalTransport(resolved.provider, resolved.modelName, {
        concurrency: resolved.concurrency,
      });
      const adapter = new LocalModelAdapter(resolved.modelName, resolved.provider.name);
      const handler = new ComposedHandler(provider, resolved.modelName, resolved.modelName, port, {
        adapter,
        tokenStrategy: "local",
        summarizeTools: options.summarizeTools,
        isInteractive: options.isInteractive,
        invocationMode,
        ...requestShapingOpts,
      });
      localProviderHandlers.set(targetModel, handler);
      log(
        `[Proxy] Created local provider handler: ${resolved.provider.name}/${resolved.modelName}${resolved.concurrency !== undefined ? ` (concurrency: ${resolved.concurrency})` : ""}`
      );
      return handler;
    }

    // Check for URL-based model (http://localhost:11434/llama3)
    const urlParsed = parseUrlModel(targetModel);
    if (urlParsed) {
      const providerConfig = createUrlProvider(urlParsed);
      const provider = new LocalTransport(providerConfig, urlParsed.modelName);
      const adapter = new LocalModelAdapter(urlParsed.modelName, providerConfig.name);
      const handler = new ComposedHandler(
        provider,
        urlParsed.modelName,
        urlParsed.modelName,
        port,
        {
          adapter,
          tokenStrategy: "local",
          summarizeTools: options.summarizeTools,
          isInteractive: options.isInteractive,
          invocationMode,
          ...requestShapingOpts,
        }
      );
      localProviderHandlers.set(targetModel, handler);
      log(
        `[Proxy] Created URL-based local provider handler: ${urlParsed.baseUrl}/${urlParsed.modelName}`
      );
      return handler;
    }

    return null;
  };

  // Helper to get or create remote provider handler (Gemini, OpenAI)
  // TODO: Consolidate src/ and packages/core/src/ - they're manually synced duplicates
  const getRemoteProviderHandler = async (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): Promise<ModelHandler | null> => {
    if (remoteProviderHandlers.has(targetModel)) {
      return remoteProviderHandlers.get(targetModel)!;
    }

    // Use centralized resolver with fallback logic
    const resolution = resolveModelProvider(targetModel);

    if (resolution.wasAutoRouted && resolution.autoRouteMessage) {
      // logStderr, NOT console.error: this fires PER REQUEST, i.e. while Claude
      // Code owns the inherited TTY. A raw console write here lands mid-frame.
      if (!options.quiet) {
        logStderr(`[Auto-route] ${resolution.autoRouteMessage}`);
      } else {
        log(`[Auto-route] ${resolution.autoRouteMessage}`);
      }
    }

    // If resolver says use OpenRouter (including fallback cases), create the handler
    // directly here so we can use the correctly-formatted fullModelId (e.g. "google/gemini-2.0-flash")
    // rather than the raw targetModel string.
    if (resolution.category === "openrouter") {
      if (resolution.wasAutoRouted && resolution.fullModelId) {
        return getOpenRouterHandler(resolution.fullModelId);
      }
      return null;
    }

    // When auto-routed (e.g. to LiteLLM), use the resolved fullModelId so that
    // resolveRemoteProvider() receives "litellm@gemini-2.0-flash" instead of the
    // original bare model name which would match the wrong (native) provider.
    const resolveTarget =
      resolution.wasAutoRouted && resolution.fullModelId ? resolution.fullModelId : targetModel;

    // If resolver says use direct-api, resolve credentials via the authority.
    if (resolution.category === "direct-api") {
      const resolved = resolveRemoteProvider(resolveTarget);
      if (!resolved) {
        // A KNOWN provider name that resolves to nothing has no endpoint: it
        // declares no static baseUrl, no set `baseUrlEnvVars`, and not
        // `buildsOwnEndpoint`. Say that here, because everything downstream of
        // this null (OpenRouter fallback, or a 400 on an explicit spec) reads as
        // "my key is missing" — which is how `vertex@` sent users looking for a
        // key that was never involved.
        log(
          `[Proxy] No remote provider resolved for "${resolveTarget}" — no endpoint is configured for it (not a credential problem)`
        );
        return null;
      }

      // Skip 'openrouter' provider here - it uses the existing OpenRouterHandler
      if (resolved.provider.name === "openrouter") {
        return null; // Will fall through to OpenRouterHandler
      }

      // Resolve the API key ON DEMAND via the credential authority — the SINGLE
      // source of truth. This pulls env → aliases → config → 1Password (lazy SDK)
      // and writes a resolved op:// key through to process.env. Providers that
      // need no auth (e.g. zen/ free) have no apiKeyEnvVar → empty key.
      let apiKey = "";
      // `authScheme: "none"` declares that this provider takes NO credential, so
      // the whole resolution block is skipped — including the anti-poison
      // `if (!apiKey) return null` at its end, which cannot otherwise tell
      // "a key was required and did not resolve" from "no key was ever wanted".
      //
      // Checked on apiKeyEnvVar's own condition rather than inside, because a
      // custom endpoint ALWAYS carries a synthesized `CUSTOM_<NAME>_KEY` — the
      // variable exists whether or not the endpoint authenticates, so its
      // presence cannot be the test. This was the last of four gates a keyless
      // endpoint hit: schema, definition, credential authority, and here.
      const needsNoAuth = resolved.provider.authScheme === "none";
      // Codex signs inside ComposedHandler on every request. Construction-time
      // signing would lease twice and let cold account-list failures escape that
      // classified boundary as a 500, before FallbackHandler can hold the hop.
      const signsPerRequest = resolved.provider.name === "openai-codex";
      if (signsPerRequest) {
        // Preserve the no-credential refusal without leasing. Failed readiness
        // must reach signing, where its typed error is classified for this turn.
        const readiness = await credentials.describeReadiness(resolved.provider.name);
        if (readiness.readiness === "absent") return null;
      }
      if (resolved.provider.apiKeyEnvVar && !needsNoAuth && !signsPerRequest) {
        // HARDENING: getRequestAuth THROWS for a name the authority never
        // registered (e.g. a runtime-renamed provider missing an alias), which
        // would surface as an HTTP 500. Degrade to the same "no credential"
        // path a missing key takes (null → explicit-spec routing reject → 400,
        // or bare-name fallback) — but warn on stderr so the registration gap
        // stays loud instead of silently masquerading as a missing key.
        if (!credentials.get(resolved.provider.name)) {
          logStderr(
            `[Proxy] No credential provider registered for "${resolved.provider.name}" — treating as missing credential (authority registration gap)`
          );
          log(
            `[Proxy] Credential authority has no provider registered under "${resolved.provider.name}"`
          );
          return null;
        }
        const auth = await credentials.getRequestAuth(resolved.provider.name, {
          model: resolved.modelName,
        });
        // Extract the bearer / x-api-key value back into the construction-time
        // key string createHandlerForProvider expects.
        apiKey =
          auth.headers.Authorization?.replace(/^Bearer\s+/i, "") || auth.headers["x-api-key"] || "";
        // ANTI-POISON: a provider that requires a key but resolved empty must NOT
        // be cached — return null (falls through to OpenRouter) so a key added
        // later (TUI hydrate-on-add, op:// resolve) is picked up on the next try.
        if (!apiKey) return null;
      }

      const handler = await createHandlerForProvider({
        provider: resolved.provider,
        modelName: resolved.modelName,
        apiKey,
        targetModel,
        port,
        sharedOpts: { isInteractive: options.isInteractive, invocationMode, ...requestShapingOpts },
      });
      if (!handler) {
        return null; // Profile returned null (missing config) or unknown provider
      }

      // Cache under both the original targetModel and the resolveTarget (if different)
      // so subsequent lookups with either key are served from cache.
      remoteProviderHandlers.set(resolveTarget, handler);
      if (resolveTarget !== targetModel) {
        remoteProviderHandlers.set(targetModel, handler);
      }
      return handler;
    }

    // If we get here, either category is not direct-api or key is not available
    // Both cases should fall through to OpenRouter or return null
    return null;
  };

  return {
    openRouter: getOpenRouterHandler,
    poe: getPoeHandler,
    local: getLocalProviderHandler,
    remote: getRemoteProviderHandler,
    openRouterHandlers,
    localProviderHandlers,
    remoteProviderHandlers,
    poeHandlers,
  };
}
