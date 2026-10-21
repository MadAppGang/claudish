import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logger from "../logger.js";
import {
  type RequestChainState,
  applyStageA,
  applyToolCallActions,
  requestChainState,
} from "./actions.js";
import {
  BREAKER_THRESHOLD,
  type BaseContextParts,
  EVENT_BUDGETS,
  HookEngine,
  MAX_PENDING_SESSIONS,
  dispatchBoundMs,
  stepTimeout,
} from "./engine.js";
import type { JournalEntry } from "./journal.js";
import { type HookDefinition, act } from "./public.js";
import { type ApplicableHook, HookRegistry, type UserHookInput } from "./registry.js";
import {
  type SessionReport,
  resetTelemetryState,
  setTelemetryConsent,
  spoolPendingSync,
} from "./telemetry/aggregate.js";

const META = { model: "glm-5", provider: "zai", sessionId: "s-1" };
const ROUTE = { modelId: "glm-5", provider: "zai", native: false };

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
  users: UserHookInput[],
  builtins: HookDefinition[] = [],
  severity?: Record<string, "off" | "warn" | "fix">
) {
  const journal: JournalEntry[] = [];
  const warnings: string[] = [];
  const engine = new HookEngine({
    registry: new HookRegistry(builtins, users, severity),
    config: severity ? { severity } : {},
    hostMode: "other",
    journalSink: (e) => journal.push(e),
    warn: (l) => warnings.push(l),
    drainTelemetryOutbox: false,
  });
  return { engine, journal, warnings };
}

/** A minimal RequestContext builder over a request chain's working state. */
const requestCtx = (_a: ApplicableHook, base: BaseContextParts, state: RequestChainState) => ({
  ...base,
  event: "request",
  host: { mode: "other" },
  route: ROUTE,
  request: {
    model: "glm-5",
    stream: true,
    systemText: typeof state.system === "string" ? state.system : "",
    messages: [],
    tools: [],
  },
  harness: { planModeActive: false },
  session: null,
});

/** One request dispatch: stage A applied at each step, starting from system "base". */
function runRequest(engine: HookEngine) {
  return engine.runChain(
    "request",
    engine.select("request", { route: ROUTE }),
    { context: requestCtx, apply: (state, items) => applyStageA(state, items) },
    META,
    { initial: requestChainState({ system: "base", messages: [], tools: [] }) }
  );
}

afterEach(() => resetTelemetryState());

