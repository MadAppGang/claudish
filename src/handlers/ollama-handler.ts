import type { Context } from "hono";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelHandler } from "./types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager } from "../middleware/index.js";
import { transformOpenAIToClaude } from "../transform.js";
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
  private CLAUDE_INTERNAL_CONTEXT_MAX = 200000;

  constructor(targetModel: string, apiKey: string | undefined, port: number) {
    this.targetModel = this.normalizeModelName(targetModel);
    this.apiKey = apiKey;
    this.port = port;
    this.adapterManager = new AdapterManager(this.targetModel);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.initialize().catch(err => log(`[Handler:${this.targetModel}] Middleware init error: ${err}`));
  }

  // Normalizar nombre de modelo (adaptado de ollama-client-lib)
  private normalizeModelName(model: string): string {
    // OllamaCloud maneja -cloud internamente, pero lo mantenemos por consistencia
    if (!model.endsWith("-cloud") && !model.includes(":cloud")) {
      if (model.includes(":")) {
        const [base, version] = model.split(":");
        return `${base}:${version}-cloud`;
      }
      return `${model}-cloud`;
    }
    return model;
  }

  // Transformar petición OpenAI → Ollama
  private transformToOllamaFormat(openAIPayload: any): any {
    return {
      model: this.normalizeModelName(openAIPayload.model),
      messages: openAIPayload.messages,
      stream: true,
      options: {
        temperature: openAIPayload.temperature ?? 0.7,
        num_ctx: openAIPayload.max_tokens || 4096,
        num_predict: openAIPayload.max_tokens
      }
    };
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
    const messages = this.convertMessages(claudeRequest);

    // OllamaCloud no soporta tools en formato /api/chat
    // Mostrar warning si se intentan usar tools
    if (claudeRequest.tools && claudeRequest.tools.length > 0) {
      log(`[OllamaCloud] Warning: Tools not supported by OllamaCloud, ignoring ${claudeRequest.tools.length} tool(s)`);
    }

    // Transformar a formato Ollama
    const ollamaPayload = this.transformToOllamaFormat({
      model: target,
      messages: messages,
      temperature: claudeRequest.temperature ?? 1,
      max_tokens: claudeRequest.max_tokens
    });

    await this.middlewareManager.beforeRequest({ modelId: target, messages, tools: [], stream: true });

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

    return this.handleStreamingResponse(c, response, adapter, target, claudeRequest);
  }

  private convertMessages(req: any): any[] {
    const messages: any[] = [];
    if (req.system) {
      let content: string;
      if (Array.isArray(req.system)) {
        content = req.system.map((i: any) => {
          if (typeof i === "string") return i;
          if (i?.text) return i.text;
          if (i?.content) return typeof i.content === "string" ? i.content : JSON.stringify(i.content);
          return JSON.stringify(i);
        }).filter(Boolean).join("\n\n");
      } else {
        content = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
      }
      content = this.filterIdentity(content);
      messages.push({ role: "system", content });
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
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text || "");
        } else if (block.type === "image") {
          // OllamaCloud doesn't support images in /api/chat, skip or add note
          textParts.push("[Image not supported by OllamaCloud]");
        }
        // Tool results are not supported by OllamaCloud, skip them
      }
      // OllamaCloud expects content as a string, not an array
      const contentString = textParts.filter(Boolean).join("\n\n");
      if (contentString) {
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
      for (const block of msg.content) {
        if (block.type === "text") {
          strings.push(block.text || "");
        }
        // Tool calls are not supported by OllamaCloud, skip them
      }
      // OllamaCloud expects content as a string, not an array
      const contentString = strings.filter(Boolean).join(" ");
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

  // Transformar streaming Ollama (línea por línea) → SSE (formato OpenAI/Claude)
  private handleStreamingResponse(c: Context, response: Response, adapter: any, target: string, request: any): Response {
    let isClosed = false;
    let ping: NodeJS.Timeout | null = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const middlewareManager = this.middlewareManager;
    const streamMetadata = new Map<string, any>();
    const handler = this; // Capturar referencia para usar en closure

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

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;

              try {
                // Ollama devuelve JSON línea por línea (no SSE)
                const chunk = JSON.parse(line);

                // Transformar formato Ollama → OpenAI SSE
                if (chunk.message?.content) {
                  lastActivity = Date.now();

                  if (!textStarted) {
                    textIdx = curIdx++;
                    send("content_block_start", {
                      type: "content_block_start",
                      index: textIdx,
                      content_block: { type: "text", text: "" }
                    });
                    textStarted = true;
                  }

                  // Procesar con adapter si está disponible
                  const res = adapter.processTextContent ? adapter.processTextContent(chunk.message.content, "") : { cleanedText: chunk.message.content };
                  if (res.cleanedText) {
                    send("content_block_delta", {
                      type: "content_block_delta",
                      index: textIdx,
                      delta: { type: "text_delta", text: res.cleanedText }
                    });
                  }
                }

                // Ollama marca done cuando termina y puede incluir información de tokens
                if (chunk.done) {
                  // OllamaCloud puede devolver tokens en la respuesta final
                  if (chunk.prompt_eval_count !== undefined) {
                    cumulativeInputTokens += chunk.prompt_eval_count;
                  }
                  if (chunk.eval_count !== undefined) {
                    cumulativeOutputTokens += chunk.eval_count;
                  }
                  
                  // Escribir archivo de tokens para la línea de estado
                  if (cumulativeInputTokens > 0 || cumulativeOutputTokens > 0) {
                    handler.writeTokenFile(cumulativeInputTokens, cumulativeOutputTokens);
                  }
                  
                  await finalize("done");
                  return;
                }
              } catch (e) {
                // Ignorar líneas inválidas
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


