import type { Context } from "hono";
import { credentials } from "../auth/credentials/authority.js";
import { requestHooksOf } from "../hooks/request-stage.js";
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

/** One SSE line split into its field name and value (one leading space dropped), per the SSE spec. */
function sseField(line: string): { name: string; value: string } {
  const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
  const colon = bare.indexOf(":");
  if (colon < 0) return { name: bare, value: "" };
  const value = bare.slice(colon + 1);
  return { name: bare.slice(0, colon), value: value.startsWith(" ") ? value.slice(1) : value };
}

/**
 * Whether one complete SSE event is an error: its FINAL `event:` name is
 * `error` (the last `event:` field wins, wherever it sits relative to the
 * data), or its data payload is JSON whose `type` is `"error"` — the shape
 * Anthropic puts in an error frame even when no `event:` line names it.
 */
function isSseErrorEvent(lines: readonly string[]): boolean {
  let eventName = "";
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment
    const { name, value } = sseField(line);
    if (name === "event") eventName = value;
    else if (name === "data") data.push(value);
  }
  if (eventName.trim() === "error") return true;
  if (data.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(data.join("\n"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "error"
    );
  } catch {
    return false;
  }
}

/**
 * The lines of one complete SSE event (each without its "\n"; the blank
 * separator, when present, is the last), ready to forward. An error event's
 * `data:` lines carry upstream text that may echo the request's credential, so
 * each is passed through `redactForClient` (exact-value replacement, so the
 * JSON stays valid); every other line, and every line of a non-error event, is
 * returned unchanged, so the framing and the bytes are preserved.
 */
export function redactSseErrorEvent(lines: string[]): string[] {
  if (!isSseErrorEvent(lines)) return lines;
  return lines.map((line) => (sseField(line).name === "data" ? redactForClient(line) : line));
}

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

  async handle(c: Context, incoming: any): Promise<Response> {
    // Hook request stages A and B, first, and only when `withHooks` put the
    // request hooks on the context. A native request is never in a fallback
    // chain, but its payload object is shared with `withAdvisor`, so the stages
    // run on a copy-on-write VIEW: `system`, `messages` and `tools` are replaced
    // on the view, never mutated in place. With no conversion there is one tool
    // representation, so stage B applies to it alone.
    const payload = await this.applyRequestHooks(c, incoming);
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
                // Bytes after the last newline, held until their line completes.
                let pending = "";
                // The complete lines of the current SSE event, held until its
                // blank separator: SSE fixes an event's type only at dispatch,
                // and `event:` may legally FOLLOW the `data:` it names, so no
                // line of an event can be forwarded before the whole event is
                // known (redactSseErrorEvent).
                let held: string[] = [];
                let eventLog = "";

                const forward = (lines: string[], text: string) => {
                  for (const line of lines) if (line.trim()) eventLog += `${line}\n`;
                  if (cancelled || !text) return;
                  controller.enqueue(encoder.encode(text));
                };
                // Forward the held event, plus `tail` (bytes with no newline
                // yet, only at the end of the stream). Every held line had its
                // own "\n", so the framing is rebuilt byte for byte.
                const flushHeld = (tail = "") => {
                  if (held.length === 0 && !tail) return;
                  const lines = redactSseErrorEvent(tail ? [...held, tail] : held);
                  held = [];
                  forward(lines, tail ? lines.join("\n") : `${lines.join("\n")}\n`);
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
                    // Each complete event in this chunk is forwarded as soon as
                    // its blank separator arrives; an unfinished one stays held.
                    const lines: string[] = [];
                    let out = "";
                    for (const line of text.slice(0, cut).split("\n")) {
                      held.push(line);
                      if (line === "" || line === "\r") {
                        const event = redactSseErrorEvent(held);
                        held = [];
                        lines.push(...event);
                        out += `${event.join("\n")}\n`;
                      }
                    }
                    forward(lines, out);
                  }
                  flushHeld(pending + decoder.decode());
                  if (eventLog) log(eventLog);
                  if (!cancelled) controller.close();
                } catch (e) {
                  // The lines already read are forwarded, as they were before
                  // events were held; the incomplete line is dropped.
                  try {
                    flushHeld();
                  } catch {}
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

  // biome-ignore lint/suspicious/noExplicitAny: the Messages API payload is untyped at this layer
  private async applyRequestHooks(c: Context, payload: any): Promise<any> {
    const hooks = requestHooksOf(c);
    if (!hooks || !payload || typeof payload !== "object") return payload;
    const view = { ...payload };
    const model = typeof payload.model === "string" ? payload.model : "";
    const scope = await hooks.beginAttempt(c, {
      claudeRequest: view,
      route: { modelId: model, provider: "anthropic", native: true },
      model,
      stream: payload.stream === true,
    });
    if (scope.hasToolDescriptionWork) {
      // Stage B replaces ELEMENTS of the array it is given; this one may still
      // be the shared payload's own. With no tools at all the actions are
      // journaled `unknown_tool` and the payload keeps having no `tools`.
      if (Array.isArray(view.tools)) view.tools = [...view.tools];
      scope.applyToolDescriptions(Array.isArray(view.tools) ? view.tools : [], null);
    }
    return view;
  }

  async shutdown(): Promise<void> {
    // No state to clean up
  }
}
