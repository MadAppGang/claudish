/**
 * OllamaCloud ProviderTransport
 *
 * Handles communication with OllamaCloud API (https://ollama.com/api/chat).
 * Uses Bearer token auth and Ollama's native JSONL streaming format.
 */

import type { StreamFormat } from "./types.js";
import { KeyAuthTransport } from "./base.js";

export class OllamaCloudTransport extends KeyAuthTransport {
  readonly streamFormat: StreamFormat = "ollama-jsonl";
}
