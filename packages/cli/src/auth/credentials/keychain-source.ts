/**
 * keychain-source — the lazy macOS Keychain seam BEHIND the credential authority.
 *
 * The single place that knows how to pull a provider's API key out of the macOS
 * Keychain on demand. The authority calls `resolveKeychainKeyForEnvVars(wanted)`
 * only when env / aliases / config have all missed — so a user whose key is
 * already in the shell environment never spawns `security` at all.
 *
 * LAZINESS GATE: `hasKeychainSource()` is a cheap SYNC sniff — the platform,
 * plus one boolean in `config.json`. It returns false WITHOUT touching the
 * keychain when the backend was never opted into, which is the whole reason the
 * `keychain.enabled` flag exists. Deliberately parallel to `hasOpSources()`.
 *
 * ORDER: this source is consulted BEFORE 1Password. The keychain is local,
 * costs ~17ms, and once its ACL is established it never prompts; a 1Password
 * resolve is a desktop-app handshake that can be denied, and a burst of denials
 * trips a 15-second machine-wide suppression (see architecture/onepassword.md).
 * Cheap and quiet goes first. An explicit env var or a config-stored key still
 * wins over both — a user who exports a key means it.
 *
 * WRITE-THROUGH, AND WHY THERE IS NO NEW `CredentialSource` MEMBER:
 * a resolved keychain value is written into `process.env` by the authority, the
 * same mechanism 1Password already uses. The strings in `CredentialSource` are
 * a WIRE CONTRACT consumed by the external profiles app through
 * `claudish providers --json` (see source.ts), so a keychain key reports "env"
 * — which is literally true once it has been written through. Origin is tracked
 * separately here, for display only, via `isKeychainHydratedVar`.
 */

import { isKeychainEnabled } from "../../profile-config.js";
import {
  KeychainError,
  enumerateKeychainVars,
  isKeychainSupported,
  lookupKeychainVar,
  readKeychainSecret,
  readKeychainSecretAsync,
} from "../../providers/keychain.js";
import { readAtUseKeyEnvVars } from "../../providers/provider-definitions.js";
import { resolveLocalApiKey } from "./local-api-key.js";

/**
 * Warn ONCE per process per distinct message.
 *
 * A bare model name credential-filters a routing CHAIN, so one process asks the
 * authority about several candidate providers. When the keychain is failing —
 * locked, or an ACL the user declined — every one of those asks fails
 * identically, and one line each reads as a cascade of distinct problems rather
 * than the single condition it is. Same rationale as op-source's warnOnce.
 *
 * Message text only; no key material is ever part of these strings.
 */
const warnedMessages = new Set<string>();

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.error(message);
}

/**
 * Env vars whose runtime value came from the keychain THIS run.
 *
 * Run-scoped and in-memory, mirroring `recordOpHydratedVars`. Reporting only —
 * it holds NAMES, never values — so provenance can say "keychain" instead of
 * mislabelling a hydrated variable as a shell export.
 */
const hydratedVars = new Set<string>();

/** Record that `envVar`'s runtime value was hydrated from the keychain. */
export function recordKeychainHydratedVar(envVar: string): void {
  hydratedVars.add(envVar);
}

/** Did `envVar`'s runtime value come from the keychain this run? */
export function isKeychainHydratedVar(envVar: string): boolean {
  return hydratedVars.has(envVar);
}

/** Test seam: forget this run's hydration record. */
export function resetKeychainHydrationRecord(): void {
  hydratedVars.clear();
}

/**
 * SYNC laziness gate: is there any point asking the keychain?
 *
 * Platform + one config boolean. No spawn, no I/O beyond the config read the
 * caller is doing anyway. False for every user who has not opted in.
 */
export function hasKeychainSource(): boolean {
  // Production escape hatch, mirroring CLAUDISH_DISABLE_OP for 1Password.
  //
  // It exists for the same reason: a test that reaches a real credential store
  // is not hermetic, and `mock.module` cannot be used to prevent it because
  // Bun's module registry is process-global and the stub bleeds into sibling
  // files. A flag the PRODUCTION code honours is the only stub that cannot leak.
  //
  // Needed here specifically because `isKeychainEnabled()` reads the real
  // ~/.claudish/config.json whenever no `--config` override is active — so a
  // test run without the guard would spawn `security` against the developer's
  // own login keychain. Set it in any suite that does not install a config
  // override.
  if (process.env.CLAUDISH_DISABLE_KEYCHAIN === "1") return false;
  if (!isKeychainSupported()) return false;
  return isKeychainEnabled();
}

