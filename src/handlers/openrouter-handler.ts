import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { isLoggingEnabled, log, logStructured } from "../logger.js";
import { GeminiThoughtSignatureMiddleware, MiddlewareManager } from "../middleware/index.js";
import { doesModelSupportReasoning, fetchModelContextWindow } from "../model-loader.js";
import { removeUriFormat, transformOpenAIToClaude } from "../transform.js";
import type { ModelHandler } from "./types.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/MadAppGang/claude-code",
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
      writeFileSync(
        join(tmpdir(), `claudish-tokens-${this.port}.json`),
        JSON.stringify(data),
        "utf-8"
      );
    } catch (e) {}
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const claudePayload = payload;
    const target = this.targetModel;
    await this.fetchContextWindow(target);

    logStructured("OpenRouter Request", {
      targetModel: target,
      originalModel: claudePayload.model,
    });

    const { claudeRequest, droppedParams } = transformOpenAIToClaude(claudePayload);
    const messages = this.convertMessages(claudeRequest, target);
    const tools = this.convertTools(claudeRequest);
    const supportsReasoning = await doesModelSupportReasoning(target);

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

    if (!response.ok) return c.json({ error: await response.text() }, response.status as any);
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
      if (messages.length > 0 && messages[0].role === "system") messages[0].content += `\n\n${msg}`;
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

    // Capture middleware manager for use in closure
    const middlewareManager = this.middlewareManager;
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
          let reasoningStarted = false;
          const reasoningIdx = -1;
          let curIdx = 0;
          const tools = new Map<number, any>();
          const toolIds = new Set<string>();
          const accTxt = 0;
          let lastActivity = Date.now();

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
            if (reasoningStarted) {
              send("content_block_stop", { type: "content_block_stop", index: reasoningIdx });
              reasoningStarted = false;
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

            // Call middleware afterStreamComplete to save reasoning_details to persistent cache
            await middlewareManager.afterStreamComplete(target, streamMetadata);

            if (reason === "error") {
              send("error", { type: "error", error: { type: "api_error", message: err } });
            } else {
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

                    // Logic for content handling (simplified port)
                    const txt = delta.content || "";
                    if (txt) {
                      lastActivity = Date.now();
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
                    for (const [_, t] of tools)
                      if (t.started && !t.closed) {
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: t.blockIndex,
                        });
                        t.closed = true;
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
