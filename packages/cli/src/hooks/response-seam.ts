/**
 * The response seam: the `withHooks` decorator at the `/v1/messages` call site.
 *
 * `withHooks(handler)` wraps the RESOLVED handler, inside the advisor:
 * `withAdvisor(withHooks(await getHandlerForRequest(model)))`. It is never
 * applied inside `getHandlerForRequest` and never to a FallbackHandler
 * candidate, so the `instanceof ComposedHandler` checks in fallback-handler.ts
 * and the `instanceof NativeHandler` check in count_tokens are untouched. Sitting
 * inside the advisor means the advisor's tee scans exactly what the client
 * receives.
 *
 * It puts the per-request `RequestHooks` on the Hono context, which is the only
 * thing that makes a terminal handler run the request stage. After the inner
 * handler returns: no scope or a non-2xx response → `abandon()` and the response
 * unchanged; otherwise `commit()` and `applyResponseSeam`.
 *
 * Every route's output converges here as Claude SSE (or the JSON message a
 * `stream:false` request gets), so one seam covers every parser. Three stages,
 * in a fixed order, each present only when an applicable hook needs it:
 *
 * 1. the closed transform (`intercept` or `buffer`, seam-transform.ts);
 * 2. the raw `response` hooks (the unsafe tier, raw.ts): each drains its input
 *    into a recorder, so no hook can stall the stream before it, and a
 *    replacement is held whole and forwarded only once it completed;
 * 3. the observe tap (seam-tap.ts), which writes the inbox `stop` before the
 *    `message_stop` chunk is enqueued and runs every observe-type consumer —
 *    `responseEnd` included — on exactly the bytes the client received.
 *
 * When no stage is needed the seam returns the SAME `Response` object, so a
 * request no hook claimed streams exactly as it did before hooks existed.
 */

import type { Context } from "hono";
import type { ModelHandler } from "../handlers/types.js";
import { log } from "../logger.js";
import type { HookEngine } from "./engine.js";
import { type InjectionSink, UnavailableSink } from "./injection/sinks.js";
import {
  type HookRequestScope,
  RequestHooks,
  attachRequestHooks,
  hookScopeOf,
} from "./request-stage.js";
import { messageBlock, messageView, rewrittenView } from "./response-blocks.js";
import { SeamHooks, type ToolCallOutcome } from "./seam-hooks.js";
import { EndLine, newRequestId, observeTap, runResponseConsumers } from "./seam-tap.js";
import { type ClosedMode, closedTransform } from "./seam-transform.js";
import { type RewriteBlock, applyTextActions } from "./text-rewrite.js";

/** The decorator `withHooks` returns. Exported for `instanceof` checks. */
export class HooksHandler implements ModelHandler {
  constructor(
    readonly inner: ModelHandler,
    readonly hooks: RequestHooks
  ) {}

  // biome-ignore lint/suspicious/noExplicitAny: the Messages API payload is untyped at this layer, as in ModelHandler
  async handle(c: Context, payload: any): Promise<Response> {
    attachRequestHooks(c, this.hooks);
    let response: Response;
    try {
      response = await this.inner.handle(c, payload);
    } catch (err) {
      hookScopeOf(c)?.abandon();
      throw err;
    }
    const scope = hookScopeOf(c);
    if (!scope) return response;
    if (!response.ok) {
      scope.abandon();
      return response;
    }
    scope.commit();
    return applyResponseSeam(response, scope, { sink: this.hooks.sink });
  }

