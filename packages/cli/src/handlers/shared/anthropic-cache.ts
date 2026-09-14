/**
 * Anthropic prompt-cache breakpoint injection.
 *
 * Ported from pino (https://github.com/alxsuv/pino, src/cache.js). A request
 * bound for an Anthropic-wire target carries a large static prefix, the tool
 * catalog, the system prompt, and the first message's CLAUDE.md + skills +
 * deferred-tool reminders, that Claude Code does not always mark for caching.
 * Marking that prefix with `cache_control` breakpoints caches it across turns,
 * so only the moving tail of the conversation is re-billed at full rate.
 *
 * Anthropic honours at most four cache breakpoints per request, so placement
 * respects a ceiling and first reclaims slots that pay for nothing: breakpoints
 * on tiny system blocks, and on intermediate conversation turns that the rolling
 * tail already covers. The tail keeps a short TTL because it moves every turn;
 * the static prefix can take the long (1h) TTL where the caller enables it.
 *
 * The functions mutate the payload in place, matching the reference.
 */

import { loadConfig } from "../../profile-config.js";

export type CacheTtl = "5m" | "1h";

/** Anthropic gates the 1h cache TTL behind this beta flag. */
export const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

// A client breakpoint on a system block smaller than this pays for nothing:
// caching <500 chars saves ~125 tokens but burns one of four breakpoints.
const MIN_SYSTEM_CACHE_CHARS = 500;

const BREAKPOINT_CEILING = 4;

interface EphemeralCacheControl {
  type: "ephemeral";
  ttl?: CacheTtl;
}

function isEphemeral(cc: unknown): cc is EphemeralCacheControl {
  return (
    !!cc && typeof cc === "object" && (cc as { type?: unknown }).type === "ephemeral"
  );
}

/** Count every ephemeral cache breakpoint anywhere in the payload. */
export function countCacheBreakpoints(body: unknown): number {
  let n = 0;
  const walk = (x: any): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }
    if (isEphemeral(x.cache_control)) n += 1;
    for (const k of Object.keys(x)) walk(x[k]);
  };
  walk(body);
  return n;
}

function hasBreakpoint(arr: unknown): boolean {
  return (
    Array.isArray(arr) &&
    arr.some((x) => x && typeof x === "object" && isEphemeral(x.cache_control))
  );
}

/**
 * Remove cache_control from intermediate conversation turns (everything between
 * the first and last message). The messages[0] and rolling-tail breakpoints
 * cover the prefix; breakpoints stranded on middle turns only burn slots.
 */
export function stripIntermediateMessageBreakpoints(body: any): number {
  if (!Array.isArray(body?.messages) || body.messages.length <= 2) return 0;
  let stripped = 0;
  for (let i = 1; i < body.messages.length - 1; i++) {
    const content = body.messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && block.cache_control) {
        delete block.cache_control;
        stripped += 1;
      }
    }
  }
  return stripped;
}

function stripSmallSystemBreakpoints(body: any): number {
  if (!Array.isArray(body.system)) return 0;
  let stripped = 0;
  for (const block of body.system) {
    if (!block || typeof block !== "object") continue;
    if (!isEphemeral(block.cache_control)) continue;
    const len = typeof block.text === "string" ? block.text.length : 0;
    if (len < MIN_SYSTEM_CACHE_CHARS) {
      delete block.cache_control;
      stripped += 1;
    }
  }
  return stripped;
}

function findLastCacheableBlockInMessage(m: any): any | null {
  if (!m || typeof m !== "object") return null;
  const c = m.content;
  if (Array.isArray(c)) {
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (
        b &&
        typeof b === "object" &&
        (b.type === "text" || b.type === "tool_result" || b.type === "image")
      ) {
        return b;
      }
    }
  } else if (typeof c === "string" && c.length > 0) {
    m.content = [{ type: "text", text: c }];
    return m.content[0];
  }
  return null;
}

function findLastCacheableMessageBlock(body: any): any | null {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const b = findLastCacheableBlockInMessage(body.messages[i]);
    if (b) return b;
  }
  return null;
}

/**
 * Force every ephemeral breakpoint inside the LAST message to the tail TTL and
 * return the nodes carrying them, so the prefix-TTL pass leaves them alone.
 * Claude Code places its own rolling tail, so we cannot assume we only own the
 * tails we injected ourselves.
 */
function normalizeTailBreakpoints(body: any, tailTtl: CacheTtl): Set<object> {
  const out = new Set<object>();
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return out;
  const last = body.messages[body.messages.length - 1];
  const walk = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (isEphemeral(n.cache_control)) {
      n.cache_control.ttl = tailTtl;
      out.add(n);
    }
    if (Array.isArray(n)) {
      n.forEach(walk);
    } else {
      for (const k of Object.keys(n)) if (k !== "cache_control") walk(n[k]);
    }
  };
  walk(last);
  return out;
}

