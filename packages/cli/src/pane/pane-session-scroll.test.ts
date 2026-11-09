import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ContractErrorException } from "./contract.js";
import type { MagmuxReply } from "./magmux-client.js";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";
import type { ScrollRequest } from "./scroll-input.js";
import {
  type GateRun,
  clientOf,
  disposeGatePanes,
  gateUntil,
  startGatePane,
} from "./test-helpers/gated-pane.js";
import { MAGMUX, NO_MAGMUX_MESSAGE } from "./test-helpers/hermetic-env.js";

const UP = "\x1b[<64;1;1M";
const DOWN = "\x1b[<65;1;1M";
const END = "\x1b[1;5F";
type Message = Record<string, unknown>;
type Send = { message: Message; timeout?: number; reply: (r: MagmuxReply) => void };
type RealRequest = (msg: Message, timeout?: number) => Promise<MagmuxReply>;

/** Same attach/event seam as pane-session-resize.test.ts; only send replies are controlled.
 * Live readiness comes from the supplied hermetic startup harness, NOT guessed private flags.
 */
class FakeClient {
  isClosed = false;
  readonly sends: Send[] = [];
  readonly lists: Send[] = [];
  holdLists = false;
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();
  private readonly pending = new Set<(r: MagmuxReply) => void>();
  constructor(private readonly otherRequest: RealRequest) {}
  on(event: string, cb: (e: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(cb);
    this.listeners.set(event, listeners);
  }
  emit(event: string, value: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(value);
  }
  request(message: Message, timeout?: number): Promise<MagmuxReply> {
    if (message.type === "list" && this.holdLists) {
      return new Promise((resolve) => {
        const reply = (r: MagmuxReply) => {
          if (!this.pending.delete(reply)) return;
          resolve(r);
        };
        this.pending.add(reply);
        this.lists.push({ message, timeout, reply });
      });
    }
    if (message.type !== "send") return this.otherRequest(message, timeout);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reply = (r: MagmuxReply) => {
        if (!this.pending.delete(reply)) return;
        if (timer) clearTimeout(timer);
        resolve(r);
      };
      this.pending.add(reply);
      this.sends.push({ message, timeout, reply });
      // Model the existing MagmuxClient request timeout; the test asserts its requested bound.
      if (timeout !== undefined)
        timer = setTimeout(
          () =>
            reply({
              ok: false,
              code: "client_timeout",
              error: "fake request deadline",
            }),
          timeout
        );
    });
  }
  close(): void {
    this.isClosed = true;
    for (const reply of [...this.pending])
      reply({ ok: false, code: "client_closed", error: "fake closed" });
  }
}

async function until(predicate: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(label);
    await Bun.sleep(5);
  }
}
async function unavailable(promise: Promise<unknown>, prefix?: string): Promise<void> {
  const outcome = await promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  );
  expect(outcome.error).toBeInstanceOf(ContractErrorException);
  expect(outcome.error).toMatchObject({ code: "scroll_unavailable" });
  if (prefix) expect((outcome.error as Error).message.startsWith(prefix)).toBe(true);
}

const restores: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  await disposeGatePanes();
}, 30_000);

function attachFake(r: GateRun, holdLists = false, original = clientOf(r)) {
  const previous = clientOf(r);
  const fake = new FakeClient(original.request.bind(original));
  fake.holdLists = holdLists;
  const attached = (
    r.s as unknown as { attach(c: unknown, reconnect: boolean): Promise<void> }
  ).attach(fake, true);
  void attached.catch(() => undefined);
  restores.push(() => {
    (r.s as unknown as { client: unknown }).client = previous;
    fake.close();
  });
  return { fake, original, attached };
}

async function verifyList(
  fake: FakeClient,
  original: ReturnType<typeof clientOf>,
  attached: Promise<void>
): Promise<void> {
  await until(() => fake.lists.length > 0, "attach never requested pane verification");
  const list = fake.lists[0]!;
  fake.holdLists = false;
  list.reply(await original.request(list.message, list.timeout));
  await attached;
}

function expectEnd(sent: Send): void {
  expect(sent.message).toEqual({
    type: "send",
    pane: 0,
    text: END,
    enter: false,
    noGate: true,
  });
}

/** A valid magmux frame: a transcript-off warning and a finished, idle REPL.
 * The fake child records no transcript prompt; only the screen can supply this answer.
 */
