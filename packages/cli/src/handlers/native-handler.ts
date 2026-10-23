import type { Context } from "hono";
import type { ModelHandler } from "./types.js";
import { log, maskCredential } from "../logger.js";
import { wrapAnthropicError } from "./shared/anthropic-error.js";
import { createResponseCapture, appendUpstreamError } from "./shared/response-capture.js";
import { requestNumberFor } from "../fork/middleware/request-logger.js";
import { recordSessionBudgetOutput } from "../fork/session-budget.js";
import { stripUnsignedThinkingBlocks } from "./shared/thinking-signature.js";
import { matchesProxyKey } from "./shared/proxy-keys.js";
import { noteProxyKeyAuthentication } from "./shared/proxy-key-rotation.js";
import {
  nativeAuthHeaderNames,
  nativeCredentialRefusalResponse,
  nativeCredentialRefusalShape,
  nativeHeaderNamesLogEnabled,
  stripForeignCredentialBesideAnthropic,
} from "./shared/native-credential-guard.js";
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

/**
 * #282: remove OUR OWN proxy headers before the wire to api.anthropic.com.
 *
 * The native passthrough forwards every inbound header (that is deliberate —
 * Max-subscription internals must survive), but the proxy's OWN headers used to
 * ride along verbatim: the cluster credential `x-proxy-key` (read by the auth
 * gate, ignored by the key swap — and ignoring is not stripping), the
 * attribution `x-claudish-machine`, and the relay hop list `x-claudish-hops`
 * (#279). Measured 2026-09-29 (ai-01, fetch stub, no network): all three
 * reached the Anthropic upstream on every native request, `x-proxy-key`
 * byte-equal to the inbound value.
 *
 * Shared by `NativeHandler.handle` AND the native `count_tokens` path in
 * proxy-server.ts so the two lists cannot drift. `authorization` is untouched:
 * when it is the client's OAuth it is what makes the subscription work.
 */
export function stripProxyOwnHeaders(headers: Record<string, string>): void {
  delete headers["x-proxy-key"];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith("x-claudish-")) delete headers[key];
  }
}

export class NativeHandler implements ModelHandler {
  private apiKey?: string;
  private baseUrl: string;
  private advisorModels?: string[];
  private advisorCollector?: string | null;
  private proxyKeys?: string[];

  constructor(apiKey?: string, advisorModels?: string[], advisorCollector?: string | null, proxyKeys?: string[]) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.anthropic.com";
    this.advisorModels = advisorModels;
    this.advisorCollector = advisorCollector;
    this.proxyKeys = proxyKeys;
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const originalHeaders = c.req.header();
    const target = payload.model;

    // #305 AC 1 — measurement instrument, OFF by default. Logs which auth
    // header NAMES the client sent (authorization / x-api-key / both / none),
    // before anything touches them. Runs on the ORIGINAL inbound set so it
    // measures the client, not our own mutations. Names only, never values.
    if (nativeHeaderNamesLogEnabled()) {
      log(`[Native][hdr-names] ${nativeAuthHeaderNames(originalHeaders)}`, true);
    }

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

