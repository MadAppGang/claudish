/**
 * Codex `/models` discovery — the per-model dispatch flags the ChatGPT Codex
 * backend publishes for ONE account.
 *
 * `GET https://chatgpt.com/backend-api/codex/models?client_version=<v>`
 * (the official client's own call, captured live in R1) returns, per model:
 * `tool_mode` (`code_mode_only`), `use_responses_lite`,
 * `default_reasoning_level`, `default_verbosity` and `truncation_policy`.
 * claudish reads those as RULES from discovery; nothing here pins a model id,
 * a mode or a limit.
 *
 * The answer is a dynamic models catalog for one credential:
 *  - memoised in this process only, keyed by `accountKey`
 *    (`code-mode/ids.ts`), 1 h TTL, single-flight per account;
 *  - never persisted;
 *  - stale-while-error: a failed refetch keeps the last good value (logged).
 *
 * Discovery is NOT an auth site. It never decides a status and never throws:
 * every failure, timeout or unrecognised body resolves to `undefined`
 * ("discovery-unknown"), and the caller stays on its non-code-mode default.
 *
 * Fallback, read-only: `~/.codex/models_cache.json`, the official Codex CLI's
 * own cache of the same endpoint (already read by
 * `auth/quota/sources/codex.ts`). It is consulted only while this process has
 * no good live answer for the account, and it also supplies `client_version`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import type { AuthBinding } from "./transport/types.js";

/** One model's dispatch flags, as `/models` publishes them. */
export interface CodexModelInfo {
  slug: string;
  toolMode?: string;
  useResponsesLite?: boolean;
  defaultReasoningLevel?: string;
  defaultVerbosity?: string;
  truncationPolicy?: { mode: string; limit: number };
  /**
   * The service tiers the account may request (`service_tiers`), e.g.
   * `{id: "priority", name: "Fast"}`. The `id` is the value Codex sends at the
   * request's top-level `service_tier`.
   */
  serviceTiers?: CodexServiceTier[];
  /** `default_service_tier`: the tier sent when the request names none. */
  defaultServiceTier?: string;
}

/** One entry of a model's `service_tiers`. */
export interface CodexServiceTier {
  id: string;
  name: string;
}

/**
 * A request default the Codex /models endpoint justifies. Empty today: the
 * B experiment found no request factor with a significant effect
 * (`ai-docs/reports/codex-parallel-wrapper-degeneration-2026-10.md`, Fisher
 * p = 1.000 for each). Plug point, should one ever be used:
 * `wireChoicesFromClaudeRequest` in composed-handler, as a default only when
 * Claude Code sent none, still clamped by step 5w. No call site ships.
 */
export interface CodexDiscoveryRules {
  /** From `defaultReasoningLevel`. */
  defaultEffort?: string;
}

/**
 * The `client_version` sent when `~/.codex/models_cache.json` names none: the
 * codex-cli version whose `/models` call R1 captured (0.161.0). The backend
 * filters models by `minimal_client_version`, so the value must be a real
 * client version; it is a protocol constant, not model data.
 */
export const CODEX_DISCOVERY_CLIENT_VERSION = "0.161.0";

/** How long a good answer is served before a refetch. */
export const CODEX_DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** Ceiling on one `/models` fetch. */
export const CODEX_DISCOVERY_FETCH_TIMEOUT_MS = 10_000;
/** How long a request with an empty memo waits for the fetch before going on. */
export const CODEX_DISCOVERY_DEFAULT_WAIT_MS = 2_000;
/**
 * After a failed fetch with no good answer to keep, the next fetch waits this
 * long, so an unreachable endpoint costs one attempt per minute rather than
 * one (and a 2 s wait) per request.
 */
const FAILURE_RETRY_AFTER_MS = 60 * 1000;

type ModelTable = Map<string, CodexModelInfo>;

interface MemoEntry {
  /** The last good live answer, and when it was fetched. */
  good?: { models: ModelTable; fetchedAt: number };
  /** The fetch in flight for this account (single-flight). */
  inflight?: Promise<ModelTable | undefined>;
  /** When the last fetch failed, while `good` was absent. */
  failedAt?: number;
}

/** Per-process memo, keyed by accountKey. Never written to disk. */
const memo = new Map<string, MemoEntry>();

export interface CodexDiscoveryOptions {
  /** Longest wait for a first fetch when the memo is empty. Default 2 s. */
  waitMs?: number;
  /** Test seam: default the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: default `Date.now`. */
  now?: () => number;
  /** Test seam: the Codex CLI home holding `models_cache.json`. Default `~/.codex`. */
  codexHome?: string;
}

