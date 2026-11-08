/**
 * The interactive driver (hook-system architecture §7.5, §11.3 "Interactive driver").
 *
 * A HEADLESS magmux stands in for the visible one: the driver gets its socket path and
 * pane id (the injection seam), and the pane runs the fake interactive child in scripted
 * mode (`fake-scripted`, `FAKE_SCRIPT`, `FAKE_KEYLOG`). A second `MagmuxClient` plays the
 * human: it types into the same pane, as a person at the keyboard would.
 *
 * The binding is a test double whose `settle()` returns a promise the test resolves,
 * except where a test says "real binding". The last two blocks drive production code
 * end to end: the own-pane search inside a real two-pane magmux, and the real
 * `claudish -i` (ambient mode, minted session id, `--add-dir`) with the proxied fake
 * and a stub upstream, where a `responseEnd` annotation crosses the in-process sink
 * into `sessionIdle`, whose injection becomes the next turn.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagmuxClient } from "../../pane/magmux-client.js";
import {
  FAKE_CHILD,
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  writeFakeClaudeWrapper,
} from "../../pane/test-helpers/hermetic-env.js";
import { TranscriptFollower } from "../../pane/transcript-follower.js";
import {
  type StubUpstream,
  startStubUpstream,
  stubEndpointConfig,
} from "../../test-helpers/stub-upstream.js";
import { HookEngine } from "../engine.js";
import { InProcessSink } from "../injection/sinks.js";
import type { JournalEntry } from "../journal.js";
import type { HookDefinition } from "../public.js";
import { HookRegistry, type UserHookInput } from "../registry.js";
import type {
  BindingPane,
  HoldInjection,
  HoldResult,
  HoldTurnInfo,
  SessionHookBinding,
} from "./binding.js";
import { InteractiveDriver, type InteractiveDriverOptions } from "./interactive-driver.js";

const T = 60_000;
const INDEX = join(import.meta.dir, "..", "..", "index.ts");
const PROBE = join(import.meta.dir, "test-helpers", "own-pane-probe.ts");

/* ───────────────────────────── the test double binding ───────────────────────────── */

interface SettleCall {
  turn: HoldTurnInfo;
  signal: AbortSignal;
  resolve(r: HoldResult): void;
}

function controlled(o: { idle?: boolean } = {}) {
  const calls: SettleCall[] = [];
  const dropped: Array<{ text: string; reason: string }> = [];
  const delivered: Array<{ text: string; at: number }> = [];
  const abandoned: Array<{ text: string; reason: string }> = [];
  const blocked: Array<{ kind: string; text: string }> = [];
  const ends: Array<{ state: string; exitCode: number | null }> = [];
  let starts = 0;
  let pane: BindingPane | null = null;
  const binding: SessionHookBinding = {
    maxConsecutive: 3,
    hasIdleWork: () => o.idle ?? true,
    settle: (turn, signal) =>
      new Promise<HoldResult>((resolve) => calls.push({ turn, signal, resolve })),
    holdBoundMs: () => 30_000,
    fireStart() {
      starts++;
    },
    fireBlocked: (b) => void blocked.push(b),
    fireEnd: (e) => void ends.push(e),
    attach(p) {
      pane = p;
    },
    noteDropped: (item, reason) => void dropped.push({ text: item.text, reason }),
    noteDelivered: (item) => void delivered.push({ text: item.text, at: Date.now() }),
    abandon: (res, reason) => {
      for (const i of res.injections) abandoned.push({ text: i.text, reason });
    },
  };
  return {
    binding,
    calls,
    dropped,
    abandoned,
    delivered,
    blocked,
    ends,
    starts: () => starts,
    pane: () => pane as BindingPane | null,
  };
}

const inject = (text: string): HoldResult => ({
  injections: [{ text, hookIds: ["hook:t/x"], source: "sessionIdle" }],
});
const nothing: HoldResult = { injections: [] };

function engineOf(...defs: Array<Omit<HookDefinition, "apiVersion">>) {
  const journal: JournalEntry[] = [];
  const users: UserHookInput[] = defs.map((d, i) => ({
    id: `hook:t/${d.id}`,
    module: "/hooks/t.ts",
    moduleIndex: 0,
    exportIndex: i,
    def: { apiVersion: 1, ...d } as HookDefinition,
  }));
  const engine = new HookEngine({
    registry: new HookRegistry([], users, undefined),
    config: {},
    hostMode: "interactive",
    journalSink: (e) => journal.push(e),
    warn: () => {},
    drainTelemetryOutbox: false,
  });
  return { engine, journal };
}

/* ───────────────────────────── the rig ───────────────────────────── */

interface TurnScript {
  say?: string;
  ask?: string;
  noWitness?: boolean;
  delayMs?: number;
  rewake?: {
    delayMs: number;
    say: string;
    workingMs?: number;
    quietMs?: number;
    gateFile?: string;
  };
}

