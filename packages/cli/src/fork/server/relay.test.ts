import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  createRelayState,
  readRequestBody,
  forwardToUpstream,
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
