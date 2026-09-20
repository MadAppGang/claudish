/**
 * invalid_prompt-class (usage-policy) upstream refusals — shared classification,
 * counting marker, and retry wiring for every translated lane (issue #65).
 *
 * A safety-classifier false positive arrives as a request-level error (code
 * `invalid_prompt` on OpenAI-shaped wires, or a message naming the usage policy
 * on anthropic-compat wires that carry no code); the client surfaces it as
 * `API Error` and the agent turn dies. Arbitrated design (2026-09-12): bounded
 * transparent retry of the IDENTICAL body first — the flag is probabilistic,
 * the same prompt usually passes (2026-09-10 Sol datapoint) — then a labeled,
 * well-formed terminal turn if it persists. Never content mutation, never a
 * bare refusal.
 */

import { log } from "../../../logger.js";

/** Retryable in-stream refusals of the policy class: two fast attempts (~4s). */
export const POLICY_RETRY_BACKOFF_MS: readonly number[] = [1_000, 3_000];

// Test seam (same convention as resetOverflowCapsForTests): the handler path
// has no opts injection point, so handler-level tests shrink the backoff.
let backoffOverrideForTests: readonly number[] | null = null;
export function setPolicyRetryBackoffForTests(ms: readonly number[] | null): void {
  backoffOverrideForTests = ms;
}

/**
 * Retry plumbing shared by the lane parsers. `retryUpstream` re-issues the
 * SAME upstream request via the transport's doFetch directly (not
 * enqueueRequest — the transport's own retry must not compound with this one).
 * `providerName` feeds the [PolicyRefusal] marker so #41/#60 can count per
 * provider/model. Absent everywhere = inert (relay passthrough, tests).
 */
export interface PolicyRetryOpts {
  retryUpstream?: () => Promise<Response | null>;
  /** Backoff before each attempt — tests inject millisecond delays. */
  retryBackoffMs?: readonly number[];
  providerName?: string;
}

/**
 * Whether an in-stream error is a policy-class refusal. Exact code match on
 * wires that carry one (OpenAI/OpenRouter/Sol); message pattern for
 * anthropic-compat providers (Z.AI, MiniMax, Kimi) whose error objects carry
 * only `type` + `message` with no code.
 */
export function isPolicyRefusal(
  code?: string | null,
  message?: string | null
): boolean {
  if (code === "invalid_prompt") return true;
  return /prompt (?:was )?flagged|flagged as (?:potentially )?violating|violat\w+ (?:the )?(?:usage|content|acceptable[- ]use) policy/i.test(
    message ?? ""
  );
}

/** Labeled surfacing text — tells the agent WHAT was refused so it can adapt. */
export function policyRefusalNotice(message: string): string {
  return `[Upstream policy refusal — invalid_prompt: ${message}]`;
}

/**
 * Counting marker (AC2): one line per detected refusal event, forceConsole so
 * it is visible without --debug, carrying lane + model + provider. #41/#60
 * count these per provider/model; `action` distinguishes transparent retries
 * from surfaced persistent refusals.
 */
export function logPolicyRefusal(opts: {
  lane: "openai" | "anthropic" | "responses";
  model: string;
  provider?: string;
  attempt: number;
  action: "retry" | "surface";
}): void {
  log(
    `[PolicyRefusal] lane=${opts.lane} model=${opts.model}${
      opts.provider ? ` provider=${opts.provider}` : ""
    } attempt=${opts.attempt} action=${opts.action}`,
    true
  );
}

// ── Pre-stream extension (#155) ─────────────────────────────────────────────
// The same refusal class arrives as a plain HTTP 4xx body BEFORE any stream
// byte exists. The lane parsers never run on that path (they need a stream
// body), so the refusal surfaced as a bare `API Error` and killed the agent
// turn (fleet session, 2026-09-19 14:41Z). Same contract as the in-stream
// lane: bounded transparent retry of the identical body, then the labeled
// terminal turn.

/**
 * Extract the (code, message) a policy classifier would see from a pre-stream
 * error body, or null when the status/body is not ours to classify.
 * 4xx only — a 5xx is never a policy flag, and quota walls (429) carry their
 * own vocabulary that `isPolicyRefusal` does not match (negative control
 * pinned by test), so `isQuotaExhaustion` keeps owning them.
 */
export function preStreamPolicyRefusal(
  status: number,
  body: string
): { code: string | null; message: string } | null {
  if (status < 400 || status >= 500) return null;
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(body);
    const err = parsed?.error ?? parsed;
    code = typeof err?.code === "string" ? err.code : null;
    message = typeof err?.message === "string" ? err.message : null;
  } catch {
    message = body; // plain-text error bodies still get the message-pattern shot
  }
  if (!isPolicyRefusal(code, message)) return null;
  return { code, message: message ?? "" };
}

/**
 * Bounded pre-stream retry of the identical body (#155). `doFetch` re-issues
 * the SAME upstream request (direct transport bypass — same wiring as the
 * in-stream lane and the overload backoff). Returns the response to CONTINUE
 * with: ok → normal path; non-ok that no longer classifies as policy → the
 * generic error path owns it (a mid-retry quota wall must not be surfaced as
 * a refusal). null → refusal persisted → caller surfaces the labeled turn
 * (it logs the `action=surface` marker itself, with the total attempt count).
 * A thrown retry leaves the original diagnosis intact — the original response
 * was still a classified refusal, so surfacing it labeled beats a 503.
 */
export async function preStreamPolicyRetry(
  doFetch: () => Promise<Response>,
  opts: {
    lane: "openai" | "anthropic" | "responses";
    model: string;
    provider?: string;
    backoffMs?: readonly number[];
  }
): Promise<{ response: Response | null; attempts: number }> {
  const backoff = opts.backoffMs ?? backoffOverrideForTests ?? POLICY_RETRY_BACKOFF_MS;
  let attempts = 0;
  for (let i = 0; i < backoff.length; i++) {
    attempts++;
    logPolicyRefusal({
      lane: opts.lane,
      model: opts.model,
      provider: opts.provider,
      attempt: attempts,
      action: "retry",
    });
    await Bun.sleep(backoff[i]);
    let resp: Response;
    try {
      resp = await doFetch();
    } catch {
      continue;
    }
    if (resp.ok) return { response: resp, attempts };
    let text = "";
    try {
      text = await resp.clone().text();
    } catch {
      // body read is best-effort — treat as foreign non-ok
    }
    if (!preStreamPolicyRefusal(resp.status, text)) return { response: resp, attempts };
  }
  return { response: null, attempts };
}
