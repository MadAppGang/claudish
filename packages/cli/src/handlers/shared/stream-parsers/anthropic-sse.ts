/**
 * Anthropic SSE passthrough stream parser.
 *
 * For providers that speak native Anthropic format (MiniMax, Kimi, Z.AI),
 * this is a near-identity transform — the response is already in Claude SSE format.
 * Only light fixups are needed (e.g., ensuring message IDs, merging usage data).
 *
 * When `filterThinking` is enabled (via adapter.shouldFilterThinking()), thinking
 * blocks are stripped from the stream and content block indices are re-numbered.
 */

import type { Context } from "hono";
import { log } from "../../../logger.js";
import type { BaseAPIFormat } from "../../../adapters/base-api-format.js";
import { createResponseCapture } from "../response-capture.js";
import { requestNumberFor } from "../../../fork/middleware/request-logger.js";
import { executeWebFetch } from "../web-search-executor.js";
import {
  isPolicyRefusal,
  logPolicyRefusal,
  policyRefusalNotice,
  POLICY_RETRY_BACKOFF_MS,
  type PolicyRetryOpts,
} from "./policy-refusal.js";

/**
 * Backoff ladder for the pre-visible transparent re-forward (#170).
 *
 * Short on purpose. This fires when the upstream died before emitting anything,
 * which on the relay lane means the hub was restarting: a few hundred ms is the
 * difference between "the container is back" and "it is not coming back soon",
 * and a request that has already paid its header latency should not pay seconds
 * more before degrading to the notice it would have got anyway.
 */
const PRE_VISIBLE_REFORWARD_BACKOFF_MS: readonly number[] = [400, 1_200];

/**
 * Bound AND kill switch for the pre-visible re-forward, re-read per stream.
 *
 * `0` disables the behavior entirely, which is the positive control that the
 * gate is real in both directions — a hot-path recovery added to every
 * anthropic-wire lane needs a way to be taken back out without a deploy.
 * Values above the ladder length clamp to it (the ladder is the real bound).
 */
function preVisibleReforwardMax(): number {
  const raw = process.env.CLAUDISH_PREVISIBLE_REFORWARD_MAX;
  if (raw === undefined || raw.trim() === "") return PRE_VISIBLE_REFORWARD_BACKOFF_MS.length;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return PRE_VISIBLE_REFORWARD_BACKOFF_MS.length;
  return Math.min(Math.floor(n), PRE_VISIBLE_REFORWARD_BACKOFF_MS.length);
}

interface AnthropicPassthroughOpts {
  modelName: string;
  onTokenUpdate?: (input: number, output: number) => void;
  /** Optional adapter — used to check shouldFilterThinking(). */
  adapter?: BaseAPIFormat;
  /** dispatch → upstream headers latency, from ComposedHandler (for [ttft]). */
  headerLatencyMs?: number;
  /**
   * When false, no resp-*.sse is written (default true). Used by the relay
   * nominal forward: the hub captures centrally, so the sidecar must not
   * double-capture nor emit an orphan response file.
   */
  capture?: boolean;
  /** invalid_prompt transparent retry (#65) — absent = inert (relay, tests). */
  retryUpstream?: () => Promise<Response | null>;
  retryBackoffMs?: readonly number[];
  /** Provider id for the [PolicyRefusal] counting marker (#65 AC2). */
  providerName?: string;
}

/**
 * Pass through an Anthropic-format SSE stream with minimal fixups.
 * The response body is already Claude-compatible SSE events.
 *
 * When adapter.shouldFilterThinking() returns true, thinking blocks are
 * stripped and content block indices are re-numbered so downstream consumers
 * see a contiguous sequence (0, 1, 2, ...).
 */
