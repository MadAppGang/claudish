/**
 * Behaviour telemetry — per-session aggregation.
 *
 * The server contract accepts ONE aggregate per Claude Code session, not one
 * record per decision (`docs/specs/behavior-telemetry-backend.md`). So decisions
 * are counted in memory for the life of the process and emitted once.
 *
 * ## Why this spools to disk instead of uploading directly
 *
 * A session ends when claudish exits, and `process.on("exit")` handlers are
 * SYNCHRONOUS — a `fetch` started there never completes. Blocking shutdown on a
 * network round-trip is not an option either: claudish exits when Claude Code
 * does, and the user is waiting on their prompt.
 *
 * So exit does the one thing it can do reliably — an `appendFileSync` to an
 * outbox — and delivery happens on a later run, in the background, while a
 * process is alive to await it. This is the same trade `stats-buffer.ts` makes
 * for the same reason, and it means a hard kill loses nothing.
 *
 * ## Consent
 *
 * Everything here is a no-op unless `hooks.telemetry.enabled` is true. That
 * flag is deliberately separate from `stats.enabled`: that consent was granted
 * for usage statistics, and reusing it for behavioural records would be consent
 * laundering.
 *
 * ## Privacy of user hooks
 *
 * This module stores what it is given. The hook engine's `journal()` fan-out is
 * the only caller in the hook system, and it passes a user hook's id as `"user"`
 * and withholds an `mcp__` tool name on such a row BEFORE calling
 * `recordTelemetryDecision` (hooks/engine.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../../logger.js";
import { VERSION } from "../../version.js";
import type { PathRelation, UploadDecision, UploadSurface } from "../journal.js";

/** Pinned by the deployed server contract. Bump only with the backend. */
export const TELEMETRY_SCHEMA_VERSION = 1;

/**
 * Coarse absolute-token buckets — a CLOSED set fixed by the server contract.
 *
 * SCOPE, since this no longer means what it originally did: this answers "how
 * big was the session", NOT "how much context pressure was there". Use
 * `context_fill_pct` for pressure.
 *
 * It was designed for pressure and is wrong for it, in two ways. Absolute tokens
 * are not comparable across models — 178K is 89% of a 200K window but 18% of a
 * 1M one, and both land in `150-200k`. And `200k+` is unbounded, so it has zero
 * resolution across 200K-1M, which is exactly where 1M-context models live.
 *
 * Kept anyway because session size is a real, separate question, and because
 * removing or re-cutting the boundaries would split stored data at the change,
 * while adding `context_fill_pct` alongside cannot. Any change to these values
 * is a SPEC CHANGE — the backend validates against this list.
 */
export type ContextBucket = "0-50k" | "50-100k" | "100-150k" | "150-200k" | "200k+";

export function contextBucket(inputTokens: number): ContextBucket {
  if (inputTokens < 50_000) return "0-50k";
  if (inputTokens < 100_000) return "50-100k";
  if (inputTokens < 150_000) return "100-150k";
  if (inputTokens < 200_000) return "150-200k";
  return "200k+";
}

/**
 * The context window this session actually runs against.
 *
 * Recorded by claude-runner, which is the ONLY place that knows it. The handler
 * knows the model's SPEC window; the enforced window is
 * `min(spec, CLAUDE_CODE_MAX_CONTEXT_TOKENS, CLAUDE_CODE_AUTO_COMPACT_WINDOW)`,
 * and those vars are set on the CHILD's env, not the proxy's. They diverge
 * routinely — the Codex OAuth backend caps gpt-5.6-sol at ~372K against a 1.05M
 * API spec — which is why the status line renders both numbers when they
 * disagree. Dividing by the spec window would understate pressure by ~3x on
 * exactly the models where the question matters.
 */
let enforcedContextWindow = 0;

/**
 * Record the window the session runs against. Called once, at spawn.
 * Zero or absent leaves `context_fill_pct` off the payload entirely — an absent
 * field is honest, a percentage computed against a guessed denominator is not.
 */
export function setSessionContextWindow(tokens: number): void {
  enforcedContextWindow = tokens > 0 ? tokens : 0;
}

