import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import {
  createRelayState,
  readRequestBody,
  forwardToUpstream,
  deepProbe,
  heartbeat,
  proberTick,
  relayHealthFields,
  redactUpstreamForLog,
  appendHop,
  hopsContainSelf,
  requestLoopedBack,
  FORWARD_HEADERS_TIMEOUT_MS,
  resolveForwardHeadersTimeoutMs,
  MIN_FORWARD_HEADERS_TIMEOUT_MS,
  MAX_FORWARD_HEADERS_TIMEOUT_MS,
  type RelayState,
} from "./relay.js";
import { getInstanceId } from "../../instance-id.js";
import {
  NOTICE_HEADER,
  noticeToHeaderValue,
} from "../../handlers/shared/failover-stream-notice.js";

// ── fetch mock ─────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let lastFetch: { url: string; init: any } | null = null;
// Every call of the current test, in order. `lastFetch` answers "what did the
// last request look like"; a retry (#636) needs "how many were sent" and "what
// did the FIRST one carry" — the two questions the fallback pins turn on.
let fetchCalls: { url: string; init: any }[] = [];
let fetchImpl: (url: any, init: any) => Promise<Response> = async () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  lastFetch = null;
  fetchCalls = [];
  globalThis.fetch = (async (url: any, init: any) => {
    lastFetch = { url: String(url), init };
    fetchCalls.push(lastFetch);
    return fetchImpl(url, init);
  }) as typeof fetch;
});

/** Body model of the Nth request sent in the current test. */
function callBodyModel(n: number): string {
  return JSON.parse(fetchCalls[n]!.init.body as string).model;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Minimal Hono Context stub for forwardToUpstream (needs req.raw.headers + body()). */
function mockForwardContext(inboundHeaders: Record<string, string> = {}): any {
  return {
    req: { raw: { headers: new Headers(inboundHeaders) } },
    // c.body(stream, init) → wrap it in a Response, as Hono does. Hono honors
    // init.headers (the passthrough's SSE header set); without this the stub
    // silently dropped every response header the code under test sets (#229).
    body: (stream: any, init?: any) =>
      new Response(stream, {
        status: 200,
        headers: init?.headers ?? { "content-type": "text/event-stream" },
      }),
  };
}

/** Minimal Context stub for readRequestBody (needs req.header/json/arrayBuffer). */
function mockReadContext(opts: {
  headers?: Record<string, string>;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
}): any {
  const headers = opts.headers ?? {};
  return {
    req: {
      header: (n: string) => headers[n.toLowerCase()],
      json: async () => opts.json,
      arrayBuffer: async () => opts.arrayBuffer,
    },
  };
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function sseResponse(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("createRelayState", () => {
  it("strips trailing slashes from upstream and applies defaults", () => {
    const s = createRelayState({ upstream: "http://192.168.0.46:3000//" });
    expect(s.upstream).toBe("http://192.168.0.46:3000");
    expect(s.compress).toBe(false);
    expect(s.alive).toBe(true);
    expect(s.consecutiveFail).toBe(0);
    expect(s.consecutiveOk).toBe(0);
  });

  it("honors compress + proxyKey", () => {
    const s = createRelayState({ upstream: "https://models.myia.io", compress: true, proxyKey: "k" });
    expect(s.compress).toBe(true);
    expect(s.proxyKey).toBe("k");
  });
});

describe("readRequestBody", () => {
  it("plain path → delegates to c.req.json() (zero-cost LAN path)", async () => {
    const c = mockReadContext({ json: { model: "glm-5.2", hi: 1 } });
    expect(await readRequestBody(c)).toEqual({ model: "glm-5.2", hi: 1 });
  });

  it("content-encoding: gzip + gzipped body → inflates and parses", async () => {
    const payload = { model: "glm-5.2", messages: [{ role: "user", content: "x" }] };
    const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"));
    const c = mockReadContext({
      headers: { "content-encoding": "gzip" },
      arrayBuffer: toArrayBuffer(gz),
    });
    expect(await readRequestBody(c)).toEqual(payload);
  });

  it("content-encoding: gzip but body already inflated (runtime pre-inflate) → magic-byte detect, no throw", async () => {
    const payload = { model: "glm-5.2" };
    const plain = Buffer.from(JSON.stringify(payload), "utf-8");
    const c = mockReadContext({
      headers: { "content-encoding": "gzip" },
      arrayBuffer: toArrayBuffer(plain),
    });
    expect(await readRequestBody(c)).toEqual(payload);
  });
});

describe("forwardToUpstream — header building", () => {
  it("preserves X-Claudish-Machine, injects x-proxy-key (not x-api-key), strips hop-by-hop", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const state = createRelayState({ upstream: "http://hub:3000", proxyKey: "cluster-key" });
    const c = mockForwardContext({
      "x-claudish-machine": "myia-po-2024",
      "content-length": "123",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      authorization: "Bearer client-oauth",
    });

    await forwardToUpstream(c, { model: "glm-5.2" }, state);

    expect(lastFetch?.url).toBe("http://hub:3000/v1/messages");
    const h = lastFetch!.init.headers as Record<string, string>;
    expect(h["x-claudish-machine"]).toBe("myia-po-2024"); // attribution survives the relay
    expect(h["x-proxy-key"]).toBe("cluster-key"); // cluster auth injected on the gate header
    expect(h["x-api-key"]).toBeUndefined(); // x-api-key MUST NOT carry the proxy key (would arm the hub native swap)
    expect(h["authorization"]).toBe("Bearer client-oauth"); // client OAuth PRESERVED for native passthrough
    expect(h["content-length"]).toBeUndefined(); // hop-by-hop stripped
    expect(h["connection"]).toBeUndefined();
    expect(h["transfer-encoding"]).toBeUndefined();
  });

  it("#686 — x-claudish-workspace survives the sidecar→hub hop verbatim (the hub composes from it)", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const state = createRelayState({ upstream: "http://hub:3000", proxyKey: "cluster-key" });
    const c = mockForwardContext({
      "x-claudish-machine": "myia-po-2025",
      "x-claudish-workspace": "claudish",
    });

    await forwardToUpstream(c, { model: "glm-5.2" }, state);

    const h = lastFetch!.init.headers as Record<string, string>;
    // Same survival class as X-Claudish-Machine (the copy loop preserves every
    // non-hop-by-hop header): the hub can only compose `x-claudish-client` from
    // parts that REACH it, so a sidecar client's workspace must arrive intact.
    expect(h["x-claudish-workspace"]).toBe("claudish");
    expect(h["x-claudish-machine"]).toBe("myia-po-2025");
    // The hop append owns exactly one header — it must not touch these.
    expect(String(h["x-claudish-hops"])).toContain(getInstanceId());
    expect(h["x-claudish-hops"]).not.toContain("claudish"); // workspace never rides the hop list
  });

  it("path-aware forward: an OpenAI request (/v1/chat/completions) reaches the hub's OpenAI ingress", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const state = createRelayState({ upstream: "http://hub:3000" });
    const c = mockForwardContext({ "x-claudish-machine": "myia-po-2024" });
    // Hono sets c.req.path; the mock only stubs req.raw.headers, so add it here.
    (c.req as any).path = "/v1/chat/completions";

    await forwardToUpstream(c, { model: "glm-5.2", messages: [] }, state);

    expect(lastFetch?.url).toBe("http://hub:3000/v1/chat/completions");
  });

  it("regression: ai-01 Opus passthrough — client x-proxy-key + OAuth both survive, stale x-api-key dropped", async () => {
    // The bug: the old relay did `delete authorization; x-api-key = proxyKey`, so a
    // relayed native (Opus) request triggered the hub's swap to a (non-existent)
    // stored Anthropic key → 401. The fix injects x-proxy-key and KEEPS auth.
    fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const state = createRelayState({ upstream: "http://hub:3000", proxyKey: "cluster-key" });
    // ai-01 sends its OAuth bearer + x-proxy-key (post client-side fix), and may
    // still carry a stale x-api-key from an older settings.json — the relay must
    // drop the latter so the hub doesn't swap on it.
    const c = mockForwardContext({
      "x-claudish-machine": "myia-ai-01",
      "x-proxy-key": "cluster-key",
      "x-api-key": "cluster-key",
      authorization: "Bearer sk-ant-oat-ai01-oauth",
    });

    await forwardToUpstream(c, { model: "claude-opus-4-8" }, state);

    const h = lastFetch!.init.headers as Record<string, string>;
    expect(h["x-claudish-machine"]).toBe("myia-ai-01");
    expect(h["x-proxy-key"]).toBe("cluster-key"); // gate passes on this (NativeHandler ignores it → no swap)
    expect(h["x-api-key"]).toBeUndefined(); // stale client x-api-key dropped so hub won't swap
    expect(h["authorization"]).toBe("Bearer sk-ant-oat-ai01-oauth"); // OAuth traverses → Anthropic passthrough
  });

  it("compress=true → gzips the body and sets content-encoding: gzip", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const state = createRelayState({ upstream: "https://models.myia.io", compress: true });
    const c = mockForwardContext({});

    await forwardToUpstream(c, { model: "glm-5.2", big: "x".repeat(1000) }, state);

    const h = lastFetch!.init.headers as Record<string, string>;
    expect(h["content-encoding"]).toBe("gzip");
    const bodyBytes = lastFetch!.init.body as Uint8Array;
    expect(bodyBytes[0]).toBe(0x1f); // gzip magic
    expect(bodyBytes[1]).toBe(0x8b);
  });

  it("compress=false → plain JSON string body, no content-encoding", async () => {
    fetchImpl = async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const state = createRelayState({ upstream: "http://hub:3000" });
    const c = mockForwardContext({});

    await forwardToUpstream(c, { model: "glm-5.2" }, state);

    const h = lastFetch!.init.headers as Record<string, string>;
    expect(h["content-encoding"]).toBeUndefined();
    expect(typeof lastFetch!.init.body).toBe("string");
  });
});