describe("HookEngine.runChain", () => {
  it("runs hooks one after another; the second sees the first's applied note", async () => {
    const events: string[] = [];
    let fastSaw: { systemText: string; prior: unknown } | undefined;
    const slow = userHook(
      "slow",
      {
        on: {
          request: async () => {
            events.push("slow:start");
            await Bun.sleep(40);
            events.push("slow:end");
            return [act.injectSystemNote("SLOW")];
          },
        },
      },
      0
    );
    const fast = userHook(
      "fast",
      {
        on: {
          request: (ctx) => {
            events.push("fast:start");
            fastSaw = { systemText: ctx.request.systemText, prior: ctx.prior };
            return [act.injectSystemNote("FAST")];
          },
        },
      },
      1
    );
    const { engine } = engineWith([slow, fast]);
    const t0 = performance.now();
    const result = await runRequest(engine);
    // The second step starts only after the first returned, so the total is at least the slow hook's.
    expect(events).toEqual(["slow:start", "slow:end", "fast:start"]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(35);
    expect(fastSaw?.systemText).toBe("base\n\nSLOW");
    expect(fastSaw?.prior).toEqual([
      { hookId: "hook:m/slow", action: act.injectSystemNote("SLOW") },
    ]);
    expect(result.applied.map((p) => [p.hookId, p.action])).toEqual([
      ["hook:m/slow", act.injectSystemNote("SLOW")],
      ["hook:m/fast", act.injectSystemNote("FAST")],
    ]);
    expect(result.state.system).toBe("base\n\nSLOW\n\nFAST");
  });

  it("times out a hook: its signal aborts, its result is discarded, others still apply", async () => {
    let seen: AbortSignal | undefined;
    let lateMutation = false;
    const hung = userHook("hung", {
      timeoutMs: 50,
      on: {
        request: async (ctx) => {
          seen = ctx.signal;
          await Bun.sleep(150);
          lateMutation = true;
          return [act.injectSystemNote("LATE")];
        },
      },
    });
    const ok = userHook("ok", { on: { request: () => [act.injectSystemNote("OK")] } }, 1);
    const { engine, journal } = engineWith([hung, ok]);
    const result = await runRequest(engine);
    expect(seen?.aborted).toBe(true);
    expect(result.runs.map((r) => r.status)).toEqual(["timeout", "ok"]);
    expect(result.applied.map((p) => p.hookId)).toEqual(["hook:m/ok"]);
    expect(journal.find((e) => e.decision === "timeout")).toMatchObject({
      hookId: "hook:m/hung",
      detail: "50 ms",
    });
    await Bun.sleep(150);
    expect(lateMutation).toBe(true);
    expect(result.applied.length).toBe(1);
    expect(result.state.system).toBe("base\n\nOK");
  });

  it("clamps timeoutMs to the event maximum", async () => {
    const { timeoutFor } = await import("./engine.js");
    const d = { apiVersion: 1, id: "x", timeoutMs: 999_999 } as HookDefinition;
    expect(timeoutFor(d, "request")).toBe(5_000);
    expect(timeoutFor(d, "responseRewrite")).toBe(10_000);
    expect(timeoutFor(d, "sessionEnd")).toBe(1_500);
    expect(timeoutFor({ apiVersion: 1, id: "x" } as HookDefinition, "sessionIdle")).toBe(5_000);
  });

  it("has an event budget equal to each event's per-hook maximum", async () => {
    const { EVENT_TIMEOUTS } = await import("./engine.js");
    for (const event of [
      "request",
      "toolCall",
      "responseRewrite",
      "responseEnd",
      "sessionStart",
      "sessionIdle",
      "sessionBlocked",
      "sessionEnd",
      "raw.providerRequest",
      "raw.providerStreamEnd",
    ] as const) {
      expect(EVENT_BUDGETS[event]).toBe(EVENT_TIMEOUTS[event].max);
    }
    expect(EVENT_BUDGETS["raw.providerChunk"]).toBeNull();
    expect(EVENT_BUDGETS["raw.response"]).toBeNull();
  });

  it("clips a step's timeout to the budget left, and skips a step with none left", () => {
    const d = { apiVersion: 1, id: "x", timeoutMs: 3_000 } as HookDefinition;
    expect(stepTimeout(d, "request", 5_000)).toEqual({ ms: 3_000, clipped: false });
    expect(stepTimeout(d, "request", 1_200)).toEqual({ ms: 1_200, clipped: true });
    expect(stepTimeout(d, "request", 0)).toBeNull();
    expect(stepTimeout(d, "raw.response", null)).toEqual({ ms: 3_000, clipped: false });
  });

  it("bounds a dispatch by the sum of its step timeouts, capped at the budget", () => {
    const hook = (timeoutMs?: number) => ({
      hook: { def: { apiVersion: 1, id: "x", timeoutMs } as HookDefinition },
    });
    expect(dispatchBoundMs("responseEnd", [hook()])).toBe(5_000);
    expect(dispatchBoundMs("responseEnd", [hook(), hook(8_000)])).toBe(13_000);
    expect(dispatchBoundMs("responseEnd", [hook(20_000), hook(20_000)])).toBe(30_000);
    expect(dispatchBoundMs("sessionIdle", [])).toBe(0);
  });

  it("fails open on a throw, a rejection and an invalid return value", async () => {
    const thrower = userHook("thrower", {
      on: {
        request: () => {
          throw new Error("boom");
        },
      },
    });
    const rejecter = userHook(
      "rejecter",
      { on: { request: async () => Promise.reject(new Error("no")) } },
      1
    );
    const wrong = userHook("wrong", { on: { request: (() => "nope") as never } }, 2);
    const fine = userHook("fine", { on: { request: () => [act.injectSystemNote("F")] } }, 3);
    const { engine, journal } = engineWith([thrower, rejecter, wrong, fine]);
    const result = await runRequest(engine);
    expect(result.runs.map((r) => r.status)).toEqual(["error", "error", "invalid", "ok"]);
    expect(result.applied.map((p) => p.hookId)).toEqual(["hook:m/fine"]);
    expect(result.state.system).toBe("base\n\nF");
    expect(journal.filter((e) => e.decision === "error").map((e) => e.detail)).toEqual([
      "boom",
      "no",
    ]);
  });

  it("journals and ignores an action not allowed for the event, keeping the valid ones", async () => {
    const mixed = userHook("mixed", {
      on: {
        request: () => [act.appendText("nope"), act.injectSystemNote("yes")] as never,
      },
    });
    const { engine, journal } = engineWith([mixed]);
    const result = await runRequest(engine);
    expect(result.applied.map((p) => p.action.type)).toEqual(["injectSystemNote"]);
    expect(journal.find((e) => e.decision === "invalid")).toMatchObject({
      action: "appendText",
      detail: "not_allowed:appendText",
      schema: 2,
      event: "request",
    });
  });

  it("at warn severity journals warned and applies nothing; warn actions always journal", async () => {
    const h = userHook("w", {
      on: { request: () => [act.injectSystemNote("N"), act.warn("look out")] },
    });
    const { engine, journal } = engineWith([h], [], { "hook:m/w": "warn" });
    const result = await runRequest(engine);
    expect(result.applied).toEqual([]);
    expect(result.state.system).toBe("base");
    expect(journal.map((e) => [e.action, e.decision])).toEqual([
      ["injectSystemNote", "warned"],
      ["warn", "warned"],
    ]);
  });

  it("does not call an off hook", async () => {
    let called = false;
    const h = userHook("off", {
      on: {
        request: () => {
          called = true;
          return [];
        },
      },
    });
    const { engine } = engineWith([h], [], { "hook:*": "off" });
    expect(engine.select("request", { route: ROUTE })).toEqual([]);
    await runRequest(engine);
    expect(called).toBe(false);
  });

  it("hands the handler a frozen context with hookId, severity, log, signal and prior", async () => {
    let captured: Record<string, unknown> | undefined;
    const h = userHook("ctx", {
      on: {
        request: (ctx) => {
          captured = ctx as unknown as Record<string, unknown>;
          return [];
        },
      },
    });
    const { engine } = engineWith([h]);
    await runRequest(engine);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured?.hookId).toBe("hook:m/ctx");
    expect(captured?.severity).toBe("fix");
    expect(typeof captured?.log).toBe("function");
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect(captured?.prior).toEqual([]);
    expect(Object.isFrozen(captured?.prior)).toBe(true);
  });

  it("restricts an observe-mode toolCall hook to warn", async () => {
    const obs = userHook("obs", {
      on: {
        toolCall: {
          tools: ["Write"],
          observe: true,
          handle: () => [act.repairToolArgs({ x: 1 }, "r"), act.warn("seen")],
        },
      },
    });
    const { engine, journal } = engineWith([obs]);
    const result = await engine.runChain(
      "toolCall",
      engine.select("toolCall", { route: ROUTE }),
      { context: (_a, base) => ({ ...base, event: "toolCall" }) },
      { ...META, toolName: "Write" },
      { initial: undefined }
    );
    expect(result.applied).toEqual([]);
    expect(journal.map((e) => e.decision)).toContain("invalid");
    expect(journal.find((e) => e.decision === "invalid")?.detail).toBe("observe_only");
  });

  it("an aborted dispatch ends the running hook as aborted and starts no later one", async () => {
    let laterCalled = false;
    const h = userHook("idle", {
      on: {
        sessionIdle: async (ctx) => {
          await new Promise((r) => ctx.signal.addEventListener("abort", r));
          return [act.injectUserTurn("late")];
        },
      },
    });
    const later = userHook(
      "later",
      {
        on: {
          sessionIdle: () => {
            laterCalled = true;
            return [];
          },
        },
      },
      1
    );
    const { engine, journal } = engineWith([h, later]);
    const parent = new AbortController();
    const running = engine.runChain(
      "sessionIdle",
      engine.select("sessionIdle", { sessionModel: "glm-5" }),
      { context: (_a, base) => ({ ...base, event: "sessionIdle" }) },
      META,
      { initial: undefined, signal: parent.signal }
    );
    await Bun.sleep(10);
    parent.abort("caller");
    const result = await running;
    expect(result.runs.map((r) => r.status)).toEqual(["aborted"]);
    expect(result.applied).toEqual([]);
    expect(laterCalled).toBe(false);
    expect(journal).toEqual([]);
  });
});

