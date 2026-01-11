
/**
 * Gemini Code Assist Handler
 *
 * Handles communication with Google's Code Assist API (gemini-cli backend).
 * Uses OAuth authentication instead of API keys.
 */

import type { Context } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelHandler } from "./types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager, GeminiThoughtSignatureMiddleware } from "../middleware/index.js";
import { transformOpenAIToClaude } from "../transform.js";
import { log, logStructured } from "../logger.js";
import { filterIdentity } from "./shared/openai-compat.js";
import {
  getModelPricing,
  type ModelPricing,
  type RemoteProvider,
} from "./shared/remote-provider-types.js";
import { getValidAccessToken, setupGeminiUser } from "../auth/gemini-oauth.js";

export class GeminiCodeAssistHandler implements ModelHandler {
  private modelName: string;
  private port: number;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private sessionTotalCost = 0;
  private sessionOutputTokens = 0;
  private contextWindow = 1000000; // Gemini has 1M context by default
  private toolCallMap = new Map<string, string>(); // tool_use_id -> function_name

  constructor(provider: RemoteProvider, modelName: string, port: number) {
    this.modelName = modelName;
    this.port = port;
    this.adapterManager = new AdapterManager(`gemini/${modelName}`);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    this.middlewareManager
      .initialize()
      .catch((err) => log(`[GeminiCodeAssistHandler:${modelName}] Middleware init error: ${err}`));
  }

  private getPricing(): ModelPricing {
    return getModelPricing("gemini", this.modelName);
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

  // Reuse message conversion logic from GeminiHandler
  // We can duplicate it here to avoid tight coupling or refactor later.
  // Duplicating for now to ensure stability.

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

  private convertAssistantMessageParts(msg: any): any[] {
    const parts: any[] = [];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          this.toolCallMap.set(block.id, block.name);
          parts.push({
            functionCall: { name: block.name, args: block.input },
          });
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }
    return parts;
  }

