/**
 * LocalDeepSeekFormatAdapter — DeepSeek-family local model adapter.
 *
 * Overrides sampling parameters for DeepSeek models.
 */

import { LocalModelAdapter, type SamplingParams } from "./local-adapter.js";

export class LocalDeepSeekFormatAdapter extends LocalModelAdapter {
  protected override getSamplingParams(): SamplingParams {
    return { temperature: 0.6, top_p: 0.95, top_k: 40, min_p: 0.0, repetition_penalty: 1.0 };
  }
}