describe("circuit breaker", () => {
  it("disables a hook after 5 consecutive failures, with one stderr line", async () => {
    let calls = 0;
    const flaky = userHook("flaky", {
      on: {
        request: () => {
          calls++;
          throw new Error("always");
        },
      },
    });
    const { engine, journal, warnings } = engineWith([flaky]);
    for (let i = 0; i < BREAKER_THRESHOLD + 2; i++) {
      await runRequest(engine);
    }
    expect(calls).toBe(BREAKER_THRESHOLD);
    expect(engine.isDisabled("hook:m/flaky")).toBe(true);
    expect(journal.filter((e) => e.decision === "disabled").length).toBe(1);
    expect(warnings).toEqual([
      "hook hook:m/flaky disabled after 5 consecutive failures (see the debug log)",
    ]);
  });

  it("any success resets the count", async () => {
    let n = 0;
    const sometimes = userHook("sometimes", {
      on: {
        request: () => {
          n++;
          if (n % 4 === 0) return [];
          throw new Error("x");
        },
      },
    });
    const { engine } = engineWith([sometimes]);
    for (let i = 0; i < 12; i++) {
      await runRequest(engine);
    }
    expect(engine.isDisabled("hook:m/sometimes")).toBe(false);
    expect(n).toBe(12);
  });
});

