/**
 * The hook engine: runs one event's hooks and turns what they return into
 * attributed, severity-gated, validated actions.
 *
 * Execution: every applicable hook's handler is invoked CONCURRENTLY, each with
 * its own timeout and `AbortSignal`, against a shallow-frozen context, inside
 * the hook output scope. Results are collected and returned in EFFECTIVE ORDER;
 * the appliers (actions.ts, text-rewrite.ts) then apply them sequentially.
 * Closed handlers cannot see each other's results, so concurrency changes no
 * outcome — it only bounds latency to the slowest hook.
 *
 * Failure posture: fail open, always. A throw, a rejection, a timeout or an
 * invalid return value is journaled and treated as "no actions"; an invalid
 * action is journaled and ignored. Five consecutive failures of one hook disable
 * it for the process (journal `disabled`, one stderr line); any success resets
 * the count. There is no fail-closed option: a throwing hook never breaks a
 * request or a session.
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
  // Shared across hooks: they run concurrently from one start, so a per-hook
  // bound of 1,500 ms bounds the whole dispatch to 1,500 ms.
  sessionEnd: { default: 1_500, max: 1_500 },
  "raw.providerRequest": { default: 1_000, max: 5_000 },
  // Synchronous; no timeout applies.
  "raw.providerChunk": { default: 0, max: 0 },
  "raw.providerStreamEnd": { default: 1_000, max: 5_000 },
  "raw.response": { default: 1_000, max: 5_000 },
};

/** A hook's timeout for an event: its own `timeoutMs` clamped to the event's maximum. */
export function timeoutFor(def: HookDefinition, event: HookEventName): number {
  const bounds = EVENT_TIMEOUTS[event];
  const own = def.timeoutMs;
  if (typeof own !== "number" || !Number.isFinite(own) || own <= 0) return bounds.default;
  return Math.min(own, bounds.max);
}

/** Consecutive failures that disable a hook for the process. */
export const BREAKER_THRESHOLD = 5;

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
  signal: AbortSignal;
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
}

export type HookRunStatus = "ok" | "timeout" | "error" | "invalid" | "aborted";

/** One hook's run within a dispatch. */
export interface HookRun<A extends HookAction> {
  applicable: ApplicableHook;
  status: HookRunStatus;
  /** Every valid action the hook returned, `warn` included, before the severity gate. */
  returned: A[];
}

export interface RunResult<A extends HookAction> {
  runs: Array<HookRun<A>>;
  /** Valid, non-`warn` actions of fix-severity hooks, in effective order: what to apply. */
  apply: Array<PlannedAction<A>>;
}

export interface RunOptions {
  /** Aborting it aborts every hook's signal; unfinished hooks end `aborted`, unjournaled. */
  signal?: AbortSignal;
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

  /* ───────────── dispatch ───────────── */

  /**
   * Run one closed event's handlers concurrently and collect their actions.
   *
   * `context` builds the event's full context from the engine's base parts;
   * the result is shallow-frozen before the handler sees it.
   */
  async run<E extends ClosedEvent>(
    event: E,
    hooks: ReadonlyArray<ApplicableHook>,
    context: (applicable: ApplicableHook, base: BaseContextParts) => object,
    meta: JournalMeta,
    opts: RunOptions = {}
  ): Promise<RunResult<EventActions[E]>> {
    const runs = await Promise.all(
      hooks.map((applicable) => this.runOne(event, applicable, context, meta, opts.signal))
    );

    const apply: Array<PlannedAction<EventActions[E]>> = [];
    for (const run of runs) {
      const { hook, severity } = run.applicable;
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
        apply.push({ hookId: hook.id, action });
      }
    }
    return { runs, apply };
  }

  private runOne<E extends ClosedEvent>(
    event: E,
    applicable: ApplicableHook,
    context: (applicable: ApplicableHook, base: BaseContextParts) => object,
    meta: JournalMeta,
    parent: AbortSignal | undefined
  ): Promise<HookRun<EventActions[E]>> {
    const { hook, severity } = applicable;
    const done = (status: HookRunStatus, returned: Array<EventActions[E]> = []) => ({
      applicable,
      status,
      returned,
    });

    const handler = handlerOf(hook.def, event);
    if (!handler) return Promise.resolve(done("ok"));
    if (parent?.aborted) return Promise.resolve(done("aborted"));

    const controller = new AbortController();
    const timeoutMs = timeoutFor(hook.def, event);
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

      const timer = setTimeout(() => {
        controller.abort(new Error(`hook ${hook.id} timed out after ${timeoutMs} ms`));
        this.journal({
          ...meta,
          event,
          hookId: hook.id,
          decision: "timeout",
          detail: `${timeoutMs} ms`,
        });
        this.noteFailure(hook.id, meta, event);
        finish(done("timeout"));
      }, timeoutMs);

      const base: BaseContextParts = {
        hookId: hook.id,
        severity,
        log: (message: string) => log(`[hook ${hook.id}] ${message}`),
        signal: controller.signal,
      };

      let value: unknown;
      try {
        const ctx = Object.freeze(context(applicable, base));
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
          this.noteSuccess(hook.id);
          finish(done("ok", result as Array<EventActions[E]>));
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
   */
  private collect(
    event: ClosedEvent,
    hookId: string,
    returned: unknown,
    meta: JournalMeta,
    observe: boolean
  ): HookAction[] | null {
    if (returned === undefined || returned === null) return [];
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
    for (const value of returned) {
      const checked = validateAction(event, value, { observe });
      if (checked.ok) {
        valid.push(checked.action);
        continue;
      }
      const type = (value as { type?: unknown } | null)?.type;
      this.journal({
        ...meta,
        event,
        hookId,
        action: typeof type === "string" ? type : undefined,
        decision: "invalid",
        detail: checked.reason,
      });
    }
    return valid;
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

    if (upload && isUploadDecision(input.decision)) {
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
