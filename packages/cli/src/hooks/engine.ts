/**
 * The hook engine: runs one dispatch's hooks as a hook chain and turns what
 * they return into attributed, severity-gated, validated, applied actions.
 *
 * Execution (§4.4.1): a dispatch is one firing of one event. Its applicable
 * hooks run one at a time, in effective order — a left fold the engine drives,
 * never `next()` middleware, so no hook can stall or stop the chain. Each step
 * builds a fresh shallow-frozen context from the dispatch's WORKING STATE (the
 * event's input plus every action earlier steps applied), calls the handler
 * inside the hook output scope with its own timeout and `AbortSignal`, then
 * severity-gates and validates what it returned and hands the step's fix
 * actions to the event's applier, in the order the hook returned them, before
 * the next hook is called. `ctx.prior` lists what earlier steps applied.
 *
 * Latency is the sum of the steps, bounded by an event budget (§4.5): a step's
 * timeout is its own or the budget left, whichever is shorter, and a hook whose
 * step would start with no budget left is journaled `skipped`. Separate
 * dispatches (two requests, two tool calls, two sessions) are independent.
 *
 * Failure posture: fail open, always. A throw, a rejection, a timeout or an
 * invalid return value is journaled and treated as "no actions", and the next
 * step sees what the failed one saw; an invalid action is journaled and
 * ignored. Five consecutive failures of one hook disable it for the process
 * (journal `disabled`, one stderr line); any success resets the count. A
 * timeout the event budget caused, and a skipped step, do not count. There is
 * no fail-closed option: a throwing hook never breaks a request or a session.
 *
 * Observability: one private `journal()` fans out to the local journal and —
 * for the surfaces and decision values the telemetry backend accepts — to
 * `recordTelemetryDecision`, the session aggregate that actually uploads. The
 * two privacy rules are applied there, before the aggregate sees anything: a
 * user hook's id uploads as `"user"`, and an `mcp__` tool name on a user hook's
 * row is withheld. Built-in ids and tool names pass through. The local line
 * keeps the real id.
 */

import { log, logStderr } from "../logger.js";
import {
  type ActionResult,
  type ClosedEvent,
  type PlannedAction,
  validateAction,
} from "./actions.js";
import type { HooksConfig, WarnSink } from "./config.js";
import { deepFreeze } from "./freeze.js";
import {
  type Decision,
  JOURNAL_SCHEMA_VERSION,
  type JournalEntry,
  type JournalEvent,
  MAX_DETAIL_CHARS,
  type Surface,
  classifyPath,
  isUploadDecision,
  isUploadSurface,
  recordDecision,
} from "./journal.js";
import { runInHookScope } from "./output-capture.js";
import type {
  HookAction,
  HookDefinition,
  HostMode,
  ObserveAction,
  PriorAction,
  RequestAction,
  ResponseEndAction,
  RewriteAction,
  SessionAction,
  Severity,
  ToolCallAction,
} from "./public.js";
import type {
  ApplicabilityScope,
  ApplicableHook,
  HookEventName,
  HookRegistry,
} from "./registry.js";
import { recordTelemetryDecision, setTelemetryConsent } from "./telemetry/aggregate.js";

/* ───────────── timeouts (§4.5) ───────────── */

/** Default and maximum handler timeout per event, in ms. */
export const EVENT_TIMEOUTS: Readonly<Record<HookEventName, { default: number; max: number }>> = {
  request: { default: 1_000, max: 5_000 },
  toolCall: { default: 1_000, max: 5_000 },
  responseRewrite: { default: 2_000, max: 10_000 },
  responseEnd: { default: 5_000, max: 30_000 },
  sessionStart: { default: 5_000, max: 30_000 },
  sessionIdle: { default: 5_000, max: 30_000 },
  sessionBlocked: { default: 5_000, max: 30_000 },
  sessionEnd: { default: 1_500, max: 1_500 },
  "raw.providerRequest": { default: 1_000, max: 5_000 },
  // Synchronous; no timeout applies.
  "raw.providerChunk": { default: 0, max: 0 },
  "raw.providerStreamEnd": { default: 1_000, max: 5_000 },
  "raw.response": { default: 1_000, max: 5_000 },
};

