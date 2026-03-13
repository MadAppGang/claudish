/**
 * LiteLLM Format Adapter
 *
 * Extends OpenAI format with LiteLLM-specific behaviors:
 * - Inline image conversion for MiniMax (LiteLLM doesn't forward image_url properly)
 * - Vision support detection from cached model discovery data
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenAIFormatAdapter } from "./openai-format-adapter.js";
import { log } from "../logger.js";

/** Models needing image_url → inline base64 conversion */
const INLINE_IMAGE_MODEL_PATTERNS = ["minimax"];

export class LiteLLMAdapter extends OpenAIFormatAdapter {
  private baseUrl: string;
  private visionSupported: boolean;
  private needsInlineImages: boolean;

  constructor(modelId: string, baseUrl: string) {
    super(modelId);
    this.baseUrl = baseUrl;
    this.visionSupported = this.checkVisionSupport();
    this.needsInlineImages = INLINE_IMAGE_MODEL_PATTERNS.some((p) =>
      modelId.toLowerCase().includes(p)
    );
  }

  override getName(): string {
    return "LiteLLMAdapter";
  }

  override supportsVision(): boolean {
    return this.visionSupported;
  }

  /**
   * Convert messages, then transform image_url blocks to inline base64 text
   * for models where LiteLLM doesn't properly forward image content.
   */
  override convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    const messages = super.convertMessages(claudeRequest, filterIdentityFn);

    if (!this.needsInlineImages) return messages;

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;

      const newContent: any[] = [];
      let inlineImages = "";

      for (const part of msg.content) {
        if (part.type === "image_url") {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (url?.startsWith("data:")) {
            const base64Match = url.match(/^data:[^;]+;base64,(.+)$/);
            if (base64Match) {
              inlineImages += `\n[Image base64:${base64Match[1]}]`;
              log(`[LiteLLMAdapter] Converted image_url to inline base64 for ${this.modelId}`);
            }
          } else if (url) {
            inlineImages += `\n[Image URL: ${url}]`;
          }
        } else {
          newContent.push(part);
        }
      }

      if (inlineImages) {
        const lastText = newContent.findLast((p: any) => p.type === "text");
        if (lastText) {
          lastText.text += inlineImages;
        } else {
          newContent.push({ type: "text", text: inlineImages.trim() });
        }
      }

      if (newContent.length === 1 && newContent[0].type === "text") {
        msg.content = newContent[0].text;
      } else if (newContent.length > 0) {
        msg.content = newContent;
      }
    }

    return messages;
  }

  override getContextWindow(): number {
    return 200_000; // Default, could be enhanced with model discovery
  }

  /**
   * Look up vision support from cached LiteLLM model discovery data.
   */
  private checkVisionSupport(): boolean {
    try {
      const hash = createHash("sha256").update(this.baseUrl).digest("hex").substring(0, 16);
      const cachePath = join(homedir(), ".claudish", `litellm-models-${hash}.json`);
      if (!existsSync(cachePath)) return true;

      const cacheData = JSON.parse(readFileSync(cachePath, "utf-8"));
      const model = cacheData.models?.find((m: any) => m.name === this.modelId);
      if (model && model.supportsVision === false) {
        log(`[LiteLLMAdapter] Model ${this.modelId} does not support vision`);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }
}