/** Drop every memoised answer (tests; a changed login keys a new entry anyway). */
export function clearCodexModelsMemo(): void {
  memo.clear();
}

/**
 * The discovery URL for a binding: the binding's Responses endpoint with its
 * trailing `/responses` replaced by `/models?client_version=<v>`. Undefined
 * when the binding has no endpoint or the endpoint has no such suffix.
 */
export function codexModelsUrl(
  binding: AuthBinding | undefined,
  clientVersion: string
): string | undefined {
  const endpoint = binding?.auth?.endpoint;
  if (!endpoint) return undefined;
  const base = endpoint.replace(/\/+$/, "");
  if (!base.endsWith("/responses")) return undefined;
  const root = base.slice(0, -"/responses".length);
  return `${root}/models?client_version=${encodeURIComponent(clientVersion)}`;
}

function readModelsCache(codexHome: string | undefined): unknown {
  try {
    const path = join(codexHome ?? join(homedir(), ".codex"), "models_cache.json");
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function clientVersionFrom(cache: unknown): string {
  const v = (cache as { client_version?: unknown } | undefined)?.client_version;
  return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : CODEX_DISCOVERY_CLIENT_VERSION;
}

/** Map one raw `/models` entry to the fields claudish reads; undefined without a slug. */
function toModelInfo(raw: unknown): CodexModelInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const slug = typeof m.slug === "string" ? m.slug : undefined;
  if (!slug) return undefined;
  const info: CodexModelInfo = { slug };
  if (typeof m.tool_mode === "string") info.toolMode = m.tool_mode;
  if (typeof m.use_responses_lite === "boolean") info.useResponsesLite = m.use_responses_lite;
  if (typeof m.default_reasoning_level === "string") {
    info.defaultReasoningLevel = m.default_reasoning_level;
  }
  if (typeof m.default_verbosity === "string") info.defaultVerbosity = m.default_verbosity;
  const tp = m.truncation_policy as { mode?: unknown; limit?: unknown } | null | undefined;
  if (tp && typeof tp.mode === "string" && typeof tp.limit === "number") {
    info.truncationPolicy = { mode: tp.mode, limit: tp.limit };
  }
  if (Array.isArray(m.service_tiers)) {
    info.serviceTiers = m.service_tiers.flatMap((tier) => {
      const t = tier as { id?: unknown; name?: unknown } | null;
      return t && typeof t.id === "string" && typeof t.name === "string"
        ? [{ id: t.id, name: t.name }]
        : [];
    });
  }
  if (typeof m.default_service_tier === "string") info.defaultServiceTier = m.default_service_tier;
  return info;
}

/** `{models:[…]}` → slug-keyed table; undefined when the body is not that shape. */
function toModelTable(body: unknown): ModelTable | undefined {
  const models = (body as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(models)) return undefined;
  const table: ModelTable = new Map();
  for (const raw of models) {
    const info = toModelInfo(raw);
    if (info) table.set(info.slug.toLowerCase(), info);
  }
  return table;
}

/** The binding's headers with `accept: application/json` (any other-case Accept dropped). */
function discoveryHeaders(binding: AuthBinding): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(binding.auth?.headers ?? {})) {
    if (name.toLowerCase() === "accept") continue;
    headers[name] = value;
  }
  headers.accept = "application/json";
  return headers;
}

