/**
 * `SessionHookBinding`: what a pane owner (the MCP server's `SessionManager`, the
 * team orchestrator) hands each `PaneSession` whose session hooks need one
 * (architecture §4.10, §7.3).
 *
 * The pane calls `settle()` once per settled turn, while it holds the turn in
 * `SETTLING`. `settle()` awaits, in order: a `sessionStart` dispatch still running
 * (its injections must not be stranded by a fast first answer), the inbox drain
 * (proxy-event `injectUserTurn` / `annotateTurn` from the pane child), and the
 * `sessionIdle` hook chain. It returns every candidate injection in the merge
 * order of §4.7 rule 4: `sessionStart`, then proxy events in arrival order, then
 * `sessionIdle` in hook-chain order. The pane applies the queue policy.
 *
 * Every session event is one dispatch run as a hook chain (§4.4.1): the session
 * and turn facts are read once, at the start of the dispatch, and a later hook
 * sees the injections earlier hooks returned in `ctx.prior`.
 *
 * The pane aborts `signal` with a reason when the hold ends without this result.
 * The reason decides what happens to what this hold already drained (§4.7 rule 12):
 * `rewake` carries the proxy items and annotations to the next settle of the same
 * turn and drops the `sessionIdle` results; `caller` drops everything `stale`;
 * `watchdog` and `error` drop it with detail `hold_ended`; `exit` and `terminal`
 * with detail `session_ended`. Every drop is a journal line, so nothing drained is
 * lost silently.
 */

import { logStderr } from "../../logger.js";
import { maxConsecutiveInjections } from "../config.js";
import {
  type ChainStep,
  EVENT_TIMEOUTS,
  type HookEngine,
  type JournalMeta,
  dispatchBoundMs,
} from "../engine.js";
import { frozenClone } from "../freeze.js";
import { type InboxLineSource, InboxReader, inboxHasPayload } from "../injection/inbox.js";
import type { InjectionSource } from "../injection/queue.js";
import type { SessionAction, SessionInfo, TurnAnnotation } from "../public.js";
import type { ApplicableHook, HookEventName } from "../registry.js";

/** What the pane tells `settle()` about the turn it holds. */
export interface HoldTurnInfo {
  index: number;
  answer: string;
  stopReason: string | null;
  apiError: boolean;
  hookCaused: boolean;
  /** hook-caused turns in a row so far (`ctx.consecutiveHookTurns`); 0 when absent */
  consecutiveHookTurns?: number;
  /** caller input is queued (`ctx.callerInputPending`); false when absent */
  callerInputPending?: boolean;
  /** the session's shape now (a send converts one-shot to interactive) */
  shape?: "interactive" | "one-shot";
}

export interface HoldInjection {
  text: string;
  hookIds: string[];
  source: InjectionSource;
}

export interface HoldResult {
  injections: HoldInjection[];
  /** set when the settle failed; the hold concludes with no injection */
  error?: string;
  /** pane anomaly keys this settle produced (`hook_injection_dropped:inbox_cap`) */
  anomalies?: string[];
  /** the annotations this hold drained, so an abandoned result can carry them (rule 12) */
  annotations?: TurnAnnotation[];
}

/** Why the pane aborted a hold. */
export type HoldAbortReason = "rewake" | "caller" | "watchdog" | "error" | "exit" | "terminal";

/** What the binding may push into its pane: `sessionStart` injections that no hold took. */
export interface BindingPane {
  queueInjections(injections: HoldInjection[]): void;
}

