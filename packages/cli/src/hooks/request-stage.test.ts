import { afterEach, describe, expect, it } from "bun:test";
import { BUILTIN_HOOKS } from "./builtins/index.js";
import { HookEngine } from "./engine.js";
import type { JournalEntry } from "./journal.js";
import { type HookDefinition, act } from "./public.js";
import { HookRegistry, type UserHookInput } from "./registry.js";
import {
  HOOK_SCOPE_CONTEXT_KEY,
  RequestHooks,
  isNativeRoute,
  proxySessionFromEnv,
  systemTextOf,
} from "./request-stage.js";
import { resetTelemetryState } from "./telemetry/aggregate.js";

const SESSION_A = "ce7d9e68-f907-444f-9680-69ec3048ce9c";
const SESSION_B = "62e11a50-15c1-4863-b880-0a518425db74";
const FOREIGN = { modelId: "gpt-5.6-sol", provider: "openai-codex", native: false };

afterEach(() => resetTelemetryState());

function userHook(id: string, def: Omit<HookDefinition, "apiVersion" | "id">, index = 0) {
  return {
    id: `hook:m/${id}`,
    module: "/hooks/m.ts",
    moduleIndex: 0,
    exportIndex: index,
    def: { apiVersion: 1, id, ...def } as HookDefinition,
  } satisfies UserHookInput;
}

function engineWith(
  users: UserHookInput[] = [],
  opts: { builtins?: boolean; severity?: Record<string, "off" | "warn" | "fix"> } = {}
) {
  const journal: JournalEntry[] = [];
  const engine = new HookEngine({
    registry: new HookRegistry(opts.builtins ? BUILTIN_HOOKS : [], users, opts.severity),
    config: opts.severity ? { severity: opts.severity } : {},
    hostMode: "other",
    journalSink: (e) => journal.push(e),
    warn: () => {},
    drainTelemetryOutbox: false,
  });
  return { engine, journal };
}

function fakeContext() {
  const vars = new Map<string, unknown>();
  return {
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
    vars,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Claude-format requests are untyped at this layer
function requestFor(sessionId: string | undefined, system: any = "base system"): any {
  const req: Record<string, unknown> = {
    system,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "ExitPlanMode", description: "Exit.", input_schema: { type: "object" } }],
  };
  if (sessionId) {
    req.metadata = {
      user_id: JSON.stringify({ device_id: "abc", account_uuid: "", session_id: sessionId }),
    };
  }
  return req;
}

async function begin(
  hooks: RequestHooks,
  // biome-ignore lint/suspicious/noExplicitAny: see requestFor
  claudeRequest: any,
  route = FOREIGN,
  c = fakeContext()
) {
  const scope = await hooks.beginAttempt(c, {
    claudeRequest,
    route,
    model: route.modelId,
    stream: true,
  });
  return { scope, c };
}

describe("isNativeRoute (RouteInfo.native for proxied routes)", () => {
  it("is today's rule: claude-* names and the anthropic provider, unless forceForeignModel", () => {
    expect(isNativeRoute("claude-opus-4-8", "openrouter")).toBe(true);
    expect(isNativeRoute("Claude.sonnet", "x")).toBe(true);
    expect(isNativeRoute("glm-5", "anthropic")).toBe(true);
    expect(isNativeRoute("gpt-5.6-sol", "openai-codex")).toBe(false);
    expect(isNativeRoute("my-claude-clone", "openrouter")).toBe(false);
    expect(isNativeRoute("claude-sonnet-5-medium", "devin", true)).toBe(false);
    expect(isNativeRoute("glm-5", "anthropic", true)).toBe(false);
  });
});

describe("systemTextOf / proxySessionFromEnv", () => {
  it("flattens string and block system prompts", () => {
    expect(systemTextOf("plain")).toBe("plain");
    expect(
      systemTextOf([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ])
    ).toBe("a\n\nb");
    expect(systemTextOf(undefined)).toBe("");
  });

  it("reads CLAUDISH_HOOK_SESSION and rejects malformed values", () => {
    expect(
      proxySessionFromEnv({ CLAUDISH_HOOK_SESSION: '{"kind":"team","id":"r:s1","role":"judge"}' })
    ).toEqual({ kind: "team", id: "r:s1", role: "judge" });
    expect(
      proxySessionFromEnv({ CLAUDISH_HOOK_SESSION: '{"kind":"channel","id":"ab12cd34"}' })
    ).toEqual({
      kind: "channel",
      id: "ab12cd34",
      role: null,
    });
    expect(proxySessionFromEnv({ CLAUDISH_HOOK_SESSION: '{"kind":"nope","id":"x"}' })).toBeNull();
    expect(proxySessionFromEnv({ CLAUDISH_HOOK_SESSION: "not json" })).toBeNull();
    expect(proxySessionFromEnv({})).toBeNull();
  });
});