/**
 * The event budget (§4.5): the time the whole hook chain of one dispatch may
 * take, in ms. Each equals the event's per-hook maximum, so no dispatch's
 * worst case is longer than one hook at its maximum. `null` = no budget: raw
 * `providerChunk` is synchronous, and each raw `response` step keeps its own
 * call and close deadlines (a budget would cut a replacement mid-decision).
 */
export const EVENT_BUDGETS: Readonly<Record<HookEventName, number | null>> = {
  request: 5_000,
  toolCall: 5_000,
  responseRewrite: 10_000,
  responseEnd: 30_000,
  sessionStart: 30_000,
  sessionIdle: 30_000,
  sessionBlocked: 30_000,
  sessionEnd: 1_500,
  "raw.providerRequest": 5_000,
  "raw.providerChunk": null,
  "raw.providerStreamEnd": 5_000,
  "raw.response": null,
};

/** A hook's timeout for an event: its own `timeoutMs` clamped to the event's maximum. */
export function timeoutFor(def: HookDefinition, event: HookEventName): number {
  const bounds = EVENT_TIMEOUTS[event];
  const own = def.timeoutMs;
  if (typeof own !== "number" || !Number.isFinite(own) || own <= 0) return bounds.default;
  return Math.min(own, bounds.max);
}

/**
 * The dispatch bound of an event (§4.5): the smaller of its budget and the sum
 * of its applicable hooks' step timeouts. With no budget, the sum.
 */
export function dispatchBoundMs(
  event: HookEventName,
  hooks: ReadonlyArray<{ hook: { def: HookDefinition } }>
): number {
  let sum = 0;
  for (const a of hooks) sum += timeoutFor(a.hook.def, event);
  const budget = EVENT_BUDGETS[event];
  return budget === null ? sum : Math.min(budget, sum);
}

/** One step's timeout: its own, or the budget left, whichever is shorter. */
export interface StepTimeout {
  ms: number;
  /**
   * true when the earlier steps cut this step's time by MORE than `clipMarginMs`, so a
   * timeout is theirs: journaled `event_budget`, not counted toward the breaker. A cut
   * within the margin leaves this false even though `ms` may be a little under the
   * hook's own timeout: that timeout is the hook's own and counts.
   */
  clipped: boolean;
}

/** The smallest cut, in ms, that makes a budget-shortened step's timeout the budget's fault. */
export const CLIP_MARGIN_MIN_MS = 250;
/** The same margin as a share of the hook's own timeout, when that is larger. */
export const CLIP_MARGIN_SHARE = 0.1;
/** The margin never exceeds this share of the hook's own timeout (short hooks). */
export const CLIP_MARGIN_MAX_SHARE = 0.5;

/**
 * How much shorter than its own timeout a step must be before a timeout is not counted:
 * max(250 ms, 10 % of its own timeout), capped at half its own timeout. Without the cap a
 * hook whose own timeout is 250 ms or less could never be clipped by more than the
 * margin, so a slow hook before it would get it disabled.
 */
export function clipMarginMs(ownMs: number): number {
  return Math.min(
    ownMs * CLIP_MARGIN_MAX_SHARE,
    Math.max(CLIP_MARGIN_MIN_MS, ownMs * CLIP_MARGIN_SHARE)
  );
}

/**
 * The step timeout of a hook whose step starts with `remaining` ms of budget
 * left (`null` = no budget), or null when nothing is left: the hook is skipped.
 *
 * The breaker rule (§2.4): a step timeout counts toward the hook's breaker unless the
 * step was clipped by MORE than `clipMarginMs(own)` — max(250 ms, 10 % of the hook's own
 * timeout), capped at half its own timeout — and therefore the hook did not get its own
 * full timeout. A clip within the
 * margin is what the earlier steps' ordinary run time costs (the built-ins before every
 * `request` hook, a 1 ms boundary between deadline and `Date.now()`); exempting it let a
 * hook that hangs at its own maximum escape the breaker forever whenever any step ran
 * before it. A larger clip means an earlier hook really spent the budget, and a slow hook
 * A must not disable a healthy hook B.
 */
export function stepTimeout(
  def: HookDefinition,
  event: HookEventName,
  remaining: number | null
): StepTimeout | null {
  const own = timeoutFor(def, event);
  if (remaining === null) return { ms: own, clipped: false };
  if (remaining <= 0) return null;
  if (remaining >= own) return { ms: own, clipped: false };
  return { ms: remaining, clipped: own - remaining > clipMarginMs(own) };
}

