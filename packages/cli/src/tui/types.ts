/**
 * Shared types for the TUI components and hooks. Extracted from App.tsx to
 * avoid circular imports back into the root component.
 */

import type { RouteTier } from "../providers/provider-definitions.js";
import type { CandidateOutcome } from "../providers/routing-rules.js";

export type Tab = "providers" | "profiles" | "routing" | "privacy" | "onepassword";

export type Mode =
  | "browse"
  | "input_key"
  | "input_endpoint"
  | "add_routing_pattern"
  | "add_routing_chain"
  | "pick_routing_scope"
  | "new_profile"
  | "pick_profile_scope"
  | "pick_provider_prefix"
  | "edit_profile_opus"
  | "edit_profile_sonnet"
  | "edit_profile_haiku"
  | "edit_profile_subagent"
  // 1Password tab modes (browse-don't-type add-wizard):
  //  - text inputs: account URL, env ID.
  //  - pickers: scope, account (multi-account), kind, and the three sequential
  //    op:// browse levels — vault → item → field/glob.
  | "input_op_account"
  | "input_op_env"
  | "pick_op_scope"
  | "pick_op_account"
  | "pick_op_kind"
  | "pick_op_vault"
  | "pick_op_item"
  | "pick_op_field";

/**
 * Routing scope. Promoted to types.ts so RoutingContent and App.tsx
 * agree on the shape and we don't carry two copies.
 */
export type RoutingScope = "global" | "project";

/**
 * A single row in the routing rules table — one of the USER's own rules, from
 * global config or from project-local config. Both layers are shown
 * concurrently, with no shadowing in the UI: if a pattern exists at both,
 * two rows render and each is independently editable.
 *
 * There is no third `"default"` kind and no `overridesDefault` flag any more.
 * Both described the shipped table of built-in rules, which was deleted when
 * routing started gathering its candidates from the cloud models catalog.
 * Nothing is left for a user rule to "override": a rule that matches is the
 * whole chain, used verbatim, and a model with no matching rule is routed from
 * the catalog. Keeping the flag would have gone on drawing a ★ against a
 * comparison that no longer exists. A `"*"` rule is a row like the others.
 *
 * Marker priority: project (▴ cyan) > global (• green). The runtime routing
 * engine still applies precedence (project beats global), but the table
 * reflects disk state.
 */
export interface MergedRule {
  kind: "global" | "project";
  pattern: string;
  chain: string[];
}

export type ProbeMode = "idle" | "input" | "running" | "done";

/** What removed a route candidate: every `CandidateOutcome` except `kept`. */
export type DroppedOutcome = Exclude<CandidateOutcome, "kept">;

/**
 * One row of the route probe: one candidate of the chain `explainRoute`
 * calculated, in chain order, or the native passthrough.
 */
export interface ProbeEntry {
  provider: string;
  displayName: string;
  /**
   * - `pending` → `testing` → `success` | `failed`, or `skipped` (not reached
   *   because an earlier hop answered): a KEPT hop, which the probe tests.
   * - `dropped`: `explainRoute` removed this candidate; `outcome` names the
   *   filter. Never tested: the credential and availability verdicts are
   *   `explainRoute`'s, and the probe keeps no second opinion.
   * - `unverified`: the route is real but this process cannot probe it — the
   *   native Claude passthrough, whose auth is the inbound Claude Code header.
   *   Neither a success nor a failure; the panel must not fold it into either.
   * - `no_key`: no longer produced. A missing credential is `dropped` with
   *   outcome `no-credential`. It stays in the union only because
   *   `probe-outcome.test.ts` names it; remove the two together.
   */
  status:
    | "pending"
    | "testing"
    | "success"
    | "failed"
    | "skipped"
    | "dropped"
    | "no_key"
    | "unverified";
  /** `dropped` only: the filter that removed the candidate. */
  outcome?: DroppedOutcome;
  /** The spec a kept hop is probed with: exactly the `Route.modelSpec` a request uses. */
  modelSpec?: string;
  /** The definition's tier; absent for a provider no definition carries. */
  tier?: RouteTier;
  /** `fallback`: the fallback hop's position, whichever provider holds it. */
  position?: "candidate" | "fallback";
  /** `"routed"` for a hop of a bare name's routing chain; absent for an explicit spec. */
  hopOrigin?: "routed";
  error?: string;
  ms?: number;
}

