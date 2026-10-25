import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import type { IncomingMessage, ServerResponse } from "node:http";
import { log, logStderr } from "./logger.js";
import type { ProxyServer } from "./types.js";
// #587/#615 — lag-probe read windows, module-level so the retirement pin can
// shorten them (a 60 s window cannot expire inside a test); /health reads
// these at CALL TIME, never a cached value.
export const lagProbeWindows = { maxMs: 60_000, blockedMs: 300_000 };
import { NativeHandler, stripProxyOwnHeaders } from "./handlers/native-handler.js";
import {
  nativeAuthHeaderNames,
  nativeCredentialRefusalResponse,
  nativeCredentialRefusalShape,
  nativeHeaderNamesLogEnabled,
  stripForeignCredentialBesideAnthropic,
} from "./handlers/shared/native-credential-guard.js";
import { OpenRouterProviderTransport } from "./providers/transport/openrouter.js";
import { OpenRouterAPIFormat } from "./adapters/openrouter-api-format.js";
import { LocalTransport } from "./providers/transport/local.js";
import { LocalModelAdapter } from "./adapters/local-adapter.js";
import { PoeProvider } from "./providers/transport/poe.js";
import type { ModelHandler } from "./handlers/types.js";
import { ComposedHandler, isOverloadWalkClass, isConnectionWalkClass, setVisionAuthPolicy, type ComposedHandlerOptions } from "./handlers/composed-handler.js";
import {
  resolveProvider,
  parseUrlModel,
  createUrlProvider,
} from "./providers/provider-registry.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { API_KEY_MAP } from "./providers/api-key-map.js";
import { resolveRemoteProvider } from "./providers/remote-provider-registry.js";
import { resolveModelProvider } from "./providers/provider-resolver.js";
import { warmPricingCache } from "./services/pricing-cache.js";
import { warmRecommendedModels } from "./model-loader.js";
import {
  resolveModelNameSync,
  logResolution,
  warmAllCatalogs,
  ensureCatalogReady,
} from "./providers/model-catalog-resolver.js";
import { FallbackHandler } from "./handlers/fallback-handler.js";
import type { FallbackCandidate } from "./handlers/fallback-handler.js";
import { wrapAnthropicError } from "./handlers/shared/anthropic-error.js";
import { isKeylessExempt, keylessRefusalMessage } from "./handlers/shared/keyless-exempt.js";
import { resolveProxyKeys, matchesProxyKey } from "./handlers/shared/proxy-keys.js";
import {
  initProxyKeyRotationTracking,
  noteProxyKeyAuthentication,
  previousKeyHitsSnapshot,
} from "./handlers/shared/proxy-key-rotation.js";
import { admissionFreezeState } from "./handlers/shared/admission-freeze.js";
import {
  describeRoutingRuleProblem,
  effectiveDefaultProvider,
  loadRoutingRuleSources,
  loadRoutingRules,
  loadUserRoutingRules,
  matchUserRoutingOverride,
  route,
  routingRuleProblems,
} from "./providers/routing-rules.js";
import { createHandlerForProvider } from "./providers/provider-profiles.js";
import { applyNativePinOverride } from "./providers/native-pin-auto.js";
import { loadCustomEndpoints } from "./providers/custom-endpoints-loader.js";
import { deriveContextLimits, purgeCapsReplacedByDerivation } from "./providers/context-limit-derivation.js";
import { getRuntimeProviders, getDeclaredContextLimit } from "./providers/runtime-providers.js";
import { loadConfig } from "./profile-config.js";
import { createStreamTracker, stallThresholdMs } from "./fork/server/stream-registry";
import { registerForkExtensions, resolveInboundKeys, stripBillingHeaderFromBody, logRequest, createHostnameConfig } from "./fork/index.js";
import { collectRoutedBareNames } from "./fork/middleware/proxy-auth.js";
import { forwardToUpstream, readRequestBody, relayHealthFields, requestLoopedBack, HOPS_HEADER, type RelayState } from "./fork/server/relay.js";
import { getInstanceId } from "./instance-id.js";
import {
  initFailover,
  isFailoverActive,
  isQuotaExhaustion,
  isWiringError,
  roleFromModelName,
  getFailoverRule,
  machineArmBucket,
  classifyNominalBucket,
  providerBucketOf,
  resolveFailoverTargetForSession,
  resolveDelegationOwner,
  resolveDelegationExcluding,
  delegationCandidateBound,
  type DelegationOwner,
  setRoleNominalResolver,
  setRoleNominalBucketResolver,
  markStepFailed,
  earliestWalledReprobeAt,
  ARM_TTL_MAX_MS,
  NATIVE_BUCKET,
  parseResetAtFromBody,
  resetStepSuccess,
  resolveTransientStep,
  onNominalSuccess,
  onNominalRefusal,
  getArmGraceMs,
  extractSessionKey,
  recordServedStepForNotices,
  servedStepForNotices,
  type FailoverRole,
} from "./fork/failover.js";
import {
  admitSessionBudget,
  openSessionBudgetAttempt,
  sessionBudgetRefusalAnthropic,
} from "./fork/session-budget.js";
import {
  encodeStepSkipHeader,
  readStepSkip,
  stepSkipDisabled,
  readStepBusyWaitMs,
  markCascadeStepAttempt,
} from "./handlers/shared/step-skip.js";
import {
  endpointPrefixOf,
  evaluateEndpointTokenBudget,
  formatBudgetFacts,
  withBudgetRelease,
} from "./handlers/shared/endpoint-token-budget.js";
import {
  decideContextAdmission,
  contextAdmissionRefusalText,
  contextAdmissionDisabled,
  buildOverflowRecoveryStream,
  buildOverflowRecoveryMessage,
  initOverflowCapsPersistence,
  type ContextAdmissionDecision,
  type DeclaredWindow,
} from "./handlers/shared/context-overflow.js";
import {
  appendCapabilityQueryToMessage,
  isCapabilityVocabEnabled,
  liftCapabilityDeclaration,
} from "./fork/capability-vocabulary.js";
import { executeWebSearch, executeWebFetch, isLowQualityWebContent, extractUrlFromWebContent, cleanRawWebContent } from "./handlers/shared/web-search-executor.js";
import { convertOpenAIRequestToAnthropic } from "./handlers/shared/format/openai-request-to-anthropic.js";
import { anthropicMessageToChatCompletion, createOpenAIChatStreamFromAnthropic } from "./handlers/shared/anthropic-to-openai.js";
import {
  applyFailoverNotices,
  carryNoticeHeader,
  noticePolicyForIngress,
} from "./handlers/shared/failover-stream-notice.js";

/**
 * Routing failures are TERMINAL — no provider can serve the request (missing
 * credential, empty chain, unknown model). They must surface to the client as a
 * non-retryable HTTP 400, not a retryable 500: a 500 makes Claude Code loop on
 * "API error · Retrying · attempt N/10" and hide the real cause. Tagging the
 * error lets the request handlers map it to 400 with the actionable message.
 * (Absorbed from upstream bbb448f6.)
 */
class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * Intercept WebSearch/WebFetch tool calls and execute them via SearXNG instead
 * of forwarding to the provider. Returns a streaming response with SearXNG results.
 *
 * Claude Code's WebSearch tool sends a sub-agent request with a single user message:
 *   "Perform a web search for the query: <query>"
 * We intercept this, execute SearXNG, and return the results as text.
 */
/**
 * #348: the overload walk's remaining-patience budget, in ms. Default 300 s —
 * see the walk branch for the 360 s relay-deadline / 600 s client-timeout
 * arithmetic. Read per request like CLAUDISH_FAILOVER_OVERLOAD_WALK; only an
 * explicit `0` disables the bound. NO client-gone check exists — a client
 * abort is undetectable on this stack pre-write (W16 pins the negative
 * result; the budget alone bounds a walk into an abandoned request).
 */
const WALK_BUDGET_DEFAULT_MS = 300_000;
function readWalkBudgetMs(): number {
  const raw = Number.parseInt((process.env.CLAUDISH_FAILOVER_WALK_BUDGET_MS || "").trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : WALK_BUDGET_DEFAULT_MS;
}

async function interceptWebTools(c: any, body: any): Promise<Response | null> {
  const messages = body.messages || [];
  const isStreaming = body.stream === true;

  // Case 1: Sub-agent web search request (1 message, user role, starts with "Perform a web search")
  if (messages.length === 1 && messages[0].role === "user") {
    const text = typeof messages[0].content === "string"
      ? messages[0].content
      : Array.isArray(messages[0].content)
        ? messages[0].content.map((b: any) => b.text || "").join("")
        : "";

    const searchMatch = text.match(/^Perform a web search for the query:\s*(.+)$/s);
    if (searchMatch) {
      const query = searchMatch[1].trim();
      log(`[WebTools] Intercepted sub-agent web search: "${query}"`);
      // Total budget for 2 attempts (5s/attempt, dimensioned from measured
      // p95 ≈ 3s — roo-extensions #3388). This is a sub-agent request, not a
      // mid-stream call, so the extra retry budget is safe to spend.
      const results = await executeWebSearch(query, 8000);
      log(`[WebTools] SearXNG results: ${results.slice(0, 100)}...`);
      return buildTextResponse(body.model || "unknown", results, isStreaming);
    }

    const fetchMatch = text.match(/^Perform a web fetch for the URL:\s*(.+)$/s);
    if (fetchMatch) {
      const url = fetchMatch[1].trim();
      log(`[WebTools] Intercepted sub-agent web fetch: "${url}"`);
      // Real fetch with graceful degradation:
      // MCP web_url_read → MCP via r.jina.ai → direct HTTP → error text.
      const resultText = await executeWebFetch(url, 10_000);
      return buildTextResponse(body.model || "unknown", resultText, isStreaming);
    }

    // Case 3: Claude Code already fetched the page and sends raw HTML/markdown
    // to a sub-agent for analysis. Format: "Web page content:\n---\n<content>"
    // This happens when Claude Code's native WebFetch tool fetches the page
    // itself, converts to markdown poorly, and delegates to a sub-agent.
    const webContentMatch = text.match(/^Web page content:\s*\n---\n([\s\S]+)$/);
    if (webContentMatch) {
      const rawContent = webContentMatch[1];
      if (isLowQualityWebContent(rawContent)) {
        log(`[WebTools] Detected low-quality web content in sub-agent, attempting re-fetch`);
        const url = extractUrlFromWebContent(rawContent);
        if (url) {
          log(`[WebTools] Re-fetching "${url}" via clean pipeline`);
          const cleanContent = await executeWebFetch(url, 10_000);
          return buildTextResponse(body.model || "unknown", cleanContent, isStreaming);
        }
        // No URL extractable — clean the raw content as best we can
        log(`[WebTools] No URL found, cleaning raw web content`);
        const cleaned = cleanRawWebContent(rawContent);
        return buildTextResponse(body.model || "unknown", cleaned, isStreaming);
      }
      // Content looks reasonable — let it through to the normal handler
      return null;
    }
  }

  // Case 2: tool_use in last assistant message for WebSearch/WebFetch
  const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
  if (lastAssistant?.content) {
    const content = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
    const webToolCalls = content.filter(
      (b: any) => b.type === "tool_use" && (b.name === "WebSearch" || b.name === "WebFetch")
    );
    if (webToolCalls.length > 0) {
      log(`[WebTools] Intercepting ${webToolCalls.length} tool_use WebSearch/WebFetch`);
      // For now, let these fall through to the normal handler
      // (they'll be handled by the stream parser's searchWeb detection)
    }
  }

  return null;
}

function buildTextResponse(model: string, text: string, streaming: boolean): Response {
  const encoder = new TextEncoder();
  const send = (event: string, data: any) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (!streaming) {
    // Non-streaming JSON response
    return new Response(JSON.stringify({
      id: `msg_webtools_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }), {
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
    });
  }

  // Streaming SSE response
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(send("message_start", {
        type: "message_start",
        message: {
          id: `msg_webtools_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }));

      controller.enqueue(send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }));

      controller.enqueue(send("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      }));

      controller.enqueue(send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      }));

      controller.enqueue(send("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "anthropic-version": "2023-06-01",
    },
  });
}

/**
 * Build an assistant response with web tool results as text blocks.
 *
 * IMPORTANT: We must NOT use tool_result blocks here. In the Anthropic API,
 * tool_result blocks are only valid in messages with role: "user". Returning
 * them in an assistant message (role: "assistant") causes the client to store
 * malformed conversation history, leading to 400 errors on subsequent requests:
 *   "tool_result blocks can only be in user messages"
 *
 * Instead, we inject the search/fetch results as a text block in a normal
 * assistant response — the same approach used by openai-sse.ts suppression.
 */
function buildToolResultResponse(model: string, toolResults: any[], streaming: boolean): Response {
  const encoder = new TextEncoder();
  const send = (event: string, data: any) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Combine all tool results into a single text block
  const combinedText = toolResults.map((tr) => tr.content).join("\n\n");

  if (!streaming) {
    return new Response(JSON.stringify({
      id: `msg_webtools_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: combinedText }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }), {
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
    });
  }

  // Streaming SSE response — emit results as a text content block
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(send("message_start", {
        type: "message_start",
        message: {
          id: `msg_webtools_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }));

      controller.enqueue(send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: combinedText },
      }));

      controller.enqueue(send("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      }));

      controller.enqueue(send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      }));

      controller.enqueue(send("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "anthropic-version": "2023-06-01",
    },
  });
}

export type RoleModelMap = {
  opus?: string;
  sonnet?: string;
  haiku?: string;
  fable?: string;
  subagent?: string;
};

/**
 * The native-lane predicate: a bare model name with neither an explicit provider
 * (`@`) nor a vendor path (`/`) prefix. Exported so the route pin in
 * `proxy-server-role-map.test.ts` composes the SAME test the router applies —
 * a re-expressed predicate in the test would pin the wrong route.
 */
export function isNativeTarget(target: string): boolean {
  return !target.includes("/") && !target.includes("@");
}

/**
 * What `CLAUDISH_NO_ANTHROPIC` does to a target that landed on the native lane.
 *
 * Extracted from `getHandlerForRequest` so the rule is pinnable without booting a
 * proxy (#613 review, point 1c). It matters beyond leak policy: it is the second
 * half of the hub's answer to a role-shaped request, and the relay deep probe
 * depends on it (see `deepProbe` in fork/server/relay.ts). A `haiku` mapping that
 * is UNSET or names a `claude-*` id leaves the target native, so this returns
 * `reroute` to `modelMap.sonnet` — the probe then measures the sonnet lane, not
 * the haiku one, which is a precondition and not a defect here.
 *
 * Only ever called from the `isNative` branch — the caller keeps both the env
 * truthiness test (an empty `CLAUDISH_NO_ANTHROPIC`, ai-01's exemption,
 * materialized empty by compose, must never reach this function) and
 * {@link isNativeTarget}.
 */
export function noAnthropicDecision(
  modelMap: RoleModelMap | undefined,
  opts: { depth: number }
): { kind: "allow" } | { kind: "reroute"; to: string } | { kind: "refuse" } {
  if (opts.depth === 0 && modelMap?.sonnet) return { kind: "reroute", to: modelMap.sonnet };
  // depth > 0 (the budget mapping itself resolved native → misconfig) or no
  // sonnet mapping: fail closed. Never leak.
  return { kind: "refuse" };
}

/** Resolve a Claude Code role name without coupling the mapping to a model version. */
export function resolveRoleMappedModel(
  requestedModel: string,
  modelMap?: RoleModelMap
): string | undefined {
  if (!modelMap) return undefined;
  const requested = requestedModel.toLowerCase();
  if (requested.includes("opus")) return modelMap.opus;
  if (requested.includes("sonnet")) return modelMap.sonnet;
  if (requested.includes("haiku")) return modelMap.haiku;
  if (requested.includes("fable")) return modelMap.fable;
  return undefined;
}

/**
 * Native-lane version pin: which Anthropic model id the body must carry.
 *
 * `resolveRoleMappedModel` decides the LANE (native vs a budget provider); on the
 * native lane it historically decided nothing else, because `NativeHandler.handle`
 * forwards `payload.model` verbatim (native-handler.ts: `const target = payload.model`)
 * and the resolved target never reached the wire. A `modelMap.opus` naming a specific
 * Anthropic version was therefore a no-op on the version axis — measured 2026-09-22 on
 * the hub: the map read `claude-opus-4-8` for weeks while 6 487 consecutive native
 * responses in 48 h were served as `claude-opus-5`, the id the clients named. That is
 * the natural experiment; the entry classified the lane and pinned nothing.
 *
 * This function closes that gap, so `modelMap.opus` means what it reads like: every
 * request the fleet routes to the native lane for a role is served by the version the
 * hub configures, without touching any client's own config.
 *
 * Deliberately narrow — it returns a pin ONLY when all of these hold:
 *  - the role resolves to a mapped target (otherwise there is nothing to pin);
 *  - that target differs from what the client asked for (never rewrite a no-op);
 *  - the target is an ANTHROPIC id (`claude-*`). Bare and native are NOT the same
 *    predicate, and conflating them is how this would misfire: the hub's own
 *    `sonnet: "glm-5.3"` is bare too, and is saved today only by resolving to a
 *    remote handler. Drop `glm-5.3` from the routing table and `isNative`
 *    (`!includes("/") && !includes("@")`) calls it native — at which point a pin
 *    without this guard would put `glm-5.3` on the Anthropic wire. Plain
 *    passthrough would have sent a real Claude id, so a loose guard here is
 *    strictly worse than no pin at all. Every native-lane model is `claude-*`;
 *  - the REQUESTED model is bare too, so an explicit `zai@claude-opus-5` — a
 *    deliberate provider route that merely contains a role keyword — is left alone.
 *
 * Kill switch `CLAUDISH_NATIVE_MODEL_PIN=0` restores the pre-pin passthrough. It is
 * read per request, on purpose: the same rationale as the thinking flags — the fleet
 * must be able to flip it without restarting the proxy that is at that moment keeping
 * everyone working.
 */