describe("forwardToUpstream — failover hysteresis (FAIL path)", () => {
  function deadState(): RelayState {
    return createRelayState({ upstream: "http://hub:3000" });
  }

  it("connection refused → returns null (fall through local) and increments fail count", async () => {
    fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const state = deadState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(r).toBeNull();
    expect(state.consecutiveFail).toBe(1);
    expect(state.alive).toBe(true); // 1 failure < threshold, still nominal
  });

  it("2 consecutive failures → alive flips to false (AUTONOMOUS)", async () => {
    fetchImpl = async () => {
      throw new Error("timeout");
    };
    const state = deadState();
    await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(state.consecutiveFail).toBe(2);
    expect(state.alive).toBe(false);
  });

  it("HTTP 500 from hub → null + counts as failure", async () => {
    fetchImpl = async () => new Response("upstream boom", { status: 500 });
    const state = deadState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(r).toBeNull();
    expect(state.consecutiveFail).toBe(1);
  });

  // ── #299 A: provider overload relayed by a live hub ────────────────────────
  // MiniMax answering 529 overloaded_error for the haiku nominal: two consecutive
  // 529s used to flip the relay AUTONOMOUS (markFail forward-http-529) and replay
  // each request against the SAME overloaded provider — a cron conversation
  // retried 12 times in 3 minutes, then dropped. The overload is the provider's,
  // not the hub's: the hub answered.
  const OVERLOAD_529_BODY = JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", code: "2064", message: "The server cluster is currently under high load" },
  });

  it("HTTP 529 is PASSED THROUGH (non-streaming request) — client gets 529 + body, no markFail, no local replay (#299 A)", async () => {
    fetchImpl = async () =>
      new Response(OVERLOAD_529_BODY, { status: 529, headers: { "content-type": "application/json" } });
    const state = deadState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m", stream: false }, state);
    expect(r).not.toBeNull(); // non-null ⇒ the caller forwards it; null is the local-replay fallthrough
    expect(r!.status).toBe(529);
    expect(await r!.text()).toBe(OVERLOAD_529_BODY);
    expect(state.consecutiveFail).toBe(0);
  });

  it("HTTP 529 is PASSED THROUGH (streaming request) and two consecutive 529s keep the relay NOMINAL (#299 A)", async () => {
    fetchImpl = async () =>
      new Response(OVERLOAD_529_BODY, { status: 529, headers: { "content-type": "application/json" } });
    const state = deadState();
    const r1 = await forwardToUpstream(mockForwardContext({}), { model: "m", stream: true }, state);
    const r2 = await forwardToUpstream(mockForwardContext({}), { model: "m", stream: true }, state);
    for (const r of [r1, r2]) {
      expect(r).not.toBeNull();
      expect(r!.status).toBe(529);
      expect(await r!.text()).toBe(OVERLOAD_529_BODY);
    }
    expect(state.consecutiveFail).toBe(0); // a 529 never fed the hysteresis
    expect(state.alive).toBe(true); // still NOMINAL after two consecutive 529s
  });

  it("a 529 RESETS an existing failure streak (the hub answered — that is liveness evidence)", async () => {
    fetchImpl = async () =>
      new Response(OVERLOAD_529_BODY, { status: 529, headers: { "content-type": "application/json" } });
    const state = deadState();
    state.consecutiveFail = 1; // one prior genuine failure
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(r).not.toBeNull();
    expect(state.consecutiveFail).toBe(0);
  });

  // ── #317 pin 6: the session budget ceiling's 429 crosses the relay intact ───
  // The hub's per-session output-token ceiling answers locally with a labeled
  // 429 + retry-after = the real remaining window. A 429 is not a 5xx: it must
  // never feed the AUTONOMOUS hysteresis (the hub is alive and answering), and
  // Claude Code honors the relayed Retry-After instead of hammering. The body
  // is the byte-shape sessionBudgetRefusalAnthropic() produces.
  const SESSION_CEILING_429_BODY = JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message:
        "[SessionBudgetCeiling] session …7855949f consumed 5000000 output tokens in a 24h sliding window (ceiling 5000000) — retry after 78300s",
    },
  });

  it("a session-ceiling 429 is PASSED THROUGH with its retry-after — no markFail, no local replay, relay stays NOMINAL (#317 pin 6)", async () => {
    fetchImpl = async () =>
      new Response(SESSION_CEILING_429_BODY, {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "78300" },
      });
    const state = deadState();
    state.consecutiveFail = 1; // a prior genuine failure must NOT be compounded by the 429
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m", stream: false }, state);
    expect(r).not.toBeNull(); // forwarded to the client, never locally replayed
    expect(r!.status).toBe(429);
    expect(await r!.text()).toBe(SESSION_CEILING_429_BODY);
    expect(r!.headers.get("retry-after")).toBe("78300"); // the window remainder reaches the client
    expect(state.consecutiveFail).toBe(0); // a 429 is liveness evidence, same as the 529 reset
    expect(state.alive).toBe(true); // still NOMINAL
  });

  // ── #318: the hub's own drain admission freeze, marked ─────────────────────
  // The #306 freeze answers new admissions with 503 + Retry-After while the hub
  // is about to restart. A relay used to read that as a hub failure (markFail +
  // local replay), fighting the drain it exists to survive. The marker header
  // is the discriminator: an UNMARKED 503 keeps the fallthrough (a hub's own
  // death is still a real 503), and only the hub writes the marker — real
  // provider overloads emit an Anthropic-shaped overloaded_error body too, so
  // the body alone could never tell them apart.
  const DRAIN_FREEZE_503_BODY = JSON.stringify({
    type: "error",
    error: {
      type: "overloaded_error",
      message: "Proxy is draining for a restart (admission freeze). Retry shortly — in-flight streams are unaffected.",
    },
  });
  const DRAIN_FREEZE_503_HEADERS = {
    "content-type": "application/json",
    "retry-after": "15",
    "x-claudish-drain-freeze": "1",
  };

  it("a MARKED 503 is PASSED THROUGH — client gets 503 + body + Retry-After, no markFail, no local replay (#318)", async () => {
    fetchImpl = async () => new Response(DRAIN_FREEZE_503_BODY, { status: 503, headers: DRAIN_FREEZE_503_HEADERS });
    const state = deadState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m", stream: false }, state);
    expect(r).not.toBeNull(); // non-null ⇒ forwarded to the client; null is the local-replay fallthrough
    expect(r!.status).toBe(503);
    expect(await r!.text()).toBe(DRAIN_FREEZE_503_BODY);
    // The freeze's contract with the client survives the rebuild — it used to
    // be dropped for every relayed non-streaming error.
    expect(r!.headers.get("retry-after")).toBe("15");
    // #318 review — the MARKER survives the hop too: in a chain A→B→hub, this
    // response is what relay A receives, and A is itself a relay. Without the
    // marker here, A reads a plain 503 and replays locally — exactly what
    // #318 removes — so the property has to compose across hops (#279's
    // x-claudish-hops exists because A→B chains are a supported topology).
    expect(r!.headers.get("x-claudish-drain-freeze")).toBe("1");
    expect(state.consecutiveFail).toBe(0);
  });

  it("a MARKED 503 passes through for a STREAMING request too, and two keep the relay NOMINAL (#318)", async () => {
    fetchImpl = async () => new Response(DRAIN_FREEZE_503_BODY, { status: 503, headers: DRAIN_FREEZE_503_HEADERS });
    const state = deadState();
    const r1 = await forwardToUpstream(mockForwardContext({}), { model: "m", stream: true }, state);
    const r2 = await forwardToUpstream(mockForwardContext({}), { model: "m", stream: true }, state);
    for (const r of [r1, r2]) {
      expect(r).not.toBeNull();
      expect(r!.status).toBe(503);
      expect(await r!.text()).toBe(DRAIN_FREEZE_503_BODY);
    }
    expect(state.consecutiveFail).toBe(0); // a drain freeze never fed the hysteresis
    expect(state.alive).toBe(true); // still NOMINAL after two consecutive freezes
  });

  it("an UNMARKED 503 keeps the fallthrough — a hub's own failure is NOT passed through (#318 control)", async () => {
    fetchImpl = async () =>
      new Response("hub boom", { status: 503, headers: { "content-type": "application/json" } });
    const state = deadState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m", stream: false }, state);
    expect(r).toBeNull(); // still the local-replay fallthrough
    expect(state.consecutiveFail).toBe(1); // still a markFail
  });

  it("success resets the failure streak", async () => {
    const state = deadState();
    state.consecutiveFail = 1; // one prior failure
    fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(r).not.toBeNull();
    expect(state.consecutiveFail).toBe(0);
  });

  it("4xx is passed through (not retried) as a real client error", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const state = deadState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(400);
    expect(state.consecutiveFail).toBe(0); // 4xx is not a hub-health failure
  });
});

