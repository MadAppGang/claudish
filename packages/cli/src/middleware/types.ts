/**
 * Middleware System for Model-Specific Behavior
 *
 * This system allows clean separation of model-specific logic (Gemini thought signatures,
 * Grok XML handling, etc.) from the core proxy server.
 */

/**
 * Context passed to middleware before sending request to OpenRouter
 */
export interface RequestContext {
  /** Model ID being used (e.g., "google/gemini-3-pro-preview") */
  modelId: string;

  /** Messages array (mutable - middlewares can modify in place) */
  messages: any[];

  /** Tools array (if any) */
  tools?: any[];

  /** Whether this is a streaming request */
  stream: boolean;
}

/**
 * Context passed to middleware after receiving non-streaming response
 */
export interface NonStreamingResponseContext {
  /** Model ID being used */
  modelId: string;

  /** OpenAI format response from OpenRouter */
  response: any;
}

/**
 * Context passed to middleware for each streaming chunk
 */
export interface StreamChunkContext {
  /** Model ID being used */
  modelId: string;

  /** Raw SSE chunk from OpenRouter */
  chunk: any;

  /** Delta object (chunk.choices[0].delta) - mutable */
  delta: any;

  /**
   * Shared metadata across all chunks in this streaming response
   * Useful for accumulating state (e.g., thought signatures)
   * Auto-cleaned after stream completes
   */
  metadata: Map<string, any>;
}

/**
 * Base middleware interface
 *
 * Middlewares handle model-specific behavior by hooking into the request/response lifecycle.
 */
export interface ModelMiddleware {
  /** Unique name for this middleware (for logging) */
  readonly name: string;

  /**
   * Determines if this middleware should handle the given model
   * Called once per request to filter active middlewares
   */
  shouldHandle(modelId: string): boolean;

  /**
   * Called once when the proxy server starts (optional)
   * Use for initialization, loading config, etc.
   */
  onInit?(): void | Promise<void>;

  /**
   * Called before sending request to OpenRouter
   * Can modify messages, add extra_content, inject system messages, etc.
   *
   * @param context - Mutable context (can modify messages array)
   */
  beforeRequest(context: RequestContext): void | Promise<void>;

  /**
   * Called after receiving complete non-streaming response (optional)
   * Can extract data, transform response, update cache, etc.
   *
   * @param context - Response context (read-only)
   */
  afterResponse?(context: NonStreamingResponseContext): void | Promise<void>;

  /**
   * Called for each chunk in a streaming response (optional)
   * Can extract data from delta, transform content, etc.
   *
   * @param context - Chunk context (delta is mutable)
   */
  afterStreamChunk?(context: StreamChunkContext): void | Promise<void>;

  /**
   * Called once after a streaming response completes (optional)
   * Use for cleanup, final processing of accumulated metadata, etc.
   *
   * @param metadata - Metadata map that was shared across all chunks
   */
  afterStreamComplete?(metadata: Map<string, any>): void | Promise<void>;
}