export function resolveNativeModelPin(
  requestedModel: string,
  modelMap?: RoleModelMap,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (env.CLAUDISH_NATIVE_MODEL_PIN === "0") return undefined;
  if (requestedModel.includes("@") || requestedModel.includes("/")) return undefined;
  const roleTarget = resolveRoleMappedModel(requestedModel.toLowerCase(), modelMap);
  if (!roleTarget || roleTarget === requestedModel) return undefined;
  if (!roleTarget.startsWith("claude-")) return undefined;
  // #219: an adopted catalog override (CLAUDISH_NATIVE_PIN_AUTO=on) replaces
  // the version within the same family. Inert — byte-identical pass-through —
  // unless the watch resolved and adopted a newer id.
  return applyNativePinOverride(roleTarget);
}

export interface ProxyServerOptions {
  summarizeTools?: boolean; // Summarize tool descriptions for local models
  quiet?: boolean; // Suppress informational stderr output (e.g., [Auto-route])
  isInteractive?: boolean; // Whether the current session is interactive (gates consent prompt)
  advisorModels?: string[]; // Advisor models from --advisor flag
  advisorCollector?: string | null; // Collector model (null = no synthesis)
  hostname?: string; // Bind address (default: "127.0.0.1", use "0.0.0.0" for Docker) — fork extension
  relay?: RelayState; // Sidecar relay state — fork extension. Undefined → this process is the hub (always local).
}

