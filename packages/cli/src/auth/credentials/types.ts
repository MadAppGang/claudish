/**
 * Credential Authority — core interfaces.
 *
 * A {@link CredentialProvider} is the single authority for one catalog provider's
 * credentials. The surface is fully ASYNC — readiness and request-auth both pull
 * from 1Password on demand when env/config/oauth-file miss. There is NO sync
 * readiness oracle anymore: 1Password resolution is async, so a credential
 * decision is async too. Resolution is memoized per provider, so the first
 * await pays the SDK cost and subsequent reads are free.
 *
 *  - `isAvailable()` — ASYNC readiness: env var set? config key? oauth file on
 *    disk? local provider enabled? op:// resolvable? Never throws (a 1Password
 *    auth failure resolves to `false`, it does not bring down the caller).
 *  - `getRequestAuth()` — ASYNC, produces the rich artifact (headers, optional
 *    endpoint override, optional payload transform) for an outgoing request.
 *    OAuth token refreshes and op:// pulls happen here, internally.
 *  - `invalidate()` — drop any memoized resolution (after a TUI hydrate-on-add).
 */

export interface RequestAuthContext {
  model: string;
  forceRefresh?: boolean;
  /**
   * When set, 1Password resolution is allowed to prompt interactively (TTY only)
   * for a multi-account picker. Off by default — routing/sign-time never prompt.
   */
  allowOpPrompt?: boolean;
}

/**
 * Which ARM of a dual-mode credential minted an artifact.
 *
 * Names the CREDENTIAL, not the billing outcome, and the distinction is
 * load-bearing. `ApiKeyCredentialProvider` is the fallback half of every
 * composite AND the sole provider for ~40 single-mode providers, several of
 * which are flat-rate plans bought with an API key (`kimi-coding`,
 * `glm-coding`, `minimax-coding`). Stamping those artifacts `"metered"` would
 * put a false statement in the type, and the next person to generalise the
 * billing record would inherit it. `"api-key"` is true of all of them; the
 * arm→billing mapping is per provider and belongs at the consumer, which is
 * where the evidence for it lives (for `openai-codex`, the two-host argument in
 * `handlers/shared/remote-provider-types.ts`).
 */
export type CredentialArm = "oauth" | "api-key";

export interface RequestAuth {
  headers: Record<string, string>;
  endpoint?: string;
  transformPayload?(payload: any): any;
  /**
   * Which half of a composite produced this. Set by the halves themselves and
   * passed through untouched by `CompositeCredentialProvider`, so a consumer can
   * ask the artifact what signed instead of inferring it.
   *
   * Optional, and its ABSENCE must be read as "unknown", never as a default arm:
   * a consumer that maps arms to money resolves unknown toward the metered/paid
   * answer, so a provider that forgets to set it over-reports cost rather than
   * hiding a real bill. See `OpenAICodexTransport.refreshAuth`.
   */
  arm?: CredentialArm;
}

export interface CredentialProvider {
  readonly catalogName: string;
  /**
   * ASYNC readiness: env var / config key / oauth file / local enabled / op://
   * resolvable. Never throws — a 1Password auth failure resolves to false so the
   * server keeps running. Memoized: the SDK is touched at most once per provider.
   */
  isAvailable(opts?: { allowOpPrompt?: boolean }): Promise<boolean>;
  /** ASYNC: the rich artifact for an outgoing request. Refreshes OAuth / pulls op:// internally. */
  getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth>;
  /** Drop any memoized resolution so the next read re-resolves (TUI hydrate-on-add). */
  invalidate?(): void;
  login?(): Promise<void>;
  logout?(): Promise<void>;
}