export interface SessionHookBinding {
  /**
   * true while a sessionIdle hook applies, a sessionStart dispatch is running, the inbox has
   * unread bytes, items are carried from an aborted hold, or a hook item is queued
   */
  hasIdleWork(queueHasHookItem: boolean): boolean;
  /**
   * The pane aborts `signal` with a `HoldAbortReason` when the hold ends without this
   * result. The reason decides what happens to proxy items already drained.
   */
  settle(turn: HoldTurnInfo, signal: AbortSignal): Promise<HoldResult>;
  /**
   * A result `settle()` returned that the pane did not apply: the hold ended another way
   * after it arrived (a re-wake or a human prompt found when the result was re-checked, a
   * caller, an exit). Handled exactly as an abort with `reason` (§4.7 rule 12).
   */
  abandon?(result: HoldResult, reason: HoldAbortReason): void;
  /**
   * The hold watchdog, read when a hold starts: what remains of a running sessionStart
   * dispatch (its start + its dispatch bound − now, or 0) + the inbox bound + the
   * sessionIdle dispatch bound + 1,000 ms. A dispatch bound is min(event budget, sum of
   * the applicable hooks' step timeouts) (§4.5). Each term bounds one stage settle() awaits.
   */
  holdBoundMs(): number;
  fireStart(): void;
  fireBlocked(block: { kind: "question" | "permission"; text: string }): void;
  fireEnd(outcome: { state: string; reason: string | null; exitCode: number | null }): void;
  /** `hooks.injection.maxConsecutive`; the pane uses 3 when absent */
  readonly maxConsecutive?: number;
  /** The pane registers itself so a sessionStart dispatch no hold took can be queued. */
  attach?(pane: BindingPane): void;
  /** An injection the pane dropped (stale, capped, pane_exited, …): one journal line per hook. */
  noteDropped?(item: { text: string; hookIds: string[] }, reason: string): void;
  /** An injection the pane admitted. */
  noteDelivered?(item: { text: string; hookIds: string[] }): void;
  /**
   * The interactive driver learned (or `/clear` changed) the Claude Code session id:
   * later contexts and journal lines carry it.
   */
  updateSession?(patch: Partial<Pick<SessionInfo, "id" | "claudeSessionId" | "injection">>): void;
  /**
   * The `sessionEnd` dispatch `fireEnd` started, settled; resolves at once when none
   * runs. The interactive launcher awaits it (≤ 1.5 s) before shutting its proxy down.
   */
  endSettled?(): Promise<void>;
  /**
   * The session is over and nothing writes its inbox any more (the pane was reaped, or
   * the launcher is shutting its proxy down): every payload line no settle took is
   * journaled dropped `session_ended`, so a late `responseEnd` result is never
   * lost without a trace.
   */
  sweepInbox?(): void;
}

export interface SessionHookBindingOptions {
  /** the inbox wait bound; production: the responseEnd dispatch bound (never below the default timeout) + 500 ms */
  inboxBoundMs?: number;
  now?: () => number;
}

/** Added to the `responseEnd` dispatch bound to bound the inbox wait (§2.3 step 5). */
export const INBOX_WAIT_MARGIN_MS = 500;
/** Added to the sum of the stage bounds for the hold watchdog (§4.5). */
export const HOLD_WATCHDOG_MARGIN_MS = 1_000;

/** The events whose hooks make a pane owner attach a binding. */
const BINDING_EVENTS: ReadonlyArray<HookEventName> = [
  "responseEnd",
  "sessionStart",
  "sessionIdle",
  "sessionBlocked",
  "sessionEnd",
];

/** True when this engine has a hook a pane owner must drive a binding for. */
export function sessionHooksNeedBinding(engine: HookEngine): boolean {
  return BINDING_EVENTS.some((e) => engine.select(e).length > 0);
}

/**
 * The production inbox wait bound for this engine: the `responseEnd` dispatch
 * bound, never below the default timeout, + 500 ms (5.5 s with one default hook;
 * 30.5 s at most, the budget).
 */
export function inboxBoundFor(engine: HookEngine): number {
  const bound = dispatchBoundMs("responseEnd", engine.select("responseEnd"));
  return Math.max(EVENT_TIMEOUTS.responseEnd.default, bound) + INBOX_WAIT_MARGIN_MS;
}

/**
 * The step functions of a `sessionStart` or `sessionIdle` chain: the working
 * state is the injections accepted so far, which later hooks see in `ctx.prior`.
 */
function injectionStep(
  source: "sessionStart" | "sessionIdle",
  context: (base: object) => object
): ChainStep<SessionAction, HoldInjection[]> {
  return {
    context: (_a, base) => context(base),
    apply: (accepted, items) => {
      const next = [...accepted];
      const applied: (typeof items)[number][] = [];
      for (const p of items) {
        if (p.action.type !== "injectUserTurn") continue;
        next.push({ text: p.action.text, hookIds: [p.hookId], source });
        applied.push(p);
      }
      // Journaled `queued` when the hold (or the pane) takes them.
      return { state: next, results: [], applied };
    },
  };
}

