import { describe, expect, it } from "bun:test";
import type { Context } from "hono";
import type { ModelHandler } from "../handlers/types.js";
import { HookEngine } from "./engine.js";
import { HookRegistry } from "./registry.js";
import { hookScopeOf, requestHooksOf } from "./request-stage.js";
import { HooksHandler, withHooks } from "./response-seam.js";

const SESSION = "ce7d9e68-f907-444f-9680-69ec3048ce9c";

function engine() {
  return new HookEngine({
    registry: new HookRegistry([], [], undefined),
    config: {},
    hostMode: "other",
    journalSink: () => {},
    warn: () => {},
    drainTelemetryOutbox: false,
  });
}

function fakeContext(): Context {
  const vars = new Map<string, unknown>();
  return {
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
  } as unknown as Context;
}

function payload() {
  return {
    model: "glm-5",
    system: "base",
    messages: [{ role: "user", content: "hi" }],
    metadata: {
      user_id: JSON.stringify({ device_id: "d", account_uuid: "", session_id: SESSION }),
    },
  };
}

/** A terminal handler that begins one attempt (as ComposedHandler does) and answers `status`. */
function terminal(status: number, onHandle?: () => void): ModelHandler & { shutdowns: number } {
  return {
    shutdowns: 0,
    async handle(c: Context, body: unknown) {
      onHandle?.();
      const hooks = requestHooksOf(c);
      await hooks?.beginAttempt(c, {
        claudeRequest: structuredClone(body) as Record<string, unknown>,
        route: { modelId: "glm-5", provider: "zai", native: false },
        model: "glm-5",
        stream: true,
      });
      return new Response("data: {}\n\n", { status });
    },
    async shutdown() {
      this.shutdowns++;
    },
  };
}

describe("withHooks", () => {
  it("returns the inner Response object itself in mode none (the identity case)", async () => {
    const inner: ModelHandler = {
      handle: async () => sentinel,
      shutdown: async () => {},
    };
    const sentinel = new Response("data: x\n\n", { status: 200 });
    // Even with a scope: begin one through a terminal that keeps the same Response.
    const c = fakeContext();
    const wrapped = withHooks(
      {
        async handle(ctx, body) {
          await requestHooksOf(ctx)?.beginAttempt(ctx, {
            claudeRequest: structuredClone(body),
            route: { modelId: "m", provider: "p", native: false },
            model: "m",
            stream: true,
          });
          return inner.handle(ctx, body);
        },
        shutdown: async () => {},
      },
      engine()
    );

    expect(await wrapped.handle(c, payload())).toBe(sentinel);
    expect(hookScopeOf(c)?.settled).toBe("committed");
  });

  it("forwards shutdown() to the inner handler exactly once", async () => {
    const inner = terminal(200);
    await withHooks(inner, engine()).shutdown();
    expect(inner.shutdowns).toBe(1);
  });

  it("is idempotent", () => {
    const e = engine();
    const once = withHooks(terminal(200), e);
    expect(withHooks(once, e)).toBe(once);
    expect(once).toBeInstanceOf(HooksHandler);
  });

  it("commits on 2xx: a pending note is consumed", async () => {
    const e = engine();
    e.queueNote(SESSION, "hook:m/j", "NOTE");
    await withHooks(terminal(200), e).handle(fakeContext(), payload());
    expect(e.peekNotes(SESSION)).toEqual([]);
  });

  it("abandons on non-2xx: a pending note stays queued for the next request", async () => {
    const e = engine();
    e.queueNote(SESSION, "hook:m/j", "NOTE");
    const c = fakeContext();
    const res = await withHooks(terminal(529), e).handle(c, payload());
    expect(res.status).toBe(529);
    expect(hookScopeOf(c)?.settled).toBe("abandoned");
    expect(e.peekNotes(SESSION).map((n) => n.text)).toEqual(["NOTE"]);
  });

  it("abandons and rethrows when the inner handler throws", async () => {
    const e = engine();
    e.queueNote(SESSION, "hook:m/j", "NOTE");
    const c = fakeContext();
    const inner: ModelHandler = {
      async handle(ctx, body) {
        await requestHooksOf(ctx)?.beginAttempt(ctx, {
          claudeRequest: structuredClone(body),
          route: { modelId: "m", provider: "p", native: false },
          model: "m",
          stream: true,
        });
        throw new Error("upstream exploded");
      },
      shutdown: async () => {},
    };
    await expect(withHooks(inner, e).handle(c, payload())).rejects.toThrow("upstream exploded");
    expect(hookScopeOf(c)?.settled).toBe("abandoned");
    expect(e.peekNotes(SESSION)).toHaveLength(1);
  });

  it("passes the response through untouched when no terminal began a scope", async () => {
    const sentinel = new Response("{}", { status: 200 });
    const res = await withHooks(
      { handle: async () => sentinel, shutdown: async () => {} },
      engine()
    ).handle(fakeContext(), payload());
    expect(res).toBe(sentinel);
  });
});
