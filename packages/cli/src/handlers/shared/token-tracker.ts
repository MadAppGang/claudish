/**
 * TokenTracker — unified token tracking and cost accounting.
 *
 * Replaces the 8 independent writeTokenFile implementations scattered
 * across handlers. Supports three token tracking strategies:
 *
 *   1. Standard (most handlers): assign input, accumulate output
 *   2. Accumulate-both (OllamaCloud): both input and output are accumulated
 *   3. Delta-aware (OpenAI): tracks input delta with race-condition detection
 *      for concurrent conversations sharing the same handler
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../logger.js";
import { getModelPricing, type ModelPricing } from "./remote-provider-types.js";

export interface TokenTrackerConfig {
  contextWindow: number;
  providerName: string;
  modelName: string;
  /** Display name for the provider (e.g., "OpenAI", "Gemini") */
  providerDisplayName?: string;
}

/**
 * The cached breakdown of a turn's input tokens, for COST ONLY. (S4-c)
 *
 * Every `update*` method below still takes the FULL context size as its
 * `inputTokens` argument — that number answers "how full is the conversation"
 * and drives the status line's occupancy bar. This object rides alongside and
 * answers a different question: how much of that context the provider served
 * from its prompt cache, and therefore may bill at a lower rate.
 *
 * Both counts are SUBSETS of `inputTokens`, not additions to it.
 */
export interface UsageCacheDetail {
  /** Tokens served from the provider's prompt cache this turn. */
  cacheReadTokens: number;
  /** Tokens written into the provider's prompt cache this turn. */
  cacheCreationTokens: number;
}

/**
 * The amount to SUBTRACT from a turn's computed cost because part of its input
 * was served from the provider's prompt cache. (S4-c)
 *
 * Written as a subtraction rather than folded into the input term on purpose:
 * with no `cacheReadCostPer1M` anywhere in the tree the rate defaults to
 * `inputCostPer1M`, the difference is exactly 0, and every existing session's
 * cost is bit-identical to what it was before the cache split landed.
 *
 * `billedInputTokens` is what the CALLING STRATEGY actually charged for, and
 * the `Math.min` against it is load-bearing — not defensive tidiness. The
 * delta-aware strategy charges only the GROWTH in context, so on a turn that
 * is ~99.9% cache (prompt 20379, cached 20352 — upstream's measured capture)
 * an unclamped discount would subtract 20352 tokens' worth from a 27-token
 * charge and drive `sessionTotalCost` negative. Clamped, the discount can
 * never exceed the charge it is discounting, so per-turn cost stays >= 0 and
 * the session total stays non-negative.
 *
 * Exported because it is the whole of the money change and the only part with
 * arithmetic worth pinning: the field it reads has no producer yet, so a test
 * has to hand it a pricing object to reach any non-zero branch at all.
 */
export function computeCacheReadDiscount(
  pricing: ModelPricing,
  billedInputTokens: number,
  detail?: UsageCacheDetail
): number {
  const cacheReadTokens = detail?.cacheReadTokens ?? 0;
  if (cacheReadTokens <= 0 || billedInputTokens <= 0) return 0;
  // Absent rate => cache reads are priced as ordinary input => no discount.
  // See ModelPricing.cacheReadCostPer1M for why this is a rule, not a ratio.
  const rate = pricing.cacheReadCostPer1M ?? pricing.inputCostPer1M;
  const perMillionSaved = pricing.inputCostPer1M - rate;
  if (!(perMillionSaved > 0)) return 0;
  const discountedTokens = Math.min(cacheReadTokens, billedInputTokens);
  return (discountedTokens / 1_000_000) * perMillionSaved;
}

export class TokenTracker {
  private port: number;
  private config: TokenTrackerConfig;
  private sessionTotalCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  /** Override model name in status line (e.g., after capacity fallback) */
  private modelNameOverride: string | undefined;
  /** Quota remaining fraction (0-1) for the current model */
  private quotaRemaining: number | undefined;
  /**
   * Cache-read tokens summed across the session, for the accumulate-both
   * strategy ALONE. (S4-c)
   *
   * That strategy ASSIGNS `sessionTotalCost` from cumulative totals rather
   * than accumulating per-turn costs, so a per-turn discount subtracted there
   * is simply overwritten by the next turn's assignment. The discount has to
   * be recomputed from a cumulative cache-read total to survive. Every other
   * strategy accumulates and needs no such counter.
   */
  private sessionCacheReadTokens = 0;