/** Force every ephemeral breakpoint NOT in `skip` to the prefix TTL. */
function applyPrefixTtl(body: any, prefixTtl: CacheTtl, skip: Set<object>): number {
  let rewritten = 0;
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (isEphemeral(node.cache_control) && !skip.has(node)) {
      if (node.cache_control.ttl !== prefixTtl) {
        node.cache_control.ttl = prefixTtl;
        rewritten += 1;
      }
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(body);
  return rewritten;
}

/**
 * Rough token count for a text: a char-based estimate (~4 chars/token). A
 * per-model tokenizer can replace this for an exact count where one is
 * configured, without changing callers.
 */
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The cacheable-prefix text (tool catalog + system + first message). Exported so
 * a caller can count it with an exact tokenizer and pass the result as
 * `prefixTokens`; the internal fallback counts it with the char estimate.
 */
export function prefixText(body: any): string {
  const parts: string[] = [];
  if (Array.isArray(body?.tools)) parts.push(JSON.stringify(body.tools));
  if (Array.isArray(body?.system)) parts.push(JSON.stringify(body.system));
  else if (typeof body?.system === "string") parts.push(body.system);
  const first = Array.isArray(body?.messages) ? body.messages[0] : undefined;
  if (first?.content !== undefined) parts.push(JSON.stringify(first.content));
  return parts.join("");
}

/** Char-estimate of the cacheable-prefix tokens, the fallback when no tokenizer. */
function estimatePrefixTokens(body: any): number {
  return countTokens(prefixText(body));
}

/**
 * Remove every ephemeral cache breakpoint from the payload. For an endpoint that
 * rejects `cache_control` (Zhipu/GLM answers 400), the field must be gone before
 * the request is sent, including the breakpoints Claude Code set. Mutates `body`;
 * returns the number removed.
 */
export function stripAnthropicCacheBreakpoints(body: any): number {
  let removed = 0;
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.cache_control) {
      delete node.cache_control;
      removed += 1;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(body);
  return removed;
}

export interface CacheInjectionOptions {
  /** TTL for the static-prefix breakpoints (tools, system, messages[0]). Default "5m". */
  prefixTtl?: CacheTtl;
  /** TTL for the rolling conversation tail. Default "5m". */
  tailTtl?: CacheTtl;
  /**
   * Minimum estimated prefix tokens before injecting. Anthropic ignores a
   * breakpoint whose cached prefix is under its minimum size, so below this we
   * skip rather than burn a slot. Default 0 (no gate): the floor is a per-model
   * fact the caller supplies (Anthropic 1024, 2048 for Haiku).
   */
  minCacheTokens?: number;
  /**
   * Exact prefix token count from a real tokenizer, when the caller resolved one
   * for the model. Absent falls back to the char estimate of {@link prefixText}.
   */
  prefixTokens?: number;
}

export interface CacheInjectionResult {
  /** Compact record of what was placed or reclaimed, for debug logging. */
  tag: string;
}

/**
 * Place cache breakpoints on the static prefix of an Anthropic Messages payload,
 * respecting the four-breakpoint ceiling. Mutates `body`.
 */
export function injectAnthropicCacheBreakpoints(
  body: any,
  opts: CacheInjectionOptions = {}
): CacheInjectionResult {
  const prefixTtl: CacheTtl = opts.prefixTtl ?? "5m";
  const tailTtl: CacheTtl = opts.tailTtl ?? "5m";
  const minCacheTokens = opts.minCacheTokens ?? 0;
  const tags: string[] = [];
  const tailBlocks = new Set<object>();

  if (!body || typeof body !== "object") return { tag: "none" };

  // A prefix under the model's minimum cacheable size caches nothing, so a
  // breakpoint there only spends a slot. Skip injection when the prefix is below
  // the floor the caller supplied, using its exact token count if it gave one.
  const prefixTokens = opts.prefixTokens ?? estimatePrefixTokens(body);
  if (minCacheTokens > 0 && prefixTokens < minCacheTokens) {
    return { tag: "below-min" };
  }

  const strippedMid = stripIntermediateMessageBreakpoints(body);
  if (strippedMid > 0) tags.push(`strip-mid:${strippedMid}`);

  const strippedSys = stripSmallSystemBreakpoints(body);
  if (strippedSys > 0) tags.push(`strip-sys:${strippedSys}`);

  // Tool catalog: a breakpoint on the last tool caches the whole catalog, and a
  // dedicated one shields it from system-prompt churn (a later breakpoint that
  // moves would otherwise invalidate the tools cached behind it too).
  if (Array.isArray(body.tools) && body.tools.length > 0 && !hasBreakpoint(body.tools)) {
    const last = body.tools[body.tools.length - 1];
    if (last && typeof last === "object") {
      last.cache_control = { type: "ephemeral", ttl: prefixTtl };
      tags.push("tools");
    }
  }

  // System prompt.
  if (Array.isArray(body.system) && body.system.length > 0 && !hasBreakpoint(body.system)) {
    const last = body.system[body.system.length - 1];
    if (last && typeof last === "object") {
      last.cache_control = { type: "ephemeral", ttl: prefixTtl };
      tags.push("system");
    }
  } else if (typeof body.system === "string" && body.system.length > 0) {
    body.system = [
      { type: "text", text: body.system, cache_control: { type: "ephemeral", ttl: prefixTtl } },
    ];
    tags.push("system-string");
  }

  // messages[0]: the static reminders (CLAUDE.md, skills, deferred-tool catalog)
  // that never change. Only when a distinct tail message follows; otherwise the
  // tail pass below already covers it.
  if (
    Array.isArray(body.messages) &&
    body.messages.length > 1 &&
    countCacheBreakpoints(body) < BREAKPOINT_CEILING
  ) {
    const first = findLastCacheableBlockInMessage(body.messages[0]);
    if (first && !first.cache_control) {
      first.cache_control = { type: "ephemeral", ttl: prefixTtl };
      tags.push("msg0");
    }
  }

  // Rolling tail: cache through the most recent user/tool_result block.
  if (countCacheBreakpoints(body) < BREAKPOINT_CEILING) {
    const tail = findLastCacheableMessageBlock(body);
    if (tail && !tail.cache_control) {
      tail.cache_control = { type: "ephemeral", ttl: tailTtl };
      tailBlocks.add(tail);
      tags.push(`tail:${tailTtl}`);
    }
  }

  // Pin Claude Code's own tail breakpoints to the tail TTL, then bring every
  // other breakpoint (ours and the client's static ones) to the prefix TTL.
  const clientTail = normalizeTailBreakpoints(body, tailTtl);
  const skip = new Set<object>([...tailBlocks, ...clientTail]);
  const rewritten = applyPrefixTtl(body, prefixTtl, skip);
  if (rewritten > 0) tags.push(`prefix-ttl:${rewritten}`);

  return { tag: tags.length ? tags.join("+") : "none" };
}

/**
 * Return an `anthropic-beta` header value that includes the extended-cache-ttl
 * flag, so 1h breakpoints are honoured. Preserves any flags already present.
 */
export function ensureExtendedCacheBeta(existing: string | undefined): string {
  if (!existing) return EXTENDED_CACHE_TTL_BETA;
  const present = existing
    .split(",")
    .map((s) => s.trim())
    .includes(EXTENDED_CACHE_TTL_BETA);
  return present ? existing : `${existing},${EXTENDED_CACHE_TTL_BETA}`;
}

/**
 * Where a model's tokenizer.json comes from. An explicit discriminated union
 * rather than shape-dispatch, because a hub id ("owner/model") and a relative
 * path are ambiguous by shape; matches how customEndpoints discriminates `kind`.
 * The heavyweight loader lives in anthropic-tokenizer.ts and is imported lazily,
 * so the tokenizers native binding is never pulled in unless a source is used.
 */
export type TokenizerSource =
  | { kind: "file"; path: string }
  | { kind: "hub"; repo: string; revision?: string }
  | { kind: "url"; url: string };

/** Pick the tokenizer source for a model from a `model glob -> source` map. */
export function tokenizerSourceFor(
  model: string,
  tokenizers: Record<string, TokenizerSource> | undefined
): TokenizerSource | undefined {
  if (!tokenizers) return undefined;
  if (tokenizers[model]) return tokenizers[model];
  for (const [pattern, source] of Object.entries(tokenizers)) {
    if (!pattern.includes("*")) continue;
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    if (re.test(model)) return source;
  }
  return undefined;
}

/**
 * Exact cacheable-prefix token count for a model when a tokenizer source is
 * configured, else undefined (the caller falls back to the char estimate). The
 * heavyweight tokenizer module is imported lazily, so the `tokenizers` native
 * binding (~60MB resident) is pulled in only when a source is actually used,
 * never on a caching-off run.
 */
export async function exactPrefixTokens(
  body: any,
  model: string,
  caching: ResolvedCachingConfig
): Promise<number | undefined> {
  const source = tokenizerSourceFor(model, caching.tokenizers);
  if (!source) return undefined;
  const { countTokensViaTokenizer } = await import("./anthropic-tokenizer.js");
  return countTokensViaTokenizer(source, prefixText(body));
}

export interface ResolvedCachingConfig {
  enabled: boolean;
  extendedTtl: boolean;
  /** Optional `model glob -> tokenizer source` map for exact prefix token counts. */
  tokenizers?: Record<string, TokenizerSource>;
}

function envFlag(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return v === "1";
}

/**
 * Resolve caching config. An env var overrides the config file, matching every
 * other claudish toggle (CLAUDISH_DEBUG, CLAUDISH_ANTHROPIC_API_BILLING, ...).
 * Absent everywhere means off.
 */
export function loadCachingConfig(): ResolvedCachingConfig {
  const fromFile = loadConfig().caching ?? {};
  return {
    enabled: envFlag("CLAUDISH_CACHE") ?? fromFile.enabled ?? false,
    extendedTtl: envFlag("CLAUDISH_CACHE_EXTENDED_TTL") ?? fromFile.extendedTtl ?? false,
    tokenizers: fromFile.tokenizers,
  };
}
