/**
 * The recovery banner, drawn with magmux's `overlay` socket verb — behaviours
 * B1–B15 of the overlay spec.
 *
 * WRITTEN BLIND. These tests come from the spec and the public contract only;
 * `magmux-ui.ts` was never opened. Every assertion is on something magmux
 * observably receives over its control socket, on the public lease query, or on
 * the pure text functions.
 *
 * THE FAKE MAGMUX IS A REAL UNIX SOCKET: `Bun.listen({ unix })` speaking the
 * contract's NDJSON protocol, recording every line it receives, and able to be
 * told to acknowledge (`ok: true`), refuse (`ok: false`), stay silent, hold its
 * replies until released, answer a foreign id, or drop the connection. Nothing
 * is replaced with `mock.module()`.
 *
 * TWO CLOCKS. The banner's redraw and linger timers run on the injected
 * `FakeClock`; socket I/O is real. So a step that advances the fake clock is
 * followed by a short REAL poll for magmux to receive what the step produced.
 *
 * WHY THE LEASE TESTS ARE SHAPED THIS WAY. The lease gates a money decision (a
 * retryable 503 versus an inline 400), so it must mean "magmux ACKNOWLEDGED a
 * write within UI_LEASE_MS", never "claudish sent one". The hold-mode fake is
 * what separates the two: the write has demonstrably ARRIVED at magmux and the
 * lease must still be false until the reply is released.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket, UnixSocketListener } from "bun";
import { resetRecoveryClock, setRecoveryClock } from "./clock.js";
import {
  closeAllEpisodes,
  uiLeaseValid as coordinatorLeaseValid,
  giveUp,
  joinEpisode,
} from "./coordinator.js";
import type { EpisodeHandle, EpisodeSeed } from "./coordinator.js";
import {
  OUTCOME_LINGER_MS,
  __resetUiStateForTests,
  bannerText,
  describeLease,
  formatElapsed,
  installRecoveryUi,
  recoveredText,
  shutdownRecoveryUi,
  uiLeaseValid,
} from "./magmux-ui.js";
import { FakeClock, drain } from "./test-helpers/fake-clock.js";
import { FRAME_TICK_MS, UI_LEASE_MS } from "./types.js";
import type { RecoveryEpisodeFrame } from "./types.js";

// ───────────────────────────────────────────────────────────────────────────
// The fake magmux
// ───────────────────────────────────────────────────────────────────────────

type ReplyMode =
  /** reply `ok: true` to every message that carries an id */
  | "ok"
  /** reply `ok: false` */
  | "fail"
  /** never reply */
  | "silent"
  /** queue `ok: true` replies until `release()` */
  | "hold"
  /** reply `ok: true`, but to an id claudish never sent */
  | "wrong-id"
  /** acknowledge everything EXCEPT overlay writes (tints are acked) */
  | "tint-only"
  /** close the connection instead of replying */
  | "close";

interface WireMsg {
  type?: string;
  id?: number | string;
  pane?: number;
  text?: string;
  style?: string;
  color?: string;
  [key: string]: unknown;
}

interface Received {
  msg: WireMsg;
  /** Recovery-clock (fake) time when magmux read the line. */
  fakeAt: number;
  conn: number;
}

interface Conn {
  id: number;
  buf: string;
  decoder: TextDecoder;
}

function foreignId(id: number | string): number | string {
  return typeof id === "number" ? id + 1_000_000 : `${id}-not-yours`;
}

class FakeMagmux {
  mode: ReplyMode;
  /** Interleave unrelated broadcast events and replies to foreign ids. */
  noise = false;
  panes: Array<{ pane: number; pid: number }>;
  readonly received: Received[] = [];
  readonly garbage: string[] = [];
  opened = 0;
  closed = 0;
  private held: Array<() => void> = [];
  private readonly live = new Map<number, Socket<Conn>>();
  private listener: UnixSocketListener<Conn> | null;
  private connSeq = 0;

  constructor(
    readonly path: string,
    opts: { mode?: ReplyMode; panes?: Array<{ pane: number; pid: number }> } = {}
  ) {
    this.mode = opts.mode ?? "ok";
    this.panes = opts.panes ?? [];
    if (existsSync(path)) unlinkSync(path);
    this.listener = Bun.listen<Conn>({
      unix: path,
      socket: {
        open: (s) => {
          s.data = { id: ++this.connSeq, buf: "", decoder: new TextDecoder() };
          this.live.set(s.data.id, s);
          this.opened++;
        },
        data: (s, chunk) => {
          s.data.buf += s.data.decoder.decode(chunk, { stream: true });
          for (let nl = s.data.buf.indexOf("\n"); nl >= 0; nl = s.data.buf.indexOf("\n")) {
            const line = s.data.buf.slice(0, nl);
            s.data.buf = s.data.buf.slice(nl + 1);
            if (line.trim() !== "") this.onLine(s, line);
          }
        },
        close: (s) => {
          if (s.data && this.live.delete(s.data.id)) this.closed++;
        },
        error: () => {},
      },
    });
  }

  get liveConnections(): number {
    return this.live.size;
  }

  private write(s: Socket<Conn>, obj: unknown): void {
    try {
      s.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // the peer went away; a real magmux would not care either
    }
  }

  private ack(s: Socket<Conn>, msg: WireMsg): void {
    this.write(s, { type: "reply", id: msg.id, ok: true, result: {} });
  }

