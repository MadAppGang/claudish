/**
 * Harness session-event layer — shared types.
 *
 * Claude Code records session state transitions (ultracode enter/exit, effort
 * changes) in its session transcript (~/.claude/projects/<slug>/<sid>.jsonl)
 * that never reach the wire. This layer tails the transcript, translates the
 * harness-internal records into the typed events below, and folds them into
 * per-session state that claudish consults at request time.
 *
 * The transcript format is Anthropic-internal and may drift between Claude
 * Code versions — every consumer must treat unknown shapes as `unknown`
 * (forward-compat passthrough) and unknown state as "no injection".
 */

/** Where an effort change applies: this session only, or the persisted default. */
export type EffortScope = "session" | "default";

/**
 * A translated harness event. Future event kinds (model_switch, …) are one
 * union member + one reducer case.
 */
export type HarnessEvent =
  | { kind: "ultra_effort_enter"; at?: string }
  | { kind: "ultra_effort_exit"; at?: string }
  | { kind: "effort_changed"; level: string; scope: EffortScope; at?: string }
  | { kind: "unknown"; attachmentType?: string; at?: string };

/** Folded per-session state. File order is authoritative; timestamps informational. */
export interface SessionEventState {
  /** True between ultra_effort_enter and ultra_effort_exit (or pre-armed by effort_changed(ultracode)). */
  ultracodeActive: boolean;
  /** Most recent effort level seen in this session (verbatim, e.g. "high", "ultracode"). */
  effort?: string;
  /** Scope of the most recent effort change. */
  effortScope?: EffortScope;
  /** Persisted default effort (settings.json seed, updated by scope==="default" changes). */
  defaultEffort?: string;
  /** Where the initial state came from. */
  seededFrom: "settings" | "none";
  /** Timestamp of the last folded event (informational only). */
  lastEventAt?: string;
}
