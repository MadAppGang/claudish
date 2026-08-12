/**
 * Failover — role-level model substitution with an explicit degradation notice.
 *
 * This is NOT the same thing as `FallbackHandler` (handlers/fallback-handler.ts).
 * That one swaps *providers* for the *same* model when a provider is unhealthy.
 * This one swaps the *model itself* for a whole role (opus/sonnet/haiku) when the
 * nominal model's budget is exhausted — a subscription-level concern, not a
 * transport-level one.
 *
 * Why it exists: the cluster runs on metered weekly plans (Anthropic, MiniMax,
 * Z.AI). When a plan burns faster than its reset window, the choice is either to
 * stop working or to serve the role from a different pool. Serving it silently is
 * the dangerous option — the agent keeps assuming capabilities it no longer has
 * (or, in the MiniMax→DeepSeek direction, fails to use capabilities it just
 * gained). So every substitution is announced at the next condensation boundary.
 *
 * Why condensation is the announcement point: it is the only moment in an agentic
 * session where the context is rebuilt from scratch anyway, so a few extra lines
 * cost nothing and are guaranteed to survive into the continuing context. It is
 * also the only free re-routing boundary (the prompt cache is already cold there).
 *
 * Configuration is env-driven, because that is how the fleet is configured
 * (docker-compose + per-machine .env), and because it must be changeable without
 * a rebuild during a budget crunch:
 *
 *   CLAUDISH_FAILOVER_OPUS=qwen-token-plan@qwen3.8-max
 *   CLAUDISH_FAILOVER_OPUS_LABEL="Qwen 3.8 Max"
 *   CLAUDISH_FAILOVER_OPUS_DIRECTION=degraded        # degraded | improved | lateral
 *   CLAUDISH_FAILOVER_OPUS_NOTE="Extended thinking is off on this target."
 *   CLAUDISH_FAILOVER_ACTIVE=opus,haiku              # armed now, no error needed
 *   CLAUDISH_FAILOVER_AUTO=1                         # also arm on upstream quota errors
 *
 * With no env set, every function here is inert: no routing change, no notice.
 */

import { logStderr } from "../logger.js";

export type FailoverRole = "opus" | "sonnet" | "haiku";

export const FAILOVER_ROLES: readonly FailoverRole[] = ["opus", "sonnet", "haiku"] as const;

/** Which way the substitution moves capability, from the agent's point of view. */
export type FailoverDirection = "degraded" | "improved" | "lateral";

export interface FailoverRule {
  role: FailoverRole;
  /** Routing target, in any form `getHandlerForRequest` accepts. */
  target: string;
  /** Human label for the notice; defaults to the target string. */
  label: string;
  direction: FailoverDirection;
  /** Optional extra guidance appended to the notice line. */
  note?: string;
}

export interface ArmedFailover {
  rule: FailoverRule;
  since: Date;
  /** "config" when armed by CLAUDISH_FAILOVER_ACTIVE, else the upstream error. */
  reason: string;
}

/** Parsed once at module load; re-read only by resetFailoverForTests(). */
let rules = new Map<FailoverRole, FailoverRule>();
let autoArmEnabled = false;
const armed = new Map<FailoverRole, ArmedFailover>();

function parseDirection(raw: string | undefined): FailoverDirection {
  const v = (raw || "").trim().toLowerCase();
  if (v === "improved" || v === "degraded" || v === "lateral") return v;
  // Unknown or unset: "degraded" is the safe default. Announcing a downgrade that
  // turned out to be an upgrade is harmless; the reverse makes the agent
  // over-trust a weaker model.
  return "degraded";
}

function loadRules(env: NodeJS.ProcessEnv): Map<FailoverRole, FailoverRule> {
  const out = new Map<FailoverRole, FailoverRule>();
  for (const role of FAILOVER_ROLES) {
    const key = `CLAUDISH_FAILOVER_${role.toUpperCase()}`;
    const target = (env[key] || "").trim();
    if (!target) continue;
    out.set(role, {
      role,
      target,
      label: (env[`${key}_LABEL`] || "").trim() || target,
      direction: parseDirection(env[`${key}_DIRECTION`]),
      note: (env[`${key}_NOTE`] || "").trim() || undefined,
    });
  }
  return out;
}

