/**
 * Attaching to a pane magmux declared before it published the pane's `input` view. magmux
 * publishes that view after its first poll of the pane, so a `list` read earlier shows the
 * declaration alone. The session reads `list` again, for a bounded time, only for that answer.
 *
 * The session is never started: a scripted client answers `list`, and `attach` is driven
 * directly.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MagmuxClient, type MagmuxReply } from "./magmux-client.js";
import { MIN_MAGMUX_VERSION } from "./pane-launch.js";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";

const BOUND_MS = 5_000;
const UNPUBLISHED = `input_gate_unavailable: magmux ${MIN_MAGMUX_VERSION} declared the input gate for pane 0 but has not published its input view yet`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type ListReply = MagmuxReply | "never";

/** Answers `list` from `replies` in order, the last one repeating; records every send. */
class ScriptedClient {
  isClosed = false;
  lists = 0;
  readonly sends: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(readonly replies: ListReply[]) {}

  on(event: string, cb: (e: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }

  emit(event: string, value: unknown = {}): void {
    if (event === "disconnected") this.isClosed = true;
    for (const cb of this.listeners.get(event) ?? []) cb(value);
  }

  close(): void {
    this.isClosed = true;
  }

  async request(msg: Record<string, unknown>, timeoutMs = 10_000): Promise<MagmuxReply> {
    if (this.isClosed) return { ok: false, code: "client_closed", error: "closed" };
    if (msg.type === "capabilities")
      return { ok: true, result: { protocol: 1, version: MIN_MAGMUX_VERSION, verbs: [] } };
    if (msg.type === "list") {
      const reply = this.replies[Math.min(this.lists, this.replies.length - 1)] as ListReply;
      this.lists++;
      if (reply !== "never") return reply;
      await Bun.sleep(timeoutMs);
      return { ok: false, code: "client_timeout", error: `no reply in ${timeoutMs} ms` };
    }
    if (msg.type === "send") this.sends.push(msg);
    return { ok: true, result: {} };
  }
}

function session(extra: Partial<PaneSessionOptions> = {}): PaneSessionImpl {
  const root = mkdtempSync("/tmp/pgw-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const s = new PaneSessionImpl(
    {
      kind: "s",
      label: "gate-wait-test",
      callerFlags: [],
      spawnModel: "gate-wait-test",
      cwd: root,
      sessionUuid: crypto.randomUUID(),
      transcriptPath: join(root, "transcript.jsonl"),
      slotEnv: {},
      shape: "interactive",
      readAvailable: true,
      parentEnv: { HOME: root, CLAUDE_CONFIG_DIR: configDir },
      decide: () => "continue",
      onBlocked: () => "wait",
      ...extra,
    },
    { paneId: "gate-wait", sockPath: join(root, "m.sock"), root, ctlDir, turnDir }
  );
  // start() was never called: there is no process, group or watcher to reap
  (s as any).reapPromise = Promise.resolve();
  cleanups.push(async () => {
    (s as any).client = null;
    (s as any).magmux = null;
    await s.shutdownReap("gate wait test cleanup");
  });
  return s;
}

const listOf = (pane: Record<string, unknown>): MagmuxReply => ({
  ok: true,
  result: { panes: [{ pane: 0, ...pane }] },
});
/** pane 0 declared and bound to this session, its input view not published */
const declared = (s: PaneSessionImpl, extra: Record<string, unknown> = {}): MagmuxReply => {
  const o = (s as any).o as PaneSessionOptions;
  return listOf({
    gateBasis: "declared",
    bound: "named",
    sessionId: o.sessionUuid,
    transcriptPath: o.transcriptPath,
    ...extra,
  });
};
const published = (s: PaneSessionImpl, extra: Record<string, unknown> = {}): MagmuxReply =>
  declared(s, { input: { ready: false, reason: "starting" }, ...extra });

async function within(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(5);
  return pred();
}

const attach = (s: PaneSessionImpl, c: ScriptedClient, reconnect = false): Promise<void> =>
  (s as any).attach(c, reconnect);

/** Starts an attach whose `list` never shows the input view, and returns once it read twice. */
async function waiting(s: PaneSessionImpl): Promise<{ c: ScriptedClient; done: Promise<void> }> {
  const c = new ScriptedClient([declared(s)]);
  const done = attach(s, c);
  expect(await within(() => c.lists >= 2, 2_000)).toBe(true);
  return { c, done };
}

/** `done` resolves well inside the bound, and no `list` is read after the event that ended it. */
async function endedAtOnce(c: ScriptedClient, done: Promise<void>): Promise<void> {
  const lists = c.lists;
  const ended = await Promise.race([done.then(() => true), Bun.sleep(1_500).then(() => false)]);
  expect(ended).toBe(true);
  await Bun.sleep(400);
  expect(c.lists).toBe(lists);
}

/** The timers set through the global `setTimeout` from here on that neither fired nor were cleared. */
function trackTimers(): Set<unknown> {
  const pending = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const t = realSet(() => {
      pending.delete(t);
      fn();
    }, ms);
    pending.add(t);
    return t;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(t);
    realClear(t);
  }) as typeof clearTimeout;
  cleanups.push(() => {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  });
  return pending;
}

