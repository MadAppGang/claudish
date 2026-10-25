/**
 * #654 — in-flight token budget per endpoint, evaluated at attempt time.
 *
 * Measured 2026-10-24 (co-signed engine-side by ai-01:vllm): a local engine
 * saturates on CONTEXT, not request count — six ~200K-token bodies ≈ 1.2M KV
 * tokens against 750,747 available, ~1 token/s for 20 min, 58 preemptions,
 * watchdog restart. A request-count limiter cannot see any of that: six
 * requests is nothing; six 200K contexts is the whole engine.
 *
 * The budget is carried by the #431 step-skip wire (`busy`), NOT by a failure:
 * the loop checks it BEFORE the upstream call, so an over-budget step never
 * reaches the engine, never writes a failure mark, never arms anything — the
 * request advances to the next step exactly as the existing `busy` class does.
 * On the nominal, a budget refusal is an overload-class diversion: the caller
 * synthesizes the same 529 the bounded busy wait produces, and the #299-B
 * one-shot walk machinery (which owns "nominal transient overload → first
 * servable step, zero state") takes it from there.
 *
 * Doctrine, all three pinned:
 *  - INERT WITHOUT ENV (#654 AC1): an endpoint without its two knobs set is
 *    not budgeted at all — no registry entry, no estimate computed, zero
 *    behavior change. Configuring a budget is what activates it.
 *  - The estimator is bytes/3.5 (AC3), measured twice: 914,723 B / 262,145
 *    real tokens = 3.49 (reqN=931, hub capture vs engine `input_tokens`);
 *    ai-01:vllm's independent measure ≈ 3.5. The legacy /4 convention
 *    undercounts 12-14% — enough to admit a window+1 body (#565's blind spot
 *    on 2026-10-24 13:29Z).
 *  - A resubmission is never new demand (AC5, arbitrated 24/10): the registry
 *    keys each lease by (machine, session, body signature); an identical
 *    resubmission that arrives while its predecessor is still in flight
 *    REPLACES the predecessor's estimate instead of adding a second one — a
 *    budget that counts the measured 56% echo as fresh traffic would trip on
 *    its own echo and divert a lane that has room. AC5b: the admission line
 *    carries `resubmit=<k>` (k ≥ 2 only) so the echo rate is readable
 *    hub-side.
 *
 * Coalescing (attaching a resubmission to the existing upstream stream) and
 * routing a resubmission to the next step are deliberately OUT of scope —
 * both change what the client receives and need their own design.
 */

/** A request whose estimate exceeds this counts against the big-concurrency
 *  cap (#654: "N concurrent requests over 100K tokens"). Below it, a request
 *  is bounded by the endpoint's request-count limiter, which is the right
 *  instrument for short traffic — the whole point of leaving ~200K of Σ
 *  headroom. */
export const BIG_REQUEST_TOKENS = 100_000;

/** Measured bytes-per-token for JSON-structured agentic prompts (AC3). */
export const BUDGET_BYTES_PER_TOKEN = 3.5;

/**
 * A lease older than this is dropped at the next admission evaluation. Real
 * turns are bounded well below it (client timeout 600 s, first-event watchdog
 * 300 s); the guard exists for the one failure mode a stream-scoped release
 * cannot close on its own — a Response whose body is never read NOR cancelled
 * would hold its estimate forever and starve the lane. Lazy sweep, no timer.
 */
export const LEASE_MAX_AGE_MS = 15 * 60_000;

export interface EndpointBudgetKnobs {
  /** Σ in-flight estimated tokens; undefined = no Σ check (knob unset). */
  sumBudget?: number;
  /** Max concurrent requests over BIG_REQUEST_TOKENS; undefined = no cap. */
  bigLimit?: number;
}

