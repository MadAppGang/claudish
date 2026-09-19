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
import { TOOL_NAME_SHAPE } from "../../adapters/tool-name-utils.js";
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
 * The cached breakdown of a turn's input tokens, for COST ONLY.
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
 * Strip a `provider@` routing prefix from a model spec.
 *
 * The status line renders `"<provider_name> <model_name>"`, so a model_name that
 * still carries its routing prefix names the provider twice — `qtoken@qwen3.7-plus`
 * under the "Alibaba Token Plan" label reads as "Alibaba Token Plan qtoken@qwen3.7-plus".
 * ComposedHandler already enforces a bare `modelName`, but a fallback override
 * comes from a transport and this is cheap insurance.
 */
export function stripProviderPrefix(name: string): string {
  const at = name.indexOf("@");
  return at === -1 ? name : name.slice(at + 1);
}

/**
 * The amount to SUBTRACT from a turn's computed cost because part of its input
 * was served from the provider's prompt cache.
 *
 * Written as a subtraction rather than folded into the input term on purpose:
 * with no `cacheReadCostPer1M` anywhere in the tree the rate defaults to
 * `inputCostPer1M`, the difference is exactly 0, and every existing session's
 * cost is bit-identical to what it was before the cache split landed. A
 * rewritten input term could not make that claim as cheaply.
 *
 * `billedInputTokens` is what the CALLING STRATEGY actually charged for, and
 * the `Math.min` against it is load-bearing — not defensive tidiness. The
 * delta-aware strategy charges only the GROWTH in context, so on the real xAI
 * capture (`grok-4.6-openai-advisor-turn1.sse`: prompt 20379, cached 20352) an
 * unclamped discount would subtract 20352 tokens' worth from a 27-token charge
 * and drive `sessionTotalCost` negative. Clamped, the discount can never exceed
 * the charge it is discounting, so per-turn cost stays >= 0 and the session
 * total stays non-negative.
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
  /**
   * Tool calls the model emitted this session, by tool name.
   *
   * Counted at the point a tool call is COMPLETE (name known, arguments closed),
   * never per streamed fragment — an `input_json_delta` path would count one
   * `Edit` twenty times. The session summary renders this as a distribution, which
   * is why the per-name breakdown is kept rather than a bare total: "47 calls" is a
   * number, "Read 18 · Edit 12 · Bash 9" is a shape.
   */
  private toolCallsByName = new Map<string, number>();
  /**
   * Wall-clock start of this tracker, i.e. of the proxied session.
   *
   * The token file already carries `updated_at`; a duration needs both ends. Taken
   * at construction because that is when the proxy begins serving, which is the
   * span the user experiences as "the session".
   */
  private readonly startedAt = Date.now();
  /**
   * Every input token this session was BILLED for, summed across turns.
   *
   * Distinct from `sessionInputTokens`, which most strategies ASSIGN rather than
   * accumulate because it answers "how full is the context right now" for the status
   * line. `sessionTotalCost` meanwhile accumulates, so the two are on different bases —
   * a ten-turn session holds one turn's input against ten turns of cost.
   *
   * That mismatch is invisible for the status line and fatal for a savings comparison:
   * pricing one turn of input at Sonnet's rate and subtracting ten turns of real cost
   * understates the saving and can invert its sign, reporting "over by $X" for a session
   * that in fact saved money. This counter is the honest denominator, and it mirrors
   * whatever each strategy actually charged for — the delta on the delta-aware path, the
   * full context on the assignment paths, the running total on accumulate-both.
   */
  private sessionBilledInputTokens = 0;
  /**
   * Cache-read tokens summed across the session, for the accumulate-both
   * strategy ALONE.
   *
   * That strategy ASSIGNS `sessionTotalCost` from cumulative totals rather than
   * accumulating per-turn costs, so a per-turn discount subtracted there is
   * simply overwritten on the next turn. The discount has to be recomputed from
   * a cumulative cache-read total to survive, which is what this counter is.
   * Every other strategy accumulates and needs no such counter.
   */
  private sessionCacheReadTokens = 0;

  constructor(port: number, config: TokenTrackerConfig) {
    this.port = port;
    this.config = config;
  }

  /**
   * Record one COMPLETED tool call. Unnamed calls are counted under `unknown`
   * rather than dropped: a tool call whose name never arrived is still a tool call,
   * and silently discarding it would make the summary's total disagree with the
   * transcript.
   */
  recordToolUse(name: string): void {
    const trimmed = name.trim();
    // A tool name is an identifier. A name that is not one did not come from a
    // tool: it is text a parser swallowed, and it can carry ARGUMENT VALUES.
    // This map is written to `stats/*.json` and printed in the session summary,
    // neither of which is a redacted surface, so the value must not land here.
    // The call is still counted, under `malformed`, so the total keeps agreeing
    // with the transcript.
    const key = !trimmed ? "unknown" : TOOL_NAME_SHAPE.test(trimmed) ? trimmed : "malformed";
    this.toolCallsByName.set(key, (this.toolCallsByName.get(key) ?? 0) + 1);
  }

  /** Total completed tool calls this session. */
  getToolCallCount(): number {
    let n = 0;
    for (const v of this.toolCallsByName.values()) n += v;
    return n;
  }

  /** Per-tool counts, descending by count. */
  getToolCalls(): Array<{ name: string; count: number }> {
    return [...this.toolCallsByName]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
  update(inputTokens: number, outputTokens: number, detail?: UsageCacheDetail): void {
    this.sessionInputTokens = inputTokens;
    this.lastInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;
    this.sessionBilledInputTokens += inputTokens;
    this.sessionCacheReadTokens += detail?.cacheReadTokens ?? 0;

    const pricing = this.getPricing();
    // This strategy charges the whole context every turn, so the whole context
    // is what the cache discount is clamped against.
    const cost =
      (inputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M -
      this.cacheReadDiscount(pricing, inputTokens, detail);
    this.sessionTotalCost += cost;

    this.writeFile(inputTokens, this.sessionOutputTokens, pricing.isEstimate);
  }

  /**
   * Accumulate both input and output tokens.
   * Used by OllamaCloud where cost is calculated on cumulative totals.
   */
  accumulateBoth(inputTokens: number, outputTokens: number, detail?: UsageCacheDetail): void {
    this.sessionInputTokens += inputTokens;
    this.lastInputTokens = this.sessionInputTokens;
    this.sessionOutputTokens += outputTokens;
    this.sessionCacheReadTokens += detail?.cacheReadTokens ?? 0;

    const pricing = this.getPricing();
    // ASSIGNED from cumulative totals, so the discount must be cumulative too: a
    // per-turn subtraction here would be thrown away by the next turn's
    // assignment. `sessionCacheReadTokens` is the running total, clamped against
    // the running input total this line is already pricing.
    const cost =
      (this.sessionInputTokens / 1_000_000) * pricing.inputCostPer1M +
      (this.sessionOutputTokens / 1_000_000) * pricing.outputCostPer1M -
      this.cacheReadDiscount(pricing, this.sessionInputTokens, {
        cacheReadTokens: this.sessionCacheReadTokens,
        cacheCreationTokens: 0,
      });
    // OllamaCloud recalculates total cost each time (not incremental)
    this.sessionTotalCost = cost;
    // Assigned, not accumulated, for the same reason the cost above is: this strategy
    // already sums input itself, so `+=` here would count every earlier turn again.
    this.sessionBilledInputTokens = this.sessionInputTokens;

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
    this.sessionCacheReadTokens += detail?.cacheReadTokens ?? 0;

    const pricing = this.getPricing();
    this.sessionBilledInputTokens += incrementalInputTokens;
    // The clamp matters MOST here: this strategy charges only the growth, which
    // on a cached continuation is a handful of tokens against a cache read of
    // tens of thousands. Discounting the raw cache-read count would make the
    // turn cost negative. See cacheReadDiscount for the measured capture.
    const cost =
      (incrementalInputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M -
      this.cacheReadDiscount(pricing, incrementalInputTokens, detail);
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
    actualCost: number | undefined,
    detail?: UsageCacheDetail
  ): void {
    this.sessionInputTokens = inputTokens;
    this.lastInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;
    this.sessionBilledInputTokens += inputTokens;
    this.sessionCacheReadTokens += detail?.cacheReadTokens ?? 0;

    if (typeof actualCost === "number" && actualCost > 0) {
      // NO DISCOUNT on this branch. The provider's own figure is already net of
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
        inputCost + outputCost - this.cacheReadDiscount(pricing, inputTokens, detail);
    }

    this.writeFile(inputTokens, this.sessionOutputTokens);
  }

  /**
   * For local models: assign input (API reports full context), accumulate output.
   * Cost is always 0 for local models.
   */
  updateLocal(inputTokens: number, outputTokens: number, _detail?: UsageCacheDetail): void {
    // No discount: local models have no pricing at all, so there is nothing to
    // discount. The parameter exists only so every strategy shares one shape and
    // the caller does not have to know which ones care.
    if (inputTokens > 0) {
      this.sessionInputTokens = inputTokens;
      this.lastInputTokens = inputTokens;
    }
    this.sessionOutputTokens += outputTokens;
    this.sessionBilledInputTokens += inputTokens;
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

  /** Instance shim over `computeCacheReadDiscount` — see that function. */
  private cacheReadDiscount(
    pricing: ModelPricing,
    billedInputTokens: number,
    detail?: UsageCacheDetail
  ): number {
    return computeCacheReadDiscount(pricing, billedInputTokens, detail);
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
        // Session-summary fields. The status line ignores both; they exist because
        // the token file is the only durable record of a session that survives the
        // proxy exiting, and the summary is printed AFTER shutdown (see
        // `session/session-summary.ts`). `started_at` pairs with `updated_at` to
        // give a duration; `tool_calls` is the distribution, not just a total.
        started_at: this.startedAt,
        tool_calls: this.getToolCalls(),
        // The savings baseline's denominator. `input_tokens` above is the CURRENT
        // context (assigned, for the status line's occupancy bar); this is the
        // cumulative billed volume. Pricing the former against a cumulative
        // `total_cost` compares one turn to N and can invert the sign of the result.
        billed_input_tokens: this.sessionBilledInputTokens,
        // The per-million RATES, not a split of the total. Cost accumulates through four
        // different strategies above (standard, accumulate-both, delta-aware,
        // actual-cost), so maintaining a parallel input/output split in each would be
        // four chances to drift from `total_cost`. Publishing the rates lets the summary
        // derive the split and rescale it to whatever `total_cost` actually says, which
        // stays correct even on the actual-cost path where the provider's billed figure
        // overrides our arithmetic entirely.
        input_per_m: pricing.inputCostPer1M,
        output_per_m: pricing.outputCostPer1M,
      };
      // model_name is ALWAYS written, not just when a fallback override is active.
      // The status line's fallback for a missing key is $CLAUDISH_ACTIVE_MODEL_NAME,
      // which is the full routed spec (`qtoken@qwen3.7-plus`) — rendered next to the
      // provider label that produces "Alibaba Token Plan qtoken@qwen3.7-plus". The override
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
