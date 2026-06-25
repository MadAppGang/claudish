/**
 * Shared types for the TUI components and hooks. Extracted from App.tsx to
 * avoid circular imports back into the root component.
 */

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
 * A single row in the routing rules table. Rows from all three layers
 * (built-in defaults, global config, project-local config) are shown
 * concurrently — no shadowing in the UI. If a pattern exists at multiple
 * layers, multiple rows render and each is independently editable.
 *
 * Marker priority: project (▴ cyan) > override (★ yellow) > user (• green)
 * > default (· dim). `overridesDefault` is true when a user rule (global
 * or project) shares an exact pattern key with a built-in default — used
 * to pick ★ vs • for the marker. The runtime routing engine still applies
 * precedence (project beats global beats default), but the table reflects
 * disk state.
 */
export interface MergedRule {
  kind: "default" | "global" | "project";
  pattern: string;
  chain: string[];
  /** True when a user rule (global or project) shares a key with a built-in default. */
  overridesDefault: boolean;
}

export type ProbeMode = "idle" | "input" | "running" | "done";

export interface ProbeEntry {
  provider: string;
  displayName: string;
  status: "pending" | "testing" | "success" | "failed" | "skipped" | "no_key";
  error?: string;
  ms?: number;
  hasKey?: boolean;
  reason?: string;
}

export interface TestResult {
  status: "testing" | "valid" | "failed";
  error?: string;
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
