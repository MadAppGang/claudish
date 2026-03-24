/**
 * ZenTransport — OpenCode Zen transport.
 * Extends OpenAIProviderTransport. Defaults API key to "public" for free tier.
 * GPT models on Zen use the Responses API endpoint (/v1/responses).
 */

import { OpenAIProviderTransport } from "./openai.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";

export class ZenTransport extends OpenAIProviderTransport {
  private isGptModel: boolean;
  private baseUrl: string;

  constructor(provider: RemoteProvider, modelName: string, apiKey: string) {
    // Default to "public" key for free zen tier
    super(provider, modelName, apiKey || "public");
    this.isGptModel = modelName.toLowerCase().startsWith("gpt-");
    this.baseUrl = provider.baseUrl;
  }

  override getEndpoint(): string {
    if (this.isGptModel) {
      return `${this.baseUrl}/v1/responses`;
    }
    return super.getEndpoint();
  }
}