/**
 * What the route probe says about the decision as a whole, beside its rows. All
 * of it comes from one `explainRoute` call.
 */
export interface ProbeSummary {
  /** `describeRouteExplanation`: where the chain came from, worded as `--probe` words it. */
  line: string;
  /** The explanation's warnings (billing notices, rule problems), one line each. */
  warnings: string[];
  /** Facts about the decision that are not warnings (a withheld fallback hop, native auth). */
  notes: string[];
  /** A no-route decision: the reason and hint `route()` would return, verbatim. */
  noRoute?: { reason: string; hint?: string };
}

export interface TestResult {
  /**
   * - "testing"     — probe in flight
   * - "valid"       — endpoint reachable + a model responded
   * - "failed"      — a real failure (auth/network/bad config) → red
   * - "unavailable" — expected, NOT a failure: local server not running, or no
   *                   probe-able model exists (e.g. only embedding models). Shown
   *                   neutral (dim/yellow), not red — claudish/config are fine,
   *                   there's just nothing to test right now.
   */
  status: "testing" | "valid" | "failed" | "unavailable";
  error?: string;
  /**
   * The upstream's own explanation, WITHOUT the `<state> · <status> · <ms> —`
   * prefix that `error` carries.
   *
   * The detail panel shows this rather than `error` because the provider row
   * directly above already prints that prefix, and repeating it cost ~36
   * characters of the only place the provider's sentence can be read. On
   * MiniMax Coding that was the difference between stopping at "Upgrade
   * you…" and showing "Upgrade your Token Plan or purchase Credits for more
   * usage. (2056)" — the part that names the plan and the way out.
   */
  providerMessage?: string;
  ms?: number;
  /** Optional annotation when status is "valid" but the endpoint reported a
   *  non-fatal condition (e.g. "throttled" for 429-but-healthy). */
  note?: string;
}

export type TestResultsMap = Record<string, TestResult>;

// ===========================================================================
// 1Password tab (tab 5)
// ===========================================================================

/**
 * Scope a 1Password config entry lives in. Mirrors OpConfigScope from
 * onepassword-config.ts (kept local so the TUI types don't depend on the
 * persistence module's export). "global" → ~/.claudish/config.json,
 * "project" → ./.claudish.json.
 */
export type OpScope = "global" | "project";

/**
 * The kind of a 1Password entry shown in the merged list.
 *  - "account"     → the DesktopAuth account URL (onepasswordAccount).
 *  - "ref"         → a single op:// field reference (onepassword[]).
 *  - "glob"        → an op:// glob field import (onepassword[], has a `*`).
 *  - "environment" → a 1Password Environment ID (onepasswordEnvironments[]).
 */
export type OpKind = "account" | "ref" | "glob" | "environment";

/**
 * A single row in the 1Password merged list. `scope` is the config scope the
 * entry was read from, or the special "env" marker for the read-only account
 * that came from OP_ACCOUNT / OP_SERVICE_ACCOUNT_TOKEN (not editable here).
 */
export interface OpEntry {
  kind: OpKind;
  /** op:// path, environment id, or account URL — verbatim. */
  value: string;
  /** Config scope, or "env" for the read-only env/token-derived account. */
  scope: OpScope | "env";
  /** Derived env var name for a single op:// ref, when one can be derived. */
  envName?: string;
}

/** Status of a per-entry connectivity test. */
export type OpTestStatus = "testing" | "valid" | "failed";

/**
 * Result of testing a single 1Password entry (read-only). `note` carries a
 * masked value / field count / var count on success; `error` the message on
 * failure.
 */
export interface OpTestResult {
  status: OpTestStatus;
  note?: string;
  error?: string;
}

/** Keyed by `${scope}:${kind}:${value}` so each row's result is independent. */
export type OpTestResultsMap = Record<string, OpTestResult>;
