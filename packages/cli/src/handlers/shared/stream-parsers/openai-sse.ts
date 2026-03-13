/**
 * OpenAI SSE → Claude SSE stream parser.
 *
 * Re-exports the existing createStreamingResponseHandler from openai-compat.ts.
 * This module exists so the ProviderHandler can import stream parsers
 * by format name without depending on the monolithic openai-compat module.
 *
 * In a future phase, the actual implementation will move here and
 * openai-compat.ts will re-export from this file (inverting the dependency).
 */

export {
  createStreamingResponseHandler,
  createStreamingState,
  type StreamingState,
  type ToolState,
} from "../openai-compat.js";
