/**
 * Web search executor — intercepts web_search tool calls from providers
 * (z.ai, GLM) and executes them via SearXNG.
 *
 * When a provider model requests web_search, claudish:
 * 1. Extracts the search query from tool arguments
 * 2. Calls the local SearXNG instance
 * 3. Returns formatted results as a text block in the stream
 *
 * IMPORTANT: executeWebSearchSync must not block the SSE stream.
 * It races SearXNG against a 3-second deadline and returns a
 * fallback message immediately if SearXNG is unreachable.
 */

import { log } from "../../logger.js";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://search.myia.io";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Execute a web search via SearXNG. Non-throwing.
 */
async function fetchFromSearXNG(query: string, maxResults = 5): Promise<SearchResult[]> {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  log(`[WebSearch] Executing: "${query}" via ${SEARXNG_URL}`);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    log(`[WebSearch] SearXNG returned HTTP ${response.status}`);
    return [];
  }

  const data = (await response.json()) as any;
  const results: SearchResult[] = (data.results || [])
    .slice(0, maxResults)
    .map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.content || r.description || "",
    }));

  log(`[WebSearch] Got ${results.length} results for "${query}"`);
  return results;
}

/**
 * Stream-safe web search: races SearXNG against a short deadline.
 * Returns formatted results text, never throws, never blocks > deadline.
 */
export async function executeWebSearch(query: string, deadlineMs = 3000): Promise<string> {
  try {
    const results = await Promise.race([
      fetchFromSearXNG(query),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deadlineMs)),
    ]);

    if (results === null) {
      log(`[WebSearch] Timed out after ${deadlineMs}ms for "${query}"`);
      return `[Web search for "${query}" timed out. SearXNG did not respond within ${deadlineMs / 1000}s.]`;
    }

    return formatSearchResults(query, results);
  } catch (err: any) {
    log(`[WebSearch] Error: ${err.message}`);
    return `[Web search for "${query}" failed: ${err.message}]`;
  }
}

/**
 * Format search results as a text block for injection into the stream.
 */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `[Web search for "${query}" returned no results. The search service may be unavailable.]`;
  }

  const lines = [`[Web search results for "${query}"]\n`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   ${r.url}`);
    if (r.snippet) {
      lines.push(`   ${r.snippet}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Extract the search query from a web_search tool call's arguments JSON.
 */
export function extractSearchQuery(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson);
    return args.query || args.q || args.search_query || args.keyword || "";
  } catch {
    // If args aren't valid JSON, try to extract from raw string
    const match = argsJson.match(/"query"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
    const match2 = argsJson.match(/"q"\s*:\s*"([^"]+)"/);
    if (match2) return match2[1];
    return "";
  }
}