/**
 * Peak context fill, as an integer percent of the enforced window.
 *
 * This is the quantity the pressure hypothesis is actually about, and absolute
 * tokens are not: 178K is 89% of a 200K window (near compaction) but 18% of a
 * 1M one (barely started). The two are indistinguishable in `context_bucket`,
 * which makes that field unusable for the cross-model comparison queries 2 and 3
 * need.
 *
 * An integer percent is already a 101-value quantisation, so it needs no further
 * bucketing: it is bounded 0-100, carries no absolute scale (nothing about
 * project size leaks), and sessions are unlinkable by construction anyway — the
 * salt below is per-process and never persisted, so the cross-session
 * fingerprint that coarse bucketing defended against cannot be assembled.
 */
export function contextFillPct(
  peakTokens: number,
  window = enforcedContextWindow
): number | undefined {
  if (!(window > 0) || !(peakTokens > 0)) return undefined;
  return Math.min(100, Math.max(0, Math.round((peakTokens / window) * 100)));
}

/**
 * Per-PROCESS random salt. Never persisted.
 *
 * The server requires a 64-char lowercase hex hash and rejects a raw Claude Code
 * session UUID, so that this dataset cannot be joined against any other system
 * that sees the same id. An ephemeral salt is strictly stronger than a stored
 * one: there is no key on disk to steal, and no way for anyone — including us —
 * to reverse a delivered id back to a session once the process is gone.
 */
const SESSION_SALT = randomBytes(32).toString("hex");

/**
 * Hash a Claude Code session id for delivery.
 *
 * The model is folded into the hash so a session that routes to several models
 * (claudish maps sonnet/opus/haiku roles independently) produces one aggregate
 * PER MODEL rather than colliding on a single id the server would treat as a
 * duplicate. That also makes the unit match the question being asked: "rules
 * firing per model, per session".
 */
function hashSessionId(rawSessionId: string, model: string): string {
  return createHash("sha256").update(`${SESSION_SALT}:${rawSessionId}:${model}`).digest("hex");
}

/** One row of the `decisions[]` array, accumulated. */
interface DecisionAggregate {
  rule_id?: string;
  surface: UploadSurface;
  tool_name?: string;
  counts: Partial<Record<UploadDecision, number>>;
  path_relations: Partial<Record<PathRelation, number>>;
}

/** The wire shape, exactly as the server accepts it. */
export interface SessionReport {
  schema_version: number;
  session_id: string;
  started_at: string;
  ended_at: string;
  claudish_version: string;
  platform: string;
  model_id: string;
  provider_name: string;
  context_bucket: ContextBucket;
  /**
   * Peak fill of the enforced window, 0-100. Omitted when the window is unknown.
   *
   * Additive alongside `context_bucket` rather than replacing it: the two answer
   * different questions ("how much pressure" vs "how big was the session"), and
   * adding a field cannot invalidate rows already stored, whereas redefining
   * `context_bucket`'s boundaries would split the data at the change.
   */
  context_fill_pct?: number;
  turns: number;
  decisions: Array<{
    rule_id?: string;
    surface: UploadSurface;
    tool_name?: string;
    counts: Partial<Record<UploadDecision, number>>;
    path_relations: Partial<Record<PathRelation, number>>;
  }>;
}

interface SessionState {
  sessionId: string;
  model: string;
  provider: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  /** Peak observed context, bucketed only at emit time. */
  maxInputTokens: number;
  decisions: Map<string, DecisionAggregate>;
}

/**
 * Bounds. A long-lived proxy must not accumulate without limit, and a runaway
 * rule must not produce a payload the server will reject on size.
 */
const MAX_TRACKED_SESSIONS = 32;
const MAX_DECISION_KEYS = 200;

const sessions = new Map<string, SessionState>();

/**
 * Consent. PUSHED in by BehaviorEngine rather than read from config here.
 *
 * The engine already holds the parsed, validated `hooks` block, so re-reading
 * config from the request path would be both wasteful and a second place for the
 * flag to be interpreted. Default false: nothing is collected until an opt-in is
 * observed, so a code path that forgets to set it fails closed.
 */
let consent = false;

export function setTelemetryConsent(value: boolean): void {
  consent = value;
}

function enabled(): boolean {
  return consent;
}

/** Test seam — drops both the consent flag and everything accumulated. */
export function resetTelemetryState(): void {
  consent = false;
  sessions.clear();
}

