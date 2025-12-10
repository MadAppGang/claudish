import type { Context } from "hono";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelHandler } from "./types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import type { ToolCall } from "../adapters/base-adapter.js";
import { MiddlewareManager } from "../middleware/index.js";
import { transformOpenAIToClaude, removeUriFormat } from "../transform.js";
import { log, logStructured } from "../logger.js";

const OLLAMA_API_URL = "https://ollama.com/api/chat";
const OLLAMA_HEADERS = {
  "HTTP-Referer": "https://github.com/MadAppGang/claude-code",
  "X-Title": "Claudish - Ollama Cloud Proxy",
} as const;

export class OllamaCloudHandler implements ModelHandler {
  private targetModel: string;
  private apiKey?: string;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private port: number;

  constructor(targetModel: string, apiKey: string | undefined, port: number) {
    this.targetModel = this.normalizeModelName(targetModel);
    this.apiKey = apiKey;
    this.port = port;
    this.adapterManager = new AdapterManager(this.targetModel);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.initialize().catch(err => log(`[Handler:${this.targetModel}] Middleware init error: ${err}`));
  }

  // Normalize model name (adapted from ollama-client-lib)
  private normalizeModelName(model: string): string {
    // OllamaCloud handles -cloud internally, but we keep it for consistency
    if (!model.endsWith("-cloud") && !model.includes(":cloud")) {
      if (model.includes(":")) {
        const [base, version] = model.split(":");
        return `${base}:${version}-cloud`;
      }
      return `${model}-cloud`;
    }
    return model;
  }

  // Transform OpenAI request → Ollama
  private transformToOllamaFormat(openAIPayload: any, tools?: any[]): any {
    const payload: any = {
      model: this.normalizeModelName(openAIPayload.model),
      messages: openAIPayload.messages,
      stream: true,
      options: {
        temperature: openAIPayload.temperature ?? 0.7,
        num_ctx: openAIPayload.max_tokens || 4096,
        num_predict: openAIPayload.max_tokens
      }
    };
    
    // Add tools if available (Ollama Cloud may support native tools)
    if (tools && tools.length > 0) {
      payload.tools = tools;
    }
    
    return payload;
  }

