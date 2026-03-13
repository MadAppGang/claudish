/**
 * AdapterManager — selects the appropriate ModelAdapter for a given model ID.
 *
 * ModelAdapters handle model-specific quirks (reasoning filters, param mapping,
 * special token stripping, context window overrides). They are independent of
 * the wire format (FormatAdapter) and apply regardless of provider path.
 */

import { ModelAdapter } from "./model-adapter.js";
import { GrokAdapter } from "./grok-adapter.js";
import { GeminiModelAdapter } from "./gemini-model-adapter.js";
import { QwenAdapter } from "./qwen-adapter.js";
import { MiniMaxAdapter } from "./minimax-adapter.js";
import { DeepSeekAdapter } from "./deepseek-adapter.js";
import { GLMAdapter } from "./glm-adapter.js";

export class AdapterManager {
  private adapters: ModelAdapter[];

  constructor(private modelId: string) {
    this.adapters = [
      new GrokAdapter(modelId),
      new GeminiModelAdapter(modelId),
      new QwenAdapter(modelId),
      new MiniMaxAdapter(modelId),
      new DeepSeekAdapter(modelId),
      new GLMAdapter(modelId),
    ];
  }

  /**
   * Get the appropriate ModelAdapter for the current model.
   * Returns a no-op ModelAdapter if no model-specific adapter matches.
   */
  getAdapter(): ModelAdapter {
    for (const adapter of this.adapters) {
      if (adapter.shouldHandle(this.modelId)) {
        return adapter;
      }
    }
    return new ModelAdapter(this.modelId);
  }
}
