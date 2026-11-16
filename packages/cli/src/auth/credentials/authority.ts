/**
 * CredentialAuthority — the single registry/dispatch point for credentials.
 *
 * The single ASYNC source of truth for provider credentials. proxy-server
 * (sign-time getRequestAuth), routing-rules (hasCredentialsForProvider), the
 * model-selector/index readiness checks, provider-resolver, and the OAuth
 * transports all consume it; the old per-entry-point env-push paths
 * (loadStoredApiKeys/hydrateOpSecrets/applyCustomEndpointOpKeys) are gone.
 * Registering a provider under multiple names (aliases) lets the catalog's
 * alternate slugs and the runtime request-path names (e.g. "gemini" — the
 * RemoteProvider rename of the "google" catalog entry) resolve to the same
 * instance.
 */

import { BUILTIN_PROVIDERS, getProviderByName } from "../../providers/provider-definitions.js";
import { AccountListInvalidError, AccountListUnavailableError } from "../accounts/errors.js";
import { AntigravityCredentialProvider } from "./antigravity-credential.js";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { clearSignedArm, installBillingProbes } from "./billing-probe.js";
import { makeCodexCredential } from "./codex-credential.js";
import { DevinCredentialProvider } from "./devin-credential.js";
import { GrokSubscriptionCredentialProvider } from "./grok-credential.js";
import { keySourcesSearched } from "./key-sources.js";
import { makeKimiCodingCredential, makeKimiCredential } from "./kimi-credential.js";
import { LocalCredentialProvider } from "./local-credential.js";
import { MuseCodeCredentialProvider } from "./muse-code-credential.js";
import { NativeAnthropicCredentialProvider } from "./native-anthropic-credential.js";
import type {
  CredentialProvider,
  KeyOrigin,
  KeySource,
  ReadinessResult,
  RequestAuth,
  RequestAuthContext,
  UseResolution,
} from "./types.js";
import { readinessDetail } from "./types.js";
import { VertexCredentialProvider } from "./vertex-credential.js";

/**
 * Re-exported from `types.js`, which is where the interface that carries them
 * lives. The authority is the documented home of the readiness vocabulary, so
 * consumers import it from here and never have to know which of the two files
 * declares it.
 */
export type {
  CredentialReadiness,
  KeyOrigin,
  KeySource,
  ReadinessResult,
  UseResolution,
} from "./types.js";
export { readinessDetail } from "./types.js";

/** Built-in local provider names that get a LocalCredentialProvider. */
const LOCAL_PROVIDER_NAMES = ["ollama", "lmstudio", "vllm", "mlx"];

/**
 * Runtime request-path aliases. toRemoteProvider() (provider-definitions.ts)
 * renames some catalog providers before the request path sees them — e.g.
 * "google" → "gemini" — and proxy-server signs requests with that RUNTIME name
 * (credentials.getRequestAuth(resolved.provider.name)). The credential must
 * resolve under both names or the request path 500s on a name the authority
 * never registered.
 */
const RUNTIME_NAME_ALIASES: Record<string, string[]> = {
  google: ["gemini"],
};

/**
 * Map a definition's declared auth scheme onto the credential provider's.
 *
 * Both registration sites used to inline `=== "x-api-key" ? "x-api-key" :
 * "bearer"`, which silently collapsed EVERY other value — including the new
 * `"none"` — into bearer. A keyless endpoint would then have been reported
 * uncredentialed and, if it got past that, signed with `Bearer ` and an empty
 * key. One function so the two sites cannot disagree, and so adding a scheme is
 * a change in one place rather than a hunt for ternaries.
 */
function normalizeAuthScheme(
  scheme: "bearer" | "x-api-key" | "none" | undefined
): "bearer" | "x-api-key" | "none" {
  if (scheme === "x-api-key") return "x-api-key";
  if (scheme === "none") return "none";
  return "bearer";
}

export class CredentialAuthority {
  private registry = new Map<string, CredentialProvider>();
  private invalidationListeners = new Set<(name?: string) => void>();

