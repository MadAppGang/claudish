/**
 * Base Gemini Handler
 *
 * Abstract base class providing shared logic for all Gemini-based handlers.
 * Implements the Template Method pattern - subclasses customize authentication
 * and API endpoints while inheriting message/tool conversion and streaming logic.
 *
 * Architecture: Gemini OAuth Refactor - Phase 1
 */

import type { Context } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelHandler } from "./types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager, GeminiThoughtSignatureMiddleware } from "../middleware/index.js";
import { transformOpenAIToClaude } from "../transform.js";
import { log, logStructured } from "../logger.js";
import { filterIdentity } from "./shared/openai-compat.js";
import { sanitizeSchemaForGemini, convertToolsToGemini } from "./shared/gemini-schema.js";
import { fetchWithRetry } from "./shared/gemini-retry.js";
import { getModelPricing, type ModelPricing } from "./shared/remote-provider-types.js";

/**
 * Abstract base class for Gemini handlers
 *
 * Provides shared functionality:
 * - Message conversion (Claude → Gemini format)
 * - Tool conversion (JSON Schema → Gemini function declarations)
 * - Streaming response handling
 * - Token tracking and cost calculation
 *
 * Subclasses must implement:
 * - getApiEndpoint(): Returns the API URL
 * - getAuthHeaders(): Returns authentication headers
 */
export abstract class BaseGeminiHandler implements ModelHandler {
  protected modelName: string;
  protected port: number;
  protected adapterManager: AdapterManager;
  protected middlewareManager: MiddlewareManager;
  protected sessionTotalCost = 0;
  protected sessionInputTokens = 0;
  protected sessionOutputTokens = 0;
  protected contextWindow = 1000000; // Gemini has 1M context by default
  protected toolCallMap = new Map<string, { name: string; thoughtSignature?: string }>(); // tool_use_id -> { name, thoughtSignature }

  /**
   * Protected constructor - subclasses must call super()
   */
  protected constructor(modelName: string, port: number) {
    this.modelName = modelName;
    this.port = port;
    this.adapterManager = new AdapterManager(`gemini/${modelName}`);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    this.middlewareManager
      .initialize()
      .catch((err) => log(`[BaseGeminiHandler:${modelName}] Middleware init error: ${err}`));
  }

  /**
   * Abstract: Get the API endpoint URL
   * Subclasses implement this to return their specific endpoint
   */
  protected abstract getApiEndpoint(): string;

  /**
   * Abstract: Get authentication headers
   * Subclasses implement this to provide their auth method (API key or OAuth)
   */
  protected abstract getAuthHeaders(): Promise<Record<string, string>>;

  /**
   * Abstract: Get provider display name for status line
   * Subclasses implement this to return their specific provider name
   */
  protected abstract getProviderName(): string;

  /**
   * Get pricing for the current model
   */
  protected getPricing(): ModelPricing {
    return getModelPricing("gemini", this.modelName);
  }

