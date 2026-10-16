/**
 * CompositeCredentialProvider — tries a primary credential source, falls back
 * to a secondary one.
 *
 * Used for OAuth-or-API-key providers (Codex, Kimi): the OAuth half is primary,
 * the API-key half is the fallback. A `fallbackSignal` lets the primary opt into
 * a fallback by throwing a sentinel error message (Kimi throws
 * "OAuth_FALLBACK_TO_API_KEY" when its login is rejected). The composite falls
 * through only when its fallback half is available, and otherwise rethrows the
 * sentinel's `cause` — the primary's own terminal error.
 */

import type {
  CredentialProvider,
  ReadinessResult,
  RequestAuth,
  RequestAuthContext,
} from "./types.js";

/**
 * One half's readiness, whether or not it implements the tri-state.
 *
 * A half that does not is not wrong, only less informative: its `false` means
 * "absent", which is the answer the whole layer gave before.
 *
 * A half that THROWS is deliberately NOT caught here. The old `isAvailable` was
 * `primary || fallback`, so a throwing half aborted the whole composite and the
 * authority's catch turned it into `false`. Catching it here instead would let
 * the fallback answer for a primary that blew up — better-looking, and a real
 * routing change: a provider that reported unavailable would start reporting
 * available. The throw propagates, the authority reports `failed`, and `failed`
 * projects to `false` — the same boolean, with the reason now attached.
 */
async function readinessOf(
  provider: CredentialProvider,
  opts?: { allowOpPrompt?: boolean }
): Promise<ReadinessResult> {
  if (provider.describeReadiness) {
    return (await provider.describeReadiness(opts)) ?? { readiness: "absent" };
  }
  return { readiness: (await provider.isAvailable(opts)) ? "present" : "absent" };
}

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

  /**
   * Readiness for the pair, keeping a half's `failed` instead of flattening it.
   *
   * This method is not optional decoration. The fallback half is normally an
   * `ApiKeyCredentialProvider`, which is the ONLY place the keychain and
   * 1Password are consulted — so without forwarding, a denied handshake for
   * `kimi` or `openai-codex` would be reported by this composite as a clean
   * `absent`, and the tri-state would be dead on arrival for exactly the
   * subscription providers it exists to protect.
   *
   * `present` short-circuits on the primary, matching the old `||` exactly: a
   * broken fallback store is never consulted, and never downgrades a provider
   * whose OAuth credential already answered. `failed` beats `absent` because a
   * store that could not be asked has not established absence.
   */
  async describeReadiness(opts?: { allowOpPrompt?: boolean }): Promise<ReadinessResult> {
    const primary = await readinessOf(this.primary, opts);
    if (primary.readiness === "present") return primary;
    const fallback = await readinessOf(this.fallback, opts);
    if (fallback.readiness === "present") return fallback;
    if (fallback.readiness === "failed") return fallback;
    if (primary.readiness === "failed") return primary;
    return { readiness: "absent" };
  }

  /** Unchanged contract: the `=== "present"` projection of the above. */
  async isAvailable(opts?: { allowOpPrompt?: boolean }): Promise<boolean> {
    return (await this.describeReadiness(opts)).readiness === "present";
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
          // Fall through ONLY to a fallback that has a credential of its own:
          // the api-key half always returns an artifact, so falling through
          // without asking sent an empty key (`x-api-key: ""`) and lost the
          // primary's message. With no key, the signal's cause (the primary's
          // own terminal error) is what the caller gets.
          if (await this.fallback.isAvailable({ allowOpPrompt: ctx.allowOpPrompt })) {
            return this.fallback.getRequestAuth(ctx);
          }
          throw e?.cause ?? e;
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
