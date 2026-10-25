/**
 * Resolve how `runModels` (team-orchestrator) must spawn the claudish CLI (#646).
 *
 * `spawn("claudish", args, { shell: false })` cannot reach a `.cmd`-shimmed
 * install on Windows — measured 2026-10-24 on both runtimes this repo ships on:
 * bun does not apply PATHEXT (ENOENT for a bare name whose only match is
 * `claudish.cmd`), and node ≥ 20 refuses `.bat`/`.cmd` without `shell: true`
 * since the CVE-2024-27980 hardening (EINVAL), even through an absolute path.
 * The npm global layout on Windows IS a `.cmd` shim, so every `claudish team`
 * run on such a seat recorded FAILED/exit-1 with empty stderr for all models.
 *
 * The fix resolves the real executable once per run — never `shell: true`,
 * which would re-parse every argument through a shell (args carry model ids
 * and user-supplied `claudeFlags`):
 *   - `claudish.exe` on PATH → spawn the absolute path directly;
 *   - `claudish.cmd` / `claudish.bat` on PATH → spawn `cmd.exe /d /s /c` with
 *     the shim and every argument quoted, `windowsVerbatimArguments: true`;
 *   - nothing on PATH → surfaced to the caller, which fails the model with a
 *     message naming the executable forms it looked for.
 *
 * Non-win32 is byte-identical to the old call: bare `claudish`, no wrapper.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** What to hand `spawn()` for one claudish CLI invocation. */
export interface ClaudishSpawn {
  /** spawn()'s command. `null` = nothing resolvable on win32 (see `refusal`). */
  command: string | null;
  /** spawn()'s args: the CLI args verbatim, or the cmd.exe wrapper around them. */
  args: string[];
  /** Extra option for the cmd.exe wrapper (`windowsVerbatimArguments`). */
  verbatim: boolean;
  /** Non-win32 / resolvable: undefined. Win32 + nothing found: the message
   * naming the executable forms that were looked for (#646 acceptance). */
  refusal?: string;
}

/**
 * The executable forms a Windows seat can offer, in resolution order. Hardcoded
 * rather than read from PATHEXT: `.exe` must win over the shim forms (a native
 * build is not a shim), and `.com`/`.vbs`/`.js` etc. are not claudish install
 * shapes. The npm layout is `claudish` (sh) + `claudish.cmd` + `claudish.ps1`;
 * `.ps1` cannot be spawned by child_process at all.
 */
const WIN32_EXECUTABLE_FORMS = ["claudish.exe", "claudish.cmd", "claudish.bat"] as const;

/** First `<dir>/<form>` that exists, searching PATH in order for each form. */
function findClaudishOnPath(): string | null {
  const pathVar = process.env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const form of WIN32_EXECUTABLE_FORMS) {
      const candidate = join(dir, form);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // Unreadable PATH entry (network drive dropped, …): try the next one.
      }
    }
  }
  return null;
}

/**
 * Windows argument quoting for the C runtime that ultimately parses the line
 * (cmd.exe passes the batch's `%*` through verbatim). Every argument is quoted
 * unconditionally — paths under `C:\Program Files\` and tmpdirs with spaces are
 * the normal case, and an unquoted-when-simple fast path buys nothing here.
 */
function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  // Double backslashes that precede a quote (and the quote itself), then any
  // trailing run of backslashes — the standard MSVCRT rules, so an embedded
  // `\"` cannot terminate the argument early.
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

/** The `/d /s /c` wrapper around a `.cmd`/`.bat` shim. */
function cmdShimSpawn(shimPath: string, cliArgs: string[]): ClaudishSpawn {
  const comspec = process.env.comspec ?? "cmd.exe";
  // cmd's /s semantics: the first and last quote of the string after /c are
  // stripped — so the WHOLE command line is wrapped in one extra pair, and the
  // inner per-argument quotes survive intact. `/d` skips AutoRun registry
  // hooks (a machine-configured hook must not see the model arguments).
  const inner = [shimPath, ...cliArgs].map(quoteWindowsArg).join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${inner}"`],
    verbatim: true,
  };
}

/**
 * Resolve the spawn shape for `claudish <cliArgs>`. Per-call (never memoized):
 * tests point PATH at a freshly created shim dir, and PATH is a legitimate
 * per-invocation input for a CLI launch.
 */
export function resolveClaudishSpawn(cliArgs: string[]): ClaudishSpawn {
  if (process.platform !== "win32") {
    return { command: "claudish", args: cliArgs, verbatim: false };
  }
  const found = findClaudishOnPath();
  if (found === null) {
    return {
      command: null,
      args: cliArgs,
      verbatim: false,
      refusal:
        `claudish executable not found on PATH (looked for ${WIN32_EXECUTABLE_FORMS.join(", ")} ` +
        `in each PATH entry). Install claudish or add its bin directory to PATH.`,
    };
  }
  if (found.endsWith(".exe")) {
    return { command: found, args: cliArgs, verbatim: false };
  }
  return cmdShimSpawn(found, cliArgs);
}
