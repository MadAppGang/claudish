/**
 * resolveModelDialect — selects the appropriate Layer 2 ModelDialect for a model.
 *
 * This allows ComposedHandler to apply model-specific quirks independent of
 * which Layer 1 APIFormat or Layer 3 ProviderTransport are used:
 * - Grok: XML function calls
 * - Gemini: Thought signatures in reasoning_details
 * - DeepSeek, GLM, etc.: thinking param stripping / mapping
 */

import type { StreamFormat } from "../providers/transport/types.js";
import { type BaseAPIFormat, DefaultAPIFormat } from "./base-api-format.js";
import { DeepSeekModelDialect } from "./deepseek-model-dialect.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { GLMModelDialect } from "./glm-model-dialect.js";
import { GrokModelDialect } from "./grok-model-dialect.js";
import { MiniMaxModelDialect } from "./minimax-model-dialect.js";
import { QwenModelDialect } from "./qwen-model-dialect.js";
import { XiaomiModelDialect } from "./xiaomi-model-dialect.js";

/**
 * Candidate dialects, in match order, for a handler WITHOUT a catalog
 * connection only (a dynamic subscription, a custom or local endpoint). A
 * catalog connection never gets a name-picked dialect: its `wire` decides
 * (`ComposedHandler`). The OpenAI and Codex formats are not here at all: the
 * API is chosen by `wire.api`, never by a model name.
 *
 * These are factories rather than instances because `shouldHandle` is an
 * instance method, so asking "does this dialect want the model" requires
 * constructing it. Building them one at a time and stopping at the first match
 * means a `grok-*` request constructs one object instead of ten.
 */
const DIALECT_FACTORIES: ReadonlyArray<(modelId: string, wire?: StreamFormat) => BaseAPIFormat> = [
  (m, w) => new GrokModelDialect(m, w),
  (m, w) => new GeminiAPIFormat(m, w),
  (m, w) => new QwenModelDialect(m, w),
  (m, w) => new MiniMaxModelDialect(m, w),
  (m, w) => new DeepSeekModelDialect(m, w),
  (m, w) => new GLMModelDialect(m, w),
  (m, w) => new XiaomiModelDialect(m, w),
];

/**
 * Resolve the dialect for a model, or the OpenAI-shaped default.
 *
 * @param modelId     Bare model name — dialects self-select on it.
 * @param wireFormat  The wire format of the Layer 1 FormatConverter this
 *   dialect will be composed with (ComposedHandler knows it; the dialect
 *   cannot, because selection is by model NAME). BaseAPIFormat — not the
 *   dialect — consumes it, substituting the Anthropic Messages reasoning knob
 *   and enabling unsigned-thinking filtering on `anthropic-sse`. That is why
 *   a multi-vendor Anthropic endpoint (Alibaba's Alibaba Token Plan serves qwen3.x,
 *   glm-5.2 and deepseek-v4-* over one URL, i.e. three different dialects)
 *   works without each dialect opting in. Omit for "unknown" → the OpenAI
 *   default, which keeps every pre-existing call site byte-identical.
 */
export function resolveModelDialect(modelId: string, wireFormat?: StreamFormat): BaseAPIFormat {
  for (const make of DIALECT_FACTORIES) {
    const dialect = make(modelId, wireFormat);
    if (dialect.shouldHandle(modelId)) return dialect;
  }
  return new DefaultAPIFormat(modelId, wireFormat);
}
