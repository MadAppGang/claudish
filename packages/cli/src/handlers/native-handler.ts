import type { Context } from "hono";
import { credentials } from "../auth/credentials/authority.js";
import { log, maskCredential } from "../logger.js";
import { redactForClient } from "../redact.js";
import { ANTHROPIC_API_ORIGIN } from "./advisor-claude-route.js";
import { ADVISOR_SWAPPED_CONTEXT_KEY } from "./advisor-decorator.js";
import {
  loadAdvisorSwapConfig,
  logAdvisorEvent,
  stripAdvisorBeta,
} from "./native-handler-advisor.js";
import { wrapAnthropicError } from "./shared/anthropic-error.js";
import { addSigningSecrets, credentialValuesFromRequest } from "./shared/call-context.js";
import {
  type UpstreamReaderSlot,
  cancelEndsUpstreamWork,
} from "./shared/stream-parsers/upstream-cancel.js";
import { stripUnsignedThinkingBlocks } from "./shared/thinking-signature.js";
import type { ModelHandler } from "./types.js";

export class NativeHandler implements ModelHandler {
  private apiKey?: string;
  private baseUrl: string;
  private advisorModels?: string[];
  private advisorCollector?: string | null;

  constructor(apiKey?: string, advisorModels?: string[], advisorCollector?: string | null) {
    this.apiKey = apiKey;
    // Always forward to real Anthropic API (the origin the advisor's Claude call uses too)
    this.baseUrl = ANTHROPIC_API_ORIGIN;
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

    // Register every credential value this request sends (the inbound Claude
    // bearer or key passed through, or the fallback key) on the request's
    // signing lease, for EVERY native request: the lease lives until the body
    // has been delivered or cancelled (`releaseWhenBodyEnds`), so each log line
    // and each echoed error below is redacted against them. The advisor
    // decorator registers the inbound values only on a turn with pending advisor
    // results; an ordinary native turn had an empty lease.
    addSigningSecrets(c, credentialValuesFromRequest(headers));

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
        // A downstream cancel cancels this reader and waits for the loop below
        // (which logs the whole stream at its end) before it resolves.
        const upstream: UpstreamReaderSlot = {};
        let cancelled = false;
        return c.body(
          new ReadableStream(
            cancelEndsUpstreamWork<Uint8Array>(upstream, {
              async start(controller) {
                const reader = anthropicResponse.body?.getReader();
                if (!reader) throw new Error("No reader");
                upstream.reader = reader;

                const decoder = new TextDecoder();
                const encoder = new TextEncoder();
                // Bytes after the last newline, held until their line completes:
                // an `error` event's data line is redacted whole, never in parts.
                let pending = "";
                // The current SSE event's name; a blank line ends the event.
                let eventName = "";
                let eventLog = "";

                // Every line passes through unchanged except the data lines of
                // an `error` event, which carry upstream text that may echo the
                // request's credential (redactForClient). Framing unchanged.
                const passLine = (line: string): string => {
                  const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
                  if (bare === "") {
                    eventName = "";
                    return line;
                  }
                  if (bare.startsWith("event:")) {
                    eventName = bare.slice(6).trim();
                    return line;
                  }
                  if (eventName === "error" && bare.startsWith("data:")) {
                    return redactForClient(line);
                  }
                  return line;
                };
                const forward = (lines: string[], text: string) => {
                  for (const line of lines) if (line.trim()) eventLog += `${line}\n`;
                  if (cancelled || !text) return;
                  controller.enqueue(encoder.encode(text));
                };

                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const text = pending + decoder.decode(value, { stream: true });
                    const cut = text.lastIndexOf("\n");
                    if (cut < 0) {
                      pending = text;
                      continue;
                    }
                    pending = text.slice(cut + 1);
                    const lines = text.slice(0, cut).split("\n").map(passLine);
                    forward(lines, `${lines.join("\n")}\n`);
                  }
                  const tail = pending + decoder.decode();
                  if (tail) {
                    const line = passLine(tail);
                    forward([line], line);
                  }
                  if (eventLog) log(eventLog);
                  if (!cancelled) controller.close();
                } catch (e) {
                  if (eventLog) log(eventLog);
                  log(`[Native] Stream Error: ${redactForClient(String(e))}`);
                  if (!cancelled) {
                    try {
                      controller.close();
                    } catch {}
                  }
                }
              },
              // Downstream went away: nothing more is enqueued, and the loop
              // above still logs what it read before cancelEndsUpstreamWork
              // resolves the cancel.
              cancel() {
                cancelled = true;
              },
            })
          ),
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

      // Handle JSON. A non-success body is upstream text that may echo the
      // request's credential, so it is redacted before it is logged or returned;
      // a success body is parsed exactly as it arrived.
      const raw = await anthropicResponse.text();
      const data = JSON.parse(anthropicResponse.ok ? raw : redactForClient(raw));
      log("\n=== [NATIVE] Response ===");
      log(JSON.stringify(data, null, 2));

      const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (anthropicResponse.headers.has("anthropic-version")) {
        responseHeaders["anthropic-version"] = anthropicResponse.headers.get("anthropic-version")!;
      }

      return c.json(data, { status: anthropicResponse.status as any, headers: responseHeaders });
    } catch (error) {
      const message = redactForClient(String(error));
      log(`[Native] Fetch Error: ${message}`);
      return c.json(wrapAnthropicError(500, message), 500);
    }
  }

  async shutdown(): Promise<void> {
    // No state to clean up
  }
}
