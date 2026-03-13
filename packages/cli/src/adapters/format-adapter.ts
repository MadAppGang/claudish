/**
 * FormatAdapter — wire format conversion for a provider's API.
 *
 * Owns: message conversion, tool schema conversion, payload building,
 *       tool name truncation, context window defaults, vision defaults.
 *
 * Does NOT own: model-specific quirks (reasoning filters, param mapping,
 *               special token stripping). Those belong to ModelAdapter.
 *
 * Default implementation produces OpenAI Chat Completions format.
 * Override for Gemini (parts), Anthropic (passthrough), OllamaCloud (native), etc.
 */

import { BaseAdapter } from "./base-adapter.js";
import { truncateToolName } from "./tool-name-utils.js";
import type { ModelPricing } from "../handlers/shared/remote-provider-types.js";

export abstract class FormatAdapter extends BaseAdapter {
  /**
   * Map of truncated tool names back to original names.
   * Populated during prepareRequest() when tool names are truncated.
   */
  protected toolNameMap: Map<string, string> = new Map();

  // ─── Wire format conversion ──────────────────────────────────

  /**
   * Convert Claude-format messages to the target API format.
   * Default: OpenAI Chat Completions format.
   */
  convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    const { convertMessagesToOpenAI } = require("../handlers/shared/openai-compat.js");
    return convertMessagesToOpenAI(claudeRequest, this.modelId, filterIdentityFn);
  }

  /**
   * Convert Claude tools to the target API format.
   * Default: OpenAI function-calling format.
   */
  convertTools(claudeRequest: any, summarize = false): any[] {
    const { convertToolsToOpenAI } = require("../handlers/shared/openai-compat.js");
    return convertToolsToOpenAI(claudeRequest, summarize);
  }

  /**
   * Build the full request payload for the target API.
   * Default: OpenAI Chat Completions format.
   */
  buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      stream: true,
    };
    if (tools.length > 0) {
      payload.tools = tools;
    }
    if (claudeRequest.max_tokens) {
      payload.max_tokens = claudeRequest.max_tokens;
    }
    if (claudeRequest.temperature !== undefined) {
      payload.temperature = claudeRequest.temperature;
    }
    return payload;
  }

  // ─── Request preparation ─────────────────────────────────────

  /**
   * Post-process the request payload before sending.
   * Default: truncate tool names if the format has a length limit.
   */
  override prepareRequest(request: any, _originalRequest: any): any {
    this.truncateToolNames(request);
    return request;
  }

  // ─── Tool name management ───────────────────────────────────

  /**
   * Maximum tool name length allowed by this format/provider.
   * Returns null if no limit (default).
   */
  getToolNameLimit(): number | null {
    return null;
  }

  getToolNameMap(): Map<string, string> {
    return this.toolNameMap;
  }

  restoreToolName(name: string): string {
    return this.toolNameMap.get(name) || name;
  }

  protected truncateToolNames(request: any): void {
    const limit = this.getToolNameLimit();
    if (!limit || !request.tools) return;

    for (const tool of request.tools) {
      const originalName = tool.function?.name || tool.name;
      if (originalName && originalName.length > limit) {
        const truncated = truncateToolName(originalName, limit);
        this.toolNameMap.set(truncated, originalName);
        if (tool.function?.name) {
          tool.function.name = truncated;
        } else if (tool.name) {
          tool.name = truncated;
        }
      }
    }
  }

  protected truncateToolNamesInMessages(messages: any[]): void {
    const limit = this.getToolNameLimit();
    if (!limit) return;

    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          if (name && name.length > limit) {
            const truncated = truncateToolName(name, limit);
            tc.function.name = truncated;
            if (!this.toolNameMap.has(truncated)) {
              this.toolNameMap.set(truncated, name);
            }
          }
        }
      }
    }
  }

  // ─── Model metadata defaults (narrows BaseAdapter's undefined) ──

  override getContextWindow(): number {
    return 200_000;
  }

  getPricing(providerName: string): ModelPricing {
    const { getModelPricing } = require("../handlers/shared/remote-provider-types.js");
    return getModelPricing(providerName, this.modelId);
  }

  override supportsVision(): boolean {
    return true;
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  override reset(): void {
    this.toolNameMap.clear();
  }
}