  private onLine(s: Socket<Conn>, line: string): void {
    let msg: WireMsg;
    try {
      msg = JSON.parse(line) as WireMsg;
    } catch {
      this.garbage.push(line);
      return;
    }
    this.received.push({ msg, fakeAt: clock.now(), conn: s.data.id });
    if (msg.id === undefined) return; // no reply expected

    if (this.noise) {
      this.write(s, { type: "event", event: "pane-output", pane: 0 });
      this.write(s, { type: "reply", id: foreignId(msg.id), ok: true, result: {} });
    }
    if (msg.type === "list") {
      this.write(s, { type: "reply", id: msg.id, ok: true, result: { panes: this.panes } });
      return;
    }
    switch (this.mode) {
      case "ok":
        this.ack(s, msg);
        return;
      case "fail":
        this.write(s, { type: "reply", id: msg.id, ok: false, error: "refused by fake magmux" });
        return;
      case "silent":
        return;
      case "hold":
        this.held.push(() => this.ack(s, msg));
        return;
      case "wrong-id":
        this.write(s, {
          type: "reply",
          id: foreignId(msg.id as number | string),
          ok: true,
          result: {},
        });
        return;
      case "tint-only":
        if (msg.type !== "overlay") this.ack(s, msg);
        return;
      case "close":
        s.end();
        return;
    }
  }

  /** Flush every held acknowledgement and acknowledge from now on. */
  release(): void {
    this.mode = "ok";
    const pending = this.held;
    this.held = [];
    for (const fn of pending) fn();
  }

  /** Close every client connection from magmux's side (the listener stays up). */
  dropConnections(): void {
    for (const s of this.live.values()) s.end();
  }

  mark(): number {
    return this.received.length;
  }

  of(type: string, from = 0): WireMsg[] {
    return this.received
      .slice(from)
      .map((r) => r.msg)
      .filter((m) => m.type === type);
  }

  overlays(from = 0): WireMsg[] {
    return this.of("overlay", from);
  }

  tints(from = 0): WireMsg[] {
    return this.of("tint", from);
  }

  lists(from = 0): WireMsg[] {
    return this.of("list", from);
  }

  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      // already gone
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Harness
// ───────────────────────────────────────────────────────────────────────────

const START_MS = 1_000_000;
const SOCKET_TEST_TIMEOUT = 20_000;
/** Pids no kernel hands out (above every pid_max), for panes that must NOT match. */
const NO_SUCH_PID_A = 2_147_483_001;
const NO_SUCH_PID_B = 2_147_483_002;

let clock: FakeClock;
const fakes: FakeMagmux[] = [];
const handles: EpisodeHandle[] = [];
let savedMagmuxSock: string | undefined;
let sockSeq = 0;
let seedSeq = 0;

/** The lease under test. One line on purpose: the negative control swaps it. */
const lease = (episodeId: string): boolean => uiLeaseValid(episodeId);

function sockPath(): string {
  const name = `mmx-ui-${process.pid}-${++sockSeq}.sock`;
  const preferred = join(tmpdir(), name);
  // sun_path is 104 bytes on macOS; a long TMPDIR would make bind() fail.
  return Buffer.byteLength(preferred) < 100 ? preferred : join("/tmp", name);
}

function startFake(opts: ConstructorParameters<typeof FakeMagmux>[1] = {}): FakeMagmux {
  const f = new FakeMagmux(sockPath(), opts);
  fakes.push(f);
  return f;
}

function seed(over: Partial<EpisodeSeed> = {}): EpisodeSeed {
  const n = ++seedSeq;
  return {
    providerName: `mmx-ui-${n}`,
    providerDisplayName: "Zephyr Cloud",
    endpoint: `http://127.0.${n % 250}.1:9/v1/chat/completions`,
    kind: "refused",
    code: "ConnectionRefused",
    reason: "Cannot reach Zephyr Cloud: the connection was refused.",
    deadlineAt: clock.now() + 270_000,
    ...over,
  };
}

function open(s: EpisodeSeed = seed()): EpisodeHandle {
  const h = joinEpisode(s);
  handles.push(h);
  return h;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll in REAL time; the fake clock does not move. */
async function eventually(cond: () => boolean, timeoutMs = 1_500): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (performance.now() >= end) return false;
    await sleepReal(5);
  }
}

async function until(cond: () => boolean, what: string, timeoutMs = 1_500): Promise<void> {
  if (!(await eventually(cond, timeoutMs))) {
    throw new Error(`timed out after ${timeoutMs} real ms waiting for ${what}`);
  }
}

/** Give real socket I/O every chance to deliver something that should NOT happen. */
async function settle(ms = 150): Promise<void> {
  await sleepReal(ms);
  await drain();
}

/** Advance the fake clock one frame at a time, letting each frame's write land. */
async function tick(f: FakeMagmux | null, frames = 1): Promise<void> {
  for (let i = 0; i < frames; i++) {
    const before = f?.received.length ?? 0;
    await clock.advance(FRAME_TICK_MS);
    if (f) await eventually(() => f.received.length > before, 300);
  }
}

const isErrorBanner = (m: WireMsg) =>
  m.type === "overlay" && m.style === "error" && typeof m.text === "string" && m.text !== "";
const isSuccessBanner = (m: WireMsg) =>
  m.type === "overlay" && m.style === "success" && typeof m.text === "string" && m.text !== "";
const isDrawn = (m: WireMsg) => m.type === "overlay" && typeof m.text === "string" && m.text !== "";
const isClear = (m: WireMsg) => m.type === "overlay" && m.text === "";
const isTint = (color: string) => (m: WireMsg) => m.type === "tint" && m.color === color;
const firstLine = (m: WireMsg) => String(m.text ?? "").split("\n")[0];
/**
 * `✗ NETWORK · Zephyr Cloud <kind word>`. The spec does not define the kind
 * word, so any short phrase with no separator is accepted (`dns` renders as
 * two words); what matters is that nothing else shares line 1.
 */
