/**
 * CompositeCredentialProvider — tries a primary credential source, falls back
 * to a secondary one.
 *
 * Used for OAuth-or-API-key providers (Codex, Kimi): the OAuth half is primary,
 * the API-key half is the fallback. A `fallbackSignal` lets the primary opt into
 * a fallback by throwing a sentinel error message (e.g. Kimi throws
 * "OAuth_FALLBACK_TO_API_KEY" when its refresh fails and an API key is present).
 */

import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export interface CompositeOptions {
  /**
   * If set, a primary `getRequestAuth()` that throws an error whose message
   * exactly equals this string falls through to the fallback. Any other error
   * is rethrown.
   */
  fallbackSignal?: string;
}

export class CompositeCredentialProvider implements CredentialProvider {
  readonly catalogName: string;
  private readonly primary: CredentialProvider;
  private readonly fallback: CredentialProvider;
  private readonly opts: CompositeOptions;

  constructor(
    catalogName: string,
    primary: CredentialProvider,
    fallback: CredentialProvider,
    opts: CompositeOptions = {}
  ) {
    this.catalogName = catalogName;
    this.primary = primary;
    this.fallback = fallback;
    this.opts = opts;
  }

  async isAvailable(opts?: { allowOpPrompt?: boolean }): Promise<boolean> {
    return (await this.primary.isAvailable(opts)) || (await this.fallback.isAvailable(opts));
  }

  invalidate(): void {
    this.primary.invalidate?.();
    this.fallback.invalidate?.();
  }

  /**
   * Both arms return an artifact; NEITHER returns null.
   *
   * This is the fact consumers get wrong. The fallback below is normally an
   * `ApiKeyCredentialProvider`, whose `getRequestAuth` always returns an object —
   * `{headers:{Authorization:"Bearer …"}}` with a key, `{headers:{}}` without one.
   * So a caller that treats "I got something back" as "the primary signed" is
   * wrong on every fallback request. The only way this method throws is a primary
   * that is AVAILABLE and then fails with something other than `fallbackSignal`.
   *
   * The artifact is returned VERBATIM from whichever half produced it, so its
   * `arm` marker survives — that marker, not the return being non-null, is how a
   * caller learns which credential won.
   */
  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    if (await this.primary.isAvailable({ allowOpPrompt: ctx.allowOpPrompt })) {
      try {
        return await this.primary.getRequestAuth(ctx);
      } catch (e: any) {
        const signal = this.opts.fallbackSignal;
        if (signal && String(e?.message) === signal) {
          return this.fallback.getRequestAuth(ctx);
        }
        throw e;
      }
    }
    return this.fallback.getRequestAuth(ctx);
  }

  async login(): Promise<void> {
    await this.primary.login?.();
  }

  async logout(): Promise<void> {
    await this.primary.logout?.();
  }
}
