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
