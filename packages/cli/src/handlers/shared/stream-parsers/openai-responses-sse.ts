/**
 * OpenAI Responses API SSE → Claude SSE stream parser.
 *
 * Handles Codex models that use /v1/responses instead of /v1/chat/completions.
 * The Responses API has different event types:
 *   response.output_text.delta → content text
 *   response.output_item.added → new item (function_call, reasoning)
 *   response.function_call_arguments.delta → tool argument streaming
 *   response.reasoning_summary_text.delta → thinking output
 *   response.output_item.done → close tool_use block
 *   response.completed / response.done → final usage
 */

import type { Context } from "hono";
import { log, getLogLevel } from "../../../logger.js";
import { wrapAnthropicError } from "../anthropic-error.js";
import { requestNumberFor } from "../../../fork/middleware/request-logger.js";

/**
 * Extract the token counts named by a context-overflow error.
 *
 * The Responses backend states both numbers in prose, e.g. "This model's
 * maximum context length is 272000 tokens. However, your messages resulted in
 * 285000 tokens." We need the used count because the error path reports
 * `usage 0+0` (no `response.completed` ever arrives), and a zero tells Claude
 * Code the conversation is EMPTY: its context gauge resets, auto-compact never
 * fires, the session stays in overflow, and every later turn fails the same
 * way — which reads to the user as "the agent ignores my messages"
 * (gpt-5.6-sol lane report, 2026-08-27).
 *
 * When the used count is absent but the limit is stated, the limit is a valid
 * lower bound — we overflowed it by definition — and is enough to trip
 * auto-compact. Returns undefined for every other error, which keeps its
 * existing behavior untouched.
 */
export function parseContextOverflow(
  message: string,
  code?: string
): { used?: number; limit?: number } | undefined {
  const msg = message || "";
  const isOverflow =
    code === "context_length_exceeded" ||
    /context length|context window|maximum context|too many tokens/i.test(msg);
  if (!isOverflow) return undefined;

  const limitMatch =
    msg.match(/maximum context length is (\d+)/i) || msg.match(/context window of (\d+)/i);
  const usedMatch =
    msg.match(/resulted in (\d+) tokens/i) ||
    msg.match(/requested (\d+) tokens/i) ||
    msg.match(/input of (\d+) tokens/i);
  const limit = limitMatch ? Number(limitMatch[1]) : undefined;
  const used = usedMatch ? Number(usedMatch[1]) : limit;
  return { used, limit };
}

type StreamReadError = {
  isSocketClose: boolean;
  detail: string;
};

function classifyStreamReadError(error: unknown): StreamReadError {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; current != null && depth < 4 && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof Error) {
      details.push(`${current.name}: ${current.message}`);
    } else {
      details.push(String(current));
    }

    const code =
      typeof current === "object" && current !== null && "code" in current
        ? String((current as { code?: unknown }).code || "")
        : "";
    if (code) details.push(`code=${code}`);
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }

  const detail = details.join(" <- ").slice(0, 300);
  const isSocketClose =
    /socket.*closed|connection (?:was )?closed|connection reset/i.test(detail) ||
    /(?:^|\W)(?:ECONNRESET|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE)(?:$|\W)/i.test(detail);
  return { isSocketClose, detail };
}