interface Rig {
  t: PaneTestEnv;
  uuid: string;
  sock: string;
  transcript: string;
  turnDir: string;
  magmux: ChildProcess;
  human: MagmuxClient;
  driver: InteractiveDriver | null;
  sink: InProcessSink;
  keylog(): string[];
  /** type into the pane as the human does */
  type(text: string, enter?: boolean): Promise<void>;
  startDriver(o?: Partial<InteractiveDriverOptions>): Promise<InteractiveDriver>;
}

const rigs = new Set<Rig>();
afterAll(() => {
  for (const r of rigs) cleanupRig(r);
});

function cleanupRig(r: Rig): void {
  rigs.delete(r);
  r.human.close();
  try {
    if (r.magmux.pid) process.kill(-r.magmux.pid, "SIGKILL");
  } catch {
    // gone
  }
  killLeftovers({ sockRoot: r.t.sockRoot, ids: [r.uuid] });
  r.t.cleanup();
}

async function finish(r: Rig): Promise<void> {
  await r.driver?.stop({ state: "COMPLETED", reason: null, exitCode: 0 });
  cleanupRig(r);
}

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Spawn a headless magmux whose pane 0 runs the scripted fake, and dial it as the human. */
async function rig(
  script: TurnScript[],
  o: {
    binding?: SessionHookBinding;
    extraEnv?: Record<string, string>;
    driver?: Partial<InteractiveDriverOptions>;
    startDriver?: boolean;
  } = {}
): Promise<Rig> {
  const t = makePaneTestEnv({
    FAKE_SCRIPT: JSON.stringify(script),
    CONTRACT_FAKE_MAX_MS: "60000",
    COLUMNS: "160",
    LINES: "50",
    ...o.extraEnv,
  });
  t.env.FAKE_KEYLOG = join(t.tmp, "keylog.txt");
  mkdirSync(t.sockRoot, { recursive: true });
  const uuid = randomUUID();
  const id = `drv${randomBytes(3).toString("hex")}`;
  const sock = join(t.sockRoot, `magmux-${id}.sock`);
  const turnDir = mkdtempSync(join(t.tmp, "turns-"));
  const cmd = `exec ${shq(process.execPath)} ${shq(FAKE_CHILD)} --model fake-scripted --session-id ${uuid}`;
  const magmux = spawn(
    MAGMUX as string,
    ["--headless", "--no-status", "--id", id, "--sock-dir", t.sockRoot, "-e", cmd],
    { cwd: t.cwd, env: t.env, stdio: ["ignore", "ignore", "ignore"], detached: true }
  );
  magmux.on("error", () => {});
  const human = await MagmuxClient.connect(sock, { timeoutMs: 10_000 });
  const sink = new InProcessSink(undefined, undefined, () => {});
  const r: Rig = {
    t,
    uuid,
    sock,
    transcript: t.transcriptPathFor(uuid),
    turnDir,
    magmux,
    human,
    driver: null,
    sink,
    keylog: () => {
      const p = t.env.FAKE_KEYLOG as string;
      return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
    },
    async type(text, enter = true) {
      const res = await human.request({ type: "send", pane: 0, text, typed: true, enter });
      if (!res.ok) throw new Error(`human send failed: ${res.code} ${res.error}`);
    },
    async startDriver(extra = {}) {
      const d = new InteractiveDriver({
        mode: "wrap",
        sockPath: sock,
        pane: 0,
        cwd: t.cwd,
        sessionId: uuid,
        projectsRoot: join(t.configDir, "projects"),
        turnDir,
        readAvailable: true,
        model: "fake-scripted",
        sink,
        warn: () => {},
        ...(o.binding ? { binding: o.binding } : {}),
        ...o.driver,
        ...extra,
        // merged last, so a test's own timings refine the fast defaults, never replace them
        timings: {
          tickMs: 100,
          typingHoldMs: 300,
          replStableMs: 200,
          corroborationMs: 200,
          ...o.driver?.timings,
          ...extra.timings,
        },
      });
      r.driver = d;
      await d.start();
      return d;
    },
  };
  rigs.add(r);
  if (o.startDriver !== false) await r.startDriver();
  return r;
}

async function until(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const sha8 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);

/* ───────────────────────────── turns and the latch ───────────────────────────── */