const ABORTED = Symbol("aborted");

/**
 * `p`'s value, or ABORTED when `signal` aborts first. `onLate` receives a value that
 * arrives after the abort won, so a caller that claimed `p` can hand it back.
 */
function raceAbort<T>(
  p: Promise<T>,
  signal: AbortSignal,
  onLate: (v: T) => void = () => {}
): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => {
    let lost = false;
    const onAbort = () => {
      lost = true;
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        if (lost) onLate(v);
        else resolve(v);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve([] as unknown as T);
      }
    );
  });
}

interface StartDispatch {
  promise: Promise<HoldInjection[]>;
  startedAt: number;
  bound: number;
  /** a hold awaits it: its injections go to that hold, not to the pane */
  claimed: boolean;
  /** its injections were taken, by a hold or by the pane: never twice, never none */
  taken: boolean;
}

interface Drained {
  start: HoldInjection[];
  proxy: HoldInjection[];
  annotations: TurnAnnotation[];
  idle: HoldInjection[];
}

class EngineSessionHookBinding implements SessionHookBinding {
  readonly maxConsecutive: number;
  private readonly inbox: InboxReader | null;
  private readonly inboxBoundMs: number;
  private readonly now: () => number;
  private meta: JournalMeta;
  private session: SessionInfo;
  private endDispatch: Promise<unknown> | null = null;
  private pane: BindingPane | null = null;
  private start: StartDispatch | null = null;
  private startFired = false;
  private ended = false;
  private cappedReported = false;
  /** sessionStart injections that resolved with no pane attached and no hold waiting */
  private startPending: HoldInjection[] = [];
  /** carried from a hold a re-wake abandoned (§4.7 rule 12) */
  private carried: { injections: HoldInjection[]; annotations: TurnAnnotation[] } = {
    injections: [],
    annotations: [],
  };

  constructor(
    private readonly engine: HookEngine,
    session: SessionInfo,
    inbox: string | InboxLineSource | null,
    opts: SessionHookBindingOptions
  ) {
    this.session = session;
    this.inbox = inbox ? new InboxReader(inbox) : null;
    this.inboxBoundMs = opts.inboxBoundMs ?? inboxBoundFor(engine);
    this.now = opts.now ?? Date.now;
    this.maxConsecutive = maxConsecutiveInjections(engine.config);
    this.meta = {
      model: session.model,
      provider: "",
      ...(session.claudeSessionId ? { sessionId: session.claudeSessionId } : {}),
    };
  }

  updateSession(patch: Partial<Pick<SessionInfo, "id" | "claudeSessionId" | "injection">>): void {
    this.session = Object.freeze({ ...this.session, ...patch });
    this.meta = {
      model: this.session.model,
      provider: "",
      ...(this.session.claudeSessionId ? { sessionId: this.session.claudeSessionId } : {}),
    };
  }

  endSettled(): Promise<void> {
    return this.endDispatch ? this.endDispatch.then(() => {}) : Promise.resolve();
  }

  attach(pane: BindingPane): void {
    this.pane = pane;
    if (this.startPending.length > 0) {
      const items = this.startPending;
      this.startPending = [];
      pane.queueInjections(items);
    }
  }

  private scope() {
    return { sessionModel: this.session.model };
  }

  private idleHooks(): ApplicableHook[] {
    return this.engine.select("sessionIdle", this.scope());
  }

  hasIdleWork(queueHasHookItem: boolean): boolean {
    return (
      queueHasHookItem ||
      this.idleHooks().length > 0 ||
      this.start !== null ||
      this.startPending.length > 0 ||
      this.carried.injections.length > 0 ||
      this.carried.annotations.length > 0 ||
      (this.inbox?.hasUnread() ?? false)
    );
  }

  holdBoundMs(): number {
    const s = this.start;
    const startRemaining = s ? Math.max(0, s.startedAt + s.bound - this.now()) : 0;
    const idle = dispatchBoundMs("sessionIdle", this.idleHooks());
    return startRemaining + this.inboxBoundMs + idle + HOLD_WATCHDOG_MARGIN_MS;
  }

