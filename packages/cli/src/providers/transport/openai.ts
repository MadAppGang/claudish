/**
 * OpenAI ProviderTransport
 *
 * Handles communication with OpenAI's API (and OpenAI-compatible providers
 * like GLM, Zen). Supports both Chat Completions and Codex Responses API.
 * Includes 30-second timeout with detailed error reporting.
 */

import { isQuotaExhaustionError } from "../../handlers/shared/quota-exhaustion.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { log } from "../../logger.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

export class OpenAIProviderTransport implements ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat;

  protected provider: RemoteProvider;
  private apiKey: string;
  protected modelName: string;

  constructor(provider: RemoteProvider, modelName: string, apiKey: string) {
    this.provider = provider;
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.name = provider.name;
    this.displayName = OpenAIProviderTransport.formatDisplayName(provider.name);

    // Codex models use the Responses API which has a different streaming format
    this.streamFormat = modelName.toLowerCase().includes("codex")
      ? "openai-responses-sse"
      : "openai-sse";
  }

  getEndpoint(): string {
    if (this.modelName.toLowerCase().includes("codex")) {
      return `${this.provider.baseUrl}/v1/responses`;
    }
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Override fetch with 30-second timeout and bounded 429 retry. The retry
   * budget is intentionally tight (~3s worst case) so probe deadlines and
   * user-perceived latency stay reasonable — long retry chains on rate
   * limits are worse UX than honest failures.
   *
   * Terminal 429s (billing/balance errors) are detected by body sniff and
   * skip the retry chain entirely: retrying a balance error wastes wall
   * clock and lies about endpoint health.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const maxRetries = 2;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetchFn();

        if (response.status === 429 && attempt < maxRetries) {
          // Sniff body for terminal billing/quota errors. Clone first so the
          // caller still gets a readable body if we return this response.
          const bodyText = await response
            .clone()
            .text()
            .catch(() => "");
          if (isTerminal429(bodyText)) {
            log(`[${this.displayName}] 429 is terminal (billing/quota), not retrying`);
            return response;
          }
          lastResponse = response;
          const retryAfter = response.headers.get("Retry-After");
          let delayMs: number;
          if (retryAfter && !Number.isNaN(Number(retryAfter))) {
            delayMs = Math.min(Number(retryAfter) * 1000, 2000);
          } else {
            // 500ms, 1000ms — quick recovery without blowing probe budget
            delayMs = 500 * (attempt + 1);
          }
          log(
            `[${this.displayName}] 429 rate limited, retry ${attempt + 1}/${maxRetries} in ${(delayMs / 1000).toFixed(1)}s`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        return response;
      } catch (fetchError: any) {
        if (fetchError.name === "AbortError") {
          log(`[${this.displayName}] Request timed out after 30s`);
          throw new OpenAITimeoutError(this.provider.baseUrl);
        }
        if (fetchError.cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
          log(`[${this.displayName}] Connection timeout: ${fetchError.message}`);
          throw new OpenAIConnectionError(this.provider.baseUrl, fetchError.cause?.code);
        }
        throw fetchError;
      }
    }

    // All retries exhausted — return the last 429 response
    return lastResponse!;
  }

  static formatDisplayName(name: string): string {
    if (name === "opencode-zen") return "Zen";
    if (name === "opencode-zen-go") return "Zen Go";
    if (name === "glm") return "GLM";
    if (name === "glm-coding") return "GLM Coding";
    if (name === "openai") return "OpenAI";
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

/**
 * Detect 429 response bodies that indicate a non-retryable condition —
 * billing/balance errors that won't resolve no matter how long we wait.
 * Conservative: only matches well-known patterns, falls through to retry
 * for anything ambiguous.
 *
 * Examples caught:
 *   - GLM/Zhipu: code 1113, "Insufficient balance or no resource package"
 *   - OpenAI:    "You exceeded your current quota"
 *   - Many:     "insufficient_quota", "billing_not_active", "out of credits"
 */
export function isTerminal429(body: string): boolean {
  if (!body) return false;

  // A spent SUBSCRIPTION allowance is terminal for this request even though it is
  // not a billing failure. Zen Go answers `429 "5-hour usage limit reached.
  // Resets in 3hr 17min"` — a window that refills on a clock, so no amount of
  // backoff inside one request can recover it. Without this, the transport's
  // 429 loop retried it until the caller's timeout: a `create_session` against a
  // bare `minimax-m2.5` burned its full 60s budget retrying an exhausted plan
  // instead of failing fast so the fallback chain could reach the metered
  // provider that was ready to serve.
  if (isQuotaExhaustionError(429, body)) return true;

  const lower = body.toLowerCase();
  return (
    lower.includes("insufficient balance") ||
    lower.includes("insufficient_balance") ||
    lower.includes("insufficient_quota") ||
    lower.includes("insufficient quota") ||
    lower.includes("billing_not_active") ||
    lower.includes("billing not active") ||
    lower.includes("quota_exceeded") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("out of credits") ||
    lower.includes('"code":"1113"') ||
    lower.includes('"code":1113')
  );
}

export class OpenAITimeoutError extends Error {
  constructor(baseUrl: string) {
    super(`Request to OpenAI API timed out. Check your network connection to ${baseUrl}`);
    this.name = "OpenAITimeoutError";
  }
}

export class OpenAIConnectionError extends Error {
  constructor(baseUrl: string, code: string) {
    super(
      `Cannot connect to OpenAI API (${baseUrl}). This may be due to: network/firewall blocking, VPN interference, or regional restrictions. Error: ${code}`
    );
    this.name = "OpenAIConnectionError";
  }
}

// Backward-compatible alias
/** @deprecated Use OpenAIProviderTransport */
export { OpenAIProviderTransport as OpenAIProvider };
