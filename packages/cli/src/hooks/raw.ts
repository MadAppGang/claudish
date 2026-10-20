/**
 * The raw (unsafe) tier: hooks that receive provider-format objects and the
 * response itself, at the points the old `MiddlewareManager` had.
 *
 * Containment is TRANSACTIONAL (FR-8: a raw hook's failure is contained the
 * same way a throwing closed hook's is). A raw hook works on copies, and its
 * work reaches the request or the client only when its call succeeds:
 *
 * - `providerRequest` runs on `structuredClone` copies of `claudeRequest`,
 *   `messages` and `tools`. They replace the pipeline's objects only when the
 *   call returns, or its promise resolves, within its timeout. A throw, a
 *   rejection or a timeout discards them, so a late mutation from an abandoned
 *   call lands on copies nobody reads.
 * - `providerChunk` is synchronous by contract and runs on a clone of the
 *   parsed provider event. A normal, non-thenable return COMMITS the clone by
 *   identity: `RawStreamTap.chunk()` returns it and the parser reads that
 *   object from then on, deletions included. A thenable return is an invalid
 *   invocation — an `async` body that throws after mutating still returns a
 *   promise, so committing on return would apply the mutation — and discards
 *   the clone; a rejection handler is attached so a rejection is journaled and
 *   never becomes an `unhandledRejection`.
 * - `providerStreamEnd` sees only the hook's own per-stream `metadata`, so
 *   there is nothing to undo; it is bounded by its timeout.
 * - `response`: claudish drains the stage's input itself into a
 *   `ResponseRecorder`. The hook's `ctx.response` is a replay of it, read at
 *   the hook's own pace, and the fallback is a second replay, so a hook that
 *   ignores its view stalls nothing. A replacement is read WHOLE and forwarded
 *   only once it closes cleanly within its deadline; in every other case the
 *   original goes, from its first byte. The client never sees a partial
 *   replacement or an error the hook caused.
 *
 * Each raw stage is a hook chain (§4.4.1), the same execution model as the
 * closed tier: its hooks run one at a time in effective order, each on what the
 * previous committed, and a stage runs after the closed chain of its point
 * (`providerRequest` after the closed `request` chain and stage B; `response`
 * after the closed transform). `providerRequest` and `providerStreamEnd` share
 * an event budget: a step's timeout is its own or the budget left, whichever is
 * shorter, and a hook reached with none left is journaled `skipped`.
 * `providerChunk` is synchronous and `response` keeps per-step deadlines, so
 * neither has a budget.
 *
 * At `warn` severity a raw hook runs on copies that are never committed, so the
 * next raw step starts from the uncommitted state, and a returned replacement is
 * read to its end and discarded.
 *
 * Containment isolates failure; it does not validate what an unsafe hook
 * deliberately produces. That is what the `unsafe` label means.
 */

import { log } from "../logger.js";
import {
  EVENT_BUDGETS,
  EVENT_BUDGET_DETAIL,
  type HookEngine,
  type JournalInput,
  type JournalMeta,
  type StepTimeout,
  stepTimeout,
  timeoutFor,
} from "./engine.js";
import { runInHookScope } from "./output-capture.js";
import type {
  RawMiddleware,
  RawProviderChunkContext,
  RawProviderRequestContext,
  RawProviderStreamEndContext,
  RawResponseContext,
  RequestFacts,
  RouteInfo,
} from "./public.js";
import type { ApplicableHook, HookEventName, UpstreamFacts } from "./registry.js";
import { HOLD_CAP_BYTES, PING_FRAME } from "./seam-transform.js";

export type RawStage = "providerRequest" | "providerChunk" | "providerStreamEnd" | "response";

const RAW_STAGES: ReadonlyArray<RawStage> = [
  "providerRequest",
  "providerChunk",
  "providerStreamEnd",
  "response",
];

/** What the parsers call at the old middleware sites. */
export interface RawStreamTap {
  /**
   * Runs the applicable `providerChunk` hooks synchronously in effective order,
   * each on a `structuredClone` of the previous result. Returns the object the
   * parser must read from now on: the last committed clone, or `chunk` itself
   * when nothing was committed. Never throws.
   */
  chunk<T>(chunk: T, deltaOf: (c: T) => unknown): T;
  /** `providerStreamEnd`, in effective order, each bounded by its timeout. Never rejects. */
  streamEnd(): Promise<void>;
}