/** The journal detail of a timeout or a skip the event budget caused. */
export const EVENT_BUDGET_DETAIL = "event_budget";

/** Consecutive failures that disable a hook for the process. */
export const BREAKER_THRESHOLD = 5;

/**
 * Actions one hook may return from one step; the rest are journaled `invalid`
 * (`too_many_actions`) and not applied. Applying a step is synchronous and runs
 * outside the step's timeout, and a `responseRewrite` step re-applies every text
 * action so far over a held response of up to 8 MiB, so an unbounded list could
 * hold the response (and its keepalive) far past the event's budget.
 */
export const MAX_ACTIONS_PER_STEP = 64;

/** The synthetic hook id carried by a pending note on the request it is applied to. */
export const PENDING_NOTE_ID = "behavior/pending-correction";

/** Sessions the pending-note store tracks; the oldest is evicted past this. */
export const MAX_PENDING_SESSIONS = 64;

/** Journal surface per event. `responseEnd` keeps the old `onModelOutput` surface. */
export const SURFACE_OF: Readonly<Record<HookEventName, Surface>> = {
  request: "request",
  toolCall: "tool_call",
  responseRewrite: "response",
  responseEnd: "model_output",
  sessionStart: "session",
  sessionIdle: "session",
  sessionBlocked: "session",
  sessionEnd: "session",
  "raw.providerRequest": "request",
  "raw.providerChunk": "response",
  "raw.providerStreamEnd": "response",
  "raw.response": "response",
};

/** The action union each closed event returns. */
export interface EventActions {
  request: RequestAction;
  toolCall: ToolCallAction;
  responseRewrite: RewriteAction;
  responseEnd: ResponseEndAction;
  sessionStart: SessionAction;
  sessionIdle: SessionAction;
  sessionBlocked: ObserveAction;
  sessionEnd: ObserveAction;
}

/** The engine-built part of every context (§4.3 `BaseContext`). */
export interface BaseContextParts {
  hookId: string;
  severity: Exclude<Severity, "off">;
  log(message: string): void;
  /** this step's own signal: its step timeout, or the dispatch's abort */
  signal: AbortSignal;
  /** what earlier steps of this dispatch applied or handed on, in order (§4.4.1 rule 5) */
  prior: ReadonlyArray<PriorAction>;
}

/** Facts every journal line of one dispatch shares. */
export interface JournalMeta {
  model: string;
  provider: string;
  sessionId?: string;
  toolName?: string;
}

/** Everything one journal line can carry. */
export interface JournalInput extends JournalMeta {
  event: HookEventName | JournalEvent;
  hookId: string;
  decision: Decision;
  action?: string;
  surface?: Surface;
  argKeys?: string[];
  observedPath?: string;
  expectedPath?: string;
  note?: string;
  detail?: string;
  /** Never sent to the telemetry aggregate, whatever the surface and decision (raw-tier rows). */
  localOnly?: boolean;
}

export type HookRunStatus = "ok" | "timeout" | "error" | "invalid" | "aborted" | "skipped";

/** One hook's step within a dispatch. */
export interface HookRun<A extends HookAction> {
  applicable: ApplicableHook;
  status: HookRunStatus;
  /** Every valid action the hook returned, `warn` included, before the severity gate. */
  returned: A[];
  /** The actions this step applied (or handed on): what it added to `ctx.prior`. */
  applied: Array<PlannedAction<A>>;
}

/** What one step's applier did with that step's fix actions. */
export interface StepApplied<A extends HookAction, S> {
  /** The working state the next step starts from. */
  state: S;
  /** Outcomes the engine journals at this step (an applier may journal itself and return none). */
  results: ReadonlyArray<ActionResult<A>>;
  /** The actions that took effect, in order: appended to `ctx.prior`. */
  applied: ReadonlyArray<PlannedAction<A>>;
}

/**
 * One event's step functions (§4.4.1). `context` builds a step's context from
 * the working state; `apply` applies one step's fix actions — valid, non-`warn`,
 * in the order the hook returned them — and must not mutate `state`: the
 * engine replaces the working state only when it returns, so a step is atomic.
 * The one exception is `responseEnd`, whose applier delivers each action as it
 * routes it; it contains a throw per action instead (`SeamHooks.end`).
 * An observe-only chain passes no `apply`: nothing it returns can be applied.
 */