/**
 * Outcome of a keychain resolve.
 *
 * `failed` is what separates "there is no item for this variable" from "the
 * keychain could not be asked" — a locked keychain, or an ACL the user
 * declined. The distinction is load-bearing for CACHING: an absent item is a
 * stable answer worth remembering, while a failure is transient and must be
 * retried, or one early stumble would mark a provider unavailable for the rest
 * of the process. The op source draws the same line for denied handshakes.
 */
export interface KeychainResolveResult {
  value?: string;
  /** True when the keychain could not be consulted (NOT when it simply had no item). */
  failed: boolean;
  /**
   * One-line diagnostic for `failed`, taken from the engine's own
   * `KeychainEnumeration.error` (`security`'s stderr, or the exit code when it
   * said nothing). Present only when `failed` is true, and never key material —
   * enumeration runs `dump-keychain` WITHOUT `-d`, so it never reads item data.
   *
   * It exists so the caller can say WHICH store was unreachable rather than
   * "unavailable". The authority turns this into a `failed` readiness detail,
   * which is the difference between telling a user to unlock their keychain and
   * telling them to buy a subscription they already have.
   */
  error?: string;
}

/**
 * The first stored value among `wanted` (primary env var, then aliases).
 *
 * Presence is checked through `keychainHasVar` — ONE `dump-keychain` for the
 * whole item list — before any value read, so a provider with nothing stored
 * costs no per-variable spawn at all. Only a name that IS present pays the
 * ~17ms value lookup.
 *
 * NEVER THROWS, AND IT NEVER HAD TO. A failure is DATA here — `failed` plus
 * `error` — not an exception and not a silent `undefined`. That distinction is
 * the whole point: throwing would force every caller into a try/catch whose
 * only honest outcome is the same flag, and returning a bare "no value" is what
 * turned a locked keychain into "this user has no credential" and moved a
 * flat-rate subscriber onto a metered provider without a word. A keychain
 * failure still degrades this provider to "no credential" for THIS resolve, so
 * the caller falls through to 1Password and a proxy or MCP server keeps running
 * — the same policy op-source applies under `onAuthFailure: "skip"`. What
 * changes is that the caller can now tell the two apart and say so.
 */
export function resolveKeychainKeyForEnvVars(wanted: Iterable<string>): KeychainResolveResult {
  if (!hasKeychainSource()) return { failed: false };
  let failed = false;
  try {
    for (const name of wanted) {
      if (!name) continue;
      const { present, failed: lookupFailed } = lookupKeychainVar(name);
      // An enumeration that could NOT run is not evidence of absence. Remember
      // it and report it, or the authority caches this provider as permanently
      // credential-less on the strength of a keychain we never managed to read.
      if (lookupFailed) failed = true;
      if (!present) continue;
      const value = readKeychainSecret(name);
      if (value) return { value, failed: false };
    }
  } catch (err) {
    const detail = err instanceof KeychainError ? err.message : String(err);
    warnOnce(`[claudish] macOS Keychain lookup skipped: ${detail}`);
    return { failed: true, error: detail };
  }
  if (failed) {
    warnOnce(
      "[claudish] macOS Keychain could not be enumerated — treating this provider as unresolved rather than uncredentialed."
    );
    // The engine already recorded WHY, and this read is normally a memo hit: the
    // same `enumerateKeychainVars()` call `lookupKeychainVar` just made is inside
    // the 3-second burst window, so asking for its diagnostic costs no extra spawn.
    // Taking the reason from the engine rather than re-deriving it here keeps
    // one description of the failure instead of two that can disagree.
    return { failed: true, error: keychainFailureDetail() };
  }
  return { failed };
}

/**
 * The engine's own reason the keychain could not be enumerated, if it still has
 * one. Never throws. Called straight after `lookupKeychainVar` enumerated, so it
 * is a memo hit inside the 3-second burst window; only if that window closed in
 * between does it re-run the one `dump-keychain` the lookup already made. A
 * re-read that now succeeds yields `undefined`, and a `failed` readiness without
 * a detail is still a correct `failed`.
 */
