/**
 * LocalLlamaFormatAdapter — Llama-family local model adapter.
 *
 * Overrides sampling parameters for Llama models.
 */

import { LocalModelAdapter, type SamplingParams } from "./local-adapter.js";

export class LocalLlamaFormatAdapter extends LocalModelAdapter {
  protected override getSamplingParams(): SamplingParams {
    return { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, repetition_penalty: 1.1 };
  }
}
