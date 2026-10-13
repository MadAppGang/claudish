/**
 * Layer 4: Behavior Compatibility Layer.
 *
 * Public surface. See types.ts for why this layer exists.
 */

import { loadConfig } from "../profile-config.js";
import { parseBehaviorConfig } from "./config.js";
import { BehaviorEngine } from "./engine.js";
import { PLAN_MODE_RULES } from "./rules/plan-mode.js";
import { SESSION_CONTEXT_RULES } from "./rules/session-context.js";
import type { BehaviorRule } from "./types.js";

export { BehaviorEngine, BehaviorSession } from "./engine.js";
export { parseBehaviorConfig, resolveSeverity } from "./config.js";
export { detectHarnessFacts } from "../hooks/harness.js";
export { loadHookRules } from "./hooks.js";
export { buildDigest } from "../hooks/observer/digest.js";
export type { ObserverDigest } from "../hooks/observer/digest.js";
export { observe, resetObserverModelCache } from "../hooks/observer/client.js";
export type { ObserverVerdict } from "../hooks/observer/client.js";
export { buildCorpus, replayTranscript } from "../hooks/observer/corpus.js";
export type { CorpusResult, Divergence } from "../hooks/observer/corpus.js";
export {
  TELEMETRY_SCHEMA_VERSION,
  contextFillPct,
  contextBucket,
  outboxPath,
  pendingReports,
  recordTelemetryDecision,
  recordTelemetryTurn,
  resetTelemetryState,
  setSessionContextWindow,
  setTelemetryConsent,
  spoolPendingSync,
} from "../hooks/telemetry/aggregate.js";
export type { ContextBucket, SessionReport } from "../hooks/telemetry/aggregate.js";
export { drainOutbox, resetDrainState } from "../hooks/telemetry/upload.js";
export type {
  BehaviorConfig,
  BehaviorContext,
  BehaviorRule,
  HarnessFacts,
  RuleAction,
  Severity,
  ToolCallContext,
} from "./types.js";

/** Rules shipped with claudish. User hooks are appended to these at load time. */
export const BUILTIN_RULES: BehaviorRule[] = [...PLAN_MODE_RULES, ...SESSION_CONTEXT_RULES];

/**
 * Build an engine from a raw config value (the `behavior` key of the merged
 * claudish config). Invalid config degrades to defaults rather than throwing —
 * a behavior layer that can stop claudish from starting is worse than no layer.
 */
export function createBehaviorEngine(rawConfig: unknown, extraRules: BehaviorRule[] = []) {
  return new BehaviorEngine(parseBehaviorConfig(rawConfig), [...BUILTIN_RULES, ...extraRules]);
}

let sharedEngine: BehaviorEngine | null = null;
let hookRules: BehaviorRule[] = [];

/**
 * Process-wide engine. Memoized because the engine is stateless (all per-request
 * state lives on a BehaviorSession) and ComposedHandler is constructed once per
 * model — re-reading and re-validating the config for each one would be waste.
 */
export function getBehaviorEngine(): BehaviorEngine {
  if (!sharedEngine) {
    sharedEngine = createBehaviorEngine(loadConfig().behavior, hookRules);
  }
  return sharedEngine;
}

/**
 * Register rules loaded from user hook modules. Must run before the first
 * `getBehaviorEngine()` call; the loader is invoked during startup.
 */
export function registerHookRules(rules: BehaviorRule[]): void {
  hookRules = [...hookRules, ...rules];
  sharedEngine = null;
}

/** Test seam: drop the memoized engine so the next call re-reads config. */
export function resetBehaviorEngine(): void {
  sharedEngine = null;
  hookRules = [];
}
