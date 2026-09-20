import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  createRelayState,
  readRequestBody,
  forwardToUpstream,
  deepProbe,
  relayHealthFields,
  FORWARD_HEADERS_TIMEOUT_MS,
  type RelayState,
} from "./relay.js";

// ── fetch mock ─────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let lastFetch: { url: string; init: any } | null = null;
let fetchImpl: (url: any, init: any) => Promise<Response> = async () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  lastFetch = null;
  globalThis.fetch = (async (url: any, init: any) => {
    lastFetch = { url: String(url), init };
    return fetchImpl(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Minimal Hono Context stub for forwardToUpstream (needs req.raw.headers + body()). */
function mockForwardContext(inboundHeaders: Record<string, string> = {}): any {
  return {
    req: { raw: { headers: new Headers(inboundHeaders) } },
    // c.body(stream) → wrap it in a Response, as Hono does for streaming.
    body: (stream: any) =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
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
  it("is generous enough that ordinary upstream latency never forces a local fallthrough", () => {
    // Measured ai-01 → models.myia.io on 2026-08-10, plain glm-5.2 streaming POSTs:
    // first byte at 2.5s / 3.1s / 3.4s / 8.3s. A 5s bound sat inside that spread and
    // silently demoted routine requests to the local pipeline (no central capture,
    // double provider spend, and budget-model reroute on CLAUDISH_NO_ANTHROPIC hosts).
    // Liveness is the prober's job, not this bound's — keep it well clear of the tail.
    expect(FORWARD_HEADERS_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });
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
