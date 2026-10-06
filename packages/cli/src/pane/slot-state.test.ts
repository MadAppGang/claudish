import { describe, expect, test } from "bun:test";
import { SLOT_STATES, TERMINAL_STATES } from "./contract.js";
import {
  PHASES,
  type Phase,
  type PhaseEvent,
  TERMINAL_PHASES,
  TRANSITIONS,
  nextPhase,
  wireState,
} from "./slot-state.js";

const ALL_EVENTS: PhaseEvent[] = [
  "boot_ready_idle",
  "boot_ready_admit",
  "boot_dialog",
  "boot_blocked",
  "boot_deadline",
  "admit",
  "prompt_accepted",
  "admit_deadline",
  "admit_abandoned",
  "blocked_question",
  "blocked_permission",
  "unblocked",
  "turn_continue",
  "rewake",
  "verdict_completed",
  "verdict_empty",
  "verdict_failed",
  "exit_clean",
  "pane_exit",
  "pane_lost",
  "cancel",
  "timeout",
];

describe("slot-state transition table (§5)", () => {
  const legal: Array<[Phase, PhaseEvent, Phase]> = [
    ["BOOTING", "boot_ready_idle", "IDLE"],
    ["BOOTING", "boot_ready_admit", "ADMITTING"],
    ["BOOTING", "boot_dialog", "FAILED"],
    ["BOOTING", "boot_blocked", "FAILED"],
    ["BOOTING", "boot_deadline", "FAILED"],
    ["ADMITTING", "prompt_accepted", "RUNNING"],
    ["ADMITTING", "admit_deadline", "FAILED"],
    ["ADMITTING", "admit_abandoned", "IDLE"],
    ["RUNNING", "blocked_question", "QUESTION"],
    ["RUNNING", "blocked_permission", "PERMISSION"],
    ["RUNNING", "turn_continue", "IDLE"],
    ["RUNNING", "verdict_completed", "COMPLETED"],
    ["RUNNING", "verdict_empty", "EMPTY"],
    ["RUNNING", "verdict_failed", "FAILED"],
    ["IDLE", "admit", "ADMITTING"],
    ["IDLE", "rewake", "RUNNING"],
    ["IDLE", "exit_clean", "COMPLETED"],
    ["QUESTION", "unblocked", "RUNNING"],
    ["QUESTION", "verdict_failed", "FAILED"],
    ["PERMISSION", "unblocked", "RUNNING"],
    ["PERMISSION", "verdict_failed", "FAILED"],
  ];
  for (const [from, ev, to] of legal) {
    test(`${from} --${ev}--> ${to}`, () => expect(nextPhase(from, ev)).toBe(to));
  }

  test("every live phase accepts pane_exit, pane_lost, cancel and timeout", () => {
    for (const p of PHASES.filter((x) => !TERMINAL_PHASES.includes(x))) {
      expect(nextPhase(p, "pane_exit")).toBe("FAILED");
      expect(nextPhase(p, "pane_lost")).toBe("FAILED");
      expect(nextPhase(p, "cancel")).toBe("CANCELLED");
      expect(nextPhase(p, "timeout")).toBe("TIMEOUT");
    }
  });

  test("terminals absorb every event (a late exit never overturns CANCELLED or TIMEOUT)", () => {
    for (const p of TERMINAL_PHASES)
      for (const ev of ALL_EVENTS) expect(nextPhase(p, ev)).toBeNull();
  });

  test("an edge missing from the table is illegal (null), never a throw", () => {
    expect(nextPhase("BOOTING", "prompt_accepted")).toBeNull();
    expect(nextPhase("IDLE", "verdict_completed")).toBeNull();
    expect(nextPhase("QUESTION", "blocked_permission")).toBeNull();
    expect(nextPhase("PERMISSION", "blocked_question")).toBeNull();
    expect(nextPhase("RUNNING", "admit")).toBeNull();
  });

  test("the table has exactly the listed legal edges plus the four any-live edges", () => {
    let count = 0;
    for (const p of PHASES) count += Object.keys(TRANSITIONS[p]).length;
    expect(count).toBe(legal.length + 4 * 6);
  });

  test("no wait turns into another wait: no QUESTION/PERMISSION/IDLE edge between them", () => {
    const waits: Phase[] = ["IDLE", "QUESTION", "PERMISSION"];
    for (const a of waits)
      for (const ev of ALL_EVENTS) {
        const b = nextPhase(a, ev);
        if (b && b !== a) expect(waits.includes(b)).toBe(false);
      }
  });
});

describe("wireState", () => {
  test("maps every phase into the closed nine-state set", () => {
    for (const p of PHASES) {
      expect(SLOT_STATES).toContain(wireState(p, true));
      expect(SLOT_STATES).toContain(wireState(p, false));
    }
  });

  test("BOOTING is STARTING; ADMITTING is STARTING only for the initial delivery (X-M1)", () => {
    expect(wireState("BOOTING", false)).toBe("STARTING");
    expect(wireState("ADMITTING", true)).toBe("STARTING");
    expect(wireState("ADMITTING", false)).toBe("RUNNING");
  });

  test("a promptless session's first send goes AWAITING_INPUT → RUNNING, never back to STARTING", () => {
    const idle = wireState("IDLE", false);
    const admitting = wireState(nextPhase("IDLE", "admit")!, false);
    expect([idle, admitting]).toEqual(["AWAITING_INPUT", "RUNNING"]);
  });

  test("IDLE and QUESTION are AWAITING_INPUT, PERMISSION is AWAITING_PERMISSION, terminals map to themselves", () => {
    expect(wireState("RUNNING", false)).toBe("RUNNING");
    expect(wireState("IDLE", false)).toBe("AWAITING_INPUT");
    expect(wireState("QUESTION", false)).toBe("AWAITING_INPUT");
    expect(wireState("PERMISSION", false)).toBe("AWAITING_PERMISSION");
    for (const p of TERMINAL_PHASES) expect<string>(wireState(p, false)).toBe(p);
    expect<string[]>([...TERMINAL_PHASES].sort()).toEqual([...TERMINAL_STATES].sort());
  });
});
