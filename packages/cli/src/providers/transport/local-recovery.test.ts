/**
 * C-17 — a stopped LOCAL provider reaches the ladder at all.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM EVERY OTHER RECOVERY TEST. The rest of
 * the suite induces its faults with a CUSTOM ENDPOINT, and custom endpoints are
 * built on the OpenAI / Anthropic / LiteLLM transports — none of which has a
 * `refreshAuth`, and all of which now classify a connect failure correctly. So
 * the whole of C-1…C-6 can go green over a completely broken local path: a
 * stopped Ollama fails inside `checkHealth()`, which used to swallow the
 * syscall error, and `refreshAuth()` rethrew a bare `Error` carrying neither a
 * `code` nor a `cause`. `classifyConnectionError` returned `null`, and the
 * single most common local failure never reached recovery at all.
 *
 * Four assertions, and only the first was in the original criterion:
 *
 *   1. the ladder runs at all;
 *   2. exactly ONE episode across the whole recovery;
 *   3. NO `recovered` is reported while the server stays down;
 *   4. the `[Recovery]` lines name the PROBE endpoint, not the inference one.
 *
 * Assertions 2 and 3 exist because assertion 1 passes even when the fix is a
 * no-op. `refreshAuth` opens with `if (this.healthChecked) return;` and
 * `checkHealth()` used to latch that flag ON FAILURE, so a retried
 * `refreshAuth()` issued no probe and did not throw — it returned SUCCESS for a
 * server that was still dead. The episode would close `recovered` for an outage
 * that never ended, and the banner and ladder assertion 1 sees would belong to
 * a SECOND episode opened milliseconds later by the fetch path against the same
 * dead port.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { ComposedHandler } from "../../handlers/composed-handler.js";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import { withConnectionRetry } from "../../handlers/shared/transient-retry.js";
import { resetRecoveryClock, setRecoveryClock } from "../../recovery/clock.js";
import { closeAllEpisodes, episodeCount } from "../../recovery/coordinator.js";
import {
  capturedRecoveryLines,
  startLogCapture,
  stopLogCapture,
} from "../../recovery/test-helpers/capture-log.js";
import { FakeClock, advanceUntilSettled, drain } from "../../recovery/test-helpers/fake-clock.js";
import type { LocalProvider as LocalProviderConfig } from "../provider-registry.js";
import { LocalTransport } from "./local.js";

/** A port nothing is listening on, taken and released so it is VERIFIED free. */
function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

const realFetch = globalThis.fetch;
let clock: FakeClock;
let deadPort: number;

beforeEach(() => {
  deadPort = freePort();
  clock = new FakeClock(0);
  setRecoveryClock(clock);
  startLogCapture();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  stopLogCapture();
  closeAllEpisodes();
  resetRecoveryClock();
});

function ollamaConfig(port: number): LocalProviderConfig {
  return {
    name: "ollama",
    baseUrl: `http://127.0.0.1:${port}`,
    apiPath: "/v1/chat/completions",
    envVar: "OLLAMA_API_KEY",
    prefixes: ["ollama"],
  };
}

/** Count the health probes the transport actually issues, per URL. */
function countProbes(): { urls: string[] } {
  const urls: string[] = [];
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/tags") || url.includes("/v1/models") || url.includes("/api/show")) {
      urls.push(url);
    }
    return realFetch(input as RequestInfo, init);
  }) as unknown as typeof fetch;
  globalThis.fetch = wrapped;
  return { urls };
}

const PAYLOAD = {
  model: "llama3.2",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

function contextFor(req: Request): { c: Context; captured: { status?: number; body?: any } } {
  const captured: { status?: number; body?: any } = {};
  const c = {
    req: {
      raw: req,
      header: (name?: string) => (name === undefined ? {} : (req.headers.get(name) ?? undefined)),
    },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) => {
      captured.body = body;
      captured.status = status;
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    },
  } as unknown as Context;
  return { c, captured };
}

// ───────────────────────────────────────────────────────────────────────────

