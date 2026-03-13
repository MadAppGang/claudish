/**
 * LocalTransport: transport for local OpenAI-compatible providers.
 *
 * Extends BaseTransport (no auth). Adds local-specific concerns:
 * - Health checks via /v1/models
 * - Context window auto-detection via /v1/models
 * - Custom undici agent with 10-minute timeouts for slow local inference
 * - LocalModelQueue for GPU concurrency control
 *
 * Subclassed by OllamaTransport for Ollama-specific behavior.
 */

import type { StreamFormat } from "./types.js";
import { BaseTransport } from "./base.js";
import type { TransportConfig } from "./base.js";
import { LocalModelQueue } from "../../handlers/shared/local-queue.js";
import { log } from "../../logger.js";
import { Agent } from "undici";

// Custom undici agent with long timeouts for local LLM inference
// Default undici headersTimeout is 30s which is too short for prompt processing
const localProviderAgent = new Agent({
  headersTimeout: 600000, // 10 minutes for headers (prompt processing time)
  bodyTimeout: 600000, // 10 minutes for body (generation time)
  keepAliveTimeout: 30000, // 30 seconds keepalive
  keepAliveMaxTimeout: 600000,
});

export class LocalTransport extends BaseTransport {
  readonly streamFormat: StreamFormat = "openai-sse";

  private concurrency?: number;
  protected healthChecked = false;
  protected isHealthy = false;
  protected _contextWindow = 32768;

  constructor(
    config: TransportConfig,
    options?: { concurrency?: number }
  ) {
    super(config);
    this.concurrency = options?.concurrency;

    // Check for env var override of context window
    const envContextWindow = process.env.CLAUDISH_CONTEXT_WINDOW;
    if (envContextWindow) {
      const parsed = parseInt(envContextWindow, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this._contextWindow = parsed;
        log(`[${this.displayName}] Context window from env: ${this._contextWindow}`);
      }
    }

    if (this.concurrency !== undefined) {
      log(
        `[${this.displayName}] Concurrency: ${this.concurrency === 0 ? "unlimited" : this.concurrency}`
      );
    }
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {};
  }

  getRequestInit(): Record<string, any> {
    return {
      // @ts-ignore - undici dispatcher for long-timeout local inference
      dispatcher: localProviderAgent,
      signal: AbortSignal.timeout(600000), // 10 minutes
    };
  }

  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    if (!LocalModelQueue.isEnabled()) return fetchFn();
    return LocalModelQueue.getInstance().enqueue(fetchFn, this.name, this.concurrency);
  }

  /**
   * Health check + context window fetch on first request.
   * Throws on failure so ProviderHandler can return an error response.
   */
  async refreshAuth(): Promise<void> {
    if (this.healthChecked) return;

    const healthy = await this.checkHealth();
    if (!healthy) {
      throw new Error(this.getConnectionErrorMessage());
    }

    await this.fetchContextWindow();
  }

  getContextWindow(): number {
    return this._contextWindow;
  }

  // ─── Health check ───────────────────────────────────────────────────

  protected async checkHealth(): Promise<boolean> {
    if (this.healthChecked) return this.isHealthy;

    try {
      const modelsUrl = `${this.baseUrl}/v1/models`;
      log(`[${this.displayName}] Trying health check: ${modelsUrl}`);
      const response = await fetch(modelsUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        this.isHealthy = true;
        this.healthChecked = true;
        log(`[${this.displayName}] Health check passed (/v1/models)`);
        return true;
      }
      log(`[${this.displayName}] /v1/models returned ${response.status}`);
    } catch (e: any) {
      log(`[${this.displayName}] /v1/models failed: ${e?.message || e}`);
    }

    this.healthChecked = true;
    this.isHealthy = false;
    log(`[${this.displayName}] Health check FAILED - provider not available`);
    return false;
  }

  // ─── Context window auto-detection ──────────────────────────────────

  protected async fetchContextWindow(): Promise<void> {
    if (process.env.CLAUDISH_CONTEXT_WINDOW) return;

    log(`[${this.displayName}] Fetching context window...`);
    await this.fetchModelsContextWindow();
  }

  protected async fetchModelsContextWindow(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        log(`[${this.displayName}] Models response: ${JSON.stringify(data).slice(0, 500)}`);

        const models = data.data || [];
        const targetModel =
          models.find((m: any) => m.id === this.modelName) ||
          models.find((m: any) => m.id?.endsWith(`/${this.modelName}`)) ||
          models.find((m: any) => this.modelName.includes(m.id));

        if (targetModel) {
          const ctxLength =
            targetModel.context_length ||
            targetModel.max_context_length ||
            targetModel.context_window ||
            targetModel.max_tokens;
          if (ctxLength && typeof ctxLength === "number") {
            this._contextWindow = ctxLength;
            log(`[${this.displayName}] Context window from model: ${this._contextWindow}`);
            return;
          }
        }

        log(`[${this.displayName}] Using default context window: ${this._contextWindow}`);
      }
    } catch (e: any) {
      log(
        `[${this.displayName}] Failed to fetch model info: ${e?.message || e}. Using default: ${this._contextWindow}`
      );
    }
  }

  // ─── Error message ──────────────────────────────────────────────────

  protected getConnectionErrorMessage(): string {
    return `Cannot connect to ${this.displayName} at ${this.baseUrl}. Make sure the server is running.`;
  }
}