describe.skipIf(!MAGMUX)(`interactive driver: turns ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`, () => {
  test(
    "the human witness opens turns; one settle per settled turn across ticks; sessionStart at the first empty box",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1" }, { say: "A2" }], { binding: dbl.binding });
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        expect(dbl.starts()).toBe(1);
        await r.type("first prompt");
        await until(() => dbl.calls.length === 1, "the first settle");
        expect(dbl.calls[0]?.turn).toMatchObject({
          index: 1,
          answer: "A1",
          hookCaused: false,
          apiError: false,
        });
        expect(d.snapshot().phase).toBe("SETTLING");
        // ≥ 10 ticks and frames: the latch holds, nothing settles the turn again
        await Bun.sleep(1_200);
        expect(dbl.calls.length).toBe(1);
        dbl.calls[0]?.resolve(nothing);
        await until(() => d.snapshot().phase === "OPEN", "OPEN after the hold");
        await Bun.sleep(600);
        expect(dbl.calls.length).toBe(1);
        await r.type("second prompt");
        await until(() => dbl.calls.length === 2, "the second settle");
        expect(dbl.calls[1]?.turn).toMatchObject({ index: 2, answer: "A2", hookCaused: false });
        expect(d.snapshot()).toMatchObject({ callerAdmitted: 2, consecutiveHookTurns: 0 });
        expect(dbl.starts()).toBe(1);
        // the human's lines reached the fake; the driver typed nothing
        expect(r.keylog()).toEqual(["first prompt", "second prompt"]);
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "a command-line prompt written before boot-ready opens turn 1 (offset 0)",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1" }], {
        binding: dbl.binding,
        extraEnv: { FAKE_INITIAL_PROMPT: "prompt from argv" },
        startDriver: false,
      });
      try {
        // The record and its answer are on disk BEFORE the driver exists.
        await until(
          () =>
            existsSync(r.transcript) &&
            readFileSync(r.transcript, "utf8").includes("turn_duration"),
          "the argv turn in the transcript"
        );
        // Control: a turn opened at the current size — the offset a driver would take if
        // it did not open turn 1 at 0 — never sees the prompt.
        const control = new TranscriptFollower(r.transcript, join(r.t.tmp, "none"));
        control.poll();
        control.openTurn({ index: 1, offset: control.size(), witness: { kind: "human" } });
        control.poll();
        expect(control.view().current?.acceptedAt).toBeNull();

        const d = await r.startDriver();
        await until(() => dbl.calls.length === 1, "the argv turn's settle");
        expect(dbl.calls[0]?.turn).toMatchObject({ index: 1, answer: "A1", hookCaused: false });
        expect(d.snapshot().callerAdmitted).toBe(1);
        expect(r.keylog()).toEqual([]);
      } finally {
        await finish(r);
      }
    },
    T
  );
});

/* ───────────────────────────── delivery ───────────────────────────── */

describe.skipIf(!MAGMUX)(`interactive driver: delivery ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`, () => {
  test(
    "an injection returned at settle is typed as the next turn, which settles hook-caused",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1" }, { say: "A2" }], { binding: dbl.binding });
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        dbl.calls[0]?.resolve(inject("HOOK-PING"));
        await until(() => r.keylog().includes("HOOK-PING"), "the injected line");
        await until(() => dbl.calls.length === 2, "settle 2");
        expect(dbl.calls[1]?.turn).toMatchObject({ index: 2, answer: "A2", hookCaused: true });
        expect(dbl.calls[1]?.turn.consecutiveHookTurns).toBe(1);
        expect(dbl.delivered.map((x) => x.text)).toEqual(["HOOK-PING"]);
        expect(dbl.dropped).toEqual([]);
        expect(d.snapshot()).toMatchObject({ callerAdmitted: 1, consecutiveHookTurns: 1 });
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "a long injection goes to a turn file in the --add-dir turn dir, and the child reads it",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1" }, {}], { binding: dbl.binding });
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        const long = `line one of the hook's message\n${"x".repeat(700)}\nlast line`;
        dbl.calls[0]?.resolve(inject(long));
        await until(() => dbl.calls.length === 2, "settle 2");
        const typed = r.keylog()[1] as string;
        expect(typed).toStartWith(`Your task is in the file \`${join(r.turnDir, "turn-1.md")}\``);
        expect(readdirSync(r.turnDir)).toEqual(["turn-1.md"]);
        expect(readFileSync(join(r.turnDir, "turn-1.md"), "utf8")).toBe(long);
        // the fake answers with the hash of what it READ: the whole text arrived
        expect(dbl.calls[1]?.turn).toMatchObject({
          index: 2,
          hookCaused: true,
          answer: `ANSWER fake-scripted ${sha8(long)}`,
        });
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "the gate: never while the box holds text; only after the box was empty and unchanged for the typing hold",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1" }, { say: "A2" }], {
        binding: dbl.binding,
        driver: { timings: { typingHoldMs: 1_500 } },
      });
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        await r.type("half-typed", false);
        await Bun.sleep(400);
        dbl.calls[0]?.resolve(inject("HOOK"));
        await Bun.sleep(2_500);
        expect(dbl.delivered).toEqual([]);
        expect(r.keylog()).toEqual(["go"]);
        expect(d.snapshot().pendingHookInputs).toBe(1);
        // the human clears the box (ctrl-u): the hold restarts from that change
        await r.type("\u0015", false);
        const cleared = Date.now();
        await until(() => dbl.delivered.length === 1, "delivery after the hold");
        const waited = (dbl.delivered[0]?.at as number) - cleared;
        expect(waited).toBeGreaterThanOrEqual(1_400);
        expect(waited).toBeLessThan(4_000);
        await until(() => r.keylog().includes("HOOK"), "the injected line");
        expect(r.keylog()).not.toContain("half-typed");
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "a human prompt witnessed before delivery makes the pending injection stale",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1" }, { say: "A2" }], { binding: dbl.binding });
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        await r.type("draft", false);
        // Let the draft reach the screen first: a keystroke inside the last frame before
        // the send is the accepted residual race (§7.5), not what this test is about.
        await Bun.sleep(600);
        dbl.calls[0]?.resolve(inject("HOOK"));
        await until(() => d.snapshot().phase === "OPEN", "OPEN");
        // the human replaces the draft and submits it
        await r.type("\u0015the human's own turn");
        await until(() => dbl.calls.length === 2, "settle 2");
        expect(dbl.calls[1]?.turn).toMatchObject({ index: 2, answer: "A2", hookCaused: false });
        dbl.calls[1]?.resolve(nothing);
        await until(() => dbl.dropped.length === 1, "the stale drop");
        expect(dbl.dropped).toEqual([{ text: "HOOK", reason: "stale" }]);
        await Bun.sleep(800);
        expect(r.keylog()).toEqual(["go", "the human's own turn"]);
        expect(dbl.delivered).toEqual([]);
        expect(d.snapshot()).toMatchObject({ callerAdmitted: 2, pendingHookInputs: 0 });
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "never Esc: an injection queued during a question waits, and no key but its own line is ever sent",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1" }, { ask: "Which one?" }], { binding: dbl.binding });
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        dbl.calls[0]?.resolve(nothing);
        await until(() => d.snapshot().phase === "OPEN", "OPEN");
        await r.type("ask me");
        await until(() => dbl.blocked.length === 1, "sessionBlocked");
        expect(dbl.blocked[0]?.kind).toBe("question");
        const pane = dbl.pane();
        expect(pane).not.toBeNull();
        pane?.queueInjections([
          { text: "HOOK", hookIds: ["hook:t/x"], source: "sessionStart" } satisfies HoldInjection,
        ]);
        await Bun.sleep(2_500);
        expect(r.keylog()).toEqual(["go", "ask me"]);
        expect(r.keylog()).not.toContain("<ESC>");
        expect(dbl.delivered).toEqual([]);
        expect(d.snapshot()).toMatchObject({ phase: "RUNNING", pendingHookInputs: 1 });
        expect(dbl.blocked.length).toBe(1);
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "acceptance: an injected line whose witness never appears is dropped send_not_accepted",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1" }, { noWitness: true }], {
        binding: dbl.binding,
        driver: { timings: { acceptMs: 1_000 } },
      });
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        dbl.calls[0]?.resolve(inject("HOOK"));
        await until(() => r.keylog().includes("HOOK"), "the typed line");
        expect(d.snapshot().phase).toBe("ADMITTING");
        await until(() => dbl.dropped.length === 1, "the acceptance timeout", 5_000);
        expect(dbl.dropped).toEqual([{ text: "HOOK", reason: "send_not_accepted" }]);
        expect(d.snapshot().phase).toBe("OPEN");
        expect(dbl.calls.length).toBe(1);
      } finally {
        await finish(r);
      }
    },
    T
  );
});

