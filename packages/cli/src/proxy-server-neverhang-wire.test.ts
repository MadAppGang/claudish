/**
 * #641 (G4a bullets 5 and 3b, structural pins) — the wire contract of the
 * streaming route, asserted at ROUTE level (real proxy port, stubbed
 * upstream), where a re-platform regression actually lands.
 *
 * Bullet 5 — never gzip the SSE response: a gzipped event stream buffers and
 * a buffered stream is a hang risk. The rule lived in CLAUDE.md with no
 * assertion holding it. Pin: a streaming response carries NO `content-encoding`
 * header at all. Mutation proof: adding `"content-encoding": "gzip"` to the
 * passthrough headers (anthropic-sse.ts) made exactly this pin red.
 *
 * Bullet 3b — `stream:false` answers a single JSON `message`, never SSE
 * (`/compact` is the real-world caller; an event-stream body to it wedges the
 * session). The collector existed but nothing at route level asserted the
 * shape a client sees. Pin: content-type application/json, body parses as ONE
 * JSON object of type "message", no SSE framing anywhere in the body. Mutation
 * proof: flipping the non-streaming response's Content-Type to
 * text/event-stream (composed-handler.ts) made exactly this pin red.
 *
 * Same hermetic harness contract as proxy-server-dwell-pin-route.test.ts
 * (config sandbox, env stripped, upstream served by a fetch stub).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "./proxy-server.js";
import { resetFailoverForTests } from "./fork/failover.js";
import { resetOverflowCapsForTests } from "./handlers/shared/context-overflow.js";
import type { ProxyServer } from "./types.js";

// Distinct range from the other in-process route tests (20115 step-skip,
// 20125 dwell-pin, 19700+/198xx older ones).
const PROXY_PORT = 20135;
const UPSTREAM_PORT = 20235;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

const SANDBOX_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
  "CLAUDISH_CAPTURE_DIR",
];
const savedEnv: Record<string, string | undefined> = {};

let activeProxy: ProxyServer | null = null;
const realFetch = globalThis.fetch;

/** Minimal healthy openai-wire SSE answer carrying `text`. */
function okSse(text: string, model: string): Response {
  const chunk = (delta: any, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body =
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop") +
    `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":${JSON.stringify(model)},"choices":[{"index":0,"delta":{},"finish_reason":"stop","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}]}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const NOMINAL = "nom-ep@fake-nom";

async function postMessage(stream: boolean): Promise<Response> {
  return realFetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 64,
      stream,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
}

beforeEach(() => {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    REAL_CONFIG_PATH,
    JSON.stringify({
      customEndpoints: {
        "nom-ep": {
          kind: "simple",
          url: `${UPSTREAM_BASE}/nm/v1`,
          format: "openai",
          apiKey: "test-key",
        },
      },
    }),
    "utf-8"
  );
  for (const k of SANDBOX_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith(UPSTREAM_BASE)) return okSse("wire-pin-text", "fake-nm");
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (activeProxy) {
    await activeProxy.shutdown();
    activeProxy = null;
  }
  if (configBackup !== null) {
    writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  } else if (!configExisted && existsSync(REAL_CONFIG_PATH)) {
    try {
      rmSync(REAL_CONFIG_PATH);
    } catch {}
  }
  configBackup = null;
  configExisted = false;
  for (const k of SANDBOX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetOverflowCapsForTests();
  resetFailoverForTests();
});

describe("#641 G4a wire pins — the streaming route's never-hang contract", () => {
  test("bullet 5: a streaming SSE response carries NO content-encoding (never gzip)", async () => {
    activeProxy = await createProxyServer(
      PROXY_PORT,
      undefined,
      undefined,
      false,
      undefined,
      { sonnet: NOMINAL },
      { quiet: true }
    );

    const r = await postMessage(true);
    expect(r.status).toBe(200);
    // The response IS an SSE stream — the pin below is about a real stream,
    // not an error body that happens to have no encoding.
    expect(r.headers.get("content-type")).toContain("text/event-stream");

    const enc = r.headers.get("content-encoding");
    expect(
      enc === null,
      `SSE response carries content-encoding: "${enc}" — gzip buffering is a hang risk`
    ).toBe(true);

    // Drain the stream so the proxy's cleanup paths run inside the test.
    await r.text();
  });

  test("bullet 3b: stream:false answers ONE JSON message, never text/event-stream", async () => {
    activeProxy = await createProxyServer(
      PROXY_PORT,
      undefined,
      undefined,
      false,
      undefined,
      { sonnet: NOMINAL },
      { quiet: true }
    );

    const r = await postMessage(false);
    expect(r.status).toBe(200);

    const ct = r.headers.get("content-type") ?? "";
    expect(
      ct.startsWith("application/json"),
      `stream:false answered content-type "${ct}" — an event-stream body to /compact wedges the session`
    ).toBe(true);

    const raw = await r.text();
    let parsed: any = null;
    let parseError = "";
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parseError = String(err);
    }
    expect(
      parsed !== null && parsed.type === "message" && !raw.includes("\ndata:")
        ? "single JSON message"
        : `stream:false body is not a single JSON message (parse: ${parseError || "ok but wrong shape"}, ` +
          `type: ${parsed?.type ?? "?"}, sse framing: ${raw.includes("data:")})`
    ).toBe("single JSON message");
    expect(parsed?.content?.[0]?.text).toBe("wire-pin-text");
  });
});
