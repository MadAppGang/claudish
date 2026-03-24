/**
 * ZenTransport — OpenCode Zen transport.
 * Extends OpenAIProviderTransport. Defaults API key to "public" for free tier.
 */

import { OpenAIProviderTransport } from "./openai.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";

export class ZenTransport extends OpenAIProviderTransport {
  constructor(provider: RemoteProvider, modelName: string, apiKey: string) {
    // Default to "public" key for free zen tier
    super(provider, modelName, apiKey || "public");
  }
}
