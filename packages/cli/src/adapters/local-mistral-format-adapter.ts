import { LocalFormatAdapter, type SamplingParams } from "./local-format-adapter.js";

export class LocalMistralFormatAdapter extends LocalFormatAdapter {
  getName(): string {
    return "LocalMistralFormatAdapter";
  }

  override shouldHandle(modelId: string): boolean {
    const id = modelId.toLowerCase();
    return id.includes("mistral") || id.includes("codestral");
  }

  protected override getSamplingParams(): SamplingParams {
    return { temperature: 0.7, top_p: 0.9, top_k: 50, min_p: 0.0, repetition_penalty: 1.0 };
  }
}
