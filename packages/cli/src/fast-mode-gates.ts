/**
 * The two Claude Code gates `/fast` needs in a pure proxy child, and their
 * removal from an env that inherited them. Kept free of claude-runner's
 * imports so the MCP print child can scrub them too.
 */

/**
 * Names the fast-mode gates claudish itself opened in a proxied child, so a
 * native-auth launch that inherits them (a tool shell, a nested claudish) can
 * close exactly those and nothing the user set: `skip` and/or `caps`.
 */
export const CLAUDISH_FAST_MODE_GATES_VAR = "CLAUDISH_FAST_MODE_GATES";

/** The capability entry claudish prepends: no `=`, so it applies to every model. */
const FAST_MODE_CAPABILITY = "fast_mode";

/**
 * Let Claude Code's `/fast` reach the proxy, which decides per connection
 * whether a faster tier exists (`speed: "fast"` → wire speed, step 5w/5s).
 *
 * Claude Code sends `speed: "fast"` only when (Claude Code 2.1.310, static):
 * the org's fast-mode status is enabled — fetched from Anthropic with the
 * session's credential, which in pure proxy mode is claudish's placeholder,
 * so it can never be; `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` sets it enabled
 * without the fetch — and the model name passes `fast_mode`, true only for
 * Opus 4.8 / Opus 5 names unless `CLAUDE_CODE_MODEL_CAPABILITIES` grants it.
 * The entry is PREPENDED: later entries win in Claude Code's parse, so a
 * user's own `pattern=-fast_mode` still turns it off for that model.
 *
 * Pure proxy mode only: under real Anthropic credentials the org check is the
 * user's own policy and is never skipped. `CLAUDE_CODE_DISABLE_FAST_MODE`
 * leaves both untouched.
 */
export function applyProxyFastModeGates(env: Record<string, string | undefined>): void {
  scrubInheritedFastModeGates(env);
  if (env.CLAUDE_CODE_DISABLE_FAST_MODE) return;
  const opened: string[] = [];
  if (env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK === undefined) {
    env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = "1";
    opened.push("skip");
  }
  const caps = env.CLAUDE_CODE_MODEL_CAPABILITIES;
  env.CLAUDE_CODE_MODEL_CAPABILITIES = caps
    ? `${FAST_MODE_CAPABILITY};${caps}`
    : FAST_MODE_CAPABILITY;
  opened.push("caps");
  env[CLAUDISH_FAST_MODE_GATES_VAR] = opened.join(",");
}

/**
 * Close the fast-mode gates a parent proxied session opened (see
 * applyProxyFastModeGates), and only those: the marker names which of the two
 * claudish set, and only claudish's own capability entry is removed.
 */
export function scrubInheritedFastModeGates(env: NodeJS.ProcessEnv): { removed: string[] } {
  const marker = env[CLAUDISH_FAST_MODE_GATES_VAR];
  if (marker === undefined) return { removed: [] };
  const opened = marker.split(",");
  const removed: string[] = [];
  if (opened.includes("skip") && env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK === "1") {
    delete env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK;
    removed.push("CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK");
  }
  const caps = env.CLAUDE_CODE_MODEL_CAPABILITIES;
  if (opened.includes("caps") && caps !== undefined) {
    if (caps === FAST_MODE_CAPABILITY) delete env.CLAUDE_CODE_MODEL_CAPABILITIES;
    else if (caps.startsWith(`${FAST_MODE_CAPABILITY};`)) {
      env.CLAUDE_CODE_MODEL_CAPABILITIES = caps.slice(FAST_MODE_CAPABILITY.length + 1);
    }
    removed.push("CLAUDE_CODE_MODEL_CAPABILITIES");
  }
  delete env[CLAUDISH_FAST_MODE_GATES_VAR];
  return { removed };
}
