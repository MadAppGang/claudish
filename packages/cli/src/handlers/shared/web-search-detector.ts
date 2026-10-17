/**
 * Web search tool call detector.
 * v1: Logs a warning when web_search is detected.
 * v2 (future): Will intercept and execute the search.
 */

import { log, logStderr } from "../../logger.js";

const WEB_SEARCH_NAMES = new Set(["web_search", "brave_web_search", "tavily_search"]);

/**
 * Check if a parsed tool call name indicates a web search request.
 */
export function isWebSearchToolCall(toolName: string): boolean {
  return WEB_SEARCH_NAMES.has(toolName);
}

/**
 * Log a warning that web search was requested but is not yet supported.
 */
export function warnWebSearchUnsupported(toolName: string, modelName: string): void {
  log(`[WebSearch] Tool call '${toolName}' detected from model '${modelName}' — not yet supported`);
  logStderr(
    `Warning: Model requested web search ('${toolName}') but server-side web search is not yet implemented. The tool call will pass through to the client as-is.`
  );
}
