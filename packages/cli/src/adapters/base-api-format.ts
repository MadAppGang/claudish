/**
 * Base class for API format implementations (Layer 1) and model dialect
 * implementations (Layer 2).
 *
 * Different models have different quirks that need translation:
 * - Grok: XML function calls instead of JSON tool_calls
 * - Deepseek: May have its own format
 * - Others: Future model-specific behaviors
 */

import type { ModelPricing } from "../handlers/shared/remote-provider-types.js";
import { getModelPricing } from "../handlers/shared/remote-provider-types.js";
import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";
import type { APIFormat } from "./api-format.js";
import {
  type ReasoningCapability,
  lookupModel,
  lookupModelReasoning,
  lookupModelReasoningStatus,
} from "./model-catalog.js";
import type { ModelDialect } from "./model-dialect.js";
import { rejectedOptionalParams } from "./optional-param-rejection.js";
import {
  type ToolNameBindings,
  encodeToolName,
  newToolNameBindings,
  wireDecodesToolNames,
} from "./tool-name-utils.js";

/**
 * The OPTIONAL parameters {@link BaseAPIFormat.applyOpenAISamplingParams} adds
 * speculatively, and therefore the only ones
 * {@link BaseAPIFormat.recoverFromRejection} will remove. Anything else in the
 * payload is either required or owned by a dialect that must recover it itself.
 */
const OPTIONAL_SAMPLING_PARAMS: readonly string[] = ["stop", "top_p"];

/**
 * OpenAI validates a function name against `^[a-zA-Z0-9_-]{1,64}$` on both the
 * Chat Completions and the Responses shape. 64 is that limit, not a guess about
 * any one model.
 */
const OPENAI_TOOL_NAME_LIMIT = 64;

/**
 * Match a model ID against a model family name, handling vendor-prefixed IDs.
 *
 * Matches: "grok-beta", "x-ai/grok-beta", "openrouter/x-ai/grok-beta"
 * Does NOT match: "qwen-grok-hybrid" (grok is not at a family boundary)
 *
 * @param modelId - The full model ID (may include vendor prefix)
 * @param family - The family name to match (e.g., "grok", "deepseek", "qwen")
 */
export function matchesModelFamily(modelId: string, family: string): boolean {
  const lower = modelId.toLowerCase();
  const fam = family.toLowerCase();
  return lower.startsWith(fam) || lower.includes(`/${fam}`);
}
import { convertMessagesToOpenAI } from "../handlers/shared/format/openai-messages.js";
import {
  convertToolsToOpenAI,
  mapToolChoiceToOpenAI,
} from "../handlers/shared/format/openai-tools.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/**
 * Canonical reasoning-effort levels emitted by Claude Code via
 * `output_config.effort`. Every dialect maps these onto its provider's native
 * reasoning knob (or strips, when the provider has none).
 */
