/**
 * Loud environment gate for test classes whose prerequisites are absent on
 * the running machine (issue: "test suite: partition the environment-dependent
 * failures and make the dependency LOUD").
 *
 * Doctrine (learned the hard way): a SILENT skip is worse than a missing test —
 * it fabricates a green line. Every gated class announces itself when its host
 * file finishes, naming each skipped test, with its reason and its activation
 * condition, visible in the output. No test disappears unnamed.
 *
 * Usage:
 *   import { envDescribe } from "../test-support/env-gate";
 *   envDescribe({
 *     id: "posix-path-shim",
 *     active: process.platform !== "win32",
 *     reason: "win32 cannot execute the #!/bin/sh PATH shim",
 *     activation: "run on a POSIX host, or port the shim to a .cmd file",
 *   })((test) => {
 *     test("...", () => { ... });   // scoped `test`, counted by the manifest
 *   });
 *
 * Strict mode (CI): CLAUDISH_TEST_ENV_STRICT=1 turns every inactive class into
 * a FAILING test (so "all green" can never hide a machine that quietly skipped
 * its way to zero), unless the class is allowlisted in CLAUDISH_TEST_ENV_ALLOW
 * (comma-separated ids).
 */
import { describe, test as bunTest, expect, afterAll } from "bun:test";
import { writeSync } from "node:fs";

export interface EnvGateClass {
  /** stable kebab-case id, allowlistable via CLAUDISH_TEST_ENV_ALLOW */
  id: string;
  /** measured condition — must be a real probe, never a constant */
  active: boolean;
  /** why the class cannot run here (stated as fact, machine-level) */
  reason: string;
  /** what would make it run */
  activation: string;
}

interface GateEntry {
  cls: EnvGateClass;
  testNames: string[];
}

// Registry on globalThis: bun runs all test files in one process, and a module
// imported from several files must share one registry for the exit manifest.
const G = globalThis as typeof globalThis & { __claudishEnvGate?: GateEntry[] };
const registry: GateEntry[] = (G.__claudishEnvGate ??= []);

export function envDescribe(cls: EnvGateClass, label = "") {
  const strict = process.env.CLAUDISH_TEST_ENV_STRICT === "1";
  const allow = (process.env.CLAUDISH_TEST_ENV_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const entry: GateEntry = { cls, testNames: [] };
  registry.push(entry);
  // Manifest timing: `bun test` does NOT run process-exit handlers (measured:
  // writeSync(2) in an exit hook prints under `bun -e`, never under `bun test`)
  // — so each gated class announces itself in an afterAll of its host file.
  // Loud, named, counted, with reason and activation condition — that is the
  // doctrine; a consolidated single end-of-run block is impossible under bun.
  afterAll(() => {
    if (!cls.active) printEntry(entry);
  });

  const host = strict && !cls.active && !allow.includes(cls.id)
    ? describe   // strict: inactive classes REGISTER (and their tests FAIL below)
    : cls.active
      ? describe
      : describe.skip;

  return (fn: (test: typeof bunTest) => void) => {
    host(label ? `[env:${cls.id}] ${label}` : `[env:${cls.id}]`, () => {
      const scoped = ((name: string, fn?: any, timeout?: number) => {
        entry.testNames.push(name);
        if (!cls.active && strict && !allow.includes(cls.id)) {
          // Loud by failing — the manifest explains the rest.
          return bunTest(name, () => {
            expect.unreachable(
              `[env-gate:${cls.id}] prerequisite absent on this machine — ${cls.reason} (activation: ${cls.activation}). ` +
                `Allow explicitly via CLAUDISH_TEST_ENV_ALLOW=${cls.id} or run on a machine that meets the condition.`
            );
          }, timeout);
        }
        return bunTest(name, fn, timeout);
      }) as typeof bunTest;
      fn(scoped);
    });
  };
}

function printEntry(entry: GateEntry): void {
  // fs.writeSync(2): synchronous fd write, immune to stream teardown — the
  // reliable channel for a message that must survive the reporter.
  const out = (line: string) => {
    try {
      writeSync(2, `\x1b[33m${line}\x1b[0m\n`);
    } catch {
      /* never let the manifest break a run */
    }
  };
  out("");
  out(`[ENV-GATE] ${entry.testNames.length} test(s) NOT executed — class '${entry.cls.id}':`);
  for (const name of entry.testNames) out(`[ENV-GATE]   · ${name}`);
  out(`[ENV-GATE]   reason: ${entry.cls.reason}`);
  out(`[ENV-GATE]   activation: ${entry.cls.activation}`);
  out(`[ENV-GATE]   (expected on machines missing prerequisites; a complete machine runs them all; CLAUDISH_TEST_ENV_STRICT=1 fails them instead)`);
}