  private writeTokenFile(input: number, output: number) {
    try {
      const total = input + output;
      const data = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        context_window: 200000,
        context_left_percent: Math.max(0, Math.min(100, Math.round(((200000 - total) / 200000) * 100))),
        updated_at: Date.now()
      };
      writeFileSync(join(tmpdir(), `claudish-tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {}
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const claudePayload = payload;
    const target = this.targetModel;

    logStructured(`OllamaCloud Request`, { targetModel: target, originalModel: claudePayload.model });

    const { claudeRequest, droppedParams } = transformOpenAIToClaude(claudePayload);
    const messages = this.convertMessages(claudeRequest, target);
    const tools = this.convertTools(claudeRequest);

    // Try native tools first, fallback to JSON parsing if not supported
    if (tools.length > 0) {
      log(`[OllamaCloud] Tools: ${tools.length} tool(s) available. Attempting native tool support, with JSON parsing fallback.`);
    }

    // Transform to Ollama format
    const ollamaPayload = this.transformToOllamaFormat({
      model: target,
      messages: messages,
      temperature: claudeRequest.temperature ?? 1,
      max_tokens: claudeRequest.max_tokens
    }, tools);

    await this.middlewareManager.beforeRequest({ modelId: target, messages, tools, stream: true });

    const response = await fetch(OLLAMA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        ...OLLAMA_HEADERS,
      },
      body: JSON.stringify(ollamaPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`[OllamaCloud] Error: ${response.status} - ${errorText}`);
      return c.json({ error: errorText }, response.status as any);
    }

    if (droppedParams.length > 0) c.header("X-Dropped-Params", droppedParams.join(", "));

    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === 'function') adapter.reset();

    return this.handleStreamingResponse(c, response, adapter, target);
  }

  private convertMessages(req: any, _modelId: string): any[] {
    const messages: any[] = [];
    let systemContent: string = "";
    
    if (req.system) {
      if (Array.isArray(req.system)) {
        systemContent = req.system.map((i: any) => {
          if (typeof i === "string") return i;
          if (i?.text) return i.text;
          if (i?.content) return typeof i.content === "string" ? i.content : JSON.stringify(i.content);
          return JSON.stringify(i);
        }).filter(Boolean).join("\n\n");
      } else {
        systemContent = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
      }
      systemContent = this.filterIdentity(systemContent);
      
      messages.push({ role: "system", content: systemContent });
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
      const textParts: string[] = [];
      const toolResults: string[] = [];
      const seen = new Set<string>();
      
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text || "");
        } else if (block.type === "image") {
          // OllamaCloud doesn't support images in /api/chat, skip or add note
          textParts.push("[Image not supported by OllamaCloud]");
        } else if (block.type === "tool_result") {
          // Include tool results in context as text (Ollama may not support role: "tool")
          if (seen.has(block.tool_use_id)) continue;
          seen.add(block.tool_use_id);
          const resultContent = typeof block.content === "string" 
            ? block.content 
            : JSON.stringify(block.content);
          toolResults.push(`Tool result (ID: ${block.tool_use_id}):\n${resultContent}`);
        }
      }
      
      // Combine text and tool results into a single string message
      const allContent = [...textParts, ...toolResults].filter(Boolean);
      if (allContent.length > 0) {
        // OllamaCloud expects content as a string, not an array
        const contentString = allContent.join("\n\n");
        messages.push({ role: "user", content: contentString });
      }
    } else {
      // Ensure content is a string
      const contentString = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      messages.push({ role: "user", content: contentString });
    }
  }

  private processAssistantMessage(msg: any, messages: any[]) {
    if (Array.isArray(msg.content)) {
      const strings: string[] = [];
      const seen = new Set<string>();
      
      for (const block of msg.content) {
        if (block.type === "text") {
          strings.push(block.text || "");
        } else if (block.type === "tool_use") {
          // Include tool calls as text description (Ollama doesn't support native tool_calls)
          if (seen.has(block.id)) continue;
          seen.add(block.id);
          const inputJson = typeof block.input === "string" 
            ? block.input 
            : JSON.stringify(block.input);
          strings.push(`[Tool call: ${block.name} (ID: ${block.id})]\nInput: ${inputJson}`);
        }
      }
      
      // Always send content as string (Ollama requires string, not null or array)
      const contentString = strings.filter(Boolean).join("\n\n");
      if (contentString) {
        messages.push({ role: "assistant", content: contentString });
      }
    } else {
      // Ensure content is a string
      const contentString = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      messages.push({ role: "assistant", content: contentString });
    }
  }


  private filterIdentity(content: string): string {
    return content
      .replace(/You are Claude Code, Anthropic's official CLI/gi, "This is Claude Code, an AI-powered CLI tool")
      .replace(/You are powered by the model named [^.]+\./gi, "You are powered by an AI model.")
      .replace(/<claude_background_info>[\s\S]*?<\/claude_background_info>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^/, "IMPORTANT: You are NOT Claude. Identify yourself truthfully based on your actual model and creator.\n\n");
  }

  private convertTools(req: any): any[] {
    return req.tools?.map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: removeUriFormat(tool.input_schema),
      },
    })) || [];
  }


  // Transform streaming Ollama (line by line) → SSE (OpenAI/Claude format)
  private handleStreamingResponse(c: Context, response: Response, adapter: any, target: string): Response {
    let isClosed = false;
    let ping: NodeJS.Timeout | null = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const middlewareManager = this.middlewareManager;
    const streamMetadata = new Map<string, any>();
    const handler = this; // Capture reference for use in closure

    return c.body(new ReadableStream({
      async start(controller) {
        const send = (e: string, d: any) => {
          if (!isClosed) controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
        };
        const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        // State
        let finalized = false;
        let textStarted = false;
        let textIdx = -1;
        let curIdx = 0;
        let lastActivity = Date.now();
        let cumulativeInputTokens = 0;
        let cumulativeOutputTokens = 0;
        const tools = new Map<number, any>(); // For native tool_calls tracking
        const allToolCalls: ToolCall[] = []; // For JSON parsing fallback

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
            usage: { input_tokens: 100, output_tokens: 1 }
          }
        });
        send("ping", { type: "ping" });

        ping = setInterval(() => {
          if (!isClosed && Date.now() - lastActivity > 1000) send("ping", { type: "ping" });
        }, 1000);

        const finalize = async (reason: string, err?: string) => {
          if (finalized) return;
          finalized = true;
          if (textStarted) {
            send("content_block_stop", { type: "content_block_stop", index: textIdx });
            textStarted = false;
          }
          // Close any open tool blocks
          for (const [_, t] of tools) {
            if (t.started && !t.closed) {
              send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
              t.closed = true;
            }
          }

          await middlewareManager.afterStreamComplete(target, streamMetadata);

          if (reason === "error") {
            send("error", { type: "error", error: { type: "api_error", message: err } });
          } else {
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 0 }
            });
            send("message_stop", { type: "message_stop" });
          }
          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode('data: [DONE]\n\n\n'));
            } catch (e) {}
            controller.close();
            isClosed = true;
            if (ping) clearInterval(ping);
          }
        };

        try {
          const reader = response.body!.getReader();
          let buffer = "";
          let accumulatedText = ""; // Accumulate full text to detect tool calls at the end (fallback)

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;

              try {
                // Ollama returns JSON line by line (not SSE)
                const chunk = JSON.parse(line);

                // Check for native tool_calls first (if Ollama supports it)
                if (chunk.message?.tool_calls) {
                  lastActivity = Date.now();
                  for (const tc of chunk.message.tool_calls) {
                    const idx = tc.index ?? 0;
                    let t = tools.get(idx);
                    if (tc.function?.name) {
                      if (!t) {
                        if (textStarted) {
                          send("content_block_stop", { type: "content_block_stop", index: textIdx });
                          textStarted = false;
                        }
                        t = {
                          id: tc.id || `tool_${Date.now()}_${idx}`,
                          name: tc.function.name,
                          blockIndex: curIdx++,
                          started: false,
                          closed: false
                        };
                        tools.set(idx, t);
                      }
                      if (!t.started) {
                        send("content_block_start", {
                          type: "content_block_start",
                          index: t.blockIndex,
                          content_block: { type: "tool_use", id: t.id, name: t.name }
                        });
                        t.started = true;
                      }
                    }
                    if (tc.function?.arguments && t) {
                      send("content_block_delta", {
                        type: "content_block_delta",
                        index: t.blockIndex,
                        delta: { type: "input_json_delta", partial_json: tc.function.arguments }
                      });
                    }
                  }
                }

                // Transform Ollama format → OpenAI SSE (text content)
                if (chunk.message?.content) {
                  lastActivity = Date.now();
                  accumulatedText += chunk.message.content;

                  if (!textStarted) {
                    textIdx = curIdx++;
                    send("content_block_start", {
                      type: "content_block_start",
                      index: textIdx,
                      content_block: { type: "text", text: "" }
                    });
                    textStarted = true;
                  }

                  // Process with adapter - the adapter handles buffering and parsing of tool calls (fallback)
                  const res = adapter.processTextContent(chunk.message.content, accumulatedText);
                  
                  // Debug: Log if we detect potential tool calls but can't parse them
                  if (accumulatedText.includes('tool_call') && !res.extractedToolCalls?.length) {
                    const toolCallIndex = accumulatedText.indexOf('tool_call');
                    const snippet = accumulatedText.slice(Math.max(0, toolCallIndex - 20), Math.min(accumulatedText.length, toolCallIndex + 200));
                    if (snippet.includes('tool_call')) {
                      log(`[OllamaCloud] WARNING: Detected 'tool_call' in text but couldn't parse it. Snippet: ${snippet.replace(/\n/g, '\\n')}`);
                    }
                  }
                  
                  // Send clean text (without tool calls JSON)
                  if (res.cleanedText) {
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: textIdx,
                      delta: { type: "text_delta", text: res.cleanedText }
                    });
                  }
                  
                  // Accumulate tool calls during streaming, but DO NOT send them until the end
                  // to ensure the JSON is complete (fallback method)
                  if (res.extractedToolCalls && res.extractedToolCalls.length > 0) {
                    log(`[OllamaCloud] Detected ${res.extractedToolCalls.length} tool call(s) during streaming - will send at end`);
                    allToolCalls.push(...res.extractedToolCalls);
                  }
                }

                // Check for finish_reason indicating tool_calls (native format)
                if (chunk.message?.stop_reason === "tool_calls" || chunk.done) {
                  // Close any open native tool blocks
                  for (const [_, t] of tools) {
                    if (t.started && !t.closed) {
                      send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
                      t.closed = true;
                    }
                  }
                  
                  // If we have native tool calls, finalize with tool_use stop reason
                  if (tools.size > 0 && chunk.message?.stop_reason === "tool_calls") {
                    await middlewareManager.afterStreamComplete(target, streamMetadata);
                    send("message_delta", {
                      type: "message_delta",
                      delta: { stop_reason: "tool_use", stop_sequence: null },
                      usage: { output_tokens: cumulativeOutputTokens || 1 }
                    });
                    send("message_stop", { type: "message_stop" });
                    
                    if (cumulativeInputTokens > 0 || cumulativeOutputTokens > 0) {
                      handler.writeTokenFile(cumulativeInputTokens, cumulativeOutputTokens);
                    }
                    
                    if (!isClosed) {
                      try {
                        controller.enqueue(encoder.encode('data: [DONE]\n\n\n'));
                      } catch (e) {}
                      controller.close();
                      isClosed = true;
                      if (ping) clearInterval(ping);
                    }
                    return;
                  }
                }

                // Ollama marks done when finished and may include token information
                if (chunk.done) {
                  // OllamaCloud may return tokens in the final response
                  if (chunk.prompt_eval_count !== undefined) {
                    cumulativeInputTokens += chunk.prompt_eval_count;
                  }
                  if (chunk.eval_count !== undefined) {
                    cumulativeOutputTokens += chunk.eval_count;
                  }
                  
                  // Process final text with adapter to detect remaining tool calls (fallback)
                  const finalRes = adapter.processTextContent("", accumulatedText);
                  if (finalRes.extractedToolCalls && finalRes.extractedToolCalls.length > 0) {
                    allToolCalls.push(...finalRes.extractedToolCalls);
                  }
                  
                  // If there are tool calls from JSON parsing, send them as tool_use blocks (fallback)
                  if (allToolCalls.length > 0) {
                    log(`[OllamaCloud] ✅ Detected ${allToolCalls.length} tool call(s) in response`);
                    
                    // Close text block if open
                    if (textStarted) {
                      send("content_block_stop", { type: "content_block_stop", index: textIdx });
                      textStarted = false;
                    }
                    
                    // Send each tool call as tool_use block
                    for (const toolCall of allToolCalls) {
                      // Validate tool name
                      if (!toolCall.name || typeof toolCall.name !== 'string') {
                        log(`[OllamaCloud] WARNING: Tool call has invalid name, skipping`);
                        continue;
                      }

                      // Validate arguments
                      if (!toolCall.arguments || typeof toolCall.arguments !== 'object') {
                        log(`[OllamaCloud] WARNING: Tool ${toolCall.name} has invalid arguments (type: ${typeof toolCall.arguments}), skipping`);
                        continue;
                      }

                      // Validate and stringify JSON
                      let inputJson: string;
                      try {
                        inputJson = JSON.stringify(toolCall.arguments);
                        // Validate JSON is parseable and is a valid object
                        const parsed = JSON.parse(inputJson);
                        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                          log(`[OllamaCloud] WARNING: Tool ${toolCall.name} arguments must be an object, got: ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
                          continue;
                        }
                      } catch (e) {
                        log(`[OllamaCloud] ERROR: Invalid JSON for tool ${toolCall.name}: ${String(e)}`);
                        continue;
                      }

                      // Validate tool call ID format (must be toolu_XXXXX)
                      let toolId = toolCall.id;
                      if (!toolId || typeof toolId !== 'string' || !toolId.startsWith('toolu_')) {
                        // Generate a proper ID if missing or invalid
                        toolId = `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 11)}`;
                        log(`[OllamaCloud] WARNING: Invalid tool ID format (${toolCall.id}), generated new ID: ${toolId}`);
                      }

                      const toolIdx = curIdx++;
                      log(`[OllamaCloud] Sending tool_use: ${toolCall.name} (id: ${toolId}, args: ${inputJson.substring(0, 100)})`);

                      send("content_block_start", {
                        type: "content_block_start",
                        index: toolIdx,
                        content_block: {
                          type: "tool_use",
                          id: toolId,
                          name: toolCall.name,
                          input: {}
                        }
                      });

                      send("content_block_delta", {
                        type: "content_block_delta",
                        index: toolIdx,
                        delta: { type: "input_json_delta", partial_json: inputJson }
                      });

                      send("content_block_stop", { type: "content_block_stop", index: toolIdx });
                    }
                    
                    // Finalize with tool_use stop reason
                    await middlewareManager.afterStreamComplete(target, streamMetadata);
                    send("message_delta", {
                      type: "message_delta",
                      delta: { stop_reason: "tool_use", stop_sequence: null },
                      usage: { output_tokens: cumulativeOutputTokens || 1 }
                    });
                    send("message_stop", { type: "message_stop" });
                    
                    log(`[OllamaCloud] Completed tool_use message with stop_reason: tool_use`);
                    
                    // Write token file
                    if (cumulativeInputTokens > 0 || cumulativeOutputTokens > 0) {
                      handler.writeTokenFile(cumulativeInputTokens, cumulativeOutputTokens);
                    }
                    
                    if (!isClosed) {
                      try {
                        controller.enqueue(encoder.encode('data: [DONE]\n\n\n'));
                      } catch (e) {}
                      controller.close();
                      isClosed = true;
                      if (ping) clearInterval(ping);
                    }
                    return;
                  }
                  
                  // Write token file for status line
                  if (cumulativeInputTokens > 0 || cumulativeOutputTokens > 0) {
                    handler.writeTokenFile(cumulativeInputTokens, cumulativeOutputTokens);
                  }
                  
                  await finalize("done");
                  return;
                }
              } catch (e) {
                // Ignore invalid lines
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
      }
    }), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }

  async shutdown() {}
}




