/**
 * PoeProvider — Poe API transport.
 *
 * Transport concerns:
 * - Bearer token auth (POE_API_KEY)
 * - Fixed endpoint: https://api.poe.com/v1/chat/completions
 * - Standard OpenAI SSE format
 */

import type { StreamFormat } from "./types.js";
import { ApiKeyTransport } from "./base.js";

const POE_API_URL = "https://api.poe.com";
const POE_API_PATH = "/v1/chat/completions";

export class PoeProvider extends ApiKeyTransport {
  readonly name = "poe";
  readonly displayName = "Poe";
  readonly streamFormat: StreamFormat = "openai-sse";

  constructor(apiKey: string) {
    super("poe", POE_API_URL, POE_API_PATH, apiKey);
  }
}
