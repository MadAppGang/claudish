/**
 * LocalMistralFormatAdapter — Mistral-family local model adapter.
 *
 * Overrides sampling parameters for Mistral models.
 */

import { LocalModelAdapter, type SamplingParams } from "./local-adapter.js";

export class LocalMistralFormatAdapter extends LocalModelAdapter {
  protected override getSamplingParams(): SamplingParams {
    return { temperature: 0.7, top_p: 0.9, top_k: 50, min_p: 0.0, repetition_penalty: 1.0 };
  }
}