describe("pane 0 declared, its input view not published yet", () => {
  test("published on the second read: the attach completes, with nothing written", async () => {
    const s = session({ initialPrompt: "Reply with exactly PEAR." });
    const c = new ScriptedClient([declared(s), published(s)]);
    await attach(s, c);
    expect((s as any).phase).toBe("BOOTING");
    expect(c.lists).toBe(2);
    expect((s as any).gateNow()).toMatchObject({ ready: false, reason: "starting" });
    expect(c.sends).toEqual([]);
  });

  test("no binding fields either, all published on the second read: the attach completes", async () => {
    const s = session();
    const c = new ScriptedClient([listOf({ gateBasis: "declared" }), published(s)]);
    await attach(s, c);
    expect((s as any).phase).toBe("BOOTING");
    expect((s as any).gateTrusted).toBe(true);
  });

  test("while it waits the connection is not trusted: no gate reading, a scroll is refused, nothing is written", async () => {
    const s = session();
    const { c, done } = await waiting(s);
    (s as any).phase = "IDLE";
    (s as any).screen = { ...(s as any).screen, seq: 5 };
    expect((s as any).trustedConnection()).toBe(false);
    expect((s as any).gateNow()).toBeNull();
    const scrolled = await s.scroll({ by: -3 }).then(
      () => "sent",
      () => "refused"
    );
    expect(scrolled).toBe("refused");
    expect(c.sends).toEqual([]);
    s.cancel();
    await done;
  });

  test("never published: fails at the bound with the unpublished detail", async () => {
    const s = session();
    const c = new ScriptedClient([declared(s)]);
    const at = Date.now();
    await attach(s, c);
    const ms = Date.now() - at;
    const snap = await s.terminal;
    expect([snap.state, snap.reason, snap.detail]).toEqual(["FAILED", "pane_lost", UNPUBLISHED]);
    expect(ms).toBeGreaterThanOrEqual(BOUND_MS - 500);
    expect(ms).toBeLessThan(BOUND_MS + 2_000);
    expect(c.lists).toBeGreaterThan(5);
    const lists = c.lists;
    await Bun.sleep(400);
    expect(c.lists).toBe(lists);
  }, 15_000);

  test("a second read that is never answered: fails at the bound with the unpublished detail", async () => {
    const s = session();
    const c = new ScriptedClient([declared(s), "never"]);
    const at = Date.now();
    await attach(s, c);
    const ms = Date.now() - at;
    expect((await s.terminal).detail).toBe(UNPUBLISHED);
    expect(ms).toBeGreaterThanOrEqual(BOUND_MS - 500);
    expect(ms).toBeLessThan(BOUND_MS + 2_000);
    expect(c.lists).toBe(2);
  }, 15_000);

  test("a boot deadline sooner than the bound: fails before it, with the unpublished detail", async () => {
    const s = session({ bootTimeoutMs: 1_500 });
    (s as any).startedAtMs = Date.now();
    const tick = setInterval(() => (s as any).step(() => (s as any).evaluate()), 250);
    cleanups.push(() => clearInterval(tick));
    const c = new ScriptedClient([declared(s)]);
    const at = Date.now();
    await attach(s, c);
    expect(Date.now() - at).toBeLessThan(3_000);
    expect(await s.terminal).toMatchObject({ reason: "pane_lost", detail: UNPUBLISHED });
    expect(c.lists).toBeGreaterThan(1);
  }, 15_000);

  test("an admission deadline sooner than the bound: fails before it, with the unpublished detail", async () => {
    const s = session();
    const any = s as any;
    any.phase = "ADMITTING";
    any.admission = { deadline: Date.now() + 1_500 };
    const c = new ScriptedClient([declared(s)]);
    const at = Date.now();
    await attach(s, c, true);
    expect(Date.now() - at).toBeLessThan(3_000);
    expect(await s.terminal).toMatchObject({ reason: "pane_lost", detail: UNPUBLISHED });
    expect(c.lists).toBeGreaterThan(1);
  }, 15_000);

  test("another session named on the second read: fails at that read as unbound", async () => {
    const s = session();
    const c = new ScriptedClient([declared(s), published(s, { sessionId: "other" })]);
    await attach(s, c);
    expect((await s.terminal).detail).toStartWith("input_gate_unbound:");
    expect(c.lists).toBe(2);
  });

  test("the pane no longer gated on the second read: fails at that read as not gated", async () => {
    const s = session();
    const c = new ScriptedClient([declared(s), listOf({})]);
    await attach(s, c);
    expect((await s.terminal).detail).toBe(
      `input_gate_unavailable: magmux ${MIN_MAGMUX_VERSION} did not gate pane 0 (gateBasis none)`
    );
    expect(c.lists).toBe(2);
  });

  test("the second list refused: fails at that read as a failed list", async () => {
    const s = session();
    const c = new ScriptedClient([declared(s), { ok: false, code: "internal", error: "boom" }]);
    await attach(s, c);
    expect((await s.terminal).detail).toContain("list failed (internal: boom)");
    expect(c.lists).toBe(2);
  });

  test("the pane dead on the second read: the exit path, and no further read", async () => {
    const s = session();
    const c = new ScriptedClient([declared(s), declared(s, { dead: true, exitCode: 7 })]);
    await attach(s, c, true);
    const snap = await s.terminal;
    expect(snap.reason).toBe("child_exited");
    expect(snap.detail).toContain("code 7");
    expect(c.lists).toBe(2);
  });

  test("the pane gone from the second read: no verdict, no further read", async () => {
    const s = session();
    const c = new ScriptedClient([declared(s), { ok: true, result: { panes: [] } }]);
    await attach(s, c);
    expect((s as any).phase).toBe("BOOTING");
    expect((s as any).gateTrusted).toBe(false);
    expect(c.lists).toBe(2);
  });

  test("the exit event during the wait: the exit path, and no further read", async () => {
    const s = session();
    // the final capture holds the exit path open past the event
    (s as any).o.timings = { exitCaptureDelayMs: 1_000 };
    const { c, done } = await waiting(s);
    const pending = trackTimers();
    await Bun.sleep(150);
    expect(pending.size).toBe(1);
    c.emit("exit", { exitCode: 7, lastLine: "" });
    // the pause's timer is cleared with the event; only the held capture's own sleep remains
    expect(pending.size).toBe(0);
    await endedAtOnce(c, done);
    expect((await s.terminal).reason).toBe("child_exited");
  }, 15_000);

  test("the pane closed during the wait: no further read", async () => {
    const s = session();
    const { c, done } = await waiting(s);
    const pending = trackTimers();
    await Bun.sleep(150);
    expect(pending.size).toBe(1);
    c.emit("pane_closed", { pane: 0 });
    expect(pending.size).toBe(0);
    await endedAtOnce(c, done);
    expect((s as any).phase).toBe("BOOTING");
  });

  test("the control connection closed during the wait: no further read, no verdict", async () => {
    const s = session();
    const { c, done } = await waiting(s);
    const pending = trackTimers();
    await Bun.sleep(150);
    expect(pending.size).toBe(1);
    c.emit("disconnected");
    expect(pending.size).toBe(0);
    await endedAtOnce(c, done);
    expect((s as any).phase).toBe("BOOTING");
  });

  test("magmux exited during the wait: no further read", async () => {
    const s = session();
    const { c, done } = await waiting(s);
    (s as any).onMagmuxExit(1, null);
    await endedAtOnce(c, done);
    expect((await s.terminal).detail).toContain("magmux exited");
  });

  for (const how of ["cancel", "expire"] as const)
    test(`${how} during the wait: ends at once, no further read, no timer left running`, async () => {
      const s = session();
      const pending = trackTimers();
      const { c, done } = await waiting(s);
      const before = [...pending];
      expect(before.length).toBeGreaterThan(0);
      s[how]();
      expect(before.filter((t) => pending.has(t))).toEqual([]);
      await endedAtOnce(c, done);
      expect((await s.terminal).state).toBe(how === "cancel" ? "CANCELLED" : "TIMEOUT");
      expect(pending.size).toBe(0);
    });

  test("cancelled while a second read is out: its reply is not acted on", async () => {
    const s = session();
    const c = new ScriptedClient([declared(s), published(s)]);
    const request = c.request.bind(c);
    const held = Promise.withResolvers<void>();
    c.request = async (msg, timeoutMs) => {
      const r = await request(msg, timeoutMs);
      if (msg.type === "list" && c.lists === 2) await held.promise;
      return r;
    };
    const done = attach(s, c);
    expect(await within(() => c.lists === 2, 2_000)).toBe(true);
    s.cancel();
    held.resolve();
    await done;
    expect((s as any).gateTrusted).toBe(false);
    expect((await s.terminal).state).toBe("CANCELLED");
    expect(c.lists).toBe(2);
  });

  test("a redialled connection dropped during the wait is dialled again", async () => {
    const s = session();
    const any = s as any;
    any.magmux = { exitCode: null, signalCode: null, pid: process.pid, kill: () => true };
    const first = new ScriptedClient([declared(s)]);
    const second = new ScriptedClient([published(s)]);
    const queue = [first, second];
    const dial = spyOn(MagmuxClient, "dial").mockImplementation(
      async () => queue.shift() as unknown as MagmuxClient
    );
    try {
      const done = any.reconnect() as Promise<void>;
      expect(await within(() => first.lists >= 2, 2_000)).toBe(true);
      first.emit("disconnected");
      await done;
      expect(any.client).toBe(second);
      expect(any.gateTrusted).toBe(true);
    } finally {
      dial.mockRestore();
    }
  });
});