export function createResponsesStreamHandler(
  c: Context,
  response: Response,
  opts: {
    modelName: string;
    onTokenUpdate?: (input: number, output: number) => void;
    toolNameMap?: Map<string, string>;
    /** dispatch → upstream headers latency, from ComposedHandler (for [ttft]). */
    headerLatencyMs?: number;
    /**
     * Transparent in-stream retry (2026-09-02 Sol crashes): re-issues the SAME
     * upstream request. Called ONLY when a retryable error event (server_error…)
     * arrives while ZERO content blocks have been emitted to the client — from
     * the client's perspective nothing happened (it saw only message_start +
     * pings). Returns null / throws → the original error is surfaced as before.
     */
    retryUpstream?: () => Promise<Response | null>;
    /** Backoff before each transparent-retry attempt (tests inject millisecond delays). */
    retryBackoffMs?: readonly number[];
  }
): Response {
  let reader = response.body?.getReader();
  if (!reader) {
    return c.json(wrapAnthropicError(500, "No response body"), 500) as any;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // TTFT anchors — headers arrived when this handler was built; the first
  // upstream `data:` line completes the measurement. reqN resolved from the
  // request object itself (assigned at ingestion): the global counter read at
  // this point returns whichever request is CURRENT while this one waited for
  // headers — under concurrency every handler in a window would log the same
  // latest number.
  const tHeaders = performance.now();
  const reqN = requestNumberFor(c.req);
  let ttftLogged = false;

  let buffer = "";
  // Block-index bookkeeping: one monotonic counter. Indices handed to the
  // client MUST be sequential (0,1,2,…) per message — the Anthropic SSE
  // contract keys content blocks by index and consumers rebuild them
  // positionally. The previous arithmetic (blockIndex + functionCalls.size +
  // (hasTextContent?1:0)) skipped an index on every parallel tool call after
  // the first (text at 0, tools at 1, 3, 4…), firing on nearly every agentic
  // turn of the Codex lane.
  let nextBlockIndex = 0;
  let textBlockIndex: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let hasTextContent = false;
  let hasToolUse = false;
  let lastActivity = Date.now();
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let isClosed = false;
  let completed = false;
  let incompleteReason: string | null = null;
  let dataEvents = 0;
  let totalBytes = 0;
  // Transparent-retry state: bounded, and only while nothing is client-visible.
  let retryAttempts = 0;
  const FAST_RETRY_BACKOFF_MS = [1_000, 3_000];
  // Match the patient admission-overload budget in ComposedHandler. The Responses
  // backend may emit response.created before rejecting with server_is_overloaded,
  // which makes the start peek classify the stream as healthy. Five coordinators
  // hit that exact gap within five minutes on 2026-09-10.
  const OVERLOAD_RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 150_000];
  // server_error = the observed OpenAI transient (2026-09-02: 10 hits in 3h,
  // each one killing an agent turn). Deterministic codes are excluded — a
  // retry would fail identically and just burn the attempt.
  const RETRYABLE_ERROR_CODES = new Set([
    "server_error",
    "server_is_overloaded",
    "internal_error",
    "temporarily_unavailable",
    "overloaded_error",
    // invalid_prompt is OpenAI's usage-policy moderation flag and it is
    // probabilistic: the identical prompt usually passes a plain retry
    // (2026-09-10 02:10Z: a single flag on the opus cascade's cx@gpt-5.6-sol
    // step killed the session turn). A genuinely malformed prompt burns the
    // same two fast attempts (~4s) and then surfaces identically.
    "invalid_prompt",
  ]);

  // Track function calls being streamed
  const functionCalls: Map<
    string,
    { name: string; arguments: string; index: number; claudeId?: string }
  > = new Map();
  const closedFunctionBlocks = new Set<number>();

  const stream = new ReadableStream({
    start: async (controller) => {
      const send = (event: string, data: any) => {
        if (!isClosed) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
      };

      const closeOpenBlocks = () => {
        if (textBlockIndex !== null) {
          send("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
          textBlockIndex = null;
        }
        for (const fnCall of new Set(functionCalls.values())) {
          if (!closedFunctionBlocks.has(fnCall.index)) {
            send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
            closedFunctionBlocks.add(fnCall.index);
          }
        }
      };

      const finishInterruptedStream = (error: unknown) => {
        if (isClosed) return;
        const { detail } = classifyStreamReadError(error);
        log(`[ResponsesSSE] Stream error model=${opts.modelName} reqN=${reqN}: ${detail}`, true);
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }

        try {
          closeOpenBlocks();
          const errorIdx = nextBlockIndex++;
          send("content_block_start", {
            type: "content_block_start",
            index: errorIdx,
            content_block: { type: "text", text: "" },
          });
          send("content_block_delta", {
            type: "content_block_delta",
            index: errorIdx,
            delta: {
              type: "text_delta",
              text: "\n\n[The connection to the model provider was interrupted. This is usually temporary — please retry.]",
            },
          });
          send("content_block_stop", { type: "content_block_stop", index: errorIdx });
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
          send("message_stop", { type: "message_stop" });
        } catch {
          // The downstream may already be gone. Never let finalization throw.
        }

        isClosed = true;
        if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const retryBeforeVisibleContent = async (
        label: string,
        retryBackoff: readonly number[]
      ): Promise<boolean> => {
        if (
          !opts.retryUpstream ||
          retryAttempts >= retryBackoff.length ||
          nextBlockIndex !== 0 ||
          textBlockIndex !== null ||
          functionCalls.size !== 0
        ) {
          return false;
        }

        retryAttempts++;
        const configuredBackoff = opts.retryBackoffMs?.[retryAttempts - 1];
        const backoffMs =
          configuredBackoff ??
          retryBackoff[retryAttempts - 1] + Math.floor(Math.random() * 1_000);
        log(
          `[ResponsesSSE] ${label} before any client-visible block — transparent retry ${retryAttempts}/${retryBackoff.length} in ${backoffMs}ms (reqN=${reqN})`,
          true
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));

        let retryResp: Response | null = null;
        try {
          retryResp = await opts.retryUpstream();
        } catch (retryError) {
          log(
            `[ResponsesSSE] retry fetch failed (reqN=${reqN}): ${classifyStreamReadError(retryError).detail}`
          );
        }
        if (!retryResp?.ok || !retryResp.body) return false;

        try {
          await reader.cancel();
        } catch {
          // old upstream body — best-effort release
        }
        reader = retryResp.body.getReader();
        buffer = "";
        return true;
      };

      send("message_start", {
        type: "message_start",
        message: {
          // Random suffix: Date.now() alone collides for handlers built in the
          // same millisecond (common under the parallel sub-agent bursts).
          id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          type: "message",
          role: "assistant",
          content: [],
          model: opts.modelName,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      send("ping", { type: "ping" });

      pingInterval = setInterval(() => {
        if (!isClosed && Date.now() - lastActivity > 1000) {
          send("ping", { type: "ping" });
        }
      }, 1000);

      try {
        // readLoop: a transparent retry swaps the upstream reader and restarts here.
        readLoop: while (true) {
          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            readResult = await reader.read();
          } catch (readError) {
            const classified = classifyStreamReadError(readError);
            if (
              classified.isSocketClose &&
              (await retryBeforeVisibleContent("socket close", FAST_RETRY_BACKOFF_MS))
            ) {
              continue readLoop;
            }
            finishInterruptedStream(readError);
            return;
          }
          const { done, value } = readResult;
          if (done) break;
          lastActivity = Date.now();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) continue;
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            dataEvents++;
            totalBytes += line.length;
            if (!ttftLogged) {
              ttftLogged = true;
              const firstEventMs = Math.round(performance.now() - tHeaders);
              const hdr = opts.headerLatencyMs ?? -1;
              process.stdout.write(
                `  [ttft] responses model=${opts.modelName} reqN=${reqN} headers=${hdr}ms firstEvent=${firstEventMs}ms total=${hdr >= 0 ? hdr + firstEventMs : -1}ms\n`
              );
            }
            if (data === "[DONE]") continue;

            try {
              const event = JSON.parse(data);

              if (getLogLevel() === "debug" && event.type) {
                log(`[ResponsesSSE] Event: ${event.type}`);
              }

              if (event.type === "response.output_text.delta") {
                if (textBlockIndex === null) {
                  textBlockIndex = nextBlockIndex++;
                  send("content_block_start", {
                    type: "content_block_start",
                    index: textBlockIndex,
                    content_block: { type: "text", text: "" },
                  });
                  hasTextContent = true;
                }
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: textBlockIndex,
                  delta: { type: "text_delta", text: event.delta || "" },
                });
              } else if (event.type === "response.output_item.added") {
                if (event.item?.type === "function_call") {
                  const itemId = event.item.id;
                  const openaiCallId = event.item.call_id || itemId;
                  const callId = openaiCallId.startsWith("toolu_")
                    ? openaiCallId
                    : `toolu_${openaiCallId.replace(/^fc_/, "")}`;
                  const rawFnName = event.item.name || "";
                  const fnName = opts.toolNameMap?.get(rawFnName) || rawFnName;
                  // Close the text block (if open) BEFORE taking the next
                  // index, so text+tools yields 0,1,2,… with no gap and the
                  // text block is stopped exactly once.
                  if (textBlockIndex !== null) {
                    send("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
                    textBlockIndex = null;
                  }
                  const fnIndex = nextBlockIndex++;

                  const fnCallData = {
                    name: fnName,
                    arguments: "",
                    index: fnIndex,
                    claudeId: callId,
                  };

                  functionCalls.set(openaiCallId, fnCallData);
                  if (itemId && itemId !== openaiCallId) {
                    functionCalls.set(itemId, fnCallData);
                  }

                  send("content_block_start", {
                    type: "content_block_start",
                    index: fnIndex,
                    content_block: { type: "tool_use", id: callId, name: fnName, input: {} },
                  });
                  hasToolUse = true;
                }
              } else if (event.type === "response.reasoning_summary_text.delta") {
                if (textBlockIndex === null) {
                  textBlockIndex = nextBlockIndex++;
                  send("content_block_start", {
                    type: "content_block_start",
                    index: textBlockIndex,
                    content_block: { type: "text", text: "" },
                  });
                  hasTextContent = true;
                }
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: textBlockIndex,
                  delta: { type: "text_delta", text: event.delta || "" },
                });
              } else if (event.type === "response.function_call_arguments.delta") {
                const callId = event.call_id || event.item_id;
                const fnCall = functionCalls.get(callId);
                if (fnCall) {
                  fnCall.arguments += event.delta || "";
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: fnCall.index,
                    delta: { type: "input_json_delta", partial_json: event.delta || "" },
                  });
                }
              } else if (event.type === "response.output_item.done") {
                if (event.item?.type === "function_call") {
                  const callId = event.item.call_id || event.item.id;
                  const fnCall = functionCalls.get(callId) || functionCalls.get(event.item.id);
                  if (fnCall && !closedFunctionBlocks.has(fnCall.index)) {
                    send("content_block_stop", { type: "content_block_stop", index: fnCall.index });
                    closedFunctionBlocks.add(fnCall.index);
                  }
                }
              } else if (event.type === "response.incomplete") {
                const reason = event.reason || "unknown";
                incompleteReason = reason;
                log(
                  `[ResponsesSSE] INCOMPLETE model=${opts.modelName} reqN=${reqN} reason=${reason}`,
                  true
                );
                if (event.response?.usage) {
                  inputTokens = event.response.usage.input_tokens || inputTokens;
                  outputTokens = event.response.usage.output_tokens || outputTokens;
                }
              } else if (event.type === "response.completed" || event.type === "response.done") {
                if (event.response?.usage) {
                  inputTokens = event.response.usage.input_tokens || 0;
                  outputTokens = event.response.usage.output_tokens || 0;
                } else if (event.usage) {
                  inputTokens = event.usage.input_tokens || 0;
                  outputTokens = event.usage.output_tokens || 0;
                }
                completed = true;
                const elapsed = Math.round(performance.now() - tHeaders);
                const stop = hasToolUse ? "tool_use" : "end_turn";
                process.stdout.write(
                  `  [resp] responses model=${opts.modelName} reqN=${reqN} events~=${dataEvents} bytes=${totalBytes} closed=true stop=${stop} ${elapsed}ms usage=${inputTokens}+${outputTokens}\n`
                );
              } else if (event.type === "error" || event.type === "response.failed") {
                const err = event.error || event.response?.error || {};
                const errMsg = err.message || event.message || "Unknown API error";
                const errCode = err.code || event.code || "";
                log(
                  `[ResponsesSSE] API error model=${opts.modelName} reqN=${reqN} code=${errCode} msg=${errMsg}`,
                  true
                );

                // Transient upstream failure with nothing client-visible yet:
                // retry transparently. OpenAI server_error arrives 1-54s AFTER
                // the first event (measured 2026-09-02) — far outside the peek
                // window — and every surfaced one kills the agent turn, forcing
                // a manual relaunch that re-uploads the full ~100-190k-token
                // context. Safe ONLY while zero content blocks were emitted
                // (nextBlockIndex === 0, no open text block, no tool calls):
                // past that, a retry would duplicate client-visible content.
                const retryBackoff =
                  errCode === "server_is_overloaded" || errCode === "overloaded_error"
                    ? OVERLOAD_RETRY_BACKOFF_MS
                    : FAST_RETRY_BACKOFF_MS;
                if (
                  RETRYABLE_ERROR_CODES.has(errCode) &&
                  (await retryBeforeVisibleContent(errCode, retryBackoff))
                ) {
                  continue readLoop;
                }

                // A context overflow must not be reported as `usage 0+0`: see
                // parseContextOverflow above — a zero wedges the client's
                // auto-compact and the session never recovers on its own.
                const overflow = parseContextOverflow(errMsg, errCode);
                if (overflow) {
                  if (overflow.used) inputTokens = overflow.used;
                  process.stdout.write(
                    `  [resp] responses CONTEXT-OVERFLOW model=${opts.modelName} reqN=${reqN} used=${overflow.used ?? "?"} limit=${overflow.limit ?? "?"}
`
                  );
                }

                closeOpenBlocks();

                const errorIdx = nextBlockIndex++;
                send("content_block_start", {
                  type: "content_block_start",
                  index: errorIdx,
                  content_block: { type: "text", text: "" },
                });
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: errorIdx,
                  delta: { type: "text_delta", text: `\n\n[API Error: ${errCode} ${errMsg}]` },
                });
                send("content_block_stop", { type: "content_block_stop", index: errorIdx });

                send("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                });
                send("message_stop", { type: "message_stop" });
                isClosed = true;
                if (pingInterval) {
                  clearInterval(pingInterval);
                  pingInterval = null;
                }
                if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
                controller.close();
                return;
              }
            } catch (parseError) {
              log(`[ResponsesSSE] Parse error: ${parseError}`);
            }
          }
        }

        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }

        if (!completed && incompleteReason === null) {
          // Early EOF: OpenAI closed the body WITHOUT a response.completed/done,
          // response.incomplete, or error event. Previously this was silently
          // treated as a normal completion (empty end_turn message) — the
          // "Connection lost mid-response" class the client sees as a killed
          // turn. Inventory it now: success vs. premature end must be visible.
          log(
            `[ResponsesSSE] EOF-WITHOUT-COMPLETION model=${opts.modelName} reqN=${reqN} events=${dataEvents} bytes=${totalBytes} input=${inputTokens} output=${outputTokens} text=${hasTextContent} tools=${hasToolUse}`,
            true
          );
        }

        if (textBlockIndex !== null) {
          send("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
          textBlockIndex = null;
        }

        const stopReason = hasToolUse ? "tool_use" : "end_turn";
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });

        isClosed = true;
        if (opts.onTokenUpdate) opts.onTokenUpdate(inputTokens, outputTokens);
        controller.close();
      } catch (error) {
        finishInterruptedStream(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
