/**
 * LiteLLM Handler
 *
 * Handles communication with LiteLLM proxy instances.
 * LiteLLM uses OpenAI-compatible API format, so we extend RemoteProviderHandler
 * with LiteLLM-specific configuration.
 *
 * LiteLLM proxies provide:
 * - Unified interface to 100+ LLM providers
 * - Load balancing, fallbacks, and budget controls
 * - OpenAI-compatible /v1/chat/completions endpoint
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { RemoteProviderHandler } from "./shared/remote-provider-handler.js";
import type { RemoteProviderConfig, ModelPricing } from "./shared/remote-provider-types.js";
import { log } from "../logger.js";

/**
 * Models that need image_url content converted to inline base64 text
 * because LiteLLM doesn't properly forward image_url to their native API.
 *
 * MiniMax expects: [Image base64:{raw_base64}] inline in text content
 * See: https://platform.minimax.io/docs/solutions/learning
 */
const INLINE_IMAGE_MODEL_PATTERNS = ["minimax"];

/**
 * Extra headers that LiteLLM should forward to specific providers.
 * Matched by model name pattern (case-insensitive).
 *
 * Kimi for Coding requires a recognized agent User-Agent header,
 * otherwise returns 403 "only available for Coding Agents".
 * See: https://github.com/router-for-me/CLIProxyAPI/issues/1280
 */
const MODEL_EXTRA_HEADERS: Array<{ pattern: string; headers: Record<string, string> }> = [
  { pattern: "kimi", headers: { "User-Agent": "claude-code/1.0" } },
];

/**
 * LiteLLM Handler
 *
 * Uses LiteLLM's OpenAI-compatible API with dynamic base URL configuration.
 * The base URL and API key are provided at runtime via CLI flags or environment variables.
 */
export class LiteLLMHandler extends RemoteProviderHandler {
  private baseUrl: string;
  private modelVisionSupported: boolean;
  private needsInlineImages: boolean;

  constructor(
    targetModel: string,
    modelName: string,
    apiKey: string,
    port: number,
    baseUrl: string
  ) {
    super(targetModel, modelName, apiKey, port);
    this.baseUrl = baseUrl;
    this.modelVisionSupported = this.checkVisionSupport();
    this.needsInlineImages = INLINE_IMAGE_MODEL_PATTERNS.some((p) =>
      this.modelName.toLowerCase().includes(p)
    );
  }

  /**
   * Check if the current model supports vision by looking up cached LiteLLM model data.
   * Falls back to true (assume vision) if no cache or model not found.
   */
  protected supportsVision(): boolean {
    return this.modelVisionSupported;
  }

  /**
   * Convert messages, then transform image_url blocks to inline base64 text
   * for models where LiteLLM doesn't properly forward image content.
   */
  protected convertMessages(claudeRequest: any): any[] {
    const messages = super.convertMessages(claudeRequest);

    if (!this.needsInlineImages) return messages;

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;

      const newContent: any[] = [];
      let inlineImages = "";

      for (const part of msg.content) {
        if (part.type === "image_url") {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (url?.startsWith("data:")) {
            // Extract raw base64 from data URI: data:image/png;base64,{data}
            const base64Match = url.match(/^data:[^;]+;base64,(.+)$/);
            if (base64Match) {
              inlineImages += `\n[Image base64:${base64Match[1]}]`;
              log(`[LiteLLM] Converted image_url to inline base64 for ${this.modelName}`);
            }
          } else if (url) {
            // URL-based image - keep as text reference since model can't fetch URLs
            inlineImages += `\n[Image URL: ${url}]`;
          }
        } else {
          newContent.push(part);
        }
      }

      if (inlineImages) {
        // Append inline image data to last text block or create one
        const lastText = newContent.findLast((p: any) => p.type === "text");
        if (lastText) {
          lastText.text += inlineImages;
        } else {
          newContent.push({ type: "text", text: inlineImages.trim() });
        }
      }

      // Simplify single-text-block arrays to plain string
      if (newContent.length === 1 && newContent[0].type === "text") {
        msg.content = newContent[0].text;
      } else if (newContent.length > 0) {
        msg.content = newContent;
      }
    }

    return messages;
  }

  /**
   * Look up vision support from cached LiteLLM model discovery data
   */
  private checkVisionSupport(): boolean {
    try {
      const hash = createHash("sha256").update(this.baseUrl).digest("hex").substring(0, 16);
      const cachePath = join(homedir(), ".claudish", `litellm-models-${hash}.json`);
      if (!existsSync(cachePath)) return true; // No cache, assume vision supported

      const cacheData = JSON.parse(readFileSync(cachePath, "utf-8"));
      const model = cacheData.models?.find((m: any) => m.name === this.modelName);
      if (model && model.supportsVision === false) {
        log(`[LiteLLM] Model ${this.modelName} does not support vision, images will be stripped`);
        return false;
      }
      return true; // Unknown model or vision supported
    } catch {
      return true; // On error, assume vision supported
    }
  }

  /**
   * Get provider configuration for LiteLLM
   */
  protected getProviderConfig(): RemoteProviderConfig {
    return {
      name: "litellm",
      baseUrl: this.baseUrl,
      apiPath: "/v1/chat/completions",
      apiKeyEnvVar: "LITELLM_API_KEY",
    };
  }

  /**
   * Get pricing for the current model
   * LiteLLM pricing should ideally come from model discovery API,
   * but we default to reasonable estimates for now.
   */
  protected getPricing(): ModelPricing {
    // TODO: Look up per-model pricing from cached LiteLLM model_hub data
    // For now, use reasonable default estimates. Real pricing is shown in --models selector.
    return {
      inputCostPer1M: 1.0,
      outputCostPer1M: 4.0,
      isEstimate: true,
    };
  }

  /**
   * Get provider display name for status line
   */
  protected getProviderName(): string {
    return "LiteLLM";
  }

  /**
   * Build the API request payload for LiteLLM
   * LiteLLM uses standard OpenAI format
   */
  protected buildRequestPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelName,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: claudeRequest.max_tokens,
    };

    if (tools.length > 0) {
      payload.tools = tools;
    }

    // Handle tool choice
    if (claudeRequest.tool_choice) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name) {
        payload.tool_choice = { type: "function", function: { name } };
      } else if (type === "auto" || type === "none") {
        payload.tool_choice = type;
      }
    }

    // Add provider-specific extra headers that LiteLLM forwards downstream
    const extraHeaders = this.getExtraHeaders();
    if (extraHeaders) {
      payload.extra_headers = extraHeaders;
    }

    return payload;
  }

  /**
   * Get extra headers for LiteLLM to forward to the downstream provider.
   * Matches model name against known patterns that require specific headers.
   */
  private getExtraHeaders(): Record<string, string> | null {
    const model = this.modelName.toLowerCase();
    const merged: Record<string, string> = {};
    let found = false;

    for (const { pattern, headers } of MODEL_EXTRA_HEADERS) {
      if (model.includes(pattern)) {
        Object.assign(merged, headers);
        found = true;
      }
    }

    return found ? merged : null;
  }
}
