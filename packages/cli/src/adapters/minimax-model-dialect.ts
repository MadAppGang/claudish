/**
 * MiniMaxModelDialect — Layer 2 dialect for MiniMax models.
 *
 * Handles MiniMax-specific quirks:
 * - Context window: all models are 204,800 tokens
 * - Temperature: must be in (0.0, 1.0] — clamps 0 → 0.01, >1 → 1.0
 * - Thinking: native support via standard `thinking` param; operator policy
 *   via CLAUDISH_MINIMAX_THINKING (see prepareRequest)
 * - Vision: not supported — supportsVision() returns false so ComposedHandler strips images
 */

import { BaseAPIFormat, AdapterResult, matchesModelFamily } from "./base-api-format.js";
import type { PrepareRequestContext } from "./model-dialect.js";
import { clientRequestedThinking } from "../handlers/shared/client-thinking.js";
import { isHex64Signature } from "../handlers/shared/thinking-signature.js";
import { log } from "../logger.js";
import { lookupModel } from "./model-catalog.js";

/** MiniMax API requires temperature in (0.0, 1.0]. Sourced from MiniMax's published API docs, not per-model. */
const TEMPERATURE_RANGE = { min: 0.01, max: 1.0 } as const;

const DEFAULT_FORCED_BUDGET = 16000;

/** MiniMax emits SHA-256-digest-shaped thinking signatures (64 lowercase hex);
 *  an Anthropic signature is a long opaque base64 blob and never matches.
 *  The shape lives in ONE place (#597) — `isHex64Signature()` in
 *  handlers/shared/thinking-signature.ts, which reads it with the opposite
 *  verdict on the native wire (foreign ⇒ stripped). */

/**
 * M3.1-Flash thinking-depth levels (Anthropic-compat doc, output_config.effort):
 * low | medium | high | xhigh | max — Flash defaults to MAX when omitted, which
 * is the single biggest output-token driver on the Flash lane (measured
 * 2026-10-19: median thinking 1.5k chars, 23 responses >5k tokens). budget_tokens
 * is not in the Anthropic-compat doc; whether Flash honors it is unmeasured
 * (forced never rewrites a client-requested budget, and production clients
 * send 31999) — effort is the first lever that reaches those requests.
 */
export const MINIMAX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type MiniMaxEffortLevel = (typeof MINIMAX_EFFORT_LEVELS)[number];

type MiniMaxThinkingPolicy =
  | { kind: "passthrough" }
  | { kind: "disabled" }
  | { kind: "forced"; budget: number }
  | { kind: "effort"; level: MiniMaxEffortLevel };

/**
 * Read CLAUDISH_MINIMAX_THINKING on every call rather than caching it (same
 * rationale as Qwen/GLM/DeepSeek): the fleet flips this during a budget
 * crunch, and a cached value would need a restart of the proxy that is, at
 * that exact moment, the thing keeping everyone working.
 */
function readThinkingPolicy(): MiniMaxThinkingPolicy {
  const raw = (process.env.CLAUDISH_MINIMAX_THINKING || "").trim().toLowerCase();
  if (!raw || raw === "passthrough" || raw === "client" || raw === "default")
    return { kind: "passthrough" };
  if (raw === "disabled" || raw === "off" || raw === "false") return { kind: "disabled" };
  let m = raw.match(/^effort:(low|medium|high|xhigh|max)$/);
  if (m) return { kind: "effort", level: m[1] as MiniMaxEffortLevel };
  m = raw.match(/^forced:(\d+)$/);
  if (m) {
    const budget = Number.parseInt(m[1], 10);
    if (Number.isFinite(budget) && budget > 0) return { kind: "forced", budget };
  } else if (raw === "forced" || raw === "enabled" || raw === "on" || raw === "true") {
    return { kind: "forced", budget: DEFAULT_FORCED_BUDGET };
  }
  log(`[MiniMaxModelDialect] Unrecognized CLAUDISH_MINIMAX_THINKING='${raw}', using 'passthrough'`);
  return { kind: "passthrough" };
}

