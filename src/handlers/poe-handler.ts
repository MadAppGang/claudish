import type { Context } from "hono";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelHandler } from "./types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager, GeminiThoughtSignatureMiddleware } from "../middleware/index.js";
import { transformOpenAIToClaude, removeUriFormat } from "../transform.js";
import { log, logStructured, isLoggingEnabled } from "../logger.js";
import { fetchModelContextWindow, doesModelSupportReasoning } from "../model-loader.js";

const POE_API_URL = "https://api.poe.com/v1/chat/completions";
const POE_HEADERS = {
  "User-Agent": "Claudish-Poe-Proxy/1.0",
};

export class PoeHandler implements ModelHandler {
  private targetModel: string;
  private apiKey?: string;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private contextWindowCache = new Map<string, number>();
  private port: number;
  private sessionTotalCost = 0;
  private CLAUDE_INTERNAL_CONTEXT_MAX = 200000;

  constructor(targetModel: string, apiKey: string | undefined, port: number) {
    this.targetModel = targetModel;
    this.apiKey = apiKey;
    this.port = port;
    this.adapterManager = new AdapterManager(targetModel);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    this.middlewareManager.initialize().catch(err => log(`[PoeHandler:${targetModel}] Middleware init error: ${err}`));
    this.fetchContextWindow(targetModel);
  }

  private async fetchContextWindow(model: string) {
    if (this.contextWindowCache.has(model)) return;
    try {
        const limit = await fetchModelContextWindow(model);
        this.contextWindowCache.set(model, limit);
    } catch (e) {}
  }

  private getTokenScaleFactor(model: string): number {
      const limit = this.contextWindowCache.get(model) || 200000;
      return limit === 0 ? 1 : this.CLAUDE_INTERNAL_CONTEXT_MAX / limit;
  }

