/**
 * Which `claudish` binary a spawned CHILD is.
 *
 * `team` and `create_session` spawn children as `spawn("claudish", …)` —
 * by NAME, resolved through PATH. In production that is exactly right: the child
 * should be the installed claudish. In a TEST it is a bug, and a particularly
 * dishonest one, because the suite goes green or red against whatever version
 * happens to be installed on the machine rather than against the tree under test.
 *
 * This is not hypothetical. `mcp-e2e/runner.ts` documents an incident where a code
 * path DELETED from this tree came back to life during a run: installed 7.34.0
 * still contained an `op account get` probe removed here, and it fired on every
 * child spawn while the harness asserted on dev spans from the parent. And the
 * MCP session e2e's `create_session` test failed for an afternoon against a fix that
 * was already correct in the tree — the child was the installed binary, which
 * still had the bug.
 *
 * `mcp-e2e/runner.ts` solved it locally by writing a `claudish` shim onto PATH.
 * That works, but it makes every harness reinvent the trick, and a harness that
 * FORGETS silently tests the wrong code — the failure mode is a passing or failing
 * test with no indication which binary produced it. This is the same fix promoted
 * to a seam the spawn sites themselves honour, so a harness opts in with one env
 * var and grandchildren inherit it for free.
 *
 * Production behaviour is unchanged: with `CLAUDISH_BIN` unset the result is
 * exactly `spawn("claudish", args)`.
 */

/** How to spawn claudish: an executable plus any arguments that must precede argv. */
export interface ClaudishSpawnTarget {
  command: string;
  prefixArgs: string[];
}

/** The env var a test harness sets to redirect child spawns at the tree under test. */
export const CLAUDISH_BIN_ENV = "CLAUDISH_BIN";

/**
 * Resolve the command a child spawn should use.
 *
 * A `.ts`/`.js` value is run through the CURRENT runtime (`process.execPath`, i.e.
 * the same bun that is executing the parent) rather than requiring the harness to
 * write an executable shim — pointing straight at `packages/cli/src/index.ts` is
 * the thing a test actually wants to say. Anything else is treated as an
 * executable path or a PATH-resolvable name.
 *
 * `spawn` is always called with `shell: false` at the call sites, so no quoting or
 * word-splitting is involved: a path containing spaces passes through intact.
 */
export function resolveClaudishSpawn(env: NodeJS.ProcessEnv = process.env): ClaudishSpawnTarget {
  const bin = env[CLAUDISH_BIN_ENV]?.trim();
  if (!bin) return { command: "claudish", prefixArgs: [] };
  if (/\.(ts|tsx|js|mjs|cjs)$/.test(bin)) {
    return { command: process.execPath, prefixArgs: ["run", bin] };
  }
  return { command: bin, prefixArgs: [] };
}
