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
import {
  overflowCapsPath,
  readOverflowCapsFile,
  writeOverflowCapsFile,
  type OverflowCapRecord,
} from "./overflow-caps-store.js";

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
  "maximum context length", // OpenAI — ALSO the vLLM shape below (#674)
  "input exceeds the context window of", // Anthropic native
  "prompt is too long", // Anthropic native
];

// The vLLM refusal that rides `maximum context length` above is worth quoting,
// because its wording is the only place the engine states its own rule and it
// carries an exact count we would otherwise have to probe for (#674, measured
// 2026-10-25, three occurrences: 04:14:30Z / 08:15:00Z / 08:15:09Z):
//
//   {"error":{"message":"This model's maximum context length is 262144 tokens.
//    However, your prompt contains at least 262145 input tokens, which exceeds
//    this limit EVEN WITHOUT ANY OUTPUT TOKENS. … (parameter=input_tokens,
//    value=262145)","type":"BadRequestError","param":"input_tokens","code":400}}
//
// Two facts to keep: admission is decided on the PROMPT alone (`max_tokens` is
// trimmed to the remaining window, never validated — see `composed-handler.ts`
// `maxOutputTokens`), and the classification comes from the PHRASE, not from a
// code — this body's `code` is the literal 400, so `OVERFLOW_CODES` plays no
// part here.

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
  try {
    const { stripped, count } = stripMediaData(payload);
    return Math.ceil(JSON.stringify(stripped).length / 4) + count * MEDIA_BLOCK_TOKENS;
  } catch {
    return 0;
  }
}

/**
 * #575 — how many image/document blocks a payload carries, using the SAME walk
 * as `estimateClampTokens`: the engine's per-prompt cap counts blocks, and the
 * number the skip marker reports must be the number the cap will count. A
 * second, divergent walk would eventually disagree with the estimator that
 * backs the admission census.
 */
export function countMediaBlocks(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  try {
    return stripMediaData(payload).count;
  } catch {
    return 0;
  }
}

/**
 * Shared media walk: replaces every `source.data` base64 payload with an empty
 * string (so the JSON length is the text-only size) and counts the blocks.
 */
function stripMediaData(payload: unknown): { stripped: unknown; count: number } {
  let count = 0;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== "object") return node;
    const obj = { ...(node as Record<string, unknown>) };
    const src = obj.source as Record<string, unknown> | undefined;
    const hasMediaData =
      src !== null && typeof src === "object" && typeof src.data === "string" && src.data.length > 0;
    if (hasMediaData) {
      count++;
      obj.source = { ...src, data: "" };
    }
    for (const k of Object.keys(obj)) {
      if (k === "source" && hasMediaData) continue; // replaced above — do not re-walk
      obj[k] = strip(obj[k]);
    }
    return obj;
  };
  return { stripped: strip(payload), count };
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
 *
 * MEASURED CORRECTION (2026-10-25, #674): the `est/64` term (1.56%) does NOT
 * track that tokenizer drift — over 1 111 served swift responses paired
 * req→resp, `real/est` is x1.068 at p50, x1.118 at p95, x1.196 at p99 (min
 * 0.57, max 3.18). Deliberately left as-is rather than enlarged: the ratio is
 * content-dependent, so any factor big enough to cover the tail over-reserves
 * on the median and truncates answers the engine would have served — and on the
 * shipping engine this clamp cannot rescue an over-window prompt anyway
 * (admission is decided by the prompt alone; the engine trims the generation).
 * The band it cannot see is #674's exact-counting case.
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
/** Durable side: same keys, plus when/why each cap was learned (#651). */
const overflowCapRecords = new Map<string, OverflowCapRecord>();
/**
 * #674 — the window a refusal STATED ("maximum context length is N"), keyed
 * like the caps. Same trust class as a `deriveContextLimit` probe but observed
 * on live traffic: feeds the #676 corroboration (and nothing else — never a
 * refusal path of its own), rides the cap's TTL/purge/reset lifecycle.
 */
const overflowStatedLimits = new Map<string, number>();
/** Armed by `initOverflowCapsPersistence()`; undefined = memory only. */
let overflowCapsStorePath: string | undefined;

/**
 * #651 - restore the caps learned by a previous process and arm write-through.
 *
 * Called once at proxy startup. Returns what it did so the caller can log it: a
 * silent restore is indistinguishable from a store that was never read. A
 * missing or corrupt file restores nothing and disarms nothing - the next
 * refusal re-learns, which is exactly today's behaviour.
 *
 * #660 r1 - a restored cap is bounded in time (`CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS`,
 * default 24 h, `0` = never). Before the TTL, a persisted cap lived until
 * somebody deleted the file, and since the learned branch is checked BEFORE the
 * derived window in `handle()`, a stale cap kept refusing requests even with
 * `deriveContextLimit: true` set - a claim outliving the measurement that
 * contradicts it. A record whose `at` cannot be parsed is NOT restored: its age
 * cannot be bounded, and the cost of not restoring is one relearning round-trip
 * (the pre-#651 behaviour), never a refused request.
 */
export function initOverflowCapsPersistence(
  path: string | undefined = overflowCapsPath(),
  opts: { now?: () => number; env?: NodeJS.ProcessEnv } = {}
): { path?: string; loaded: number; expired: number } {
  overflowCapsStorePath = path;
  if (!path) return { loaded: 0, expired: 0 };
  const maxAgeMs = overflowCapsMaxAgeMs(opts.env);
  const now = opts.now?.() ?? Date.now();
  let loaded = 0;
  let expired = 0;
  for (const [key, record] of readOverflowCapsFile(path)) {
    if (maxAgeMs > 0) {
      const atMs = Date.parse(record.at);
      if (!Number.isFinite(atMs) || now - atMs > maxAgeMs) {
        expired++;
        continue;
      }
    }
    overflowCaps.set(key, record.cap);
    overflowCapRecords.set(key, record);
    if (record.statedLimit !== undefined && record.statedLimit > 0) {
      overflowStatedLimits.set(key, record.statedLimit);
    }
    loaded++;
  }
  return { path, loaded, expired };
}

/**
 * #660 r1 - `CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS`, the maximum age of a restored
 * learned cap. Default 24 h (the effective pre-#651 lifetime: the watchdog
 * restarts the hub nightly, so an in-memory cap never outlived it). `0` means
 * no expiry. Unparsable or negative values fall back to the default rather
 * than silently disarming the bound.
 */
export function overflowCapsMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS ?? "").trim();
  if (raw.length === 0) return DEFAULT_OVERFLOW_CAPS_MAX_AGE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_OVERFLOW_CAPS_MAX_AGE_MS;
  return Math.floor(n);
}