function stateFor(rawSessionId: string, model: string, provider: string): SessionState | undefined {
  const key = `${rawSessionId}|${model}`;
  let state = sessions.get(key);
  if (!state) {
    // Evict oldest — Map preserves insertion order. Dropping rather than
    // spooling is deliberate: this bound is only reached by a process serving
    // dozens of concurrent sessions, where the oldest is least likely to still
    // be receiving turns.
    while (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    const now = new Date().toISOString();
    state = {
      sessionId: hashSessionId(rawSessionId, model),
      model,
      provider,
      startedAt: now,
      endedAt: now,
      turns: 0,
      maxInputTokens: 0,
      decisions: new Map(),
    };
    sessions.set(key, state);
  }
  return state;
}

/** Record a completed turn. Supplies the denominator every rate query needs. */
export function recordTelemetryTurn(p: {
  sessionId?: string;
  model: string;
  provider: string;
  inputTokens?: number;
}): void {
  if (!enabled() || !p.sessionId) return;
  const state = stateFor(p.sessionId, p.model, p.provider);
  if (!state) return;
  state.turns++;
  state.endedAt = new Date().toISOString();
  if (typeof p.inputTokens === "number" && p.inputTokens > state.maxInputTokens) {
    state.maxInputTokens = p.inputTokens;
  }
}

/**
 * Record one supervisor decision.
 *
 * Called alongside the local journal write, from the same site, so the two can
 * never disagree about what happened.
 */
export function recordTelemetryDecision(p: {
  sessionId?: string;
  model: string;
  provider: string;
  surface: UploadSurface;
  decision: UploadDecision;
  ruleId?: string;
  toolName?: string;
  pathRelation?: PathRelation;
}): void {
  if (!enabled() || !p.sessionId) return;
  const state = stateFor(p.sessionId, p.model, p.provider);
  if (!state) return;

  const key = `${p.ruleId ?? ""}|${p.surface}|${p.toolName ?? ""}`;
  let agg = state.decisions.get(key);
  if (!agg) {
    if (state.decisions.size >= MAX_DECISION_KEYS) return;
    agg = {
      rule_id: p.ruleId,
      surface: p.surface,
      tool_name: p.toolName,
      counts: {},
      path_relations: {},
    };
    state.decisions.set(key, agg);
  }
  agg.counts[p.decision] = (agg.counts[p.decision] ?? 0) + 1;
  if (p.pathRelation) {
    agg.path_relations[p.pathRelation] = (agg.path_relations[p.pathRelation] ?? 0) + 1;
  }
  state.endedAt = new Date().toISOString();
}

function toReport(state: SessionState): SessionReport {
  return {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    session_id: state.sessionId,
    started_at: state.startedAt,
    ended_at: state.endedAt,
    claudish_version: VERSION,
    platform: process.platform,
    model_id: state.model,
    provider_name: state.provider,
    context_bucket: contextBucket(state.maxInputTokens),
    ...(contextFillPct(state.maxInputTokens) !== undefined && {
      context_fill_pct: contextFillPct(state.maxInputTokens),
    }),
    turns: state.turns,
    decisions: [...state.decisions.values()],
  };
}

/** Everything pending, as it would be sent. Exposed for the CLI preview. */
export function pendingReports(): SessionReport[] {
  return [...sessions.values()].map(toReport);
}

export function outboxPath(): string {
  return join(homedir(), ".claudish", "behavior-outbox.jsonl");
}

/**
 * Write every pending aggregate to the outbox. SYNCHRONOUS by requirement —
 * this is called from `process.on("exit")`, where nothing else can run.
 *
 * Never throws: a telemetry failure must not change how claudish exits.
 */
export function spoolPendingSync(path = outboxPath()): number {
  if (sessions.size === 0) return 0;
  const reports = pendingReports().filter((r) => r.turns > 0 || r.decisions.length > 0);
  sessions.clear();
  if (reports.length === 0) return 0;

  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${reports.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return reports.length;
  } catch (err) {
    log(`[behavior:telemetry] could not spool: ${err}`);
    return 0;
  }
}

/**
 * Spool on exit. Registered unconditionally — the handler itself checks consent
 * via the (empty) session map, so a user who never opted in pays one no-op call.
 */
process.on("exit", () => {
  try {
    spoolPendingSync();
  } catch {
    // Process is exiting; there is nowhere left to report this.
  }
});