function screenOnlyAnswer(r: GateRun, fake: FakeClient): void {
  const capture = r.s.capture();
  if (!("lines" in capture)) throw new Error("expected a full capture");
  const lines = capture.lines.map((line) => (line.includes("Simmering") ? "" : line));
  const echoRow = lines.findIndex((line) =>
    line.includes("❯ turn whose prompt is never recorded in the transcript")
  );
  if (echoRow < 0) throw new Error("expected the prompt echo in the current capture");
  if (echoRow + 3 >= lines.length) throw new Error("expected room after the prompt echo");
  lines[echoRow + 1] = "  ⎿  Transcript saving is off";
  lines[echoRow + 2] = "⏺ screen fallback answer";
  lines[echoRow + 3] = "✻ Cogitated for 1s";
  fake.emit("frame", {
    type: "frame",
    pane: 0,
    key: true,
    cols: capture.cols,
    rows: capture.rows,
    cursor: capture.cursor,
    lines: lines.map((t, y) => ({ y, t })),
  });
}

async function live() {
  const r = await startGatePane("answer");
  await r.s.ready;
  await gateUntil(r, (s) => s.state === "AWAITING_INPUT");
  const original = clientOf(r);
  const fake = new FakeClient(original.request.bind(original));
  // attach is the seam used by the supplied resize regression tests.
  await (r.s as unknown as { attach(c: unknown, reconnect: boolean): Promise<void> }).attach(
    fake,
    true
  );
  restores.push(() => {
    (r.s as unknown as { client: unknown }).client = original;
    fake.close();
  });
  return { r, fake, original };
}
async function sendAt(fake: FakeClient, index: number, ms = 2000): Promise<Send> {
  await until(() => fake.sends.length > index, "scroll never sent its magmux request", ms);
  return fake.sends[index]!;
}
async function scroll(r: GateRun, fake: FakeClient, req: ScrollRequest): Promise<Send> {
  const index = fake.sends.length;
  const result = r.s.scroll(req);
  const sent = await sendAt(fake, index);
  sent.reply({ ok: true, result: {} });
  await result;
  return sent;
}