  constructor(port: number, config: TokenTrackerConfig) {
    this.port = port;
    this.config = config;
  }

  /** Set an override model name (shown in status line instead of original) */
  setActiveModelName(name: string): void {
    this.modelNameOverride = name;
  }

  /** Update provider display name (e.g., after OAuth resolves the tier) */
  setProviderDisplayName(name: string): void {
    this.config.providerDisplayName = name;
  }

  /** Set quota remaining fraction (0-1) for the current model */
  setQuotaRemaining(fraction: number): void {
    this.quotaRemaining = fraction;
  }

  /** Force rewrite the token file with current state */
  rewrite(): void {
    this.writeFile(this.sessionInputTokens, this.sessionOutputTokens);
  }

  /**
   * Standard update: assign input (latest context), accumulate output.
   * Used by most remote providers (Gemini, AnthropicCompat, Vertex, RemoteProvider, etc.)
   */
  update(inputTokens: number, outputTokens: number, detail?: UsageCacheDetail): void {
    this.sessionInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;
    this.sessionCacheReadTokens += detail?.cacheReadTokens ?? 0;

    const pricing = this.getPricing();
    // This strategy charges the whole context every turn, so the whole context
    // is what the cache discount is clamped against.
    const cost =
      (inputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M -
      computeCacheReadDiscount(pricing, inputTokens, detail);
    this.sessionTotalCost += cost;

    this.writeFile(inputTokens, this.sessionOutputTokens, pricing.isEstimate);
  }

  /**
   * Accumulate both input and output tokens.
   * Used by OllamaCloud where cost is calculated on cumulative totals.
   */
  accumulateBoth(inputTokens: number, outputTokens: number, detail?: UsageCacheDetail): void {
    this.sessionInputTokens += inputTokens;
    this.sessionOutputTokens += outputTokens;
    this.sessionCacheReadTokens += detail?.cacheReadTokens ?? 0;

    const pricing = this.getPricing();
    // ASSIGNED from cumulative totals, so the discount must be cumulative too:
    // a per-turn subtraction here would be thrown away by the next turn's
    // assignment. `sessionCacheReadTokens` is the running total, clamped
    // against the running input total this line is already pricing.
    const cost =
      (this.sessionInputTokens / 1_000_000) * pricing.inputCostPer1M +
      (this.sessionOutputTokens / 1_000_000) * pricing.outputCostPer1M -
      computeCacheReadDiscount(pricing, this.sessionInputTokens, {
        cacheReadTokens: this.sessionCacheReadTokens,
        cacheCreationTokens: 0,
      });
    // OllamaCloud recalculates total cost each time (not incremental)
    this.sessionTotalCost = cost;

    this.writeFile(this.sessionInputTokens, this.sessionOutputTokens, pricing.isEstimate);
  }

  /**
   * Delta-aware update with race-condition detection for concurrent conversations.
   * Used by OpenAI handler where multiple conversations may share one handler.
   *
   * inputTokens = full context size from the API (not incremental)
   * Only charges for the delta (new tokens added since last request).
   */
  updateWithDelta(inputTokens: number, outputTokens: number, detail?: UsageCacheDetail): void {
    let incrementalInputTokens: number;

    if (inputTokens >= this.sessionInputTokens) {
      // Normal: context grew (continuation)
      incrementalInputTokens = inputTokens - this.sessionInputTokens;
      this.sessionInputTokens = inputTokens;
    } else if (inputTokens < this.sessionInputTokens * 0.5) {
      // Different conversation with much smaller context
      incrementalInputTokens = inputTokens;
      log(
        `[TokenTracker] Detected concurrent conversation (${inputTokens} < ${this.sessionInputTokens}), charging full input`
      );
    } else {
      // Ambiguous decrease — charge full and update
      incrementalInputTokens = inputTokens;
      this.sessionInputTokens = inputTokens;
      log(
        `[TokenTracker] Ambiguous token decrease (${inputTokens} vs ${this.sessionInputTokens}), charging full input`
      );
    }

    this.sessionOutputTokens += outputTokens;
    this.sessionCacheReadTokens += detail?.cacheReadTokens ?? 0;

    const pricing = this.getPricing();
    // The clamp matters MOST here: this strategy charges only the growth, which
    // on a cached continuation is a handful of tokens against a cache read of
    // tens of thousands. Discounting the raw cache-read count would make the
    // turn cost negative — see computeCacheReadDiscount's measured capture.
    const cost =
      (incrementalInputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M -
      computeCacheReadDiscount(pricing, incrementalInputTokens, detail);
    this.sessionTotalCost += cost;

    this.writeFile(
      Math.max(inputTokens, this.sessionInputTokens),
      this.sessionOutputTokens,
      pricing.isEstimate
    );
  }

  /**
   * Update with actual cost from the API (e.g., OpenRouter returns cost directly).
   * Falls back to calculated cost when actualCost is 0 or unavailable.
   */
  updateWithActualCost(
    inputTokens: number,
    outputTokens: number,
    actualCost: number | undefined,
    detail?: UsageCacheDetail
  ): void {
    this.sessionInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;
    this.sessionCacheReadTokens += detail?.cacheReadTokens ?? 0;

    if (typeof actualCost === "number" && actualCost > 0) {
      // NO DISCOUNT on this branch: the provider's own figure is already net of
      // whatever caching it applied; subtracting a cache discount from it would
      // double-count the saving and under-report real spend.
      this.sessionTotalCost += actualCost;
      log(`[TokenTracker] Actual cost from API: $${actualCost.toFixed(6)}`);
    } else {
      // The computed fallback is the `update` arithmetic, so it takes the
      // `update` treatment: full context charged, discount clamped against it.
      const pricing = this.getPricing();
      const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M;
      const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
      this.sessionTotalCost +=
        inputCost + outputCost - computeCacheReadDiscount(pricing, inputTokens, detail);
    }

    this.writeFile(inputTokens, this.sessionOutputTokens);
  }

  /**
   * For local models: assign input (API reports full context), accumulate output.
   * Cost is always 0 for local models.
   */
  updateLocal(inputTokens: number, outputTokens: number, _detail?: UsageCacheDetail): void {
    // No discount: local models have no pricing at all. The parameter exists
    // only so every strategy shares one shape and the caller does not have to
    // know which ones care.
    if (inputTokens > 0) {
      this.sessionInputTokens = inputTokens;
    }
    this.sessionOutputTokens += outputTokens;
    // Local models are free
    this.writeFile(this.sessionInputTokens, this.sessionOutputTokens);
  }

  /** Update just the context window (e.g., after fetching from model API) */
  setContextWindow(contextWindow: number): void {
    this.config.contextWindow = contextWindow;
  }

  /** Get the current session total cost */
  getTotalCost(): number {
    return this.sessionTotalCost;
  }

  /** Get current session input tokens */
  getInputTokens(): number {
    return this.sessionInputTokens;
  }

  /** Get current session output tokens */
  getOutputTokens(): number {
    return this.sessionOutputTokens;
  }

  private getPricing(): ModelPricing {
    return getModelPricing(this.config.providerName, this.config.modelName);
  }

  private getDisplayName(): string {
    if (this.config.providerDisplayName) return this.config.providerDisplayName;
    const name = this.config.providerName;
    if (name === "opencode-zen") return "Zen";
    if (name === "glm") return "GLM";
    if (name === "openai") return "OpenAI";
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  private writeFile(inputTokens: number, outputTokens: number, isEstimate?: boolean): void {
    try {
      const total = inputTokens + outputTokens;
      const cw = this.config.contextWindow;
      // context_left_percent: -1 means "unknown" (no catalog entry for this model)
      const leftPct =
        cw > 0 ? Math.max(0, Math.min(100, Math.round(((cw - total) / cw) * 100))) : -1;

      const pricing = this.getPricing();
      const isFreeModel =
        pricing.isFree || (pricing.inputCostPer1M === 0 && pricing.outputCostPer1M === 0);

      const data: Record<string, any> = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: total,
        total_cost: this.sessionTotalCost,
        context_window: cw > 0 ? cw : "unknown",
        context_left_percent: leftPct,
        provider_name: this.getDisplayName(),
        updated_at: Date.now(),
        is_free: isFreeModel,
        is_estimated: isEstimate || false,
      };
      // When a fallback model is active, include it so the status line shows the actual model
      if (this.modelNameOverride) {
        data.model_name = this.modelNameOverride;
      }
      // Include quota remaining if available (e.g., from Gemini Code Assist)
      if (this.quotaRemaining !== undefined) {
        data.quota_remaining = this.quotaRemaining;
      }

      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      log(`[TokenTracker] Error writing token file: ${e}`);
    }
  }
}
