/**
 * Tool name truncation utilities for model adapters
 *
 * Some model APIs (e.g., OpenAI) impose a maximum length on tool/function names.
 * These utilities provide deterministic truncation with hash-based collision avoidance.
 */

import { log } from "../logger.js";

/**
 * The character shape of a tool name, as a pattern fragment.
 *
 * Every tool Claude Code advertises is an identifier. Anything else that reaches
 * a "tool name" slot is text some parser swallowed, and swallowed text carries
 * argument VALUES. Kept here so the text extractor
 * (`handlers/shared/tool-call-recovery.ts`) and the parser's hold-back test
 * hold the same line. (S4-b e82c315)
 */
export const TOOL_NAME_SOURCE = "[A-Za-z_][A-Za-z0-9_.-]{0,63}";

/** Anchored form of {@link TOOL_NAME_SOURCE}. Stateless, so it is safe to share. */
export const TOOL_NAME_SHAPE = new RegExp(`^${TOOL_NAME_SOURCE}$`);

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

// ─── The wire codec ─────────────────────────────────────────────────────────

/**
 * Characters an OpenAI-shaped wire accepts in a function name.
 *
 * This is a DIFFERENT question from {@link TOOL_NAME_SHAPE}, and the two must
 * not be merged. `TOOL_NAME_SHAPE` answers "may this string occupy a tool-name
 * slot in something we parsed" — it stays the single definition of that, and it
 * deliberately admits `.`, because a name we READ may legally contain one.
 * This charset answers "what will the endpoint accept", and OpenAI's function
 * name is validated against `^[a-zA-Z0-9_-]{1,64}$`, which admits no dot.
 *
 * Anything outside it is mapped to `_`, and the map records the way back.
 * (S4-b 2e18042)
 */
const UNWIRABLE_CHARACTER = /[^A-Za-z0-9_-]/g;

/** The two directions of one request's codec. Both are per-request; see reset(). */
export interface ToolNameBindings {
  /** encoded → original. This is the map the stream parser decodes with. */
  byEncoded: Map<string, string>;
  /** original → encoded. Makes the encoding stable within a request. */
  byOriginal: Map<string, string>;
}

/** A fresh, empty pair of bindings. */
export function newToolNameBindings(): ToolNameBindings {
  return { byEncoded: new Map(), byOriginal: new Map() };
}

/** `prefix` + `_` + 8 hex, exactly `limit` characters. */
function hashedForm(transformed: string, original: string, limit: number, salt: number): string {
  const seed = salt === 0 ? original : `${original}#${salt}`;
  const prefix = transformed.slice(0, Math.max(0, limit - 9));
  return `${prefix}_${hashToolName(seed)}`;
}

/**
 * Encode a tool name for an OpenAI-shaped wire, reversibly.
 *
 * Two transformations, in this order:
 *
 *  1. **Charset.** Every character outside {@link UNWIRABLE_CHARACTER}'s
 *     complement becomes `_`.
 *  2. **Length and collisions.** A transformed name longer than `limit`, OR one
 *     already bound to a DIFFERENT original, becomes
 *     `prefix + "_" + hash8(original)`.
 *
 * Step 2's collision arm is not an optimisation. Charset-mapping makes `a.b`
 * and `a_b` the same string, so two different tools can claim one encoded name
 * at ANY length — and the map would then decode every call to whichever of them
 * was registered last, silently handing the model's call to the wrong tool.
 * Length was never the only way to collide.
 *
 * Every binding is recorded, identity ones included, because an identity
 * encoding CLAIMS that name: without the record, a later `a.b` would transform
 * onto an unregistered `a_b` and win it from the real `a_b`.
 *
 * The hash is the collision GUARD, not an inverse. A codec cannot be reversible
 * from an arbitrary-length name into a 64-character slot — the map is
 * authoritative, and that is why it must reach the parser intact.
 */
export function encodeToolName(
  original: string,
  limit: number,
  bindings: ToolNameBindings
): string {
  const already = bindings.byOriginal.get(original);
  if (already !== undefined) return already;

  const transformed = original.replace(UNWIRABLE_CHARACTER, "_");
  const takenByAnother = (name: string) => {
    const owner = bindings.byEncoded.get(name);
    return owner !== undefined && owner !== original;
  };

  let encoded =
    transformed.length <= limit ? transformed : hashedForm(transformed, original, limit, 0);
  if (takenByAnother(encoded)) {
    // Salt only ever advances on a hash8 collision between two DIFFERENT
    // originals, which is vanishingly rare — but "vanishingly rare" and
    // "silently hands the model's call to another tool" is the wrong pair.
    let salt = 0;
    do {
      encoded = hashedForm(transformed, original, limit, salt++);
    } while (takenByAnother(encoded));
  }

  bindings.byEncoded.set(encoded, original);
  bindings.byOriginal.set(original, encoded);
  if (encoded !== original) {
    log(
      `[ToolName] Encoded: "${original}" -> "${encoded}" (${original.length} -> ${encoded.length})`
    );
  }
  return encoded;
}
