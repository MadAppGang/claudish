/**
 * BaseTransport — abstract base for all ProviderTransport implementations.
 *
 * Owns a RequestQueue for rate limiting. Queue behavior is configured
 * via method overrides, not external hook functions:
 *   - onResponse(): rate limit detection (override for Gemini, OpenRouter)
 *   - shouldRetry(): 5xx retry logic (override for local OOM)
 *
 * Subclass ApiKeyTransport for Bearer/x-api-key auth.
 * Subclass OAuthTransport for token-based auth with refresh.
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import { RequestQueue, type QueueState, type RequestQueueConfig } from "../../handlers/shared/request-queue.js";

export abstract class BaseTransport implements ProviderTransport {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly streamFormat: StreamFormat;
  readonly tokenStrategy?: ProviderTransport["tokenStrategy"];

  protected queue: RequestQueue;

  constructor(label: string, queueConfig?: Omit<RequestQueueConfig, "onResponse" | "shouldRetry" | "calculateDelay">) {
    this.queue = new RequestQueue(label, {
      ...queueConfig,
      onResponse: (response, state) => this.onResponse(response, state),
      shouldRetry: (response, errorBody) => this.shouldRetry(response, errorBody),
      calculateDelay: (state) => this.calculateDelay(state),
    });
  }

  abstract getEndpoint(model?: string): string;
  abstract getHeaders(): Promise<Record<string, string>>;

  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    return this.queue.enqueue(fetchFn);
  }

  /** Called after each response. Return true if rate limited. Default: 429 detection. */
  protected onResponse(response: Response, _state: QueueState): boolean {
    return response.status === 429;
  }

  /** Called on 5xx. Return true to retry once. Default: no retry. */
  protected shouldRetry(_response: Response, _errorBody: string): boolean {
    return false;
  }

  /** Override delay calculation. Default: base delay with error backoff. */
  protected calculateDelay(state: QueueState): number {
    let d = state.baseDelayMs;
    if (state.consecutiveErrors > 0) d = Math.min(d * (1 + state.consecutiveErrors * 0.5), state.maxDelayMs);
    return d;
  }
}

export abstract class ApiKeyTransport extends BaseTransport {
  protected apiKey: string;
  protected baseUrl: string;
  protected apiPath: string;

  constructor(
    label: string,
    baseUrl: string,
    apiPath: string,
    apiKey: string,
    queueConfig?: Omit<RequestQueueConfig, "onResponse" | "shouldRetry" | "calculateDelay">,
  ) {
    super(label, queueConfig);
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.apiPath = apiPath;
  }

  getEndpoint(_model?: string): string {
    return `${this.baseUrl}${this.apiPath}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
  }
}

export abstract class OAuthTransport extends BaseTransport {
  protected accessToken = "";

  async getHeaders(): Promise<Record<string, string>> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.accessToken}`,
    };
  }
}