  register(p: CredentialProvider, aliases: string[] = []): void {
    this.registry.set(p.catalogName, p);
    for (const a of aliases) {
      this.registry.set(a, p);
    }
  }

  /**
   * Register (or replace) a plain API-key provider at RUNTIME — used by custom
   * endpoints, which are loaded after this singleton is built. Idempotent: a
   * re-register with the same name overwrites. This keeps custom endpoints
   * inside the single authority instead of resolving their keys out-of-band.
   *
   * `declaredKey` carries the endpoint's CONFIG-DECLARED key (a literal or an
   * expanded `${VAR}`). Without it a custom endpoint is only credentialed when
   * its `CUSTOM_<NAME>_KEY` env var happens to be set — which nothing but the
   * op:// pre-resolution path ever does — so every `${VAR}`/literal endpoint
   * failed the routing pre-flight with "No API key for provider".
   */
  registerApiKeyProvider(descriptor: {
    name: string;
    envVar: string;
    aliases?: string[];
    authScheme?: "bearer" | "x-api-key" | "none";
    declaredKey?: () => string | undefined;
  }): void {
    if (!descriptor.envVar) return;
    this.register(
      new ApiKeyCredentialProvider({
        catalogName: descriptor.name,
        envVar: descriptor.envVar,
        aliases: descriptor.aliases,
        authScheme: normalizeAuthScheme(descriptor.authScheme),
        declaredKey: descriptor.declaredKey,
      }),
      [descriptor.name]
    );
  }

  /**
   * ASYNC readiness, THREE-VALUED: resolves env → config → oauth-file →
   * keychain → op:// (both lazy) and reports `present` / `absent` / `failed`.
   *
   * This method exists because `isAvailable` had exactly one slot for two facts
   * and the old `catch { return false }` here put both in it. Every resolution
   * failure — a denied 1Password handshake and its 15-second machine-wide
   * suppression, a locked Mac, a keychain ACL the user declined, a `security`
   * binary that is not there — became indistinguishable from "this user has no
   * key for this provider". Downstream, `hasCredentialsForProvider`
   * (routing-rules.ts) drops such a candidate from the routing chain, so a
   * flat-rate subscription the user DOES hold was silently replaced by a
   * metered provider and billed per token, with nothing printed.
   *
   * Three things make the third value REACHABLE rather than decorative:
   *   - a provider may implement `describeReadiness()` itself and report
   *     `failed` from a propagated flag — `ApiKeyCredentialProvider` does this
   *     for the keychain's `{value?, failed}` and for an op resolve whose
   *     failure `onAuthFailure:"skip"` swallowed;
   *   - `CompositeCredentialProvider` forwards a half's `failed` instead of
   *     flattening it to a boolean;
   *   - a source that DOES throw is caught here and reported as `failed`.
   *
   * Never throws. An unknown provider is genuinely `absent` — nothing was
   * consulted, so there is no failure to report.
   */
  async describeReadiness(
    name: string,
    opts?: { allowOpPrompt?: boolean }
  ): Promise<ReadinessResult> {
    const provider = this.registry.get(name);
    if (!provider) return { readiness: "absent" };
    try {
      if (provider.describeReadiness) {
        // A provider is allowed to be sloppy about its return; a missing verdict
        // must not become `undefined.readiness` at a call site that reads it.
        return (await provider.describeReadiness(opts)) ?? { readiness: "absent" };
      }
      return { readiness: (await provider.isAvailable(opts)) ? "present" : "absent" };
    } catch (err) {
      return {
        readiness: "failed",
        detail: readinessDetail(err),
        ...(err instanceof AccountListUnavailableError || err instanceof AccountListInvalidError
          ? { failureReason: "accounts-list" as const }
          : {}),
      };
    }
  }

