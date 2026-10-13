/**
 * Build the handler for a catalog connection from its `wire` and the route
 * registry (catalog 3.7.0): the API comes from `wire.api`, the URL from the
 * registry, and each request's output limit, reasoning, mode and speed from the
 * wire (`ComposedHandler` step 5w). A provider's own transport is kept only for
 * what is the provider's: authentication, identity headers and extra fields.
 *
 * Out of scope, and left to their own profiles: the dynamic subscriptions
 * (`gk@`, `ag@`, `dv@`), whose account decides what they serve and whose
 * connections the catalog publishes as `unknown`; Vertex, whose project is the
 * user's; and every provider without a route binding (local, LiteLLM, custom
 * endpoints).
 */
import type { Context } from "hono";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import type { BaseAPIFormat } from "../adapters/base-api-format.js";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { OpenRouterAPIFormat } from "../adapters/openrouter-api-format.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import { wrapAnthropicError } from "../handlers/shared/anthropic-error.js";
import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
import type { ModelHandler } from "../handlers/types.js";
import { log } from "../logger.js";
import { ensureRouteRegistryReady } from "./catalog-client.js";
import {
  type ResolvedConnection,
  connectionBaseUrl,
  resolveConnection,
  resolveRouteProfile,
} from "./connection-resolver.js";
import { type KnownWire, type WireApi, wireRequestUrl } from "./connection-wire.js";
import { getProviderByName } from "./provider-definitions.js";
import type { ProfileContext } from "./provider-profiles.js";
import { AnthropicProviderTransport } from "./transport/anthropic-compat.js";
import { GeminiProviderTransport } from "./transport/gemini-apikey.js";
import { OpenAICodexTransport } from "./transport/openai-codex.js";
import { OpenAIProviderTransport } from "./transport/openai.js";
import { OpenCodeZenMessagesTransport, OpenCodeZenTransport } from "./transport/opencode-zen.js";
import { OpenRouterProviderTransport } from "./transport/openrouter.js";
import { PoeProvider } from "./transport/poe.js";
import type { ProviderTransport } from "./transport/types.js";
import { TryInTurnHandler, apiOnlyWire } from "./wire-try-in-turn.js";

/** Providers whose requests are NOT built from catalog wires (see the header). */
const NOT_WIRE_ROUTED = new Set(["grok-subscription", "antigravity", "devin", "vertex"]);

const OPENCODE = new Set(["opencode-zen", "opencode-zen-go"]);

/**
 * The base URL a request goes to: the registry's, unless the user overrode the
 * provider's base URL (env or config), which is kept and logged. An override
 * with no path keeps the registry's path (`https://api.minimaxi.com` +
 * `/anthropic/v1`); one with a path is used as the whole base.
 */
export function effectiveBaseUrl(
  registryBaseUrl: string,
  definitionBaseUrl: string | undefined,
  resolvedBaseUrl: string | undefined
): { baseUrl: string; overridden: boolean } {
  if (!resolvedBaseUrl || !definitionBaseUrl || resolvedBaseUrl === definitionBaseUrl) {
    return { baseUrl: registryBaseUrl, overridden: false };
  }
  try {
    const override = new URL(resolvedBaseUrl);
    if (override.pathname === "/" || override.pathname === "") {
      return {
        baseUrl: `${override.origin}${new URL(registryBaseUrl).pathname}`,
        overridden: true,
      };
    }
  } catch {
    return { baseUrl: registryBaseUrl, overridden: false };
  }
  return { baseUrl: resolvedBaseUrl.replace(/\/+$/, ""), overridden: true };
}

/**
 * One line saying how a connection is called, for `--probe`: the API and URL,
 * the output-limit field, the reasoning encoding, and the modes and speeds it
 * offers. Every part is the wire's own value or its status, never derived.
 */
export function describeConnectionWire(connection: ResolvedConnection): string {
  const where = `${connection.route.routeId}/${connection.route.routeProfileId} · ${connection.externalModelId}`;
  const { wire } = connection;
  if (wire.status === "unsupported") return `${where}: unsupported (${wire.protocol})`;
  if (wire.status === "unknown") {
    const apis = Object.keys(connection.profile.apis).join(", ") || "none";
    return `${where}: wire unknown — tries ${apis} in turn`;
  }
  const base = connectionBaseUrl(connection, wire.api);
  const url = base ? wireRequestUrl(base, wire.api, connection.externalModelId) : "no base URL";
  const status = (value: string | { status: string }) =>
    typeof value === "string" ? value : value.status;
  const parts = [`${wire.api} ${url}`, `limit ${status(wire.tokenParam)}`];
  const reasoning = wire.reasoning;
  if (reasoning.status === "supported") {
    const effort = reasoning.effort;
    parts.push(
      "path" in effort
        ? `effort ${effort.path} [${Object.keys(effort.values).join(",")}]`
        : `effort ${effort.status}`
    );
    if (reasoning.mode.status === "supported") {
      parts.push(`modes ${Object.keys(reasoning.mode.values).join(",")}`);
    }
  } else {
    parts.push(`reasoning ${reasoning.status}`);
  }
  if (wire.speed.status === "supported")
    parts.push(`speeds ${Object.keys(wire.speed.values).join(",")}`);
  return `${where}: ${parts.join(" · ")}`;
}

