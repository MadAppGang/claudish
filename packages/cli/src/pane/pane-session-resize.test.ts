import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MagmuxReply } from "./magmux-client.js";
import { MIN_MAGMUX_VERSION } from "./pane-launch.js";
import { PaneSessionImpl, type PaneSessionOptions } from "./pane-session.js";

type Request = Record<string, unknown>;
type RecordedRequest = {
  msg: Request;
  timeoutMs?: number;
  reply: (reply: MagmuxReply) => void;
};

/** Only the attach/resize client surface; no transport, process or module mocks. */
class FakeClient {
  isClosed = false;
  readonly requests: RecordedRequest[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private readonly pending = new Set<(reply: MagmuxReply) => void>();

  on(event: string, cb: (event: unknown) => void): void {
    const callbacks = this.listeners.get(event) ?? [];
    callbacks.push(cb);
    this.listeners.set(event, callbacks);
  }

  emit(event: string, value: unknown = {}): void {
    if (event === "disconnected") this.isClosed = true;
    for (const cb of this.listeners.get(event) ?? []) cb(value);
  }

  request(msg: Request, timeoutMs?: number): Promise<MagmuxReply> {
    return new Promise((resolve) => {
      const reply = (r: MagmuxReply) => {
        this.pending.delete(reply);
        resolve(r);
      };
      this.requests.push({ msg, timeoutMs, reply });
      if (this.isClosed) {
        reply({ ok: false, code: "client_closed", error: "fake closed" });
      } else if (msg.type === "capabilities") {
        reply({
          ok: true,
          result: { protocol: 1, version: MIN_MAGMUX_VERSION, verbs: ["watch", "list", "resize"] },
        });
      } else if (msg.type === "watch" || msg.type === "list") {
        reply({ ok: true, result: { panes: [] } });
      } else if (msg.type === "resize") {
        this.pending.add(reply);
      } else {
        throw new Error(`unexpected fake request: ${String(msg.type)}`);
      }
    });
  }

  close(): void {
    this.isClosed = true;
    for (const reply of this.pending)
      reply({ ok: false, code: "client_closed", error: "fake closed" });
    this.emit("disconnected");
  }
}

const fixtures: Array<{ session: PaneSessionImpl; root: string; clients: FakeClient[] }> = [];

function fixture() {
  const root = mkdtempSync("/tmp/prsz-");
  const configDir = join(root, "config");
  const ctlDir = join(root, "launch-ctl000");
  const turnDir = join(root, "launch-turn00");
  for (const dir of [configDir, ctlDir, turnDir]) mkdirSync(dir);
  const opts: PaneSessionOptions = {
    kind: "s",
    label: "resize-test",
    callerFlags: [],
    spawnModel: "resize-test",
    cwd: root,
    sessionUuid: crypto.randomUUID(),
    transcriptPath: join(root, "transcript.jsonl"),
    slotEnv: {},
    shape: "interactive",
    readAvailable: true,
    parentEnv: { HOME: root, CLAUDE_CONFIG_DIR: configDir },
    decide: () => "continue",
    onBlocked: () => "wait",
  };
  // Do not start(): magmux stays null, so onDisconnected cannot dial a socket.
  const session = new PaneSessionImpl(opts, {
    paneId: "resize-test",
    sockPath: join(root, "absent.sock"),
    root,
    ctlDir,
    turnDir,
  });
  const f = { session, root, clients: [] as FakeClient[] };
  fixtures.push(f);
  return {
    session,
    async attach(reconnect = false) {
      const client = new FakeClient();
      f.clients.push(client);
      await (session as any).attach(client, reconnect);
      return client;
    },
  };
}

async function within(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  return predicate();
}

function resizeRequest(client: FakeClient): RecordedRequest {
  const request = client.requests.find((r) => r.msg.type === "resize");
  if (!request) throw new Error("resize() did not send a resize request");
  return request;
}

afterEach(async () => {
  for (const { session, root, clients } of fixtures.splice(0)) {
    try {
      for (const client of clients) client.close();
      // start() was never called: there is no process/group/watcher to reap.
      // Keep shutdown's terminal transition, without its unrelated `ps` subprocess.
      (session as any).reapPromise = Promise.resolve();
      await session.shutdownReap("resize test cleanup");
      expect(await within(() => !(session as any).resizeDraining, 500)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 5000);

describe("pane resize review regressions", () => {
  test("M1: reconnect applies a pending size queued during the previous screen wait", async () => {
    const { session, attach } = fixture();
    const first = await attach();
    const resized = session.resize(100, 40);
    resizeRequest(first).reply({
      ok: true,
      result: { cols: 100, rows: 40, changed: true, manual: true },
    });
    // Confirm the reply was consumed, with no frame to end the 1 s screen wait.
    expect(await within(() => (session as any).appliedSize?.cols === 100, 200)).toBe(true);
    expect((session as any).resizeDraining).toBe(true);
    expect(session.capture()).toMatchObject({ cols: 160 });
    first.emit("disconnected");
    expect(await session.resize(120, 45)).toMatchObject({ cols: 120, rows: 45, pending: true });
    const second = await attach(true);
    expect((session as any).resizeDraining).toBe(true);
    const received = await within(
      () =>
        second.requests.some(
          (r) => r.msg.type === "resize" && r.msg.cols === 120 && r.msg.rows === 45
        ),
      3000
    );
    await resized;
    expect(received, "fresh client must receive the pending 120x45 resize within 3 s").toBe(true);
  }, 5000);

  test("M2a: quiet window includes a redraw frame received before the resize reply", async () => {
    const { session, attach } = fixture();
    const client = await attach();
    const resized = session.resize(100, 40);
    client.emit("frame", {
      type: "frame",
      pane: 0,
      key: true,
      cols: 100,
      rows: 40,
      lines: [{ y: 0, t: "resize redraw" }],
    });
    const frameChangedAt = (session as any).screen.changedAt as number;
    expect(frameChangedAt).toBeGreaterThan(0);
    expect(session.capture()).toMatchObject({ cols: 100, rows: 40 });
    expect((session as any).inResizeQuiet(frameChangedAt)).toBe(true);
    await Bun.sleep(300);
    resizeRequest(client).reply({
      ok: true,
      result: { cols: 100, rows: 40, changed: true, manual: true },
    });
    await resized;
    expect(
      (session as any).inResizeQuiet(frameChangedAt),
      "pre-reply redraw must remain inside the quiet window"
    ).toBe(true);
  }, 5000);

  test("M2b: a timed-out resize retains its quiet window", async () => {
    const { session, attach } = fixture();
    const client = await attach();
    // Observe either outcome without letting the expected rejection escape the test.
    const settled = session.resize(100, 40).then(
      () => undefined,
      () => undefined
    );
    resizeRequest(client).reply({ ok: false, code: "client_timeout", error: "fake reply timeout" });
    await settled;
    expect(
      (session as any).inResizeQuiet(Date.now()),
      "a timeout may follow an applied resize and must retain the quiet window"
    ).toBe(true);
  }, 5000);
});