function envSuffix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Parse the two knobs for one endpoint from the environment. Read per request
 * (house convention) — in a container a NEW value still enters only at the
 * next recreate (#310). Garbage is inert, never a default: there is no
 * meaningful default budget, and an operator typo must not invent one.
 * Names normalize `[^A-Za-z0-9]` → `_` uppercased (`vllm-myia` →
 * `CLAUDISH_ENDPOINT_TOKEN_BUDGET_VLLM_MYIA`).
 */
export function readEndpointBudgetKnobs(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): EndpointBudgetKnobs | null {
  const suffix = envSuffix(name);
  const sumRaw = (env[`CLAUDISH_ENDPOINT_TOKEN_BUDGET_${suffix}`] || "").trim();
  const bigRaw = (env[`CLAUDISH_ENDPOINT_BIG_LIMIT_${suffix}`] || "").trim();
  const sumBudget = /^\d+$/.test(sumRaw) ? Number.parseInt(sumRaw, 10) : undefined;
  const bigLimit = /^\d+$/.test(bigRaw) ? Number.parseInt(bigRaw, 10) : undefined;
  if (sumBudget !== undefined && sumBudget <= 0) return null; // "0" is a typo, not "unlimited"
  if (sumBudget === undefined && bigLimit === undefined) return null;
  return { sumBudget, bigLimit };
}

/**
 * The endpoint prefix of a routing target — `vllm-myia` in
 * `vllm-myia@swift-1.5-27b:8!own`. A bare id (no `@`) belongs to a builtin
 * provider's default chain and carries no endpoint budget.
 */
export function endpointPrefixOf(target: string | undefined): string | null {
  if (!target) return null;
  const at = target.indexOf("@");
  if (at <= 0) return null;
  const prefix = target.slice(0, at);
  return prefix.length > 0 ? prefix : null;
}

/**
 * Serialize once per gated attempt (#663 r1): the estimator and the body
 * signature both consume the SAME serialized payload, and serializing a
 * ~1 MB agentic body twice per attempt is a measurable tax. Returns "" only
 * when serialization throws — same fallback both consumers had.
 */
function serializeForBudget(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? "";
  } catch {
    return "";
  }
}

/**
 * AC3 estimator: bytes / 3.5, deliberately NOT the /4 `estimatePayloadTokens`
 * convention (that one undercounts 12-14% on these bodies, which is exactly
 * the #565 blind spot) and NOT the media-aware `estimateClampTokens` (base64
 * media DOES consume engine KV — deflating it would understate the load the
 * budget exists to bound). Raw serialized length, one divisor, pinned.
 */
export function estimateBudgetTokens(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  return Math.ceil(serializeForBudget(payload).length / BUDGET_BYTES_PER_TOKEN);
}

/**
 * AC5 body signature: FNV-1a over the serialized payload. 32-bit is enough —
 * a collision merges two different bodies into one lease (an under-count the
 * TTL and the request limiter bound), while the alternative (SHA-256) would
 * force an async hash at a synchronous seam.
 */
export function bodySignature(payload: unknown): string {
  return fnv1aSerialized(serializeForBudget(payload));
}