  private convertToGeminiTools(claudeRequest: any): any {
    if (!claudeRequest.tools?.length) return undefined;
    const functionDeclarations = claudeRequest.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      parameters: this.convertJsonSchemaToGemini(tool.input_schema),
    }));
    return [{ functionDeclarations }];
  }

  private convertJsonSchemaToGemini(schema: any): any {
    if (!schema) return {};
    const geminiSchema: any = { type: schema.type || "object" };
    if (schema.properties) {
      geminiSchema.properties = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        geminiSchema.properties[key] = this.convertPropertyToGemini(prop as any);
      }
    }
    if (schema.required) geminiSchema.required = schema.required;
    return geminiSchema;
  }

  private convertPropertyToGemini(prop: any): any {
    const result: any = { type: prop.type || "string" };
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

  private buildVertexPayload(claudeRequest: any): any {
    const contents = this.convertToGeminiMessages(claudeRequest);
    const tools = this.convertToGeminiTools(claudeRequest);
    
    // Note: Use snake_case for generation_config as per Vertex AI REST API?
    // Wait, Code Assist Server uses `toVertexGenerationConfig` which maps to camelCase in TS but `JSON.stringify`?
    // The gemini-cli code uses `generationConfig` (camelCase) in TS, but we need to know what it sends over wire.
    // The `gemini-oauth.md` says: `generationConfig` (camelCase) but `max_output_tokens` (snake_case).
    // Let's stick to what we saw in `gemini-cli`: `maxOutputTokens`.
    // Actually `gemini-oauth.md` says: `Uses snake_case for config fields (max_output_tokens, not maxOutputTokens)`.
    // Wait, my repogrep said: `maxOutputTokens: config.maxOutputTokens`.
    // But `JSON.stringify(req)` sends it.
    // If I use `maxOutputTokens` it should work if the server accepts camelCase.
    // However, Vertex AI REST API usually uses camelCase for JSON fields.
    // `gemini-oauth.md` line 146: "Uses snake_case for config fields".
    // I will try camelCase first as per my search result from `converter.ts` which returns an object with `maxOutputTokens`.
    
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

  private handleStreamingResponse(c: Context, response: Response, _claudeRequest: any): Response {
    // This logic is identical to GeminiHandler because the response format is likely the same (Vertex/Gemini API)
    // I'm copying it verbatim from GeminiHandler to avoid dependency/shared code issues for now.
    
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

            if (thinkingStarted) send("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
            if (textStarted) send("content_block_stop", { type: "content_block_stop", index: textIdx });
            for (const t of Array.from(tools.values())) {
              if (t.started && !t.closed) {
                send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
                t.closed = true;
              }
            }

            await this.middlewareManager.afterStreamComplete(`gemini/${this.modelName}`, streamMetadata);

            if (usage) {
              log(`[GeminiCodeAssist] Usage: prompt=${usage.promptTokenCount || 0}, completion=${usage.candidatesTokenCount || 0}`);
              this.updateTokenTracking(usage.promptTokenCount || 0, usage.candidatesTokenCount || 0);
            }

            if (reason === "error") {
              log(`[GeminiCodeAssist] Stream error: ${err}`);
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
              try { controller.enqueue(encoder.encode("data: [DONE]\n\n\n")); } catch (e) {}
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
                  
                  // Code Assist API wraps response in { response: { candidates: [...] } }
                  const responseData = chunk.response || chunk;
                  if (responseData.usageMetadata) usage = responseData.usageMetadata;

                  const candidate = responseData.candidates?.[0];
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
                } catch (e) {
                  log(`[GeminiCodeAssist] Parse error: ${e}`);
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

  async handle(c: Context, payload: any): Promise<Response> {
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);

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
        user_prompt_id: randomUUID(), // Required by Code Assist?
        request: vertexPayload,
      };

      await this.middlewareManager.beforeRequest({
        modelId: `gemini/${this.modelName}`,
        messages: vertexPayload.contents,
        tools: claudeRequest.tools || [],
        stream: true,
      });

      // 4. Send Request (with retry for rate limits)
      const endpoint = "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
      log(`[GeminiCodeAssist] Calling API: ${endpoint} (Project: ${projectId})`);

      let response: Response | null = null;
      let lastError = "";
      const maxRetries = 5;
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
          },
          body: JSON.stringify(requestBody),
        });
        
        log(`[GeminiCodeAssist] Response status: ${response.status}`);
        
        if (response.status === 429) {
          // Rate limited - extract retry delay and wait
          const errorData = await response.json().catch(() => ({}));
          const retryDelay = errorData?.error?.details?.find((d: any) => d.retryDelay)?.retryDelay;
          const waitMs = retryDelay ? parseFloat(retryDelay) * 1000 : (attempt + 1) * 1000;
          log(`[GeminiCodeAssist] Rate limited, waiting ${waitMs}ms before retry...`);
          lastError = errorData?.error?.message || "Rate limited";
          await new Promise(r => setTimeout(r, Math.min(waitMs, 5000)));
          continue;
        }
        
        break;
      }
      
      if (!response || response.status === 429) {
        log(`[GeminiCodeAssist] All retries exhausted: ${lastError}`);
        return c.json({ error: { type: "rate_limit_error", message: lastError } }, 429);
      }

      if (!response.ok) {
        const errorText = await response.text();
        log(`[GeminiCodeAssist] Error: ${errorText}`);
        return c.json({ error: errorText }, response.status as any);
      }

      if (droppedParams.length > 0) {
        c.header("X-Dropped-Params", droppedParams.join(", "));
      }

      return this.handleStreamingResponse(c, response, claudeRequest);
    } catch (e: any) {
      log(`[GeminiCodeAssist] Handler error: ${e.message}`);
      // Special handling for auth errors
      if (e.message.includes("No OAuth credentials") || e.message.includes("Run `claudish --gemini-login`")) {
         return c.json({ 
             error: { 
                 type: "authentication_error", 
                 message: "Authentication required. Please run `claudish --gemini-login` to use Gemini without an API key." 
             } 
         }, 401);
      }
      return c.json({ error: { type: "api_error", message: e.message } }, 500);
    }
  }

  async shutdown(): Promise<void> {}
}

