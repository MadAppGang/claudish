/**
 * OpenAI SSE → Claude SSE stream parser.
 *
 * Converts OpenAI-compatible Server-Sent Events to Claude SSE format.
 * Used by ComposedHandler to translate streaming responses from
 * OpenAI-compatible providers (OpenRouter, LiteLLM, local models, etc.)
 * into the format Claude Code expects.
 */

import type { Context } from "hono";
import { log, logStderr } from "../../../logger.js";

const SEARXNG_AVAILABLE = !!process.env.SEARXNG_URL;
import {
  validateAndRepairToolCall,
  inferMissingParameters,
  extractToolCallsFromText,
  type ToolSchema,
} from "../tool-call-recovery.js";
import { isWebSearchToolCall } from "../web-search-detector.js";
import { executeWebSearch, extractSearchQuery } from "../web-search-executor.js";
import { createResponseCapture, currentRequestNumber } from "../response-capture.js";

export interface StreamingState {
  usage: any;
  finalized: boolean;
  textStarted: boolean;
  textIdx: number;
  reasoningStarted: boolean;
  reasoningIdx: number;
  curIdx: number;
  tools: Map<number, ToolState>;
  toolIds: Set<string>;
  lastActivity: number;
  accumulatedText: string; // Accumulated text for potential tool call extraction
  lastFinishReason: string | null; // Last finish_reason seen (stop/length/content_filter) — diagnoses empty responses
}

export interface ToolState {
  id: string;
  name: string;
  blockIndex: number;
  started: boolean; // Whether content_block_start has been sent
  closed: boolean;
  suppressed: boolean; // Web search tools — drop from stream, replace with text
  remapped: boolean; // Web search tools re-emitted as the client's WebSearch tool_use
  arguments: string; // Accumulated JSON arguments string
  buffered: boolean; // Whether we're buffering args until tool call completes
}

/**
 * Whether the client declared a WebSearch tool in this request.
 * When it did, provider-side web search calls (web_search tool calls or GLM
 * <searchWeb> tags) are remapped to a synthetic WebSearch tool_use with
 * stop_reason "tool_use" — the client then runs its own WebSearch, gets the
 * results as a tool_result, and the agentic loop CONTINUES. Suppressing the
 * call and injecting results as text ends the turn (stop_reason end_turn),
 * which stalls the agent on raw search results (CoursIA incident 2026-06-10).
 */
function clientDeclaresWebSearch(toolSchemas?: any[]): boolean {
  return !!toolSchemas?.some((s) => s?.name === "WebSearch");
}

/**
 * Validate tool call arguments against the tool schema
 * Now includes automatic repair of missing parameters
 */
export function validateToolArguments(
  toolName: string,
  argsStr: string,
  toolSchemas: any[],
  textContent?: string
): {
  valid: boolean;
  missingParams: string[];
  parsedArgs: any;
  repaired: boolean;
  repairedArgs?: any;
} {
  const result = validateAndRepairToolCall(
    toolName,
    argsStr,
    toolSchemas as ToolSchema[],
    textContent
  );

  if (result.repaired) {
    log(`[ToolValidation] Repaired tool call ${toolName} - inferred missing parameters`);
  }

  return {
    valid: result.valid,
    missingParams: result.missingParams,
    parsedArgs: result.args,
    repaired: result.repaired,
    repairedArgs: result.repaired ? result.args : undefined,
  };
}

/**
 * Create initial streaming state
 */
export function createStreamingState(): StreamingState {
  return {
    usage: null,
    finalized: false,
    textStarted: false,
    textIdx: -1,
    reasoningStarted: false,
    reasoningIdx: -1,
    curIdx: 0,
    tools: new Map(),
    toolIds: new Set(),
    lastActivity: Date.now(),
    accumulatedText: "",
    lastFinishReason: null,
  };
}

/**
 * Handle streaming response conversion from OpenAI SSE to Claude SSE format
 */