async function fetchModelTable(
  binding: AuthBinding,
  opts: CodexDiscoveryOptions
): Promise<ModelTable | undefined> {
  const url = codexModelsUrl(binding, clientVersionFrom(readModelsCache(opts.codexHome)));
  if (!url) {
    log("[CodexDiscovery] endpoint has no /responses suffix; tool_mode unknown");
    return undefined;
  }
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const response = await doFetch(url, {
      method: "GET",
      headers: discoveryHeaders(binding),
      signal: AbortSignal.timeout(CODEX_DISCOVERY_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      log(`[CodexDiscovery] GET /models answered HTTP ${response.status}`);
      return undefined;
    }
    const table = toModelTable(await response.json());
    if (!table) {
      log("[CodexDiscovery] GET /models body has no models array");
      return undefined;
    }
    log(`[CodexDiscovery] GET /models: ${table.size} model(s)`);
    return table;
  } catch (err) {
    log(`[CodexDiscovery] GET /models failed: ${err}`);
    return undefined;
  }
}

/** Start (or join) the account's fetch; settles the memo entry when it ends. */
function startFetch(
  entry: MemoEntry,
  binding: AuthBinding,
  opts: CodexDiscoveryOptions,
  now: () => number
): Promise<ModelTable | undefined> {
  if (entry.inflight) return entry.inflight;
  const p = fetchModelTable(binding, opts).then((table) => {
    if (table) {
      entry.good = { models: table, fetchedAt: now() };
      entry.failedAt = undefined;
    } else if (entry.good) {
      log("[CodexDiscovery] refetch failed; keeping the last good answer");
    } else {
      entry.failedAt = now();
    }
    return table ?? entry.good?.models;
  });
  entry.inflight = p.finally(() => {
    entry.inflight = undefined;
  });
  return entry.inflight;
}

/** `p`'s value, or `"timeout"` after `ms`; the timer never outlives the race. */
async function waitAtMost<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([p, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The empty-memo path: start (or join) the fetch and wait at most `waitMs`,
 * unless a recent failure is still backing off. Without a live answer in time,
 * the Codex CLI's cache.
 */
async function firstAnswer(
  entry: MemoEntry,
  slug: string,
  binding: AuthBinding,
  opts: CodexDiscoveryOptions,
  now: () => number
): Promise<CodexModelInfo | undefined> {
  const backingOff =
    entry.failedAt !== undefined && now() - entry.failedAt < FAILURE_RETRY_AFTER_MS;
  if (!backingOff || entry.inflight) {
    const waitMs = Math.max(0, opts.waitMs ?? CODEX_DISCOVERY_DEFAULT_WAIT_MS);
    const result = await waitAtMost(startFetch(entry, binding, opts, now), waitMs);
    // A live answer is authoritative: a model it does not list is unknown,
    // never filled in from the CLI's cache.
    if (result !== "timeout" && result) return result.get(slug.toLowerCase());
    if (result === "timeout" && slug) {
      log(`[CodexDiscovery] ${slug}: /models not answered within ${waitMs} ms`);
    }
  }
  return slug ? fromModelsCache(slug, opts.codexHome) : undefined;
}

/** The Codex CLI's cached answer for `slug`, when this process has no live one. */
function fromModelsCache(slug: string, codexHome: string | undefined): CodexModelInfo | undefined {
  const info = toModelTable(readModelsCache(codexHome))?.get(slug.toLowerCase());
  if (info) log(`[CodexDiscovery] ${slug}: using ~/.codex/models_cache.json`);
  return info;
}

/**
 * Start the account's `/models` fetch without waiting for it, so a later
 * tool-bearing request finds the memo warm. Meant for right after step 5b of an
 * `openai-codex` OAuth request (Claude Code's first request is usually
 * tool-less). Never throws.
 */
export function prefetchCodexModels(
  binding: AuthBinding,
  accountKey: string,
  opts: CodexDiscoveryOptions = {}
): void {
  void getCodexModelInfo("", binding, accountKey, { ...opts, waitMs: 0 }).catch(() => {});
}

/**
 * The `/models` entry for `slug` on the account `accountKey` names, fetched
 * with `binding` (this request's OAuth artifact).
 *
 *  - fresh memo → answered from it;
 *  - stale memo → answered from it while one refetch runs (stale-while-error
 *    keeps it if that refetch fails);
 *  - empty memo → the fetch is started (or joined) and awaited at most
 *    `waitMs` (default 2 s); past that, `undefined` now and the memo fills
 *    for the next request.
 * With no good live answer, `~/.codex/models_cache.json` is consulted.
 * `undefined` = unknown. Never throws.
 */
export async function getCodexModelInfo(
  slug: string,
  binding: AuthBinding,
  accountKey: string,
  opts: CodexDiscoveryOptions = {}
): Promise<CodexModelInfo | undefined> {
  try {
    const now = opts.now ?? Date.now;
    let entry = memo.get(accountKey);
    if (!entry) {
      entry = {};
      memo.set(accountKey, entry);
    }

    if (entry.good) {
      if (now() - entry.good.fetchedAt >= CODEX_DISCOVERY_TTL_MS) {
        void startFetch(entry, binding, opts, now);
      }
      return entry.good.models.get(slug.toLowerCase());
    }
    return await firstAnswer(entry, slug, binding, opts, now);
  } catch (err) {
    log(`[CodexDiscovery] lookup failed: ${err}`);
    return undefined;
  }
}
