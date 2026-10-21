/**
 * Preset-mode sandbox guard — the pure half of `test-preload.ts`.
 *
 * In preset mode the launcher hands us the sandbox via `HOME` before bun boots
 * (bun >= 1.4 / POSIX freezes `os.homedir()`), so nothing at runtime tells an
 * isolated sandbox apart from the operator's real home by value: `homedir()`
 * IS the preset, and `os.userInfo().homedir` follows `$HOME` too (libuv checks
 * HOME before getpwuid — measured on the CI runner: preset HOME and userInfo()
 * were the same path). B1 of the #574 review asked for a guard that can
 * actually fire; the evidence that survives is the LOCATION of the sandbox.
 *
 * So preset mode proceeds only if the sandbox is a throwaway directory
 * (under tmpdir or RUNNER_TEMP) AND either runs on GitHub Actions or carries
 * the conventional `claudish-test-home[-*]` basename. An inherited
 * `CLAUDISH_TEST_PRESET_HOME=1` on a seat points at the real home, which fails
 * the first condition — the #242 class (afterAll rmSync'ing `~/.claudish`)
 * cannot happen through preset mode.
 *
 * Kept in its own module so the branches can be pinned by unit tests: importing
 * the preload itself runs its side effects.
 */
import { basename, resolve, sep } from "node:path";

export const SANDBOX_BASENAME = "claudish-test-home";

export interface PresetCheck {
  /** The launcher-provided home — what `homedir()` resolves to in preset mode. */
  sandbox: string;
  /** `os.tmpdir()` — a sandbox below it is throwaway by construction. */
  tmpDir: string;
  /** GitHub Actions' per-job temp dir, when running on a runner. */
  runnerTemp?: string;
  /** `process.env.GITHUB_ACTIONS === "true"`. */
  githubActions: boolean;
}

/**
 * Returns a refusal message when preset mode cannot prove its sandbox is
 * throwaway, or null when it may proceed.
 */
export function presetRefusal(c: PresetCheck): string | null {
  const sandbox = resolve(c.sandbox);
  const under = (base: string) => sandbox === resolve(base) || sandbox.startsWith(resolve(base) + sep);
  const throwaway = under(c.tmpDir) || (c.runnerTemp ? under(c.runnerTemp) : false);
  if (!throwaway) {
    return (
      `preset mode refused — ${sandbox} is neither under ${resolve(c.tmpDir)} nor under RUNNER_TEMP; ` +
      "a preset HOME must be a throwaway directory (the real ~/.claudish is what we protect)"
    );
  }
  const base = basename(sandbox);
  if (!c.githubActions && base !== SANDBOX_BASENAME && !base.startsWith(SANDBOX_BASENAME + "-")) {
    return (
      `preset mode refused — ${sandbox} does not look like a test sandbox ` +
      `(basename must be ${SANDBOX_BASENAME}[-*] outside CI); refusing to run against a real home`
    );
  }
  return null;
}