const DEFAULT_OVERFLOW_CAPS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * #660 r1 - drop every learned cap of one provider (the `customEndpoints` key).
 * Called when derivation SUCCEEDS for that provider at startup: the measured
 * window replaces the learned value instead of sitting behind it - the learned
 * branch is checked first in `handle()`, so without this purge a stale cap
 * would keep refusing what the fresh measurement just allowed. Rewrites the
 * durable store when one is armed. Returns how many entries were dropped.
 */
export function forgetOverflowCapsForProvider(providerName: string): number {
  const prefix = `${providerName}::`;
  let purged = 0;
  for (const key of [...overflowCaps.keys()]) {
    if (!key.startsWith(prefix)) continue;
    overflowCaps.delete(key);
    overflowCapRecords.delete(key);
    overflowStatedLimits.delete(key);
    purged++;
  }
  if (purged > 0 && overflowCapsStorePath) {
    writeOverflowCapsFile(overflowCapsStorePath, overflowCapRecords);
  }
  return purged;
}

/** Test/teardown hook: forget the armed path without touching the caps. */
export function disarmOverflowCapsPersistence(): void {
  overflowCapsStorePath = undefined;
}

export function rememberOverflowCap(
  providerName: string,
  model: string,
  tokens: number,
  evidence?: string,
  statedLimit?: number
): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const key = `${providerName}::${model}`;
  const cap = Math.floor(tokens);
  overflowCaps.set(key, cap);
  // #674 — a stated window is accepted only as a finite positive number, and
  // an ABSENT statement never erases a previous one (a wording change in one
  // refusal is not evidence the window moved).
  if (Number.isFinite(statedLimit) && statedLimit! > 0) {
    overflowStatedLimits.set(key, Math.floor(statedLimit!));
  }
  // #651 - write-through only when a durable store is armed: a unit test or a
  // dev launcher (no env) keeps this module strictly in-memory.
  if (overflowCapsStorePath) {
    overflowCapRecords.set(key, {
      cap,
      at: new Date().toISOString(),
      evidence,
      ...(overflowStatedLimits.has(key)
        ? { statedLimit: overflowStatedLimits.get(key) }
        : {}),
    });
    writeOverflowCapsFile(overflowCapsStorePath, overflowCapRecords);
  }
}

export function getOverflowCap(providerName: string, model: string): number | undefined {
  return overflowCaps.get(`${providerName}::${model}`);
}

/**
 * #674 — the window the latest overflow refusal for this (provider, model)
 * stated in its own body, when it stated one. An ENGINE number, not an
 * estimate: the corroboration compares it in clamp units. `undefined` when no
 * refusal ever stated a window (most providers) — callers must treat that as
 * "no evidence", exactly like an absent `derivedContextLimit`.
 */
export function getStatedContextLimit(providerName: string, model: string): number | undefined {
  return overflowStatedLimits.get(`${providerName}::${model}`);
}

export function resetOverflowCapsForTests(): void {
  overflowCaps.clear();
  overflowCapRecords.clear();
  overflowStatedLimits.clear();
  overflowCapsStorePath = undefined;
}

