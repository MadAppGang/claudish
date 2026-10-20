/**
 * The response-side hook calls of one request, shared by the seam's three
 * places that run them: the closed transform (`toolCall` on held blocks,
 * `responseRewrite` at `message_delta`), the observe tap (observe-mode
 * `toolCall`, warn-mode `responseRewrite`, `responseEnd`), and the
 * non-streaming JSON branch.
 *
 * Each call is one dispatch, run as a hook chain (§4.4.1): a later hook sees
 * the arguments, the response text or the hand-offs earlier hooks produced.
 * Separate dispatches — two tool calls, the tap's `responseEnd` and warn-mode
 * `responseRewrite` — run independently.
 *
 * Every call fails open: the engine journals a throw, a rejection, a timeout or
 * an invalid return and treats it as "no actions", so a broken hook leaves the
 * response as the earlier hooks left it.
 */

import { log } from "../logger.js";
import { type ActionResult, type PlannedAction, applyToolCallActions } from "./actions.js";
import type { JournalMeta } from "./engine.js";
import type { InjectionSink } from "./injection/sinks.js";
import type { ResponseEndAction, ResponseView, ToolCallAction } from "./public.js";
import { type ArmedToolHook, type HookRequestScope, armedFor } from "./request-stage.js";
import { parseToolArgs } from "./response-blocks.js";
import type { RewriteBlock, TextAction, TextRewriteResult } from "./text-rewrite.js";

/** A completed tool call, as the seam assembled it. */
export interface SeamToolCall {
  id: string;
  name: string;
  /** The argument JSON exactly as the model produced it. */
  rawArgs: string;
}

/** Fix-severity rewrite actions, attributed, in chain order. */
export type PlannedTextAction = PlannedAction<TextAction>;

/** The held response after some text actions: what the next rewrite step sees. */
export interface RewrittenResponse {
  view: ResponseView;
  /** What `applyTextActions` did: the blocks, and each action's outcome by index. */
  result: TextRewriteResult<RewriteBlock>;
}

/** The `responseRewrite` chain's outcome: its actions, and the response they produce. */
export interface RewriteOutcome {
  /** Every text action the chain applied, in chain order. */
  planned: PlannedTextAction[];
  /** `after(planned)`: the blocks to emit and each action's outcome, computed once. */
  final: RewrittenResponse;
}

/**
 * One tool call's `toolCall` chain outcome. Its repairs are journaled by exactly one
 * of `delivered()` (journaled `repaired`) and `notDelivered(detail)` (journaled
 * `dropped`, local only), whichever the seam calls first; later calls do nothing.
 */
export interface ToolCallOutcome {
  /** The repaired arguments, or undefined to forward the model's own. */
  args: Record<string, unknown> | undefined;
  delivered(): void;
  notDelivered(detail: string): void;
}

/** The outcome of a call no hook could repair: nothing to journal either way. */
const NO_REPAIR: ToolCallOutcome = Object.freeze({
  args: undefined,
  delivered: () => {},
  notDelivered: () => {},
});

export class SeamHooks {
  constructor(
    readonly scope: HookRequestScope,
    readonly sink: InjectionSink
  ) {}

  private get engine() {
    return this.scope.engine;
  }

  private get plan() {
    return this.scope.response;
  }

  /** True when a fix-severity `toolCall` hook holds blocks of this tool. */
  intercepts(name: string): boolean {
    return this.plan.interceptHooks.some((h) => armedFor(h, name));
  }

  /** True when an observe-mode or warn-severity `toolCall` hook watches this tool. */
  observes(name: string): boolean {
    return this.plan.observeToolHooks.some((h) => armedFor(h, name));
  }

