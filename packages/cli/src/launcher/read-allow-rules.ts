/**
 * Read allow rules that let Claude Code Read one folder claudish owns without a
 * permission prompt: the arguments that follow `--allowedTools`.
 *
 * Not `--add-dir`: Claude Code 2.1.326 asks "Is this a directory you created or
 * one you trust?" for every added folder not trusted before, and the launch
 * waits on that question; the answer holds for one session only. A Read allow
 * rule asks nothing, headless or interactive, adds to the user's own
 * `--allowedTools` rules, and grants Read only.
 *
 * Claude Code matches the real path, so the rules name the folder's real
 * spelling and, when it differs (`/var` → `/private/var`), the spelling given.
 * `//` starts an absolute path in a permission rule.
 */

import { realpathSync } from "node:fs";

/** `Read(//<folder>/**)` for the folder's real spelling, then the given one when it differs. */
export function readAllowRules(dir: string): string[] {
  return [...new Set([realpathSync(dir), dir])].map((path) => `Read(/${path}/**)`);
}
