/**
 * The tier-1 deadline and the two switches.
 *
 * THE DEADLINE IS THE SHARPEST REQUIREMENT IN THIS PHASE, and it is a
 * DERIVATION rather than a constant. Phase 0 measured Claude Code's client
 * abort against a custom base URL at 359.607 s and then PROVED that the number
 * is `API_TIMEOUT_MS`'s 360 000 ms default rather than a fixed watchdog, by
 * setting the variable to 20 000 and observing six aborts at exactly 20.000 s.
 *
 * So a user who has set `API_TIMEOUT_MS=60000` has a client that gives up at
 * 60 s. Hold their request for a deadline derived from the DEFAULT and every
 * episode ends in `client_gone`: recovery never engages, on that machine,
 * silently, forever, with nothing printed anywhere. That is the failure this
 * file exists to make impossible, and it is why the first test asserts the
 * value MOVES with the environment rather than asserting any single number.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRecoveryEnabled, readRecoveryUi } from "../profile-config.js";
import {
  CLIENT_CEILING_CLAMP_MS,
  DEADLINE_MARGIN_MS,
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_TIER1_DEADLINE_MS,
  TIER1_DEADLINE_FLOOR_MS,
  logDeadlineIfShortened,
  recoverySurfaceAllowed,
  resetDeadlineNotice,
  resetRecoveryFlagOverrides,
  resolveRecoveryEnabled,
  resolveRecoveryUi,
  resolveTier1DeadlineMs,
  retryWatchdogEnv,
  setRecoveryFlagOverrides,
} from "./settings.js";
import {
  capturedRecoveryLines,
  startLogCapture,
  stopLogCapture,
} from "./test-helpers/capture-log.js";

const ENV_KEYS = ["API_TIMEOUT_MS", "CLAUDISH_RECOVERY", "CLAUDISH_RECOVERY_UI"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetRecoveryFlagOverrides();
  resetDeadlineNotice();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  resetRecoveryFlagOverrides();
  resetDeadlineNotice();
});

// ───────────────────────────────────────────────────────────────────────────
// The deadline
// ───────────────────────────────────────────────────────────────────────────

describe("resolveTier1DeadlineMs — derived from API_TIMEOUT_MS, never hardcoded", () => {
  test("the measured default is what the derivation is anchored to", () => {
    // Recorded so a later edit that 'simplifies' the anchor has to argue with
    // the measurement rather than with a bare number.
    expect(DEFAULT_API_TIMEOUT_MS).toBe(360_000);
    expect(CLIENT_CEILING_CLAMP_MS).toBe(300_000);
    expect(DEADLINE_MARGIN_MS).toBe(30_000);
    expect(TIER1_DEADLINE_FLOOR_MS).toBe(15_000);
  });

  test("unset ⇒ 270 000 ms (min(default,300k) − 30k)", () => {
    expect(resolveTier1DeadlineMs({} as NodeJS.ProcessEnv)).toBe(270_000);
    expect(DEFAULT_TIER1_DEADLINE_MS).toBe(270_000);
  });

  test("API_TIMEOUT_MS=60000 ⇒ 30 000 ms, far BELOW the default hold", () => {
    // The whole point. A hardcoded 270 s here would outlive this user's client
    // by 210 s and end every episode in client_gone.
    const d = resolveTier1DeadlineMs({ API_TIMEOUT_MS: "60000" } as NodeJS.ProcessEnv);
    expect(d).toBe(30_000);
    expect(d).toBeLessThan(60_000);
    expect(d).toBeLessThan(DEFAULT_TIER1_DEADLINE_MS);
  });

  test("the value MOVES with the environment — it is not a constant", () => {
    // Mutation-relevant: an implementation that returned a constant passes the
    // default case and fails here, which is the only case that matters.
    const seen = new Set(
      ["45000", "60000", "120000", "240000", "360000"].map((v) =>
        resolveTier1DeadlineMs({ API_TIMEOUT_MS: v } as NodeJS.ProcessEnv)
      )
    );
    expect(seen.size).toBeGreaterThan(1);
    expect([...seen].sort((a, b) => a - b)).toEqual([15_000, 30_000, 90_000, 210_000, 270_000]);
  });

  test("an absurdly small API_TIMEOUT_MS clamps UP to the floor, not to zero or negative", () => {
    // 20 000 − 30 000 is negative. A raw subtraction would give a deadline in
    // the past, so shouldSkipTier1's no-budget gate would fire on every single
    // request and the feature would be off with no trace.
    expect(resolveTier1DeadlineMs({ API_TIMEOUT_MS: "20000" } as NodeJS.ProcessEnv)).toBe(15_000);
    expect(resolveTier1DeadlineMs({ API_TIMEOUT_MS: "1" } as NodeJS.ProcessEnv)).toBe(15_000);
    expect(resolveTier1DeadlineMs({ API_TIMEOUT_MS: "30000" } as NodeJS.ProcessEnv)).toBe(15_000);
  });

  test("a generous API_TIMEOUT_MS is clamped by the client ceiling", () => {
    expect(resolveTier1DeadlineMs({ API_TIMEOUT_MS: "900000" } as NodeJS.ProcessEnv)).toBe(270_000);
  });

  test("garbage, zero and negative all fall back to the default ceiling", () => {
    for (const raw of ["", "abc", "0", "-5000", "NaN"]) {
      expect(resolveTier1DeadlineMs({ API_TIMEOUT_MS: raw } as NodeJS.ProcessEnv)).toBe(270_000);
    }
  });

  test("reads process.env by default", () => {
    process.env.API_TIMEOUT_MS = "60000";
    expect(resolveTier1DeadlineMs()).toBe(30_000);
  });
});

describe("logDeadlineIfShortened", () => {
  // Through the REAL logger — see capture-log.ts for why not `mock.module()`.
  beforeAll(() => startLogCapture());
  afterAll(() => stopLogCapture());

  test("says nothing at the default — a healthy default must not be noisy", async () => {
    logDeadlineIfShortened(resolveTier1DeadlineMs({} as NodeJS.ProcessEnv));
    expect(await capturedRecoveryLines()).toEqual([]);
  });

  test("fires once when the environment shortens the hold, naming both numbers", async () => {
    process.env.API_TIMEOUT_MS = "60000";
    logDeadlineIfShortened(resolveTier1DeadlineMs());
    logDeadlineIfShortened(resolveTier1DeadlineMs());
    logDeadlineIfShortened(resolveTier1DeadlineMs());
    const lines = await capturedRecoveryLines();
    // Once per process: a shortened budget is not an error and must not be
    // repeated on every failing request.
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("tier-1 hold shortened to 30s");
    // Both halves matter: what you got, and what you would have got. A line
    // carrying only the first is not actionable.
    expect(lines[0]).toContain("API_TIMEOUT_MS=60000");
    expect(lines[0]).toContain("default would be 270s");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The switches
// ───────────────────────────────────────────────────────────────────────────

describe("resolveRecoveryEnabled / resolveRecoveryUi — flag > env > scoped > true", () => {
  test("nothing set ⇒ true for both (the default is ON)", () => {
    expect(resolveRecoveryEnabled()).toBe(true);
    expect(resolveRecoveryUi()).toBe(true);
  });

  test("env alone decides when no flag is given", () => {
    process.env.CLAUDISH_RECOVERY = "0";
    process.env.CLAUDISH_RECOVERY_UI = "false";
    expect(resolveRecoveryEnabled()).toBe(false);
    expect(resolveRecoveryUi()).toBe(false);
    process.env.CLAUDISH_RECOVERY = "1";
    process.env.CLAUDISH_RECOVERY_UI = "true";
    expect(resolveRecoveryEnabled()).toBe(true);
    expect(resolveRecoveryUi()).toBe(true);
  });

  test("the flag BEATS the environment, in both directions", () => {
    process.env.CLAUDISH_RECOVERY = "0";
    process.env.CLAUDISH_RECOVERY_UI = "0";
    setRecoveryFlagOverrides({ recovery: true, recoveryUi: true });
    expect(resolveRecoveryEnabled()).toBe(true);
    expect(resolveRecoveryUi()).toBe(true);

    process.env.CLAUDISH_RECOVERY = "1";
    process.env.CLAUDISH_RECOVERY_UI = "1";
    setRecoveryFlagOverrides({ recovery: false, recoveryUi: false });
    expect(resolveRecoveryEnabled()).toBe(false);
    expect(resolveRecoveryUi()).toBe(false);
  });

  test("the two switches are independent — the UI switch never gates the ladder", () => {
    // DEC-1: the loopback carve-out is deleted. `recoveryUi` decides one thing
    // only, and it is not whether a retry happens.
    setRecoveryFlagOverrides({ recoveryUi: false });
    expect(resolveRecoveryUi()).toBe(false);
    expect(resolveRecoveryEnabled()).toBe(true);
  });

  test("an unparseable env value is NO opinion, not false", () => {
    // "yes"/"on"/"" must not silently disable recovery: a typo'd off-switch
    // that half-works is worse than one that does not work at all.
    for (const raw of ["yes", "on", "", "  ", "2", "off"]) {
      process.env.CLAUDISH_RECOVERY = raw;
      expect(resolveRecoveryEnabled()).toBe(true);
    }
  });

  test("whitespace and case are tolerated on the values that DO parse", () => {
    process.env.CLAUDISH_RECOVERY = " FALSE ";
    expect(resolveRecoveryEnabled()).toBe(false);
    process.env.CLAUDISH_RECOVERY = " True ";
    expect(resolveRecoveryEnabled()).toBe(true);
  });

  test("resetRecoveryFlagOverrides clears the flag layer", () => {
    setRecoveryFlagOverrides({ recovery: false });
    expect(resolveRecoveryEnabled()).toBe(false);
    resetRecoveryFlagOverrides();
    expect(resolveRecoveryEnabled()).toBe(true);
  });
});

describe("the scoped layers: project .claudish.json > global config.json", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudish-recovery-scope-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const paths = () => ({
    global: () => join(dir, "config.json"),
    project: () => join(dir, ".claudish.json"),
  });

  test("project beats global", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ recoveryUi: { enabled: true } }));
    writeFileSync(join(dir, ".claudish.json"), JSON.stringify({ recoveryUi: { enabled: false } }));
    expect(readRecoveryUi(paths())).toBe(false);
  });

  test("global answers when the project file says nothing", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ recovery: { enabled: false } }));
    expect(readRecoveryEnabled(paths())).toBe(false);
  });

  test("`{}` is NO OPINION and falls through to the next scope", () => {
    // The reason both fields are objects rather than bare booleans. A bare
    // boolean cannot express 'present but undecided', so a project file that
    // merely mentions the key would override the global one with `false`.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ recoveryUi: { enabled: false } }));
    writeFileSync(join(dir, ".claudish.json"), JSON.stringify({ recoveryUi: {} }));
    expect(readRecoveryUi(paths())).toBe(false);
  });

  test("neither scope stating a boolean ⇒ undefined, so the caller's default applies", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ recoveryUi: { enabled: "yes" } }));
    expect(readRecoveryUi(paths())).toBeUndefined();
    expect(readRecoveryEnabled(paths())).toBeUndefined();
  });

  test("a garbled file is skipped rather than fatal", () => {
    writeFileSync(join(dir, ".claudish.json"), "{ not json");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ recovery: { enabled: false } }));
    expect(readRecoveryEnabled(paths())).toBe(false);
  });

  test("a missing file is skipped rather than fatal", () => {
    expect(readRecoveryUi(paths())).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `recoverySurfaceAllowed` — the gate that decides whether a launch PAYS for
// the recovery surface. It shipped as `resolveRecoveryUi()` alone at both
// `claude-runner.ts` call sites, so `--no-recovery` still wrapped the session
// in magmux. Observed on a real launch at HEAD 60cdb37, from the OS's own
// process table: `magmux --id claudish-84222` running under `--no-recovery`.
// ───────────────────────────────────────────────────────────────────────────

describe("recoverySurfaceAllowed — BOTH switches, because a wrap nothing can use is pure cost", () => {
  test("both on (the default) ⇒ the launch may own a surface", () => {
    expect(recoverySurfaceAllowed()).toBe(true);
  });

  test("--no-recovery withdraws the surface even with the UI switch left ON", () => {
    // THE REGRESSION. With the ladder disabled `shouldSkipTier1` answers
    // `recovery-disabled` on the first classified failure, so no episode is
    // ever opened and `ensureRecoveryUi` is never called: the pane CANNOT
    // appear. Wrapping anyway charges the emulator's native scrollback
    // (RISK-4), +89 ms of launch and a generated launcher script for a surface
    // that is structurally unreachable — and makes RISK-7's "restores today's
    // behaviour everywhere, byte for byte" false about the launch.
    setRecoveryFlagOverrides({ recovery: false });
    expect(resolveRecoveryUi()).toBe(true); // the UI switch is untouched…
    expect(recoverySurfaceAllowed()).toBe(false); // …and the surface is still withdrawn
  });

  test("every layer of the master switch withdraws it, not just the flag", () => {
    process.env.CLAUDISH_RECOVERY = "0";
    expect(recoverySurfaceAllowed()).toBe(false);
    // …and the flag can put it back, since the flag beats the environment.
    setRecoveryFlagOverrides({ recovery: true });
    expect(recoverySurfaceAllowed()).toBe(true);
  });

  test("--no-recovery-ui withdraws it with the ladder left ON", () => {
    // The half that already worked: retries still run, they simply answer
    // inline at exhaustion because no lease can exist.
    setRecoveryFlagOverrides({ recoveryUi: false });
    expect(resolveRecoveryEnabled()).toBe(true);
    expect(recoverySurfaceAllowed()).toBe(false);
  });

  test("the watchdog moves with it — surface and reach are one decision", () => {
    setRecoveryFlagOverrides({ recovery: false });
    expect(retryWatchdogEnv({ paneEligible: true })).toEqual({});
    resetRecoveryFlagOverrides();
    expect(retryWatchdogEnv({ paneEligible: true })).toEqual({ CLAUDE_CODE_RETRY_WATCHDOG: "1" });
  });
});

describe("claude-runner asks that gate, and not the UI switch alone", () => {
  // A SOURCE GUARD, and it is the only thing that can fail on the defect that
  // actually shipped. The predicate above was always correct as an expression;
  // what was wrong was the CALL SITE — `resolveRecoveryUi() &&
  // paneCapability.kind === "wrap"` — and `launchClaudeCode` cannot be unit
  // tested for it: reaching that line means spawning Claude Code inside a real
  // magmux on a real TTY. That is C-8's live matrix, not a unit test. This is
  // the cheap half, and it fails the moment either call site is reverted.
  const source = readFileSync(resolve(import.meta.dir, "../claude-runner.ts"), "utf8");
  // The comments there name `resolveRecoveryUi()` while explaining why it is
  // not enough, so a guard that did not strip them would pass on reverted code.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("the magmux wrap ternary consults recoverySurfaceAllowed()", () => {
    const gate = /const wrap =\s*([\s\S]{0,160}?)\?\s*\n?\s*planMagmuxWrap/.exec(code)?.[1];
    expect(gate, "could not find the wrap ternary in claude-runner.ts").toBeTruthy();
    expect(gate).toContain("recoverySurfaceAllowed()");
    expect(gate).toContain('paneCapability.kind === "wrap"');
    // The reverted form, named explicitly so the failure says what went wrong
    // rather than which substring is missing.
    expect(
      /\bresolveRecoveryUi\(\)/.test(gate as string)
        ? "the wrap gate asks resolveRecoveryUi() — --no-recovery will still wrap the session in magmux"
        : null
    ).toBeNull();
  });

  test("the ambient-magmux branch consults it too", () => {
    const branch = code
      .split("\n")
      .find((l) => l.includes("else if") && /ambient|MAGMUX_SOCK/.test(l));
    expect(branch, "could not find the ambient branch in claude-runner.ts").toBeTruthy();
    expect(branch).toContain("recoverySurfaceAllowed()");
    expect(
      /\bresolveRecoveryUi\(\)/.test(branch as string)
        ? "the ambient branch asks resolveRecoveryUi() — --no-recovery still installs the recovery UI in a grid pane"
        : null
    ).toBeNull();
  });

  test("the ambient branch reads magmuxPaneCapability(), not its own MAGMUX_SOCK test (F8)", () => {
    // `network-recovery.md`: one predicate decides the surface. The ambient branch
    // used to restate it as `config.interactive && process.env.MAGMUX_SOCK`, so a
    // case added to `magmuxPaneCapability()` (the pane child, D22) would still
    // install the recovery UI here.
    const branch = code
      .split("\n")
      .find((l) => l.includes("else if") && /ambient|MAGMUX_SOCK/.test(l));
    expect(branch, "could not find the ambient branch in claude-runner.ts").toBeTruthy();
    expect(branch).toContain('paneCapability.kind === "ambient"');
    expect(branch).not.toContain("MAGMUX_SOCK");
  });
});