describe.skipIf(!MAGMUX)("review amendments on controlled connections", () => {
  // REQ: 5a.A
  test("an attached client with a held list reply refuses scroll as reconnecting", async () => {
    const { r, fake: previous, original: transport } = await live();
    await scroll(r, previous, { by: -1 });
    const { fake, original, attached } = attachFake(r, true, transport);
    await until(() => fake.lists.length > 0, "verification list not requested");
    expect(fake.isClosed).toBe(false);
    expect(r.s.capture().seq).toBeGreaterThan(0);
    expect(r.s.snapshot().state).toBe("AWAITING_INPUT");

    for (const req of [{ by: -1 }, { to: "end" }] as ScrollRequest[]) {
      await expect(r.s.scroll(req)).rejects.toMatchObject({
        code: "scroll_unavailable",
        message: expect.stringContaining("reconnecting"),
      });
    }
    expect(fake.sends).toHaveLength(0);
    await verifyList(fake, original, attached);
    // A refused request was not queued and did not change the remembered direction.
    expect((await scroll(r, fake, { by: -2 })).message.text).toBe(UP.repeat(2));
    expect(fake.sends).toHaveLength(1);
  }, 30_000);

  // REQ: 5a.A
  // REQ: 5a.D
  test("prompt restoration waits for verification then sends ctrl-End once before admission", async () => {
    const { r, fake: previous, original: transport } = await live();
    await scroll(r, previous, { by: -1 });
    const { fake, original, attached } = attachFake(r, true, transport);
    await until(() => fake.lists.length > 0, "verification list not requested");
    const delivery = Promise.resolve(r.s.send("deliver only on the verified connection"));
    void delivery.catch(() => undefined);
    try {
      // Let several evaluations run while the connection is attached but unverified.
      await Bun.sleep(300);
      expect(fake.sends).toHaveLength(0);
      expect(r.s.snapshot().turnsCompleted).toBe(0);
      await verifyList(fake, original, attached);
      const end = await sendAt(fake, 0);
      expectEnd(end);
      await Bun.sleep(300);
      expect(fake.sends).toHaveLength(1);
      end.reply({ ok: true, result: {} });
      const prompt = await sendAt(fake, 1);
      expect(prompt.message.noGate).not.toBe(true);
      await Bun.sleep(300);
      expect(fake.sends.filter((s) => s.message.text === END)).toHaveLength(1);
      prompt.reply(await original.request(prompt.message, prompt.timeout));
      await delivery;
      await gateUntil(r, (s) => s.state === "AWAITING_INPUT" && s.turnsCompleted === 1);
      expect(fake.sends.filter((s) => s.message.text === END)).toHaveLength(1);
    } finally {
      fake.close();
      r.s.cancel();
      await delivery.catch(() => undefined);
    }
  }, 30_000);

  for (const failure of ["not-ok", "timeout", "no-connection"] as const) {
    // REQ: 5a.D
    test(`a ${failure} ctrl-End does not prevent or reattempt the prompt admission`, async () => {
      const { r, fake: current, original } = await live();
      await scroll(r, current, { by: -1 });
      if (failure === "no-connection") current.isClosed = true;
      const delivery = Promise.resolve(r.s.send(`prompt after ${failure} restoration`));
      void delivery.catch(() => undefined);
      try {
        if (failure === "no-connection") {
          await Bun.sleep(300);
          expect(current.sends).toHaveLength(1);
          current.isClosed = false;
          // Model a fresh, verified connection after the disconnected admission wait.
          await (
            r.s as unknown as { attach(c: unknown, reconnect: boolean): Promise<void> }
          ).attach(current, true);
        }
        const end = await sendAt(current, 1);
        expectEnd(end);
        const started = performance.now();
        if (failure === "not-ok") {
          end.reply({ ok: false, code: "refused", error: "fake ctrl-End refusal" });
        } else if (failure === "timeout") {
          expect(end.timeout).toBe(5000);
          // No reply: the fake's requested deadline must be the only wait.
        } else {
          end.reply({ ok: false, code: "client_closed", error: "connection lost" });
        }
        const prompt = await sendAt(current, 2, failure === "timeout" ? 6500 : 2000);
        expect(prompt.message.noGate).not.toBe(true);
        if (failure === "timeout") {
          expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
          expect(performance.now() - started).toBeLessThan(6500);
        }
        // A held prompt reply gives admission evaluations time to run; no second ctrl-End.
        await Bun.sleep(300);
        expect(current.sends.filter((s) => s.message.text === END)).toHaveLength(1);
        prompt.reply(await original.request(prompt.message, prompt.timeout));
        await delivery;
        await gateUntil(r, (s) => s.state === "AWAITING_INPUT" && s.turnsCompleted === 1);
        const offset = current.sends.length;
        await scroll(r, current, { by: -2 });
        expect(current.sends[offset]!.message.text).toBe(UP.repeat(3));
      } finally {
        current.close();
        r.s.cancel();
        await delivery.catch(() => undefined);
      }
    }, 30_000);
  }

  for (const confirmation of ["not-ok", "timeout"] as const) {
    // REQ: 5a.C
    test(`a scrolled screen-read turn waits for ${confirmation} ctrl-End confirmation and fresh quiet time`, async () => {
      // No prompt is recorded. Withhold the child's finished screen beyond this test's
      // budget so the controlled frame below is the only possible finished answer.
      // empty_transcript omits the early transcript-off warning: first accept the
      // prompt and scroll while RUNNING, then announce screen fallback explicitly.
      const r = await startGatePane("empty_transcript", {
        env: { FAKE_GAP_MS_SCREEN: "120000" },
      });
      await r.s.ready;
      await gateUntil(r, (s) => s.state === "AWAITING_INPUT");
      const { fake, original, attached } = attachFake(r);
      await attached;
      const delivery = Promise.resolve(
        r.s.send("turn whose prompt is never recorded in the transcript")
      );
      void delivery.catch(() => undefined);
      const prompt = await sendAt(fake, 0);
      prompt.reply(await original.request(prompt.message, prompt.timeout));
      await delivery;
      // send() acknowledges queueing; public RUNNING also covers the ADMITTING phase.
      await gateUntil(r, (s) => s.phase === "RUNNING");
      expect(readFileSync(r.transcript, "utf8")).toBe("");
      expect((await scroll(r, fake, { by: -2 })).message.text).toBe(UP.repeat(3));

      screenOnlyAnswer(r, fake);
      const first = await sendAt(fake, 2, 15_000);
      expectEnd(first);
      expect(r.s.snapshot()).toMatchObject({ state: "RUNNING", turnsCompleted: 0 });
      expect(r.turns).toHaveLength(0);
      await Bun.sleep(300);
      expect(r.s.snapshot()).toMatchObject({ state: "RUNNING", turnsCompleted: 0 });
      expect(r.turns).toHaveLength(0);
      if (confirmation === "not-ok")
        first.reply({ ok: false, code: "refused", error: "fake restore failure" });
      else expect(first.timeout).toBe(5000);
      const retry = await sendAt(fake, 3, confirmation === "timeout" ? 8000 : 3000);
      expectEnd(retry);
      expect(r.s.snapshot()).toMatchObject({ state: "RUNNING", turnsCompleted: 0 });
      expect(r.turns).toHaveLength(0);

      // This frame has an answer after the echo, so its quiet time is 6 s (5a.C).
      // Keep the 35 s hold, beyond even the 32 s no-answer quiet; unanswered retries
      // must expire normally rather than settling the scrolled answer.
      const holdUntil = Date.now() + 35_000;
      while (Date.now() < holdUntil) {
        expect(r.s.snapshot()).toMatchObject({ state: "RUNNING", turnsCompleted: 0 });
        expect(r.turns).toHaveLength(0);
        await Bun.sleep(100);
      }
      // Wait for a fresh retry so the eventual success arrives within its reply deadline.
      const confirmed = await sendAt(fake, fake.sends.length, 8000);
      expectEnd(confirmed);
      const confirmedAt = performance.now();
      confirmed.reply({ ok: true, result: {} });
      // Quiet time accrued before confirmation cannot be spent after it.
      // Check just short of the 6 s answer-row quiet, leaving a polling margin.
      const freshQuietUntil = confirmedAt + 5500;
      while (performance.now() < freshQuietUntil) {
        expect(r.s.snapshot()).toMatchObject({ state: "RUNNING", turnsCompleted: 0 });
        expect(r.turns).toHaveLength(0);
        await Bun.sleep(100);
      }
      await gateUntil(r, (s) => s.state === "AWAITING_INPUT" && s.turnsCompleted === 1, 8000);
      expect(performance.now() - confirmedAt).toBeGreaterThanOrEqual(6000);
      expect(r.turns).toHaveLength(1);
      expect(r.turns[0]!.answer).toContain("screen fallback answer");
      expect(readFileSync(r.transcript, "utf8")).toBe("");
      expect((await scroll(r, fake, { by: -1 })).message.text).toBe(UP.repeat(2));
    }, 115_000);
  }
});