/** FNV-1a over an already-serialized payload (the single-serialization seam). */
function fnv1aSerialized(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

interface LeaseRecord {
  tokens: number;
  big: boolean;
  at: number;
  sig: string;
  /** AC5: a superseded lease keeps this flag so its (late) release is a
   *  no-op — the successor already replaced it in the array. */
  superseded: boolean;
}

/** endpoint name → live leases. Entries die only via release or the stale
 *  sweep; an empty array deletes the key so `size` stays honest. */
const inflight = new Map<string, LeaseRecord[]>();

/** AC5b — admission count per `${endpoint}::${scope|signature}`. Lives exactly
 *  as long as the signature holds a live lease (dies with the last one, by
 *  release or stale sweep), so a fresh identical body after completion reads
 *  `resubmit=1` again. Without it a replace-only registry could never report a
 *  third copy: the in-flight set holds ONE lease, so "how many times has this
 *  body been submitted?" is invisible at evaluation time. */
const sigCounts = new Map<string, number>();

function sweepStale(name: string, leases: LeaseRecord[], now: number, onStale?: (info: string) => void): LeaseRecord[] {
  const live: LeaseRecord[] = [];
  let dropped = 0;
  let droppedTokens = 0;
  for (const l of leases) {
    if (now - l.at > LEASE_MAX_AGE_MS) {
      dropped++;
      droppedTokens += l.tokens;
      l.superseded = true; // its release, if it ever fires, must be a no-op
    } else {
      live.push(l);
    }
  }
  if (dropped > 0) {
    if (live.length === 0) inflight.delete(name);
    else inflight.set(name, live);
    pruneSigCounts(name, live);
    onStale?.(`[EndpointBudget] ${name}: dropped ${dropped} stale lease(s) (${droppedTokens} tokens) older than ${LEASE_MAX_AGE_MS}ms — a body never read nor cancelled`);
  }
  return live;
}

/** Drop the admission counts of signatures that no longer hold a live lease. */
function pruneSigCounts(name: string, leases: LeaseRecord[]): void {
  const liveSigs = new Set(leases.map((l) => l.sig));
  for (const key of sigCounts.keys()) {
    if (key.startsWith(`${name}::`) && !liveSigs.has(key.slice(name.length + 2))) {
      sigCounts.delete(key);
    }
  }
}

export interface EndpointBudgetFacts {
  name: string;
  est: number;
  sum: number;
  sumBudget?: number;
  bigInFlight: number;
  bigLimit?: number;
  /** AC5b — copy number of this signature among the live leases AFTER
   *  admission (1 = fresh body, 2 = first resubmission). */
  resubmit: number;
  /** AC5 — true when an identical body was in flight and its estimate was
   *  REPLACED (not added) by this admission. */
  replaced: boolean;
}

export interface EndpointBudgetDecision {
  refused: boolean;
  /** "sum" (Σ over budget) or "big" (big-concurrency cap) — for the marker. */
  reason?: "sum" | "big";
  facts: EndpointBudgetFacts;
  /** Register the in-flight lease (applying the AC5 replacement). MUST be
   *  called exactly once on the path that actually issues the upstream call —
   *  including a refusal the caller chose to serve anyway (an untracked
   *  served request makes Σ lie low). Returns the release callback. */
  commit(): () => void;
}

/**
 * Evaluate the budget for one attempt. Returns null when the target's
 * endpoint carries no knobs at all (AC1 inert-by-default).
 *
 * The AC5 replacement is applied INSIDE this evaluation: a resubmission
 * first removes its predecessor's estimate, then the (single) estimate is
 * weighed — so an echo can never trip a budget its own predecessor fits
 * under. The replacement is only durably registered by `commit()`; an
 * abandoned evaluation (caller advances/walks instead) leaves the
 * predecessor's lease exactly as it was.
 */
export function evaluateEndpointTokenBudget(
  name: string,
  payload: unknown,
  scope: { machine?: string; session?: string },
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
  onStale?: (info: string) => void
): EndpointBudgetDecision | null {
  const knobs = readEndpointBudgetKnobs(name, env);
  if (!knobs) return null;
  // #663 r1: serialize the body ONCE — the estimate and the signature below
  // both consume this string, never two full serializations of the same body.
  const serialized = payload === undefined || payload === null ? "" : serializeForBudget(payload);
  const est = serialized.length === 0 ? 0 : Math.ceil(serialized.length / BUDGET_BYTES_PER_TOKEN);
  const sig = `${scope.machine ?? ""}|${scope.session ?? ""}|${fnv1aSerialized(serialized)}`;
  const sigKey = `${name}::${sig}`;
  const leases = sweepStale(name, inflight.get(name) ?? [], now, onStale);
  // AC5: an identical body still in flight is not new demand — its estimate
  // is replaced, never summed. Evaluate against the post-replacement set.
  const replacedLease = leases.find((l) => l.sig === sig && !l.superseded) ?? null;
  const effective = replacedLease ? leases.filter((l) => l !== replacedLease) : leases;
  const sum = effective.reduce((acc, l) => acc + l.tokens, 0);
  const bigInFlight = effective.filter((l) => l.big).length;
  // AC5b: the copy number is the admission COUNT of this signature, not the
  // in-flight lease count (a replace-only registry always holds one).
  const resubmit = replacedLease ? (sigCounts.get(sigKey) ?? 1) + 1 : 1;
  const big = est > BIG_REQUEST_TOKENS;
  let refused = false;
  let reason: "sum" | "big" | undefined;
  if (knobs.sumBudget !== undefined && sum + est > knobs.sumBudget) {
    refused = true;
    reason = "sum";
  }
  if (!refused && knobs.bigLimit !== undefined && big && bigInFlight >= knobs.bigLimit) {
    refused = true;
    reason = "big";
  }
  const facts: EndpointBudgetFacts = {
    name,
    est,
    sum,
    sumBudget: knobs.sumBudget,
    bigInFlight,
    bigLimit: knobs.bigLimit,
    resubmit,
    replaced: replacedLease !== null,
  };
  const commit = (): (() => void) => {
    if (replacedLease) {
      replacedLease.superseded = true;
      const arr = inflight.get(name);
      if (arr) {
        const idx = arr.indexOf(replacedLease);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) inflight.delete(name);
      }
    }
    const record: LeaseRecord = { tokens: est, big, at: now, sig, superseded: false };
    let arr = inflight.get(name);
    if (!arr) {
      arr = [];
      inflight.set(name, arr);
    }
    arr.push(record);
    sigCounts.set(sigKey, replacedLease ? resubmit : 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (record.superseded) return; // AC5: a replaced lease releases as a no-op
      record.superseded = true;
      const cur = inflight.get(name);
      if (!cur) return;
      const idx = cur.indexOf(record);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) inflight.delete(name);
      if (!cur.some((l) => l.sig === sig)) sigCounts.delete(sigKey);
    };
  };
  return { refused, reason, facts, commit };
}

