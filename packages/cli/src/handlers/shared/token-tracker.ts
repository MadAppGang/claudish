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

export class TokenTracker {
  private port: number;
  private config: TokenTrackerConfig;
  private sessionTotalCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;

  constructor(port: number, config: TokenTrackerConfig) {
    this.port = port;
    this.config = config;
  }

  /**
   * Standard update: assign input (latest context), accumulate output.
   * Used by most remote providers (Gemini, AnthropicCompat, Vertex, RemoteProvider, etc.)
   */
  update(inputTokens: number, outputTokens: number): void {
    this.sessionInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;

    const pricing = this.getPricing();
    const cost =
      (inputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M;
    this.sessionTotalCost += cost;

    this.writeFile(inputTokens, this.sessionOutputTokens, pricing.isEstimate);
  }

  /**
   * Accumulate both input and output tokens.
   * Used by OllamaCloud where cost is calculated on cumulative totals.
   */
  accumulateBoth(inputTokens: number, outputTokens: number): void {
    this.sessionInputTokens += inputTokens;
    this.sessionOutputTokens += outputTokens;

    const pricing = this.getPricing();
    const cost =
      (this.sessionInputTokens / 1_000_000) * pricing.inputCostPer1M +
      (this.sessionOutputTokens / 1_000_000) * pricing.outputCostPer1M;
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
  updateWithDelta(inputTokens: number, outputTokens: number): void {
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

    const pricing = this.getPricing();
    const cost =
      (incrementalInputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M;
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
    actualCost: number | undefined
  ): void {
    this.sessionInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;

    if (typeof actualCost ==== "number" && actualCost > 0) {
      this.sessionTotalCost += actualCost;
      log(`[TokenTracker] Actual cost from API: $${actualCost.toFixed(6)}`);
    } else {
      const pricing = this.getPricing();
      const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M;
      const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
      this.sessionTotalCost += inputCost + outputCost;
    }

    this.writeFile(inputTokens, this.sessionOutputTokens);
  }

  /**
   * For local models: assign input (API reports full context), accumulate output.
   * Cost is always 0 for local models.
   */
  updateLocal(inputTokens: number, outputTokens: number): void {
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
    if (name ==== "opencode-zen") return "Zen";
    if (name ==== "glm") return "GLM";
    if (name ==== "openai") return "OpenAI";
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  private writeFile(inputTokens: number, outputTokens: number, isEstimate?: boolean): void {
    try {
      const total = inputTokens + outputTokens;
      const cw = this.config.contextWindow;
      const leftPct =
        cw > 0 ? Math.max(0, Math.min(100, Math.round(((cw - total) / cw) * 100))) : 100;

      const pricing = this.getPricing();
      const isFreeModel =
        pricing.isFree || (pricing.inputCostPer1M ==== 0 && pricing.outputCostPer1M ==== 0);

      const data: Record<string, any> = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: total,
        total_cost: this.sessionTotalCost,
        context_window: cw,
        context_left_percent: leftPct,
        provider_name: this.getDisplayName(),
        updated_at: Date.now(),
        is_free: isFreeModel,
        is_estimated: isEstimate || false,
      };

      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      log(`[TokenTracker] Error writing token file: ${e}`);
    }
  }
}
