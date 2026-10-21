/**
 * Claude Code's TIER ALIASES — names that route to native Claude Code but are
 * not model ids the Anthropic API will accept.
 *
 * ## Why this distinction has to exist
 *
 * `parseModelSpec` sends Claude Code's own names to `native-anthropic`: every
 * `claude-` id, and every name {@link isClaudeCodeModelName} accepts. Any other
 * bare name with no `/` goes to `route()` instead (`AUTO_ROUTE_PROVIDER`). Two
 * very different things still arrive at the native route:
 *
 *   - `opus`, `sonnet`, `haiku`, `internal`, `default` — Claude Code's own tier
 *     selectors. The API rejects them ("not a valid model ID"), but the ROUTE is
 *     healthy, so probing them verbatim would report a failure that does not
 *     exist. These need a concrete id substituted.
 *   - a concrete `claude-` id, including one that does not exist
 *     (`claude-opus-9`). At runtime `native-handler.ts` forwards `payload.model`
 *     VERBATIM and Anthropic answers for it, 404 included, so substituting a
 *     working id here makes `--probe` report `live` for a model that cannot
 *     serve a single request.
 *
 * The probe used to substitute for every name, which is how `swe-1.7` came to
 * "probe byte-identically to a nonsense string" back when the parser still sent
 * both natively: the substitution erased the difference between them before the
 * request was ever sent.
 *
 * So the rule is: substitute for a KNOWN alias, pass everything else through and
 * let the API answer honestly.
 *
 * Kept import-free and separate from `team-orchestrator.ts`'s `SENTINEL_MODELS`
 * on purpose. That set answers a different question — "may this be spawned as a
 * claudish child process?" — and happens to list the same names today. Sharing
 * one set would couple two unrelated decisions; what matters is that neither
 * silently grows a name the other should have known about.
 */

/** The Claude Code tier a request maps onto. */
export type ClaudeTier = "opus" | "sonnet" | "haiku";

/**
 * The tier alias table.
 *
 * `internal` and `default` mean "whatever Claude Code is configured with" rather
 * than a specific tier. They map to `opus` because that is the tier Claude Code
 * runs by default, and because the probe only needs SOME valid id to prove the
 * passthrough works — it is testing the route and the credential, not a model.
 */
const TIER_ALIASES: Record<string, ClaudeTier> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  internal: "opus",
  default: "opus",
};

/**
 * The tier this name selects, or null when it is an ordinary model id.
 *
 * Null is the answer that must NOT be substituted: it means the caller named
 * something concrete, and the honest probe is to send it and report what the API
 * says.
 */
export function claudeCodeTierAlias(model: string): ClaudeTier | null {
  return TIER_ALIASES[model.trim().toLowerCase()] ?? null;
}

/**
 * Every alias Claude Code itself accepts as a `--model` value. A superset of the
 * {@link TIER_ALIASES} keys, so keep every tier alias listed here too. `opusplan`
 * (which switches tier with the mode) and `best` (whatever Claude Code rates most
 * capable) are not in the tier table, but Claude Code owns them all the same.
 */
export const CLAUDE_CODE_MODEL_ALIASES = [
  "opus",
  "sonnet",
  "haiku",
  "internal",
  "default",
  "opusplan",
  "best",
] as const;

/** Claude Code's 1M-context selector, appended to an alias or a `claude-` id: `sonnet[1m]`. */
export const ONE_MILLION_CONTEXT_SUFFIX = "[1m]";

/**
 * Whether Claude Code owns this bare name: one of its aliases, optionally with the
 * `[1m]` suffix, or any `claude-` id (the suffix included). Trimmed and
 * case-insensitive.
 *
 * A different question from {@link claudeCodeTierAlias}, which asks which tier to
 * substitute: `opus[1m]`, `sonnet[1m]`, `opusplan` and `best` are Claude Code's
 * names, and the tier table answers null for each. Not a model name at all (`""`,
 * `@model`), `claude` with no dash, and every other vendor's id are false.
 */
export function isClaudeCodeModelName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized.startsWith("claude-")) return true;
  const alias = normalized.endsWith(ONE_MILLION_CONTEXT_SUFFIX)
    ? normalized.slice(0, -ONE_MILLION_CONTEXT_SUFFIX.length)
    : normalized;
  return (CLAUDE_CODE_MODEL_ALIASES as readonly string[]).includes(alias);
}

/**
 * Normalize a `--model` value so a native-Anthropic SELECTOR becomes a name
 * Claude Code actually recognises.
 *
 * `internal` and `default` are selectors, not model ids. Claude Code rejects
 * them outright — measured 2026-08-22, `claudish --model internal --stdin`
 * exits 1 with `[claude-code:unrecognized_model] {"model":"internal"}` and
 * "There's an issue with the selected model (internal)". The TIER they select
 * IS recognised: the same command with `--model opus` exits 0. So the fix is to
 * hand Claude Code the tier and let IT resolve the tier to the current model —
 * no id is pinned here, which is what the no-hardcoded-model-data rule requires.
 * (`--model claude-opus-4-1` also exits 0, but only because Claude Code remaps
 * it: "automatically remapped to Opus 5". Pinning ids is how the probe's
 * hardcoded default rotted; the tier cannot rot.)
 *
 * Everything else passes through untouched — `claude-*` ids are already valid,
 * and an explicit `provider@model` spec is not in the alias table at all.
 *
 * Applied at the `--model` parse boundary, so EVERY consumer sees the
 * normalized value: the proxy's native branch, the env handed to Claude Code,
 * `team` children, and `create_session` children (both spawn `claudish
 * --model X`, and that child normalizes at its own boundary).
 */
export function normalizeNativeModelSpec(spec: string): string {
  return claudeCodeTierAlias(spec) ?? spec;
}
