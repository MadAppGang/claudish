/**
 * Failover — role-level model substitution as a transitive cascade of degradations,
 * with explicit onset + recovery notices.
 *
 * This is NOT `FallbackHandler` (handlers/fallback-handler.ts). That one swaps
 * *providers* for the *same* model when a provider is unhealthy — a transport
 * concern. This one swaps the *model itself* for a whole role (opus/sonnet/haiku)
 * when the nominal model's budget is exhausted — a subscription concern.
 *
 * Each role has an ORDERED CASCADE of substitutes, `>`-separated in env:
 *
 *   CLAUDISH_FAILOVER_OPUS=qwen-token-plan@qwen3.8-max>gc@glm-5.2>deepseek@deepseek-payg
 *   CLAUDISH_FAILOVER_OPUS_LABEL=Qwen 3.8 Max>GLM-5.2>DeepSeek PAYG
 *   CLAUDISH_FAILOVER_OPUS_DIRECTION=degraded>degraded>improved
 *
 * "Opus → Qwen 3.8 → GLM" is nominal-tier cascade behaviour, not a set of special
 * routes: when the nominal walls, serve step 0; when step 0 ALSO walls, serve step
 * 1; and so on. A single value (no `>`) is a 1-step cascade — the historical config
 * parses unchanged. The last step (typically PAYG) is always served when everything
 * above it is down: a pay-per-use target should not wall, and its real error beats a
 * synthetic one.
 *
 * Per-step TTL with exponential backoff (BACKOFF_MS) avoids re-probing a weekly wall
 * every 10 min (Qwen: ~6 probes over 6 days) while GLM's rolling 5h window self-heals
 * (10m+30m+1h+4h ≈ 5h30 lands a probe right after it restarts). Step-failure state is
 * deliberately INDEPENDENT of the role-level auto-arm TTL: the 10-min nominal re-probe
 * cycle must not re-probe a weekly-walled step every time it fires.
 *
 * Two notices, two moments (the user's mandate 2026-08-12):
 *  - Moment of failover/recovery (streaming, once per session per resolved depth): the
 *    substitute (or back-to-nominal) model reads its own prior turn starting with the
 *    notice, so it knows the capability delta and resumes its normal working scope.
 *  - Condensation (/compact, every time): re-injected because compaction rebuilds
 *    context and loses the prior notice. Onset persists while armed; RECOVERY persists
 *    RECOVERY_CONDENSATIONS times so the model can "corriger ses mémoires et se
 *    remettre en rythme nominal."
 *
 * Recovery detection = the auto-arm TTL probe. An armed role's auto-arm expires after
 * AUTO_ARM_TTL_MS; the next request serves nominal; if nominal answers, the role
 * transitions to RECOVERING and notices fire. Config-arms (operator-held) do not
 * self-probe — their recovery is operator-initiated. Now that NativeHandler propagates
 * upstream status (commit 30a974f), auto-arm works on Anthropic-native, so the
 * historical reason to config-arm Opus is gone — auto-arm is the default path and
 * Friday-03h-style resets self-detect.
 */

import { logStderr } from "../logger.js";

export type FailoverRole = "opus" | "sonnet" | "haiku";

export const FAILOVER_ROLES: readonly FailoverRole[] = ["opus", "sonnet", "haiku"] as const;

/** Which way the substitution moves capability, from the agent's point of view. */
export type FailoverDirection = "degraded" | "improved" | "lateral";

/** One substitution target within a role's cascade. */
export interface FailoverStep {
  /** Routing target, in any form `getHandlerForRequest` accepts. */
  target: string;
  /** Human label for the notice; defaults to the target string. */
  label: string;
  direction: FailoverDirection;
  /** Optional extra guidance appended to the notice line. */
  note?: string;
  /** Operator-declared reset time (CLAUDISH_FAILOVER_<ROLE>_RESET): the step is not
   * re-probed before this moment. For walls whose body carries no date (Mistral's
   * subscription 402); body-parsed dates take precedence when both exist. */
  resetAt?: Date;
}

export interface FailoverRule {
  role: FailoverRole;
  /** Ordered substitutes; index 0 is served first when the nominal walls. */
  steps: FailoverStep[];
}

/** A role whose nominal is currently walled (armed). Does not carry the resolved
 * step — that depends on per-step failure state, resolved on demand. */
export interface ArmedFailover {
  since: Date;
  /** "config" when armed by CLAUDISH_FAILOVER_ACTIVE, else the upstream error. */
  reason: string;
}

/** A role + the cascade step currently serving it. */
export interface ResolvedFailover {
  role: FailoverRole;
  step: FailoverStep;
  stepIndex: number;
}

