/**
 * Failover — role-level model substitution as a transitive cascade of degradations,
 * with explicit onset + recovery notices.
 *
 * This is NOT `FallbackHandler` (handlers/fallback-handler.ts). That one swaps
 * *providers* for the *same* model when a provider is unhealthy — a transport
 * concern. This one swaps the *model itself* for a whole role (opus/sonnet/haiku/fable)
 * when the nominal model's budget is exhausted — a subscription concern.
 *
 * Each role has an ORDERED CASCADE of substitutes, `>`-separated in env. Walls are
 * per PROVIDER BUCKET (#275): a refusal walls the meter the refusing nominal draws
 * on, and only requests whose own nominal sits in a walled bucket divert — the
 * maxing of one provider never contaminates another role's healthy nominal.
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
import { parseModelSpec } from "../providers/model-parser.js";

export type FailoverRole = "opus" | "sonnet" | "haiku" | "fable";

export const FAILOVER_ROLES: readonly FailoverRole[] = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
] as const;

/** Which way the substitution moves capability, from the agent's point of view. */
export type FailoverDirection = "degraded" | "improved" | "lateral";

/** One substitution target within a role's cascade. */
export interface FailoverStep {
  /** Routing target, in any form `getHandlerForRequest` accepts. When this step
   * delegates to another role (#274), this holds the CONCRETE model currently
   * serving that role (its nominal if healthy, else the target of its own
   * resolved cascade step) — refreshed at every resolution. The dwell pin, the
   * notices and the routing log all read this field, so a role-step is always
   * announced and pinned by what it actually serves, never by the role name. */
  target: string;
  /** #274: set when this step was configured as `role:<r>` — a delegation to
   * another role rather than a model target. `target` then holds the resolved
   * concrete model (see above). */
  roleRef?: FailoverRole;
  /** Human label for the notice; defaults to the target string. */
  label: string;
  direction: FailoverDirection;
  /** Optional extra guidance appended to the notice line. */
  note?: string;
  /** Operator-declared reset time (CLAUDISH_FAILOVER_<ROLE>_RESET): while in the
   * FUTURE it CLOSES a HEALTHY step — never selected by the walk, never the
   * last-step fallback, and a dwell pin on it yields (#261; a closure gesture must
   * bite on a step that never failed, not only extend the backoff of a walled one).
   * A step that HAS failed is governed by its failure record's resetAt instead —
   * body-parsed wins over this config date at mark time (the live body knew
   * better); the two planes trade places only across a restart, whose
   * initFailover wipe leaves every step healthy. Once the date passes, the step is
   * probeable again, backoff deciding as for any other step. For walls whose body
   * carries no date (Mistral's subscription 402). */
  resetAt?: Date;
}

export interface FailoverRule {
  role: FailoverRole;
  /** Ordered substitutes; index 0 is served first when the nominal walls. */
  steps: FailoverStep[];
}

/** A provider bucket currently walled (armed). Does not carry the resolved
 * step — that depends on the ROLE's per-step failure state, resolved on demand. */