/** Pin a transport's endpoint to `url`, delegating everything else to it. */
function withEndpoint(inner: ProviderTransport, url: string): ProviderTransport {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "getEndpoint") return () => url;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function adapterFor(
  api: WireApi,
  modelName: string,
  providerName: string,
  definitionName: string,
  vendor: string | undefined
): BaseAPIFormat {
  switch (api) {
    case "chat-completions":
      return definitionName === "openrouter"
        ? new OpenRouterAPIFormat(modelName, { vendor: vendor ?? "" })
        : new OpenAIAPIFormat(modelName);
    case "responses":
      return new CodexAPIFormat(modelName, undefined, {
        codexExtras: definitionName === "openai-codex",
      });
    case "anthropic-messages":
      return new AnthropicAPIFormat(modelName, providerName);
    case "gemini":
      return new GeminiAPIFormat(modelName);
  }
}

/**
 * The provider's own transport for `api`: who signs, which identity headers,
 * which extra fields. Its endpoint is replaced by the registry URL, except
 * Codex, whose host is decided by the credential that signs (OAuth →
 * chatgpt.com, API key → api.openai.com; `routing.md`).
 */
function transportFor(
  definitionName: string,
  api: WireApi,
  ctx: ProfileContext,
  url: string
): ProviderTransport {
  if (definitionName === "openai-codex") {
    return new OpenAICodexTransport(ctx.provider, ctx.modelName, ctx.apiKey);
  }
  let inner: ProviderTransport;
  if (api === "anthropic-messages") {
    const provider: RemoteProvider = OPENCODE.has(definitionName)
      ? { ...ctx.provider, authScheme: "x-api-key" }
      : ctx.provider;
    inner = OPENCODE.has(definitionName)
      ? new OpenCodeZenMessagesTransport(provider, ctx.apiKey)
      : new AnthropicProviderTransport(provider, ctx.apiKey);
  } else if (api === "gemini" && definitionName === "google") {
    inner = new GeminiProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey);
  } else if (OPENCODE.has(definitionName)) {
    inner = new OpenCodeZenTransport(ctx.provider, ctx.modelName, ctx.apiKey);
  } else if (definitionName === "openrouter") {
    inner = new OpenRouterProviderTransport(ctx.apiKey, ctx.modelName);
  } else if (definitionName === "poe") {
    inner = new PoeProvider();
  } else {
    inner = new OpenAIProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey);
  }
  return withEndpoint(inner, url);
}

/**
 * A handler that sends nothing and answers every request with `message`.
 *
 * Returned for a connection that must not be called, instead of `null`: a null
 * handler falls through to the OpenRouter fallback, which is exactly the
 * silent substitution the wire reader exists to end. 400 because the request,
 * not the network, is what cannot be served.
 */
export class RefusingHandler implements ModelHandler {
  constructor(private readonly message: string) {}