  /**
   * Run the fix-severity `toolCall` hook chain for one held call. Each repair
   * replaces the working arguments the next hook sees in `ctx.tool.args`;
   * `ctx.tool.rawArgs` stays the model's own JSON.
   *
   * The repairs are journaled when the caller knows what reached the client, not
   * at their steps: a flush (hold cap, upstream error, fail-open) or a cancel can
   * send the model's own arguments after a repair was applied, and a `repaired`
   * line (an upload decision) for arguments the client never received is a false
   * negative for the very divergence plan-mode measures. The caller calls exactly
   * one of `delivered()` / `notDelivered()`; `ignored` lines, which describe what a
   * hook decided rather than what was sent, are journaled at once.
   */
  async interceptToolCall(call: SeamToolCall, signal?: AbortSignal): Promise<ToolCallOutcome> {
    const hooks = this.hooksFor(this.plan.interceptHooks, call.name);
    if (hooks.length === 0) return NO_REPAIR;
    const args = parseToolArgs(call.rawArgs);
    if (!args) {
      // Malformed arguments are the recovery layer's concern; no hook sees them.
      log(`[hooks] toolCall ${call.name}: arguments are not a JSON object, hooks not called`);
      return NO_REPAIR;
    }

    const meta: JournalMeta = { ...this.scope.meta, toolName: call.name };
    // The path facts keep the telemetry's categorical `pathRelation`: the
    // plan-mode measurement keys off where the MODEL wrote against where the
    // harness expected it. So `observedPath` is always the model's own path, not
    // the working arguments an earlier hook's repair produced; `argKeys` is what
    // the step saw.
    const modelPath = typeof args.file_path === "string" ? args.file_path : undefined;
    const pathFacts = (current: Record<string, unknown>) => ({
      argKeys: Object.keys(current),
      observedPath: modelPath,
      expectedPath: this.scope.harness.planFilePath,
    });
    const deferred: Array<{
      results: ActionResult<ToolCallAction>[];
      before: Record<string, unknown>;
    }> = [];
    const chain = await this.engine.runChain(
      "toolCall",
      hooks,
      {
        context: (_applicable, base, current) => this.toolContext(base, call, current),
        apply: (current, items) => {
          const out = applyToolCallActions(current, items);
          if (out.results.length > 0) deferred.push({ results: out.results, before: current });
          return {
            state: out.args,
            // journaled by delivered() / notDelivered()
            results: [],
            applied: out.results.map((r) => ({ hookId: r.hookId, action: r.action })),
          };
        },
        // A call a hook saw and left alone is a decision too: a hook that never
        // fires looks identical to a hook that is not needed without the negatives.
        afterStep: (run, before) => {
          if (run.status !== "ok" || run.applied.some((p) => p.action.type === "repairToolArgs")) {
            return;
          }
          this.engine.journal({
            ...meta,
            ...pathFacts(before),
            event: "toolCall",
            hookId: run.applicable.hook.id,
            decision: "ignored",
          });
        },
      },
      meta,
      signal ? { initial: args, signal } : { initial: args }
    );
    const repaired = chain.applied.some((p) => p.action.type === "repairToolArgs");
    if (repaired) log(`[hooks] toolCall ${call.name}: arguments repaired`);

    let settled = false;
    const once = (fn: () => void) => () => {
      if (settled) return;
      settled = true;
      fn();
    };
    return {
      args: repaired ? chain.state : undefined,
      delivered: once(() => {
        for (const { results, before } of deferred) {
          this.engine.recordResults("toolCall", results, meta, (r) => ({
            ...pathFacts(before),
            note: r.action.type === "repairToolArgs" ? r.action.reason : undefined,
          }));
        }
      }),
      notDelivered: (detail: string) =>
        once(() => {
          for (const { results, before } of deferred) {
            for (const r of results) {
              this.engine.journal({
                ...meta,
                ...pathFacts(before),
                event: "toolCall",
                hookId: r.hookId,
                action: r.action.type,
                decision: "dropped",
                detail,
              });
            }
          }
        })(),
    };
  }