  /** Forwarded: `AdvisorSwapHandler.shutdown()` calls it on whatever it wraps. */
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** Wrap a resolved handler so its requests run hooks. Idempotent. */
export function withHooks(inner: ModelHandler, engine: HookEngine): ModelHandler {
  if (inner instanceof HooksHandler) return inner;
  return new HooksHandler(inner, new RequestHooks(engine));
}

export interface SeamOptions {
  /** Where `responseEnd` injections and the inbox lines go. Default: none available. */
  sink?: InjectionSink;
  /** The id this response's inbox lines carry. Default: a fresh UUID. */
  req?: string;
  /** Test seams for the closed transform's keepalive and hold cap. */
  pingIntervalMs?: number;
  holdCapBytes?: number;
}

/** The seam's stages for one request, decided before the response starts. */
export interface SeamPlan {
  mode: "none" | ClosedMode;
  /** Applicable raw `response` hooks. */
  raw: number;
  tap: boolean;
}

/** The strictest closed mode an armed hook needs, and whether the tap is needed. */
export function planSeam(scope: HookRequestScope): SeamPlan {
  const p = scope.response;
  const mode =
    p.rewriteHooks.length > 0 ? "buffer" : p.interceptHooks.length > 0 ? "intercept" : "none";
  const tap =
    p.endHooks.length > 0 || p.observeToolHooks.length > 0 || p.observeRewriteHooks.length > 0;
  return { mode, raw: scope.raw.responseHookCount, tap };
}

/**
 * Assemble the response stages for an accepted (2xx) response. With no stage
 * needed it returns the SAME object. Fails open: a seam that cannot be built
 * returns the response as the handler produced it.
 */
export async function applyResponseSeam(
  response: Response,
  scope: HookRequestScope,
  opts: SeamOptions = {}
): Promise<Response> {
  const plan = planSeam(scope);
  log(`[hooks] seam mode=${plan.mode} raw=${plan.raw} tap=${plan.tap ? 1 : 0}`);
  if ((plan.mode === "none" && plan.raw === 0 && !plan.tap) || !response.body) return response;

  const hooks = new SeamHooks(scope, opts.sink ?? new UnavailableSink());
  const req = opts.req ?? newRequestId();
  const rawOpts = { pingIntervalMs: opts.pingIntervalMs, capBytes: opts.holdCapBytes };
  if (isJson(response)) {
    // fail open here too. The branch reads the body; the untouched copy is what
    // the client gets when that read or a stage throws, so an upstream body error
    // reaches the reader as it would with no hook, and never rejects out of the seam.
    const original = response.clone();
    try {
      return await jsonBranch(response, hooks, plan, req, (r) =>
        scope.raw.responseStages(r, rawOpts)
      );
    } catch (err) {
      log(`[hooks] seam not applied: ${err instanceof Error ? err.message : err}`);
      return original;
    }
  }

  try {
    let body: ReadableStream<Uint8Array> = response.body;
    if (plan.mode !== "none") {
      body = closedTransform(body, {
        mode: plan.mode,
        hooks,
        pingIntervalMs: opts.pingIntervalMs,
        holdCapBytes: opts.holdCapBytes,
      });
    }
    if (plan.raw > 0) {
      const staged = scope.raw.responseStages(
        new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
        rawOpts
      );
      body = staged.body ?? body;
    }
    if (plan.tap) body = observeTap(body, hooks, req);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: withoutLength(response.headers),
    });
  } catch (err) {
    log(`[hooks] seam not applied: ${err instanceof Error ? err.message : err}`);
    return response;
  }
}

function isJson(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return type.includes("application/json");
}