  private writeTokenFile(input: number, output: number) {
      try {
          const total = input + output;
          const limit = this.contextWindowCache.get(this.targetModel) || 200000;
          const leftPct = limit > 0 ? Math.max(0, Math.min(100, Math.round(((limit - total) / limit) * 100))) : 100;
          const data = {
              input_tokens: input,
              output_tokens: output,
              total_tokens: total,
              total_cost: this.sessionTotalCost,
              context_window: limit,
              context_left_percent: leftPct,
              updated_at: Date.now()
          };
          writeFileSync(join(tmpdir(), `claudish-tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
      } catch (e) {}
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const claudePayload = payload;
    const target = this.targetModel;
    await this.fetchContextWindow(target);

    logStructured(`Poe Request`, { targetModel: target, originalModel: claudePayload.model });

    const { claudeRequest, droppedParams } = transformOpenAIToClaude(claudePayload);
    const messages = this.convertMessages(claudeRequest, target);
    const tools = this.convertTools(claudeRequest);
    const supportsReasoning = await doesModelSupportReasoning(target);

    // Extract actual model name without "poe/" prefix for Poe API
    const actualModelName = target.replace(/^poe\//, '');

    const poePayload: any = {
        model: actualModelName,
        messages,
        temperature: claudeRequest.temperature ?? 1,
        stream: true,
        max_tokens: claudeRequest.max_tokens,
        tools: tools.length > 0 ? tools : undefined,
        stream_options: { include_usage: true }
    };

    if (supportsReasoning) poePayload.include_reasoning = true;
    if (claudeRequest.thinking) poePayload.thinking = claudeRequest.thinking;

    if (claudeRequest.tool_choice) {
        const { type, name } = claudeRequest.tool_choice;
        if (type === 'tool' && name) poePayload.tool_choice = { type: 'function', function: { name } };
        else if (type === 'auto' || type === 'none') poePayload.tool_choice = type;
    }

    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === 'function') adapter.reset();
    adapter.prepareRequest(poePayload, claudeRequest);

    await this.middlewareManager.beforeRequest({ modelId: target, messages, tools, stream: true });

    const response = await fetch(POE_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
            ...POE_HEADERS,
        },
        body: JSON.stringify(poePayload)
    });

    if (!response.ok) return c.json({ error: await response.text() }, response.status as any);
    if (droppedParams.length > 0) c.header("X-Dropped-Params", droppedParams.join(", "));

    return this.handleStreamingResponse(c, response, adapter, target, claudeRequest);
  }

  private convertMessages(req: any, modelId: string): any[] {
      const messages: any[] = [];
      if (req.system) {
          let content = Array.isArray(req.system) ? req.system.map((i: any) => i.text || i).join("\n\n") : req.system;
          content = this.filterIdentity(content);
          messages.push({ role: "system", content });
      }

      // Add Poe-specific tool calling instructions for models that need it
      if (modelId.includes("grok") || modelId.includes("x-ai")) {
          const msg = "IMPORTANT: When calling tools, you MUST use the OpenAI tool_calls format with JSON. NEVER use XML format like <xai:function_call>.";
          if (messages.length > 0 && messages[0].role === 'system') messages[0].content += "\n\n" + msg;
          else messages.unshift({ role: "system", content: msg });
      }

      if (req.messages) {
          for (const msg of req.messages) {
              if (msg.role === "user") this.processUserMessage(msg, messages);
              else if (msg.role === "assistant") this.processAssistantMessage(msg, messages);
          }
      }
      return messages;
  }

  private processUserMessage(msg: any, messages: any[]) {
      if (Array.isArray(msg.content)) {
          const contentParts = [];
          const toolResults = [];
          const seen = new Set();

          for (const part of msg.content) {
              if (part.type === "text") {
                  contentParts.push({ type: "text", text: part.text });
              } else if (part.type === "image") {
                  contentParts.push({
                      type: "image_url",
                      image_url: { url: part.source.url }
                  });
              } else if (part.type === "tool_result") {
                  const toolCallId = part.tool_call_id;
                  if (!seen.has(toolCallId)) {
                      toolResults.push({
                          tool_call_id: toolCallId,
                          content: part.content || null
                      });
                      seen.add(toolCallId);
                  }
              }
          }

          if (contentParts.length > 0) {
              messages.push({ role: "user", content: contentParts });
          }
          if (toolResults.length > 0) {
              messages.push({ role: "tool", content: toolResults });
          }
      } else {
          messages.push({ role: "user", content: msg.content });
      }
  }

  private processAssistantMessage(msg: any, messages: any[]) {
      if (Array.isArray(msg.content)) {
          let textContent = "";
          const toolCalls = [];

          for (const part of msg.content) {
              if (part.type === "text") {
                  textContent += part.text;
              } else if (part.type === "tool_use") {
                  toolCalls.push({
                      id: part.id,
                      type: "function",
                      function: {
                          name: part.name,
                          arguments: JSON.stringify(part.input)
                      }
                  });
              }
          }

          if (textContent && toolCalls.length > 0) {
              messages.push({
                  role: "assistant",
                  content: textContent,
                  tool_calls: toolCalls
              });
          } else if (textContent) {
              messages.push({ role: "assistant", content: textContent });
          } else if (toolCalls.length > 0) {
              messages.push({ role: "assistant", tool_calls: toolCalls });
          }
      } else {
          messages.push({ role: "assistant", content: msg.content });
      }
  }

  private convertTools(req: any): any[] {
      if (!req.tools) return [];

      return req.tools.map((tool: any) => ({
          type: "function",
          function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema
          }
      }));
  }

  private filterIdentity(content: string): string {
      return content.replace(/Claude (Code|ai)/g, "Claudish").replace(/Claude/g, "AI Assistant");
  }

  private async handleStreamingResponse(
    c: Context,
    response: Response,
    adapter: any,
    targetModel: string,
    claudeRequest: any
  ): Promise<Response> {
    const reader = response.body?.getReader();
    if (!reader) {
        return c.json({ error: "No response body" }, 500);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            try {
                let buffer = "";
                let contentIndex = 0;
                let thinkingIndex = 1;
                let toolCallIndex = 0;
                let currentToolCall: any = null;
                let usageAccumulator: any = {};

                await PoeHandler.writeMessageStart(controller, encoder, targetModel, claudeRequest);

                const processChunk = async (chunk: Uint8Array) => {
                    buffer += new TextDecoder().decode(chunk);
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        if (line.trim() === "") continue;
                        if (line.startsWith("data: ")) {
                            const data = line.slice(6);
                            if (data === "[DONE]") continue;

                            try {
                                const parsed = JSON.parse(data);
                                await PoeHandler.processSSEEvent(
                                    parsed,
                                    controller,
                                    encoder,
                                    contentIndex,
                                    thinkingIndex,
                                    toolCallIndex,
                                    currentToolCall,
                                    usageAccumulator,
                                    adapter
                                );

                                if (parsed.choices?.[0]?.delta?.content) {
                                    contentIndex++;
                                }
                                if (parsed.choices?.[0]?.delta?.tool_calls) {
                                    toolCallIndex++;
                                }
                            } catch (e) {
                                logStructured(`PoeHandler SSE Parse Error`, { data, error: e instanceof Error ? e.message : e });
                            }
                        }
                    }
                };

                const pump = async () => {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        await processChunk(value);
                    }
                    await pump();
                };

                await pump();

                await PoeHandler.writeMessageEnd(controller, encoder, usageAccumulator);

            } catch (error) {
                logStructured(`PoeHandler Stream Error`, { error: error instanceof Error ? error.message : error });
                controller.error(error);
            } finally {
                try { reader.releaseLock(); } catch (e) {}
            }
        }
    });

    return c.body(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    });
  }

  private static async writeMessageStart(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    targetModel: string,
    claudeRequest: any
  ) {
    const startEvent = {
        type: "message_start",
        message: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [],
            model: targetModel,
            stop_reason: null,
            stop_sequence: null,
            usage: {
                input_tokens: 0,
                output_tokens: 0
            }
        }
    };

    controller.enqueue(encoder.encode(`event: message_start\n`));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(startEvent)}\n\n`));

    const contentBlockStart = {
        type: "content_block_start",
        index: 0,
        content_block: {
            type: "text",
            text: ""
        }
    };

    controller.enqueue(encoder.encode(`event: content_block_start\n`));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentBlockStart)}\n\n`));

    controller.enqueue(encoder.encode(`event: ping\n`));
    controller.enqueue(encoder.encode(`data: {"type": "ping"}\n\n`));
  }

  private static async processSSEEvent(
    parsed: any,
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    contentIndex: number,
    thinkingIndex: number,
    toolCallIndex: number,
    currentToolCall: any,
    usageAccumulator: any,
    adapter: any
  ) {
    const delta = parsed.choices?.[0]?.delta;

    if (delta?.content) {
        const adaptedDelta = adapter.processChunk ? adapter.processChunk(delta.content) : delta.content;
        const textDelta = {
            type: "text_delta",
            delta: { type: "text_delta", text: adaptedDelta }
        };

        controller.enqueue(encoder.encode(`event: text_delta\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(textDelta)}\n\n`));
    }

    if (delta?.tool_calls) {
        for (const toolCall of delta.tool_calls) {
            if (toolCall.function?.arguments) {
                const toolDelta = {
                    type: "input_json_delta",
                    delta: { partial_json: toolCall.function.arguments }
                };

                controller.enqueue(encoder.encode(`event: input_json_delta\n`));
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolDelta)}\n\n`));
            }
        }
    }

    if (parsed.usage) {
        Object.assign(usageAccumulator, parsed.usage);
    }
  }

  private static async writeMessageEnd(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    usageAccumulator: any
  ) {
    const contentBlockStop = {
        type: "content_block_stop",
        index: 0
    };

    controller.enqueue(encoder.encode(`event: content_block_stop\n`));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentBlockStop)}\n\n`));

    const messageDelta = {
        type: "message_delta",
        delta: {
            stop_reason: "end_turn",
            stop_sequence: null
        },
        usage: {
            output_tokens: usageAccumulator.output_tokens || 0
        }
    };

    controller.enqueue(encoder.encode(`event: message_delta\n`));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(messageDelta)}\n\n`));

    const messageStop = {
        type: "message_stop"
    };

    controller.enqueue(encoder.encode(`event: message_stop\n`));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(messageStop)}\n\n`));
  }

  async shutdown(): Promise<void> {
    // Clean up resources
    this.contextWindowCache.clear();
    await this.middlewareManager.destroy();
  }
}