function keychainFailureDetail(): string | undefined {
  try {
    const listed = enumerateKeychainVars();
    return listed.failed ? listed.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load every stored keychain secret into `process.env`, gap-filling only.
 *
 * WHY THIS EXISTS: `describeSourceSync` cannot await, so the config TUI's
 * readiness dots, "configured first" sort and not-configured divider would all
 * report a keychain-only provider as unconfigured until something happened to
 * resolve it. Hydrating up front is exactly how 1Password's keys become visible
 * to the same sync rules — the classifier sees a real `process.env` entry, and
 * reports "env", which by then it is.
 *
 * GAP-FILL, NEVER OVERWRITE: a variable already present in the environment was
 * put there by the user's shell (or by an earlier, higher-priority source), and
 * silently replacing it would invert the documented precedence — env beats
 * keychain, always.
 *
 * IT MUST SKIP CONFIG-STORED KEYS TOO, and that is less obvious. `config.json`
 * outranks the keychain in the resolution chain, but it is NOT in `process.env`
 * — so hydrating on "absent from env" alone would push the keychain value into
 * env, where step 1 of the chain finds it FIRST and the config key that should
 * have won is never consulted. The config TUI would then sign requests with a
 * different credential than the same machine uses outside the TUI. Filtering on
 * `resolveLocalApiKey` rather than on `process.env` keeps the two identical.
 *
 * PARALLEL: reads run concurrently, so ten stored keys cost roughly one read's
 * wall clock (~30ms) rather than ten (~170ms).
 *
 * @returns the number of variables actually hydrated.
 */
export async function hydrateKeychainIntoEnv(): Promise<number> {
  if (!hasKeychainSource()) return 0;
  let names: string[];
  try {
    const listed = enumerateKeychainVars();
    if (listed.failed) {
      warnOnce(`[claudish] macOS Keychain enumeration skipped: ${listed.error ?? "unknown error"}`);
      return 0;
    }
    names = listed.names;
  } catch (err) {
    warnOnce(`[claudish] macOS Keychain enumeration skipped: ${String(err)}`);
    return 0;
  }

  // `resolveLocalApiKey` is steps 1-3 of the authority's own chain (env →
  // aliases → config.apiKeys) — the exact set of sources that outrank the
  // keychain. Anything it can already answer must be left alone. A read-at-use
  // key (`vaultKeyReadAtUse`, ANTHROPIC_API_KEY) is never read here: its value
  // stays out of `process.env`, where every child Claude Code would inherit it,
  // and readiness answers it from enumeration alone.
  const readAtUse = readAtUseKeyEnvVars();
  const missing = names.filter((n) => !readAtUse.has(n) && !resolveLocalApiKey({ envVar: n }));
  if (missing.length === 0) return 0;

  const results = await Promise.all(
    missing.map(async (name) => {
      try {
        return { name, value: await readKeychainSecretAsync(name) };
      } catch (err) {
        warnOnce(
          `[claudish] macOS Keychain read for ${name} skipped: ${err instanceof KeychainError ? err.message : String(err)}`
        );
        return { name, value: null };
      }
    })
  );

  let hydrated = 0;
  for (const { name, value } of results) {
    // Re-check against the SAME higher-priority sources, not just process.env:
    // another source may have filled it while we awaited, and config still
    // outranks us.
    if (!value || resolveLocalApiKey({ envVar: name })) continue;
    process.env[name] = value;
    recordKeychainHydratedVar(name);
    hydrated++;
  }
  return hydrated;
}

/**
 * SYNC presence check for the predefined-endpoint registration gate.
 *
 * Registration cannot await, and it must decide whether a bundled vendor row is
 * worth registering at all. `keychainHasVar` answers from the single enumerate
 * call, so this stays affordable however many providers ask.
 *
 * Presence ONLY — deliberately not a value. `resolveLocalApiKey` remains the
 * one oracle for what a request is actually signed with, and widening THAT
 * would change key resolution for every provider in the authority at once.
 */
export function keychainHasAnyOf(names: Iterable<string>): boolean {
  if (!hasKeychainSource()) return false;
  try {
    for (const name of names) {
      if (name && lookupKeychainVar(name).present) return true;
    }
  } catch {
    // Enumeration failure → "nothing stored". Never blocks registration.
  }
  return false;
}
