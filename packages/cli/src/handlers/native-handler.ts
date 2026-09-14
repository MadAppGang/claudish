import type { Context } from "hono";
import { credentials } from "../auth/credentials/authority.js";
import { log, maskCredential } from "../logger.js";
import { ADVISOR_SWAPPED_CONTEXT_KEY } from "./advisor-decorator.js";
import {
  loadAdvisorSwapConfig,
  logAdvisorEvent,
  stripAdvisorBeta,
} from "./native-handler-advisor.js";
import {
  type ResolvedCachingConfig,
  ensureExtendedCacheBeta,
  exactPrefixTokens,
  injectAnthropicCacheBreakpoints,
} from "./shared/anthropic-cache.js";
import { wrapAnthropicError } from "./shared/anthropic-error.js";
import { stripUnsignedThinkingBlocks } from "./shared/thinking-signature.js";
import type { ModelHandler } from "./types.js";

export class NativeHandler implements ModelHandler {
  private apiKey?: string;
  private baseUrl: string;
  private advisorModels?: string[];
  private advisorCollector?: string | null;
  private caching: ResolvedCachingConfig;

  constructor(
    apiKey?: string,
    advisorModels?: string[],
    advisorCollector?: string | null,
    caching?: ResolvedCachingConfig
  ) {
    this.apiKey = apiKey;
    // Always forward to real Anthropic API
    this.baseUrl = "https://api.anthropic.com";
    this.advisorModels = advisorModels;
    this.advisorCollector = advisorCollector;
    this.caching = caching ?? { enabled: false, extendedTtl: false };
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const originalHeaders = c.req.header();
    const target = payload.model;

    // Drop thinking blocks Anthropic cannot have signed, before anything else
    // reads the payload — so the advisor logging below dumps what actually goes
    // on the wire rather than what arrived.
    //
    // Foreign reasoning reaches the client as `{type:"thinking", signature:""}`
    // (openai-sse has no signature to give it), and a single mixed-provider
    // session then 400s every subsequent native turn with
    // "Invalid signature in thinking block". See thinking-signature.ts for why
    // this belongs on the native path only, and which case it deliberately
    // still misses.
    const strippedThinking = stripUnsignedThinkingBlocks(payload.messages);
    if (strippedThinking > 0) {
      log(
        `[Native] stripped ${strippedThinking} unsigned thinking block(s) from history for ${target} (foreign-provider origin)`
      );
    }

    // -------------------------------------------------------------------
    // Advisor. The swap, the response scan and the tool_result rewrite are
    // done ONCE per request by `withAdvisorSwap` (advisor-decorator.ts),
    // which the proxy wraps around whatever handler it resolved — this one
    // included. What stays here is the one thing a wrapper cannot reach: the
    // outbound headers. When the decorator swapped the advisor server tool
    // it sets `advisorSwapped` on the context, and the matching beta flag is
    // stripped below.
    // -------------------------------------------------------------------
    const advisorSwapped = c.get(ADVISOR_SWAPPED_CONTEXT_KEY) === true;

    log("\n=== [NATIVE] Claude Code → Anthropic API Request ===");
    log(
      `[Native] x-api-key: ${originalHeaders["x-api-key"] ? maskCredential(originalHeaders["x-api-key"]) : "(not set)"}`
    );
    log(
      `[Native] authorization: ${originalHeaders.authorization ? maskCredential(originalHeaders.authorization) : "(not set)"}`
    );
    log(`Request body (Model: ${target}):`);
    log("=== End Request ===\n");

    // Build headers - pass through auth headers exactly as received
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": originalHeaders["anthropic-version"] || "2023-06-01",
    };

