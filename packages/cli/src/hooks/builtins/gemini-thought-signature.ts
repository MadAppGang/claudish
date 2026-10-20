/**
 * Built-in raw hook `gemini/thought-signature`.
 *
 * Gemini 3 requires the reasoning of an assistant turn that called tools to be
 * sent back with that turn on every later request. OpenRouter carries it as the
 * message's `reasoning_details` array, and it must be the WHOLE array: a request
 * whose assistant tool call lacks it is rejected with a 400 validation error.
 * References: https://ai.google.dev/gemini-api/docs/thought-signatures and
 * https://openrouter.ai/docs/use-cases/reasoning-tokens#preserving-reasoning-blocks
 *
 * Three raw stages, ported from the `GeminiThoughtSignatureMiddleware` the hook
 * system replaced:
 *
 * - `providerChunk` (was `afterStreamChunk`) accumulates each chunk's
 *   `reasoning_details` and tool-call ids into the stream's own `metadata`. It
 *   only READS the delta, so the committed clone equals the parsed chunk and the
 *   client stream never changes.
 * - `providerStreamEnd` (was `afterStreamComplete`) caches what one response
 *   accumulated against its tool-call ids, when it carried both.
 * - `providerRequest` (was `beforeRequest`) puts the cached array back on each
 *   assistant message whose tool calls it was recorded for.
 *
 * Active when the bare model name contains `gemini` or `google/`, today's rule.
 * The cache is keyed per route (`<provider>\0<modelId>`): the middleware was
 * constructed once per handler, i.e. per served model, and that scope is kept.
 * Each per-route cache stays unbounded, as before.
 *
 * The middleware's `afterResponse` (non-streaming) had no production caller and
 * is not ported. If non-streaming Gemini is ever wired, it needs a raw stage on
 * the provider-format JSON, which the hook system does not offer.
 */

import { isLoggingEnabled, log, logStructured } from "../../logger.js";
import type {
  RawProviderChunkContext,
  RawProviderRequestContext,
  RawProviderStreamEndContext,
  RouteInfo,
} from "../public.js";
import type { BuiltinHook } from "../registry.js";

export const GEMINI_THOUGHT_SIGNATURE_HOOK_ID = "gemini/thought-signature";

/** The `middleware_names` stats value, unchanged from the middleware it replaced. */
export const GEMINI_THOUGHT_SIGNATURE_STATS_NAME = "GeminiThoughtSignature";

interface CachedReasoning {
  // biome-ignore lint/suspicious/noExplicitAny: provider-format reasoning blocks, forwarded verbatim
  reasoning_details: any[];
  tool_call_ids: Set<string>;
}

type RouteCache = Map<string, CachedReasoning>;

const REASONING_KEY = "reasoning_details";
const TOOL_IDS_KEY = "tool_call_ids";

function routeKey(route: RouteInfo): string {
  return `${route.provider}\0${route.modelId}`;
}

/**
 * A fresh instance of the built-in, with its own caches. One per hook engine:
 * the engine is one per process, as the middleware instances were one per
 * handler.
 */
export function createGeminiThoughtSignatureHook(): BuiltinHook {
  const caches = new Map<string, RouteCache>();
  const cacheFor = (route: RouteInfo): RouteCache => {
    const key = routeKey(route);
    let cache = caches.get(key);
    if (!cache) {
      cache = new Map();
      caches.set(key, cache);
    }
    return cache;
  };

  return {
    apiVersion: 1,
    id: GEMINI_THOUGHT_SIGNATURE_HOOK_ID,
    description:
      "Sends Gemini's reasoning_details back with the assistant tool calls they were produced for",
    order: "pre",
    models: ["*gemini*", "*google/*"],
    routes: "all",
    defaultSeverity: "fix",
    statsName: GEMINI_THOUGHT_SIGNATURE_STATS_NAME,
    unsafe: true,
    raw: {
      providerRequest(ctx: RawProviderRequestContext): void {
        const cache = caches.get(routeKey(ctx.route));
        if (!cache || cache.size === 0) return;
        let injected = 0;
        for (const msg of ctx.messages) {
          if (msg?.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
          for (const [messageId, cached] of cache) {
            // biome-ignore lint/suspicious/noExplicitAny: provider-format tool call
            if (!msg.tool_calls.some((tc: any) => cached.tool_call_ids.has(tc?.id))) continue;
            msg.reasoning_details = cached.reasoning_details;
            injected++;
            if (isLoggingEnabled()) {
              logStructured("[Gemini] Reasoning details added to assistant message", {
                message_id: messageId,
                reasoning_blocks: cached.reasoning_details.length,
                tool_calls: msg.tool_calls.length,
              });
            }
            break; // once per message
          }
          if (!msg.reasoning_details && isLoggingEnabled()) {
            log(
              // biome-ignore lint/suspicious/noExplicitAny: provider-format tool call
              `[Gemini] No reasoning_details cached for the assistant tool calls ${msg.tool_calls.map((tc: any) => tc?.id).join(", ")}`
            );
          }
        }
        if (injected > 0 && isLoggingEnabled()) {
          logStructured("[Gemini] Signature injection complete", {
            injected,
            cacheSize: cache.size,
          });
        }
      },

      providerChunk(ctx: RawProviderChunkContext): void {
        const delta = ctx.delta;
        if (!delta) return;
        if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
          // biome-ignore lint/suspicious/noExplicitAny: provider-format reasoning blocks
          let accumulated = ctx.metadata.get(REASONING_KEY) as any[] | undefined;
          if (!accumulated) {
            accumulated = [];
            ctx.metadata.set(REASONING_KEY, accumulated);
          }
          accumulated.push(...delta.reasoning_details);
        }
        if (Array.isArray(delta.tool_calls)) {
          let ids = ctx.metadata.get(TOOL_IDS_KEY) as Set<string> | undefined;
          if (!ids) {
            ids = new Set();
            ctx.metadata.set(TOOL_IDS_KEY, ids);
          }
          for (const tc of delta.tool_calls) {
            if (typeof tc?.id === "string" && tc.id) ids.add(tc.id);
          }
        }
      },

      providerStreamEnd(ctx: RawProviderStreamEndContext): void {
        // biome-ignore lint/suspicious/noExplicitAny: provider-format reasoning blocks
        const reasoning = (ctx.metadata.get(REASONING_KEY) as any[] | undefined) ?? [];
        const ids = (ctx.metadata.get(TOOL_IDS_KEY) as Set<string> | undefined) ?? new Set();
        if (reasoning.length === 0 || ids.size === 0) return;
        const cache = cacheFor(ctx.route);
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        cache.set(messageId, { reasoning_details: reasoning, tool_call_ids: ids });
        logStructured("[Gemini] Streaming complete - reasoning details saved", {
          message_id: messageId,
          reasoning_blocks: reasoning.length,
          tool_calls: ids.size,
          total_cached_messages: cache.size,
        });
      },
    },
  } as BuiltinHook;
}