describe("scroll refusal before a child is started", () => {
  // REQ: 5 (state gate: no pane / no screen / booting)
  test("unstarted session refuses scroll without sending or creating a connection", async () => {
    const root = mkdtempSync("/tmp/pscr-");
    for (const name of ["config", "ctl", "turn"]) mkdirSync(join(root, name));
    const opts: PaneSessionOptions = {
      kind: "s",
      label: "scroll-test",
      callerFlags: [],
      spawnModel: "scroll-test",
      cwd: root,
      sessionUuid: crypto.randomUUID(),
      transcriptPath: join(root, "transcript.jsonl"),
      slotEnv: {},
      shape: "interactive",
      readAvailable: true,
      parentEnv: { HOME: root, CLAUDE_CONFIG_DIR: join(root, "config") },
      decide: () => "continue",
      onBlocked: () => "wait",
    };
    const session = new PaneSessionImpl(opts, {
      paneId: "scroll-test",
      sockPath: join(root, "absent.sock"),
      root,
      ctlDir: join(root, "ctl"),
      turnDir: join(root, "turn"),
    });
    try {
      expect(session.capture()).toMatchObject({ seq: 0 });
      await unavailable(session.scroll({ by: -1 }));
      await unavailable(session.scroll({ to: "end" }));
      expect((session as unknown as { client: unknown }).client).toBeNull();
      expect(session.capture()).toMatchObject({ seq: 0 });
    } finally {
      // No start(), hence no child or watcher to reap (same seam as resize tests).
      (session as unknown as { reapPromise: Promise<void> }).reapPromise = Promise.resolve();
      await session.shutdownReap("scroll test cleanup");
      rmSync(root, { recursive: true, force: true });
    }
  });
});

if (!MAGMUX) console.warn(`pane live-scroll transport SKIPPED — ${NO_MAGMUX_MESSAGE}`);