  /** Run the observe-mode and warn-severity `toolCall` hook chain for one delivered call. */
  async observeToolCall(call: SeamToolCall, signal?: AbortSignal): Promise<void> {
    const hooks = this.hooksFor(this.plan.observeToolHooks, call.name);
    if (hooks.length === 0) return;
    const args = parseToolArgs(call.rawArgs);
    if (!args) {
      log(`[hooks] toolCall ${call.name}: arguments are not a JSON object, hooks not called`);
      return;
    }
    // Only `warn` can come out of an observing chain: nothing is applied.
    await this.engine.runChain(
      "toolCall",
      hooks,
      { context: (_applicable, base, current) => this.toolContext(base, call, current) },
      { ...this.scope.meta, toolName: call.name },
      signal ? { initial: args, signal } : { initial: args }
    );
  }

  private hooksFor(armed: ReadonlyArray<ArmedToolHook>, name: string) {
    return armed.filter((h) => armedFor(h, name)).map((h) => h.applicable);
  }

  private toolContext(base: object, call: SeamToolCall, args: Record<string, unknown>): object {
    return this.scope.proxyContext(base, "toolCall", {
      // proxyContext hands the hook a deep-frozen copy: `args` is the working state.
      tool: { id: call.id, name: call.name, args, rawArgs: call.rawArgs },
    });
  }

  /**
   * Run the fix-severity `responseRewrite` hook chain; returns every text action
   * it applied, in chain order, for the seam's single `applyTextActions` call.
   * `after` gives the held response once a list of text actions is applied:
   * each hook's `ctx.response` is `after` of everything earlier steps returned.
   */
  async rewrite(
    after: (actions: ReadonlyArray<TextAction>) => RewrittenResponse,
    signal?: AbortSignal
  ): Promise<RewriteOutcome> {
    const hooks = this.plan.rewriteHooks;
    if (hooks.length === 0) return { planned: [], final: after([]) };
    // One evaluation per working state: the step that applied it and the
    // context of the next step share it.
    let memoFor: ReadonlyArray<PlannedTextAction> | null = null;
    let memo: RewrittenResponse | null = null;
    const at = (planned: ReadonlyArray<PlannedTextAction>): RewrittenResponse => {
      if (planned !== memoFor || !memo) {
        memo = after(planned.map((p) => p.action));
        memoFor = planned;
      }
      return memo;
    };

    const chain = await this.engine.runChain(
      "responseRewrite",
      hooks,
      {
        context: (_applicable, base, planned: ReadonlyArray<PlannedTextAction>) =>
          this.scope.proxyContext(base, "responseRewrite", { response: at(planned).view }),
        apply: (planned, items) => {
          const added = items.filter((p): p is PlannedTextAction => p.action.type !== "warn");
          const next = [...planned, ...added];
          // The seam journals the outcomes once, after the final application;
          // `prior` lists the actions that changed the text at this step.
          const changed = new Set(
            at(next)
              .result.applied.filter((a) => a.changed)
              .map((a) => a.index)
          );
          return {
            state: next,
            results: [],
            applied: added.filter((_, i) => changed.has(planned.length + i)),
          };
        },
      },
      this.scope.meta,
      signal ? { initial: [], signal } : { initial: [] }
    );
    // The final application is the one the last step already computed (memoised):
    // the seam emits it rather than applying every action again.
    return { planned: [...chain.state], final: at(chain.state) };
  }

  /** Journal what `applyTextActions` did with each planned action. */
  recordRewrite(
    planned: ReadonlyArray<PlannedTextAction>,
    result: Pick<TextRewriteResult<RewriteBlock>, "applied" | "rejected">
  ): void {
    const results = [
      ...result.applied.map((a) => ({
        ...(planned[a.index] as PlannedTextAction),
        decision: a.changed ? ("matched" as const) : ("ignored" as const),
        ...(a.changed ? {} : { detail: "no_match" }),
      })),
      ...result.rejected.map((r) => ({
        ...(planned[r.index] as PlannedTextAction),
        decision: "invalid" as const,
        detail: r.reason,
      })),
    ];
    this.engine.recordResults("responseRewrite", results, this.scope.meta);
  }

  /** Journal one rewrite-hook outcome that did not come from an action (cap, citations). */
  noteRewriteInvalid(detail: string): void {
    for (const a of this.plan.rewriteHooks) {
      this.engine.journal({
        ...this.scope.meta,
        event: "responseRewrite",
        hookId: a.hook.id,
        decision: "invalid",
        detail,
      });
    }
  }