export interface ChainStep<A extends HookAction, S> {
  context(applicable: ApplicableHook, base: BaseContextParts, state: S): object;
  apply?(state: S, items: ReadonlyArray<PlannedAction<A>>): StepApplied<A, S>;
  /** Extra fields for the journal line of one result this step's applier returned. */
  journalExtra?(result: ActionResult<A>, before: S): Partial<JournalInput>;
  /**
   * Called once a hook's step ended (not for a skipped or aborted one, nor for one
   * whose applier threw: that step's lines are its `apply_failed` errors), with
   * the state the step saw: for journal lines that are not action outcomes.
   */
  afterStep?(run: HookRun<A>, before: S): void;
}

export interface ChainOptions<S> {
  /** The working state step 1 starts from. */
  initial: S;
  /**
   * Aborting it aborts the running step's signal and starts no later step;
   * the running hook ends `aborted`, unjournaled.
   */
  signal?: AbortSignal;
  /** `ctx.prior` of step 1: actions applied before the chain (the request's pending notes). */
  prior?: ReadonlyArray<PriorAction>;
}

export interface ChainResult<A extends HookAction, S> {
  /** One entry per hook the chain reached, in effective order. */
  runs: Array<HookRun<A>>;
  /** The working state after the last step. */
  state: S;
  /** Every action the chain's steps applied (or handed on), in order. */
  applied: Array<PlannedAction<A>>;
}