export function createAnthropicPassthroughStream(
  c: Context,
  response: Response,
  opts: AnthropicPassthroughOpts
): Response {
  const encoder = new TextEncoder();
  // `let`: re-created on a policy-refusal reader swap — a TextDecoder keeps
  // partial multi-byte state across decode(stream:true) calls, and bytes from
  // the OLD stream must not leak into the first chunk of the new one.
  let decoder = new TextDecoder();
  let isClosed = false;
  let lastActivity = Date.now();
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  // TTFT anchors — headers arrived when this stream was built; the first
  // upstream `data:` line completes the measurement (see the marker below).
  // reqN resolved from the request object (assigned at ingestion) — the
  // global counter read here would return whichever request is current while
  // this one waited for headers.
  const tHeaders = performance.now();
  const reqN = requestNumberFor(c.req);
  let ttftLogged = false;

  const filterThinking = opts.adapter?.shouldFilterThinking() ?? false;

  const cap = createResponseCapture("anthropic", opts.modelName, opts.capture !== false, reqN);

  return c.body(
    new ReadableStream({
      async start(controller) {
        // Diagnostic tap: mirror every outgoing byte into the response capture.
        const _origEnqueue = controller.enqueue.bind(controller);
        controller.enqueue = ((chunk: any) => {
          cap.tap(chunk);
          return _origEnqueue(chunk);
        }) as typeof controller.enqueue;
        const sendPing = () => {
          if (!isClosed) {
            controller.enqueue(encoder.encode("event: ping\ndata: {\"type\":\"ping\"}\n\n"));
          }
        };

        // ── Event-line withholding (S4-a, upstream c9e97c9 + b48042c) ──────
        // An SSE frame is `event: X\ndata: {...}\n\n` and the event line
        // arrives FIRST. Any filter that drops a data line must therefore drop
        // the event line that introduced it, or the client receives an event
        // with no data — Claude Code dies on that shape with `Could not parse
        // message into JSON`. The verdict isn't known until the data line is
        // read, so the event line is buffered for exactly one line. Held on
        // BOTH paths: every drop site below (thinking suppression, server
        // tool suppression, orphan frames) lives on one path or the other.
        let pendingEventLine: string | null = null;
        /** A frame was just dropped — swallow its trailing blank separator too. */
        let suppressedFrame = false;
        const flushPendingEvent = () => {
          if (pendingEventLine !== null && !isClosed) {
            controller.enqueue(encoder.encode(pendingEventLine + "\n"));
          }
          pendingEventLine = null;
        };
        /** Emit a data line (flushing its held `event:` line first, in order). */
        const emitDataLine = (text: string) => {
          flushPendingEvent();
          if (!isClosed) {
            controller.enqueue(encoder.encode(text + "\n"));
          }
        };
        /** Mark the current frame as dropped: header and blank separator go too. */
        const dropFrame = () => {
          pendingEventLine = null;
          suppressedFrame = true;
        };

        sendPing();

        pingInterval = setInterval(() => {
          if (!isClosed && Date.now() - lastActivity > 1000) {
            sendPing();
          }
        }, 1000);

        // ── Shared content-block index tracking state ──────────────────
        // DECLARED HERE (in start() scope, not inside the inner try block) so that
        // handleServerToolResult's closure and the read loop share the SAME binding.
        // Previously highestSeenIndex was declared inside the inner try{} block while
        // handleServerToolResult (which writes it at line ~109) lived in the outer scope —
        // two different block scopes → ReferenceError: highestSeenIndex is not defined
        // whenever a real server_tool_use block fired the handler, crashing the proxy
        // (observed live: po-2025 "Content block not found" freeze).
        let highestSeenIndex = -1;
        let lastBlockOpen = false;
        const clampIndex = (idx: number, context: string): number => {
          if (idx > highestSeenIndex + 1) {
            log(
              `[AnthropicSSE] Index jump detected: ${idx} but expected <=${highestSeenIndex + 1} (${context}) — clamping to ${highestSeenIndex + 1}`
            );
            return highestSeenIndex + 1;
          }
          return idx;
        };
        // Upstream→emitted index mapping for the block currently open.
        // clampIndex only corrects UPWARD jumps (idx > highest+1). When a
        // content_block_start is remapped DOWNWARD — which is what suppressing a
        // block does to every block after it — the following deltas/stop still
        // carry the upstream index, clampIndex sees nothing out of range, and the
        // client gets deltas addressed to a block that was opened under a
        // different index ("Content block not found"). Latent until two blocks
        // were suppressed in one stream, which is exactly what Z.AI does
        // (server_tool_use + tool_result). Remembering the pair fixes it for any
        // number of suppressions.
        let openBlockUpstreamIndex: number | null = null;
        let openBlockEmittedIndex: number | null = null;
        const trackIndex = (idx: number) => {
          if (idx > highestSeenIndex) highestSeenIndex = idx;
        };

        // Execute a suppressed server_tool_use (webReader) and inject the result
        // as a text block. Non-blocking — errors degrade to a short notice.
        const handleServerToolResult = async (
          toolName: string,
          rawInput: string,
          currentHighestIdx: number,
        ) => {
          const textIdx = currentHighestIdx + 1;
          let resultText: string;
          try {
            const input = JSON.parse(rawInput || "{}");
            const url = input.url;
            if (url && (toolName === "webReader" || toolName === "web_search_preview")) {
              log(`[AnthropicSSE] Executing suppressed server_tool_use webReader for ${url}`);
              const result = await executeWebFetch(url);
              resultText = result.ok
                ? result.text
                : `[Web fetch for ${url} failed: ${result.error}]`;
            } else {
              resultText = `[Server tool "${toolName}" was executed by the provider (result not available locally).]`;
            }
          } catch {
            resultText = `[Server tool "${toolName}" was executed by the provider (result not available locally).]`;
          }
          // Truncate very long results to avoid blowing up the context
          if (resultText.length > 8000) {
            resultText = resultText.slice(0, 8000) + "\n[...truncated]";
          }
          if (!isClosed) {
            controller.enqueue(encoder.encode(
              `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: textIdx, content_block: { type: "text", text: "" } })}\n\n`
            ));
            controller.enqueue(encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: textIdx, delta: { type: "text_delta", text: resultText } })}\n\n`
            ));
            controller.enqueue(encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: textIdx })}\n\n`
            ));
            highestSeenIndex = textIdx;
          }
        };

        try {
          let reader = response.body!.getReader();
          let buffer = "";
          let inputTokens = 0;
          let outputTokens = 0;

          // invalid_prompt-class transparent retry state (#65): only while
          // NOTHING client-visible has been forwarded (no message_start —
          // unlike the responses lane it comes from upstream here, so a retry
          // after it would duplicate message_start and break the client).
          let policyRetryAttempts = 0;
          const policyRetryBackoff = opts.retryBackoffMs ?? POLICY_RETRY_BACKOFF_MS;

          let totalLines = 0;
          let textChunks = 0;
          let toolUseBlocks = 0;
          let stopReason: string | null = null;
          let sawMessageStop = false;
          let sawMessageStart = false;

          // Thinking-block filtering state
          let insideThinkingBlock = false;
          /** How many thinking blocks have been suppressed so far. */
          let thinkingBlocksSuppressed = 0;

          // server_tool_use suppression state.
          // Z.AI built-in tools (webReader, web_search) emit server_tool_use blocks
          // that Claude Code doesn't support — "Unsupported content type: server_tool_use"
          // followed by "Content block not found" (index desync). Suppress them and
          // execute web fetches ourselves, injecting results as text blocks.
          let insideServerToolBlock = false;
          let serverToolName = "";
          let serverToolInput = "";
          let serverToolsSuppressed = 0;

          // tool_result suppression state.
          // Live capture (2026-08-11, api.z.ai /api/anthropic/v1/messages, glm-5.2):
          // Z.AI does not stop at server_tool_use — it runs the tool server-side and
          // streams the OUTCOME back as an assistant-side `tool_result` content block:
          //   idx1 server_tool_use(web_search_prime) → idx3 tool_result(tool_use_id, content)
          // In the Anthropic wire format `tool_result` is a USER-turn block; an
          // assistant one is off-spec, so it reaches Claude Code as the very same
          // "Unsupported content type" failure the server_tool_use suppression above
          // exists to prevent. Suppress the whole block lifecycle for the same reason.
          let insideToolResultBlock = false;
          let toolResultsSuppressed = 0;

          // (highestSeenIndex / lastBlockOpen / clampIndex / trackIndex declared
          //  earlier in start() scope — shared with handleServerToolResult's closure.)

          // ── Graceful in-stream error finalization ─────────────────────
          // Some anthropic-compat providers (Z.AI, MiniMax, Kimi) return HTTP 200
          // and then inject an SSE error (e.g. Z.AI's [1302] rate limit) with NO
          // valid message envelope. Forwarding a bare `event: error` makes Claude
          // Code report "empty or malformed response (HTTP 200)" and crash the turn.
          // Instead we ALWAYS emit a valid, terminal Claude message so the client
          // ends the turn cleanly (no crash, no corruption):
          //   - before any content → synthetic message_start + short notice + stop
          //   - mid-stream         → close the open block + message_delta + stop
          // ComposedHandler's peek/retry catches most start-of-stream rate limits
          // before they reach here (it retries + falls back to a second provider);
          // this is the last-resort safety net for whatever still slips through.
          const finalizeWithError = (errMsg: string, path: string, noticeOverride?: string) => {
            if (!isClosed) {
              if (!sawMessageStart) {
                const isRateLimit =
                  /rate.?limit|\b1302\b|\b429\b|too many requests|overloaded/i.test(errMsg);
                const notice =
                  noticeOverride ??
                  (isRateLimit
                    ? "[The model provider is rate limited right now. The proxy retried and exhausted fallback capacity — please try again in a moment.]"
                    : `[Upstream provider error: ${errMsg}]`);
                const synthId = `msg_${Date.now()}`;
                // Frames built with JSON.stringify, never string interpolation
                // (S4-a, upstream 5934fec): custom endpoints allow arbitrary
                // model names, and one quote or backslash in a hand-built
                // literal produces JSON the client cannot parse — turning a
                // recoverable truncation into a hard failure.
                controller.enqueue(
                  encoder.encode(
                    "event: message_start\ndata: " +
                      JSON.stringify({
                        type: "message_start",
                        message: {
                          id: synthId,
                          type: "message",
                          role: "assistant",
                          model: opts.modelName,
                          content: [],
                          stop_reason: null,
                          stop_sequence: null,
                          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                        },
                      }) +
                      "\n\n"
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    "event: content_block_start\ndata: " +
                      JSON.stringify({
                        type: "content_block_start",
                        index: 0,
                        content_block: { type: "text", text: "" },
                      }) +
                      "\n\n"
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    "event: content_block_delta\ndata: " +
                      JSON.stringify({
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "text_delta", text: notice },
                      }) +
                      "\n\n"
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    "event: content_block_stop\ndata: " +
                      JSON.stringify({ type: "content_block_stop", index: 0 }) +
                      "\n\n"
                  )
                );
              } else {
                // Mid-stream: close whatever content block was open when the error hit,
                // otherwise the client sees an unterminated block.
                // Only emit if the block is actually still open — if the provider
                // already sent a content_block_stop, a duplicate would cause
                // "Content block not found" on the client.
                if (highestSeenIndex >= 0 && lastBlockOpen) {
                  controller.enqueue(
                    encoder.encode(
                      "event: content_block_stop\ndata: " +
                        JSON.stringify({ type: "content_block_stop", index: highestSeenIndex }) +
                        "\n\n"
                    )
                  );
                }
                // A policy-refusal notice (#65) must reach the agent even
                // mid-stream: the labeled text is the only signal of WHAT was
                // refused, so the agent can adapt instead of guessing.
                if (noticeOverride) {
                  const noticeIdx = highestSeenIndex + 1;
                  controller.enqueue(
                    encoder.encode(
                      "event: content_block_start\ndata: " +
                        JSON.stringify({
                          type: "content_block_start",
                          index: noticeIdx,
                          content_block: { type: "text", text: "" },
                        }) +
                        "\n\n"
                    )
                  );
                  controller.enqueue(
                    encoder.encode(
                      "event: content_block_delta\ndata: " +
                        JSON.stringify({
                          type: "content_block_delta",
                          index: noticeIdx,
                          delta: { type: "text_delta", text: noticeOverride },
                        }) +
                        "\n\n"
                    )
                  );
                  controller.enqueue(
                    encoder.encode(
                      "event: content_block_stop\ndata: " +
                        JSON.stringify({ type: "content_block_stop", index: noticeIdx }) +
                        "\n\n"
                    )
                  );
                  highestSeenIndex = noticeIdx;
                }
              }
              // Upstream already closed the message — never emit a second
              // terminal pair (S4-a, upstream 5934fec): a socket that dies
              // AFTER message_stop (trailing-byte read error) must not append
              // a duplicate message_delta + message_stop on top of a complete
              // turn.
              if (!sawMessageStop) {
                // stop_reason is the value upstream actually reported, falling
                // back to end_turn — a turn that lost only its terminal frames
                // may still have delivered a complete tool_use block, and a
                // hardcoded end_turn there makes the client discard the tool
                // call.
                const tailStop = stopReason ?? "end_turn";
                controller.enqueue(
                  encoder.encode(
                    "event: message_delta\ndata: " +
                      JSON.stringify({
                        type: "message_delta",
                        delta: { stop_reason: tailStop, stop_sequence: null },
                        usage: { output_tokens: outputTokens },
                      }) +
                      "\n\n"
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    "event: message_stop\ndata: " +
                      JSON.stringify({ type: "message_stop" }) +
                      "\n\n"
                  )
                );
              }
            }
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            cap.note(`in-stream-error->graceful: ${errMsg.slice(0, 80)}`);
            cap.done({ closed: true, stop_reason: "error-graceful", path });
            // Surface to stdout (visible without --debug) so a mid-stream burst
            // that bypassed the start-of-stream peek is still observable live.
            log(
              `[RateLimit] safety-net finalized stream gracefully (${path}): ${errMsg.slice(0, 120)}`,
              true
            );
            try {
              controller.close();
            } catch {
              // already closed
            }
          };

          // ── In-stream error dispatch (#65) ──────────────────────────────
          // Shared by the filterThinking and passthrough detection sites.
          // Policy-class refusals get the arbitrated treatment: bounded
          // transparent retry of the identical body (the flag is probabilistic
          // — 2026-09-10 datapoint), then a labeled terminal turn if
          // persistent. Every other in-stream error keeps its pre-existing
          // behavior (generic graceful finalization).
          const handleInStreamError = async (
            errObj: any,
            path: string
          ): Promise<"retried" | "surfaced"> => {
            const errCode = typeof errObj?.code === "string" ? errObj.code : "";
            const errMsg = errObj?.message || JSON.stringify(errObj);
            if (isPolicyRefusal(errCode, errMsg)) {
              const nothingVisible =
                !sawMessageStart && highestSeenIndex === -1 && !lastBlockOpen;
              const canRetry =
                !!opts.retryUpstream &&
                policyRetryAttempts < policyRetryBackoff.length &&
                nothingVisible;
              logPolicyRefusal({
                lane: "anthropic",
                model: opts.modelName,
                provider: opts.providerName,
                attempt: policyRetryAttempts + 1,
                action: canRetry ? "retry" : "surface",
              });
              if (canRetry) {
                policyRetryAttempts++;
                const backoffMs =
                  policyRetryBackoff[policyRetryAttempts - 1] +
                  Math.floor(Math.random() * 1_000);
                log(
                  `[AnthropicSSE] invalid_prompt before any client-visible event — transparent retry ${policyRetryAttempts}/${policyRetryBackoff.length} in ${backoffMs}ms (reqN=${reqN})`,
                  true
                );
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                let retryResp: Response | null = null;
                try {
                  retryResp = await opts.retryUpstream!();
                } catch {
                  // retry fetch failed — fall through to surface
                }
                if (retryResp?.ok && retryResp.body) {
                  try {
                    await reader.cancel();
                  } catch {
                    // old upstream body — best-effort release
                  }
                  reader = retryResp.body.getReader();
                  buffer = "";
                  decoder = new TextDecoder();
                  return "retried";
                }
              }
              log(`[AnthropicSSE] In-stream error detected: ${errMsg}`);
              finalizeWithError(errMsg, path, policyRefusalNotice(errMsg));
              return "surfaced";
            }
            log(`[AnthropicSSE] In-stream error detected: ${errMsg}`);
            finalizeWithError(errMsg, path);
            return "surfaced";
          };

          // ── Pre-visible upstream death → bounded re-forward (#170) ──────
          // An upstream that dies AFTER the response headers but BEFORE a single
          // client-visible event costs the agent a whole turn. finalizeWithError
          // below ends that turn cleanly — the never-hang invariant holds — but it
          // ends it with a notice instead of an answer, and nothing was forwarded
          // that would prevent re-issuing the request. The gate for recovering it
          // already exists above, for policy refusals (#65): while nothing is
          // client-visible the upstream is re-issuable without duplicating a
          // message_start the client has already seen. The read path never used it.
          //
          // Measured cause, 2026-09-20 (po-2025, the hub's host): 13 container
          // restarts in one morning, an attempted remediation for a Docker Desktop
          // localhost-forwarder wedge that container restarts cannot fix (#168).
          // Each one cut every in-flight SSE on every relaying machine, at 9-13
          // activeStreams. The restart is the fleet's dominant turn-killer, and the
          // subset of cut streams that had not yet emitted is recoverable for the
          // cost of one re-forward.
          //
          // Deliberately narrower than "retry on error": only while nothing is
          // client-visible, only with a caller-supplied closure, and bounded by its
          // OWN counter — independent of policyRetryAttempts, so the two can compose
          // without either becoming unbounded. When the upstream is genuinely down
          // the re-forward fails in milliseconds and the stream finalizes exactly as
          // it did before. The closure is expected to arrive already wrapped in
          // boundRetryUpstream(): the replacement stream needs its own first-event
          // watchdog, and on the relay lane there is no outer wrap to inherit.
          let preVisibleReforwards = 0;
          const preVisibleReforwardBound = preVisibleReforwardMax();
          const tryPreVisibleReforward = async (reason: string): Promise<boolean> => {
            if (!opts.retryUpstream) return false;
            if (preVisibleReforwards >= preVisibleReforwardBound) return false;
            // Same predicate as the policy-refusal gate: past any of these three a
            // replacement stream would duplicate what the client already holds.
            if (sawMessageStart || highestSeenIndex !== -1 || lastBlockOpen) return false;
            const backoffMs = PRE_VISIBLE_REFORWARD_BACKOFF_MS[preVisibleReforwards];
            preVisibleReforwards++;
            log(
              `[AnthropicSSE] upstream died before any client-visible event (${reason}) — ` +
                `transparent re-forward ${preVisibleReforwards}/${preVisibleReforwardBound} ` +
                `in ${backoffMs}ms (model=${opts.modelName} reqN=${reqN})`,
              true
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            let resp: Response | null = null;
            try {
              resp = await opts.retryUpstream();
            } catch {
              return false; // re-forward itself failed → surface the original death
            }
            if (!resp?.ok || !resp.body) return false;
            try {
              await reader.cancel();
            } catch {
              // old upstream body — best-effort release
            }
            reader = resp.body.getReader();
            buffer = "";
            // A TextDecoder keeps partial multi-byte state across decode(stream:true);
            // bytes from the dead stream must not leak into the replacement's first chunk.
            decoder = new TextDecoder();
            return true;
          };

          // Wrap the read loop so a mid-stream upstream socket close (Z.AI / GLM
          // Coding connection reset) is caught HERE — where finalizeWithError is
          // in scope — instead of escaping to the outer catch which can only do a
          // bare controller.close() with NO terminal message_stop. Without that
          // terminal event, Claude Code reports "socket connection was closed
          // unexpectedly" and freezes the turn. See never-hang-priority.
          try {
          // A transparent policy-refusal retry swaps the upstream reader and
          // restarts the read here.
          readLoop: while (true) {
            let chunk: Awaited<ReturnType<typeof reader.read>>;
            try {
              chunk = await reader.read();
            } catch (readFail) {
              // A socket reset with nothing forwarded yet is recoverable (#170).
              // Otherwise rethrow so the graceful finalization below runs unchanged.
              if (await tryPreVisibleReforward(`read error: ${String(readFail).slice(0, 80)}`)) {
                continue readLoop;
              }
              throw readFail;
            }
            if (chunk.done) {
              // A graceful close having emitted nothing is the SAME lost turn as a
              // reset — `docker stop` on the upstream produces exactly this shape —
              // so it gets the same recovery. A stream that emitted anything fails
              // the gate and falls straight through to normal end-of-stream handling.
              if (await tryPreVisibleReforward("upstream closed with no event")) {
                continue readLoop;
              }
              break;
            }
            const value = chunk.value;
            buffer += decoder.decode(value, { stream: true });
            lastActivity = Date.now();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (let line of lines) {
              totalLines++;

              // ── SSE data-prefix normalization ─────────────────────────
              // Anthropic's canonical wire format (and what every check below
              // expects) is `data: {...}` with exactly one space after the colon.
              // Some anthropic-compat providers emit `data:{...}` with NO space
              // (Qwen Cloud Token Plan / Alibaba MaaS). Without normalization,
              // every `startsWith("data: ")` check silently fails: no data line
              // is ever parsed, sawMessageStop stays false, and finalizeWithError
              // injects a spurious "[empty response]" error after the valid
              // stream completes. The HTML5 SSE spec allows either form (one
              // optional leading space is trimmed from the field value), so this
              // normalization is spec-compliant. See qwen-deepseek-onboarding.
              if (line.startsWith("data:") && !line.startsWith("data: ")) {
                line = "data: " + line.slice(5);
              }

              // TTFT marker on the first upstream event — stdout like [resp] so
              // the two join in docker logs (2026-08-24 instrumentation gap:
              // totals were logged, first-token timing never was).
              if (!ttftLogged && line.startsWith("data: ")) {
                ttftLogged = true;
                const firstEventMs = Math.round(performance.now() - tHeaders);
                const hdr = opts.headerLatencyMs ?? -1;
                process.stdout.write(
                  `  [ttft] anthropic model=${opts.modelName} reqN=${reqN} headers=${hdr}ms firstEvent=${firstEventMs}ms total=${hdr >= 0 ? hdr + firstEventMs : -1}ms\n`
                );
              }

              // ── Thinking-block filtering ──────────────────────────────
              if (filterThinking && line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));

                  // ── In-stream error detection (GitHub #106) ──
                  // Some anthropic-compat providers (Z.AI, MiniMax, Kimi) return
                  // HTTP 200 with {"error":{...}} embedded in the SSE payload.
                  // Detect and surface as a proper error event.
                  if (data.error) {
                    dropFrame();
                    if (
                      (await handleInStreamError(data.error, "in-stream-error-filtered")) ===
                      "retried"
                    ) {
                      continue readLoop;
                    }
                    return; // stop processing further lines
                  }

                  // Track: entering a thinking block
                  if (
                    data.type === "content_block_start" &&
                    data.content_block?.type === "thinking"
                  ) {
                    insideThinkingBlock = true;
                    thinkingBlocksSuppressed++;
                    // Thinking blocks are suppressed — don't count them as open.
                    log(`[AnthropicSSE] Filtering thinking block at index ${data.index}`);
                    dropFrame();
                    continue; // suppress this line
                  }

                  // Track: exiting a thinking block
                  if (insideThinkingBlock && data.type === "content_block_stop") {
                    insideThinkingBlock = false;
                    dropFrame();
                    continue; // suppress this line
                  }

                  // Suppress all deltas while inside a thinking block
                  // (thinking_delta, signature_delta)
                  if (insideThinkingBlock) {
                    dropFrame();
                    continue;
                  }

                  // Re-index content blocks through the same pair-remap layer
                  // the passthrough branch uses (S4-a, upstream b48042c — which
                  // generalizes our own #127 repair). Suppressed blocks never
                  // call trackIndex, so the next real start lands on the slot
                  // the suppressed block would have taken: the renumbering
                  // falls out of highestSeenIndex instead of a subtraction
                  // counter. Jumped starts (z.ai 0 → 2) are remapped to the
                  // next sequential slot with the pair remembered so the
                  // block's own deltas and stop follow it. An orphan frame —
                  // no remap entry and no block the client opened at that
                  // index, e.g. MiniMax-M3's implicit signature block
                  // (signature_delta + stop at 0 with NO content_block_start;
                  // 7 production captures 2026-07-19 → 08-06) — is dropped
                  // whole: re-attaching it to another block would corrupt that
                  // block's content, and forwarding it kills the client turn
                  // with "Content block not found".
                  if (typeof data.index === "number") {
                    if (data.type === "content_block_start") {
                      lastBlockOpen = true;
                      const expected = highestSeenIndex + 1;
                      openBlockUpstreamIndex = data.index;
                      openBlockEmittedIndex = expected;
                      trackIndex(expected);
                      if (data.index !== expected) {
                        log(
                          `[AnthropicSSE] content_block_start index ${data.index} remapped to ${expected} (filtered, model=${opts.modelName})`
                        );
                        emitDataLine("data: " + JSON.stringify({ ...data, index: expected }));
                      } else {
                        emitDataLine(line);
                      }
                    } else {
                      if (data.type === "content_block_stop") lastBlockOpen = false;
                      const followed =
                        openBlockUpstreamIndex !== null && data.index === openBlockUpstreamIndex
                          ? openBlockEmittedIndex!
                          : data.index;
                      if (data.type === "content_block_stop") {
                        openBlockUpstreamIndex = null;
                        openBlockEmittedIndex = null;
                      }
                      if (followed === data.index && followed > highestSeenIndex) {
                        log(
                          `[AnthropicSSE] Dropping orphan ${data.type} at index ${data.index} on the filtered path (no open block, model=${opts.modelName})`
                        );
                        dropFrame();
                        continue;
                      }
                      const finalIdx = clampIndex(followed, `${data.type} (filtered)`);
                      const payload =
                        finalIdx === data.index
                          ? line
                          : "data: " + JSON.stringify({ ...data, index: finalIdx });
                      emitDataLine(payload);
                    }
                  } else {
                    emitDataLine(line);
                  }
                } catch {
                  // Unparseable — pass through
                  emitDataLine(line);
                }
              } else {
                // Non-data lines (event: lines, blank lines) or no filtering
                if (!filterThinking && line.startsWith("data: ")) {
                  // Parse data lines BEFORE enqueuing to detect in-stream errors
                  try {
                    const data = JSON.parse(line.slice(6));

                    // ── In-stream error detection (GitHub #106) ──
                    if (data.error) {
                      dropFrame();
                      if (
                        (await handleInStreamError(data.error, "in-stream-error")) === "retried"
                      ) {
                        continue readLoop;
                      }
                      return; // stop processing further lines
                    }

                    // ── server_tool_use suppression ──────────────────────────────
                    // MUST run BEFORE the index-remap/passthrough logic below.
                    // Z.AI built-in tools (webReader, web_search_preview) emit
                    // server_tool_use blocks that Claude Code doesn't understand:
                    //   "Unsupported content type: server_tool_use" + "Content block not found"
                    // We suppress the entire block lifecycle (start → deltas → stop),
                    // execute web fetches ourselves, and inject results as text.
                    // (Ordering matters: without this guard first, the start event
                    //  would already be enqueued by the passthrough below before the
                    //  suppression flag is set — leaking the unsupported block type.)
                    if (
                      data.type === "content_block_start" &&
                      data.content_block?.type === "server_tool_use"
                    ) {
                      insideServerToolBlock = true;
                      serverToolName = data.content_block.name || "(unnamed)";
                      // Z.AI delivers the COMPLETE input object inside
                      // content_block_start and then emits zero deltas (live
                      // capture 2026-08-11: start → stop, no input_json_delta).
                      // Seeding from it is what makes the input visible at all;
                      // accumulating deltas alone left rawInput = "" on every
                      // real stream, so even a genuine webReader silently
                      // degraded to the "not available locally" notice instead
                      // of being fetched. Deltas still append below for
                      // providers that stream the input incrementally.
                      serverToolInput =
                        data.content_block.input && typeof data.content_block.input === "object"
                          ? JSON.stringify(data.content_block.input)
                          : "";
                      serverToolsSuppressed++;
                      dropFrame();
                      log(`[AnthropicSSE] Suppressing server_tool_use block at index ${data.index}: ${serverToolName}`);
                      continue; // drop this start event
                    }
                    if (insideServerToolBlock) {
                      // Accumulate input_json_delta inside the suppressed block
                      if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
                        serverToolInput += data.delta.partial_json || "";
                      }
                      // On stop: block is complete — execute and inject result
                      if (data.type === "content_block_stop") {
                        insideServerToolBlock = false;
                        log(`[AnthropicSSE] server_tool_use "${serverToolName}" complete, input=${serverToolInput.length} chars`);
                        // Fire-and-forget: execute the web fetch and inject as text
                        handleServerToolResult(serverToolName, serverToolInput, highestSeenIndex);
                        serverToolName = "";
                        serverToolInput = "";
                      }
                      dropFrame();
                      continue; // drop all events inside the suppressed block
                    }

                    // ── tool_result suppression ──────────────────────────────────
                    // Same guard, same reason, sibling block: Z.AI streams the
                    // server-side tool OUTCOME as an assistant `tool_result` block
                    // right after the server_tool_use it suppressed above. That block
                    // type is USER-turn-only in the Anthropic wire format, so it hits
                    // Claude Code as "Unsupported content type" exactly like its
                    // sibling did. Nothing is lost by dropping it: Z.AI also emits the
                    // same results as a plain text block ("**Output:** …") immediately
                    // before it, and authors its final answer from them afterwards.
                    // Must run BEFORE the passthrough below, for the ordering reason
                    // spelled out above.
                    if (
                      data.type === "content_block_start" &&
                      data.content_block?.type === "tool_result"
                    ) {
                      insideToolResultBlock = true;
                      toolResultsSuppressed++;
                      dropFrame();
                      log(`[AnthropicSSE] Suppressing tool_result block at index ${data.index} (tool_use_id=${data.content_block.tool_use_id ?? "?"})`);
                      continue; // drop this start event
                    }
                    if (insideToolResultBlock) {
                      if (data.type === "content_block_stop") insideToolResultBlock = false;
                      dropFrame();
                      continue; // drop all events inside the suppressed block
                    }

                    // No error — check index bounds before passing through
                    if (typeof data.index === "number") {
                      if (data.type === "content_block_start") {
                        lastBlockOpen = true;
                        // z.ai sometimes sends content_block_start with an index
                        // that jumps (e.g., 0 → 2, skipping 1). This causes
                        // "Content block not found" on the client. Remap to
                        // sequential indices to keep the client happy.
                        const expected = highestSeenIndex + 1;
                        // Remember the pair so this block's deltas/stop follow it.
                        openBlockUpstreamIndex = data.index;
                        openBlockEmittedIndex = expected;
                        if (data.index !== expected) {
                          log(
                            `[AnthropicSSE] content_block_start index ${data.index} remapped to ${expected} (model=${opts.modelName})`
                          );
                          const remapped = { ...data, index: expected };
                          emitDataLine("data: " + JSON.stringify(remapped));
                        } else {
                          emitDataLine(line);
                        }
                        trackIndex(expected);
                      } else {
                        // delta / stop — follow the open block's remap, else clamp
                        if (data.type === "content_block_stop") lastBlockOpen = false;
                        const followed =
                          openBlockUpstreamIndex !== null && data.index === openBlockUpstreamIndex
                            ? openBlockEmittedIndex!
                            : data.index;
                        if (followed !== data.index) {
                          log(
                            `[AnthropicSSE] ${data.type} index ${data.index} follows remapped block → ${followed}`
                          );
                        }
                        if (data.type === "content_block_stop") {
                          openBlockUpstreamIndex = null;
                          openBlockEmittedIndex = null;
                        }
                        // Orphan frame (S4-a, upstream b48042c): no remap entry
                        // and no block the client opened at this index. Dropped
                        // whole — clamping it onto another block would corrupt
                        // that block's content, and forwarding it produces the
                        // very "Content block not found" this layer prevents.
                        if (followed === data.index && followed > highestSeenIndex) {
                          log(
                            `[AnthropicSSE] Dropping orphan ${data.type} at index ${data.index} (no open block, model=${opts.modelName})`
                          );
                          dropFrame();
                          continue;
                        }
                        const finalIdx = clampIndex(followed, `${data.type} (passthrough)`);
                        // Re-serialize only when the index actually moved; an
                        // untouched line is forwarded byte-for-byte as before.
                        const payload =
                          finalIdx === data.index
                            ? line
                            : "data: " + JSON.stringify({ ...data, index: finalIdx });
                        emitDataLine(payload);
                      }
                    } else {
                      // No index field — pass through as-is
                      emitDataLine(line);
                    }

                    // Usage/debug tracking
                    if (data.message?.usage) {
                      inputTokens = data.message.usage.input_tokens || inputTokens;
                      outputTokens = data.message.usage.output_tokens || outputTokens;
                    }
                    if (data.usage) {
                      inputTokens = data.usage.input_tokens || inputTokens;
                      outputTokens = data.usage.output_tokens || outputTokens;
                    }
                    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                      const txt = data.delta.text || "";
                      textChunks++;
                      log(
                        `[AnthropicSSE] Text chunk: "${txt.substring(0, 30).replace(/\n/g, "\\n")}" (${txt.length} chars)`
                      );
                    }
                    if (
                      data.type === "content_block_start" &&
                      data.content_block?.type === "tool_use"
                    ) {
                      toolUseBlocks++;
                      log(`[AnthropicSSE] Tool use: ${data.content_block.name}`);
                    }
                    if (data.type === "message_start") {
                      sawMessageStart = true;
                    }
                    if (data.type === "message_delta" && data.delta?.stop_reason) {
                      stopReason = data.delta.stop_reason;
                    }
                    if (data.type === "message_stop") {
                      sawMessageStop = true;
                    }
                  } catch {
                    // Unparseable data line — pass through
                    emitDataLine(line);
                  }
                } else {
                  // Non-data lines (event: lines, blank lines).
                  // An `event:` line is HELD until its `data:` line is
                  // adjudicated (see the withholding block at the top of
                  // start()): if the data line is dropped, the header goes with
                  // it instead of reaching the client as an event with no body,
                  // which Claude Code rejects outright. The blank separator of
                  // a dropped frame is swallowed for the same reason.
                  if (line.trimStart().startsWith("event: error")) {
                    // A bare `event: error` header never forwards: the matching
                    // `data:` payload that follows triggers finalizeWithError().
                    // Forwarding it verbatim is itself what makes Claude Code
                    // report "empty or malformed response (HTTP 200)", and it
                    // produced the double `event: error` seen in production
                    // captures.
                    pendingEventLine = null;
                    continue;
                  }
                  if (line.startsWith("event:")) {
                    pendingEventLine = line;
                    continue;
                  }
                  if (line.trim() === "" && suppressedFrame) {
                    suppressedFrame = false;
                    continue;
                  }
                  if (!isClosed) {
                    controller.enqueue(encoder.encode(line + "\n"));
                  }
                }
              }

              // ── Usage/debug tracking for filtered path ────────────────
              // We need this even when filtering, but the data was already parsed
              // above in the filterThinking branch. Re-parse for tracking only.
              if (filterThinking && line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.message?.usage) {
                    inputTokens = data.message.usage.input_tokens || inputTokens;
                    outputTokens = data.message.usage.output_tokens || outputTokens;
                  }
                  if (data.usage) {
                    inputTokens = data.usage.input_tokens || inputTokens;
                    outputTokens = data.usage.output_tokens || outputTokens;
                  }
                  if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                    textChunks++;
                  }
                  if (
                    data.type === "content_block_start" &&
                    data.content_block?.type === "tool_use"
                  ) {
                    toolUseBlocks++;
                    log(`[AnthropicSSE] Tool use: ${data.content_block.name}`);
                  }
                  if (data.type === "message_delta" && data.delta?.stop_reason) {
                    stopReason = data.delta.stop_reason;
                  }
                  if (data.type === "message_start") {
                    sawMessageStart = true;
                  }
                  if (data.type === "message_stop") {
                    sawMessageStop = true;
                  }
                } catch {}
              }
            }
          }
          } catch (readErr) {
            // Upstream socket closed mid-stream (Z.AI / GLM Coding connection
            // reset). finalizeWithError() emits the terminal message_stop so the
            // client ends the turn cleanly instead of freezing. In scope here
            // because finalizeWithError is declared above in the same outer try.
            log(
              `[AnthropicSSE] Upstream read error for ${opts.modelName}: ${String(readErr).slice(0, 200)} — finalizing gracefully`,
              true
            );
            // The turn's tokens must reach the token file even on an abandoned
            // stream (S4-a, upstream 5934fec): returning early past
            // onTokenUpdate would trade the hang for a quieter leak.
            if (opts.onTokenUpdate) {
              opts.onTokenUpdate(inputTokens, outputTokens);
            }
            finalizeWithError(`upstream read error: ${String(readErr)}`, "reader-exception");
            return; // skip normal finalization — already terminated
          }

          log(
            `[AnthropicSSE] Stream complete for ${opts.modelName}: ${totalLines} lines, ${textChunks} text chunks, ${toolUseBlocks} tool_use blocks, stop_reason=${stopReason}` +
              (filterThinking ? `, filtered ${thinkingBlocksSuppressed} thinking blocks` : "")
          );
          cap.note(`upstream-done sawMessageStop=${sawMessageStop} stop_reason=${stopReason} toolUse=${toolUseBlocks}`);

          if (opts.onTokenUpdate) {
            opts.onTokenUpdate(inputTokens, outputTokens);
          }

          // Finalization: if the upstream stream ended without sending
          // message_stop, emit it ourselves. Claude Code requires
          // message_stop as the terminal event — without it, the client
          // reports "API returned an empty or malformed response (HTTP 200)".
          if (!isClosed && !sawMessageStop) {
            log(`[AnthropicSSE] Stream ended without message_stop (stopReason=${stopReason}) — emitting synthetic finalization`);
            if (!sawMessageStart) {
              const synthId = `msg_${Date.now()}`;
              // JSON.stringify, same rule as finalizeWithError (S4-a): a quote
              // in a custom-endpoint model name must not break the client.
              controller.enqueue(encoder.encode(
                "event: message_start\ndata: " +
                  JSON.stringify({
                    type: "message_start",
                    message: {
                      id: synthId,
                      type: "message",
                      role: "assistant",
                      model: opts.modelName,
                      content: [],
                      stop_reason: null,
                      stop_sequence: null,
                      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                    },
                  }) +
                  "\n\n"
              ));
              controller.enqueue(encoder.encode(
                "event: content_block_start\ndata: " +
                  JSON.stringify({
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  }) +
                  "\n\n"
              ));
              controller.enqueue(encoder.encode(
                "event: content_block_delta\ndata: " +
                  JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: {
                      type: "text_delta",
                      text: "[Error: The model returned an empty response. This is usually transient — a momentary provider load or rate limit, NOT a context-size problem. Please retry. If it recurs repeatedly on a very large conversation, then try /compact.]",
                    },
                  }) +
                  "\n\n"
              ));
              controller.enqueue(encoder.encode(
                "event: content_block_stop\ndata: " +
                  JSON.stringify({ type: "content_block_stop", index: 0 }) +
                  "\n\n"
              ));
            }
            if (!stopReason) {
              controller.enqueue(encoder.encode(
                "event: message_delta\ndata: " +
                  JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: outputTokens },
                  }) +
                  "\n\n"
              ));
            }
            controller.enqueue(encoder.encode(
              "event: message_stop\ndata: " +
                JSON.stringify({ type: "message_stop" }) +
                "\n\n"
            ));
          }

          if (!isClosed) {
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            cap.done({ closed: true, stop_reason: stopReason, sawMessageStop, path: "normal" });
            controller.close();
          } else {
            cap.done({ closed: true, stop_reason: stopReason, sawMessageStop, path: "already-closed" });
          }
        } catch (e) {
          log(`[AnthropicSSE] Stream error: ${e}`);
          cap.note(`stream-exception ${String(e)}`);
          if (!isClosed) {
            isClosed = true;
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            cap.done({ closed: true, stop_reason: "exception", path: "catch", error: String(e) });
            controller.close();
          } else {
            cap.done({ closed: true, stop_reason: "exception", path: "catch-already-closed", error: String(e) });
          }
        }
      },
      cancel(reason?: unknown) {
        cap.note(`client-cancel ${reason !== undefined ? String(reason) : ""}`);
        cap.done({ closed: false, stop_reason: "client-cancel", path: "cancel" });
        isClosed = true;
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
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