describe("forwardToUpstream — connect retry (#80 part 2)", () => {
  // The container → host.docker.internal tunnel resets chronically (~1 per 8 min
  // measured over 12 h, 87 failures, hub answering /health in 4 ms throughout).
  // A connect failure is fast, so one retry absorbs the blip — and an absorbed
  // blip feeds neither the hysteresis nor the local-cascade diversion.
  function freshState(): RelayState {
    return createRelayState({ upstream: "http://hub:3000" });
  }

  it("a connect failure is retried once; success on retry forwards and does NOT markFail", async () => {
    let calls = 0;
    fetchImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("The socket connection was closed unexpectedly.");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const state = freshState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(calls).toBe(2);
    expect(r).not.toBeNull();
    expect(state.consecutiveFail).toBe(0); // absorbed: no hysteresis food
    expect(state.alive).toBe(true);
  });

  it("both attempts fail → falls through to local and marks ONE failure (not two)", async () => {
    let calls = 0;
    fetchImpl = async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    };
    const state = freshState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(calls).toBe(2);
    expect(r).toBeNull();
    expect(state.consecutiveFail).toBe(1); // per-request, not per-attempt
  });

  it("a header deadline is NOT retried — one attempt only (retrying would double the stall)", async () => {
    let calls = 0;
    fetchImpl = async (_url: any, init: any) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
      });
    };
    const state = freshState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state, 50);
    expect(calls).toBe(1);
    expect(r).toBeNull();
    expect(state.consecutiveFail).toBe(0); // a deadline is not liveness evidence (existing rule)
  });

  it("an HTTP 500 is NOT retried — the hub answered, hysteresis owns it", async () => {
    let calls = 0;
    fetchImpl = async () => {
      calls++;
      return new Response("boom", { status: 500 });
    };
    const state = freshState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(calls).toBe(1);
    expect(r).toBeNull();
    expect(state.consecutiveFail).toBe(1);
  });
});

describe("forwardToUpstream — a header deadline is not liveness evidence", () => {
  // The bound documents itself as "NOT a liveness detector — the heartbeat prober
  // owns that", yet its abort used to call markFail. So a slow PROVIDER drove the
  // HUB's state machine. On ai-01 (2026-08-24) that produced 23 header-deadline
  // fallthroughs in 24h — 21 of them one failure short of the threshold — and one
  // spurious 3m06s machine-wide AUTONOMOUS episode with the hub healthy throughout.
  function freshState(): RelayState {
    return createRelayState({ upstream: "http://hub:3000" });
  }

  /** A fetch that outlives the deadline, so the AbortController is what rejects. */
  const neverAnswers = async (_url: any, init: any) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
    });

  it("still falls through to local, so the request is served", async () => {
    fetchImpl = neverAnswers;
    const state = freshState();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state, 20);
    expect(r).toBeNull();
  });

  it("does not count against the hub", async () => {
    fetchImpl = neverAnswers;
    const state = freshState();
    await forwardToUpstream(mockForwardContext({}), { model: "m" }, state, 20);
    expect(state.consecutiveFail).toBe(0);
  });

  it("two in a row do not flip the machine to AUTONOMOUS", async () => {
    fetchImpl = neverAnswers;
    const state = freshState();
    await forwardToUpstream(mockForwardContext({}), { model: "m" }, state, 20);
    await forwardToUpstream(mockForwardContext({}), { model: "m" }, state, 20);
    expect(state.alive).toBe(true);
  });

  it("does not erase progress toward recovery", async () => {
    fetchImpl = neverAnswers;
    const state = freshState();
    state.consecutiveOk = 2; // two good heartbeats banked; recovery needs three
    await forwardToUpstream(mockForwardContext({}), { model: "m" }, state, 20);
    expect(state.consecutiveOk).toBe(2);
  });

  it("a genuinely refused connection still marks the hub down", async () => {
    // The other half of the split: this one IS liveness evidence and must keep
    // driving the hysteresis exactly as before.
    fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const state = freshState();
    await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    expect(state.consecutiveFail).toBe(2);
    expect(state.alive).toBe(false);
  });
});

describe("FORWARD_HEADERS_TIMEOUT_MS — must sit above real hub header latency", () => {
  it("covers the hub's full header-phase contract, not just ordinary first-byte latency (#320)", () => {
    // Two measurements set this pin, a decade apart in traffic shape:
    // 1. Ordinary traffic (ai-01 → models.myia.io, 2026-08-10): first byte at
    //    2.5/3.1/3.4/8.3s — why the old 5s bound was a bug (routine latency
    //    silently demoted requests to the local pipeline; liveness is the
    //    prober's job, not this bound's).
    // 2. GLM bursts (2026-10-03/04, #320 AC1): the hub LEGITIMATELY holds
    //    headers 35-92s in salves (queue to 221s), and its documented overload
    //    contract is transport 60s + patient backoff ~305s ≈ 6 min. A relay
    //    budget inside that contract amputates waits the hub is faithfully
    //    holding — the 30s value did exactly that.
    // The pin is the hub's own first-event watchdog (CLAUDISH_FIRST_EVENT_TIMEOUT_MS,
    // 300s default): cutting before it means the relay aborts waits the hub itself
    // has not yet given up on.
    expect(FORWARD_HEADERS_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it("stays under the client's documented 10-min timeout", () => {
    // Past the client's own timeout the bound protects no one: the client has
    // abandoned the turn while the local replay never happens. MAX pins the ceiling.
    expect(FORWARD_HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
  });
});

/** A fetch that accepts the POST and never sends headers — only an abort ends it.
 * Models the #320 AC4 shape: a live connection, a hub that said nothing. */
function muteFetchImpl(): (url: any, init: any) => Promise<Response> {
  return (_url: any, init: any) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("The operation was aborted");
        (e as any).name = "AbortError";
        rej(e);
      });
    });
}

describe("#320 CLAUDISH_RELAY_HEADER_TIMEOUT_MS — configurable, empty-safe, bounded", () => {
  const KEY = "CLAUDISH_RELAY_HEADER_TIMEOUT_MS";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("unset yields the default", () => {
    delete process.env[KEY];
    expect(resolveForwardHeadersTimeoutMs()).toBe(FORWARD_HEADERS_TIMEOUT_MS);
  });

  it('"" yields the default — the Number("") === 0 trap (#310 review)', () => {
    // Compose injects every listed name as "" by default. A naive
    // `raw ?? FORWARD_HEADERS_TIMEOUT_MS` passes "" through (not nullish),
    // Number("") === 0, and an unclamped read returns 0 — an instant-timeout
    // relay on every unconfigured container. This test is the AC2 pin: on that
    // mutated shape (guard dropped AND range clamp dropped) it goes red; the
    // range clamp below additionally pins "0" itself as out of range.
    process.env[KEY] = "";
    expect(resolveForwardHeadersTimeoutMs()).toBe(FORWARD_HEADERS_TIMEOUT_MS);
  });

  it('"0" yields the default — there is no "off": an unbounded header wait is the never-hang violation the bound exists to prevent', () => {
    process.env[KEY] = "0";
    expect(resolveForwardHeadersTimeoutMs()).toBe(FORWARD_HEADERS_TIMEOUT_MS);
  });

  it("garbage yields the default, never NaN", () => {
    process.env[KEY] = "360s"; // plausible hand-edit typo
    expect(resolveForwardHeadersTimeoutMs()).toBe(FORWARD_HEADERS_TIMEOUT_MS);
  });

  it("out-of-range values yield the default (below MIN re-creates the 5s bug class; above MAX outlives the client)", () => {
    process.env[KEY] = String(MIN_FORWARD_HEADERS_TIMEOUT_MS - 1);
    expect(resolveForwardHeadersTimeoutMs()).toBe(FORWARD_HEADERS_TIMEOUT_MS);
    process.env[KEY] = String(MAX_FORWARD_HEADERS_TIMEOUT_MS + 1);
    expect(resolveForwardHeadersTimeoutMs()).toBe(FORWARD_HEADERS_TIMEOUT_MS);
  });

  it("in-range values are honored, floored, boundaries inclusive", () => {
    process.env[KEY] = "45000";
    expect(resolveForwardHeadersTimeoutMs()).toBe(45_000);
    process.env[KEY] = "6000.9";
    expect(resolveForwardHeadersTimeoutMs()).toBe(6_000);
    process.env[KEY] = String(MIN_FORWARD_HEADERS_TIMEOUT_MS);
    expect(resolveForwardHeadersTimeoutMs()).toBe(MIN_FORWARD_HEADERS_TIMEOUT_MS);
    process.env[KEY] = String(MAX_FORWARD_HEADERS_TIMEOUT_MS);
    expect(resolveForwardHeadersTimeoutMs()).toBe(MAX_FORWARD_HEADERS_TIMEOUT_MS);
  });

  it("forwardToUpstream reads the env budget when no explicit one is passed (production wiring)", async () => {
    // The route calls forwardToUpstream WITHOUT a budget — the env must reach the
    // header phase through the parameter default. The env value here is MIN
    // (5000ms) because the resolver clamps anything shorter to the default — an
    // important property in itself (a sub-5s budget re-creates the 2026-08-10 bug
    // class), but one that makes this wiring proof a 5s wait. If the env were not
    // wired through the parameter default, this would wait the full 360s default
    // and time out red.
    process.env[KEY] = String(MIN_FORWARD_HEADERS_TIMEOUT_MS);
    fetchImpl = muteFetchImpl();
    const state = createRelayState({ upstream: "http://hub:3000" });
    const t0 = Date.now();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state);
    const dt = Date.now() - t0;
    expect(r).toBeNull();
    expect(dt).toBeGreaterThanOrEqual(4_000); // it was the TIMER that fired, not a fast error
    expect(dt).toBeLessThan(10_000); // ...and it was MIN's timer, not the 360s default
    // A header deadline is liveness-neutral (prober owns liveness): no markFail.
    expect(state.consecutiveFail).toBe(0);
  }, 15_000);

  it("a mute upstream behind a live hub still ends the client turn within the budget — never-hang (#320 AC4)", async () => {
    // The bound is a BACKSTOP (the hub's own /health stall detector owns the wedge
    // verdict), but it must still bound: a black-holed connection can hang a request
    // forever without it. Mutation pin: remove the bound (never arm the abort) and
    // the await below never settles — this test times out red.
    fetchImpl = muteFetchImpl();
    const state = createRelayState({ upstream: "http://hub:3000" });
    const t0 = Date.now();
    const r = await forwardToUpstream(mockForwardContext({}), { model: "m" }, state, 80);
    expect(r).toBeNull(); // fell through to local — the turn continues, bounded
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("the NOMINAL→AUTONOMOUS flip releases in-flight header waits with their own label (#323 B1)", async () => {
    // /health probes fail fast (the prober's evidence); /v1/messages stays mute,
    // so the forward sits in the header phase when the flip lands. At a 360s
    // budget the flip (~200s in production) is the FIRST thing that knows those
    // waits are dead — without the abort, every forward dispatched inside the
    // detection window sits out the full budget (review B1). Mutation pin: drop
    // the abort loop in markFail and this test times out red (60s budget never
    // fires inside the 20s window).
    fetchImpl = (url: any, init: any) => {
      if (String(url).endsWith("/health")) throw new Error("probe refused");
      return muteFetchImpl()(url, init);
    };
    const state = createRelayState({ upstream: "http://hub:3000" });
    const consoleLines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      consoleLines.push(a.join(" "));
    };
    try {
      const t0 = Date.now();
      const pending = forwardToUpstream(
        mockForwardContext({}),
        { model: "m" },
        state,
        60_000
      );
      await new Promise((r) => setTimeout(r, 30)); // reach the header wait
      await proberTick(state); // heartbeat failure #1
      await proberTick(state); // #2 → flip → the waiter is released
      const r = await pending;
      const dt = Date.now() - t0;
      expect(r).toBeNull();
      expect(dt).toBeLessThan(5_000); // released at the flip (~30ms), not the 60s budget
      expect(state.alive).toBe(false);
      // The two prober failures set consecutiveFail=2; the abort itself must not
      // count as a third failure — the flip already spoke, it is not new evidence.
      expect(state.consecutiveFail).toBe(2);
      // Distinct label: not "header-timeout" (that reads as latency) and not
      // "connect:" (that reads as transport and would feed the hysteresis).
      expect(consoleLines.some((l) => l.includes("aborted-on-autonomous"))).toBe(true);
      expect(consoleLines.some((l) => l.includes("header-timeout after"))).toBe(false);
    } finally {
      console.log = origLog;
    }
  }, 20_000);

  it("a re-forward draws on the turn's ONE header deadline, not a fresh budget (#323 B2)", async () => {
    // Original forward: headers arrive instantly, the body dies pre-visible
    // (#170's trigger). The re-forward target is mute — only its abort ends it.
    // With the turn-wide 600ms deadline: ladder delay 400ms + ~200ms remaining
    // budget ≈ 600ms total. A fresh per-leg budget (the mutation) adds the full
    // 600ms at the re-forward → ~1000ms; the pin sits between at 800ms.
    let calls = 0;
    fetchImpl = (_url: any, init: any) => {
      calls++;
      if (calls === 1) return Promise.resolve(sseDyingResponse());
      return muteFetchImpl()(_url, init);
    };
    const state = createRelayState({ upstream: "http://hub:3000" });
    const t0 = Date.now();
    const out = await drainResponse(
      await forwardToUpstream(mockForwardContext({}), { model: "m" }, state, 600)
    );
    const dt = Date.now() - t0;
    expect(calls).toBeGreaterThanOrEqual(2); // the death did trigger a re-forward
    expect(out).toContain("message_stop"); // finalized with the original death, not hung
    expect(dt).toBeLessThan(800); // the ONE deadline bounded the whole turn's header legs
  }, 20_000);
});

