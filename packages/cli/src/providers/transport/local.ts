/**
 * LocalProvider — transport for local OpenAI-compatible providers.
 *
 * Supports Ollama, LM Studio, vLLM, MLX, and custom local endpoints.
 *
 * Transport concerns:
 * - Health checks (Ollama /api/tags → /v1/models fallback)
 * - Context window auto-detection (Ollama /api/show, LM Studio /v1/models)
 * - Custom undici agent with 10-minute timeouts for slow local inference
 * - LocalModelQueue for GPU concurrency control
 * - Provider-specific error messages
 */

import { Agent } from "undici";
import { credentials } from "../../auth/credentials/authority.js";
import { markOwnTimeout } from "../../handlers/shared/connection-error.js";
import { LocalModelQueue } from "../../handlers/shared/local-queue.js";
import { log } from "../../logger.js";
import type { LocalProvider as LocalProviderConfig } from "../../providers/provider-registry.js";
import {
  discoverViaLMStudio,
  discoverViaOllama,
  discoverViaOpenAIModels,
} from "./probe-discovery.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

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

export class LocalTransport implements ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat = "openai-sse";

  private config: LocalProviderConfig;
  private modelName: string;
  private concurrency?: number;
  /**
   * SUCCESS-ONLY latch: true once a probe has actually reached the server.
   * A FAILED probe must never set it — see the comment at the end of
   * `checkHealth()` for what setting it there made `refreshAuth()` return.
   */
  private healthChecked = false;
  private isHealthy = false;
  /**
   * The last error a health probe THREW, kept so `refreshAuth()` can hand it on
   * as a `cause`. `checkHealth()` catches its probe failures and only logs them;
   * without this field the syscall error — the sole evidence that this was a
   * failure to REACH the server rather than a server saying no — is destroyed
   * inside the catch, and `classifyConnectionError` returns `null` for every
   * ollama/lmstudio/vllm outage.
   */
  private lastProbeError: unknown;
  /** The URL of the probe that failed, for the same reason. */
  private lastProbeUrl: string | undefined;
  private _contextWindow = 32768;
  /** Cached result of the Ollama-backend probe; undefined until first probed. */
  private _isOllamaBackend?: boolean;

  constructor(config: LocalProviderConfig, modelName: string, options?: { concurrency?: number }) {
    this.config = config;
    this.modelName = modelName;
    this.name = config.name;
    this.displayName = DISPLAY_NAMES[config.name] || "Local";
    this.concurrency = options?.concurrency;

    // Check for env var override of context window
    const envContextWindow = process.env.CLAUDISH_CONTEXT_WINDOW;
    if (envContextWindow) {
      const parsed = Number.parseInt(envContextWindow, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
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
    // Local providers default to no auth. When the deployment requires it
    // (LM Studio "Reachable on local network", vLLM --api-key, remote Ollama
    // behind a reverse proxy), the user sets <PROVIDER>_API_KEY. For the four
    // known local providers the bearer token resolves through the credential
    // authority (env → config → op://) — the single source of truth. A "custom"
    // local endpoint (not registered in the authority) keeps its config.apiKey.
    if (this.config.name && this.config.name !== "custom") {
      const auth = await credentials.getRequestAuth(this.config.name, { model: "" });
      if (auth.headers.Authorization || auth.headers["x-api-key"]) {
        return { ...auth.headers };
      }
    }
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  async discoverProbeModel(exclude?: ReadonlySet<string>) {
    // Each local server gets the richest discovery surface it exposes:
    //   - Ollama: /api/ps (loaded) + /api/tags (all with size).
    //   - LM Studio: /api/v0/models with per-model loaded state, so we can
    //     pick a loaded model and avoid the "model loading error" 400 that
    //     happens when LM Studio fails to JIT-load a downloaded-but-cold
    //     model. Falls back to /v1/models if /api/v0 isn't available.
    //   - vLLM / MLX: plain /v1/models — no loaded-state distinction.
    const cacheKey = {
      key: `${this.config.name}:${this.config.baseUrl}`,
      displayName: this.displayName,
      exclude,
      hasApiKey: Boolean(this.config.apiKey),
    };
    if (await this.isOllamaBackend()) {
      return discoverViaOllama(this.config.baseUrl, {
        ...cacheKey,
        key: `ollama:${this.config.baseUrl}`,
      });
    }
    if (this.config.name === "lmstudio") {
      return discoverViaLMStudio(this.config.baseUrl, await this.getHeaders(), cacheKey);
    }
    return discoverViaOpenAIModels(
      `${this.config.baseUrl}/v1/models`,
      await this.getHeaders(),
      cacheKey
    );
  }

  getRequestInit(): Record<string, any> {
    return {
      // @ts-ignore - undici dispatcher for long-timeout local inference
      dispatcher: localProviderAgent,
      signal: AbortSignal.timeout(600000), // 10 minutes
    };
  }

  async getExtraPayloadFields(): Promise<Record<string, any>> {
    // Ollama defaults to 2048 context and silently truncates, so set it
    // explicitly for any endpoint that is actually an Ollama server, not only
    // the one literally named "ollama".
    if (await this.isOllamaBackend()) {
      const numCtx = Math.max(this._contextWindow, 32768);
      log(`[${this.displayName}] Setting num_ctx: ${numCtx} (detected: ${this._contextWindow})`);
      return { options: { num_ctx: numCtx } };
    }
    return {};
  }

  async enqueueRequest(
    fetchFn: () => Promise<Response>,
    opts?: { signal?: AbortSignal }
  ): Promise<Response> {
    if (!LocalModelQueue.isEnabled()) return fetchFn();
    return LocalModelQueue.getInstance().enqueue(
      fetchFn,
      this.name,
      this.concurrency,
      opts?.signal
    );
  }

  /**
   * Health check + context window fetch on first request.
   * Throws on failure so ComposedHandler can return an error response.
   */
  async refreshAuth(): Promise<void> {
    if (this.healthChecked) return;

    const healthy = await this.checkHealth();
    if (!healthy) {
      // `{ cause }` is the whole point. `classifyConnectionError` walks `.code`
      // and then the `.cause` chain to depth 8; the sentence below carries
      // neither a code nor any phrase the message fallback matches, so a bare
      // `new Error(msg)` classified as `null` and a stopped Ollama reached
      // ComposedHandler's refreshAuth catch as an unclassified failure — 401,
      // which `isRetryableError` treats as retryable, walking the user down the
      // fallback chain and onto metered billing while their own machine was
      // simply not running the server.
      throw Object.assign(
        new Error(this.getConnectionErrorMessage(), {
          cause: this.lastProbeError,
        }),
        { claudishEndpoint: this.lastProbeUrl ?? this.config.baseUrl }
      );
    }

    await this.fetchContextWindow();
  }

  getContextWindow(): number {
    return this._contextWindow;
  }

  /** Expose config for adapter access */
  getConfig(): LocalProviderConfig {
    return this.config;
  }

  // ─── Health checks ──────────────────────────────────────────────────

  /**
   * Whether this endpoint is actually an Ollama server, so the Ollama-only
   * treatment (num_ctx injection, /api/show context detection, /api/tags model
   * discovery) reaches a custom endpoint pointed at Ollama under a different
   * name, not just the provider literally named "ollama".
   *
   * The literal "ollama" provider is authoritative and answers without a probe;
   * any other recognized local provider (LM Studio, vLLM, MLX) names its own
   * backend and is never Ollama. Only a "custom"/unrecognized endpoint is probed
   * once against Ollama's /api/tags, whose {models:[...]} shape a generic
   * OpenAI-compatible server does not return. The result is cached, and a
   * network failure is treated as "not Ollama" rather than thrown.
   */
  private async isOllamaBackend(): Promise<boolean> {
    if (this.config.name === "ollama") return true;
    if (this.config.name !== "custom" && this.config.name in DISPLAY_NAMES) return false;
    if (this._isOllamaBackend !== undefined) return this._isOllamaBackend;

    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = (await response.json()) as any;
        this._isOllamaBackend = Array.isArray(data?.models);
      } else {
        this._isOllamaBackend = false;
      }
    } catch {
      this._isOllamaBackend = false;
    }
    log(
      `[${this.displayName}] Ollama backend probe (${this.config.baseUrl}): ${this._isOllamaBackend}`
    );
    return this._isOllamaBackend;
  }

  private async checkHealth(): Promise<boolean> {
    if (this.healthChecked) return this.isHealthy;

    // Each probe attempt starts from a clean slate: a stale error from an
    // earlier attempt must never be handed on as this failure's cause.
    this.lastProbeError = undefined;
    this.lastProbeUrl = undefined;

    // Try Ollama-specific health check first
    const healthUrl = `${this.config.baseUrl}/api/tags`;
    try {
      log(`[${this.displayName}] Trying health check: ${healthUrl}`);
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        this.isHealthy = true;
        this.healthChecked = true;
        log(`[${this.displayName}] Health check passed (/api/tags)`);
        return true;
      }
      log(`[${this.displayName}] /api/tags returned ${response.status}, trying /v1/models`);
    } catch (e: any) {
      // KEEP the error, do not merely log it. See `lastProbeError`'s docs: this
      // catch is where the connect evidence used to die.
      //
      // `markOwnTimeout` because the probe's 5 s ceiling is OURS: we asked "is
      // anything there" and got no answer inside a window we chose, which is a
      // reachability fact. Untagged, a `TimeoutError` is now deliberately
      // unclassified — see `connection-error.ts`'s `NAME_KIND` header for the
      // billing reason a transport's own inference ceiling must not be one.
      this.lastProbeError = markOwnTimeout(e);
      this.lastProbeUrl = healthUrl;
      log(`[${this.displayName}] /api/tags failed: ${e?.message || e}, trying /v1/models`);
    }

    // Try generic OpenAI-compatible health check
    const modelsUrl = `${this.config.baseUrl}/v1/models`;
    try {
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
      // Tagged for the same reason as the /api/tags probe above.
      this.lastProbeError = markOwnTimeout(e);
      this.lastProbeUrl = modelsUrl;
      log(`[${this.displayName}] /v1/models failed: ${e?.message || e}`);
    }

    // `healthChecked` latches SUCCESS ONLY. It used to be set here too, and
    // that made a retried `refreshAuth()` a LIE: `refreshAuth` opens with
    // `if (this.healthChecked) return;`, so the second call issued no probe and
    // DID NOT THROW — it returned successfully for a server that was still
    // dead. Harmless while nothing called it twice inside a request; the moment
    // a retry ladder does, attempt 2 resolves instantly, the episode closes as
    // "recovered", and a recovery record is written for an outage that never
    // ended, while the real failure re-appears milliseconds later from the
    // fetch path as a second, unrelated-looking episode.
    //
    // Three consequences of the fix, all wanted:
    //   - a retried refreshAuth() RE-PROBES, which is the entire point;
    //   - a dead local server costs one extra probe per request instead of
    //     latching unhealthy for the process lifetime. Against a refused
    //     loopback port that probe returns in ~1 ms;
    //   - a recovered server now runs fetchContextWindow(). Today it never
    //     does: the failed probe latched the flag that guards it, so the
    //     provider served forever on a stale context window.
    this.isHealthy = false;
    log(`[${this.displayName}] Health check FAILED - provider not available`);
    return false;
  }

  // ─── Context window auto-detection ──────────────────────────────────

  private async fetchContextWindow(): Promise<void> {
    // Skip if env var already set
    if (process.env.CLAUDISH_CONTEXT_WINDOW) return;

    log(`[${this.displayName}] Fetching context window...`);
    if (await this.isOllamaBackend()) {
      await this.fetchOllamaContextWindow();
    } else if (this.config.name === "lmstudio") {
      await this.fetchLMStudioContextWindow();
    } else {
      log(
        `[${this.displayName}] No context window fetch for this provider, using default: ${this._contextWindow}`
      );
    }
  }

  private async fetchOllamaContextWindow(): Promise<void> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.modelName }),
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        let ctxFromInfo = data.model_info?.["general.context_length"];

        // Search for {arch}.context_length if not found at general.context_length
        if (!ctxFromInfo && data.model_info) {
          for (const key of Object.keys(data.model_info)) {
            if (key.endsWith(".context_length")) {
              ctxFromInfo = data.model_info[key];
              break;
            }
          }
        }

        const ctxFromParams = data.parameters?.match(/num_ctx\s+(\d+)/)?.[1];
        if (ctxFromInfo) {
          this._contextWindow = Number.parseInt(String(ctxFromInfo), 10);
        } else if (ctxFromParams) {
          this._contextWindow = Number.parseInt(ctxFromParams, 10);
        } else {
          log(`[${this.displayName}] No context info found, using default: ${this._contextWindow}`);
        }
        if (ctxFromInfo || ctxFromParams) {
          log(`[${this.displayName}] Context window: ${this._contextWindow}`);
        }
      }
    } catch {
      // Use default context window
    }
  }

  private async fetchLMStudioContextWindow(): Promise<void> {
    try {
      const response = await fetch(`${this.config.baseUrl}/v1/models`, {
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

        this._contextWindow = 32768;
        log(`[${this.displayName}] Using default context window: ${this._contextWindow}`);
      }
    } catch (e: any) {
      this._contextWindow = 32768;
      log(
        `[${this.displayName}] Failed to fetch model info: ${e?.message || e}. Using default: ${this._contextWindow}`
      );
    }
  }

  // ─── Error messages ─────────────────────────────────────────────────

  private getConnectionErrorMessage(): string {
    switch (this.config.name) {
      case "ollama":
        return `Cannot connect to Ollama at ${this.config.baseUrl}. Make sure Ollama is running with: ollama serve`;
      case "lmstudio":
        return `Cannot connect to LM Studio at ${this.config.baseUrl}. Make sure LM Studio server is running.`;
      case "vllm":
        return `Cannot connect to vLLM at ${this.config.baseUrl}. Make sure vLLM server is running.`;
      default:
        return `Cannot connect to ${this.config.name} at ${this.config.baseUrl}. Make sure the server is running.`;
    }
  }
}
