/**
 * Black-box tests: the Grok OAuth token refresh must not hang on a half-open token host.
 *
 * Spec (from the caller's brief): claudish refreshes an expired Grok OAuth token by POSTing
 * to `<issuer>/oauth2/token` behind a single-flight latch. The refresh must give up after
 * TOKEN_REFRESH_TIMEOUT_MS (20000 ms), fail as a CONNECTION error that names the token host,
 * release the latch, and still share ONE in-flight refresh between concurrent callers.
 *
 * Coverage map (requirement -> test):
 *   REQ-0  the ceiling is 20000 ms                       -> "REQ-0 ..."
 *   REQ-T1 hung host -> rejects within ~ceiling           -> "REQ-T1 ..."
 *   REQ-T2 the rejection classifies as "unreachable"      -> "REQ-T2 ..."
 *   REQ-T3 the rejection carries claudishEndpoint         -> "REQ-T3 ..."
 *   REQ-T4 the latch clears: 2 sequential calls = 2 POSTs -> "REQ-T4 ..."
 *   REQ-T5 2 concurrent calls = exactly 1 POST            -> "REQ-T5 ..."
 *
 * The hung host is a real `Bun.serve` on an ephemeral port, so the real client and its real
 * AbortSignal timeout are exercised: no fetch double, no module mock. REQ-0 pins the 20000 ms
 * value; the waits run at CEILING_MS through `setGrokRefreshTimeoutForTesting`, because the
 * latch, the classification and the endpoint name are the same at any ceiling. The waits are
 * also SHARED:
 *   - T1, T2, T3 and T4 assert on ONE timed-out refresh (`firstTimedOutRefresh`). Whichever of
 *     them runs first starts it; the rest reuse its recorded outcome. Each test awaits it
 *     itself, so any one of them run alone (`-t`) still performs the call, and a refresh that
 *     never settles fails every one of them with "Received: pending" rather than passing.
 *   - T4 adds exactly one more call on the same host, so its host sees 2 POSTs in total.
 *   - T5 uses its own host and its own concurrent pair, so its request count is its own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import { TOKEN_REFRESH_TIMEOUT_MS } from "../../handlers/shared/transient-retry.js";
import {
  resolveGrokAccessToken,
  setGrokHomeForTesting,
  setGrokRefreshTimeoutForTesting,
} from "./grok-credentials.js";

const OIDC_SCOPE = "https://auth.x.ai::TEST-CLIENT-ID";

/** The refresh ceiling these tests run at. */
const CEILING_MS = 300;
/** "About the ceiling" with generous slack: a missing timeout still reports as `pending`. */
const SETTLE_LIMIT_MS = CEILING_MS + 3_000;
/** Per-test budgets, well above the in-test deadline so the deadline reports first. */
const ONE_CALL_BUDGET_MS = 10_000;
const TWO_CALL_BUDGET_MS = 15_000;

beforeAll(() => setGrokRefreshTimeoutForTesting(CEILING_MS));
afterAll(() => setGrokRefreshTimeoutForTesting(null));

const TOKEN_POST = { method: "POST", path: "/oauth2/token" } as const;

type TokenRequest = { method: string; path: string };

type Settled =
  | { state: "rejected"; error: unknown; elapsedMs: number }
  | { state: "resolved"; value: unknown; elapsedMs: number }
  | { state: "pending"; elapsedMs: number };

/**
 * Wait for `promise` to settle, but never longer than `limitMs`. A call that is still
 * unsettled at the deadline reports `pending` instead of hanging the test, so a missing
 * timeout shows up as a readable assertion failure rather than only as a test timeout.
 * Call this immediately after starting the operation: elapsedMs is measured from here.
 */
async function settleWithin(promise: Promise<unknown>, limitMs: number): Promise<Settled> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), limitMs);
  });
  try {
    const outcome = await Promise.race([
      promise.then(
        (value) => ({ state: "resolved" as const, value }),
        (error: unknown) => ({ state: "rejected" as const, error })
      ),
      deadline,
    ]);
    const elapsedMs = performance.now() - startedAt;
    if (outcome === "deadline") return { state: "pending", elapsedMs };
    return { ...outcome, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

function rejectionOf(outcome: Settled): unknown {
  expect(outcome.state).toBe("rejected");
  if (outcome.state !== "rejected") throw new Error(`expected a rejection, got ${outcome.state}`);
  return outcome.error;
}

interface HungTokenHost {
  tokenEndpoint: string;
  /** Every request the host has received, in arrival order. */
  requests: TokenRequest[];
  close(): Promise<void>;
}

/**
 * Start a token host that accepts every request and never answers it, and point a fresh
 * Grok home at it: the only credential is expired and names this host as its issuer.
 */
function openHungTokenHost(): HungTokenHost {
  const requests: TokenRequest[] = [];
  // Resolvers of the handler promises the host is still holding open, one per request.
  const pendingAnswers: Array<(response: Response) => void> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Bun's server closes a connection whose handler has not answered within `idleTimeout`
    // seconds (default 10). That server-side close would reject the client FOR us and hide
    // a missing client-side timeout, so it is disabled: this host accepts and stays silent
    // for as long as the client is willing to wait — the half-open socket from the spec.
    idleTimeout: 0,
    fetch(req) {
      requests.push({ method: req.method, path: new URL(req.url).pathname });
      // Never answered while the test runs; the resolver is kept only so close() can
      // release the handler.
      return new Promise<Response>((resolve) => {
        pendingAnswers.push(resolve);
      });
    },
  });
  const issuer = `http://127.0.0.1:${server.port}`;

  const grokHome = mkdtempSync(join(tmpdir(), "claudish-grok-refresh-timeout-"));
  setGrokHomeForTesting(grokHome);
  writeFileSync(
    join(grokHome, "auth.json"),
    `${JSON.stringify(
      {
        [OIDC_SCOPE]: {
          key: "tok-old",
          refresh_token: "ref-old",
          expires_at: "2000-01-01T00:00:00.000Z",
          auth_mode: "oidc",
          oidc_issuer: issuer,
          oidc_client_id: "TEST-CLIENT-ID",
        },
      },
      null,
      2
    )}\n`
  );

  return {
    tokenEndpoint: `${issuer}/oauth2/token`,
    requests,
    async close() {
      setGrokHomeForTesting(null);
      // Settle every handler the host still holds BEFORE stopping it. On Bun 1.3.10,
      // `stop(true)` waits for in-flight handlers even after the client has aborted, so a
      // never-settling handler hangs this teardown until its hook times out (Bun 1.4.0 does
      // not wait). The client gave up long ago, so nobody receives this answer.
      for (const answer of pendingAnswers.splice(0)) {
        answer(new Response(null, { status: 503 }));
      }
      await server.stop(true);
      rmSync(grokHome, { recursive: true, force: true });
    },
  };
}

