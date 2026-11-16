/**
 * "Is this provider's API key already on this machine, without asking anyone?"
 *
 * Steps 1–3 of `ApiKeyCredentialProvider`'s resolution chain — env var →
 * aliases → `config.json` `apiKeys` — extracted so a caller that must NOT be
 * async can ask the same question the authority asks, and get the same answer.
 * `ApiKeyCredentialProvider.resolveFromEnvConfig()` calls this, so there is one
 * oracle rather than two; the class adds only its own 4th step (a
 * config-DECLARED key, which is a custom-endpoint concept and has no meaning to
 * anyone else).
 *
 * It lives in its own module, and that placement is the point rather than
 * tidiness. The predefined-endpoint gate must decide whether to register a
 * vendor at all, and registration cannot await; the SDK step sits behind
 * `hasOpSources()` inside the authority's ASYNC `resolveKey`. THIS module
 * imports neither `op-source` nor anything that reaches 1Password, so a caller
 * that depends only on it cannot reach the SDK.
 *
 * Be exact about the scope of that, because the stronger claim is false and
 * would be load-bearing if believed: the predefined-endpoint GATE also pulls in
 * `custom-endpoints-loader` → `authority` → `api-key-credential` → `op-source`,
 * so `@1password/sdk` IS in its static import closure. What actually keeps the
 * SDK out of registration is that every function on the path is SYNCHRONOUS and
 * the SDK sits behind an `await`. Sync-ness is the guarantee; this module's
 * clean import list is a local reinforcement of it, not a proof about the whole
 * gate. It matters on a machine where concurrent 1Password handshakes are
 * arbitrated globally and a burst of denials trips a 15-second machine-wide
 * suppression. Same reasoning that put `realValue` in its own dependency-free
 * module.
 *
 * `realValue()` is applied at EVERY step, which is what makes two edge cases
 * fall out for free: an env var set to `""` reads as absent, and an unexpanded
 * `${VAR}` placeholder — which a declarative MCP host really does pass through
 * verbatim — is truthy garbage that must never read as a credential, nor
 * shadow the 1Password value that would have resolved.
 *
 * SYNCHRONOUS, and the only I/O is step 3: `getApiKey` → `loadConfig()`, which
 * is a `readFileSync` + `JSON.parse` of `~/.claudish/config.json` on EVERY
 * call — there is no cache, so a 25-row catalog with nothing credentialed does
 * 25 reads. Measured on this machine: 25 × `loadConfig()` is 0.68 ms against a
 * typical 40-key config and 2.45 ms against a 500-key one, against a whole
 * registration pass of ~1.5 ms–2 ms. Not material, and deliberately not
 * memoized: the config TUI's hydrate-on-add re-runs registration inside a live
 * process precisely so a just-imported key is seen, and a cache would make that
 * re-run answer from before the import. Steps 1 and 2 touch nothing but
 * `process.env`, so a credentialed provider never reaches the read at all.
 */

import { realValueFor } from "../../env-placeholder.js";
import { getApiKey } from "../../profile-config.js";

export interface LocalApiKeyQuery {
  /** Primary env var, e.g. `GROQ_API_KEY`. */
  envVar: string;
  /** Additional accepted spellings, tried in order after the primary. */
  aliases?: string[];
}

/**
 * The locally-present key, or `undefined`. Env wins over aliases wins over
 * config — the order the authority signs with, so a caller can trust that the
 * value it sees is the value that will be sent.
 *
 * KNOWN AND DELIBERATE ASYMMETRY: aliases are read from `process.env` only, not
 * from `config.apiKeys`. So a `CUSTOM_GROQ_KEY` (or any alias spelling) stored
 * in `~/.claudish/config.json` does not resolve, while the PRIMARY variable
 * stored there does. Extending step 3 over the aliases is a two-line change and
 * was rejected on purpose: this function is not a helper for the predefined
 * endpoint gate, it IS `ApiKeyCredentialProvider.resolveFromEnvConfig()`'s
 * implementation, so widening it silently widens key resolution for EVERY
 * provider in the authority — e.g. `openai-codex` would start authenticating
 * from a config-stored `OPENAI_API_KEY` it currently ignores. That may well be
 * the right change; it is a credential-authority decision with its own blast
 * radius, and smuggling it in under an endpoints feature is how a routing
 * change ends up unreviewed. The gap is small (the conventional variable, which
 * is what the config TUI and the missing-key error both name, is unaffected)
 * and has two escape hatches: store the primary name, or `predefinedEndpoints.enable`.
 */
export function resolveLocalApiKey(q: LocalApiKeyQuery): string | undefined {
  // NOTE: map alias names to their VALUES before .find — `aliases.find(a =>
  // process.env[a])` returns the alias NAME (a truthy string), so the request
  // would be signed with the literal env-var name → 401.
  // realValueFor also drops claudish's own placeholder for that variable, which a
  // nested claudish inherits from the proxied session that started it.
  return (
    realValueFor(q.envVar, process.env[q.envVar]) ||
    (q.aliases ?? []).map((a) => realValueFor(a, process.env[a])).find((v) => !!v) ||
    realValueFor(q.envVar, getApiKey(q.envVar))
  );
}

/** SYNC predicate over {@link resolveLocalApiKey}. Never throws, never awaits. */
export function hasLocalApiKey(q: LocalApiKeyQuery): boolean {
  try {
    return !!resolveLocalApiKey(q);
  } catch {
    return false;
  }
}