export function createStreamingResponseHandler(
  c: Context,
  response: Response,
  adapter: any,
  target: string,
  middlewareManager: any,
  onTokenUpdate?: (input: number, output: number) => void,
  toolSchemas?: any[], // Tool schemas for validation
  toolNameMap?: Map<string, string>, // Truncated → original tool name mapping
  headerLatencyMs?: number // dispatch → upstream headers, from ComposedHandler
): Response {
  log(`[Streaming] ===== HANDLER STARTED for ${target} =====`);
  let isClosed = false;
  let ping: NodeJS.Timeout | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const streamMetadata = new Map<string, any>();

  const cap = createResponseCapture("openai", target);
  // TTFT anchor: headers are in the moment this handler is built. The first
  // upstream `data:` line then closes the measurement. stdout like [resp] so
  // the two markers join in docker logs (this was the instrumentation gap of
  // the 2026-08-24 abort investigation: totals were logged, TTFT never was).
  // reqN is FROZEN here, at construction — reading the counter later (in the
  // pump) would label the line with whatever request arrived during the wait,
  // and the bias grows with exactly the latency this marker exists to measure.
  const tHeaders = performance.now();
  const reqN = currentRequestNumber();
  let ttftLogged = false;

  return c.body(
    new ReadableStream({
      async start(controller) {
        // Diagnostic tap (no-op unless CLAUDISH_CAPTURE_DIR set): mirror every
        // outgoing byte to the response capture so a hung stream is visible offline.
        const _origEnqueue = controller.enqueue.bind(controller);
        controller.enqueue = ((chunk: any) => {
          cap.tap(chunk);
          return _origEnqueue(chunk);
        }) as any;

        const send = (e: string, d: any) => {
          if (!isClosed) {
            controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
          }
        };

        const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const state = createStreamingState();

        // Emit a synthetic WebSearch tool_use block. Used to remap provider
        // web search calls (web_search tool calls, GLM <searchWeb> tags) to
        // the client's own WebSearch tool so the agentic loop continues
        // (stop_reason "tool_use") instead of ending the turn on raw results.
        const emitWebSearchToolUse = (query: string, t?: ToolState) => {
          const blockIndex = t?.blockIndex ?? state.curIdx++;
          const id = t?.id ?? `tool_websearch_${Date.now()}_${blockIndex}`;
          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id, name: "WebSearch" },
          });
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
          });
          send("content_block_stop", { type: "content_block_stop", index: blockIndex });
          if (t) {
            t.started = true;
            t.closed = true;
          } else {
            // Register so hasStructuredTools counts it → stop_reason "tool_use".
            // Negative key avoids collisions with provider tool_call indices.
            state.tools.set(-(blockIndex + 1), {
              id,
              name: "WebSearch",
              blockIndex,
              started: true,
              closed: true,
              suppressed: false,
              remapped: true,
              arguments: JSON.stringify({ query }),
              buffered: false,
            });
          }
          log(`[Stream] Remapped provider web search → WebSearch tool_use (query="${query}")`);
        };

        send("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: target,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        send("ping", { type: "ping" });

        ping = setInterval(() => {
          if (!isClosed && Date.now() - state.lastActivity > 1000) {
            send("ping", { type: "ping" });
          }
        }, 1000);

        const finalize = async (reason: string, err?: string) => {
          if (state.finalized) return;
          state.finalized = true;
          // Hang-guard: the body below performs awaits and send()s that can throw
          // (a controller errored by a client-disconnect race, a callback failure).
          // If a throw escaped, the outer read-loop catch would re-call finalize() —
          // now a no-op (finalized=true) — leaving the stream with no message_stop
          // and a leaked ping interval: a hung HTTP 200 the client reports as "empty
          // or malformed response", and an agent blocked forever (the worst proxy
          // failure mode). The try/catch/finally GUARANTEES terminal events +
          // controller.close() + clearInterval(ping) on every exit path.
          let terminalSent = false;
          let toolCount = 0;
          try {
          toolCount = Array.from(state.tools.values()).filter(t => t.started && !t.suppressed).length;
          log(`[Stream] reason=${reason} model=${target} text=${state.textStarted} tools=${toolCount} text_len=${state.accumulatedText.length} err=${err ?? "none"}`);
          logStderr(`[Stream] ${target} ${reason} text_len=${state.accumulatedText.length} tools=${toolCount}`);

          // Debug: Log accumulated text for analysis
          if (state.accumulatedText.length > 0) {
            const preview = state.accumulatedText.slice(0, 500).replace(/\n/g, "\\n");
            log(
              `[Streaming] Accumulated text (${state.accumulatedText.length} chars): ${preview}...`
            );
          }

          // Check for text-based web search tags (GLM emits <searchWeb><query>...</query></searchWeb>)
          // These must be intercepted before text-based tool call extraction, since we want to
          // execute SearXNG and replace the search tags with results, not pass them through.
          let searchWebResults: string | null = null;
          let pendingSearchRemap: string | null = null;
          let cleanedText = state.accumulatedText;
          const searchWebMatch = state.accumulatedText.match(/<searchWeb>\s*<query>([\s\S]*?)<\/query>\s*<\/searchWeb>/i);
          if (searchWebMatch) {
            const searchQuery = searchWebMatch[1].trim();
            if (searchQuery && clientDeclaresWebSearch(toolSchemas)) {
              // Remap to the client's WebSearch tool — emitted as a tool_use
              // block after the text blocks close, keeping the agent loop alive.
              log(`[Stream] GLM searchWeb detected: "${searchQuery}" — remapping to client WebSearch tool_use`);
              pendingSearchRemap = searchQuery;
            } else {
              log(`[Stream] GLM searchWeb detected: "${searchQuery}" — intercepting via SearXNG`);
              if (searchQuery && SEARXNG_AVAILABLE) {
                searchWebResults = await executeWebSearch(searchQuery);
              } else {
                searchWebResults = searchQuery
                  ? `[Web search for "${searchQuery}" could not be executed. SearXNG is not configured.]`
                  : `[Web search was requested but no query was provided.]`;
              }
            }
            // Remove the search tags from accumulated text so they don't appear in output
            cleanedText = state.accumulatedText.replace(/<searchWeb>[\s\S]*?<\/searchWeb>/i, "").trim();
            state.accumulatedText = cleanedText;
          }

          // Close any open reasoning/text blocks BEFORE emitting new blocks below.
          // If we don't, new tool_use blocks (higher indices) get fully opened/closed
          // before the reasoning block (lower index) is stopped — the Anthropic client
          // rejects this out-of-order lifecycle as "Content block not found".
          //
          // Snapshot BEFORE clearing the flags: hasContent (below) must know whether
          // text/reasoning was EVER produced, not whether a block is still open.
          // Reading state.textStarted after this close block made hasContent always
          // false for pure-text responses — a spurious "[Error: empty response …
          // try /compact]" was appended after every valid text answer (cluster-wide
          // false-compact incident, 2026-06-12).
          const producedText = state.textStarted;
          const producedReasoning = state.reasoningStarted;
          if (state.reasoningStarted) {
            send("content_block_stop", { type: "content_block_stop", index: state.reasoningIdx });
            state.reasoningStarted = false;
          }
          if (state.textStarted) {
            send("content_block_stop", { type: "content_block_stop", index: state.textIdx });
            state.textStarted = false;
          }

          // Check for text-based tool calls before finalizing
          // Some models (like Qwen) output tool calls as text instead of structured tool_calls
          const textToolCalls = extractToolCallsFromText(state.accumulatedText);
          log(`[Streaming] Text-based tool calls found: ${textToolCalls.length}`);
          if (textToolCalls.length > 0) {
            log(
              `[Streaming] Found ${textToolCalls.length} text-based tool call(s), converting to structured format`
            );

            // Send each extracted tool call as a proper tool_use block
            for (const tc of textToolCalls) {
              const toolIdx = state.curIdx++;
              const toolId = `tool_${Date.now()}_${toolIdx}`;

              send("content_block_start", {
                type: "content_block_start",
                index: toolIdx,
                content_block: { type: "tool_use", id: toolId, name: tc.name },
              });
              send("content_block_delta", {
                type: "content_block_delta",
                index: toolIdx,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.arguments) },
              });
              send("content_block_stop", { type: "content_block_stop", index: toolIdx });
            }
          }

          // GLM <searchWeb> remapped to the client's WebSearch tool —
          // emitted as a tool_use block so stop_reason becomes "tool_use".
          if (pendingSearchRemap) {
            emitWebSearchToolUse(pendingSearchRemap);
          }

          // Inject SearXNG results if we intercepted GLM <searchWeb> tags.
          // Sent as a separate text block after the (now-cleaned) model output.
          if (searchWebResults) {
            const srchIdx = state.curIdx++;
            send("content_block_start", {
              type: "content_block_start",
              index: srchIdx,
              content_block: { type: "text", text: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: srchIdx,
              delta: { type: "text_delta", text: searchWebResults },
            });
            send("content_block_stop", { type: "content_block_stop", index: srchIdx });
          }

          // Remapped web search tools that never saw finish_reason="tool_calls"
          // (e.g. the provider ended with "stop") — emit them now so the
          // query isn't silently dropped and stop_reason becomes "tool_use".
          for (const t of Array.from(state.tools.values())) {
            if (t.remapped && !t.closed) {
              const query = extractSearchQuery(t.arguments);
              if (query) {
                emitWebSearchToolUse(query, t);
              } else {
                t.closed = true;
              }
            }
          }

          // Handle buffered-but-unsent structured tool calls.
          // Some models (e.g., Gemini via LiteLLM) send tool calls with finish_reason="stop"
          // instead of "tool_calls", so the normal validation path (line ~695) is never reached.
          // We must send these buffered tools here so Claude Code can execute them.
          for (const t of Array.from(state.tools.values())) {
            if (!t.closed && t.buffered && !t.started) {
              if (toolSchemas && toolSchemas.length > 0) {
                const validation = validateToolArguments(
                  t.name,
                  t.arguments,
                  toolSchemas,
                  state.accumulatedText
                );

                if (validation.valid || (validation.repaired && validation.repairedArgs)) {
                  const argsJson = JSON.stringify(
                    validation.repaired ? validation.repairedArgs : validation.parsedArgs
                  );
                  log(
                    `[Streaming] Sending buffered tool call (finish_reason!=tool_calls): ${t.name} with args: ${argsJson}`
                  );
                  send("content_block_start", {
                    type: "content_block_start",
                    index: t.blockIndex,
                    content_block: { type: "tool_use", id: t.id, name: t.name },
                  });
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: t.blockIndex,
                    delta: { type: "input_json_delta", partial_json: argsJson },
                  });
                  send("content_block_stop", {
                    type: "content_block_stop",
                    index: t.blockIndex,
                  });
                  t.started = true;
                  t.closed = true;
                } else {
                  log(
                    `[Streaming] Buffered tool call ${t.name} failed validation, skipping: ${validation.missingParams.join(", ")}`
                  );
                  t.closed = true;
                }
              } else {
                // No schemas to validate against — send as-is
                const argsJson = t.arguments || "{}";
                log(
                  `[Streaming] Sending buffered tool call (no validation): ${t.name} with args: ${argsJson}`
                );
                send("content_block_start", {
                  type: "content_block_start",
                  index: t.blockIndex,
                  content_block: { type: "tool_use", id: t.id, name: t.name },
                });
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: t.blockIndex,
                  delta: { type: "input_json_delta", partial_json: argsJson },
                });
                send("content_block_stop", {
                  type: "content_block_stop",
                  index: t.blockIndex,
                });
                t.started = true;
                t.closed = true;
              }
            }
          }

          // Close any remaining started-but-unclosed tool calls
          for (const t of Array.from(state.tools.values())) {
            if (t.started && !t.closed) {
              send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
              t.closed = true;
            }
          }

          if (middlewareManager) {
            await middlewareManager.afterStreamComplete(target, streamMetadata);
          }

          // Determine whether the stream produced any usable content.
          const hasStructuredTools = Array.from(state.tools.values()).some((t) => t.started && !t.suppressed);
          // A suppressed web-search tool that reached `closed` emitted its SearXNG
          // result as a real text block (see the suppression path) — that IS content,
          // even though the tool is suppressed and never set textStarted. Likewise the
          // GLM <searchWeb> SearXNG injection. Counting these prevents a spurious
          // "[Error: empty response]" being appended after valid search results.
          const hasSuppressedWebText = Array.from(state.tools.values()).some((t) => t.suppressed && t.closed);
          const hasContent =
            producedText ||
            producedReasoning ||
            state.accumulatedText.length > 0 ||
            hasStructuredTools ||
            textToolCalls.length > 0 ||
            hasSuppressedWebText ||
            searchWebResults !== null;

          if (reason === "error") {
            // Socket close, network error, or other fetch failure mid-stream.
            // Previously we sent event: error, but Claude Code surfaces raw SSE error
            // events as "API Error: <message>" without closing the turn cleanly.
            // Instead, close any open blocks and inject the error as a text block
            // so the turn ends gracefully with end_turn.
            log(`[Stream] Stream error from ${target}: ${err}`);
            logStderr(`[Stream] Stream error from ${target}: ${err?.substring(0, 120)}`);

            // Close reasoning if still open
            if (state.reasoningStarted) {
              send("content_block_stop", { type: "content_block_stop", index: state.reasoningIdx });
              state.reasoningStarted = false;
            }
            // Close text if still open
            if (state.textStarted) {
              send("content_block_stop", { type: "content_block_stop", index: state.textIdx });
              state.textStarted = false;
            }

            // Inject error as a text block (or replace if no content was produced)
            const isSocketClose = /socket.*closed|connection was closed|ECONNRESET/i.test(err || "");
            const errorNotice = isSocketClose
              ? `[The connection to the model provider was interrupted. This is usually temporary — please retry.]`
              : `[Upstream stream error: ${(err || "unknown").substring(0, 200)}]`;
            const errorIdx = state.curIdx++;
            send("content_block_start", {
              type: "content_block_start",
              index: errorIdx,
              content_block: { type: "text", text: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: errorIdx,
              delta: { type: "text_delta", text: errorNotice },
            });
            send("content_block_stop", { type: "content_block_stop", index: errorIdx });

            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: {
                input_tokens: state.usage?.prompt_tokens || 0,
                output_tokens: state.usage?.completion_tokens || 0,
              },
            });
            send("message_stop", { type: "message_stop" });
            terminalSent = true;
          } else {
            // Ensure at least one content block exists — some providers (z.ai, GLM)
            // return empty responses (finish_reason without content). The Anthropic
            // SDK treats messages with content:[] as malformed.
            if (!hasContent) {
              // Inject a text content block with the error message.
              // Previously we sent event: error, but Claude Code does not handle
              // raw error events in-stream — it reports "empty or malformed response".
              // A content block with the error text is properly parsed and surfaced.
              //
              // Cause classification (was: always blamed "context too large"):
              //   - finish_reason "length"        → genuine context/max_tokens overflow → compact
              //   - finish_reason "content_filter"→ provider content filter → not a context issue
              //   - otherwise (stop/null)         → almost always transient (provider load /
              //                                       momentary rate limit) → RETRY, do NOT compact
              // The old blanket "compact" message pushed agents into a destructive /compact on
              // transient empties (the majority — sub-agents with tiny contexts), discarding
              // context mid-task. Lead with "transient, retry"; mention compact only when the
              // cause is actually length/overflow.
              const fr = state.lastFinishReason;
              const promptTokens = state.usage?.prompt_tokens ?? 0;
              const isOverflow = fr === "length" || promptTokens > 100_000;
              const emptyMsg =
                fr === "content_filter"
                  ? `The model's response was filtered by the provider's content policy. This is usually transient — please retry, or rephrase the request.`
                  : isOverflow
                    ? `The model returned an empty response and the conversation context is very large (finish_reason: ${fr || "stop"}, ~${promptTokens} input tokens). Try /compact to reduce the context size, or retry.`
                    : `The model returned an empty response (finish_reason: ${fr || "stop"}). This is usually transient — a momentary provider load or rate limit, NOT a context-size problem. Please retry. If it recurs repeatedly, then try /compact.`;
              const blockIdx = state.curIdx++;
              send("content_block_start", {
                type: "content_block_start",
                index: blockIdx,
                content_block: { type: "text", text: "" },
              });
              send("content_block_delta", {
                type: "content_block_delta",
                index: blockIdx,
                delta: { type: "text_delta", text: `[Error: ${emptyMsg}]` },
              });
              send("content_block_stop", { type: "content_block_stop", index: blockIdx });
              const cls = fr === "content_filter" ? "content-filter" : isOverflow ? "overflow" : "transient";
              logStderr(
                `[Stream] EMPTY RESPONSE from ${target} — finish_reason=${fr || "null"} prompt_tokens=${promptTokens} → ${cls} (injected ${cls} message)`
              );
              log(
                `[Stream] Empty response from provider (finish_reason=${fr || "null"}, prompt_tokens=${promptTokens}) — classified as ${cls}, injected guidance`
              );
            }

            // Set stop_reason based on whether we sent ANY tool calls (text-based or structured)
            const stopReason =
              textToolCalls.length > 0 || hasStructuredTools ? "tool_use" : "end_turn";
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: {
                input_tokens: state.usage?.prompt_tokens || 0,
                output_tokens: state.usage?.completion_tokens || 0,
              },
            });
            send("message_stop", { type: "message_stop" });
            terminalSent = true;
          }

          // Update token counts - use actual usage if available, otherwise estimate
          if (onTokenUpdate) {
            if (state.usage) {
              log(
                `[Streaming] Final usage: prompt=${state.usage.prompt_tokens || 0}, completion=${state.usage.completion_tokens || 0}`
              );
              onTokenUpdate(state.usage.prompt_tokens || 0, state.usage.completion_tokens || 0);
            } else {
              // Estimate tokens for local models that don't return usage data
              // Rough estimate: ~4 characters per token
              const estimatedOutputTokens = Math.ceil(state.accumulatedText.length / 4);
              log(
                `[Streaming] No usage data from provider, estimating: ~${estimatedOutputTokens} output tokens`
              );
              onTokenUpdate(0, estimatedOutputTokens);
            }
          }

          } catch (finalizeErr) {
            // finalize() body threw before completing (controller enqueue raced a
            // disconnect, a callback failed, etc.). Force terminal events so the
            // client never hangs on an un-terminated 200.
            logStderr(
              `[Stream] finalize() threw for ${target}: ${String(finalizeErr).slice(0, 160)} — forcing terminal events`
            );
            if (!terminalSent) {
              try {
                send("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: {
                    input_tokens: state.usage?.prompt_tokens || 0,
                    output_tokens: state.usage?.completion_tokens || 0,
                  },
                });
                send("message_stop", { type: "message_stop" });
                terminalSent = true;
              } catch {}
            }
          } finally {
            // ALWAYS terminate the HTTP stream and free the ping timer, on every
            // exit path (success, empty, error, or a throw inside finalize).
            if (!isClosed) {
              try {
                controller.enqueue(encoder.encode("data: [DONE]\n\n\n"));
              } catch {}
              try {
                controller.close();
              } catch {}
              isClosed = true;
              if (ping) clearInterval(ping);
              try {
                cap.note(`close reason=${reason}`);
                cap.done({ closed: true, reason, tools: toolCount, text_len: state.accumulatedText.length, err: err ?? null });
              } catch {}
            }
          }
        };

        try {
          const reader = response.body!.getReader();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim() || !line.startsWith("data: ")) continue;
              const dataStr = line.slice(6);
              if (!ttftLogged) {
                ttftLogged = true;
                const firstEventMs = Math.round(performance.now() - tHeaders);
                const hdr = headerLatencyMs ?? -1;
                process.stdout.write(
                  `  [ttft] openai model=${target} reqN=${reqN} headers=${hdr}ms firstEvent=${firstEventMs}ms total=${hdr >= 0 ? hdr + firstEventMs : -1}ms\n`
                );
              }
              log(`[SSE:openai] ${dataStr.substring(0, 300)}`);
              if (dataStr === "[DONE]") {
                await finalize("done");
                return;
              }

              try {
                const chunk = JSON.parse(dataStr);
                if (chunk.usage) {
                  state.usage = chunk.usage;
                  log(
                    `[Streaming] Usage data received: prompt=${chunk.usage.prompt_tokens}, completion=${chunk.usage.completion_tokens}, total=${chunk.usage.total_tokens}`
                  );
                }

                const delta = chunk.choices?.[0]?.delta;
                const finishReason = chunk.choices?.[0]?.finish_reason;

                // Track the last non-null finish_reason so the empty-response
                // fallback (finalize) can diagnose the cause instead of guessing
                // "context overflow" for every empty response.
                if (finishReason) {
                  state.lastFinishReason = finishReason;
                }

                // Debug: Log chunk details for troubleshooting early termination
                if (delta?.content || finishReason) {
                  log(
                    `[Streaming] Chunk: content=${delta?.content?.length || 0} chars, finish_reason=${finishReason || "null"}`
                  );
                }

                if (delta) {
                  if (middlewareManager) {
                    await middlewareManager.afterStreamChunk({
                      modelId: target,
                      chunk,
                      delta,
                      metadata: streamMetadata,
                    });
                  }

                  // Handle reasoning_content (Kimi, DeepSeek thinking models via LiteLLM)
                  if (delta.reasoning_content) {
                    state.lastActivity = Date.now();
                    if (!state.reasoningStarted) {
                      state.reasoningIdx = state.curIdx++;
                      send("content_block_start", {
                        type: "content_block_start",
                        index: state.reasoningIdx,
                        content_block: { type: "thinking", thinking: "" },
                      });
                      state.reasoningStarted = true;
                    }
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: state.reasoningIdx,
                      delta: { type: "thinking_delta", thinking: delta.reasoning_content },
                    });
                  }

                  // Handle text content
                  const txt = delta.content || "";
                  log(
                    `[Streaming] Text chunk: "${txt.substring(0, 30).replace(/\n/g, "\\n")}" (${txt.length} chars)`
                  );
                  if (txt) {
                    state.lastActivity = Date.now();
                    // Close thinking block before starting text
                    if (state.reasoningStarted) {
                      send("content_block_stop", {
                        type: "content_block_stop",
                        index: state.reasoningIdx,
                      });
                      state.reasoningStarted = false;
                    }
                    const res = adapter.processTextContent(txt, "");
                    log(
                      `[Streaming] After adapter: "${res.cleanedText.substring(0, 30).replace(/\n/g, "\\n")}" (${res.cleanedText.length} chars, transformed=${res.wasTransformed})`
                    );

                    // Debug: Log text processing
                    if (txt.length > 0 && res.cleanedText.length === 0) {
                      log(`[Streaming] Text filtered out by adapter: "${txt.substring(0, 50)}"`);
                    }

                    if (res.cleanedText) {
                      // Accumulate text for potential tool call extraction
                      state.accumulatedText += res.cleanedText;

                      // Check if text contains STRUCTURED tool call patterns that we should hold back
                      // Only hold back for patterns we can actually parse (XML, JSON), not natural language
                      // Natural language patterns are extracted at finalization, not held back
                      const hasStructuredToolPattern =
                        // Qwen XML-style: <function=ToolName>
                        /<function=[^>]+>/.test(state.accumulatedText) ||
                        // JSON tool call in text: {"name": "Task", "arguments":
                        /\{\s*"(?:name|tool)"\s*:\s*"(?:Task|Read|Write|Edit|Bash|Grep|Glob)"/i.test(
                          state.accumulatedText
                        ) ||
                        // XML tool_call tags: <tool_call>
                        /<tool_call>/.test(state.accumulatedText);

                      // Only hold back if we have a structured pattern AND haven't accumulated too much
                      // (if we've accumulated > 1000 chars without a complete pattern, release the text)
                      const shouldHoldBack =
                        hasStructuredToolPattern && state.accumulatedText.length < 1000;

                      if (shouldHoldBack) {
                        log(
                          `[Streaming] Text held back (structured tool pattern): ${state.accumulatedText.length} chars accumulated`
                        );
                      }

                      if (!shouldHoldBack) {
                        if (!state.textStarted) {
                          state.textIdx = state.curIdx++;
                          send("content_block_start", {
                            type: "content_block_start",
                            index: state.textIdx,
                            content_block: { type: "text", text: "" },
                          });
                          state.textStarted = true;
                          log(`[Streaming] Started text block at index ${state.textIdx}`);
                        }
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: state.textIdx,
                          delta: { type: "text_delta", text: res.cleanedText },
                        });
                      }
                    }
                  }

                  // Handle tool calls
                  if (delta.tool_calls) {
                    log(
                      `[Streaming] Received ${delta.tool_calls.length} structured tool call(s) from model`
                    );
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index;
                      let t = state.tools.get(idx);
                      if (tc.function?.name) {
                        if (!t) {
                          // Close thinking and text blocks before starting tool
                          if (state.reasoningStarted) {
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: state.reasoningIdx,
                            });
                            state.reasoningStarted = false;
                          }
                          if (state.textStarted) {
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: state.textIdx,
                            });
                            state.textStarted = false;
                          }
                          // Restore truncated tool name to original if mapping exists
                          const rawName = tc.function.name;
                          const restoredName = toolNameMap?.get(rawName) || rawName;
                          const isWebSearch = isWebSearchToolCall(restoredName);
                          const remapToWebSearch = isWebSearch && clientDeclaresWebSearch(toolSchemas);
                          if (isWebSearch) {
                            log(`[Stream] Web search tool call detected: "${restoredName}" — ${remapToWebSearch ? "remapping to client WebSearch tool_use" : `intercepting via SearXNG (available=${SEARXNG_AVAILABLE})`}`);
                          }
                          t = {
                            id: tc.id || `tool_${Date.now()}_${idx}`,
                            name: restoredName,
                            blockIndex: state.curIdx++,
                            started: false,
                            closed: false,
                            suppressed: isWebSearch && !remapToWebSearch,
                            remapped: remapToWebSearch,
                            arguments: "", // Initialize arguments accumulator
                            buffered: !!toolSchemas && toolSchemas.length > 0 && !isWebSearch,
                          };
                          state.tools.set(idx, t);
                        }
                        // Only send content_block_start immediately if NOT buffering.
                        // Suppressed and remapped tools never stream their blocks live.
                        if (!t.started && !t.buffered && !t.suppressed && !t.remapped) {
                          send("content_block_start", {
                            type: "content_block_start",
                            index: t.blockIndex,
                            content_block: { type: "tool_use", id: t.id, name: t.name },
                          });
                          t.started = true;
                        }
                      }
                      if (tc.function?.arguments && t) {
                        // Always accumulate arguments — suppressed/remapped tools
                        // need them too (extractSearchQuery reads the query later).
                        t.arguments += tc.function.arguments;
                        // Only stream immediately if NOT buffering/suppressed/remapped
                        if (!t.buffered && !t.suppressed && !t.remapped) {
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: t.blockIndex,
                            delta: {
                              type: "input_json_delta",
                              partial_json: tc.function.arguments,
                            },
                          });
                        }
                      }
                    }
                  }
                }

                if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
                  for (const t of Array.from(state.tools.values())) {
                    if (t.remapped) {
                      if (!t.closed) {
                        const query = extractSearchQuery(t.arguments);
                        if (query) {
                          emitWebSearchToolUse(query, t);
                        } else {
                          // No usable query — degrade to the suppression path
                          // (text injection below) rather than emit a broken tool_use.
                          t.remapped = false;
                          t.suppressed = true;
                        }
                      }
                      if (t.closed) continue;
                    }
                    if (t.suppressed) {
                      // Execute web search via SearXNG and inject results
                      if (!t.closed) {
                        const query = extractSearchQuery(t.arguments);
                        let resultText: string;
                        if (query && SEARXNG_AVAILABLE) {
                          resultText = await executeWebSearch(query);
                        } else {
                          resultText = query
                            ? `[Web search for "${query}" could not be executed. The search service (SearXNG) is not configured. Set SEARXNG_URL env var to enable.]`
                            : `[Web search was requested but no query was provided.]`;
                        }
                        send("content_block_start", {
                          type: "content_block_start",
                          index: t.blockIndex,
                          content_block: { type: "text", text: "" },
                        });
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: t.blockIndex,
                          delta: { type: "text_delta", text: resultText },
                        });
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: t.blockIndex,
                        });
                        t.closed = true;
                      }
                      continue;
                    }
                    if (!t.closed) {
                      // Validate and potentially repair tool arguments
                      if (toolSchemas && toolSchemas.length > 0) {
                        const validation = validateToolArguments(
                          t.name,
                          t.arguments,
                          toolSchemas,
                          state.accumulatedText
                        );

                        if (validation.repaired && validation.repairedArgs) {
                          // Tool call was repaired - send the complete repaired arguments
                          log(
                            `[Streaming] Tool call ${t.name} was repaired with inferred parameters`
                          );
                          const repairedJson = JSON.stringify(validation.repairedArgs);
                          log(
                            `[Streaming] Sending repaired tool call: ${t.name} with args: ${repairedJson}`
                          );

                          // If buffered, this is the first time we're sending this tool call
                          // Send the complete repaired tool call as a single block
                          if (t.buffered && !t.started) {
                            send("content_block_start", {
                              type: "content_block_start",
                              index: t.blockIndex,
                              content_block: { type: "tool_use", id: t.id, name: t.name },
                            });
                            send("content_block_delta", {
                              type: "content_block_delta",
                              index: t.blockIndex,
                              delta: { type: "input_json_delta", partial_json: repairedJson },
                            });
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: t.blockIndex,
                            });
                            t.started = true;
                            t.closed = true;
                            continue;
                          }

                          // If already started (non-buffered), close old and send new
                          if (t.started) {
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: t.blockIndex,
                            });
                            const repairedIdx = state.curIdx++;
                            const repairedId = `tool_repaired_${Date.now()}_${repairedIdx}`;
                            send("content_block_start", {
                              type: "content_block_start",
                              index: repairedIdx,
                              content_block: { type: "tool_use", id: repairedId, name: t.name },
                            });
                            send("content_block_delta", {
                              type: "content_block_delta",
                              index: repairedIdx,
                              delta: { type: "input_json_delta", partial_json: repairedJson },
                            });
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: repairedIdx,
                            });
                            t.closed = true;
                            continue;
                          }

                          // Non-buffered and never started — emit repaired tool at a new index
                          const fallbackIdx = state.curIdx++;
                          const fallbackId = `tool_repaired_${Date.now()}_${fallbackIdx}`;
                          log(
                            `[Streaming] Emitting repaired tool ${t.name} (non-buffered, not started) at fallback index ${fallbackIdx}`
                          );
                          send("content_block_start", {
                            type: "content_block_start",
                            index: fallbackIdx,
                            content_block: { type: "tool_use", id: fallbackId, name: t.name },
                          });
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: fallbackIdx,
                            delta: { type: "input_json_delta", partial_json: repairedJson },
                          });
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: fallbackIdx,
                          });
                          t.closed = true;
                          continue;
                        }

                        if (!validation.valid) {
                          // Repair failed - send error message instead of invalid tool call
                          log(
                            `[Streaming] Tool call ${t.name} validation failed: ${validation.missingParams.join(", ")}`
                          );
                          // Close the original tool block FIRST (lower index) so that
                          // the error text block (higher index) doesn't open/close out of order.
                          if (t.started && !t.buffered && !t.closed) {
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: t.blockIndex,
                            });
                          }
                          const errorIdx = t.buffered ? t.blockIndex : state.curIdx++;
                          const errorMsg = `\n\n⚠️ Tool call "${t.name}" failed: missing required parameters: ${validation.missingParams.join(", ")}. Local models sometimes generate incomplete tool calls. Please try again or use a model with better tool support.`;
                          send("content_block_start", {
                            type: "content_block_start",
                            index: errorIdx,
                            content_block: { type: "text", text: "" },
                          });
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: errorIdx,
                            delta: { type: "text_delta", text: errorMsg },
                          });
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: errorIdx,
                          });
                          t.closed = true;
                          continue;
                        }

                        // Valid tool call - send if buffered, close if not
                        if (t.buffered && !t.started) {
                          const argsJson = JSON.stringify(validation.parsedArgs);
                          send("content_block_start", {
                            type: "content_block_start",
                            index: t.blockIndex,
                            content_block: { type: "tool_use", id: t.id, name: t.name },
                          });
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: t.blockIndex,
                            delta: { type: "input_json_delta", partial_json: argsJson },
                          });
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: t.blockIndex,
                          });
                          t.started = true;
                          t.closed = true;
                          continue;
                        }
                      }

                      // Non-buffered valid tool call or no validation - just close
                      if (t.started && !t.closed) {
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: t.blockIndex,
                        });
                        t.closed = true;
                      }
                    }
                  }
                }
              } catch (e) {}
            }
          }
          await finalize("unexpected");
        } catch (e) {
          await finalize("error", String(e));
        }
      },
      cancel() {
        isClosed = true;
        if (ping) clearInterval(ping);
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}

/**
 * Estimate token count from text (rough approximation)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
