/**
 * The real `SessionHookBinding` over a real engine (architecture §4.10, §7.3, §11.5
 * H-35 and H-36, and the `holdBoundMs` terms of H-21b). No pane: the tests call
 * `settle()` the way `PaneSession` does and abort its signal with each reason.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookEngine } from "../engine.js";
import type { JournalEntry } from "../journal.js";
import type { HookDefinition, SessionIdleContext, SessionInfo } from "../public.js";
import { HookRegistry, type UserHookInput } from "../registry.js";
import {
  HOLD_WATCHDOG_MARGIN_MS,
  type HoldInjection,
  type HoldTurnInfo,
  createSessionHookBinding,
  inboxBoundFor,
  reportOwnerWithoutHooks,
  resetOwnerWithoutHooksReportForTests,
  sessionHooksNeedBinding,
} from "./binding.js";

const dir = mkdtempSync(join(tmpdir(), "hook-binding-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SESSION: SessionInfo = {
  kind: "channel",
  role: null,
  id: "abcd1234",
  claudeSessionId: "11111111-2222-3333-4444-555555555555",
  model: "glm-5",
  cwd: "/w",
  shape: "one-shot",
  injection: "available",
};
const TURN: HoldTurnInfo = {
  index: 1,
  answer: "A1",
  stopReason: "end_turn",
  apiError: false,
  hookCaused: false,
};

function user(id: string, def: Omit<HookDefinition, "apiVersion" | "id">): UserHookInput {
  return {
    id: `hook:t/${id}`,
    module: "/hooks/t.ts",
    moduleIndex: 0,
    exportIndex: 0,
    def: { apiVersion: 1, id, ...def } as HookDefinition,
  };
}

function engineOf(...users: UserHookInput[]) {
  const journal: JournalEntry[] = [];
  const engine = new HookEngine({
    registry: new HookRegistry([], users, undefined),
    config: {},
    hostMode: "mcp",
    journalSink: (e) => journal.push(e),
    warn: () => {},
    drainTelemetryOutbox: false,
  });
  return { engine, journal };
}

let n = 0;
function inbox(lines: object[]): string {
  const p = join(dir, `inbox-${++n}.jsonl`);
  writeFileSync(p, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return p;
}

const stopR1 = { v: 1, kind: "stop", req: "r1" };
const injectP = { v: 1, kind: "inject", req: "r1", hookId: "hook:c/p", text: "P", at: "x" };
const annotateK = {
  v: 1,
  kind: "annotate",
  req: "r1",
  hookId: "hook:c/a",
  key: "k",
  value: 7,
  at: "x",
};
const endR1 = { v: 1, kind: "end", req: "r1" };

const texts = (xs: HoldInjection[]) => xs.map((x) => x.text);

describe("hasIdleWork and holdBoundMs", () => {
  test("no session hook, empty inbox, nothing queued: no idle work (no hold, today's timing)", () => {
    const { engine } = engineOf();
    const b = createSessionHookBinding(engine, SESSION, inbox([]));
    expect(b.hasIdleWork(false)).toBe(false);
    expect(b.hasIdleWork(true)).toBe(true);
  });

  test("unread inbox bytes and an applicable sessionIdle hook each make idle work", () => {
    const { engine } = engineOf();
    expect(createSessionHookBinding(engine, SESSION, inbox([stopR1])).hasIdleWork(false)).toBe(
      true
    );
    const idle = engineOf(user("i", { on: { sessionIdle: () => [] } })).engine;
    expect(createSessionHookBinding(idle, SESSION, null).hasIdleWork(false)).toBe(true);
  });

  test("the inbox bound is the responseEnd dispatch bound + 500 ms, never below the default", () => {
    expect(inboxBoundFor(engineOf().engine)).toBe(5_500);
    const slow = engineOf(user("e", { timeoutMs: 20_000, on: { responseEnd: () => [] } })).engine;
    expect(inboxBoundFor(slow)).toBe(20_500);
    expect(sessionHooksNeedBinding(slow)).toBe(true);
    expect(sessionHooksNeedBinding(engineOf().engine)).toBe(false);
  });

  test("with two responseEnd hooks the inbox bound is their sum, capped at the 30 s budget", () => {
    const two = engineOf(
      user("e1", { timeoutMs: 8_000, on: { responseEnd: () => [] } }),
      user("e2", { on: { responseEnd: () => [] } })
    ).engine;
    expect(inboxBoundFor(two)).toBe(8_000 + 5_000 + 500);
    const capped = engineOf(
      user("e1", { timeoutMs: 20_000, on: { responseEnd: () => [] } }),
      user("e2", { timeoutMs: 20_000, on: { responseEnd: () => [] } })
    ).engine;
    expect(inboxBoundFor(capped)).toBe(30_000 + 500);
  });

  test("H-21b/M-2: holdBoundMs adds what remains of a RUNNING sessionStart dispatch bound", async () => {
    let now = 10_000;
    const { engine } = engineOf(
      user("start", {
        timeoutMs: 4_000,
        on: { sessionStart: () => new Promise((r) => setTimeout(() => r([]), 300)) },
      }),
      user("idle", { timeoutMs: 2_000, on: { sessionIdle: () => [] } })
    );
    const b = createSessionHookBinding(engine, SESSION, null, {
      inboxBoundMs: 200,
      now: () => now,
    });
    expect(b.holdBoundMs()).toBe(200 + 2_000 + HOLD_WATCHDOG_MARGIN_MS);
    b.fireStart();
    now += 50; // the hold starts 50 ms into the dispatch
    expect(b.holdBoundMs()).toBe(3_950 + 200 + 2_000 + HOLD_WATCHDOG_MARGIN_MS);
    expect(b.hasIdleWork(false)).toBe(true);
    await Bun.sleep(400);
    expect(b.holdBoundMs()).toBe(200 + 2_000 + HOLD_WATCHDOG_MARGIN_MS);
  });

  test("holdBoundMs sums the sessionStart and sessionIdle hooks' step timeouts, capped at the budget", async () => {
    let now = 10_000;
    const { engine } = engineOf(
      user("start1", {
        timeoutMs: 4_000,
        on: { sessionStart: () => new Promise((r) => setTimeout(() => r([]), 100)) },
      }),
      user("start2", { timeoutMs: 1_000, on: { sessionStart: () => [] } }),
      user("idle1", { timeoutMs: 2_000, on: { sessionIdle: () => [] } }),
      user("idle2", { timeoutMs: 3_000, on: { sessionIdle: () => [] } })
    );
    const b = createSessionHookBinding(engine, SESSION, null, {
      inboxBoundMs: 200,
      now: () => now,
    });
    expect(b.holdBoundMs()).toBe(200 + 5_000 + HOLD_WATCHDOG_MARGIN_MS);
    b.fireStart();
    now += 50;
    expect(b.holdBoundMs()).toBe(4_950 + 200 + 5_000 + HOLD_WATCHDOG_MARGIN_MS);
    await Bun.sleep(200);

    const capped = engineOf(
      user("idle1", { timeoutMs: 20_000, on: { sessionIdle: () => [] } }),
      user("idle2", { timeoutMs: 20_000, on: { sessionIdle: () => [] } })
    ).engine;
    const c = createSessionHookBinding(capped, SESSION, null, { inboxBoundMs: 200 });
    expect(c.holdBoundMs()).toBe(200 + 30_000 + HOLD_WATCHDOG_MARGIN_MS);
  });
});

describe("settle()", () => {
  test("merge order: sessionStart, then proxy (arrival order), then sessionIdle; annotations reach ctx.turn", async () => {
    let seen: SessionIdleContext | null = null;
    const { engine, journal } = engineOf(
      user("start", {
        on: {
          sessionStart: () =>
            new Promise((r) => setTimeout(() => r([{ type: "injectUserTurn", text: "S0" }]), 150)),
        },
      }),
      user("idle", {
        on: {
          sessionIdle: (ctx) => {
            seen = ctx;
            return [{ type: "injectUserTurn", text: "I1" }];
          },
        },
      })
    );
    const p = inbox([stopR1, injectP, annotateK, endR1, { ...injectP, req: "r2", text: "P2" }]);
    const b = createSessionHookBinding(engine, SESSION, p, { inboxBoundMs: 200 });
    b.fireStart();
    // the hold starts before the dispatch returns: settle() waits for it (H11)
    const r = await b.settle(
      { ...TURN, consecutiveHookTurns: 2, callerInputPending: false },
      new AbortController().signal
    );
    expect(texts(r.injections)).toEqual(["S0", "P", "P2", "I1"]);
    expect(r.injections.map((i) => i.source)).toEqual([
      "sessionStart",
      "proxy",
      "proxy",
      "sessionIdle",
    ]);
    const ctx = seen as unknown as SessionIdleContext;
    expect(ctx.turn.annotations).toEqual([{ hookId: "hook:c/a", key: "k", value: 7 }]);
    expect(ctx.turn.index).toBe(1);
    expect(ctx.consecutiveHookTurns).toBe(2);
    expect(ctx.session.id).toBe("abcd1234");
    expect(journal.filter((j) => j.decision === "queued").map((j) => j.hookId)).toEqual([
      "hook:t/start",
      "hook:c/p",
      "hook:c/p",
      "hook:t/idle",
    ]);
  });

  test("H-36: a request's lines past the recorded length resolve this settle at ~150 ms; another request's line is the next settle's", async () => {
    const { engine } = engineOf();
    const p = inbox([stopR1]);
    const b = createSessionHookBinding(engine, SESSION, p, { inboxBoundMs: 1_000 });
    setTimeout(
      () =>
        appendFileSync(
          p,
          [injectP, endR1, { ...injectP, req: "r2", text: "Q" }]
            .map((l) => `${JSON.stringify(l)}\n`)
            .join("")
        ),
      150
    );
    const t0 = Date.now();
    const r = await b.settle(TURN, new AbortController().signal);
    const took = Date.now() - t0;
    expect(texts(r.injections)).toEqual(["P"]);
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(700);
    expect(b.hasIdleWork(false)).toBe(true);
    const r2 = await b.settle({ ...TURN, index: 2 }, new AbortController().signal);
    expect(texts(r2.injections)).toEqual(["Q"]);
  });

  test("an inbox capped line becomes one pane anomaly and one journal line", async () => {
    const { engine, journal } = engineOf();
    const b = createSessionHookBinding(engine, SESSION, inbox([{ v: 1, kind: "capped" }]), {
      inboxBoundMs: 100,
    });
    const r = await b.settle(TURN, new AbortController().signal);
    expect(r.anomalies).toEqual(["hook_injection_dropped:inbox_cap"]);
    expect(journal.some((j) => j.decision === "dropped" && j.detail === "inbox_cap")).toBe(true);
  });
});

describe("H-35: drained items on every abort reason (§4.7 rule 12)", () => {
  async function abortedRun(reason: string) {
    let called!: () => void;
    const idleCalled = new Promise<void>((r) => {
      called = r;
    });
    let calls = 0;
    const { engine, journal } = engineOf(
      user("idle", {
        timeoutMs: 30_000,
        on: {
          sessionIdle: (ctx) => {
            calls++;
            if (calls === 1) {
              called();
              // waits on its signal: only the abort ends it
              return new Promise((r) =>
                ctx.signal.addEventListener("abort", () =>
                  r([{ type: "injectUserTurn", text: "S" }])
                )
              );
            }
            return [];
          },
        },
      })
    );
    const b = createSessionHookBinding(
      engine,
      SESSION,
      inbox([stopR1, injectP, annotateK, endR1]),
      {
        inboxBoundMs: 200,
      }
    );
    const ac = new AbortController();
    const settled = b.settle(TURN, ac.signal);
    await idleCalled; // the inbox is drained before sessionIdle runs
    ac.abort(reason);
    const r = await settled;
    expect(r.injections).toEqual([]);
    return { b, journal };
  }

  test("rewake: P and k are offered at the next settle() of the same turn", async () => {
    const { b, journal } = await abortedRun("rewake");
    expect(journal.filter((j) => j.decision === "dropped" && j.hookId === "hook:c/p")).toEqual([]);
    expect(b.hasIdleWork(false)).toBe(true);
    // the next settle of the SAME turn carries P (and k into ctx.turn.annotations)
    const r = await b.settle(TURN, new AbortController().signal);
    expect(texts(r.injections)).toEqual(["P"]);
  });

  test("rewake: the carried annotation reaches the next settle's sessionIdle", async () => {
    let seen: SessionIdleContext | null = null;
    let calls = 0;
    const { engine } = engineOf(
      user("idle", {
        on: {
          sessionIdle: (ctx) => {
            calls++;
            if (calls === 1)
              return new Promise((r) => ctx.signal.addEventListener("abort", () => r([])));
            seen = ctx;
            return [];
          },
        },
      })
    );
    const b = createSessionHookBinding(
      engine,
      SESSION,
      inbox([stopR1, injectP, annotateK, endR1]),
      {
        inboxBoundMs: 200,
      }
    );
    const ac = new AbortController();
    const first = b.settle(TURN, ac.signal);
    while (calls === 0) await Bun.sleep(5);
    ac.abort("rewake");
    await first;
    await b.settle(TURN, new AbortController().signal);
    expect((seen as unknown as SessionIdleContext).turn.annotations).toEqual([
      { hookId: "hook:c/a", key: "k", value: 7 },
    ]);
  });

  const dropped = (journal: JournalEntry[], hookId: string) =>
    journal.filter((j) => j.decision === "dropped" && j.hookId === hookId).map((j) => j.detail);

  test("caller: P and k are journaled dropped stale", async () => {
    const { b, journal } = await abortedRun("caller");
    expect(dropped(journal, "hook:c/p")).toEqual(["stale"]);
    expect(dropped(journal, "hook:c/a")).toEqual(["stale"]);
    expect(b.hasIdleWork(false)).toBe(true); // only the idle hook itself remains
  });

  for (const reason of ["watchdog", "error"]) {
    test(`${reason}: dropped, detail hold_ended`, async () => {
      const { journal } = await abortedRun(reason);
      expect(dropped(journal, "hook:c/p")).toEqual(["hold_ended"]);
      expect(dropped(journal, "hook:c/a")).toEqual(["hold_ended"]);
    });
  }

  for (const reason of ["exit", "terminal"]) {
    test(`${reason}: dropped, detail session_ended`, async () => {
      const { journal } = await abortedRun(reason);
      expect(dropped(journal, "hook:c/p")).toEqual(["session_ended"]);
      expect(dropped(journal, "hook:c/a")).toEqual(["session_ended"]);
    });
  }

  test("items a re-wake carried that no later settle takes are dropped session_ended at the end", async () => {
    const { b, journal } = await abortedRun("rewake");
    b.fireEnd({ state: "TIMEOUT", reason: "timeout", exitCode: null });
    expect(dropped(journal, "hook:c/p")).toEqual(["session_ended"]);
    expect(dropped(journal, "hook:c/a")).toEqual(["session_ended"]);
  });
});

describe("a result settle() returned, abandoned by the pane (§4.7 rule 12)", () => {
  const dropped = (journal: JournalEntry[], hookId: string) =>
    journal.filter((j) => j.decision === "dropped" && j.hookId === hookId).map((j) => j.detail);

  /** A settle that RETURNS (no abort): P from the inbox, k annotated, S from sessionIdle. */
  async function returned() {
    let seen: SessionIdleContext | null = null;
    let calls = 0;
    const { engine, journal } = engineOf(
      user("idle", {
        on: {
          sessionIdle: (ctx) => {
            calls++;
            if (calls === 1) return [{ type: "injectUserTurn", text: "S" }];
            seen = ctx;
            return [];
          },
        },
      })
    );
    const b = createSessionHookBinding(
      engine,
      SESSION,
      inbox([stopR1, injectP, annotateK, endR1]),
      { inboxBoundMs: 200 }
    );
    const r = await b.settle(TURN, new AbortController().signal);
    expect(texts(r.injections)).toEqual(["P", "S"]);
    expect(r.annotations).toEqual([{ hookId: "hook:c/a", key: "k", value: 7 }]);
    return { b, r, journal, seen: () => seen };
  }

  test("rewake: P and k are carried to the next settle of the same turn; S is dropped rewake", async () => {
    const { b, r, journal, seen } = await returned();
    b.abandon?.(r, "rewake");
    expect(dropped(journal, "hook:c/p")).toEqual([]);
    expect(dropped(journal, "hook:t/idle")).toEqual(["rewake"]);
    expect(b.hasIdleWork(false)).toBe(true);
    const next = await b.settle(TURN, new AbortController().signal);
    expect(texts(next.injections)).toEqual(["P"]);
    expect((seen() as unknown as SessionIdleContext).turn.annotations).toEqual([
      { hookId: "hook:c/a", key: "k", value: 7 },
    ]);
  });

  test("caller: every item and annotation is dropped stale; nothing is carried", async () => {
    const { b, r, journal } = await returned();
    b.abandon?.(r, "caller");
    expect(dropped(journal, "hook:c/p")).toEqual(["stale"]);
    expect(dropped(journal, "hook:t/idle")).toEqual(["stale"]);
    expect(dropped(journal, "hook:c/a")).toEqual(["stale"]);
    const next = await b.settle(TURN, new AbortController().signal);
    expect(next.injections).toEqual([]);
  });
});

