import type { Context } from "hono";
import type { ModelHandler } from "./types.js";
import { log, maskCredential } from "../logger.js";
import { wrapAnthropicError } from "./shared/anthropic-error.js";
import { createResponseCapture, appendUpstreamError } from "./shared/response-capture.js";
import {
  fetchMultiModelAdvice,
  findPendingAdvisorToolResults,
  loadAdvisorSwapConfig,
  logAdvisorEvent,
  recordAdvisorEventsFromChunk,
  rewriteAdvisorToolResults,
  stripAdvisorBeta,
  stubAdvisorAdvice,
  swapAdvisorToolInBody,
} from "./native-handler-advisor.js";

export class NativeHandler implements ModelHandler {
  private apiKey?: string;
  private baseUrl: string;
  private advisorModels?: string[];
  private advisorCollector?: string | null;
  private proxyKey?: string;

  constructor(apiKey?: string, advisorModels?: string[], advisorCollector?: string | null, proxyKey?: string) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.anthropic.com";
    this.advisorModels = advisorModels;
    this.advisorCollector = advisorCollector;
    this.proxyKey = proxyKey;
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const originalHeaders = c.req.header();
    const target = payload.model;

    // -------------------------------------------------------------------
    // Advisor-swap experiment (opt-in via CLAUDISH_SWAP_ADVISOR=1).
    // No-op if the env var is unset. See native-handler-advisor.ts.
    //
    // Two-way mutation on each request:
    //   1. Outbound swap: advisor_20260301 server tool → regular tool named
    //      "advisor". Also strips advisor-tool-2026-03-01 beta flag.
    //   2. Inbound rewrite (Stage 2): any tool_result blocks targeting an
    //      advisor tool_use_id we've previously seen in a streamed response
    //      get their error payload replaced with stubbed advisor advice.
    // -------------------------------------------------------------------
    const advisorCfg = loadAdvisorSwapConfig(this.advisorModels, this.advisorCollector);
    let advisorSwapped: ReturnType<typeof swapAdvisorToolInBody> = null;
    let advisorRewrittenIds: string[] = [];
    if (advisorCfg.enabled) {
      // Stage 1: tool-definition swap (outbound).
      advisorSwapped = swapAdvisorToolInBody(payload);
      if (advisorSwapped) {
        log("[Native][advisor-swap] replaced advisor_20260301 with regular tool 'advisor'");
        logAdvisorEvent(advisorCfg, {
          kind: "swap_applied",
          model: target,
          originalTool: advisorSwapped.originalTool,
          regularTool: advisorSwapped.regularTool,
        });
      }

      // Stage 2: tool_result rewrite (inbound). Runs AFTER the Stage-1 swap
      // so it sees the possibly-mutated payload. In practice the two are
      // orthogonal — rewrite looks at messages[].content tool_result blocks,
      // swap looks at tools[].
      if (advisorCfg.models && advisorCfg.models.length > 0) {
        // Multi-model advisor: async pre-fetch from external models
        const pendingIds = findPendingAdvisorToolResults(payload);
        if (pendingIds.length > 0) {
          const adviceMap = new Map<string, string>();
          for (const id of pendingIds) {
            const advice = await fetchMultiModelAdvice(
              id,
              payload.messages as any[],
              advisorCfg.models,
              advisorCfg.collector ?? null,
              {
                openrouter: process.env.OPENROUTER_API_KEY,
                google: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY,
                openai: process.env.OPENAI_API_KEY,
                anthropic: originalHeaders["x-api-key"],
              },
            );
            adviceMap.set(id, advice);
          }
          advisorRewrittenIds = rewriteAdvisorToolResults(
            payload,
            (id) => adviceMap.get(id) ?? stubAdvisorAdvice(id),
          );
          if (advisorRewrittenIds.length > 0) {
            log(
              `[Native][advisor] rewrote ${advisorRewrittenIds.length} tool_result(s) with multi-model advice from [${advisorCfg.models.join(", ")}]` +
              (advisorCfg.collector ? ` (collector: ${advisorCfg.collector})` : " (no collector)")
            );
            logAdvisorEvent(advisorCfg, {
              kind: "multi_model_rewrite",
              ids: advisorRewrittenIds,
              models: advisorCfg.models,
              collector: advisorCfg.collector,
              model: target,
            });
          }
        }
      } else {
        // Legacy: stub advice (env var mode)
        advisorRewrittenIds = rewriteAdvisorToolResults(payload, stubAdvisorAdvice);
        if (advisorRewrittenIds.length > 0) {
          log(
            `[Native][advisor-swap] rewrote ${advisorRewrittenIds.length} error tool_result(s) with stub advice: ${advisorRewrittenIds.join(", ")}`
          );
          logAdvisorEvent(advisorCfg, {
            kind: "tool_result_rewritten",
            ids: advisorRewrittenIds,
            model: target,
          });
        }
      }

      // Dump request body (trimmed) so we can inspect follow-ups that carry
      // tool_result blocks — critical evidence for Stage 2 debugging.
      if (advisorCfg.dumpBodies) {
        logAdvisorEvent(advisorCfg, {
          kind: "request_body",
          swapApplied: !!advisorSwapped,
          rewrittenIds: advisorRewrittenIds,
          model: target,
          body: trimForLog(payload),
        });
      }
    }