describe("forwardToUpstream — streaming (never-hang delegation)", () => {
  it("SSE response is routed through the passthrough and terminates", async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    fetchImpl = async () => sseResponse(sse);
    const state = createRelayState({ upstream: "http://hub:3000" });
    const r = await forwardToUpstream(mockForwardContext({}), { model: "glm-5.2" }, state);
    expect(r).not.toBeNull();
    expect(r!.headers.get("content-type")).toContain("text/event-stream");
    // Drain the piped stream to completion — must include a terminal message_stop
    // (never-hang: the passthrough always emits one) and not hang.
    const out = await r!.text();
    expect(out).toContain("message_stop");
    expect(state.consecutiveFail).toBe(0);
  });
});

describe("forwardToUpstream — header timeout must NOT truncate the body (regression)", () => {
  // Regression guard for the AbortSignal.timeout() trap: the forward fetch must
  // bound ONLY the header-fetch phase, never the body stream. A prior version used
  // signal: AbortSignal.timeout(5000), which keeps firing after headers arrive and
  // aborts the streaming body mid-flight — truncating EVERY real response at ~5s.
  // The fix clears the header timer the instant fetch() resolves. Here the header
  // timeout is a tiny 120ms and the terminal message_stop is emitted only at ~300ms
  // (well after it): with the bug the abort fires, the body errors, and "late" +
  // message_stop are lost; fixed, the full stream arrives.
  it("delivers content emitted after headerTimeoutMs (timer cleared once headers arrive)", async () => {
    const encoder = new TextEncoder();
    fetchImpl = async (_url: any, init: any) => {
      const signal: AbortSignal | undefined = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n' +
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"early"}}\n\n'
            )
          );
          // Real fetch errors the body stream when its signal fires — model that so
          // the buggy AbortSignal.timeout path would actually truncate here.
          if (signal) {
            signal.addEventListener("abort", () => {
              try {
                controller.error(new Error("aborted"));
              } catch {}
            });
          }
          setTimeout(() => {
            try {
              controller.enqueue(
                encoder.encode(
                  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"late"}}\n\n' +
                    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
                    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
                    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
                )
              );
              controller.close();
            } catch {}
          }, 300);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const state = createRelayState({ upstream: "http://hub:3000" });
    // 120ms header timeout << 300ms body tail: proves the body is unbounded by it.
    const r = await forwardToUpstream(mockForwardContext({}), { model: "glm-5.2" }, state, 120);
    expect(r).not.toBeNull();
    const out = await r!.text();
    expect(out).toContain("early");
    expect(out).toContain("late"); // emitted AFTER the header timeout → not truncated
    expect(out).toContain("message_stop");
  });
});