describe("RequestHooks.beginAttempt — stage A and stage B", () => {
  it("the first hook sees the request as given, and stage A replaces system/messages without mutating them", async () => {
    let seen: { systemText?: string; firstUser?: unknown; session?: unknown; host?: unknown } = {};
    const { engine } = engineWith([
      userHook("edit", {
        on: {
          request: (ctx) => {
            seen = {
              systemText: ctx.request.systemText,
              firstUser: ctx.request.messages[0]?.content,
              session: ctx.session,
              host: ctx.host,
            };
            return [act.injectSystemNote("NOTE"), act.appendUserText("APPENDED")];
          },
        },
      }),
    ]);
    const session = { kind: "channel" as const, id: "ab12cd34", role: null };
    const req = requestFor(SESSION_A);
    const originalMessages = req.messages;
    const originalFirst = req.messages[0];
    const { scope, c } = await begin(new RequestHooks(engine, session), req);

    expect(seen).toEqual({
      systemText: "base system",
      firstUser: "hello",
      session,
      host: { mode: "other" },
    });
    expect(req.system).toBe("base system\n\nNOTE");
    expect(req.messages).not.toBe(originalMessages);
    expect(originalFirst).toEqual({ role: "user", content: "hello" });
    expect(req.messages[0].content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "APPENDED" },
    ]);
    expect(c.vars.get(HOOK_SCOPE_CONTEXT_KEY)).toBe(scope);
  });

  it("holds description actions for stage B and applies them to both representations", async () => {
    const { engine, journal } = engineWith([
      userHook("desc", {
        on: { request: () => [act.rewriteToolDescription("ExitPlanMode", " +B")] },
      }),
    ]);
    const req = requestFor(SESSION_A);
    const { scope } = await begin(new RequestHooks(engine), req);

    // Not applied at stage A.
    expect(req.tools[0].description).toBe("Exit.");
    expect(scope.hasToolDescriptionWork).toBe(true);

    const converted = [
      { type: "function", function: { name: "ExitPlanMode", description: "Exit." } },
    ];
    scope.applyToolDescriptions(req.tools, converted);
    expect(req.tools[0].description).toBe("Exit. +B");
    expect(converted[0]?.function.description).toBe("Exit. +B");
    expect(scope.hasToolDescriptionWork).toBe(false);

    // A second call is a no-op.
    scope.applyToolDescriptions(req.tools, converted);
    expect(req.tools[0].description).toBe("Exit. +B");
    expect(
      journal.filter((e) => e.action === "rewriteToolDescription").map((e) => e.decision)
    ).toEqual(["matched"]);
  });

  it("the foreign-scoped built-ins stay off on a native route", async () => {
    const { engine } = engineWith([], { builtins: true });
    const req = requestFor(SESSION_A, "SessionStart hook additional context");
    req.messages[0].content =
      "You should create your plan at /tmp/p/assigned.md using the Write tool.";
    const native = { modelId: "claude-opus-4-8", provider: "anthropic", native: true };
    const { scope } = await begin(new RequestHooks(engine), req, native);

    expect(req.system).toBe("SessionStart hook additional context");
    expect(scope.hasToolDescriptionWork).toBe(false);
  });

  it("skips the harness scan when no hook applies", async () => {
    const { engine } = engineWith();
    const req = requestFor(SESSION_A);
    req.messages[0].content = "You should create your plan at /tmp/p/assigned.md now.";
    const { scope } = await begin(new RequestHooks(engine), req);

    expect(scope.harness).toEqual({ planModeActive: false, sessionId: SESSION_A });
  });

  it("detects harness facts when a hook applies", async () => {
    const { engine } = engineWith([userHook("noop", { on: { request: () => [] } })]);
    const req = requestFor(SESSION_A);
    req.messages[0].content = "You should create your plan at /tmp/p/assigned.md now.";
    const { scope } = await begin(new RequestHooks(engine), req);

    expect(scope.harness.planModeActive).toBe(true);
    expect(scope.harness.planFilePath).toBe("/tmp/p/assigned.md");
    expect(scope.harness.sessionId).toBe(SESSION_A);
  });

  it("a responseEnd-only hook sees the real harness facts", async () => {
    const { engine } = engineWith([userHook("end", { on: { responseEnd: () => [] } })]);
    const req = requestFor(SESSION_A);
    req.messages[0].content = "You should create your plan at /tmp/p/assigned.md now.";
    const { scope } = await begin(new RequestHooks(engine), req);

    expect(scope.harness.planModeActive).toBe(true);
    expect(scope.harness.planFilePath).toBe("/tmp/p/assigned.md");
  });

  it("a hook reordering ctx.request.messages in place cannot change the request", async () => {
    const { engine, journal } = engineWith([
      userHook("rev", {
        on: {
          request: (ctx) => {
            (ctx.request.messages as unknown as unknown[]).reverse();
            (ctx.request.tools as unknown as unknown[]).pop();
            return [];
          },
        },
      }),
    ]);
    const req = requestFor(SESSION_A);
    req.messages.push({ role: "assistant", content: "second" });
    await begin(new RequestHooks(engine), req);

    expect(req.messages.map((m: { content: string }) => m.content)).toEqual(["hello", "second"]);
    expect(req.tools.map((t: { name: string }) => t.name)).toEqual(["ExitPlanMode"]);
    expect(journal.some((e) => e.hookId === "hook:m/rev" && e.decision === "error")).toBe(true);
  });

  it("evaluates toolCall armed() and responseRewrite claims() for fix-severity hooks only", async () => {
    const { engine } = engineWith(
      [
        userHook("armed", {
          on: {
            toolCall: {
              tools: ["Write"],
              armed: (ctx) => ctx.harness.planModeActive,
              handle: () => [],
            },
          },
        }),
        userHook(
          "unarmed",
          {
            on: { toolCall: { tools: ["Edit"], armed: () => false, handle: () => [] } },
          },
          1
        ),
        userHook(
          "observer",
          {
            on: { toolCall: { tools: ["Read"], observe: true, handle: () => [] } },
          },
          2
        ),
        userHook("warned", { on: { toolCall: { tools: ["Bash"], handle: () => [] } } }, 3),
        userHook("claims", { on: { responseRewrite: { handle: () => [] } } }, 4),
        userHook(
          "declines",
          {
            on: { responseRewrite: { claims: () => false, handle: () => [] } },
          },
          5
        ),
        userHook(
          "throws",
          {
            on: {
              responseRewrite: {
                claims: () => {
                  throw new Error("boom");
                },
                handle: () => [],
              },
            },
          },
          6
        ),
      ],
      { severity: { "hook:m/warned": "warn" } }
    );
    const req = requestFor(SESSION_A);
    req.messages[0].content = "You should create your plan at /tmp/p/assigned.md now.";
    const { scope } = await begin(new RequestHooks(engine), req);

    expect([...scope.armedTools]).toEqual(["Write"]);
    expect(scope.rewriteClaimants).toEqual(["hook:m/claims"]);
  });
});

