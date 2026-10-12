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

/**
 * #441/#442 — fixed token allocation charged for ONE image/document block
 * when estimating for the dynamic clamp. A 1 MB screenshot is ~1.5k tokens
 * on a vision lane and ~0 once described/stripped by the vision fallback —
 * never the ~750k its base64 characters score under the /4 convention.
 */
export const MEDIA_BLOCK_TOKENS = 1600;

/**
 * Prompt estimate for the #441 dynamic clamp — DISTINCT from
 * `estimatePayloadTokens` (the overflow-recovery estimate, where
 * over-counting base64 is safe: an inflated count only compacts earlier).
 * Here an inflated estimate TRUNCATES the answer: measured (review
 * c.6114982206), a 1.03 MB screenshot plus "describe this screenshot"
 * clamped max_tokens 16384 → 558 on a 262 144 window. Each image/document
 * `source.data` is therefore replaced by a fixed MEDIA_BLOCK_TOKENS
 * allocation instead of its base64 length / 4.
 */
export function estimateClampTokens(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  let mediaBlocks = 0;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== "object") return node;
    const obj = { ...(node as Record<string, unknown>) };
    const src = obj.source as Record<string, unknown> | undefined;
    const hasMediaData =
      src !== null && typeof src === "object" && typeof src.data === "string" && src.data.length > 0;
    if (hasMediaData) {
      mediaBlocks++;
      obj.source = { ...src, data: "" };
    }
    for (const k of Object.keys(obj)) {
      if (k === "source" && hasMediaData) continue; // replaced above — do not re-walk
      obj[k] = strip(obj[k]);
    }
    return obj;
  };
  try {
    const stripped = strip(payload);
    return Math.ceil(JSON.stringify(stripped).length / 4) + mediaBlocks * MEDIA_BLOCK_TOKENS;
  } catch {
    return 0;
  }
}

/**
 * #441 — FLOOR of the safety margin subtracted from `contextLimit − promptEstimate`
 * before the dynamic max_tokens clamp. The margin actually applied is
 * proportional — `max(this floor, est/64)` — because the /4 estimator drifts
 * toward /3.5 on code-dense prompts: a fixed margin covers none of that at
 * 250k, a proportional one tracks it (~1.6% of the prompt, ~3.9k at the RX95
 * window; pre-review #442, ai-01 2026-10-11). Covers the two drifts the /4
 * estimator cannot see: a tokenizer reading structured JSON yields MORE tokens
 * than chars/4 (every `{`/`"`/`:` is a token), and the wire prompt is the
 * CONVERTED payload (openai or anthropic), not the Claude-shaped request we
 * estimate — a few percent of shape delta at 250k. Over-estimating the prompt
 * is safe (it only shrinks max_tokens further); UNDER-estimating re-arms the
 * vLLM 400 this clamp exists to prevent. 2048 ≈ 0.8% of the Swift window
 * (262 144).
 */
export const CONTEXT_LIMIT_SAFETY_MARGIN_TOKENS = 2048;

/** #441 — the margin actually applied for a given prompt estimate. */
export function contextLimitMarginTokens(est: number): number {
  return Math.max(CONTEXT_LIMIT_SAFETY_MARGIN_TOKENS, Math.ceil(est / 64));
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

// The reported-usage floor lives in its own leaf module: the Responses parser needs
// it too, and it is the module this one imports — re-exported here so callers keep a
// single import site.
export { overflowReportFloor, overflowReportedTokens } from "./overflow-report-floor.js";

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
