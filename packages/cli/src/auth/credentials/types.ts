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
 *    disk? local provider enabled? op:// resolvable? Normally never throws (a
 *    1Password auth failure resolves to `false`). Codex pool presence is the
 *    exception: unknown account configuration throws so signing cannot use a key.
 *  - `getRequestAuth()` — ASYNC, produces the rich artifact (headers, optional
 *    endpoint override, optional payload transform) for an outgoing request.
 *    OAuth token refreshes and op:// pulls happen here, internally.
 *  - `invalidate()` — drop any memoized resolution (after a TUI hydrate-on-add).
 */

/**
 * Three-valued credential readiness — "I could not ask" is NOT "there is
 * nothing there".
 *
 * `isAvailable()` answers a boolean, and a boolean has exactly one slot for two
 * different facts. Every resolution failure therefore collapsed into `false`,
 * which reads downstream as "this user has no credential for this provider":
 * the candidate is filtered out of the routing chain and a metered provider
 * serves the request with no line printed. A locked Mac, a denied 1Password
 * handshake or a keychain ACL the user declined would silently move a
 * flat-rate subscriber onto pay-per-token.
 *
 *  - `present` — a credential resolved (or none is required).
 *  - `absent`  — every source was consulted and none holds one. A STABLE answer.
 *  - `failed`  — a source could not be consulted at all. TRANSIENT, and it says
 *                nothing about whether the credential exists.
 *
 * `failed` normally keeps a candidate out of the chain. A typed Codex account-list
 * failure is the exception: routing retains it and skips credential-dependent
 * discovery so signing can return the repair/transient verdict, never a metered
 * substitute. The keychain/op source's failure evidence survives to the caller.
 */
export type CredentialReadiness = "present" | "absent" | "failed";

/** A readiness verdict, with a one-line diagnostic when it is `failed`. */
export interface ReadinessResult {
  readiness: CredentialReadiness;
  /**
   * Why the credential could not be resolved, for `failed`. On `present` it may
   * name where a key that has not been read yet will be read from
   * (`macOS Keychain (read when used)`). NEVER key material — these strings
   * reach stderr and the routing warning.
   */
  detail?: string;
  /** A typed account-list failure must reach Codex signing, never a metered hop. */
  failureReason?: "accounts-list";
}

/**
 * A thrown value as ONE bounded line, for {@link ReadinessResult.detail}.
 *
 * Lives here, beside the type it serves, so the authority, the composite and
 * every provider format a failure the same way — a second implementation of
 * this is a second thing that can disagree. It is bounded because an SDK error
 * can be a multi-line Rust struct dump, and pasting one into a routing warning
 * buries the sentence that matters.
 *
 * Message text only, and redacted — see {@link redactSecrets}. claudish's own
 * credential sources never put key material in an error message, but this line
 * is not always ours: it can be an SDK's, a shell tool's, or an upstream
 * server's, and those quote what they were given.
 */
export function readinessDetail(err: unknown): string | undefined {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).split("\n")[0].trim();
  if (!raw) return undefined;
  const line = redactSecrets(raw);
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Remove anything key-shaped from a line that is about to be shown or logged.
 *
 * Defence in depth, for the case where the text is not ours. The concrete
 * vector is a URL: Google's endpoints take the key as a QUERY PARAMETER, so any
 * error that quotes the request URL — a fetch failure, a 400 body, a curl-style
 * diagnostic from a shell tool — carries the key inside an otherwise ordinary
 * sentence. An `Authorization` header echoed into an error body does the same.
 *
 * Deliberately narrow. It targets the shapes a secret actually takes, rather
 * than masking every long token, because over-redacting destroys the part of
 * the message a user needs: a redacted request id or model name turns a
 * diagnosable failure into "something went wrong".
 */
export function redactSecrets(text: string): string {
  return (
    text
      // `?key=…`, `&api_key=…`, `token=…`, `secret=…`, `password=…`
      .replace(
        /([?&](?:api[-_]?key|key|access[-_]?token|token|secret|password)=)[^&\s"']+/gi,
        "$1[redacted]"
      )
      // `Authorization: Bearer …`, and a bare `Bearer …`
      .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
      // Vendor-prefixed keys, which are self-identifying: sk-…, sk_live_…, AIza…,
      // ghp_…, xoxb-…. The prefix is kept so the reader can see WHICH credential.
      .replace(/\b(sk|rk|pk)[-_][A-Za-z0-9_-]{12,}/g, "$1-[redacted]")
      .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, "AIza[redacted]")
      .replace(/\b(gh[pousr]_)[A-Za-z0-9]{16,}/g, "$1[redacted]")
      .replace(/\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g, "$1[redacted]")
  );
}

import type { EffortLevel } from "../../adapters/base-api-format.js";
import type { ModelIdChoice } from "../../providers/model-id-effort-choice.js";
import type { SelectReason } from "../accounts/policy.js";
import type { AccountRef, AccountSelectionContext } from "../accounts/types.js";

