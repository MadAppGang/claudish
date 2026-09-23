/**
 * Control tests for the env gate itself (#175): both gate directions must hold
 * in the same run — an inactive class registers, skips loudly and never runs
 * its body; an active class executes its body for real. The registry must
 * count every gated test.
 *
 * `active` here is a CONSTANT on purpose: these tests exercise the gate
 * mechanism, not a machine property — the doctrine "active must be a measured
 * probe" applies to real gated classes, not to the gate's own controls.
 */
import { describe, test, expect } from "bun:test";
import { envDescribe } from "./env-gate";

let activeRan = false;

envDescribe(
  {
    id: "ctl-inactive",
    active: false,
    reason: "control: condition false",
    activation: "control: never",
  },
  "control inactive class"
)((test) => {
  test("inactive class body must NOT run", () => {
    throw new Error("gate failed closed: body of an inactive class executed");
  });
});

envDescribe(
  {
    id: "ctl-active",
    active: true,
    reason: "control: condition true",
    activation: "control: always",
  },
  "control active class"
)((test) => {
  test("active class runs its body", () => {
    activeRan = true;
    expect(1 + 1).toBe(2);
  });
});

describe("env-gate controls", () => {
  // Both envDescribe calls above are registered at module top level, so their
  // tests have already executed by the time this describe runs (declaration
  // order) — registering a gated class INSIDE a test would invert that order,
  // which is the exact hazard these controls pin.
  test("active class actually ran its body", () => {
    expect(activeRan).toBe(true);
  });

  test("registry holds both classes with counted tests", () => {
    const reg = (globalThis as { __claudishEnvGate?: Array<{ cls: { id: string }; testNames: string[] }> }).__claudishEnvGate ?? [];
    const ids = reg.map((e) => `${e.cls.id}:${e.testNames.length}`);
    expect(ids).toContain("ctl-inactive:1");
    expect(ids).toContain("ctl-active:1");
  });
});
