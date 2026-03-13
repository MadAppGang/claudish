/**
 * GeminiCodeAssistTransport -- Gemini Code Assist (gemini-cli backend) via OAuth.
 *
 * Transport concerns:
 * - OAuth access token via getValidAccessToken()
 * - Project ID via setupGeminiUser()
 * - Wraps payload in CodeAssist envelope: {model, project, user_prompt_id, request}
 * - GeminiRequestQueue for rate limiting
 * - gemini-sse stream format (with response wrapper)
 */

import { randomUUID } from "node:crypto";
import type { StreamFormat } from "./types.js";
import { OAuthTransport } from "./base.js";
import { GeminiRequestQueue } from "../../handlers/shared/gemini-queue.js";
import { log } from "../../logger.js";

export class GeminiCodeAssistTransport extends OAuthTransport {
  readonly streamFormat: StreamFormat = "gemini-sse";

  private projectId: string | null = null;

  constructor(modelName: string) {
    super({
      name: "gemini-codeassist",
      displayName: "Gemini Free",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      apiPath: "/v1internal:streamGenerateContent?alt=sse",
      modelName,
    });
  }

  /**
   * Refresh OAuth token and project ID before each request.
   * Uses dynamic imports to avoid loading OAuth code unless needed.
   */
  async refreshAuth(): Promise<void> {
    const { getValidAccessToken, setupGeminiUser } = await import("../../auth/gemini-oauth.js");
    this.accessToken = await getValidAccessToken();
    const { projectId } = await setupGeminiUser(this.accessToken!);
    this.projectId = projectId;
    log(`[GeminiCodeAssist] Auth refreshed, project: ${this.projectId}`);
  }

  /**
   * Wrap the standard Gemini payload in the CodeAssist envelope.
   * The inner payload (contents, generationConfig, systemInstruction, tools)
   * is built by GeminiFormatAdapter.buildPayload().
   */
  transformPayload(payload: any): any {
    return {
      model: this.modelName,
      project: this.projectId,
      user_prompt_id: randomUUID(),
      request: payload,
    };
  }

  /**
   * Rate-limited request via GeminiRequestQueue singleton.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const queue = GeminiRequestQueue.getInstance();
    return queue.enqueue(fetchFn);
  }
}