    log("\n=== [NATIVE] Claude Code → Anthropic API Request ===");
    log(
      `[Native] x-api-key: ${originalHeaders["x-api-key"] ? maskCredential(originalHeaders["x-api-key"]) : "(not set)"}`
    );
    log(
      `[Native] authorization: ${originalHeaders["authorization"] ? maskCredential(originalHeaders["authorization"]) : "(not set)"}`
    );
    log(`Request body (Model: ${target}):`);
    log("=== End Request ===\n");

    // Transparent passthrough: forward ALL incoming headers to api.anthropic.com.
    // This is essential for Max subscription auth — Claude Code sends internal
    // headers that make the subscription work for Opus/Sonnet, and we must not
    // drop any of them.
    //
    // Skip hop-by-hop headers and Hono-internal headers that must not be
    // forwarded to an upstream API.
    const HOP_BY_HOP = new Set([
      "host", "connection", "keep-alive", "transfer-encoding", "te",
      "trailer", "upgrade", "content-length",
    ]);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    for (const [key, value] of Object.entries(originalHeaders)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      if (typeof value !== "string") continue;
      headers[key] = value;
    }

    // Proxy key override: if the client auth matches our proxy key, replace it
    // with the stored Anthropic key (proxy key is for the local proxy only,
    // not for api.anthropic.com). When no proxy key is configured (pass-through
    // mode), everything flows through unmodified.
    if (this.proxyKey) {
      const bearerToken = originalHeaders["authorization"]?.startsWith("Bearer ")
        ? originalHeaders["authorization"].slice(7)
        : originalHeaders["authorization"];
      const clientAuthToken = originalHeaders["x-api-key"] || bearerToken;
      if (clientAuthToken === this.proxyKey) {
        // Strip proxy key from forwarded headers
        delete headers["x-api-key"];
        delete headers["authorization"];
        if (this.apiKey) {
          if (this.apiKey.startsWith("sk-ant-oat")) {
            headers["authorization"] = `Bearer ${this.apiKey}`;
          } else {
            headers["x-api-key"] = this.apiKey;
          }
        }
      }
    }

    // Advisor-swap: strip advisor beta flag when we swapped the tool
    if (advisorSwapped && originalHeaders["anthropic-beta"]) {
      const incomingBeta = originalHeaders["anthropic-beta"];
      const { stripped, changed } = stripAdvisorBeta(incomingBeta);
      if (changed) {
        log(
          `[Native][advisor-swap] stripped advisor-tool beta; before=${incomingBeta} after=${stripped ?? "(empty)"}`
        );
        logAdvisorEvent(advisorCfg, {
          kind: "beta_stripped",
          before: incomingBeta,
          after: stripped ?? "",
        });
      }
      if (stripped) headers["anthropic-beta"] = stripped;
      else delete headers["anthropic-beta"];
    }

