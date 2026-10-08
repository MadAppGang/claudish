import type { Context } from "hono";
import { credentials } from "../auth/credentials/authority.js";
import { log, maskCredential } from "../logger.js";
import { ADVISOR_SWAPPED_CONTEXT_KEY } from "./advisor-decorator.js";
import {
  loadAdvisorSwapConfig,
  logAdvisorEvent,
  stripAdvisorBeta,
} from "./native-handler-advisor.js";
import { wrapAnthropicError } from "./shared/anthropic-error.js";
import {
  bodyToForward,
  forwardedSearch,
  requestHeadersToForward,
  responseHeadersToReturn,
} from "./shared/anthropic-forward.js";
import { stripUnsignedThinkingBlocks } from "./shared/thinking-signature.js";
import type { ModelHandler } from "./types.js";

export class NativeHandler implements ModelHandler {
  private apiKey?: string;
  private baseUrl: string;
  private advisorModels?: string[];
  private advisorCollector?: string | null;

  constructor(apiKey?: string, advisorModels?: string[], advisorCollector?: string | null) {
    this.apiKey = apiKey;
    // Always forward to real Anthropic API
    this.baseUrl = "https://api.anthropic.com";
    this.advisorModels = advisorModels;
    this.advisorCollector = advisorCollector;
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

    const headers = await this.forwardedHeaders(c, target);
    const incomingBeta = headers["anthropic-beta"];
    if (incomingBeta && advisorSwapped) {
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
      else delete headers["anthropic-beta"];
    }

    try {
      const anthropicResponse = await fetch(`${this.baseUrl}/v1/messages${forwardedSearch(c)}`, {
        method: "POST",
        headers,
        body: bodyToForward(c, payload),
      });
      const status = anthropicResponse.status;
      const responseHeaders = responseHeadersToReturn(anthropicResponse.headers);
      const contentType = anthropicResponse.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        log("[Native] Streaming response detected");
        return new Response(
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
          { status, headers: responseHeaders }
        );
      }

      const text = await anthropicResponse.text();
      log("\n=== [NATIVE] Response ===");
      log(text);
      return new Response(text, { status, headers: responseHeaders });
    } catch (error) {
      log(`[Native] Fetch Error: ${error}`);
      return c.json(wrapAnthropicError(500, String(error)), 500);
    }
  }

  /**
   * `POST /v1/messages/count_tokens`, forwarded the way `handle` forwards a
   * message: with Claude Code's own headers, its auth among them.
   */
  async countTokens(c: Context, payload: { model: string }): Promise<Response> {
    try {
      const upstream = await fetch(
        `${this.baseUrl}/v1/messages/count_tokens${forwardedSearch(c)}`,
        {
          method: "POST",
          headers: await this.forwardedHeaders(c, payload.model),
          body: bodyToForward(c, payload),
        }
      );
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: responseHeadersToReturn(upstream.headers),
      });
    } catch (error) {
      log(`[Native] count_tokens Fetch Error: ${error}`);
      return c.json(wrapAnthropicError(500, String(error)), 500);
    }
  }

  /**
   * Every header Claude Code sent, less the per-connection ones. A request that
   * carries no auth of its own (the --probe client does not replicate the key
   * Claude Code injects) falls back to the key this handler was constructed
   * with, else to ANTHROPIC_API_KEY through the credential authority (env,
   * config, op://), so even the fallback is sourced from the single layer.
   */
  private async forwardedHeaders(c: Context, target: string): Promise<Record<string, string>> {
    const headers = requestHeadersToForward(c.req.raw.headers);
    headers["content-type"] = "application/json";
    if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
    if (!headers.authorization && !headers["x-api-key"]) {
      let fallbackKey = this.apiKey;
      if (!fallbackKey) {
        const auth = await credentials.getRequestAuth("native-anthropic", { model: target });
        fallbackKey = auth.headers["x-api-key"];
      }
      if (fallbackKey) headers["x-api-key"] = fallbackKey;
    }
    return headers;
  }

  async shutdown(): Promise<void> {
    // No state to clean up
  }
}
