/**
 * Per-session state reducer — pure, never throws.
 *
 * File order is authoritative (events fold in the order they appear in the
 * transcript); timestamps are informational only.
 */

import type { HarnessEvent, SessionEventState } from "./types.js";

/** Fresh state, optionally seeded from ~/.claude/settings.json `effortLevel`. */
export function initialState(seed?: { defaultEffort?: string }): SessionEventState {
  if (seed?.defaultEffort) {
    return {
      ultracodeActive: false,
      effort: seed.defaultEffort,
      defaultEffort: seed.defaultEffort,
      seededFrom: "settings",
    };
  }
  return { ultracodeActive: false, seededFrom: "none" };
}

/** Fold one event into state. Unknown events only touch lastEventAt. */
export function reduceEvent(state: SessionEventState, event: HarnessEvent): SessionEventState {
  const next: SessionEventState = { ...state, lastEventAt: event.at ?? state.lastEventAt };
  switch (event.kind) {
    case "ultra_effort_enter":
      next.ultracodeActive = true;
      return next;
    case "ultra_effort_exit":
      next.ultracodeActive = false;
      return next;
    case "effort_changed":
      next.effort = event.level;
      next.effortScope = event.scope;
      // Pre-arm on `/effort ultracode` (the stdout line lands ~8ms before the
      // ultra_effort_enter attachment — belt-and-braces for that window);
      // any other level clears it.
      next.ultracodeActive = event.level === "ultracode";
      if (event.scope === "default") next.defaultEffort = event.level;
      return next;
    default:
      return next;
  }
}
