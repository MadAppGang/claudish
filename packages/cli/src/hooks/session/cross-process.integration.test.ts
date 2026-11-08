/**
 * Cross-process session hooks (hook-system architecture §2.3, §11.3 "Cross-process"):
 * the owner (a real MCP `SessionManager` in this process) + the REAL child claudish
 * (`src/index.ts` as `CLAUDISH_BIN`) in a real magmux pane + the fake Claude Code in
 * proxied mode (`FAKE_CLAUDE_PROXY=1`), whose every turn is a streaming `/v1/messages`
 * through the child's proxy to a stub upstream (`stub@fake-model` via `customEndpoints`
 * in the `CLAUDISH_CONFIG` file).
 *
 * The child loads its hooks from that config; the owner's engine is built here. What
 * crosses the process boundary is only the owner-created inbox file.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as logger from "../../logger.js";
import { SessionManager } from "../../mcp-session/session-manager.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
  writeFakeClaudeWrapper,
} from "../../pane/test-helpers/hermetic-env.js";
import {
  type StubScript,
  type StubUpstream,
  startStubUpstream,
  stubEndpointConfig,
} from "../../test-helpers/stub-upstream.js";
import { HookEngine } from "../engine.js";
import type { JournalEntry } from "../journal.js";
import type { HookDefinition, TurnAnnotation } from "../public.js";
import { HookRegistry, type UserHookInput } from "../registry.js";
import { resetOwnerWithoutHooksReportForTests } from "./binding.js";

const INDEX = join(import.meta.dir, "..", "..", "index.ts");
const T = 90_000;

const open = new Set<{ t: PaneTestEnv; stub: StubUpstream }>();
afterAll(() => {
  for (const o of open) {
    o.stub.stop();
    killLeftovers({ sockRoot: o.t.sockRoot });
    o.t.cleanup();
  }
});

function ownerEngine(...defs: Array<Omit<HookDefinition, "apiVersion">>) {
  const journal: JournalEntry[] = [];
  const users: UserHookInput[] = defs.map((d, i) => ({
    id: `hook:owner/${d.id}`,
    module: "/hooks/owner.ts",
    moduleIndex: 0,
    exportIndex: i,
    def: { apiVersion: 1, ...d } as HookDefinition,
  }));
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

interface Rig {
  t: PaneTestEnv;
  stub: StubUpstream;
  manager: SessionManager;
  id: string;
  keylog(): string[];
  info(): ReturnType<SessionManager["getSession"]>;
  output(): string;
}

/**
 * One session: the child's hook module source (written to the test's temp dir and named
 * in `hooks.modules`), the stub's script, and the owner's engine.
 */
async function rig(o: {
  childHooks: string;
  stub: StubScript;
  engine: HookEngine;
  prompt?: string | null;
  extraEnv?: Record<string, string>;
}): Promise<Rig> {
  const stub = startStubUpstream({ format: "openai-sse", script: o.stub });
  const t = makePaneTestEnv();
  open.add({ t, stub });
  const module = join(t.tmp, "child-hooks.js");
  writeFileSync(module, o.childHooks);
  const config = join(t.tmp, "claudish-config.json");
  writeFileSync(
    config,
    JSON.stringify({ ...stubEndpointConfig(stub), hooks: { modules: [module] } }, null, 2)
  );
  Object.assign(t.env, {
    CLAUDISH_BIN: INDEX,
    CLAUDE_PATH: writeFakeClaudeWrapper(t.tmp),
    CLAUDISH_CONFIG: config,
    FAKE_CLAUDE_PROXY: "1",
    FAKE_KEYLOG: join(t.tmp, "keylog.txt"),
    CONTRACT_FAKE_MAX_MS: "80000",
    ...o.extraEnv,
  });
  const manager = new SessionManager({
    maxSessions: 4,
    sessionsDir: join(t.tmp, "sessions"),
    hostPid: 1,
    parentEnv: t.env,
    paneTimings: { replStableMs: 200, corroborationMs: 200 },
    hookEngine: async () => o.engine,
  });
  const prompt = o.prompt === undefined ? "Reply first." : o.prompt;
  const id = await manager.createSession({
    model: "stub@fake-model",
    cwd: t.cwd,
    ...(prompt ? { prompt } : {}),
  });
  return {
    t,
    stub,
    manager,
    id,
    keylog: () => {
      const p = t.env.FAKE_KEYLOG as string;
      return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
    },
    info: () => manager.getSession(id),
    output: () => manager.getOutput(id).output,
  };
}

