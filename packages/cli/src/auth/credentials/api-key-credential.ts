/**
 * ApiKeyCredentialProvider — the credential authority for API-key providers.
 *
 * Resolution order (ASYNC, memoized per provider):
 *   1. process.env[envVar]
 *   2. process.env[alias] for each alias
 *   3. getApiKey(envVar) — config.json apiKeys map
 *   4. 1Password (op:// — lazy SDK, only when 1-3 missed AND an op source exists)
 *
 * When step 4 resolves a key, the value is written THROUGH into process.env so
 * spawned child processes (MCP team/channel) inherit it and never touch the SDK.
 * The authority is the ONLY code that pushes op:// keys into process.env.
 *
 * `isAvailable()` additionally honors two affordances the legacy oracle granted:
 *   - `publicKeyFallback`: the provider ships a free/public key VALUE → always
 *     available, and `getRequestAuth()` emits that value when no real key resolves.
 *   - `oauthFallback`: a `<file>` under ~/.claudish/ — if that OAuth credential
 *     file exists, the provider is available even without an env/config/op key.
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
import { getApiKey } from "../../profile-config.js";
import { hasOpSources, resolveOpKeyForEnvVars } from "./op-source.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export interface ApiKeyDescriptor {
  catalogName: string;
  envVar: string;
  aliases?: string[];
  authScheme?: "bearer" | "x-api-key";
  staticHeaders?: Record<string, string>;
  /**
   * Public/free API key VALUE (e.g. "public") sent when no real key resolves —
   * the provider is always available and getRequestAuth emits this fallback as
   * the key. Mirrors ProviderDefinition.publicKeyFallback (same string).
   */
  publicKeyFallback?: string;
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
  private readonly authScheme: "bearer" | "x-api-key";
  private readonly staticHeaders: Record<string, string>;
  private readonly publicKeyFallback?: string;
  private readonly oauthFallback?: string;
  private readonly declaredKey?: () => string | undefined;

  /** Memoized resolved key ("" = resolved-and-empty). undefined = not yet resolved. */
  private cachedKey: string | undefined;
  /** In-flight resolution, so concurrent callers share one op pull. */
  private resolving: Promise<string> | undefined;

  constructor(descriptor: ApiKeyDescriptor) {
    this.catalogName = descriptor.catalogName;
    this.envVar = descriptor.envVar;
    this.aliases = descriptor.aliases ?? [];
    this.authScheme = descriptor.authScheme ?? "bearer";
    this.staticHeaders = descriptor.staticHeaders ?? {};
    this.publicKeyFallback = descriptor.publicKeyFallback;
    this.oauthFallback = descriptor.oauthFallback;
    this.declaredKey = descriptor.declaredKey;
  }

  /**
   * SYNC: env → aliases → config.json apiKeys → declared key (custom endpoints).
   * Does NOT touch 1Password.
   */
  private resolveFromEnvConfig(): string | undefined {
    // NOTE: map alias names to their VALUES before .find — `aliases.find(a =>
    // process.env[a])` would return the alias NAME (a truthy string), so the
    // credential would send the literal env-var name as the API key → 401.
    // realValue() drops unexpanded `${VAR}` placeholders at EVERY step — a host
    // can leak one into env, and a config/declared value can carry one whose
    // referenced variable is unset. A placeholder must never shadow 1Password.
    return (
      realValue(process.env[this.envVar]) ||
      this.aliases.map((a) => realValue(process.env[a])).find((v) => !!v) ||
      realValue(getApiKey(this.envVar)) ||
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
   * ASYNC resolved key: env → aliases → config → op:// (lazy). Memoized; the
   * op pull happens at most once. Writes a resolved op key THROUGH to
   * process.env so spawned children inherit it.
   */
  private async resolveKey(opts?: { allowOpPrompt?: boolean }): Promise<string> {
    if (this.cachedKey !== undefined) return this.cachedKey;
    if (this.resolving) return this.resolving;

    this.resolving = (async () => {
      // Steps 1-3: env / aliases / config — no SDK.
      const local = this.resolveFromEnvConfig();
      if (local) {
        this.cachedKey = local;
        return local;
      }
      // Step 4: 1Password, only if a source exists (the sync sniff gates the SDK).
      if (hasOpSources()) {
        const wanted = new Set<string>([this.envVar, ...this.aliases]);
        const resolved = await resolveOpKeyForEnvVars(wanted, {
          onAuthFailure: "skip",
          allowPrompt: opts?.allowOpPrompt ?? false,
        });
        const value =
          resolved[this.envVar] ?? this.aliases.map((a) => resolved[a]).find((v) => !!v);
        if (value) {
          // Write-through mirror: child processes inherit this, no re-resolve.
          process.env[this.envVar] = value;
          this.cachedKey = value;
          return value;
        }
        // op source EXISTS but resolution came back empty — this can be a
        // TRANSIENT op-auth failure (onAuthFailure:"skip" swallows it). Do NOT
        // cache the miss, or a single early failure would mark the provider
        // permanently unavailable. Return "" WITHOUT caching so the next call
        // retries (e.g. once the 1Password desktop handshake completes).
        return "";
      }
      // No op source at all → the empty result is stable; safe to cache.
      this.cachedKey = "";
      return "";
    })();

    try {
      return await this.resolving;
    } finally {
      this.resolving = undefined;
    }
  }

  async isAvailable(opts?: { allowOpPrompt?: boolean }): Promise<boolean> {
    if (this.publicKeyFallback) return true;
    // Cheap checks first — avoid the op pull when an oauth file already qualifies.
    if (this.resolveFromEnvConfig()) return true;
    if (this.hasOauthFallbackFile()) return true;
    const key = await this.resolveKey(opts);
    return !!key;
  }

  invalidate(): void {
    this.cachedKey = undefined;
    this.resolving = undefined;
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    // A real user key always wins; the catalog's public/free fallback key only
    // fills in when nothing resolved. Without this, a keyless publicKeyFallback
    // provider (e.g. OpenCode Zen) returned EMPTY headers and proxy-server
    // rejected the route as "no credential" before the handler was built.
    const key =
      (await this.resolveKey({ allowOpPrompt: ctx.allowOpPrompt })) || this.publicKeyFallback || "";
    let headers: Record<string, string>;
    if (this.authScheme === "x-api-key") {
      headers = { "x-api-key": key, ...this.staticHeaders };
    } else if (key) {
      headers = { Authorization: `Bearer ${key}`, ...this.staticHeaders };
    } else {
      headers = { ...this.staticHeaders };
    }
    return { headers };
  }
}