  /**
   * ASYNC readiness: resolves env → config → oauth-file → op:// (lazy SDK) for
   * the provider. Never throws — an unknown provider or a 1Password auth failure
   * resolves to false. Memoized inside each provider, so the SDK is touched at
   * most once. This is THE single readiness oracle (replaces the three old sync
   * ones: isProviderAvailable / isApiKeyAvailable / the old isAuthenticated).
   *
   * UNCHANGED SIGNATURE, UNCHANGED CONTRACT, and deliberately a pure PROJECTION
   * of `describeReadiness` rather than a second implementation. `failed` maps to
   * `false` as before. Routing asks for the full verdict for Codex and retains
   * typed account-list failures, so the handler answers them instead of silently
   * substituting a metered hop. Other callers still get the boolean projection.
   */
  async isAvailable(name: string, opts?: { allowOpPrompt?: boolean }): Promise<boolean> {
    return (await this.describeReadiness(name, opts)).readiness === "present";
  }

  /**
   * Resolve `name`'s API key now, for a use that will sign with it: a launch, or
   * a probe send. One resolution, so the source it reports is the step that
   * produced THIS key, and a vault that could not be read says why instead of
   * looking like a missing key. Never throws; never caches a failure.
   *
   * A provider that does not resolve an API key (an OAuth login, the native
   * passthrough) answers `absent` with the sources an API key would be read from.
   */
  async resolveForUse(name: string, opts?: { allowOpPrompt?: boolean }): Promise<UseResolution> {
    const provider = this.registry.get(name);
    if (!provider?.resolveForUse) return { state: "absent", searched: keySourcesSearched() };
    try {
      return await provider.resolveForUse(opts);
    } catch (err) {
      return {
        state: "failed",
        reason: readinessDetail(err) ?? `the ${name} credential could not be resolved`,
      };
    }
  }

  /**
   * Where the last key `name` resolved in this process came from, and its masked
   * value. Never the key. undefined when nothing has been resolved yet.
   */
  describeOrigin(name: string): KeyOrigin | undefined {
    return this.registry.get(name)?.describeOrigin?.();
  }

  async getRequestAuth(name: string, ctx: RequestAuthContext): Promise<RequestAuth> {
    const p = this.registry.get(name);
    if (!p) throw new Error(`No credential provider for ${name}`);
    return p.getRequestAuth(ctx);
  }

  /**
   * Identity material for the credential `name` would sign with now, bound to
   * the endpoint: the provider's own material, then the value of every base-URL
   * override its definition honours, so the same key against another server
   * reads as another account. Only the dynamic models catalog store consumes it,
   * and only to hash it. It is never logged and never written anywhere.
   *
   * Never throws. undefined for an unknown provider, one that implements no
   * `accountIdentity`, or one with nothing to sign with.
   */
  async accountIdentity(
    name: string,
    opts?: { allowOpPrompt?: boolean }
  ): Promise<string | undefined> {
    const provider = this.registry.get(name);
    if (!provider?.accountIdentity) return undefined;
    try {
      const material = await provider.accountIdentity(opts);
      if (!material) return undefined;
      const overrides = (getProviderByName(name)?.baseUrlEnvVars ?? [])
        .map((envVar) => `${envVar}=${process.env[envVar]?.trim() ?? ""}`)
        .join("\n");
      return overrides ? `${material}\n${overrides}` : material;
    } catch {
      return undefined;
    }
  }

