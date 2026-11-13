/**
 * The meter of a Claude API launch: per-request stats and claudish's cost line
 * for the requests the monitor proxy forwards to Anthropic on the user's key.
 *
 * On that launch the proxy signs every forwarded request with the launch's key
 * (`launch-key`), so every forwarded request is billed to the key and recorded
 * here, whatever credential it arrived with. No other launch meters through the
 * native passthrough: what decides is the signer, not an inbound header.
 * `count_tokens` is not metered: Anthropic does not bill it.
 *
 * Claude Code sends subagent and background turns on other models through the
 * same passthrough, so each turn is priced by its OWN model. Only a turn on the
 * session's main model moves the context occupancy the status line shows.
 *
 * The status line shows the whole session (one tracker), but a stats event
 * carries its own model's running totals: `estimated_cost` is read as the
 * emitting model's running total, so a model's spend is its row maximum, and a
 * session-wide figure on every row would count each model's spend again under
 * the others.
 */

import { getProviderByName } from "../providers/provider-definitions.js";
import { catalogEntryForRequest, ownConnection } from "../services/pricing-cache.js";
import { recordStats } from "../stats.js";
import { classifyError } from "../telemetry.js";
import type { ClaudeApiMeter, ClaudeApiTurn } from "./shared/claude-api-usage.js";
import { getModelPricing } from "./shared/remote-provider-types.js";
import { TokenTracker, type UsageCacheDetail, computeTurnCost } from "./shared/token-tracker.js";

export type {
  AnthropicUsage,
  ClaudeApiMeter,
  ClaudeApiTurn,
} from "./shared/claude-api-usage.js";
export { mergeSseUsage } from "./shared/claude-api-usage.js";

/** The claudish provider of the Claude API, as stats and pricing name it. */
const CLAUDE_API_PROVIDER = "anthropic";

/** The canonical model id a request's model name prices from, else the name itself. */
function canonicalModelId(name: string): string {
  return catalogEntryForRequest(CLAUDE_API_PROVIDER, name)?.modelId ?? name;
}

/**
 * The context window the catalog publishes for `name` on the Claude API: its
 * own connection's, else the model's. 0 when the catalog knows neither.
 */
export function claudeApiContextWindow(name: string): number {
  const entry = catalogEntryForRequest(CLAUDE_API_PROVIDER, name);
  if (!entry) return 0;
  return ownConnection(entry, CLAUDE_API_PROVIDER, name)?.contextWindow ?? entry.contextWindow ?? 0;
}

/** True when a response reported any token count. */
function reportsTokens(u: NonNullable<ClaudeApiTurn["usage"]>): boolean {
  return [
    u.input_tokens,
    u.output_tokens,
    u.cache_read_input_tokens,
    u.cache_creation_input_tokens,
  ].some((n) => typeof n === "number" && n > 0);
}

/** One model's running totals, as its stats rows carry them. */
interface ModelTotals {
  /** The latest request's billed input, as `TokenTracker.update` keeps it. */
  input: number;
  output: number;
  cost: number;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** The HTTP status Anthropic documents for each error type it can put in a stream. */
const STREAM_ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
};

/**
 * A stream error event as a stats failure: an overload as one, any other type
 * classified by its documented status.
 */
function streamFailure(type: string): { error_class: string; error_code: string } {
  const status = STREAM_ERROR_STATUS[type];
  if (type === "overloaded_error") return { error_class: "overload", error_code: type };
  return status !== undefined
    ? classifyError(undefined, status)
    : { error_class: "http_error", error_code: "stream_error" };
}

/**
 * A meter for one Claude API launch. `mainModel` is the id Claude Code was
 * given; `port` keys the status line's token file, as for every handler.
 */
export function createClaudeApiMeter(opts: {
  port: number;
  mainModel: string;
  contextWindow: number;
}): ClaudeApiMeter {
  const displayName = getProviderByName(CLAUDE_API_PROVIDER)?.displayName;
  const tracker = new TokenTracker(opts.port, {
    contextWindow: opts.contextWindow,
    providerName: CLAUDE_API_PROVIDER,
    modelName: opts.mainModel,
    ...(displayName ? { providerDisplayName: displayName } : {}),
  });
  const mainId = canonicalModelId(opts.mainModel);
  // Keyed by the request's model name, which is the stats row's `model_id`.
  const totalsByModel = new Map<string, ModelTotals>();

  return {
    record(turn: ClaudeApiTurn): void {
      let totals = totalsByModel.get(turn.model);
      if (!totals) {
        totals = { input: 0, output: 0, cost: 0 };
        totalsByModel.set(turn.model, totals);
      }
      const ok =
        turn.error === undefined && turn.streamErrorType === undefined && isSuccess(turn.status);
      // Anthropic bills the tokens a response reported, whatever became of the
      // request: a cancelled stream's, and a stream that failed after
      // `message_start`, are counted, while the event keeps the failed status.
      // A request that reported no usage changes no counter.
      if (turn.usage && reportsTokens(turn.usage)) {
        const u = turn.usage;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheCreation = u.cache_creation_input_tokens ?? 0;
        const input = (u.input_tokens ?? 0) + cacheCreation + cacheRead;
        const output = u.output_tokens ?? 0;
        const detail: UsageCacheDetail = {
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
        };
        if (canonicalModelId(turn.model) === mainId) {
          const before = tracker.getTotalCost();
          tracker.update(input, output, detail);
          totals.cost += tracker.getTotalCost() - before;
        } else {
          const cost = computeTurnCost(
            getModelPricing(CLAUDE_API_PROVIDER, turn.model),
            input,
            output,
            detail
          );
          tracker.addSideTurn(cost, input, output, detail);
          totals.cost += cost;
        }
        totals.input = input;
        totals.output += output;
      }

      try {
        const failure = turn.cancelled
          ? { error_class: "cancelled", error_code: "client_cancelled" }
          : turn.streamErrorType !== undefined && isSuccess(turn.status)
            ? streamFailure(turn.streamErrorType)
            : turn.error !== undefined || !isSuccess(turn.status)
              ? classifyError(turn.error, turn.status > 0 ? turn.status : undefined)
              : undefined;
        recordStats({
          model_id: turn.model,
          provider_name: CLAUDE_API_PROVIDER,
          stream_format: "anthropic-messages",
          latency_ms: Math.round(turn.latencyMs),
          success: ok && !turn.cancelled,
          http_status: turn.status,
          ...(failure ?? {}),
          input_tokens: totals.input,
          output_tokens: totals.output,
          estimated_cost: totals.cost,
          is_free_model: false,
          token_strategy: "standard",
          adapter_name: "native-passthrough",
          middleware_names: [],
          fallback_used: false,
          invocation_mode: "explicit-model",
        });
      } catch {
        // Stats must never break a request.
      }
    },
  };
}