/* ───────────────────────────── re-wake (D23) ───────────────────────────── */

describe.skipIf(!MAGMUX)(
  `interactive driver: a lost send reply ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`,
  () => {
    /**
     * The driver's send of `text` reaches magmux (with `enter` as given here), and its
     * reply is then reported lost (`client_timeout`), as a dropped socket would.
     */
    function loseReplyOf(text: string, enter: boolean): () => void {
      const proto = MagmuxClient.prototype as unknown as {
        request(msg: Record<string, unknown>, ms?: number): Promise<unknown>;
      };
      const original = proto.request;
      proto.request = async function (this: unknown, msg: Record<string, unknown>, ms?: number) {
        if (msg.type !== "send" || msg.text !== text) return original.call(this, msg, ms);
        await original.call(this, { ...msg, enter }, ms);
        return { ok: false, code: "client_timeout", error: "no reply (test)" };
      };
      return () => {
        proto.request = original;
      };
    }

    /**
     * The driver's send of `text` is typed without its Enter, then the connection
     * closes before the reply: the old client can deliver nothing more.
     */
    function dropConnectionAfter(text: string): () => void {
      const proto = MagmuxClient.prototype as unknown as {
        request(msg: Record<string, unknown>, ms?: number): Promise<unknown>;
      };
      const original = proto.request;
      proto.request = async function (
        this: MagmuxClient,
        msg: Record<string, unknown>,
        ms?: number
      ) {
        if (msg.type !== "send" || msg.text !== text) return original.call(this, msg, ms);
        await original.call(this, { ...msg, enter: false }, ms);
        // as `onClose` does: the reply is reported lost once the socket has closed
        this.close();
        while (!this.isClosed) await Bun.sleep(5);
        return { ok: false, code: "client_lost", error: "connection closed (test)" };
      };
      return () => {
        proto.request = original;
      };
    }

    test(
      "the connection closed after the line was typed, its Enter lost: Enter goes through the new connection",
      async () => {
        const dbl = controlled();
        const r = await rig([{ say: "A1" }, { say: "A2" }], { binding: dbl.binding });
        const restore = dropConnectionAfter("HOOK-LOST");
        try {
          const d = r.driver as InteractiveDriver;
          await until(() => d.snapshot().booted, "boot");
          await r.type("go");
          await until(() => dbl.calls.length === 1, "settle 1");
          dbl.calls[0]?.resolve(inject("HOOK-LOST"));
          await until(() => dbl.calls.length === 2, "settle 2", 25_000);
          expect(dbl.dropped).toEqual([]);
          expect(dbl.calls[1]?.turn).toMatchObject({ index: 2, answer: "A2", hookCaused: true });
          expect(r.keylog()).toEqual(["go", "HOOK-LOST"]);
        } finally {
          restore();
          await finish(r);
        }
      },
      T
    );

    for (const enter of [true, false]) {
      test(
        `the line was typed${enter ? " and entered" : ", its Enter lost"}: the injection is accepted as the hook's turn`,
        async () => {
          const dbl = controlled();
          const r = await rig([{ say: "A1" }, { say: "A2" }], { binding: dbl.binding });
          const restore = loseReplyOf("HOOK-LOST", enter);
          try {
            const d = r.driver as InteractiveDriver;
            await until(() => d.snapshot().booted, "boot");
            await r.type("go");
            await until(() => dbl.calls.length === 1, "settle 1");
            dbl.calls[0]?.resolve(inject("HOOK-LOST"));
            await until(() => dbl.calls.length === 2, "settle 2", 25_000);
            expect(dbl.dropped).toEqual([]);
            expect(dbl.calls[1]?.turn).toMatchObject({ index: 2, answer: "A2", hookCaused: true });
            expect(d.snapshot()).toMatchObject({ callerAdmitted: 1, consecutiveHookTurns: 1 });
            expect(r.keylog()).toEqual(["go", "HOOK-LOST"]);
          } finally {
            restore();
            await finish(r);
          }
        },
        T
      );
    }
  }
);

