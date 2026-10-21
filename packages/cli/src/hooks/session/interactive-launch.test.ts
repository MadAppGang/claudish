/**
 * The interactive launcher's plan when session hooks are loaded (hook-system §3.2, §7.5,
 * §12 P7): the wrap's second reason, the recovery gate it must NOT open, the session-id
 * mint and the `--add-dir` turn directory.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MagmuxPaneCapability } from "../../launcher/magmux-wrapper.js";
import {
  RETRY_WATCHDOG_OWNER_ENV,
  applyRetryWatchdog,
  recoverySurfaceAllowed,
  resetRecoveryFlagOverrides,
  setRecoveryFlagOverrides,
} from "../../recovery/settings.js";
import {
  driverLeadingArgs,
  planInteractiveSurfaces,
  sessionFlagsOf,
} from "./interactive-launch.js";

const WRAP: MagmuxPaneCapability = { kind: "wrap", magmux: "/usr/local/bin/magmux" };
const AMBIENT: MagmuxPaneCapability = { kind: "ambient", sock: "/tmp/magmux-1.sock" };
const NO_TTY: MagmuxPaneCapability = { kind: "none", reason: "no-tty" };
const PRINT: MagmuxPaneCapability = { kind: "none", reason: "not-interactive" };
const PANE_CHILD: MagmuxPaneCapability = { kind: "none", reason: "pane-child" };

afterEach(() => resetRecoveryFlagOverrides());

describe("planInteractiveSurfaces", () => {
  test("no session hooks: today's plan exactly (the wrap is the recovery surface's alone)", () => {
    expect(
      planInteractiveSurfaces({
        capability: WRAP,
        recoveryAllowed: true,
        sessionHooksNeedDriver: false,
      })
    ).toEqual({ wrap: true, recoveryUi: "wrap", driver: null, noSurfaceSession: false });
    expect(
      planInteractiveSurfaces({
        capability: WRAP,
        recoveryAllowed: false,
        sessionHooksNeedDriver: false,
      })
    ).toEqual({ wrap: false, recoveryUi: null, driver: null, noSurfaceSession: false });
    expect(
      planInteractiveSurfaces({
        capability: AMBIENT,
        recoveryAllowed: true,
        sessionHooksNeedDriver: false,
      })
    ).toEqual({ wrap: false, recoveryUi: "ambient", driver: null, noSurfaceSession: false });
  });

  test("session hooks with recovery on: one wrap, both the banner and the driver on it", () => {
    expect(
      planInteractiveSurfaces({
        capability: WRAP,
        recoveryAllowed: true,
        sessionHooksNeedDriver: true,
      })
    ).toEqual({ wrap: true, recoveryUi: "wrap", driver: "wrap", noSurfaceSession: false });
  });

  test("--no-recovery + session hooks: the wrap is planned for the driver, the banner is not", () => {
    expect(
      planInteractiveSurfaces({
        capability: WRAP,
        recoveryAllowed: false,
        sessionHooksNeedDriver: true,
      })
    ).toEqual({ wrap: true, recoveryUi: null, driver: "wrap", noSurfaceSession: false });
  });

  test("ambient: the driver runs on the ambient pane whatever the recovery switches say", () => {
    for (const recoveryAllowed of [true, false])
      expect(
        planInteractiveSurfaces({
          capability: AMBIENT,
          recoveryAllowed,
          sessionHooksNeedDriver: true,
        })
      ).toEqual({
        wrap: false,
        recoveryUi: recoveryAllowed ? "ambient" : null,
        driver: "ambient",
        noSurfaceSession: false,
      });
  });

  test("no pane (no TTY, -p): lifecycle-only session hooks; a pane child: none at all", () => {
    for (const capability of [NO_TTY, PRINT])
      expect(
        planInteractiveSurfaces({ capability, recoveryAllowed: true, sessionHooksNeedDriver: true })
      ).toEqual({ wrap: false, recoveryUi: null, driver: null, noSurfaceSession: true });
    expect(
      planInteractiveSurfaces({
        capability: PANE_CHILD,
        recoveryAllowed: true,
        sessionHooksNeedDriver: true,
      })
    ).toEqual({ wrap: false, recoveryUi: null, driver: null, noSurfaceSession: false });
  });
});

/**
 * The recovery gate, as `claude-runner.ts` asks it: the watchdog is applied with
 * `paneEligible: capability.kind !== "none"` and its own `recoverySurfaceAllowed()`,
 * and the wrap is planned from the same capability plus the session-hook reason.
 */
