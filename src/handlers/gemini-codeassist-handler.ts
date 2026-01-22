/**
 * Gemini Code Assist Handler
 *
 * Handles communication with Google's Code Assist API (gemini-cli backend).
 * Uses OAuth authentication instead of API keys.
 *
 * API Endpoint: https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
 *
 * Request format (different from standard Gemini API):
 * {
 *   "model": "gemini-2.5-flash",
 *   "project": "projectId",
 *   "user_prompt_id": "uuid",
 *   "request": {
 *     "contents": [...],
 *     "generationConfig": {...},
 *     "systemInstruction": {...},
 *     "tools": [...]
 *   }
 * }
 */

import type { Context } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelHandler } from "./types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager } from "../middleware/manager.js";
import { GeminiThoughtSignatureMiddleware } from "../middleware/gemini-thought-signature.js";
import { transformOpenAIToClaude } from "../transform.js";
import { log, logStructured } from "../logger.js";
import { filterIdentity } from "./shared/openai-compat.js";
import { getModelPricing, type ModelPricing } from "./shared/remote-provider-types.js";
import { convertToolsToGemini } from "./shared/gemini-schema.js";
import { fetchWithRetry } from "./shared/gemini-retry.js";
import { getValidAccessToken, setupGeminiUser } from "../auth/gemini-oauth.js";

const CODE_ASSIST_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

export class GeminiCodeAssistHandler implements ModelHandler {
  private modelName: string;
  private port: number;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private sessionTotalCost = 0;
  private sessionOutputTokens = 0;
  private contextWindow = 1000000; // Gemini has 1M context by default
  private toolCallMap = new Map<string, string>(); // tool_use_id -> function_name

  constructor(modelName: string, port: number) {
    this.modelName = modelName;
    this.port = port;
    this.adapterManager = new AdapterManager(`gemini/${modelName}`);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    this.middlewareManager
      .initialize()
      .catch((err) => log(`[GeminiCodeAssistHandler:${modelName}] Middleware init error: ${err}`));

    log(`[GeminiCodeAssistHandler] Initialized for model: ${modelName}`);
  }

  async shutdown(): Promise<void> {
    // Cleanup if needed
    log(`[GeminiCodeAssistHandler] Shutting down handler for ${this.modelName}`);
  }

  private getPricing(): ModelPricing {
    // Code Assist OAuth sessions are FREE - return zero cost with isFree flag
    return {
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      isFree: true,
    };
  }

