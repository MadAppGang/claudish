/**
 * GeminiCodeAssistProvider — Gemini Code Assist (gemini-cli backend) via OAuth.
 *
 * Transport concerns:
 * - OAuth access token via getValidAccessToken()
 * - Project ID via setupGeminiUser()
 * - Fixed endpoint: cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
 * - Wraps payload in CodeAssist envelope: {model, project, user_prompt_id, request: <payload>}
 * - Rate limiting via onResponse override (parses quotaResetDelay from 429)
 * - gemini-sse stream format (with response wrapper)
 */

import { randomUUID } from "node:crypto";
import type { StreamFormat } from "./types.js";
import { OAuthTransport } from "./base.js";
import type { QueueState } from "../../handlers/shared/request-queue.js";
import { log } from "../../logger.js";

const CODE_ASSIST_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

export class GeminiCodeAssistProviderTransport extends OAuthTransport {
  readonly name = "gemini-codeassist";
  readonly displayName = "Gemini Free";
  readonly streamFormat: StreamFormat = "gemini-sse";
  readonly tokenStrategy = "standard" as const;
  readonly unwrapResponse = true;

  private modelName: string;
  private projectId: string | null = null;

  constructor(modelName: string) {
    super("gemini-codeassist", {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
    });
    this.modelName = modelName;
  }

  getEndpoint(): string {
    return CODE_ASSIST_ENDPOINT;
  }

  protected override onResponse(response: Response, state: QueueState): boolean {
    if (response.status !== 429) return false;
    try {
      response.clone().text().then(text => {
        const data = JSON.parse(text);
        const detail = data?.error?.details?.find((d: any) => d.quotaResetDelay);
        if (detail?.quotaResetDelay) {
          const match = detail.quotaResetDelay.match(/(\d+(?:\.\d+)?)/);
          if (match) {
            state.currentDelayMs = Math.min(
              Math.max(Math.ceil(parseFloat(match[1]) * 1000), state.baseDelayMs),
              state.maxDelayMs,
            );
          }
        }
      }).catch(() => {});
    } catch {}
    return true;
  }

  /**
   * Refresh OAuth token and project ID before each request.
   * Uses dynamic imports to avoid loading OAuth code unless needed.
   */
  async refreshAuth(): Promise<void> {
    const { getValidAccessToken, setupGeminiUser } = await import("../../auth/gemini-oauth.js");
    this.accessToken = await getValidAccessToken();
    const { projectId } = await setupGeminiUser(this.accessToken);
    this.projectId = projectId;
    log(`[GeminiCodeAssist] Auth refreshed, project: ${this.projectId}`);
  }

  /**
   * Wrap the standard Gemini payload in the CodeAssist envelope.
   * The inner payload (contents, generationConfig, systemInstruction, tools)
   * is built by GeminiAdapter.buildPayload().
   */
  transformPayload(payload: any): any {
    return {
      model: this.modelName,
      project: this.projectId,
      user_prompt_id: randomUUID(),
      request: payload,
    };
  }
}

// Backward-compatible alias
/** @deprecated Use GeminiCodeAssistProviderTransport */
export { GeminiCodeAssistProviderTransport as GeminiCodeAssistProvider };