describe("every other first answer is decided on that read", () => {
  const notGated = `input_gate_unavailable: magmux ${MIN_MAGMUX_VERSION} did not gate pane 0 (gateBasis `;
  const cases: Array<[string, (s: PaneSessionImpl) => MagmuxReply, string]> = [
    ["not gated at all", () => listOf({}), `${notGated}none)`],
    ["gated as a direct pane", (s) => declared(s, { gateBasis: "direct" }), `${notGated}direct)`],
    [
      "an input view in a form not known here",
      (s) => declared(s, { input: { ready: "yes" } }),
      UNPUBLISHED,
    ],
    ["another session", (s) => published(s, { sessionId: "other" }), "input_gate_unbound:"],
    ["another path", (s) => published(s, { transcriptPath: "/x/o.jsonl" }), "input_gate_unbound:"],
    ["bound by time", (s) => published(s, { bound: "mtime" }), "input_gate_unbound:"],
    ["another session, no input view", (s) => declared(s, { sessionId: "other" }), UNPUBLISHED],
    [
      "another path, no input view",
      (s) => declared(s, { transcriptPath: "/x/o.jsonl" }),
      UNPUBLISHED,
    ],
    ["bound by time, no input view", (s) => declared(s, { bound: "mtime" }), UNPUBLISHED],
    ["bound by prompt, no input view", (s) => declared(s, { bound: "prompt" }), UNPUBLISHED],
    [
      "a failed list",
      () => ({ ok: false, code: "internal", error: "boom" }),
      "input_gate_unbound:",
    ],
  ];
  for (const [name, reply, detail] of cases)
    test(`${name}: one read, no wait`, async () => {
      const s = session();
      const c = new ScriptedClient([reply(s), published(s)]);
      await attach(s, c);
      expect(c.lists).toBe(1);
      const snap = await s.terminal;
      expect(snap.reason).toBe("pane_lost");
      expect(snap.detail).toStartWith(detail);
    });
});