describe("the Grok token refresh ceiling", () => {
  test("REQ-0: the refresh ceiling TOKEN_REFRESH_TIMEOUT_MS is 20000 ms", () => {
    expect(TOKEN_REFRESH_TIMEOUT_MS).toBe(20_000);
  });
});

describe("one refresh against a token host that accepts and never answers", () => {
  let host: HungTokenHost;
  let firstRefresh: Promise<{ outcome: Settled; requestsWhenSettled: TokenRequest[] }> | undefined;

  beforeAll(() => {
    host = openHungTokenHost();
  });

  afterAll(async () => {
    await host.close();
  });

  /**
   * The ONE timed-out refresh T1-T4 share. Started by whichever test asks first; the request
   * log is snapshotted when it settles, so a later call (T4's) cannot change what T1 sees.
   */
  function firstTimedOutRefresh() {
    firstRefresh ??= settleWithin(resolveGrokAccessToken(), SETTLE_LIMIT_MS).then((outcome) => ({
      outcome,
      requestsWhenSettled: [...host.requests],
    }));
    return firstRefresh;
  }

  test(
    "REQ-T1: resolveGrokAccessToken rejects instead of hanging, within about the refresh ceiling",
    async () => {
      const { outcome, requestsWhenSettled } = await firstTimedOutRefresh();

      // A hung refresh holds the single-flight latch, so every later request would join it.
      expect(outcome.state).toBe("rejected");
      expect(outcome.elapsedMs).toBeLessThan(SETTLE_LIMIT_MS);
      // The rejection came from the hung token host, not from a precondition failing first.
      expect(requestsWhenSettled).toEqual([TOKEN_POST]);
    },
    ONE_CALL_BUDGET_MS
  );

  test(
    "REQ-T2: the timed-out refresh is classified as a connection failure of kind unreachable",
    async () => {
      const error = rejectionOf((await firstTimedOutRefresh()).outcome);

      // Unclassified, this error would escape into the fallback chain (metered billing).
      expect(classifyConnectionError(error)).toEqual({
        kind: "unreachable",
        code: expect.any(String),
      });
    },
    ONE_CALL_BUDGET_MS
  );

  test(
    "REQ-T3: the timed-out refresh names the token endpoint as claudishEndpoint",
    async () => {
      const error = rejectionOf((await firstTimedOutRefresh()).outcome);

      // The user must be told about the AUTH host that went silent, not the inference host.
      expect((error as { claudishEndpoint?: unknown }).claudishEndpoint).toBe(host.tokenEndpoint);
    },
    ONE_CALL_BUDGET_MS
  );

  test(
    "REQ-T4: after a timed-out refresh the latch is released, so the next call makes a new request",
    async () => {
      const first = await firstTimedOutRefresh();
      expect(first.outcome.state).toBe("rejected");
      expect(first.requestsWhenSettled).toEqual([TOKEN_POST]);

      const second = await settleWithin(resolveGrokAccessToken(), SETTLE_LIMIT_MS);

      // A latch left holding the dead promise would answer the second call with no request.
      expect(second.state).toBe("rejected");
      expect(host.requests).toEqual([TOKEN_POST, TOKEN_POST]);
    },
    TWO_CALL_BUDGET_MS
  );
});

describe("two concurrent refreshes against a token host that accepts and never answers", () => {
  let host: HungTokenHost;

  beforeAll(() => {
    host = openHungTokenHost();
  });

  afterAll(async () => {
    await host.close();
  });

  test(
    "REQ-T5: two concurrent calls against the hung host send exactly one refresh request",
    async () => {
      const firstCall = resolveGrokAccessToken();
      const secondCall = resolveGrokAccessToken();

      const outcomes = await Promise.all([
        settleWithin(firstCall, SETTLE_LIMIT_MS),
        settleWithin(secondCall, SETTLE_LIMIT_MS),
      ]);

      expect(outcomes.map((o) => o.state)).toEqual(["rejected", "rejected"]);
      // The server rotates the refresh token; a second concurrent refresh breaks the session.
      expect(host.requests).toEqual([TOKEN_POST]);
    },
    ONE_CALL_BUDGET_MS
  );
});