  /* ───────────── settle ───────────── */

  async settle(turn: HoldTurnInfo, signal: AbortSignal): Promise<HoldResult> {
    const anomalies: string[] = [];
    const d: Drained = {
      start: [...this.startPending],
      proxy: [...this.carried.injections],
      annotations: [...this.carried.annotations],
      idle: [],
    };
    this.startPending = [];
    this.carried = { injections: [], annotations: [] };

    // 1. A sessionStart dispatch still running holds this settle, within its own bound.
    const start = this.start;
    if (start) {
      start.claimed = true;
      // An abort can win the race after the dispatch resolved and its own handler left
      // the items to this claim: they are handed back, not lost.
      const got = await raceAbort(start.promise, signal, (items) => this.unclaimed(start, items));
      if (got === ABORTED) start.claimed = false;
      else {
        start.taken = true;
        d.start.push(...got);
      }
    }

    // 2. The inbox: proxy-event injections and annotations of this turn's responses.
    if (!signal.aborted && this.inbox) {
      const drained = await this.inbox.drain(this.inboxBoundMs, signal);
      for (const i of drained.injections)
        d.proxy.push({ text: i.text, hookIds: [i.hookId], source: "proxy" });
      for (const a of drained.annotations)
        d.annotations.push({ hookId: a.hookId, key: a.key, value: a.value });
      // held to the child's action rules; never offered
      for (const x of drained.invalid) {
        anomalies.push("hook_injection_dropped:invalid");
        this.engine.journal({
          ...this.meta,
          event: "responseEnd",
          hookId: x.hookId,
          action: x.kind === "inject" ? "injectUserTurn" : "annotateTurn",
          decision: "invalid",
          detail: `inbox: ${x.reason}`,
        });
      }
      // a request whose responseEnd outran the bound; its later lines go to the
      // next settle, or to the sweep when there is none
      for (const req of drained.timedOut) {
        anomalies.push("hook_inbox_wait_timeout");
        this.engine.journal({
          ...this.meta,
          event: "responseEnd",
          hookId: "inbox",
          action: "injectUserTurn",
          decision: "timeout",
          detail: `request ${req} still running at the ${this.inboxBoundMs} ms inbox bound`,
        });
      }
      if (drained.capped && !this.cappedReported) {
        this.cappedReported = true;
        anomalies.push("hook_injection_dropped:inbox_cap");
        this.journalDrop("responseEnd", "injectUserTurn", "inbox", "inbox_cap");
      }
    }

    // 3. The sessionIdle chain, with this turn's annotations. The session and
    //    turn facts are read once, here, at the start of the dispatch.
    if (!signal.aborted) {
      const hooks = this.idleHooks();
      if (hooks.length > 0) {
        // A deep-frozen copy: an annotation's value can be an object or an array, and
        // `d.annotations` is carried into the hold result and across a re-wake.
        const annotations = frozenClone(d.annotations);
        const session = this.sessionFor(turn);
        const facts = {
          event: "sessionIdle",
          session,
          turn: Object.freeze({
            index: turn.index,
            answer: turn.answer,
            stopReason: turn.stopReason,
            apiError: turn.apiError,
            hookCaused: turn.hookCaused,
            annotations,
          }),
          consecutiveHookTurns: turn.consecutiveHookTurns ?? 0,
          callerInputPending: turn.callerInputPending ?? false,
        };
        const chain = await this.engine.runChain(
          "sessionIdle",
          hooks,
          injectionStep("sessionIdle", (base) => ({ ...base, ...facts })),
          this.meta,
          { initial: [], signal }
        );
        d.idle.push(...chain.state);
      }
    }

    if (signal.aborted) {
      this.onAborted(signal.reason, d);
      return { injections: [], anomalies };
    }
    const injections = [...d.start, ...d.proxy, ...d.idle];
    for (const i of injections) this.journalItem(i, "queued");
    return { injections, anomalies, annotations: d.annotations };
  }

  abandon(result: HoldResult, reason: HoldAbortReason): void {
    const of = (s: InjectionSource) => result.injections.filter((i) => i.source === s);
    this.onAborted(reason, {
      start: of("sessionStart"),
      proxy: of("proxy"),
      idle: of("sessionIdle"),
      annotations: [...(result.annotations ?? [])],
    });
  }

