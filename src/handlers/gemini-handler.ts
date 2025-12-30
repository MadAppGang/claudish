/**
 * Gemini Handler
 *
 * Handles direct requests to Google's Gemini API using GOOGLE_API_KEY.
 * Transforms between Claude format and Gemini's native format.
 */

import type { Context } from "hono";
import type { ModelHandler } from "./types.js";
import { transformClaudeToGemini, transformGeminiChunkToClaude } from "../transform.js";
import { log, logStructured } from "../logger.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiHandler implements ModelHandler {
  private targetModel: string;
  private apiKey: string;
  private port: number;
  private sessionTotalCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private CLAUDE_INTERNAL_CONTEXT_MAX = 200000;
  private contextWindow = 200000; // Default Gemini context (will be model-specific)

  constructor(targetModel: string, apiKey: string, port: number) {
    this.targetModel = targetModel;
    this.apiKey = apiKey;
    this.port = port;

    // Set context window based on model
    if (targetModel.includes("gemini-2.5")) {
      this.contextWindow = 200000;
    } else if (targetModel.includes("gemini-2.0")) {
      this.contextWindow = 128000;
    } else if (targetModel.includes("gemini-1.5")) {
      this.contextWindow = 128000;
    }

    // Write initial token file
    this.writeTokenFile(0, 0);
  }

  private writeTokenFile(input: number, output: number) {
    try {
      const total = input + output;
      const limit = this.contextWindow;
      const leftPct =
        limit > 0
          ? Math.max(0, Math.min(100, Math.round(((limit - total) / limit) * 100)))
          : 100;
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
    } catch (e) {
      // Ignore write errors
    }
  }

  async handle(c: Context, payload: any): Promise<Response> {
    logStructured(`Gemini Request`, {
      targetModel: this.targetModel,
      originalModel: payload.model,
    });

    // Transform Claude format to Gemini format
    const { geminiPayload, claudeRequest } = transformClaudeToGemini(payload, this.targetModel);

    // Build Gemini API URL
    const endpoint = `${GEMINI_BASE_URL}/models/${this.targetModel}:streamGenerateContent`;
    const url = `${endpoint}?alt=sse`;

    log(`[Gemini] Requesting: ${url}`);

    // Make request to Gemini API
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey, // Gemini uses x-goog-api-key, not Authorization
        "Content-Type": "application/json",
      },
      body: JSON.stringify(geminiPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`[Gemini] Error: ${response.status} ${errorText}`);
      return c.json(
        {
          error: {
            type: "api_error",
            message: `Gemini API error: ${errorText}`,
          },
        },
        response.status as any
      );
    }

    // Stream the response back in Claude format
    return this.handleStreamingResponse(c, response, claudeRequest);
  }

  private handleStreamingResponse(
    c: Context,
    response: Response,
    claudeRequest: any
  ): Response {
    let isClosed = false;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const self = this;

    return c.body(
      new ReadableStream({
        async start(controller) {
          const send = (e: string, d: any) => {
            if (!isClosed) {
              controller.enqueue(encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
            }
          };

          const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          // State tracking
          let usage: any = null;
          let finalized = false;
          let textStarted = false;
          let textIdx = -1;
          let curIdx = 0;
          const tools = new Map<number, any>();
          let accumulatedText = "";

          // Send message_start
          send("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: self.targetModel,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 1 },
            },
          });

          try {
            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");

            let buffer = "";

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim() || line.startsWith(":")) continue;

                // Parse SSE format: "data: {...}"
                if (line.startsWith("data: ")) {
                  const jsonStr = line.slice(6);
                  if (jsonStr.trim() === "[DONE]") continue;

                  try {
                    const chunk = JSON.parse(jsonStr);

                    // Gemini streaming format:
                    // { candidates: [{ content: { parts: [{ text: "..." }] } }], usageMetadata: {...} }

                    const candidate = chunk.candidates?.[0];
                    if (!candidate) continue;

                    const parts = candidate.content?.parts || [];

                    for (const part of parts) {
                      // Handle text content
                      if (part.text) {
                        if (!textStarted) {
                          textStarted = true;
                          textIdx = curIdx++;
                          send("content_block_start", {
                            type: "content_block_start",
                            index: textIdx,
                            content_block: { type: "text", text: "" },
                          });
                        }

                        accumulatedText += part.text;

                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: textIdx,
                          delta: { type: "text_delta", text: part.text },
                        });
                      }

                      // Handle function calls (Gemini format)
                      if (part.functionCall) {
                        const { name, args } = part.functionCall;
                        const thought_signature = part.thoughtSignature;

                        // Encode thought_signature in tool ID for round-trip preservation
                        // Format: toolu_<random>__ts_<urlencoded_thought_signature>
                        // IMPORTANT: thought_signature must be preserved exactly as received
                        let toolId = `toolu_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                        if (thought_signature) {
                          const sigEncoded = encodeURIComponent(thought_signature);
                          toolId = `${toolId}__ts_${sigEncoded}`;
                        }

                        const toolIdx = curIdx++;

                        // Start tool use block
                        send("content_block_start", {
                          type: "content_block_start",
                          index: toolIdx,
                          content_block: {
                            type: "tool_use",
                            id: toolId,
                            name: name,
                          },
                        });

                        // Send tool input
                        send("content_block_delta", {
                          type: "content_block_delta",
                          index: toolIdx,
                          delta: {
                            type: "input_json_delta",
                            partial_json: JSON.stringify(args),
                          },
                        });

                        // Stop tool use block
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: toolIdx,
                        });

                        tools.set(toolIdx, { id: toolId, name, args, thought_signature });
                      }
                    }

                    // Track usage
                    if (chunk.usageMetadata) {
                      usage = {
                        input_tokens: chunk.usageMetadata.promptTokenCount || 0,
                        output_tokens: chunk.usageMetadata.candidatesTokenCount || 0,
                      };
                    }

                    // Check for finish reason
                    if (candidate.finishReason && !finalized) {
                      finalized = true;

                      // Stop any open content blocks
                      if (textStarted) {
                        send("content_block_stop", {
                          type: "content_block_stop",
                          index: textIdx,
                        });
                      }

                      // Map finish reason
                      let stopReason: string | null = null;
                      if (candidate.finishReason === "STOP") stopReason = "end_turn";
                      else if (candidate.finishReason === "MAX_TOKENS")
                        stopReason = "max_tokens";

                      // Send message_delta
                      send("message_delta", {
                        type: "message_delta",
                        delta: { stop_reason: stopReason, stop_sequence: null },
                        usage: usage || { output_tokens: 0 },
                      });
                    }
                  } catch (e) {
                    log(`[Gemini] Chunk parse error: ${e}`);
                  }
                }
              }
            }

            // If not finalized, send final events
            if (!finalized) {
              if (textStarted) {
                send("content_block_stop", {
                  type: "content_block_stop",
                  index: textIdx,
                });
              }
              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: usage || { output_tokens: 0 },
              });
            }

            // Send message_stop
            send("message_stop", { type: "message_stop" });

            // Update token tracking
            if (usage) {
              self.sessionInputTokens = usage.input_tokens;
              self.sessionOutputTokens += usage.output_tokens;
              self.writeTokenFile(self.sessionInputTokens, self.sessionOutputTokens);

              // Calculate cost (example rates - update based on actual Gemini pricing)
              const inputCost = (usage.input_tokens / 1_000_000) * 0.15; // $0.15 per 1M input tokens
              const outputCost = (usage.output_tokens / 1_000_000) * 0.60; // $0.60 per 1M output tokens
              self.sessionTotalCost += inputCost + outputCost;
            }

            controller.close();
            isClosed = true;
          } catch (err) {
            log(`[Gemini] Stream error: ${err}`);
            if (!isClosed) {
              send("error", {
                type: "error",
                error: {
                  type: "api_error",
                  message: String(err),
                },
              });
              controller.close();
              isClosed = true;
            }
          }
        },

        cancel() {
          isClosed = true;
        },
      })
    );
  }

  async shutdown(): Promise<void> {
    log(`[Gemini:${this.targetModel}] Shutting down`);
  }
}
