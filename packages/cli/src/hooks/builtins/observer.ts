/**
 * Built-in hook `observer/divergence`: the local advisory observer.
 *
 * A small LOCAL model (hooks/observer/client.ts) is asked whether a tool call
 * the model just made violates one of claudish's conformance rules. It sees a
 * digest — tool names, harness facts, the call's argument keys and path-like
 * values — never conversation text. Its verdict lands in the divergence log
 * (`~/.claudish/behavior-divergences.jsonl`), the input for rules that do not
 * exist yet.
 *
 * An observe-mode `toolCall` hook: it never holds the stream and can only warn,
 * so turning the observer on no longer suppresses incremental delivery of
 * `Write` content, as the behavior layer's buffering did. The consultation is
 * fire-and-forget: the handler returns at once, and the observer keeps its own
 * timeout (`hooks.observer.timeoutMs`), so a slow local model never counts as a
 * hook timeout.
 *
 * Off unless `hooks.observer.enabled` is true and the mode is not `off`.
 * `enforce` is rejected by the config schema: the observer is advisory.
 */

import { log } from "../../logger.js";
import type { HooksConfig } from "../config.js";
import { observe } from "../observer/client.js";
import { buildDigest } from "../observer/digest.js";
import { recordLiveDivergence } from "../observer/live-log.js";
import type { ToolCallAction, ToolCallContext } from "../public.js";
import type { BuiltinHook } from "../registry.js";

export const OBSERVER_HOOK_ID = "observer/divergence";

/** Watched when `hooks.observer.watchTools` is not set (unchanged from the behavior layer). */
export const DEFAULT_WATCH_TOOLS: ReadonlyArray<string> = [
  "Write",
  "Edit",
  "NotebookEdit",
  "ExitPlanMode",
];

/** True when the config turns the observer on. */
export function observerEnabled(config: Pick<HooksConfig, "observer">): boolean {
  return config.observer?.enabled === true && (config.observer.mode ?? "suggest") !== "off";
}

/** Ask the observer about one delivered call. Advisory only: never throws, never awaited by the seam. */
async function consult(
  config: Pick<HooksConfig, "observer">,
  ruleVocabulary: ReadonlyArray<string>,
  ctx: ToolCallContext
): Promise<void> {
  try {
    const digest = buildDigest({
      model: ctx.route.modelId,
      toolNames: ctx.request.tools.map((t) => t.name),
      harness: { ...ctx.harness },
      ruleVocabulary: [...ruleVocabulary],
      call: { name: ctx.tool.name, args: { ...ctx.tool.args } },
    });
    const verdict = await observe(digest, config);
    if (!verdict?.ruleId) return;
    log(
      `[hooks:observer] flagged ${ctx.tool.name} as ${verdict.ruleId} ` +
        `(confidence ${verdict.confidence})${verdict.note ? `: ${verdict.note}` : ""}`
    );
    await recordLiveDivergence({
      source: "observer",
      ts: new Date().toISOString(),
      model: ctx.route.modelId,
      toolName: ctx.tool.name,
      ruleId: verdict.ruleId,
      confidence: verdict.confidence,
      note: verdict.note,
      paths: digest.proposedCall?.paths,
    });
  } catch (err) {
    log(`[hooks:observer] consult failed: ${err}`);
  }
}

/**
 * The observer built-in for one config. `ruleVocabulary` is the rule ids the
 * observer may name (every other built-in's id); anything else it returns is a
 * hallucination and is discarded.
 */
export function createObserverHook(
  config: Pick<HooksConfig, "observer">,
  ruleVocabulary: ReadonlyArray<string>
): BuiltinHook {
  return {
    apiVersion: 1,
    id: OBSERVER_HOOK_ID,
    description:
      "Ask a small local model whether a delivered tool call breaks a conformance rule; " +
      "log its verdict. Advisory, off by default (hooks.observer).",
    defaultSeverity: "fix",
    // The measured divergences are foreign models'; native Claude honours
    // Claude Code's conventions itself.
    routes: "foreign",
    on: {
      toolCall: {
        tools: config.observer?.watchTools ?? DEFAULT_WATCH_TOOLS,
        observe: true,
        armed: () => observerEnabled(config),
        handle(ctx: ToolCallContext): ToolCallAction[] {
          void consult(config, ruleVocabulary, ctx);
          return [];
        },
      },
    },
  };
}
