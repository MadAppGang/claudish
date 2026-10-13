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
 * This revision implements closed mode `none` only: the seam returns the inner
 * `Response` object itself. The `intercept` and `buffer` modes, the raw
 * `response` stage and the observe tap come with the response half.
 */

import type { Context } from "hono";
import type { ModelHandler } from "../handlers/types.js";
import { log } from "../logger.js";
import type { HookEngine } from "./engine.js";
import {
  type HookRequestScope,
  RequestHooks,
  attachRequestHooks,
  hookScopeOf,
} from "./request-stage.js";

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
    return applyResponseSeam(response, scope);
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

/**
 * Assemble the response stages for an accepted response. With no stage needed
 * — the only case this revision builds — it returns the SAME object, so
 * streaming takes exactly today's path.
 */
export function applyResponseSeam(response: Response, _scope: HookRequestScope): Response {
  log("[hooks] seam mode=none raw=0 tap=0");
  return response;
}