// ── deep probe: a quota wall is liveness, not death ────────────────
//
// The recovery gate asks the hub for one specific model. When that model's plan
// is spent the hub answers 429/402 — which it can only do by being alive. Reading
// that as "hub down" pins the sidecar in AUTONOMOUS, where it serves the SAME
// walled model locally and usually without a failover cascade. These pin both
// halves: the wall must open the gate, and the narrowness that keeps a burst,
// a bad key and a bad model id OUT of that verdict must survive.
describe("deep probe: quota wall vs hub death", () => {
  const state = () => createRelayState({ upstream: "http://hub:3000", proxyKey: "k" });

  it("treats a 429 naming a quota wall as proof the hub is alive", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: { message: "Your weekly quota for this plan has been exhausted." },
        }),
        { status: 429 }
      );
    expect(await deepProbe(state())).toBe(true);
  });

  it("treats 402 Payment Required as liveness too", async () => {
    fetchImpl = async () => new Response("insufficient balance", { status: 402 });
    expect(await deepProbe(state())).toBe(true);
  });

  it("does NOT treat a plain per-minute 429 burst as liveness", async () => {
    // No quota/plan wording: the hub may be flapping under load, and OK_THRESHOLD
    // exists precisely to keep waiting in that case.
    fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "rate limit: 10 requests per minute" } }), {
        status: 429,
      });
    expect(await deepProbe(state())).toBe(false);
  });

  it("never launders a 401 into a health verdict, whatever the body says", async () => {
    // A bad proxy key is a wiring mistake. Returning to NOMINAL on it would relay
    // every request into a 401 wall instead of serving them locally.
    fetchImpl = async () => new Response("quota exhausted, weekly plan limit", { status: 401 });
    expect(await deepProbe(state())).toBe(false);
  });

  it("still requires a terminal message_stop on a 200", async () => {
    fetchImpl = async () =>
      sseResponse(
        'event: message_start\ndata: {"type":"message_start"}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      );
    expect(await deepProbe(state())).toBe(true);

    fetchImpl = async () =>
      sseResponse('event: message_start\ndata: {"type":"message_start"}\n\n');
    expect(await deepProbe(state())).toBe(false); // truncated stream is not recovery
  });

  it("sends the proxy key, not an api key (x-api-key arms the hub native swap)", async () => {
    fetchImpl = async () => new Response("nope", { status: 500 });
    await deepProbe(state());
    expect(lastFetch!.url).toBe("http://hub:3000/v1/messages");
    expect(lastFetch!.init.headers["x-proxy-key"]).toBe("k");
    expect(lastFetch!.init.headers["x-api-key"]).toBeUndefined();
  });

  // #345: the probe is claudish's OWN traffic and must not arrive header-less —
  // it read as a phantom attribution lane until verify-machine-header.py learned
  // to separate it by shape.
  it("identifies itself with X-Claudish-Machine when CLAUDISH_MACHINE is set (#345)", async () => {
    const prev = process.env.CLAUDISH_MACHINE;
    try {
      process.env.CLAUDISH_MACHINE = "myia-po-2023";
      fetchImpl = async () => new Response("nope", { status: 500 });
      await deepProbe(state());
      expect(lastFetch!.init.headers["X-Claudish-Machine"]).toBe("myia-po-2023");
    } finally {
      if (prev === undefined) delete process.env.CLAUDISH_MACHINE;
      else process.env.CLAUDISH_MACHINE = prev;
    }
  });

  // #298 b1: the success line is the only evidence that names WHERE recovery
  // was measured (a direct upstream fetch, never the local cascade). Without
  // it, "probe ran, silently" and "recovery without a probe" read identical —
  // the false reading retracted on 06/10. One line per probe, success side
  // only; failures keep their existing per-reason lines.
  it("emits exactly one OK line on a SUCCESSFUL probe (#298 b1)", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.join(" "));
    };
    try {
      fetchImpl = async () =>
        sseResponse(
          'event: message_start\ndata: {"type":"message_start"}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        );
      expect(await deepProbe(state())).toBe(true);
    } finally {
      console.log = origLog;
    }
    const ok = lines.filter((l) => l.includes("[Relay] deep probe OK — message_stop after"));
    expect(ok.length).toBe(1);
  });

  it("emits NO OK line on a failed probe — the failure line speaks (#298 b1)", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.join(" "));
    };
    try {
      fetchImpl = async () => new Response("nope", { status: 500 });
      expect(await deepProbe(state())).toBe(false);
    } finally {
      console.log = origLog;
    }
    expect(lines.some((l) => l.includes("deep probe OK"))).toBe(false);
    expect(lines.some((l) => l.includes("deep probe failed"))).toBe(true);
  });

  it("sends NO machine header when CLAUDISH_MACHINE is unset or empty (#345)", async () => {
    const prev = process.env.CLAUDISH_MACHINE;
    try {
      // compose injects every listed name as at least "", and "" is NOT nullish
      // (#310) — an unset/empty name must yield NO header, never a `X-Claudish-
      // Machine: ` that the hub would file as a nameless machine.
      delete process.env.CLAUDISH_MACHINE;
      fetchImpl = async () => new Response("nope", { status: 500 });
      await deepProbe(state());
      expect(lastFetch!.init.headers["X-Claudish-Machine"]).toBeUndefined();

      process.env.CLAUDISH_MACHINE = "";
      await deepProbe(state());
      expect(lastFetch!.init.headers["X-Claudish-Machine"]).toBeUndefined();

      process.env.CLAUDISH_MACHINE = "   ";
      await deepProbe(state());
      expect(lastFetch!.init.headers["X-Claudish-Machine"]).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDISH_MACHINE;
      else process.env.CLAUDISH_MACHINE = prev;
    }
  });

  // #613: the probe must measure the HUB's servability, not one provider's. A
  // concrete z.ai model gates recovery on z.ai — a z.ai-only outage with a
  // healthy hub keeps every sidecar AUTONOMOUS while the hub serves fine.
  describe("probe model (#613)", () => {
    // The FIRST request: since #636 a failed first attempt is retried on the
    // fallback model in the same tick, so `lastFetch` would answer for the
    // retry, not for the nominal attempt these pins are about.
    const bodyModel = (): string => callBodyModel(0);

    it("asks for a role-shaped id, not the z.ai sonnet nominal", async () => {
      fetchImpl = async () => new Response("nope", { status: 500 });
      await deepProbe(state());
      // RED on the pre-#613 code: the body carried the literal "glm-5.3", which
      // the hub resolves on the SONNET role — one provider deciding recovery.
      expect(bodyModel()).toBe("claude-haiku-4-5-20251001");
      expect(bodyModel()).not.toBe("glm-5.3");
    });

    it("honors CLAUDISH_RELAY_PROBE_MODEL, read per call", async () => {
      const prev = process.env.CLAUDISH_RELAY_PROBE_MODEL;
      try {
        process.env.CLAUDISH_RELAY_PROBE_MODEL = "glm-5.3"; // exact pre-#613 behavior
        fetchImpl = async () => new Response("nope", { status: 500 });
        await deepProbe(state());
        expect(bodyModel()).toBe("glm-5.3");

        process.env.CLAUDISH_RELAY_PROBE_MODEL = "swift-1.5-27b";
        fetchCalls = []; // the next deepProbe's first request, not this test's first
        await deepProbe(state());
        expect(bodyModel()).toBe("swift-1.5-27b");
      } finally {
        if (prev === undefined) delete process.env.CLAUDISH_RELAY_PROBE_MODEL;
        else process.env.CLAUDISH_RELAY_PROBE_MODEL = prev;
      }
    });

    it("treats empty and whitespace as unset", async () => {
      const prev = process.env.CLAUDISH_RELAY_PROBE_MODEL;
      try {
        // compose injects every listed name as at least "" (#310) — empty is not
        // a model name, it must not reach the hub as one.
        process.env.CLAUDISH_RELAY_PROBE_MODEL = "   ";
        fetchImpl = async () => new Response("nope", { status: 500 });
        await deepProbe(state());
        expect(bodyModel()).toBe("claude-haiku-4-5-20251001");
      } finally {
        if (prev === undefined) delete process.env.CLAUDISH_RELAY_PROBE_MODEL;
        else process.env.CLAUDISH_RELAY_PROBE_MODEL = prev;
      }
    });

    it("stays a DEEP probe: a tool call and a stream are still requested", async () => {
      fetchImpl = async () => new Response("nope", { status: 500 });
      await deepProbe(state());
      const b = JSON.parse(lastFetch!.init.body as string);
      // The anti-flap design is not in question here — only the model is (#613).
      expect(b.stream).toBe(true);
      expect(Array.isArray(b.tools)).toBe(true);
      expect(b.tools.length).toBeGreaterThan(0);
    });
  });

  // #636 review (option B): the probe sends NO `authorization` by design, so on
  // a hub WITHOUT a modelMap the haiku-shaped id stays NATIVE and attempt 1
  // collects a 503 refusal or a 401 — neither of which says the hub is down.
  // Read as death it pins the sidecar AUTONOMOUS for good after its next cut.
  // One retry, same tick, on a model the hub resolves on the SONNET role.
  describe("fallback attempt in the same tick (#636)", () => {
    const okStream = () =>
      sseResponse(
        'event: message_start\ndata: {"type":"message_start"}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      );
    /** Answer attempt 1 with `first`, attempt 2 (if any) with `second`. */
    const sequence = (first: () => Response, second: () => Response) => {
      let n = 0;
      fetchImpl = async () => (n++ === 0 ? first() : second());
    };

    it("retries a 503 on glm-5.3 in the same tick and reports true", async () => {
      sequence(
        () => new Response("native lane refused", { status: 503 }),
        () => okStream()
      );
      expect(await deepProbe(state())).toBe(true);
      expect(fetchCalls.length).toBe(2);
      expect(callBodyModel(0)).toBe("claude-haiku-4-5-20251001");
      expect(callBodyModel(1)).toBe("glm-5.3");
    });

    it("retries a 401 the same way — the native shape that motivated the review", async () => {
      sequence(
        () => new Response("invalid api key", { status: 401 }),
        () => okStream()
      );
      expect(await deepProbe(state())).toBe(true);
      expect(fetchCalls.length).toBe(2);
      expect(callBodyModel(1)).toBe("glm-5.3");
    });

    it("sends exactly TWO requests when both attempts fail — never a third", async () => {
      sequence(
        () => new Response("down", { status: 503 }),
        () => new Response("down", { status: 503 })
      );
      expect(await deepProbe(state())).toBe(false);
      expect(fetchCalls.length).toBe(2);
    });

    it("spends NO fallback when the nominal attempt passes", async () => {
      fetchImpl = async () => okStream();
      expect(await deepProbe(state())).toBe(true);
      expect(fetchCalls.length).toBe(1);
    });

    it("spends NO fallback on a quota wall — that is liveness on the first answer", async () => {
      fetchImpl = async () => new Response("weekly plan quota exhausted", { status: 429 });
      expect(await deepProbe(state())).toBe(true);
      expect(fetchCalls.length).toBe(1);
    });

    it("honors CLAUDISH_RELAY_PROBE_FALLBACK_MODEL, read per call", async () => {
      const prev = process.env.CLAUDISH_RELAY_PROBE_FALLBACK_MODEL;
      try {
        process.env.CLAUDISH_RELAY_PROBE_FALLBACK_MODEL = "mmc@MiniMax-M3";
        sequence(
          () => new Response("down", { status: 503 }),
          () => okStream()
        );
        expect(await deepProbe(state())).toBe(true);
        expect(callBodyModel(1)).toBe("mmc@MiniMax-M3");
      } finally {
        if (prev === undefined) delete process.env.CLAUDISH_RELAY_PROBE_FALLBACK_MODEL;
        else process.env.CLAUDISH_RELAY_PROBE_FALLBACK_MODEL = prev;
      }
    });

    it("treats empty and whitespace as unset — the built-in glm-5.3", async () => {
      const prev = process.env.CLAUDISH_RELAY_PROBE_FALLBACK_MODEL;
      try {
        // compose injects every listed name as at least "" (#310); an empty
        // value is not a model name and must never reach the hub as one.
        process.env.CLAUDISH_RELAY_PROBE_FALLBACK_MODEL = "   ";
        sequence(
          () => new Response("down", { status: 503 }),
          () => okStream()
        );
        expect(await deepProbe(state())).toBe(true);
        expect(callBodyModel(1)).toBe("glm-5.3");
      } finally {
        if (prev === undefined) delete process.env.CLAUDISH_RELAY_PROBE_FALLBACK_MODEL;
        else process.env.CLAUDISH_RELAY_PROBE_FALLBACK_MODEL = prev;
      }
    });

    it("names the model that decided, on the line the operator reads", async () => {
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (...a: unknown[]) => {
        lines.push(a.join(" "));
      };
      try {
        sequence(
          () => new Response("native lane refused", { status: 503 }),
          () => okStream()
        );
        expect(await deepProbe(state())).toBe(true);
      } finally {
        console.log = origLog;
      }
      const ok = lines.filter((l) => l.includes("[Relay] deep probe OK"));
      expect(ok.length).toBe(1); // one probe, one OK line — the attempt's own
      expect(ok[0]).toContain("glm-5.3"); // it was the fallback that passed
      // …and the failed first attempt is named on its own line, with both models.
      expect(
        lines.some(
          (l) =>
            l.includes("first attempt on claude-haiku-4-5-20251001 failed") &&
            l.includes("second attempt on glm-5.3 in the same tick")
        )
      ).toBe(true);
    });
  });
});

