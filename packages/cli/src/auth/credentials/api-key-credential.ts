/**
 * ApiKeyCredentialProvider — the credential authority for API-key providers.
 *
 * Resolution order (ASYNC, memoized per provider):
 *   1. process.env[envVar]
 *   2. process.env[alias] for each alias
 *   3. getApiKey(envVar) — config.json apiKeys map
 *   4. macOS Keychain (lazy `security`, only when 1-3 missed AND the backend is on)
 *   5. 1Password (op:// — lazy SDK, only when 1-4 missed AND an op source exists)
 *
 * Keychain precedes 1Password because it is local, prompt-free once its ACL is
 * established, and ~17ms — where a 1Password resolve is a desktop-app handshake
 * that can be denied, and whose denials trip a 15-second machine-wide
 * suppression. Both remain BELOW env and config: a user who exports a key, or
 * types one into the config, means it.
 *
 * When step 4 or 5 resolves a key, the value is written THROUGH into process.env
 * so spawned child processes (MCP team/session) inherit it and never touch the
 * SDK or the keychain. The authority is the ONLY code that pushes keys from
 * either vault into process.env.
 *
 * `describeReadiness()` reports `present` / `absent` / `failed`, and
 * `isAvailable()` is its `=== "present"` projection. Steps 4 and 5 are the two
 * measured ways a REAL credential resolves to nothing — a locked or declined
 * keychain, a denied 1Password handshake — and both used to arrive here as a
 * bare `""`, indistinguishable from "this user has no key". That is what let a
 * flat-rate subscription be dropped from the routing chain and replaced by a
 * metered provider with nothing printed. The reason now survives; what routing
 * DOES with it is unchanged, since `failed` still projects to unavailable.
 *
 * `describeReadiness()` additionally honors one affordance the legacy oracle
 * granted:
 *   - `oauthFallback`: a `<file>` under ~/.claudish/ — if that OAuth credential
 *     file exists, the provider is available even without an env/config/op key.
 *
 * There used to be a second, `publicKeyFallback`, which made a provider report
 * available on the strength of a hardcoded literal token. It is gone: a keyless
 * provider declares `authScheme: "none"` instead, which is handled below and
 * says no credential is expected rather than inventing one.
 *
 * Resolution is memoized: the first await pays the env/config/op cost; later
 * reads return the cached result. `invalidate()` clears it (TUI hydrate-on-add).
 * An empty/failed op resolve is NOT cached as "" — it's cached as "unavailable"
 * only after the op source is consulted, and `invalidate()` re-opens it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realValue } from "../../env-placeholder.js";
import {
  hasKeychainSource,
  recordKeychainHydratedVar,
  resolveKeychainKeyForEnvVars,
} from "./keychain-source.js";
import { resolveLocalApiKey } from "./local-api-key.js";
import { hasOpSources, resolveOpKeyForEnvVars } from "./op-source.js";
import type {
  CredentialProvider,
  ReadinessResult,
  RequestAuth,
  RequestAuthContext,
} from "./types.js";

/**
 * The outcome of one async key resolution: the key (possibly ""), plus WHY it
 * is empty when a credential STORE could not be consulted.
 *
 * `failure` is set only for "could not ask" — a keychain that would not answer,
 * a 1Password handshake that was denied or unavailable. It is deliberately NOT
 * set for "every source answered and none holds this key", which is an ordinary,
 * stable `absent` and must stay one: marking that `failed` would make every
 * provider the user has not configured report an error.
 */
interface KeyResolution {
  key: string;
  failure?: string;
}

export interface ApiKeyDescriptor {
  catalogName: string;
  envVar: string;
  aliases?: string[];
  /**
   * How to sign a request. `"none"` means this provider takes no credential at
   * all — see the class field of the same name for why that is distinct from
   * "the key happens to be empty".
   */
  authScheme?: "bearer" | "x-api-key" | "none";
  staticHeaders?: Record<string, string>;
  /**
   * OAuth credential filename under ~/.claudish/ (e.g. "codex-oauth.json"). If
   * the file exists, the provider counts as available even with no API key.
   * Mirrors ProviderDefinition.oauthFallback.
   */
  oauthFallback?: string;
  /**
   * SYNC resolver for a key the provider DECLARES in config rather than in an
   * env var — currently custom endpoints, whose `apiKey` field is a literal or
   * a `${VAR}` reference (config-schema.ts CustomEndpoint).
   *
   * Consulted LAST in the sync chain (after env → aliases → config.apiKeys) so
   * an explicit env/config value still overrides the declaration, and so the
   * op:// write-through mirror (process.env[CUSTOM_<NAME>_KEY]) keeps winning.
   *
   * MUST return undefined for an `op://` declaration: those are resolved by the
   * async op-source step below, and returning the literal ref here would short-
   * circuit it and sign requests with the string "op://…".
   */
  declaredKey?: () => string | undefined;
}