describe("journal fan-out and the upload projection", () => {
  it("uploads a user hook as rule_id user and withholds an mcp__ tool name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-hooks-engine-"));
    try {
      setTelemetryConsent(true);
      const repair = userHook("fix-args", {
        on: { toolCall: { tools: ["*"], handle: () => [act.repairToolArgs({ q: 1 }, "x")] } },
      });
      const builtin = {
        apiVersion: 1,
        id: "plan-mode/plan-file-path",
        on: { toolCall: { tools: ["Write"], handle: () => [act.repairToolArgs({ p: 1 }, "y")] } },
      } as HookDefinition;
      const { engine, journal } = engineWith([repair], [builtin]);
      // The engine constructor pushes consent from config (off here); turn it on after.
      setTelemetryConsent(true);

      for (const toolName of ["mcp__srv__x", "Write"]) {
        const meta = { ...META, toolName };
        await engine.runChain(
          "toolCall",
          engine.select("toolCall", { route: ROUTE }),
          {
            context: (_a, base) => ({ ...base, event: "toolCall" }),
            apply: (args: Record<string, unknown>, items) => {
              const out = applyToolCallActions(args, items);
              return { state: out.args, results: out.results, applied: items };
            },
          },
          meta,
          { initial: {} as Record<string, unknown> }
        );
      }

      const outbox = join(dir, "outbox.jsonl");
      expect(spoolPendingSync(outbox)).toBe(1);
      const report = JSON.parse(readFileSync(outbox, "utf8").trim()) as SessionReport;
      const rows = report.decisions.map((d) => [d.rule_id, d.tool_name, d.counts.repaired]);
      expect(rows).toContainEqual(["user", undefined, 1]); // mcp__srv__x withheld
      expect(rows).toContainEqual(["user", "Write", 1]); // built-in tool names are not user data
      expect(rows).toContainEqual(["plan-mode/plan-file-path", "Write", 1]);
      // A built-in keeps an mcp__ tool name: only user rows are projected.
      expect(
        rows.some(([id, tool]) => id === "plan-mode/plan-file-path" && tool === "mcp__srv__x")
      ).toBe(true);
      expect(JSON.stringify(report)).not.toContain("hook:m/fix-args");

      // The local journal keeps the real id and tool.
      expect(journal).toContainEqual(
        expect.objectContaining({
          hookId: "hook:m/fix-args",
          ruleId: "hook:m/fix-args",
          toolName: "mcp__srv__x",
          decision: "repaired",
          surface: "tool_call",
          schema: 2,
        })
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps local-only surfaces and decisions out of the upload", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-hooks-engine-"));
    try {
      const { engine } = engineWith([]);
      setTelemetryConsent(true);
      engine.journal({ ...META, event: "responseRewrite", hookId: "x", decision: "matched" });
      engine.journal({ ...META, event: "request", hookId: "x", decision: "superseded" });
      engine.journal({ ...META, event: "sessionIdle", hookId: "x", decision: "delivered" });
      expect(spoolPendingSync(join(dir, "o.jsonl"))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clips detail to 200 characters and never throws on a failing sink", () => {
    const entries: JournalEntry[] = [];
    const { engine } = engineWith([]);
    const clipped = new HookEngine({
      registry: new HookRegistry([], [], undefined),
      config: {},
      hostMode: "other",
      journalSink: (e) => entries.push(e),
      drainTelemetryOutbox: false,
    });
    clipped.journal({
      ...META,
      event: "request",
      hookId: "x",
      decision: "error",
      detail: "d".repeat(500),
    });
    expect(entries[0]?.detail?.length).toBe(200);

    const logSpy = spyOn(logger, "log");
    const broken = new HookEngine({
      registry: new HookRegistry([], [], undefined),
      config: {},
      hostMode: "other",
      journalSink: () => {
        throw new Error("disk full");
      },
      drainTelemetryOutbox: false,
    });
    expect(() =>
      broken.journal({ ...META, event: "request", hookId: "x", decision: "error" })
    ).not.toThrow();
    logSpy.mockRestore();
    expect(engine).toBeDefined();
  });
});

