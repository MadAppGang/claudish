/**
 * Pins the test-run home sandbox (#242). If the bunfig `[test] preload` is
 * removed, renamed, or stops taking effect, these go red — and the rest of the
 * suite is once again writing the operator's real ~/.claudish.
 *
 * The third test reads the preload's proof marker instead of assuming one
 * regime: when homedir() re-read HOME at runtime, the sandbox is provably
 * distinct from the real home; in preset mode homedir() IS the launcher's HOME
 * on every platform (bun >= 1.4 freezes it, and userInfo() follows HOME too),
 * so the proof is the sandbox's throwaway LOCATION and the test re-checks it.
 */
import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";

const PROOFS = ["env-home", "preset-throwaway"];

describe("#242 — tests never see the operator's real home", () => {
  test("the preload ran: a sandbox, the real home and the proof are recorded", () => {
    expect(process.env.CLAUDISH_TEST_HOME_SANDBOX).toBeTruthy();
    expect(process.env.CLAUDISH_TEST_REAL_HOME).toBeTruthy();
    expect(PROOFS).toContain(process.env.CLAUDISH_TEST_SANDBOX_PROOF ?? "");
  });

  test("homedir() resolves to the sandbox", () => {
    const sandbox = resolve(process.env.CLAUDISH_TEST_HOME_SANDBOX!);
    expect(resolve(homedir())).toBe(sandbox);
  });

  test("the sandbox is provably NOT the operator's real home", () => {
    const sandbox = resolve(process.env.CLAUDISH_TEST_HOME_SANDBOX!);
    const realHome = resolve(process.env.CLAUDISH_TEST_REAL_HOME!);
    const proof = process.env.CLAUDISH_TEST_SANDBOX_PROOF;
    if (proof === "preset-throwaway") {
      // homedir() IS the launcher's HOME here, on every platform, so equality
      // with realHome is expected and proves nothing. The preload refused unless
      // the sandbox was a throwaway test sandbox — re-check both halves of that.
      const under = (base: string) =>
        sandbox === resolve(base) || sandbox.startsWith(resolve(base) + sep);
      const runnerTemp = process.env.RUNNER_TEMP;
      expect(under(tmpdir()) || (runnerTemp ? under(runnerTemp) : false)).toBe(true);
      const name = basename(sandbox);
      const conventional = name === "claudish-test-home" || name.startsWith("claudish-test-home-");
      expect(process.env.GITHUB_ACTIONS === "true" || conventional).toBe(true);
      return;
    }
    expect(sandbox).not.toBe(realHome);
  });
});