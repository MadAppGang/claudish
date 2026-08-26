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
import { type ReasoningCapability, lookupModel, lookupModelReasoning } from "./model-catalog.js";
import type { ModelDialect } from "./model-dialect.js";
import { truncateToolName } from "./tool-name-utils.js";

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
import { convertToolsToOpenAI } from "../handlers/shared/format/openai-tools.js";

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
 * own APIs. Measured against Qwen Plan's Anthropic endpoint on 2026-08-02:
 * a top-level `reasoning_effort` of `"max"` AND of `"banana"` both return 200,
 * i.e. the field is silently ignored — a dialect emitting it there believes it
 * set the depth and did nothing.
 */
const NON_ANTHROPIC_REASONING_FIELDS = [
  "reasoning_effort",
  "enable_thinking",
  "thinking_budget",
] as const;

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
   * OpenAI-compatible vs. Qwen Plan's /apps/anthropic/v1/messages), and their
   * reasoning knobs are named differently on each.
   *
   * DIALECTS SHOULD NOT READ THIS. It is consumed by {@link prepareRequest}'s
   * template and by {@link shouldFilterThinking}, which is what makes the
   * Anthropic-wire behaviour automatic for every dialect — including ones
   * written before the endpoint existed. A dialect that branches on it is
   * re-creating the bug this replaced (see the qwen-cloud session log).
   *
   * `undefined` means "not composed / caller didn't say" — treat it as the
   * historical OpenAI default so nothing changes for existing call sites.
   */
  protected readonly wireFormat?: StreamFormat;

  /**
   * Map of truncated tool names back to original names.
   * Populated during prepareRequest() when tool names are truncated.
   */
  protected toolNameMap: Map<string, string> = new Map();

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
   * Optional: repair a request that a provider rejected because of an OPTIONAL
   * parameter this dialect added speculatively. See `ModelDialect` for the full
   * rationale; ComposedHandler calls it at most once per request.
   */
  recoverFromRejection?(payload: any, errorText: string): { payload: any; note: string } | null;

  /**
   * Maximum tool name length allowed by this model's API.
   * Returns null if no limit (default).
   */
  getToolNameLimit(): number | null {
    return null;
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
   * Get the tool name map (truncated -> original).
   * Use after prepareRequest() to get the mapping for response processing.
   */
  getToolNameMap(): Map<string, string> {
    return this.toolNameMap;
  }

  /**
   * Restore a potentially truncated tool name to its original.
   */
  restoreToolName(name: string): string {
    return this.toolNameMap.get(name) || name;
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
   * Alibaba's Qwen Plan is the worked example: one Anthropic-compatible
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
   * `reasoning` record, never from a table here. Alibaba's Qwen Plan roster is
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
   * models do not accept. Verified live 2026-08-02 against Qwen Plan:
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
    const reasoning = this.lookupReasoningCapability();

    // Catalog is explicit that the model cannot reason — never switch it on.
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
      request.thinking = { type: "disabled" };
      log(`[${this.getName()}] effort ${effort} -> thinking.type: disabled for ${this.modelId}`);
      return request;
    }

    // A token budget is only legitimate where the catalog says the model takes
    // one (`control: "budget"` / `supportsBudgetTokens`).
    if (reasoning && (reasoning.control === "budget" || reasoning.supportsBudgetTokens)) {
      return this.enableAnthropicThinkingWithBudget(request, effort, "catalog: budget-controlled");
    }

    // A discrete level: clamp into what this model actually advertises.
    const advertised = reasoning?.efforts?.length ? reasoning : undefined;
    if (advertised) {
      const level = this.clampToAdvertisedEffort(effort, advertised);
      request.thinking = { type: "enabled" };
      if (level) {
        request.output_config = { ...(request.output_config ?? {}), effort: level };
      }
      log(
        `[${this.getName()}] effort ${effort} -> thinking: enabled, output_config.effort: ${level ?? "(none advertised)"} for ${this.modelId} (advertised: ${advertised.efforts?.join("/")})`
      );
      return request;
    }

    // `control: "toggle"` (or an unrecognized control with no level list):
    // reasoning is on/off only. Emit the switch and nothing else.
    if (reasoning) {
      request.thinking = { type: "enabled" };
      log(
        `[${this.getName()}] effort ${effort} -> thinking: enabled (no depth knob; catalog control=${reasoning.control ?? "unknown"}) for ${this.modelId}`
      );
      return request;
    }

    // No catalog entry at all (cold cache, or a model newer than the catalog —
    // qwen3.8-max-preview is exactly this today). No information means keep the
    // generic behaviour rather than guess a narrower one.
    return this.enableAnthropicThinkingWithBudget(request, effort, "no catalog entry");
  }

  /** Enable Anthropic-wire thinking with the generic token-budget ladder. */
  private enableAnthropicThinkingWithBudget(request: any, effort: EffortLevel, why: string): any {
    const budget = this.effortToThinkingTokenBudget(effort);
    request.thinking =
      budget === undefined ? { type: "enabled" } : { type: "enabled", budget_tokens: budget };
    log(
      `[${this.getName()}] effort ${effort} -> thinking: enabled, budget_tokens: ${budget ?? "(model max)"} for ${this.modelId} (${why})`
    );
    return request;
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
    this.toolNameMap.clear();
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
    }
    if (claudeRequest.max_tokens) {
      payload.max_tokens = claudeRequest.max_tokens;
    }
    if (claudeRequest.temperature !== undefined) {
      payload.temperature = claudeRequest.temperature;
    }
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
   * is exactly how `qc@glm-5.2` and `qc@deepseek-v4-pro` kept leaking after
   * `qc@qwen3.7-plus` was fixed. `wireFormat` is the composition hint
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
   * Truncate tool names in the request payload if the model has a name length limit.
   * Handles both Chat Completions format ({type:"function", function:{name}})
   * and Responses API format ({type:"function", name}).
   * Stores the mapping in this.toolNameMap for reverse mapping in responses.
   */
  protected truncateToolNames(request: any): void {
    const limit = this.getToolNameLimit();
    if (!limit || !request.tools) return;

    for (const tool of request.tools) {
      const originalName = tool.function?.name || tool.name;
      if (originalName && originalName.length > limit) {
        const truncated = truncateToolName(originalName, limit);
        this.toolNameMap.set(truncated, originalName);
        if (tool.function?.name) {
          tool.function.name = truncated;
        } else if (tool.name) {
          tool.name = truncated;
        }
      }
    }
  }

  /**
   * Truncate tool names in assistant message history (for messages array).
   * This is needed because historical tool_use blocks in the conversation
   * may contain names that exceed the model's limit.
   */
  protected truncateToolNamesInMessages(messages: any[]): void {
    const limit = this.getToolNameLimit();
    if (!limit) return;

    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          if (name && name.length > limit) {
            const truncated = truncateToolName(name, limit);
            tc.function.name = truncated;
            if (!this.toolNameMap.has(truncated)) {
              this.toolNameMap.set(truncated, name);
            }
          }
        }
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