/**
 * An UNEXPANDED `${VAR}` placeholder is not a key — see `env-placeholder.ts` for
 * the rule and why it lives in its own module.
 *
 * Re-exported here because this was its original home and several call sites
 * (notably the sync readiness classifier in `tui/providers.ts`) import it from
 * this path. Keeping the re-export means the rule moved without a rename sweep,
 * and there is still exactly ONE implementation.
 */
export { realValue };

export class ApiKeyCredentialProvider implements CredentialProvider {
  readonly catalogName: string;
  private readonly envVar: string;
  private readonly aliases: string[];
  /**
   * `"none"` is NOT the same as "resolved an empty key", and conflating them is
   * what made keyless endpoints unreachable.
   *
   * An empty key means "a credential was expected and is missing" — the routing
   * pre-flight is right to reject that, because the request would 401. `"none"`
   * means "no credential was ever expected", so the provider is AVAILABLE with
   * nothing configured and its requests carry no auth header. The two need
   * different answers from `isAvailable()`, which is why this is a scheme rather
   * than a sentinel key value.
   */
  private readonly authScheme: "bearer" | "x-api-key" | "none";
  private readonly staticHeaders: Record<string, string>;
  private readonly oauthFallback?: string;
  private readonly declaredKey?: () => string | undefined;

  /** Memoized resolved key ("" = resolved-and-empty). undefined = not yet resolved. */
  private cachedKey: string | undefined;
  /**
   * In-flight resolution, so concurrent callers share one op pull.
   *
   * It carries the FAILURE alongside the key rather than leaving the reason in
   * an instance field: several callers share one resolution (a bare model name
   * credential-filters a whole chain, and the config TUI resolves ~16 providers
   * at once), so a field would be read by whichever caller happened to land
   * after the next resolution had already overwritten it.
   */
  private resolving: Promise<KeyResolution> | undefined;

  constructor(descriptor: ApiKeyDescriptor) {
    this.catalogName = descriptor.catalogName;
    this.envVar = descriptor.envVar;
    this.aliases = descriptor.aliases ?? [];
    this.authScheme = descriptor.authScheme ?? "bearer";
    this.staticHeaders = descriptor.staticHeaders ?? {};
    this.oauthFallback = descriptor.oauthFallback;
    this.declaredKey = descriptor.declaredKey;
  }

  /**
   * SYNC: env → aliases → config.json apiKeys → declared key (custom endpoints).
   * Does NOT touch 1Password.
   *
   * The first three steps are `resolveLocalApiKey` — shared verbatim with the
   * predefined-endpoint registration gate, which must answer "is this key
   * already here?" synchronously. Two implementations of that question is the
   * duplicate-oracle pattern the credential refactor deleted, so there is one.
   * The 4th step stays here because a config-DECLARED key is a custom-endpoint
   * concept with no meaning outside this class. realValue() applies at every
   * step (see local-api-key.ts): a placeholder must never shadow 1Password.
   */
  private resolveFromEnvConfig(): string | undefined {
    return (
      resolveLocalApiKey({ envVar: this.envVar, aliases: this.aliases }) ||
      realValue(this.resolveDeclared())
    );
  }

  /** The config-declared key (custom endpoints). Never throws. */
  private resolveDeclared(): string | undefined {
    try {
      return this.declaredKey?.() || undefined;
    } catch {
      return undefined;
    }
  }

  /** SYNC: does the oauthFallback credential file exist under ~/.claudish/? */
  private hasOauthFallbackFile(): boolean {
    if (!this.oauthFallback) return false;
    try {
      return existsSync(join(homedir(), ".claudish", this.oauthFallback));
    } catch {
      return false;
    }
  }