describe("pending notes (ported from behavior/output-rules.test.ts)", () => {
  it("applies a queued note to the next request of the same session", async () => {
    const { engine, journal } = engineWith();
    engine.queueNote(SESSION_A, "hook:m/judge", "Run the verification before claiming completion.");
    const next = requestFor(SESSION_A, "turn two system");
    await begin(new RequestHooks(engine), next);

    expect(next.system).toBe("turn two system\n\nRun the verification before claiming completion.");
    expect(
      journal.some((e) => e.hookId === "behavior/pending-correction" && e.decision === "matched")
    ).toBe(true);
  });

  it("does not leak a note to a different session id", async () => {
    const { engine } = engineWith();
    engine.queueNote(SESSION_A, "hook:m/judge", "Session A correction");
    const other = requestFor(SESSION_B);
    await begin(new RequestHooks(engine), other);

    expect(other.system).toBe("base system");
  });

  it("drains a note once the request carrying it commits", async () => {
    const { engine } = engineWith();
    const hooks = new RequestHooks(engine);
    engine.queueNote(SESSION_A, "hook:m/judge", "One-shot correction");
    const next = requestFor(SESSION_A);
    const { scope } = await begin(hooks, next);
    scope.commit();
    const later = requestFor(SESSION_A);
    await begin(hooks, later);

    expect(next.system).toBe("base system\n\nOne-shot correction");
    expect(later.system).toBe("base system");
  });

  it("keeps a note when the attempt carrying it is abandoned (a failed fallback attempt)", async () => {
    const { engine } = engineWith();
    const hooks = new RequestHooks(engine);
    engine.queueNote(SESSION_A, "hook:m/judge", "Survives a failed attempt");
    const c = fakeContext();
    const first = await begin(hooks, requestFor(SESSION_A), FOREIGN, c);
    // The second attempt on the same context abandons the first.
    const secondReq = requestFor(SESSION_A);
    const second = await begin(hooks, secondReq, FOREIGN, c);
    expect(first.scope.settled).toBe("abandoned");
    expect(secondReq.system).toBe("base system\n\nSurvives a failed attempt");
    second.scope.abandon();

    const third = requestFor(SESSION_A);
    await begin(hooks, third);
    expect(third.system).toBe("base system\n\nSurvives a failed attempt");
  });

  it("carries a note on every concurrent request that starts before any of them commits", async () => {
    const { engine } = engineWith();
    const hooks = new RequestHooks(engine);
    engine.queueNote(SESSION_A, "hook:m/judge", "Concurrent note");
    const a = requestFor(SESSION_A);
    const b = requestFor(SESSION_A);
    const [sa, sb] = await Promise.all([begin(hooks, a), begin(hooks, b)]);
    sa.scope.commit();
    sb.scope.commit();

    expect(a.system).toBe("base system\n\nConcurrent note");
    expect(b.system).toBe("base system\n\nConcurrent note");
    expect(engine.peekNotes(SESSION_A)).toEqual([]);
  });

  it("applies an identical note from a hook and from the store once: the hook's is superseded", async () => {
    const { engine, journal } = engineWith([
      userHook("same", { on: { request: () => [act.injectSystemNote("Same text")] } }),
    ]);
    engine.queueNote(SESSION_A, "hook:m/judge", "Same text");
    const req = requestFor(SESSION_A);
    await begin(new RequestHooks(engine), req);

    expect(req.system).toBe("base system\n\nSame text");
    expect(
      journal
        .filter((e) => e.action === "injectSystemNote")
        .map((e) => [e.hookId, e.decision, e.detail])
    ).toEqual([
      ["behavior/pending-correction", "matched", undefined],
      ["hook:m/same", "superseded", "duplicate"],
    ]);
  });

  it("applies the stored note as step 0: it precedes the hooks' notes, and they see it", async () => {
    let saw: { systemText: string; prior: unknown } | undefined;
    const { engine } = engineWith([
      userHook("other", {
        on: {
          request: (ctx) => {
            saw = { systemText: ctx.request.systemText, prior: ctx.prior };
            return [act.injectSystemNote("Hook note")];
          },
        },
      }),
    ]);
    engine.queueNote(SESSION_A, "hook:m/judge", "Stored note");
    const req = requestFor(SESSION_A);
    await begin(new RequestHooks(engine), req);

    expect(req.system).toBe("base system\n\nStored note\n\nHook note");
    expect(saw?.systemText).toBe("base system\n\nStored note");
    expect(saw?.prior).toEqual([
      { hookId: "behavior/pending-correction", action: act.injectSystemNote("Stored note") },
    ]);
  });

  it("applies no hook action at warn severity", async () => {
    const { engine, journal } = engineWith(
      [userHook("w", { on: { request: () => [act.injectSystemNote("withheld")] } })],
      { severity: { "hook:m/w": "warn" } }
    );
    const req = requestFor(SESSION_A);
    await begin(new RequestHooks(engine), req);

    expect(req.system).toBe("base system");
    expect(journal.some((e) => e.hookId === "hook:m/w" && e.decision === "warned")).toBe(true);
  });

  it("a throwing request hook fails open", async () => {
    const { engine } = engineWith([
      userHook("boom", {
        on: {
          request: () => {
            throw new Error("request hook exploded");
          },
        },
      }),
      userHook("ok", { on: { request: () => [act.injectSystemNote("still applied")] } }, 1),
    ]);
    const req = requestFor(SESSION_A);
    await begin(new RequestHooks(engine), req);

    expect(req.system).toBe("base system\n\nstill applied");
  });
});