/**
 * (Re)read configuration from the environment and arm whatever
 * CLAUDISH_FAILOVER_ACTIVE names. Called once at proxy startup so the log line
 * lands next to the other startup banners; safe to call again in tests.
 */
export function initFailover(env: NodeJS.ProcessEnv = process.env): void {
  rules = loadRules(env);
  autoArmEnabled = /^(1|true|yes|on)$/i.test((env.CLAUDISH_FAILOVER_AUTO || "").trim());
  armed.clear();

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
        // Armed but unconfigured is a config error the operator must see: it
        // silently means "no failover" exactly when one was intended.
        logStderr(
          `[Failover] '${role}' is listed in CLAUDISH_FAILOVER_ACTIVE but CLAUDISH_FAILOVER_${role.toUpperCase()} is not set — no substitution will happen for this role.`
        );
        continue;
      }
      // Date.now() (not new Date()) so `since` and the TTL comparison in
      // isFailoverActive read the same clock — otherwise a test that fakes
      // Date.now cannot exercise the expiry at all.
      armed.set(role, { rule, since: new Date(Date.now()), reason: "config" });
    }
  }

  if (armed.size > 0 || rules.size > 0) {
    const armedList =
      armed.size > 0
        ? [...armed.values()].map((a) => `${a.rule.role}→${a.rule.label}`).join(", ")
        : "none";
    logStderr(
      `[Failover] configured=${rules.size} armed=[${armedList}] auto=${autoArmEnabled ? "on" : "off"}`
    );
  }
}

/**
 * Which role a client-requested model name belongs to.
 *
 * Substring matching on the name the CLIENT sent, deliberately: Claude Code
 * always speaks in roles ("claude-opus-5", "claude-3-5-haiku-…") even when the
 * proxy serves something else entirely. Kept as the single definition so the
 * routing hook and the auto-arm path can never drift apart.
 */
export function roleFromModelName(model: string | undefined): FailoverRole | null {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return null;
}

/** The configured substitution for a role, armed or not. */
export function getFailoverRule(role: FailoverRole): FailoverRule | undefined {
  return rules.get(role);
}

/**
 * How long an auto-armed substitution holds before the nominal model is retried.
 *
 * A provider wall is a *window*, not a state change: Z.AI's 5h cap, Anthropic's
 * weekly reset, MiniMax's quota all lift on their own. Staying on the substitute
 * until an operator notices wastes the plan the fleet actually pays for, so the
 * arming has to be self-clearing.
 *
 * Ten minutes is chosen against the cost of being wrong in each direction: too
 * short and a still-capped provider is probed constantly (one wasted round-trip
 * per expiry, per in-flight request); too long and a recovered plan sits unused.
 * A provider window is measured in hours, so ten minutes recovers promptly while
 * probing at most ~6 times an hour.
 */
const AUTO_ARM_TTL_MS = 10 * 60 * 1000;

/**
 * True when requests for this role must be routed to the failover target.
 *
 * Auto-armed substitutions EXPIRE (see AUTO_ARM_TTL_MS): once the TTL passes the
 * entry is dropped, so the next request goes to the nominal model. If the wall is
 * still up, that request takes a quota refusal and the reactive path in
 * proxy-server re-arms and retries through the substitute — transparently, so the
 * client never sees the probe. If the wall has lifted, the request simply
 * succeeds and the fleet is back on its nominal plan with no operator action.
 *
 * Config-armed substitutions (CLAUDISH_FAILOVER_ACTIVE) never expire: those are a
 * deliberate decision to conserve a plan, not a reaction to a refusal, and only
 * an operator should reverse them.
 */
export function isFailoverActive(role: FailoverRole): boolean {
  const entry = armed.get(role);
  if (!entry) return false;
  if (entry.reason === "config") return true; // operator-held: never self-clears
  if (Date.now() - entry.since.getTime() < AUTO_ARM_TTL_MS) return true;
  armed.delete(role);
  logStderr(
    `[Failover] DISARMED ${role} → retrying nominal model (auto-arm TTL elapsed after ${Math.round(
      (Date.now() - entry.since.getTime()) / 60000
    )}min). Re-arms automatically if the wall is still up.`
  );
  return false;
}

