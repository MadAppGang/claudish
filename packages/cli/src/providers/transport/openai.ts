/**
 * OpenAI ProviderTransport
 *
 * Handles communication with OpenAI's API (and OpenAI-compatible providers
 * like GLM, Zen). Supports both Chat Completions and Codex Responses API.
 * Includes 30-second timeout with detailed error reporting.
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { LocalModelQueue } from "../../handlers/shared/local-queue.js";
import { ConcurrencyLimiter } from "../../handlers/shared/concurrency-limiter.js";
import { log } from "../../logger.js";
import { isQuotaWall } from "./quota-wall.js";

export class OpenAIProviderTransport implements ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat;

  protected provider: RemoteProvider;
  private apiKey: string;
  private modelName: string;
  private maxConcurrency?: number;
  private limiter?: ConcurrencyLimiter;

  constructor(
    provider: RemoteProvider,
    modelName: string,
    apiKey: string,
    maxConcurrency?: number
  ) {
    this.provider = provider;
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.name = provider.name;
    this.maxConcurrency = maxConcurrency;
    this.displayName = OpenAIProviderTransport.formatDisplayName(provider.name);

    // Codex models use the Responses API which has a different streaming format
    this.streamFormat = modelName.toLowerCase().includes("codex")
      ? "openai-responses-sse"
      : "openai-sse";

    if (this.maxConcurrency !== undefined) {
      log(
        `[${this.displayName}] Concurrency: ${this.maxConcurrency === 0 ? "unlimited" : this.maxConcurrency}`
      );
    }
    // Per-instance cap (independent per provider — see ConcurrencyLimiter docs).
    // 0 = unlimited (no limiter). Gated by CLAUDISH_LOCAL_QUEUE_ENABLED so that env
    // var also disables remote caps.
    if (this.maxConcurrency !== undefined && this.maxConcurrency > 0 && LocalModelQueue.isEnabled()) {
      this.limiter = new ConcurrencyLimiter(this.maxConcurrency, this.displayName);
    }
  }

  getEndpoint(): string {
    if (this.modelName.toLowerCase().includes("codex")) {
      return `${this.provider.baseUrl}/v1/responses`;
    }
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  /**
   * Honor the optional streamFormatOverride declared on the RemoteProvider.
   * Lets a custom endpoint (e.g. an aggregator whose openai transport actually
   * speaks anthropic-sse) win over the dialect's default choice of openai-sse.
   */
  overrideStreamFormat(): StreamFormat | undefined {
    return this.provider.streamFormatOverride;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Override fetch with 30-second timeout, 429 retry with exponential backoff,
   * and detailed error handling.
   *
   * If `maxConcurrency` is set (capacity-limited backends, e.g. a single-GPU
   * vLLM server, or a remote provider that must not pile up unbounded slow
   * streams), each ATTEMPT is run through a per-instance ConcurrencyLimiter so
   * at most N requests are in flight to THIS backend at once — independent of
   * other providers' caps. Unset / 0 = unbounded (the default, unchanged
   * behavior for every standard remote provider).
   *
   * The cap gates the fetch, NOT the backoff sleep. During a 429 backoff no
   * request is in flight, so holding a slot there contradicts what the cap is
   * documented to do, and converts one throttled request into a full ladder
   * (2+4+8+16+30s ≈ 62.5s) of head-of-line blocking for every other caller of
   * the same provider: with a cap of 6, six throttled requests stall the whole
   * lane while the backend sits idle. Diagnosed 2026-08-24 on the GLM lane,
   * where a burst 429 amplified into fleet-wide `Connection lost mid-response`.
   * GeminiCodeAssistTransport already gates per attempt; this aligns with it.
   *
   * Re-acquiring puts a retry at the BACK of the FIFO queue, which is wanted: a
   * request the backend just throttled should not cut ahead of traffic it has
   * not. Patience is unchanged — same maxRetries, same delays, same responses.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const gate = (fn: () => Promise<Response>): Promise<Response> =>
      this.limiter ? this.limiter.run(fn) : fn();

    const runWith429Retry = async (): Promise<Response> => {
      const maxRetries = 5;
      let lastResponse: Response | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await gate(fetchFn);

          if (response.status === 429 && attempt < maxRetries) {
            lastResponse = response;
            // A wall will still be a wall after the ladder — give up now so the
            // caller's deadline is not spent asleep. Bursts still retry (narrow predicate).
            if (await isQuotaWall(response, this.displayName)) return response;
            // Parse Retry-After header if present
            const retryAfter = response.headers.get("Retry-After");
            let delayMs: number;
            if (retryAfter && !Number.isNaN(Number(retryAfter))) {
              delayMs = Math.min(Number(retryAfter) * 1000, 30000);
            } else {
              // Exponential backoff: 2s, 4s, 8s, 16s, 30s
              delayMs = Math.min(2000 * Math.pow(2, attempt), 30000);
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
    };

    // Capacity-limited backend (e.g. single-GPU vLLM, or a slow remote provider
    // that must not be allowed to pile up unbounded streams and starve the event
    // loop). Gating happens per attempt inside the loop above (see `gate`), so a
    // backoff sleep never occupies a slot the backend could be serving with.
    return runWith429Retry();
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
