/**
 * Whether THIS process may open a credential dialog — fixed once, by the entry
 * point, never by a request.
 *
 * ## Why a role, and why per process
 *
 * Reading another application's Keychain item (the Muse Code CLI's login) can
 * open the macOS access dialog. A dialog is acceptable only where a person is
 * at the terminal that caused it and expects it: an interactive
 * `claudish --model …` launch, or an action the user just took in the config
 * TUI. Everywhere else — an MCP server, a `team` slot or channel session in a
 * headless magmux pane, `--probe`, `claudish serve`, a piped `-p` or CI — a
 * dialog appears on a desktop nobody is watching, blocks a request on it, and
 * piles up across runs.
 *
 * The decision was ambient once (read per request, from whatever the request
 * looked like), and every review found another caller that raised it. So it is
 * decided ONCE, where the process starts, from facts about the process:
 *
 * - `isPaneChild()` — NOT `isatty`. A magmux pane has a real PTY, so a `team`
 *   slot looks interactive to every TTY test (`pane/child-env.ts`).
 * - stdin AND stderr are TTYs — a piped or CI launch is not a person.
 * - `--probe` exits inside `parseArgs`, before any launch code, and is a
 *   diagnostic: it never prompts.
 *
 * ## The rule for changing it
 *
 * The first `setCredentialPromptRole` wins. After that the role can only be
 * LOWERED to `never`, never raised: an entry point deeper in the same process
 * that knows it must not prompt (`--probe`, the MCP server) can always say so,
 * and nothing a request does can widen it. The default, before any entry point
 * has spoken, is `never`.
 *
 * `CLAUDISH_PANE_CHILD` is the marker `pane-launch.ts` sets for every MCP
 * `team` slot and `create_session` pane. CLI `--team` grid panes do not carry
 * it: the user who ran `--team` is at that terminal, so those panes take
 * `interactive-launch`, and the per-machine read lock bounds them to one dialog.
 */

import { isPaneChild } from "../../pane/child-env.js";

/**
 * - `never`: no credential dialog. Only claudish's own files are read.
 * - `interactive-launch`: an interactive `claudish` launch with a person at the
 *   terminal; the launch hook and the request path may read the Keychain.
 * - `tui`: the config TUI; only an explicit user action (`withInteractiveCredential`)
 *   may read, in-process, before it issues any proxy request.
 */
export type CredentialPromptRole = "never" | "interactive-launch" | "tui";

let role: CredentialPromptRole = "never";
let fixed = false;

/**
 * Set the process's role. The first call fixes it; later calls may only lower it
 * to `never` (see the module comment). Returns the role in effect afterwards.
 */
export function setCredentialPromptRole(next: CredentialPromptRole): CredentialPromptRole {
  if (!fixed) {
    role = next;
    fixed = true;
  } else if (next === "never") {
    role = "never";
  }
  return role;
}

/** The role in effect. Read-only for every caller that is not an entry point. */
export function credentialPromptRole(): CredentialPromptRole {
  return role;
}

/** Facts about a CLI launch, injectable so the decision is testable without a TTY. */
export interface LaunchFacts {
  argv: readonly string[];
  env?: Record<string, string | undefined>;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
}

/**
 * The role of a `claudish` CLI launch (`index.ts` `runCli`), decided before
 * `parseArgs` so the model picker it may open already knows it.
 */
export function decideLaunchRole(facts: LaunchFacts): CredentialPromptRole {
  if (facts.argv.includes("--probe")) return "never";
  if (isPaneChild(facts.env ?? process.env)) return "never";
  if (!facts.stdinIsTTY || !facts.stderrIsTTY) return "never";
  return "interactive-launch";
}

/** Test seam: forget the role, as if no entry point had run. */
export function _resetCredentialPromptRoleForTest(): void {
  role = "never";
  fixed = false;
}
