/**
 * F2: the child's exit code survives a magmux socket drop.
 *
 * Real magmux plus the fake interactive child (scenario `exit_mid_turn`, which exits with
 * code 3 about 300 ms after it receives a prompt). The test drops the session's socket while
 * the prompt is being delivered, and keeps the magmux socket path unreachable (renamed away,
 * the listener itself stays alive) so the session cannot simply reconnect and see the exit
 * event. Then the child exits.
 *
 *  - reachable-after-exit: the socket path comes back as soon as the child is gone. magmux
 *    still holds the pane and knows the code, so the session must report 3. (Whichever way
 *    the session learns it, through its own reconnect or by asking, the outcome is the same.)
 *  - unreachable: the path never comes back. magmux cannot be asked, so the session finishes
 *    without a code, and does so promptly (a bounded attempt, not a hang).
 *
 * Timing note: the one-second liveness tick means "reachable" can in principle lose a race
 * if the host is badly overloaded; re-run alone before calling a failure real.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import {
  type GateRun,
  clientOf,
  disposeGatePanes,
  gateUntil,
  startGatePane,
} from "./test-helpers/gated-pane.js";
import { MAGMUX, NO_MAGMUX_MESSAGE } from "./test-helpers/hermetic-env.js";

const T = 90_000;
/** Generous for a loaded host; the old behaviour finishes in ~1 s, a hang would be far over. */
const PROMPT_FINISH_MS = 12_000;

afterEach(async () => {
  await disposeGatePanes();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(check: () => boolean, label: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** Start an idle interactive pane whose first prompt makes the child exit with code 3. */
async function startExiting(): Promise<GateRun> {
  const r = await startGatePane("exit_mid_turn", { shape: "interactive" });
  await gateUntil(r, (s) => s.state === "AWAITING_INPUT", 45_000);
  return r;
}

/**
 * Send the prompt; the instant the first send is on the wire, hide the socket path and close
 * the session's client. Returns the child's pid and the paths needed to put the socket back.
 */
async function dropDuringDelivery(r: GateRun): Promise<{ pid: number; hidden: string }> {
  const pid = r.s.snapshot().panePid;
  if (!pid) throw new Error("the pane has no pid to watch");
  const sock = r.s.sockPath;
  const hidden = `${sock}.hidden`;
  const client = clientOf(r);
  const real = client.request.bind(client);
  let dropped = false;
  client.request = async (message, timeout) => {
    const delivery = real(message, timeout);
    if (message.type === "send" && typeof message.text === "string" && !dropped) {
      dropped = true;
      await Bun.sleep(100);
      renameSync(sock, hidden);
      client.close();
    }
    return delivery;
  };
  r.s.send("go");
  await until(() => dropped, "the socket drop", 20_000);
  return { pid, hidden };
}

describe.skipIf(!MAGMUX)(
  `F2 exit code after a socket drop (${MAGMUX ? "real magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    test(
      "F2-0 control: without any drop the child's exit code 3 is reported",
      async () => {
        const r = await startExiting();
        r.s.send("go");
        const snap = await gateUntil(r, (s) => s.exitCode !== null || s.state === "FAILED", 45_000);
        expect(snap.exitCode).toBe(3);
      },
      T
    );

    for (const lagMs of [0, 1000]) {
      test(
        `F2-1 socket dropped, child exits, magmux reachable ${lagMs} ms later: the session reports code 3`,
        async () => {
          const r = await startExiting();
          const { pid, hidden } = await dropDuringDelivery(r);
          const sock = r.s.sockPath;
          await until(() => !alive(pid), "the child to exit", 45_000);
          // The old liveness-only path gives up about a second after the exit. With 0 ms the
          // session's own redial can see the exit event; with 1000 ms only an attempt made
          // at the moment the child is found gone, and bounded to a second or two, can.
          // magmux itself holds the pane and its code throughout.
          await Bun.sleep(lagMs);
          if (existsSync(hidden)) renameSync(hidden, sock);
          const snap = await Promise.race([
            r.s.terminal,
            Bun.sleep(PROMPT_FINISH_MS).then(() => {
              throw new Error(`no terminal state in ${PROMPT_FINISH_MS} ms after the child exited`);
            }),
          ]);
          expect(snap.exitCode).toBe(3);
          expect(snap.state).toBe("FAILED");
        },
        T
      );
    }

    test(
      "F2-2 socket dropped, child exits, magmux unreachable: finishes promptly with no exit code",
      async () => {
        const r = await startExiting();
        const { pid, hidden } = await dropDuringDelivery(r);
        const sock = r.s.sockPath;
        await until(() => !alive(pid), "the child to exit", 45_000);
        const goneAt = Date.now();
        try {
          const snap = await Promise.race([
            r.s.terminal,
            Bun.sleep(PROMPT_FINISH_MS).then(() => {
              throw new Error(
                `the session was still unfinished ${PROMPT_FINISH_MS} ms after the child exited with magmux unreachable`
              );
            }),
          ]);
          expect(Date.now() - goneAt).toBeLessThan(PROMPT_FINISH_MS);
          expect(snap.exitCode).toBeNull();
          expect(["FAILED", "COMPLETED", "CANCELLED", "EMPTY", "TIMEOUT"]).toContain(snap.state);
        } finally {
          // Put the path back so the pane can be reaped and the no-orphan check can pass.
          if (existsSync(hidden)) renameSync(hidden, sock);
        }
      },
      T
    );
  }
);
