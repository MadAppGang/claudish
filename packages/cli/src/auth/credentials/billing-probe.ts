/**
 * Which credential actually signs, expressed as a billing answer.
 *
 * Two tiers, in priority order:
 *   1. `signedArm` — what the transport ACTUALLY resolved on the last request.
 *      Exact. Written by OpenAICodexTransport.refreshAuth(), which is the only
 *      place that knows whether the OAuth arm or the api-key arm won
 *      (providers/transport/openai-codex.ts:56-63).
 *   2. `PROBES` — what WOULD sign, for surfaces that ask before any request
 *      (preflight, the picker). For openai-codex that is
 *      CodexOAuthHalf.isAvailable() (codex-credential.ts:45-47) ==
 *      CodexOAuth.getInstance().hasCredentials().
 *
 * Deliberately NOT hasOAuthCredentials("openai-codex") (auth/oauth-registry.ts:106)
 * and NOT describeSourceSync (auth/credentials/source.ts:111, whose OAuth branch
 * delegates to the same function). Both return true for an `access_token` with an
 * unexpired `expires_at` and NO `refresh_token` (oauth-registry.ts:88-97) — a state
 * where CodexOAuth.hasCredentials() is FALSE (codex-oauth.ts:104-106, :311, which
 * nulls the whole credential unless all three fields are present) and the API key
 * is what actually signs. Reporting SUB there under-reports real money, which is
 * the one direction that costs the user. Three reviewers verified this
 * independently; billing-probe.test.ts pins it.
 *
 * This adds NO file I/O: the CodexOAuth singleton and its one credential-file read
 * already happen when authority.ts is imported (authority.ts:235 → :157 →
 * codex-credential.ts:43's field initialiser). What is new is that the result now
 * decides a billing label.
 *
 * Both tiers are overridable in tests via the CodexOAuth singleton-override seam
 * (equivalence.test.ts:136-152) — never `mock.module`, never a credential fixture
 * file under $HOME (scripts/guard-real-config.ts:31 sandboxes only config.json).
 */

import { registerSubscriptionCredentialProbe } from "../../handlers/shared/remote-provider-types.js";
import { CodexOAuth } from "../codex-oauth.js";

/** Which arm of a dual-mode credential signed: the flat-rate one or the metered one. */
export type SignedArm = "subscription" | "metered";

/**
 * The arm that ACTUALLY signed, per provider, from the last request.
 *
 * Written by the transport after it resolves auth; read by the probe. This is the
 * `recordOpHydratedVars` shape (op-source.ts): async resolution writes a
 * run-scoped record, sync code reads it afterwards.
 *
 * Absent = no request has been signed yet, in which case the probe falls back to
 * "which credential WOULD sign" — the honest answer for a display surface that
 * runs before any request (preflight, the picker).
 *
 * Keyed by provider, not by handler: under the `serve` gateway two concurrent
 * Codex conversations share one entry (risk R-14), last write wins.
 *
 * The unsafe interleaving is TWO HEALTHY conversations on opposite arms, not
 * "a failure followed by a success" — an earlier version of this comment claimed
 * the latter and it understated the risk. A successful OAuth `refreshAuth`
 * writes "subscription"; a successful `OPENAI_CODEX_API_KEY` one writes
 * "metered". Neither is a failure. `TokenTracker.getPricing` re-queries per
 * stream delta (token-tracker.ts:347-348), so the metered conversation can pick
 * up the other's "subscription" mid-stream and accrue that request's tokens as
 * $0 with `is_free: true` — printing FREE on the status line
 * (claude-runner.ts:366) for usage OpenAI is billing. The opposite direction
 * (a subscriber over-quoted) is cosmetic.
 *
 * The window is one request per mislabelled read, and a same-arm process (the
 * common case: one credential per machine) never interleaves. Accepted rather
 * than fixed, because handler-scoped keying needs transport identity threaded
 * into `TokenTracker`, which rule #9 of the design forbids. Do not restate the
 * bound as "a failure writes metered": that sentence is what made three readers
 * believe two healthy conversations were safe.
 */
const signedArm = new Map<string, SignedArm>();

/**
 * Record which arm signed. Called by OpenAICodexTransport.refreshAuth() — the one
 * place in the tree that knows.
 */
export function recordSignedArm(provider: string, arm: SignedArm): void {
  signedArm.set(provider.toLowerCase(), arm);
}

/**
 * Forget the recorded arm(s), returning the probe to its "what WOULD sign" answer.
 *
 * TWO callers, and the production one is the important one.
 *
 * PRODUCTION: `CredentialAuthority.invalidate()`, `.login()` and `.logout()`. The
 * record is a statement about a credential state and must not outlive it. Without
 * this, a long-lived process (the MCP server, `serve`) that made one successful
 * OAuth request kept reporting `SUB` on preflight, `list_models` and the picker
 * after the user logged out or swapped the credential — until the next request
 * happened to rewrite it. "The window is one request" only holds for a process
 * that keeps making requests.
 *
 * TESTS: for the same reason registerSubscriptionCredentialProbe returns the
 * previous probe — this is run-scoped module state, and Bun runs every test file
 * in one process, so a record written by one test bleeds into every later file.
 *
 * REVIEW-BLOCKING, exactly like restoring a probe with `register(null)`: any test
 * that reaches `OpenAICodexTransport.refreshAuth()` — including one that only
 * meant to pin an endpoint or a header — writes this record, and must clear it in
 * `afterEach`. Measured, not theorised: with the OAuth fixture stamped
 * `arm: "oauth"`, `openai-codex-oauth.test.ts` left `"subscription"` behind and
 * the next file in the same run answered `isSubscriptionProvider("openai-codex")`
 * = true on a machine where NO credential would sign
 * (`validation/fix2-residue-leak.txt`). That is the money-losing direction,
 * leaking out of a test that has nothing to do with billing.
 *
 * NOT cleared on a failed REQUEST. An arm was still resolved and a request was
 * still signed with it, so the record is true; and a 401 on the OAuth arm is not
 * evidence about the next request's arm. Invalidate/logout are the events that
 * make it false.
 */
export function clearSignedArm(provider?: string): void {
  if (provider) signedArm.delete(provider.toLowerCase());
  else signedArm.clear();
}

/**
 * "Which credential WOULD sign", per credential-decided provider.
 *
 * openai-codex: exactly the predicate the composite uses to choose its primary —
 * CompositeCredentialProvider.getRequestAuth takes the OAuth half iff
 * `await this.primary.isAvailable()` (composite-credential.ts:50), and that half's
 * isAvailable() is `this.oauth.hasCredentials()` (codex-credential.ts:45-47).
 * getInstance() is called at probe time, not at module load, so the singleton
 * override seam used by the tests is observed.
 */
const PROBES: Record<string, () => boolean> = {
  "openai-codex": () => CodexOAuth.getInstance().hasCredentials(),
};

/**
 * Wire the probe into the pricing leaf. Called once, from authority.ts, right
 * after the credential authority is built.
 *
 * Returns the previous probe so a caller that installs this can restore what was
 * there. Production ignores it; tests must not.
 */
export function installBillingProbes(): ((provider: string) => boolean) | null {
  return registerSubscriptionCredentialProbe((p) => {
    const recorded = signedArm.get(p);
    // What DID sign beats what WOULD sign. Order is load-bearing: reading the
    // record second would let the approximate answer mask the exact one.
    if (recorded) return recorded === "subscription";
    return PROBES[p]?.() === true;
  });
}