    // Execute fetch
    try {
      const anthropicResponse = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const contentType = anthropicResponse.headers.get("content-type") || "";

      // Upstream refusal (429/402/…). Two things must happen here that the
      // streaming branch below would otherwise lose:
      //   1. Capture the body — NativeHandler is the ONLY path for Anthropic-
      //      native traffic (Opus/Fable), so without this a quota wall from
      //      api.anthropic.com left no durable trace (the GLM wall was visible
      //      only because composed-handler already captured; Opus was blind).
      //   2. Return the upstream status verbatim. c.body() below defaults to 200,
      //      which made the reactive failover check (proxy-server.ts:933
      //      `if (!response.ok)`) never see an Anthropic quota refusal — the whole
      //      role-level failover was inert on native traffic. Returning the real
      //      status lets that check arm and retry through the substitute.
      // Anthropic returns an error body even for stream:true requests when the
      // refusal is at the gateway/quota layer (before streaming starts), so a
      // single text() read is complete and cheap.
      if (!anthropicResponse.ok) {
        const errText = await anthropicResponse.text().catch(() => "");
        appendUpstreamError({
          model: target,
          provider: "Anthropic (native)",
          status: anthropicResponse.status,
          body: errText,
        });
        log(`[Native] upstream ${anthropicResponse.status}: ${errText.slice(0, 200)}`);
        // Preserve Anthropic's own error envelope when it is valid JSON (it
        // carries the type/code the agent may act on); fall back to a wrapped
        // envelope for a non-JSON body so the client still gets a clean shape.
        let errBody: unknown;
        try {
          errBody = JSON.parse(errText);
        } catch {
          errBody = wrapAnthropicError(anthropicResponse.status, errText.slice(0, 500));
        }
        return c.json(errBody, { status: anthropicResponse.status as any });
      }

      // Handle streaming
      if (contentType.includes("text/event-stream")) {
        log("[Native] Streaming response detected");
        const cap = createResponseCapture("native", target);
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

                  cap.tap(value);
                  controller.enqueue(value);

                  // Basic logging
                  const chunkText = decoder.decode(value, { stream: true });
                  buffer += chunkText;
                  // Advisor tap: extract any advisor tool_use ids and record
                  // stream events to the log (no-op when disabled).
                  recordAdvisorEventsFromChunk(advisorCfg, chunkText);
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";
                  for (const line of lines) if (line.trim()) eventLog += line + "\n";
                }
                if (eventLog) log(eventLog);
                cap.note("reader done");
                cap.done({ closed: true, reason: "done" });
                controller.close();
              } catch (e) {
                log(`[Native] Stream Error: ${e}`);
                cap.note(`stream error: ${String(e)}`);
                cap.done({ closed: true, reason: "error", err: String(e) });
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

      // Advisor tap for the non-streaming branch (mostly for title-classifier
      // calls on Haiku which return JSON). Picks up any advisor tool_use ids
      // we might miss in SSE.
      if (advisorCfg.enabled) {
        try {
          recordAdvisorEventsFromChunk(advisorCfg, JSON.stringify(data));
        } catch {
          // ignore scan failures — logging-only
        }
      }

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

/**
 * Produces a logging-friendly copy of a request payload. Trims long text
 * fields (system prompts can exceed 30KB) so the advisor-swap log stays
 * readable. Preserves block structure so you can still inspect the shape
 * of tool_use / tool_result / server_tool_use blocks.
 */
function trimForLog(payload: any): any {
  const TEXT_TRUNC = 400;
  const clone = structuredClone(payload);
  const trimStr = (s: string) =>
    typeof s === "string" && s.length > TEXT_TRUNC
      ? s.slice(0, TEXT_TRUNC) + `… [+${s.length - TEXT_TRUNC} chars]`
      : s;
  const walk = (v: any): any => {
    if (typeof v === "string") return trimStr(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(clone);
}
