/**
 * OllamaCloud Handler
 *
 * Handles requests to OllamaCloud API (https://ollama.com/api/chat)
 * Uses Ollama's native format (NOT OpenAI format):
 * - Request: {"model": "gpt-oss:20b", "messages": [...], "stream": true}
 * - Response: Line-by-line JSON (NOT SSE format)
 * - Final chunk: {"done": true, "prompt_eval_count": N, "eval_count": M}
 */

import type { Context } from "hono";
import type { ModelHandler } from "./types.js";
import type { RemoteProvider } from "./shared/remote-provider-types.js";
import { log, logStructured } from "../logger.js";
import { transformOpenAIToClaude } from "../transform.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { calculateCost } from "./shared/remote-provider-types.js";

export class OllamaCloudHandler implements ModelHandler {
  private provider: RemoteProvider;
  private modelName: string;
  private apiKey: string;
  private port: number;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;

  constructor(provider: RemoteProvider, modelName: string, apiKey: string, port: number) {
    this.provider = provider;
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.port = port;
    this.writeTokenFile(0, 0);
  }

  /**
   * Convert Claude messages to simple string format for OllamaCloud
   * Similar to simpleFormat in openai-compat.ts
   */
  private convertMessagesToOllama(claudeRequest: any): any[] {
    const messages: any[] = [];

    // System message
    if (claudeRequest.system) {
      const content = Array.isArray(claudeRequest.system)
        ? claudeRequest.system.map((i: any) => i.text || i).join("\n\n")
        : claudeRequest.system;
      messages.push({ role: "system", content });
    }

    // User and assistant messages
    if (claudeRequest.messages) {
      for (const msg of claudeRequest.messages) {
        if (msg.role === "user") {
          messages.push(this.processUserMessage(msg));
        } else if (msg.role === "assistant") {
          messages.push(this.processAssistantMessage(msg));
        }
      }
    }

    return messages;
  }

