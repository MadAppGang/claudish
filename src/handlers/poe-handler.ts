import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import { log, logStructured } from "../logger.js";
import type { ModelHandler } from "./types.js";

// Find the scripts directory - handle both source and built scenarios
function findPoeBridgeScript(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Try relative to current file (works in source)
  const relativeToSource = join(__dirname, "../../scripts/poe-bridge.py");
  if (existsSync(relativeToSource)) {
    return relativeToSource;
  }

  // Try relative to process.cwd() (works when installed globally or run from project root)
  const relativeToCwd = join(process.cwd(), "scripts/poe-bridge.py");
  if (existsSync(relativeToCwd)) {
    return relativeToCwd;
  }

  // Try relative to dist directory (works in built scenario)
  const relativeToBuilt = join(__dirname, "../scripts/poe-bridge.py");
  if (existsSync(relativeToBuilt)) {
    return relativeToBuilt;
  }

  // Fallback - will fail but error message will be clear
  return relativeToSource;
}

const POE_BRIDGE_SCRIPT = findPoeBridgeScript();

/**
 * PoeHandler - Routes requests to Poe API via Python bridge.
 *
 * Uses fastapi-poe Python SDK for full Poe API compatibility,
 * including thinking_budget parameter for reasoning models.
 *
 * Features:
 * - Model transformation: poe/MODEL_NAME → MODEL_NAME (just strip prefix)
 * - Thinking budget support: Passes thinking.budget_tokens from Claude Code as thinking_budget to Poe API
 *   (enables extended thinking for models like Claude-Sonnet-4, Grok-4-reasoning, etc.)
 *
 * When Claude Code detects "ultrathink" in messages, it sends thinking.budget_tokens parameter,
 * which this handler translates to thinking_budget for Poe's API.
 */
export class PoeHandler implements ModelHandler {
  private poeModelId: string;
  private apiKey?: string;
  private activeProcesses = new Set<ChildProcess>();

  constructor(targetModel: string, apiKey: string | undefined, _port: number) {
    // Simple transformation: poe/ANYTHING → ANYTHING
    this.poeModelId = this.stripPoePrefix(targetModel);
    this.apiKey = apiKey;

    log(`[PoeHandler] Initialized for model: ${this.poeModelId}`);
    log(`[PoeHandler] Python bridge script: ${POE_BRIDGE_SCRIPT}`);
  }

  /**
   * Strip the poe/ prefix from model name.
   * poe/Claude-Sonnet-4.5 → Claude-Sonnet-4.5
   */
  private stripPoePrefix(model: string): string {
    return model.replace(/^poe\//, "");
  }

  /**
   * Handle incoming request from Claude Code.
   * Spawns Python bridge process and streams response.
   */
  async handle(c: Context, payload: any): Promise<Response> {
    log("[PoeHandler] Received request");
    log(`[PoeHandler] Payload type: ${typeof payload}`);
    log(`[PoeHandler] Payload keys: ${payload ? Object.keys(payload).join(", ") : "null"}`);
    log(
      `[PoeHandler] Messages: ${payload?.messages ? `array of ${payload.messages.length}` : "undefined"}`
    );

    logStructured("Poe Request", {
      poeModel: this.poeModelId,
      originalModel: payload.model,
      messageCount: payload.messages?.length || 0,
      hasThinking: !!payload.thinking,
    });

    // Prepare request for Python bridge
    const poeRequest: any = {
      model: this.poeModelId,
      messages: payload.messages || [],
      system: this.extractSystem(payload),
    };

    // Pass thinking parameter if present (for models that support thinking_budget)
    // Claude Code sends thinking.budget_tokens when "ultrathink" is detected
    if (payload.thinking?.budget_tokens) {
      poeRequest.thinking_budget = payload.thinking.budget_tokens;
      log(`[PoeHandler] Thinking budget detected: ${payload.thinking.budget_tokens} tokens`);
    }

    log(
      `[PoeHandler] Prepared request: model=${poeRequest.model}, messages=${poeRequest.messages.length}, system=${poeRequest.system ? "present" : "empty"}, thinking_budget=${poeRequest.thinking_budget || "none"}`
    );

    // Check for API key
    if (!this.apiKey) {
      return this.errorResponse(c, "POE_API_KEY not configured", 401);
    }

    // Spawn Python bridge process
    let proc: ChildProcess;
    try {
      proc = spawn("python3", [POE_BRIDGE_SCRIPT], {
        env: { ...process.env, POE_API_KEY: this.apiKey },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.activeProcesses.add(proc);
    } catch (err) {
      log(`[PoeHandler] Failed to spawn Python: ${err}`);
      return this.errorResponse(c, "Failed to start Poe bridge. Is Python 3 installed?", 500);
    }

    // Handle process errors
    proc.on("error", (err) => {
      log(`[PoeHandler] Process error: ${err}`);
    });

    proc.on("exit", (code) => {
      this.activeProcesses.delete(proc);
      if (code !== 0) {
        log(`[PoeHandler] Python bridge exited with code ${code}`);
      }
    });

    // Log stderr for debugging
    proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        log(`[PoeHandler] Python: ${msg}`);
      }
    });

    // Send request to Python stdin
    try {
      proc.stdin?.write(JSON.stringify(poeRequest));
      proc.stdin?.end();
    } catch (err) {
      log(`[PoeHandler] Failed to write to stdin: ${err}`);
      proc.kill();
      return this.errorResponse(c, "Failed to communicate with Poe bridge", 500);
    }

    // Create streaming response from Python stdout
    const stream = this.createResponseStream(proc);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /**
   * Create a ReadableStream from Python process stdout.
   */
  private createResponseStream(proc: ChildProcess): ReadableStream<Uint8Array> {
    let isClosed = false;

    return new ReadableStream({
      start(controller) {
        if (!proc.stdout) {
          controller.close();
          return;
        }

        proc.stdout.on("data", (chunk: Buffer) => {
          if (!isClosed) {
            controller.enqueue(new Uint8Array(chunk));
          }
        });

        proc.stdout.on("end", () => {
          if (!isClosed) {
            isClosed = true;
            controller.close();
          }
        });

        proc.stdout.on("error", (err) => {
          if (!isClosed) {
            isClosed = true;
            log(`[PoeHandler] Stream error: ${err}`);
            controller.error(err);
          }
        });

        proc.on("error", (err) => {
          if (!isClosed) {
            isClosed = true;
            log(`[PoeHandler] Process error: ${err}`);
            controller.error(err);
          }
        });
      },

      cancel() {
        isClosed = true;
        proc.kill();
      },
    });
  }

  /**
   * Extract system message from Claude payload.
   */
  private extractSystem(payload: any): string {
    const system = payload.system;

    if (!system) return "";

    if (typeof system === "string") {
      return system;
    }

    if (Array.isArray(system)) {
      return system
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text || "")
        .join("\n");
    }

    return "";
  }

  /**
   * Create an error response in SSE format.
   */
  private errorResponse(_c: Context, message: string, status: number): Response {
    const encoder = new TextEncoder();
    const errorEvent = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\ndata: [DONE]\n\n`;

    return new Response(encoder.encode(errorEvent), {
      status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }

  /**
   * Cleanup active processes on shutdown.
   */
  async shutdown(): Promise<void> {
    for (const proc of this.activeProcesses) {
      proc.kill();
    }
    this.activeProcesses.clear();
  }
}
