/**
 * Quota-wall short-circuit for the transport 429 retry ladders.
 *
 * The ladders exist for *burst* limits: a per-minute cap clears on its own, so
 * sleeping 2s/4s/8s/16s/30s and retrying is exactly right. A **plan or quota
 * wall** is the opposite — it is still there 62.5s later, so the whole ladder
 * is spent sleeping against something that cannot move, and the caller's own
 * deadline fires mid-sleep. Measured on the hub 2026-08-24: 166 `glm-5.2`
 * requests, 0 served in 6h; every one of them walked the full ladder before
 * failing, and the sidecar's 30s header deadline aborted them at the halfway
 * point — reported client-side as `Connection lost mid-response`.
 *
 * The predicate is NOT re-implemented here. `isQuotaExhaustion` is the same
 * function the budget failover arms on (`fork/failover.ts`) — pure, two scalars
 * in, no state — so sharing it keeps the two consumers from drifting apart.
 * That matters because its narrowness is the whole safety property: a bare 429
 * with no quota/credit/balance/weekly/plan wording is a burst, and MUST keep
 * being retried. Widening this predicate to "any 429" would turn every transient
 * rate limit into an instant hard failure.
 *
 * Never throws: an unreadable body degrades to the pre-existing ladder.
 */

import { isQuotaExhaustion } from "../../fork/failover.js";
import { log } from "../../logger.js";

/**
 * True when this response is a wall worth giving up on immediately.
 *
 * `clone()` is required: the caller still returns this Response to its own
 * caller, so its body must stay unconsumed. (Same pattern as
 * `gemini-codeassist.ts`, which clones to read an error body it also forwards.)
 */
export async function isQuotaWall(response: Response, displayName: string): Promise<boolean> {
  try {
    const body = await response.clone().text();
    if (!isQuotaExhaustion(response.status, body)) return false;
    log(
      `[${displayName}] ${response.status} names a quota/plan wall, not a burst — ` +
        `skipping the retry ladder (it would sleep ~62s against a wall)`
    );
    return true;
  } catch {
    // Body unreadable (already consumed, stream error, …). Retry as before —
    // a missed short-circuit costs latency, a wrong one costs correctness.
    return false;
  }
}
