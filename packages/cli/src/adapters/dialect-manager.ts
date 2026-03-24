/**
 * resolveModelDialect — select the appropriate ModelDialect for a given model.
 *
 * Pure function. Returns the first dialect whose shouldHandle() matches,
 * or DefaultAPIFormat as fallback.
 */

import { BaseAPIFormat, DefaultAPIFormat } from "./base-api-format.js";
import { GrokModelDialect } from "./grok-model-dialect.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { CodexAPIFormat } from "./codex-api-format.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";
import { QwenModelDialect } from "./qwen-model-dialect.js";
import { MiniMaxModelDialect } from "./minimax-model-dialect.js";
import { DeepSeekModelDialect } from "./deepseek-model-dialect.js";
import { GLMModelDialect } from "./glm-model-dialect.js";
import { XiaomiModelDialect } from "./xiaomi-model-dialect.js";

const DIALECTS: Array<new (modelId: string) => BaseAPIFormat> = [
  GrokModelDialect,
  GeminiAPIFormat,
  CodexAPIFormat, // Must precede OpenAIAPIFormat
  OpenAIAPIFormat,
  QwenModelDialect,
  MiniMaxModelDialect,
  DeepSeekModelDialect,
  GLMModelDialect,
  XiaomiModelDialect,
];

export function resolveModelDialect(modelId: string): BaseAPIFormat {
  for (const Dialect of DIALECTS) {
    const d = new Dialect(modelId);
    if (d.shouldHandle(modelId)) return d;
  }
  return new DefaultAPIFormat(modelId);
}