describe("sessionStart outside a hold, and the other events", () => {
  test("a dispatch no hold took is queued into the attached pane", async () => {
    const { engine } = engineOf(
      user("start", { on: { sessionStart: () => [{ type: "injectUserTurn", text: "HELLO" }] } })
    );
    const b = createSessionHookBinding(engine, SESSION, null);
    const queued: HoldInjection[][] = [];
    b.attach?.({ queueInjections: (items) => queued.push(items) });
    b.fireStart();
    b.fireStart(); // once per session
    await Bun.sleep(20);
    expect(queued.map(texts)).toEqual([["HELLO"]]);
    expect(queued[0]?.[0]?.source).toBe("sessionStart");
  });

  test("sessionBlocked and sessionEnd fire, observe-only, with their facts", async () => {
    const seen: string[] = [];
    const { engine } = engineOf(
      user("obs", {
        on: {
          sessionBlocked: (ctx) => void seen.push(`blocked:${ctx.block.kind}:${ctx.block.text}`),
          sessionEnd: (ctx) => void seen.push(`end:${ctx.outcome.state}:${ctx.outcome.exitCode}`),
        },
      })
    );
    const b = createSessionHookBinding(engine, SESSION, null);
    b.fireBlocked({ kind: "question", text: "Which?" });
    b.fireEnd({ state: "COMPLETED", reason: null, exitCode: 0 });
    b.fireEnd({ state: "COMPLETED", reason: null, exitCode: 0 });
    await Bun.sleep(20);
    expect(seen).toEqual(["blocked:question:Which?", "end:COMPLETED:0"]);
  });
});