/** The provider-format request `providerRequest` hooks see and may replace. */
export interface ProviderRequestState {
  // biome-ignore lint/suspicious/noExplicitAny: the Claude-format request is untyped at this layer
  claudeRequest: any;
  // biome-ignore lint/suspicious/noExplicitAny: provider format
  messages: any[];
  // biome-ignore lint/suspicious/noExplicitAny: provider format
  tools: any[];
}

export interface ResponseStageOptions {
  /** Interval of the stage's own pings while it holds a replacement. Default 1,000 ms. */
  pingIntervalMs?: number;
  /** Recorded original plus held replacement above this falls back to the original. Default 8 MiB. */
  capBytes?: number;
}

/* ───────────── helpers ───────────── */

/**
 * The reader surface this module uses. Annotated structurally, not as
 * `ReadableStreamDefaultReader`: bun-types and node:stream/web declare that
 * global differently (`readMany`), and a package that typechecks this file
 * under node's stream types (macos-bridge) rejects the bun one.
 */
type ByteReader = {
  read(): Promise<{ done: true; value?: unknown } | { done: false; value: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

type Bounded =
  | { status: "ok"; value: unknown }
  | { status: "error"; err: unknown }
  | { status: "timeout" };

/** Call `fn` and settle within `ms`. A synchronous throw is an `error`, never a rejection. */
function callBounded(fn: () => unknown, ms: number): Promise<Bounded> {
  let value: unknown;
  try {
    value = fn();
  } catch (err) {
    return Promise.resolve({ status: "error", err });
  }
  if (!isThenable(value)) return Promise.resolve({ status: "ok", value });
  return new Promise<Bounded>((resolveCall) => {
    const timer = setTimeout(() => resolveCall({ status: "timeout" }), ms);
    Promise.resolve(value).then(
      (v) => {
        clearTimeout(timer);
        resolveCall({ status: "ok", value: v });
      },
      (err: unknown) => {
        clearTimeout(timer);
        resolveCall({ status: "error", err });
      }
    );
  });
}

function rawOf(applicable: ApplicableHook): RawMiddleware {
  return ((applicable.hook.def as { raw?: RawMiddleware }).raw ?? {}) as RawMiddleware;
}

/* ───────────── stats ───────────── */

/**
 * `middleware_names` for stats: the `statsName` of every BUILT-IN raw hook that
 * applies to the route. User hooks never appear, so the OTLP `llm.middleware`
 * attribute does not change for users with hooks. Empty when no engine is
 * loaded in this process. `upstream` is the route's catalog facts, when the
 * handler has a catalog connection.
 */
export function statsNames(
  engine: HookEngine | null | undefined,
  route: RouteInfo,
  upstream?: UpstreamFacts
): string[] {
  if (!engine) return [];
  const names: string[] = [];
  for (const stage of RAW_STAGES) {
    for (const { hook } of engine.registry.applicable(`raw.${stage}`, { route, upstream })) {
      if (hook.source === "builtin" && hook.statsName && !names.includes(hook.statsName)) {
        names.push(hook.statsName);
      }
    }
  }
  return names;
}

/* ───────────── one request's raw tier ───────────── */

/**
 * The raw tier for one upstream attempt. Owned by the attempt's
 * `HookRequestScope`; the terminal handler runs `providerRequest` and opens a
 * stream tap per parser, and the response seam runs the `response` stage.
 *
 * Every request a raw hook touches journals ONE line per hook (`decision:
 * "raw"`, its stages listed) and a debug-log line. A warn-severity run is
 * journaled `warned` once per hook and stage.
 */
export class RawRequest {
  private readonly touched = new Set<string>();
  private readonly warnedStages = new Set<string>();

  constructor(
    readonly engine: HookEngine,
    readonly route: RouteInfo,
    readonly meta: JournalMeta,
    /** The request as response-side hooks see it. */
    readonly facts: RequestFacts,
    /** Catalog facts about the route's upstream, when the handler has a catalog connection. */
    readonly upstream?: UpstreamFacts
  ) {}

  /** Applicable hooks for one stage, in effective order, minus breaker-disabled ones. */
  hooks(stage: RawStage): ApplicableHook[] {
    return this.engine.select(`raw.${stage}`, { route: this.route, upstream: this.upstream });
  }

  /** How many raw `response` hooks apply (the seam log's `raw=<n>`). */
  get responseHookCount(): number {
    return this.hooks("response").length;
  }

  /* ───────────── journaling ───────────── */

  journal(input: Omit<JournalInput, keyof JournalMeta | "localOnly">): void {
    this.engine.journal({ ...this.meta, ...input, localOnly: true });
  }

  private fail(
    applicable: ApplicableHook,
    stage: RawStage,
    decision: "error" | "timeout" | "invalid",
    detail: string,
    countsFailure = true
  ): void {
    const event: HookEventName = `raw.${stage}`;
    this.journal({ event, hookId: applicable.hook.id, decision, detail: `${stage}: ${detail}` });
    log(`[hooks] raw ${applicable.hook.id} ${stage} ${decision}: ${detail}`);
    if (countsFailure) this.engine.noteFailure(applicable.hook.id, this.meta, event);
  }

  /**
   * A step timed out: on its own timeout (counts), or on a budget clipped beyond the
   * margin (does not; `stepTimeout` in engine.ts holds the rule).
   */
  private timedOut(applicable: ApplicableHook, stage: RawStage, timeout: StepTimeout): void {
    if (timeout.clipped) this.fail(applicable, stage, "timeout", EVENT_BUDGET_DETAIL, false);
    else this.fail(applicable, stage, "timeout", `${timeout.ms} ms`);
  }

  /** The stage's budget was spent before this hook's step: not called, not counted. */
  private skip(applicable: ApplicableHook, stage: RawStage): void {
    this.journal({
      event: `raw.${stage}`,
      hookId: applicable.hook.id,
      decision: "skipped",
      detail: `${stage}: ${EVENT_BUDGET_DETAIL}`,
    });
    log(`[hooks] raw ${applicable.hook.id} ${stage} skipped: ${EVENT_BUDGET_DETAIL}`);
  }

  /** The step timeout of a budgeted stage whose chain started at `startedAt`; null = skip. */
  stepTimeoutFor(
    applicable: ApplicableHook,
    stage: "providerRequest" | "providerStreamEnd",
    startedAt: number
  ): StepTimeout | null {
    const event: HookEventName = `raw.${stage}`;
    const budget = EVENT_BUDGETS[event];
    const remaining = budget === null ? null : startedAt + budget - Date.now();
    return stepTimeout(applicable.hook.def, event, remaining);
  }

  private succeed(applicable: ApplicableHook, stage: RawStage): void {
    this.engine.noteSuccess(applicable.hook.id);
    const id = applicable.hook.id;
    if (applicable.severity === "warn") {
      const key = `${id}\0${stage}`;
      if (this.warnedStages.has(key)) return;
      this.warnedStages.add(key);
      this.journal({
        event: `raw.${stage}`,
        hookId: id,
        decision: "warned",
        detail: `${stage}: severity warn, not committed`,
      });
      return;
    }
    if (this.touched.has(id)) return;
    this.touched.add(id);
    const stages = applicable.hook.events
      .filter((e) => e.startsWith("raw."))
      .map((e) => e.slice(4))
      .join(",");
    this.journal({
      event: `raw.${stage}`,
      hookId: id,
      decision: "raw",
      detail: `stages: ${stages}`,
    });
    log(
      `[hooks] raw ${id} touched ${this.route.provider}/${this.route.modelId} (stages ${stages})`
    );
  }

  /* ───────────── providerRequest ───────────── */

  /**
   * Run the `providerRequest` chain: the hooks in effective order, each on
   * clones of the previous result, within the stage's budget. Returns the state
   * the pipeline continues with: the input itself when nothing was committed.
   * Never rejects.
   */
  async providerRequest(input: ProviderRequestState): Promise<ProviderRequestState> {
    let current = input;
    const startedAt = Date.now();
    for (const applicable of this.hooks("providerRequest")) {
      if (this.engine.isDisabled(applicable.hook.id)) continue;
      const fn = rawOf(applicable).providerRequest;
      if (typeof fn !== "function") continue;
      const timeout = this.stepTimeoutFor(applicable, "providerRequest", startedAt);
      if (!timeout) {
        this.skip(applicable, "providerRequest");
        continue;
      }

      let ctx: RawProviderRequestContext;
      try {
        ctx = {
          hookId: applicable.hook.id,
          route: this.route,
          claudeRequest: structuredClone(current.claudeRequest),
          messages: structuredClone(current.messages),
          tools: structuredClone(current.tools),
        };
      } catch (err) {
        this.fail(
          applicable,
          "providerRequest",
          "error",
          `request not cloneable: ${errorText(err)}`
        );
        continue;
      }

      const raw = rawOf(applicable);
      const outcome = await callBounded(
        () => runInHookScope(applicable.hook.id, () => fn.call(raw, ctx)),
        timeout.ms
      );
      if (outcome.status === "timeout") {
        this.timedOut(applicable, "providerRequest", timeout);
        continue;
      }
      if (outcome.status === "error") {
        this.fail(applicable, "providerRequest", "error", errorText(outcome.err));
        continue;
      }
      // A hook may replace the fields, not only edit them; it may not replace
      // them with something the pipeline cannot carry on with.
      if (
        !ctx.claudeRequest ||
        typeof ctx.claudeRequest !== "object" ||
        !Array.isArray(ctx.messages) ||
        !Array.isArray(ctx.tools)
      ) {
        this.fail(
          applicable,
          "providerRequest",
          "invalid",
          "claudeRequest, messages or tools replaced by a non-object"
        );
        continue;
      }
      this.succeed(applicable, "providerRequest");
      if (applicable.severity !== "fix") continue;
      current = { claudeRequest: ctx.claudeRequest, messages: ctx.messages, tools: ctx.tools };
    }
    return current;
  }

  /* ───────────── stream tap ───────────── */

  /**
   * A tap for one parser stream, or undefined when no `providerChunk` or
   * `providerStreamEnd` hook applies (the parser then does nothing extra).
   */
  streamTap(): RawStreamTap | undefined {
    const chunkHooks = this.hooks("providerChunk");
    const endHooks = this.hooks("providerStreamEnd");
    if (chunkHooks.length === 0 && endHooks.length === 0) return undefined;
    return new StreamTap(this, chunkHooks, endHooks);
  }

  /** @internal the tap reports through these. */
  reportFail(
    applicable: ApplicableHook,
    stage: RawStage,
    decision: "error" | "timeout" | "invalid",
    detail: string
  ): void {
    this.fail(applicable, stage, decision, detail);
  }

  /** @internal */
  reportSuccess(applicable: ApplicableHook, stage: RawStage): void {
    this.succeed(applicable, stage);
  }

  /** @internal */
  reportTimeout(applicable: ApplicableHook, stage: RawStage, timeout: StepTimeout): void {
    this.timedOut(applicable, stage, timeout);
  }

  /** @internal */
  reportSkip(applicable: ApplicableHook, stage: RawStage): void {
    this.skip(applicable, stage);
  }

  /* ───────────── response ───────────── */

  /**
   * Run the `response` stage: each applicable hook in effective order, each
   * over the previous stage's output. Returns `response` itself when no hook
   * applies.
   */
  responseStages(response: Response, opts: ResponseStageOptions = {}): Response {
    let current = response;
    for (const applicable of this.hooks("response")) {
      if (this.engine.isDisabled(applicable.hook.id)) continue;
      current = responseStage(current, applicable, this, opts);
    }
    return current;
  }
}

/* ───────────── RawStreamTap ───────────── */

class StreamTap implements RawStreamTap {
  /** Per hook, per stream; shared across that hook's calls; never cloned. */
  private readonly metadata = new Map<string, Map<string, unknown>>();
  private ended = false;

  constructor(
    private readonly raw: RawRequest,
    private readonly chunkHooks: ApplicableHook[],
    private readonly endHooks: ApplicableHook[]
  ) {}

  private metadataFor(hookId: string): Map<string, unknown> {
    let m = this.metadata.get(hookId);
    if (!m) {
      m = new Map();
      this.metadata.set(hookId, m);
    }
    return m;
  }

  chunk<T>(chunk: T, deltaOf: (c: T) => unknown): T {
    let current = chunk;
    for (const applicable of this.chunkHooks) {
      const id = applicable.hook.id;
      if (this.raw.engine.isDisabled(id)) continue;
      const raw = rawOf(applicable);
      const fn = raw.providerChunk;
      if (typeof fn !== "function") continue;

      let ctx: RawProviderChunkContext;
      try {
        const clone = structuredClone(current);
        ctx = {
          hookId: id,
          route: this.raw.route,
          chunk: clone,
          delta: deltaOf(clone),
          metadata: this.metadataFor(id),
        };
      } catch (err) {
        this.raw.reportFail(
          applicable,
          "providerChunk",
          "error",
          `chunk not cloneable: ${errorText(err)}`
        );
        continue;
      }

      let returned: unknown;
      try {
        returned = runInHookScope(id, () => fn.call(raw, ctx));
      } catch (err) {
        this.raw.reportFail(applicable, "providerChunk", "error", errorText(err));
        continue;
      }
      if (isThenable(returned)) {
        // Whatever the promise later does, this clone is never committed.
        this.raw.reportFail(applicable, "providerChunk", "invalid", "async_return");
        try {
          Promise.resolve(returned).then(undefined, (err: unknown) => {
            this.raw.journal({
              event: "raw.providerChunk",
              hookId: id,
              decision: "error",
              detail: `providerChunk: ${errorText(err)}`,
            });
          });
        } catch {
          // A hostile thenable whose `then` throws: nothing left to attach to.
        }
        continue;
      }
      this.raw.reportSuccess(applicable, "providerChunk");
      if (applicable.severity !== "fix") continue;
      current = ctx.chunk as T;
    }
    return current;
  }

  async streamEnd(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const startedAt = Date.now();
    for (const applicable of this.endHooks) {
      const id = applicable.hook.id;
      if (this.raw.engine.isDisabled(id)) continue;
      const raw = rawOf(applicable);
      const fn = raw.providerStreamEnd;
      if (typeof fn !== "function") continue;
      const timeout = this.raw.stepTimeoutFor(applicable, "providerStreamEnd", startedAt);
      if (!timeout) {
        this.raw.reportSkip(applicable, "providerStreamEnd");
        continue;
      }
      const ctx: RawProviderStreamEndContext = {
        hookId: id,
        route: this.raw.route,
        metadata: this.metadataFor(id),
      };
      const outcome = await callBounded(
        () => runInHookScope(id, () => fn.call(raw, ctx)),
        timeout.ms
      );
      if (outcome.status === "timeout") {
        this.raw.reportTimeout(applicable, "providerStreamEnd", timeout);
      } else if (outcome.status === "error") {
        this.raw.reportFail(applicable, "providerStreamEnd", "error", errorText(outcome.err));
      } else {
        this.raw.reportSuccess(applicable, "providerStreamEnd");
      }
    }
  }
}

/* ───────────── ResponseRecorder ───────────── */

interface Cursor {
  pos: number;
  detached: boolean;
}

/** A replay of the recorder from byte 0, and the way to let go of it. */
export interface Replay {
  stream: ReadableStream<Uint8Array>;
  /** Stop reading: the replay closes and its chunks may be freed. Idempotent. */
  detach(): void;
}

/**
 * Reads a body to its end at upstream speed, whatever its readers do, and
 * serves any number of replays from byte 0. A replay never slows the recorder,
 * and cancelling one cancels neither the recorder nor another replay.
 *
 * Every chunk is retained until `stopRetaining()`; after that a chunk is freed
 * once every live replay has read past it.
 */
export class ResponseRecorder {
  private chunks: Uint8Array[] = [];
  /** Index (in the whole recording) of `chunks[0]`. */
  private base = 0;
  private retainAll = true;
  private readonly cursors = new Set<Cursor>();
  private wake: Array<() => void> = [];
  private readonly reader: ByteReader;

  /** Bytes read so far. */
  totalBytes = 0;
  done = false;
  failed = false;
  failure: unknown = undefined;
  /** Resolves when the input ends, errors or is cancelled. Never rejects. */
  readonly ended: Promise<void>;

  constructor(
    body: ReadableStream<Uint8Array>,
    private readonly onChunk: () => void = () => {}
  ) {
    this.reader = body.getReader();
    this.ended = this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const r = await this.reader.read();
        if (r.done) break;
        this.chunks.push(r.value);
        this.totalBytes += r.value.byteLength;
        this.release();
        this.notify();
        this.onChunk();
      }
    } catch (err) {
      this.failed = true;
      this.failure = err;
    } finally {
      this.done = true;
      this.notify();
    }
  }

  private notify(): void {
    const waiting = this.wake;
    this.wake = [];
    for (const w of waiting) w();
  }

  private next(): Promise<void> {
    return new Promise((r) => this.wake.push(r));
  }

  /**
   * A new replay from byte 0. Must be created before `stopRetaining()`. `copy` hands
   * out a copy of each chunk instead of the retained bytes: a hook's view must, since a
   * hook may edit what it reads in place, and the retained bytes are the fallback the
   * client gets when that hook fails or is not committed.
   */
  replay(opts: { copy?: boolean } = {}): Replay {
    const cursor: Cursor = { pos: this.base, detached: false };
    this.cursors.add(cursor);
    const detach = () => {
      if (cursor.detached) return;
      cursor.detached = true;
      this.cursors.delete(cursor);
      this.release();
      this.notify();
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          for (;;) {
            if (cursor.detached) {
              controller.close();
              return;
            }
            const idx = cursor.pos - this.base;
            if (idx < this.chunks.length) {
              const chunk = this.chunks[idx] as Uint8Array;
              cursor.pos++;
              this.release();
              // `new Uint8Array(chunk)` allocates: `chunk.slice()` would not on a Node
              // Buffer (a hook may return one), whose `slice` is a view of the same bytes.
              controller.enqueue(opts.copy ? new Uint8Array(chunk) : chunk);
              return;
            }
            if (this.done) {
              detach();
              if (this.failed) controller.error(this.failure);
              else controller.close();
              return;
            }
            await this.next();
          }
        },
        cancel: () => detach(),
      },
      { highWaterMark: 0 }
    );
    return { stream, detach };
  }

  /** From now on, free each chunk once every live replay has read past it. */
  stopRetaining(): void {
    this.retainAll = false;
    this.release();
  }

  private release(): void {
    if (this.retainAll) return;
    let min = this.base + this.chunks.length;
    for (const c of this.cursors) min = Math.min(min, c.pos);
    const drop = min - this.base;
    if (drop <= 0) return;
    this.chunks = this.chunks.slice(drop);
    this.base = min;
  }

  /** Cancel the input (and so the upstream). */
  cancel(reason?: unknown): void {
    this.reader.cancel(reason).catch(() => {});
  }
}

