/**
 * Properties of the fault fixtures themselves, measured with the same in-process
 * `fetch` the proxy uses. A contract test that asserts the wording of a failure
 * relies on the fixture producing the same failure every time.
 */

import { expect, test } from "bun:test";
import { DEAD_ENDPOINT_RESET, reservePorts, startRawFixture } from "./fixtures.js";

// Back to back, with no wait between them: a reset taken at accept time shows up
// as `ConnectionRefused` about 1 time in 100 this way (measured 119 in 10 000), so
// 3000 fetches catch it nearly every run in about half a second.
const FETCHES = 3000;

test("a dead endpoint's reset reaches fetch as ECONNRESET on every connection", async () => {
  const [port] = reservePorts(1);
  const dead = startRawFixture(port as number, { resetWhen: DEAD_ENDPOINT_RESET });
  try {
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < FETCHES; i++) {
      const outcome = await fetch(`http://127.0.0.1:${dead.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then(
        (res) => `answered ${res.status}`,
        // Bun's fetch puts its own error name on `code`, the property claudish
        // classifies connection failures by.
        (err: unknown) => String((err as { code?: unknown } | null)?.code ?? err)
      );
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    expect(outcomes).toEqual({ ECONNRESET: FETCHES });
    expect(dead.connections).toHaveLength(FETCHES);
  } finally {
    dead.stop();
  }
}, 15_000);
