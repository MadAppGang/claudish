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
import {
  CLAUDE_CODE_MODEL_ALIASES,
  ONE_MILLION_CONTEXT_SUFFIX,
  claudeCodeTierAlias,
} from "../providers/claude-code-aliases.js";

/** The Anthropic API origin. `NativeHandler` forwards to it; the advisor calls it. */
export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";

/** The Messages endpoint every advisor call to Claude is POSTed to. */
export const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_API_ORIGIN}/v1/messages`;

/** The host of {@link ANTHROPIC_API_ORIGIN}, for notices and records. */
export const ANTHROPIC_API_HOST = new URL(ANTHROPIC_API_ORIGIN).host;

/**
 * Why a Claude name cannot be sent to the API as a model id.
 *
 * - `claude-selector`: a Claude Code selector that names no single model the
 *   API accepts (`opusplan`, `best`, any `[1m]` form).
 * - `unresolved-alias`: a tier alias the catalog holds no id for (it is cold
 *   or has never been fetched).
 */
export type ClaudeAdvisorModelRefusal = "claude-selector" | "unresolved-alias";

/** The Anthropic model id a Claude name stands for, or why there is none. */
export type ClaudeAdvisorModel =
  | { refused: false; id: string }
  | { refused: true; cause: ClaudeAdvisorModelRefusal; alias: string; reason: string };

function selectorRefusal(alias: string, reason: string): ClaudeAdvisorModel {
  return { refused: true, cause: "claude-selector", alias, reason };
}

/**
 * The Anthropic model id for a Claude name (the model part of the spec, with
 * any `anthropic@` already removed), over every name native recognition
 * admits (`isClaudeCodeModelName`):
 *
 * | Name (trimmed, case-insensitive)        | Outcome                                    |
 * |-----------------------------------------|--------------------------------------------|
 * | ends with `[1m]`                        | refused: the API takes no `[1m]` in an id  |
 * | a tier alias (`opus`, `sonnet`, `haiku`, and `internal`/`default` → `opus`) | the tier's id from the catalog, else refused `unresolved-alias` |
 * | `opusplan`                              | refused: it switches tier with the mode    |
 * | `best`                                  | refused: Claude Code's own rating          |
 * | any other Claude Code alias             | refused (a guard: an alias added later)    |
 * | anything else (a `claude-*` id)         | passed through as written                  |
 *
 * The alias itself is never the answer. It used to fall through as `?? model`,
 * so the default collector POSTed the literal `haiku` to api.anthropic.com,
 * which rejects it, after the notice had told the user
 * `haiku -> api.anthropic.com (ANTHROPIC_API_KEY, billed per token)`.
 */
export function claudeAdvisorModelFor(model: string): ClaudeAdvisorModel {
  const normalized = model.trim().toLowerCase();

  if (normalized.endsWith(ONE_MILLION_CONTEXT_SUFFIX)) {
    return selectorRefusal(
      model,
      `"${model}" uses Claude Code's 1M-context selector, which Claude Code applies and the ` +
        `Anthropic API does not accept in a model id; name the model without "${ONE_MILLION_CONTEXT_SUFFIX}".`
    );
  }

  const tier = claudeCodeTierAlias(normalized);
  if (tier) {
    // The TIER's alias, not the name: `internal` and `default` select the opus
    // tier, and the catalog's alias table knows the tier.
    const resolved = findEntryByAlias(tier)?.modelId ?? latestAnthropicTierModelId(tier);
    if (resolved) return { refused: false, id: resolved };
    return {
      refused: true,
      cause: "unresolved-alias",
      alias: model,
      reason:
        `"${model}" is a claudish alias, not a model id ${ANTHROPIC_API_HOST} accepts, and the ` +
        "model catalog holds no id for it, so claudish refused to send it. Name the model by its " +
        "full model id, or refresh the catalog (`claudish --models-refresh`).",
    };
  }

  if (normalized === "opusplan") {
    return selectorRefusal(
      model,
      `"${model}" switches tier with Claude Code's mode, so it names no single model; name a ` +
        "tier (opus, sonnet, haiku) or a model id."
    );
  }
  if (normalized === "best") {
    return selectorRefusal(
      model,
      `"${model}" is Claude Code's own choice of model and claudish has no source for it; name ` +
        "a tier or a model id."
    );
  }
  if ((CLAUDE_CODE_MODEL_ALIASES as readonly string[]).includes(normalized)) {
    return selectorRefusal(
      model,
      `"${model}" is a Claude Code selector, not a model id the Anthropic API accepts; name a ` +
        "tier (opus, sonnet, haiku) or a model id."
    );
  }

  return { refused: false, id: model };
}
