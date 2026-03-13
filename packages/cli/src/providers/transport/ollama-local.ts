/**
 * OllamaTransport: transport for local Ollama instances.
 *
 * Extends LocalTransport with Ollama-specific concerns:
 * - Health check via /api/tags (fast detection), /v1/models fallback
 * - Context window detection via /api/show
 * - num_ctx injection to prevent silent context truncation
 * - Ollama-specific error message ("ollama serve")
 */

import { LocalTransport } from "./local.js";
import { log } from "../../logger.js";

export class OllamaTransport extends LocalTransport {
  // ─── Ollama payload injection ───────────────────────────────────────

  getExtraPayloadFields(): Record<string, any> {
    // Ollama defaults to 2048 context and silently truncates, so set it explicitly
    const numCtx = Math.max(this._contextWindow, 32768);
    log(`[${this.displayName}] Setting num_ctx: ${numCtx} (detected: ${this._contextWindow})`);
    return { options: { num_ctx: numCtx } };
  }

  // ─── Ollama health check ────────────────────────────────────────────

  protected override async checkHealth(): Promise<boolean> {
    if (this.healthChecked) return this.isHealthy;

    // Try Ollama's native /api/tags first (faster than /v1/models)
    try {
      const healthUrl = `${this.baseUrl}/api/tags`;
      log(`[${this.displayName}] Trying health check: ${healthUrl}`);
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        this.isHealthy = true;
        this.healthChecked = true;
        log(`[${this.displayName}] Health check passed (/api/tags)`);
        return true;
      }
      log(`[${this.displayName}] /api/tags returned ${response.status}, trying /v1/models`);
    } catch (e: any) {
      log(`[${this.displayName}] /api/tags not available, trying /v1/models`);
    }

    // Fall back to generic /v1/models health check
    return super.checkHealth();
  }

  // ─── Ollama context window via /api/show ────────────────────────────

  protected override async fetchContextWindow(): Promise<void> {
    if (process.env.CLAUDISH_CONTEXT_WINDOW) return;

    log(`[${this.displayName}] Fetching context window...`);

    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
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
          this._contextWindow = parseInt(String(ctxFromInfo), 10);
        } else if (ctxFromParams) {
          this._contextWindow = parseInt(ctxFromParams, 10);
        } else {
          log(
            `[${this.displayName}] No context info from /api/show, using default: ${this._contextWindow}`
          );
          return;
        }
        log(`[${this.displayName}] Context window: ${this._contextWindow}`);
        return;
      }
    } catch {
      // Fall through to generic /v1/models detection
    }

    // Fall back to generic /v1/models context window detection
    await this.fetchModelsContextWindow();
  }

  // ─── Ollama error message ───────────────────────────────────────────

  protected override getConnectionErrorMessage(): string {
    return `Cannot connect to Ollama at ${this.baseUrl}. Make sure Ollama is running with: ollama serve`;
  }
}
