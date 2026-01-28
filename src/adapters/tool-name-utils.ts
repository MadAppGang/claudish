/**
 * Tool name truncation utilities for model adapters
 *
 * Some model APIs (e.g., OpenAI) impose a maximum length on tool/function names.
 * These utilities provide deterministic truncation with hash-based collision avoidance.
 */

import { log } from "../logger.js";

/**
 * Simple deterministic string hash that produces an 8-char hex string.
 * Used for tool name truncation to avoid collisions.
 */
function hashToolName(name: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(16).padStart(8, "0").slice(0, 8);
}

/**
 * Truncate a tool name to fit within the given max length.
 * If the name fits, returns as-is.
 * If too long: prefix(maxLength-9) + '_' + 8-char-hash = maxLength.
 */
export function truncateToolName(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const prefixLen = maxLength - 9; // 8 chars for hash + 1 for separator '_'
  const prefix = name.slice(0, prefixLen);
  const hash = hashToolName(name);
  const truncated = `${prefix}_${hash}`;
  log(
    `[ToolName] Truncated: "${name}" -> "${truncated}" (${name.length} -> ${truncated.length} chars)`
  );
  return truncated;
}