  /** §4.7 rule 12: what a hold that ended without its result does with what it drained. */
  private onAborted(reason: unknown, d: Drained): void {
    const r = (typeof reason === "string" ? reason : "error") as HoldAbortReason;
    if (r === "rewake" && !this.ended) {
      this.carried = {
        injections: [...this.carried.injections, ...d.start, ...d.proxy],
        annotations: [...this.carried.annotations, ...d.annotations],
      };
      for (const i of d.idle) this.journalItem(i, "dropped", "rewake");
      return;
    }
    // A re-wake after the session ended has no next settle to carry to.
    const detail =
      r === "caller" ? "stale" : r === "watchdog" || r === "error" ? "hold_ended" : "session_ended";
    for (const i of [...d.start, ...d.proxy, ...d.idle]) this.journalItem(i, "dropped", detail);
    for (const a of d.annotations) this.journalAnnotation(a, detail);
  }

  /* ───────────── other events ───────────── */

  fireStart(): void {
    if (this.startFired || this.ended) return;
    this.startFired = true;
    const hooks = this.engine.select("sessionStart", this.scope());
    if (hooks.length === 0) return;
    const bound = dispatchBoundMs("sessionStart", hooks);
    const session = this.sessionFor();
    const promise = this.engine
      .runChain(
        "sessionStart",
        hooks,
        injectionStep("sessionStart", (base) => ({ ...base, event: "sessionStart", session })),
        this.meta,
        { initial: [] }
      )
      .then((r) => r.state)
      .catch(() => [] as HoldInjection[]);
    const entry: StartDispatch = {
      promise,
      startedAt: this.now(),
      bound,
      claimed: false,
      taken: false,
    };
    this.start = entry;
    void promise.then((items) => {
      if (this.start === entry) this.start = null;
      if (entry.claimed) return; // the hold awaiting it takes them
      this.unclaimed(entry, items);
    });
  }

  /** A sessionStart dispatch's injections that no hold took: the pane's, or dropped. */
  private unclaimed(entry: StartDispatch, items: HoldInjection[]): void {
    if (entry.taken) return;
    entry.taken = true;
    if (this.ended) {
      for (const i of items) this.journalItem(i, "dropped", "session_ended");
      return;
    }
    for (const i of items) this.journalItem(i, "queued");
    if (this.pane) this.pane.queueInjections(items);
    else this.startPending.push(...items);
  }

  fireBlocked(block: { kind: "question" | "permission"; text: string }): void {
    if (this.ended) return;
    const hooks = this.engine.select("sessionBlocked", this.scope());
    if (hooks.length === 0) return;
    const session = this.sessionFor();
    const facts = { event: "sessionBlocked", session, block: Object.freeze({ ...block }) };
    // Only `warn` is allowed: an observing chain, nothing to apply. Never rejects
    // into the caller, as fireStart/fireEnd do not.
    void this.engine
      .runChain(
        "sessionBlocked",
        hooks,
        { context: (_a, base) => ({ ...base, ...facts }) },
        this.meta,
        { initial: undefined }
      )
      .catch(() => undefined);
  }

  fireEnd(outcome: { state: string; reason: string | null; exitCode: number | null }): void {
    if (this.ended) return;
    this.ended = true;
    // Items a re-wake carried that no later settle took (§4.7 rule 12).
    for (const i of [...this.carried.injections, ...this.startPending])
      this.journalItem(i, "dropped", "session_ended");
    for (const a of this.carried.annotations) this.journalAnnotation(a, "session_ended");
    this.carried = { injections: [], annotations: [] };
    this.startPending = [];
    const hooks = this.engine.select("sessionEnd", this.scope());
    if (hooks.length === 0) return;
    const session = this.sessionFor();
    const facts = { event: "sessionEnd", session, outcome: Object.freeze({ ...outcome }) };
    // The 1.5 s budget bounds the whole chain, so the launcher's exit wait holds.
    this.endDispatch = this.engine
      .runChain(
        "sessionEnd",
        hooks,
        { context: (_a, base) => ({ ...base, ...facts }) },
        this.meta,
        { initial: undefined }
      )
      .catch(() => undefined);
  }

