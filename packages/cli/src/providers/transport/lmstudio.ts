/**
 * LMStudioTransport — transport for local LM Studio instances.
 *
 * Overrides from LocalTransport:
 * - Context window: fetches from /v1/models (context_length, max_context_length, etc.)
 * - Error message: LM Studio-specific connection guidance
 */

import type { LocalProvider as LocalProviderConfig } from "../provider-registry.js";
import { LocalTransport } from "./local.js";
import { log } from "../../logger.js";

export class LMStudioTransport extends LocalTransport {
  constructor(config: LocalProviderConfig, modelName: string, options?: { concurrency?: number }) {
    super(config, modelName, options);
  }

  protected async fetchContextWindow(): Promise<void> {
    if (process.env.CLAUDISH_CONTEXT_WINDOW) return;

    log(`[${this.displayName}] Fetching context window...`);
    const config = this.getConfig();

    try {
      const response = await fetch(`${config.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        log(`[${this.displayName}] Models response: ${JSON.stringify(data).slice(0, 500)}`);

        const models = data.data || [];
        const modelName = this.getModelName();
        const targetModel =
          models.find((m: any) => m.id === modelName) ||
          models.find((m: any) => m.id?.endsWith(`/${modelName}`)) ||
          models.find((m: any) => modelName.includes(m.id));

        if (targetModel) {
          const ctxLength =
            targetModel.context_length ||
            targetModel.max_context_length ||
            targetModel.context_window ||
            targetModel.max_tokens;
          if (ctxLength && typeof ctxLength === "number") {
            this.setContextWindow(ctxLength);
            log(`[${this.displayName}] Context window from model: ${this.getContextWindow()}`);
            return;
          }
        }

        this.setContextWindow(32768);
        log(`[${this.displayName}] Using default context window: ${this.getContextWindow()}`);
      }
    } catch (e: any) {
      this.setContextWindow(32768);
      log(
        `[${this.displayName}] Failed to fetch model info: ${e?.message || e}. Using default: ${this.getContextWindow()}`
      );
    }
  }

  protected getConnectionErrorMessage(): string {
    const config = this.getConfig();
    return `Cannot connect to LM Studio at ${config.baseUrl}. Make sure LM Studio server is running.`;
  }
}