  /**
   * Write token tracking file
   */
  protected writeTokenFile(input: number, output: number): void {
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
        provider_name: this.getProviderName(),
        updated_at: Date.now(),
      };

      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      log(`[BaseGeminiHandler] Error writing token file: ${e}`);
    }
  }

  /**
   * Update token tracking
   */
  protected updateTokenTracking(inputTokens: number, outputTokens: number): void {
    this.sessionInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;

    const pricing = this.getPricing();
    const cost =
      (inputTokens / 1_000_000) * pricing.inputCostPer1M +
      (outputTokens / 1_000_000) * pricing.outputCostPer1M;
    this.sessionTotalCost += cost;

    this.writeTokenFile(inputTokens, this.sessionOutputTokens);
  }

  /**
   * Convert Claude messages to Gemini format
   */
  protected convertToGeminiMessages(claudeRequest: any): any[] {
    const messages: any[] = [];

    // Process each message
    if (claudeRequest.messages) {
      for (const msg of claudeRequest.messages) {
        if (msg.role === "user") {
          const parts = this.convertUserMessageParts(msg);
          if (parts.length > 0) {
            messages.push({ role: "user", parts });
          }
        } else if (msg.role === "assistant") {
          const parts = this.convertAssistantMessageParts(msg);
          if (parts.length > 0) {
            messages.push({ role: "model", parts }); // Gemini uses "model" not "assistant"
          }
        }
      }
    }

    return messages;
  }

  /**
   * Convert user message content to Gemini parts
   */
  protected convertUserMessageParts(msg: any): any[] {
    const parts: any[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image") {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
        } else if (block.type === "tool_result") {
          // Gemini handles tool results as functionResponse
          // Need to look up the function name from our tool call map
          const toolInfo = this.toolCallMap.get(block.tool_use_id);
          if (!toolInfo) {
            log(
              `[BaseGeminiHandler:${this.modelName}] Warning: No function name found for tool_use_id ${block.tool_use_id}`
            );
            continue;
          }
          parts.push({
            functionResponse: {
              name: toolInfo.name,
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

  /**
   * Convert assistant message content to Gemini parts
   */
  protected convertAssistantMessageParts(msg: any): any[] {
    const parts: any[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          // Look up the stored thoughtSignature for this tool call
          const toolInfo = this.toolCallMap.get(block.id);
          let thoughtSignature = toolInfo?.thoughtSignature;

          // If no signature found, use dummy signature to skip validation
          // This is REQUIRED for Gemini 3/2.5 with thinking enabled
          // Handles cases like session recovery, migrations, or first request with history
          // See: https://ai.google.dev/gemini-api/docs/thought-signatures
          if (!thoughtSignature) {
            thoughtSignature = "skip_thought_signature_validator";
            log(`[BaseGeminiHandler:${this.modelName}] Using dummy thoughtSignature for tool ${block.name} (${block.id})`);
          }

          // Build the function call part
          const functionCallPart: any = {
            functionCall: {
              name: block.name,
              args: block.input,
            },
          };

          // Include thoughtSignature (REQUIRED for Gemini 3/2.5 with thinking enabled)
          if (thoughtSignature) {
            functionCallPart.thoughtSignature = thoughtSignature;
          }

          parts.push(functionCallPart);
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
  protected convertToGeminiTools(claudeRequest: any): any {
    return convertToolsToGemini(claudeRequest.tools);
  }

  /**
   * Build the Gemini API request payload
   */
  protected buildGeminiPayload(claudeRequest: any): any {
    const contents = this.convertToGeminiMessages(claudeRequest);
    const tools = this.convertToGeminiTools(claudeRequest);

    const payload: any = {
      contents,
      generationConfig: {
        temperature: claudeRequest.temperature ?? 1,
        maxOutputTokens: claudeRequest.max_tokens,
      },
    };

    // Add system instruction if present
    if (claudeRequest.system) {
      let systemContent = Array.isArray(claudeRequest.system)
        ? claudeRequest.system.map((i: any) => i.text || i).join("\n\n")
        : claudeRequest.system;
      systemContent = filterIdentity(systemContent);

      // Add Gemini-specific instructions
      systemContent += `\n\nCRITICAL INSTRUCTION FOR OUTPUT FORMAT:
1. Keep ALL internal reasoning INTERNAL. Never output your thought process as visible text.
2. Do NOT start responses with phrases like "Wait, I'm...", "Let me think...", "Okay, so..."
3. Only output: final responses, tool calls, and code. Nothing else.`;

      payload.systemInstruction = { parts: [{ text: systemContent }] };
    }

    if (tools) {
      payload.tools = tools;
    }

    // Handle thinking/reasoning configuration
    if (claudeRequest.thinking) {
      const { budget_tokens } = claudeRequest.thinking;

      if (this.modelName.includes("gemini-3")) {
        // Gemini 3 uses thinking_level
        payload.generationConfig.thinkingConfig = {
          thinkingLevel: budget_tokens >= 16000 ? "high" : "low",
        };
      } else {
        // Gemini 2.5 uses thinking_budget
        const MAX_GEMINI_BUDGET = 24576;
        const budget = Math.min(budget_tokens, MAX_GEMINI_BUDGET);
        payload.generationConfig.thinkingConfig = {
          thinkingBudget: budget,
        };
      }
    }

    return payload;
  }

  /**
   * Handle the streaming response from Gemini
   */
  protected handleStreamingResponse(c: Context, response: Response, _claudeRequest: any): Response {
    let isClosed = false;
    let ping: NodeJS.Timeout | null = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const streamMetadata = new Map<string, any>();
    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();

    // Capture reference to toolCallMap for use in the streaming closure
    const toolCallMap = this.toolCallMap;
    const modelName = this.modelName;

    return c.body(
      new ReadableStream({
        start: async (controller) => {
          const send = (e: string, d: any) => {
            if (!isClosed) {
              controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
            }
          };

          const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          // State
          let usage: any = null;
          let finalized = false;
          let textStarted = false;
          let textIdx = -1;
          let thinkingStarted = false;
          let thinkingIdx = -1;
          let curIdx = 0;
          const tools = new Map<number, any>();
          let lastActivity = Date.now();
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
              usage: { input_tokens: 100, output_tokens: 1 },
            },
          });
          send("ping", { type: "ping" });

          ping = setInterval(() => {
            if (!isClosed && Date.now() - lastActivity > 1000) {
              send("ping", { type: "ping" });
            }
          }, 1000);

          const finalize = async (reason: string, err?: string) => {
            if (finalized) return;
            finalized = true;

            if (thinkingStarted) {
              send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
            }
            if (textStarted) {
              send("content_block_stop", { type: "content_block_stop", index: textIdx });
            }
            for (const t of Array.from(tools.values())) {
              if (t.started && !t.closed) {
                send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
                t.closed = true;
              }
            }

            await this.middlewareManager.afterStreamComplete(
              `gemini/${this.modelName}`,
              streamMetadata
            );

            if (usage) {
              log(
                `[BaseGeminiHandler] Usage: prompt=${usage.promptTokenCount || 0}, completion=${usage.candidatesTokenCount || 0}`
              );
              this.updateTokenTracking(
                usage.promptTokenCount || 0,
                usage.candidatesTokenCount || 0
              );
            }

            if (reason === "error") {
              log(`[BaseGeminiHandler] Stream error: ${err}`);
              send("error", { type: "error", error: { type: "api_error", message: err } });
            } else {
              const hasToolCalls = tools.size > 0;
              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: hasToolCalls ? "tool_use" : "end_turn", stop_sequence: null },
                usage: { output_tokens: usage?.candidatesTokenCount || 0 },
              });
              send("message_stop", { type: "message_stop" });
            }

            if (!isClosed) {
              try {
                controller.enqueue(encoder.encode("data: [DONE]\n\n\n"));
              } catch (e) {}
              controller.close();
              isClosed = true;
              if (ping) clearInterval(ping);
            }
          };

          try {
            const reader = response.body!.getReader();
            let buffer = "";

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim() || !line.startsWith("data: ")) continue;
                const dataStr = line.slice(6);
                if (dataStr === "[DONE]") {
                  await finalize("done");
                  return;
                }

                try {
                  const chunk = JSON.parse(dataStr);

                  // Extract usage metadata
                  if (chunk.usageMetadata) {
                    usage = chunk.usageMetadata;
                  }

                  // Process candidates
                  const candidate = chunk.candidates?.[0];
                  if (candidate?.content?.parts) {
                    for (const part of candidate.content.parts) {
                      lastActivity = Date.now();

                      // Handle thinking/reasoning text
                      if (part.thought || part.thoughtText) {
                        const thinkingContent = part.thought || part.thoughtText;
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
                          delta: { type: "thinking_delta", thinking: thinkingContent },
                        });
                      }

                      // Handle regular text
                      if (part.text) {
                        // Close thinking block before text
                        if (thinkingStarted) {
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: thinkingIdx,
                          });
                          thinkingStarted = false;
                        }

                        const res = adapter.processTextContent(part.text, accumulatedText);
                        accumulatedText += res.cleanedText || "";

                        if (res.cleanedText) {
                          if (!textStarted) {
                            textIdx = curIdx++;
                            send("content_block_start", {
                              type: "content_block_start",
                              index: textIdx,
                              content_block: { type: "text", text: "" },
                            });
                            textStarted = true;
                          }
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: textIdx,
                            delta: { type: "text_delta", text: res.cleanedText },
                          });
                        }
                      }

                      // Handle function calls
                      if (part.functionCall) {
                        // Close other blocks
                        if (thinkingStarted) {
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: thinkingIdx,
                          });
                          thinkingStarted = false;
                        }
                        if (textStarted) {
                          send("content_block_stop", {
                            type: "content_block_stop",
                            index: textIdx,
                          });
                          textStarted = false;
                        }

                        const toolIdx = tools.size;
                        const toolId = `tool_${Date.now()}_${toolIdx}`;
                        const t = {
                          id: toolId,
                          name: part.functionCall.name,
                          blockIndex: curIdx++,
                          started: true,
                          closed: false,
                          arguments: JSON.stringify(part.functionCall.args || {}),
                        };
                        tools.set(toolIdx, t);

                        // Extract and store thoughtSignature for Gemini 3/2.5 thinking support
                        // This is REQUIRED when thinking is enabled - Gemini validates signatures on subsequent requests
                        const thoughtSignature = part.thoughtSignature;
                        if (thoughtSignature) {
                          log(`[BaseGeminiHandler:${modelName}] Captured thoughtSignature for tool ${t.name} (${t.id})`);
                        }
                        toolCallMap.set(t.id, {
                          name: t.name,
                          thoughtSignature: thoughtSignature,
                        });

                        send("content_block_start", {
                          type: "content_block_start",
                          index: t.blockIndex,
                          content_block: { type: "tool_use", id: t.id, name: t.name },
                        });
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: t.blockIndex,
                          delta: { type: "input_json_delta", partial_json: t.arguments },
                        });
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: t.blockIndex,
                        });
                        t.closed = true;
                      }
                    }
                  }

                  // Check for finish reason
                  if (candidate?.finishReason) {
                    if (
                      candidate.finishReason === "STOP" ||
                      candidate.finishReason === "MAX_TOKENS"
                    ) {
                      await finalize("done");
                      return;
                    }
                  }
                } catch (e) {
                  log(`[BaseGeminiHandler] Parse error: ${e}`);
                }
              }
            }

            await finalize("unexpected");
          } catch (e) {
            await finalize("error", String(e));
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

  /**
   * Main request handler (Template Method)
   * Implements the core request flow - subclasses provide authentication
   */
  async handle(c: Context, payload: any): Promise<Response> {
    // Transform Claude request
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);

    // Log request summary
    const systemPromptLength =
      typeof claudeRequest.system === "string" ? claudeRequest.system.length : 0;
    logStructured("Gemini Request", {
      targetModel: `gemini/${this.modelName}`,
      originalModel: payload.model,
      messageCount: claudeRequest.messages?.length || 0,
      toolCount: claudeRequest.tools?.length || 0,
      systemPromptLength,
      maxTokens: claudeRequest.max_tokens,
    });

    // Build Gemini request
    const geminiPayload = this.buildGeminiPayload(claudeRequest);

    // Call middleware
    await this.middlewareManager.beforeRequest({
      modelId: `gemini/${this.modelName}`,
      messages: geminiPayload.contents,
      tools: claudeRequest.tools || [],
      stream: true,
    });

    // Get endpoint and auth headers from subclass
    const endpoint = this.getApiEndpoint();
    const authHeaders = await this.getAuthHeaders();

    log(`[BaseGeminiHandler] Calling API: ${endpoint}`);

    let response: Response;
    let lastErrorText: string | undefined;
    let attempts = 1;

    try {
      const result = await fetchWithRetry(
        endpoint,
        {
          method: "POST",
          headers: {
            ...authHeaders,
          },
          body: JSON.stringify(geminiPayload),
        },
        { maxRetries: 5, baseDelayMs: 2000, maxDelayMs: 30000 },
        "[BaseGeminiHandler]"
      );
      response = result.response;
      lastErrorText = result.lastErrorText;
      attempts = result.attempts;
    } catch (fetchError: any) {
      // Provide helpful error message for common issues
      if (fetchError.name === "AbortError") {
        log(`[BaseGeminiHandler] Request timed out`);
        return c.json(
          {
            error: {
              type: "timeout_error",
              message:
                "Request to Gemini API timed out. Check your network connection to googleapis.com",
            },
          },
          504
        );
      }
      if (fetchError.cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
        log(`[BaseGeminiHandler] Connection timeout: ${fetchError.message}`);
        return c.json(
          {
            error: {
              type: "connection_error",
              message: `Cannot connect to Gemini API (googleapis.com). This may be due to: network/firewall blocking, VPN interference, or regional restrictions. Error: ${fetchError.cause?.code}`,
            },
          },
          503
        );
      }
      log(`[BaseGeminiHandler] Fetch error: ${fetchError.message}`);
      return c.json(
        {
          error: {
            type: "network_error",
            message: `Failed to connect to Gemini API: ${fetchError.message}`,
          },
        },
        503
      );
    }

    log(`[BaseGeminiHandler] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = response.status === 429 ? lastErrorText : await response.text();
      log(`[BaseGeminiHandler] API error ${response.status} after ${attempts} attempt(s): ${errorText}`);
      return c.json({ error: errorText }, response.status as any);
    }

    if (attempts > 1) {
      log(`[BaseGeminiHandler] Request succeeded after ${attempts} attempts`);
    }

    if (droppedParams.length > 0) {
      c.header("X-Dropped-Params", droppedParams.join(", "));
    }

    return this.handleStreamingResponse(c, response, claudeRequest);
  }

  async shutdown(): Promise<void> {
    // Cleanup if needed
  }
}