    // Pass through auth headers as-is. If the incoming request carries NO auth
    // (e.g. the --probe client, which doesn't replicate Claude Code's injected
    // key) fall back to the api key this handler was constructed with, so the
    // native passthrough can still authenticate against api.anthropic.com.
    if (originalHeaders.authorization) {
      headers.authorization = originalHeaders.authorization;
    }
    if (originalHeaders["x-api-key"]) {
      headers["x-api-key"] = originalHeaders["x-api-key"];
    }
    if (!originalHeaders.authorization && !originalHeaders["x-api-key"]) {
      // No inbound auth → fall back to the construction-time key, else resolve
      // ANTHROPIC_API_KEY through the credential authority (env → config → op://),
      // so even the native fallback is sourced from the single layer.
      let fallbackKey = this.apiKey;
      if (!fallbackKey) {
        const auth = await credentials.getRequestAuth("native-anthropic", { model: target });
        fallbackKey = auth.headers["x-api-key"];
      }
      if (fallbackKey) {
        headers["x-api-key"] = fallbackKey;
      }
    }
    if (originalHeaders["anthropic-beta"]) {
      const incomingBeta = originalHeaders["anthropic-beta"];
      if (advisorSwapped) {
        // When we swap the advisor tool we must also strip the matching beta
        // flag; otherwise Anthropic rejects the request (beta enabled but no
        // matching server tool declared).
        const { stripped, changed } = stripAdvisorBeta(incomingBeta);
        if (changed) {
          log(
            `[Native][advisor-swap] stripped advisor-tool beta; before=${incomingBeta} after=${stripped ?? "(empty)"}`
          );
          logAdvisorEvent(loadAdvisorSwapConfig(this.advisorModels, this.advisorCollector), {
            kind: "beta_stripped",
            before: incomingBeta,
            after: stripped ?? "",
          });
        }
        if (stripped) headers["anthropic-beta"] = stripped;
      } else {
        headers["anthropic-beta"] = incomingBeta;
      }
    }

    // Prompt-cache injection (opt-in). This is the only path where claudish owns
    // the outbound headers, so the 1h extended TTL, which needs the beta flag, is
    // available here; the composed path is limited to the 5m default.
    if (this.caching.enabled) {
      const prefixTtl = this.caching.extendedTtl ? "1h" : "5m";
      const prefixTokens = await exactPrefixTokens(payload, target, this.caching);
      const { tag } = injectAnthropicCacheBreakpoints(payload, {
        prefixTtl,
        tailTtl: "5m",
        // Haiku's minimum cacheable prefix is 2048 tokens; every other Claude is 1024.
        minCacheTokens: /haiku/i.test(target) ? 2048 : 1024,
        prefixTokens,
      });
      if (this.caching.extendedTtl) {
        headers["anthropic-beta"] = ensureExtendedCacheBeta(headers["anthropic-beta"]);
      }
      if (tag !== "none") log(`[Native] cache injection: ${tag}`);
    }

    // Execute fetch
    try {
      const anthropicResponse = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const contentType = anthropicResponse.headers.get("content-type") || "";

      // Handle streaming
      if (contentType.includes("text/event-stream")) {
        log("[Native] Streaming response detected");
        return c.body(
          new ReadableStream({
            async start(controller) {
              const reader = anthropicResponse.body?.getReader();
              if (!reader) throw new Error("No reader");

              const decoder = new TextDecoder();
              let buffer = "";
              let eventLog = "";

              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;

                  controller.enqueue(value);

                  // Basic logging
                  const chunkText = decoder.decode(value, { stream: true });
                  buffer += chunkText;
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";
                  for (const line of lines) if (line.trim()) eventLog += `${line}\n`;
                }
                if (eventLog) log(eventLog);
                controller.close();
              } catch (e) {
                log(`[Native] Stream Error: ${e}`);
                controller.close();
              }
            },
          }),
          {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "anthropic-version": "2023-06-01",
            },
          }
        );
      }

      // Handle JSON
      const data = await anthropicResponse.json();
      log("\n=== [NATIVE] Response ===");
      log(JSON.stringify(data, null, 2));

      const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (anthropicResponse.headers.has("anthropic-version")) {
        responseHeaders["anthropic-version"] = anthropicResponse.headers.get("anthropic-version")!;
      }

      return c.json(data, { status: anthropicResponse.status as any, headers: responseHeaders });
    } catch (error) {
      log(`[Native] Fetch Error: ${error}`);
      return c.json(wrapAnthropicError(500, String(error)), 500);
    }
  }

  async shutdown(): Promise<void> {
    // No state to clean up
  }
}
