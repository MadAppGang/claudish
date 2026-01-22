/**
 * Vertex AI OAuth Handler
 *
 * Handles Vertex AI requests using OAuth authentication.
 * Supports both Gemini models and partner models (Anthropic, Mistral).
 *
 * For Gemini: Uses generateContent/streamGenerateContent API
 * For Partners: Uses rawPredict/streamRawPredict API with native formats
 */

import type { Context } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelHandler } from "./types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import {
  MiddlewareManager,
  GeminiThoughtSignatureMiddleware,
} from "../middleware/index.js";
import { transformOpenAIToClaude } from "../transform.js";
import { log, logStructured } from "../logger.js";
import { filterIdentity } from "./shared/openai-compat.js";
import {
  getModelPricing,
  type ModelPricing,
} from "./shared/remote-provider-types.js";
import {
  getVertexAuthManager,
  getVertexConfig,
  buildVertexOAuthEndpoint,
  type VertexConfig,
} from "../auth/vertex-auth.js";

interface ParsedVertexModel {
  publisher: string;
  model: string;
}

/**
 * Parse vertex model string into publisher and model
 * Examples:
 *   "gemini-2.5-flash" -> { publisher: "google", model: "gemini-2.5-flash" }
 *   "anthropic/claude-3-5-sonnet" -> { publisher: "anthropic", model: "claude-3-5-sonnet" }
 */
function parseVertexModel(modelId: string): ParsedVertexModel {
  const parts = modelId.split("/");
  if (parts.length === 1) {
    // Default to google publisher for Gemini models
    return { publisher: "google", model: parts[0] };
  }
  return { publisher: parts[0], model: parts.slice(1).join("/") };
}

/**
 * Vertex AI OAuth Handler
 */
export class VertexOAuthHandler implements ModelHandler {
  private modelName: string;
  private port: number;
  private config: VertexConfig;
  private parsed: ParsedVertexModel;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private sessionTotalCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private contextWindow = 1000000;
  private toolCallMap = new Map<string, { name: string; thoughtSignature?: string }>();

  constructor(modelName: string, port: number) {
    this.modelName = modelName;
    this.port = port;
    this.config = getVertexConfig()!;
    this.parsed = parseVertexModel(modelName);

    this.adapterManager = new AdapterManager(`vertex/${modelName}`);
    this.middlewareManager = new MiddlewareManager();

    if (this.parsed.publisher === "google") {
      this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    }

    this.middlewareManager
      .initialize()
      .catch((err) => log(`[VertexOAuth:${modelName}] Middleware init error: ${err}`));
  }

  private getPricing(): ModelPricing {
    return getModelPricing("vertex", this.parsed.model);
  }

  private getApiEndpoint(): string {
    return buildVertexOAuthEndpoint(
      this.config,
      this.parsed.publisher,
      this.parsed.model,
      true // streaming
    );
  }

