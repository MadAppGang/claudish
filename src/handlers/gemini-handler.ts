/**
 * Gemini API Handler
 *
 * Handles direct communication with Google's Gemini API.
 * Supports streaming, tool calling, and thinking/reasoning.
 *
 * API Documentation: https://ai.google.dev/gemini-api/docs
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
import { getModelPricing, type ModelPricing, type RemoteProvider } from "./shared/remote-provider-types.js";

/**
 * Gemini API Handler
 *
 * Uses Gemini's native API format which differs from OpenAI:
 * - Messages use "parts" instead of "content"
 * - Tools use "functionDeclarations"
 * - Responses come as "candidates" with "content.parts"
 */
export class GeminiHandler implements ModelHandler {
  private provider: RemoteProvider;
  private modelName: string;
  private apiKey: string;
  private port: number;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private sessionTotalCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private contextWindow = 1000000; // Gemini has 1M context by default
  private toolCallMap = new Map<string, string>(); // tool_use_id -> function_name for tool result mapping

  constructor(provider: RemoteProvider, modelName: string, apiKey: string, port: number) {
    this.provider = provider;
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.port = port;
    this.adapterManager = new AdapterManager(`gemini/${modelName}`);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    this.middlewareManager.initialize().catch(err =>
      log(`[GeminiHandler:${modelName}] Middleware init error: ${err}`)
    );
  }

  /**
   * Get pricing for the current model
   */
  private getPricing(): ModelPricing {
    return getModelPricing("gemini", this.modelName);
  }

  /**
   * Get the API endpoint URL
   */
  private getApiEndpoint(): string {
    const baseUrl = this.provider.baseUrl;
    const apiPath = this.provider.apiPath.replace("{model}", this.modelName);
    return `${baseUrl}${apiPath}`;
  }

  /**
   * Write token tracking file
   */
  private writeTokenFile(input: number, output: number): void {
    try {
      const total = input + output;
      const leftPct = this.contextWindow > 0
        ? Math.max(0, Math.min(100, Math.round(((this.contextWindow - total) / this.contextWindow) * 100)))
        : 100;

      const data = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        total_cost: this.sessionTotalCost,
        context_window: this.contextWindow,
        context_left_percent: leftPct,
        updated_at: Date.now(),
      };

      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      log(`[GeminiHandler] Error writing token file: ${e}`);
    }
  }

  /**
   * Update token tracking
   */
  private updateTokenTracking(inputTokens: number, outputTokens: number): void {
    this.sessionInputTokens = inputTokens;
    this.sessionOutputTokens += outputTokens;

    const pricing = this.getPricing();
    const cost = (inputTokens / 1_000_000) * pricing.inputCostPer1M +
                 (outputTokens / 1_000_000) * pricing.outputCostPer1M;
    this.sessionTotalCost += cost;

    this.writeTokenFile(inputTokens, this.sessionOutputTokens);
  }

  /**
   * Convert Claude messages to Gemini format
   */
  private convertToGeminiMessages(claudeRequest: any): any[] {
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
  private convertUserMessageParts(msg: any): any[] {
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
          const functionName = this.toolCallMap.get(block.tool_use_id);
          if (!functionName) {
            log(`[GeminiHandler:${this.modelName}] Warning: No function name found for tool_use_id ${block.tool_use_id}`);
            continue;
          }
          parts.push({
            functionResponse: {
              name: functionName,
              response: {
                content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
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
  private convertAssistantMessageParts(msg: any): any[] {
    const parts: any[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          // Track the mapping from tool_use_id to function name for tool results
          this.toolCallMap.set(block.id, block.name);
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input,
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
   * Convert Claude tools to Gemini function declarations
   */
  private convertToGeminiTools(claudeRequest: any): any {
    if (!claudeRequest.tools || claudeRequest.tools.length === 0) {
      return undefined;
    }

    const functionDeclarations = claudeRequest.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      parameters: this.convertJsonSchemaToGemini(tool.input_schema),
    }));

    return [{ functionDeclarations }];
  }

  /**
   * Convert JSON Schema to Gemini's schema format
   */
  private convertJsonSchemaToGemini(schema: any): any {
    if (!schema) return {};

    // Clone and modify schema for Gemini compatibility
    const geminiSchema: any = {
      type: schema.type || "object",
    };

    if (schema.properties) {
      geminiSchema.properties = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        geminiSchema.properties[key] = this.convertPropertyToGemini(prop as any);
      }
    }

    if (schema.required) {
      geminiSchema.required = schema.required;
    }

    return geminiSchema;
  }

  /**
   * Convert a single property to Gemini format
   */
  private convertPropertyToGemini(prop: any): any {
    const result: any = {
      type: prop.type || "string",
    };

    if (prop.description) result.description = prop.description;
    if (prop.enum) result.enum = prop.enum;
    if (prop.items) result.items = this.convertPropertyToGemini(prop.items);
    if (prop.properties) {
      result.properties = {};
      for (const [k, v] of Object.entries(prop.properties)) {
        result.properties[k] = this.convertPropertyToGemini(v as any);
      }
    }

    return result;
  }

  /**
   * Build the Gemini API request payload
   */
  private buildGeminiPayload(claudeRequest: any): any {
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
  private handleStreamingResponse(c: Context, response: Response, _claudeRequest: any): Response {
    let isClosed = false;
    let ping: NodeJS.Timeout | null = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const streamMetadata = new Map<string, any>();
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

            await this.middlewareManager.afterStreamComplete(`gemini/${this.modelName}`, streamMetadata);

            if (usage) {
              log(`[GeminiHandler] Usage: prompt=${usage.promptTokenCount || 0}, completion=${usage.candidatesTokenCount || 0}`);
              this.updateTokenTracking(usage.promptTokenCount || 0, usage.candidatesTokenCount || 0);
            }

            if (reason === "error") {
              log(`[GeminiHandler] Stream error: ${err}`);
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
                          send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
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
                          send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
                          thinkingStarted = false;
                        }
                        if (textStarted) {
                          send("content_block_stop", { type: "content_block_stop", index: textIdx });
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
                        send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
                        t.closed = true;
                      }
                    }
                  }

                  // Check for finish reason
                  if (candidate?.finishReason) {
                    if (candidate.finishReason === "STOP" || candidate.finishReason === "MAX_TOKENS") {
                      await finalize("done");
                      return;
                    }
                  }
                } catch (e) {
                  log(`[GeminiHandler] Parse error: ${e}`);
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
   * Main request handler
   */
  async handle(c: Context, payload: any): Promise<Response> {
    // Transform Claude request
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);

    // Log request summary
    const systemPromptLength = typeof claudeRequest.system === "string" ? claudeRequest.system.length : 0;
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

    // Make API call
    const endpoint = this.getApiEndpoint();
    log(`[GeminiHandler] Calling API: ${endpoint}`);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(geminiPayload),
    });

    log(`[GeminiHandler] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      log(`[GeminiHandler] Error: ${errorText}`);
      return c.json({ error: errorText }, response.status as any);
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