  private processUserMessage(msg: any): any {
    if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          const resultContent =
            typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          textParts.push(`[Tool Result]: ${resultContent}`);
        }
        // Skip images - OllamaCloud doesn't support vision
      }
      return { role: "user", content: textParts.join("\n\n") };
    } else {
      return { role: "user", content: msg.content };
    }
  }

  private processAssistantMessage(msg: any): any {
    if (Array.isArray(msg.content)) {
      const strings: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          strings.push(block.text);
        } else if (block.type === "tool_use") {
          strings.push(`[Tool Call: ${block.name}]: ${JSON.stringify(block.input)}`);
        }
      }
      return { role: "assistant", content: strings.join("\n") };
    } else {
      return { role: "assistant", content: msg.content };
    }
  }

  /**
   * Write token tracking file for status line
   */
  private writeTokenFile(input: number, output: number): void {
    try {
      this.sessionInputTokens += input;
      this.sessionOutputTokens += output;
      const sessionTotal = this.sessionInputTokens + this.sessionOutputTokens;
      const cost = calculateCost(
        this.provider.name,
        this.modelName,
        this.sessionInputTokens,
        this.sessionOutputTokens
      );

      // Strip provider prefix from model name for cleaner display
      const displayModelName = this.modelName.replace(/^(go|g|gemini|v|vertex|oai|mmax|mm|kimi|moonshot|glm|zhipu|oc|ollama|lmstudio|vllm|mlx)[\/:]/, '');

      const data = {
        input_tokens: this.sessionInputTokens,
        output_tokens: this.sessionOutputTokens,
        total_tokens: sessionTotal,
        total_cost: cost,
        context_window: 0,
        context_left_percent: 100,
        provider_name: "OllamaCloud",
        model_name: displayModelName,
        updated_at: Date.now(),
      };

      const claudishDir = join(homedir(), ".claudish");
      mkdirSync(claudishDir, { recursive: true });
      writeFileSync(join(claudishDir, `tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
    } catch (e) {
      // Ignore write errors
    }
  }

  async handle(c: Context, payload: any): Promise<Response> {
    logStructured(`OllamaCloud Request`, {
      provider: this.provider.name,
      targetModel: this.modelName,
      originalModel: payload.model,
      baseUrl: this.provider.baseUrl,
    });

    // Transform request
    const { claudeRequest } = transformOpenAIToClaude(payload);
    const messages = this.convertMessagesToOllama(claudeRequest);

    // Build OllamaCloud payload (Ollama native format)
    const ollamaPayload = {
      model: this.modelName,
      messages,
      stream: true,
    };

    // Make request to OllamaCloud
    const apiUrl = `${this.provider.baseUrl}${this.provider.apiPath}`;
    log(`[OllamaCloud] Request: ${messages.length} messages`);
    log(`[OllamaCloud] Endpoint: ${apiUrl}`);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(ollamaPayload),
      });

      log(`[OllamaCloud] Response status: ${response.status}`);
      if (!response.ok) {
        const errorBody = await response.text();
        log(`[OllamaCloud] ERROR: ${errorBody.slice(0, 200)}`);
        return this.handleErrorResponse(c, response.status, errorBody);
      }

      log(`[OllamaCloud] Response OK, proceeding to streaming...`);
      return this.handleStreamingResponse(c, response);
    } catch (error: any) {
      log(`[OllamaCloud] Error: ${error.message}`);
      return this.errorResponse(c, "api_error", error.message);
    }
  }

  /**
   * Handle streaming response from OllamaCloud
   * Converts Ollama line-by-line JSON format to Claude SSE format
   */
  private handleStreamingResponse(c: Context, response: Response): Response {
    log(`[OllamaCloud] ===== STREAMING STARTED =====`);
    let isClosed = false;
    let ping: NodeJS.Timeout | null = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const self = this; // Capture context for use inside ReadableStream

    return c.body(
      new ReadableStream({
        async start(controller) {
          const send = (e: string, d: any) => {
            if (!isClosed) {
              controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
            }
          };

          const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          let textStarted = false;
          let textIdx = 0;
          let accumulatedText = "";
          let promptTokens = 0;
          let completionTokens = 0;
          let lastActivity = Date.now();

          // Send initial message_start event
          send("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: self.modelName,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 1 },
            },
          });
          send("ping", { type: "ping" });

          // Keepalive ping
          ping = setInterval(() => {
            if (!isClosed && Date.now() - lastActivity > 1000) {
              send("ping", { type: "ping" });
            }
          }, 1000);

          const finalize = (reason: string, err?: string) => {
            if (isClosed) return;

            // Close any open text block
            if (textStarted) {
              send("content_block_stop", { type: "content_block_stop", index: textIdx });
            }

            if (reason === "error") {
              send("error", { type: "error", error: { type: "api_error", message: err } });
            } else {
              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: completionTokens },
              });
              send("message_stop", { type: "message_stop" });
            }

            // Update token counts
            self.writeTokenFile(promptTokens, completionTokens);

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
                if (!line.trim()) continue;

                try {
                  const chunk = JSON.parse(line);

                  // Check for completion
                  if (chunk.done) {
                    log(`[OllamaCloud] Stream done`);
                    // Extract token counts from final chunk
                    if (chunk.prompt_eval_count) {
                      promptTokens = chunk.prompt_eval_count;
                    }
                    if (chunk.eval_count) {
                      completionTokens = chunk.eval_count;
                    }
                    log(
                      `[OllamaCloud] Final tokens: prompt=${promptTokens}, completion=${completionTokens}`
                    );
                    finalize("done");
                    return;
                  }

                  // Extract text content from message
                  const content = chunk.message?.content || "";
                  if (content) {
                    lastActivity = Date.now();
                    accumulatedText += content;
                    log(
                      `[OllamaCloud] Text chunk: "${content.substring(0, 30).replace(/\n/g, "\\n")}" (${content.length} chars)`
                    );

                    // Start text block if not already started
                    if (!textStarted) {
                      send("content_block_start", {
                        type: "content_block_start",
                        index: textIdx,
                        content_block: { type: "text", text: "" },
                      });
                      textStarted = true;
                      log(`[OllamaCloud] Started text block at index ${textIdx}`);
                    }

                    // Send text delta
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: textIdx,
                      delta: { type: "text_delta", text: content },
                    });
                  }
                } catch (e) {
                  log(`[OllamaCloud] Failed to parse chunk: ${line.slice(0, 100)}`);
                }
              }
            }

            finalize("unexpected");
          } catch (error: any) {
            log(`[OllamaCloud] Stream error: ${error.message}`);
            finalize("error", error.message);
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

  private handleErrorResponse(c: Context, status: number, errorBody: string): Response {
    try {
      const parsed = JSON.parse(errorBody);
      const errorMsg = parsed.error?.message || parsed.error || errorBody;
      return this.errorResponse(c, "api_error", errorMsg, status);
    } catch {
      return this.errorResponse(c, "api_error", errorBody, status);
    }
  }

  private errorResponse(c: Context, type: string, message: string, status: number = 503): Response {
    return c.json(
      {
        error: {
          type,
          message,
        },
      },
      status as any
    );
  }

  async shutdown(): Promise<void> {}
}
