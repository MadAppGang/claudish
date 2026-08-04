/**
 * One rule for "this env value is an unexpanded `${VAR}` placeholder, not a value".
 *
 * A host that launches claudish from a declarative config can pass an env entry
 * through VERBATIM when the referenced shell variable is unset. Claude Code does
 * exactly this with the claudish plugin's `.mcp.json`
 * (`"OPENROUTER_API_KEY": "${OPENROUTER_API_KEY}"`): an MCP server started from a
 * shell without that variable receives the literal string `${OPENROUTER_API_KEY}`.
 *
 * That string is truthy, so it wins any `process.env.X || fallback` chain,
 * shadows 1Password entirely, and gets signed into an Authorization header — a
 * 401 that reads as "claudish ignored my 1Password config".
 *
 * This lives in its own dependency-free module because more than one layer needs
 * it and they cannot import each other: `auth/credentials/api-key-credential.ts`
 * (the credential chain), `tui/providers.ts` (the sync readiness classifier), and
 * `providers/onepassword.ts` (OP_ACCOUNT). The last one closes a cycle —
 * onepassword → api-key-credential → op-source → onepassword — so importing the
 * rule from the credential layer is not an option, and duplicating it would let
 * the copies drift. Divergence here is not cosmetic: it is exactly how
 * `claudish providers --json` came to call a provider ready on the strength of a
 * placeholder that sign-time correctly refused to use.
 *
 * Deliberately anchored and brace-only: a real value never has this shape, and a
 * value that merely CONTAINS `${` (unlikely but not impossible) is left alone.
 */
export const UNEXPANDED_PLACEHOLDER = /^\$\{[^}]*\}$/;

/** The value, or undefined when it is an unexpanded `${VAR}` placeholder. */
export function realValue(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return UNEXPANDED_PLACEHOLDER.test(v.trim()) ? undefined : v;
}
