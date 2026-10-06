/**
 * Tokens, cost, tool calls and provider for one pane (architecture §2.12, M6, M11).
 *
 * The proxy's token file is authoritative when it carries data (a foreign route writes
 * it as it serves). A native route writes no token data (research §2.5: the file stays
 * at its initialised zeros), so tokens and tool calls then come from the transcript and
 * `cost_usd` stays null: Claude Code's own `cost-state` prices at API rates, which is
 * fictional spend for a subscription user (D12).
 */

import { statSync } from "node:fs";
import { parseModelChain, parseModelSpec } from "../providers/model-parser.js";
import { nativeRouteFor } from "../providers/native-route.js";
import { getProviderByName } from "../providers/provider-definitions.js";
import { type ModelTokenStats, readTokenStatsAt } from "../team-stats.js";
import type { PaneSnapshot } from "./types.js";

export type TokenFileStats = ModelTokenStats;

const cache = new Map<string, { mtimeMs: number; size: number; stats: TokenFileStats | null }>();

/** `readTokenStatsAt`, re-read only when the file's mtime or size changed. */
export function readTokenFileCached(path: string): TokenFileStats | null {
  let st: { mtimeMs: number; size: number };
  try {
    const s = statSync(path);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    cache.delete(path);
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.stats;
  const stats = readTokenStatsAt(path);
  // A mid-write read returns null; do not cache it, the next tick retries.
  if (stats) cache.set(path, { ...st, stats });
  return stats;
}

/** The token file carries real data: the proxy served at least one request. */
export function tokenFileHasData(t: TokenFileStats | null): t is TokenFileStats {
  return !!t && (!!t.provider_name || (t.total_tokens ?? 0) > 0);
}

export interface Accounting {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  toolCalls: number;
  provider: string | null;
}

export function mergeAccounting(
  snap: Pick<PaneSnapshot, "tokensIn" | "tokensOut" | "toolCalls">,
  tokenFile: TokenFileStats | null,
  ids: { model: string; spawnModel: string | null } | null = null
): Accounting {
  const provider = ids
    ? resolveProvider({ model: ids.model, spawnModel: ids.spawnModel, tokenFile })
    : (tokenFile?.provider_name ?? null);
  if (tokenFileHasData(tokenFile)) {
    const toolCalls = (tokenFile.tool_calls ?? []).reduce((n, t) => n + (t.count ?? 0), 0);
    return {
      // billed_input_tokens is the cumulative input; input_tokens is the CURRENT context.
      tokensIn: tokenFile.billed_input_tokens ?? null,
      tokensOut: tokenFile.output_tokens ?? null,
      costUsd: typeof tokenFile.total_cost === "number" ? tokenFile.total_cost : null,
      toolCalls,
      provider,
    };
  }
  return {
    tokensIn: snap.tokensIn,
    tokensOut: snap.tokensOut,
    costUsd: null,
    toolCalls: snap.toolCalls,
    provider,
  };
}

/** `provider@model`, a single hop only; null for a bare name or a `+` chain. */
export function parsePinnedSpec(
  spawnModel: string | null
): { provider: string; model: string } | null {
  if (!spawnModel) return null;
  if (parseModelChain(spawnModel).length !== 1) return null;
  if (!/^[^@]+@.+$/.test(spawnModel)) return null;
  const p = parseModelSpec(spawnModel);
  return p.isExplicitProvider ? { provider: p.provider, model: p.model } : null;
}

/**
 * Display name of the claudish provider serving the slot. The token file is
 * observation, not routing; `nativeRouteFor` runs before any route lookup (CLAUDE.md
 * invariant); a pinned spec names its provider; anything else is not known yet.
 */
export function resolveProvider(input: {
  model: string;
  spawnModel: string | null;
  tokenFile: TokenFileStats | null;
}): string | null {
  if (input.tokenFile?.provider_name) return input.tokenFile.provider_name;
  const native = nativeRouteFor(input.model);
  if (native) return getProviderByName("native-anthropic")?.displayName ?? native.displayName;
  const pinned = parsePinnedSpec(input.spawnModel);
  if (pinned) return getProviderByName(pinned.provider)?.displayName ?? pinned.provider;
  return null;
}
