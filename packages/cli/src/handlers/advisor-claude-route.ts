/**
 * Where an advisor call to Claude goes, and which Anthropic model id a Claude
 * name sent there stands for.
 *
 * A leaf: it reads the catalog lookups and Claude Code's alias vocabulary
 * (`claude-code-aliases.ts`) and nothing from the advisor or the proxy, so the
 * startup planner, the advisor call path and `NativeHandler` can all import it
 * without a cycle.
 *
 * No model id is pinned here. A tier alias (`haiku`) resolves through two live
 * sources: the catalog's own alias table, then the newest `claude-<tier>-*` id
 * the catalog lists (the rule `--probe` uses). A concrete `claude-*` id is
 * passed through as written, because the API may serve a model newer than the
 * catalog.
 */

import { latestAnthropicTierModelId } from "../providers/catalog-client.js";
import { findEntryByAlias } from "../providers/catalog-query.js";

/** The Anthropic API origin. `NativeHandler` forwards to it; the advisor calls it. */
export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";

/** The Messages endpoint every advisor call to Claude is POSTed to. */
export const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_API_ORIGIN}/v1/messages`;

/** The host of {@link ANTHROPIC_API_ORIGIN}, for notices and records. */
export const ANTHROPIC_API_HOST = new URL(ANTHROPIC_API_ORIGIN).host;

/** Why a Claude name cannot be sent to the API as a model id. */
export type ClaudeAdvisorModelRefusal = "unresolved-alias";

/** The Anthropic model id a Claude name stands for, or why there is none. */
export type ClaudeAdvisorModel =
  | { refused: false; id: string }
  | { refused: true; cause: ClaudeAdvisorModelRefusal; alias: string };

/**
 * The Claude Code TIER an advisor spec names as a bare alias (`haiku`), or null
 * for anything already spelled as a model id (`claude-haiku-4-5`). Only an
 * alias needs resolving; an id is passed through as the user wrote it.
 */
function anthropicTierAlias(model: string): "opus" | "sonnet" | "haiku" | null {
  const m = model.toLowerCase();
  return m === "opus" || m === "sonnet" || m === "haiku" ? m : null;
}

/**
 * The Anthropic model id for a Claude name (the model part of the spec, with
 * any `anthropic@` already removed).
 *
 * The alias itself is never the answer. It used to fall through as `?? model`,
 * so the default collector POSTed the literal `haiku` to api.anthropic.com,
 * which rejects it, after the notice had told the user
 * `haiku -> api.anthropic.com (ANTHROPIC_API_KEY, billed per token)`.
 */
export function claudeAdvisorModelFor(model: string): ClaudeAdvisorModel {
  const tier = anthropicTierAlias(model);
  if (!tier) return { refused: false, id: model };
  const resolved = findEntryByAlias(model)?.modelId ?? latestAnthropicTierModelId(tier);
  return resolved
    ? { refused: false, id: resolved }
    : { refused: true, cause: "unresolved-alias", alias: model };
}