describe.skipIf(!MAGMUX)(`interactive driver: re-wake ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`, () => {
  test(
    "a notification during a pending injection neither drops it stale nor resets the cap; the turn settles again with its index",
    async () => {
      const dbl = controlled();
      const r = await rig(
        [{ say: "A1", rewake: { delayMs: 1_200, say: "A1b" } }, { say: "A2" }, { say: "A3" }],
        { binding: dbl.binding, driver: { timings: { typingHoldMs: 3_500 } } }
      );
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        dbl.calls[0]?.resolve(inject("HOOK"));
        await until(() => d.snapshot().phase === "OPEN", "OPEN with the injection pending");
        expect(d.snapshot().pendingHookInputs).toBe(1);
        // the background notification wakes the model: the SAME turn settles again
        await until(() => dbl.calls.length === 2, "the re-woken turn's settle");
        expect(dbl.calls[1]?.turn).toMatchObject({ index: 1, hookCaused: false });
        expect(dbl.calls[1]?.turn.answer).toContain("A1b");
        expect(d.snapshot()).toMatchObject({ callerAdmitted: 1, consecutiveHookTurns: 0 });
        expect(dbl.dropped).toEqual([]);
        dbl.calls[1]?.resolve(nothing);
        // the injection survived and is delivered once the gate opens
        await until(() => r.keylog().includes("HOOK"), "the injection", 10_000);
        await until(() => dbl.calls.length === 3, "the hook turn's settle");
        expect(dbl.calls[2]?.turn).toMatchObject({ index: 2, hookCaused: true, answer: "A2" });
        expect(dbl.dropped).toEqual([]);
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "a re-wake DURING the hold aborts it with reason rewake; the same turn is held again",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1", rewake: { delayMs: 1_000, say: "A1b" } }], {
        binding: dbl.binding,
      });
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        await until(() => dbl.calls[0]?.signal.aborted === true, "the hold's abort");
        expect(dbl.calls[0]?.signal.reason).toBe("rewake");
        await until(() => dbl.calls.length === 2, "the second hold of turn 1");
        expect(dbl.calls[1]?.turn.index).toBe(1);
        // a late result of the abandoned hold changes nothing
        dbl.calls[0]?.resolve(inject("LATE"));
        dbl.calls[1]?.resolve(nothing);
        await Bun.sleep(1_000);
        expect(r.keylog()).toEqual(["go"]);
        expect(d.snapshot()).toMatchObject({ phase: "OPEN", callerAdmitted: 1 });
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "a human prompt DURING the hold aborts it with reason caller",
    async () => {
      const dbl = controlled();
      const r = await rig([{ say: "A1" }, { say: "A2" }], { binding: dbl.binding });
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        await r.type("again");
        await until(() => dbl.calls[0]?.signal.aborted === true, "the hold's abort");
        expect(dbl.calls[0]?.signal.reason).toBe("caller");
        dbl.calls[0]?.resolve(inject("HOOK"));
        await until(() => dbl.calls.length === 2, "settle 2");
        expect(dbl.calls[1]?.turn).toMatchObject({ index: 2, answer: "A2", hookCaused: false });
        dbl.calls[1]?.resolve(nothing);
        await Bun.sleep(800);
        expect(r.keylog()).toEqual(["go", "again"]);
      } finally {
        await finish(r);
      }
    },
    T
  );

  test(
    "a re-wake already in the transcript when the hold's result arrives: nothing is typed; the result is abandoned rewake",
    async () => {
      const dbl = controlled();
      // the fake starts its re-wake when this file exists: after the test saw the hold
      const gate = join(tmpdir(), `claudish-rewake-gate-${randomUUID()}`);
      const r = await rig(
        [
          { say: "A1", rewake: { gateFile: gate, delayMs: 100, quietMs: 3_000, say: "A1-B" } },
          { say: "A2" },
        ],
        { binding: dbl.binding }
      );
      try {
        const d = r.driver as InteractiveDriver;
        await until(() => d.snapshot().booted, "boot");
        await r.type("go");
        await until(() => dbl.calls.length === 1, "settle 1");
        writeFileSync(gate, "");
        // The re-wake's records land with no redraw: the screen still shows the idle box,
        // and the driver's last poll is older than them. Resolve the instant they exist.
        const end = Date.now() + 20_000;
        while (!readFileSync(r.transcript, "utf8").includes("A1-B")) {
          if (Date.now() > end) throw new Error("timed out waiting for the re-wake's records");
          await Bun.sleep(2);
        }
        dbl.calls[0]?.resolve(inject("HOOK-LATE"));
        await until(
          () => dbl.calls.length === 2 || r.keylog().includes("HOOK-LATE"),
          "the re-woken turn's settle, or the injection typed over it"
        );
        expect(r.keylog()).toEqual(["go"]);
        // Either the result came back (abandoned rewake), or, rarely, the driver's own
        // backstop poll saw the records first and ended the hold before it arrived.
        if ((dbl.calls[0]?.signal.reason as string | undefined) !== "rewake")
          expect(dbl.abandoned).toEqual([{ text: "HOOK-LATE", reason: "rewake" }]);
        expect(dbl.delivered).toEqual([]);
        expect(dbl.calls[1]?.turn.index).toBe(1);
        expect(dbl.calls[1]?.turn.answer).toContain("A1-B");
        expect(d.snapshot()).toMatchObject({ callerAdmitted: 1, consecutiveHookTurns: 0 });
      } finally {
        rmSync(gate, { force: true });
        await finish(r);
      }
    },
    T
  );
});

