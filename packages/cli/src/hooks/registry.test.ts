import { describe, expect, it } from "bun:test";
import type { HookDefinition, RouteInfo } from "./public.js";
import { type BuiltinHook, HookRegistry, type UserHookInput, eventsOf } from "./registry.js";

const handler = () => [];

function def(id: string, extra: Partial<HookDefinition> = {}): HookDefinition {
  return { apiVersion: 1, id, on: { request: handler }, ...extra } as HookDefinition;
}

function user(id: string, moduleIndex: number, exportIndex: number, extra = {}): UserHookInput {
  return {
    id: `hook:m${moduleIndex}/${id}`,
    module: `/hooks/m${moduleIndex}.ts`,
    moduleIndex,
    exportIndex,
    def: def(id, extra),
  };
}

const foreign: RouteInfo = { modelId: "glm-5", provider: "zai", native: false };
const native: RouteInfo = { modelId: "claude-opus-5", provider: "anthropic", native: true };

describe("HookRegistry effective order", () => {
  it("orders by bucket, then built-ins first, then module position, then export order", () => {
    const builtins: BuiltinHook[] = [def("b/normal"), def("b/post", { order: "post" })];
    const users = [
      user("u1-late", 1, 0),
      user("u0-second", 0, 1),
      user("u0-first", 0, 0),
      user("u1-pre", 1, 1, { order: "pre" }),
    ];
    const reg = new HookRegistry(builtins, users, undefined);
    expect(reg.hooks.map((h) => h.id)).toEqual([
      "hook:m1/u1-pre",
      "b/normal",
      "hook:m0/u0-first",
      "hook:m0/u0-second",
      "hook:m1/u1-late",
      "b/post",
    ]);
    expect(reg.hooks.map((h) => h.source)).toEqual([
      "user",
      "builtin",
      "user",
      "user",
      "user",
      "builtin",
    ]);
  });
});

describe("HookRegistry applicability", () => {
  it("filters proxy events by routes and model globs", () => {
    const reg = new HookRegistry(
      [def("foreign-only", { routes: "foreign" }), def("native-only", { routes: "native" })],
      [user("glm", 0, 0, { models: ["glm-*", "kimi-*"] })],
      undefined
    );
    expect(reg.applicable("request", { route: foreign }).map((a) => a.hook.id)).toEqual([
      "foreign-only",
      "hook:m0/glm",
    ]);
    expect(reg.applicable("request", { route: native }).map((a) => a.hook.id)).toEqual([
      "native-only",
    ]);
  });

  it("drops severity off and resolves model-scoped keys against the route model", () => {
    const reg = new HookRegistry([def("plan-mode/plan-file-path")], [], {
      "plan-mode/*": "off",
      "glm-*:plan-mode/plan-file-path": "warn",
    });
    expect(reg.applicable("request", { route: foreign })).toEqual([
      { hook: reg.hooks[0] as never, severity: "warn" },
    ]);
    expect(reg.applicable("request", { route: { ...foreign, modelId: "kimi-k3" } })).toEqual([]);
  });

  it("defaults user hooks to fix", () => {
    const reg = new HookRegistry([], [user("x", 0, 0)], undefined);
    expect(reg.applicable("request", { route: foreign })[0]?.severity).toBe("fix");
  });

  it("does not filter session events by route; scopes severity by the session model", () => {
    const sessionDef = {
      apiVersion: 1,
      id: "ping",
      routes: "native",
      models: "nothing-*",
      on: { sessionIdle: handler },
    } as HookDefinition;
    const reg = new HookRegistry([], [{ ...user("ping", 0, 0), def: sessionDef }], {
      "gpt-*:hook:m0/ping": "off",
    });
    expect(reg.applicable("sessionIdle", { sessionModel: "glm-5" }).length).toBe(1);
    expect(reg.applicable("sessionIdle", { sessionModel: "gpt-6" }).length).toBe(0);
  });

  it("indexes hooks by every event they declare, raw stages included", () => {
    const raw = {
      apiVersion: 1,
      id: "gemini/thought-signature",
      unsafe: true,
      raw: { providerRequest: handler, providerChunk: handler },
      on: { toolCall: { tools: ["Write"], handle: handler } },
    } as unknown as HookDefinition;
    expect(eventsOf(raw)).toEqual(["toolCall", "raw.providerRequest", "raw.providerChunk"]);
    const reg = new HookRegistry([{ ...raw, statsName: "GeminiThoughtSignature" }], [], undefined);
    expect(reg.has("raw.providerChunk")).toBe(true);
    expect(reg.has("raw.response")).toBe(false);
    expect(reg.hooks[0]?.unsafe).toBe(true);
    expect(reg.hooks[0]?.statsName).toBe("GeminiThoughtSignature");
  });
});