interface StepFailure {
  count: number;
  lastFailure: Date;
  /** Effective reset time for this failure episode: body-parsed wins over the
   * config-declared step.resetAt. While set and in the future the step is skipped
   * regardless of backoff — the wall cannot lift before its reset. Once it passes,
   * the step is probed again (a reset step must be consumed, not avoided). */
  resetAt?: Date;
}

interface RecoveryState {
  since: Date;
  /** Condensation notices remaining before recovery clears. */
  remaining: number;
  prevLabel: string;
  prevDirection: FailoverDirection;
  prevStepIndex: number;
  /** Sessions that already got the one-time stream recovery notice. */
  notifiedSessions: Set<string>;
}

/** Parsed once at module load; re-read only by resetFailoverForTests(). */
let rules = new Map<FailoverRole, FailoverRule>();
let autoArmEnabled = false;
const armed = new Map<FailoverRole, ArmedFailover>();
/** Per-step failure counters. Independent of the role-level arm TTL. */
const stepFailures = new Map<FailoverRole, StepFailure[]>();
/** Roles that just returned to nominal after failover — emitting recovery notices. */
const recovering = new Map<FailoverRole, RecoveryState>();
/** Bridge: step a role WAS serving, captured when its auto-arm TTL expires. The
 * cascade loop consumes this to seed `recovering` if the nominal probe succeeds. */
const pendingRecovery = new Map<
  FailoverRole,
  { label: string; direction: FailoverDirection; stepIndex: number }
>();
/**
 * Sessions that have already received the "moment of failover" stream notice, per
 * role, mapped to the LAST step index they were notified at. Re-notify when the
 * resolved step CHANGES (Qwen→GLM mid-session) so the agent recalibrates to the new
 * substitute. Cleared on auto-arm TTL expiry (a fresh episode re-notifies) and on
 * full reset. Condensation notices are independent of this map.
 */
const notifiedSessions = new Map<FailoverRole, Map<string, number>>();

const AUTO_ARM_TTL_MS = 10 * 60 * 1000;
const RECOVERY_CONDENSATIONS = 3;
/** Safety TTL: clear recovery even if no compactions fire to decrement it. */
const RECOVERY_MAX_MS = 60 * 60 * 1000;
/** Per-step probe backoff: ~10m, 30m, 1h, 4h, then a 24h cap. */
const BACKOFF_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000];

function parseDirection(raw: string | undefined): FailoverDirection {
  const v = (raw || "").trim().toLowerCase();
  if (v === "improved" || v === "degraded" || v === "lateral") return v;
  // Unknown or unset: "degraded" is the safe default. Announcing a downgrade that
  // turned out to be an upgrade is harmless; the reverse makes the agent over-trust
  // a weaker model.
  return "degraded";
}

/** Split a `>`-separated env value into trimmed non-empty steps. */
function splitSteps(raw: string): string[] {
  return raw.split(">").map((s) => s.trim()).filter(Boolean);
}

/** Parse CLAUDISH_FAILOVER_<ROLE>_RESET into per-step dates. Unlike labels, position
 * matters even for empty entries: ">2026-08-25T22:28:00Z" declares a reset for step 1
 * only — so empties must NOT be filtered out the way splitSteps does. Invalid entries
 * warn and fall back to undefined (no declared reset = probe per backoff, the safe default). */
function parseStepResets(raw: string | undefined, count: number, role: FailoverRole): (Date | undefined)[] {
  const out: (Date | undefined)[] = Array.from({ length: count }, () => undefined);
  if (!raw) return out;
  const parts = raw.split(">").map((s) => s.trim());
  for (let i = 0; i < count && i < parts.length; i++) {
    if (!parts[i]) continue;
    const d = new Date(parts[i]);
    if (isNaN(d.getTime())) {
      logStderr(
        `[Failover] ${role}: unparseable reset date '${parts[i]}' for step ${i} — ignoring. Want ISO 8601, e.g. 2026-09-01T00:00:00Z.`
      );
      continue;
    }
    out[i] = d;
  }
  return out;
}