/* ───────────────────────────── the session id from requests ───────────────────────────── */

describe.skipIf(!MAGMUX)(
  `interactive driver: session from requests ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`,
  () => {
    test(
      "--resume: no id at boot; the first request's id opens the turn at its last human prompt",
      async () => {
        const dbl = controlled();
        const r = await rig([{ say: "A1", delayMs: 400 }, { say: "A2" }], {
          binding: dbl.binding,
          driver: { sessionId: null },
        });
        try {
          const d = r.driver as InteractiveDriver;
          await until(() => d.snapshot().booted, "boot");
          expect(d.snapshot()).toMatchObject({ phase: "NONE", sessionId: null });
          await r.type("resumed prompt");
          // Claude Code writes the prompt, THEN sends the request that names the session.
          await until(
            () =>
              existsSync(r.transcript) &&
              readFileSync(r.transcript, "utf8").includes("resumed prompt"),
            "the prompt record"
          );
          r.sink.noteSessionId(r.uuid);
          expect(d.snapshot().sessionId).toBe(r.uuid);
          await until(() => dbl.calls.length === 1, "the turn's settle");
          expect(dbl.calls[0]?.turn).toMatchObject({ index: 1, answer: "A1", hookCaused: false });
          dbl.calls[0]?.resolve(nothing);
          // a late request naming no other session changes nothing; the next turn is followed
          r.sink.noteSessionId(r.uuid);
          await r.type("next");
          await until(() => dbl.calls.length === 2, "the next settle");
          expect(dbl.calls[1]?.turn).toMatchObject({ index: 2, answer: "A2" });
        } finally {
          await finish(r);
        }
      },
      T
    );

    test(
      "an id whose transcript never appears is not followed",
      async () => {
        const dbl = controlled();
        const r = await rig([{ say: "A1" }], {
          binding: dbl.binding,
          driver: { timings: { tickMs: 100 } },
        });
        try {
          const d = r.driver as InteractiveDriver;
          await until(() => d.snapshot().booted, "boot");
          r.sink.noteSessionId(randomUUID());
          await Bun.sleep(500);
          expect(d.snapshot().sessionId).toBe(r.uuid);
          await r.type("still followed");
          await until(() => dbl.calls.length === 1, "the settle on the original session");
        } finally {
          await finish(r);
        }
      },
      T
    );
  }
);

/* ───────────────────────────── real binding: sessionStart, sessionEnd ───────────────────────────── */

