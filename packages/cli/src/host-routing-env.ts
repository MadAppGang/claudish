/**
 * Claude Code's host-routing pair on a proxy-auth launch, and its removal where a
 * later launch needs the user's own login.
 *
 * A proxy-auth launch sets `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` and an empty
 * `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` in the Claude Code child's environment
 * (ai-docs/architecture/settings-env.md). From there both reach every process that
 * session starts: tool shells, a nested `claudish`, the claudish MCP server. Under
 * the host marker Claude Code ignores a stored claude.ai login and prints "Not
 * logged in", so a launch that relies on that login must not inherit it.
 *
 * A Claude API launch sets the host marker alone: its requests go to Anthropic,
 * so the trust flag keeps whatever value the launcher gave it.
 *
 * `CLAUDISH_SET_HOST_ROUTING_VARS` records what claudish set: `1` for the pair,
 * `marker` for the host marker alone. Only what the record names is removed: a
 * user who set either variable themselves keeps it.
 */
import { ENV } from "./config.js";

/** The record's value when claudish set the host marker and cleared the trust flag. */
const RECORD_PAIR = "1";
/** The record's value when claudish set the host marker alone. */
const RECORD_MARKER = "marker";

/** Mark `env` host-managed without first-party trust, and record that claudish did. */
export function applyHostRouting(env: Record<string, string | undefined>): void {
  env[ENV.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST] = "1";
  env[ENV.CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL] = "";
  env[ENV.CLAUDISH_SET_HOST_ROUTING_VARS] = RECORD_PAIR;
}

/**
 * Mark `env` host-managed and record that claudish set the marker alone. The
 * trust flag is left as the launcher gave it: a session whose requests go to
 * Anthropic keeps it. Settings `env` blocks then set neither the base URL nor a
 * credential for the child.
 */
export function applyHostManagedMarker(env: Record<string, string | undefined>): void {
  env[ENV.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST] = "1";
  env[ENV.CLAUDISH_SET_HOST_ROUTING_VARS] = RECORD_MARKER;
}

/**
 * Remove what the record says claudish set, and the record: the marker and the
 * trust flag for `1`, the marker alone for `marker`. Without a record nothing is
 * touched. Mutates `env` in place and returns the names it deleted.
 */
export function scrubInheritedHostRouting(env: Record<string, string | undefined>): {
  removed: string[];
} {
  const record = env[ENV.CLAUDISH_SET_HOST_ROUTING_VARS];
  const names =
    record === RECORD_PAIR
      ? [
          ENV.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
          ENV.CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL,
          ENV.CLAUDISH_SET_HOST_ROUTING_VARS,
        ]
      : record === RECORD_MARKER
        ? [ENV.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, ENV.CLAUDISH_SET_HOST_ROUTING_VARS]
        : [];
  const removed: string[] = [];
  for (const name of names) {
    if (name in env) {
      delete env[name];
      removed.push(name);
    }
  }
  return { removed };
}