    // Strip thinking blocks that arrived without a valid Anthropic signature.
    // They originate from non-Anthropic providers (GLM/Kimi/DeepSeek reasoning
    // surfaced as type:"thinking" with signature:"") and poison mixed-provider
    // sessions: the Anthropic API rejects them with
    // "messages.N.content.M: Invalid signature in thinking block" once a turn
    // routes here. Genuine signed Anthropic thinking is preserved.
    //
    // `stripForeignHexSignature` closes the second half of the same hole (#597):
    // MiniMax hands out REAL 64-hex signatures, which the empty-signature test
    // above cannot see, and Anthropic rejects those identically. The opt-in is
    // here and only here — this handler IS the native wire, which is what makes
    // the strip wire-discriminated rather than a guess on signature shape.
    const strippedThinking = stripUnsignedThinkingBlocks(payload.messages, {
      stripForeignHexSignature: true,
    });
    if (strippedThinking > 0) {
      log(
        `[Native] Stripped ${strippedThinking} unsigned/foreign-signature thinking block(s) (non-Anthropic origin) from message history for ${target}`
      );
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
    // #282 — the proxy's own headers (cluster key, attribution, hop list) stop
    // HERE: everything past this point belongs to the client and the API, and
    // api.anthropic.com is a third party to our cluster auth.
    stripProxyOwnHeaders(headers);

    // Proxy key override: if the client auth matches one of our proxy keys
    // (primary or previous, during a rotation), replace it with the stored
    // Anthropic key (proxy key is for the local proxy only, not for
    // api.anthropic.com). When no proxy key is configured (pass-through
    // mode), everything flows through unmodified.
    let credentialSubstituted = false;
    if (this.proxyKeys?.length) {
      const bearerToken = originalHeaders["authorization"]?.startsWith("Bearer ")
        ? originalHeaders["authorization"].slice(7)
        : originalHeaders["authorization"];
      const clientAuthToken = originalHeaders["x-api-key"] || bearerToken;
      if (matchesProxyKey(clientAuthToken, this.proxyKeys)) {
        // #439 — this swap is one of the sites that ACCEPT a proxy key:
        // count it when it is the retiring one (no-op outside a window).
        // The raw request carries the middleware's mark when the fork
        // middleware already counted this authentication (exemption
        // branch) — then this site skips, keeping one request = one count.
        noteProxyKeyAuthentication(clientAuthToken, originalHeaders, c.req.raw);
        // Strip proxy key from forwarded headers
        delete headers["x-api-key"];
        delete headers["authorization"];
        if (this.apiKey) {
          credentialSubstituted = true;
          if (this.apiKey.startsWith("sk-ant-oat")) {
            headers["authorization"] = `Bearer ${this.apiKey}`;
          } else {
            headers["x-api-key"] = this.apiKey;
          }
        }
      }
    }

    // #296 — the credential state that would now leave for api.anthropic.com
    // is either absent (shape A: the swap removed the client's token and there
    // is no stored key to substitute) or foreign (shape B: a Bearer belonging
    // to another party, about to be handed to a third party — same class #282
    // closed for x-proxy-key). Refuse locally, labeled, zero upstream fetch.
    // An sk-ant-* credential (OAuth or API key, the ai-01 passthrough) and the
    // substituted-key path above stay untouched.
    const refusalShape = nativeCredentialRefusalShape(headers, credentialSubstituted);
    if (refusalShape) {
      log(
        `[Native] refused — no Anthropic credential to send (shape=${refusalShape}, model=${target})`,
        true
      );
      return nativeCredentialRefusalResponse(target);
    }

    // #305 — mixed credentials: a FOREIGN credential riding beside an
    // Anthropic-shaped one is stripped, never forwarded. The sk-ant-
    // credential still authenticates, so the authorized lane survives
    // whatever AC 1 measures; the foreign token never leaves.
    const strippedForeign = stripForeignCredentialBesideAnthropic(headers);
    if (strippedForeign.length > 0) {
      log(
        `[Native] stripped foreign credential beside Anthropic credential (header=${strippedForeign.join(",")}, model=${target})`,
        true
      );
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
        const cap = createResponseCapture("native", target, true, requestNumberFor(c.req));
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
                  for (const line of lines) {
                    if (line.trim()) eventLog += line + "\n";
                    // #317: the terminal message_delta carries the upstream
                    // usage — feed the per-session budget counter. Max-per-
                    // attempt in the sink makes this idempotent and tolerant
                    // of any earlier partial usage line. Never throws.
                    if (line.includes('"output_tokens"')) {
                      for (const m of line.matchAll(/"output_tokens"\s*:\s*(\d+)/g)) {
                        recordSessionBudgetOutput(c.req.raw, Number(m[1]));
                      }
                    }
                  }
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

      // #317: non-streaming native usage feeds the session budget too.
      {
        const n = Number((data as any)?.usage?.output_tokens);
        if (Number.isFinite(n) && n > 0) recordSessionBudgetOutput(c.req.raw, n);
      }

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
