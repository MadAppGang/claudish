/**
 * What the native passthrough tells the Claude API launch's meter about one
 * forwarded request, and how a streamed response's usage is read. No imports:
 * the passthrough needs these without the meter's pricing and stats modules.
 */

/** Anthropic's usage object, as a response or its stream reports it. */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** One forwarded `/v1/messages` request, after its response ended. */
export interface ClaudeApiTurn {
  /** The model the request named (Claude Code's own id). */
  model: string;
  /** The upstream HTTP status; 0 when no response arrived. */
  status: number;
  latencyMs: number;
  usage?: AnthropicUsage;
  /** The client went away before the response ended. */
  cancelled?: boolean;
  /** The request failed without a usable response: the fetch or the stream read threw. */
  error?: unknown;
  /**
   * The stream carried an SSE error event (its `error.type`, e.g.
   * `overloaded_error`), so the request failed although the HTTP status was 2xx.
   */
  streamErrorType?: string;
}

export interface ClaudeApiMeter {
  /** Record one forwarded `/v1/messages` request, after its response ended. */
  record(turn: ClaudeApiTurn): void;
}

/**
 * Merge the usage one Anthropic SSE `data:` line reports into `usage`, the way
 * the Anthropic stream parser does: `message_start` carries input and cache
 * counts under `message.usage`, `message_delta` the output under `usage`. A
 * line that is not a JSON `data:` line changes nothing.
 */
export function mergeSseUsage(line: string, usage: AnthropicUsage): void {
  if (!line.startsWith("data:")) return;
  let data: { message?: { usage?: AnthropicUsage }; usage?: AnthropicUsage } | null;
  try {
    data = JSON.parse(line.slice("data:".length).trim());
  } catch {
    return;
  }
  for (const u of [data?.message?.usage, data?.usage]) {
    if (!u || typeof u !== "object") continue;
    usage.input_tokens = u.input_tokens || usage.input_tokens;
    usage.output_tokens = u.output_tokens || usage.output_tokens;
    usage.cache_read_input_tokens = u.cache_read_input_tokens || usage.cache_read_input_tokens;
    usage.cache_creation_input_tokens =
      u.cache_creation_input_tokens || usage.cache_creation_input_tokens;
  }
}