/** The countable marker line for a decision — same shape family as the #431
 *  SKIP marker (`reason=busy est=… sum=…/…`), so the fleet greps one format. */
export function formatBudgetFacts(facts: EndpointBudgetFacts, refused: boolean, reason?: string): string {
  const parts = [`est=${facts.est}`];
  if (facts.sumBudget !== undefined) parts.push(`sum=${facts.sum}/${facts.sumBudget}`);
  else parts.push(`sum=${facts.sum}`);
  if (facts.bigLimit !== undefined) parts.push(`big=${facts.bigInFlight}/${facts.bigLimit}`);
  if (facts.resubmit >= 2) parts.push(`resubmit=${facts.resubmit}`); // AC5b
  if (refused) parts.push(`reason=${reason}`);
  return parts.join(" ");
}

/** Test/reset hook — the registry is process-global by design (the budget is
 *  cross-request state); tests must isolate it. */
export function clearEndpointTokenBudgets(): void {
  inflight.clear();
  sigCounts.clear();
}

/** Read-only introspection for tests and diagnostics. */
export function endpointBudgetSnapshot(): Record<string, { count: number; sum: number; big: number }> {
  const out: Record<string, { count: number; sum: number; big: number }> = {};
  for (const [name, leases] of inflight) {
    out[name] = {
      count: leases.length,
      sum: leases.reduce((a, l) => a + l.tokens, 0),
      big: leases.filter((l) => l.big).length,
    };
  }
  return out;
}

/**
 * Release the lease when the response's BYTES stop flowing — end of stream,
 * consumer cancel, or stream error. The engine holds KV from admission until
 * generation completes (≈ stream end), so the lease must live exactly as
 * long: released earlier it under-counts (the budget lies low exactly when it
 * matters), later it starves the lane.
 *
 * Explicit reader pump, not `pipeThrough(TransformStream)`: flush fires on a
 * normal close but NOT on a consumer cancel, and a cancelled-but-unreleased
 * lease is the leak this wrapper exists to prevent. A bodyless response
 * releases immediately.
 */
export function withBudgetRelease<T extends Response>(response: T, release: () => void): T {
  const upstreamBody = response.body;
  if (!upstreamBody) {
    release();
    return response;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    release();
  };
  const reader = upstreamBody.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await reader.read();
        if (r.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(r.value);
        }
      } catch {
        // Never-hang rule (#663 r1): no `controller.error()` in a production
        // source — this wrapped body is the CLIENT-facing response, and the
        // inner layer owns `message_stop`. Release the lease and CLOSE: a
        // client reading to the end sees a terminated stream, never a broken
        // pipe; this wrapper's only job is the lease.
        finish();
        controller.close();
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }) as T;
}
