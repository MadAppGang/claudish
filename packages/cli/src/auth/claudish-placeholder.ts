/**
 * claudish's OWN placeholder credentials, and the one exact-match test for them.
 *
 * A proxied Claude Code child gets these instead of a real Anthropic credential:
 * they only suppress Claude Code's login, and the proxy signs every request. From
 * the child they leak into every process the session starts (tool shells, tmux
 * panes, nested claudish runs, `team` slots), so any layer that reads
 * `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` must be able to tell them apart from
 * a user's key.
 *
 * Dependency-free on purpose: the launcher, the credential layer and the
 * placeholder rule in `env-placeholder.ts` all need it, and the credential layer
 * cannot import the launcher.
 */

/**
 * The placeholder ANTHROPIC_API_KEY claudish puts in a PROXIED child's env. Its only
 * job is suppressing Claude Code's login dialog; the proxy handles real auth.
 */
export const CLAUDISH_PLACEHOLDER_API_KEY =
  "sk-ant-api03-placeholder-not-used-proxy-handles-auth-with-openrouter-key-xxxxxxxxxxxxxxxxxxxxx";

/** The placeholder ANTHROPIC_AUTH_TOKEN paired with CLAUDISH_PLACEHOLDER_API_KEY. */
export const CLAUDISH_PLACEHOLDER_AUTH_TOKEN = "placeholder-token-not-used-proxy-handles-auth";

/**
 * Is `value` claudish's OWN placeholder for the env variable `name`? Only an exact
 * match counts, and only for the variable that placeholder belongs to. Every other
 * value, including unset, is not a placeholder.
 */
export function isClaudishPlaceholderCredential(name: string, value: string | undefined): boolean {
  if (name === "ANTHROPIC_API_KEY") return value === CLAUDISH_PLACEHOLDER_API_KEY;
  if (name === "ANTHROPIC_AUTH_TOKEN") return value === CLAUDISH_PLACEHOLDER_AUTH_TOKEN;
  return false;
}
