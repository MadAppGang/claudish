/**
 * Poe Middleware Manager - Manages middleware for Poe models
 *
 * Provides middleware support specifically for Poe models, enabling
 * advanced processing like thought signature extraction while maintaining
 * compatibility with the existing middleware system.
 */

import { GeminiThoughtSignatureMiddleware } from "./gemini-thought-signature.js";
import type { ModelMiddleware } from "./types.js";
import type { RequestContext, StreamChunkContext, NonStreamingResponseContext } from "./types.js";
import { log } from "../logger.js";

/**
 * Middleware manager for Poe models
 *
 * Extends the standard middleware system to work with Poe-specific
 * requirements and model detection patterns.
 */
export class PoeMiddlewareManager {
  private middlewares: ModelMiddleware[] = [];
  private modelId: string;

  constructor(poeModelId: string) {
    this.modelId = poeModelId;
    this.initializeMiddlewares();
  }

  /**
   * Initialize middlewares relevant to Poe models
   */
  private initializeMiddlewares(): void {
    // Strip "poe:" prefix for middleware detection
    const cleanModelId = this.modelId.replace(/^poe:/, "");

    // Register Gemini thought signature middleware for Gemini models
    const geminiMiddleware = new GeminiThoughtSignatureMiddleware();
    if (geminiMiddleware.shouldHandle(cleanModelId)) {
      this.middlewares.push(geminiMiddleware);
      log(`[PoeMiddlewareManager] Registered GeminiThoughtSignatureMiddleware for ${this.modelId}`);
    }

    // Future: Add other Poe-specific middlewares here
    // - Grok XML processing middleware
    // - OpenAI reasoning parameter middleware
    // - Qwen thinking budget middleware
  }

  /**
   * Execute beforeRequest hooks
   */
  async beforeRequest(context: RequestContext): Promise<void> {
    for (const middleware of this.middlewares) {
      try {
        if (middleware.beforeRequest) {
          await middleware.beforeRequest(context);
        }
      } catch (error) {
        log(`[PoeMiddlewareManager] Error in beforeRequest for ${middleware.constructor.name}: ${error}`);
      }
    }
  }

  /**
   * Execute afterResponse hooks
   */
  async afterResponse(context: NonStreamingResponseContext): Promise<void> {
    for (const middleware of this.middlewares) {
      try {
        if (middleware.afterResponse) {
          await middleware.afterResponse(context);
        }
      } catch (error) {
        log(`[PoeMiddlewareManager] Error in afterResponse for ${middleware.constructor.name}: ${error}`);
      }
    }
  }

  /**
   * Execute afterStreamChunk hooks
   */
  async afterStreamChunk(context: StreamChunkContext): Promise<void> {
    for (const middleware of this.middlewares) {
      try {
        if (middleware.afterStreamChunk) {
          await middleware.afterStreamChunk(context);
        }
      } catch (error) {
        log(`[PoeMiddlewareManager] Error in afterStreamChunk for ${middleware.constructor.name}: ${error}`);
      }
    }
  }

  /**
   * Execute afterStreamComplete hooks
   */
  async afterStreamComplete(metadata: Map<string, any>): Promise<void> {
    for (const middleware of this.middlewares) {
      try {
        if (middleware.afterStreamComplete) {
          await middleware.afterStreamComplete(metadata);
        }
      } catch (error) {
        log(`[PoeMiddlewareManager] Error in afterStreamComplete for ${middleware.constructor.name}: ${error}`);
      }
    }
  }

  /**
   * Initialize all middlewares
   */
  async initialize(): Promise<void> {
    for (const middleware of this.middlewares) {
      try {
        if (middleware.onInit) {
          await middleware.onInit();
        }
      } catch (error) {
        log(`[PoeMiddlewareManager] Error in initialization for ${middleware.constructor.name}: ${error}`);
      }
    }

    log(`[PoeMiddlewareManager] Initialized ${this.middlewares.length} middlewares for ${this.modelId}`);
  }

  /**
   * Check if any middlewares are registered
   */
  hasMiddlewares(): boolean {
    return this.middlewares.length > 0;
  }

  /**
   * Get registered middleware count
   */
  getMiddlewareCount(): number {
    return this.middlewares.length;
  }
}