function isUserHook(hookId: string): boolean {
  return hookId.startsWith("hook:");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…` : text;
}

/** The function and its `this` for one event of a definition. */
function handlerOf(
  def: HookDefinition,
  event: ClosedEvent
): { fn: (ctx: unknown) => unknown; self: unknown } | null {
  const on = (def.on ?? {}) as Record<string, unknown>;
  const entry = on[event];
  if (event === "toolCall" || event === "responseRewrite") {
    const container = entry as { handle?: unknown } | undefined;
    return typeof container?.handle === "function"
      ? { fn: container.handle as (ctx: unknown) => unknown, self: container }
      : null;
  }
  return typeof entry === "function" ? { fn: entry as (ctx: unknown) => unknown, self: on } : null;
}

interface PendingNote {
  seq: number;
  hookId: string;
  text: string;
}

export interface HookEngineOptions {
  registry: HookRegistry;
  config: HooksConfig;
  hostMode: HostMode;
  /** Local journal writer. Default: append to `~/.claudish/behavior-journal.jsonl`. */
  journalSink?: (entry: JournalEntry) => void;
  /** Where the breaker's stderr line goes. Default: `logStderr`. */
  warn?: WarnSink;
  /**
   * Deliver telemetry a previous process spooled, in the background, when
   * consent is on. Default true; tests turn it off so nothing reaches the network.
   */
  drainTelemetryOutbox?: boolean;
}

export class HookEngine {
  readonly registry: HookRegistry;
  readonly config: HooksConfig;
  readonly hostMode: HostMode;

  private readonly journalSink: (entry: JournalEntry) => void;
  private readonly warnSink: WarnSink;
  private readonly failures = new Map<string, number>();
  private readonly disabled = new Set<string>();
  private readonly notes = new Map<string, PendingNote[]>();
  private noteSeq = 0;

  constructor(opts: HookEngineOptions) {
    this.registry = opts.registry;
    this.config = opts.config;
    this.hostMode = opts.hostMode;
    this.journalSink = opts.journalSink ?? ((entry) => void recordDecision(entry));
    this.warnSink = opts.warn ?? ((line) => logStderr(line));

    // The engine owns the parsed config, so consent is pushed to the collector
    // from here rather than re-read on the request path.
    const optedIn = opts.config.telemetry?.enabled === true;
    setTelemetryConsent(optedIn);
    // Deliver what a PREVIOUS process spooled at exit. In the background of a
    // live process, because shutdown is synchronous and cannot await a POST.
    if (optedIn && opts.drainTelemetryOutbox !== false) {
      void import("./telemetry/upload.js")
        .then((m) => m.drainOutbox())
        .catch((err) => log(`[hooks:telemetry] drain unavailable: ${err}`));
    }
  }

  /* ───────────── selection ───────────── */

  /** Applicable hooks for an event, in effective order, minus those the breaker disabled. */
  select(event: HookEventName, scope: ApplicabilityScope = {}): ApplicableHook[] {
    return this.registry.applicable(event, scope).filter((a) => !this.disabled.has(a.hook.id));
  }

  /** True when the circuit breaker disabled this hook. */
  isDisabled(hookId: string): boolean {
    return this.disabled.has(hookId);
  }

  /* ───────────── dispatch: the hook chain (§4.4.1) ───────────── */

  /**
   * Run one dispatch's hooks as a hook chain: one at a time, in the order of
   * `hooks` (effective order), each step's fix actions applied by `step.apply`
   * before the next hook is called.
   *
   * Per step: a hook the breaker disabled since selection is passed over with
   * no journal line; a hook whose step would start with no budget left is
   * journaled `skipped`; otherwise its context is built from the working state
   * (shallow-frozen, with `prior`), it is called with its step timeout and its
   * own signal, its return value is validated, `warn` actions and everything a
   * warn-severity hook returned are journaled `warned`, and its remaining
   * actions are applied atomically. An applier that throws (a claudish bug)
   * leaves the working state as it was and journals each action of the step
   * `error` with detail `apply_failed:<message>`.
   */
  async runChain<E extends ClosedEvent, S>(
    event: E,
    hooks: ReadonlyArray<ApplicableHook>,
    step: ChainStep<EventActions[E], S>,
    meta: JournalMeta,
    opts: ChainOptions<S>
  ): Promise<ChainResult<EventActions[E], S>> {
    type A = EventActions[E];
    const budget = EVENT_BUDGETS[event];
    const deadline = budget === null ? null : Date.now() + budget;
    const prior: PriorAction[] = [...(opts.prior ?? [])];
    const runs: Array<HookRun<A>> = [];
    const appliedAll: Array<PlannedAction<A>> = [];
    let state = opts.initial;

    for (const applicable of hooks) {
      if (opts.signal?.aborted) break;
      const { hook, severity } = applicable;
      if (this.disabled.has(hook.id)) continue;

      const timeout = stepTimeout(
        hook.def,
        event,
        deadline === null ? null : deadline - Date.now()
      );
      if (timeout === null) {
        this.journal({
          ...meta,
          event,
          hookId: hook.id,
          decision: "skipped",
          detail: EVENT_BUDGET_DETAIL,
        });
        runs.push({ applicable, status: "skipped", returned: [], applied: [] });
        continue;
      }

      const seen = state;
      const frozenPrior = Object.freeze([...prior]);
      const run = await this.runStep<E>(
        event,
        applicable,
        (base) => step.context(applicable, { ...base, prior: frozenPrior }, seen),
        meta,
        opts.signal,
        timeout
      );
      runs.push(run);
      if (run.status === "aborted") break;

      // Severity gate: warn actions journal at the step; a warn hook applies nothing.
      const items: Array<PlannedAction<A>> = [];
      for (const action of run.returned) {
        if (action.type === "warn") {
          log(`[hooks] ${hook.id} warn: ${action.message}`);
          this.journal({
            ...meta,
            event,
            hookId: hook.id,
            action: "warn",
            decision: "warned",
            detail: action.message,
          });
          continue;
        }
        if (severity !== "fix") {
          this.journal({
            ...meta,
            event,
            hookId: hook.id,
            action: action.type,
            decision: "warned",
            detail: "severity warn: not applied",
          });
          continue;
        }
        items.push({ hookId: hook.id, action });
      }
      if (items.length === 0 || !step.apply) {
        step.afterStep?.(run, seen);
        continue;
      }

      let outcome: StepApplied<A, S>;
      try {
        outcome = step.apply(seen, items);
      } catch (err) {
        log(`[hooks] ${hook.id}: applying its actions failed: ${errorText(err)}`);
        for (const item of items) {
          this.journal({
            ...meta,
            event,
            hookId: hook.id,
            action: item.action.type,
            decision: "error",
            detail: `apply_failed:${errorText(err)}`,
          });
        }
        // No afterStep: the step's lines are the `error` ones above. An `ignored` line
        // from afterStep (no repair applied) would contradict them.
        continue;
      }
      state = outcome.state;
      if (outcome.results.length > 0) {
        this.recordResults(
          event,
          outcome.results,
          meta,
          step.journalExtra
            ? (r) => step.journalExtra?.(r as ActionResult<A>, seen) ?? {}
            : undefined
        );
      }
      for (const p of outcome.applied) {
        run.applied.push(p);
        appliedAll.push(p);
        // Already a deep-frozen copy (`collect`): the same object the working state
        // holds, so a later hook cannot write into it through ctx.prior.
        prior.push(Object.freeze({ hookId: p.hookId, action: p.action }));
      }
      step.afterStep?.(run, seen);
    }
    return { runs, state, applied: appliedAll };
  }

  /** One step: call the handler within `timeout`, validate what it returned. */
  private runStep<E extends ClosedEvent>(
    event: E,
    applicable: ApplicableHook,
    context: (base: BaseContextParts) => object,
    meta: JournalMeta,
    parent: AbortSignal | undefined,
    timeout: StepTimeout
  ): Promise<HookRun<EventActions[E]>> {
    const { hook, severity } = applicable;
    const done = (status: HookRunStatus, returned: Array<EventActions[E]> = []) => ({
      applicable,
      status,
      returned,
      applied: [],
    });

    const handler = handlerOf(hook.def, event);
    if (!handler) return Promise.resolve(done("ok"));
    if (parent?.aborted) return Promise.resolve(done("aborted"));

    const controller = new AbortController();
    const timeoutMs = timeout.ms;
    const observe =
      event === "toolCall" &&
      (hook.def.on?.toolCall as { observe?: boolean } | undefined)?.observe === true;

    return new Promise((resolveRun) => {
      let settled = false;
      const finish = (run: HookRun<EventActions[E]>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        parent?.removeEventListener("abort", onParentAbort);
        resolveRun(run);
      };

      const onParentAbort = () => {
        controller.abort(parent?.reason ?? new Error("aborted"));
        finish(done("aborted"));
      };
      parent?.addEventListener("abort", onParentAbort, { once: true });

      // A late result is discarded: once the timer fired, `settled` is true.
      const timer = setTimeout(() => {
        controller.abort(new Error(`hook ${hook.id} timed out after ${timeoutMs} ms`));
        this.journal({
          ...meta,
          event,
          hookId: hook.id,
          decision: "timeout",
          detail: timeout.clipped ? EVENT_BUDGET_DETAIL : `${timeoutMs} ms`,
        });
        // Clipped beyond the margin: the steps before this one spent the budget, so it is
        // not this hook's failure. Within the margin it is the hook's own (stepTimeout).
        if (!timeout.clipped) this.noteFailure(hook.id, meta, event);
        finish(done("timeout"));
      }, timeoutMs);

      const base: BaseContextParts = {
        hookId: hook.id,
        severity,
        log: (message: string) => log(`[hook ${hook.id}] ${message}`),
        signal: controller.signal,
        prior: [],
      };

      let value: unknown;
      try {
        const ctx = Object.freeze(context(base));
        value = runInHookScope(hook.id, () => handler.fn.call(handler.self, ctx));
      } catch (err) {
        this.journal({
          ...meta,
          event,
          hookId: hook.id,
          decision: "error",
          detail: errorText(err),
        });
        this.noteFailure(hook.id, meta, event);
        finish(done("error"));
        return;
      }

      Promise.resolve(value).then(
        (returned) => {
          if (settled) return;
          const result = this.collect(event, hook.id, returned, meta, observe);
          if (result === null) {
            this.noteFailure(hook.id, meta, event);
            finish(done("invalid"));
            return;
          }
          const actions = result.actions as Array<EventActions[E]>;
          if (result.notPlainData) {
            // Its other, valid actions still apply, as with any invalid action; but a
            // value claudish cannot copy is a broken return, so the step counts.
            this.noteFailure(hook.id, meta, event);
            finish(done("invalid", actions));
            return;
          }
          this.noteSuccess(hook.id);
          finish(done("ok", actions));
        },
        (err: unknown) => {
          if (settled) return;
          this.journal({
            ...meta,
            event,
            hookId: hook.id,
            decision: "error",
            detail: errorText(err),
          });
          this.noteFailure(hook.id, meta, event);
          finish(done("error"));
        }
      );
    });
  }

  /**
   * Validate a handler's return value. Returns the valid actions, or null when
   * the value itself is invalid (not an array, not undefined).
   *
   * Each action is COPIED before it is validated, and the deep-frozen copy is the
   * only object claudish uses from then on: the applier, stage B's held list, the
   * rewrite plan and `ctx.prior` all share it. So a hook cannot change an action
   * after returning it (from a timer, say) to slip past the limits checked here,
   * and a getter or a Proxy cannot show validation one value and the applier
   * another. A value that cannot be copied as plain data (a method, a Symbol, a
   * Proxy) is journaled `invalid` (`not_plain_data`) and sets `notPlainData`,
   * which counts the step toward the breaker.
   */
  private collect(
    event: ClosedEvent,
    hookId: string,
    returned: unknown,
    meta: JournalMeta,
    observe: boolean
  ): { actions: HookAction[]; notPlainData: boolean } | null {
    if (returned === undefined || returned === null) return { actions: [], notPlainData: false };
    if (!Array.isArray(returned)) {
      this.journal({
        ...meta,
        event,
        hookId,
        decision: "invalid",
        detail: "return value is not an array",
      });
      return null;
    }
    const valid: HookAction[] = [];
    if (returned.length > MAX_ACTIONS_PER_STEP) {
      // One line for the excess, not one per action: the array is unbounded.
      this.journal({
        ...meta,
        event,
        hookId,
        decision: "invalid",
        detail: `too_many_actions:${returned.length - MAX_ACTIONS_PER_STEP} over ${MAX_ACTIONS_PER_STEP}`,
      });
    }
    let notPlainData = false;
    for (const value of returned.slice(0, MAX_ACTIONS_PER_STEP)) {
      let copy: unknown;
      try {
        copy = structuredClone(value);
      } catch {
        notPlainData = true;
        let type: unknown;
        try {
          type = (value as { type?: unknown } | null)?.type;
        } catch {
          // a Proxy may throw on any read
        }
        this.journal({
          ...meta,
          event,
          hookId,
          action: typeof type === "string" ? type : undefined,
          decision: "invalid",
          detail: "not_plain_data",
        });
        continue;
      }
      const checked = validateAction(event, copy, { observe });
      if (checked.ok) {
        valid.push(deepFreeze(checked.action));
        continue;
      }
      const type = (copy as { type?: unknown } | null)?.type;
      this.journal({
        ...meta,
        event,
        hookId,
        action: typeof type === "string" ? type : undefined,
        decision: "invalid",
        detail: checked.reason,
      });
    }
    return { actions: valid, notPlainData };
  }

  /**
   * Call a synchronous predicate (`armed`, `claims`) inside the hook's scope.
   * A throw, or a non-boolean, counts as `false`.
   */
  callPredicate(
    hookId: string,
    fn: ((ctx: never) => unknown) | undefined,
    self: unknown,
    ctx: object,
    fallback = true
  ): boolean {
    if (typeof fn !== "function") return fallback;
    try {
      const value = runInHookScope(hookId, () =>
        (fn as (c: object) => unknown).call(self, Object.freeze(ctx))
      );
      return value === true;
    } catch (err) {
      log(`[hooks] ${hookId} predicate threw: ${errorText(err)}`);
      return false;
    }
  }

  /* ───────────── circuit breaker ───────────── */

  /** Count one failed call. The fifth in a row disables the hook for the process. */
  noteFailure(hookId: string, meta: JournalMeta, event: HookEventName | JournalEvent): void {
    if (this.disabled.has(hookId)) return;
    const count = (this.failures.get(hookId) ?? 0) + 1;
    this.failures.set(hookId, count);
    if (count < BREAKER_THRESHOLD) return;
    this.disabled.add(hookId);
    this.journal({
      ...meta,
      event,
      hookId,
      decision: "disabled",
      detail: `${BREAKER_THRESHOLD} consecutive failures`,
    });
    this.warnSink(
      `hook ${hookId} disabled after ${BREAKER_THRESHOLD} consecutive failures (see the debug log)`
    );
  }

  /** Any success resets the consecutive-failure count. */
  noteSuccess(hookId: string): void {
    this.failures.delete(hookId);
  }

  /* ───────────── journal ───────────── */

  /**
   * The single fan-out: the local journal line, and — for an uploadable
   * surface and decision — the telemetry aggregate, after the privacy
   * projection. Fire-and-forget; journaling never sits on the request path.
   */
  journal(input: JournalInput): void {
    const event = input.event.startsWith("raw.") ? "raw" : (input.event as JournalEvent);
    const surface = input.surface ?? SURFACE_OF[input.event as HookEventName] ?? "request";
    const upload = isUploadSurface(surface);
    const pathRelation = upload ? classifyPath(input.observedPath, input.expectedPath) : undefined;

    if (upload && input.localOnly !== true && isUploadDecision(input.decision)) {
      const user = isUserHook(input.hookId);
      recordTelemetryDecision({
        sessionId: input.sessionId,
        model: input.model,
        provider: input.provider,
        surface,
        decision: input.decision,
        // A user hook's id is a user-chosen name, and so is an MCP server's.
        ruleId: user ? "user" : input.hookId,
        toolName: user && input.toolName?.startsWith("mcp__") ? undefined : input.toolName,
        pathRelation,
      });
    }

    const entry: JournalEntry = {
      schema: JOURNAL_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      event,
      hookId: input.hookId,
      model: input.model,
      provider: input.provider,
      surface,
      decision: input.decision,
      ruleId: input.hookId,
    };
    if (input.action !== undefined) entry.action = input.action;
    if (input.sessionId !== undefined) entry.sessionId = input.sessionId;
    if (input.toolName !== undefined) entry.toolName = input.toolName;
    if (input.argKeys !== undefined) entry.argKeys = input.argKeys;
    if (pathRelation !== undefined) entry.pathRelation = pathRelation;
    if (
      input.observedPath !== undefined ||
      input.expectedPath !== undefined ||
      input.note !== undefined
    ) {
      entry.local = {
        observedPath: input.observedPath,
        expectedPath: input.expectedPath,
        note: input.note,
      };
    }
    const detail = clip(input.detail);
    if (detail !== undefined) entry.detail = detail;

    try {
      this.journalSink(entry);
    } catch (err) {
      log(`[hooks:journal] could not record: ${errorText(err)}`);
    }
  }

  /** Journal what the appliers decided for each planned action. */
  recordResults(
    event: HookEventName,
    results: ReadonlyArray<ActionResult>,
    meta: JournalMeta,
    extra?: (result: ActionResult) => Partial<JournalInput>
  ): void {
    for (const r of results) {
      const toolName =
        "tool" in r.action && typeof r.action.tool === "string" ? r.action.tool : meta.toolName;
      // A repaired tool call keeps the decision the telemetry backend knows it by.
      const decision: Decision =
        r.action.type === "repairToolArgs" && r.decision === "matched" ? "repaired" : r.decision;
      this.journal({
        ...meta,
        toolName,
        event,
        hookId: r.hookId,
        action: r.action.type,
        decision,
        detail: r.detail,
        ...(extra?.(r) ?? {}),
      });
    }
  }

  /* ───────────── pending notes ───────────── */

  /**
   * Store an `injectSystemNote` from `responseEnd` for the Claude session's
   * NEXT request. Bounded to MAX_PENDING_SESSIONS sessions, oldest evicted.
   */
  queueNote(sessionId: string, hookId: string, text: string): void {
    const list = this.notes.get(sessionId) ?? [];
    list.push({ seq: ++this.noteSeq, hookId, text });
    // Re-insert so a busy session is the newest, not evicted first.
    this.notes.delete(sessionId);
    this.notes.set(sessionId, list);
    while (this.notes.size > MAX_PENDING_SESSIONS) {
      const oldest = this.notes.keys().next().value;
      if (oldest === undefined) break;
      this.notes.delete(oldest);
    }
  }

  /**
   * The notes pending for a session, WITHOUT removing them. They are removed by
   * `consumeNotes` only once a request carrying them is accepted, so a failed
   * fallback attempt cannot lose a note.
   */
  peekNotes(sessionId: string | undefined): ReadonlyArray<Readonly<PendingNote>> {
    if (!sessionId) return [];
    return [...(this.notes.get(sessionId) ?? [])];
  }

  /** Remove the notes a committed request carried (by `seq`; already-removed ones are ignored). */
  consumeNotes(sessionId: string, seqs: ReadonlyArray<number>): void {
    const list = this.notes.get(sessionId);
    if (!list) return;
    const drop = new Set(seqs);
    const rest = list.filter((n) => !drop.has(n.seq));
    if (rest.length === 0) this.notes.delete(sessionId);
    else this.notes.set(sessionId, rest);
  }
}