// The reported-usage floor lives in its own leaf module: the Responses parser needs
// it too, and it is the module this one imports — re-exported here so callers keep a
// single import site.
export { overflowReportFloor, overflowReportedTokens } from "./overflow-report-floor.js";

// ── #565 — admission census over DECLARED windows ─────────────────────────────
// Incident 2026-10-20: a 1.2k-message `/compact` turn (~1.1M tokens) reached the
// hub, the nominal answered a MiniMax 400 ("Input too large"), and the client
// got provider jargon that sent a whole diagnosis thread down the wrong path.
// No lane in the fleet has a window anywhere near that size, so the request was
// doomed at admission — the proxy could have said so itself.
//
// Deliberately NOT a rescue: nothing downstream can take the request, the
// correct outcome IS the refusal. The only question is whether it is announced
// locally, with numbers, or surfaces as an opaque upstream 400.

/** One candidate window on the request's resolved path. */
export interface DeclaredWindow {
  /** Provider (custom-endpoint) name, e.g. `vllm-myia`. */
  name: string;
  limit: number;
}

export interface ContextAdmissionDecision {
  /** True when every candidate on the path declares a window, and every one is smaller than the request. */
  refuse: boolean;
  estTokens: number;
  /** The largest declared window seen; undefined when the path declares none. */
  largest?: DeclaredWindow;
}

/**
 * Decide whether a request can be refused at admission.
 *
 * `windows` carries ONLY declared bounds (an operator `contextLimit`);
 * `undeclaredCandidates` counts the candidates on the same path that declare
 * nothing. A path with ANY undeclared candidate falls open — the census never
 * guesses a window, and an undeclared candidate is never treated as `0`. The
 * refusal must clear the largest declared window by the same proportional
 * margin the #441 clamp reserves (`contextLimitMarginTokens`), so a request
 * merely NEAR a window is left to the clamp and the learned cap (#79) instead
 * of being refused on estimator drift.
 */
export function decideContextAdmission(
  payload: unknown,
  windows: readonly DeclaredWindow[],
  undeclaredCandidates = 0
): ContextAdmissionDecision {
  const declared = windows.filter((w) => Number.isFinite(w.limit) && w.limit > 0);
  // One undeclared candidate is enough to stand down (hub 2026-10-22): the
  // haiku path `MiniMax (nothing) > vllm-myia (262 144) > role:sonnet > ds@…
  // (nothing)` refused every request over 262k — `/compact` included, so the
  // session could never condense its way out — while the nominal and the PAYG
  // terminator could have taken it. A candidate the census cannot see may be
  // the one that serves; only a path where EVERY candidate declares a window
  // too small is doomed. An entry with a non-finite or zero limit is an
  // undeclared candidate too, never a window of size 0.
  if (undeclaredCandidates > 0 || declared.length < windows.length) {
    return { refuse: false, estTokens: 0 };
  }
  // Nothing declared ⇒ no census at all (estTokens 0, not a measurement): the
  // estimate walks and re-serialises the whole body, and most requests on most
  // machines have no declared window to weigh. Pay for it only when it decides.
  if (declared.length === 0) return { refuse: false, estTokens: 0 };
  // `estimateClampTokens`, not `estimatePayloadTokens`: the clamp estimator
  // replaces each image/document base64 block with a fixed allocation, so a
  // 1 MB screenshot scores ~1.6k instead of the ~750k its base64 chars would.
  // For a REFUSAL an inflated estimate is a false refusal — the /4 convention
  // is safe only where over-counting merely compacts earlier.
  const estTokens = estimateClampTokens(payload);
  let largest = declared[0];
  for (const w of declared) if (w.limit > largest.limit) largest = w;
  const refuse = estTokens > largest.limit + contextLimitMarginTokens(estTokens);
  return { refuse, estTokens, largest };
}

/**
 * The refusal text. States what was measured and what to do — never posture,
 * never instruct the agent to undo its decisions (doctrine 2026-08-23).
 *
 * LOAD-BEARING: this wording must never match `isQuotaExhaustion` (no "quota",
 * "credit", "balance", "weekly", "usage limit", "plan limit", "exhaust",
 * "exceed your account") — a context refusal is not a wall and must not arm a
 * cascade. Pinned by test.
 */
export function contextAdmissionRefusalText(estTokens: number, largest: DeclaredWindow): string {
  return (
    `[claudish] Input of ~${estTokens} tokens exceeds every declared context window on this route ` +
    `(largest declared: ${largest.limit} — ${largest.name}). No DECLARED window on this route can ` +
    `take it; ` +
    `the context gauge has been advanced accordingly. Condense the conversation before retrying.`
  );
}

/** `CLAUDISH_CONTEXT_ADMISSION=0` restores today's behaviour: no census, no
 * local refusal. Only an explicit "0" disarms, per house convention. */
export function contextAdmissionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDISH_CONTEXT_ADMISSION || "").trim() === "0";
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