  /** Journal one intercept outcome that did not come from an action (the hold cap). */
  noteInterceptInvalid(detail: string): void {
    for (const a of this.plan.interceptHooks) {
      this.engine.journal({
        ...this.scope.meta,
        event: "toolCall",
        hookId: a.applicable.hook.id,
        decision: "invalid",
        detail,
      });
    }
  }

  /** Warn-severity `responseRewrite` hooks, as a chain over the delivered response. */
  async observeRewrite(view: ResponseView): Promise<void> {
    const hooks = this.plan.observeRewriteHooks;
    if (hooks.length === 0) return;
    await this.engine.runChain(
      "responseRewrite",
      hooks,
      {
        context: (_applicable, base) =>
          this.scope.proxyContext(base, "responseRewrite", { response: view }),
      },
      this.scope.meta,
      { initial: undefined }
    );
  }

  /** True when a `responseEnd` hook applies (and so the inbox gets `stop` and `end`). */
  get hasEndHooks(): boolean {
    return this.plan.endHooks.length > 0;
  }

  /**
   * Run the `responseEnd` hook chain over the final response, routing each
   * step's actions at the step, in chain order: `injectSystemNote` to this
   * Claude session's next request, `injectUserTurn` and `annotateTurn` to the
   * sink. A later hook sees what the sink accepted in `ctx.prior`. Never rejects.
   */
  async end(view: ResponseView, req: string): Promise<void> {
    const hooks = this.plan.endHooks;
    if (hooks.length === 0) return;
    try {
      await this.engine.runChain(
        "responseEnd",
        hooks,
        {
          context: (_applicable, base) =>
            this.scope.proxyContext(base, "responseEnd", { response: view }),
          // NOT atomic, unlike the other appliers: routing an action is delivering it
          // (a queued note, an inbox line), which cannot be taken back. So a throw is
          // contained per action: that action is journaled `error` (`apply_failed`), the
          // ones before it stay delivered and listed in `prior`, and the rest still go.
          apply: (state, items) => {
            const results: ActionResult<ResponseEndAction>[] = [];
            const applied: PlannedAction<ResponseEndAction>[] = [];
            for (const item of items) {
              let r: ActionResult<ResponseEndAction> | null;
              try {
                r = this.route(item, req);
              } catch (err) {
                this.engine.journal({
                  ...this.scope.meta,
                  event: "responseEnd",
                  hookId: item.hookId,
                  action: item.action.type,
                  decision: "error",
                  detail: `apply_failed:${err instanceof Error ? err.message : String(err)}`,
                });
                continue;
              }
              if (!r) continue;
              results.push(r);
              if (r.decision === "queued") applied.push(item);
            }
            return { state, results, applied };
          },
        },
        this.scope.meta,
        { initial: undefined }
      );
    } catch (err) {
      log(`[hooks] responseEnd failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Hand one `responseEnd` action on, and say what became of it. */
  private route(
    item: PlannedAction<ResponseEndAction>,
    req: string
  ): ActionResult<ResponseEndAction> | null {
    const { hookId, action } = item;
    switch (action.type) {
      case "injectSystemNote":
        if (!this.scope.sessionId) return { ...item, decision: "dropped", detail: "no_session" };
        this.engine.queueNote(this.scope.sessionId, hookId, action.text);
        return { ...item, decision: "queued", detail: "next request" };
      case "injectUserTurn": {
        const outcome = this.sink.inject(req, hookId, action.text);
        return outcome === "queued"
          ? { ...item, decision: "queued" }
          : { ...item, decision: "dropped", detail: outcome };
      }
      case "annotateTurn": {
        const outcome = this.sink.annotate(req, hookId, action.key, action.value);
        return outcome === "queued"
          ? { ...item, decision: "queued" }
          : { ...item, decision: "dropped", detail: outcome };
      }
      default:
        return null;
    }
  }
}
