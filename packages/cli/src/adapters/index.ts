/**
 * Model format and dialect implementations
 */

export { BaseAPIFormat, DefaultAPIFormat } from "./base-api-format.js";
export type { ToolCall, AdapterResult } from "./base-api-format.js";
export { GrokModelDialect } from "./grok-model-dialect.js";
export { resolveModelDialect } from "./dialect-manager.js";

// Backward-compatible aliases
export {
  BaseAPIFormat as BaseModelAdapter,
  DefaultAPIFormat as DefaultAdapter,
} from "./base-api-format.js";
export { GrokModelDialect as GrokAdapter } from "./grok-model-dialect.js";