async function finish(r: Rig): Promise<void> {
  await r.manager.shutdownAll();
  const left = await waitNoOrphans({ sockRoot: r.t.sockRoot }, 10_000);
  r.stub.stop();
  killLeftovers({ sockRoot: r.t.sockRoot });
  for (const o of open) if (o.t === r.t) open.delete(o);
  r.t.cleanup();
  expect(left).toEqual({ processes: [], files: [] });
}

async function until(pred: () => boolean, what: string, ms = 45_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "EMPTY"];

/** A child hook that injects once and annotates every response (never on the injected turn). */
const INJECT_ONCE = `export default [{
  apiVersion: 1,
  id: "inject",
  on: {
    responseEnd(ctx) {
      const last = ctx.request.messages[ctx.request.messages.length - 1];
      const text = typeof last?.content === "string" ? last.content : "";
      if (text.includes("INJECTED")) return [];
      return [
        { type: "injectUserTurn", text: "INJECTED-TURN" },
        { type: "annotateTurn", key: "seen", value: text },
      ];
    },
  },
}];
`;

describe.skipIf(!MAGMUX)(`cross-process injection ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`, () => {
  test(
    "a responseEnd hook in the child injects; the owner delivers it as the next turn; its annotation reaches sessionIdle",
    async () => {
      const seen: TurnAnnotation[][] = [];
      const { engine } = ownerEngine({
        id: "idle",
        on: {
          sessionIdle: (ctx) => {
            seen.push([...ctx.turn.annotations]);
            return [];
          },
        },
      });
      const r = await rig({
        childHooks: INJECT_ONCE,
        stub: [{ parts: [{ text: "STUB-ONE" }] }, { parts: [{ text: "STUB-TWO" }] }],
        engine,
      });
      try {
        await until(() => TERMINAL.includes(r.info().state), "a terminal state");
        const info = r.info();
        expect(info.state).toBe("COMPLETED");
        expect(info.turnsCompleted).toBe(2);
        expect(r.keylog()).toContain("INJECTED-TURN");
        const out = r.output();
        expect(out).toContain("STUB-ONE");
        expect(out).toContain("STUB-TWO");
        // the child's proxy really carried both turns
        expect(r.stub.requests.length).toBe(2);
        expect(seen[0]).toEqual([
          { hookId: "hook:child-hooks/inject", key: "seen", value: "Reply first." },
        ]);
        // the injected turn's response annotated nothing
        expect(seen[1]).toEqual([]);
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "the child is killed between stop and end: the owner's wait ends at the exit, not at the 30.5 s bound",
    async () => {
      // the child's responseEnd never resolves (timeout 30 s): `stop` is on disk, `end` is not
      const hang = `export default [{
  apiVersion: 1, id: "hang", timeoutMs: 30000,
  on: { responseEnd: () => new Promise(() => {}) },
}];
`;
      const { engine } = ownerEngine({
        id: "end",
        timeoutMs: 30_000,
        on: { responseEnd: () => [] },
      });
      const r = await rig({ childHooks: hang, stub: [{ parts: [{ text: "STUB-ONE" }] }], engine });
      try {
        await until(() => r.manager.getDiagnostics(r.id).phase === "SETTLING", "the hold");
        await Bun.sleep(300);
        expect(r.manager.getDiagnostics(r.id).phase).toBe("SETTLING");
        const pid = r.info().panePid as number;
        const t0 = Date.now();
        process.kill(pid, "SIGKILL");
        await until(() => TERMINAL.includes(r.info().state), "a terminal state", 15_000);
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect(r.info().state).toBe("COMPLETED");
        expect(r.output()).toContain("STUB-ONE");
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "a request still streaming at settle (no stop) is not waited for; its later inject is delivered at the next settle",
    async () => {
      // turn 1 is answered at once; a side request (a background subagent's stream) is
      // fired and not awaited, and its stream takes ~4 s. Its responseEnd injects.
      const side = `export default [{
  apiVersion: 1, id: "side",
  on: {
    responseEnd(ctx) {
      const last = ctx.request.messages[ctx.request.messages.length - 1];
      const text = typeof last?.content === "string" ? last.content : "";
      return text === "SIDE-REQUEST" ? [{ type: "injectUserTurn", text: "FROM-SIDE" }] : [];
    },
  },
}];
`;
      const { engine } = ownerEngine({ id: "end", on: { responseEnd: () => [] } });
      const lastText = (body: unknown) => {
        const msgs = (body as { messages?: Array<{ content?: unknown }> }).messages ?? [];
        return JSON.stringify(msgs[msgs.length - 1]?.content ?? "");
      };
      const r2 = await rig({
        childHooks: side,
        engine,
        prompt: null,
        extraEnv: { FAKE_CLAUDE_SIDE: "SIDE-REQUEST" },
        stub: (req) => {
          const last = lastText(req.body);
          if (last.includes("SIDE-REQUEST"))
            return { parts: [{ text: "SIDE-ANSWER" }], deltaChars: 1, chunkDelayMs: 350 };
          if (last.includes("FROM-SIDE")) return { parts: [{ text: "STUB-THREE" }] };
          if (last.includes("second")) return { parts: [{ text: "STUB-TWO" }] };
          return { parts: [{ text: "STUB-ONE" }] };
        },
      });
      const { manager, id } = r2;
      try {
        await until(() => r2.info().state === "AWAITING_INPUT", "boot");
        const t0 = Date.now();
        manager.sendInput(id, "Reply first.");
        await until(
          () => r2.info().turnsCompleted === 1 && r2.info().state === "AWAITING_INPUT",
          "turn 1 settled"
        );
        // settled (and the hold done) while the side stream (~4 s) is still running
        expect(Date.now() - t0).toBeLessThan(3_500);
        expect(r2.keylog()).not.toContain("FROM-SIDE");
        // the side stream ends; its inject waits for the next settle
        await until(
          () =>
            readFileSync(
              join(manager.getDiagnostics(id).sessionDir, "hook-inbox.jsonl"),
              "utf8"
            ).includes("FROM-SIDE"),
          "the side inject in the inbox",
          20_000
        );
        expect(r2.keylog()).not.toContain("FROM-SIDE");
        manager.sendInput(id, "Reply second.");
        await until(
          () => r2.keylog().includes("FROM-SIDE"),
          "FROM-SIDE delivered at the next settle"
        );
        await until(() => r2.info().turnsCompleted === 3, "turn 3");
        expect(r2.output()).toContain("STUB-THREE");
      } finally {
        await finish(r2);
      }
    },
    T
  );

  test(
    "an owner without session hooks and a child whose responseEnd injects: owner_without_hooks at reap, one stderr line",
    async () => {
      resetOwnerWithoutHooksReportForTests();
      const stderr = spyOn(logger, "logStderr");
      const { engine, journal } = ownerEngine(); // no session hook: no binding
      const r = await rig({
        childHooks: INJECT_ONCE,
        stub: [{ parts: [{ text: "STUB-ONE" }] }],
        engine,
      });
      try {
        await until(() => TERMINAL.includes(r.info().state), "a terminal state");
        expect(r.info().state).toBe("COMPLETED");
        expect(r.info().turnsCompleted).toBe(1);
        expect(r.keylog()).not.toContain("INJECTED-TURN");
        await until(
          () => journal.some((j) => j.detail === "owner_without_hooks"),
          "the reap check",
          20_000
        );
        const lines = stderr.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes("loaded no session hooks"));
        expect(lines).toEqual([
          "a pane child produced hook injections, but this process loaded no session hooks: restart the MCP server after changing hooks.modules",
        ]);
        // the owner deletes the inbox at reap
        expect(
          existsSync(join(r.manager.getDiagnostics(r.id).sessionDir, "hook-inbox.jsonl"))
        ).toBe(false);
      } finally {
        stderr.mockRestore();
        await finish(r);
      }
    },
    T
  );
});
