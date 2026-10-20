/**
 * The hook request stage inside NativeHandler: both stages at the top of
 * handle(), on a copy-on-write view of the payload, only under `withHooks`.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { BUILTIN_HOOKS } from "../hooks/builtins/index.js";
import { HookEngine } from "../hooks/engine.js";
import { type HookDefinition, type RouteInfo, act } from "../hooks/public.js";
import { HookRegistry, type UserHookInput } from "../hooks/registry.js";
import { withHooks } from "../hooks/response-seam.js";
import { NativeHandler } from "./native-handler.js";

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function captureFetch(): { bodies: any[] } {
  const bodies: any[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: unknown,
    init?: RequestInit
  ) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ type: "message", content: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return { bodies };
}

function fakeContext(): any {
  const vars = new Map<string, unknown>();
  return {
    req: { header: () => ({ "x-api-key": "sk-test" }) },
    json: (body: unknown, init?: { status?: number } | number) =>
      new Response(JSON.stringify(body), {
        status: typeof init === "number" ? init : (init?.status ?? 200),
      }),
    body: (stream: unknown, init?: ResponseInit) => new Response(stream as BodyInit, init),
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
  };
}

function engineWith(users: UserHookInput[]) {
  return new HookEngine({
    registry: new HookRegistry(BUILTIN_HOOKS, users, undefined),
    config: {},
    hostMode: "other",
    journalSink: () => {},
    warn: () => {},
    drainTelemetryOutbox: false,
  });
}

function userHook(id: string, def: Omit<HookDefinition, "apiVersion" | "id">) {
  return {
    id: `hook:m/${id}`,
    module: "/hooks/m.ts",
    moduleIndex: 0,
    exportIndex: 0,
    def: { apiVersion: 1, id, ...def } as HookDefinition,
  } satisfies UserHookInput;
}

function payload(): any {
  return {
    model: "claude-opus-4-8",
    max_tokens: 16,
    system: [{ type: "text", text: "SessionStart hook additional context: banner" }],
    messages: [
      {
        role: "user",
        content: "You should create your plan at /tmp/p/assigned.md using the Write tool.",
      },
    ],
    tools: [{ name: "ExitPlanMode", description: "Exit.", input_schema: { type: "object" } }],
  };
}

describe("NativeHandler request stage", () => {
  it("applies native-scoped user actions on a copy-on-write view; the inbound payload is untouched", async () => {
    const { bodies } = captureFetch();
    let route: RouteInfo | undefined;
    const engine = engineWith([
      userHook("native", {
        routes: "native",
        on: {
          request: (ctx) => {
            route = ctx.route;
            return [
              act.injectSystemNote("NATIVE-NOTE"),
              act.rewriteToolDescription("ExitPlanMode", " +DESC"),
            ];
          },
        },
      }),
    ]);
    const inbound = payload();
    const snapshot = structuredClone(inbound);
    const res = await withHooks(new NativeHandler("sk-x"), engine).handle(fakeContext(), inbound);

    expect(res.status).toBe(200);
    expect(route).toEqual({ modelId: "claude-opus-4-8", provider: "anthropic", native: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].system).toEqual([
      { type: "text", text: "SessionStart hook additional context: banner" },
      { type: "text", text: "NATIVE-NOTE" },
    ]);
    expect(bodies[0].tools[0].description).toBe("Exit. +DESC");
    // Copy-on-write: the object withAdvisor shares was never mutated.
    expect(inbound).toEqual(snapshot);
  });

  it("the foreign-scoped built-ins never touch a native request", async () => {
    const { bodies } = captureFetch();
    const inbound = payload();
    await withHooks(new NativeHandler("sk-x"), engineWith([])).handle(fakeContext(), inbound);

    expect(bodies[0].system).toEqual(inbound.system);
    expect(bodies[0].tools).toEqual(inbound.tools);
  });

  it("runs no hooks without withHooks", async () => {
    const { bodies } = captureFetch();
    const inbound = payload();
    await new NativeHandler("sk-x").handle(fakeContext(), inbound);

    expect(bodies[0]).toEqual(inbound);
  });
});