export interface RequestAuthContext {
  model: string;
  exclude?: AccountRef[];
  pin?: AccountRef;
  rejected?: RequestAuth;
  requireOAuth?: boolean;
  selectionContext?: AccountSelectionContext;
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
  account?: AccountRef;
  /**
   * Why the pool chose `account` (`AccountLease.reason`). Data only: the usage
   * ledger records it, and nothing decides on it.
   */
  selectReason?: SelectReason;
  headers: Record<string, string>;
  endpoint?: string;
  /**
   * Wrap the payload in the provider envelope. `request`, when given, carries
   * THIS request's effort, so one artifact serves turns with different levels,
   * and `onModelChoice`, told the model id the envelope sends and what decided
   * it, where the envelope chooses one.
   */
  transformPayload?(
    payload: any,
    request?: { effort?: EffortLevel; onModelChoice?: (choice: ModelIdChoice) => void }
  ): any;
  /**
   * Which half of a composite produced this. Set by the halves themselves and
   * passed through untouched by `CompositeCredentialProvider`, so a consumer can
   * ask the artifact what signed instead of inferring it.
   *
   * Optional, and its ABSENCE must be read as "unknown", never as a default arm:
   * a consumer that maps arms to money resolves unknown toward the metered/paid
   * answer, so a provider that forgets to set it over-reports cost rather than
   * hiding a real bill. See `OpenAICodexTransport.signRequest`.
   */
  arm?: CredentialArm;
  /**
   * A display-safe name of the credential that signed (no secret in it), for
   * a provider with several login sources: Muse Code's
   * `Muse Code borrowed copy · Muse Code Power Usage`. A transport returns it
   * from `signingCredential()`, and `--probe` reads it off the response.
   */
  signer?: string;
}

/**
 * Where a resolved API key came from: the step of the resolution chain that
 * produced it. A label, never key material. A credential provider sees a
 * `.env` value only once it is loaded into the environment, and reports that
 * one as `environment`.
 */
export type KeySource = "environment" | "config" | "macOS Keychain" | "1Password";

/** The origin of the key a provider last resolved: its source and a masked value. */
export interface KeyOrigin {
  source: KeySource;
  /** `maskCredential` of the key: its first and last four characters. */
  masked: string;
}

/** The answer to "resolve the key now, for a use that signs with it". */
export type UseResolution =
  | { state: "present"; key: string; source: KeySource }
  | { state: "absent"; searched: string[] }
  | { state: "failed"; reason: string };

export interface CredentialProvider {
  readonly catalogName: string;
  /**
   * ASYNC readiness: env var / config key / oauth file / local enabled / op://
   * resolvable. Normally never throws — a 1Password auth failure resolves to
   * false. CodexPoolHalf throws typed account-list errors on unknown presence;
   * the authority describes those as failed, while sign-time dispatch rethrows.
   */
  isAvailable(opts?: { allowOpPrompt?: boolean }): Promise<boolean>;
  /**
   * OPTIONAL three-valued readiness — implement it wherever this provider can
   * tell "no credential" apart from "could not ask" (see
   * {@link CredentialReadiness}).
   *
   * CONTRACT, and it is load-bearing: the authority projects
   * `isAvailable(name)` as `describeReadiness(name).readiness === "present"`, so
   * an implementation MUST agree with its own `isAvailable()` on that boundary
   * or routing changes. The safe way to hold the contract is to define
   * `isAvailable()` as the projection of this method rather than writing the
   * two independently — every implementation here does.
   *
   * A provider that does not implement it is not wrong, only less informative:
   * the authority falls back to `isAvailable()` and maps `false` to `absent`,
   * which is exactly the behaviour that existed before.
   */
  describeReadiness?(opts?: { allowOpPrompt?: boolean }): Promise<ReadinessResult>;
  /**
   * OPTIONAL: resolve the API key now, for a use that will sign with it, keeping
   * the step that produced it, the vault's reason when a store could not be
   * asked, or the sources searched. Implemented by API-key providers.
   */
  resolveForUse?(opts?: { allowOpPrompt?: boolean }): Promise<UseResolution>;
  /** OPTIONAL: where the last key this provider resolved came from, masked. */
  describeOrigin?(): KeyOrigin | undefined;
  /** ASYNC: the rich artifact for an outgoing request. Refreshes OAuth / pulls op:// internally. */
  getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth>;
  /**
   * Stable identity material for the credential that WOULD sign now, plus every
   * endpoint override this provider honours. Never sent, never logged, never
   * persisted; only hashed by the dynamic models catalog store. No network.
   * undefined when nothing would sign.
   *
   * A provider that does not implement it never has its dynamic models catalog
   * persisted, which is the fail-closed answer: without identity, a stored list
   * could be read back for a different account.
   */
  accountIdentity?(opts?: { allowOpPrompt?: boolean }): Promise<string | undefined>;
  /** Drop any memoized resolution so the next read re-resolves (TUI hydrate-on-add). */
  invalidate?(): void;
  /**
   * Sign with a key the user just saved to `source`, until the next
   * `invalidate()`. Held in memory only, never written into `process.env`.
   */
  replaceKey?(key: string, source: KeySource): void;
  /**
   * The local stores that still outrank a key saved to `savedTo` in a new
   * process (see `ApiKeyCredentialProvider.sourcesOutranking`).
   */
  sourcesOutranking?(key: string, savedTo: KeySource): KeySource[];
  login?(): Promise<void>;
  logout?(): Promise<void>;
}