  private writeTokenFile(input: number, output: number): void {
    try {
      const total = input + output;
      const leftPct =
        this.contextWindow > 0
          ? Math.max(0, Math.min(100, Math.round(((this.contextWindow - total) / this.contextWindow) * 100)))
          : 100;

      const pricing = this.getPricing();

      // Strip provider prefix from model name for cleaner display
      const displayModelName = this.modelName.replace(/^(go|g|gemini|v|vertex|oai|mmax|mm|kimi|moonshot|glm|zhipu|oc|ollama|lmstudio|vllm|mlx)[\/:]/, '');

      const data = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        total_cost: this.sessionTotalCost,
        context_window: this.contextWindow,
        context_left_percent: leftPct,
        is_free: pricing.isFree || false,
        is_estimated: pricing.isEstimate || false,
        provider_name: "Vertex AI",
        model_name: displayModelName,
        updated_at: Date.now(),
      };

      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      log(`[VertexOAuth] Error writing token file: ${e}`);
    }
  }

  private updateTokenTracking(inputTokens: number, outputTokens: number): void {
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
   * Build request payload based on publisher
   */
  private buildPayload(claudeRequest: any): any {
    if (this.parsed.publisher === "google") {
      return this.buildGeminiPayload(claudeRequest);
    } else if (this.parsed.publisher === "anthropic") {
      return this.buildAnthropicPayload(claudeRequest);
    } else if (this.parsed.publisher === "mistralai" || this.parsed.publisher === "meta") {
      // Mistral and Meta use OpenAI-compatible format
      return this.buildOpenAIPayload(claudeRequest);
    } else {
      // Default to OpenAI format for unknown publishers (most common)
      return this.buildOpenAIPayload(claudeRequest);
    }
  }

  /**
   * Build Gemini-format payload
   */
  private buildGeminiPayload(claudeRequest: any): any {
    const contents = this.convertToGeminiMessages(claudeRequest);

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
      payload.systemInstruction = { parts: [{ text: systemContent }] };
    }

    const tools = this.convertToGeminiTools(claudeRequest);
    if (tools) {
      payload.tools = tools;
    }

    if (claudeRequest.thinking) {
      const { budget_tokens } = claudeRequest.thinking;
      if (this.parsed.model.includes("gemini-3")) {
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

  /**
   * Build Anthropic-format payload for Claude on Vertex
   */
  private buildAnthropicPayload(claudeRequest: any): any {
    // Anthropic on Vertex uses native Anthropic Messages API format
    // with anthropic_version in body instead of header
    const payload: any = {
      anthropic_version: "vertex-2023-10-16",
      messages: claudeRequest.messages,
      max_tokens: claudeRequest.max_tokens || 4096,
      stream: true,
    };

    if (claudeRequest.system) {
      payload.system = Array.isArray(claudeRequest.system)
        ? claudeRequest.system.map((i: any) => i.text || i).join("\n\n")
        : claudeRequest.system;
    }

    if (claudeRequest.temperature !== undefined) {
      payload.temperature = claudeRequest.temperature;
    }

    if (claudeRequest.tools && claudeRequest.tools.length > 0) {
      payload.tools = claudeRequest.tools;
    }

    return payload;
  }

  /**
   * Build OpenAI-format payload for Mistral, Meta, and other OpenAI-compatible models
   */
  private buildOpenAIPayload(claudeRequest: any): any {
    const messages: any[] = [];

    // Add system message if present
    if (claudeRequest.system) {
      const systemContent = Array.isArray(claudeRequest.system)
        ? claudeRequest.system.map((i: any) => i.text || i).join("\n\n")
        : claudeRequest.system;
      messages.push({ role: "system", content: filterIdentity(systemContent) });
    }

    // Convert Claude messages to OpenAI format
    if (claudeRequest.messages) {
      for (const msg of claudeRequest.messages) {
        if (msg.role === "user") {
          const content = this.convertClaudeContentToOpenAI(msg.content);
          messages.push({ role: "user", content });
        } else if (msg.role === "assistant") {
          const content = this.convertClaudeContentToOpenAI(msg.content);
          messages.push({ role: "assistant", content });
        }
      }
    }

    // Mistral rawPredict uses just model name; others use publisher/model
    const modelId = this.parsed.publisher === "mistralai"
      ? this.parsed.model
      : `${this.parsed.publisher}/${this.parsed.model}`;

    const payload: any = {
      model: modelId,
      messages,
      max_tokens: claudeRequest.max_tokens || 4096,
      stream: true,
    };

    if (claudeRequest.temperature !== undefined) {
      payload.temperature = claudeRequest.temperature;
    }

    // Convert tools to OpenAI format if present
    if (claudeRequest.tools && claudeRequest.tools.length > 0) {
      payload.tools = claudeRequest.tools.map((tool: any) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }));
    }

    return payload;
  }

  /**
   * Convert Claude content blocks to OpenAI format
   */
  private convertClaudeContentToOpenAI(content: any): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n");
    }
    return "";
  }

  // Gemini message conversion methods (same as GeminiHandler)
  private convertToGeminiMessages(claudeRequest: any): any[] {
    const messages: any[] = [];

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
            messages.push({ role: "model", parts });
          }
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
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
        } else if (block.type === "tool_result") {
          const toolInfo = this.toolCallMap.get(block.tool_use_id);
          if (toolInfo) {
            parts.push({
              functionResponse: {
                name: toolInfo.name,
                response: {
                  content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
                },
              },
            });
          }
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }

    return parts;
  }

  private convertAssistantMessageParts(msg: any): any[] {
    const parts: any[] = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          const toolInfo = this.toolCallMap.get(block.id);
          let thoughtSignature = toolInfo?.thoughtSignature || "skip_thought_signature_validator";

          const functionCallPart: any = {
            functionCall: {
              name: block.name,
              args: block.input,
            },
          };

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

  private convertToGeminiTools(claudeRequest: any): any {
    if (!claudeRequest.tools || claudeRequest.tools.length === 0) {
      return undefined;
    }

    const functionDeclarations = claudeRequest.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      parameters: this.sanitizeSchemaForGemini(tool.input_schema),
    }));

    return [{ functionDeclarations }];
  }

  private sanitizeSchemaForGemini(schema: any): any {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map((item) => this.sanitizeSchemaForGemini(item));

    const result: any = {};
    const normalizedType = Array.isArray(schema.type)
      ? schema.type.filter((t: string) => t !== "null")[0] || "string"
      : schema.type || "string";

    result.type = normalizedType;

    if (schema.description) result.description = schema.description;
    if (Array.isArray(schema.enum)) result.enum = schema.enum;
    if (Array.isArray(schema.required)) result.required = schema.required;

    if (schema.properties) {
      result.properties = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        if (value && typeof value === "object") {
          result.properties[key] = this.sanitizeSchemaForGemini(value);
        }
      }
    }

    if (schema.items) {
      result.items = this.sanitizeSchemaForGemini(
        Array.isArray(schema.items) ? schema.items[0] : schema.items
      );
    }

    return result;
  }

  /**
   * Handle streaming response (Gemini format)
   */
  private handleGeminiStreamingResponse(c: Context, response: Response): Response {
    let isClosed = false;
    let ping: NodeJS.Timeout | null = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
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
          let usage: any = null;
          let finalized = false;
          let textStarted = false;
          let textIdx = -1;
          let thinkingStarted = false;
          let thinkingIdx = -1;
          let curIdx = 0;
          const tools = new Map<number, any>();
          let lastActivity = Date.now();

          send("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: `vertex/${this.modelName}`,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 1 },
            },
          });

          ping = setInterval(() => {
            if (!isClosed && Date.now() - lastActivity > 1000) {
              send("ping", { type: "ping" });
            }
          }, 1000);

          const finalize = async (reason: string, err?: string) => {
            if (finalized) return;
            finalized = true;

            if (thinkingStarted) send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
            if (textStarted) send("content_block_stop", { type: "content_block_stop", index: textIdx });

            for (const t of Array.from(tools.values())) {
              if (t.started && !t.closed) {
                send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
                t.closed = true;
              }
            }

            if (usage) {
              this.updateTokenTracking(usage.promptTokenCount || 0, usage.candidatesTokenCount || 0);
            }

            if (reason === "error") {
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
              } catch {}
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

                  if (chunk.usageMetadata) usage = chunk.usageMetadata;

                  const candidate = chunk.candidates?.[0];
                  if (candidate?.content?.parts) {
                    for (const part of candidate.content.parts) {
                      lastActivity = Date.now();

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

                      if (part.text) {
                        if (thinkingStarted) {
                          send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
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
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: textIdx,
                          delta: { type: "text_delta", text: part.text },
                        });
                      }

                      if (part.functionCall) {
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

                        const thoughtSignature = part.thoughtSignature;
                        toolCallMap.set(t.id, { name: t.name, thoughtSignature });

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

                  if (candidate?.finishReason === "STOP" || candidate?.finishReason === "MAX_TOKENS") {
                    await finalize("done");
                    return;
                  }
                } catch {}
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
   * Handle streaming response (Anthropic format)
   */
  private handleAnthropicStreamingResponse(_c: Context, response: Response): Response {
    // For Anthropic on Vertex, the response is in native Anthropic SSE format
    // We can pass it through mostly unchanged
    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /**
   * Handle streaming response (OpenAI format - for Mistral, Meta, etc.)
   */
  private handleOpenAIStreamingResponse(c: Context, response: Response): Response {
    let isClosed = false;
    let ping: NodeJS.Timeout | null = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    return c.body(
      new ReadableStream({
        start: async (controller) => {
          const send = (e: string, d: any) => {
            if (!isClosed) {
              controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
            }
          };

          const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          let finalized = false;
          let textStarted = false;
          let textIdx = 0;
          let lastActivity = Date.now();

          send("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: `vertex/${this.modelName}`,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 1 },
            },
          });

          ping = setInterval(() => {
            if (!isClosed && Date.now() - lastActivity > 1000) {
              send("ping", { type: "ping" });
            }
          }, 1000);

          const finalize = async (reason: string, err?: string) => {
            if (finalized) return;
            finalized = true;

            if (textStarted) {
              send("content_block_stop", { type: "content_block_stop", index: textIdx });
            }

            if (reason === "error") {
              send("error", { type: "error", error: { type: "api_error", message: err } });
            } else {
              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 100 },
              });
              send("message_stop", { type: "message_stop" });
            }

            if (!isClosed) {
              try {
                controller.enqueue(encoder.encode("data: [DONE]\n\n\n"));
              } catch {}
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
                  const choice = chunk.choices?.[0];

                  if (choice?.delta?.content) {
                    lastActivity = Date.now();

                    if (!textStarted) {
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
                      delta: { type: "text_delta", text: choice.delta.content },
                    });
                  }

                  if (choice?.finish_reason) {
                    await finalize("done");
                    return;
                  }
                } catch {}
              }
            }

            await finalize("done");
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
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);

    logStructured("Vertex OAuth Request", {
      targetModel: `vertex/${this.modelName}`,
      publisher: this.parsed.publisher,
      model: this.parsed.model,
      project: this.config.projectId,
      location: this.config.location,
      messageCount: claudeRequest.messages?.length || 0,
      toolCount: claudeRequest.tools?.length || 0,
    });

    // Get OAuth token
    const authManager = getVertexAuthManager();
    let accessToken: string;
    try {
      accessToken = await authManager.getAccessToken();
    } catch (e: any) {
      log(`[VertexOAuth] Auth failed: ${e.message}`);
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

    // Build request
    const requestPayload = this.buildPayload(claudeRequest);
    const endpoint = this.getApiEndpoint();

    log(`[VertexOAuth] Calling API: ${endpoint}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError.name === "AbortError") {
        return c.json({ error: { type: "timeout_error", message: "Request timed out" } }, 504);
      }
      return c.json({ error: { type: "network_error", message: fetchError.message } }, 503);
    } finally {
      clearTimeout(timeoutId);
    }

    log(`[VertexOAuth] Response status: ${response.status}`);

    // Handle 401 - try to refresh token
    if (response.status === 401) {
      log("[VertexOAuth] Got 401, refreshing token and retrying");
      await authManager.refreshToken();
      const newToken = await authManager.getAccessToken();

      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${newToken}`,
        },
        body: JSON.stringify(requestPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return c.json({ error: errorText }, response.status as any);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      log(`[VertexOAuth] Error: ${errorText}`);
      return c.json({ error: errorText }, response.status as any);
    }

    if (droppedParams.length > 0) {
      c.header("X-Dropped-Params", droppedParams.join(", "));
    }

    // Handle response based on publisher
    if (this.parsed.publisher === "google") {
      return this.handleGeminiStreamingResponse(c, response);
    } else if (this.parsed.publisher === "anthropic") {
      return this.handleAnthropicStreamingResponse(c, response);
    } else {
      // Mistral, Meta, and other OpenAI-compatible providers
      return this.handleOpenAIStreamingResponse(c, response);
    }
  }

  async shutdown(): Promise<void> {}
}