describe("C-17 — a stopped local provider enters the ladder through refreshAuth", () => {
  test("a bare `new Error` from refreshAuth would NOT classify — the cause is what carries it", async () => {
    // The control that makes the rest of this file meaningful. Without
    // `{ cause }` the classifier returns null and everything downstream is a
    // no-op for ollama / lmstudio / vllm.
    const transport = new LocalTransport(ollamaConfig(deadPort), "llama3.2");
    let thrown: unknown;
    try {
      await transport.refreshAuth();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(classifyConnectionError(thrown)).not.toBeNull();
    expect(classifyConnectionError(thrown)?.kind).toBe("refused");
    // And the endpoint it carries is a PROBE url, not the inference one.
    //
    // DEVIATION FROM THE CRITERION'S LITERAL TEXT, recorded here rather than
    // hidden: C-17 assertion 4 says the lines must name `…/api/tags`. They name
    // `…/v1/models`, because `checkHealth()` tries `/api/tags` FIRST and then
    // falls back to `/v1/models`, overwriting `lastProbeUrl` each time — so the
    // endpoint reported is the LAST probe attempted rather than the first. That
    // is the more general behaviour (LM Studio and vLLM have no `/api/tags` at
    // all, so pinning the first would name a URL those providers never use) and
    // it satisfies what FR-5 actually requires: the right HOST, and a probe
    // path rather than the inference path. The assertion is written to the
    // requirement, not to the example.
    const endpoint = (thrown as { claudishEndpoint?: string }).claudishEndpoint ?? "";
    expect(endpoint).toMatch(/\/(api\/tags|v1\/models)$/);
    expect(endpoint).not.toContain("/v1/chat/completions");
    expect(endpoint).toContain(`127.0.0.1:${deadPort}`);
    // A bare rethrow — what the transport used to do — classifies as null.
    expect(classifyConnectionError(new Error((thrown as Error).message))).toBeNull();
  });

  test("the ladder RE-PROBES on every attempt and never reports a false `recovered`", async () => {
    const { urls } = countProbes();
    const transport = new LocalTransport(ollamaConfig(deadPort), "llama3.2");

    let first: unknown;
    try {
      await transport.refreshAuth();
    } catch (e) {
      first = e;
    }
    const probesAfterFirst = urls.length;
    expect(probesAfterFirst).toBeGreaterThan(0);

    const conn = classifyConnectionError(first);
    expect(conn).not.toBeNull();

    const result = await advanceUntilSettled(
      clock,
      withConnectionRetry(() => transport.refreshAuth(), first, {
        providerName: "ollama",
        providerDisplayName: "Ollama",
        resolveEndpoint: (err) =>
          (err as { claudishEndpoint?: string })?.claudishEndpoint ??
          `http://127.0.0.1:${deadPort}`,
        deadlineAt: 30_000, // two rungs is enough to see the latch
        signal: new AbortController().signal,
      }),
      120_000
    );

    // 1. The ladder ran.
    expect(result.kind).toBe("exhausted");
    expect(result.attempts).toBe(3);

    // 2. Each retried refreshAuth RE-PROBED. With the success-only latch
    //    reverted, this number does not move at all past the first call.
    expect(urls.length).toBeGreaterThan(probesAfterFirst);
    expect(urls.filter((u) => u.includes("/api/tags")).length).toBeGreaterThanOrEqual(3);

    // 3. No false recovery: the server never came back, so nothing may say it
    //    did — this is the assertion that fails when the latch is reverted.
    const lines = await capturedRecoveryLines();
    expect(lines.some((l) => l.includes("Ollama recovered after"))).toBe(false);
    expect(lines.some((l) => l.includes("closed: recovered"))).toBe(false);

    // 4. Exactly ONE episode across the whole recovery.
    const opened = lines.filter((l) => l.includes("opened for"));
    expect(opened.length).toBe(1);
    const ids = new Set(
      lines.map((l) => /episode ([0-9a-f-]{36})/.exec(l)?.[1]).filter(Boolean) as string[]
    );
    expect(ids.size).toBe(1);

    // 5. The lines name a PROBE endpoint, not the inference endpoint. See the
    //    recorded deviation in the first test for why it is `/v1/models`.
    expect(opened[0]).toMatch(/\/(api\/tags|v1\/models) /);
    expect(opened[0]).not.toContain("/v1/chat/completions");
  });

  test("a server that comes back MID-LADDER ends the episode with a real success", async () => {
    // Assertion 5 of C-17. It requires the health probe to actually run again,
    // which the reverted latch makes impossible: attempt 2 would resolve
    // instantly, and `fetchContextWindow()` — guarded by the same flag — would
    // never run at all.
    const { urls } = countProbes();
    const transport = new LocalTransport(ollamaConfig(deadPort), "llama3.2");

    let first: unknown;
    try {
      await transport.refreshAuth();
    } catch (e) {
      first = e;
    }

    let server: ReturnType<typeof Bun.serve> | null = null;
    let attempt = 0;
    const op = async () => {
      attempt++;
      // The user starts Ollama between the second and third attempt.
      if (attempt === 3 && !server) {
        server = Bun.serve({
          hostname: "127.0.0.1",
          port: deadPort,
          fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/api/tags") return Response.json({ models: [] });
            if (url.pathname === "/api/show")
              return Response.json({ model_info: { "llama.context_length": 131072 } });
            return new Response("not found", { status: 404 });
          },
        });
      }
      return transport.refreshAuth();
    };

    try {
      const result = await advanceUntilSettled(
        clock,
        withConnectionRetry(op, first, {
          providerName: "ollama",
          providerDisplayName: "Ollama",
          resolveEndpoint: (err) =>
            (err as { claudishEndpoint?: string })?.claudishEndpoint ??
            `http://127.0.0.1:${deadPort}`,
          deadlineAt: 270_000,
          signal: new AbortController().signal,
        }),
        400_000
      );

      expect(result.kind).toBe("ok");
      expect(attempt).toBe(3);
      // The recovered server ran fetchContextWindow — which the latch used to
      // make unreachable forever, leaving the provider on a stale window.
      expect(urls.some((u) => u.includes("/api/show"))).toBe(true);
      expect(transport.getContextWindow()).toBe(131072);

      const lines = await capturedRecoveryLines();
      // ONE episode, and it recovered exactly once. The two patterns are
      // deliberately distinct: `closed: recovered after …` ALSO contains the
      // substring "recovered after", so a loose match counts one recovery twice.
      expect(lines.filter((l) => l.includes("opened for")).length).toBe(1);
      expect(lines.filter((l) => l.includes("Ollama recovered after")).length).toBe(1);
      expect(lines.filter((l) => l.includes("closed: recovered")).length).toBe(1);
      expect(episodeCount()).toBe(0);
    } finally {
      (server as ReturnType<typeof Bun.serve> | null)?.stop(true);
    }
  });

  test("through the REAL ComposedHandler: a stopped local provider is held, not 401'd", async () => {
    const transport = new LocalTransport(ollamaConfig(deadPort), "llama3.2");
    const handler = new ComposedHandler(
      transport as unknown as ConstructorParameters<typeof ComposedHandler>[0],
      "llama3.2",
      "llama3.2",
      8080,
      {}
    );
    const ac = new AbortController();
    const req = new Request("http://127.0.0.1:8080/v1/messages", {
      method: "POST",
      signal: ac.signal,
    });
    const { c, captured } = contextFor(req);

    const p = handler.handle(c, PAYLOAD);
    await drain(40);

    // It is HELD — an episode is open — rather than answered 401 and walked
    // down the fallback chain onto metered billing.
    expect(episodeCount()).toBe(1);
    const opened = (await capturedRecoveryLines()).filter((l) => l.includes("opened for"));
    expect(opened.length).toBe(1);
    expect(opened[0]).toContain("Ollama");
    expect(opened[0]).toMatch(/\/(api\/tags|v1\/models) /);
    expect(opened[0]).not.toContain("/v1/chat/completions");

    ac.abort(new DOMException("client gone", "AbortError"));
    const response = await p;
    expect(response.status).toBe(499);
    expect(captured.status).not.toBe(401);
    expect(episodeCount()).toBe(0);
  });
});
