/**
 * Context-overflow interception — the "recoverable turn" for pre-stream prompt-size refusals.
 *
 * Incident 2026-09-10/11: a worker read a large PDF, the context blew past the provider's
 * maximum prompt size in a single step, and every subsequent turn failed with a pre-stream
 * 400 (`{"code":"1261","message":"Prompt exceeds max length"}` — GLM Coding) carrying NO
 * `usage`. Claude Code's context gauge never advanced, its auto-compact (threshold
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW, fleet-wide 280k) never fired, and `/continue` re-sent
 * the same oversized prompt indefinitely — a wedged session that lost a whole night.
 *
 * The fix mirrors the emission doctrine already in production on the Responses lane
 * (openai-responses-sse.ts, `parseContextOverflow` + the error-branch frames): when the
 * upstream refuses the prompt for size, answer HTTP 200 with a factual text block and a
 * `usage.input_tokens` at or above the real size, so the client's gauge crosses its
 * compaction threshold and the next turn compacts instead of looping.
 *
 * The operative limit is a VARIABLE provider-side maximum prompt size (GLM 1261), not the
 * model's context window — every cascade model except the local vLLM accepts 1M, and the
 * fleet compaction threshold (280k) is deliberate and unchanged. There is therefore no
 * static number to check against: the cap is LEARNED from the first rejection and held
 * in memory to short-circuit later oversized requests before they pay the round-trip.
 */

import { parseContextOverflow } from "./stream-parsers/openai-responses-sse.js";

export interface ContextOverflowMatch {
  matched: boolean;
  /** Token count the provider says was used, when the body states one. */
  used?: number;
  /** Token limit the provider states, when present. */
  limit?: number;
}

/** Error codes that mean "the prompt exceeds the provider's maximum prompt size". */
const OVERFLOW_CODES = new Set(["context_length_exceeded", "1261"]);

/**
 * Message fragments that identify a prompt-size refusal. Deliberately narrow —
 * telemetry.ts's `classifyError` matches any "token" and would swallow unrelated
 * 400s (an "invalid token" auth error is not an overflow).
 */
const OVERFLOW_PHRASES = [
  "prompt exceeds max length", // GLM Coding 1261
  "maximum context length", // OpenAI
  "input exceeds the context window of", // Anthropic native
  "prompt is too long", // Anthropic native
];

/**
 * Strict matcher for prompt-size refusals. Accepts the RAW upstream error body
 * (the same string `appendUpstreamError` captures). Returns `matched: false` for
 * everything else — quota walls (GLM 1308 "Usage limit reached"), auth errors,
 * moderation flags — so those keep their existing relay path untouched.
 */
export function classifyContextOverflow(status: number, errorBody: string): ContextOverflowMatch {
  if (status < 400 || status > 413) return { matched: false };

  let code: string | undefined;
  let message = "";
  try {
    const parsed = JSON.parse(errorBody);
    const rawCode = parsed?.error?.code ?? parsed?.code;
    if (rawCode !== undefined && rawCode !== null) code = String(rawCode);
    const rawMsg = parsed?.error?.message ?? parsed?.message;
    if (rawMsg !== undefined && rawMsg !== null) message = String(rawMsg);
  } catch {
    message = errorBody;
  }

  const lower = message.toLowerCase();
  const matched =
    (code !== undefined && OVERFLOW_CODES.has(code)) ||
    OVERFLOW_PHRASES.some((p) => lower.includes(p));
  if (!matched) return { matched: false };

  // Reuse the Responses-lane extractor for any stated used/limit counts.
  const parsed = parseContextOverflow(message, code);
  return { matched: true, used: parsed?.used, limit: parsed?.limit };
}

/**
 * Token estimate for a request payload, same convention as the `/v1/messages/count_tokens`
 * estimation route (`JSON.stringify(body).length / 4`) and `estimateTokens` in openai-sse.
 * Over-estimates base64 images — acceptable: an inflated count only compacts earlier.
 */
export function estimatePayloadTokens(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  try {
    return Math.ceil(JSON.stringify(payload).length / 4);
  } catch {
    return 0;
  }
}

// ── Learned provider cap ──────────────────────────────────────────────────────
// providerKey → last rejected estimate. In-memory only (cleared on restart): the
// first oversized request after a restart pays one round-trip to relearn, which is
// the unavoidable cost of not hardcoding a variable provider limit.

const overflowCaps = new Map<string, number>();

export function rememberOverflowCap(providerName: string, model: string, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  overflowCaps.set(`${providerName}::${model}`, Math.floor(tokens));
}

export function getOverflowCap(providerName: string, model: string): number | undefined {
  return overflowCaps.get(`${providerName}::${model}`);
}

export function resetOverflowCapsForTests(): void {
  overflowCaps.clear();
}

/**
 * Floor applied to the REPORTED `usage.input_tokens`. The real rejected size can sit
 * below the client's compaction threshold yet above the provider cap (the exact wedge
 * of the incident): reporting the raw size would leave the gauge under the threshold
 * and the session would keep looping. The floor guarantees the gauge crosses it.
 * Env `CLAUDISH_OVERFLOW_REPORT_FLOOR` (default 280 000 — the fleet compaction
 * threshold); `0` disables the floor and reports the raw numbers.
 */
export function overflowReportFloor(): number {
  const raw = process.env.CLAUDISH_OVERFLOW_REPORT_FLOOR;
  if (raw === undefined) return 280_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 280_000;
  return Math.floor(n);
}

/** The `input_tokens` to report: the largest of body-stated, estimated, floor. */
export function overflowReportedTokens(
  used: number | undefined,
  estimate: number,
  floor: number
): number {
  return Math.max(used ?? 0, estimate, floor);
}

// ── Recoverable-turn constructors ─────────────────────────────────────────────

/**
 * Factual notice text. Doctrine (failover notices, 2026-08-23): state what happened
 * and what to do — never posture, never instruct the agent to undo its decisions.
 */
export function overflowRecoveryText(
  providerName: string,
  model: string,
  estTokens: number
): string {
  return (
    `[claudish] Input of ~${estTokens} tokens exceeded the serving model's maximum prompt size ` +
    `(provider ${providerName}, model ${model}). The context gauge has been advanced accordingly. ` +
    `Condense the conversation and retry.`
  );
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

function frame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Complete SSE turn: message_start → one text block → message_delta with the real
 * `usage.input_tokens` → message_stop. Every terminating path must emit
 * `message_stop` (never-hang invariant); `message_delta.usage` is the frame the
 * client's gauge actually reads.
 */
export function buildOverflowRecoveryStream(
  text: string,
  inputTokens: number,
  modelName: string
): Response {
  const id = `msg_overflow_${Date.now()}`;
  const outputTokens = Math.max(1, Math.ceil(text.length / 4));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        frame("message_start", {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model: modelName,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        })
      );
      controller.enqueue(
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })
      );
      controller.enqueue(
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        })
      );
      controller.enqueue(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
      controller.enqueue(
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        })
      );
      controller.enqueue(frame("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS } });
}

/** Single JSON message — the `stream: false` lane (notably `/compact`). */
export function buildOverflowRecoveryMessage(
  text: string,
  inputTokens: number,
  modelName: string
): Record<string, unknown> {
  return {
    id: `msg_overflow_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: modelName,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: Math.max(1, Math.ceil(text.length / 4)) },
  };
}
