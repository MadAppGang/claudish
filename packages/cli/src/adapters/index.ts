/**
 * Model adapters for handling model-specific quirks
 */

export { BaseModelAdapter, DefaultAdapter } from "./base-adapter.js";
export type { ToolCall, AdapterResult } from "./base-adapter.js";
export { GrokAdapter } from "./grok-adapter.js";
export { AdapterManager } from "./adapter-manager.js";