// ── relayHealthFields (#157): /health must say the ROLE, origin-only ──
//
// 2026-09-19: a hub recreated as a relay forwarding to itself (ARR loops back)
// answered `200 {"status":"ok"}` for 4h40 while flapping 193 AUTONOMOUS
// transitions — the flap WAS the service, so every prober, hysteresis and
// consumer was structurally blind. The role makes the wrong-role node visible
// in one call. `/health` is unauthenticated, so the upstream publishes its
// ORIGIN only — userinfo there (documented SearXNG form) would be a leak.
describe("relayHealthFields", () => {
  it("reports hub + null upstream with no relay configured", () => {
    expect(relayHealthFields(undefined)).toEqual({ role: "hub", upstream: null });
    expect(relayHealthFields({ ...createRelayState({ upstream: "http://h:1" }), upstream: "" })).toEqual(
      { role: "hub", upstream: null }
    );
  });

  it("reports relay-nominal while the prober holds the upstream alive", () => {
    const s = createRelayState({ upstream: "https://models.myia.io" });
    expect(relayHealthFields(s)).toEqual({ role: "relay-nominal", upstream: "https://models.myia.io" });
  });

  it("reports relay-autonomous once hysteresis has flipped", () => {
    const s = createRelayState({ upstream: "http://192.168.0.50:3000" });
    s.alive = false;
    expect(relayHealthFields(s)).toEqual({ role: "relay-autonomous", upstream: "http://192.168.0.50:3000" });
  });

  it("publishes only the ORIGIN of an upstream carrying userinfo — /health is unauthenticated", () => {
    const s = createRelayState({ upstream: "https://user:secret@hub.example:3000" });
    const fields = JSON.stringify(relayHealthFields(s));
    expect(fields).not.toContain("user:secret");
    expect(relayHealthFields(s).upstream).toBe("https://hub.example:3000");
  });

  it("never throws on an unparseable upstream, and still strips userinfo", () => {
    const s = createRelayState({ upstream: "https://user:secret@not a url" });
    const fields = relayHealthFields(s);
    expect(fields.role).toBe("relay-nominal");
    expect(JSON.stringify(fields)).not.toContain("user:secret");
  });

  // Review of #159 (ai-01, 2026-09-20): the two conditions had to MEET for the
  // strip to leak — an unparseable upstream AND an unencoded `@` in the
  // password. `new URL` resolves that form on the last `@`, so the parsable
  // branch was always safe and only the fallback republished a tail
  // (`https://ss@not a url`). Positive control: the same password on a
  // PARSABLE upstream must also come back clean, or this test would pass on a
  // regex that never runs.
  it("strips a password containing an unencoded @, on BOTH branches", () => {
    const parsable = createRelayState({ upstream: "https://user:p@ss@hub.example:3000" });
    expect(relayHealthFields(parsable).upstream).toBe("https://hub.example:3000");

    const unparseable = createRelayState({ upstream: "https://user:p@ss@not a url" });
    const out = relayHealthFields(unparseable).upstream!;
    expect(out).toBe("https://not a url");
    expect(out).not.toContain("@");
  });

  it("leaves an upstream with no userinfo untouched", () => {
    const s = createRelayState({ upstream: "http://192.168.0.50:3000" });
    expect(relayHealthFields(s).upstream).toBe("http://192.168.0.50:3000");
  });
});

// ── heartbeat self-loop detection (#156): identity, not string matching ──
//
// The 2026-09-19 shape — a hub recreated as a relay forwarding to ITSELF
// through a public URL (ARR loops back) — is invisible to every string
// comparison: nothing in "https://models.myia.io" resembles anything the
// process knows about itself. A per-process nonce published on /health makes
// the upstream RECOGNISABLE: same instanceId ⇒ the upstream IS this process.
// Detection must be conservative (the negatives below pin exactly what it must
// NOT see), and a detected loop must settle AUTONOMOUS — never flap, never
// refuse to serve.

describe("heartbeat — self-loop detection (#156)", () => {
  const realConsoleLog = console.log;
  let consoleLines: string[];

  beforeEach(() => {
    consoleLines = [];
    console.log = ((m: unknown) => {
      consoleLines.push(String(m));
    }) as typeof console.log;
  });
  afterEach(() => {
    console.log = realConsoleLog;
  });

  const selfMarkers = () => consoleLines.filter((l) => l.includes("resolves to SELF"));

  it("matching instanceId ⇒ heartbeat failed + exactly one forceConsole marker at the transition", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ status: "ok", instanceId: getInstanceId() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const state = createRelayState({ upstream: "https://models.myia.io" });
    expect(await heartbeat(state)).toBe(false);
    expect(state.selfLoop).toBe(true);
    expect(selfMarkers()).toHaveLength(1);
    expect(selfMarkers()[0]).toContain("https://models.myia.io");
    // transition only — the second detection must not repeat the marker
    consoleLines = [];
    expect(await heartbeat(state)).toBe(false);
    expect(selfMarkers()).toHaveLength(0);
    expect(state.selfLoop).toBe(true);
  });

  it("negative: reply WITHOUT instanceId (older image) ⇒ not detected, verdict unchanged (true)", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    const state = createRelayState({ upstream: "http://192.168.0.50:3000" });
    expect(await heartbeat(state)).toBe(true);
    expect(state.selfLoop).toBe(false);
    expect(selfMarkers()).toHaveLength(0);
  });

  it("negative: non-JSON 200 body ⇒ not detected, behaviour unchanged (true)", async () => {
    fetchImpl = async () => new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });
    const state = createRelayState({ upstream: "http://192.168.0.50:3000" });
    expect(await heartbeat(state)).toBe(true);
    expect(state.selfLoop).toBe(false);
    expect(selfMarkers()).toHaveLength(0);
  });

  it("negative: a DIFFERENT instanceId (a real upstream) ⇒ not detected (true)", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ status: "ok", instanceId: "11111111-2222-3333-4444-555555555555" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const state = createRelayState({ upstream: "http://192.168.0.50:3000" });
    expect(await heartbeat(state)).toBe(true);
    expect(state.selfLoop).toBe(false);
    expect(selfMarkers()).toHaveLength(0);
  });

  it("a plain !res.ok still fails with no marker (pre-#156 path untouched)", async () => {
    fetchImpl = async () => new Response("nope", { status: 503 });
    const state = createRelayState({ upstream: "http://192.168.0.50:3000" });
    expect(await heartbeat(state)).toBe(false);
    expect(state.selfLoop).toBe(false);
    expect(selfMarkers()).toHaveLength(0);
  });

  it("an unreadable body is a FAILED heartbeat, not an undetected one", async () => {
    fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.error(new Error("aborted mid-body"));
          },
        }),
        { status: 200 }
      );
    const state = createRelayState({ upstream: "http://192.168.0.50:3000" });
    expect(await heartbeat(state)).toBe(false);
    expect(state.selfLoop).toBe(false);
  });

  it("self-loop settles AUTONOMOUS via the real hysteresis (proberTick) and NEVER flaps", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ status: "ok", instanceId: getInstanceId() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const state = createRelayState({ upstream: "https://models.myia.io" });
    await proberTick(state); // failure 1/2 — still nominal, marker fired
    expect(state.alive).toBe(true);
    expect(selfMarkers()).toHaveLength(1);
    await proberTick(state); // failure 2/2 → AUTONOMOUS
    expect(state.alive).toBe(false);
    expect(relayHealthFields(state).role).toBe("relay-autonomous");
    // every further tick keeps failing (the upstream is still ourselves) —
    // stable AUTONOMOUS, no recovery attempt, no flap, no repeated marker
    await proberTick(state);
    await proberTick(state);
    await proberTick(state);
    expect(state.alive).toBe(false);
    expect(selfMarkers()).toHaveLength(1);
  });

  it("a normal relay → real upstream stays nominal with selfLoop false (proberTick)", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ status: "ok", instanceId: "11111111-2222-3333-4444-555555555555" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const state = createRelayState({ upstream: "http://192.168.0.50:3000" });
    await proberTick(state);
    await proberTick(state);
    expect(state.alive).toBe(true);
    expect(state.selfLoop).toBe(false);
    expect(relayHealthFields(state).role).toBe("relay-nominal");
    expect(selfMarkers()).toHaveLength(0);
  });
});

