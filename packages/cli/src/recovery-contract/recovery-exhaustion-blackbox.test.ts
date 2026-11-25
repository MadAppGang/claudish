/**
 * CONTRACT POINT 4 — at exhaustion the client gets 503 when a recovery banner
 * is confirmed on screen, and 400 when it is not.
 *
 * ONLY THE NEGATIVE ARM IS HERE, and that is a finding rather than an omission:
 * "a banner is confirmed on screen" has no published way to be SET from outside
 * the proxy independently of the switch that also enables the ladder, so the
 * 503 arm and the 400 arm cannot both be produced in one experiment (trap
 * T-13). See test-results.md — it needs a documented pane-attach seam or a PTY
 * end-to-end run.
 *
 * Every status below is read from `Response.status` of a fetch against the
 * proxy's own URL. This project's documented failure mode is that a terminal
 * error is remapped to 400 on the way out, so a status asserted anywhere
 * upstream of the socket is measuring a different thing than the user gets
 * (trap T-6).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DEAD_ENDPOINT_RESET,
  type FixturePool,
  type ProxyHandle,
  createRawFixturePool,
  endpointsConfig,
  envSnapshot,
  postMessage,
  reservePorts,
  startProxy,
  startRawFixture,
  startStatusFixture,
} from "./fixtures.js";

const API_TIMEOUT_MS = 40_000; // ⇒ 10s deadline ⇒ attempts at 0s, 5s

let restoreEnv: () => void;
let proxy: ProxyHandle;
let pool: FixturePool;

beforeAll(async () => {
  restoreEnv = envSnapshot(["API_TIMEOUT_MS", "CLAUDISH_RECOVERY", "CLAUDISH_RECOVERY_UI"]);
  process.env.API_TIMEOUT_MS = String(API_TIMEOUT_MS);
  delete process.env.CLAUDISH_RECOVERY;
  delete process.env.CLAUDISH_RECOVERY_UI; // UI on by default; no pane can attach here

  pool = createRawFixturePool(3, "ep-exhaust");
  proxy = await startProxy(endpointsConfig(pool.specs));
}, 60_000);

afterAll(async () => {
  await proxy?.shutdown();
  pool?.stopAll();
  restoreEnv?.();
});

describe("CP-4 — exhaustion with no banner on screen", () => {
  test("answers 400 connection_error naming provider, host and reason, with no recovery headers", async () => {
    const { model, fixture, name } = pool.next();
    const result = await postMessage(proxy.url, { model });

    // The ladder really ran first (otherwise this is just the off-switch).
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);

    expect(result.status).toBe(400);
    const err = JSON.parse(result.body).error;
    expect(err.type).toBe("connection_error");
    // provider, host and the reason, in the words the product already uses.
    expect(err.message.toLowerCase()).toContain(name.toLowerCase());
    expect(err.message).toContain(`127.0.0.1:${fixture.port}`);
    expect(err.message.length).toBeGreaterThan(20);

    // A 503 handed back for retry carries these; a 400 must not.
    expect(result.headers.get("x-claudish-recovery")).toBeNull();
    expect(result.headers.get("x-should-retry")).toBeNull();
  }, 60_000);

  test("the streaming path leaves the client something it can act on", async () => {
    // A-6: with headers already committed a 503 is unsendable, so the
    // contract is satisfiable two ways. Both are acceptable; a half-written
    // stream with no terminal error event is not — that is the shape that
    // silently truncates a turn.
    const { model, fixture } = pool.next();
    const result = await postMessage(proxy.url, { model, stream: true });
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);

    const actionable =
      result.status >= 400 ||
      (result.status === 200 && /event:\s*error/.test(result.body)) ||
      /"type"\s*:\s*"error"/.test(result.body);
    expect(
      actionable,
      `streaming exhaustion produced status ${result.status} with body ${result.body.slice(0, 300)}`
    ).toBe(true);
  }, 60_000);

  test("a recovery exhaustion survives an earlier candidate's auth failure in the chain", async () => {
    // C-14: an earlier candidate's non-connection failure must not turn the
    // recovery outcome into a combined terminal error that hides the reason
    // — the client must still be told the network is down, not that it is
    // unauthenticated.
    const [authPort] = reservePorts(1);
    const auth401 = startStatusFixture(401, authPort);
    const [deadPort] = reservePorts(1);
    // The body below is asserted word for word, so the reset must come after the
    // proxy has connected; see DEAD_ENDPOINT_RESET.
    const dead = startRawFixture(deadPort, { resetWhen: DEAD_ENDPOINT_RESET });
    let chainProxy: ProxyHandle | undefined;
    try {
      chainProxy = await startProxy(
        endpointsConfig([
          { name: "ep-auth", port: authPort, model: "m-auth" },
          { name: "ep-down", port: deadPort, model: "m-down" },
        ]),
        {
          model: "ep-auth@m-auth",
          modelChain: ["ep-auth@m-auth", "ep-down@m-down"],
        }
      );

      const result = await postMessage(chainProxy.url, { model: "ep-auth@m-auth" });

      expect(auth401.hits).toBeGreaterThanOrEqual(1);
      expect(dead.connections.length).toBeGreaterThanOrEqual(2); // candidate 2 laddered
      const err = JSON.parse(result.body).error;
      // The contract pins the STATUS for this case (C-14), not the error
      // type, so the type is asserted only negatively: the user must not be
      // told they have an auth problem while the network is down.
      expect(result.status).not.toBe(401);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(err.type).not.toBe("authentication_error");
      // The network reason survives into the body the client can read. On
      // the chain path it lands in `error.attempts[]` rather than
      // `error.message`, so assert against the body the client receives
      // rather than against one field of it.
      expect(result.body).toContain("Cannot reach");
      expect(result.body).toContain(`127.0.0.1:${dead.port}`);
    } finally {
      await chainProxy?.shutdown();
      auth401.stop();
      dead.stop();
    }
  }, 90_000);
});
