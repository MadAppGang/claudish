/**
 * CONTRACT POINT 3 — when an attempt succeeds mid-ladder, the request completes
 * normally.
 *
 * REAL TIME, deliberately (trap T-10): a fake clock proves the policy and hides
 * the mechanism. A body that was consumed by attempt 1 and replayed empty, a
 * credential dropped on the retry, a timer that fires after the response was
 * already written — none of those are visible without real sockets and real
 * timers.
 *
 * Trap T-3 is the one this file exists for: every "it retried at 5s/10s/30s"
 * assertion in the suite passes on a feature that can never actually finish.
 *
 * The four turns run at the same time, each against its own endpoint, because
 * an episode is per endpoint: `beforeAll` starts them and each test awaits its
 * own. A run filtered to one test still starts all four, and `afterAll` waits
 * for every one of them before the proxy shuts down.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ProxyHandle,
  type RawFixture,
  endpointsConfig,
  envSnapshot,
  postMessage,
  reservePorts,
  startProxy,
  startRawFixture,
} from "./fixtures.js";

const API_TIMEOUT_MS = 60_000; // ⇒ 30s deadline ⇒ attempts at 0s, 5s, 15s

let restoreEnv: () => void;
let proxy: ProxyHandle;
const fixtures: RawFixture[] = [];

/** One endpoint per scenario: an episode is per-endpoint and outlives its request. */
const SCENARIOS = [
  "recovers", // resets attempt 1, serves attempt 2
  "body", // same, with a large distinctive body
  "stream", // same, client asked for stream:true
  "never", // never serves — the exhaustion arm
] as const;

const ports: Record<string, number> = {};
const fixtureOf: Record<string, RawFixture> = {};

// ~200 KB of distinctive payload plus a tool_result block. A body consumed
// by attempt 1 and replayed empty satisfies every timing assertion in this
// suite and delivers garbage to the model.
const filler = "REPLAY-MARKER-".repeat(14_000); // ≈ 196 KB
const content = [
  { type: "text", text: `head ${filler} tail` },
  {
    type: "tool_result",
    tool_use_id: "toolu_blackbox_1",
    content: "TOOL-RESULT-SENTINEL",
  },
];

type Turn = ReturnType<typeof postMessage>;
let turns: { recovers: Turn; body: Turn; stream: Turn; never: Turn };

beforeAll(async () => {
  restoreEnv = envSnapshot(["API_TIMEOUT_MS", "CLAUDISH_RECOVERY"]);
  process.env.API_TIMEOUT_MS = String(API_TIMEOUT_MS);
  delete process.env.CLAUDISH_RECOVERY;

  const reserved = reservePorts(SCENARIOS.length);
  SCENARIOS.forEach((name, i) => {
    ports[name] = reserved[i];
    const fx = startRawFixture(reserved[i], {
      resetWhen: "afterBody",
      serveFromAttempt: name === "never" ? Number.POSITIVE_INFINITY : 2,
      sseText: `RECOVERED-ANSWER-${name.toUpperCase()}`,
    });
    fixtures.push(fx);
    fixtureOf[name] = fx;
  });

  proxy = await startProxy(
    endpointsConfig(
      SCENARIOS.map((name) => ({ name: `ep-${name}`, port: ports[name], model: `m-${name}` }))
    )
  );

  turns = {
    recovers: postMessage(proxy.url, { model: "ep-recovers@m-recovers" }),
    body: postMessage(proxy.url, {
      model: "ep-body@m-body",
      content,
    }),
    stream: postMessage(proxy.url, {
      model: "ep-stream@m-stream",
      stream: true,
    }),
    never: postMessage(proxy.url, { model: "ep-never@m-never" }),
  };
  // A turn that rejects before its test awaits it is reported by that test.
  for (const turn of Object.values(turns)) void turn.catch(() => {});
}, 60_000);

afterAll(async () => {
  if (turns) await Promise.allSettled(Object.values(turns));
  await proxy?.shutdown();
  for (const f of fixtures) f.stop();
  restoreEnv?.();
});

describe("CP-3 — recovery completes the turn", () => {
  test("the upstream comes back mid-ladder and the client gets 200 with the real answer", async () => {
    const fixture = fixtureOf.recovers;
    const result = await turns.recovers;

    expect(result.status).toBe(200);
    expect(result.body).toContain("RECOVERED-ANSWER-RECOVERS");
    // It really did fail first: ≥2 upstream connections, and the answer
    // arrived no earlier than the second rung.
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);
    expect(result.elapsedMs).toBeGreaterThan(4_000);

    const parsed = JSON.parse(result.body);
    expect(parsed.type).toBe("message");
    expect(parsed.content[0].text).toContain("RECOVERED-ANSWER-RECOVERS");
  }, 60_000);

  test("the request BODY is replayed intact on the successful attempt", async () => {
    const fixture = fixtureOf.body;
    const result = await turns.body;

    expect(result.status).toBe(200);
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);

    const first = fixture.connections[0].body;
    const success = fixture.connections[fixture.connections.length - 1].body;

    expect(first.length).toBeGreaterThan(150_000);
    expect(success.length).toBeGreaterThan(150_000);
    expect(success).toContain("TOOL-RESULT-SENTINEL");
    expect(success.split("REPLAY-MARKER-").length - 1).toBe(14_000);
    // The retry must send the SAME request, not a truncated or re-encoded one.
    expect(success).toBe(first);
  }, 90_000);

  test("the credential travels with the retry", async () => {
    // A retry that drops the Authorization header turns an outage into a 401
    // storm the moment the network returns.
    const fixture = fixtureOf.body;
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);
    const first = fixture.connections[0].headers.authorization;
    const success = fixture.connections[fixture.connections.length - 1].headers.authorization;
    expect(first).toBe("Bearer test-key-ep-body");
    expect(success).toBe(first);
  }, 20_000);

  test("a recovered streaming turn is a well-formed Claude SSE stream", async () => {
    const fixture = fixtureOf.stream;
    const result = await turns.stream;

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);

    const events = result.body
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7).trim());

    expect(events.filter((e) => e === "message_start").length).toBe(1);
    expect(events).toContain("message_stop");
    expect(result.body).toContain("RECOVERED-ANSWER-STREAM");
    // Nothing may precede message_start that a strict SSE client would choke
    // on: the first event of the stream is the message_start itself.
    expect(events[0]).toBe("message_start");
  }, 60_000);

  test("an upstream that never returns produces exactly one exhaustion answer", async () => {
    const fixture = fixtureOf.never;
    const result = await turns.never;

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);

    const attemptsAtAnswer = fixture.connections.length;
    // No late attempt and no second response after the client was answered.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(fixture.connections.length).toBe(attemptsAtAnswer);
  }, 90_000);
});