/* ───────────── one response hook ───────────── */

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("application/json");
}

function sleep(ms: number): { promise: Promise<void>; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((r) => {
    timer = setTimeout(r, Math.max(0, ms));
  });
  return { promise, clear: () => clearTimeout(timer) };
}

type StageDecision = { kind: "original" } | { kind: "replacement"; chunks: Uint8Array[] };

/**
 * One raw `response` hook over one input Response (§6). The returned Response
 * streams the original as soon as the hook returns nothing, holds a returned
 * replacement whole (emitting pings meanwhile on an SSE response) and forwards
 * it only once it closed cleanly within its deadline, and otherwise forwards
 * the original from its first byte.
 */
function responseStage(
  input: Response,
  applicable: ApplicableHook,
  raw: RawRequest,
  opts: ResponseStageOptions
): Response {
  if (!input.body) return input;
  const id = applicable.hook.id;
  const json = isJsonResponse(input);
  const pingIntervalMs = opts.pingIntervalMs ?? 1_000;
  const capBytes = opts.capBytes ?? HOLD_CAP_BYTES;
  const timeoutMs = timeoutFor(applicable.hook.def, "raw.response");
  const encoder = new TextEncoder();
  const ping = encoder.encode(PING_FRAME);

  let decision: StageDecision | null = null;
  let holding = false;
  let heldBytes = 0;
  let cancelled = false;
  let fallback: Replay | null = null;
  let fallbackReader: ByteReader | null = null;
  let replacementReader: ByteReader | null = null;

  // Wakes the client-side pull when the state changes.
  let changed: () => void = () => {};
  let changedPromise = new Promise<void>((r) => {
    changed = r;
  });
  const signal = () => {
    const fire = changed;
    changedPromise = new Promise<void>((r) => {
      changed = r;
    });
    fire();
  };

  const recorder = new ResponseRecorder(input.body, () => {
    if (decision === null && recorder.totalBytes + heldBytes > capBytes) {
      raw.reportFail(applicable, "response", "invalid", "buffer_cap");
      decideOriginal();
    }
  });
  const view = recorder.replay({ copy: true });

  function cancelReplacement(): void {
    const reader = replacementReader;
    replacementReader = null;
    reader?.cancel().catch(() => {});
  }

  /**
   * The client gets the original. The hook's view ends here too, unless `keepView`: a
   * warn replacement may be built from `ctx.response`, and it is read against the view
   * to its end before `run()` detaches it.
   */
  function decideOriginal(keepView = false): void {
    if (decision !== null) return;
    if (!cancelled) {
      fallback = recorder.replay();
      fallbackReader = fallback.stream.getReader();
    }
    if (!keepView) view.detach();
    cancelReplacement();
    recorder.stopRetaining();
    decision = { kind: "original" };
    signal();
  }

  function decideReplacement(chunks: Uint8Array[]): void {
    if (decision !== null) return;
    view.detach();
    recorder.stopRetaining();
    decision = { kind: "replacement", chunks };
    signal();
  }

  /**
   * Read a replacement to its end within the deadline: this hook's timeout
   * after the LATER of the call's return (now) and the end of the original,
   * which claudish reads itself, so that end never waits on a reader. `keep`
   * holds the bytes for the client (fix); otherwise they are discarded (warn).
   */
  async function readWhole(
    replacement: Response,
    keep: boolean
  ): Promise<
    | { ok: true; chunks: Uint8Array[] }
    | { ok: false; decision: "timeout" | "error" | "invalid"; detail: string }
  > {
    const chunks: Uint8Array[] = [];
    if (!replacement.body) return { ok: true, chunks };
    const reader = replacement.body.getReader();
    replacementReader = reader;
    let finished = false;
    let deadlineTimer: { promise: Promise<void>; clear(): void } | null = null;
    const timedOut = recorder.ended.then(() => {
      if (finished) return new Promise<never>(() => {});
      deadlineTimer = sleep(timeoutMs);
      return deadlineTimer.promise.then(() => "timeout" as const);
    });
    try {
      for (;;) {
        if (cancelled || (keep && decision !== null)) {
          return { ok: false, decision: "invalid", detail: "superseded" };
        }
        const r = await Promise.race([reader.read(), timedOut]);
        if (r === "timeout") {
          return {
            ok: false,
            decision: "timeout",
            detail: `replacement did not close within ${timeoutMs} ms`,
          };
        }
        if (r.done) return { ok: true, chunks };
        if (!keep) continue;
        chunks.push(r.value);
        heldBytes += r.value.byteLength;
        if (recorder.totalBytes + heldBytes > capBytes) {
          return { ok: false, decision: "invalid", detail: "buffer_cap" };
        }
      }
    } catch (err) {
      return { ok: false, decision: "error", detail: `replacement errored: ${errorText(err)}` };
    } finally {
      finished = true;
      (deadlineTimer as { clear(): void } | null)?.clear();
    }
  }

  async function run(): Promise<void> {
    const ctx: RawResponseContext = {
      hookId: id,
      route: raw.route,
      request: raw.facts,
      response: new Response(view.stream, {
        status: input.status,
        statusText: input.statusText,
        headers: input.headers,
      }),
    };
    const rawHook = rawOf(applicable);
    const fn = rawHook.response;
    const outcome =
      typeof fn === "function"
        ? await callBounded(() => runInHookScope(id, () => fn.call(rawHook, ctx)), timeoutMs)
        : ({ status: "ok", value: undefined } as Bounded);

    const returned = outcome.status === "ok" ? outcome.value : undefined;
    const isResponse = returned instanceof Response;

    if (decision !== null || cancelled) {
      // Decided while the call ran (the hold cap, or the client went away).
      if (isResponse) (returned as Response).body?.cancel().catch(() => {});
      return;
    }
    if (outcome.status === "timeout") {
      raw.reportFail(applicable, "response", "timeout", `${timeoutMs} ms`);
      decideOriginal();
      return;
    }
    if (outcome.status === "error") {
      raw.reportFail(applicable, "response", "error", errorText(outcome.err));
      decideOriginal();
      return;
    }
    if (returned === undefined || returned === null) {
      raw.reportSuccess(applicable, "response");
      decideOriginal();
      return;
    }
    if (!isResponse) {
      raw.reportFail(applicable, "response", "invalid", "returned a value that is not a Response");
      decideOriginal();
      return;
    }

    if (applicable.severity !== "fix") {
      // Read to its end and discarded; the original goes at once. The view stays
      // readable until then: the replacement may stream it.
      decideOriginal(true);
      const read = await readWhole(returned as Response, false).finally(() => view.detach());
      if (read.ok) raw.reportSuccess(applicable, "response");
      else {
        cancelReplacement();
        raw.reportFail(applicable, "response", read.decision, read.detail);
      }
      return;
    }

    holding = true;
    signal();
    const read = await readWhole(returned as Response, true);
    if (decision !== null || cancelled) {
      cancelReplacement();
      return;
    }
    if (read.ok) {
      raw.reportSuccess(applicable, "response");
      decideReplacement(read.chunks);
      return;
    }
    cancelReplacement();
    raw.reportFail(applicable, "response", read.decision, read.detail);
    decideOriginal();
  }

  let replacementIndex = 0;
  let lastPingAt = Date.now();
  let pingedSinceHold = false;

  const out = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        for (;;) {
          const d = decision as StageDecision | null;
          if (d?.kind === "replacement") {
            if (replacementIndex < d.chunks.length) {
              controller.enqueue(d.chunks[replacementIndex++] as Uint8Array);
              return;
            }
            controller.close();
            return;
          }
          if (d?.kind === "original") {
            try {
              const r = await (fallbackReader as ByteReader).read();
              if (r.done) controller.close();
              else controller.enqueue(r.value);
            } catch (err) {
              controller.error(err);
            }
            return;
          }
          // Undecided: wait for a decision, emitting keepalive pings on SSE.
          const wait = changedPromise;
          if (json) {
            await wait;
            continue;
          }
          const due = holding && !pingedSinceHold ? 0 : lastPingAt + pingIntervalMs - Date.now();
          const timer = sleep(due);
          const which = await Promise.race([
            wait.then(() => "changed" as const),
            timer.promise.then(() => "ping" as const),
          ]);
          timer.clear();
          if (which === "ping" && decision === null) {
            lastPingAt = Date.now();
            if (holding) pingedSinceHold = true;
            controller.enqueue(ping);
            return;
          }
        }
      },
      cancel: (reason) => {
        cancelled = true;
        recorder.cancel(reason);
        view.detach();
        cancelReplacement();
        (fallbackReader as ByteReader | null)?.cancel(reason).catch(() => {});
        (fallback as Replay | null)?.detach();
        signal();
      },
    },
    { highWaterMark: 0 }
  );

  void run().catch((err) => {
    // run() isolates every hook failure itself; this guards the stage.
    log(`[hooks] raw ${id} response stage failed open: ${errorText(err)}`);
    decideOriginal();
  });

  const headers = new Headers(input.headers);
  headers.delete("content-length");
  return new Response(out, { status: input.status, statusText: input.statusText, headers });
}
