import { LocalFormatAdapter, type SamplingParams } from "./local-format-adapter.js";

export class LocalLlamaFormatAdapter extends LocalFormatAdapter {
  getName(): string {
    return "LocalLlamaFormatAdapter";
  }

  override shouldHandle(modelId: string): boolean {
    return modelId.toLowerCase().includes("llama");
  }

  protected override getSamplingParams(): SamplingParams {
    return { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, repetition_penalty: 1.1 };
  }
}