  /**
   * ASYNC resolved key: env → aliases → config → keychain → op:// (both lazy).
   * Memoized; each vault is consulted at most once. Writes a resolved key
   * THROUGH to process.env so spawned children inherit it.
   */
  private async resolveKey(opts?: { allowOpPrompt?: boolean }): Promise<string> {
    return (await this.resolveKeyDetailed(opts)).key;
  }

  /**
   * The same resolution, keeping the REASON an empty result is empty.
   *
   * Both vault steps below can come back with nothing for two different
   * reasons, and the old `Promise<string>` had one slot for both. "The keychain
   * is locked" and "there is no item for this variable" arrived as the same
   * `""`, so `isAvailable()` reported a subscriber with a perfectly good key as
   * uncredentialed, routing dropped the provider, and a metered vendor served
   * the request. The stores already distinguish the two — `{value?, failed}`
   * from the keychain, and now `onFailure` from the op source — so this method
   * carries the distinction up instead of flattening it.
   *
   * The failure is reported WITHOUT ever being cached: transience is the whole
   * point, and the existing "do not memoize a miss that might have been a
   * failure" rules below are what make the next call retry.
   */
  private async resolveKeyDetailed(opts?: { allowOpPrompt?: boolean }): Promise<KeyResolution> {
    // A cached key is a SETTLED answer — either a real value or a stable,
    // deliberately-memoized absence. Neither carries a failure, because the
    // rules below refuse to cache anything that might have been one.
    if (this.cachedKey !== undefined) return { key: this.cachedKey };
    if (this.resolving) return this.resolving;

    this.resolving = (async (): Promise<KeyResolution> => {
      // Steps 1-3: env / aliases / config — no SDK.
      const local = this.resolveFromEnvConfig();
      if (local) {
        this.cachedKey = local;
        return { key: local };
      }
      // Step 4: macOS Keychain, only if the backend is on (the sync sniff gates
      // the `security` spawn). Local and quiet, so it is tried before 1Password.
      let keychainFailure: string | undefined;
      if (hasKeychainSource()) {
        const kc = resolveKeychainKeyForEnvVars([this.envVar, ...this.aliases]);
        if (kc.value) {
          // Write-through mirror: child processes inherit this and re-resolve
          // nothing — the same contract the op step below honours.
          process.env[this.envVar] = kc.value;
          recordKeychainHydratedVar(this.envVar);
          this.cachedKey = kc.value;
          return { key: kc.value };
        }
        // A keychain MISS is stable (the item is genuinely absent) and may be
        // cached below. A keychain FAILURE — locked, or a declined ACL — is
        // transient and must not be, or one early stumble would mark this
        // provider unavailable for the rest of the process.
        if (kc.failed) {
          keychainFailure = kc.error
            ? `macOS Keychain could not be read: ${kc.error}`
            : "macOS Keychain could not be read";
        }
      }
      // Step 5: 1Password, only if a source exists (the sync sniff gates the SDK).
      if (hasOpSources()) {
        const wanted = new Set<string>([this.envVar, ...this.aliases]);
        // Capture the first swallowed reason. `onAuthFailure:"skip"` is right —
        // a credential backend having a bad day must not take down an MCP or
        // serve process — but skipping the ERROR is not the same as skipping
        // the exception, and this is where the two were conflated.
        let opFailure: string | undefined;
        const resolved = await resolveOpKeyForEnvVars(wanted, {
          onAuthFailure: "skip",
          allowPrompt: opts?.allowOpPrompt ?? false,
          onFailure: (reason) => {
            opFailure ??= reason;
          },
        });
        const value =
          resolved[this.envVar] ?? this.aliases.map((a) => resolved[a]).find((v) => !!v);
        if (value) {
          // Write-through mirror: child processes inherit this, no re-resolve.
          process.env[this.envVar] = value;
          this.cachedKey = value;
          return { key: value };
        }
        // op source EXISTS but resolution came back empty — this can be a
        // TRANSIENT op-auth failure (onAuthFailure:"skip" swallows it). Do NOT
        // cache the miss, or a single early failure would mark the provider
        // permanently unavailable. Return "" WITHOUT caching so the next call
        // retries (e.g. once the 1Password desktop handshake completes).
        //
        // The keychain failure is reported only when 1Password did not fail
        // too: one reason is a remedy the user can act on, two are a list to
        // triage. 1Password wins because it is the step that actually answered
        // last for this key.
        return { key: "", failure: opFailure ?? keychainFailure };
      }
      // No op source at all → the empty result is stable and safe to cache,
      // UNLESS the keychain step above failed rather than simply missing: that
      // failure is transient, so leave the result uncached and let the next
      // call retry once the keychain is unlocked.
      if (!keychainFailure) this.cachedKey = "";
      return { key: "", failure: keychainFailure };
    })();

    try {
      return await this.resolving;
    } finally {
      this.resolving = undefined;
    }
  }

