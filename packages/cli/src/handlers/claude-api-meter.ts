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

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
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

  return {
    record(turn: ClaudeApiTurn): void {
      const ok = turn.error === undefined && isSuccess(turn.status);
      // Anthropic bills the tokens a response reported, a cancelled stream's
      // included; a failed request reports none and changes no counter.
      if (ok && turn.usage) {
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
          tracker.update(input, output, detail);
        } else {
          const cost = computeTurnCost(
            getModelPricing(CLAUDE_API_PROVIDER, turn.model),
            input,
            output,
            detail
          );
          tracker.addSideTurn(cost, input, output, detail);
        }
      }

      try {
        const failure = turn.cancelled
          ? { error_class: "cancelled", error_code: "client_cancelled" }
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
          input_tokens: tracker.getInputTokens(),
          output_tokens: tracker.getOutputTokens(),
          estimated_cost: tracker.getTotalCost(),
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
