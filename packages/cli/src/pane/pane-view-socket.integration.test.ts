/**
 * The read-only view socket, against REAL magmux and the fake interactive child: a pane's
 * magmux binds `<sockRoot>/magmux-<id>.view`, attach verifies it and publishes its path, the
 * socket refuses input, and the reap removes it. Hermetic env and sockRoot per test, ending
 * with the no-orphan check.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { MagmuxClient } from "./magmux-client.js";
import { type PaneSession, startPaneSession } from "./pane-session.js";
import { viewSockPathOf } from "./process-identity.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  newSessionUuid,
  waitNoOrphans,
} from "./test-helpers/hermetic-env.js";

const T = 40_000;

const open: Array<{ s: PaneSession; t: PaneTestEnv; uuid: string }> = [];
afterAll(async () => {
  for (const r of open) {
    r.s.cancel();
    await r.s.reaped();
    killLeftovers({ sockRoot: r.t.sockRoot, ids: [r.uuid] });
    r.t.cleanup();
  }
});

async function until<T>(read: () => T | null | undefined, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what} not seen in ${ms} ms`);
    await Bun.sleep(50);
  }
}

describe.skipIf(!MAGMUX)(
  `pane view socket, real magmux (${MAGMUX ? "" : NO_MAGMUX_MESSAGE})`,
  () => {
    test(
      "a pane's .view is private, verified, read-only, published, and gone after the reap",
      async () => {
        const t = makePaneTestEnv({ CONTRACT_FAKE_MAX_MS: "60000" });
        const uuid = newSessionUuid();
        const s = await startPaneSession({
          kind: "t",
          label: "01",
          callerFlags: [],
          spawnModel: "fake-answer",
          cwd: t.cwd,
          sessionUuid: uuid,
          transcriptPath: t.transcriptPathFor(uuid),
          slotEnv: {},
          shape: "interactive",
          initialPrompt: undefined,
          readAvailable: true,
          parentEnv: t.env,
          sockRoot: t.sockRoot,
          decide: () => "continue",
          onBlocked: (b) => ({ state: "FAILED", reason: "blocked", detail: b.text }),
          timings: { replStableMs: 200, bootStaticMs: 800, corroborationMs: 200 },
        });
        const run = { s, t, uuid };
        open.push(run);

        const view = viewSockPathOf(t.sockRoot, s.paneId);
        await s.ready;
        const published = await until(() => s.snapshot().viewSockPath, "a published view socket");
        expect(published).toBe(view);
        expect(s.snapshot().anomalies).not.toContain("view_socket_unverified");

        const st = lstatSync(view);
        expect(st.isSocket()).toBe(true);
        expect(st.uid).toBe(process.getuid?.() ?? st.uid);
        // magmux 0.19.0 leaves the socket inode at the umask's mode; nobody else can write to
        // it, and the directory that holds it admits its owner only
        expect(st.mode & 0o022).toBe(0);
        expect(statSync(dirname(view)).mode & 0o077).toBe(0);

        const client = await MagmuxClient.dial(view);
        try {
          const caps = await client.request<{ readOnly?: unknown; viewSocket?: unknown }>({
            type: "capabilities",
          });
          expect(caps.ok).toBe(true);
          if (caps.ok) {
            expect(caps.result.readOnly).toBe(true);
            expect(caps.result.viewSocket).toBe(view);
          }
          const sent = await client.request({ type: "send", pane: 0, text: "typed from a viewer" });
          expect(sent).toMatchObject({ ok: false, code: "forbidden", reason: "read_only" });
        } finally {
          client.close();
        }

        open.splice(open.indexOf(run), 1);
        s.cancel();
        await s.reaped();
        expect(s.snapshot().viewSockPath).toBeNull();
        const left = await waitNoOrphans({
          sockRoot: t.sockRoot,
          ids: [uuid],
          pgids: [s.snapshot().panePid ?? 0],
        });
        killLeftovers({ sockRoot: t.sockRoot, ids: [uuid] });
        expect(existsSync(view)).toBe(false);
        t.cleanup();
        expect(left).toEqual({ processes: [], files: [] });
      },
      T
    );
  }
);
