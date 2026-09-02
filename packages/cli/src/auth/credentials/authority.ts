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

import { BUILTIN_PROVIDERS } from "../../providers/provider-definitions.js";
import { AntigravityCredentialProvider } from "./antigravity-credential.js";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { clearSignedArm, installBillingProbes } from "./billing-probe.js";
import { makeCodexCredential } from "./codex-credential.js";
import { DevinCredentialProvider } from "./devin-credential.js";
import { GrokSubscriptionCredentialProvider } from "./grok-credential.js";
import { makeKimiCodingCredential, makeKimiCredential } from "./kimi-credential.js";
import { LocalCredentialProvider } from "./local-credential.js";
import { NativeAnthropicCredentialProvider } from "./native-anthropic-credential.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";
import { VertexCredentialProvider } from "./vertex-credential.js";

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
   * ASYNC readiness: resolves env → config → oauth-file → op:// (lazy SDK) for
   * the provider. Never throws — an unknown provider or a 1Password auth failure
   * resolves to false. Memoized inside each provider, so the SDK is touched at
   * most once. This is THE single readiness oracle (replaces the three old sync
   * ones: isProviderAvailable / isApiKeyAvailable / the old isAuthenticated).
   */
  async isAvailable(name: string, opts?: { allowOpPrompt?: boolean }): Promise<boolean> {
    try {
      return (await this.registry.get(name)?.isAvailable(opts)) ?? false;
    } catch {
      return false;
    }
  }

  async getRequestAuth(name: string, ctx: RequestAuthContext): Promise<RequestAuth> {
    const p = this.registry.get(name);
    if (!p) throw new Error(`No credential provider for ${name}`);
    return p.getRequestAuth(ctx);
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

  async login(name: string): Promise<void> {
    await this.registry.get(name)?.login?.();
    // A new credential may sign with a different arm than the last request did.
    clearSignedArm(name);
  }

  async logout(name: string): Promise<void> {
    await this.registry.get(name)?.logout?.();
    // The OAuth file is gone. Keeping a `subscription` record here is the exact
    // staleness that reports SUB and $0 for a user who is now on the API key.
    clearSignedArm(name);
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