  /**
   * Subscribe to `invalidate()`. A module that memoizes something derived from
   * a credential (the dynamic models catalog's identity memo) drops it here, so
   * an invalidation reaches it without this module importing it.
   */
  onInvalidate(listener: (name?: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  private notifyInvalidated(name?: string): void {
    for (const listener of this.invalidationListeners) {
      try {
        listener(name);
      } catch {
        // A listener's fault must not abort the invalidation of the others.
      }
    }
  }

  /** Every name registered to the same provider instance as `name`, `name` included. */
  private namesSharing(name: string): string[] {
    const provider = this.registry.get(name);
    if (!provider) return [name];
    const names = [...this.registry.entries()]
      .filter(([, registered]) => registered === provider)
      .map(([registeredName]) => registeredName);
    return names.includes(name) ? names : [name, ...names];
  }

  /**
   * A login or logout replaces the account behind `name`, so its stored dynamic
   * models catalog is deleted with it. Loaded lazily: the catalog module imports
   * this one. A failure here never fails the login itself.
   */
  private async forgetModelsLists(name: string): Promise<void> {
    try {
      const { forgetAccountModelsLists } = await import(
        "../../providers/dynamic-models-catalog.js"
      );
      for (const registered of this.namesSharing(name)) forgetAccountModelsLists(registered);
    } catch {
      // Best effort: a new credential derives a new account key and misses anyway.
    }
  }

  /**
   * Drop any memoized resolution. With no name, invalidate every registered
   * provider (after a TUI hydrate-on-add or a config change). Idempotent.
   *
   * Also forgets which arm last SIGNED. The signed-arm record is a statement
   * about a credential state, so it cannot outlive an invalidation of that state:
   * in a long-lived process (the MCP server, `serve`) one successful OAuth request
   * would otherwise pin `SUB` on preflight, `list_models` and the picker after the
   * credential was replaced or removed, until the next request rewrote it.
   * Clearing returns the answer to "which credential WOULD sign", which is the
   * honest answer when nothing has been signed since.
   */
  invalidate(name?: string): void {
    clearSignedArm(name);
    this.notifyInvalidated(name);
    if (name) {
      this.registry.get(name)?.invalidate?.();
      return;
    }
    // Dedup: providers registered under aliases share one instance.
    const seen = new Set<CredentialProvider>();
    for (const p of this.registry.values()) {
      if (seen.has(p)) continue;
      seen.add(p);
      p.invalidate?.();
    }
  }

  /**
   * Make a key the user just saved sign for `name` at once, in this process,
   * without writing it into `process.env`: the provider's memo is dropped (as
   * `invalidate` does) and the saved key outranks every other store until the
   * next invalidation. A provider that cannot hold a replacement is only
   * invalidated.
   */
  replaceKey(name: string, key: string, source: KeySource): void {
    this.invalidate(name);
    this.registry.get(name)?.replaceKey?.(key, source);
  }

  /**
   * The local stores that will still outrank a key just saved to `savedTo`
   * when a new process resolves `name`, so the caller can say so instead of
   * presenting the saved key as the one every launch uses. Call it BEFORE the
   * save touches `process.env` or `config.json`. Never throws.
   */
  sourcesOutranking(name: string, key: string, savedTo: KeySource): KeySource[] {
    try {
      return this.registry.get(name)?.sourcesOutranking?.(key, savedTo) ?? [];
    } catch {
      return [];
    }
  }

  async login(name: string): Promise<void> {
    await this.registry.get(name)?.login?.();
    // A new credential may sign with a different arm than the last request did.
    clearSignedArm(name);
    await this.forgetModelsLists(name);
  }

  async logout(name: string): Promise<void> {
    await this.registry.get(name)?.logout?.();
    // The OAuth file is gone. Keeping a `subscription` record here is the exact
    // staleness that reports SUB and $0 for a user who is now on the API key.
    clearSignedArm(name);
    await this.forgetModelsLists(name);
  }

  get(name: string): CredentialProvider | undefined {
    return this.registry.get(name);
  }

  static buildDefault(): CredentialAuthority {
    const authority = new CredentialAuthority();

    // Explicitly-handled providers (OAuth / composite / ADC / local / native).
    authority.register(makeCodexCredential(), ["openai-codex"]);
    // Antigravity is its OWN product: auth comes from the SHARED Antigravity
    // token (the agy keychain item), not a GEMINI_API_KEY. Registered under its
    // own name so `ag@` requests resolve here (and never onto "google").
    //
    // "google" is the DIRECT Gemini API (GEMINI_API_KEY), registered by the
    // generic loop below under both "google" and its runtime request-path name
    // "gemini" — nothing here may alias it, or a GEMINI_API_KEY-only user looks
    // uncredentialed and "gemini" goes unregistered (probe 500).
    authority.register(new AntigravityCredentialProvider(), ["antigravity"]);
    // Devin's artifact is `authorization: Basic <k>-<k>`, which the generic
    // ApiKeyCredentialProvider cannot express. Its definition carries
    // apiKeyEnvVar: "" so the generic loop below skips it anyway — this
    // registration is what actually makes `dv@` resolvable.
    authority.register(new DevinCredentialProvider(), ["devin"]);
    // The Grok CLI's OIDC token expires in 6 hours and this provider refreshes
    // it, which the generic ApiKeyCredentialProvider cannot do. Its definition
    // carries apiKeyEnvVar: "" so the generic loop below skips it anyway — this
    // registration is what makes `gk@` resolvable. It must NOT alias onto
    // "x-ai": that is the METERED XAI_API_KEY provider, and crossing them would
    // let a pay-per-token key authenticate a flat-rate `SUB` provider.
    authority.register(new GrokSubscriptionCredentialProvider(), ["grok-subscription"]);
    // Muse Code: a key minted from a Meta `dca:` login, confirmed by the mint's
    // entitlement answer. `apiKeyEnvVar: ""`, so the generic loop skips it; it
    // must NOT alias onto "meta", the METERED META_API_KEY provider.
    authority.register(new MuseCodeCredentialProvider(), ["meta-muse-code"]);
    authority.register(makeKimiCredential(), ["kimi"]);
    // kimi-coding is a SEPARATE product with its own endpoint + KIMI_CODING_API_KEY.
    // It must NOT alias onto the regular Kimi credential, or the coding endpoint
    // receives the wrong product's key → 401.
    authority.register(makeKimiCodingCredential(), ["kimi-coding"]);
    authority.register(new VertexCredentialProvider(), ["vertex"]);
    for (const name of LOCAL_PROVIDER_NAMES) {
      authority.register(new LocalCredentialProvider(name), [name]);
    }
    authority.register(new NativeAnthropicCredentialProvider(), ["native-anthropic"]);

    // Names already owned by the explicit registrations above — never override
    // them with a generic API-key provider.
    const alreadyRegistered = new Set<string>([
      "openai-codex",
      "antigravity",
      // Redundant with `apiKeyEnvVar: ""` (the loop skips it either way), and
      // kept because this set is the documented STATEMENT OF INTENT: if someone
      // ever gives the devin definition an env var, the generic provider must
      // still not take the name.
      "devin",
      "kimi",
      "kimi-coding",
      "vertex",
      "native-anthropic",
      ...LOCAL_PROVIDER_NAMES,
    ]);

    // Every other builtin provider that has an API-key env var gets a plain
    // ApiKeyCredentialProvider. Local providers and OAuth-only providers (empty
    // apiKeyEnvVar) are skipped.
    for (const def of BUILTIN_PROVIDERS) {
      if (alreadyRegistered.has(def.name)) continue;
      if (def.isLocal) continue;
      if (!def.apiKeyEnvVar) continue;
      authority.register(
        new ApiKeyCredentialProvider({
          catalogName: def.name,
          envVar: def.apiKeyEnvVar,
          aliases: def.apiKeyAliases,
          authScheme: normalizeAuthScheme(def.authScheme),
          // Mirror the readiness affordances the old isProviderAvailable oracle
          // granted, so authority.isAuthenticated() matches hasCredentialsForProvider.
          // (`publicKeyFallback` was one of these and is gone — a keyless
          // provider now declares `authScheme: "none"`, which says no credential
          // is expected rather than inventing one. See provider-definitions.ts.)
          oauthFallback: def.oauthFallback,
          ...(def.vaultKeyReadAtUse === true ? { readAtUse: true as const } : {}),
        }),
        [def.name, ...(RUNTIME_NAME_ALIASES[def.name] ?? [])]
      );
    }

    return authority;
  }
}

export const credentials = CredentialAuthority.buildDefault();

// Teach the pricing leaf to ask the credential layer which arm signs for the
// dual-mode providers (today: openai-codex). ONE registration site rather than
// three entry points, and the failure is self-consistent: a process that never
// imports this module never authenticates, so "metered" is the right answer for
// it anyway. Unregistered it is silently metered — safe as money, but it also
// suppresses the routing-rules.ts:413 cost warning. See CLAUDE.md's invariants.
installBillingProbes();
