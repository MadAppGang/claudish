/**
 * resolveModelDialect — select the appropriate ModelDialect for a given model.
 *
 * Matching rules are centralized here, not scattered across adapter classes.
 * Each entry declares its family names and vendor prefixes. matchesModelFamily
 * handles the prefix/vendor-prefix logic.
 */

import { BaseAPIFormat, DefaultAPIFormat, matchesModelFamily } from "./base-api-format.js";
import { GrokModelDialect } from "./grok-model-dialect.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { CodexAPIFormat } from "./codex-api-format.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";
import { QwenModelDialect } from "./qwen-model-dialect.js";
import { MiniMaxModelDialect } from "./minimax-model-dialect.js";
import { DeepSeekModelDialect } from "./deepseek-model-dialect.js";
import { GLMModelDialect } from "./glm-model-dialect.js";
import { XiaomiModelDialect } from "./xiaomi-model-dialect.js";

interface DialectEntry {
  Dialect: new (modelId: string) => BaseAPIFormat;
  families: string[];
  vendors?: string[];
  custom?: (modelId: string) => boolean;
}

// Order matters: CodexAPIFormat must precede OpenAIAPIFormat.
const DIALECTS: DialectEntry[] = [
  { Dialect: GrokModelDialect, families: ["grok"], vendors: ["x-ai/"] },
  { Dialect: GeminiAPIFormat, families: ["gemini"], vendors: ["google/"] },
  { Dialect: CodexAPIFormat, families: ["codex"] },
  { Dialect: OpenAIAPIFormat, families: [], custom: (id) =>
      id.startsWith("oai/") || id.includes("o1") || id.includes("o3") },
  { Dialect: QwenModelDialect, families: ["qwen", "alibaba"] },
  { Dialect: MiniMaxModelDialect, families: ["minimax"] },
  { Dialect: DeepSeekModelDialect, families: ["deepseek"] },
  { Dialect: GLMModelDialect, families: ["glm-", "chatglm-"], vendors: ["zhipu/"] },
  { Dialect: XiaomiModelDialect, families: ["xiaomi", "mimo"] },
];

function matches(modelId: string, entry: DialectEntry): boolean {
  const lower = modelId.toLowerCase();
  for (const fam of entry.families) {
    if (matchesModelFamily(modelId, fam)) return true;
  }
  if (entry.vendors) {
    for (const v of entry.vendors) {
      if (lower.includes(v)) return true;
    }
  }
  return entry.custom?.(lower) ?? false;
}

export function resolveModelDialect(modelId: string): BaseAPIFormat {
  for (const entry of DIALECTS) {
    if (matches(modelId, entry)) return new entry.Dialect(modelId);
  }
  return new DefaultAPIFormat(modelId);
}
