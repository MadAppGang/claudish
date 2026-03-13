import { LocalFormatAdapter, type SamplingParams } from "./local-format-adapter.js";

export class LocalDeepSeekFormatAdapter extends LocalFormatAdapter {
  getName(): string {
    return "LocalDeepSeekFormatAdapter";
  }

  protected override getSamplingParams(): SamplingParams {
    return { temperature: 0.6, top_p: 0.95, top_k: 40, min_p: 0.0, repetition_penalty: 1.0 };
  }
}
