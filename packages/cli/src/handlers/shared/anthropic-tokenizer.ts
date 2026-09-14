/**
 * Load a model's tokenizer from a configured source and count tokens, so the
 * cache min-size gate can use an exact prefix token count instead of the char
 * estimate.
 *
 * The `tokenizers` package exposes only `fromFile` and `fromString` (no hub
 * download), so a hub id or URL is fetched here from
 * `https://huggingface.co/{repo}/resolve/{revision}/tokenizer.json` and
 * disk-cached, mirroring the model-catalog cache. The loaded tokenizer (or a
 * null miss) is memoized per source, so the heavy parse and any fetch happen
 * once per process; a failure degrades to `undefined`, i.e. the caller's char
 * estimate, never an error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Tokenizer } from "tokenizers";
import { log } from "../../logger.js";
import type { TokenizerSource } from "./anthropic-cache.js";

export type { TokenizerSource };

const CACHE_DIR = join(homedir(), ".claudish", "tokenizers");

const cache = new Map<string, Promise<Tokenizer | null>>();

function sourceKey(source: TokenizerSource): string {
  switch (source.kind) {
    case "file":
      return `file:${source.path}`;
    case "hub":
      return `hub:${source.repo}@${source.revision ?? "main"}`;
    case "url":
      return `url:${source.url}`;
  }
}

/** A filesystem-safe cache filename for a fetched tokenizer.json. */
function cacheFileName(source: TokenizerSource): string {
  return `${sourceKey(source).replace(/[^\w.@-]/g, "_")}.json`;
}

async function fetchTokenizerJson(url: string, source: TokenizerSource): Promise<string> {
  const cachePath = join(CACHE_DIR, cacheFileName(source));
  if (existsSync(cachePath)) return readFileSync(cachePath, "utf-8");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`tokenizer fetch returned ${res.status} for ${url}`);
  const text = await res.text();
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, text, "utf-8");
  } catch {
    // Best-effort cache; a read-only home just re-fetches next process.
  }
  return text;
}

async function load(source: TokenizerSource): Promise<Tokenizer | null> {
  try {
    if (source.kind === "file") return await Tokenizer.fromFile(source.path);
    const url =
      source.kind === "hub"
        ? `https://huggingface.co/${source.repo}/resolve/${source.revision ?? "main"}/tokenizer.json`
        : source.url;
    return Tokenizer.fromString(await fetchTokenizerJson(url, source));
  } catch (err) {
    log(`[cache] tokenizer load failed (${sourceKey(source)}): ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Load (and memoize) the tokenizer for a source, or null if it cannot load. */
export function resolveTokenizer(source: TokenizerSource): Promise<Tokenizer | null> {
  const key = sourceKey(source);
  let pending = cache.get(key);
  if (!pending) {
    pending = load(source);
    cache.set(key, pending);
  }
  return pending;
}

/**
 * Exact token count for `text` via the source's tokenizer, or `undefined` when
 * the tokenizer cannot load (so the caller falls back to the char estimate).
 */
export async function countTokensViaTokenizer(
  source: TokenizerSource,
  text: string
): Promise<number | undefined> {
  const tokenizer = await resolveTokenizer(source);
  if (!tokenizer) return undefined;
  try {
    const encoding = await tokenizer.encode(text, null);
    return encoding.getIds().length;
  } catch {
    return undefined;
  }
}