function loadRules(env: NodeJS.ProcessEnv): Map<FailoverRole, FailoverRule> {
  const out = new Map<FailoverRole, FailoverRule>();
  for (const role of FAILOVER_ROLES) {
    const key = `CLAUDISH_FAILOVER_${role.toUpperCase()}`;
    const targets = splitSteps(env[key] || "");
    if (targets.length === 0) continue;
    const labels = splitSteps(env[`${key}_LABEL`] || "");
    const directions = splitSteps(env[`${key}_DIRECTION`] || "");
    const notes = splitSteps(env[`${key}_NOTE`] || "");
    const resets = parseStepResets(env[`${key}_RESET`], targets.length, role);
    if (labels.length !== 0 && labels.length !== targets.length) {
      logStderr(
        `[Failover] ${role}: ${labels.length} labels vs ${targets.length} targets — padding with defaults. Check CLAUDISH_FAILOVER_${role.toUpperCase()}_LABEL.`
      );
    }
    const steps: FailoverStep[] = targets.map((target, i) => ({
      target,
      label: labels[i]?.trim() || target,
      direction: parseDirection(directions[i]),
      note: notes[i]?.trim() || undefined,
      resetAt: resets[i],
    }));
    out.set(role, { role, steps });
  }
  return out;
}

/** Deployment-specific model-name → role aliases (CLAUDISH_FAILOVER_ROLE_MODELS),
 * so clients that request the nominal model by NAME (e.g. "glm-5.2", "MiniMax-M3")
 * instead of a role keyword ("claude-sonnet-4-6") still get cascade protection.
 * Pattern is a lowercased substring matched against the requested model. */
let roleAliases: { pattern: string; role: FailoverRole }[] = [];

/** Parse "pattern:role,pattern:role" — lowercase patterns, validated roles. */
function parseRoleAliases(raw: string): { pattern: string; role: FailoverRole }[] {
  const out: { pattern: string; role: FailoverRole }[] = [];
  for (const piece of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [patternRaw, roleRaw] = piece.split(":");
    const pattern = (patternRaw || "").trim().toLowerCase();
    const role = (roleRaw || "").trim().toLowerCase() as FailoverRole;
    if (!pattern || !FAILOVER_ROLES.includes(role)) {
      logStderr(
        `[Failover] Skipping malformed role alias '${piece}' — want "pattern:role" with role in ${FAILOVER_ROLES.join("/")}`
      );
      continue;
    }
    out.push({ pattern, role });
  }
  return out;
}

/**
 * (Re)read configuration from the environment and arm whatever
 * CLAUDISH_FAILOVER_ACTIVE names. Called once at proxy startup so the log line lands
 * next to the other startup banners; safe to call again in tests.
 */
export function initFailover(env: NodeJS.ProcessEnv = process.env): void {
  rules = loadRules(env);
  roleAliases = parseRoleAliases(env.CLAUDISH_FAILOVER_ROLE_MODELS || "");
  autoArmEnabled = /^(1|true|yes|on)$/i.test((env.CLAUDISH_FAILOVER_AUTO || "").trim());
  armed.clear();
  // In-memory probe/recovery state does not survive a restart — start fresh.
  stepFailures.clear();
  recovering.clear();
  pendingRecovery.clear();
  notifiedSessions.clear();

  const activeRaw = (env.CLAUDISH_FAILOVER_ACTIVE || "").trim().toLowerCase();
  if (activeRaw && activeRaw !== "none") {
    for (const piece of activeRaw.split(/[,\s]+/).filter(Boolean)) {
      const role = piece as FailoverRole;
      if (!FAILOVER_ROLES.includes(role)) {
        logStderr(`[Failover] Ignoring unknown role in CLAUDISH_FAILOVER_ACTIVE: '${piece}'`);
        continue;
      }
      const rule = rules.get(role);
      if (!rule) {
        // Armed but unconfigured is a config error the operator must see: it silently
        // means "no failover" exactly when one was intended.
        logStderr(
          `[Failover] '${role}' is listed in CLAUDISH_FAILOVER_ACTIVE but CLAUDISH_FAILOVER_${role.toUpperCase()} is not set — no substitution will happen for this role.`
        );
        continue;
      }
      // Date.now() (not new Date()) so `since` and the TTL comparison read the same
      // clock — otherwise a test that fakes Date.now cannot exercise the expiry.
      armed.set(role, { since: new Date(Date.now()), reason: "config" });
    }
  }

  if (armed.size > 0 || rules.size > 0) {
    const armedList =
      armed.size > 0
        ? [...armed.keys()].map((r) => `${r}→${describeResolved(r)}`).join(", ")
        : "none";
    logStderr(
      `[Failover] configured=${rules.size} armed=[${armedList}] auto=${autoArmEnabled ? "on" : "off"}`
    );
  }
}

/** Human label for the step a role would resolve to right now (or "nominal"). */
function describeResolved(role: FailoverRole): string {
  const { step } = resolveFailoverTarget(role);
  return step ? step.label : "nominal";
}

/**
 * Which role a client-requested model name belongs to. Substring on the CLIENT name
 * (Claude Code speaks in roles: "claude-opus-5", "claude-3-5-haiku-…") even when the
 * proxy serves something else. Single definition so the routing hook and the auto-arm
 * path can never drift.
 */
