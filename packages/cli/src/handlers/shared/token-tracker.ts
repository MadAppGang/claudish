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
import { dirname, join } from "node:path";
import { type PlanUsage, isPlanStale } from "../../auth/quota/types.js";
import { log } from "../../logger.js";
import { type ModelPricing, getModelPricing } from "./remote-provider-types.js";

export interface TokenTrackerConfig {
  contextWindow: number;
  providerName: string;
  modelName: string;
  /** Display name for the provider (e.g., "OpenAI", "Gemini") */
  providerDisplayName?: string;
}

/**
 * Strip a `provider@` routing prefix from a model spec.
 *
 * The status line renders `"<provider_name> <model_name>"`, so a model_name that
 * still carries its routing prefix names the provider twice — `qc@qwen3.7-plus`
 * under the "Qwen Plan" label reads as "Qwen Plan qc@qwen3.7-plus".
 * ComposedHandler already enforces a bare `modelName`, but a fallback override
 * comes from a transport and this is cheap insurance.
 */
export function stripProviderPrefix(name: string): string {
  const at = name.indexOf("@");
  return at === -1 ? name : name.slice(at + 1);
}

export class TokenTracker {
  private port: number;
  private config: TokenTrackerConfig;
  private sessionTotalCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  /**
   * The input-token count from the MOST RECENT request, verbatim — never a
   * high-water mark. `sessionInputTokens` is a billing baseline that the
   * delta-aware strategy deliberately refuses to lower (see updateWithDelta),
   * so it is the wrong number to show a user or to seed a placeholder with.
   */
  private lastInputTokens = 0;
  /** Override model name in status line (e.g., after capacity fallback) */
  private modelNameOverride: string | undefined;
  /**
   * Plan usage for the subscription this session is SPENDING, published under
   * the `plan` key for status lines. Held in memory and serialized by
   * writeFile — never fetched there, so publishing costs no extra I/O.
   */
  private planUsage: PlanUsage | undefined;
  /** Last plan written, so setPlanUsage can write on change only. */
  private lastPlanSerialized = "";

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

  /**
   * Record plan usage for the provider being spent.
   *
   * Writes the file when the value actually CHANGES, and only then.
   *
   * An earlier version stored without writing, on the reasoning that writeFile
   * already runs on every token update so the next one would pick it up free.
   * That left two holes. A background poll that resolves after a turn's final
   * token write published nothing until the *next* turn — and for a provider
   * polled every 5 minutes on an idle session, that could be never. Worse, an
   * expired reading was only dropped at write time, so a stale `plan` sat in
   * the file indefinitely and the frozen consumer rendered it as current, which
   * is exactly the failure the omit-when-stale rule exists to prevent.
   *
   * Change-triggered is still effectively free: a plan changes at most once per
   * scrape or poll interval, not once per token, so this adds a write every few
   * minutes rather than the per-delta amplification the original note feared.
   */
  setPlanUsage(plan: PlanUsage | undefined): void {
    const next = plan ? JSON.stringify(plan) : "";
    if (next === this.lastPlanSerialized) return;
    this.planUsage = plan;
    this.lastPlanSerialized = next;
    this.rewrite();
  }

  /** Force rewrite the token file with current state */
  rewrite(): void {
    this.writeFile(this.getLastInputTokens(), this.sessionOutputTokens);
  }

