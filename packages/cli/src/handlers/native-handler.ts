import type { Context } from "hono";
import type { ModelHandler } from "./types.js";
import { log, maskCredential } from "../logger.js";

export class NativeHandler implements ModelHandler {
  private apiKey?: string;
  private baseUrl: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
    // Always forward to real Anthropic API
    this.baseUrl = "https://api.anthropic.com";
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const originalHeaders = c.req.header();
    const target = payload.model;

    log("\n=== [NATIVE] Claude Code → Anthropic API Request ===");
    log(
      `[Native] x-api-key: ${originalHeaders["x-api-key"] ? maskCredential(originalHeaders["x-api-key"]) : "(not set)"}`
    );
    log(
      `[Native] authorization: ${originalHeaders["authorization"] ? maskCredential(originalHeaders["authorization"]) : "(not set)"}`
    );
    log(`Request body (Model: ${target}):`);
    log("=== End Request ===\n");

    // Build headers - pass through auth headers exactly as received
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": originalHeaders["anthropic-version"] || "2023-06-01",
    };

    // Pass through auth headers as-is
    if (originalHeaders["authorization"]) {
      headers["authorization"] = originalHeaders["authorization"];
    }
    if (originalHeaders["x-api-key"]) {
      headers["x-api-key"] = originalHeaders["x-api-key"];
    }
    if (originalHeaders["anthropic-beta"]) {
      headers["anthropic-beta"] = originalHeaders["anthropic-beta"];
    }

    // Execute fetch
    try {
      const anthropicResponse = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const contentType = anthropicResponse.headers.get("content-type") || "";

      // Handle streaming
      if (contentType.includes("text/event-stream")) {
        log("[Native] Streaming response detected");
        return c.body(
          new ReadableStream({
            async start(controller) {
              const reader = anthropicResponse.body?.getReader();
              if (!reader) throw new Error("No reader");

              const decoder = new TextDecoder();
              let buffer = "";
              let eventLog = "";

              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;

                  controller.enqueue(value);

                  // Basic logging
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";
                  for (const line of lines) if (line.trim()) eventLog += line + "\n";
                }
                if (eventLog) log(eventLog);
                controller.close();
              } catch (e) {
                log(`[Native] Stream Error: ${e}`);
                controller.close();
              }
            },
          }),
          {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "anthropic-version": "2023-06-01",
            },
          }
        );
      }

      // Handle JSON
      const data = await anthropicResponse.json();
      log("\n=== [NATIVE] Response ===");
      log(JSON.stringify(data, null, 2));

      const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (anthropicResponse.headers.has("anthropic-version")) {
        responseHeaders["anthropic-version"] = anthropicResponse.headers.get("anthropic-version")!;
      }

      return c.json(data, { status: anthropicResponse.status as any, headers: responseHeaders });
    } catch (error) {
      log(`[Native] Fetch Error: ${error}`);
      return c.json({ error: { type: "api_error", message: String(error) } }, 500);
    }
  }

  async shutdown(): Promise<void> {
    // No state to clean up
  }
}