/** Currently-armed substitutions, in a stable role order. */
export function getActiveFailovers(): ArmedFailover[] {
  return FAILOVER_ROLES.map((r) => armed.get(r)).filter((a): a is ArmedFailover => !!a);
}

/**
 * Arm a role after an upstream refusal. No-op unless CLAUDISH_FAILOVER_AUTO is on
 * and a target is configured. Returns true only on the transition, so callers can
 * log once instead of on every subsequent request.
 */
export function armFailover(role: FailoverRole, reason: string): boolean {
  if (!autoArmEnabled) return false;
  // isFailoverActive (not armed.has) so an EXPIRED auto-arm can re-arm: after the
  // TTL the probe request goes nominal, and when the wall is still up this is the
  // call that puts the role back on the substitute. armed.has would see the stale
  // entry and refuse — leaving the role on a dead provider until a restart.
  if (isFailoverActive(role)) return false;
  const rule = rules.get(role);
  if (!rule) return false;
  armed.set(role, { rule, since: new Date(Date.now()), reason });
  logStderr(`[Failover] ARMED ${role} → ${rule.label} (${rule.target}) — ${reason}`);
  return true;
}

/**
 * Does this upstream failure mean "the budget for this role is gone"?
 *
 * Deliberately narrower than FallbackHandler.isRetryableError: a 404 or a 401 is
 * a wiring mistake, and swapping the model would hide it. Only quota/credit
 * exhaustion — the thing a different pool actually fixes — arms a failover.
 */
export function isQuotaExhaustion(status: number, body: string): boolean {
  if (status === 402) return true; // payment required
  const lower = (body || "").toLowerCase();
  if (status === 429) {
    // A plain per-minute rate limit is transient and must NOT burn the weekly
    // budget switch; only a plan/quota exhaustion should.
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

const DIRECTION_TEXT: Record<FailoverDirection, string> = {
  degraded: "slightly weaker than the nominal model",
  improved: "stronger than the nominal model",
  lateral: "roughly equivalent to the nominal model",
};

/**
 * The block appended to a condensation result. Returns null when nothing is
 * armed, so the common case adds zero bytes.
 *
 * Written for the agent that will read it as context, not for a human log: it
 * states what changed, which direction capability moved, and what to do about it.
 */
export function buildFailoverNotice(): string | null {
  const active = getActiveFailovers();
  if (active.length === 0) return null;

  const lines = active.map((a) => {
    const { role, label, target, direction, note } = a.rule;
    const bits = [
      `- \`${role}\` is being served by **${label}** (\`${target}\`) — ${DIRECTION_TEXT[direction]}.`,
    ];
    if (note) bits.push(`  ${note}`);
    return bits.join("\n");
  });

  return [
    "",
    "---",
    "",
    "**[claudish] Failover model active.** This condensation, and the requests that follow it, are not being served by the nominal model:",
    "",
    ...lines,
    "",
    "This is a budget substitution, not an error — the nominal plan is exhausted or being conserved. Keep working; adjust your expectations to the model actually serving you.",
  ].join("\n");
}

/**
 * Append the failover notice to a collected Anthropic message, in place.
 *
 * Called on the non-streaming path only — i.e. `/compact` and any other
 * `stream: false` caller. Appends to the trailing text block when there is one
 * (a condensation result is a single summary; a second block risks clients that
 * only read `content[0]`), otherwise pushes one.
 *
 * Never throws: a malformed message must not turn a working condensation into a
 * failed one. A missing notice is a cosmetic loss; a thrown error here would
 * break the only operation that lets a full session continue.
 */
export function appendFailoverNoticeToMessage(message: any): void {
  try {
    const notice = buildFailoverNotice();
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

/** Test seam: drop all state so a test can install its own environment. */
export function resetFailoverForTests(env?: NodeJS.ProcessEnv): void {
  if (env) {
    initFailover(env);
  } else {
    rules = new Map();
    autoArmEnabled = false;
    armed.clear();
  }
}
