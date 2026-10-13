/**
 * The response-side hook calls of one request, shared by the seam's three
 * places that run them: the closed transform (`toolCall` on held blocks,
 * `responseRewrite` at `message_delta`), the observe tap (observe-mode
 * `toolCall`, warn-mode `responseRewrite`, `responseEnd`), and the
 * non-streaming JSON branch.
 *
 * Every call fails open: the engine journals a throw, a rejection, a timeout or
 * an invalid return and treats it as "no actions", so a broken hook leaves the
 * response exactly as the model produced it.
 */

import { log } from "../logger.js";
import { type PlannedAction, applyToolCallActions } from "./actions.js";
import type { JournalMeta } from "./engine.js";
import type { InjectionSink } from "./injection/sinks.js";
import type { ResponseView, RewriteAction } from "./public.js";
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

/** Fix-severity rewrite actions, attributed, in effective order. */
export type PlannedTextAction = PlannedAction<TextAction>;

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
   * Run the fix-severity `toolCall` hooks for one held call. Returns the
   * replacement arguments, or undefined to forward the model's own.
   */
  async interceptToolCall(
    call: SeamToolCall,
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | undefined> {
    return this.runToolCall(call, this.plan.interceptHooks, true, signal);
  }

  /** Run the observe-mode and warn-severity `toolCall` hooks for one delivered call. */
  async observeToolCall(call: SeamToolCall, signal?: AbortSignal): Promise<void> {
    await this.runToolCall(call, this.plan.observeToolHooks, false, signal);
  }

  private async runToolCall(
    call: SeamToolCall,
    armed: ReadonlyArray<ArmedToolHook>,
    apply: boolean,
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | undefined> {
    const hooks = armed.filter((h) => armedFor(h, call.name)).map((h) => h.applicable);
    if (hooks.length === 0) return undefined;
    const args = parseToolArgs(call.rawArgs);
    if (!args) {
      // Malformed arguments are the recovery layer's concern; no hook sees them.
      log(`[hooks] toolCall ${call.name}: arguments are not a JSON object, hooks not called`);
      return undefined;
    }

    const meta: JournalMeta = { ...this.scope.meta, toolName: call.name };
    const run = await this.engine.run(
      "toolCall",
      hooks,
      (_applicable, base) =>
        this.scope.proxyContext(base, "toolCall", {
          tool: {
            id: call.id,
            name: call.name,
            args: structuredClone(args),
            rawArgs: call.rawArgs,
          },
        }),
      meta,
      signal ? { signal } : {}
    );
    if (!apply) return undefined;

    // The path facts keep the telemetry's categorical `pathRelation`: the
    // plan-mode measurement keys off where a write landed against where the
    // harness expected it.
    const pathFacts = {
      argKeys: Object.keys(args),
      observedPath: typeof args.file_path === "string" ? args.file_path : undefined,
      expectedPath: this.scope.harness.planFilePath,
    };
    const applied = applyToolCallActions(run.apply);
    this.engine.recordResults("toolCall", applied.results, meta, (r) => ({
      ...pathFacts,
      note: r.action.type === "repairToolArgs" ? r.action.reason : undefined,
    }));
    // A call a hook saw and left alone is a decision too: a hook that never
    // fires looks identical to a hook that is not needed without the negatives.
    if (applied.args === undefined) {
      for (const r of run.runs) {
        if (r.status !== "ok") continue;
        this.engine.journal({
          ...meta,
          ...pathFacts,
          event: "toolCall",
          hookId: r.applicable.hook.id,
          decision: "ignored",
        });
      }
    } else {
      log(`[hooks] toolCall ${call.name}: arguments repaired`);
    }
    return applied.args;
  }

  /** Run the fix-severity `responseRewrite` hooks; returns their text actions. */
  async rewrite(view: ResponseView, signal?: AbortSignal): Promise<PlannedTextAction[]> {
    const hooks = this.plan.rewriteHooks;
    if (hooks.length === 0) return [];
    const run = await this.engine.run(
      "responseRewrite",
      hooks,
      (_applicable, base) => this.scope.proxyContext(base, "responseRewrite", { response: view }),
      this.scope.meta,
      signal ? { signal } : {}
    );
    return run.apply.filter(
      (p): p is PlannedTextAction => (p.action as RewriteAction).type !== "warn"
    );
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

  /** Warn-severity `responseRewrite` hooks, evaluated against the delivered response. */
  async observeRewrite(view: ResponseView): Promise<void> {
    const hooks = this.plan.observeRewriteHooks;
    if (hooks.length === 0) return;
    await this.engine.run(
      "responseRewrite",
      hooks,
      (_applicable, base) => this.scope.proxyContext(base, "responseRewrite", { response: view }),
      this.scope.meta
    );
  }

  /** True when a `responseEnd` hook applies (and so the inbox gets `stop` and `end`). */
  get hasEndHooks(): boolean {
    return this.plan.endHooks.length > 0;
  }

  /**
   * Run `responseEnd` over the final response and route its actions:
   * `injectSystemNote` to this Claude session's next request, `injectUserTurn`
   * and `annotateTurn` to the sink. Never rejects.
   */
  async end(view: ResponseView, req: string): Promise<void> {
    const hooks = this.plan.endHooks;
    if (hooks.length === 0) return;
    const meta = this.scope.meta;
    try {
      const run = await this.engine.run(
        "responseEnd",
        hooks,
        (_applicable, base) => this.scope.proxyContext(base, "responseEnd", { response: view }),
        meta
      );
      for (const { hookId, action } of run.apply) {
        const base = { ...meta, event: "responseEnd" as const, hookId, action: action.type };
        switch (action.type) {
          case "injectSystemNote":
            if (this.scope.sessionId) {
              this.engine.queueNote(this.scope.sessionId, hookId, action.text);
              this.engine.journal({ ...base, decision: "queued", detail: "next request" });
            } else {
              this.engine.journal({ ...base, decision: "dropped", detail: "no_session" });
            }
            break;
          case "injectUserTurn": {
            const outcome = this.sink.inject(req, hookId, action.text);
            this.engine.journal({
              ...base,
              decision: outcome === "queued" ? "queued" : "dropped",
              ...(outcome === "queued" ? {} : { detail: outcome }),
            });
            break;
          }
          case "annotateTurn": {
            const outcome = this.sink.annotate(req, hookId, action.key, action.value);
            this.engine.journal({
              ...base,
              decision: outcome === "queued" ? "queued" : "dropped",
              ...(outcome === "queued" ? {} : { detail: outcome }),
            });
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      log(`[hooks] responseEnd failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