  /**
   * Standard update: assign input (latest context), accumulate output.
   * Used by most remote providers (Gemini, AnthropicCompat, Vertex, RemoteProvider, etc.)
   */
  update(inputTokens: number, outputTokens: number): void {
    this.sessionInputTokens = inputTokens;
    this.lastInputTokens = inputTokens;
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
    this.lastInputTokens = this.sessionInputTokens;
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

    // The status file always reports THIS request's context, even when the
    // billing baseline below refuses to move.
    this.lastInputTokens = inputTokens;

    if (inputTokens >= this.sessionInputTokens) {
      // Normal: context grew (continuation)
      incrementalInputTokens = inputTokens - this.sessionInputTokens;
      this.sessionInputTokens = inputTokens;
    } else if (inputTokens < this.sessionInputTokens * 0.5) {
      // Different conversation with much smaller context. The baseline is left
      // where it is on purpose: a concurrent conversation must not reset the
      // main thread's billing high-water and get its own growth charged twice.
      // A compaction lands here too — hence the separate lastInputTokens, which
      // is what the status line reads. Conflating them pinned the status bar at
      // the pre-compaction peak forever ("0% context left" after a clean
      // /compact) because the file was written with a Math.max().
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

    this.writeFile(inputTokens, this.sessionOutputTokens, pricing.isEstimate);
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
    this.lastInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;

    if (typeof actualCost === "number" && actualCost > 0) {
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
      this.lastInputTokens = inputTokens;
    }
    this.sessionOutputTokens += outputTokens;
    // Local models are free
    this.writeFile(this.sessionInputTokens, this.sessionOutputTokens);
  }

  /** Update just the context window (e.g., after fetching from model API) */
  setContextWindow(contextWindow: number): void {
    this.config.contextWindow = contextWindow;
  }

  /** Current context window in tokens. 0 means "not resolved yet / unknown". */
  getContextWindow(): number {
    return this.config.contextWindow;
  }

  /** Get the current session total cost */
  getTotalCost(): number {
    return this.sessionTotalCost;
  }

  /** Get current session input tokens (billing baseline — may lag a compaction) */
  getInputTokens(): number {
    return this.sessionInputTokens;
  }

  /**
   * Input tokens from the most recent request — the live context size.
   * Use this for anything user-facing or for seeding a placeholder; use
   * getInputTokens() only for cost accounting.
   */
  getLastInputTokens(): number {
    return this.lastInputTokens || this.sessionInputTokens;
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
      // Context occupancy is the CURRENT conversation size, which is `inputTokens` —
      // every strategy passes the latest request's context here (see lastInputTokens).
      // `outputTokens` is a session-CUMULATIVE counter, so folding it in made this
      // percentage decay with session AGE instead of with context use: once lifetime
      // output passed the window the value pinned at 0 and stopped carrying any signal.
      // Measured on a 3-day session: input 94,018 against a 372,000 window, output
      // 2,280,419 cumulative — reported 0% left when 75% was free, which is why a
      // 200K compaction clamp went unnoticed for three days. `total` stays cumulative
      // for `total_tokens`, which is a billing figure and genuinely session-wide.
      //
      // context_left_percent: -1 means "unknown" (no catalog entry for this model)
      const leftPct =
        cw > 0 ? Math.max(0, Math.min(100, Math.round(((cw - inputTokens) / cw) * 100))) : -1;

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
      // model_name is ALWAYS written, not just when a fallback override is active.
      // The status line's fallback for a missing key is $CLAUDISH_ACTIVE_MODEL_NAME,
      // which is the full routed spec (`qc@qwen3.7-plus`) — rendered next to the
      // provider label that produces "Qwen Plan qc@qwen3.7-plus". The override
      // still wins when set, because a capacity fallback legitimately needs to show
      // the SUBSTITUTED model rather than the one the user asked for.
      const displayModel = stripProviderPrefix(
        this.modelNameOverride || this.config.modelName || ""
      );
      if (displayModel) {
        data.model_name = displayModel;
      }
      // Plan usage for the subscription actually being spent. Status lines
      // render this INSTEAD of Anthropic's rate limits, which under claudish
      // describe an account the session is not using.
      //
      // Stale readings are OMITTED rather than flagged. The consumer
      // (statusline.sh) reads only `.plan.label` and `.plan.windows[]` and
      // ignores keys it does not know — so a `stale: true` field would be
      // dropped while the numbers beside it still rendered as current. Absence
      // is the only signal the frozen contract can carry, and the consumer
      // already degrades silently on it.
      if (this.planUsage && !isPlanStale(this.planUsage)) {
        data.plan = {
          label: this.planUsage.label,
          windows: this.planUsage.windows,
          source: this.planUsage.source,
        };
      }

      // CLAUDISH_TOKEN_FILE lets a parent process dictate where these stats land.
      // The default path is keyed to a port the child picks for itself, so an
      // orchestrator spawning N children has no way to tell which file belongs
      // to which model. Pointing each child at a known path is what makes
      // per-model token/cost reporting possible.
      const override = process.env.CLAUDISH_TOKEN_FILE;
      const outPath = override || join(homedir(), ".claudish", `tokens-${this.port}.json`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(data), "utf-8");
    } catch (e) {
      log(`[TokenTracker] Error writing token file: ${e}`);
    }
  }
}