const KIND_HEADER = /^✗ NETWORK · Zephyr Cloud [^\s·]+(?: [^\s·]+){0,2}$/;

/**
 * Wait for magmux to receive an overlay matching `pred`. Waits in real time
 * first; if the implementation draws on the next frame rather than at once, it
 * then advances one frame (B1 separately insists on "at once").
 */
async function awaitBanner(
  f: FakeMagmux,
  pred: (m: WireMsg) => boolean = isErrorBanner,
  from = 0
): Promise<WireMsg> {
  const find = () => f.overlays(from).find(pred);
  for (let round = 0; round < 3; round++) {
    if (await eventually(() => find() !== undefined, 500)) return find() as WireMsg;
    await clock.advance(FRAME_TICK_MS);
  }
  throw new Error(
    `magmux never received the expected overlay; it got: ${JSON.stringify(f.overlays(from))}`
  );
}

function ancestorOf(pid: number): number | null {
  const r = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { env: { ...process.env } });
  const n = Number.parseInt(String(r.stdout ?? "").trim(), 10);
  return Number.isFinite(n) && n > 1 ? n : null;
}

beforeAll(() => {
  // A developer running this inside magmux must never have the suite draw on
  // their real pane.
  savedMagmuxSock = process.env.MAGMUX_SOCK;
  delete process.env.MAGMUX_SOCK;
});

afterAll(() => {
  if (savedMagmuxSock !== undefined) process.env.MAGMUX_SOCK = savedMagmuxSock;
});

beforeEach(() => {
  clock = new FakeClock(START_MS);
  setRecoveryClock(clock);
});

afterEach(() => {
  __resetUiStateForTests();
  for (const h of handles.splice(0)) h.leave();
  closeAllEpisodes();
  resetRecoveryClock();
  delete process.env.MAGMUX_SOCK;
  for (const f of fakes.splice(0)) f.stop();
});

// ───────────────────────────────────────────────────────────────────────────
// B1 — drawing starts with the episode
// ───────────────────────────────────────────────────────────────────────────