describe("pending notes", () => {
  it("peeks without removing, and consumes only what a committed request carried", () => {
    const { engine } = engineWith([]);
    engine.queueNote("s", "hook:m/a", "one");
    const first = engine.peekNotes("s");
    // A concurrent request that started before any commit sees the same note.
    expect(engine.peekNotes("s").map((n) => n.text)).toEqual(["one"]);
    engine.queueNote("s", "hook:m/a", "two");
    engine.consumeNotes(
      "s",
      first.map((n) => n.seq)
    );
    expect(engine.peekNotes("s").map((n) => n.text)).toEqual(["two"]);
    expect(engine.peekNotes(undefined)).toEqual([]);
  });

  it("tracks at most 64 sessions, evicting the oldest", () => {
    const { engine } = engineWith([]);
    for (let i = 0; i <= MAX_PENDING_SESSIONS; i++) engine.queueNote(`s${i}`, "h", "n");
    expect(engine.peekNotes("s0")).toEqual([]);
    expect(engine.peekNotes(`s${MAX_PENDING_SESSIONS}`).length).toBe(1);
  });
});

describe("callPredicate", () => {
  it("treats a throw or a non-true value as false and defaults an absent predicate", () => {
    const { engine } = engineWith([]);
    expect(engine.callPredicate("h", undefined, null, {})).toBe(true);
    expect(engine.callPredicate("h", undefined, null, {}, false)).toBe(false);
    expect(
      engine.callPredicate(
        "h",
        () => {
          throw new Error("x");
        },
        null,
        {}
      )
    ).toBe(false);
    expect(engine.callPredicate("h", (() => 1) as never, null, {})).toBe(false);
    expect(engine.callPredicate("h", (() => true) as never, null, {})).toBe(true);
  });
});