export function roleFromModelName(model: string | undefined): FailoverRole | null {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  // Fall back to deployment-specific aliases: a client that names the nominal
  // model directly ("glm-5.2") instead of a role keyword must still be cascaded.
  for (const alias of roleAliases) {
    if (m.includes(alias.pattern)) return alias.role;
  }
  return null;
}

/** The configured cascade for a role, armed or not. */
export function getFailoverRule(role: FailoverRole): FailoverRule | undefined {
  return rules.get(role);
}

// ─── per-step backoff ──────────────────────────────────────────────────────────

function stepTtlMs(count: number): number {
  const idx = Math.min(Math.max(count, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[idx];
}

function isStepTtlFailed(f: StepFailure | undefined): boolean {
  if (!f || f.count === 0) return false;
  // A known reset date dominates the backoff: the wall cannot lift before it, and a
  // reset in the past means "probe now" so a recovered step is consumed, not avoided.
  if (f.resetAt) return Date.now() < f.resetAt.getTime();
  return Date.now() - f.lastFailure.getTime() < stepTtlMs(f.count);
}

function stepFailuresFor(role: FailoverRole): StepFailure[] {
  let arr = stepFailures.get(role);
  if (!arr) {
    const rule = rules.get(role);
    const len = rule ? rule.steps.length : 0;
    arr = Array.from({ length: len }, () => ({ count: 0, lastFailure: new Date(0) }));
    stepFailures.set(role, arr);
  }
  return arr;
}

/** Record that cascade step `idx` for `role` just quota-walled. `bodyResetAt` is the
 * reset time parsed from the provider's own error body (most accurate at wall time);
 * when absent, the operator-declared step.resetAt applies if configured. */
export function markStepFailed(
  role: FailoverRole,
  idx: number,
  reason: string,
  bodyResetAt?: Date
): void {
  const rule = rules.get(role);
  if (!rule || idx < 0 || idx >= rule.steps.length) return;
  const arr = stepFailuresFor(role);
  const resetAt = bodyResetAt ?? rule.steps[idx].resetAt;
  arr[idx] = { count: arr[idx].count + 1, lastFailure: new Date(Date.now()), resetAt };
  const ttlText = resetAt ? `until ${resetAt.toISOString()}` : `${Math.round(stepTtlMs(arr[idx].count) / 60000)}min`;
  logStderr(
    `[Failover] step ${role}[${idx}] (${rule.steps[idx].label}) walled — count=${arr[idx].count} ttl=${ttlText} (${reason})`
  );
}

/** Clear one step's failure state after it answered successfully. */
export function resetStepSuccess(role: FailoverRole, idx: number): void {
  const arr = stepFailures.get(role);
  if (!arr || !arr[idx] || arr[idx].count === 0) return;
  arr[idx] = { count: 0, lastFailure: new Date(0) };
}

/** Clear ALL step failures for a role — used when the nominal itself recovers. */
export function resetAllStepFailures(role: FailoverRole): void {
  stepFailures.delete(role);
}

// ─── resolution ────────────────────────────────────────────────────────────────

/**
 * The cascade step that should serve `role` right now, or null for the nominal model.
 * Walks the cascade, skipping TTL-failed steps; if every step is TTL-failed, returns
 * the LAST step anyway (PAYG is meant to always work). Single source of truth — used
 * by `getHandlerForRequest`'s swap AND the cascade loop.
 */
export function resolveFailoverTarget(role: FailoverRole): { step: FailoverStep | null; stepIndex: number } {
  const rule = rules.get(role);
  if (!rule || !isFailoverActive(role)) return { step: null, stepIndex: -1 };
  return resolveSkippingFailed(role, rule);
}

/** Resolution that does NOT call isFailoverActive (used inside isFailoverActive's
 * own expiry path, to avoid recursion and to read pre-deletion state). Assumes armed. */
function resolveSkippingFailed(
  role: FailoverRole,
  rule: FailoverRule
): { step: FailoverStep | null; stepIndex: number } {
  const fails = stepFailures.get(role);
  for (let i = 0; i < rule.steps.length; i++) {
    if (!isStepTtlFailed(fails?.[i])) return { step: rule.steps[i], stepIndex: i };
  }
  const last = rule.steps.length - 1;
  return { step: rule.steps[last], stepIndex: last };
}

/**
 * How long an auto-armed substitution holds before the nominal model is retried. A
 * provider wall is a window (Z.AI 5h cap, Anthropic weekly, MiniMax quota) that lifts
 * on its own; staying on the substitute until an operator notices wastes the paid
 * plan. Ten minutes recovers promptly while probing at most ~6×/hour.
 */
/**
 * True when requests for this role must be routed into the cascade. Auto-arms EXPIRE
 * after AUTO_ARM_TTL_MS: once expired the entry is dropped and the role's prior
 * resolved step is stashed in `pendingRecovery` so the cascade loop can emit a
 * recovery notice if the nominal probe succeeds. Config-arms never expire.
 *
 * NOTE: step-failure state is intentionally NOT cleared here — the per-step backoff
 * must outlive the role-arm cycle so a weekly-walled step isn't re-probed every
 * 10 minutes. It is cleared only on full nominal recovery (resetAllStepFailures).
 */
export function isFailoverActive(role: FailoverRole): boolean {
  const entry = armed.get(role);
  if (!entry) return false;
  if (entry.reason === "config") return true; // operator-held: never self-clears
  if (Date.now() - entry.since.getTime() < AUTO_ARM_TTL_MS) return true;
  // TTL expired. Capture what this role was serving so the loop can seed recovery on
  // a successful nominal probe, then disarm.
  const rule = rules.get(role);
  if (rule) {
    const { step, stepIndex } = resolveSkippingFailed(role, rule);
    if (step) pendingRecovery.set(role, { label: step.label, direction: step.direction, stepIndex });
  }
  armed.delete(role);
  notifiedSessions.delete(role); // a fresh episode may re-notify at a new depth
  logStderr(
    `[Failover] DISARMED ${role} → probing nominal (auto-arm TTL elapsed after ${Math.round(
      (Date.now() - entry.since.getTime()) / 60000
    )}min). Re-arms if the wall is still up.`
  );
  return false;
}

/** Currently-armed roles with their resolved step, in stable role order. */
export function getActiveFailovers(): ResolvedFailover[] {
  const out: ResolvedFailover[] = [];
  for (const role of FAILOVER_ROLES) {
    if (!isFailoverActive(role)) continue;
    const { step, stepIndex } = resolveFailoverTarget(role);
    if (step) out.push({ role, step, stepIndex });
  }
  return out;
}

/**
 * Arm a role after an upstream refusal. No-op unless CLAUDISH_FAILOVER_AUTO is on and
 * a cascade is configured. Returns true only on the transition. Re-arming clears any
 * stale recovery state for the role — we are back in failover, a recovery notice
 * would mislead.
 */
export function armFailover(role: FailoverRole, reason: string): boolean {
  if (!autoArmEnabled) return false;
  // isFailoverActive (not armed.has) so an EXPIRED auto-arm can re-arm.
  if (isFailoverActive(role)) return false;
  const rule = rules.get(role);
  if (!rule) return false;
  armed.set(role, { since: new Date(Date.now()), reason });
  pendingRecovery.delete(role);
  recovering.delete(role);
  const { step } = resolveFailoverTarget(role);
  logStderr(`[Failover] ARMED ${role} → ${step ? step.label : "cascade"} — ${reason}`);
  return true;
}

/**
 * Does this upstream failure mean "the budget for this role is gone"? Deliberately
 * narrower than FallbackHandler.isRetryableError: a 404/401 is a wiring mistake, and
 * swapping the model would hide it. Only quota/credit exhaustion arms a failover.
 */
export function isQuotaExhaustion(status: number, body: string): boolean {
  if (status === 402) return true; // payment required
  const lower = (body || "").toLowerCase();
  if (status === 429) {
    // A plain per-minute rate limit is transient and must NOT burn the weekly budget
    // switch; only a plan/quota exhaustion should.
    if (
      lower.includes("quota") ||
      lower.includes("credit") ||
      lower.includes("balance") ||
      lower.includes("weekly") ||
      lower.includes("usage limit") ||
      lower.includes("plan limit") ||
      lower.includes("exhaust")
    ) {
      return true;
    }
    // Anthropic weekly usage cap: the body says "rate limit" — the one word this
    // branch exists to distrust — but Anthropic's per-minute bodies always name
    // a WINDOW ("tokens per minute", "requests per minute"), while the cap names
    // the ACCOUNT with no window: "This request would exceed your account's rate
    // limit. Please try again later." Production 2026-08-20: no keyword above
    // matched, the opus cascade never armed through the entire exhaustion
    // window, and every client saw the raw 429 instead of Qwen step 0.
    if (
      lower.includes("exceed your account") &&
      !lower.includes("per minute") &&
      !lower.includes("per second") &&
      !lower.includes("per hour")
    ) {
      return true;
    }
    return false;
  }
  if (status === 400 || status === 403 || status === 500) {
    return (
      lower.includes("insufficient balance") ||
      lower.includes("insufficient credit") ||
      lower.includes("insufficient_quota") ||
      lower.includes("quota exceeded") ||
      lower.includes("allocationquota")
    );
  }
  return false;
}

/**
 * Extract a wall-lift time from a provider error body, when the provider names one.
 *  - Qwen (Alibaba MaaS): "The quota will reset at 08-25 22:28:00 UTC" — MM-DD HH:mm:ss,
 *    year implied (guards a Dec→Jan rollover by rolling a >1-day-past date forward).
 *  - MiniMax: "Resets in 2 days 13 hr" — relative to now.
 * Returns undefined for silent bodies (Mistral's subscription 402, Anthropic's weekly
 * cap, plain per-minute rate limits) — those fall back to the config-declared
 * step.resetAt or the exponential backoff.
 */
export function parseResetAtFromBody(body: string): Date | undefined {
  const text = body || "";
  const abs = /reset at (\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)? UTC/i.exec(text);
  if (abs) {
    const year = new Date().getUTCFullYear();
    let d = new Date(
      Date.UTC(year, Number(abs[1]) - 1, Number(abs[2]), Number(abs[3]), Number(abs[4]), Number(abs[5]))
    );
    if (d.getTime() < Date.now() - 24 * 3600_000) {
      d.setUTCFullYear(d.getUTCFullYear() + 1);
    }
    return d;
  }
  const rel = /resets? in (\d+) days?(?:\s+(\d+)\s*h(?:rs?|ours?)?)?/i.exec(text);
  if (rel) {
    const days = Number(rel[1]);
    const hours = rel[2] ? Number(rel[2]) : 0;
    return new Date(Date.now() + days * 24 * 3600_000 + hours * 3600_000);
  }
  return undefined;
}

/**
 * Is this failure a *wiring* fault — a bad key, a bad endpoint, a model id typed
 * wrong in a cascade step?
 *
 * This is the explicit negative space of {@link isQuotaExhaustion}, and it exists
 * for one reason: the cascade may advance past an intermediate step that fails for
 * an unrecognized reason (see the fail-forward branch in `handleWithCascade`).
 * Advancing is right for a step that is genuinely unwell, and wrong for a step that
 * is merely *misconfigured* — a mistyped model id would otherwise become permanently
 * invisible, because every request would silently step over it while the cascade
 * looked healthy and quietly ran one step short.
 *
 * Keyed on the machine-readable signature where a provider offers one
 * (`"type":"invalid_model"`, GLM code 1500), with the human message as a fallback
 * anchor for providers that offer none. 401/403/404 need no body: there is no
 * reading of them under which swapping the model is the correct response.
 *
 * Deliberately NOT a catch-all for 400: a payload-shape 400 (e.g. DeepSeek's
 * `reasoning_content must be passed back`) IS worth advancing over, because another
 * provider may well accept the same payload. Only the *identity* errors are pinned.
 */
export function isWiringError(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 404) return true;
  if (status !== 400) return false;
  const lower = (body || "").toLowerCase();
  return (
    lower.includes("invalid_model") ||
    lower.includes("invalid model") ||
    lower.includes("model not found") ||
    lower.includes("unknown model")
  );
}

/**
 * Called by the cascade loop when the NOMINAL model answered successfully for `role`.
 * Clears all step failures (healthy nominal = fresh episode) and, if the role had a
 * pending recovery (its auto-arm just expired), seeds the recovery notice state.
 */
export function onNominalSuccess(role: FailoverRole): void {
  resetAllStepFailures(role);
  const pending = pendingRecovery.get(role);
  if (pending) {
    pendingRecovery.delete(role);
    recovering.set(role, {
      since: new Date(Date.now()),
      remaining: RECOVERY_CONDENSATIONS,
      prevLabel: pending.label,
      prevDirection: pending.direction,
      prevStepIndex: pending.stepIndex,
      notifiedSessions: new Set(),
    });
    logStderr(
      `[Failover] RECOVERED ${role} → nominal (was ${pending.label}, the ${ordinal(
        pending.stepIndex
      )} fallback). Recovery notices for ${RECOVERY_CONDENSATIONS} condensations.`
    );
  }
}

/** True while recovery notices should fire for `role` (self-clears after TTL). */
export function isRecovering(role: FailoverRole): boolean {
  const r = recovering.get(role);
  if (!r) return false;
  if (Date.now() - r.since.getTime() > RECOVERY_MAX_MS) {
    recovering.delete(role);
    return false;
  }
  return true;
}

function recoveringState(role: FailoverRole): RecoveryState | undefined {
  return isRecovering(role) ? recovering.get(role) : undefined;
}

// ─── notices ───────────────────────────────────────────────────────────────────

const DIRECTION_TEXT: Record<FailoverDirection, string> = {
  degraded: "slightly weaker than the nominal model",
  improved: "stronger than the nominal model",
  lateral: "roughly equivalent to the nominal model",
};

function ordinal(n: number): string {
  return (["1st", "2nd", "3rd"][n] as string | undefined) ?? `${n + 1}th`;
}

/**
 * The block appended to a condensation result. Returns null when nothing is armed and
 * nothing is recovering, so the common case adds zero bytes. Emits one line per armed
 * role (onset — fires every /compact while armed) and one per recovering role
 * (recovery — fires RECOVERY_CONDENSATIONS times then clears). Written for the agent
 * that reads it as context: which model is actually serving, which ahead of it is
 * also exhausted, and what to do about it.
 *
 * When `role` is given, only that role is reported: a condensation belongs to one
 * session, and only the failover of THAT session's role is "the model actually
 * serving you". An armed sibling role is someone else's failover — announcing it
 * here tells the agent its own requests are substituted when they are not.
 */
export function buildFailoverNotice(role?: FailoverRole | null): string | null {
  const active = getActiveFailovers().filter((a) => !role || a.role === role);
  const rec = FAILOVER_ROLES.filter((r) => (!role || r === role) && isRecovering(r)).map((r) => ({
    role: r,
    state: recoveringState(r)!,
  }));
  if (active.length === 0 && rec.length === 0) return null;

  const lines: string[] = [];
  for (const a of active) {
    const { role, step, stepIndex } = a;
    const ahead = stepIndex > 0
      ? ` (${rules
          .get(role)!
          .steps.slice(0, stepIndex)
          .map((s) => s.label)
          .join(", ")} ahead of it ${stepIndex === 1 ? "is" : "are"} also exhausted)`
      : "";
    const bits = [
      `- \`${role}\` is being served by **${step.label}** (\`${step.target}\`) — the ${ordinal(
        stepIndex
      )} fallback${ahead}, ${DIRECTION_TEXT[step.direction]}.`,
    ];
    if (step.note) bits.push(`  ${step.note}`);
    lines.push(bits.join("\n"));
  }
  for (const r of rec) {
    const roleLabel = r.role.charAt(0).toUpperCase() + r.role.slice(1);
    const recal =
      r.state.prevDirection === "improved"
        ? `You were stronger than nominal under ${r.state.prevLabel}; scale back to your normal ${roleLabel} capability.`
        : `The context you inherit was built under a weaker model (${r.state.prevLabel}) — resume your normal working scope: you can take on tasks you deferred under the substitute.`;
    lines.push(
      `- \`${r.role}\` is **back on the nominal ${roleLabel} model** after serving as ${r.state.prevLabel} (the ${ordinal(
        r.state.prevStepIndex
      )} fallback). ${recal}`
    );
    // Decrement after emitting; clear when the budget of condensations is spent.
    r.state.remaining -= 1;
    if (r.state.remaining <= 0) recovering.delete(r.role);
  }

  const header =
    active.length === 0 && rec.length > 0
      ? "**[claudish] Nominal model restored.** One or more roles are back on their nominal model after a budget failover:"
      : "**[claudish] Failover model active.** This condensation, and the requests that follow it, are not being served by the nominal model:";
  return [
    "",
    "---",
    "",
    header,
    "",
    ...lines,
    "",
    "This is a cascade of budget substitutions, not an error — the nominal plan is exhausted or being conserved. Keep working; adjust your expectations to the model actually serving you.",
  ].join("\n");
}

/**
 * Append the failover/recovery notice to a collected Anthropic message, in place.
 * Called on the non-streaming path (`/compact` and any `stream: false` caller).
 * Pass the requesting session's role so the notice covers only that role's
 * failover. Appends to the trailing text block when there is one (clients may read
 * `content[0]`), otherwise pushes one. Never throws — a malformed message must not
 * turn a working condensation into a failed one.
 */
export function appendFailoverNoticeToMessage(message: any, role?: FailoverRole | null): void {
  try {
    const notice = buildFailoverNotice(role);
    if (!notice) return;
    if (!message || !Array.isArray(message.content)) return;

    for (let i = message.content.length - 1; i >= 0; i--) {
      const block = message.content[i];
      if (block?.type === "text" && typeof block.text === "string") {
        block.text += notice;
        return;
      }
    }
    message.content.push({ type: "text", text: notice.replace(/^\n+/, "") });
  } catch {
    // Notice is best-effort by design; see doc comment.
  }
}

/** Depth-aware stream notice for an ARMED role: names the step + what's exhausted
 * ahead of it. Addressed to the substitute model about to generate. */
function buildStreamNoticeText(role: FailoverRole, step: FailoverStep, stepIndex: number): string {
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const ahead =
    stepIndex > 0
      ? ` and ${rules
          .get(role)!
          .steps.slice(0, stepIndex)
          .map((s) => s.label)
          .join(", ")} ahead of you ${stepIndex === 1 ? "is" : "are"} also`
      : "";
  const prefix = `[claudish] You are serving this session as ${step.label} (\`${step.target}\`) — the ${ordinal(
    stepIndex
  )} fallback for the ${roleLabel} role, because the nominal ${roleLabel} model${ahead} temporarily exhausted. `;
  if (step.direction === "degraded") {
    return (
      prefix +
      `The context you inherit was built under a stronger model. Adjust accordingly: be more conservative, verify assumptions before acting, prefer well-trodden solutions over speculative ones, and take fewer risks than you would under ${roleLabel}.`
    );
  }
  if (step.direction === "improved") {
    return (
      prefix +
      `You are stronger than the nominal model here — use the extra capability to keep the work on track and clean up any loose ends in the inherited context.`
    );
  }
  return prefix + `Capability is roughly equivalent; continue the work as normal.`;
}

/** One-time stream notice for a RECOVERING role: the nominal is back. */
function buildStreamRecoveryText(role: FailoverRole, st: RecoveryState): string {
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  if (st.prevDirection === "improved") {
    return `[claudish] You are back on the nominal ${roleLabel} model after serving as ${st.prevLabel} (the ${ordinal(
      st.prevStepIndex
    )} fallback), which was stronger than nominal. Scale back to your normal ${roleLabel} working scope.`;
  }
  return `[claudish] You are back on the nominal ${roleLabel} model after serving as ${st.prevLabel} (the ${ordinal(
    st.prevStepIndex
  )} fallback). The context you inherit was built under a weaker model. Resume your normal working scope: you can take on tasks you deferred under the substitute.`;
}

/**
 * Return the one-time stream notice for this role+session, marking the session
 * notified at the current depth. Returns null when there is nothing to announce.
 * Recovery takes precedence (a recovering role is not armed). For an armed role, the
 * notice re-fires when the resolved step CHANGES since the session was last notified
 * (Qwen→GLM mid-session) so the agent recalibrates to the new substitute. Atomic
 * (check + mark in one call) so two concurrent in-flight requests can't both win.
 */
export function consumeStreamNotice(role: FailoverRole, sessionKey: string | null): string | null {
  if (!sessionKey) return null;

  const rec = recoveringState(role);
  if (rec) {
    if (rec.notifiedSessions.has(sessionKey)) return null;
    rec.notifiedSessions.add(sessionKey);
    return buildStreamRecoveryText(role, rec);
  }

  if (!isFailoverActive(role)) return null;
  const { step, stepIndex } = resolveFailoverTarget(role);
  if (!step) return null;
  let perRole = notifiedSessions.get(role);
  if (!perRole) {
    perRole = new Map();
    notifiedSessions.set(role, perRole);
  }
  if (perRole.get(sessionKey) === stepIndex) return null; // already notified at this depth
  perRole.set(sessionKey, stepIndex);
  return buildStreamNoticeText(role, step, stepIndex);
}

/**
 * Extract a stable per-session key from an Anthropic request payload. Claude Code
 * sends `metadata.user_id` as a JSON string `{"device_id","account_uuid","session_id"}`;
 * we key dedup on `session_id`. Returns null when nothing stable is present (the
 * stream notice is then skipped rather than spammed).
 */
export function extractSessionKey(payload: any): string | null {
  try {
    const uid = payload?.metadata?.user_id;
    if (!uid) return null;
    if (typeof uid === "string") {
      try {
        const p = JSON.parse(uid);
        if (p?.session_id) return String(p.session_id);
      } catch {
        /* not JSON — use the raw string */
      }
      return uid;
    }
    if (uid && typeof uid === "object" && (uid as any).session_id) {
      return String((uid as any).session_id);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Test seam: drop all state so a test can install its own environment. */
export function resetFailoverForTests(env?: NodeJS.ProcessEnv): void {
  if (env) {
    initFailover(env);
  } else {
    rules = new Map();
    roleAliases = [];
    autoArmEnabled = false;
    armed.clear();
    stepFailures.clear();
    recovering.clear();
    pendingRecovery.clear();
    notifiedSessions.clear();
  }
}
