import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import {
  ANTIGRAVITY_PLAIN_FETCH_ENV,
  antigravityFetch,
  antigravityHeaderLines,
} from "./antigravity-fetch.js";

type Mode = "plain" | "gzip" | "hang" | "sse";

let received = "";
let mode: Mode = "plain";
let server: import("bun").TCPSocketListener<undefined>;
let base = "";
const savedEnv: Record<string, string | undefined> = {};
const ENV = [
  ANTIGRAVITY_PLAIN_FETCH_ENV,
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

function requestComplete(text: string): boolean {
  const at = text.indexOf("\r\n\r\n");
  if (at < 0) return false;
  const head = text.slice(0, at);
  if (/transfer-encoding: chunked/i.test(head)) return text.endsWith("0\r\n\r\n");
  const length = Number(head.match(/content-length: (\d+)/i)?.[1] ?? 0);
  return text.length - at - 4 >= length;
}

beforeAll(() => {
  server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        received += Buffer.from(data).toString("latin1");
        if (mode === "hang" || !requestComplete(received)) return;
        if (mode === "gzip") {
          const body = gzipSync('{"ok":true}');
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n`
          );
          socket.write(body);
        } else if (mode === "sse") {
          socket.write(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
          );
          for (const part of ["data: 1\n\n", "data: 2\n\n"]) {
            socket.write(`${part.length.toString(16)}\r\n${part}\r\n`);
          }
          socket.write("0\r\n\r\n");
        } else {
          socket.write(
            "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 4\r\nX-Kept: yes\r\n\r\nbusy"
          );
        }
        socket.end();
      },
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
  received = "";
  mode = "plain";
  for (const name of ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

const HEADERS = {
  Authorization: "Bearer token",
  "User-Agent": "antigravity/cli/1.5.9 (aidev_client)",
  "Content-Type": "application/json",
};

describe("the request head is the Antigravity CLI's", () => {
  test("a streamGenerateContent call: chunked body, the recorded header order, nothing more", async () => {
    mode = "sse";
    const res = await antigravityFetch(`${base}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: HEADERS,
      body: '{"a":1}',
    });
    expect(await res.text()).toBe("data: 1\n\ndata: 2\n\n");
    expect(received).toBe(
      [
        "POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        "User-Agent: antigravity/cli/1.5.9 (aidev_client)",
        "Transfer-Encoding: chunked",
        "Authorization: Bearer token",
        "Content-Type: application/json",
        "Accept-Encoding: gzip",
        "",
        "7",
        '{"a":1}',
        "0",
        "",
        "",
      ].join("\r\n")
    );
  });

  test("every other call: Content-Length in the same place", async () => {
    const res = await antigravityFetch(`${base}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: HEADERS,
      body: '{"é":1}',
    });
    await res.text();
    expect(received).toBe(
      [
        "POST /v1internal:loadCodeAssist HTTP/1.1",
        `Host: 127.0.0.1:${server.port}`,
        "User-Agent: antigravity/cli/1.5.9 (aidev_client)",
        "Content-Length: 8",
        "Authorization: Bearer token",
        "Content-Type: application/json",
        "Accept-Encoding: gzip",
        "",
        Buffer.from('{"é":1}', "utf8").toString("latin1"),
      ].join("\r\n")
    );
  });

  test("a caller's Accept, Connection and Accept-Encoding are not sent; another header follows", () => {
    expect(
      antigravityHeaderLines(
        {
          accept: "*/*",
          Connection: "keep-alive",
          "Accept-Encoding": "br",
          "X-Other": "1",
          authorization: "Bearer t",
        },
        2,
        false
      )
    ).toEqual([
      ["Content-Length", "2"],
      ["Authorization", "Bearer t"],
      ["Accept-Encoding", "gzip"],
      ["X-Other", "1"],
    ]);
  });
});

describe("the response reads as a fetch response", () => {
  test("status, headers and body of a refusal are passed on", async () => {
    const res = await antigravityFetch(`${base}/x`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    });
    expect(res.status).toBe(429);
    expect(res.ok).toBe(false);
    expect(res.headers.get("x-kept")).toBe("yes");
    expect(await res.text()).toBe("busy");
  });

  test("a gzip body is decoded and no longer labelled gzip", async () => {
    mode = "gzip";
    const res = await antigravityFetch(`${base}/x`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("failures keep the vocabulary the callers classify", () => {
  test("an abort before the response rejects with the signal's reason", async () => {
    mode = "hang";
    const controller = new AbortController();
    const pending = antigravityFetch(`${base}/x`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.catch((e) => e);
    expect(error).toBe(controller.signal.reason);
    expect(error.name).toBe("AbortError");
  });

  test("an already aborted signal sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await antigravityFetch(`${base}/x`, {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    }).catch((e) => e);
    expect(error).toBe(controller.signal.reason);
    expect(received).toBe("");
  });

  test("a refused connection and an unknown host classify as connection errors", async () => {
    const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = closed.port;
    closed.stop(true);
    const refused = await antigravityFetch(`http://127.0.0.1:${port}/x`, {
      method: "POST",
      body: "{}",
    }).catch((e) => e);
    expect(classifyConnectionError(refused)?.kind).toBe("refused");

    const dns = await antigravityFetch("https://no-such-host.invalid/x", {
      method: "POST",
      body: "{}",
    }).catch((e) => e);
    expect(classifyConnectionError(dns)?.kind).toBe("dns");
  });
});

test("behind a proxy the runtime's fetch sends the request", async () => {
  process.env.HTTP_PROXY = "http://127.0.0.1:9";
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("via fetch");
  }) as typeof fetch;
  try {
    const res = await antigravityFetch(`${base}/x`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    });
    expect(await res.text()).toBe("via fetch");
    expect(calls).toEqual([`${base}/x`]);
    expect(received).toBe("");
  } finally {
    globalThis.fetch = original;
  }
});

test("the plain-fetch switch hands the request to the runtime's fetch", async () => {
  process.env[ANTIGRAVITY_PLAIN_FETCH_ENV] = "1";
  const res = await antigravityFetch(`${base}/x`, { method: "POST", headers: HEADERS, body: "{}" });
  await res.text();
  expect(received).toContain("Connection: keep-alive");
});