describe("an owner without hooks (§2.3 step 1)", () => {
  beforeEach(() => resetOwnerWithoutHooksReportForTests());

  test("an inject in the inbox at reap: journaled owner_without_hooks, one stderr line per process", () => {
    const { engine, journal } = engineOf();
    const lines: string[] = [];
    const p = inbox([stopR1, injectP, endR1]);
    expect(reportOwnerWithoutHooks(p, engine, { model: "m" }, (l) => lines.push(l))).toBe(true);
    expect(reportOwnerWithoutHooks(p, engine, { model: "m" }, (l) => lines.push(l))).toBe(true);
    expect(journal.filter((j) => j.detail === "owner_without_hooks")).toHaveLength(2);
    expect(lines).toEqual([
      "a pane child produced hook injections, but this process loaded no session hooks: restart the MCP server after changing hooks.modules",
    ]);
  });

  test("bookkeeping lines only: nothing reported", () => {
    const lines: string[] = [];
    expect(
      reportOwnerWithoutHooks(inbox([stopR1, endR1]), null, { model: "m" }, (l) => lines.push(l))
    ).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("inbox lines the settle did not take", () => {
  test("an inbox line that fails the action rules is journaled invalid and never offered", async () => {
    const { engine, journal } = engineOf(user("e", { on: { responseEnd: () => [] } }));
    const b = createSessionHookBinding(
      engine,
      SESSION,
      inbox([stopR1, { ...injectP, text: "/exit" }, injectP, endR1]),
      { inboxBoundMs: 100 }
    );
    const r = await b.settle(TURN, new AbortController().signal);
    expect(texts(r.injections)).toEqual(["P"]);
    expect(r.anomalies).toContain("hook_injection_dropped:invalid");
    expect(
      journal
        .filter((j) => j.decision === "invalid" && j.hookId === "hook:c/p")
        .map((j) => j.detail)
    ).toEqual(["inbox: slash_command"]);
  });

  test("a request still running at the bound is recorded, not silent", async () => {
    const { engine, journal } = engineOf(user("e", { on: { responseEnd: () => [] } }));
    const b = createSessionHookBinding(engine, SESSION, inbox([stopR1]), { inboxBoundMs: 100 });
    const r = await b.settle(TURN, new AbortController().signal);
    expect(r.anomalies).toContain("hook_inbox_wait_timeout");
    expect(journal.some((j) => j.decision === "timeout" && j.hookId === "inbox")).toBe(true);
  });

  test("payload that arrives after the last settle is journaled session_ended at the sweep", async () => {
    const { engine, journal } = engineOf(user("e", { on: { responseEnd: () => [] } }));
    const path = inbox([stopR1]);
    const b = createSessionHookBinding(engine, SESSION, path, { inboxBoundMs: 100 });
    await b.settle(TURN, new AbortController().signal); // r1 times out
    appendFileSync(path, `${JSON.stringify(injectP)}\n${JSON.stringify(annotateK)}\n`);
    b.fireEnd({ state: "COMPLETED", reason: null, exitCode: 0 });
    b.sweepInbox?.();
    const dropped = journal.filter((j) => j.decision === "dropped" && j.detail === "session_ended");
    expect(dropped.map((j) => [j.hookId, j.action])).toEqual([
      ["hook:c/p", "injectUserTurn"],
      ["hook:c/a", "annotateTurn"],
    ]);
  });
});

describe("a sessionStart dispatch a hold claimed, and the hold's abort", () => {
  for (const order of ["abort lands after the dispatch resolved", "abort lands first"] as const) {
    test(`${order}: the items are queued into the pane, never lost`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const { engine, journal } = engineOf(
        user("start", {
          on: {
            sessionStart: () => gate.then(() => [{ type: "injectUserTurn", text: "HELLO" }]),
          },
        })
      );
      const b = createSessionHookBinding(engine, SESSION, null);
      const queued: HoldInjection[][] = [];
      b.attach?.({ queueInjections: (items) => queued.push(items) });
      b.fireStart();
      const ac = new AbortController();
      const entry = (b as unknown as { start: { promise: Promise<unknown> } }).start;
      // Registered BEFORE settle(): runs after the binding's own handler (which sees the
      // claim and leaves the items to the hold) and before the hold's race sees them.
      if (order === "abort lands after the dispatch resolved")
        void entry.promise.then(() => ac.abort("rewake"));
      const settled = b.settle(TURN, ac.signal);
      if (order === "abort lands first") ac.abort("rewake");
      release();
      const r = await settled;
      await Bun.sleep(20);
      expect(r.injections).toEqual([]);
      expect(queued.map(texts)).toEqual([["HELLO"]]);
      expect(journal.filter((j) => j.hookId === "hook:t/start").map((j) => j.decision)).toEqual([
        "queued",
      ]);
    });
  }
});
