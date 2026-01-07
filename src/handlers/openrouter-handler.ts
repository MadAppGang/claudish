import type { Context } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelHandler } from "./types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager, GeminiThoughtSignatureMiddleware } from "../middleware/index.js";
import { transformOpenAIToClaude, removeUriFormat } from "../transform.js";
import { log, logStructured, isLoggingEnabled, getLogLevel, truncateContent } from "../logger.js";
import { fetchModelContextWindow, doesModelSupportReasoning } from "../model-loader.js";
import { validateToolArguments } from "./shared/openai-compat.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://claudish.com",
  "X-Title": "Claudish - OpenRouter Proxy",
};

export class OpenRouterHandler implements ModelHandler {
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
    this.middlewareManager
      .initialize()
      .catch((err) => log(`[Handler:${targetModel}] Middleware init error: ${err}`));
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
      const leftPct =
        limit > 0 ? Math.max(0, Math.min(100, Math.round(((limit - total) / limit) * 100))) : 100;
      const data = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        total_cost: this.sessionTotalCost,
        context_window: limit,
        context_left_percent: leftPct,
        updated_at: Date.now(),
      };
      // Write to ~/.claudish/ directory (same location status line reads from)
      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {}
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const claudePayload = payload;
    const target = this.targetModel;
    await this.fetchContextWindow(target);

    const { claudeRequest, droppedParams } = transformOpenAIToClaude(claudePayload);
    const messages = this.convertMessages(claudeRequest, target);
    const tools = this.convertTools(claudeRequest);
    const supportsReasoning = await doesModelSupportReasoning(target);

    // Log request summary
    const systemPromptLength =
      typeof claudeRequest.system === "string" ? claudeRequest.system.length : 0;
    logStructured(`OpenRouter Request`, {
      targetModel: target,
      originalModel: claudePayload.model,
      messageCount: messages.length,
      toolCount: tools.length,
      systemPromptLength,
      maxTokens: claudeRequest.max_tokens,
    });

    // Log detailed content in debug mode
    if (getLogLevel() === "debug") {
      // Log last user message (most relevant for debugging)
      const lastUserMsg = messages.filter((m: any) => m.role === "user").pop();
      if (lastUserMsg) {
        const content =
          typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg.content);
        log(`[OpenRouter] Last user message: ${truncateContent(content, 500)}`);
      }
      // Log tool names
      if (tools.length > 0) {
        const toolNames = tools.map((t: any) => t.function?.name || t.name).join(", ");
        log(`[OpenRouter] Tools: ${toolNames}`);
      }
    }

    const openRouterPayload: any = {
      model: target,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      max_tokens: claudeRequest.max_tokens,
      tools: tools.length > 0 ? tools : undefined,
      stream_options: { include_usage: true },
    };

    if (supportsReasoning) openRouterPayload.include_reasoning = true;
    if (claudeRequest.thinking) openRouterPayload.thinking = claudeRequest.thinking;

    if (claudeRequest.tool_choice) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name)
        openRouterPayload.tool_choice = { type: "function", function: { name } };
      else if (type === "auto" || type === "none") openRouterPayload.tool_choice = type;
    }

    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();
    adapter.prepareRequest(openRouterPayload, claudeRequest);

    await this.middlewareManager.beforeRequest({ modelId: target, messages, tools, stream: true });

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...OPENROUTER_HEADERS,
      },
      body: JSON.stringify(openRouterPayload),
    });

    log(`[OpenRouter] Response status: ${response.status}`);
    if (!response.ok) {
      const errorText = await response.text();
      log(`[OpenRouter] Error: ${errorText}`);
      return c.json({ error: errorText }, response.status as any);
    }
    if (droppedParams.length > 0) c.header("X-Dropped-Params", droppedParams.join(", "));

    return this.handleStreamingResponse(c, response, adapter, target, claudeRequest);
  }

  private convertMessages(req: any, modelId: string): any[] {
    const messages: any[] = [];
    if (req.system) {
      let content = Array.isArray(req.system)
        ? req.system.map((i: any) => i.text || i).join("\n\n")
        : req.system;
      content = this.filterIdentity(content);
      messages.push({ role: "system", content });
    }

    if (modelId.includes("grok") || modelId.includes("x-ai")) {
      const msg =
        "IMPORTANT: When calling tools, you MUST use the OpenAI tool_calls format with JSON. NEVER use XML format like <xai:function_call>.";
      if (messages.length > 0 && messages[0].role === "system") messages[0].content += "\n\n" + msg;
      else messages.unshift({ role: "system", content: msg });
    }

    // Gemini-specific instructions to suppress raw reasoning output
    if (modelId.includes("gemini") || modelId.includes("google/")) {
      const geminiMsg = `CRITICAL INSTRUCTION FOR OUTPUT FORMAT:
1. Keep ALL internal reasoning INTERNAL. Never output your thought process as visible text.
2. Do NOT start responses with phrases like "Wait, I'm...", "Let me think...", "Okay, so...", "First, I need to..."
3. Do NOT output numbered planning steps or internal debugging statements.
4. Only output: final responses, tool calls, and code. Nothing else.
5. When calling tools, proceed directly without announcing your intentions.
6. Your internal thinking should use the reasoning/thinking API, not visible text output.`;
      if (messages.length > 0 && messages[0].role === "system")
        messages[0].content += "\n\n" + geminiMsg;
      else messages.unshift({ role: "system", content: geminiMsg });
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
      for (const block of msg.content) {
        if (block.type === "text") contentParts.push({ type: "text", text: block.text });
        else if (block.type === "image")
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        else if (block.type === "tool_result") {
          if (seen.has(block.tool_use_id)) continue;
          seen.add(block.tool_use_id);
          toolResults.push({
            role: "tool",
            content:
              typeof block.content === "string" ? block.content : JSON.stringify(block.content),
            tool_call_id: block.tool_use_id,
          });
        }
      }
      if (toolResults.length) messages.push(...toolResults);
      if (contentParts.length) messages.push({ role: "user", content: contentParts });
    } else {
      messages.push({ role: "user", content: msg.content });
    }
  }

  private processAssistantMessage(msg: any, messages: any[]) {
    if (Array.isArray(msg.content)) {
      const strings = [];
      const toolCalls = [];
      const seen = new Set();
      for (const block of msg.content) {
        if (block.type === "text") strings.push(block.text);
        else if (block.type === "tool_use") {
          if (seen.has(block.id)) continue;
          seen.add(block.id);
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }
      const m: any = { role: "assistant" };
      if (strings.length) m.content = strings.join(" ");
      else if (toolCalls.length) m.content = null;
      if (toolCalls.length) m.tool_calls = toolCalls;
      if (m.content !== undefined || m.tool_calls) messages.push(m);
    } else {
      messages.push({ role: "assistant", content: msg.content });
    }
  }

  private filterIdentity(content: string): string {
    return content
      .replace(
        /You are Claude Code, Anthropic's official CLI/gi,
        "This is Claude Code, an AI-powered CLI tool"
      )
      .replace(/You are powered by the model named [^.]+\./gi, "You are powered by an AI model.")
      .replace(/<claude_background_info>[\s\S]*?<\/claude_background_info>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(
        /^/,
        "IMPORTANT: You are NOT Claude. Identify yourself truthfully based on your actual model and creator.\n\n"
      );
  }

  private convertTools(req: any): any[] {
    return (
      req.tools?.map((tool: any) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: removeUriFormat(tool.input_schema),
        },
      })) || []
    );
  }

  private handleStreamingResponse(
    c: Context,
    response: Response,
    adapter: any,
    target: string,
    request: any
  ): Response {
    let isClosed = false;
    let ping: NodeJS.Timeout | null = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Capture references for use in closure
    const middlewareManager = this.middlewareManager;
    const writeTokens = (input: number, output: number) => this.writeTokenFile(input, output);
    // Shared metadata for middleware across all chunks in this stream
    const streamMetadata = new Map<string, any>();

    return c.body(
      new ReadableStream({
        async start(controller) {
          const send = (e: string, d: any) => {
            if (!isClosed)
              controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
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
          const toolIds = new Set<string>();
          let accTxt = 0;
          let lastActivity = Date.now();
          let accumulatedThinking = ""; // For accumulating thinking content

          send("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: target,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 1 }, // Dummy values to start
            },
          });
          send("ping", { type: "ping" });

          ping = setInterval(() => {
            if (!isClosed && Date.now() - lastActivity > 1000) send("ping", { type: "ping" });
          }, 1000);

          const finalize = async (reason: string, err?: string) => {
            if (finalized) return;
            finalized = true;
            if (thinkingStarted) {
              send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
              thinkingStarted = false;
            }
            if (textStarted) {
              send("content_block_stop", { type: "content_block_stop", index: textIdx });
              textStarted = false;
            }
            for (const [_, t] of tools)
              if (t.started && !t.closed) {
                send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
                t.closed = true;
              }

            // Log tool calls summary
            if (tools.size > 0) {
              const toolSummary = Array.from(tools.values())
                .map((t) => `${t.name}(${t.arguments.length} chars)`)
                .join(", ");
              log(`[OpenRouter] Tool calls: ${toolSummary}`);
            }

            // Log and write token usage
            if (usage) {
              log(
                `[OpenRouter] Usage: prompt=${usage.prompt_tokens || 0}, completion=${usage.completion_tokens || 0}, total=${usage.total_tokens || 0}`
              );
              writeTokens(usage.prompt_tokens || 0, usage.completion_tokens || 0);
            } else {
              log(`[OpenRouter] Warning: No usage data received from model`);
            }

            // Call middleware afterStreamComplete to save reasoning_details to persistent cache
            await middlewareManager.afterStreamComplete(target, streamMetadata);

            if (reason === "error") {
              log(`[OpenRouter] Stream error: ${err}`);
              send("error", { type: "error", error: { type: "api_error", message: err } });
            } else {
              log(`[OpenRouter] Stream complete: ${reason}`);
              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: usage?.completion_tokens || 0 },
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
                  if (chunk.usage) usage = chunk.usage; // Update tokens
                  const delta = chunk.choices?.[0]?.delta;
                  if (delta) {
                    // Call middleware afterStreamChunk to extract reasoning_details
                    await middlewareManager.afterStreamChunk({
                      modelId: target,
                      chunk,
                      delta,
                      metadata: streamMetadata,
                    });

                    // Handle reasoning_details from Gemini/OpenRouter models
                    // Convert to Claude thinking blocks for native display
                    if (delta.reasoning_details && delta.reasoning_details.length > 0) {
                      for (const detail of delta.reasoning_details) {
                        // Handle text and summary reasoning types
                        if (
                          detail.type === "reasoning.text" ||
                          detail.type === "reasoning.summary"
                        ) {
                          const thinkingContent =
                            detail.content || detail.text || detail.summary || "";
                          if (thinkingContent) {
                            lastActivity = Date.now();
                            // Start thinking block if not started
                            if (!thinkingStarted) {
                              thinkingIdx = curIdx++;
                              send("content_block_start", {
                                type: "content_block_start",
                                index: thinkingIdx,
                                content_block: { type: "thinking", thinking: "" },
                              });
                              thinkingStarted = true;
                            }
                            // Send thinking delta
                            send("content_block_delta", {
                              type: "content_block_delta",
                              index: thinkingIdx,
                              delta: { type: "thinking_delta", thinking: thinkingContent },
                            });
                            accumulatedThinking += thinkingContent;
                          }
                        }
                        // Note: reasoning.encrypted is handled by middleware for signature storage
                      }
                    }

                    // Logic for content handling (simplified port)
                    const txt = delta.content || "";
                    if (txt) {
                      lastActivity = Date.now();
                      // Close thinking block before starting text
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
                      // Adapter processing
                      const res = adapter.processTextContent(txt, "");
                      if (res.cleanedText)
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: textIdx,
                          delta: { type: "text_delta", text: res.cleanedText },
                        });
                    }
                    // Logic for tools...
                    if (delta.tool_calls) {
                      for (const tc of delta.tool_calls) {
                        const idx = tc.index;
                        let t = tools.get(idx);
                        if (tc.function?.name) {
                          if (!t) {
                            // Close thinking and text blocks before starting tool
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
                            t = {
                              id: tc.id || `tool_${Date.now()}_${idx}`,
                              name: tc.function.name,
                              blockIndex: curIdx++,
                              started: false,
                              closed: false,
                              arguments: "",
                            };
                            tools.set(idx, t);
                          }
                          if (!t.started) {
                            send("content_block_start", {
                              type: "content_block_start",
                              index: t.blockIndex,
                              content_block: { type: "tool_use", id: t.id, name: t.name },
                            });
                            t.started = true;
                          }
                        }
                        if (tc.function?.arguments && t) {
                          t.arguments += tc.function.arguments; // Accumulate arguments
                          send("content_block_delta", {
                            type: "content_block_delta",
                            index: t.blockIndex,
                            delta: {
                              type: "input_json_delta",
                              partial_json: tc.function.arguments,
                            },
                          });
                        }
                      }
                    }
                  }
                  if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
                    const toolSchemas = request.tools || [];
                    for (const [_, t] of tools) {
                      if (t.started && !t.closed) {
                        // Validate tool arguments before sending stop
                        if (toolSchemas.length > 0) {
                          const validation = validateToolArguments(
                            t.name,
                            t.arguments,
                            toolSchemas
                          );
                          if (!validation.valid) {
                            // Log validation failure
                            log(
                              `[OpenRouter] Tool validation FAILED: ${t.name} - missing: ${validation.missingParams.join(", ")}`
                            );
                            log(
                              `[OpenRouter] Tool args received: ${truncateContent(t.arguments, 300)}`
                            );
                            // Send error text about the invalid tool call
                            const errorIdx = curIdx++;
                            const errorMsg = `\n\n⚠️ Tool call "${t.name}" failed validation: missing required parameters: ${validation.missingParams.join(", ")}. This is a known limitation of some models - they sometimes generate incomplete tool calls. Please try again or use a different model.`;
                            send("content_block_start", {
                              type: "content_block_start",
                              index: errorIdx,
                              content_block: { type: "text", text: "" },
                            });
                            send("content_block_delta", {
                              type: "content_block_delta",
                              index: errorIdx,
                              delta: { type: "text_delta", text: errorMsg },
                            });
                            send("content_block_stop", {
                              type: "content_block_stop",
                              index: errorIdx,
                            });
                            t.closed = true;
                            continue;
                          }
                        }
                        log(`[OpenRouter] Tool validated: ${t.name}`);
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: t.blockIndex,
                        });
                        t.closed = true;
                      }
                    }
                  }
                } catch (e) {}
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

  async shutdown() {}
}