  sweepInbox(): void {
    if (!this.inbox) return;
    let lines: ReturnType<InboxReader["takeRemaining"]>;
    try {
      lines = this.inbox.takeRemaining();
    } catch {
      return;
    }
    for (const l of lines)
      this.journalDrop(
        "responseEnd",
        l.kind === "inject" ? "injectUserTurn" : "annotateTurn",
        l.hookId,
        "session_ended"
      );
  }

  noteDropped(item: { text: string; hookIds: string[] }, reason: string): void {
    for (const hookId of item.hookIds)
      this.engine.journal({
        ...this.meta,
        event: "sessionIdle",
        hookId,
        action: "injectUserTurn",
        decision: "dropped",
        detail: reason,
      });
  }

  noteDelivered(item: { text: string; hookIds: string[] }): void {
    for (const hookId of item.hookIds)
      this.engine.journal({
        ...this.meta,
        event: "sessionIdle",
        hookId,
        action: "injectUserTurn",
        decision: "delivered",
      });
  }

  /* ───────────── helpers ───────────── */

  private sessionFor(turn?: HoldTurnInfo): SessionInfo {
    return Object.freeze({ ...this.session, ...(turn?.shape ? { shape: turn.shape } : {}) });
  }

  private eventOf(source: InjectionSource): HookEventName {
    return source === "proxy" ? "responseEnd" : source;
  }

  private journalItem(i: HoldInjection, decision: "queued" | "dropped", detail?: string): void {
    for (const hookId of i.hookIds)
      this.engine.journal({
        ...this.meta,
        event: this.eventOf(i.source),
        hookId,
        action: "injectUserTurn",
        decision,
        ...(detail ? { detail } : {}),
      });
  }

  private journalAnnotation(a: TurnAnnotation, detail: string): void {
    this.engine.journal({
      ...this.meta,
      event: "responseEnd",
      hookId: a.hookId,
      action: "annotateTurn",
      decision: "dropped",
      detail,
    });
  }

  private journalDrop(event: HookEventName, action: string, hookId: string, detail: string): void {
    this.engine.journal({ ...this.meta, event, hookId, action, decision: "dropped", detail });
  }
}

/**
 * The real binding. `inbox` is a pane child's inbox file, the interactive launcher's
 * in-memory source (`InProcessSink.inbox`), or null. `inboxBoundMs` and `now` exist for
 * tests (H-21b, H-35, H-36); production passes neither, and the inbox bound is §2.3
 * step 5's.
 */
export function createSessionHookBinding(
  engine: HookEngine,
  session: SessionInfo,
  inbox: string | InboxLineSource | null,
  opts: SessionHookBindingOptions = {}
): SessionHookBinding {
  return new EngineSessionHookBinding(engine, session, inbox, opts);
}

/* ───────────── owner without hooks (§2.3 step 1) ───────────── */

let ownerWithoutHooksReported = false;

/**
 * At reap, an owner WITHOUT a binding checks its child's inbox once: a child that
 * loaded hooks this process did not (a config edit after the server started) may
 * have produced injections nobody will deliver. Journals
 * `hook_injection_dropped:owner_without_hooks` and prints one stderr line per
 * process. Returns true when it found any.
 */
export function reportOwnerWithoutHooks(
  inboxPath: string,
  engine: HookEngine | null,
  meta: { model: string; sessionId?: string },
  warn: (line: string) => void = logStderr
): boolean {
  if (!inboxHasPayload(inboxPath)) return false;
  engine?.journal({
    model: meta.model,
    provider: "",
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    event: "sessionEnd",
    hookId: "inbox",
    action: "injectUserTurn",
    decision: "dropped",
    detail: "owner_without_hooks",
  });
  if (!ownerWithoutHooksReported) {
    ownerWithoutHooksReported = true;
    warn(
      "a pane child produced hook injections, but this process loaded no session hooks: restart the MCP server after changing hooks.modules"
    );
  }
  return true;
}

/** Test seam: let the next owner-without-hooks report print its stderr line again. */
export function resetOwnerWithoutHooksReportForTests(): void {
  ownerWithoutHooksReported = false;
}