describe.skipIf(!MAGMUX)(
  `interactive driver: real binding ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`,
  () => {
    test(
      "a sessionStart injection is typed at the first idle; stop() fires sessionEnd and waits for it",
      async () => {
        let endSeen = null as { state: string; exitCode: number | null } | null;
        const { engine, journal } = engineOf(
          {
            id: "start",
            on: { sessionStart: () => [{ type: "injectUserTurn", text: "START-PING" }] },
          },
          {
            id: "end",
            on: {
              sessionEnd: async (ctx) => {
                await Bun.sleep(300);
                endSeen = { state: ctx.outcome.state, exitCode: ctx.outcome.exitCode };
                return [];
              },
            },
          }
        );
        const r = await rig([{ say: "S1" }], { startDriver: false });
        try {
          const d = await r.startDriver({ engine });
          await until(() => r.keylog().includes("START-PING"), "the sessionStart injection");
          await until(() => d.snapshot().settles === 1, "its turn's settle");
          expect(d.snapshot()).toMatchObject({ consecutiveHookTurns: 1, callerAdmitted: 0 });
          expect(
            journal.some(
              (j) =>
                j.hookId === "hook:t/start" &&
                j.decision === "delivered" &&
                j.action === "injectUserTurn"
            )
          ).toBe(true);
          const t0 = Date.now();
          await d.stop({ state: "COMPLETED", reason: null, exitCode: 0 });
          expect(endSeen).toEqual({ state: "COMPLETED", exitCode: 0 });
          expect(Date.now() - t0).toBeLessThan(1_500);
        } finally {
          await finish(r);
        }
      },
      T
    );

    test(
      "stop() waits at most 1.5 s for a sessionEnd hook that never returns",
      async () => {
        const { engine } = engineOf({
          id: "hang",
          on: { sessionEnd: () => new Promise(() => {}) },
        });
        const r = await rig([], { startDriver: false });
        try {
          const d = await r.startDriver({ engine });
          await until(() => d.snapshot().booted, "boot");
          const t0 = Date.now();
          await d.stop({ state: "COMPLETED", reason: null, exitCode: 0 });
          const took = Date.now() - t0;
          expect(took).toBeGreaterThanOrEqual(1_000);
          expect(took).toBeLessThan(2_500);
        } finally {
          await finish(r);
        }
      },
      T
    );
  }
);

/* ───────────────────────────── ambient: the own pane ───────────────────────────── */

describe.skipIf(!MAGMUX)(`ambient: own pane ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`, () => {
  test(
    "found via list + ancestry: pane 1 of a grid, not 0, in both layouts",
    async () => {
      const t = makePaneTestEnv();
      mkdirSync(t.sockRoot, { recursive: true });
      const procs: ChildProcess[] = [];
      try {
        for (const layout of ["exec", "child-of-shell"] as const) {
          const out = join(t.tmp, `probe-${layout}.json`);
          const run = `${shq(process.execPath)} ${shq(PROBE)} ${shq(out)}`;
          const id = `own${randomBytes(3).toString("hex")}`;
          const m = spawn(
            MAGMUX as string,
            [
              "--headless",
              "--no-status",
              "--id",
              id,
              "--sock-dir",
              t.sockRoot,
              "-e",
              "sleep 30",
              "-e",
              // (a) the probe IS the pane process; (b) a shell stays the pane process
              layout === "exec" ? `exec ${run}` : `${run}; sleep 1`,
            ],
            { cwd: t.cwd, env: t.env, stdio: "ignore", detached: true }
          );
          m.on("error", () => {});
          procs.push(m);
          await until(() => existsSync(out), `the probe's answer (${layout})`);
          const got = JSON.parse(readFileSync(out, "utf8"));
          expect(got.pane).toBe(1);
          expect(got.listed.panes.find((p: { pane: number }) => p.pane === 0).pid).not.toBe(
            got.pid
          );
        }
      } finally {
        for (const m of procs)
          try {
            if (m.pid) process.kill(-m.pid, "SIGKILL");
          } catch {
            // gone
          }
        killLeftovers({ sockRoot: t.sockRoot });
        t.cleanup();
      }
    },
    T
  );
});

/* ───────────────────────────── end to end: claudish -i ───────────────────────────── */

/**
 * The hermetic twin of live check 1: the REAL `claudish -i` runs inside a magmux pane,
 * so it is in AMBIENT mode (the pane exports `MAGMUX_SOCK`): it mints the session id,
 * adds the turn dir, installs the in-process sink, finds its own pane by ancestry and
 * starts the driver. Claude Code is the proxied fake; its every turn goes through
 * claudish's proxy to the stub upstream. The child's hooks come from `CLAUDISH_CONFIG`:
 * `responseEnd` annotates each response (through the in-process sink), and
 * `sessionIdle` injects HOOK-PING once, only when that annotation arrived.
 */
const E2E_HOOKS = (endMarker: string) => `import { renameSync, writeFileSync } from "node:fs";
export default [{
  apiVersion: 1,
  id: "ping",
  on: {
    responseEnd(ctx) {
      return [{ type: "annotateTurn", key: "seen", value: ctx.response.text }];
    },
    sessionIdle(ctx) {
      if (ctx.turn.hookCaused) return [];
      if (!ctx.turn.annotations.some((a) => a.key === "seen" && a.value === "STUB-ONE")) return [];
      return [{ type: "injectUserTurn", text: "HOOK-PING" }];
    },
    sessionEnd(ctx) {
      // Written whole and renamed into place: the test polls for the file, and a
      // plain write is visible empty before its JSON lands.
      writeFileSync(${JSON.stringify(`${endMarker}.tmp`)}, JSON.stringify({ session: ctx.session, outcome: ctx.outcome }));
      renameSync(${JSON.stringify(`${endMarker}.tmp`)}, ${JSON.stringify(endMarker)});
      return [];
    },
  },
}];
`;

