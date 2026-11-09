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
 * `CLAUDISH_SET_HOST_ROUTING_VARS` records that claudish set the pair. Only with that
 * marker present is the pair removed: a user who set either variable themselves
 * keeps it.
 */
import { ENV } from "./config.js";

const HOST_ROUTING_VARS = [
  ENV.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
  ENV.CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL,
  ENV.CLAUDISH_SET_HOST_ROUTING_VARS,
] as const;

/** Mark `env` host-managed without first-party trust, and record that claudish did. */
export function applyHostRouting(env: Record<string, string | undefined>): void {
  env[ENV.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST] = "1";
  env[ENV.CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL] = "";
  env[ENV.CLAUDISH_SET_HOST_ROUTING_VARS] = "1";
}

/**
 * Remove the host-routing pair and its marker when the marker says claudish set them.
 * Without the marker nothing is touched. Mutates `env` in place and returns the names
 * it deleted.
 */
export function scrubInheritedHostRouting(env: Record<string, string | undefined>): {
  removed: string[];
} {
  if (env[ENV.CLAUDISH_SET_HOST_ROUTING_VARS] !== "1") return { removed: [] };
  const removed: string[] = [];
  for (const name of HOST_ROUTING_VARS) {
    if (name in env) {
      delete env[name];
      removed.push(name);
    }
  }
  return { removed };
}