export class MiniMaxModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // MiniMax interleaved thinking is handled by the model
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Handle request preparation — clamp temperature to MiniMax's accepted range,
   * apply the operator thinking policy.
   *
   * The valid temperature range is the TEMPERATURE_RANGE constant sourced from
   * MiniMax's published API docs. The standard `thinking` parameter is supported
   * natively by MiniMax's Anthropic-compatible endpoint.
   *
   * Unlike Qwen/GLM/DeepSeek (which think BY DEFAULT and need an off switch),
   * M3 does not reason without a `thinking` request: absent or disabled gives
   * `[text]`; enabled (any budget) or adaptive gives `[thinking, text]` on a
   * small prompt (live probes through the hub, 2026-09-23 — M3; M3.1-Flash
   * differs on both ends: it thinks with the field omitted, and `disabled`
   * is a 400/2013).
   *
   * ⚠ This switch does NOT make the production haiku lane reason. Hub corpus,
   * every MiniMax-M3 response 2026-09-23 11:38Z→19:49Z (887, all paired):
   * 679 requests ALREADY carry `{"type":"enabled","budget_tokens":31999}`
   * (claude-vscode) and only 6 of them produced a `thinking_delta`; the other
   * 208 are absent/disabled, almost all sdk-cli one-shots. `forced` leaves
   * the 679 untouched and rewrites the 208 — why enabled long-context
   * requests mostly don't reason is an open question (#237 review), not
   * something this policy addresses. CLAUDISH_MINIMAX_THINKING:
   *
   *   passthrough (default) — send exactly what the client asked for
   *   disabled              — force `thinking: {"type":"disabled"}` (⚠ M3.1-Flash
   *                           rejects this with 400/2013 — it cannot think less
   *                           than adaptive; use effort:low on Flash. The Flash
 *                           guard below rewrites the disabled to adaptive, so
 *                           the request survives)
   *   forced[:<n>]          — force `{"type":"enabled","budget_tokens":<n>}`
   *                           (default n=16000) when the client did not itself
   *                           ask for thinking; a client that asked (enabled OR
   *                           adaptive — `clientRequestedThinking`) keeps its
   *                           own setting untouched. ⚠ budget_tokens is not in
   *                           the Anthropic-compat doc; whether M3.1-Flash
   *                           honors it is unmeasured (forced never rewrites a
   *                           client-requested budget, and production clients
   *                           send 31999) — kept for older models only.
   *   effort:<level>        — M3.1-Flash only: inject
   *                           `output_config: {"effort": low|medium|high|xhigh|max}`
   *                           — the documented thinking-depth slider. Flash
   *                           defaults to MAX when the field is absent, the
   *                           dominant output-token driver on the Flash lane.
   *                           Applied regardless of the client's own thinking
   *                           request; ignored with a log line for non-Flash
   *                           models. Shares `forced`'s filter semantics
   *                           (shouldFilterThinking/preserveThinkingBlock):
   *                           Flash always thinks, so the #295/#324
   *                           continuation chain needs its blocks preserved.
   *
   * Rewrites apply on the anthropic wire only (`ctx.wireFormat ===
   * "anthropic-sse"`): on OpenAI-shaped routings the `thinking` object is not
   * the switch this endpoint reads, so forcing it there is inert noise. As
   * with Qwen, a configured budget that would not fit under max_tokens is not
   * forced for that one request — failing the request would be worse than
   * skipping its reasoning.
   */
  override prepareRequest(request: any, originalRequest: any, ctx?: PrepareRequestContext): any {
    if (request.temperature !== undefined) {
      if (request.temperature < TEMPERATURE_RANGE.min) {
        log(
          `[MiniMaxModelDialect] Clamping temperature ${request.temperature} → ${TEMPERATURE_RANGE.min} (MiniMax requires >= ${TEMPERATURE_RANGE.min})`
        );
        request.temperature = TEMPERATURE_RANGE.min;
      } else if (request.temperature > TEMPERATURE_RANGE.max) {
        log(
          `[MiniMaxModelDialect] Clamping temperature ${request.temperature} → ${TEMPERATURE_RANGE.max} (MiniMax requires <= ${TEMPERATURE_RANGE.max})`
        );
        request.temperature = TEMPERATURE_RANGE.max;
      }
    }

    const policy = readThinkingPolicy();
    if (ctx?.wireFormat === "anthropic-sse" && policy.kind === "effort") {
      // output_config.effort is the documented M3.1-Flash thinking-depth knob
      // (low..max, default max when omitted). Flash-only per the doc: M3 does
      // not document the field, so sending it there is noise at best.
      if (/m3\.1/i.test(String(this.modelId ?? ""))) {
        const prior = (request.output_config ?? {}) as Record<string, unknown>;
        request.output_config = { ...prior, effort: policy.level };
        log(
          `[MiniMaxModelDialect] thinking depth effort=${policy.level} (output_config.effort, model ${this.modelId})`
        );
      } else {
        log(
          `[MiniMaxModelDialect] effort policy ignored for ${this.modelId} — output_config.effort is M3.1-Flash only`
        );
      }
    }
    if (ctx?.wireFormat === "anthropic-sse" && policy.kind !== "passthrough" && policy.kind !== "effort") {
      // `adaptive` is a request too — an `=== "enabled"` test overwrote it.
      const clientEnabled = clientRequestedThinking(originalRequest?.thinking);
      const maxTokensRaw = Number(request.max_tokens ?? 0);
      const maxTokensKnown = maxTokensRaw > 0;
      const budgetFits =
        policy.kind === "forced" && (!maxTokensKnown || maxTokensRaw > policy.budget + 1);

      if (policy.kind === "disabled") {
        request.thinking = { type: "disabled" };
        log("[MiniMaxModelDialect] thinking disabled (CLAUDISH_MINIMAX_THINKING=disabled)");
      } else if (clientEnabled) {
        log("[MiniMaxModelDialect] client already requested thinking — leaving its budget untouched");
      } else if (budgetFits) {
        request.thinking = { type: "enabled", budget_tokens: policy.budget };
        log(
          `[MiniMaxModelDialect] thinking forced (client=${originalRequest?.thinking?.type ?? "absent"}), budget ${policy.budget} — NOTE: budget_tokens is not in the MiniMax doc; on M3.1-Flash prefer effort:<level>`
        );
      } else {
        log(
          `[MiniMaxModelDialect] thinking not forced for this request (max_tokens ${maxTokensRaw} <= budget ${policy.budget})`
        );
      }
    }

    // M3.1-Flash cannot think less than adaptive: a `thinking.type:"disabled"`
    // that reaches the wire is a 400/2013 ("requires adaptive thinking;
    // thinking.type='disabled' … is not allowed"). Measured live 2026-10-21:
    // WebFetch one-shots (msgs=1, haiku role) send `{"type":"disabled"}` and
    // took the 400 straight back. This is a MODEL constraint, not an operator
    // preference — it applies under every policy (the effort block above
    // deliberately never touches `thinking`, which is exactly how the client's
    // disabled reached the wire) and runs AFTER the policy block, so an
    // operator `disabled` armed on Flash is caught too. `adaptive` is the
    // minimum the model accepts; dropping the field instead would reset Flash
    // to its MAX-when-omitted default.
    if (
      ctx?.wireFormat === "anthropic-sse" &&
      /m3\.1/i.test(String(this.modelId ?? "")) &&
      request.thinking?.type === "disabled"
    ) {
      request.thinking = { type: "adaptive" };
      log(
        `[MiniMaxModelDialect] M3.1-Flash rejects thinking.type=disabled (400/2013) — sending adaptive instead (model ${this.modelId})`
      );
    }

    return request;
  }

  /**
   * Context window sourced from the model catalog.
   * Defaults to 204,800 (MiniMax standard context) if not in catalog.
   */
  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  /**
   * MiniMax's Anthropic API does not support image or document content blocks.
   * Returning false causes ComposedHandler to strip/proxy image content.
   * Sourced from model catalog; defaults to false for unrecognized MiniMax models.
   */
  override supportsVision(): boolean {
    return lookupModel(this.modelId)?.supportsVision ?? false;
  }

  /**
   * MiniMax's Anthropic-compatible endpoint returns thinking blocks that leak
   * to the user when passed through unrequested. Filter them from the SSE
   * stream — the parser consults this only when the client did NOT itself
   * request thinking (anthropic-sse opts.clientRequestedThinking), so a
   * client that asks for thinking still receives its blocks.
   *
   * #295 — EXCEPT under a `forced` policy. M3 only (re)starts thinking on a
   * tool-continuation turn when the preceding assistant turn carries its
   * preserved thinking block (live bisect T4a/T4c), and `forced` is exactly
   * the state "model thinks, client did not ask": filtering there strips every
   * thinking block from every forced response, so the client never holds one,
   * never echoes one, and the chain mutes on every continuation turn (the
   * 1/30 production shape). Under `forced` the blocks pass through — the cost
   * of them appearing in CC is the one the issue accepts. The leak this filter
   * exists for (passthrough policy, unrequested thinking) is unchanged.
   *
   * Re-read per call like readThinkingPolicy(): the fleet flips this knob
   * mid-flight. The forced-but-budget-doesn't-fit request also lands here
   * unfiltered — harmless: no injection means M3 emits no thinking block,
   * so there is nothing to pass through anyway.
   */
  override shouldFilterThinking(): boolean {
    // `effort` shares forced's shape: M3.1-Flash ALWAYS thinks (omitted thinking
    // = on, doc 2026-10-19), so the same tool-continuation chain that #295/#324
    // measured for `forced` applies — blocks pass through, history preserved.
    const kind = readThinkingPolicy().kind;
    return kind !== "forced" && kind !== "effort";
  }

  /**
   * #324 B1 — the SECOND filter of the #295 chain, inbound side. The outgoing
   * fix (shouldFilterThinking above) lets a `forced` response carry its
   * thinking block to the client; this one lets the block survive the RETURN
   * trip. ComposedHandler strips every history thinking block for non-native
   * providers (composed-handler.ts, the preserveThinkingInHistory gate), so
   * without this override the block the client dutifully echoes back is
   * removed before it reaches M3, and the model falls back to the mute T4a
   * shape on every continuation turn — the chain repaired on one wire and
   * broken again on the other.
   *
   * Discriminant, from the production fixtures (not supposition): MiniMax
   * signatures are SHA-256-digest-shaped — 64 lowercase hex chars. M3's
   * implicit-signature shape is literally the SHA-256 of the empty string
   * (`e3b0c442…b855`, fixtures minimax-m3-anthropic-implicit-signature
   * r10324/r10416), M2.5's vary but stay 64-hex, and M2.5 also emits
   * unsigned blocks (turns 2-3 of the m25 captures). An Anthropic signature
   * is none of these: a long opaque base64 blob, always present. So under
   * `forced`: unsigned or 64-hex ⇒ MiniMax's own, preserved (signature
   * included — the chain needs it intact); anything else ⇒ foreign (an Opus
   * block carried in by a session that fell to a MiniMax cascade step),
   * still stripped — the strip's original raison d'être stands.
   *
   * NOT preserveThinkingInHistory(): that boolean also feeds
   * reasoningRoundtrip in ComposedHandler's convertMessages (OpenAI wire,
   * `reasoning_content` echo-back). MiniMax lanes run anthropic-sse, where
   * this per-block hook is the only consulted seam, and flipping the boolean
   * would force reasoning_content onto OpenAI-shaped MiniMax routings the
   * policy was never measured on. Re-read per call, same rationale as
   * readThinkingPolicy().
   */
  override preserveThinkingBlock(block: unknown): boolean {
    const kind = readThinkingPolicy().kind;
    if (kind !== "forced" && kind !== "effort") return false;
    const sig = (block as { signature?: unknown } | null)?.signature;
    if (typeof sig !== "string" || sig === "") return true; // M2.5 unsigned shape
    return isHex64Signature(sig);
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "minimax");
  }

  getName(): string {
    return "MiniMaxModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use MiniMaxModelDialect */
export { MiniMaxModelDialect as MiniMaxAdapter };