// ── redactUpstreamForLog (#160): the LOG must not carry credentials either ──
//
// #159 fixed `/health`; the three log lines that interpolate `state.upstream`
// kept printing it verbatim — boot and both hysteresis transitions. `docker
// logs` is read by every cycle, quoted into dashboard reports and archived, so
// a credential printed there outlives the session that printed it.
//
// Two properties are being pinned, and they pull in opposite directions:
//   - a credential-free upstream comes back BYTE-IDENTICAL, so arming this on
//     the fleet changes no log line on any machine configured as they are today;
//   - a credentialed one loses userinfo but KEEPS host, port and path, because
//     that is what makes a misconfigured upstream diagnosable. Deliberately
//     wider than the origin-only `/health` field above.

describe("redactUpstreamForLog", () => {
  it("returns a credential-free upstream byte-identical (no fleet-wide log change)", () => {
    for (const u of [
      "http://192.168.0.50:3000",
      "http://host.docker.internal:3000",
      "https://models.example.io",
      "http://127.0.0.1:3002",
    ]) {
      expect(redactUpstreamForLog(u)).toBe(u);
    }
  });

  it("strips userinfo but keeps host, port and path", () => {
    expect(redactUpstreamForLog("https://user:secret@hub.example:3000")).toBe("https://hub.example:3000");
    expect(redactUpstreamForLog("https://user:secret@hub.example:3000/api")).toBe(
      "https://hub.example:3000/api"
    );
    expect(redactUpstreamForLog("https://user@hub.example:3000")).toBe("https://hub.example:3000");
  });

  // Same two-branch trap as `/health`: the leak needed an unparseable upstream
  // AND an unencoded `@` in the password. Positive control: the parsable branch
  // must also come back clean, or this test would pass on a regex never run.
  it("strips a password containing an unencoded @, on BOTH branches", () => {
    expect(redactUpstreamForLog("https://user:p@ss@hub.example:3000")).toBe("https://hub.example:3000");

    const out = redactUpstreamForLog("https://user:p@ss@not a url");
    expect(out).toBe("https://not a url");
    expect(out).not.toContain("@");
  });

  it("never throws, whatever it is handed", () => {
    for (const u of ["", "not a url", "://", "http://", "user:pass@host"]) {
      expect(() => redactUpstreamForLog(u)).not.toThrow();
    }
  });

  // The function being correct proves nothing about the CALL SITES, and the
  // call sites are where the leak lived. This pins them structurally, so a
  // future log line added verbatim fails here rather than on a hub's disk.
  it("no log line in relay.ts interpolates state.upstream verbatim", () => {
    const src = readFileSync(new URL("./relay.ts", import.meta.url), "utf-8");
    const logCalls = src.match(/log\(\s*`\[Relay\][^`]*`/g) ?? [];

    // Positive control: the matcher must find the log calls at all, and must
    // find the redacted form — otherwise "0 verbatim" would mean "0 matched".
    // 5 = boot + 2 hysteresis transitions (#160) + both #156 self-loop
    // transition lines; grows with every new redacted call site.
    expect(logCalls.length).toBeGreaterThan(3);
    expect(logCalls.filter((l) => l.includes("redactUpstreamForLog(state.upstream)")).length).toBe(5);

    const verbatim = logCalls.filter((l) => /\$\{state\.upstream\}/.test(l));
    expect(verbatim).toEqual([]);
  });
});

// ── #170: pre-visible upstream death → transparent re-forward ──────────────
//
// A hub restart cuts every in-flight SSE on every relaying machine at once.
// The streams that had not yet emitted anything are recoverable: nothing was
// forwarded, so the request can be re-issued without the client ever knowing.
// Before #170 the relay passed no `retryUpstream` at all — the opts comment
// read, literally, "absent = inert (relay, tests)".

/** Headers arrive, then the body dies having delivered nothing. */
function sseDyingResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("ECONNRESET (hub restart)"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

/** Headers arrive and then nothing, ever — the mute-but-200 shape of #108. */
function sseMuteResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({ start() {} }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

const RECOVERED_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_r","model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"served after the restart"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function drainResponse(r: Response | null): Promise<string> {
  if (!r?.body) return "";
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("forwardToUpstream — pre-visible re-forward (#170)", () => {
  it("recovers a hub death that landed before any client-visible event", async () => {
    let calls = 0;
    fetchImpl = async () => {
      calls++;
      return calls === 1 ? sseDyingResponse() : sseResponse(RECOVERED_SSE);
    };
    const state = createRelayState({ upstream: "http://hub:3000" });
    const out = await drainResponse(
      await forwardToUpstream(mockForwardContext({}), { model: "m" }, state)
    );
    expect(calls).toBe(2); // original + exactly one re-forward
    expect(out).toContain("served after the restart");
    expect(out).toContain("message_stop");
    // A recovery attempt is NOT a liveness measurement — same separation #80
    // part 2 established for the absorbed connect retry. Feeding the hysteresis
    // here would flip relays to AUTONOMOUS on the very blips this absorbs.
    expect(state.consecutiveFail).toBe(0);
  });

  it("re-forwards to the SAME path the client hit, not a hardcoded /v1/messages", async () => {
    const urls: string[] = [];
    let calls = 0;
    fetchImpl = async (url: any) => {
      urls.push(String(url));
      calls++;
      return calls === 1 ? sseDyingResponse() : sseResponse(RECOVERED_SSE);
    };
    const c = mockForwardContext({});
    c.req.path = "/v1/chat/completions";
    const state = createRelayState({ upstream: "http://hub:3000" });
    await drainResponse(await forwardToUpstream(c, { model: "m" }, state));
    expect(urls).toEqual([
      "http://hub:3000/v1/chat/completions",
      "http://hub:3000/v1/chat/completions",
    ]);
  });

  it("the re-forward is header-bounded — a hub that never answers cannot hang the turn", async () => {
    let calls = 0;
    fetchImpl = async (_url: any, init: any) => {
      calls++;
      if (calls === 1) return sseDyingResponse();
      // Second call: never resolves on its own. Only the AbortSignal ends it.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const state = createRelayState({ upstream: "http://hub:3000" });
    const started = Date.now();
    const out = await drainResponse(
      await forwardToUpstream(mockForwardContext({}), { model: "m" }, state, 50)
    );
    expect(calls).toBe(2);
    // Finalized, not hung: the turn ends with a terminal event either way.
    expect(out).toContain("message_stop");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("the REPLACEMENT stream carries its own first-event watchdog (boundRetryUpstream)", async () => {
    // Without the wrap, a mute-but-200 replacement is unbounded and hangs the
    // client — the exact failure #108 confines, reintroduced by the recovery
    // path itself. Measured in review of #137: wrapper removed, the stream was
    // still open after 6s against a 1s window.
    const prev = process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
    process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = "150";
    try {
      let calls = 0;
      fetchImpl = async () => {
        calls++;
        return calls === 1 ? sseDyingResponse() : sseMuteResponse();
      };
      const state = createRelayState({ upstream: "http://hub:3000" });
      const out = await drainResponse(
        await forwardToUpstream(mockForwardContext({}), { model: "m" }, state)
      );
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(out).toContain("message_stop");
    } finally {
      if (prev === undefined) delete process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
      else process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS = prev;
    }
  }, 20_000);

  it("POSITIVE CONTROL — kill switch at 0 restores the pre-#170 relay behavior", async () => {
    process.env.CLAUDISH_PREVISIBLE_REFORWARD_MAX = "0";
    try {
      let calls = 0;
      fetchImpl = async () => {
        calls++;
        return calls === 1 ? sseDyingResponse() : sseResponse(RECOVERED_SSE);
      };
      const state = createRelayState({ upstream: "http://hub:3000" });
      const out = await drainResponse(
        await forwardToUpstream(mockForwardContext({}), { model: "m" }, state)
      );
      expect(calls).toBe(1); // no re-forward at all
      expect(out).not.toContain("served after the restart");
      expect(out).toContain("message_stop");
    } finally {
      delete process.env.CLAUDISH_PREVISIBLE_REFORWARD_MAX;
    }
  });
});

// ── #286: the passthrough's "nothing client-visible" predicates are
// wire-agnostic ────────────────────────────────────────────────────────────────
// Measured while writing #283's route-level control: a NOMINAL relay forwarding
// /v1/chat/completions pipes the hub's OpenAI-SSE body through
// createAnthropicPassthroughStream, whose #170 gate (`sawMessageStart ||
// highestSeenIndex !== -1 || lastBlockOpen`) is anthropic parser state that
// NEVER arms on the OpenAI wire. A graceful end after the FULL body was
// delivered read as "died before anything visible": 2 re-forwards, 3 hub
// requests, 3 copies of the content, then a synthetic "[Error: The model
// returned an empty response…]" tail in anthropic event format after the real
// [DONE]. The fix tracks forwardedAnyData at emitDataLine — the one choke
// point every data-line emission funnels through — so "nothing client-visible"
// means "no data line was FORWARDED", whatever its schema.

/** Spec-correct OpenAI SSE chunks (what the hub really answers on that route). */
function openaiChunkSse(marker: string): string {
  const chunk = (delta: any, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-hub",
      object: "chat.completion.chunk",
      created: 1,
      model: "fake",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  return (
    chunk({ role: "assistant", content: "" }) +
    chunk({ content: marker }) +
    chunk({}, "stop") +
    "data: [DONE]\n\n"
  );
}

describe("forwardToUpstream — wire-agnostic re-forward predicates (#286)", () => {
  it("OpenAI wire: graceful end after the full body → NO re-forward, single copy, no empty-response tail", async () => {
    let calls = 0;
    fetchImpl = async () => {
      calls++;
      return sseResponse(openaiChunkSse("FROM-THE-HUB"));
    };
    const state = createRelayState({ upstream: "http://hub:3000" });
    const c = mockForwardContext({});
    c.req.path = "/v1/chat/completions";
    const out = await drainResponse(await forwardToUpstream(c, { model: "m" }, state));

    // Pre-fix this measured: calls=3, marker ×3, + the empty-response error text.
    expect(calls).toBe(1);
    expect(out.split("FROM-THE-HUB").length - 1).toBe(1);
    expect(out).toContain("[DONE]");
    expect(out).not.toContain("empty response");
    // never-hang intact: the stream still terminates (synthetic terminal tail).
    expect(out).toContain("message_stop");
  });

  it("OpenAI wire: hub death BEFORE any chunk → the #170 recovery still fires across wires", async () => {
    let calls = 0;
    fetchImpl = async () => {
      calls++;
      return calls === 1 ? sseDyingResponse() : sseResponse(openaiChunkSse("served after the restart"));
    };
    const state = createRelayState({ upstream: "http://hub:3000" });
    const c = mockForwardContext({});
    c.req.path = "/v1/chat/completions";
    const out = await drainResponse(await forwardToUpstream(c, { model: "m" }, state));

    expect(calls).toBe(2); // original + exactly one re-forward — recovery preserved
    expect(out.split("served after the restart").length - 1).toBe(1);
  });

  it("OpenAI wire: a policy-refusal error chunk arriving AFTER content → surfaced, never retried", async () => {
    // Content first, then the in-stream error shape both wire parsers detect
    // (`data: {"error":…}`). Pre-fix, the #65 nothingVisible predicate was
    // anthropic parser state only → it retried the identical body with the
    // content already client-visible, duplicating what the client holds.
    let calls = 0;
    fetchImpl = async () => {
      calls++;
      return sseResponse(
        openaiChunkSse("PARTIAL-CONTENT").slice(0, openaiChunkSse("PARTIAL-CONTENT").indexOf("data: [DONE]")) +
          `data: ${JSON.stringify({ error: { code: "invalid_prompt", message: "request rejected due to usage policy" } })}\n\n`
      );
    };
    const state = createRelayState({ upstream: "http://hub:3000" });
    const c = mockForwardContext({});
    c.req.path = "/v1/chat/completions";
    const out = await drainResponse(await forwardToUpstream(c, { model: "m" }, state));

    expect(calls).toBe(1); // content already visible → the retry gate must stay shut
    expect(out).toContain("PARTIAL-CONTENT");
    expect(out.split("PARTIAL-CONTENT").length - 1).toBe(1);
    // The persistent refusal surfaces labeled (#65), and the turn terminates.
    expect(out.toLowerCase()).toContain("policy refusal");
    expect(out).toContain("message_stop");
  });
});

// ── #229 review: the relay must not be where the hub's notice header dies ────
// Both relay branches rebuild their client-facing response headers (the
// non-stream branch from a 1-key literal, the stream branch through the
// passthrough's own header set). A sidecar-relayed OpenAI client must see the
// same notice signal a direct-to-hub client sees.

describe("#229 — relay carries the failover-notice header across both branches", () => {
  const NOTICE = "[claudish] You are a budget substitute.";

  function openAIContext(): any {
    const c = mockForwardContext({ "x-claudish-machine": "myia-po-2024" });
    (c.req as any).path = "/v1/chat/completions";
    return c;
  }

  it("non-stream branch: the buffered rebuild keeps the hub-set notice header", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "hi" } }] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          [NOTICE_HEADER]: noticeToHeaderValue(NOTICE),
        },
      });
    const state = createRelayState({ upstream: "http://hub:3000" });

    const out = await forwardToUpstream(openAIContext(), { model: "glm-5.2", stream: false, messages: [] }, state);

    expect(out).not.toBeNull();
    expect(out!.headers.get(NOTICE_HEADER)).toBe(noticeToHeaderValue(NOTICE));
    const body: any = await out!.json();
    expect(body.choices[0].message.content).toBe("hi"); // body intact under the header
  });

  it("stream branch: the passthrough rebuild keeps the hub-set notice header", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { content: [] } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const hub = sseResponse(sse);
    const headers = new Headers(hub.headers);
    headers.set(NOTICE_HEADER, noticeToHeaderValue(NOTICE));
    fetchImpl = async () => new Response(hub.body, { status: hub.status, headers });
    const state = createRelayState({ upstream: "http://hub:3000" });

    const out = await forwardToUpstream(openAIContext(), { model: "glm-5.2", stream: true, messages: [] }, state);

    expect(out).not.toBeNull();
    expect(out!.headers.get(NOTICE_HEADER)).toBe(noticeToHeaderValue(NOTICE));
    const text = await out!.text();
    expect(text).toContain("message_stop"); // stream passthrough intact under the header
  });
});