function withoutLength(headers: Headers): Headers {
  const out = new Headers(headers);
  out.delete("content-length");
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: a Messages API message is untyped at this layer
type Json = any;

/** A text block carrying citations is never rewritten (it is re-emitted as is). */
function isCitedText(block: Json): boolean {
  return Array.isArray(block?.citations) && block.citations.length > 0;
}

/**
 * The closed part of the JSON branch. Returns the body to forward and the
 * message it holds (null when the body is not a Messages API message, which
 * passes unchanged). Fails open: on a throw the original text goes.
 */
async function closedJson(
  text: string,
  hooks: SeamHooks,
  plan: SeamPlan
): Promise<{ text: string; message: Json }> {
  let message: Json;
  try {
    message = JSON.parse(text);
  } catch {
    return { text, message: null };
  }
  if (!message || !Array.isArray(message.content)) return { text, message: null };
  if (plan.mode === "none") return { text, message };

  // Repairs are journaled once it is known whether the rebuilt body goes out.
  const outcomes: ToolCallOutcome[] = [];
  try {
    // Each tool call is its own dispatch (§4.4.1 rule 9): their chains run
    // side by side, and the blocks keep their order.
    let content: Json[] = await Promise.all(
      (message.content as Json[]).map(async (block) => {
        if (
          block?.type !== "tool_use" ||
          typeof block.name !== "string" ||
          !hooks.intercepts(block.name)
        ) {
          return block;
        }
        const outcome = await hooks.interceptToolCall({
          id: String(block.id ?? ""),
          name: block.name,
          rawArgs: JSON.stringify(block.input ?? {}),
        });
        outcomes.push(outcome);
        return outcome.args ? { ...block, input: outcome.args } : block;
      })
    );
    if (plan.mode === "buffer") {
      const blocks: RewriteBlock[] = content.map((b) => ({
        type: typeof b?.type === "string" ? b.type : "unknown",
        ...(b?.type === "text" && typeof b.text === "string" ? { text: b.text } : {}),
        ...(isCitedText(b) ? { locked: true } : {}),
      }));
      // The whole content[] is the held region: each rewrite step sees it as the
      // earlier steps' text actions left it.
      const repaired = content;
      const stopReason = typeof message.stop_reason === "string" ? message.stop_reason : null;
      const { planned, final } = await hooks.rewrite((actions) => {
        const result = applyTextActions(blocks, actions);
        return {
          view: rewrittenView([], result.blocks, (i) => messageBlock(repaired[i]), stopReason),
          result,
        };
      });
      if (planned.length > 0 && blocks.some((b) => b.locked)) hooks.noteRewriteInvalid("citations");
      const result = final.result;
      hooks.recordRewrite(planned, result);
      const original = content;
      content = result.blocks.map((out) => {
        const text = (out.block as { text?: string }).text ?? "";
        if (out.source === null) return { type: "text", text };
        return out.changed ? { ...original[out.source], text } : original[out.source];
      });
    }
    const next = { ...message, content };
    const body = JSON.stringify(next);
    for (const o of outcomes) o.delivered();
    return { text: body, message: next };
  } catch (err) {
    log(`[hooks] seam JSON branch failed open: ${err instanceof Error ? err.message : err}`);
    for (const o of outcomes) o.notDelivered("failed_open");
    return { text, message };
  }
}

/**
 * The non-streaming branch (§5.4): the message is parsed once, the `toolCall`
 * hook chain repairs `tool_use.input`, the `responseRewrite` chain applies the
 * same text actions over `content[]` (the whole array being the held region),
 * and the body is re-serialised with the original status and headers. The raw `response`
 * stage then sees that body as one unit. The inbox `stop` is written before the
 * Response is returned; `responseEnd` runs after, on the final message.
 */
async function jsonBranch(
  response: Response,
  hooks: SeamHooks,
  plan: SeamPlan,
  req: string,
  rawStages: (r: Response) => Response
): Promise<Response> {
  const text = await response.text();
  const rebuild = (body: string) =>
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: withoutLength(response.headers),
    });

  const closed = await closedJson(text, hooks, plan);
  let out = rebuild(closed.text);
  if (plan.raw > 0) out = rawStages(out);
  if (!plan.tap) return out;

  // The tap needs the final bytes: a raw replacement is what the client gets.
  const finalText = plan.raw > 0 ? await out.text() : closed.text;
  let message: Json = closed.message;
  if (plan.raw > 0) {
    try {
      message = JSON.parse(finalText);
    } catch {
      // A replacement that is not a message: the consumers see what they can.
    }
  }
  if (!message || !Array.isArray(message.content)) return rebuild(finalText);
  out = rebuild(finalText);

  const end = new EndLine(hooks, req);
  if (hooks.hasEndHooks) {
    try {
      hooks.sink.stop(req);
    } catch (err) {
      log(`[hooks] inbox stop failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  const view = messageView(message);
  for (const block of message.content as Json[]) {
    if (
      block?.type === "tool_use" &&
      typeof block.name === "string" &&
      hooks.observes(block.name)
    ) {
      void hooks
        .observeToolCall({
          id: String(block.id ?? ""),
          name: block.name,
          rawArgs: JSON.stringify(block.input ?? {}),
        })
        .catch(() => {});
    }
  }
  runResponseConsumers(hooks, view, req, end);
  return out;
}