describe("B1: drawing starts with the episode", () => {
  test(
    "B1: opening an episode sends an error overlay for pane 0 headed '✗ NETWORK · <provider> <kind word>' and a red tint, without waiting a frame",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);

      open(seed({ providerDisplayName: "Zephyr Cloud", kind: "refused" }));

      // No fake-clock advance: "drawing starts with the episode".
      await until(
        () => f.overlays().some(isErrorBanner) && f.tints().some(isTint("red")),
        "an error overlay and a red tint"
      );
      const banner = f.overlays().find(isErrorBanner) as WireMsg;
      expect(banner.pane).toBe(0);
      expect(banner.style).toBe("error");
      expect(banner.id).toBeDefined();
      expect(firstLine(banner)).toMatch(KIND_HEADER);
      const red = f.tints().find(isTint("red")) as WireMsg;
      expect(red.pane).toBe(0);
      expect(clock.now()).toBe(START_MS);
    },
    SOCKET_TEST_TIMEOUT
  );

  test(
    "B1: with an explicit socket path the lease targets pane 0 and reports the connection",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const h = open();

      await awaitBanner(f);
      await until(() => lease(h.episodeId), "the lease after magmux acknowledged");

      const d = describeLease(h.episodeId);
      expect(d.targetPane).toBe(0);
      expect(d.connected).toBe(true);
      expect(d.valid).toBe(true);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B2 — no lease before an acknowledgement
// ───────────────────────────────────────────────────────────────────────────

describe("B2: no lease before magmux acknowledges", () => {
  test(
    "B2: the lease is false while an overlay write has ARRIVED at magmux but is unacknowledged, and true once magmux replies ok",
    async () => {
      const f = startFake({ mode: "hold" });
      installRecoveryUi(f.path);
      const h = open();

      await awaitBanner(f); // the write has reached magmux
      await settle(); // give a send-granted lease every chance to appear
      expect(lease(h.episodeId)).toBe(false);
      expect(describeLease(h.episodeId).valid).toBe(false);

      f.release();
      await until(() => lease(h.episodeId), "the lease after magmux acknowledged");
      expect(lease(h.episodeId)).toBe(true);
    },
    SOCKET_TEST_TIMEOUT
  );

  test(
    "B2: a recovery clock that starts at 0 does not make an unacknowledged lease look fresh",
    async () => {
      clock = new FakeClock(0);
      setRecoveryClock(clock);
      const f = startFake({ mode: "hold" });
      installRecoveryUi(f.path);
      const h = open();

      await awaitBanner(f);
      await settle();
      expect(lease(h.episodeId)).toBe(false);

      f.release();
      await until(() => lease(h.episodeId), "the lease after magmux acknowledged");
    },
    SOCKET_TEST_TIMEOUT
  );

  test(
    "B2: unrelated broadcast events and replies to other ids do not prevent a real acknowledgement from granting the lease",
    async () => {
      const f = startFake();
      f.noise = true;
      installRecoveryUi(f.path);
      const h = open();

      await awaitBanner(f);

      await until(() => lease(h.episodeId), "the lease despite interleaved noise");
      await tick(f, 2);
      expect(f.overlays().filter(isErrorBanner).length).toBeGreaterThanOrEqual(2);
      expect(lease(h.episodeId)).toBe(true);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B3 — the lease requires acknowledgement, not just sending
// ───────────────────────────────────────────────────────────────────────────

describe("B3: sending is not acknowledgement", () => {
  const cases: Array<[ReplyMode, string]> = [
    ["fail", "replies ok:false to every write"],
    ["silent", "never replies"],
    ["wrong-id", "replies ok:true only to ids claudish never sent"],
    ["tint-only", "acknowledges the tint but never an overlay write"],
    ["close", "drops the connection instead of replying"],
  ];
  for (const [mode, how] of cases) {
    test(
      `B3: the lease stays false when magmux ${how}`,
      async () => {
        const f = startFake({ mode });
        installRecoveryUi(f.path);
        const h = open();

        await awaitBanner(f);
        await settle();
        expect(lease(h.episodeId)).toBe(false);

        await tick(f, 3);
        await settle();
        expect(f.overlays().filter(isDrawn).length).toBeGreaterThanOrEqual(1);
        expect(lease(h.episodeId)).toBe(false);
        expect(describeLease(h.episodeId).valid).toBe(false);
      },
      SOCKET_TEST_TIMEOUT
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// B4 — the lease lapses on its own
// ───────────────────────────────────────────────────────────────────────────

describe("B4: a lease lapses once magmux stops acknowledging", () => {
  const cases: Array<[ReplyMode, string]> = [
    ["silent", "goes silent"],
    ["fail", "starts refusing"],
  ];
  for (const [mode, how] of cases) {
    test(
      `B4: a valid lease is false no later than UI_LEASE_MS after the last acknowledgement when magmux ${how}`,
      async () => {
        const f = startFake();
        installRecoveryUi(f.path);
        const h = open();
        await awaitBanner(f);
        await until(() => lease(h.episodeId), "the first acknowledgement to grant the lease");

        f.mode = mode;
        // Let any reply already on the wire be read at THIS fake instant, so no
        // acknowledgement can carry a later fake time than `lastAckBy`.
        await settle(100);
        const lastAckBy = clock.now();
        expect(lease(h.episodeId)).toBe(true);
        const markAfterSwitch = f.mark();

        while (clock.now() < lastAckBy + UI_LEASE_MS) await tick(f);
        await settle();

        expect(clock.now()).toBe(lastAckBy + UI_LEASE_MS);
        expect(lease(h.episodeId)).toBe(false);
        expect(describeLease(h.episodeId).valid).toBe(false);
        // It lapsed while claudish was still writing — sending did not renew it.
        expect(f.overlays(markAfterSwitch).filter(isDrawn).length).toBeGreaterThanOrEqual(1);
      },
      SOCKET_TEST_TIMEOUT
    );
  }

  test(
    "B4/B6: with magmux acknowledging every frame, the lease is still valid after more than UI_LEASE_MS of outage",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const h = open();
      await awaitBanner(f);
      await until(() => lease(h.episodeId), "the first acknowledgement");
      const t0 = clock.now();

      while (clock.now() < t0 + UI_LEASE_MS + 5 * FRAME_TICK_MS) await tick(f);
      await settle();

      expect(lease(h.episodeId)).toBe(true);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B5 — losing the connection revokes the lease at once
// ───────────────────────────────────────────────────────────────────────────

describe("B5: a closed magmux socket revokes the lease immediately", () => {
  test(
    "B5: magmux closing the connection makes the lease false with no fake time elapsed",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const h = open();
      await awaitBanner(f);
      await until(() => lease(h.episodeId), "the lease before the close");
      const frozenAt = clock.now();

      f.mode = "silent"; // a reconnect must not be able to earn a fresh lease
      f.dropConnections();

      await until(() => !lease(h.episodeId), "the lease to be revoked by the close", 1_000);
      await settle();
      expect(lease(h.episodeId)).toBe(false);
      expect(clock.now()).toBe(frozenAt);
    },
    SOCKET_TEST_TIMEOUT
  );

  test(
    "B5: magmux going away entirely (listener stopped) makes the lease false with no fake time elapsed, and later frames throw nothing",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const h = open();
      await awaitBanner(f);
      await until(() => lease(h.episodeId), "the lease before magmux exits");
      const frozenAt = clock.now();

      f.stop();

      await until(() => !lease(h.episodeId), "the lease to be revoked when magmux exits", 1_000);
      expect(clock.now()).toBe(frozenAt);
      await tick(null, 3);
      await settle();
      expect(lease(h.episodeId)).toBe(false);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B6 — the banner is re-asserted every second
// ───────────────────────────────────────────────────────────────────────────

describe("B6: the banner is re-asserted once per FRAME_TICK_MS", () => {
  test(
    "B6: advancing the clock N frames produces about N further overlay writes for the live episode",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      open();
      await awaitBanner(f);
      await settle();
      const before = f.overlays().filter(isErrorBanner).length;
      const N = 5;

      await tick(f, N);
      await settle();

      const writes = f.overlays().filter(isErrorBanner).length - before;
      expect(writes).toBeGreaterThanOrEqual(N - 1);
      expect(writes).toBeLessThanOrEqual(N + 1);
      expect(f.overlays().every((m) => m.pane === 0)).toBe(true);
    },
    SOCKET_TEST_TIMEOUT
  );

  test(
    "B6: the countdown moves — five frames later the banner's 'next attempt in Ns' is about five seconds lower",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const h = open();
      h.recordAttemptResult("ConnectionRefused", false);
      const parked = h.waitForNextAttempt(new AbortController().signal, 30_000);
      parked.catch(() => {});
      const countdown = (m: WireMsg) => /next attempt in (\d+)s/.exec(String(m.text))?.[1];

      await awaitBanner(f, (m) => isErrorBanner(m) && countdown(m) !== undefined);
      const first = Number(countdown(f.overlays().filter(isErrorBanner).at(-1) as WireMsg));
      expect(first).toBeGreaterThanOrEqual(25);
      expect(first).toBeLessThanOrEqual(30);

      await tick(f, 5);
      await settle();

      const later = Number(countdown(f.overlays().filter(isErrorBanner).at(-1) as WireMsg));
      expect(first - later).toBeGreaterThanOrEqual(4);
      expect(first - later).toBeLessThanOrEqual(6);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B7 — recovered
// ───────────────────────────────────────────────────────────────────────────

describe("B7: a recovered episode", () => {
  test("B7: OUTCOME_LINGER_MS is the specified 4000 ms", () => {
    expect(OUTCOME_LINGER_MS).toBe(4_000);
  });

  test(
    "B7: shows a green '✓ NETWORK · <provider> recovered' success banner, drops the lease, and clears with a tint reset exactly OUTCOME_LINGER_MS later",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const h = open(seed({ providerDisplayName: "Zephyr Cloud" }));
      const id = h.episodeId;
      await awaitBanner(f);
      await until(() => lease(id), "the lease while the outage was live");
      const mark = f.mark();

      h.recordAttemptResult("ok", true);
      h.leave();
      const closedAt = clock.now();
      await drain();

      expect(lease(id)).toBe(false);
      await until(
        () => f.overlays(mark).some(isSuccessBanner) && f.tints(mark).some(isTint("green")),
        "a success overlay and a green tint"
      );
      const ok = f.overlays(mark).find(isSuccessBanner) as WireMsg;
      expect(ok.pane).toBe(0);
      expect(firstLine(ok)).toBe("✓ NETWORK · Zephyr Cloud recovered");
      expect((f.tints(mark).find(isTint("green")) as WireMsg).pane).toBe(0);

      // It lingers: nothing clears it before OUTCOME_LINGER_MS.
      await clock.advance(OUTCOME_LINGER_MS - FRAME_TICK_MS);
      await settle();
      expect(f.overlays(mark).some(isClear)).toBe(false);
      expect(f.tints(mark).some(isTint("reset"))).toBe(false);

      await clock.advance(FRAME_TICK_MS);
      await until(
        () => f.overlays(mark).some(isClear) && f.tints(mark).some(isTint("reset")),
        "the clearing overlay and the tint reset after the linger"
      );
      expect(clock.now()).toBe(closedAt + OUTCOME_LINGER_MS);
      expect((f.overlays(mark).find(isClear) as WireMsg).pane).toBe(0);
      expect(lease(id)).toBe(false);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B8 — any other ending clears at once
// ───────────────────────────────────────────────────────────────────────────

describe("B8: an episode that ends without recovering clears at once", () => {
  async function expectClearedWithoutSuccess(f: FakeMagmux, mark: number, id: string) {
    const at = clock.now();
    await until(
      () => f.overlays(mark).some(isClear) && f.tints(mark).some(isTint("reset")),
      "a clearing overlay and a tint reset",
      1_000
    );
    expect(clock.now()).toBe(at); // at once — no linger
    expect(lease(id)).toBe(false);

    // Run well past the linger: still no success banner, and the cleared
    // banner is never re-asserted for the dead episode.
    await tick(f, Math.ceil(OUTCOME_LINGER_MS / FRAME_TICK_MS) + 2);
    await settle();
    expect(f.overlays(mark).some((m) => m.style === "success")).toBe(false);
    expect(f.tints(mark).some(isTint("green"))).toBe(false);
    const after = f.received.slice(mark).map((r) => r.msg);
    const clearAt = after.findIndex(isClear);
    expect(after.slice(clearAt + 1).filter(isDrawn)).toEqual([]);
    expect(lease(id)).toBe(false);
  }

  test(
    "B8: giveUp(id) sends overlay text '' and tint reset immediately, and never a success banner",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const h = open();
      await awaitBanner(f);
      const mark = f.mark();

      giveUp(h.episodeId);

      await expectClearedWithoutSuccess(f, mark, h.episodeId);
    },
    SOCKET_TEST_TIMEOUT
  );

  const endings: Array<[string, (h: EpisodeHandle) => void]> = [
    ["given up", (h) => giveUp(h.episodeId)],
    [
      "recovered",
      (h) => {
        h.recordAttemptResult("ok", true);
        h.leave();
      },
    ],
  ];
  for (const [how, end] of endings) {
    test(
      `B7/B8: an acknowledgement arriving only AFTER the episode was ${how} does not revive its lease`,
      async () => {
        const f = startFake({ mode: "hold" });
        installRecoveryUi(f.path);
        const h = open();
        await awaitBanner(f); // painted, not yet acknowledged
        await settle();
        expect(lease(h.episodeId)).toBe(false);

        end(h);
        await drain();
        f.release(); // magmux finally answers every write, the pre-close banner included
        await settle(200);

        expect(lease(h.episodeId)).toBe(false);
        expect(coordinatorLeaseValid(h.episodeId)).toBe(false);
      },
      SOCKET_TEST_TIMEOUT
    );
  }

  test(
    "B8: when magmux acknowledges late, the pane still ends with tint 'reset', not the outage's red",
    async () => {
      const f = startFake({ mode: "hold" });
      installRecoveryUi(f.path);
      const h = open();
      await awaitBanner(f);
      await settle();

      giveUp(h.episodeId);
      await drain();
      f.release();
      await settle(200);
      await tick(f, 2);
      await settle();

      expect(f.tints().at(-1)?.color).toBe("reset");
      expect(f.overlays().at(-1)?.text).toBe("");
    },
    SOCKET_TEST_TIMEOUT
  );

  test(
    "B8: the LAST waiter leaving clears at once with no success banner; an earlier leave keeps the banner up",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const s = seed();
      const a = open(s);
      const b = open(s);
      expect(a.episodeId).toBe(b.episodeId);
      await awaitBanner(f);

      a.leave();
      const midMark = f.mark();
      await tick(f, 2);
      await settle();
      expect(f.overlays(midMark).some(isClear)).toBe(false);
      expect(f.overlays(midMark).some(isErrorBanner)).toBe(true);

      const mark = f.mark();
      b.leave();

      await expectClearedWithoutSuccess(f, mark, a.episodeId);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B9 — two outages at once
// ───────────────────────────────────────────────────────────────────────────

describe("B9: two live outages", () => {
  async function twoOutages(f: FakeMagmux) {
    const a = open(
      seed({
        providerDisplayName: "Alpha Cloud",
        endpoint: "http://alpha.test:9/v1/chat/completions",
      })
    );
    const b = open(
      seed({
        providerDisplayName: "Bravo Cloud",
        endpoint: "http://bravo.test:9/v1/chat/completions",
      })
    );
    expect(a.episodeId).not.toBe(b.episodeId);
    const both = await awaitBanner(
      f,
      (m) => isErrorBanner(m) && String(m.text).includes("+1 more outage")
    );
    const head = firstLine(both);
    const drawnIsA = head.startsWith("✗ NETWORK · Alpha Cloud");
    expect(drawnIsA || head.startsWith("✗ NETWORK · Bravo Cloud")).toBe(true);
    return drawnIsA
      ? { drawn: a, drawnName: "Alpha Cloud", other: b, otherName: "Bravo Cloud" }
      : { drawn: b, drawnName: "Bravo Cloud", other: a, otherName: "Alpha Cloud" };
  }

  test(
    "B9: the banner says '+1 more outage'; closing the drawn outage hands the banner to the survivor and drops the closed lease",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const { drawn, other, otherName } = await twoOutages(f);
      const mark = f.mark();

      giveUp(drawn.episodeId);

      const next = await awaitBanner(
        f,
        (m) => isErrorBanner(m) && firstLine(m).startsWith(`✗ NETWORK · ${otherName}`),
        mark
      );
      expect(next.text).not.toContain("+1 more outage");
      expect(lease(drawn.episodeId)).toBe(false);
      await until(() => lease(other.episodeId), "the survivor's lease once its banner is acked");

      const keep = f.mark();
      await tick(f, 2);
      await settle();
      const later = f.overlays(keep).filter(isDrawn);
      expect(later.length).toBeGreaterThanOrEqual(1);
      expect(later.every((m) => firstLine(m).startsWith(`✗ NETWORK · ${otherName}`))).toBe(true);
      expect(lease(drawn.episodeId)).toBe(false);
    },
    SOCKET_TEST_TIMEOUT
  );

  test(
    "B9: closing the outage that is NOT drawn keeps drawing the other and drops the '+1 more outage' count",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const { drawn, drawnName, other } = await twoOutages(f);
      const mark = f.mark();

      giveUp(other.episodeId);
      await tick(f, 2);
      await settle();

      const later = f.overlays(mark).filter(isDrawn);
      expect(later.length).toBeGreaterThanOrEqual(1);
      const last = later.at(-1) as WireMsg;
      expect(firstLine(last).startsWith(`✗ NETWORK · ${drawnName}`)).toBe(true);
      expect(last.text).not.toContain("+1 more outage");
      expect(lease(other.episodeId)).toBe(false);
      await until(() => lease(drawn.episodeId), "the still-drawn outage's lease");
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B10 — no magmux
// ───────────────────────────────────────────────────────────────────────────

describe("B10: no magmux to draw on", () => {
  async function expectInert(h: EpisodeHandle, bystander: FakeMagmux) {
    await settle();
    await tick(null, 3); // a redraw that threw would reject here
    await settle();
    expect(lease(h.episodeId)).toBe(false);
    expect(coordinatorLeaseValid(h.episodeId)).toBe(false);
    expect(describeLease(h.episodeId).connected).toBe(false);
    expect(describeLease(h.episodeId).valid).toBe(false);
    expect(bystander.opened).toBe(0);
    expect(bystander.received).toEqual([]);
  }

  test(
    "B10: installRecoveryUi(null) with no MAGMUX_SOCK — opening an episode throws nothing, sends nothing, holds no lease",
    async () => {
      const bystander = startFake(); // listening, advertised to nobody
      expect(process.env.MAGMUX_SOCK).toBeUndefined();

      expect(() => installRecoveryUi(null)).not.toThrow();
      let h: EpisodeHandle | undefined;
      expect(() => {
        h = open();
      }).not.toThrow();

      await expectInert(h as EpisodeHandle, bystander);
    },
    SOCKET_TEST_TIMEOUT
  );

  test(
    "B10: installRecoveryUi(<path that does not exist>) — opening an episode throws nothing and holds no lease",
    async () => {
      const bystander = startFake();
      const missing = sockPath();
      expect(existsSync(missing)).toBe(false);

      expect(() => installRecoveryUi(missing)).not.toThrow();
      let h: EpisodeHandle | undefined;
      expect(() => {
        h = open();
      }).not.toThrow();

      await expectInert(h as EpisodeHandle, bystander);
    },
    SOCKET_TEST_TIMEOUT
  );

  test(
    "B10: installRecoveryUi(null) with MAGMUX_SOCK naming a path that does not exist — throws nothing and holds no lease",
    async () => {
      const bystander = startFake();
      const missing = sockPath();
      process.env.MAGMUX_SOCK = missing;

      expect(() => installRecoveryUi(null)).not.toThrow();
      let h: EpisodeHandle | undefined;
      expect(() => {
        h = open();
      }).not.toThrow();

      await expectInert(h as EpisodeHandle, bystander);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B11 — not installed
// ───────────────────────────────────────────────────────────────────────────

describe("B11: banner not installed", () => {
  test(
    "B11: without installRecoveryUi the lease is false, even with MAGMUX_SOCK pointing at a magmux that acknowledges everything",
    async () => {
      const f = startFake();
      process.env.MAGMUX_SOCK = f.path;

      const h = open();
      await settle();
      await tick(f, 2);
      await settle();

      expect(lease(h.episodeId)).toBe(false);
      expect(coordinatorLeaseValid(h.episodeId)).toBe(false);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B12 — ambient magmux
// ───────────────────────────────────────────────────────────────────────────

describe("B12: ambient magmux found through MAGMUX_SOCK", () => {
  const targets: Array<[string, () => number | null]> = [
    ["this process", () => process.pid],
    ["its parent", () => process.ppid],
    ["its grandparent", () => ancestorOf(process.ppid)],
  ];
  for (const [who, pidOf] of targets) {
    test(
      `B12: sends 'list' and draws only on the pane whose pid is ${who}`,
      async () => {
        const target = pidOf();
        if (target === null) throw new Error(`could not resolve the pid of ${who}`);
        const f = startFake({
          panes: [
            { pane: 0, pid: NO_SUCH_PID_A },
            { pane: 3, pid: target },
            { pane: 5, pid: NO_SUCH_PID_B },
          ],
        });
        process.env.MAGMUX_SOCK = f.path;
        installRecoveryUi(null);

        const h = open();
        const drawn = await awaitBanner(f);
        await until(() => f.tints().some(isTint("red")), "the red tint");

        const types = f.received.map((r) => r.msg.type);
        expect(types).toContain("list");
        expect(types.indexOf("list")).toBeLessThan(types.indexOf("overlay"));
        expect(drawn.pane).toBe(3);
        expect(f.overlays().every((m) => m.pane === 3)).toBe(true);
        expect(f.tints().every((m) => m.pane === 3)).toBe(true);
        await until(() => lease(h.episodeId), "the lease on the matched pane");
        expect(describeLease(h.episodeId).targetPane).toBe(3);
      },
      SOCKET_TEST_TIMEOUT
    );
  }

  test(
    "B12: when no pane's pid is this process or an ancestor, it draws nothing and holds no lease",
    async () => {
      const f = startFake({
        panes: [
          { pane: 0, pid: NO_SUCH_PID_A },
          { pane: 1, pid: NO_SUCH_PID_B },
        ],
      });
      process.env.MAGMUX_SOCK = f.path;
      installRecoveryUi(null);

      const h = open();
      await until(() => f.lists().length > 0, "claudish to ask magmux for its panes");
      await settle();
      await tick(f, 3);
      await settle();

      expect(f.overlays()).toEqual([]);
      expect(f.tints()).toEqual([]);
      expect(lease(h.episodeId)).toBe(false);
      expect(coordinatorLeaseValid(h.episodeId)).toBe(false);
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B13 — the coordinator sees the lease
// ───────────────────────────────────────────────────────────────────────────

describe("B13: the coordinator's uiLeaseValid agrees with the banner's", () => {
  test(
    "B13: both are false before the acknowledgement, both true after it, both false once the socket closes",
    async () => {
      const f = startFake({ mode: "hold" });
      installRecoveryUi(f.path);
      const h = open();
      const id = h.episodeId;

      await awaitBanner(f);
      await settle();
      expect({ banner: uiLeaseValid(id), coordinator: coordinatorLeaseValid(id) }).toEqual({
        banner: false,
        coordinator: false,
      });

      f.release();
      await until(() => uiLeaseValid(id), "the banner's lease after the acknowledgement");
      expect({ banner: uiLeaseValid(id), coordinator: coordinatorLeaseValid(id) }).toEqual({
        banner: true,
        coordinator: true,
      });

      f.mode = "silent";
      f.dropConnections();
      await until(() => !uiLeaseValid(id), "the banner's lease to drop on close", 1_000);
      expect({ banner: uiLeaseValid(id), coordinator: coordinatorLeaseValid(id) }).toEqual({
        banner: false,
        coordinator: false,
      });
    },
    SOCKET_TEST_TIMEOUT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// B14 — banner text (pure)
// ───────────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

function frame(over: Partial<RecoveryEpisodeFrame> = {}): RecoveryEpisodeFrame {
  return {
    type: "episode",
    episodeId: "ep-banner",
    state: "waiting",
    tier: 1,
    providerDisplayName: "Zephyr Cloud",
    host: "api.zephyr.test",
    endpoint: "https://api.zephyr.test/v1/chat/completions",
    kind: "refused",
    code: "ConnectionRefused",
    loopback: false,
    reason: "Cannot reach Zephyr Cloud: the connection was refused.",
    attempts: 2,
    clientRetries: 0,
    startedAtMs: NOW - 26_000,
    nextAttemptAtMs: NOW + 30_000,
    lastOutcome: "ConnectionRefused",
    waiters: 1,
    otherEpisodes: 0,
    ...over,
  };
}

const lastLine = (text: string) => (text.trimEnd().split("\n").at(-1) ?? "").trim();

describe("B14: bannerText", () => {
  test("B14: line 1 stands alone as '✗ NETWORK · <provider> <kind word>', distinct per kind", () => {
    const reason = "Cannot reach Zephyr Cloud: the connection was refused.";
    const heads = (["dns", "refused", "unreachable"] as const).map(
      (kind) => bannerText(frame({ kind, reason, waiters: 2 }), NOW).split("\n")[0]
    );

    for (const head of heads) {
      expect(head).toMatch(KIND_HEADER);
      expect(head).not.toContain(reason);
      expect(head).not.toContain("api.zephyr.test");
      expect(head).not.toContain("held");
      expect(head).not.toContain("next attempt");
      expect(head).not.toContain("Esc");
    }
    expect(new Set(heads).size).toBe(3);
  });

  test("B14: the reason sentence is word-wrapped, intact and in order, to lines of at most 60 characters", () => {
    const reason =
      "Cannot reach Zephyr Cloud because every connection attempt was refused by the remote host, which usually means the service is down or a local proxy is intercepting the request before it leaves this machine.";
    const words = new Set(reason.split(" "));

    const lines = bannerText(frame({ reason }), NOW).split("\n");

    const reasonLines = lines.filter((l) => {
      const t = l.trim();
      return t !== "" && reason.includes(t) && t.split(/\s+/).every((w) => words.has(w));
    });
    expect(reasonLines.map((l) => l.trim()).join(" ")).toBe(reason);
    expect(reasonLines.length).toBeGreaterThan(1);
    for (const l of reasonLines) {
      expect([...l.trimEnd()].length).toBeLessThanOrEqual(60);
    }
  });

  test("B14: 'waiting' with a next-attempt instant reads 'next attempt in <N>s'", () => {
    expect(bannerText(frame({ state: "waiting", nextAttemptAtMs: NOW + 30_000 }), NOW)).toContain(
      "next attempt in 30s"
    );
    expect(bannerText(frame({ state: "waiting", nextAttemptAtMs: NOW + 5_000 }), NOW)).toContain(
      "next attempt in 5s"
    );
  });

  test("B14: nextAttemptAtMs null reads 'connecting to <host>…'", () => {
    const text = bannerText(
      frame({ state: "attempting", nextAttemptAtMs: null, host: "api.zephyr.test" }),
      NOW
    );
    expect(text).toContain("connecting to api.zephyr.test…");
  });

  test("B14: state 'handoff' reads 'handed back to Claude Code'", () => {
    expect(bannerText(frame({ state: "handoff" }), NOW)).toContain("handed back to Claude Code");
  });

  test("B14: waiters 1 reads '1 request held' and waiters 2 reads '2 requests held'", () => {
    const one = bannerText(frame({ waiters: 1 }), NOW);
    const two = bannerText(frame({ waiters: 2 }), NOW);

    expect(one).toContain("1 request held");
    expect(one).not.toContain("requests held");
    expect(two).toContain("2 requests held");
  });

  test("B14: the last line is 'Esc in Claude Code stops the turn' in every state", () => {
    const frames = [
      frame({ state: "waiting" }),
      frame({ state: "attempting", nextAttemptAtMs: null }),
      frame({ state: "handoff" }),
      frame({ otherEpisodes: 1, waiters: 3 }),
    ];
    for (const f of frames) {
      expect(lastLine(bannerText(f, NOW))).toBe("Esc in Claude Code stops the turn");
    }
  });

  test("B9/B14: one other live episode reads '+1 more outage'; none reads no count", () => {
    expect(bannerText(frame({ otherEpisodes: 1 }), NOW)).toContain("+1 more outage");
    expect(bannerText(frame({ otherEpisodes: 0 }), NOW)).not.toContain("more outage");
  });

  test("B7: recoveredText's first line is '✓ NETWORK · <provider> recovered'", () => {
    expect(recoveredText(frame(), NOW).split("\n")[0]).toBe("✓ NETWORK · Zephyr Cloud recovered");
  });

  test("contract: formatElapsed renders 9s, 1m 26s and 2h 5m", () => {
    expect(formatElapsed(9_000)).toBe("9s");
    expect(formatElapsed(86_000)).toBe("1m 26s");
    expect(formatElapsed((2 * 3600 + 5 * 60) * 1_000)).toBe("2h 5m");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B15 — shutdown
// ───────────────────────────────────────────────────────────────────────────

describe("B15: shutdownRecoveryUi", () => {
  test(
    "B15: clears the overlay and resets the tint, disconnects, and uninstalls — no lease, and a new episode sends nothing",
    async () => {
      const f = startFake();
      installRecoveryUi(f.path);
      const h = open();
      await awaitBanner(f);
      await until(() => lease(h.episodeId), "the lease before shutdown");
      const mark = f.mark();

      await shutdownRecoveryUi();

      await until(
        () => f.overlays(mark).some(isClear) && f.tints(mark).some(isTint("reset")),
        "the clearing overlay and tint reset on shutdown",
        1_000
      );
      expect((f.overlays(mark).find(isClear) as WireMsg).pane).toBe(0);
      await until(() => f.liveConnections === 0, "magmux to see the connection close", 1_000);
      expect(lease(h.episodeId)).toBe(false);

      const afterShutdown = f.mark();
      const connectionsBefore = f.opened;
      const h2 = open(seed({ providerDisplayName: "Late Cloud" }));
      await settle();
      await tick(f, 3);
      await settle();

      expect(f.received.slice(afterShutdown).map((r) => r.msg)).toEqual([]);
      expect(f.opened).toBe(connectionsBefore);
      expect(lease(h2.episodeId)).toBe(false);
      expect(lease(h.episodeId)).toBe(false);
    },
    SOCKET_TEST_TIMEOUT
  );
});