export async function createProxyServer(
  port: number,
  openrouterApiKey?: string,
  model?: string,
  monitorMode: boolean = false,
  anthropicApiKey?: string,
  modelMap?: RoleModelMap,
  options: ProxyServerOptions = {}
): Promise<ProxyServer> {
  // Resolve proxy keys early — needed for both auth middleware and NativeHandler.
  // CLAUDISH_PROXY_KEY_PREVIOUS keeps the retiring key accepted during a
  // rotation window (see handlers/shared/proxy-keys.ts); unset = single key.
  const loadedConfig = loadConfig();
  const previousProxyKey = process.env.CLAUDISH_PROXY_KEY_PREVIOUS || loadedConfig.proxyKeyPrevious;
  const proxyKeys = resolveProxyKeys(
    process.env.CLAUDISH_PROXY_KEY || loadedConfig.proxyKey,
    previousProxyKey
  );
  // #439 — while a rotation window is open, count per-bucket hits of the
  // retiring key so the window can be closed by measurement, not by cutting
  // blind (init with an empty previous leaves the tracker inert).
  initProxyKeyRotationTracking(previousProxyKey);

  // #400 — scoped inbound keys (external consumers): same ingress as the proxy
  // key but gated to an allowlist of models, so subscriptions stay
  // fleet-internal. Same lifecycle as customEndpoints: config read once per
  // proxy lifetime (bind-mounted config.json, picked up at restart/recreate).
  // Invalid entries were already warned+skipped inside the resolver.
  const inboundKeys = resolveInboundKeys(loadedConfig, proxyKeys);

  // #410 — bare names that resolve to a non-native route; keeps them off the
  // Anthropic pass-through exemption in the auth middleware.
  const routedBareNames = collectRoutedBareNames(loadedConfig);

  // Budget failover config (fork extension). Inert with no CLAUDISH_FAILOVER_*
  // env; when set, diverts a whole role to another pool and announces it at the
  // next condensation. Read once per proxy lifetime. See fork/failover.ts.
  initFailover();

  // #274: the failover module needs each role's NOMINAL routing target to
  // resolve a `role:` cascade step (modelMap is the owner). The reverse mapping
  // of resolveRoleMappedModel — a role whose modelMap entry is unset has no
  // known nominal, and the delegation falls to that role's own cascade.
  setRoleNominalResolver((r) => modelMap?.[r]);

  // Load user-declared custom endpoints from ~/.claudish/config.json and
  // register them in the runtime provider registry so they appear in lookups
  // and handler creation. Runs once per proxy lifetime; idempotent.
  try {
    const customEpResult = loadCustomEndpoints(loadConfig());
    if (customEpResult.registered > 0) {
      log(
        `[Proxy] Registered ${customEpResult.registered} custom endpoint(s) from config`
      );
    }
    for (const err of customEpResult.errors) {
      // logStderr, NOT console.error: stderr under a relayed session is Claude
      // Code's TTY, and this must also reach the durable log file. (218c3586.)
      logStderr(
        `[claudish] customEndpoints['${err.name}'] failed validation: ${err.message}`
      );
    }
  } catch (err) {
    // Config read failure should not crash the proxy — the rest of startup
    // continues and users get the default (builtin-only) set of providers.
    log(`[Proxy] customEndpoints load skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // #651 — two pieces of context-window state that must not depend on a human
  // retyping them, nor on this process staying alive.
  //
  // (1) The LEARNED cap, restored before any request is served. It lived in
  //     memory only, so a recreate forgot it and reopened the band between the
  //     engine's real limit and the reported floor — measured 24/10: a
  //     `400 "Input too large"` 52 min after the restart, teaching nothing back.
  //     The path is opt-in: the config bind is READ-ONLY in the container, so
  //     the compose default points at the writable model-cache volume; unset
  //     keeps today's memory-only behaviour.
  const capsRestored = initOverflowCapsPersistence();
  log(
    capsRestored.path
      ? `[ContextLimit] learned caps restored n=${capsRestored.loaded} expired=${capsRestored.expired} path=${capsRestored.path}`
      : "[ContextLimit] learned caps are memory-only (CLAUDISH_OVERFLOW_CAPS_PATH unset)"
  );

  // (2) The DECLARED window, derived from the endpoint's own `/v1/models` when
  //     it opts in (`deriveContextLimit: true`). Bounded per endpoint, never
  //     throws, and inert when nothing opts in — an endpoint that says nothing
  //     boots byte-identically, with zero probes on the wire.
  try {
    const derived = await deriveContextLimits(loadedConfig);
    if (derived.length > 0) {
      log(
        `[ContextLimit] derivation: ${derived.filter((d) => d.derived).length}/${derived.length} endpoint(s) derived from /v1/models`
      );
    }
    // #660 r1 — a SUCCEEDED derivation outranks any restored learned cap for
    // that provider: the learned branch is checked first in `handle()`, so a
    // stale cap would keep refusing what the fresh measurement just allowed.
    // The purge is what makes "a measurement beats a claim" true at the seam
    // where the two meet. r2: the loop lives in purgeCapsReplacedByDerivation
    // (same module as the outcomes) — it purges under the handler's own key.
    const capsPurged = purgeCapsReplacedByDerivation(derived);
    if (capsPurged > 0) {
      log(`[ContextLimit] derivation replaced ${capsPurged} restored learned cap(s) with the measured window`);
    }
  } catch (err) {
    // Belt and braces: deriveContextLimits swallows per-endpoint failures, and
    // a probe must never be able to keep the proxy from booting.
    logStderr(`[ContextLimit] derivation skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Define handlers for different roles
  const nativeHandler = new NativeHandler(anthropicApiKey, options.advisorModels, options.advisorCollector, proxyKeys);
  // #289 — the vision fallback (image descriptions on the ComposedHandler
  // path) must never forward the proxy's own key to api.anthropic.com: same
  // key set, same swap rule as the native lane above.
  setVisionAuthPolicy({ proxyKeys, anthropicApiKey });
  const openRouterHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> OpenRouter Handler
  const localProviderHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Local Provider Handler
  const remoteProviderHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Gemini/OpenAI Handler
  const poeHandlers = new Map<string, ModelHandler>(); // Map from Target Model ID -> Poe Handler

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
      const orProvider = new OpenRouterProviderTransport(openrouterApiKey || "", modelId);
      const orAdapter = new OpenRouterAPIFormat(modelId);
      openRouterHandlers.set(
        modelId,
        new ComposedHandler(orProvider, modelId, modelId, port, {
          adapter: orAdapter,
          isInteractive: options.isInteractive,
          invocationMode,
        })
      );
    }
    return openRouterHandlers.get(modelId)!;
  };

  // Helper to get or create Poe handler for a target model
  const getPoeHandler = (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): ModelHandler | null => {
    const poeApiKey = process.env.POE_API_KEY;
    if (!poeApiKey) {
      log(`[Proxy] POE_API_KEY not set, cannot use Poe model: ${targetModel}`);
      return null;
    }
    // Strip "poe:" prefix to get the actual model name for the API
    const modelId = targetModel.replace(/^poe:/, "");
    if (!poeHandlers.has(modelId)) {
      const poeTransport = new PoeProvider(poeApiKey);
      poeHandlers.set(
        modelId,
        new ComposedHandler(poeTransport, modelId, modelId, port, {
          isInteractive: options.isInteractive,
          invocationMode,
        })
      );
    }
    return poeHandlers.get(modelId)!;
  };

  // Check if model is a Poe model (has poe: prefix)
  const isPoeModel = (model: string): boolean => {
    return model.startsWith("poe:");
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
  const getRemoteProviderHandler = (
    targetModel: string,
    invocationMode?: ComposedHandlerOptions["invocationMode"]
  ): ModelHandler | null => {
    if (remoteProviderHandlers.has(targetModel)) {
      return remoteProviderHandlers.get(targetModel)!;
    }

    // Use centralized resolver with fallback logic
    const resolution = resolveModelProvider(targetModel);

    if (resolution.wasAutoRouted && resolution.autoRouteMessage) {
      // logStderr, NOT console.error: this fires PER REQUEST, i.e. while Claude
      // Code owns the inherited TTY — a raw console write lands mid-frame.
      // logStderr already writes the debug log file, so the quiet branch only
      // needs the file line. (218c3586.)
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

    // If resolver says use direct-api and key is available, create handler
    // Custom endpoints registered at runtime always have credentials (resolved from config)
    const isRuntimeProvider = getRuntimeProviders().has(resolution.parsed?.provider ?? "");
    if (resolution.category === "direct-api" && (resolution.apiKeyAvailable || isRuntimeProvider)) {
      const resolved = resolveRemoteProvider(resolveTarget);
      if (!resolved) return null;

      // Skip 'openrouter' provider here - it uses the existing OpenRouterHandler
      if (resolved.provider.name === "openrouter") {
        return null; // Will fall through to OpenRouterHandler
      }

      // Get API key - empty string for providers that don't require auth (like zen/ free models)
      const apiKey = resolved.provider.apiKeyEnvVar
        ? process.env[resolved.provider.apiKeyEnvVar] || ""
        : "";

      const handler = createHandlerForProvider({
        provider: resolved.provider,
        modelName: resolved.modelName,
        apiKey,
        targetModel,
        port,
        sharedOpts: { isInteractive: options.isInteractive, invocationMode },
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

  // Direct-provider catalog warmup (LiteLLM, Zen, Zen Go) was removed in
  // commit 5 of the model-catalog and routing redesign. claudish only fetches
  // Firebase catalogs now. The OpenRouter catalog is still warmed below via
  // warmAllCatalogs() since it backs vendor-prefix resolution.

  // Load effective routing rules once at startup. Returns a merged view of
  // DEFAULT_ROUTING_RULES + global config + local config (local wins). The
  // routing engine consults these via route() for every bare-name request.
  // `userRoutingRules` keeps the user-authored subset apart: it is what lets a
  // user routing override beat the native-anthropic heuristic below (2c).
  const routingRuleSources = loadRoutingRuleSources();
  const effectiveRoutingRules = loadRoutingRules(routingRuleSources);
  // The fallback hop, resolved once beside the rules and passed to route()
  // with them (upstream 9f8364f5). Passing rules alone makes route() read NO
  // default provider (its guard keeps this machine's setting out of tests),
  // so before this every bare name the proxy routed appended NO fallback hop,
  // whatever `defaultProvider` — or `CLAUDISH_DEFAULT_PROVIDER` — said.
  const effectiveFallbackProvider = effectiveDefaultProvider();
  const userRoutingRules = loadUserRoutingRules(routingRuleSources);
  // Problems in those rules, reported ONCE, here (upstream 5af1bf3f): before
  // Claude Code owns the terminal, and through logStderr, which the quiet flag
  // and a diagnostics pane both govern. `loadRoutingRules` prints nothing,
  // because it also runs inside TUIs and on every `route()` call — the old
  // per-load console.error tore TUI frames mid-draw. The custom endpoints were
  // registered above (loadCustomEndpoints), so a rule naming one is not
  // reported as an unknown provider (upstream 8a23cf3e).
  for (const problem of routingRuleProblems(routingRuleSources)) {
    logStderr(`Warning: ${describeRoutingRuleProblem(problem)}`);
  }

  // Cache fallback handlers by target model string.
  // No TTL/invalidation: claudish is ephemeral per session, so env changes
  // (new API keys) take effect on next session start.
  const fallbackHandlerCache = new Map<string, ModelHandler>();

  // Detect the invocation mode for a given target model string.
  // Used to populate stats: how did the user specify this model?
  const detectInvocationMode = (
    target: string,
    wasFromModelMap: boolean
  ): ComposedHandlerOptions["invocationMode"] => {
    if (wasFromModelMap) return "model-map";
    if (!target) return "auto-route";
    const parsedSpec = parseModelSpec(target);
    if (parsedSpec.isExplicitProvider) {
      // Check if this came from env var (CLAUDISH_MODEL or ANTHROPIC_MODEL)
      const envModel = process.env.CLAUDISH_MODEL || process.env.ANTHROPIC_MODEL;
      if (envModel && (target === envModel || parsedSpec.model === envModel)) {
        return "env-var";
      }
      return "explicit-model";
    }
    return "auto-route";
  };

  // Fail-closed backstop for the CLAUDISH_NO_ANTHROPIC leak guard: when a native
  // (real api.anthropic.com) route is forbidden and no safe budget reroute is
  // available, refuse cleanly rather than leak. A clean 503 is NOT a never-hang
  // violation — the client gets a terminal error, not a hung stream.
  const anthropicRefusalHandler: ModelHandler = {
    async handle(c) {
      return c.json(
        wrapAnthropicError(
          503,
          "This claudish sidecar has CLAUDISH_NO_ANTHROPIC set and no budget model mapping to reroute a native Anthropic request. Refusing to reach api.anthropic.com (leak-policy: Anthropic models are ai-01 only)."
        ),
        503
      );
    },
    async shutdown() {},
  };

  /** Steps 1-2 of getHandlerForRequest's target resolution, extracted so the
   * cascade loop can derive the SAME pre-failover nominal target without
   * re-implementing the mapping priority (drift between the two would mis-bucket
   * a nominal and with it the whole #275 diversion test). */
  const resolveNominalTarget = (requestedModel: string): { target: string; mapped: boolean } => {
    let target = requestedModel;
    let mapped = false;
    if (modelMap) {
      // Role-specific mappings take highest priority. Family matching is
      // version-independent, so a future claude-fable-* keeps the same role.
      const roleTarget = resolveRoleMappedModel(requestedModel.toLowerCase(), modelMap);
      if (roleTarget) {
        target = roleTarget;
        mapped = true;
      }
      // Default model (--model) is fallback for all roles
      else if (model) target = model;
    } else if (model) {
      // No role mappings at all - use default model
      target = model;
    }
    return { target, mapped };
  };

  /**
   * The provider bucket a requested model's NOMINAL draws on (#275) — the meter a
   * quota refusal walls. The decision core is `classifyNominalBucket`
   * (fork/failover.ts), which mirrors step 2c's guard exactly; this wrapper adds
   * the two pieces that need proxy state: the modelMap-resolved nominal target
   * and, only when the routing chain owns the decision, the catalog warmup +
   * `route()` call. This is the request-side half of the per-bucket failover:
   * the wall itself is recorded by the cascade loop against the refusing
   * request's bucket.
   */
  const nominalBucketOfModel = async (requestedModel: string): Promise<string> => {
    const { target } = resolveNominalTarget(requestedModel);
    const decision = classifyNominalBucket(target, (m) =>
      matchUserRoutingOverride(m, userRoutingRules)
    );
    if ("bucket" in decision) return decision.bucket;
    await ensureCatalogReady("openrouter", 5000);
    const plan = route(decision.routeModel, effectiveRoutingRules, effectiveFallbackProvider);
    // plan.primary is the credential-filtered primary — if the natural primary
    // lacks its key the serving candidate is the first fallback (accepted v1
    // approximation: a mis-credentialed primary is a config error, and the
    // refusal that eventually surfaces re-walls the bucket it names).
    if (plan.kind === "ok" && plan.primary) return plan.primary.provider;
    // No chain: a bare name with no routable provider is the native lane
    // (matches the isNative predicate of step 6 below).
    return providerBucketOf(target);
  };

  /**
   * The ONE bucket an ingress request keys every failover decision on (#275):
   * undefined when its role has no cascade; the `machine:<name>` bucket when
   * the role is config-armed for the caller's X-Claudish-Machine
   * (`role@machine` in CLAUDISH_FAILOVER_ACTIVE) — that machine's requests
   * divert, with the notice, while every other machine stays on the nominal;
   * else the nominal's real bucket.
   */
  const requestBucketOf = async (c: Context, requestedModel: string): Promise<string | undefined> => {
    const role = roleFromModelName(requestedModel);
    if (!role || !getFailoverRule(role)) return undefined;
    return (
      machineArmBucket(role, c.req.header("x-claudish-machine")) ?? (await nominalBucketOfModel(requestedModel))
    );
  };

  /**
   * #348 (review 06/10, bloquant): bucket for an ALREADY-CONCRETE cascade
   * step target — classifyNominalBucket + catalog + route(), WITHOUT
   * resolveNominalTarget. The walk's injected bucketer used to be
   * nominalBucketOfModel, which runs the REQUEST-side mapping first: a step
   * target whose id contains a role keyword (`or@anthropic/claude-sonnet-*`)
   * re-mapped onto modelMap[role] — i.e. onto the NOMINAL's bucket — and the
   * new "same bucket as the nominal" skip then jumped a healthy step drawing
   * on a different meter (probe-proven: s0 healthy, bucket ≠ nominal's,
   * skipped). With a `--model` default configured, EVERY keyword-free step
   * target bucketed as the default model instead of itself. A step target is
   * already concrete: classify it, route it, done. `nominalBucketOfModel`
   * stays what it is — the bucket of the name the client ASKED for.
   */
  const concreteStepBucketOf = async (stepTarget: string): Promise<string> => {
    const decision = classifyNominalBucket(stepTarget, (m) =>
      matchUserRoutingOverride(m, userRoutingRules)
    );
    if ("bucket" in decision) return decision.bucket;
    await ensureCatalogReady("openrouter", 5000);
    return concreteStepBucketOfSync(stepTarget);
  };

  /**
   * Sync twin of `concreteStepBucketOf`, for the failover module's role-step
   * delegation: `resolveRoleStep` runs inside the synchronous resolution and
   * cannot await. Same classification, same `route()` decision; only the
   * catalog warm-up is skipped — it serves OpenRouter vendor-prefix resolution,
   * the request side has warmed it long before any delegation resolves, and a
   * cold catalog leaves the same accepted approximation as a mis-credentialed
   * primary (see nominalBucketOfModel).
   */
  const concreteStepBucketOfSync = (stepTarget: string): string => {
    const decision = classifyNominalBucket(stepTarget, (m) =>
      matchUserRoutingOverride(m, userRoutingRules)
    );
    if ("bucket" in decision) return decision.bucket;
    const plan = route(decision.routeModel, effectiveRoutingRules, effectiveFallbackProvider);
    if (plan.kind === "ok" && plan.primary) return plan.primary.provider;
    return providerBucketOf(stepTarget);
  };

  // A `role:` step whose target nominal is a bare routing-chain name
  // (`modelMap.sonnet = glm-5.3`) must see the wall on the bucket that name
  // actually draws on — the route() primary, not anything the failover module
  // can classify alone. Registered next to the nominal resolver's twin.
  setRoleNominalBucketResolver(concreteStepBucketOfSync);

  /**
   * #412 (review ai-01 08/10, point 1) — is this request's NOMINAL target the
   * native passthrough? The auth middleware marked the request keyless
   * precisely because its ASKED name parsed native and is not a routed bare
   * name, but `modelMap` can still send it elsewhere (`modelMap.sonnet =
   * glm-5.3`): that shape must keep requiring a key, so the failover-swap
   * suppression is keyed on the nominal TARGET, never on the request merely
   * being keyless.
   */
  const nominalIsNative = (requestedModel: string): boolean => {
    const { target } = resolveNominalTarget(requestedModel);
    const spec = parseModelSpec(target);
    return spec.provider === "native-anthropic" && !routedBareNames.has(target);
  };

  /**
   * #412 — ONE definition of "this request is keyless and its nominal is
   * native", read by every resolution of the same request: the route's
   * log/billing-strip resolution, `handleWithCascade`'s, and count_tokens'.
   * They MUST agree — the route's resolution is not a dry run: it mutates the
   * #91 per-session dwell pin, and its handler identity decides whether the
   * billing header is stripped. Two resolutions disagreeing would label the
   * request `ComposedHandler` while the cascade served it natively, and would
   * let a keyless request write fleet failover state through the back door.
   */
  const keylessNativeRequest = (c: Context, requestedModel: string): boolean =>
    isKeylessExempt(c.req.raw) && nominalIsNative(requestedModel);

  const getHandlerForRequest = async (
    requestedModel: string,
    depth = 0,
    sessionKey: string | null = null,
    nominalBucket?: string,
    /**
     * #299-B: serve THIS target verbatim, bypassing both the modelMap lookup
     * and the failover swap (2a). Used only by the cascade loop's one-shot
     * overload walk, where the step to try is chosen by the walk itself, not
     * by resolution — a state read would either re-select the nominal (no arm)
     * or write the dwell pin the walk must not write.
     */
    forceTarget?: string,
    /**
     * #412 (review ai-01 08/10, point 1): suppress the 2a failover swap for
     * THIS request. Set only for a keyless request whose NOMINAL target is
     * native — substituting a budget step there answers the client's own
     * exhausted meter with a 401 about a key they never needed, which
     * conflates a native quota limit with a login failure. It suppresses the
     * SWAP, never the resolution: modelMap and the routing chain still decide
     * the target, so a keyless request whose modelMap entry is a budget model
     * still resolves there and is then refused by the keyless guard below.
     */
    suppressFailover = false,
    /**
     * #431: step indexes this request has already skipped (context overflow /
     * busy). Threaded into the 2a resolution so the handler swap and the
     * loop's own bookkeeping resolution agree — they run twice per attempt
     * and a divergence would build the handler for one step while the loop
     * advances past another. Undefined for every non-loop caller.
     */
    skipSteps?: ReadonlySet<number>
  ): Promise<ModelHandler> => {
    // 1. Monitor Mode Override
    if (monitorMode) return nativeHandler;

    let target: string;
    let wasFromModelMap: boolean;
    if (forceTarget) {
      target = forceTarget;
      wasFromModelMap = true; // a walk step is as explicit as a swap target
    } else {
      // 2. Resolve target model based on mappings or defaults
      // Priority: role mappings > default model (--model) > requested model (native)
      const { target: mappedTarget, mapped } = resolveNominalTarget(requestedModel);
      target = mappedTarget;
      wasFromModelMap = mapped;
    }

    // The role is derived from what the CLIENT asked for, independently of
    // whether modelMap has an entry for it — a failover must be able to divert
    // an unmapped role (e.g. bare native opus on ai-01) just as well as a mapped
    // one. Single definition in failover.roleFromModelName (role keywords +
    // CLAUDISH_FAILOVER_ROLE_MODELS aliases) so the swap and the cascade loop
    // can never drift.
    const role = roleFromModelName(requestedModel);

    // 2a. Budget failover — a whole role is served from a cascade of substitute
    // pools because its nominal plan is exhausted or being conserved. Sits AFTER
    // the modelMap cascade so it overrides the nominal mapping, and BEFORE
    // catalog/route resolution so the substitute is resolved like any other target.
    // resolveFailoverTargetForSession walks the cascade skipping TTL-failed
    // steps, plus the per-session dwell (#91 point 4) when a session key is
    // available. Inert unless CLAUDISH_FAILOVER_* is configured. See fork/failover.ts.
    // Skipped entirely for a forced walk target: that attempt must not read
    // failover state (the walk changes none).
    if (!forceTarget && !suppressFailover && role && getFailoverRule(role)) {
      // #275: the diversion test is bucket-scoped — compute this request's
      // nominal bucket (unless the caller — the cascade loop — already did).
      const bucket = nominalBucket ?? (await nominalBucketOfModel(requestedModel));
      const resolved = resolveFailoverTargetForSession(role, sessionKey, bucket, skipSteps);
      if (resolved.step && resolved.step.target !== target) {
        log(
          `[Proxy] Failover: role '${role}' [${bucket}] ${target} → ${resolved.step.target} step[${resolved.stepIndex}] (${resolved.step.label})`
        );
        target = resolved.step.target;
        wasFromModelMap = true;
      }
    }

    const invocationMode = detectInvocationMode(target, wasFromModelMap);

    // 2b. Catalog resolution — resolve vendor prefix for OpenRouter.
    // This must happen after target is determined but before handler construction.
    // ensureCatalogReady awaits the catalog if not yet warm (with 5s timeout).
    // resolveModelNameSync then reads from the in-memory cache synchronously.
    // (LiteLLM catalog resolution was removed in commit 5 — users type the
    // exact LiteLLM model_group name now; see plan §D.)
    //
    // ⚠ Explicitness transition, ACCEPTED (a9112dce ruling, S4-d lot A review
    // 2026-09-21): the one form this rewrites from non-explicit to explicit is
    // `openrouter/<vendor>/<model>` — parseModelSpec auto-detects it through
    // NATIVE_MODEL_PATTERNS, which is DERIVED from BUILTIN_PROVIDERS in
    // provider-definitions.ts (l. 728: "Replaces NATIVE_MODEL_PATTERNS in
    // model-parser.ts"), so a name-grep in THIS file is blind to it. After the
    // rewrite, 2c sees isExplicitProvider:true and skips the provider-fallback
    // chain. Deliberate (option b of the ruling; option a was preserving chain
    // eligibility): the name names the aggregator, so it routes directly.
    // Bare `vendor/model` forms (e.g. `qwen/...`) parse to their OWN provider
    // and remain chain-eligible. Pinned in proxy-server-routing-error.test.ts.
    {
      const parsedTarget = parseModelSpec(target);
      if (parsedTarget.provider === "openrouter") {
        await ensureCatalogReady(parsedTarget.provider, 5000);
        const resolution = resolveModelNameSync(parsedTarget.model, parsedTarget.provider);
        logResolution(parsedTarget.model, resolution, options.quiet);
        if (resolution.wasResolved) {
          // Reconstruct target with resolved model name so handler construction
          // uses the correct fully-qualified API ID (e.g., "qwen/qwen3-coder-next").
          target = `${parsedTarget.provider}@${resolution.resolvedId}`;
        }
      }
    }

    // 2c. Provider fallback chain for auto-routed models
    // When no explicit provider@ prefix is given, consult the routing engine
    // (defaults + user overrides merged in loadRoutingRules), filter to
    // credentialed providers, and wrap them in a FallbackHandler.
    {
      const parsedForFallback = parseModelSpec(target);
      if (
        !parsedForFallback.isExplicitProvider &&
        (parsedForFallback.provider !== "native-anthropic" ||
          // A user-authored routing entry for this exact name (or glob) wins
          // over the bare-name heuristic: without this, an alias the user
          // routed to a custom endpoint is classified native-anthropic, the
          // routing engine is skipped entirely, and the request 401s against
          // api.anthropic.com (#3401).
          matchUserRoutingOverride(parsedForFallback.model, userRoutingRules)) &&
        !isPoeModel(target)
      ) {
        const cacheKey = `fallback:${target}`;
        if (fallbackHandlerCache.has(cacheKey)) {
          return fallbackHandlerCache.get(cacheKey)!;
        }

        // Ensure catalog is warm before route() builds OpenRouter modelSpecs.
        await ensureCatalogReady("openrouter", 5000);

        const plan = route(parsedForFallback.model, effectiveRoutingRules, effectiveFallbackProvider);
        if (plan.kind === "ok") {
          const chain = [plan.primary, ...plan.fallbacks];
          const candidates: FallbackCandidate[] = [];
          for (const candidate of chain) {
            let handler: ModelHandler | null = null;
            if (candidate.provider === "openrouter") {
              handler = getOpenRouterHandler(candidate.modelSpec, invocationMode);
            } else {
              handler = getRemoteProviderHandler(candidate.modelSpec, invocationMode);
            }
            if (handler) {
              candidates.push({ name: candidate.displayName, handler });
            }
          }

          if (candidates.length > 0) {
            const resultHandler =
              candidates.length > 1 ? new FallbackHandler(candidates) : candidates[0].handler;

            fallbackHandlerCache.set(cacheKey, resultHandler);

            const routeLine = `[Route] ${candidates.length} ${candidates.length === 1 ? "provider" : "providers"} for ${parsedForFallback.model}: ${candidates.map((c) => c.name).join(" → ")}`;
            if (!options.quiet && candidates.length > 1) {
              logStderr(routeLine);
            } else {
              // The debug log gets the chain even when stderr does not: a
              // single hop, or a quiet `-p` run. Without it a request that
              // went to the fallback hop alone left no line naming the
              // provider it used (upstream 9f8364f5).
              log(routeLine);
            }
            return resultHandler;
          }
        } else {
          // No routable provider for a bare model name. Routing is fully
          // data-driven now (DEFAULT_ROUTING_RULES + user overrides) — if the
          // chain is empty and credential filtering produces nothing, that's
          // the user's configured outcome. Throw so the request handler
          // surfaces a clean error instead of silently falling through to a
          // legacy OpenRouter fallback. (Pre-commit-5 there was a hidden
          // OpenRouter step 7 that masked the no-route case.)
          // RoutingError, not bare Error: the request handlers map it to a
          // terminal 400 instead of a retryable 500 (bbb448f6).
          const message = plan.hint
            ? `[Route] ${plan.reason}\n${plan.hint}`
            : `[Route] ${plan.reason}`;
          throw new RoutingError(message);
        }
      }
    }

    // 3. Check for Poe Model (poe: prefix)
    if (isPoeModel(target)) {
      const poeHandler = getPoeHandler(target, invocationMode);
      if (poeHandler) {
        log(`[Proxy] Routing to Poe: ${target}`);
        return poeHandler;
      }
    }

    // 4. Check for Remote Provider (g/, gemini/, oai/, openai/, mmax/, mm/, kimi/, moonshot/, glm/, zhipu/)
    const remoteHandler = getRemoteProviderHandler(target, invocationMode);
    if (remoteHandler) return remoteHandler;

    // 5. Check for Local Provider (ollama/, lmstudio/, vllm/, or URL)
    const localHandler = getLocalProviderHandler(target, invocationMode);
    if (localHandler) return localHandler;

    // 6. Native vs OpenRouter Decision
    // Models with explicit provider prefix (@) should never fall to native Anthropic handler.
    // They were explicitly routed to a provider - if the handler wasn't created above,
    // it's because the API key is missing, not because it's a native model.
    const hasExplicitProvider = target.includes("@");
    const isNative = isNativeTarget(target);

    if (isNative) {
      // Leak-policy backstop (defense in depth). On a non-ai-01 autonomous
      // sidecar, CLAUDISH_NO_ANTHROPIC forbids ever touching real
      // api.anthropic.com. An unmapped claude-* (or any bare native string that
      // slipped through the modelMap) would otherwise leak. Reroute to the budget
      // sonnet mapping — keeps the agent alive during an outage without leaking.
      // This sits ABOVE the per-machine config (opus/sonnet/haiku/fable already
      // budget-mapped) because we have leaked on an undefined field before
      // (memory: leak-policy-binary-by-machine).
      //
      // The truthiness test is load-bearing, not sloppy. docker-compose always
      // MATERIALIZES this variable (`- CLAUDISH_NO_ANTHROPIC=${CLAUDISH_NO_ANTHROPIC:-}`),
      // so inside a container it is never absent — only `1` (every machine) or
      // "" (ai-01, the one machine authorized to reach api.anthropic.com).
      // Empty-string-falsy IS the ai-01 exemption; there is no separate opt-out.
      // Deleting the variable from a .env to "clean it up" therefore changes
      // nothing (compose re-creates it empty), and flipping this to a
      // `!== undefined` test would silently kill ai-01 native Opus lane.
      if (process.env.CLAUDISH_NO_ANTHROPIC) {
        const guard = noAnthropicDecision(modelMap, { depth });
        if (guard.kind === "reroute") {
          log(
            `[Proxy] NO_ANTHROPIC: rerouting native '${target}' → budget '${guard.to}'`,
            true
          );
          return getHandlerForRequest(guard.to, depth + 1, sessionKey);
        }
        // depth > 0 (the budget mapping itself resolved native → misconfig) or no
        // sonnet mapping: fail closed. Never leak.
        log(`[Proxy] NO_ANTHROPIC: refusing native '${target}' (no safe budget reroute)`, true);
        return anthropicRefusalHandler;
      }
      // If we mapped to a native string (unlikely) or passed through
      return nativeHandler;
    }

    // 6b. Explicit non-OpenRouter spec that produced no handler above means its
    // credential is MISSING — its key didn't resolve, so getRemoteProviderHandler
    // returned null. Per the routing contract, an explicit provider@model must
    // NOT silently fall through to OpenRouter (defaultProvider/last-resort
    // fallback applies to BARE names only — CLAUDE.md §Model Routing). Absorbed
    // from upstream bbb448f6: a retryable 500 here makes Claude Code loop on
    // "API error · Retrying" while the real cause (no key for the named
    // provider) stays hidden; a terminal 400 with the env-var hint surfaces it.
    if (hasExplicitProvider) {
      const parsedExplicit = parseModelSpec(target);
      // openrouter@... (and its or@ shortcut — parseModelSpec normalizes both)
      // legitimately uses the OpenRouter handler below.
      if (parsedExplicit.provider !== "openrouter") {
        const keyInfo = API_KEY_MAP[parsedExplicit.provider];
        const keyNames = keyInfo
          ? [keyInfo.envVar, ...(keyInfo.aliases ?? [])].join(" or ")
          : undefined;
        const hint = keyNames
          ? `No API key for provider "${parsedExplicit.provider}". Set ${keyNames} (env, config, or 1Password import).`
          : `No API key for provider "${parsedExplicit.provider}".`;
        throw new RoutingError(
          `Explicit model "${target}" could not be routed — its provider has no credential. ${hint}`
        );
      }
    }

    // 7. OpenRouter Handler (default for any model with "/" or explicit OpenRouter spec)
    return getOpenRouterHandler(target, invocationMode);
  };

  /**
   * Run a request through the budget-failover cascade. Tries the resolved target
   * (nominal when not armed, else the first non-TTL-failed cascade step); on a
   * quota wall it advances state (arm the role, or mark the step failed) and
   * retries the next resolution — bounded by (cascade length + 1), so it never
   * hangs. Reuses the same `c` on every attempt: handlers do not mutate the Hono
   * Context before returning a non-ok Response (the FallbackHandler invariant),
   * which is what makes the retry safe.
   *
   * `getHandlerForRequest`'s internal swap reads `resolveFailoverTargetForSession` —
   * the SAME source of truth this loop reads — so mutating failover state between attempts
   * is enough; no override target is passed in (that would race two resolutions).
   */
  const handleWithCascade = async (
    c: Context,
    body: any,
    requestedModel: string,
    nominalBucket?: string
  ): Promise<Response> => {
    // #348: the walk's time budget is measured from HERE — the moment the
    // request entered the cascade. The nominal attempt's full cost (transport
    // retry ladder + patient backoff + its own latency) counts against it,
    // because that is what the client already waited before the walk fires.
    const cascadeStartedAtMs = Date.now();
    const role = roleFromModelName(requestedModel);
    const rule = role ? getFailoverRule(role) : undefined;
    // #275: the provider bucket THIS request's nominal draws on. Computed once
    // (the routing consult is in-memory but not free) and threaded through every
    // failover decision below — the arm, the resolution and the success callback
    // must all key on the same bucket or the diversion test lies.
    const bucket =
      nominalBucket ?? (rule ? await nominalBucketOfModel(requestedModel) : undefined);
    // ── #565 — admission census over DECLARED windows ──────────────────────
    // Placed HERE, before the loop and before any handler is built, because the
    // decision needs the whole PATH (nominal + every cascade step), not the
    // attempt that happens to be resolved first: a request no declared window
    // can take is doomed on every candidate, so paying the first round-trip to
    // learn it is pure waste — and the client gets MiniMax/vLLM jargon instead
    // of a number it can act on (hub 2026-10-20: a 1.1M-token `/compact` turn).
    //
    // Declared-only, by design: a provider that declares no `contextLimit` is
    // NOT assumed unbounded — the census simply cannot see it, and a path with
    // ANY such candidate falls open to today's behaviour. Refusing on a guessed
    // window would break the lanes nobody declared (every built-in provider,
    // today); refusing on the declared SUBSET broke the ones somebody did (hub
    // 2026-10-22: swift's 262 144 vetoed the haiku path's whole cascade, its
    // undeclared nominal and PAYG terminator included).
    //
    // The answer is the SAME recoverable turn the #79/#431 paths already use, not
    // a bare 400: the gauge advances with the real size, so the client's own
    // compaction fires. A 400 here would reproduce the `/compact` retry loop #79
    // closed — the client would resend the identical body.
    if (!contextAdmissionDisabled()) {
      const windows: DeclaredWindow[] = [];
      let undeclared = 0;
      const collectWindow = (target: string | undefined): void => {
        const at = target ? target.indexOf("@") : -1;
        // A bare/built-in name, the NATIVE lane (`claude-opus-5` on ai-01 is a
        // 1M-context lane that declares nothing — a smaller step must never
        // veto the model the client named) or an unresolved target: each
        // declares nothing, and each is a candidate that may take the request.
        if (!target || at <= 0) {
          undeclared++;
          return;
        }
        const limit = getDeclaredContextLimit(target.slice(0, at));
        if (limit !== undefined) windows.push({ name: target.slice(0, at), limit });
        else undeclared++;
      };
      // A `role:<r>` step delegates to r's whole path — its nominal and its own
      // steps — not to whichever concrete its `target` was last refreshed to.
      // The delegation graph is proven acyclic at load; `seen` only keeps the
      // census bounded if that proof is ever bypassed.
      const seen = new Set<FailoverRole>();
      const collectSteps = (r: FailoverRole): void => {
        for (const s of getFailoverRule(r)?.steps ?? []) {
          if (!s.roleRef) {
            collectWindow(s.target);
            continue;
          }
          if (seen.has(s.roleRef)) continue;
          seen.add(s.roleRef);
          collectWindow(modelMap?.[s.roleRef]);
          collectSteps(s.roleRef);
        }
      };
      collectWindow(resolveNominalTarget(requestedModel).target);
      if (role) {
        seen.add(role);
        collectSteps(role);
      }
      const admission: ContextAdmissionDecision = decideContextAdmission(body, windows, undeclared);
      if (admission.refuse && admission.largest) {
        const text = contextAdmissionRefusalText(admission.estTokens, admission.largest);
        log(
          `[ContextAdmission] REFUSE ${requestedModel}: est=${admission.estTokens} > largest declared ${admission.largest.limit} (${admission.largest.name}) — no upstream fetch`,
          true // forceConsole — operational event, countable marker
        );
        return body?.stream === true
          ? buildOverflowRecoveryStream(text, admission.estTokens, requestedModel)
          : c.json(buildOverflowRecoveryMessage(text, admission.estTokens, requestedModel));
      }
    }
    // #412 — a keyless request whose NOMINAL is native must not be substituted
    // away by the budget failover (review ai-01 08/10, point 1). Two measured
    // shapes, one answer: (a) in-request, the native 429 arms the role and the
    // retry re-resolves to a budget step; (b) a bucket already armed by a
    // PREVIOUS request resolves straight to that step on attempt 0, with no
    // prior response to surface. Both would hand a client its own native wall
    // as a 401 about a key it never needed. Suppressing the swap keeps the
    // native trajectory bounded — the client's own response surfaces — and
    // writes NO fleet state (no arm, no step mark, no dwell pin): a request
    // that may not spend fleet budget must not shape the fleet's failover.
    const keylessNative = keylessNativeRequest(c, requestedModel);
    // #416 review (ai-01, non-blocking): there used to be a second belt here —
    // `keylessNative ? 1 : …` — capping the loop at one attempt. It was
    // UNREACHABLE, and measured as such: widening it back changes no test
    // outcome (15/15 either way), because the loop's own step guard already
    // forces `stepIndex === -1` for a keyless request (the resolution above is
    // `role && !keylessNative ? … : { step: null, stepIndex: -1 }`), and both
    // outcomes of attempt 0 return: a served response ends the loop, a refused
    // one hits the `if (keylessNative)` early return below. An unreachable
    // guard is worse than no guard — it reads as protection nobody has. The
    // early return is the guard, it is observable (it emits the countable
    // marker) and it is pinned (T3/T4); this line is subtraction, not a new
    // promise.
    const maxAttempts = rule ? rule.steps.length + 1 : 1; // nominal + each step
    const armGraceMs = getArmGraceMs();
    const sessionKey = extractSessionKey(body); // #91 point 4: per-session dwell
    // #317: the machine half of the budget key — same attribution header the
    // capture pipeline and the proxy-key rotation bucketizer read.
    const machineHeader = c.req.header("x-claudish-machine") ?? null;
    let graceRetried = false; // #91: one wait-and-retry on the nominal per request
    // #263/#331: concretes this request already paid, per step index. A
    // concurrent nominal success (onNominalSuccess → resetAllStepFailures) can
    // clear step marks mid-request — routine once ROLE_MODELS folds several
    // nominals into one role — and the next resolution then re-selects a step
    // this request just watched wall. Re-paying it burned the attempt budget
    // and surfaced its raw error (hub 2026-09-25: Sol → Mistral 402 twice,
    // never reaching the healthy last step). Re-mark and re-resolve instead,
    // without calling the handler or consuming an attempt; `revisits` is capped
    // at the step count, so the loop stays bounded. #331 keys the guard by the
    // CONCRETE paid (a delegation that advanced serves a different concrete —
    // not a re-payment); the index-keyed Set would re-freeze it (see the loop).
    const triedConcretes = new Map<number, Set<string>>();
    let revisits = 0;
    // #609: a delegated concrete that failed in this request is followed by the
    // NEXT concrete of the target's path, on the SAME delegating step, before
    // the walk moves to the caller's next step or surfaces — a `role:` step
    // stands for the target's whole chain, not for the one concrete the
    // resolution happened to pick. One-shot override, consumed by the next
    // iteration; it rides outside the caller's attempt budget (`attempt--`,
    // like the #263 revisit), bounded by the target path's candidate count, and
    // excludes every concrete this request already paid on ANY step.
    type DelegationOverride = { stepIndex: number; concrete: string; owner: DelegationOwner };
    let delegationOverride: DelegationOverride | null = null;
    let delegationWalks = 0;
    let response: Response | undefined;
    // #299-B: one-shot bounded — a nominal transient overload walks to the
    // first servable cascade step at most ONCE per request, whatever the loop
    // does afterwards.
    let overloadWalked = false;
    // #431: cascade steps THIS request has skipped (context overflow / busy) —
    // request-scoped memory for both resolutions (handler swap + loop read),
    // so the walk advances past a step that cannot take the request instead of
    // re-paying it. Never contains the last index: a skip fires only when a
    // successor exists. Writes NO fleet state — no markStepFailed, no bucket
    // wall, no arm — the step is healthy, the request just does not fit.
    const skippedSteps = new Set<number>();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // #609: an override attempt serves the walk's concrete verbatim (the
      // #299-B forceTarget seam) and reads no failover state — the walk chose
      // the step and the concrete, a re-resolution would hand the dead one back.
      // Typed read: the only writer is the walkDelegatedTarget closure below, which
      // control-flow narrowing cannot see (it would narrow this to `null`).
      const override = delegationOverride as DelegationOverride | null;
      delegationOverride = null;
      const handler = override
        ? await getHandlerForRequest(override.concrete, 0, sessionKey, bucket, override.concrete)
        : await getHandlerForRequest(
            requestedModel,
            0,
            sessionKey,
            bucket,
            undefined,
            keylessNative,
            skippedSteps
          );
      const resolved = override && rule
        ? { step: rule.steps[override.stepIndex], stepIndex: override.stepIndex }
        : role && !keylessNative
          ? resolveFailoverTargetForSession(role, sessionKey, bucket, skippedSteps)
          : { step: null, stepIndex: -1 };
      const { stepIndex } = resolved;
      // #274 (review 29/09): when this attempt serves a role-step's DELEGATION,
      // the concrete model belongs to another cascade, and failover bookkeeping
      // must reach the OWNING side — a delegated wall of the target's nominal
      // arms the target's bucket, a delegated wall of the target's step marks
      // that step. The owning coordinate comes from the RESOLUTION itself
      // (resolveDelegationOwner): the first cut derived it by comparing the
      // concrete target to the DELEGATING role's own nominal (never equal — a
      // role's nominal never appears in its own cascade) and by reverse
      // target→step lookup (which finds the delegating step back, since a
      // role-step's `target` is refreshed in place). Null for model steps and
      // the nominal attempt — no owning side to record.
      const delegation = override
        ? { concrete: override.concrete, owner: override.owner }
        : role && resolved.step?.roleRef
          ? resolveDelegationOwner(role, resolved.step)
          : null;
      // #609: arm the next delegated concrete for THIS step, if the target's
      // path still has one this request has not paid. True = the caller
      // `continue`s (after draining the failed body); false = today's walk.
      const walkDelegatedTarget = (): boolean => {
        if (!role || !delegation || !resolved.step?.roleRef || stepIndex < 0) return false;
        if (delegationWalks >= delegationCandidateBound(resolved.step)) return false;
        const paid = new Set<string>();
        for (const set of triedConcretes.values()) for (const x of set) paid.add(x);
        const next = resolveDelegationExcluding(resolved.step, paid);
        if (!next) return false;
        delegationWalks++;
        delegationOverride = { stepIndex, concrete: next.concrete, owner: next.owner };
        log(
          `[Failover] DELEGATION-WALK ${role}[${stepIndex}] — ${delegation.concrete} failed in this request; ` +
            `trying ${next.concrete} (${next.owner.role} ${next.owner.nominal ? "nominal" : `step ${next.owner.stepIndex}`})`,
          true // forceConsole — operational event, countable marker
        );
        return true;
      };
      // #331: the #263 revisit guard is keyed by the CONCRETE this request
      // already paid on that step, not by the step index alone. A role-step
      // whose delegation has ADVANCED resolves a different concrete — serving
      // it is not a re-payment of the wall this request watched (the index-keyed
      // form re-marked such a step WITHOUT a concrete, re-freezing it for the
      // full backoff — the intra-request half of the 24 h freeze). The same
      // concrete re-selected after a concurrent clear keeps the #263 semantics
      // — re-mark and re-resolve. #331 (review 06/10, point 2): the re-mark
      // CARRIES the concrete — it changes nothing intra-request (nothing
      // succeeded in between, so the delegation cannot move and the record
      // binds identically), but a record WITHOUT one binds a role-step for its
      // whole backoff (up to 24 h) however far the delegation advances LATER
      // — the revisit path re-opening the freeze #331 closed.
      const attemptConcreteNow = delegation?.concrete ?? resolved.step?.target;
      if (
        role &&
        stepIndex >= 0 &&
        attemptConcreteNow !== undefined &&
        triedConcretes.get(stepIndex)?.has(attemptConcreteNow) &&
        revisits < (rule?.steps.length ?? 0)
      ) {
        revisits++;
        markStepFailed(role, stepIndex, `re-selected after a concurrent clear — already failed in this request`, undefined, {
          concrete: attemptConcreteNow,
        });
        attempt--;
        continue;
      }
      if (stepIndex >= 0 && attemptConcreteNow !== undefined) {
        let paid = triedConcretes.get(stepIndex);
        if (!paid) {
          paid = new Set<string>();
          triedConcretes.set(stepIndex, paid);
        }
        paid.add(attemptConcreteNow);
      }
      // #412 — the keyless exemption admits, this decides. A request admitted
      // without a credential of its own may only be served by the native
      // passthrough (which spends the CLIENT's Anthropic-shaped credential).
      // Every other resolution spends one the caller does not hold: a modelMap
      // reroute, a routing entry, a custom endpoint, a cascade step, the
      // one-shot overload walk, the vision fallback. Placed HERE — after the
      // revisit guard's `continue`s and before the pin mutates the body — so it
      // runs only on an attempt that would actually be served.
      //
      // Refuse BEFORE any upstream fetch. Two shapes, deliberately different:
      //   - nothing answered yet ⇒ labeled 401. The request never had a right
      //     to this lane;
      //   - a prior native attempt already answered (attempt 0 was NativeHandler
      //     and came back non-ok) ⇒ surface THAT. On a walled native bucket the
      //     honest answer to the client is their own 429 — their meter is the
      //     exhausted one — not a 401 blaming the key they never needed.
      if (isKeylessExempt(c.req.raw) && !(handler instanceof NativeHandler)) {
        // #412 (review ai-01 08/10, point 4): name a CONCRETE, non-secret lane,
        // never the handler class alone — `ComposedHandler` as the lane says
        // nothing about which credential the request resolved to, and an
        // operator reading the marker needs the target (`glm-5.3`,
        // `frognano-4b`) to know what would have been spent.
        const lane = resolved.step?.target ?? resolveNominalTarget(requestedModel).target;
        if (response) return response;
        logStderr(
          `[ProxyAuth] keyless request for ${requestedModel} resolves to a server-held credential (${lane}) — refused, zero upstream fetch`
        );
        return c.json(
          wrapAnthropicError(401, keylessRefusalMessage(requestedModel, lane), "authentication_error"),
          401
        );
      }
      // Native-lane version pin. Applied HERE rather than at the route, because the
      // cascade re-resolves the handler every attempt: only the attempt that actually
      // lands on NativeHandler may carry a bare Anthropic id, and a later attempt is a
      // budget provider that must see the body untouched. Restored on failure so the
      // mutation can never outlive the attempt that earned it (ComposedHandler reads
      // payload.model for its `originalModel` telemetry).
      const pinnedModel = handler instanceof NativeHandler
        ? resolveNativeModelPin(body.model, modelMap)
        : undefined;
      const modelBeforePin = body.model;
      if (pinnedModel) {
        log(`[Proxy] native pin: '${modelBeforePin}' → '${pinnedModel}' (modelMap role target)`, true);
        body.model = pinnedModel;
      }
      // #431 AC3: arm the bounded busy wait for THIS attempt only — a cascade
      // step (stepIndex >= 0) skips forward when the endpoint limiter stays
      // full past the knob; the nominal keeps its unbounded FIFO (AC3: "the
      // nominal path keeps its current behavior"). Marked here, after the
      // guards that `continue`/return, so only an attempt that will actually
      // be served pays for the marking. The kill switch gates it: off = no
      // bound anywhere, today's behavior.
      //
      // CR S2/S3: the bound applies to a NON-LAST step only — on the last step
      // (and on the nominal) the 529-skip has no successor to advance to, so a
      // bound there converts a long-but-finite queue wait into an empty-skip
      // surface. The unbounded re-mark (0) matters for the SAME request: the
      // marking is per-ATTEMPT state on the Context, and an earlier attempt of
      // this request may have already set a bound that must not survive into
      // the final attempt.
      if (role && !stepSkipDisabled()) {
        if (rule != null && stepIndex >= 0 && stepIndex < rule.steps.length - 1) {
          markCascadeStepAttempt(c, readStepBusyWaitMs());
        } else {
          markCascadeStepAttempt(c, 0);
        }
      }
      // #654 — in-flight token budget per endpoint, evaluated BEFORE the
      // upstream call: a local engine saturates on CONTEXT, not request count
      // (six ~200K-token bodies ≈ 1.2M KV against 750,747 available — measured
      // 2026-10-24, engine-side). The budget rides the #431 `busy` skip wire,
      // never the failure path. Inert unless the endpoint carries its knobs
      // (AC1); estimator bytes/3.5 (AC3); an identical resubmission REPLACES
      // its predecessor's estimate instead of adding one (AC5, arbitrated
      // 24/10 — a budget counting the measured 56% client echo as fresh
      // demand would trip on its own echo and divert a lane that has room).
      // A refusal only ever DIVERTS: a non-last step advances (skip semantics
      // — no mark, no wall, no arm, engine never sees the request); the
      // nominal synthesizes the same 529 the bounded busy wait produces and
      // lets the #299-B walk machinery own the diversion; a lane with no
      // diversion (last step, unconfigured role, walk off) serves anyway —
      // the budget bounds admission, it never refuses a servable request.
      const budgetPrefix = endpointPrefixOf(
        attemptConcreteNow ??
          (stepIndex === -1 ? resolveNominalTarget(requestedModel).target : undefined)
      );
      const budgetDecision = budgetPrefix
        ? evaluateEndpointTokenBudget(
            budgetPrefix,
            body,
            { machine: machineHeader, session: sessionKey },
            process.env,
            Date.now(),
            (info) => logStderr(info)
          )
        : null;
      let releaseBudget: (() => void) | undefined;
      let budgetSynthResponse: Response | undefined;
      if (budgetDecision) {
        const budgetDetail = formatBudgetFacts(
          budgetDecision.facts,
          budgetDecision.refused,
          budgetDecision.reason
        );
        if (budgetDecision.facts.resubmit >= 2) {
          log(
            `[EndpointBudget] ${budgetPrefix} resubmit=${budgetDecision.facts.resubmit} in flight (${budgetDetail}) — estimate replaces its predecessor (#654 AC5)`,
            true // forceConsole — operational event, countable marker (AC5b)
          );
        }
        if (budgetDecision.refused) {
          const canSkipStep =
            role != null &&
            rule != null &&
            stepIndex >= 0 &&
            stepIndex < rule.steps.length - 1 &&
            attempt + 1 < maxAttempts &&
            !stepSkipDisabled();
          if (canSkipStep) {
            log(
              `[Failover] SKIP ${role}[${stepIndex}] reason=busy ${budgetDetail} ` +
                `(${attemptConcreteNow ?? "?"}) — advancing to next step, no failure mark (endpoint token budget #654)`,
              true // forceConsole — operational event (#431/#654)
            );
            skippedSteps.add(stepIndex);
            continue;
          }
          const canWalkNominal =
            role != null &&
            stepIndex === -1 &&
            rule != null &&
            rule.steps.length > 0 &&
            !keylessNative &&
            !(bucket ?? "").startsWith(`${NATIVE_BUCKET}/`) &&
            (process.env.CLAUDISH_FAILOVER_OVERLOAD_WALK || "").trim() !== "0";
          if (canWalkNominal) {
            // Same wire shape as ComposedHandler's bounded busy 529: the
            // #299-B walk block below picks it up (`isOverloadWalkClass` on
            // the 529), diverts one-shot to the first servable step, writes
            // no state — and when nothing is servable it surfaces this 529,
            // which the client retries on its own.
            log(
              `[Failover] budget-skip nominal ${requestedModel} (${budgetDetail}) — overload-class diversion (#654)`,
              true // forceConsole — operational event
            );
            budgetSynthResponse = new Response(
              JSON.stringify(
                wrapAnthropicError(
                  529,
                  `${budgetPrefix} busy — in-flight token budget exceeded (${budgetDetail})`,
                  "overloaded_error"
                )
              ),
              {
                status: 529,
                headers: {
                  "Content-Type": "application/json",
                  "Retry-After": "2",
                  "x-claudish-step-skip": encodeStepSkipHeader("busy", budgetDetail),
                },
              }
            );
          } else {
            logStderr(
              `[EndpointBudget] ${budgetPrefix} over budget with no diversion — serving anyway (${budgetDetail})`
            );
          }
        }
      }
      // #317: FRESH attempt token per upstream attempt — the usage sink keys
      // the max-ledger on it, and two paid attempts of one request must land
      // in two slots or the second under-counts. No-op when both bars are off.
      // The budget synth path (nominal → 529 for the walk block) must NOT
      // reach the handler — the engine never sees a refused attempt (AC2).
      // NB: `response` outlives the iteration (declared above the loop), so
      // the gate here is the LOCAL flag, never `response` truthiness — a
      // previous iteration's cancelled skip response is stale state.
      if (budgetSynthResponse) {
        response = budgetSynthResponse;
      } else {
        if (budgetDecision) releaseBudget = budgetDecision.commit();
        openSessionBudgetAttempt(c.req.raw, machineHeader, sessionKey, process.env);
        response = await handler.handle(c, body);
        if (pinnedModel && !response.ok) body.model = modelBeforePin;
      }
      if (releaseBudget && response) {
        // The lease lives exactly as long as the attempt's bytes: the wrapper
        // releases on stream end, consumer cancel, or error (a skipped/
        // cancelled body releases through its cancel hook; a bodyless
        // response immediately). Below this point every path — skip advance,
        // walk, notice wrap, return — carries the tracked body or drains it.
        response = withBudgetRelease(response, releaseBudget);
      }
      // #431 AC1/AC3 — a step that cannot take THIS request skips forward.
      // Two shapes, one header: `context` rides the overflow recovery turn
      // (HTTP 200 — classified from upstream or short-circuited by the learned
      // cap; without this block that ok would run the SUCCESS bookkeeping and
      // pin the session onto a step that just refused the prompt), `busy`
      // rides the bounded 529. Advance requires: a cascade step, a successor
      // (never the last step — its recovery turn / 529 IS the client's answer
      // today and stays so), and the kill switch off. No markStepFailed, no
      // bucket wall, no arm: the step is healthy, the request does not fit.
      // The dwell pin is handled at the resolution (a pin on the skipped
      // index yields for this request; the re-pin lands on the successor,
      // which is now what serves this session). Body drained: a discarded
      // recovery stream is a connection held open for nothing.
      {
        const stepSkip = readStepSkip(response);
        if (
          stepSkip &&
          role &&
          stepIndex >= 0 &&
          rule != null &&
          stepIndex < rule.steps.length - 1 &&
          // CR S4: a skip on the LAST iteration has no attempt left to advance
          // to — without this guard the `continue` would exit the loop and fall
          // through to the empty-return path, handing the client a bare 200
          // with no message_stop. The recovery turn / 529 of the last attempt
          // must be the answer (the predicate above normally prevents this —
          // the last STEP cannot skip — but `maxAttempts` can be exhausted one
          // iteration before the last step is reached, e.g. a delegated
          // resolution that advanced mid-request).
          attempt + 1 < maxAttempts &&
          !stepSkipDisabled()
        ) {
          log(
            `[Failover] SKIP ${role}[${stepIndex}] reason=${stepSkip.reason}` +
              (stepSkip.detail ? ` ${stepSkip.detail}` : "") +
              ` (${attemptConcreteNow ?? resolved.step?.target ?? "?"}) — advancing to next step, no failure mark`,
            true // forceConsole — operational event (#431 AC4)
          );
          skippedSteps.add(stepIndex);
          try {
            await response.body?.cancel();
          } catch {
            // already gone — nothing to drain
          }
          continue;
        }
      }
      if (response.ok) {
        if (role) {
          // #431 CR B1: record the step that actually produced this response —
          // the notice builders (applyFailoverNotices) resolve "who is serving"
          // generically and cannot see request-local skips, so without this a
          // successor-served turn announced the SKIPPED step's name. No-op on
          // the nominal (stepIndex -1 / undefined step), and cleared-by-design
          // per request (WeakMap on the Context).
          recordServedStepForNotices(c, role, resolved.step, stepIndex);
          if (stepIndex === -1) onNominalSuccess(role, bucket); // nominal healthy → fresh episode + maybe recovery
          else resetStepSuccess(role, stepIndex);
          // #274: the concrete model succeeded — clear the OWNING side too,
          // in the owner's vocabulary: the TARGET's bucket when the delegated
          // model was its nominal (never the delegating role's own bucket),
          // the TARGET's step otherwise.
          if (delegation) {
            if (delegation.owner.nominal) {
              // #367: the target is ALREADY CONCRETE — classify it, never
              // re-map it (nominalBucketOfModel runs the request-side
              // mapping: with a --model default, a keyword-free concrete
              // booked the DEFAULT's bucket; a role-keyworded concrete booked
              // the nominal's).
              const ownerBucket = await concreteStepBucketOf(delegation.concrete);
              onNominalSuccess(delegation.owner.role, ownerBucket);
            } else {
              resetStepSuccess(delegation.owner.role, delegation.owner.stepIndex);
            }
          }
        }
        return response;
      }
      if (!role) return response; // no role → no cascade possible
      let errBody = "";
      try {
        errBody = await response.clone().text();
      } catch {
        // unreadable body — status alone still decides for 402
      }
      if (!isQuotaExhaustion(response.status, errBody)) {
        // Fail-forward. A non-quota failure on an INTERMEDIATE cascade step still
        // has a working successor beneath it, so advancing serves the user instead
        // of surfacing a substitute's incident as if it were their own. This is what
        // makes wall *recognition* an optimization rather than a safety prerequisite:
        // an unrecognized wall on a middle step now degrades to one wasted round-trip,
        // not a failed request.
        //
        // Narrow on three axes, each for a different reason:
        //  - nominal (stepIndex -1) never advances ON A NON-OVERLOAD FAILURE:
        //    that is the user's own model failing, and it must surface. The one
        //    exception is the transient-overload walk below (#299-B).
        //  - the last step never advances: there is nothing beneath it.
        //  - wiring faults never advance: a mistyped model id in a step would become
        //    permanently invisible, every request stepping over it in silence.
        const isIntermediateStep =
          stepIndex >= 0 && rule != null && stepIndex < rule.steps.length - 1;
        // #299-B — one-shot overload walk. A 529 (or a 429/503 the patient
        // backoff already exhausted into a 529, or a 400 `connection_error`)
        // on the NOMINAL is a PROVIDER saying "unreachable/overloaded", not
        // the role's plan being walled (#299 measured 30 % of MiniMax
        // attempts failing so, 2026-10-02): the client retried a dozen times
        // against the same overloaded provider and then dropped the turn.
        // Try the FIRST SERVABLE cascade step ONCE, for this request only,
        // and write no FAILURE state — no arm, no stepFailures mark, no
        // bucket wall, no dwell pin (a SERVED attempt still mirrors the
        // loop's success bookkeeping, which a wall never feeds). The
        // separation is the #170 re-forward's (`no
        // markFail`): the moment the overload lifts, the very next request
        // re-probes the nominal instead of riding a cascade the role was
        // never exiled to.
        //
        // The NATIVE lane is excluded on purpose (review of #326, point 1):
        // its bucket is `anthropic-native/<model>` and its meter is the
        // CLIENT's own Anthropic credential — a native 529 says nothing about
        // a plan being walled, but serving the turn from a non-Claude step
        // WITHOUT a notice would contradict "every substitution is
        // announced", on the one model the client picked deliberately, while
        // Claude Code already retries its 529s on its own.
        const walkDisabled = (process.env.CLAUDISH_FAILOVER_OVERLOAD_WALK || "").trim() === "0";
        if (
          !isIntermediateStep &&
          stepIndex === -1 &&
          !overloadWalked &&
          !walkDisabled &&
          rule != null &&
          rule.steps.length > 0 &&
          !(bucket ?? "").startsWith(`${NATIVE_BUCKET}/`) &&
          // #412 (review ai-01 08/10, point 3): the native lane is excluded
          // ABOVE by its bucket prefix — but that predicate is a property of
          // `nominalBucketOfModel`, and a future bucketing change would reopen
          // the path silently. A keyless request never walks: the walk serves
          // the turn from a step the FLEET pays for, which is exactly what the
          // keyless invariant forbids, and its "no failure state" promise
          // would not make that spend legitimate.
          !keylessNative &&
          isOverloadWalkClass(response.status, errBody)
        ) {
          overloadWalked = true;
          // #348: the walk is a recovery attempt paid out of the client's
          // REMAINING patience. By the time a 429/503 overload reaches the
          // walk it has already climbed the transport ladder (~60 s) and the
          // patient backoff (~305 s) — ≈365 s, past the relay's 360 s header
          // deadline (the sidecar fell through and served locally; the hub's
          // walk output is unread) and leaving < 235 s of the 600 s client
          // timeout for a direct client whose walk step is ALSO slow.
          // CLAUDISH_FAILOVER_WALK_BUDGET_MS (default 300 s, 0 = off, read
          // per request): keeps the direct-client sum under 600 s with the
          // relayed 365 s class already excluded, while the measured driver
          // (a direct MiniMax 529, seconds) still walks.
          //
          // NO client-gone skip: a client abort is UNDETECTABLE here on this
          // stack (Bun + @hono/node-server, body already consumed — probe
          // matrix in budget-failover.md §One-shot overload walk). The
          // adapter's Request signal arms only at the first write;
          // `incoming.destroyed` is true on every HEALTHY request too (Bun
          // destroys the message once read); socket state and entry-time
          // events are identical with and without abort. A predicate built on
          // any of them would skip every walk or none — pin W16 guards this
          // negative result; the budget alone bounds a walk into an abandoned
          // request, and the walk is one attempt by construction.
          const walkBudgetMs = readWalkBudgetMs();
          const walkElapsedMs = Date.now() - cascadeStartedAtMs;
          if (walkBudgetMs > 0 && walkElapsedMs > walkBudgetMs) {
            log(
              `[Failover] WALK ${role} skipped — budget ${walkElapsedMs}ms > ${walkBudgetMs}ms (HTTP ${response.status} on nominal ${requestedModel})`,
              true
            );
            return response;
          }
          // First SERVABLE step, read-only (a step in per-step backoff or a
          // walled bucket is skipped — walking there is a round-trip at a
          // target we already know is dead; a role-step whose delegation
          // cannot resolve concrete is skipped too, so the ROLE NAME can
          // never reach the wire as a model id). Null ⇒ no servable step:
          // surface the original overload rather than substitute blind.
          // #348: the wall check buckets bare targets CANONICALLY (the
          // injected async resolver — providerBucketOf reads `glm` where the
          // wall lives on the route() primary `glm-coding`), and the
          // NOMINAL's own bucket is skipped too (same bucket = same capacity
          // the 529 just refused). The bucketer is concreteStepBucketOf, NOT
          // nominalBucketOfModel: a step target is already concrete, and the
          // request-side mapping would re-map a role-keyworded step id onto
          // the nominal's bucket (review 06/10 bloquant — probe-measured).
          //
          // A rejection here must NOT escape the try contract of the walk:
          // before #348 the call was sync and pure; it now awaits catalog +
          // route(). W14 made the catch load-bearing (a throw becomes a
          // terminal 400 instead of the retryable 529) — .catch(() => null)
          // keeps a resolver failure on the "no servable step" path: surface
          // the original overload. (Not pinned: no injection seam — named in
          // the PR body.)
          const walk = await resolveTransientStep(role, {
            bucketOf: concreteStepBucketOf,
            nominalBucket: bucket ?? undefined,
          }).catch(() => null);
          if (walk) {
            log(
              `[Failover] WALK ${role} one-shot (HTTP ${response.status} on nominal ${requestedModel}) → ${walk.concrete} (step ${walk.stepIndex})`,
              true
            );
            // #598: ONE paid walk attempt, factored so the connection-class
            // advance below reuses the exact bookkeeping. A served attempt
            // mirrors the loop's success (a success resets the step's failure
            // count; it never arms); a failed one writes NO state, ever
            // (#299 B). The failure is returned CLASSIFIED — the step's own
            // wire shape decides whether the walk may advance, and only its
            // body carries it.
            const attemptWalkStep = async (
              target: NonNullable<typeof walk>
            ): Promise<
              | { served: Response }
              | { served: null; status: number; errBody: string }
              | { served: null; budgetRefused: true }
            > => {
              const modelBeforeAttempt = body.model;
              // #654 r1 — the walk serves through the SAME endpoint budget as
              // the loop. A walk target carrying knobs is evaluated BEFORE the
              // call (on the hub, the budgeted vLLM endpoint is the haiku
              // cascade's step 0 — the first servable target of a haiku
              // overload walk, the exact traffic the budget exists to bound),
              // a refusal is a SKIP (zero calls, no state, advance to the next
              // servable step), and a served attempt commits its lease and
              // wraps its response — a walk-served request holding no lease
              // is the module's own "Σ lies low" failure.
              const walkBudgetPrefix = endpointPrefixOf(target.concrete);
              const walkBudget = walkBudgetPrefix
                ? evaluateEndpointTokenBudget(
                    walkBudgetPrefix,
                    body,
                    { machine: machineHeader, session: sessionKey },
                    process.env,
                    Date.now(),
                    (info) => logStderr(info)
                  )
                : null;
              if (walkBudget?.refused) {
                log(
                  `[Failover] WALK-SKIP ${role} → ${target.concrete} reason=busy ${formatBudgetFacts(
                    walkBudget.facts,
                    true,
                    walkBudget.reason
                  )} — endpoint token budget (#654)`,
                  true
                );
                return { served: null, budgetRefused: true };
              }
              let walkRelease: (() => void) | undefined;
              // #628 review (bloquant, classe #331): the delegation owner is
              // STATE-DEPENDENT — resolveRoleStep reads the target nominal's
              // bucket wall, and can arm it. Resolved AFTER the attempt, a wall
              // moved by another request during the round-trip would credit a
              // step that never served (a false recovery that brings a benched
              // step back). Resolve BEFORE the call, as `main` did, and credit
              // only when the resolved concrete is still the one attempted —
              // the guard also closes `main`'s residual window between
              // resolution and the call.
              const targetDelegation = target.step.roleRef
                ? resolveDelegationOwner(role, target.step)
                : null;
              try {
                const targetHandler = await getHandlerForRequest(
                  target.concrete,
                  0,
                  sessionKey,
                  bucket,
                  target.concrete
                );
                if (walkBudget) walkRelease = walkBudget.commit();
                // #317: the walk is a paid upstream attempt too — fresh token.
                openSessionBudgetAttempt(c.req.raw, machineHeader, sessionKey, process.env);
                const targetResp = await targetHandler.handle(c, body);
                if (targetResp.ok) {
                  // The step proved itself — mirror the loop's success
                  // bookkeeping (a success resets a step's failure count; it
                  // never arms).
                  if (!target.step.roleRef) resetStepSuccess(role, target.stepIndex);
                  // Only credit the owner that actually served: a delegation
                  // resolved to a different concrete (or to null ⇒ cannot
                  // serve) during the round-trip must not lift a wall or reset
                  // a step on a success it did not produce.
                  if (targetDelegation && targetDelegation.concrete === target.concrete) {
                    if (targetDelegation.owner.nominal) {
                      // #367 (same class as the W19 bucketer): the walk's
                      // delegated concrete is already concrete — classify, no
                      // request-side re-mapping.
                      const ownerBucket = await concreteStepBucketOf(targetDelegation.concrete);
                      onNominalSuccess(targetDelegation.owner.role, ownerBucket);
                    } else {
                      resetStepSuccess(
                        targetDelegation.owner.role,
                        targetDelegation.owner.stepIndex
                      );
                    }
                  }
                  return {
                    served: walkRelease ? withBudgetRelease(targetResp, walkRelease) : targetResp,
                  };
                }
                // Not ok: the step's own incident must not become the client's
                // answer, and its unread body is a connection held open for
                // nothing. READ it rather than cancelling it — the body is both
                // the classifier's input (#598) and the drain; the drained
                // bytes end the lease.
                const targetErrBody = await targetResp.text().catch(() => "");
                walkRelease?.();
                return { served: null, status: targetResp.status, errBody: targetErrBody };
              } catch {
                // The attempt itself threw — no class, so no advance: the
                // original overload stands. The lease (if committed) ends here.
                walkRelease?.();
                return { served: null, status: 0, errBody: "" };
              } finally {
                body.model = modelBeforeAttempt;
              }
            };
            const firstAttempt = await attemptWalkStep(walk);
            if (firstAttempt.served) return firstAttempt.served;
            // #654 r1 — a budget-refused target was never called: the
            // admission gate fired before the engine, so the walk advances to
            // the next servable step with the loop's skip semantics — no call,
            // no mark, no wall, no arm. Bounded to ONE hop, like everything
            // the walk buys; a second refusal surfaces the ORIGINAL overload
            // (the budget bounds admission, it never refuses a servable
            // request outright — the next request re-probes the nominal).
            if ("budgetRefused" in firstAttempt && firstAttempt.budgetRefused) {
              const budgetSkip = await resolveTransientStep(role, {
                bucketOf: concreteStepBucketOf,
                nominalBucket: bucket ?? undefined,
                afterStepIndex: walk.stepIndex,
              }).catch(() => null);
              if (budgetSkip) {
                const skipped = await attemptWalkStep(budgetSkip);
                if (skipped.served) return skipped.served;
              }
              return response;
            }
            // #598 — a step that died CONNECTION-class has told us the HOST was
            // unreachable, not that its plan is walled. Measured 2026-10-22:
            // the nominal's egress and walk step 0's were the same dead host,
            // so 194/194 sonnet walks re-picked step 0 and step 1 was never
            // tried — a transport failure writes no state by design (#299 B),
            // so `firstServable` keeps finding that same dead step servable.
            // Advance ONCE, to the next servable step, still writing no plan
            // state. Deliberately NOT on a 402/429/503/529: that is capacity
            // the resolver owns, and stepping over it would re-buy exactly what
            // #299 B rejected (pin W31). The bound is structural — this block
            // runs once per request, and the advanced attempt never advances in
            // turn.
            // The budget bounds the WALK, not its entry: the advance is a paid
            // attempt too, so re-check the elapsed time before buying it.
            // Reaching here already means one more connection failure was
            // absorbed; a budget that admitted the first attempt and not the
            // second is the intended shape (worst case: nominal + 1 walk +
            // the advance's own connect timeout, all inside the budget).
            const advanceElapsedMs = Date.now() - cascadeStartedAtMs;
            if (
              isConnectionWalkClass(firstAttempt.status, firstAttempt.errBody) &&
              walkBudgetMs > 0 &&
              advanceElapsedMs > walkBudgetMs
            ) {
              log(
                `[Failover] WALK-ADVANCE ${role} skipped — budget ${advanceElapsedMs}ms > ${walkBudgetMs}ms`,
                true
              );
            } else if (isConnectionWalkClass(firstAttempt.status, firstAttempt.errBody)) {
              const nextWalk = await resolveTransientStep(role, {
                bucketOf: concreteStepBucketOf,
                nominalBucket: bucket ?? undefined,
                afterStepIndex: walk.stepIndex,
              }).catch(() => null);
              if (nextWalk) {
                log(
                  `[Failover] WALK-ADVANCE ${role} — step ${walk.stepIndex} (${walk.concrete}) died connection-class; one extra attempt at ${nextWalk.concrete} (step ${nextWalk.stepIndex})`,
                  true
                );
                const advanced = await attemptWalkStep(nextWalk);
                if (advanced.served) return advanced.served;
              }
            }
          }
          return response;
        }
        if (!isIntermediateStep) {
          // #609: a delegating LAST step whose concrete failed non-quota walks
          // the target's remaining path before surfacing. No mark is written —
          // the last step's contract today (nothing beneath it to protect); the
          // exclusion set is the request's only memory of the failure. A wiring
          // fault still surfaces: a mistyped id must stay visible.
          if (!isWiringError(response.status, errBody) && walkDelegatedTarget()) {
            try {
              await response.body?.cancel();
            } catch {
              // already gone — nothing to drain
            }
            attempt--;
            continue;
          }
          return response;
        }
        if (isWiringError(response.status, errBody)) {
          log(
            `[Failover] STEP-WIRING ${role} step=${stepIndex} — HTTP ${response.status} looks like a misconfigured step; surfacing instead of advancing`,
            true
          );
          return response;
        }
        // Loud on purpose: advancing must never be silent, or a persistently sick
        // step is indistinguishable from a healthy cascade.
        const why = `HTTP ${response.status} (non-quota) from step ${stepIndex}`;
        log(`[Failover] STEP-ADVANCE ${role} — ${why}; trying next step`, true);
        // Marked, not merely skipped: the first backoff rung is 10 min, so a transient
        // blip costs one short skip of a step that has a live successor — whereas not
        // marking makes every subsequent request re-pay the round-trip (and its
        // timeout) to a step that may be down for hours. Any success resets the count.
        // The nonQuota flag (#276) is what keeps a dwell-pinned session from being
        // re-pinned DEEPER by this advance: the step is broken, not walled, so the
        // session's dwell is forfeited (it rejoins the general resolution each
        // request) instead of riding this step's successor past a recovered nominal.
        // #331: every mark carries the CONCRETE this attempt served — a role
        // step's TTL binds only while its delegation keeps resolving there.
        const attemptConcrete = delegation?.concrete ?? resolved.step?.target;
        markStepFailed(role, stepIndex, why, parseResetAtFromBody(errBody), {
          nonQuota: true,
          concrete: attemptConcrete,
        });
        if (delegation && !delegation.owner.nominal) {
          markStepFailed(delegation.owner.role, delegation.owner.stepIndex, why, parseResetAtFromBody(errBody), {
            nonQuota: true,
            concrete: delegation.concrete,
          });
        }
        // #609: the target's remaining path comes before the caller's next step.
        if (walkDelegatedTarget()) {
          try {
            await response.body?.cancel();
          } catch {
            // already gone — nothing to drain
          }
          attempt--;
        }
        continue;
      }
      const reason = `HTTP ${response.status} from ${requestedModel}`;
      if (stepIndex === -1) {
        // #412 (review ai-01 08/10, point 1): a keyless NATIVE request surfaces
        // the client's own wall — it is their meter that is exhausted — and
        // arms nothing. Arming here would exile the role for a TTL off a
        // credential the fleet does not hold, and the retry it triggers would
        // then hand the client a 401 about a key they never needed. One
        // countable marker, then the native response.
        if (keylessNative) {
          logStderr(
            `[ProxyAuth] keyless native ${requestedModel} [${bucket ?? "-"}] → HTTP ${response.status} surfaced, no arm (client's own credential)`
          );
          return response;
        }
        // Nominal walled (#91 gate: burst discrimination + grace before arming —
        // see onNominalRefusal). "armed" also covers the concurrent-request race
        // where another request armed the role between this one's handler
        // resolution and its 429: proceeding to the retry serves it from the
        // cascade instead of surfacing a raw 429 (production 2026-08-20: the
        // disarm-probe window at each 10-min TTL raced two opus requests; the
        // loser died client-side with "API Error").
        const verdict = onNominalRefusal(role, reason, response.headers.get("retry-after"), errBody, bucket);
        if (verdict.outcome === "burst") {
          // A short retry-after names a burst: surface it, the client ladder
          // absorbs it, the role never exiles for a 10-min TTL off a blip.
          return response;
        }
        if (verdict.outcome === "grace") {
          // Under CLAUDISH_FAILOVER_ARM_AFTER consecutive refusals. With
          // ARM_GRACE_MS configured, buy the nominal a few seconds of patience
          // inside this same request (one retry) before surfacing the 429.
          if (armGraceMs > 0 && !graceRetried) {
            graceRetried = true;
            await new Promise((r) => setTimeout(r, armGraceMs));
            attempt--; // replay the nominal attempt, not a cascade step
            continue;
          }
          return response;
        }
        // "armed" — fall through: the retry below re-resolves the handler and
        // serves from the cascade.
      } else {
        // #274 delegated bookkeeping: the delegating step is marked ONCE, and
        // the owning side records the wall in ITS OWN vocabulary — a
        // delegated qualifying wall of the target's nominal goes through the
        // TARGET's grace/arm semantics (onNominalRefusal on the target's
        // bucket, so delegated traffic itself accumulates the arm instead of
        // waiting for direct traffic), and a delegated wall of the target's
        // step marks THAT step's backoff. Exactly one increment per failure on
        // each side (the first cut double-marked the delegating step: 10→30min
        // off a single wall).
        if (delegation?.owner.nominal) {
          markStepFailed(role, stepIndex, reason, parseResetAtFromBody(errBody), {
            concrete: delegation.concrete,
          });
          // #367: already-concrete delegation target — concreteStepBucketOf
          // (classify + route), not the request-side mapping: the delegated
          // wall must arm the bucket the target ACTUALLY draws on.
          const ownerBucket = await concreteStepBucketOf(delegation.concrete);
          onNominalRefusal(delegation.owner.role, reason, response.headers.get("retry-after"), errBody, ownerBucket);
        } else {
          markStepFailed(role, stepIndex, reason, parseResetAtFromBody(errBody), {
            concrete: delegation?.concrete ?? resolved.step?.target,
          });
          if (delegation && delegation.owner.nominal === false) {
            markStepFailed(delegation.owner.role, delegation.owner.stepIndex, reason, parseResetAtFromBody(errBody), {
              concrete: delegation.concrete,
            });
          }
        }
        // #609: a delegated wall walks the target's remaining path in-request —
        // the marks above are written exactly as before; the walk only decides
        // what THIS request tries next. Exhausted → today's advance / surface.
        if (walkDelegatedTarget()) {
          try {
            await response.body?.cancel();
          } catch {
            // already gone — nothing to drain
          }
          attempt--;
          continue;
        }
        if (rule && stepIndex === rule.steps.length - 1) {
          // #409: a walled LAST step used to surface the provider's own status
          // verbatim. Claude Code renders a 403 as an auth failure and offers an
          // Anthropic login prompt (measured ai-01 2026-10-08: Kimi's weekly 403
          // blocked a session on that prompt until the user intervened), and a
          // DeepSeek 402 "Insufficient Balance" reads as a wiring error to fix by
          // hand. Both ARE budget walls — isQuotaExhaustion just classified them,
          // the steps above were walled the same way — so say so in the
          // vocabulary the client already retries: 429 rate_limit_error, which is
          // what Anthropic's own weekly cap returns, with a retry-after bounded
          // by the proxy's next re-probe (capped at the wall-TTL max — below).
          // The message names role, concrete and original status,
          // so the wall is never silent. Native lane excluded: its meter is the
          // client's own Anthropic credential, which already speaks 429 (the
          // walk above uses the same bucket guard). 401/404 never reach here —
          // they don't classify as walls and surface unchanged.
          if (!(bucket ?? "").startsWith(`${NATIVE_BUCKET}/`)) {
            const lastConcrete = delegation?.concrete ?? resolved.step?.target ?? requestedModel;
            let upstreamMsg = errBody.slice(0, 200);
            try {
              const parsed = JSON.parse(errBody);
              const m = parsed?.error?.message ?? parsed?.message;
              if (typeof m === "string" && m.length > 0) upstreamMsg = m.slice(0, 200);
            } catch {
              // not JSON — the raw slice above already is the message
            }
            const headers = new Headers({ "Content-Type": "application/json" });
            // CR1a — the horizon is the proxy's next re-probe of ANY walled
            // element (bucket-wall TTL expiry, step backoff expiry, or a known
            // step reset when one is named), never a far-future announced
            // reset alone: a retry-after beyond that moment tells the client
            // to sleep through the return of service. CR1b — defensive ceiling
            // at the bucket-wall TTL cap (ARM_TTL_MAX_MS, 40 min): the horizon
            // can exceed it only via a distant step reset (Kimi announces a
            // week while GLM reopens every 5 h), and Claude Code honors a
            // multi-day retry-after by sleeping or abandoning the turn.
            const horizon = earliestWalledReprobeAt(role, bucket);
            let capped = false;
            if (horizon) {
              const seconds = Math.max(1, Math.ceil((horizon.getTime() - Date.now()) / 1000));
              capped = seconds > ARM_TTL_MAX_MS / 1000;
              headers.set("retry-after", String(Math.min(Math.ceil(ARM_TTL_MAX_MS / 1000), seconds)));
            }
            log(
              `[Failover] WALL-SURFACE ${role} — HTTP ${response.status} from ${lastConcrete} rewritten to 429 rate_limit_error` +
                (horizon
                  ? ` (retry-after ${headers.get("retry-after")}s${capped ? ", capped at wall-TTL max" : ""})`
                  : " (no re-probe horizon — retry-after omitted)"),
              true
            );
            // The upstream body was only ever read from a clone; the original is
            // a connection held open for nothing once we replace the response.
            try {
              await response.body?.cancel();
            } catch {
              // already gone — nothing to drain
            }
            return new Response(
              JSON.stringify({
                type: "error",
                error: {
                  type: "rate_limit_error",
                  message: `[Failover] ${role}: every step walled — last: ${lastConcrete} ${response.status}: ${upstreamMsg}`,
                },
              }),
              { status: 429, headers }
            );
          }
          return response; // last step also walled (native lane: surface as-is)
        }
      }
    }
    return response as Response;
  };

  // Failover/recovery notices: applyFailoverNotices() in
  // failover-stream-notice.ts, applied per route through noticePolicyForIngress —
  // content on /v1/messages, response header on /v1/chat/completions (#229).

  // Fork extension: hostname binding + remote address tracking
  const hostnameConfig = createHostnameConfig(options.hostname);

  /**
   * #83 grain 2: append the capability query to a collected (non-streaming)
   * response — the condensation rail, mirroring applyFailoverNotices'
   * non-streaming branch but independent of any failover role. Streaming passes
   * through untouched (condensation is the non-stream path). Gate re-read per
   * call (`CLAUDISH_CAPABILITY_VOCAB`, default off). Never throws.
   */
  const applyCapabilityQueryAtCondensation = async (
    response: Response,
    sessionKey: string | null,
    wantsStreaming: boolean
  ): Promise<Response> => {
    if (wantsStreaming || !response.ok) return response;
    if (!sessionKey || !isCapabilityVocabEnabled(process.env)) return response;
    try {
      const message = await response.clone().json();
      if (appendCapabilityQueryToMessage(message, sessionKey, process.env)) {
        log(`[Capability] query appended to condensation (session=${sessionKey.slice(0, 8)})`);
        const headers = new Headers(response.headers);
        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(message), { status: response.status, headers });
      }
      return response;
    } catch {
      return response;
    }
  };

  const app = new Hono();
  app.use("*", cors());

  // Terminal-safety backstop (absorbed from upstream 218c3586). Hono's DEFAULT
  // error handler is literally `console.error(err)` + a text/plain
  // "Internal Server Error" — so an unhandled route rejection prints a
  // multi-line error dump onto stderr, which under a relayed session IS Claude
  // Code's TTY, and hands the client a non-JSON body it cannot render. With
  // onError installed, no route rejection can ever reach a console again: it
  // goes to the log file, and the client gets a single-line Anthropic JSON
  // envelope (c.json serializes; control bytes stay escaped inside the string).
  app.onError((err, c) => {
    logStderr(`[Proxy] Unhandled error on ${c.req.method} ${c.req.path}: ${err?.message ?? err}`);
    log(`[Proxy] Unhandled error stack: ${err?.stack ?? "(no stack)"}`);
    // A routing failure stays TERMINAL even when it arrives here. Every
    // route that can raise one maps it already, so this is not a live gap —
    // it is the place a FUTURE route lands, and a 500 there would hand back
    // the retryable status this whole change exists to remove. The `return
    // await` above is the proof the path is real: it fixed a rejection that
    // escaped its try/catch and would have surfaced exactly here.
    if (err instanceof RoutingError) {
      return c.json(wrapAnthropicError(400, err.message, "invalid_request_error"), 400);
    }
    return c.json(wrapAnthropicError(500, `Proxy error: ${err?.message ?? String(err)}`), 500);
  });

  // Fork extensions: proxy auth + model discovery
  registerForkExtensions(app, { proxyKeys, inboundKeys, routedBareNames });

  app.get("/", (c) =>
    c.json({
      status: "ok",
      message: "Claudish Proxy",
      config: { mode: monitorMode ? "monitor" : "hybrid", mappings: modelMap },
    })
  );
  // Drain support (fork): count in-flight SSE streams so the watchdog can wait
  // for a quiet moment instead of dropping every agent mid-response. See
  // fork/server/stream-registry.ts for the full rationale.
  const streamTracker = createStreamTracker();
  const startedAt = Date.now();
  // #587 gate — event-loop lag probe. bun's perf_hooks.monitorEventLoopDelay
  // is a measured STUB on the hub's production runtime (a 200 ms synchronous
  // block records 0 on oven/bun 1.3.14, script context, top-level and inside
  // a timer callback alike), so the gate cannot ride it. A repeating 20 ms
  // timer measures how late it fires instead — the same quantity, portable.
  //
  // #615 review redesign: the percentiles are GONE. A setInterval does not
  // catch up after a block — one long block leaves ONE sample, so p99 never
  // moved (measured: 2 s block, p99 unchanged at 26), and reading them cost
  // two Array.from().sort() per /health call (7.89 ms on a full ring) on the
  // very loop being measured. What the relay-flip question needs is a signal
  // localizable IN TIME, joinable with the sidecars' AUTONOMOUS lines on the
  // same clock:
  //   - a [EventLoop] log line the moment a tick runs ≥ LAG_LOG_THRESHOLD_MS
  //     late (docker logs -t timestamps it; one line per block, not per tick);
  //   - /health eventLoopMax60sMs — a windowed max that RETIRES;
  //   - /health eventLoopBlockedMs5m — the sum of lag over the window, floored
  //     at LAG_BLOCK_FLOOR_MS so an idle Windows seat's timer granularity (a
  //     20 ms interval fires at ~31 ms → every tick "lags" ~11 ms) does not
  //     read as five minutes of blockage — see docs/reference/relay-internals.md;
  //   - eventLoopMaxMs stays as the cumulative high-water mark — one 03:00 GC
  //     pause can pin it forever, so date episodes with the windowed max.
  // Samples are sparse (positive lags only) with per-sample timestamps: a
  // window read walks backwards from the newest sample and stops at the first
  // one older than the edge — O(samples in window), no sort, no allocation.
  // Observation only: nothing gates on these.
  const LAG_TICK_MS = 20;
  const LAG_RING = 15_000;
  const LAG_LOG_THRESHOLD_MS = 250;
  const LAG_BLOCK_FLOOR_MS = 50;
  const lagRing = new Float64Array(LAG_RING);
  const lagTsRing = new Float64Array(LAG_RING);
  let lagCount = 0;
  let lagMaxCumulative = 0;
  // #615 review point 2: the probe runs on the MONOTONIC clock. `Date.now()`
  // is wall time, so an NTP resync (or the WSL2 VM clock catching up after
  // host load) steps it forward and manufactures a phantom `[EventLoop] lag=`
  // line — precisely the false positive that would correlate with an
  // AUTONOMOUS flip caused by the same host event — while a backward step
  // silently drops samples. `performance.now()` cannot step. The log line
  // still gets its wall time from `docker logs -t`, which is the clock the
  // sidecars' transitions are read on.
  const lagState = { lastTick: performance.now() };
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lagState.lastTick - LAG_TICK_MS;
    if (lag > 0) {
      const slot = lagCount % LAG_RING;
      lagRing[slot] = lag;
      lagTsRing[slot] = now;
      lagCount++;
      if (lag > lagMaxCumulative) lagMaxCumulative = lag;
      if (lag >= LAG_LOG_THRESHOLD_MS) logStderr(`[EventLoop] lag=${Math.round(lag)}ms`);
    }
    lagState.lastTick = now;
  }, LAG_TICK_MS);
  lagTimer.unref?.();
  const lagWindowed = (windowMs: number, mode: "max" | "blockedSum"): number => {
    // Walk sample indices newest→oldest (monotone in lagCount); modulo maps an
    // index to its ring slot once the ring has wrapped. Timestamps are monotone
    // in the index, so the first sample older than the edge ends the walk.
    const edge = performance.now() - windowMs;
    const oldest = Math.max(0, lagCount - LAG_RING);
    let out = 0;
    for (let idx = lagCount - 1; idx >= oldest; idx--) {
      const slot = idx % LAG_RING;
      if (lagTsRing[slot] < edge) break;
      const lag = lagRing[slot];
      if (mode === "max") {
        if (lag > out) out = lag;
      } else if (lag >= LAG_BLOCK_FLOOR_MS) out += lag;
    }
    return Math.round(out * 10) / 10;
  };
  app.use("*", streamTracker.middleware);

  // Liveness, not mere existence. This was a constant-time JSON handler that
  // touched nothing in the request pipeline, so it answered 200 from a process
  // serving nobody — which is exactly how the 2026-09-02 outage (hub silent
  // 03:20:45Z → 05:47Z) stayed invisible to every sidecar prober for 2h27 while
  // they kept relaying into it. `relay.ts` documents that hole and calls it
  // "never observed"; it has been observed once now, fleet-wide.
  //
  // So: streams in flight and nothing moving → 503, which is the signal the
  // probers already act on (2 failures, 10s apart → AUTONOMOUS). `status` stays
  // first and the body keeps `activeStreams`, so the drain script and the
  // watchdog are unaffected; the two new fields explain a demotion after the fact.
  //
  // #157, the adjacent family member (2026-09-19): a 200 from a process in the
  // WRONG ROLE — a hub recreated as a relay forwarding to itself answered
  // "ok" for 4h40 while flapping 193 times. `role` + `upstream` (origin only)
  // make that visible in one call. Same parse-safety rule: appended after the
  // existing fields, nothing renamed.
  //
  // #156 closes that loop with identity: `instanceId` is a random per-process
  // nonce, and a relay additionally publishes `selfLoop` — true when the
  // upstream's /health returned OUR OWN id (detected in relay.ts heartbeat).
  // Appended after the existing fields; nothing renamed.
  app.get("/health", (c) => {
    const thresholdMs = stallThresholdMs();
    const stalled = streamTracker.isStalled(thresholdMs);
    const { role, upstream } = relayHealthFields(options.relay);
    return c.json(
      {
        status: stalled ? "stalled" : "ok",
        activeStreams: streamTracker.getActiveStreams(),
        pendingRequests: streamTracker.getPendingRequests(),
        msSinceProgress: streamTracker.getMsSinceProgress(),
        stallThresholdMs: thresholdMs,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        role,
        upstream,
        instanceId: getInstanceId(),
        // #306 review — the drain reads THIS to confirm the proxy actually
        // sees its flag (drain home vs container mount can differ; a VM clock
        // skew can expire a fresh flag). The reason, never the flag content.
        admissionFreeze: admissionFreezeState().reason,
        ...(options.relay ? { selfLoop: options.relay.selfLoop } : {}),
        // #439 — previous-key hits per bucket during a rotation window.
        // Omitted entirely when no window is open (that absence IS the
        // signal). Appended last: nothing renamed, older parsers unaffected.
        ...(previousKeyHitsSnapshot() ?? {}),
        // #587 — event-loop lag, time-localized (#615 review redesign: the
        // percentiles are gone — one long block leaves ONE sample so p99
        // never moved, and two sorts per call cost 7.89 ms on this very
        // loop). eventLoopMax60sMs is the windowed max (it retires);
        // eventLoopBlockedMs5m the floored sum of lag over the window
        // (weighs a block by its length; the 50 ms floor keeps an idle
        // Windows seat's ~11 ms timer granularity from reading as
        // blockage — see docs/reference/relay-internals.md); eventLoopMaxMs
        // the cumulative high-water mark since start — a single 03:00 GC
        // pause can pin it forever, so date episodes with the windowed max
        // and the [EventLoop] log line (timestamped by docker logs -t, it
        // joins with the sidecars' AUTONOMOUS flips on the same clock).
        // 0 on a fresh process; nothing renamed, nothing gates on these.
        eventLoopMax60sMs: lagWindowed(lagProbeWindows.maxMs, "max"),
        eventLoopBlockedMs5m: lagWindowed(lagProbeWindows.blockedMs, "blockedSum"),
        eventLoopMaxMs: Math.round(lagMaxCumulative * 10) / 10,
      },
      stalled ? 503 : 200
    );
  });

  // Token counting
  app.post("/v1/messages/count_tokens", async (c) => {
    try {
      // #548 — same client-error terminal 400 as /v1/messages: c.req.json()
      // throws a SyntaxError on empty / non-JSON input that the catch below
      // maps to a retryable 500 (which relays count toward hub hysteresis).
      // Answered before the freeze gate, handler resolution and any forward.
      let body: any;
      try {
        body = await c.req.json();
      } catch (parseErr) {
        return c.json(
          wrapAnthropicError(400, `Invalid request body: ${(parseErr as Error)?.message ?? parseErr}`, "invalid_request_error"),
          400
        );
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return c.json(
          wrapAnthropicError(400, "Invalid request body: expected a JSON object", "invalid_request_error"),
          400
        );
      }
      // #306 review — same admission freeze as the serving routes: messages
      // are refused during the window, so counting for a message that can no
      // longer be admitted is the asymmetry po-2024 flagged. Same 503 +
      // Retry-After, in-flight streams untouched.
      const freeze = drainFreezeGate();
      if (freeze) return freeze;
      if (typeof body?.model !== "string" || body.model.length === 0) {
        return c.json(
          wrapAnthropicError(400, "missing required field: model"),
          400
        );
      }
      // #412 — same suppression as the serving routes: this resolution writes
      // the dwell pin too, and the keyless guard just below must see the
      // handler the request would ACTUALLY get, not a swapped one. Same bucket
      // as the serving routes too (#552 review, B2): with `undefined` the
      // resolution fell back to the nominal's bucket, so a machine-armed
      // caller counted against the nominal instead of the model that answers,
      // and the nominal landing deleted its session's dwell pin.
      const handler = await getHandlerForRequest(
        body.model,
        0,
        extractSessionKey(body),
        await requestBucketOf(c, body.model),
        undefined,
        keylessNativeRequest(c, body.model)
      );

      // #412 — same invariant on the counting path as on the serving one, and
      // for the same reason: a keyless request resolves here to a handler that
      // would spend the FLEET's credential. No cascade on this route, so there
      // is no prior attempt to surface — it is always the labeled 401.
      if (isKeylessExempt(c.req.raw) && !(handler instanceof NativeHandler)) {
        const lane = resolveNominalTarget(body.model).target;
        logStderr(
          `[ProxyAuth] keyless request for ${body.model} resolves to a server-held credential (${lane}) — refused, zero upstream fetch (count_tokens)`
        );
        return c.json(
          wrapAnthropicError(401, keylessRefusalMessage(body.model, lane), "authentication_error"),
          401
        );
      }

      // If native, forward transparently (all client headers passthrough).
      if (handler instanceof NativeHandler) {
        // Same pin as the serving path: counting against a different model than the
        // one that will answer makes the client's own context accounting drift.
        const pinnedModel = resolveNativeModelPin(body.model, modelMap);
        if (pinnedModel) body.model = pinnedModel;
        const HOP_BY_HOP = new Set([
          "host", "connection", "keep-alive", "transfer-encoding", "te",
          "trailer", "upgrade", "content-length",
        ]);
        const reqHeaders: Record<string, string> = { "Content-Type": "application/json" };
        for (const [key, value] of Object.entries(c.req.header())) {
          if (HOP_BY_HOP.has(key.toLowerCase()) || typeof value !== "string") continue;
          reqHeaders[key] = value;
        }
        // #282 — same strip as NativeHandler.handle: the proxy's own headers
        // (cluster key, attribution, hop list) never reach api.anthropic.com.
        stripProxyOwnHeaders(reqHeaders);
        // Proxy key override (same logic as NativeHandler)
        let credentialSubstituted = false;
        if (proxyKeys.length > 0) {
          const authHeader = c.req.header("authorization");
          const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
          const clientAuthToken = c.req.header("x-api-key") || bearerToken;
          if (matchesProxyKey(clientAuthToken, proxyKeys)) {
            // #439 — this swap is one of the sites that ACCEPT a proxy key:
            // count it when it is the retiring one (no-op outside a window).
            // The middleware's mark on c.req.raw (exemption branch, which
            // count_tokens crosses — /v1/*) keeps one request = one count.
            noteProxyKeyAuthentication(clientAuthToken, c.req.header(), c.req.raw);
            delete reqHeaders["x-api-key"];
            delete reqHeaders["authorization"];
            if (anthropicApiKey) {
              credentialSubstituted = true;
              if (anthropicApiKey.startsWith("sk-ant-oat")) {
                reqHeaders["authorization"] = `Bearer ${anthropicApiKey}`;
              } else {
                reqHeaders["x-api-key"] = anthropicApiKey;
              }
            }
          }
        }

        // #296 — same credential guard as NativeHandler.handle: refuse locally
        // when the post-swap credential is absent (shape A) or foreign
        // (shape B), instead of forwarding to api.anthropic.com.
        const refusalShape = nativeCredentialRefusalShape(reqHeaders, credentialSubstituted);
        if (refusalShape) {
          log(
            `[Native] refused — no Anthropic credential to send (shape=${refusalShape}, model=${body.model}, path=count_tokens)`,
            true
          );
          return nativeCredentialRefusalResponse(body.model);
        }

        // #305 — same mixed-credential strip as NativeHandler.handle.
        const strippedForeign = stripForeignCredentialBesideAnthropic(reqHeaders);
        if (strippedForeign.length > 0) {
          log(
            `[Native] stripped foreign credential beside Anthropic credential (header=${strippedForeign.join(",")}, model=${body.model}, path=count_tokens)`,
            true
          );
        }
        // #305 AC 1 — same measurement instrument (names only, OFF by default).
        if (nativeHeaderNamesLogEnabled()) {
          log(`[Native][hdr-names] ${nativeAuthHeaderNames(c.req.header())} (count_tokens)`, true);
        }

        const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(body),
        });
        return c.json(await res.json());
      } else {
        // OpenRouter handler logic (estimation)
        const txt = JSON.stringify(body);
        return c.json({ input_tokens: Math.ceil(txt.length / 4) });
      }
    } catch (e) {
      // Routing failures are terminal — surface as a non-retryable 400 (bbb448f6).
      if (e instanceof RoutingError) {
        return c.json(wrapAnthropicError(400, e.message, "invalid_request_error"), 400);
      }
      // This branch logged NOTHING at all before: same blind spot as the
      // /v1/messages catch, and this route is on the relay's forward path too.
      logStderr(`[Proxy] ERROR 500 on POST ${c.req.path}: ${e}`);
      return c.json(wrapAnthropicError(500, String(e)), 500);
    }
  });

  /**
   * #306 — admission freeze gate for the drain's final pre-restart window.
   * Returns the 503+Retry-After Response when the freeze is live, null when
   * admissions flow. Called after the body is read (keep-alive hygiene: an
   * unread body would poison the next request on the connection) and before
   * any handler/relay work. In-flight streams never re-enter a route, so they
   * are untouched by construction; /health is not gated, so the drain keeps
   * polling right through the freeze.
   */
  const drainFreezeGate = (): Response | null => {
    const state = admissionFreezeState();
    if (!state.frozen) return null;
    log(`[DrainFreeze] admission refused — 503 + Retry-After (state=${state.reason})`, true);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "overloaded_error",
          message:
            "Proxy is draining for a restart (admission freeze). Retry shortly — in-flight streams are unaffected.",
        },
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": "15",
          // #318 — marks this 503 as OUR deliberate drain window. A relaying
          // sidecar treats an unmarked 503 as a hub failure (markFail + local
          // replay, #299 A's rationale); the marker lets it pass this one
          // through like a 4xx instead. Explicit header, not body sniffing:
          // real provider overloads emit an Anthropic-shaped overloaded_error
          // body too. Never stripped on the hub→relay response path (#282's
          // x-claudish-* strip is native-lane-toward-Anthropic only).
          "x-claudish-drain-freeze": "1",
        },
      }
    );
  };

  app.post("/v1/messages", async (c) => {
    try {
      // readRequestBody inflates a gzipped body (WAN external sidecar → hub);
      // identical to c.req.json() on the uncompressed LAN/direct path.
      // #548 — an empty / non-JSON / non-object body is the CLIENT's error: a
      // terminal 400, not a retryable 500 (Claude Code loops on "API error ·
      // Retrying" against a 5xx, and a sidecar's local 500 would pollute the
      // hub-500 signal the relays arm hysteresis on). Answered before the
      // relay branch, handler selection and any upstream call.
      let body: any;
      try {
        body = await readRequestBody(c);
      } catch (parseErr) {
        return c.json(
          wrapAnthropicError(400, `Invalid request body: ${(parseErr as Error)?.message ?? parseErr}`, "invalid_request_error"),
          400
        );
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return c.json(
          wrapAnthropicError(400, "Invalid request body: expected a JSON object", "invalid_request_error"),
          400
        );
      }

      // #306 — opt-in admission freeze, BEFORE the relay branch: the freeze
      // belongs to THIS container's restart, so a frozen admission must not
      // be forwarded either (a forward would die mid-body when the local
      // container restarts — strictly worse than a clean retryable 503).
      const freeze = drainFreezeGate();
      if (freeze) return freeze;

      // Sidecar relay (fork extension). In NOMINAL mode (upstream configured +
      // alive) forward the raw request to the central hub and return its piped
      // response. This branch sits BEFORE interceptWebTools / getHandlerForRequest
      // / logRequest, so nominal forwards do NOT capture locally (the hub captures
      // centrally) — mode-aware capture for free. A pre-stream forward failure
      // returns null → fall through to the normal local path for this one request
      // (and feeds the prober's hysteresis toward AUTONOMOUS).
      //
      // #279 — checked BEFORE forwarding: a request whose hop list carries our
      // own instanceId is one of our forwards coming back (boot window before the
      // heartbeat latched selfLoop, or an A→B→A cycle heartbeat identity cannot
      // see). Serving locally is the only reaction — never a refusal.
      const relay = options.relay;
      if (relay?.upstream && requestLoopedBack(c)) {
        log(
          `[Relay] request returned via ${HOPS_HEADER} — own id in hop list (boot window or relay cycle) — serving LOCALLY`,
          true
        );
      } else if (relay?.upstream && relay.alive) {
        const forwarded = await forwardToUpstream(c, body, relay);
        if (forwarded) return forwarded;
      }

      // Log tool names in request for debugging WebSearch/WebFetch
      const toolNames = (body.tools || []).map((t: any) => t.name);
      if (toolNames.length > 0) log(`[Proxy] Tools in request: ${toolNames.join(", ")}`);
      // Also check messages for tool_use blocks
      const lastMsg = body.messages?.[body.messages.length - 1];
      if (lastMsg?.content) {
        const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
        const toolUses = blocks.filter((b: any) => b.type === "tool_use");
        if (toolUses.length > 0) log(`[Proxy] Last msg tool_use: ${toolUses.map((t: any) => t.name).join(", ")}`);
      }

      // Intercept WebSearch/WebFetch tool calls and execute via SearXNG
      try {
        const webToolResponse = await interceptWebTools(c, body);
        if (webToolResponse) return webToolResponse;
      } catch (e: any) {
        log(`[WebTools] Intercept error (falling through to normal handler): ${e.message}`);
      }

      // Resolve once for the request log + billing-header strip decision. The
      // cascade below re-resolves as failover state mutates (same source of truth).
      const sessionKey = extractSessionKey(body);

      // #317 option B — per-session output-token ceiling, admission BEFORE any
      // handler resolution: a refused request pays no upstream and writes no
      // failover state (not even the dwell pin the resolution below writes).
      // Inert without CLAUDISH_SESSION_BUDGET_* (null admission, zero work).
      {
        const admission = admitSessionBudget(
          c.req.header("x-claudish-machine") ?? null,
          sessionKey,
          process.env
        );
        if (admission?.refused) return sessionBudgetRefusalAnthropic(admission);
      }

      // #83 grain 2: capability vocabulary — lift the session's declaration from
      // trailing assistant history, once per session (the #91 p4 dwell seam),
      // gated CLAUDISH_CAPABILITY_VOCAB (default off → zero work).
      if (sessionKey && isCapabilityVocabEnabled(process.env)) {
        const declared = liftCapabilityDeclaration(sessionKey, body);
        if (declared) log(`[Capability] session=${sessionKey.slice(0, 8)} declared ${JSON.stringify(declared)}`);
      }

      // #275: the nominal bucket computed once for the failover cascade AND the
      // notices — both must key on the same meter or a notice announces a
      // diversion the session never took.
      const requestRole = roleFromModelName(body.model);
      const requestBucket = await requestBucketOf(c, body.model);
      // #412 — the SAME suppression as the cascade below: this resolution is
      // not a dry run (it writes the per-session dwell pin and decides the
      // billing-header strip), so letting it swap behind a keyless native
      // request would both mislabel the log and write fleet state.
      const handler = await getHandlerForRequest(
        body.model,
        0,
        sessionKey,
        requestBucket,
        undefined,
        keylessNativeRequest(c, body.model)
      );
      logRequest(body, handler.constructor.name, c.req.raw, hostnameConfig.remoteAddrMap);
      stripBillingHeaderFromBody(body, handler instanceof NativeHandler);

      // Route through the budget-failover cascade (nominal → step0 → step1 …),
      // then inject onset/recovery notices. See handleWithCascade / applyFailoverNotices.
      const response = await handleWithCascade(c, body, body.model, requestBucket);
      const noticed = await applyFailoverNotices(
        response,
        requestRole,
        sessionKey,
        body.stream === true,
        noticePolicyForIngress(c.req.path),
        requestBucket,
        servedStepForNotices(c, requestRole) // #431 CR B1: name the step that actually served
      );
      // The `await` is load-bearing (218c3586): `return promise` hands it back
      // BEFORE it settles, so a rejection escapes this try/catch entirely and
      // lands in the app.onError backstop instead of the mapped handler below.
      return await applyCapabilityQueryAtCondensation(noticed, sessionKey, body.stream === true);
    } catch (e) {
      log(`[Proxy] Error: ${e}`);
      // Routing failures are terminal — surface as a non-retryable 400 so the
      // client shows the real reason (e.g. missing key) instead of looping on
      // "API error · Retrying". Other errors stay 500. (bbb448f6.)
      if (e instanceof RoutingError) {
        return c.json(wrapAnthropicError(400, e.message, "invalid_request_error"), 400);
      }
      // logStderr, NOT log: log() is file-only and a no-op unless --debug, and a
      // hub runs with debug off — so a 500 here was invisible on the very machine
      // that produced it. Measured 2026-09-22 03:18:02Z: 18 requests across 6
      // machines reached no upstream (no [ttft]) and the hub logged nothing,
      // while the relays reported `hub HTTP 500` and armed their AUTONOMOUS
      // hysteresis off it (relay.ts: `res.status >= 500` → markFail). The
      // instrument was verified live in that same window: 773 `[claudish]` lines.
      logStderr(`[Proxy] ERROR 500 on POST ${c.req.path}: ${e}`);
      return c.json(wrapAnthropicError(500, String(e)), 500);
    }
  });

  // OpenAI-compatible ingress. An OpenAI client (sk-agent, any AsyncOpenAI
  // consumer) POSTs here; we translate the body to Anthropic shape, run the
  // SAME routing pipeline as /v1/messages (so the client inherits the cascade,
  // budget failover, accounting, and leak policy), and translate the response
  // back to OpenAI wire shape. Anthropic remains the native ingress; this is a
  // translated ingress into the same pipeline. See CLAUDE.md.
  app.post("/v1/chat/completions", async (c) => {
    try {
      // #548 — same client-error terminal 400 as /v1/messages, in this route's
      // OpenAI error envelope: readRequestBody() throws a SyntaxError on
      // empty / non-JSON input that the catch below maps to a retryable 500
      // (which relays count toward hub hysteresis). Answered before the
      // freeze gate, the relay branch and any upstream call.
      let openaiBody: any;
      try {
        openaiBody = await readRequestBody(c);
      } catch (parseErr) {
        return c.json(
          { error: { message: `Invalid request body: ${(parseErr as Error)?.message ?? parseErr}`, type: "invalid_request_error", param: null, code: null } },
          400
        );
      }
      if (openaiBody === null || typeof openaiBody !== "object" || Array.isArray(openaiBody)) {
        return c.json(
          { error: { message: "Invalid request body: expected a JSON object", type: "invalid_request_error", param: null, code: null } },
          400
        );
      }

      // #306 — same admission freeze as /v1/messages, same placement before
      // the relay branch, for the same reason.
      const freeze = drainFreezeGate();
      if (freeze) return freeze;

      // Relay (sidecar NOMINAL): forward the RAW OpenAI body to the hub's
      // /v1/chat/completions — the hub translates. Path-aware forward
      // (relay.ts) means this reaches the right hub route, not /v1/messages.
      // #279: same hop-list gate as /v1/messages — a loop can enter on either
      // ingress.
      const relay = options.relay;
      if (relay?.upstream && requestLoopedBack(c)) {
        log(
          `[Relay] request returned via ${HOPS_HEADER} — own id in hop list (boot window or relay cycle) — serving LOCALLY`,
          true
        );
      } else if (relay?.upstream && relay.alive) {
        const forwarded = await forwardToUpstream(c, openaiBody, relay);
        if (forwarded) return forwarded;
      }

      if (typeof openaiBody?.model !== "string" || openaiBody.model.length === 0) {
        return c.json(
          { error: { message: "missing required field: model", type: "invalid_request_error", param: "model", code: null } },
          400
        );
      }

      const anthropicBody = convertOpenAIRequestToAnthropic(openaiBody);
      const wantsStream = openaiBody.stream === true;

      // #317 option B — same admission as /v1/messages, on the OpenAI wire
      // shape this ingress speaks (sk-agent / AsyncOpenAI consumers get a
      // programmatic consumer's error envelope, with the same retry-after).
      {
        const openaiSessionKey = extractSessionKey(anthropicBody);
        const admission = admitSessionBudget(
          c.req.header("x-claudish-machine") ?? null,
          openaiSessionKey,
          process.env
        );
        if (admission?.refused) {
          return c.json(
            {
              error: {
                message: admission.message,
                type: "rate_limit_error",
                code: null,
              },
            },
            429,
            { "retry-after": String(admission.retryAfterSec) }
          );
        }
      }

      // #275: same one-bucket-per-request rule as /v1/messages (see there).
      const requestRole = roleFromModelName(anthropicBody.model);
      const requestBucket = await requestBucketOf(c, anthropicBody.model);
      // #412 — the OpenAI-compatible ingress resolves the handler for the same
      // two reasons as /v1/messages (log label + billing strip, plus the dwell
      // pin it writes as a side effect), so it carries the same suppression.
      const handler = await getHandlerForRequest(
        anthropicBody.model,
        0,
        extractSessionKey(anthropicBody),
        requestBucket,
        undefined,
        keylessNativeRequest(c, anthropicBody.model)
      );
      logRequest(anthropicBody, handler.constructor.name, c.req.raw, hostnameConfig.remoteAddrMap);
      stripBillingHeaderFromBody(anthropicBody, handler instanceof NativeHandler);

      // Route through the cascade, then inject onset/recovery notices on the
      // Anthropic-shape response BEFORE translation to OpenAI wire shape. #229:
      // this ingress's consumers are programmatic (sk-agent, any AsyncOpenAI
      // client) — the notice rides the response header, NOT the content, so an
      // empty model output stays visibly empty instead of being masked by the
      // notice-as-answer.
      let response = await handleWithCascade(c, anthropicBody, anthropicBody.model, requestBucket);
      response = await applyFailoverNotices(
        response,
        requestRole,
        extractSessionKey(anthropicBody),
        wantsStream,
        noticePolicyForIngress(c.req.path),
        requestBucket,
        servedStepForNotices(c, requestRole) // #431 CR B1: name the step that actually served
      );

      // Translate the final Anthropic response to OpenAI shape.
      if (!response.ok) {
        // Error: convert the Anthropic error envelope to OpenAI's error shape so
        // an OpenAI SDK can surface it instead of choking on the foreign body.
        let errJson: any;
        try {
          errJson = await response.json();
        } catch {
          errJson = { error: { type: "api_error", message: `upstream HTTP ${response.status}` } };
        }
        const anthropicErr = errJson?.error ?? errJson;
        const oaiErr = {
          error: {
            message: anthropicErr.message ?? `upstream HTTP ${response.status}`,
            type: anthropicErr.type ?? "api_error",
            code: anthropicErr.code ?? null,
          },
        };
        return c.json(oaiErr, response.status as any);
      }

      if (wantsStream) {
        // #229 review: both translations below rebuild their headers from
        // scratch, which is where the notice header set above used to die —
        // consumed (dedup + recovery-budget side effects) then never delivered.
        return carryNoticeHeader(
          response,
          createOpenAIChatStreamFromAnthropic(response, anthropicBody.model)
        );
      }
      const message = await response.json();
      return carryNoticeHeader(
        response,
        c.json(anthropicMessageToChatCompletion(message, anthropicBody.model), {
          headers: { "Content-Type": "application/json" },
        })
      );
    } catch (e) {
      log(`[Proxy] /v1/chat/completions error: ${e}`);
      // Same RoutingError doctrine as /v1/messages (bbb448f6), on the OpenAI
      // wire shape this ingress speaks — this route resolves through the same
      // getHandlerForRequest, so the missing-credential throw reaches it too.
      if (e instanceof RoutingError) {
        return c.json(
          { error: { message: e.message, type: "invalid_request_error", code: null } },
          400
        );
      }
      return c.json(
        { error: { message: String(e), type: "api_error", code: null } },
        500
      );
    }
  });

  const server = serve({
    fetch(req, env, ctx) {
      if (!req.headers.get("x-forwarded-for") && !req.headers.get("x-real-ip")) {
        // @ts-expect-error — Bun injects remoteAddress on the server info object
        const addr = ctx?.remoteAddress?.address as string | undefined;
        if (addr) hostnameConfig.remoteAddrMap.set(req, addr);
      }
      return app.fetch(req, env, ctx);
    },
    port,
    hostname: hostnameConfig.hostname,
  });

  // Port resolution
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr?.port ? addr.port : port;
  if (actualPort !== port) port = actualPort;

  // In-flight request registry for the shutdown bound (#630). Tracked HERE, at
  // the server, because this is the only layer that sees both shapes that
  // matter: a response a client is still waiting for (must not be cut) and a
  // socket whose client vanished mid-request (must not hold the stop). The
  // stream tracker cannot answer this — `stream:false` work (`/compact`) never
  // registers as a stream, and a half-written request never registers at all.
  // `request` fires on HEADERS, so membership alone must not gate the stop:
  // consumableInFlight() counts an entry only when the body has fully arrived
  // (`req.complete`) and the response is not yet written (`!res.writableEnded`)
  // — work a client can still consume. A half-written request (headers sent,
  // body missing) is therefore worth waiting NOTHING for, which is the rule the
  // motivating case needs: an agent killed mid-turn leaves exactly that shape.
  const inFlight = new Set<{ req: IncomingMessage; res: ServerResponse }>();
  const consumableInFlight = (): number => {
    let n = 0;
    for (const { req, res } of inFlight) {
      if (req.complete && !res.writableEnded) n++;
    }
    return n;
  };
  server.on("request", (req, res) => {
    const entry = { req, res };
    inFlight.add(entry);
    let counted = true;
    const done = () => {
      if (!counted) return;
      counted = false;
      inFlight.delete(entry);
    };
    res.on("close", done);
    res.on("finish", done);
  });

  log(`[Proxy] Server started on port ${port}`);

  // Warm pricing cache in background (non-blocking)
  warmPricingCache().catch(() => {});

  // Warm recommended models from Firebase in background (non-blocking)
  warmRecommendedModels().catch(() => {});

  // Warm model catalog resolvers in background (non-blocking).
  // OpenRouter is the only registered resolver post-commit-5 — the LiteLLM
  // resolver was removed (claudish doesn't fetch LiteLLM's catalog anymore).
  warmAllCatalogs(["openrouter"]).catch(() => {
    // Warming failures are non-fatal — resolver falls back to passthrough
  });

  return {
    port,
    url: `http://${hostnameConfig.hostname}:${port}`,
    // #255: the SIGTERM path logs this at the die — the tracker lives inside
    // this closure, and /health stops answering once close() drops the socket.
    getActiveStreams: () => streamTracker.getActiveStreams(),
    shutdown: async () => {
      clearInterval(lagTimer);
      // #630: `server.close()` drops the listening socket immediately, then
      // waits for EVERY connection to end — including one whose client died
      // mid-request. Measured 2026-10-24 on the real path (hub po-2025):
      // `shutdown()` did not resolve until the client socket was destroyed
      // (3046 ms, resolving exactly at the destroy, with a partial POST held
      // open), and a throwaway container carrying one half-written request took
      // 21 401 ms to stop against 482 ms with no client at all. With
      // `stop_grace_period: 120s` a recreate can therefore spend up to two
      // minutes with the hub down, and the drain's true-zero cannot prevent it:
      // that instrument counts tracked STREAMS, while a half-written request
      // never registers and a `stream:false` turn (`/compact`) is not a stream.
      //
      // So wait for work a client can still CONSUME — a request whose body has
      // fully arrived (`req.complete`) and whose response is not yet written
      // (`!res.writableEnded`) — on a bound, then cut. A half-written request
      // earns NOTHING: its client is still composing the ask and cannot consume
      // an answer, and it is the exact shape an agent killed mid-turn leaves
      // behind (holding the stop for the full grace with the listener already
      // down). An idle keep-alive socket is worth nothing either (measured
      // 483 ms to stop with one open) — it never fires `request` at all.
      // Because only consumable work is counted, the grace no longer costs
      // anything on the dead-client path: an operator can raise it toward
      // `stop_grace_period` (long `stream:false` turns, `/compact`) without
      // stretching the dead-client window.
      // Compose injects this name as "" when unset (#310) — and Number("") is
      // 0, so a `?? default` read would turn an unset knob into an instant
      // cut. Same empty-safe shape as the first-event watchdog: "", garbage
      // and negatives all mean the default; "0" stays a deliberate instant cut.
      const rawGrace = process.env.CLAUDISH_SHUTDOWN_GRACE_MS;
      const parsedGrace = Number(rawGrace);
      const graceMs = !rawGrace || !Number.isFinite(parsedGrace) || parsedGrace < 0 ? 30_000 : parsedGrace;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      const deadline = Date.now() + graceMs;
      let consumable = consumableInFlight();
      while ((consumable > 0 || streamTracker.getActiveStreams() > 0) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        consumable = consumableInFlight();
      }
      server.closeAllConnections?.();
      // The cut above does not reach a connection still being PARSED — Bun's
      // compat leaves a half-written request out of the connection registry, so
      // the close callback would wait for that client forever (measured: still
      // 3017 ms after a 300 ms grace, resolving only when the client itself
      // destroyed the socket). Settle on a bound instead: whoever called
      // shutdown is exiting or re-binding, and an unbounded wait here is the
      // 120 s outage this whole path exists to avoid.
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    },
  };
}