describe("recovery gate: --no-recovery + session hooks wraps WITHOUT exporting the watchdog", () => {
  function launch(sessionHooksNeedDriver: boolean) {
    const env: Record<string, string | undefined> = {};
    applyRetryWatchdog(env, { paneEligible: WRAP.kind !== "none" });
    const plan = planInteractiveSurfaces({
      capability: WRAP,
      recoveryAllowed: recoverySurfaceAllowed(),
      sessionHooksNeedDriver,
    });
    return { env, plan };
  }

  test("--no-recovery + hooks: wrapped, driver on, no recovery UI, no CLAUDE_CODE_RETRY_WATCHDOG", () => {
    setRecoveryFlagOverrides({ recovery: false });
    const { env, plan } = launch(true);
    expect(plan.wrap).toBe(true);
    expect(plan.driver).toBe("wrap");
    expect(plan.recoveryUi).toBeNull();
    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBeUndefined();
    expect(env[RETRY_WATCHDOG_OWNER_ENV]).toBeUndefined();
  });

  test("--no-recovery-ui + hooks: the same", () => {
    setRecoveryFlagOverrides({ recoveryUi: false });
    const { env, plan } = launch(true);
    expect(plan.wrap).toBe(true);
    expect(plan.recoveryUi).toBeNull();
    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBeUndefined();
  });

  test("an inherited claudish watchdog is still REMOVED when the recovery gate fails", () => {
    setRecoveryFlagOverrides({ recovery: false });
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_RETRY_WATCHDOG: "1",
      [RETRY_WATCHDOG_OWNER_ENV]: "1",
    };
    applyRetryWatchdog(env, { paneEligible: true });
    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBeUndefined();
  });

  test("positive control: recovery on + hooks exports the watchdog and installs the banner", () => {
    setRecoveryFlagOverrides({ recovery: true, recoveryUi: true });
    const { env, plan } = launch(true);
    expect(plan.wrap).toBe(true);
    expect(plan.recoveryUi).toBe("wrap");
    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBe("1");
  });

  test("negative control: --no-recovery without hooks does not wrap (the shipped fix stays)", () => {
    setRecoveryFlagOverrides({ recovery: false });
    const { env, plan } = launch(false);
    expect(plan.wrap).toBe(false);
    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBeUndefined();
  });
});

describe("sessionFlagsOf", () => {
  test("nothing given: claudish mints", () => {
    expect(sessionFlagsOf(["--permission-mode", "plan", "hello"])).toEqual({
      sessionId: null,
      resumes: false,
    });
  });

  test("an explicit --session-id is the session from boot, in both spellings", () => {
    expect(sessionFlagsOf(["--session-id", "abc"])).toEqual({ sessionId: "abc", resumes: false });
    expect(sessionFlagsOf(["--session-id=abc"])).toEqual({ sessionId: "abc", resumes: false });
  });

  test("every resume flag means Claude Code decides: no id known, no mint", () => {
    for (const args of [
      ["--resume"],
      ["--resume", "x"],
      ["-r"],
      ["--continue"],
      ["-c"],
      ["--fork-session", "--resume", "x"],
      ["--session-id", "abc", "--fork-session"],
    ])
      expect(sessionFlagsOf(args)).toEqual({ sessionId: null, resumes: true });
  });

  test("arguments after -- are the prompt, not flags", () => {
    expect(sessionFlagsOf(["--", "-c is not a flag here"])).toEqual({
      sessionId: null,
      resumes: false,
    });
  });
});

describe("driverLeadingArgs", () => {
  test("--add-dir is never the last of the leading args a positional could follow", () => {
    const minted = driverLeadingArgs({ mintedSessionId: "u-1", turnDir: "/t" });
    expect(minted).toEqual(["--session-id", "u-1", "--add-dir", "/t"]);
    expect(driverLeadingArgs({ mintedSessionId: null, turnDir: "/t" })).toEqual([
      "--add-dir",
      "/t",
    ]);
    // claude-runner puts these ahead of its own `--settings <file>`, which ends the
    // variadic list: a prompt after it can never be read as a directory.
    const argv = [...minted, "--settings", "/s.json", "hello"];
    const at = argv.indexOf("--add-dir");
    expect(argv[at + 2]?.startsWith("-")).toBe(true);
  });
});