export interface ArmedFailover {
  since: Date;
  /** The upstream error that armed the wall. */
  reason: string;
  /** How long THIS wall holds before the bucket's nominals are probed again
   * (#91 point 3: grows with each disarm→re-arm cycle while the wall holds). */
  ttlMs: number;
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
   * config-declared step.resetAt. While set and in the future the FAILED step
   * stays skipped regardless of backoff — the wall cannot lift before its reset.
   * Once it passes, the step is probed again (a reset step must be consumed, not
   * avoided). Distinct from the config plane (#261): a future step.resetAt closes
   * even a HEALTHY step (count===0); this record's resetAt only extends the
   * backoff of a step that actually failed. */
  resetAt?: Date;
  /** #276: the LATEST failure was NON-quota — the STEP-ADVANCE class (the step is
   * broken or content-filtering; its provider's meter is NOT walled). Set only by
   * the proxy's non-quota fail-forward site. A dwell pin whose step died this way
   * yields WITHOUT re-pinning, so the session rejoins the general resolution and
   * returns to the nominal the moment its bucket wall expires — instead of riding
   * the next cascade step past a recovered nominal (measured 2026-09-28: a pinned
   * session sat on the PAYG tail for hours while the nominal sat healthy at 47%).
   * Absent = quota-class (or unmarked) — ordinary advancement, the pin re-pins at
   * the next step. The record is replaced whole on each mark, so the flag always
   * reflects the most recent death, never an older episode. */
  nonQuota?: true;
  /** #331: the CONCRETE target this failure was recorded against. For a
   * `role:` step the backoff measures one concrete the delegation happened to
   * resolve to — the delegation itself may have since ADVANCED (the target
   * role's own resolution moved on), and freezing the step for that old
   * concrete's wall kept a role with no other path dead up to the 24 h cap
   * while the target served healthily (hub po-2025, 2026-10-04: `haiku[1]` =
   * `role:sonnet`, 408 walls, TTL escalated to 1440 min). While set and the
   * delegation still resolves to THIS concrete, the TTL binds; once
   * `resolveRoleStep` yields a different concrete the step is probeable again.
   * For model steps the field is inert (their TTL is about the step itself —
   * a model step's target never moves). Absent = binds (a record without a
   * concrete — the pre-#331 shape — keeps the freeze; conservative). Every
   * proxy-side mark carries it since #331, the #263 revisit re-mark included. */
  concrete?: string;
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

// ─── #275: per-model maxing, provider-scoped contagion ─────────────────────────
// Walls used to be keyed by ROLE: any member's refusal (Sol's weekly wall, a native
// claude-sonnet 429) exiled EVERY request of that role — including those whose own
// nominal (z.ai GLM at 47% credit remaining) was perfectly healthy. Measured
// 2026-09-28 on the hub: two arms keyed `sonnet` off `gpt-6-sol` and the whole
// fleet walked Mistral(402)→Kimi(403)→DeepSeek while z.ai served nothing.
//
// The operator ruling: maxing is a property of the MODEL'S PROVIDER BUCKET — the
// meter — and NOTHING else. A qualifying refusal while serving model M walls
// bucket(M); only requests whose own resolved nominal sits in a walled bucket
// divert to THEIR role's cascade (marche 1, never the nominal — see #274). The
// OpenAI Pro plan exhausting walls `openai-codex` (Sol AND astra divert, across
// roles); the GLM Coding 5h window walls `glm-coding`; it never reaches a healthy
// `glm-coding`-nominal request through the sonnet role.

/** Prefix of the bucket a native-lane target draws on. The native meter is the
 * CLIENT's Anthropic credential (the proxy holds none), so native buckets are
 * PER MODEL — `anthropic-native/<model>` — never one shared native bucket: a
 * native sonnet 429 bills a different client credential than native opus. */
export const NATIVE_BUCKET = "anthropic-native";
/** Legacy/test bucket: a wall on `*` diverts the role regardless of nominal
 * (the pre-#275 role-wide arm, still what `armFailover(role, reason)` creates). */
export const LEGACY_ROLE_WIDE_BUCKET = "*";

/** The per-model bucket of a native-lane target (see NATIVE_BUCKET). */
export function nativeBucketFor(model: string): string {
  return `${NATIVE_BUCKET}/${model}`;
}

/** The request-side half of #275: which meter does this nominal target draw on?
 * Pure decision core of proxy-server's `nominalBucketOfModel`, extracted so the
 * derivation is testable without booting the proxy (PR #277 review). Mirrors
 * step 2c of `getHandlerForRequest` EXACTLY — the two must not drift, or a wall
 * arms on a bucket no request ever resolves to:
 *  - an explicit target (`provider@model`, legacy prefix, URL) buckets on its
 *    CANONICAL provider name — parseModelSpec resolves shortcuts (`gc@` →
 *    `glm-coding`, `cx@` → `openai-codex`, `or@` → `openrouter`), the same
 *    vocabulary `route()` emits for bare names: one meter, one bucket, whatever
 *    the spelling;
 *  - a bare name that parseModelSpec classifies native-anthropic (`claude-*`,
 *    any unmapped bare name) stays on the native lane UNLESS a user-authored
 *    routing override claims it (#3401) — `route()` is never consulted, so a
 *    hub without an Anthropic key cannot mis-bucket it `openrouter`;
 *  - anything else is the routing chain's decision: `route()` (credential-
 *    filtered) names the primary provider, and that is the bucket.
 */
export type NominalBucketDecision = { bucket: string } | { routeModel: string };

export function classifyNominalBucket(
  target: string,
  userRoutingOverride: (model: string) => boolean
): NominalBucketDecision {
  const parsed = parseModelSpec((target || "").trim());
  if (parsed.isExplicitProvider) return { bucket: parsed.provider };
  if (parsed.provider === "native-anthropic" && !userRoutingOverride(parsed.model)) {
    return { bucket: nativeBucketFor(parsed.model) };
  }
  return { routeModel: parsed.model };
}

/** Last-resort bucket for a target the routing chain could not resolve (route()
 * returned no plan). Canonicalized through parseModelSpec like
 * classifyNominalBucket, with the vendor prefix as the only signal left for the
 * unknown `vendor/model` form. */
export function providerBucketOf(target: string): string {
  const t = (target || "").trim();
  const parsed = parseModelSpec(t);
  if (parsed.isExplicitProvider) return parsed.provider;
  if (parsed.provider === "native-anthropic") return nativeBucketFor(parsed.model);
  if (parsed.provider === "unknown") {
    const slash = t.indexOf("/");
    return slash > 0 ? t.slice(0, slash) : nativeBucketFor(parsed.model);
  }
  return parsed.provider;
}

/** Walled provider buckets (auto-arms; TTL-expiring). Config-arms live separately
 * in configArmedRoles — they are operator-held and never self-clear. */
const walled = new Map<string, ArmedFailover>();
/** Roles armed by CLAUDISH_FAILOVER_ACTIVE — divert regardless of bucket. */
const configArmedRoles = new Set<FailoverRole>();
/** Per-step failure counters, per role. Independent of the bucket-wall TTL: the
 * cascade steps are shared targets, their walls are facts about the STEP, not
 * about whichever nominal diverted onto it. */
const stepFailures = new Map<FailoverRole, StepFailure[]>();
/** (role|bucket) pairs that just returned to nominal — emitting recovery notices. */
const recovering = new Map<string, RecoveryState>();
/** (role|bucket) → the cascade step that pair was last seen serving while its
 * bucket was walled. Replaces the old per-role pendingRecovery: recovery is now
 * knowable per (role, bucket), and the wall expiry itself no longer sees the role. */
const servedUnderWall = new Map<string, { label: string; direction: FailoverDirection; stepIndex: number }>();
/**
 * Sessions that have already received the "moment of failover" stream notice, per
 * (role|bucket), mapped to the set of step indices they were notified at. Re-notify
 * when the resolved step CHANGES (Qwen→GLM mid-session) so the agent recalibrates
 * to the new substitute. Cleared on wall TTL expiry (a fresh episode re-notifies)
 * and on full reset. Condensation notices are independent of this map.
 */
const notifiedSessions = new Map<string, Map<string, Set<number>>>();

function roleBucketKey(role: FailoverRole, bucket: string | undefined): string {
  return `${role}|${bucket ?? LEGACY_ROLE_WIDE_BUCKET}`;
}

const AUTO_ARM_TTL_MS = 10 * 60 * 1000;
/** #91 point 3: the re-probe TTL grows while the wall holds. A flat 10-minute
 * disarm/re-arm cycle flips the serving model ~6×/hour for the whole duration of
 * a wall (measured on the hub: 107 arms ≈ 214 model transitions per 24 h), cold
 * prompt-cache on BOTH ends each time. Steps: 10 m → 20 m → 40 m, capped. */
const ARM_TTL_STEPS_MS = [AUTO_ARM_TTL_MS, 20 * 60_000, 40 * 60_000];
/** Cap of the bucket-wall TTL ladder (40 min). Exported as the documented
 * defensive ceiling for the #409 retry-after horizon: the longest the proxy
 * can ever sit on a walled bucket without re-probing it. */
export const ARM_TTL_MAX_MS = ARM_TTL_STEPS_MS[ARM_TTL_STEPS_MS.length - 1];
const RECOVERY_CONDENSATIONS = 3;
/** Safety TTL: clear recovery even if no compactions fire to decrement it. */
const RECOVERY_MAX_MS = 60 * 60 * 1000;
/** Per-step probe backoff: ~10m, 30m, 1h, 4h, then a 24h cap. */
const BACKOFF_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000];

// ─── #91: grace before arming ──────────────────────────────────────────────────
// One transient refusal used to exile the role for a full AUTO_ARM_TTL_MS and
// flip the serving model twice (cold prompt cache at both ends). For this fleet
// a brief stall is cheaper than a silent provider switch, so arming now needs
// CLAUDISH_FAILOVER_ARM_AFTER consecutive qualifying refusals (1 restores the
// pre-#91 arm-on-first-refusal), and a 429 naming a SHORT retry delay never
// counts at all — a wall speaks in hours, a burst says seconds.

/** Consecutive qualifying nominal refusals required before arming. >= 1. */
let armAfterRefusals = 2;
/** When > 0, an under-threshold refusal waits this long and retries the NOMINAL
 * once inside the same request before surfacing the 429. 0 = off (default). */
let armGraceMs = 0;
/** A retry-after below this is a burst, never a wall. Tunable, 120 s start. */
let armRetryAfterCeilingMs = 120_000;
/** #91 point 4: minimum time a session keeps its resolved cascade step, so an
 * in-flight conversation cannot flip providers mid-work (each flip = cold
 * prompt-cache at both ends). 0 disables the per-session dwell. */
let sessionDwellMs = 600_000;
/** Dwell recovery: how long a VERIFIED nominal recovery (a real request served
 * by the nominal, not a TTL expiry that merely starts a probe) must hold before
 * live dwell pins yield back to it. Bounds the oscillation cost of an
 * intermittent wall's isolated success to one provider switch per arm cycle. */
let recoveryGraceMs = 120_000;
/** Run of consecutive qualifying nominal refusals, per bucket (#91 gate). All the
 * nominals of a bucket draw on the same meter, so every refusal through it — from
 * any role — counts toward the same wall. */
const nominalRefusals = new Map<string, { count: number; lastAt: number }>();
/** #91 point 3: TTL-expiry disarms per bucket that led back to an arm (the wall
 * still held). Grows the NEXT wall's TTL; reset by any nominal success. */
const armTtlEscalation = new Map<string, { disarms: number; lastDisarmAt: number }>();

/** TTL for a fresh wall of `bucket`: base, or the escalated step when the previous
 * disarm re-armed (wall still up). A re-arm more than ARM_TTL_MAX_MS after the
 * last disarm is a fresh episode — the escalation decayed. */
function armTtlFor(bucket: string): number {
  const esc = armTtlEscalation.get(bucket);
  if (!esc || Date.now() - esc.lastDisarmAt > ARM_TTL_MAX_MS) return ARM_TTL_STEPS_MS[0];
  return ARM_TTL_STEPS_MS[Math.min(esc.disarms, ARM_TTL_STEPS_MS.length - 1)];
}

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

/** #274: parse a `role:<r>` step reference. Returns the role when the raw step
 * is exactly that form (case-insensitive, trimmed); undefined otherwise — a
 * model target must never be misparsed as a delegation (models can contain
 * colons, e.g. `ollama@llama3.2:3`, but `role:` is unambiguous). */
function parseRoleRef(raw: string): FailoverRole | undefined {
  const m = /^role\s*:\s*(.+)$/i.exec((raw || "").trim());
  if (!m) return undefined;
  const role = m[1].trim().toLowerCase() as FailoverRole;
  return FAILOVER_ROLES.includes(role) ? role : undefined;
}

/**
 * #274 acyclicity guard: the delegation graph (role → roles it references via
 * `role:` steps) must stay acyclic — Sonnet's chain stays model-only by design,
 * so role-steps terminate there. A cycle is refused at LOAD time (never at
 * resolution): the config is dropped with a loud log rather than letting a
 * recursive resolution loop forever at runtime. Self-reference is a cycle of 1.
 * Returns true when the graph is acyclic (no delegation path returns to `from`).
 */
function delegationAcyclic(
  from: FailoverRole,
  visiting: Set<FailoverRole>,
  refs: Map<FailoverRole, FailoverRole[]>
): boolean {
  if (visiting.has(from)) return false;
  visiting.add(from);
  for (const next of refs.get(from) ?? []) {
    if (!delegationAcyclic(next, visiting, refs)) return false;
  }
  visiting.delete(from);
  return true;
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
  const rawTargets = new Map<FailoverRole, string[]>();
  for (const role of FAILOVER_ROLES) {
    const targets = splitSteps(env[`CLAUDISH_FAILOVER_${role.toUpperCase()}`] || "");
    if (targets.length > 0) rawTargets.set(role, targets);
  }
  // #274: collect the delegation graph and refuse a cyclic config at load —
  // resolution must be able to assume the graph terminates.
  const refs = new Map<FailoverRole, FailoverRole[]>();
  for (const [role, targets] of rawTargets) {
    const r = targets.map(parseRoleRef).filter((x): x is FailoverRole => x !== undefined);
    if (r.length > 0) refs.set(role, r);
  }
  const rejected = new Set<FailoverRole>();
  for (const role of rawTargets.keys()) {
    if (!delegationAcyclic(role, new Set(), refs)) {
      rejected.add(role);
      logStderr(
        `[Failover] ${role}: REFUSED — its 'role:' delegation forms a cycle (${[...(refs.get(role) ?? [])].join(", ")}). The delegation graph must stay acyclic; check CLAUDISH_FAILOVER_${role.toUpperCase()} and every role it delegates to.`
      );
    }
  }

  const out = new Map<FailoverRole, FailoverRule>();
  for (const role of FAILOVER_ROLES) {
    const targets = rawTargets.get(role);
    if (!targets || rejected.has(role)) continue;
    const key = `CLAUDISH_FAILOVER_${role.toUpperCase()}`;
    const labels = splitSteps(env[`${key}_LABEL`] || "");
    const directions = splitSteps(env[`${key}_DIRECTION`] || "");
    const notes = splitSteps(env[`${key}_NOTE`] || "");
    const resets = parseStepResets(env[`${key}_RESET`], targets.length, role);
    if (labels.length !== 0 && labels.length !== targets.length) {
      logStderr(
        `[Failover] ${role}: ${labels.length} labels vs ${targets.length} targets — padding with defaults. Check ${key}_LABEL.`
      );
    }
    const steps: FailoverStep[] = targets.map((target, i) => {
      const roleRef = parseRoleRef(target);
      return {
        // A role-step's target starts as the role keyword; the first resolution
        // replaces it with the concrete model actually serving that role. Until
        // then nothing routes to it (resolution always runs before serving).
        target: roleRef ?? target,
        roleRef,
        label: labels[i]?.trim() || target,
        direction: parseDirection(directions[i]),
        note: notes[i]?.trim() || undefined,
        resetAt: resets[i],
      };
    });
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
  // #261: attest every config closure at startup — one line per step closed by a
  // future resetAt, the countable marker that the gesture bit. The 2026-09-25
  // closure ran invisibly (865 responses on a closed step, nothing in the log
  // said "closed"), which is exactly how an inert closure survives a weekend.
  for (const rule of rules.values()) {
    rule.steps.forEach((step, i) => {
      if (step.resetAt && Date.now() < step.resetAt.getTime()) {
        logStderr(
          `[Failover] CLOSED ${rule.role}[${i}] (${step.label}) until ${step.resetAt.toISOString()} — operator-declared reset; the step is not selected before that instant (#261).`
        );
      }
    });
  }
  roleAliases = parseRoleAliases(env.CLAUDISH_FAILOVER_ROLE_MODELS || "");
  autoArmEnabled = /^(1|true|yes|on)$/i.test((env.CLAUDISH_FAILOVER_AUTO || "").trim());
  walled.clear();
  configArmedRoles.clear();
  // In-memory probe/recovery state does not survive a restart — start fresh.
  stepFailures.clear();
  recovering.clear();
  servedUnderWall.clear();
  notifiedSessions.clear();
  nominalRefusals.clear();
  armTtlEscalation.clear();
  dwellPins.clear();
  dwellYieldTombstones.clear();
  nominalRecoveredAt.clear();
  const parseIntEnv = (raw: string | undefined, fallback: number): number => {
    const n = Number.parseInt((raw || "").trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  };
  armAfterRefusals = Math.max(1, parseIntEnv(env.CLAUDISH_FAILOVER_ARM_AFTER, 2));
  armGraceMs = Math.max(0, parseIntEnv(env.CLAUDISH_FAILOVER_ARM_GRACE_MS, 0));
  armRetryAfterCeilingMs = Math.max(0, parseIntEnv(env.CLAUDISH_FAILOVER_ARM_RETRY_AFTER_CEILING_MS, 120_000));
  sessionDwellMs = Math.max(0, parseIntEnv(env.CLAUDISH_FAILOVER_SESSION_DWELL_MS, 600_000));
  recoveryGraceMs = Math.max(0, parseIntEnv(env.CLAUDISH_FAILOVER_RECOVERY_GRACE_MS, 120_000));

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
      configArmedRoles.add(role);
    }
  }

  if (configArmedRoles.size > 0 || walled.size > 0 || rules.size > 0) {
    const parts: string[] = [];
    for (const role of configArmedRoles) parts.push(`${role}→${describeResolved(role)}`);
    for (const bucket of walled.keys()) parts.push(`${bucket}→walled`);
    const armedList = parts.length > 0 ? parts.join(", ") : "none";
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
  if (m.includes("fable")) return "fable";
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

// ─── #274: role-as-failover-step ───────────────────────────────────────────────
// A cascade step of the form `role:sonnet` delegates to another ROLE instead of
// naming a model — the operator's mental model ("when X maxes, become role Y")
// made config, removing the duplication where a healthy role's nominal had to be
// copied as step 0 of every other role's cascade (deployed 2026-09-28 13:41Z as
// the interim fix, removed once this lands).
//
// Delegation resolution = the target role's NOMINAL when healthy, else the
// target's currently-resolved cascade step (shared walk state) — delegated
// traffic joins the target's existing resolution instead of re-walking walled
// steps. The graph is proven acyclic at load (delegationAcyclic), so the
// recursion below terminates. Failover bookkeeping happens on BOTH levels: the
// delegating step records against its own role (dwell/skip/notice) AND the
// concrete model records against the owning cascade (nominal walls the owning
// bucket, an owning-step wall marks the owning step's backoff).

/** Resolves a role's NOMINAL routing target — injected by proxy-server (the
 * modelMap owner). Unset in tests: a role-step then resolves to its next best
 * concrete substitute (the target role's own cascade, never the unknown
 * nominal), and if the target has no cascade either the delegating step is
 * skipped. Never returns the placeholder role keyword as a servable target. */
let roleNominalResolver: ((role: FailoverRole) => string | undefined) | null = null;

export function setRoleNominalResolver(fn: ((role: FailoverRole) => string | undefined) | null): void {
  roleNominalResolver = fn;
}

/** The provider bucket a role's NOMINAL model draws on, named the way the
 * proxy's request side names it — injected by proxy-server next to the nominal
 * resolver. Keyed by the nominal MODEL the resolver above returned, never by
 * role: the bucket tested must be the one the delegation would actually serve
 * (#367, W21). A bare routing-chain nominal (`glm-5.3`) carries no bucket this
 * module can derive: its meter is the `route()` primary (`glm-coding`), and a
 * user routing rule can send any bare name anywhere. Without it a delegation
 * cannot see that nominal's wall and serves it walled (hub, 08/10→20/10: 15 of
 * the 31 `Sonnet role` delegation walls landed while `glm-coding` was already
 * armed). Unset (unit tests) → the local classification below. */
let roleNominalBucketResolver: ((nominal: string) => string | undefined) | null = null;

export function setRoleNominalBucketResolver(
  fn: ((nominal: string) => string | undefined) | null
): void {
  roleNominalBucketResolver = fn;
}

/** #274: which cascade OWNS the concrete model a delegation just resolved to.
 * Derived BY the resolution itself (see resolveRoleStep) — a reverse
 * target→step lookup cannot find it: role-steps carry targets refreshed in
 * place to the concrete model, so the delegating step (or another role's
 * delegation) wins any string search while the real owner is never matched.
 * `nominal: true` → the concrete model is the target role's NOMINAL (walls
 * arm its bucket through onNominalRefusal); `nominal: false` + `stepIndex` →
 * the concrete model is the target's cascade step i (walls mark that step). */
export type DelegationOwner =
  | { role: FailoverRole; nominal: true }
  | { role: FailoverRole; nominal: false; stepIndex: number };

/** Resolve a role-step to the concrete model currently serving `step.roleRef`:
 * the target's nominal when healthy enough, else the target's own resolved
 * cascade step (recursed — acyclic by load-time proof). "Healthy enough" holds
 * the delegation to the SAME bar the cascade loop holds the nominal: not the
 * arm-after-refusals grace threshold (a wall whose escalate-TTL expired is a
 * live, confirmed wall — its probe belongs to the target's own cascade, not to
 * every session delegated into it). Returns the concrete target string PLUS
 * the owning coordinate (recursed to the terminal role for nested
 * delegations), or null when the delegation cannot serve right now. Side
 * effects: arms the target's nominal bucket when that bucket is already walled
 * but unconfigured; refreshes `step.target` in place. */
function resolveRoleStep(
  _role: FailoverRole,
  step: FailoverStep
): { concrete: string; owner: DelegationOwner } | null {
  const targetRole = step.roleRef!;
  const nominal = roleNominalResolver?.(targetRole);
  if (nominal) {
    // The proxy's own bucket first — the same routing decision the request
    // side keys walls on, user routing rules included. The local
    // classification only stands in when no resolver is injected.
    let bucket = roleNominalBucketResolver?.(nominal);
    if (bucket === undefined) {
      const nb = classifyNominalBucket(nominal, () => false);
      if ("bucket" in nb) bucket = nb.bucket;
    }
    if (bucket !== undefined) {
      const walledNow =
        isBucketWalled(bucket) || isBucketWalled(LEGACY_ROLE_WIDE_BUCKET);
      if (!walledNow) {
        step.target = nominal;
        return { concrete: nominal, owner: { role: targetRole, nominal: true } };
      }
      if (!rules.get(targetRole)) {
        // Walled bucket and the target role has NO cascade to fall to: arm the
        // bucket so the wall owns a failover (a role-step resolves to the
        // nominal if healthy — a walled bucket is not healthy, and with nowhere
        // to fall the delegating role advances to its own next step).
        armFailover(targetRole, `role-step nominal ${nominal} found its bucket ${bucket} walled with no cascade`, bucket);
      }
    } else {
      // Bare routing-chain nominal and no bucket resolver (unit tests): the
      // credential-filtered bucket is a proxy-side (route()) call this module
      // must not make, so serving the nominal is the only safe default.
      step.target = nominal;
      return { concrete: nominal, owner: { role: targetRole, nominal: true } };
    }
  }
  const own = rules.get(targetRole);
  if (own) {
    const ownResolved = resolveSkippingFailed(targetRole, own);
    if (ownResolved.step) {
      if (ownResolved.step.roleRef) {
        // Nested delegation: recurse — the terminal owner is the innermost
        // cascade actually serving, never an intermediate role-step.
        const nested = resolveRoleStep(targetRole, ownResolved.step);
        if (nested) {
          step.target = nested.concrete;
          return nested;
        }
      } else {
        step.target = ownResolved.step.target;
        return {
          concrete: ownResolved.step.target,
          owner: { role: targetRole, nominal: false, stepIndex: ownResolved.stepIndex },
        };
      }
    }
  }
  return null;
}

/** The concrete target of any step: the model itself, or the role-step's
 * resolved delegation. Exposed for the proxy's bookkeeping (knowing WHICH
 * concrete model a role-step currently serves without re-resolving). */
export function resolveConcreteTarget(role: FailoverRole, step: FailoverStep): string | null {
  if (!step.roleRef) return step.target;
  return resolveRoleStep(role, step)?.concrete ?? null;
}

/** #274 (review 29/09): the concrete model AND its owning coordinate for a
 * role-step, derived from the resolution itself. The proxy's cascade loop uses
 * this for delegated bookkeeping: a wall of the concrete model must arm/mark
 * the OWNING cascade (the target's nominal bucket or the target's step), not
 * the delegating step a second time. Null when `step` is not a role-step or
 * the delegation cannot serve right now. */
export function resolveDelegationOwner(
  role: FailoverRole,
  step: FailoverStep
): { concrete: string; owner: DelegationOwner } | null {
  if (!step.roleRef) return null;
  return resolveRoleStep(role, step);
}

// ─── per-step backoff ──────────────────────────────────────────────────────────

function stepTtlMs(count: number): number {
  const idx = Math.min(Math.max(count, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[idx];
}

function isStepTtlFailed(f: StepFailure | undefined, step?: FailoverStep): boolean {
  // #261: an operator-declared FUTURE step.resetAt CLOSES a HEALTHY step (no
  // failure record) outright. Before this, the config value only entered the walk
  // through markStepFailed — extending the backoff of an already-walled step — so a
  // closure gesture on a healthy step silently did nothing, and initFailover's
  // stepFailures wipe at startup meant the very recreate that deployed the _RESET
  // also erased any failure state that would have made it bite. Measured on the hub
  // 2026-09-25: 865 responses served on a Qwen step closed until Monday, the pool
  // burning all weekend while `[Failover] DWELL … pinned to step 2` logged
  // throughout. The two planes compose cleanly: a FAILED step's closure date is
  // its RECORD's resetAt (body-parsed wins over the config date at mark time — the
  // live body knew better; pinned by "body-parsed reset WINS"), and the config
  // plane is what a fresh recreate evaluates, because the wipe leaves every step
  // healthy. They can only trade places across a restart, never in one resolution.
  if ((!f || f.count === 0) && step?.resetAt && Date.now() < step.resetAt.getTime()) {
    return true;
  }
  if (!f || f.count === 0) return false;
  // A known reset date EXTENDS the backoff, it never replaces it. Before the reset
  // instant the wall cannot lift, so the step stays failed however short the backoff
  // rung is. After it, the step is merely probeable — and probeable means the ordinary
  // exponential backoff decides, exactly as for a step that never had a reset date.
  //
  // Returning false outright once the date passed (the 21/08 shape of this function)
  // made the step permanently exempt from backoff: each new wall re-marked it and the
  // very next request re-selected it, so handleWithCascade burned all
  // `steps.length + 1` attempts on one dead step and surfaced its 402 to the client
  // instead of advancing. Production 2026-09-01: sonnet step0 (Mistral) hit count=96
  // in three hours the morning after its declared reset, taking every sonnet lane in
  // the fleet down with it.
  if (f.resetAt && Date.now() < f.resetAt.getTime()) return true;
  return Date.now() - f.lastFailure.getTime() < stepTtlMs(f.count);
}

/** #331: does this step's TTL failure still BIND? A `role:` step's backoff was
 * recorded against ONE concrete the delegation happened to resolve to
 * (`StepFailure.concrete`); the target role's own resolution may have advanced
 * since (its bucket walled, its step marked — the #274 walk state is shared),
 * and the delegating step must follow it instead of staying frozen for up to
 * the 24 h cap on a concrete the delegation has left. The TTL therefore binds
 * a role-step only while `resolveRoleStep` keeps resolving to the SAME
 * concrete; the moment it yields a different one, the step is probeable.
 *
 * Non-negotiables this predicate preserves (decision of record, issue #331):
 *  - INTRA-REQUEST advancement: within one request the resolution cannot move
 *    (nothing succeeds in between), so the same concrete stays skipped.
 *  - The #274 two-level bookkeeping is untouched — this only reads it.
 *  - A MODEL step's TTL is about the step itself (its target never moves):
 *    binds whenever TTL-failed. A record without a concrete (a pre-#331
 *    shape) binds — conservative. The #263 revisit re-mark carries its
 *    concrete, so it binds only while the delegation stays there.
 *  - The #261 closure plane (healthy step, future config resetAt) binds a
 *    role-step regardless of the delegation: an operator closure speaks
 *    louder than where the delegation points today.
 *
 * The `resolveRoleStep` call re-resolves the delegation — its two side effects
 * are the module's shared idiom (a `step.target` refresh in place, and the
 * arm-when-walled-nominal-has-no-cascade guard) and both are what the ordinary
 * probeable path already does one line later in every caller. */
function stepTtlBinds(
  role: FailoverRole,
  f: StepFailure | undefined,
  step: FailoverStep | undefined
): boolean {
  if (!step || !isStepTtlFailed(f, step)) return false;
  if (!step.roleRef) return true;
  if (f?.concrete === undefined) return true;
  return resolveConcreteTarget(role, step) === f.concrete;
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

/** Record that cascade step `idx` for `role` just failed. A quota wall is the
 * default vocabulary; `opts.nonQuota` marks the STEP-ADVANCE class instead (the
 * step is broken, not walled — different log verb, and a dwell pin on it yields
 * without re-pinning, #276). `bodyResetAt` is the reset time parsed from the
 * provider's own error body (most accurate at wall time); when absent, the
 * operator-declared step.resetAt applies if configured. `opts.concrete` is the
 * concrete target the failed attempt served (#331): for a `role:` step it is
 * what the delegation resolved to, and the step's TTL binds only while the
 * delegation keeps resolving there. */
export function markStepFailed(
  role: FailoverRole,
  idx: number,
  reason: string,
  bodyResetAt?: Date,
  opts?: { nonQuota?: boolean; concrete?: string }
): void {
  const rule = rules.get(role);
  if (!rule || idx < 0 || idx >= rule.steps.length) return;
  const arr = stepFailuresFor(role);
  const resetAt = bodyResetAt ?? rule.steps[idx].resetAt;
  const nonQuota = opts?.nonQuota === true;
  const concrete = opts?.concrete;
  arr[idx] = {
    count: arr[idx].count + 1,
    lastFailure: new Date(Date.now()),
    resetAt,
    ...(nonQuota ? { nonQuota: true } : {}),
    ...(concrete !== undefined ? { concrete } : {}),
  };
  const ttlText = resetAt ? `until ${resetAt.toISOString()}` : `${Math.round(stepTtlMs(arr[idx].count) / 60000)}min`;
  logStderr(
    `[Failover] step ${role}[${idx}] (${rule.steps[idx].label}) ${nonQuota ? "failed (non-quota)" : "walled"} — count=${arr[idx].count} ttl=${ttlText} (${reason})`
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

/**
 * #409 (review CR1): the earliest instant the proxy will re-probe ANY walled
 * element of the role — the earliest moment service can come back on its own.
 * Sources, all future-dated (a past reset means "already open" and bounds
 * nothing): the request's bucket wall at TTL expiry (the wall disarms and
 * probes the nominal again), the legacy role-wide `*` wall if armed, each
 * step's known reset when it names one (body-parsed at mark time, else the
 * operator's `_RESET`), else that step's backoff expiry
 * (`lastFailure + stepTtlMs(count)` — the cascade re-probes skipped steps when
 * it resolves), then any future config step.resetAt (#261 closures, which DO
 * re-arm when the date passes). Feeds the `retry-after` of the rewritten
 * last-step wall: a horizon beyond the next re-probe tells the client to sleep
 * through the moment service returns — the R1 defect was exactly that, Kimi's
 * announced week on one step producing ≈83 days while GLM's 5-hour window on
 * another step reopened on its own — and Claude Code honors a multi-day
 * retry-after by sleeping or abandoning the turn.
 */
export function earliestWalledReprobeAt(role: FailoverRole, bucket?: string): Date | undefined {
  const now = Date.now();
  let earliest: Date | undefined;
  const consider = (t: number) => {
    if (t > now && (earliest === undefined || t < earliest.getTime())) earliest = new Date(t);
  };
  const wall = walled.get(bucket ?? "");
  if (wall) consider(wall.since.getTime() + wall.ttlMs);
  const legacy = walled.get(LEGACY_ROLE_WIDE_BUCKET);
  if (legacy) consider(legacy.since.getTime() + legacy.ttlMs);
  for (const f of stepFailuresFor(role)) {
    if (!f) continue;
    if (f.resetAt) consider(f.resetAt.getTime());
    else consider(f.lastFailure.getTime() + stepTtlMs(f.count));
  }
  const rule = rules.get(role);
  if (rule) for (const s of rule.steps) if (s.resetAt) consider(s.resetAt.getTime());
  return earliest;
}

// ─── #274 bookkeeping seam (proxy-side) ────────────────────────────────────────
// When a role-step serves, the concrete model must ALSO record against the
// OWNING cascade — a delegated wall of sonnet's nominal arms sonnet's nominal
// bucket, not merely marks the delegating role's step. The owning coordinate
// comes from the resolution itself (resolveDelegationOwner above): the first
// version of #274 derived it by reverse lookup (findCascadeStepForTarget) and
// the review probe (29/09) measured it finding the DELEGATING step back — a
// role-step's `target` is refreshed in place to the concrete model, so the
// string search can never single out the true owner. That function is gone;
// resolution is the single source of truth.

// ─── resolution ────────────────────────────────────────────────────────────────

/**
 * The cascade step that should serve `role` right now, or null for the nominal model.
 * Walks the cascade, skipping TTL-failed steps; if every step is TTL-failed, returns
 * the LAST step anyway (PAYG is meant to always work). Single source of truth — used
 * by `getHandlerForRequest`'s swap AND the cascade loop.
 *
 * `bucket` (#275) is the provider bucket of THIS request's resolved nominal. With
 * it, the diversion test is `isFailoverActive(role, bucket)`: the request diverts
 * only when its OWN nominal's meter is walled (or the role is config-armed). Without
 * it (banner, tests), any wall or config-arm of the role diverts — the pre-#275
 * role-wide behavior.
 */
export function resolveFailoverTarget(
  role: FailoverRole,
  bucket?: string,
  /**
   * #431: step indexes THIS request has skipped (context overflow / busy) —
   * excluded from the walk so the cascade advances instead of re-paying a
   * step that just proved unable to take the request. Request-scoped by the
   * caller (handleWithCascade's per-request Set); every other caller passes
   * nothing and gets the pre-#431 walk.
   */
  skipSteps?: ReadonlySet<number>
): { step: FailoverStep | null; stepIndex: number } {
  const rule = rules.get(role);
  if (!rule || !isFailoverActive(role, bucket)) return { step: null, stepIndex: -1 };
  const resolved = resolveSkippingFailed(role, rule, skipSteps);
  if (resolved.stepIndex >= 0 && bucket !== undefined) {
    // Remember what (role, bucket) is serving while walled — the recovery notice
    // needs it, and the wall's TTL expiry cannot see the role (#275).
    servedUnderWall.set(roleBucketKey(role, bucket), {
      label: resolved.step!.label,
      direction: resolved.step!.direction,
      stepIndex: resolved.stepIndex,
    });
  }
  return resolved;
}

// ─── #91 point 4: per-session dwell ────────────────────────────────────────────
// Each provider switch re-cold the prompt cache at BOTH ends — on a large agentic
// context the dominant avoidable cost of the failover feature. The role-level
// dampers (points 1-3) bound how often SWITCHES HAPPEN; the dwell bounds how often
// one CONVERSATION rides them: a session keeps its resolved cascade step for at
// least CLAUDISH_FAILOVER_SESSION_DWELL_MS (default 10 min, 0 = off), so the
// disarm→nominal→re-arm oscillation moves traffic only between conversations,
// never under one.

/** Live dwell pins: role → session → the step it must keep serving until `until`.
 * Set only while armed at a step (stepIndex >= 0) — nominal is never pinned. */
const dwellPins = new Map<FailoverRole, Map<string, { stepIndex: number; until: number }>>();
/** Timestamp of the FIRST verified nominal success since the last arm (onNominalSuccess), keyed by
 * role|bucket like the other #275 state. A live dwell pin yields once this is
 * older than `recoveryGraceMs`, so an ACTIVE conversation returns to the
 * nominal when its own provider is proven healthy — without this exit the pin
 * only ever yields on step-death, and a long-lived conversation rides the
 * fallback until it ends. Measured 2026-10-01 (minimax wall, 19:23→20:08Z):
 * new sessions returned to the nominal within ~2 min of the lift, pinned cron
 * conversations were still ~70% on the Kimi fallback 20 min later. Bucket-keyed
 * (not role-keyed) so a sibling bucket's recovery cannot un-pin sessions whose
 * OWN nominal is still walled — role-keyed, every request of a still-walled
 * bucket would yield, re-resolve to the fallback step and re-pin, with two log
 * lines each, for as long as the mixed state held. Cleared by armFailover. */
const nominalRecoveredAt = new Map<string, number>();
/** #276: sessions that forfeited their dwell because their pinned step died of a
 * NON-QUOTA error, → when the forfeit lapses. While live, a resolution landing on
 * a cascade step returns it WITHOUT re-pinning. The forfeit must outlive the
 * intra-request resolutions that follow a STEP-ADVANCE (the loop resolves twice
 * per attempt — swap + loop read): without it the sibling resolution re-pins the
 * deeper step immediately and the pin then outlives the nominal's bucket wall,
 * which is the measured defect (2026-09-28: armed 11:05Z, pinned step 2 died
 * non-quota 12:31Z, the session rode the PAYG tail for hours while the nominal
 * sat healthy at 47% — no pinned session ever probed it, so no #294 recovery
 * stamp ever landed either; the wall had long expired). One dwell window long —
 * bounded: a real, long wall re-establishes ordinary dwell after it lapses, and
 * a resolution landing on the nominal clears it (the forfeit served its purpose). */
const dwellYieldTombstones = new Map<FailoverRole, Map<string, number>>();
/** Prune guard so the pin map cannot grow without bound across a long uptime. */
const DWELL_PINS_MAX = 512;
/** Same guard for the #276 forfeit map (review of #316). Exported for the
 * cap test so the constant cannot drift from its assertion. */
export const DWELL_TOMBSTONES_MAX = 512;

function pruneDwellPins(role: FailoverRole): void {
  const pins = dwellPins.get(role);
  if (!pins || pins.size <= DWELL_PINS_MAX) return;
  const now = Date.now();
  for (const [k, v] of pins) {
    if (v.until <= now) pins.delete(k);
  }
  if (pins.size > DWELL_PINS_MAX) {
    // Still over: drop the oldest pins (Map preserves insertion order).
    const excess = pins.size - DWELL_PINS_MAX;
    let i = 0;
    for (const k of pins.keys()) {
      if (i++ >= excess) break;
      pins.delete(k);
    }
  }
}

/** Test/config seam for the dwell window (#91 point 4). */
export function getSessionDwellMs(): number {
  return sessionDwellMs;
}

/** Test seam (#276): the live dwell pin of a session, or null — so tests can
 * assert pin state directly instead of inferring it from resolution outcomes. */
export function getSessionDwellPinForTests(
  role: FailoverRole,
  sessionKey: string
): { stepIndex: number; until: number } | null {
  const pin = dwellPins.get(role)?.get(sessionKey);
  if (!pin || pin.until <= Date.now()) return null;
  return { ...pin };
}

/** Test seam (#276, review of #316): entries currently held in the forfeit
 * map — proves the DWELL_TOMBSTONES_MAX lapsed-entry sweep. */
export function getDwellYieldTombstoneCountForTests(role: FailoverRole): number {
  return dwellYieldTombstones.get(role)?.size ?? 0;
}

/**
 * Session-aware cascade resolution — the routing seam `getHandlerForRequest` and
 * the cascade loop use when a session key is available. Same walk as
 * {@link resolveFailoverTarget}, plus the dwell:
 *
 *  - A live pin HOLDS while its step is still servable, even when the role-level
 *    state moved on (disarmed to probe the nominal, re-armed, escalated) — that
 *    oscillation is exactly what the dwell exists to keep off one conversation.
 *  - The pin YIELDS on genuine advancement: the pinned step itself TTL-failed
 *    (markStepFailed walked past it), or the pin expired. Yielding re-pins at
 *    the new step — EXCEPT when the step died of a NON-QUOTA error (#276): the
 *    dwell is then FORFEITED (yield without re-pin, see dwellYieldTombstones),
 *    so the session rejoins the general resolution each request instead of
 *    dwelling on the successor past a recovered nominal.
 *  - The pin also YIELDS on VERIFIED nominal recovery: a real request served by
 *    the nominal (onNominalSuccess) more than `recoveryGraceMs` ago. Without
 *    this exit an active conversation rides its fallback step until it ENDS —
 *    measured 2026-10-01, pinned cron sessions still on the fallback 20 min
 *    after the wall lifted while new sessions had long returned. The grace
 *    bounds the cost of an intermittent wall's isolated success to one switch
 *    per arm cycle, and any re-arm re-holds.
 *  - Nominal (stepIndex -1) is never pinned: pinning it would feed a session
 *    into an armed wall when its own refusal just caused the arm.
 */
export function resolveFailoverTargetForSession(
  role: FailoverRole,
  sessionKey: string | null,
  bucket?: string,
  /** #431: request-scoped skips — see resolveFailoverTarget. */
  skipSteps?: ReadonlySet<number>
): { step: FailoverStep | null; stepIndex: number } {
  const rule = rules.get(role);
  if (!rule) return { step: null, stepIndex: -1 };
  const dwell = sessionDwellMs;
  if (!sessionKey || dwell <= 0) return resolveFailoverTarget(role, bucket, skipSteps);

  const now = Date.now();
  const pins = dwellPins.get(role);
  const pin = pins?.get(sessionKey);
  // #276: set when a live pin's step died of a NON-QUOTA error — the dwell is
  // forfeited below instead of re-pinned at the walk's next step.
  let pinnedDiedNonQuota = false;
  let diedStepIndex = -1;

  if (pin && pin.until > now) {
    // #431: a pin on a step THIS request just skipped cannot hold — the step
    // is healthy but cannot take this session's request (an oversized
    // conversation stays oversized). Yield WITHOUT a #276 tombstone: the
    // forfeit exists for a step that DIED (no re-pin at the successor); here
    // re-pinning at the successor is exactly right — it is the step now
    // serving this session, and ordinary dwell should hold it there.
    if (skipSteps?.has(pin.stepIndex)) {
      pins?.delete(sessionKey);
      logStderr(
        `[Failover] DWELL ${role} session …${sessionKey.slice(-8)} yielded — step ${pin.stepIndex} skipped for this request (#431); re-resolving`
      );
    } else {
    const fails = stepFailures.get(role);
    const pinnedStep = rule.steps[pin.stepIndex];
    const pinnedFailure = fails?.[pin.stepIndex];
    let pinnedStillServable =
      // The step (not just its failure record) is passed: a config-declared
      // future resetAt closes the step outright (#261), so a pin holding on a
      // step the operator just closed yields instead of riding out its dwell.
      // #331: stepTtlBinds, not bare isStepTtlFailed — a pinned `role:` step
      // whose TTL was recorded against a concrete the delegation has LEFT is
      // still servable (it rides the target's current resolution); only a
      // freeze on the CURRENT concrete is a genuine advancement-past-the-pin.
      pin.stepIndex < rule.steps.length && !stepTtlBinds(role, pinnedFailure, pinnedStep);
    if (pinnedStillServable && pinnedStep?.roleRef) {
      if (resolveRoleStep(role, pinnedStep) === null) {
        // The delegation can no longer serve (its own resolution went nominal,
        // or its concrete target died) — re-resolve; never pin a placeholder.
        // Otherwise the pin HOLDS even if the delegating role's own earlier
        // steps became probeable: `resolveRoleStep` refreshes `step.target` in
        // place, so the session rides the target's cascade without a provider
        // switch inside its dwell (#91 point 4). A `wasNominal` yield here
        // moved sessions to an earlier probeable step mid-dwell — removed in
        // review (probe, 01/10): the flag survived delegated successes (the
        // reset clears the OWNER's coordinate), so one nominal wall unpinned
        // every session on that step for hours.
        pinnedStillServable = false;
      }
    }
    const recoveredAt = nominalRecoveredAt.get(roleBucketKey(role, bucket));
    if (pinnedStillServable && recoveredAt !== undefined && now - recoveredAt >= recoveryGraceMs) {
      // Verified nominal recovery past the grace — return this conversation to
      // the nominal (re-resolution lands there; nominal is never re-pinned).
      pins?.delete(sessionKey);
      logStderr(
        `[Failover] DWELL ${role} session …${sessionKey.slice(-8)} yielded — nominal recovered ${Math.round(
          (now - recoveredAt) / 1000
        )}s ago`
      );
    } else if (pinnedStillServable) {
      // Sliding dwell: an in-flight conversation (one that keeps resolving)
      // renews, so the hold lasts as long as the session is active. An idle
      // session's pin expires dwell after its last request.
      pin.until = Math.max(pin.until, now + dwell);
      return { step: rule.steps[pin.stepIndex], stepIndex: pin.stepIndex };
    }
    // Pinned step TTL-failed (genuine advancement) — fall through, re-pin below.
    // #276 carve-out: a NON-QUOTA death means the step is broken, not walled —
    // re-pinning the successor is what strands a session on the cascade tail
    // past a recovered nominal (the pin then holds through the wall's TTL expiry,
    // and with every active session pinned the nominal is never probed, so no
    // #294 recovery stamp ever lands). TTL-failed must be re-checked here, not
    // inferred from !pinnedStillServable: that flag is also cleared by a dead
    // delegation, which keeps its own re-resolve-and-re-pin semantics.
    pinnedDiedNonQuota =
      !pinnedStillServable &&
      pinnedFailure != null &&
      pinnedFailure.nonQuota === true &&
      isStepTtlFailed(pinnedFailure);
    diedStepIndex = pin.stepIndex;
    } // end of the non-skipped pin branch (#431 else)
  }

  const resolved = resolveFailoverTarget(role, bucket, skipSteps);
  if (pinnedDiedNonQuota) {
    // #276: yield WITHOUT re-pinning. The tombstone keeps the sibling resolution
    // of this same cascade attempt (the loop resolves twice per attempt) from
    // re-pinning the walk's step; the session re-decides from scratch on every
    // request until the forfeit lapses — nominal the moment the wall is gone.
    pins?.delete(sessionKey);
    const tombs = dwellYieldTombstones.get(role) ?? new Map();
    // Bounded like DWELL_PINS_MAX (review of #316): an entry otherwise leaves
    // only when its OWN session resolves again, so a conversation that ends
    // right after its forfeit leaves its entry for the process lifetime. Lapsed
    // entries are dropped on this write; live forfeits are never evicted (the
    // temporary over-cap is bounded by one dwell window, same as the pin map's
    // oldest-excess pass tolerates).
    if (tombs.size >= DWELL_TOMBSTONES_MAX) {
      for (const [k, until] of tombs) {
        if (until <= now) tombs.delete(k);
      }
    }
    tombs.set(sessionKey, now + dwell);
    dwellYieldTombstones.set(role, tombs);
    logStderr(
      `[Failover] DWELL ${role} session …${sessionKey.slice(-8)} yielded — step ${diedStepIndex} (${rule.steps[diedStepIndex]?.label}) died non-quota; dwell forfeited, re-resolving unpinned`
    );
    return resolved;
  }
  if (resolved.stepIndex >= 0) {
    const tombs = dwellYieldTombstones.get(role);
    const tomb = tombs?.get(sessionKey);
    if (tomb !== undefined) {
      if (tomb > now) return resolved; // #276 forfeit live — serve the walk, don't re-pin
      tombs?.delete(sessionKey); // lapsed — ordinary dwell resumes
    }
    const m = dwellPins.get(role) ?? new Map();
    // Pin (or re-pin at a new step) only on change: resolve runs twice per
    // cascade attempt (swap + loop read) and identical results must not churn
    // the map or the log.
    const prev = m.get(sessionKey);
    if (!prev || prev.stepIndex !== resolved.stepIndex) {
      m.set(sessionKey, { stepIndex: resolved.stepIndex, until: now + dwell });
      dwellPins.set(role, m);
      pruneDwellPins(role);
      logStderr(
        `[Failover] DWELL ${role} session …${sessionKey.slice(-8)} pinned to step ${resolved.stepIndex} (${resolved.step?.label}) for ${Math.round(dwell / 60000)}min — one provider switch per dwell`
      );
    } else {
      prev.until = Math.max(prev.until, now + dwell);
    }
  } else if (pins) {
    pins.delete(sessionKey); // back at nominal: no pin
    // The #276 forfeit served its purpose — the session is back at the nominal
    // (which is never pinned); let ordinary dwell apply on a future re-arm.
    dwellYieldTombstones.get(role)?.delete(sessionKey);
  }
  return resolved;
}

/** Resolution that does NOT call isFailoverActive (used inside isFailoverActive's
 * own expiry path, to avoid recursion and to read pre-deletion state). Assumes armed.
 * #274: a role-step that cannot serve (null delegation) is skipped like a failed
 * step; an all-delegation cascade with no servable delegate yields null (no
 * substitution) rather than routing to a placeholder. */
function resolveSkippingFailed(
  role: FailoverRole,
  rule: FailoverRule,
  /** #431: request-scoped skips — see resolveFailoverTarget. Never contains
   * the LAST index (the loop only skips a step that has a successor), so the
   * all-skipped fallback below still lands on a servable last step. */
  skipSteps?: ReadonlySet<number>
): { step: FailoverStep | null; stepIndex: number } {
  const fails = stepFailures.get(role);
  for (let i = 0; i < rule.steps.length; i++) {
    const step = rule.steps[i];
    // #431: a step this request already skipped stays skipped for its
    // remainder — no mark was written (the step is healthy), the exclusion is
    // the only memory the walk has of the skip.
    if (skipSteps?.has(i)) continue;
    // #331: stepTtlBinds, not bare isStepTtlFailed — a `role:` step frozen on a
    // concrete its delegation has LEFT is probeable again (the freeze was
    // measured holding a dead role for 24 h while the target served: hub
    // 2026-10-04, `haiku[1]` = `role:sonnet`, 408 walls). Within one request
    // the resolution cannot move, so intra-request advancement is unchanged.
    if (stepTtlBinds(role, fails?.[i], step)) continue;
    if (step.roleRef && resolveRoleStep(role, step) === null) continue;
    return { step, stepIndex: i };
  }
  // Every step is TTL-failed: serve the LAST step anyway — a PAYG target should
  // not wall, and its real error beats a synthetic one. Two exceptions, both
  // yielding nothing so the raw refusal surfaces instead of a placeholder route:
  // a last step that is a role delegation is not a guaranteed-servable PAYG, and
  // a last step the OPERATOR closed with a future config resetAt (#261) — "PAYG
  // always serves" is a liveness bet on the final step, and an explicit closure
  // speaks more precisely than our bet. Serving it anyway is exactly the inert
  // closure measured on the hub.
  const last = rule.steps.length - 1;
  const lastStep = rule.steps[last];
  if (lastStep.resetAt && Date.now() < lastStep.resetAt.getTime()) {
    return { step: null, stepIndex: -1 };
  }
  // #331: a role-step LAST step whose TTL still binds its current concrete
  // surfaces the refusal instead of re-paying it. Pre-#331 this fallback
  // re-served the delegation every request while its concrete sat walled, and
  // every refusal re-marked the SAME step — the measured 408-wall/24 h-TTL
  // shape on `haiku[1]` (hub 2026-10-04). A MODEL-step last step keeps the
  // "PAYG always serves" bet exactly as before: its TTL is about itself, and
  // serving it is how the operator sees the real error.
  if (lastStep.roleRef && stepTtlBinds(role, fails?.[last], lastStep)) {
    return { step: null, stepIndex: -1 };
  }
  if (lastStep.roleRef && resolveRoleStep(role, lastStep) === null) {
    return { step: null, stepIndex: -1 };
  }
  return { step: lastStep, stepIndex: last };
}

/** #299-B — the FIRST SERVABLE cascade step for the one-shot overload walk,
 * read-only (the `resolveSkippingFailed` half without its armed-resolution
 * side effects; the "resolveTransientStep" idea is #302's, credit po-2025).
 * Skips exactly what the armed resolver would skip — TTL-failed steps (the
 * per-step backoff) and role-steps whose delegation cannot currently resolve
 * a concrete target — plus one exclusion of the walk's own: a step whose
 * provider bucket is WALLED (a weekly OpenAI wall on step 0 must not turn
 * every nominal 529 into a round-trip at a step we already know is dead while
 * a healthy step waits behind it — review of #326, point 3; #348 makes the
 * bucket CANONICAL for bare targets via the injected async resolver, and adds
 * the nominal's own bucket to the skip — a 529 is that bucket's capacity
 * saying no, so a sibling model on the same bucket re-pays the overload).
 * Unlike `resolveSkippingFailed` there is NO last-step fallback: the walk is a
 * recovery attempt, not a substitution, so walking into a step we know is
 * unservable is pure cost — null means "surface the original overload".
 *
 * Read-only in FAILURE-state terms (no arm, no mark, no wall, no pin — review
 * of #326, point 4): the walk writes no failure state, though its caller does
 * mirror the loop's SUCCESS bookkeeping on a served attempt (`resetStepSuccess`,
 * owner-side `onNominalSuccess` for delegations), which is state a wall never
 * feeds. Two benign touches remain, both the module's shared idiom rather than
 * new writes: `isBucketWalled`'s lazy TTL expiry drops an already-expired wall
 * exactly as the next ordinary resolution would, and `resolveConcreteTarget`
 * refreshes a role-step's `target` in place to the model actually serving it
 * — which is also what keeps the walk from ever routing the ROLE NAME as a
 * model id (the pre-refresh `target` can still be `roleRef`). */
export async function resolveTransientStep(
  role: FailoverRole,
  opts?: {
    /**
     * #348: canonical bucket for a step target. BARE targets are the reason
     * this exists: `providerBucketOf("glm-5.3")` says `glm`, but a bare
     * nominal's wall is armed on its credential-filtered `route()` primary
     * (`glm-coding`) — the same canonicalization `classifyNominalBucket`
     * applies to the nominal (failover.ts:645's "the failover module must
     * not make a proxy-side route() call" stance still holds for the SYNC
     * armed walk; here the ASYNC call site injects the resolver, so the
     * module itself stays route-free). Absent (unit callers): bare targets
     * fall back to `providerBucketOf` — the pre-#348 behavior.
     */
    bucketOf?: (target: string) => Promise<string>;
    /**
     * #348 part 3: the overloaded NOMINAL's own bucket. A 529 is the bucket's
     * plan/provider saying "overloaded" — another model drawing on the SAME
     * bucket shares that capacity, so walking there re-pays the overload. A
     * different bucket is a different meter and a legitimate landing.
     */
    nominalBucket?: string;
  }
): Promise<{ step: FailoverStep; stepIndex: number; concrete: string } | null> {
  const rule = rules.get(role);
  if (!rule) return null;
  const fails = stepFailures.get(role);
  for (let i = 0; i < rule.steps.length; i++) {
    const step = rule.steps[i];
    // The step MUST ride along (#261 rebase, review of #326 point 2): without
    // it a HEALTHY step closed by a future config _RESET reads as servable
    // here (the closure plane lives in the step's resetAt, not in the
    // stepFailures record) and the walk pays a round-trip at a step the
    // armed resolver would never select. Compiles either way — the param is
    // optional — so no rebase conflict will ever surface this.
    //
    // #331 (review 06/10, point 1): stepTtlBinds, not bare isStepTtlFailed —
    // the walk is the third reader of a frozen role-step that used to skip it
    // however far the delegation had moved: on a nominal 529 the walk then
    // jumped to the NEXT step (or surfaced the 529) while the delegation's
    // current concrete was servable. Same rule as resolveSkippingFailed: a
    // role-step's TTL binds only while the delegation still resolves to the
    // recorded concrete. Composes with #348's concrete-step bucketer below
    // (pins W17-W19 + W20 in proxy-server-overload-walk-route.test.ts).
    if (stepTtlBinds(role, fails?.[i], step)) continue;
    const concrete = step.roleRef ? resolveConcreteTarget(role, step) : step.target;
    if (concrete === null) continue;
    const stepBucket = opts?.bucketOf ? await opts.bucketOf(concrete) : providerBucketOf(concrete);
    if (isBucketWalled(stepBucket)) continue;
    if (opts?.nominalBucket !== undefined && stepBucket === opts.nominalBucket) continue;
    return { step, stepIndex: i, concrete };
  }
  return null;
}

/**
 * How long an auto-armed substitution holds before the nominal model is retried. A
 * provider wall is a window (Z.AI 5h cap, Anthropic weekly, MiniMax quota) that lifts
 * on its own; staying on the substitute until an operator notices wastes the paid
 * plan. Ten minutes recovers promptly while probing at most ~6×/hour.
 */
/**
 * True when the wall on `bucket` still holds. Auto-walls EXPIRE after their TTL:
 * once expired the entry is dropped (the next request through the bucket serves its
 * nominal — the probe), and every (role|bucket) notified-session map is cleared so a
 * re-arm re-notifies. Config-arms never expire (they live in configArmedRoles, not
 * here). Recovery state is NOT seeded here — servedUnderWall holds it per
 * (role, bucket) and onNominalSuccess consumes it on a successful probe.
 *
 * NOTE: step-failure state is intentionally NOT cleared here — the per-step backoff
 * must outlive the wall cycle so a weekly-walled step isn't re-probed every
 * 10 minutes. It is cleared only on full nominal recovery (resetAllStepFailures).
 */
export function isBucketWalled(bucket: string): boolean {
  const entry = walled.get(bucket);
  if (!entry) return false;
  if (Date.now() - entry.since.getTime() < entry.ttlMs) return true;
  walled.delete(bucket);
  for (const key of notifiedSessions.keys()) {
    if (key.endsWith(`|${bucket}`)) notifiedSessions.delete(key);
  }
  // #91 point 3: this disarm escalates the NEXT wall's TTL if it is still up
  // (the re-arm reads this count). A nominal success clears it first.
  const esc = armTtlEscalation.get(bucket);
  armTtlEscalation.set(bucket, { disarms: (esc?.disarms || 0) + 1, lastDisarmAt: Date.now() });
  const nextTtlMs = armTtlFor(bucket);
  logStderr(
    `[Failover] DISARMED bucket ${bucket} → probing nominals (auto-arm TTL elapsed after ${Math.round(
      (Date.now() - entry.since.getTime()) / 60000
    )}min). Re-walls if the wall is still up${
      nextTtlMs > ARM_TTL_STEPS_MS[0] ? ` (next arm TTL grows to ${Math.round(nextTtlMs / 60000)}min)` : ""
    }.`
  );
  return false;
}

/**
 * True when requests for this role must be routed into the cascade. With `bucket`
 * (#275): the request diverts when its OWN nominal's bucket is walled, when the
 * legacy role-wide bucket is walled, or when the role is config-armed — never
 * because some OTHER bucket's nominal maxed. Without `bucket` (banner, health,
 * tests): any wall or config-arm of the role diverts.
 */
export function isFailoverActive(role: FailoverRole, bucket?: string): boolean {
  if (configArmedRoles.has(role)) return true;
  if (bucket !== undefined) return isBucketWalled(bucket) || isBucketWalled(LEGACY_ROLE_WIDE_BUCKET);
  if (isBucketWalled(LEGACY_ROLE_WIDE_BUCKET)) return true;
  for (const b of walled.keys()) {
    if (isBucketWalled(b)) return true;
  }
  return false;
}

/** Currently-armed (role, bucket) pairs with their resolved step, in stable order.
 * Roles config-armed resolve once (bucket "*"); each walled bucket is reported for
 * every role that has actually been serving under it (servedUnderWall) — a wall
 * diverts only the sessions whose nominal sits in it, and those are the pairs that
 * did. */
export function getActiveFailovers(): (ResolvedFailover & { bucket: string })[] {
  const out: (ResolvedFailover & { bucket: string })[] = [];
  for (const role of FAILOVER_ROLES) {
    if (configArmedRoles.has(role)) {
      const { step, stepIndex } = resolveFailoverTarget(role);
      if (step) out.push({ role, step, stepIndex, bucket: LEGACY_ROLE_WIDE_BUCKET });
      continue;
    }
    const seen = new Set<string>();
    for (const key of servedUnderWall.keys()) {
      if (!key.startsWith(`${role}|`)) continue;
      const bucket = key.slice(role.length + 1);
      if (seen.has(bucket) || !isBucketWalled(bucket)) continue;
      seen.add(bucket);
      const rule = rules.get(role);
      if (!rule) continue;
      const { step, stepIndex } = resolveSkippingFailed(role, rule);
      if (step) out.push({ role, step, stepIndex, bucket });
    }
  }
  return out;
}

/**
 * Wall `bucket` after an upstream refusal from a nominal that draws on it. No-op
 * unless CLAUDISH_FAILOVER_AUTO is on and the refusing ROLE has a cascade (the wall
 * is only useful if there is somewhere to divert to — but it walls the BUCKET, so
 * every other role with a nominal in it diverts too). Returns true only on the
 * transition. Re-walling clears stale recovery state for the (role|bucket) pairs of
 * that role — we are back in failover, a recovery notice would mislead.
 *
 * The default bucket is the legacy role-wide one, so `armFailover(role, reason)`
 * keeps its pre-#275 meaning (divert the whole role).
 */
export function armFailover(role: FailoverRole, reason: string, bucket: string = LEGACY_ROLE_WIDE_BUCKET): boolean {
  if (!autoArmEnabled) return false;
  // isBucketWalled (not walled.has) so an EXPIRED wall can re-arm.
  if (isBucketWalled(bucket)) return false;
  const rule = rules.get(role);
  if (!rule) return false;
  const ttlMs = armTtlFor(bucket);
  walled.set(bucket, { since: new Date(Date.now()), reason, ttlMs });
  for (const key of [...recovering.keys()]) {
    if (key.startsWith(`${role}|`)) recovering.delete(key);
  }
  // A fresh arm voids any recovery: dwell pins must hold again until the
  // nominal proves itself once more (the grace restarts with the next success).
  // A bucket arm voids that bucket's marker; a legacy role-wide arm voids every
  // bucket's (the role-wide wall walls them all).
  if (bucket === LEGACY_ROLE_WIDE_BUCKET) {
    for (const k of nominalRecoveredAt.keys()) {
      if (k.startsWith(`${role}|`)) nominalRecoveredAt.delete(k);
    }
  } else {
    nominalRecoveredAt.delete(roleBucketKey(role, bucket));
  }
  // Seeding the serving memory HERE (not at TTL expiry): the wall's expiry cannot
  // see the role, and a caller that arms without first resolving (tests, and the
  // arm-time log line below) still leaves a recovery breadcrumb. Resolutions
  // during the wall refresh it.
  const { step } = resolveFailoverTarget(role, bucket);
  logStderr(
    `[Failover] ARMED bucket ${bucket} (${role} nominal) → ${step ? step.label : "cascade"} — ${reason}${
      ttlMs > ARM_TTL_STEPS_MS[0] ? ` (ttl ${Math.round(ttlMs / 60000)}min, escalated)` : ""
    }`
  );
  return true;
}

/**
 * #91 burst/wall discriminator. A 429 that names a SHORT retry delay — the
 * `retry-after` header in seconds, or a body-named relative delay ("Resets in
 * 2 days 13 hr", "try again in 30 seconds") — is a burst: it must not exile the
 * role for AUTO_ARM_TTL_MS. A wall speaks in hours. Returns the delay in ms
 * when one is found AND it is below the ceiling (burst), else null (wall, or
 * no signal — the body predicate decides, exactly as before). Absolute body
 * resets ("reset at 08-25 22:28:00 UTC", GLM's "for 5 hour … will reset at …")
 * intentionally do NOT match: those are walls, and parseResetAtFromBody owns
 * them for the steps.
 */
export function burstRetryAfterMs(headerValue: string | null, body: string): number | null {
  const headerSecs = Number.parseFloat((headerValue || "").trim());
  if (Number.isFinite(headerSecs) && headerSecs >= 0) {
    return headerSecs * 1000 < armRetryAfterCeilingMs ? headerSecs * 1000 : null;
  }
  const m = /(?:reset|retry|try again)[^.\n]{0,40}?\bin (\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i.exec(body || "");
  if (m) {
    const unitMs: Record<string, number> = {
      second: 1000, sec: 1000,
      minute: 60_000, min: 60_000,
      hour: 3_600_000, hr: 3_600_000,
      day: 86_400_000,
    };
    const unit = m[2].toLowerCase().replace(/s$/, "");
    const ms = Number(m[1]) * (unitMs[unit] ?? 0);
    return ms > 0 && ms < armRetryAfterCeilingMs ? ms : null;
  }
  return null;
}

export type NominalRefusalVerdict =
  | { outcome: "armed" }
  | { outcome: "burst"; retryAfterMs: number }
  | { outcome: "grace"; count: number; needed: number };

/** Test/config seam for the proxy's wait-and-retry (#91 ARM_GRACE_MS). */
export function getArmGraceMs(): number {
  return armGraceMs;
}

/**
 * #91 gate for a qualifying refusal from the NOMINAL model — the single
 * decision point the cascade loop consults instead of calling armFailover
 * directly. Order matters:
 *  1. already armed (typically a concurrent request armed between this
 *     request's handler resolution and its 429) → "armed", the loop serves
 *     from the cascade rather than surfacing a raw 429;
 *  2. burst (short retry-after) → never counts, never arms;
 *  3. under CLAUDISH_FAILOVER_ARM_AFTER consecutive refusals → "grace",
 *     the caller surfaces the 429 (the client ladder retries; a nominal
 *     success clears the run via onNominalSuccess);
 *  4. threshold met → armFailover fires, "armed".
 */
export function onNominalRefusal(
  role: FailoverRole,
  reason: string,
  retryAfterHeader: string | null,
  errBody: string,
  bucket: string = LEGACY_ROLE_WIDE_BUCKET
): NominalRefusalVerdict {
  if (isFailoverActive(role, bucket)) return { outcome: "armed" };
  const burst = burstRetryAfterMs(retryAfterHeader, errBody);
  if (burst !== null) {
    logStderr(
      `[Failover] BURST ${role} (${bucket}) — retry-after ${Math.round(burst / 1000)}s names a short window; not arming (a wall speaks in hours)`
    );
    return { outcome: "burst", retryAfterMs: burst };
  }
  const rec = nominalRefusals.get(bucket);
  const count = (rec?.count || 0) + 1;
  if (count >= armAfterRefusals) {
    nominalRefusals.delete(bucket);
    if (armFailover(role, reason, bucket)) return { outcome: "armed" };
    // autoArmEnabled off or unconfigured rule: behave like the old call site —
    // not armed, not active, the caller surfaces the raw response.
    return { outcome: "grace", count, needed: armAfterRefusals };
  }
  nominalRefusals.set(bucket, { count, lastAt: Date.now() });
  logStderr(
    `[Failover] ARM-GRACE ${role} (${bucket}) — qualifying refusal ${count}/${armAfterRefusals} (CLAUDISH_FAILOVER_ARM_AFTER); not arming yet`
  );
  return { outcome: "grace", count, needed: armAfterRefusals };
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
    // switch; only a plan/quota exhaustion should. A body that names a WINDOW
    // ("per minute"/"per second"/"per hour") is a burst even when it speaks
    // quota vocabulary — Google's per-minute 429 says "Quota exceeded for quota
    // metric 'Generate requests per minute'" (#140). Deliberately NOT handled
    // here: Google's windowless "Resource has been exhausted (e.g. check
    // quota)." is structurally ambiguous (same wording for per-minute and
    // per-day) and must stay arming in the classifier — disambiguating it
    // would reproduce this bug in the other direction. Its burst side is
    // caught one layer up by burstRetryAfterMs: a sub-ceiling Retry-After
    // never arms (a wall speaks in hours).
    if (
      (lower.includes("quota") ||
        lower.includes("credit") ||
        lower.includes("balance") ||
        lower.includes("weekly") ||
        lower.includes("usage limit") ||
        lower.includes("plan limit") ||
        lower.includes("exhaust")) &&
      !lower.includes("per minute") &&
      !lower.includes("per second") &&
      !lower.includes("per hour")
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
      lower.includes("allocationquota") ||
      // Kimi Coding (kc@k3) spends a 5-HOUR ROLLING window and answers HTTP 403
      // when it is gone: "You've reached your 5-hour usage limit. Your quota will
      // reset when the current 5-hour window ends. To continue now, purchase extra
      // usage or upgrade your plan". Clients render that 403 as "Failed to
      // authenticate", which is why it was never recognized as a wall at all —
      // and it is ALSO caught by isWiringError's blanket `403 → wiring` rule, so
      // the cascade surfaced it to the client instead of advancing to the step
      // below. A 5-hour subscription window is a wall like any other: without
      // these two wordings the Kimi step never armed and the whole cascade
      // stalled on a spent window (production 2026-09-15, user-reported).
      // Quota is evaluated BEFORE wiring in handleWithCascade, so matching here
      // is what makes the advance happen inside the same request.
      lower.includes("usage limit") ||
      lower.includes("upgrade your plan")
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
  // Z.AI / GLM answers `"Usage limit reached for 5 hour. Your limit will reset at
  // 2026-08-12 18:58:34"` — a four-digit year and, decisively, **no timezone marker**,
  // so neither branch above matches (the one above requires `MM-DD` and a literal
  // ` UTC`). Until now GLM's own lift time was discarded and the step fell back to the
  // [10m, 30m, 1h, 4h, 24h] ladder against a wall that states when it opens.
  //
  // The timezone is the whole difficulty, and guessing it is not safe. `resetAt` makes
  // `isStepSkipped` skip the step until that instant, so a value read 8h too late
  // FORFEITS a working lane for 8h, while one read too early costs a single wasted
  // probe. The two errors are not symmetric, so the branch must not rely on being right.
  //
  // It therefore does not guess — it lets the message check itself. The same body states
  // the window ("for 5 hour"), and a reset can never be further off than the window is
  // long. Read as UTC: if the provider means UTC the value lands inside the window and is
  // used; under any other offset it lands outside, we decline it, and the caller keeps
  // exactly today's backoff. Safe under both readings without anyone knowing Z.AI's
  // server timezone.
  const absYmd = /reset at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/i.exec(text);
  if (absYmd) {
    const d = new Date(
      Date.UTC(
        Number(absYmd[1]),
        Number(absYmd[2]) - 1,
        Number(absYmd[3]),
        Number(absYmd[4]),
        Number(absYmd[5]),
        Number(absYmd[6])
      )
    );
    const ahead = d.getTime() - Date.now();
    const stated = /for (\d+)\s*hours?/i.exec(text);
    // No stated window: bound it generously rather than trusting the value outright.
    const maxAhead = stated ? Number(stated[1]) * 3600_000 : 7 * 24 * 3600_000;
    // The small negative tolerance absorbs clock skew and a wall that just lifted.
    if (ahead >= -5 * 60_000 && ahead <= maxAhead) return d;
    // Implausible under a UTC reading — fall through instead of trusting it.
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
 * Called by the cascade loop when the NOMINAL model answered successfully for `role`
 * drawing on `bucket`. Clears that bucket's refusal run and TTL escalation (healthy
 * nominal = fresh episode for the METER) and, if (role|bucket) was serving under a
 * wall whose TTL had just expired, seeds the recovery notice state.
 *
 * Step failures are reset only when NO wall remains anywhere: a sibling bucket's
 * persistent wall (native sonnet walled while z.ai serves nominal successes on
 * every request, measured 2026-09-28) keeps its sessions walking the cascade, and
 * clearing the steps' backoff under it would make every diverted request re-pay a
 * doomed probe on step 0 before advancing.
 */
export function onNominalSuccess(role: FailoverRole, bucket: string = LEGACY_ROLE_WIDE_BUCKET): void {
  // #91: a healthy nominal means a fresh episode for this bucket — the
  // consecutive-refusal run that was building toward a wall is void, and so is the
  // TTL escalation it was feeding (point 3: prompt recovery over damping).
  nominalRefusals.delete(bucket);
  armTtlEscalation.delete(bucket);
  // Verified recovery: a real request just served by the nominal. This is what
  // lets live dwell pins yield back to it (after recoveryGraceMs) — a TTL
  // expiry only starts a probe and must NOT un-pin anything. Stamp the FIRST
  // success of a recovery only (a busy nominal must not keep pushing it
  // forward: measuring since the LAST success, a nominal serving anyone every
  // <grace would hold every pin forever — coordinator probe P1, 01/10), and
  // never under a live wall (an in-flight request admitted before the arm
  // proves nothing about the meter — its stamp would age under the wall and
  // mass-un-pin at the TTL expiry, probe P3). `armFailover` voids the stamp,
  // so `!has` is exactly "first success since the last arm", and a
  // config-armed role never stamps (isFailoverActive is always true for it).
  const recKey = roleBucketKey(role, bucket);
  if (!nominalRecoveredAt.has(recKey) && !isFailoverActive(role, bucket)) {
    nominalRecoveredAt.set(recKey, Date.now());
  }
  const key = roleBucketKey(role, bucket);
  const pending = servedUnderWall.get(key);
  if (pending) {
    servedUnderWall.delete(key);
    recovering.set(key, {
      since: new Date(Date.now()),
      remaining: RECOVERY_CONDENSATIONS,
      prevLabel: pending.label,
      prevDirection: pending.direction,
      prevStepIndex: pending.stepIndex,
      notifiedSessions: new Set(),
    });
    logStderr(
      `[Failover] RECOVERED ${role} (${bucket}) → nominal (was ${pending.label}, the ${ordinal(
        pending.stepIndex
      )} fallback). Recovery notices for ${RECOVERY_CONDENSATIONS} condensations.`
    );
  }
  let wallsRemain = walled.size > 0;
  if (wallsRemain) {
    // Expire what has expired before counting it as remaining.
    let live = 0;
    for (const b of walled.keys()) {
      if (isBucketWalled(b)) live++;
    }
    wallsRemain = live > 0;
  }
  // Withholding the step-backoff reset while ANY bucket is walled is deliberate:
  // a long-lived sibling wall (a Kimi weekly, 7 days) holds it off, but the
  // steps still expire on their own ladder — this is only a loss of EARLY
  // reset, never a leak.
  if (!wallsRemain) resetAllStepFailures(role);
}

/** Recovery entries matching (role[, bucket]) — exact key when bucket is given,
 * any bucket of the role otherwise. Self-clears expired entries. */
function recoveringEntries(
  role?: FailoverRole | null,
  bucket?: string
): { key: string; role: FailoverRole; state: RecoveryState }[] {
  const out: { key: string; role: FailoverRole; state: RecoveryState }[] = [];
  for (const [key, st] of recovering) {
    if (Date.now() - st.since.getTime() > RECOVERY_MAX_MS) {
      recovering.delete(key);
      continue;
    }
    const sep = key.indexOf("|");
    const roleStr = key.slice(0, sep);
    const keyBucket = key.slice(sep + 1);
    if (role && roleStr !== role) continue;
    if (bucket !== undefined && keyBucket !== bucket) continue;
    out.push({ key, role: roleStr as FailoverRole, state: st });
  }
  return out;
}

/** True while recovery notices should fire for `role` (self-clears after TTL). */
export function isRecovering(role: FailoverRole): boolean {
  return recoveringEntries(role).length > 0;
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

/** The step that actually produced the ok response a request is being handed back (#431 CR B1). */
export interface ServedStepRecord {
  role: FailoverRole;
  step: FailoverStep;
  stepIndex: number;
}

/**
 * #431 CR B1: keyed on the Hono Context of the request (WeakMap — the entry dies
 * with the request, never needs a reset between tests). The loop records the step
 * whose response it returns; the notice builders prefer that record over their
 * general resolution, because `resolveFailoverTarget` cannot see request-local
 * skips or the session pin — with skip {0} armed, it kept announcing step 0's
 * name on turns step 1 had just served.
 */
const servedStepRecords = new WeakMap<object, ServedStepRecord>();

/** Loop-side record: the step whose response goes back to the client. No-op without one. */
export function recordServedStepForNotices(
  c: object,
  role: FailoverRole,
  step: FailoverStep | null | undefined,
  stepIndex: number
): void {
  if (!step || stepIndex < 0) return;
  servedStepRecords.set(c, { role, step, stepIndex });
}

/** Notice-side read: this request's served step, when it reports `role` (else undefined). */
export function servedStepForNotices(c: object, role?: FailoverRole | null): ServedStepRecord | undefined {
  const rec = servedStepRecords.get(c);
  if (!rec) return undefined;
  if (role && rec.role !== role) return undefined;
  return rec;
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
export function buildFailoverNotice(
  role?: FailoverRole | null,
  bucket?: string,
  served?: ServedStepRecord
): string | null {
  const active: (ResolvedFailover & { bucket: string })[] = [];
  if (role) {
    // One session, one (role, bucket): only ITS OWN bucket's diversion is "the
    // model actually serving you" — a sibling bucket's wall is someone else's
    // failover and must not be announced here (#275).
    //
    // #431 CR B1: `served` is the step the loop actually returned a response
    // from for THIS request. When present it wins over the general resolver,
    // which cannot see request-local skips: a turn served by the SUCCESSOR
    // after a skipped step otherwise announced the skipped step's name.
    const servedRec = served && served.role === role ? served : undefined;
    const { step, stepIndex } = servedRec ?? resolveFailoverTarget(role, bucket);
    if (step) active.push({ role, step, stepIndex, bucket: bucket ?? LEGACY_ROLE_WIDE_BUCKET });
  } else {
    active.push(...getActiveFailovers());
  }
  const rec = recoveringEntries(role, bucket);
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
    if (r.state.remaining <= 0) recovering.delete(r.key);
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
export function appendFailoverNoticeToMessage(
  message: any,
  role?: FailoverRole | null,
  bucket?: string,
  served?: ServedStepRecord
): void {
  try {
    const notice = buildFailoverNotice(role, bucket, served);
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
  // Name the steps still downstream — a serving step read alone looks like the
  // rest of the cascade (e.g. Kimi) was dropped from the config.
  const remaining = rules.get(role)!.steps.slice(stepIndex + 1);
  const remainder =
    remaining.length > 0 ? `Remaining fallbacks: ${remaining.map((s) => s.label).join(", ")}. ` : "";
  if (step.direction === "degraded") {
    return (
      prefix +
      remainder +
      `Capability note: ${step.label} is weaker than the nominal ${roleLabel} model; the inherited context may reflect the nominal's stronger output.`
    );
  }
  if (step.direction === "improved") {
    return (
      prefix +
      remainder +
      `Capability note: ${step.label} is stronger than the nominal ${roleLabel} model.`
    );
  }
  return prefix + remainder + `Capability is roughly equivalent; continue the work as normal.`;
}

/** One-time stream notice for a RECOVERING role: the nominal is back. */
function buildStreamRecoveryText(role: FailoverRole, st: RecoveryState): string {
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  if (st.prevDirection === "improved") {
    return `[claudish] You are back on the nominal ${roleLabel} model after serving as ${st.prevLabel} (the ${ordinal(
      st.prevStepIndex
    )} fallback), which was stronger than nominal.`;
  }
  return `[claudish] You are back on the nominal ${roleLabel} model after serving as ${st.prevLabel} (the ${ordinal(
    st.prevStepIndex
  )} fallback). The context above may include work done under that substitute.`;
}

/**
 * Return the one-time stream notice for this role+session, marking the session
 * notified at the current depth. Returns null when there is nothing to announce.
 * Recovery takes precedence (a recovering role is not armed). For an armed role, the
 * notice fires ONCE PER DISTINCT STEP per session (Qwen→GLM mid-session still
 * announces the new substitute), so the agent recalibrates to a change without a
 * re-probe that drops back to an already-announced step re-spamming the notice.
 * Tracking the SET of announced depths (not the last one) is what bounds the notices:
 * a step whose failure state is cleared (resetStepSuccess / resetAllStepFailures —
 * neither clears this map) resolves again, and under the old last-depth comparison
 * that return fired a fresh notice every time the resolver oscillated. Atomic
 * (check + mark in one call) so two concurrent in-flight requests can't both win.
 */
export function consumeStreamNotice(
  role: FailoverRole,
  sessionKey: string | null,
  bucket?: string,
  served?: ServedStepRecord
): string | null {
  if (!sessionKey) return null;

  const rec = recoveringEntries(role, bucket)[0]?.state;
  if (rec) {
    if (rec.notifiedSessions.has(sessionKey)) return null;
    rec.notifiedSessions.add(sessionKey);
    return buildStreamRecoveryText(role, rec);
  }

  if (!isFailoverActive(role, bucket)) return null;
  // #431 CR B1: prefer what actually served this request — same rationale as
  // buildFailoverNotice. The announced-depth dedup below then keys on the
  // SERVED depth, so a skip-induced depth change still announces once.
  const servedRec = served && served.role === role ? served : undefined;
  const { step, stepIndex } = servedRec ?? resolveFailoverTarget(role, bucket);
  if (!step) return null;
  const key = roleBucketKey(role, bucket);
  let perPair = notifiedSessions.get(key);
  if (!perPair) {
    perPair = new Map();
    notifiedSessions.set(key, perPair);
  }
  let announced = perPair.get(sessionKey);
  if (!announced) {
    announced = new Set();
    perPair.set(sessionKey, announced);
  }
  if (announced.has(stepIndex)) return null; // already announced this depth in this session
  announced.add(stepIndex);
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
    walled.clear();
    configArmedRoles.clear();
    stepFailures.clear();
    recovering.clear();
    servedUnderWall.clear();
    notifiedSessions.clear();
    nominalRefusals.clear();
    armTtlEscalation.clear();
    dwellPins.clear();
    dwellYieldTombstones.clear();
    roleNominalResolver = null;
    roleNominalBucketResolver = null;
    armAfterRefusals = 2;
    armGraceMs = 0;
    armRetryAfterCeilingMs = 120_000;
    sessionDwellMs = 600_000;
  }
}