export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The seven canonical levels, ascending — also the membership set for validation. */
const EFFORT_ORDER: EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The canonical levels in ascending order. Exported so dialects can CLAMP a
 * requested level into whatever subset a model actually advertises (the slim
 * catalog's `reasoning.efforts`) instead of sending a level the model has no
 * mode for.
 */
export const EFFORT_LEVELS: readonly EffortLevel[] = EFFORT_ORDER;

/** Narrow an arbitrary catalog/config string to a canonical {@link EffortLevel}. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_ORDER.includes(value as EffortLevel);
}

/**
 * Reasoning knobs that belong to an OpenAI-shaped wire and must never ride an
 * Anthropic Messages request.
 *
 * Two of them (`enable_thinking`, `thinking_budget`) are DashScope's; the third
 * (`reasoning_effort`) is OpenAI's and is also accepted by DeepSeek's and xAI's
 * own APIs. Measured against Alibaba Token Plan's Anthropic endpoint on 2026-08-02:
 * a top-level `reasoning_effort` of `"max"` AND of `"banana"` both return 200,
 * i.e. the field is silently ignored — a dialect emitting it there believes it
 * set the depth and did nothing.
 */
const NON_ANTHROPIC_REASONING_FIELDS = [
  "reasoning_effort",
  "enable_thinking",
  "thinking_budget",
] as const;

/**
 * Smallest reasoning budget a provider will accept.
 *
 * Anthropic's Messages API documents `budget_tokens >= 1024`, and the
 * Anthropic-compatible endpoints claudish speaks to inherit it. Below this a
 * budget is not "small", it is invalid, so the correct move is to stop
 * expressing depth as a budget rather than to send a smaller number.
 */
export const MIN_THINKING_BUDGET = 1024;

/**
 * Output tokens reserved for the answer itself when a budget is clamped.
 *
 * A budget equal to the ceiling is rejected outright (`max_completion_tokens
 * [32000] must be greater than thinking_budget [38912]` is the same rule seen
 * from the other side), and a budget one token under it leaves a model that has
 * thought and cannot speak. Reserving a real slice keeps a clamped request
 * useful rather than merely legal.
 */
export const ANSWER_TOKEN_RESERVE = 1024;

/**
 * The output ceiling a reasoning budget must fit under.
 *
 * Read from the ORIGINAL Claude-format request first, because `max_tokens` is
 * the field every wire derives its own ceiling from and the only one guaranteed
 * to be present before the payload is built. The payload is consulted second,
 * under all three names the wires use, so a dialect that runs after its
 * converter still sees the number actually being sent.
 *
 * Deliberately NOT the catalog's `maxOutputTokens`: the provider validates the
 * budget against the ceiling in the request, so that is the number that decides
 * whether the pair is legal.
 */
export function outputCeilingOf(originalRequest: any, payload?: any): number | undefined {
  const candidates = [
    originalRequest?.max_tokens,
    payload?.max_tokens,
    payload?.max_completion_tokens,
    payload?.max_output_tokens,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * Fit a reasoning budget under an output ceiling.
 *
 * Returns:
 * - the budget unchanged when it already fits,
 * - a smaller budget when the ceiling requires one,
 * - `undefined` when there is no budget to send in the first place (effort
 *   `max` omits it so the model uses its own maximum), or when no ceiling is
 *   known and the caller's number therefore stands,
 * - `"no-room"` when the ceiling cannot hold a legal budget AND leave room to
 *   answer. That is a distinct outcome from "no budget": the caller must stop
 *   expressing depth as a budget, not send the request without one.
 */
export function clampThinkingBudget(
  budget: number | undefined,
  ceiling: number | undefined
): number | undefined | "no-room" {
  if (budget === undefined) return undefined;
  if (ceiling === undefined) return budget;

  const allowed = ceiling - ANSWER_TOKEN_RESERVE;
  if (allowed < MIN_THINKING_BUDGET) return "no-room";
  return Math.min(budget, allowed);
}

export interface AdapterResult {
  /** Cleaned text content (with XML/special formats removed) */
  cleanedText: string;
  /** Extracted tool calls from special formats */
  extractedToolCalls: ToolCall[];
  /** Whether any transformation was done */
  wasTransformed: boolean;
}

export abstract class BaseAPIFormat implements APIFormat, ModelDialect {
  protected modelId: string;

  /**
   * The WIRE FORMAT this instance is composed with — i.e. the shape of the
   * payload a Layer 2 dialect is being handed, which is decided by the Layer 1
   * FormatConverter, not by the model's name.
   *
   * A dialect is auto-selected by model name (see DialectManager), so on its
   * own it cannot tell whether the same model is being reached over the
   * OpenAI/Chat-Completions wire or the Anthropic Messages wire. Providers do
   * exist that serve one model family over both (Qwen: DashScope
   * OpenAI-compatible vs. Alibaba Token Plan's /apps/anthropic/v1/messages), and their
   * reasoning knobs are named differently on each.
   *
   * DIALECTS SHOULD NOT READ THIS. It is consumed by {@link prepareRequest}'s
   * template and by {@link shouldFilterThinking}, which is what makes the
   * Anthropic-wire behaviour automatic for every dialect — including ones
   * written before the endpoint existed. A dialect that branches on it is
   * re-creating the bug this replaced (see the qwen-token-plan session log).
   *
   * `undefined` means "not composed / caller didn't say" — treat it as the
   * historical OpenAI default so nothing changes for existing call sites.
   */
  protected readonly wireFormat?: StreamFormat;

  /**
   * The parser the RESPONSE will actually be fed to, as ComposedHandler
   * resolves it — `provider.overrideStreamFormat()` first, then the adapters.
   *
   * Distinct from {@link wireFormat}, which is the REQUEST shape. They are
   * usually the same and are not always: a custom endpoint may declare
   * `{transport:"openai", streamFormat:"anthropic-sse"}`, and then the payload
   * is OpenAI-shaped (so the encoder arms) while the parser is the Anthropic
   * passthrough (which has no decode map). Only {@link getToolNameLimit} reads
   * this; nothing else should branch on it.
   *
   * Set ONCE, from the ComposedHandler constructor. It is a property of the
   * composition, not of the request — `resolveStreamFormat()` does not look at
   * the request at all — so this carries none of the per-request race that made
   * {@link toolNameBindings} per-request.
   */
  private responseWireFormat?: StreamFormat;

  /**
   * Tell this adapter which parser will read the response it is helping build.
   *
   * Called once per handler, at construction. A delegating adapter that runs an
   * inner adapter's `prepareRequest` MUST override this and pass it on, or the
   * inner adapter encodes names into a wire that cannot decode them
   * (OpenRouterAPIFormat and LocalAdapter both do).
   */
  setResponseWireFormat(format: StreamFormat | undefined): void {
    this.responseWireFormat = format;
  }

  /**
   * This request's tool-name bindings, in both directions.
   *
   * PER REQUEST, and REPLACED rather than cleared — never mutated after it has
   * been handed out. Handlers are cached one per model while `claudish serve`
   * hosts several conversations, so the instance is shared: clearing the map
   * that request A's parser is still decoding with, because request B started,
   * turns A's tool calls into names nothing recognises — and `keepOnlyRealTools`
   * then drops them with no error anywhere. `adapters.md` records the same
   * hazard class for `getHeaders`. `reset()` mints a new pair; the old one stays
   * whole for whoever is still reading it.
   */
  protected toolNameBindings: ToolNameBindings = newToolNameBindings();

  constructor(modelId: string, wireFormat?: StreamFormat) {
    this.modelId = modelId;
    this.wireFormat = wireFormat;
  }

  /** The model ID this format/dialect was constructed for. */
  getModelId(): string {
    return this.modelId;
  }

  /** The composed wire format, or undefined when none was supplied. */
  getWireFormat(): StreamFormat | undefined {
    return this.wireFormat;
  }

  /**
   * Process text content and extract any model-specific tool call formats
   * @param textContent - The raw text content from the model
   * @param accumulatedText - The accumulated text so far (for multi-chunk parsing)
   * @returns Cleaned text and any extracted tool calls
   */
  abstract processTextContent(textContent: string, accumulatedText: string): AdapterResult;

  /**
   * Check if this format/dialect should be used for the given model
   */
  abstract shouldHandle(modelId: string): boolean;

  /**
   * Get name for logging
   */
  abstract getName(): string;

  /**
   * Repair a request that a provider rejected because of an OPTIONAL parameter
   * this format/dialect added speculatively. See `ModelDialect` for the full
   * rationale; ComposedHandler calls it at most once per request.
   *
   * The base implementation covers the sampling controls
   * {@link applyOpenAISamplingParams} forwards. A dialect that overrides this
   * for its own parameter MUST end by delegating to `super`, or it silently
   * removes that cover for its own models (GrokModelDialect does).
   */
  recoverFromRejection(payload: any, errorText: string): { payload: any; note: string } | null {
    return this.recoverFromSamplingParamRejection(payload, errorText);
  }

  /**
   * Drop whichever of {@link OPTIONAL_SAMPLING_PARAMS} this 4xx named, or
   * return null when it named none.
   *
   * Narrow on purpose: a missed recovery is a visible failed request, while a
   * wrong one silently strips a parameter the model did accept.
   */
  protected recoverFromSamplingParamRejection(
    payload: any,
    errorText: string
  ): { payload: any; note: string } | null {
    if (!payload) return null;
    const present = OPTIONAL_SAMPLING_PARAMS.filter((p) => payload[p] !== undefined);
    if (present.length === 0) return null;

    const rejected = rejectedOptionalParams(errorText, present);
    if (rejected.length === 0) return null;

    const next = { ...payload };
    for (const p of rejected) delete next[p];
    return { payload: next, note: `dropped ${rejected.join(", ")} for ${this.modelId}` };
  }

  /**
   * Forward the two sampling controls Claude Code sends that every
   * OpenAI-shaped builder in this tree used to drop: `stop_sequences` → `stop`,
   * and `top_p`.
   *
   * `stop` matters more than it looks. Claude Code's own classifier requests
   * carry stop sequences, and a relay that never receives them keeps generating
   * past the point the caller said to stop — which reads as a slow, rambling
   * model rather than as a dropped parameter. `anthropic-api-format.ts` already
   * forwards `stop_sequences` on the Anthropic wire, so this closes the
   * OpenAI-shaped half only.
   *
   * Both are OPTIONAL parameters sent speculatively:
   * {@link recoverFromRejection} drops whichever one a strict relay rejects and
   * the request is retried once.
   *
   * No cap is applied to the sequence count. OpenAI documents a limit of four,
   * but capping here would silently discard the fifth sequence — the failure
   * mode this repo keeps paying for — whereas sending all of them fails loudly
   * and recovers.
   *
   * @param payload - the provider payload being built (mutated in place)
   * @param claudeRequest - the inbound Anthropic-shaped request
   */
  protected applyOpenAISamplingParams(payload: any, claudeRequest: any): void {
    if (!payload || !claudeRequest) return;

    const sequences = claudeRequest.stop_sequences;
    if (Array.isArray(sequences)) {
      // An empty string is not a stop sequence anywhere, and strict relays 400
      // on one. Dropping the empty entries keeps the real ones.
      const usable = sequences.filter((s: unknown) => typeof s === "string" && s.length > 0);
      if (usable.length > 0) payload.stop = usable;
    }

    if (claudeRequest.top_p !== undefined && claudeRequest.top_p !== null) {
      payload.top_p = claudeRequest.top_p;
    }
  }

  /**
   * Maximum tool name length this request's wire accepts, or null for no limit.
   *
   * THE QUESTION IS "CAN THE RESPONSE BE DECODED", NOT "IS THE REQUEST
   * OpenAI-SHAPED". Those come apart, and when they do the encoder runs with no
   * decoder behind it and Claude Code receives a tool name it never advertised.
   * `wireDecodesToolNames` is the one list of parsers that are handed this
   * request's map; a wire absent from it gets null and nothing is encoded. The
   * cost of not encoding is a loud 400 on a >64-char name; the cost of encoding
   * without a decoder is a silently dropped tool call.
   *
   * OpenAI validates a function name against `^[a-zA-Z0-9_-]{1,64}$` on both of
   * its shapes, so 64 is that limit and not a guess about any one model. Before
   * item 7 this method returned null on every adapter except Xiaomi, so nothing
   * truncated at all — and a real 65-character MCP name
   * (`mcp__plugin_browser-use_browser-use__retry_with_browser_use_agent`) failed
   * the WHOLE request, not just that tool.
   */
  getToolNameLimit(): number | null {
    // Precedence mirrors ComposedHandler.resolveStreamFormat(), which is what
    // actually picks the parser: the provider's RESPONSE override first, then
    // the composed request wire, then the dialect's own guess. A dialect
    // self-selects by model name and its `getStreamFormat()` answers
    // "openai-sse" whatever it was composed into, so it is the last word, never
    // the first.
    const wire = this.responseWireFormat ?? this.wireFormat ?? this.getStreamFormat();
    return wireDecodesToolNames(wire) ? OPENAI_TOOL_NAME_LIMIT : null;
  }

  /**
   * Maximum number of tools this API accepts in a single request. Returns null
   * if no limit (default). OpenAI's Chat Completions API hard-caps the `tools`
   * array at 128 — exceeding it fails the whole request with HTTP 400
   * "Invalid 'tools': array too long". The ComposedHandler head-slices the
   * converted tools to this count so a session with many MCP tools still works
   * (Claude Code's built-in tools come first and are preserved).
   */
  getMaxToolCount(): number | null {
    return null;
  }

  /**
   * This request's decode map (encoded → original).
   *
   * Read it ONCE, immediately after `prepareRequest`, and thread that reference
   * onward — do not re-read it after an `await`. `reset()` replaces the
   * bindings, so a later read on a shared handler returns the NEXT request's
   * map.
   */
  getToolNameMap(): Map<string, string> {
    return this.toolNameBindings.byEncoded;
  }

  /**
   * Restore a possibly-encoded tool name to its original.
   */
  restoreToolName(name: string): string {
    return this.toolNameBindings.byEncoded.get(name) || name;
  }

  /**
   * Handle any request preparation before sending to the model.
   *
   * TEMPLATE METHOD — do NOT override this in a dialect or format. Override
   * {@link prepareRequestCommon} (wire-agnostic work: tool-name truncation,
   * temperature clamping, …) and/or {@link applyNativeReasoning} (the reasoning
   * knob of the model's OWN provider API) instead.
   *
   * The split exists because WHICH reasoning knob a request must carry is a
   * property of the WIRE, not of the model family — and dialects are selected
   * by model NAME (see DialectManager), so a dialect cannot know the wire.
   * Alibaba's Alibaba Token Plan is the worked example: one Anthropic-compatible
   * endpoint serving qwen3.x AND glm-5.2 AND deepseek-v4-*, i.e. three
   * different dialects reaching the SAME wire. Before this hoist only
   * QwenModelDialect had been taught the wire, so glm/deepseek on that endpoint
   * emitted their own APIs' knobs — which that endpoint silently ignores — and
   * leaked their reasoning into the chat as prose.
   *
   * On the Anthropic wire the base therefore has the LAST WORD: the dialect's
   * native reasoning emission is skipped, OpenAI-shaped knobs are stripped even
   * if some other hook set them, and {@link applyAnthropicWireReasoning}
   * (catalog-driven) supplies the knob. Every other wire is byte-identical to
   * the pre-hoist behaviour.
   *
   * @param request - The provider payload being prepared
   * @param originalRequest - The original Claude-format request
   * @returns The modified request payload
   */
  prepareRequest(request: any, originalRequest: any): any {
    const prepared = this.prepareRequestCommon(request, originalRequest) ?? request;

    // Tool-name encoding lives in the TEMPLATE, not in the hook, so that every
    // adapter gets it exactly once and no subclass can lose it by overriding
    // `prepareRequestCommon` without calling super — which is how it came to be
    // on OpenAIAPIFormat and Xiaomi alone. One call site for the whole tree.
    this.encodeToolNames(prepared);

    if (!this.isAnthropicWire()) {
      return this.applyNativeReasoning(prepared, originalRequest) ?? prepared;
    }

    this.stripNonAnthropicReasoningFields(prepared);
    return this.applyAnthropicWireReasoning(prepared, originalRequest) ?? prepared;
  }

  /**
   * Wire-agnostic request preparation — runs on EVERY wire.
   *
   * This is where non-reasoning quirks belong: tool-name truncation, tool-count
   * caps, temperature clamping, delegation to an inner adapter. Anything that
   * emits a reasoning knob belongs in {@link applyNativeReasoning} instead, so
   * the Anthropic wire can substitute its own.
   */
  protected prepareRequestCommon(request: any, _originalRequest: any): any {
    return request;
  }

  /**
   * The reasoning knob of the model's OWN provider API (DashScope's
   * `enable_thinking`, OpenAI/xAI/DeepSeek's `reasoning_effort`, GLM's
   * `thinking` toggle, …). Runs on every wire EXCEPT `anthropic-sse`.
   *
   * Override this in a dialect. Do not branch on the wire inside it — that is
   * precisely the coupling this split removes.
   */
  protected applyNativeReasoning(request: any, _originalRequest: any): any {
    return request;
  }

  /** True when this instance was composed with the Anthropic Messages wire. */
  protected isAnthropicWire(): boolean {
    return this.wireFormat === "anthropic-sse";
  }

  /**
   * Remove reasoning knobs that only exist on OpenAI-shaped wires.
   *
   * Belt-and-braces: with the hook split nothing should set them here, but a
   * dialect that puts its reasoning emission in the wrong hook (or an inner
   * adapter reached through delegation) would otherwise ship a field the
   * Anthropic endpoint ignores while believing depth was set.
   */
  protected stripNonAnthropicReasoningFields(request: any): void {
    if (!request) return;
    for (const field of NON_ANTHROPIC_REASONING_FIELDS) {
      if (request[field] !== undefined) delete request[field];
    }
  }

  /**
   * Reasoning knob for the Anthropic Messages wire — the SINGLE place to tune
   * it, for every dialect.
   *
   * The SHAPE of the knob is a PER-MODEL fact read from the slim catalog's
   * `reasoning` record, never from a table here. Alibaba's Alibaba Token Plan roster is
   * why a fixed ladder is wrong: `qwen3.7-plus` is `control: "toggle"` (it
   * exposes no depth parameter at all, so a `budget_tokens` would be an
   * invented field), while `glm-5.2` and `deepseek-v4-pro` on the SAME endpoint
   * are `control: "effort"` with their own restricted level sets
   * (`["xhigh","high"]`, `["max","high"]`) that do not contain every claudish
   * level.
   *
   * `output_config.effort` is the field Claude Code itself sends to an
   * Anthropic Messages endpoint and which AnthropicAPIFormat drops when
   * rebuilding the payload. Restoring it (clamped) is how a discrete level
   * reaches a model whose only other knob is `budget_tokens`, which these
   * models do not accept. Verified live 2026-08-02 against Alibaba Token Plan:
   * `output_config.effort: "high"` → 200, `"banana"` → 400 naming the seven
   * accepted levels, so the field IS read.
   *
   * Fail-soft by construction: an unknown model / cold cache yields `undefined`
   * metadata and falls through to the generic budget ladder. No path throws and
   * no request is ever blocked on catalog data.
   *
   * Override only for an endpoint whose enable value is outside the Anthropic
   * vocabulary (MiniMax answers `adaptive`, not `enabled`).
   */
  protected applyAnthropicWireReasoning(request: any, originalRequest: any): any {
    // ── Truthful unknown ────────────────────────────────────────────────────
    //
    // Checked FIRST, before the request's own effort signal, because an unknown
    // control makes every downstream branch a guess regardless of what was
    // asked for.
    //
    // There is no generic fallback here any more. The one that used to sit at
    // the bottom of this method emitted the effort ladder's token budget for any
    // model the catalog did not describe, which is how `qwen3.8-max` was sent
    // `budget_tokens: 38912` against a `max_tokens` of 32000 and rejected with
    // "max_completion_tokens [32000] must be greater than thinking_budget
    // [38912]" — a 400 before any inference, on a model the provider serves
    // perfectly well.
    //
    // A guessed knob is not a safe default. It is a claim about a wire contract
    // we have not read, and the failure lands on the newest models, which are
    // exactly the ones the catalog has not caught up with yet.
    //
    // `supportsThinking` is deliberately NOT consulted as a substitute. The
    // catalog publishes that flag even while reporting the status unknown
    // (`query-handler.ts` sets `reasoningStatus: "unknown"` and can still emit
    // `supportsThinking` from coarse capability data), so it is present exactly
    // where it proves nothing about the knob.
    const status = this.lookupReasoningStatus();
    if (status !== "known") {
      log(
        `[${this.getName()}] ${this.modelId} reasoning control ${status === "unknown" ? "unknown" : "absent from the catalog"} -> no reasoning parameter emitted`
      );
      return request;
    }

    const reasoning = this.lookupReasoningCapability();

    // Catalog is explicit that the model cannot reason — never switch it on.
    // This is a KNOWN answer, and the opposite instruction to the unknown case
    // above: there we say nothing, here we say off.
    if (reasoning?.supported === false) {
      request.thinking = { type: "disabled" };
      log(`[${this.getName()}] ${this.modelId} reports no reasoning support -> thinking: disabled`);
      return request;
    }

    const effort = this.resolveEffortLevel(originalRequest);
    // No effort signal at all: leave whatever Claude Code sent untouched. The
    // endpoint's own default is a better answer than a level we invented.
    if (!effort) return request;

    if (effort === "none" || effort === "minimal") {
      // `mandatory` means the model cannot run with reasoning off, so a
      // `disabled` here is a request the provider must reject. Honour the
      // intent as far as the model allows: the lowest level it advertises.
      if (reasoning?.mandatory) {
        return this.enableAnthropicEffort(request, effort, reasoning, "mandatory reasoning");
      }
      request.thinking = { type: "disabled" };
      log(`[${this.getName()}] effort ${effort} -> thinking.type: disabled for ${this.modelId}`);
      return request;
    }

    // ── Control-driven dispatch ─────────────────────────────────────────────
    //
    // `control` is authoritative and is read BEFORE `supportsBudgetTokens`.
    // That order is the rule: a model may advertise discrete levels AND accept a
    // budget, and in that case the levels are the control the vendor documents.
    // The previous code tested `control === "budget" || supportsBudgetTokens`,
    // so an optional budget capability silently overrode an effort control and
    // sent a token count to a model whose knob is a level.
    const control = reasoning?.control;
    const advertisesEfforts = (reasoning?.efforts?.length ?? 0) > 0;

    if (control === "effort" || (control === undefined && advertisesEfforts)) {
      return this.enableAnthropicEffort(request, effort, reasoning, "catalog: effort-controlled");
    }

    if (control === "budget" || (control === undefined && reasoning?.supportsBudgetTokens)) {
      return this.enableAnthropicBudget(request, effort, originalRequest, reasoning);
    }

    // `toggle`, `adaptive`, or a control this build does not recognise:
    // reasoning is on/off only. Emit the switch and no depth.
    request.thinking = { type: "enabled" };
    this.stripAnthropicEffortField(request);
    log(
      `[${this.getName()}] effort ${effort} -> thinking: enabled (no depth knob; catalog control=${control ?? "unspecified"}) for ${this.modelId}`
    );
    return request;
  }

  /**
   * Emit a discrete level, clamped into what the model advertises.
   *
   * Never also emits a budget: on this wire `output_config.effort` and
   * `thinking.budget_tokens` are two spellings of the same intent, and sending
   * both is a self-contradicting payload.
   */
  private enableAnthropicEffort(
    request: any,
    effort: EffortLevel,
    reasoning: ReasoningCapability | undefined,
    why: string
  ): any {
    const level = reasoning ? this.clampToAdvertisedEffort(effort, reasoning) : undefined;
    request.thinking = { type: "enabled" };
    if (level) {
      request.output_config = { ...(request.output_config ?? {}), effort: level };
    }
    log(
      `[${this.getName()}] effort ${effort} -> thinking: enabled, output_config.effort: ${level ?? "(none advertised)"} for ${this.modelId} (${why}; advertised: ${reasoning?.efforts?.join("/") ?? "none"})`
    );
    return request;
  }

  /**
   * Emit a token budget, clamped to fit under the request's output ceiling.
   *
   * The ceiling is the REQUEST's `max_tokens`, not the catalog's
   * `maxOutputTokens`, because `max_tokens` is the number the provider
   * validates the budget against — it is the one we are about to send.
   */
  private enableAnthropicBudget(
    request: any,
    effort: EffortLevel,
    originalRequest: any,
    reasoning: ReasoningCapability | undefined
  ): any {
    const requested = this.effortToThinkingTokenBudget(effort);
    const ceiling = outputCeilingOf(originalRequest, request);
    const budget = clampThinkingBudget(requested, ceiling);

    if (budget === "no-room") {
      // The ceiling cannot hold a legal budget AND leave room for an answer.
      // A mandatory-reasoning model still has to reason, so send the plain
      // on-switch and let the provider pick its own depth; anything else is a
      // payload it must reject.
      if (reasoning?.mandatory) {
        request.thinking = { type: "enabled" };
      } else {
        request.thinking = { type: "disabled" };
      }
      this.stripAnthropicEffortField(request);
      log(
        `[${this.getName()}] effort ${effort} -> budget ${requested ?? "(model max)"} does not fit under max_tokens ${ceiling}; sent thinking.type: ${request.thinking.type} for ${this.modelId}`
      );
      return request;
    }

    request.thinking =
      budget === undefined ? { type: "enabled" } : { type: "enabled", budget_tokens: budget };
    // A budget and a level are mutually exclusive expressions of depth.
    this.stripAnthropicEffortField(request);
    log(
      `[${this.getName()}] effort ${effort} -> thinking: enabled, budget_tokens: ${budget ?? "(model max)"}${
        budget !== undefined && budget !== requested
          ? ` (clamped from ${requested} under max_tokens ${ceiling})`
          : ""
      } for ${this.modelId} (catalog: budget-controlled)`
    );
    return request;
  }

  /**
   * Remove `output_config.effort` from a payload that expresses depth another
   * way, dropping the container when it is left empty.
   */
  private stripAnthropicEffortField(request: any): void {
    if (!request?.output_config || typeof request.output_config !== "object") return;
    if (request.output_config.effort === undefined) return;
    delete request.output_config.effort;
    if (Object.keys(request.output_config).length === 0) delete request.output_config;
  }

  /**
   * Clamp a requested level into the set a model actually advertises.
   *
   * - Advertised exactly → send it.
   * - Otherwise → the nearest advertised level, ties resolved UPWARD so a model
   *   is never silently under-driven (asking `low` of a model whose floor is
   *   `high` must get `high`, not nothing).
   * - No usable level list → the catalog's `defaultEffort`, else undefined
   *   (caller then sends the plain on-switch).
   *
   * Levels the catalog reports but claudish has no name for are ignored rather
   * than passed through — the vocabulary is {@link EFFORT_LEVELS}.
   *
   * ## Why clamping is load-bearing, not cosmetic (GLM-5.2)
   *
   * An endpoint ACCEPTING a level is not the same as the model DISTINGUISHING
   * it. Verified 2026-08-02 against the Z.AI coding endpoint: every one of the
   * seven canonical levels (`none`…`max`) is accepted — `reasoning_effort:
   * "banana"` returns a 400 that lists all seven — yet GLM-5.2 documents
   * exactly TWO (https://docs.z.ai/guides/llm/glm-5.2): `max` and `high`, with
   * `max` the default, and explicitly states that **any value other than
   * `high` runs at Max**.
   *
   * So the model's real behaviour is a one-bit test — "is this string `high`?"
   * — and passing an unadvertised level through unchanged INVERTS the user's
   * intent: a request for `low` is not `high`, therefore it runs at Max, and
   * asking for less thinking buys the most. Clamping `low → high` is what keeps
   * "less effort" from meaning "maximum effort". This is also why ties resolve
   * upward rather than downward: the failure mode of guessing too high is a
   * slower turn, the failure mode of falling off the advertised set entirely is
   * a silent jump to the endpoint's default.
   *
   * ## Known catalog discrepancy (fix belongs in models-index, not here)
   *
   * The slim catalog currently reports `efforts: ["xhigh","high"]`,
   * `defaultEffort: "high"` for glm-5.2, while the vendor docs say
   * `["max","high"]` with default `max`. `xhigh` is harmless TODAY only by
   * accident — anything that isn't `high` means Max, so `xhigh` and `max`
   * produce the same behaviour. It is still wrong data. The correction belongs
   * in the models-index catalog; do NOT hardcode a per-model override here, or
   * claudish stops reflecting the catalog it is supposed to be driven by.
   */
  protected clampToAdvertisedEffort(
    requested: EffortLevel,
    reasoning: ReasoningCapability
  ): EffortLevel | undefined {
    // `--effort` pins the level VERBATIM — skip the clamp entirely. This is an
    // escape hatch, and it can produce a 400: the clamp is what normally keeps
    // a level the model does not advertise off the wire. Asking for it anyway
    // is the user's explicit choice.
    // `--effort` pins the level VERBATIM — skip the clamp entirely. This is an
    // escape hatch, and it can produce a 400: the clamp is what normally keeps
    // a level the model does not advertise off the wire. Asking for it anyway
    // is the user's explicit choice.
    if (this.pinnedEffort) return this.pinnedEffort;
    const advertised = (reasoning.efforts ?? []).filter(isEffortLevel);
    if (advertised.length === 0) {
      return isEffortLevel(reasoning.defaultEffort) ? reasoning.defaultEffort : undefined;
    }
    if (advertised.includes(requested)) return requested;

    const target = EFFORT_ORDER.indexOf(requested);
    let best = advertised[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of advertised) {
      const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - target);
      // `<=` semantics: break ties toward the later (higher) level, since
      // `advertised` is scanned in catalog order which is not guaranteed sorted.
      if (
        distance < bestDistance ||
        (distance === bestDistance && EFFORT_ORDER.indexOf(candidate) > EFFORT_ORDER.indexOf(best))
      ) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Slim-catalog reasoning metadata for this model, or undefined. Never throws. */
  protected lookupReasoningCapability(): ReasoningCapability | undefined {
    try {
      return lookupModelReasoning(this.modelId);
    } catch {
      // lookupModelReasoning throws only on a provider-routed id, which a
      // dialect should never see. Stay fail-soft regardless.
      return undefined;
    }
  }

  /**
   * Whether the catalog KNOWS this model's reasoning control.
   *
   * Fail-soft to `undefined`, which callers must treat exactly like
   * `"unknown"`: emit no reasoning parameter. A lookup that threw has told us
   * nothing, and "nothing" must never become a guessed knob.
   */
  protected lookupReasoningStatus(): "known" | "unknown" | undefined {
    try {
      return lookupModelReasoningStatus(this.modelId);
    } catch {
      return undefined;
    }
  }

  /**
   * Effort → token budget (claudish convention), shared by DashScope's
   * `thinking_budget` and Anthropic's `thinking.budget_tokens`. `max` omits the
   * budget so the model uses its full max CoT length.
   */
  protected effortToThinkingTokenBudget(effort: EffortLevel): number | undefined {
    switch (effort) {
      case "low":
        return 2048;
      case "medium":
        return 8192;
      case "high":
        return 24576;
      case "xhigh":
        return 38912;
      case "max":
        return undefined; // omit → model max
      default:
        return 8192;
    }
  }

  /**
   * `--effort <level>`: a user-pinned effort that bypasses BOTH the request's
   * own signal and the per-model catalog clamp.
   *
   * Safe as instance state because every ComposedHandler owns its dialect —
   * `resolveModelDialect()` builds a fresh object per call and never caches —
   * so a pin set for one model cannot leak into another.
   *
   * Only the seven canonical levels are accepted. A provider-specific value
   * that is not one of them cannot flow through the `EffortLevel`-typed
   * pipeline at all; `--model-params reasoning_effort=<value>` is the tool for
   * that, and it lands on the payload after every adapter has finished.
   */
  protected pinnedEffort?: EffortLevel;

  /** Install the `--effort` override for this handler. undefined clears it. */
  setEffortOverride(level: EffortLevel | undefined): void {
    this.pinnedEffort = level;
  }

  /**
   * Normalize Claude Code's effort signal to a canonical {@link EffortLevel}
   * (or undefined when the request carries no effort hint).
   *
   * Priority:
   *  1. `output_config.effort` — the modern string level Claude Code (Opus
   *     4.7/4.8) sends (none/minimal/low/medium/high/xhigh/max).
   *  2. Legacy `thinking.budget_tokens` — older clients sent a token budget;
   *     bucket it into a canonical level.
   *
   * Every dialect calls this, then clamps the result to its provider's
   * accepted value set (or strips, when the provider has no reasoning knob).
   */
  protected resolveEffortLevel(originalRequest: any): EffortLevel | undefined {
    // `--effort` wins over anything the request carries. Checked first so the
    // legacy budget_tokens fallback below cannot override an explicit pin.
    if (this.pinnedEffort) return this.pinnedEffort;
    const lvl = originalRequest?.output_config?.effort;
    if (typeof lvl === "string") {
      const lower = lvl.toLowerCase();
      if (EFFORT_ORDER.includes(lower as EffortLevel)) {
        return lower as EffortLevel;
      }
    }

    // Legacy fallback: thinking.budget_tokens → bucketed effort.
    const budget = originalRequest?.thinking?.budget_tokens;
    if (typeof budget === "number") {
      if (budget <= 0) return "none";
      if (budget < 4000) return "low";
      if (budget < 16000) return "medium";
      if (budget < 32000) return "high";
      return "xhigh";
    }

    return undefined;
  }

  /**
   * Reset internal state between requests (prevents state contamination)
   */
  reset(): void {
    // REPLACE, never clear: a parser from the previous request may still be
    // decoding with the old map. See {@link toolNameBindings}.
    this.toolNameBindings = newToolNameBindings();
  }

  // ─── ComposedHandler integration (Phase 1c) ───────────────────────
  // These methods have sensible defaults so existing implementations continue
  // to work unchanged. Override in specific classes as needed.

  /**
   * Convert Claude-format messages to the target API format.
   * Default: delegates to convertMessagesToOpenAI.
   * Override for non-OpenAI formats (e.g., Gemini parts-based format).
   */
  convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    return convertMessagesToOpenAI(claudeRequest, this.modelId, filterIdentityFn);
  }

  /**
   * Convert Claude tools to the target API format.
   * Default: OpenAI function-calling format.
   */
  convertTools(claudeRequest: any, summarize = false): any[] {
    return convertToolsToOpenAI(claudeRequest, summarize);
  }

  /**
   * Build the full request payload for the target API.
   * Default: OpenAI Chat Completions format.
   * Override for Gemini (generateContent), Anthropic passthrough, etc.
   */
  buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      stream: true,
    };
    if (tools.length > 0) {
      payload.tools = tools;

      // This builder had no tool_choice handling at ALL, which is easy to miss
      // because it holds no copy of the mapping to grep for. It is not dead:
      // `ComposedHandler.getAdapter()` is `explicitAdapter || resolvedDialect`,
      // so every provider profile that supplies no explicit Layer-1 format
      // builds its payload here — and dropped the caller's tool_choice
      // entirely, not just `any`.
      const toolChoice = mapToolChoiceToOpenAI(claudeRequest.tool_choice);
      if (toolChoice !== undefined) {
        payload.tool_choice = toolChoice;
      }
    }
    if (claudeRequest.max_tokens) {
      payload.max_tokens = claudeRequest.max_tokens;
    }
    if (claudeRequest.temperature !== undefined) {
      payload.temperature = claudeRequest.temperature;
    }
    this.applyOpenAISamplingParams(payload, claudeRequest);
    return payload;
  }

  /**
   * The stream format this format's target API returns.
   * Default: "openai-sse" (most common format).
   * Override for Anthropic passthrough ("anthropic-sse"), Gemini ("gemini-sse"), etc.
   */
  getStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  /**
   * Context window size for this model (tokens).
   * Used for token tracking and context-left-percent calculation.
   */
  getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  /**
   * Pricing info for this model. Used by TokenTracker.
   * Default: delegates to the centralized getModelPricing.
   */
  getPricing(providerName: string): ModelPricing {
    return getModelPricing(providerName, this.modelId);
  }

  /**
   * Whether this model supports vision/image input.
   */
  supportsVision(): boolean {
    return true;
  }

  /**
   * Whether thinking blocks should be filtered from the SSE response.
   *
   * TRUE ON THE ANTHROPIC WIRE, for every dialect — unsigned thinking is a
   * property of the ENDPOINT, not of any model family.
   *
   * An Anthropic `thinking` block carries a cryptographic `signature` that
   * Claude Code verifies and round-trips on later turns. A third-party
   * Anthropic-compatible endpoint cannot produce one: captured live from Qwen
   * Plan (/apps/anthropic/v1/messages) for qwen3.8-max-preview and
   * qwen3.7-plus,
   *
   *     content_block_start: (index 0, type 'thinking', signature '')
   *     signature_delta count: 1, total signature length: 0
   *
   * so block[0] is a structurally valid thinking block with an EMPTY signature.
   * Claude Code cannot treat that as a first-class thinking block, so the
   * reasoning degrades into ordinary inline prose in the chat. We cannot forge a
   * signature, so the only correct move is to drop the block:
   * `createAnthropicPassthroughStream` strips it and RE-INDEXES the remaining
   * content blocks to a contiguous 0,1,2… sequence.
   *
   * Gating on the WIRE rather than a model roster is deliberate — a hardcoded
   * list would silently miss the next model added to a multi-vendor plan, which
   * is exactly how `qtoken@glm-5.2` and `qtoken@deepseek-v4-pro` kept leaking after
   * `qtoken@qwen3.7-plus` was fixed. `wireFormat` is the composition hint
   * ComposedHandler supplies from `explicitAdapter.getStreamFormat()`.
   *
   * NOTE this is keyed on the composed `wireFormat`, which is supplied ONLY by
   * DialectManager (to every adapter it builds, Layer 1 formats included).
   * AnthropicAPIFormat is never built there — the provider profiles construct
   * it explicitly — so it keeps `false`, and a genuinely Anthropic backend
   * reached through it (Vertex serving real `claude-*`, whose signatures are
   * valid) is untouched.
   *
   * Override to force `true` on a provider that is only ever reached over this
   * wire and therefore need not depend on the hint being supplied (MiniMax).
   */
  shouldFilterThinking(): boolean {
    return this.isAnthropicWire();
  }

  /**
   * Rewrite every tool name in this payload into what the wire accepts, and
   * record the way back.
   *
   * THREE places carry a tool name, and all three must agree or the request is
   * worse than it was before:
   *
   *   1. `tools[]` — what the model may call. Both shapes: Chat Completions
   *      `{type:"function", function:{name}}` and the Responses API's flat
   *      `{type:"function", name}`.
   *   2. The HISTORY — `messages[]` assistant `tool_calls`, and the Responses
   *      API's `input[]` `function_call` items. A history naming a tool that is
   *      not in `tools[]` is rejected by strict endpoints and confuses every
   *      other one.
   *   3. `tool_choice` — pointing at a name the model was never offered is a
   *      400 on the first forced-tool turn.
   *
   * Encoding runs on the BUILT payload rather than inside each builder because
   * that is where all three live, and because the map has to be minted
   * somewhere both the payload and the parser can see.
   *
   * Idempotent: an already-encoded name transforms to itself and is bound to
   * itself, so a delegating adapter that runs this after its inner adapter
   * already did changes nothing.
   */
  protected encodeToolNames(request: any): void {
    const limit = this.getToolNameLimit();
    if (!limit || !request) return;

    const encode = (name: string) => encodeToolName(name, limit, this.toolNameBindings);

    if (Array.isArray(request.tools)) {
      for (const tool of request.tools) {
        if (tool?.function?.name) {
          tool.function.name = encode(tool.function.name);
        } else if (tool?.name) {
          tool.name = encode(tool.name);
        }
      }
    }

    if (Array.isArray(request.messages)) {
      for (const msg of request.messages) {
        if (msg?.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
        for (const tc of msg.tool_calls) {
          if (tc?.function?.name) tc.function.name = encode(tc.function.name);
        }
      }
    }

    // Responses API history. `input` holds `function_call` items rather than an
    // assistant message with `tool_calls`, so the branch above cannot see them.
    if (Array.isArray(request.input)) {
      for (const item of request.input) {
        if (item?.type === "function_call" && item.name) item.name = encode(item.name);
      }
    }

    const choice = request.tool_choice;
    if (choice && typeof choice === "object") {
      // `{type:"function", function:{name}}` (chat) and `{type:"function", name}`
      // (responses). The string forms — "auto"/"none"/"required" — name nothing.
      if (choice.function?.name) {
        choice.function.name = encode(choice.function.name);
      } else if (choice.name) {
        choice.name = encode(choice.name);
      }
    }
  }
}

/**
 * Default format/dialect that does no transformation
 */
export class DefaultAPIFormat extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  shouldHandle(_modelId: string): boolean {
    return false; // Default is fallback
  }

  getName(): string {
    return "DefaultAPIFormat";
  }
}

// ─── Backward-compatible aliases ──────────────────────────────────────────────
// Keep old names as aliases so legacy code referencing them still compiles
// during the transition. These can be removed in a future cleanup pass.

/** @deprecated Use BaseAPIFormat */
export const BaseModelAdapter = BaseAPIFormat;
export type BaseModelAdapter = BaseAPIFormat;

/** @deprecated Use DefaultAPIFormat */
export const DefaultAdapter = DefaultAPIFormat;
export type DefaultAdapter = DefaultAPIFormat;
