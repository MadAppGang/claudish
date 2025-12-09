/**
 * MiddlewareManager - Orchestrates model-specific middlewares
 *
 * Responsibilities:
 * - Register middlewares
 * - Filter active middlewares by model ID
 * - Execute middleware chain in order
 * - Handle errors gracefully (log and continue)
 */

import { isLoggingEnabled, log, logStructured } from "../logger.js";
import type {
  ModelMiddleware,
  NonStreamingResponseContext,
  RequestContext,
  StreamChunkContext,
} from "./types.js";

export class MiddlewareManager {
  private middlewares: ModelMiddleware[] = [];
  private initialized = false;

  /**
   * Register a middleware
   * Middlewares execute in registration order
   */
  register(middleware: ModelMiddleware): void {
    this.middlewares.push(middleware);

    if (isLoggingEnabled()) {
      logStructured("Middleware Registered", {
        name: middleware.name,
        total: this.middlewares.length,
      });
    }
  }

  /**
   * Initialize all middlewares (call onInit hooks)
   * Should be called once when server starts
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      log("[Middleware] Already initialized, skipping");
      return;
    }

    log(`[Middleware] Initializing ${this.middlewares.length} middleware(s)...`);

    for (const middleware of this.middlewares) {
      if (middleware.onInit) {
        try {
          await middleware.onInit();
          log(`[Middleware] ${middleware.name} initialized`);
        } catch (error) {
          log(`[Middleware] ERROR: ${middleware.name} initialization failed: ${error}`);
          // Continue with other middlewares even if one fails
        }
      }
    }

    this.initialized = true;
    log("[Middleware] Initialization complete");
  }

  /**
   * Get active middlewares for a specific model
   */
  private getActiveMiddlewares(modelId: string): ModelMiddleware[] {
    return this.middlewares.filter((m) => m.shouldHandle(modelId));
  }

  /**
   * Execute beforeRequest hooks for all active middlewares
   */
  async beforeRequest(context: RequestContext): Promise<void> {
    const active = this.getActiveMiddlewares(context.modelId);

    if (active.length === 0) {
      return; // No middlewares for this model
    }

    if (isLoggingEnabled()) {
      logStructured("Middleware Chain (beforeRequest)", {
        modelId: context.modelId,
        middlewares: active.map((m) => m.name),
        messageCount: context.messages.length,
      });
    }

    for (const middleware of active) {
      try {
        await middleware.beforeRequest(context);
      } catch (error) {
        log(`[Middleware] ERROR in ${middleware.name}.beforeRequest: ${error}`);
        // Continue with next middleware - don't let one failure break the chain
      }
    }
  }

  /**
   * Execute afterResponse hooks for non-streaming responses
   */
  async afterResponse(context: NonStreamingResponseContext): Promise<void> {
    const active = this.getActiveMiddlewares(context.modelId);

    if (active.length === 0) {
      return;
    }

    if (isLoggingEnabled()) {
      logStructured("Middleware Chain (afterResponse)", {
        modelId: context.modelId,
        middlewares: active.map((m) => m.name),
      });
    }

    for (const middleware of active) {
      if (middleware.afterResponse) {
        try {
          await middleware.afterResponse(context);
        } catch (error) {
          log(`[Middleware] ERROR in ${middleware.name}.afterResponse: ${error}`);
        }
      }
    }
  }

  /**
   * Execute afterStreamChunk hooks for each streaming chunk
   */
  async afterStreamChunk(context: StreamChunkContext): Promise<void> {
    const active = this.getActiveMiddlewares(context.modelId);

    if (active.length === 0) {
      return;
    }

    // Only log on first chunk to avoid spam
    if (isLoggingEnabled() && !context.metadata.has("_middlewareLogged")) {
      logStructured("Middleware Chain (afterStreamChunk)", {
        modelId: context.modelId,
        middlewares: active.map((m) => m.name),
      });
      context.metadata.set("_middlewareLogged", true);
    }

    for (const middleware of active) {
      if (middleware.afterStreamChunk) {
        try {
          await middleware.afterStreamChunk(context);
        } catch (error) {
          log(`[Middleware] ERROR in ${middleware.name}.afterStreamChunk: ${error}`);
        }
      }
    }
  }

  /**
   * Execute afterStreamComplete hooks after streaming finishes
   */
  async afterStreamComplete(modelId: string, metadata: Map<string, any>): Promise<void> {
    const active = this.getActiveMiddlewares(modelId);

    if (active.length === 0) {
      return;
    }

    for (const middleware of active) {
      if (middleware.afterStreamComplete) {
        try {
          await middleware.afterStreamComplete(metadata);
        } catch (error) {
          log(`[Middleware] ERROR in ${middleware.name}.afterStreamComplete: ${error}`);
        }
      }
    }
  }
}