describe.skipIf(!MAGMUX)("live pane scroll with controlled magmux replies", () => {
  // REQ: 4, 5.2, 5.4
  test("sends one raw ungated burst with a 5000 ms confirmation deadline", async () => {
    const { r, fake } = await live();
    const before = r.s.capture().seq;
    const result = r.s.scroll({ by: -3 });
    const sent = await sendAt(fake, 0);
    expect(fake.sends).toHaveLength(1);
    expect(sent.message).toEqual({
      type: "send",
      pane: 0,
      text: UP.repeat(4),
      enter: false,
      noGate: true,
    });
    expect(sent.timeout).toBe(5000);
    sent.reply({ ok: true, result: {} });
    expect(await result).toEqual({ seq: before });
    expect(fake.sends).toHaveLength(1);
  }, 30_000);

  // REQ: 5.4
  test("waits for a changed frame and answers that seq rather than the pre-scroll seq", async () => {
    const { r, fake } = await live();
    const before = r.s.capture().seq;
    let settled = false;
    const result = r.s.scroll({ by: -1 }).then((v) => {
      settled = true;
      return v;
    });
    const sent = await sendAt(fake, 0);
    sent.reply({ ok: true, result: {} });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    fake.emit("frame", {
      type: "frame",
      pane: 0,
      key: true,
      cols: 160,
      rows: 50,
      lines: [{ y: 0, t: "controlled scroll redraw" }],
    });
    expect(r.s.capture().seq).toBeGreaterThan(before);
    expect(await result).toEqual({ seq: r.s.capture().seq });
  }, 30_000);

  // REQ: 5.4
  test("an unchanged edge screen returns current seq after the 1000 ms screen wait", async () => {
    const { r, fake } = await live();
    const before = r.s.capture().seq;
    const result = r.s.scroll({ to: "end" });
    const sent = await sendAt(fake, 0);
    const repliedAt = performance.now();
    sent.reply({ ok: true, result: {} });
    expect(await result).toEqual({ seq: before });
    const elapsed = performance.now() - repliedAt;
    // Lower bound catches an immediate stale answer; generous upper bound is only a hang guard.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
    expect(sent.message).toEqual({ type: "send", pane: 0, text: END, enter: false, noGate: true });
  }, 30_000);

  // REQ: 4, 5
  test("success keeps direction state and to end resets it", async () => {
    const { r, fake } = await live();
    const requests: ScrollRequest[] = [
      { by: -2 },
      { by: -2 },
      { by: 2 },
      { to: "end" },
      { by: -2 },
    ];
    for (const req of requests) await scroll(r, fake, req);
    expect(fake.sends.map((s) => s.message.text)).toEqual([
      UP.repeat(3),
      UP.repeat(2),
      DOWN.repeat(3),
      END,
      UP.repeat(3),
    ]);
  }, 30_000);

  for (const failure of ["not-ok", "timeout"] as const) {
    // REQ: 5.3
    test(`${failure} confirmation refuses the call and makes the next position unknown`, async () => {
      const { r, fake } = await live();
      await scroll(r, fake, { by: -1 });
      const failed = r.s.scroll({ by: -2 });
      const rejected = unavailable(failed, "magmux did not confirm the scroll");
      const sent = await sendAt(fake, 1);
      expect(sent.message.text).toBe(UP.repeat(2)); // same direction before failure
      expect(sent.timeout).toBe(5000);
      if (failure === "not-ok") sent.reply({ ok: false, code: "refused", error: "fake refusal" });
      // For timeout, deliberately supply no reply: FakeClient's requested deadline expires.
      await rejected;
      expect((await scroll(r, fake, { by: -2 })).message.text).toBe(UP.repeat(3));
    }, 30_000);
  }

  // REQ: 5.1 (state gate: admitting)
  test("an in-flight prompt admission refuses scroll before sending any wheel bytes", async () => {
    const { r, fake } = await live();
    // Hold the existing prompt send's magmux response, not an invented session state flag.
    const delivery = Promise.resolve(r.s.send("a prompt held at magmux admission")).then(
      () => undefined,
      () => undefined
    );
    try {
      const promptSend = await sendAt(fake, 0);
      expect(promptSend.message.noGate).not.toBe(true);
      const count = fake.sends.length;
      await unavailable(r.s.scroll({ by: -1 }));
      await unavailable(r.s.scroll({ to: "end" }));
      expect(fake.sends).toHaveLength(count);
    } finally {
      fake.close(); // resolve the deliberately held prompt request before cleanup
      r.s.cancel();
      await delivery;
    }
  }, 30_000);

  // REQ: 5 (state gate: reconnecting, nothing queued)
  test("a disconnected socket refuses without enqueueing a send for reconnect", async () => {
    const { r, fake } = await live();
    fake.isClosed = true;
    await unavailable(r.s.scroll({ by: -2 }));
    expect(fake.sends).toHaveLength(0);
    fake.isClosed = false;
    await scroll(r, fake, { by: 1 });
    expect(fake.sends.map((s) => s.message.text)).toEqual([DOWN.repeat(2)]);
  }, 30_000);

  // REQ: 5 (state gate: terminal)
  test("a cancelled live session refuses scroll and sends nothing", async () => {
    const { r, fake } = await live();
    r.s.cancel();
    expect(r.s.snapshot().state).toBe("CANCELLED");
    const sentAtCancel = fake.sends.length;
    await unavailable(r.s.scroll({ by: -1 }));
    await unavailable(r.s.scroll({ to: "end" }));
    expect(fake.sends).toHaveLength(sentAtCancel);
  }, 30_000);
});