describe("#279a — deep-probe overlap guard (proberTick)", () => {
  it("two concurrent ticks on an AUTONOMOUS state past cooldown run exactly ONE deep probe", async () => {
    // The guard under test: `probingStates` (WeakSet) must stop a second tick
    // from launching another deep probe while one is in flight. setInterval
    // does not await tick(), and a real probe is a model call (up to ~30 s) —
    // without the guard, every 10 s tick during recovery double-spends.
    let deepProbes = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    fetchImpl = async (url: any) => {
      const u = String(url);
      if (u.endsWith("/health")) {
        // Healthy AND not self (a different node's id) — the heartbeat returns
        // true without tripping #156's self-loop detection.
        return new Response(
          JSON.stringify({ status: "ok", instanceId: "11111111-1111-4111-8111-111111111111" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      deepProbes++; // a deep-probe POST reached the stub
      await held; // hold the probe in flight like a real 30 s model call
      return sseResponse("event: message_stop\ndata: {}\n\n");
    };
    const state = createRelayState({ upstream: "http://hub:3000" });
    state.alive = false; // AUTONOMOUS
    state.lastFlipAt = 0; // epoch → the 60 s recovery cooldown is long past
    state.consecutiveOk = 3; // OK_THRESHOLD already reached → first tick deep-probes
    const t1 = proberTick(state);
    await new Promise((r) => setTimeout(r, 20)); // t1 parks inside the held probe
    const t2 = proberTick(state); // concurrent tick while the probe is in flight
    await new Promise((r) => setTimeout(r, 20));
    expect(deepProbes).toBe(1); // the overlap guard: t2 must NOT launch a second probe
    release();
    await Promise.all([t1, t2]);
    expect(state.alive).toBe(true); // held probe completed with message_stop → recovered
  });
});

describe("#279b — hop-list self-detection", () => {
  it("appendHop: absent header → [id]; existing list → appended, upstream ids preserved in order", () => {
    expect(appendHop(undefined, "a")).toBe("a");
    expect(appendHop(null, "a")).toBe("a");
    expect(appendHop("", "a")).toBe("a");
    expect(appendHop("   ", "a")).toBe("a"); // whitespace-only ≈ absent
    expect(appendHop("node-a", "node-b")).toBe("node-a,node-b");
    expect(appendHop("node-a, node-b", "node-c")).toBe("node-a,node-b,node-c"); // spaces trimmed
  });

  it("hopsContainSelf: own id in list → true; absent/empty/others → false", () => {
    const own = getInstanceId();
    expect(hopsContainSelf(own)).toBe(true);
    expect(hopsContainSelf(`node-b,${own}`)).toBe(true); // mid-list
    expect(hopsContainSelf(`${own},node-b`)).toBe(true); // head of list
    expect(hopsContainSelf("node-b,node-c")).toBe(false);
    expect(hopsContainSelf(undefined)).toBe(false);
    expect(hopsContainSelf("")).toBe(false);
    expect(hopsContainSelf("  ")).toBe(false);
  });

  it("requestLoopedBack: true only when the INCOMING request carries our own id (AC-b 1/3)", () => {
    const own = getInstanceId();
    expect(requestLoopedBack(mockForwardContext({ "x-claudish-hops": `node-b,${own}` }))).toBe(true);
    expect(requestLoopedBack(mockForwardContext({ "x-claudish-hops": "node-b,node-c" }))).toBe(false);
    expect(requestLoopedBack(mockForwardContext({}))).toBe(false); // no header → exactly today's behavior
  });

  it("forwardToUpstream appends own id to the hop list, attribution/auth headers untouched (AC-b 2)", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    const state = createRelayState({ upstream: "http://hub:3000", proxyKey: "cluster-key" });
    const c = mockForwardContext({
      "x-claudish-hops": "node-a", // an upstream relay already marked this request
      "x-claudish-machine": "myia-po-203",
      authorization: "Bearer client-oauth",
    });

    await forwardToUpstream(c, { model: "glm-5.2" }, state);

    const h = lastFetch!.init.headers as Record<string, string>;
    expect(h["x-claudish-hops"]).toBe(`node-a,${getInstanceId()}`); // appended, upstream ids preserved
    expect(h["x-claudish-machine"]).toBe("myia-po-203"); // attribution survives, untouched
    expect(h["authorization"]).toBe("Bearer client-oauth"); // client OAuth untouched
    expect(h["x-proxy-key"]).toBe("cluster-key"); // cluster gate untouched
  });

  it("forwardToUpstream with NO incoming hop header → list starts with own id (boot window marks hop 1)", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    const state = createRelayState({ upstream: "http://hub:3000" });
    await forwardToUpstream(mockForwardContext({}), { model: "glm-5.2" }, state);
    const h = lastFetch!.init.headers as Record<string, string>;
    expect(h["x-claudish-hops"]).toBe(getInstanceId());
  });
});
