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
 * Maximum bytes to download from a URL. Prevents multi-MB pages from
 * consuming memory and blocking the event loop during regex processing.
 * 500 KB is plenty for text extraction — we only keep 15K chars of output.
 */
const MAX_FETCH_BYTES = 500_000;

/**
 * Maximum HTML input size for regex-based htmlToText(). If the downloaded
 * HTML exceeds this, it is pre-truncated. Since we only keep 15K chars of
 * output, 100K chars of input HTML is more than sufficient.
 */
const MAX_HTML_INPUT_CHARS = 100_000;

/**
 * Fetch a URL and convert HTML to readable text.
 * Uses streaming with a byte cap to avoid loading multi-MB pages into memory,
 * and pre-truncates HTML before regex to prevent event-loop blocking.
 */
export async function executeWebFetch(url: string, deadlineMs = 10_000): Promise<string> {
  try {
    log(`[WebFetch] Fetching: "${url}"`);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(deadlineMs),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Claudish/1.0)",
        Accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";

    // Stream the response body with a byte cap to avoid loading
    // multi-MB pages (e.g. HuggingFace model cards) into memory.
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let truncated = false;
    const reader = response.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
        if (totalBytes > MAX_FETCH_BYTES) {
          log(`[WebFetch] Body exceeded ${MAX_FETCH_BYTES} bytes after ${totalBytes} bytes, truncating download`);
          truncated = true;
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Decode collected chunks
    const decoder = new TextDecoder();
    let body = chunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();

    // If it's already plain text or JSON, return as-is (truncated)
    if (contentType.includes("text/plain") || contentType.includes("application/json")) {
      return truncateContent(body, 15000);
    }

    // HTML content — pre-truncate before regex to prevent CPU spikes,
    // then strip tags and decode entities
    if (contentType.includes("text/html") || body.trimStart().startsWith("<")) {
      if (body.length > MAX_HTML_INPUT_CHARS) {
        log(`[WebFetch] Pre-truncating HTML: ${body.length} → ${MAX_HTML_INPUT_CHARS} chars before regex`);
        body = body.slice(0, MAX_HTML_INPUT_CHARS);
      }
      const text = htmlToText(body);
      log(`[WebFetch] Converted HTML to text: ${body.length} → ${text.length} chars${truncated ? " (download truncated)" : ""}`);
      return truncateContent(text, 15000);
    }

    // Unknown content type — return truncated raw text
    return truncateContent(body, 15000);
  } catch (err: any) {
    log(`[WebFetch] Error fetching "${url}": ${err.message}`);
    return `[Web fetch for "${url}" failed: ${err.message}]`;
  }
}

/**
 * Basic HTML → plain text conversion.
 * Strips tags, decodes common entities, normalizes whitespace.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Convert common block elements to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|br|tr|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Collapse excessive whitespace (3+ newlines → 2)
  text = text.replace(/\n{3,}/g, "\n\n");
  // Collapse excessive spaces
  text = text.replace(/[ \t]+/g, " ");

  return text.trim();
}

/**
 * Truncate content to a maximum length, adding an ellipsis if truncated.
 */
function truncateContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n\n[... content truncated at ${maxLen} chars. Original length: ${text.length} chars]`;
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