describe.skipIf(!MAGMUX)(`end to end: claudish -i ${MAGMUX ? "" : NO_MAGMUX_MESSAGE}`, () => {
  let stub: StubUpstream | null = null;
  afterAll(() => stub?.stop());

  test("ambient claudish -i: a sessionIdle injection fed by a responseEnd annotation becomes the next turn", async () => {
    stub = startStubUpstream({
      format: "openai-sse",
      script: [{ parts: [{ text: "STUB-ONE" }] }, { parts: [{ text: "STUB-TWO" }] }],
    });
    const t = makePaneTestEnv({ COLUMNS: "160", LINES: "50", CONTRACT_FAKE_MAX_MS: "80000" });
    mkdirSync(t.sockRoot, { recursive: true });
    const endMarker = join(t.tmp, "session-end.json");
    const module = join(t.tmp, "e2e-hooks.js");
    writeFileSync(module, E2E_HOOKS(endMarker));
    const config = join(t.tmp, "claudish-config.json");
    writeFileSync(
      config,
      JSON.stringify({ ...stubEndpointConfig(stub), hooks: { modules: [module] } }, null, 2)
    );
    const dump = join(t.tmp, "fake-claude-dump.json");
    Object.assign(t.env, {
      CLAUDE_PATH: writeFakeClaudeWrapper(t.tmp),
      CLAUDISH_CONFIG: config,
      FAKE_CLAUDE_PROXY: "1",
      FAKE_CLAUDE_DUMP: dump,
      FAKE_KEYLOG: join(t.tmp, "keylog.txt"),
    });
    const id = `e2e${randomBytes(3).toString("hex")}`;
    const sock = join(t.sockRoot, `magmux-${id}.sock`);
    const cmd = `exec ${shq(process.execPath)} --no-env-file ${shq(INDEX)} -i --model stub@fake-model -y --quiet --no-recovery`;
    const m = spawn(
      MAGMUX as string,
      ["--headless", "--no-status", "--id", id, "--sock-dir", t.sockRoot, "-e", cmd],
      { cwd: t.cwd, env: t.env, stdio: "ignore", detached: true }
    );
    m.on("error", () => {});
    const human = await MagmuxClient.connect(sock, { timeoutMs: 10_000 });
    const keylog = () => {
      const p = t.env.FAKE_KEYLOG as string;
      return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
    };
    try {
      // Claude Code's argv: the minted id and the turn dir lead, `--settings` ends the list
      await until(() => existsSync(dump), "the fake Claude Code's argv dump", 30_000);
      const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
      expect(argv[0]).toBe("--session-id");
      const sid = argv[1] as string;
      expect(sid).toMatch(/^[0-9a-f-]{36}$/);
      expect(argv[2]).toBe("--add-dir");
      expect(argv[4]).toBe("--settings");
      // wait for the REPL, then type as the human
      await Bun.sleep(1_500);
      const sent = await human.request({
        type: "send",
        pane: 0,
        text: "Reply first.",
        typed: true,
        enter: true,
      });
      expect(sent.ok).toBe(true);
      await until(() => keylog().includes("HOOK-PING"), "the injected turn", 40_000);
      const transcript = t.transcriptPathFor(sid);
      await until(
        () => existsSync(transcript) && readFileSync(transcript, "utf8").includes("STUB-TWO"),
        "the injected turn's answer",
        30_000
      );
      const records = readFileSync(transcript, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const texts = records.map((r) =>
        r.type === "user"
          ? `user:${typeof r.message?.content === "string" ? r.message.content : ""}`
          : r.type === "assistant"
            ? `assistant:${(r.message?.content ?? []).map((b: { text?: string }) => b.text ?? "").join("")}`
            : null
      );
      const order = texts.filter((x): x is string => x !== null);
      expect(order).toEqual([
        "user:Reply first.",
        "assistant:STUB-ONE",
        "user:HOOK-PING",
        "assistant:STUB-TWO",
      ]);
      expect(stub.requests.length).toBe(2);
      expect(keylog()).toEqual(["Reply first.", "HOOK-PING"]);
      // the human quits: sessionEnd runs before claudish exits
      await human.request({ type: "send", pane: 0, text: "/exit", typed: true, enter: true });
      await until(() => existsSync(endMarker), "sessionEnd", 15_000);
      const end = JSON.parse(readFileSync(endMarker, "utf8"));
      expect(end.outcome).toEqual({ state: "COMPLETED", reason: null, exitCode: 0 });
      expect(end.session).toMatchObject({ kind: "interactive", id: sid, claudeSessionId: sid });
    } finally {
      human.close();
      try {
        if (m.pid) process.kill(-m.pid, "SIGKILL");
      } catch {
        // gone
      }
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
    }
  }, 90_000);
});
