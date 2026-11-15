/**
 * `withCompaction`: claudish's context compaction on whatever handler the
 * proxy resolved.
 *
 * The proxy places it as `withAdvisor(withCompaction(withRequestHooks(h)))`,
 * on the resolved handler, once per request. So it runs on native, monitor and
 * foreign routes alike, after the advisor's rewrite of its own tool_results
 * (which it skips), and before the hooks, which see the compacted body. It
 * mutates the parsed body in place before any converter reads it; the native
 * forward then sends the body's own serialisation (`bodyToForward`).
 *
 * The session key is `session_id` from `metadata.user_id`
 * (`extractSessionId`). A request without one, or with an id that is not safe
 * as a folder name, passes through untouched.
 */

import type { Context } from "hono";
import {
  getAdvisorCall,
  rewriteAdvisorToolResults,
} from "../handlers/native-handler-advisor.js";
import type { ModelHandler } from "../handlers/types.js";
import { extractSessionId } from "../hooks/harness.js";
import { log } from "../logger.js";
import type { CompactionRuntime } from "./runtime.js";
import { isSafeSessionId } from "./store.js";

declare module "hono" {
  interface ContextVariableMap {
    /** Set by `withCompaction` once it has processed this request. */
    compactionHandled: boolean;
  }
}

/**
 * Wrap `inner` so its requests are compacted. Returns `inner` itself when no
 * runtime is given (compaction off) and never wraps a handler twice.
 */
export function withCompaction(
  inner: ModelHandler,
  runtime: CompactionRuntime | undefined,
  routedModel?: string
): ModelHandler {
  if (!runtime) return inner;
  if (inner instanceof CompactionHandler) return inner;
  return new CompactionHandler(inner, runtime, routedModel);
}

/** The wrapper `withCompaction` returns. Exported for `instanceof` checks. */
export class CompactionHandler implements ModelHandler {
  constructor(
    readonly inner: ModelHandler,
    private readonly runtime: CompactionRuntime,
    /** The model spec the proxy routes this request to; see `compactRequest`. */
    private readonly routedModel?: string
  ) {}

  async handle(c: Context, payload: unknown): Promise<Response> {
    if (c.get("compactionHandled") === true) return this.inner.handle(c, payload);
    c.set("compactionHandled", true);
    await compactRequest(this.runtime, payload, this.routedModel);
    return this.inner.handle(c, payload);
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }
}

/** The session folder key of a request, or undefined when it may not be compacted. */
export function compactionSessionOf(payload: unknown): string | undefined {
  const id = extractSessionId(payload);
  return isSafeSessionId(id) ? id : undefined;
}

/**
 * Compact one `/v1/messages` body in place: the tool-output pass first, then
 * the history pass, which hashes the messages as the first pass left them.
 * Never rejects: a fault leaves the body as the decisions recorded so far
 * made it. The history pass never waits for a summary.
 *
 * `routedModel` is the model spec the proxy routes the request to (a role
 * mapping or `--model` can send a `claude-*` request to another model); the
 * history limit is its context window. Absent, the body's own `model` is used.
 */
export async function compactRequest(
  runtime: CompactionRuntime,
  payload: unknown,
  routedModel?: string
): Promise<void> {
  const sessionId = compactionSessionOf(payload);
  if (!sessionId) return;
  if (runtime.settings.toolOutputs.enabled) {
    try {
      const summary = await runtime.toolOutputs.compact(payload, sessionId);
      if (summary.compressed > 0 || summary.keptOriginal > 0 || summary.replaced > 0) {
        log(
          `[compaction] session ${sessionId}: replaced=${summary.replaced} compressed=${summary.compressed} kept-original=${summary.keptOriginal}`
        );
      }
    } catch (err) {
      log(`[compaction] tool outputs skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (runtime.settings.history.enabled) {
    try {
      const pass = runtime.history.compact(payload, sessionId, routedModel);
      if (pass.applied !== "none" || pass.precomputeStarted) {
        log(
          `[compaction] session ${sessionId}: history ${pass.applied}${pass.boundary !== undefined ? ` at ${pass.boundary}` : ""}, ~${pass.estimate ?? "?"} of ${pass.limit ?? "?"} tokens${pass.precomputeStarted ? ", summary started" : ""}`
        );
      }
    } catch (err) {
      log(`[compaction] history skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Apply the recorded forms to a `count_tokens` body in place, with no model
 * call, in the order `/v1/messages` applies them: the advisor's results
 * already delivered (its own tool_results, which the history hashes cover),
 * the tool-output forms, then a recorded history swap. So Claude Code's count
 * matches what `/v1/messages` sends. Never throws.
 */
export function applyStoredForms(runtime: CompactionRuntime, payload: unknown): void {
  const sessionId = compactionSessionOf(payload);
  if (!sessionId) return;
  try {
    // Stored results only: a call with no delivered result is left as it is,
    // and no panel runs.
    rewriteAdvisorToolResults(
      payload as Record<string, unknown>,
      (id) => getAdvisorCall(id, sessionId)?.result,
      sessionId
    );
  } catch (err) {
    log(
      `[compaction] count_tokens advisor replay skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (runtime.settings.toolOutputs.enabled) {
    try {
      runtime.toolOutputs.replay(payload, sessionId);
    } catch (err) {
      log(
        `[compaction] count_tokens replay skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (runtime.settings.history.enabled) {
    try {
      runtime.history.replay(payload, sessionId);
    } catch (err) {
      log(
        `[compaction] count_tokens history replay skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