  /**
   * Three-valued readiness. `isAvailable()` below is its `=== "present"`
   * projection, so the two cannot disagree about whether this provider routes.
   *
   * The ORDER of the cheap checks is the same as it always was, and it matters
   * for more than speed: a key already in env/config, or an oauth file on disk,
   * makes the provider `present` without ever touching a vault — so a broken
   * keychain or a denied 1Password cannot downgrade a provider that was never
   * going to ask them.
   */
  async describeReadiness(opts?: { allowOpPrompt?: boolean }): Promise<ReadinessResult> {
    // A provider that takes no credential is always available. Checked FIRST and
    // before any resolution, because there is nothing to resolve: reaching the
    // env/config/oauth/1Password chain for it would be pure cost, and on the
    // 1Password step a real prompt for a key that does not exist.
    if (this.authScheme === "none") return { readiness: "present" };
    // Cheap checks first — avoid the op pull when an oauth file already qualifies.
    if (this.resolveFromEnvConfig()) return { readiness: "present" };
    if (this.hasOauthFallbackFile()) return { readiness: "present" };
    const { key, failure } = await this.resolveKeyDetailed(opts);
    if (key) return { readiness: "present" };
    // No key AND no failure means every store answered and none holds one —
    // which is the ordinary state of every provider the user has not set up,
    // and must stay `absent`.
    return failure ? { readiness: "failed", detail: failure } : { readiness: "absent" };
  }

  async isAvailable(opts?: { allowOpPrompt?: boolean }): Promise<boolean> {
    return (await this.describeReadiness(opts)).readiness === "present";
  }

  invalidate(): void {
    this.cachedKey = undefined;
    this.resolving = undefined;
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    // No credential expected → send the static headers and nothing else. Returns
    // before any resolution for the same reason isAvailable does.
    //
    // This is also why `"none"` could not be expressed by leaving the key empty:
    // the `x-api-key` branch below emits the header UNCONDITIONALLY, so an empty
    // key under that scheme would put a literal `x-api-key: ` on the wire — worse
    // than no header, since a gateway that ignores unknown auth may still reject
    // a malformed one.
    if (this.authScheme === "none") {
      // Deliberately UNMARKED (no `arm`). No credential arm answered here — the
      // provider declares it needs none — and "unknown" is the honest value. A
      // consumer that maps arms to money reads unknown as the paid answer, which
      // is the safe direction.
      return { headers: { ...this.staticHeaders } };
    }
    // No invented fallback: a provider that resolves nothing signs with nothing,
    // and the routing pre-flight is right to reject that as "no credential"
    // rather than send a guessed token and collect a 401 downstream. A provider
    // that genuinely needs no credential says so with `authScheme: "none"`,
    // which returned above.
    const key = await this.resolveKey({ allowOpPrompt: ctx.allowOpPrompt });
    let headers: Record<string, string>;
    if (this.authScheme === "x-api-key") {
      headers = { "x-api-key": key, ...this.staticHeaders };
    } else if (key) {
      headers = { Authorization: `Bearer ${key}`, ...this.staticHeaders };
    } else {
      headers = { ...this.staticHeaders };
    }
    // Stamped on EVERY return of this branch, including the keyless one above
    // (`headers = {...staticHeaders}` — an artifact with no Authorization at all).
    // That is the point: this method never returns null and never throws, so
    // "something came back" says nothing about which arm won. Only this marker
    // does. See CompositeCredentialProvider.getRequestAuth and
    // OpenAICodexTransport.signRequest.
    return { arm: "api-key", headers };
  }
}
