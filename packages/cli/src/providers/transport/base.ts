/**
 * BaseTransport — abstract base for all ProviderTransport implementations.
 *
 * Owns a RequestQueue for rate limiting and provides common auth patterns.
 * Subclass ApiKeyTransport for Bearer/x-api-key auth.
 * Subclass OAuthTransport for token-based auth with refresh.
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import { RequestQueue, type RequestQueueConfig } from "../../handlers/shared/request-queue.js";

export abstract class BaseTransport implements ProviderTransport {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly streamFormat: StreamFormat;
  readonly tokenStrategy?: ProviderTransport["tokenStrategy"];

  protected queue: RequestQueue;

  constructor(label: string, queueConfig?: RequestQueueConfig) {
    this.queue = new RequestQueue(label, queueConfig);
  }

  abstract getEndpoint(model?: string): string;
  abstract getHeaders(): Promise<Record<string, string>>;

  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    return this.queue.enqueue(fetchFn);
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
    queueConfig?: RequestQueueConfig,
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
