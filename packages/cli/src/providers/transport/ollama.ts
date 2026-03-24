/**
 * OllamaTransport — transport for local Ollama instances.
 *
 * Overrides from LocalTransport:
 * - Health check: tries /api/tags first (Ollama-native), then /v1/models fallback
 * - Context window: fetches from /api/show (model_info, parameters)
 * - Extra payload: injects num_ctx to prevent Ollama's silent 2048 truncation
 * - Error message: Ollama-specific connection guidance
 */

import type { LocalProvider as LocalProviderConfig } from "../provider-registry.js";
import { LocalTransport } from "./local.js";
import { log } from "../../logger.js";

export class OllamaTransport extends LocalTransport {
  constructor(config: LocalProviderConfig, modelName: string, options?: { concurrency?: number }) {
    super(config, modelName, options);
  }

  getExtraPayloadFields(): Record<string, any> {
    const ctxWindow = this.getContextWindow();
    const numCtx = Math.max(ctxWindow, 32768);
    log(`[${this.displayName}] Setting num_ctx: ${numCtx} (detected: ${ctxWindow})`);
    return { options: { num_ctx: numCtx } };
  }

  protected async checkHealth(): Promise<boolean> {
    const config = this.getConfig();

    // Try Ollama-native /api/tags first
    try {
      const healthUrl = `${config.baseUrl}/api/tags`;
      log(`[${this.displayName}] Trying health check: ${healthUrl}`);
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        log(`[${this.displayName}] Health check passed (/api/tags)`);
        return true;
      }
      log(`[${this.displayName}] /api/tags returned ${response.status}, trying /v1/models`);
    } catch (e: any) {
      log(`[${this.displayName}] /api/tags failed: ${e?.message || e}, trying /v1/models`);
    }

    // Fall back to generic OpenAI-compatible check
    return super.checkHealth();
  }

  protected async fetchContextWindow(): Promise<void> {
    if (process.env.CLAUDISH_CONTEXT_WINDOW) return;

    log(`[${this.displayName}] Fetching context window...`);
    const config = this.getConfig();

    try {
      const response = await fetch(`${config.baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.getModelName() }),
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
          this.setContextWindow(parseInt(String(ctxFromInfo), 10));
        } else if (ctxFromParams) {
          this.setContextWindow(parseInt(ctxFromParams, 10));
        } else {
          log(`[${this.displayName}] No context info found, using default: ${this.getContextWindow()}`);
        }
        if (ctxFromInfo || ctxFromParams) {
          log(`[${this.displayName}] Context window: ${this.getContextWindow()}`);
        }
      }
    } catch {
      // Use default context window
    }
  }

  protected getConnectionErrorMessage(): string {
    const config = this.getConfig();
    return `Cannot connect to Ollama at ${config.baseUrl}. Make sure Ollama is running with: ollama serve`;
  }
}
