/**
 * LocalTransport — base transport for local OpenAI-compatible providers.
 *
 * Generic base for vLLM, MLX, custom URLs, and any OpenAI-compatible local endpoint.
 * Provider-specific behavior lives in subclasses:
 *   - OllamaTransport: /api/tags health check, /api/show context window, num_ctx injection
 *   - LMStudioTransport: /v1/models context window detection
 *
 * Transport concerns:
 * - Health checks (/v1/models for generic providers)
 * - Custom undici agent with 10-minute timeouts for slow local inference
 * - LocalModelQueue for GPU concurrency control
 */

import type { StreamFormat } from "./types.js";
import type { LocalProvider as LocalProviderConfig } from "../../providers/provider-registry.js";
import { BaseTransport } from "./base.js";
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

const DISPLAY_NAMES: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  vllm: "vLLM",
  mlx: "MLX",
  custom: "Custom",
};

export class LocalTransport extends BaseTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat = "openai-sse";
  readonly tokenStrategy = "local" as const;

  protected config: LocalProviderConfig;
  protected modelName: string;
  private concurrency?: number;
  private healthChecked = false;
  private _contextWindow = 32768;

  constructor(config: LocalProviderConfig, modelName: string, options?: { concurrency?: number }) {
    super(config.name);
    this.config = config;
    this.modelName = modelName;
    this.name = config.name;
    this.displayName = DISPLAY_NAMES[config.name] || "Local";
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

  getEndpoint(): string {
    return `${this.config.baseUrl}${this.config.apiPath}`;
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

  getExtraPayloadFields(): Record<string, any> {
    return {};
  }

  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    if (!LocalModelQueue.isEnabled()) return fetchFn();
    return LocalModelQueue.getInstance().enqueue(fetchFn, this.name, this.concurrency);
  }

  /**
   * Health check + context window fetch on first request.
   * Throws on failure so ComposedHandler can return an error response.
   */
  async refreshAuth(): Promise<void> {
    if (this.healthChecked) return;

    const healthy = await this.checkHealth();
    if (!healthy) {
      throw new Error(this.getConnectionErrorMessage());
    }

    this.healthChecked = true;
    await this.fetchContextWindow();
  }

  getContextWindow(): number {
    return this._contextWindow;
  }

  /** Expose config for adapter access */
  getConfig(): LocalProviderConfig {
    return this.config;
  }

  /** Expose model name for subclass access */
  getModelName(): string {
    return this.modelName;
  }

  /** Allow subclasses to update the context window */
  protected setContextWindow(value: number): void {
    this._contextWindow = value;
  }

  // --- Health checks ---

  /**
   * Generic health check: tries /v1/models.
   * Subclasses can override to try provider-specific endpoints first,
   * then call super.checkHealth() as fallback.
   */
  protected async checkHealth(): Promise<boolean> {
    try {
      const modelsUrl = `${this.config.baseUrl}/v1/models`;
      log(`[${this.displayName}] Trying health check: ${modelsUrl}`);
      const response = await fetch(modelsUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        log(`[${this.displayName}] Health check passed (/v1/models)`);
        return true;
      }
      log(`[${this.displayName}] /v1/models returned ${response.status}`);
    } catch (e: any) {
      log(`[${this.displayName}] /v1/models failed: ${e?.message || e}`);
    }

    log(`[${this.displayName}] Health check FAILED - provider not available`);
    return false;
  }

  // --- Context window auto-detection ---

  /**
   * Fetch context window from the provider API.
   * Base implementation is a no-op (uses default). Subclasses override for
   * provider-specific detection (Ollama /api/show, LM Studio /v1/models).
   */
  protected async fetchContextWindow(): Promise<void> {
    if (process.env.CLAUDISH_CONTEXT_WINDOW) return;

    log(
      `[${this.displayName}] No context window fetch for this provider, using default: ${this._contextWindow}`
    );
  }

  // --- Error messages ---

  protected getConnectionErrorMessage(): string {
    switch (this.config.name) {
      case "vllm":
        return `Cannot connect to vLLM at ${this.config.baseUrl}. Make sure vLLM server is running.`;
      default:
        return `Cannot connect to ${this.config.name} at ${this.config.baseUrl}. Make sure the server is running.`;
    }
  }
}
