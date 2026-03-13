import { LocalFormatAdapter, type SamplingParams } from "./local-format-adapter.js";

export class LocalLlamaFormatAdapter extends LocalFormatAdapter {
  getName(): string {
    return "LocalLlamaFormatAdapter";
  }

  protected override getSamplingParams(): SamplingParams {
    return { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, repetition_penalty: 1.1 };
  }
}