  private writeTokenFile(input: number, output: number): void {
    try {
      const total = input + output;
      const leftPct =
        this.contextWindow > 0
          ? Math.max(
              0,
              Math.min(100, Math.round(((this.contextWindow - total) / this.contextWindow) * 100))
            )
          : 100;

      const pricing = this.getPricing();
      const data = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        total_cost: this.sessionTotalCost,
        context_window: this.contextWindow,
        context_left_percent: leftPct,
        is_free: pricing.isFree || false,
        is_estimated: pricing.isEstimate || false,
        provider_name: "Gemini Free",
        updated_at: Date.now(),
      };

      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      log(`[GeminiCodeAssistHandler] Error writing token file: ${e}`);
    }
  }

  private updateTokenTracking(inputTokens: number, outputTokens: number): void {
    this.sessionOutputTokens += outputTokens;

    const pricing = this.getPricing();
    const cost =
      (inputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M;
    this.sessionTotalCost += cost;

    this.writeTokenFile(inputTokens, this.sessionOutputTokens);
  }

  // ============================================================================
  // Message Conversion (Anthropic -> Gemini format)
  // ============================================================================

  private convertToGeminiMessages(claudeRequest: any): any[] {
    const messages: any[] = [];
    if (claudeRequest.messages) {
      for (const msg of claudeRequest.messages) {
        if (msg.role === "user") {
          const parts = this.convertUserMessageParts(msg);
          if (parts.length > 0) messages.push({ role: "user", parts });
        } else if (msg.role === "assistant") {
          const parts = this.convertAssistantMessageParts(msg);
          if (parts.length > 0) messages.push({ role: "model", parts });
        }
      }
    }
    return messages;
  }

  private convertUserMessageParts(msg: any): any[] {
    const parts: any[] = [];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image") {
          parts.push({
            inlineData: { mimeType: block.source.media_type, data: block.source.data },
          });
        } else if (block.type === "tool_result") {
          const functionName = this.toolCallMap.get(block.tool_use_id);
          if (!functionName) continue;
          parts.push({
            functionResponse: {
              name: functionName,
              response: {
                content:
                  typeof block.content === "string" ? block.content : JSON.stringify(block.content),
              },
            },
          });
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }
    return parts;
  }

  private convertAssistantMessageParts(msg: any): any[] {
    const parts: any[] = [];
    let isFirstFunctionCall = true;

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          this.toolCallMap.set(block.id, block.name);
          const part: any = {
            functionCall: { name: block.name, args: block.input },
          };

          // Gemini 3 models require thoughtSignature on the first functionCall in active loops
          if (this.modelName.includes("gemini-3") && isFirstFunctionCall) {
            part.thoughtSignature = "skip_thought_signature_validator";
            isFirstFunctionCall = false;
          }

          parts.push(part);
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }
    return parts;
  }

  /**
   * Convert Claude tools to Gemini function declarations
   * Uses shared schema sanitization from gemini-schema.ts
   */
  private convertToGeminiTools(claudeRequest: any): any {
    return convertToolsToGemini(claudeRequest.tools);
  }

  // ============================================================================
  // Request Building
  // ============================================================================

  private buildVertexPayload(claudeRequest: any): any {
    const contents = this.convertToGeminiMessages(claudeRequest);
    const tools = this.convertToGeminiTools(claudeRequest);

    const payload: any = {
      contents,
      generationConfig: {
        temperature: claudeRequest.temperature ?? 1,
        maxOutputTokens: claudeRequest.max_tokens,
      },
    };

    if (claudeRequest.system) {
      let systemContent = Array.isArray(claudeRequest.system)
        ? claudeRequest.system.map((i: any) => i.text || i).join("\n\n")
        : claudeRequest.system;
      systemContent = filterIdentity(systemContent);
      systemContent += `\n\nCRITICAL INSTRUCTION FOR OUTPUT FORMAT:
1. Keep ALL internal reasoning INTERNAL. Never output your thought process as visible text.
2. Do NOT start responses with phrases like "Wait, I'm...", "Let me think...", "Okay, so..."
3. Only output: final responses, tool calls, and code. Nothing else.`;

      payload.systemInstruction = { parts: [{ text: systemContent }] };
    }

    if (tools) payload.tools = tools;

    if (claudeRequest.thinking) {
      const { budget_tokens } = claudeRequest.thinking;
      if (this.modelName.includes("gemini-3")) {
        payload.generationConfig.thinkingConfig = {
          thinkingLevel: budget_tokens >= 16000 ? "high" : "low",
        };
      } else {
        const MAX_GEMINI_BUDGET = 24576;
        payload.generationConfig.thinkingConfig = {
          thinkingBudget: Math.min(budget_tokens, MAX_GEMINI_BUDGET),
        };
      }
    }

    return payload;
  }

  // ============================================================================
  // Streaming Response Handler
  // ============================================================================

  private handleStreamingResponse(c: Context, response: Response, _claudeRequest: any): Response {
    let isClosed = false;
    let ping: NodeJS.Timeout | null = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();

    return c.body(
      new ReadableStream({
        start: async (controller) => {
          const send = (e: string, d: any) => {
            if (!isClosed) {
              controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
            }
          };

          const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          let usage: any = null;
          let finalized = false;
          let textStarted = false;
          let textIdx = -1;
          let thinkingStarted = false;
          let thinkingIdx = -1;
          let curIdx = 0;
          const tools = new Map<number, any>();
          let accumulatedText = "";

          send("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: `gemini/${this.modelName}`,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          });

          ping = setInterval(() => {
            if (!isClosed) {
              send("ping", { type: "ping" });
            }
          }, 10000);

          const finalize = (stopReason = "end_turn") => {
            if (finalized) return;
            finalized = true;

            // Close any open text block
            if (textStarted) {
              send("content_block_stop", { type: "content_block_stop", index: textIdx });
              textStarted = false;
            }

            // Close any open thinking block
            if (thinkingStarted) {
              send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
              thinkingStarted = false;
            }

            const finalUsage = usage || { promptTokenCount: 0, candidatesTokenCount: 0 };
            const inputTokens = finalUsage.promptTokenCount || 0;
            const outputTokens = finalUsage.candidatesTokenCount || 0;

            this.updateTokenTracking(inputTokens, outputTokens);

            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: outputTokens },
            });

            send("message_stop", { type: "message_stop" });

            if (ping) {
              clearInterval(ping);
              ping = null;
            }
            if (!isClosed) {
              isClosed = true;
              controller.close();
            }
          };

          try {
            const reader = response.body?.getReader();
            if (!reader) {
              finalize("error");
              return;
            }

            let buffer = "";

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const dataStr = line.slice(6).trim();
                if (!dataStr || dataStr === "[DONE]") continue;

                try {
                  const chunk = JSON.parse(dataStr);

                  // Code Assist API wraps response in { response: { candidates: [...] } }
                  const responseData = chunk.response || chunk;
                  if (responseData.usageMetadata) usage = responseData.usageMetadata;

                  const candidate = responseData.candidates?.[0];
                  if (candidate?.content?.parts) {
                    for (const part of candidate.content.parts) {
                      // Handle thinking blocks
                      if (part.thought) {
                        if (!thinkingStarted) {
                          thinkingIdx = curIdx++;
                          send("content_block_start", {
                            type: "content_block_start",
                            index: thinkingIdx,
                            content_block: { type: "thinking", thinking: "" },
                          });
                          thinkingStarted = true;
                        }
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: thinkingIdx,
                          delta: { type: "thinking_delta", thinking: part.thought },
                        });
                        continue;
                      }

                      // Handle text
                      if (part.text) {
                        // Close thinking before text
                        if (thinkingStarted) {
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: thinkingIdx,
                          });
                          thinkingStarted = false;
                        }

                        if (!textStarted) {
                          textIdx = curIdx++;
                          send("content_block_start", {
                            type: "content_block_start",
                            index: textIdx,
                            content_block: { type: "text", text: "" },
                          });
                          textStarted = true;
                        }

                        // Process through adapter
                        const res = adapter.processTextContent(part.text, accumulatedText);
                        accumulatedText += res.cleanedText || "";

                        if (res.cleanedText) {
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: textIdx,
                            delta: { type: "text_delta", text: res.cleanedText },
                          });
                        }
                      }

                      // Handle function calls
                      if (part.functionCall) {
                        // Close text block if open
                        if (textStarted) {
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: textIdx,
                          });
                          textStarted = false;
                        }

                        const toolIdx = curIdx++;
                        const toolId = `toolu_${Date.now()}_${Math.random().toString(36).slice(2)}`;

                        tools.set(toolIdx, {
                          id: toolId,
                          name: part.functionCall.name,
                          args: part.functionCall.args || {},
                        });

                        send("content_block_start", {
                          type: "content_block_start",
                          index: toolIdx,
                          content_block: {
                            type: "tool_use",
                            id: toolId,
                            name: part.functionCall.name,
                            input: {},
                          },
                        });

                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: toolIdx,
                          delta: {
                            type: "input_json_delta",
                            partial_json: JSON.stringify(part.functionCall.args || {}),
                          },
                        });

                        send("content_block_stop", { type: "content_block_stop", index: toolIdx });
                      }
                    }
                  }

                  // Check for finish reason
                  if (candidate?.finishReason) {
                    const stopReason =
                      candidate.finishReason === "STOP"
                        ? tools.size > 0
                          ? "tool_use"
                          : "end_turn"
                        : "end_turn";
                    finalize(stopReason);
                    return;
                  }
                } catch (parseErr) {
                  log(`[GeminiCodeAssist] Parse error: ${parseErr}`);
                }
              }
            }

            finalize(tools.size > 0 ? "tool_use" : "end_turn");
          } catch (err: any) {
            log(`[GeminiCodeAssist] Stream error: ${err.message}`);
            finalize("error");
          }
        },
        cancel() {
          isClosed = true;
          if (ping) clearInterval(ping);
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }
    );
  }

  // ============================================================================
  // Main Handler
  // ============================================================================

  async handle(c: Context, payload: any): Promise<Response> {
    const { claudeRequest } = transformOpenAIToClaude(payload);

    logStructured("Gemini Code Assist Request", {
      targetModel: `gemini/${this.modelName}`,
      messageCount: claudeRequest.messages?.length || 0,
      toolCount: claudeRequest.tools?.length || 0,
    });

    try {
      // 1. Get OAuth Token
      const accessToken = await getValidAccessToken();

      // 2. Setup User & Get Project
      const { projectId } = await setupGeminiUser(accessToken);

      // 3. Build Payload
      const vertexPayload = this.buildVertexPayload(claudeRequest);
      const requestBody = {
        model: this.modelName,
        project: projectId,
        user_prompt_id: randomUUID(),
        request: vertexPayload,
      };

      await this.middlewareManager.beforeRequest({
        modelId: `gemini/${this.modelName}`,
        messages: vertexPayload.contents,
        tools: claudeRequest.tools || [],
        stream: true,
      });

      // 4. Send Request with retry logic for rate limits
      log(`[GeminiCodeAssist] Calling API: ${CODE_ASSIST_ENDPOINT} (Project: ${projectId})`);

      const { response, attempts, lastErrorText } = await fetchWithRetry(
        CODE_ASSIST_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(requestBody),
        },
        { maxRetries: 5, baseDelayMs: 2000, maxDelayMs: 30000 },
        "[GeminiCodeAssist]"
      );

      if (!response.ok) {
        const errorText = response.status === 429 ? lastErrorText : await response.text();
        log(`[GeminiCodeAssist] API error ${response.status} after ${attempts} attempt(s): ${errorText}`);
        return c.json(
          {
            error: {
              type: "api_error",
              message: `Gemini Code Assist API error: ${response.status} - ${errorText}`,
            },
          },
          response.status as any
        );
      }

      if (attempts > 1) {
        log(`[GeminiCodeAssist] Request succeeded after ${attempts} attempts`);
      }

      return this.handleStreamingResponse(c, response, claudeRequest);
    } catch (e: any) {
      log(`[GeminiCodeAssist] Error: ${e.message}`);

      // Special handling for auth errors
      if (
        e.message.includes("No OAuth credentials") ||
        e.message.includes("run `claudish --gemini-login`")
      ) {
        return c.json(
          {
            error: {
              type: "authentication_error",
              message: e.message,
            },
          },
          401
        );
      }
      return c.json({ error: { type: "api_error", message: e.message } }, 500);
    }
  }
}
