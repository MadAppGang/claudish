/**
 * Which credential actually signs, expressed as a billing answer.
 *
 * Two tiers, in priority order:
 *   1. `signedArm` — what the transport ACTUALLY resolved on the last request.
 *      Exact. Written by OpenAICodexTransport.signRequest() from the artifact's
 *      `arm`, the only place that knows whether the OAuth arm or the api-key arm
 *      won.
 *   2. `PROBES` — what WOULD sign, for surfaces that ask before any request
 *      (preflight, the picker). For openai-codex the registry's synchronous
 *      presence projection is shared with transport safety. It may stat/re-read
 *      account-list sources, never pooled token material, Keychain or refresh.
 *
 * Configured rows reserve OAuth even when disabled or unusable. Unknown account
 * configuration also predicts SUB: signing fails closed, so there is no metered
 * request for this conservative label to hide. Confirmed absence (including an
 * empty suppressed pool) predicts metered. No singleton disjunct may resurrect
 * a suppressed legacy login. Only the registry's confirmed synthesized legacy
 * case delegates signing to the existing CodexOAuth facade.
 *
 * The registry/probe injection seams and signed-arm reset isolate test data;
 * never use mock.module or real credentials.
 */

import { registerSubscriptionCredentialProbe } from "../../handlers/shared/remote-provider-types.js";
import { getAccountRegistry } from "../accounts/registry.js";

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
 * the latter and it understated the risk. A successful OAuth `signRequest`
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
 * Record which arm signed. Called by OpenAICodexTransport.signRequest() — the one
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
 * that reaches `OpenAICodexTransport.signRequest()` — including one that only
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
 * Same presence fact as CodexPoolHalf.isAvailable(), but unknown configuration
 * returns true instead of throwing. Read at probe time so invalidation and the
 * registry override are observed; readiness never depends on stored tokens.
 */
const PROBES: Record<string, () => boolean> = {
  "openai-codex": () => getAccountRegistry().mayHaveConfiguredAccounts("openai-codex"),
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
    try {
      return PROBES[p]?.() === true;
    } catch {
      // A registered Codex prediction must not reopen metered routing on failure.
      return p === "openai-codex";
    }
  });
}