  async handle(): Promise<Response> {
    log(`[Wire] refused: ${this.message}`);
    return new Response(
      JSON.stringify(wrapAnthropicError(400, `claudish: ${this.message}`, "invalid_request_error")),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  async shutdown(): Promise<void> {}
}

/**
 * How long building a catalog handler waits for a refresh that writes the
 * route registry. A full refresh (model pages, plans, registry) measured 9.3s
 * on 2026-10-12; the old 5s wait refused the first requests after an upgrade.
 */
const CATALOG_WAIT_MS = 30_000;

/**
 * The handler for a catalog provider while no route registry is readable:
 * each request waits for the refresh again and builds the real handler once
 * it can, answering with the refusal only for the requests that still find
 * no catalog. Never a cached refusal.
 */
export class CatalogPendingHandler implements ModelHandler {
  private built?: ModelHandler;

  constructor(
    private readonly ctx: ProfileContext,
    private readonly definitionName: string,
    private readonly message: string
  ) {}

  async handle(c: Context, payload: any): Promise<Response> {
    if (!this.built) {
      const outcome = await buildWireHandler(this.ctx, this.definitionName);
      if (outcome.kind === "handler" && !(outcome.handler instanceof CatalogPendingHandler)) {
        this.built = outcome.handler;
      } else {
        return new RefusingHandler(
          outcome.kind === "refused" ? outcome.message : this.message
        ).handle();
      }
    }
    return this.built.handle(c, payload);
  }

  async shutdown(): Promise<void> {
    await this.built?.shutdown();
  }
}

export type WireHandlerOutcome =
  /** Built from the wire, or a {@link TryInTurnHandler} when the wire is unknown. */
  | { kind: "handler"; handler: ModelHandler }
  /** Not a wire-routed provider: the caller builds its handler as before. */
  | { kind: "not-wire-routed" }
  /** The request must not be sent; `message` says why. */
  | { kind: "refused"; message: string };

export async function buildWireHandler(
  ctx: ProfileContext,
  definitionName: string
): Promise<WireHandlerOutcome> {
  if (NOT_WIRE_ROUTED.has(definitionName)) return { kind: "not-wire-routed" };

  let resolution = resolveConnection(definitionName, ctx.modelName, ctx.catalogCachePath);
  if (resolution.ok === false && resolution.reason === "not-catalog-routed") {
    return { kind: "not-wire-routed" };
  }
  if (
    resolution.ok === false &&
    (resolution.reason === "no-catalog" || resolution.reason === "no-registry") &&
    // A cache path is the test seam: a fixture is never refreshed from the network.
    !ctx.catalogCachePath
  ) {
    await ensureRouteRegistryReady(CATALOG_WAIT_MS);
    resolution = resolveConnection(definitionName, ctx.modelName, ctx.catalogCachePath);
  }
  if (resolution.ok === false) {
    if (resolution.reason === "no-catalog" || resolution.reason === "no-registry") {
      const message =
        `the cloud models catalog (with its route registry) is not available, so ${definitionName}@${ctx.modelName} ` +
        "cannot be called: claudish sends catalog providers nothing it was not told. Run `claudish --models-refresh`; local models still work.";
      // A fixture says what it says. In production the refresh may simply
      // not have finished: the proxy caches handlers per model, so a refusal
      // returned here would outlive the refresh for the whole session.
      if (ctx.catalogCachePath) return { kind: "refused", message };
      return { kind: "handler", handler: new CatalogPendingHandler(ctx, definitionName, message) };
    }
    // The catalog does not publish this model on this provider (a model newer
    // than the generation, or one only the account knows). The route profile
    // still says which APIs the host serves: try them in turn.
    const profile = resolveRouteProfile(definitionName, ctx.catalogCachePath);
    if (!profile) return { kind: "not-wire-routed" };
    const unpublished: ResolvedConnection = {
      provider: definitionName,
      modelId: ctx.modelName,
      route: profile.route,
      externalModelId: ctx.modelName,
      wire: { status: "unknown", evidence: [] },
      profile: profile.profile,
      generationId: profile.generationId,
    };
    return tryInTurn(ctx, definitionName, unpublished, "not published for this provider");
  }

  const connection = resolution.connection;
  const { wire } = connection;
  if (wire.status === "unsupported") {
    return {
      kind: "refused",
      message:
        `${connection.route.routeId}/${connection.route.routeProfileId} · ${connection.externalModelId} speaks ` +
        `${wire.protocol}, which claudish does not implement`,
    };
  }
  if (wire.status === "unknown") return tryInTurn(ctx, definitionName, connection, "wire unknown");

  const handler = buildKnownWireHandler(ctx, definitionName, connection, wire);
  return handler
    ? { kind: "handler", handler }
    : tryInTurn(ctx, definitionName, connection, `no base URL for ${wire.api}`);
}

function tryInTurn(
  ctx: ProfileContext,
  definitionName: string,
  connection: ResolvedConnection,
  why: string
): WireHandlerOutcome {
  const label = `${connection.route.routeId}/${connection.route.routeProfileId} · ${connection.externalModelId}`;
  const apis = Object.keys(connection.profile.apis) as WireApi[];
  if (apis.length === 0) {
    return { kind: "refused", message: `${label}: ${why}, and its route profile publishes no API` };
  }
  log(`[Wire] ${label}: ${why} — trying ${apis.join(", ")} in turn (a catalog gap)`);
  const key = `${connection.generationId}|${label}`;
  return {
    kind: "handler",
    handler: new TryInTurnHandler(key, label, apis, (api) => {
      const wire = apiOnlyWire(api);
      return buildKnownWireHandler(ctx, definitionName, { ...connection, wire }, wire);
    }),
  };
}

export function buildKnownWireHandler(
  ctx: ProfileContext,
  definitionName: string,
  connection: ResolvedConnection,
  wire: KnownWire
): ModelHandler | null {
  const registryBase = connectionBaseUrl(connection, wire.api);
  if (!registryBase) return null;
  const definition = getProviderByName(definitionName);
  const { baseUrl, overridden } = effectiveBaseUrl(
    registryBase,
    definition?.baseUrl,
    ctx.provider.baseUrl
  );
  const url = wireRequestUrl(baseUrl, wire.api, connection.externalModelId);
  if (overridden) log(`[Wire] ${definitionName}: base URL overridden by user config → ${baseUrl}`);

  const transport = transportFor(definitionName, wire.api, ctx, url);
  const adapter = adapterFor(
    wire.api,
    ctx.modelName,
    ctx.provider.name,
    definitionName,
    connection.vendor
  );
  const handler = new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
    adapter,
    ...(wire.api === "chat-completions" || wire.api === "responses"
      ? { tokenStrategy: "delta-aware" as const }
      : {}),
    ...ctx.sharedOpts,
    connection,
  });
  log(
    `[Wire] ${definitionName}@${ctx.modelName} → ${connection.route.routeId}/${connection.route.routeProfileId} · ` +
      `${connection.externalModelId}: ${wire.api} ${definitionName === "openai-codex" ? "(credential-decided host)" : url} ` +
      `[generation ${connection.generationId}]`
  );
  return handler;
}
