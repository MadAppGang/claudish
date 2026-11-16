import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import {
  ANTIGRAVITY_PLAIN_FETCH_ENV,
  antigravityFetch,
  antigravityHeaderLines,
  nodeHttpWritesOwnHead,
} from "./antigravity-fetch.js";

/** The suites that read what `node:http` wrote run only where it writes its own head. */
const ownClient = describe.skipIf(!nodeHttpWritesOwnHead(process.versions.bun));

type Mode = "plain" | "gzip" | "hang" | "sse" | "redirect";

/** Where the "redirect" mode sends the client. */
let redirectTo = "/moved";

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
  "NO_PROXY",
  "no_proxy",
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
        if (mode === "redirect") {
          // The first request is sent on; the request that follows it is answered.
          mode = "plain";
          received += "\n--next--\n";
          socket.write(
            `HTTP/1.1 307 Temporary Redirect\r\nLocation: ${redirectTo}\r\nContent-Length: 0\r\n\r\n`
          );
          socket.end();
          return;
        }
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
  redirectTo = "/moved";
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

test("the node:http client is used on Node and on Bun 1.4.0 and later", () => {
  expect(nodeHttpWritesOwnHead(undefined)).toBe(true);
  expect(nodeHttpWritesOwnHead("1.4.0")).toBe(true);
  expect(nodeHttpWritesOwnHead("1.4.1-canary.3")).toBe(true);
  expect(nodeHttpWritesOwnHead("1.4.0-canary.1")).toBe(false);
  expect(nodeHttpWritesOwnHead("2.0.0")).toBe(true);
  expect(nodeHttpWritesOwnHead("1.3.10")).toBe(false);
  expect(nodeHttpWritesOwnHead("1.10.0")).toBe(true);
  expect(nodeHttpWritesOwnHead("0.9.0")).toBe(false);
  expect(nodeHttpWritesOwnHead("garbage")).toBe(false);
});

test("on a Bun older than 1.4.0 the runtime's fetch sends the request", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("via fetch");
  }) as typeof fetch;
  try {
    const res = await antigravityFetch(
      `${base}/x`,
      { method: "POST", headers: HEADERS, body: "{}" },
      { idleTimeoutMs: 1000, bunVersion: "1.3.10" }
    );
    expect(await res.text()).toBe("via fetch");
    expect(calls).toEqual([`${base}/x`]);
    expect(received).toBe("");
  } finally {
    globalThis.fetch = original;
  }
});

ownClient("the request head is the Antigravity CLI's", () => {
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

ownClient("the response reads as a fetch response", () => {
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

ownClient("failures keep the vocabulary the callers classify", () => {
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

ownClient("what fetch did for its callers and node:http does not", () => {
  test("a connection that stays silent fails as a timed-out connection", async () => {
    mode = "hang";
    const failure = await antigravityFetch(
      `${base}/x`,
      { method: "POST", headers: HEADERS, body: "{}" },
      { idleTimeoutMs: 150, bunVersion: process.versions.bun }
    ).catch((error) => error);
    expect((failure as { code?: string }).code).toBe("ETIMEDOUT");
    expect(classifyConnectionError(failure)?.kind).toBe("unreachable");
  });

  test("a request that never gets a socket fails as a timed-out connection", async () => {
    // A request whose socket never connects: no socket timeout can fire on it.
    const stalled = Object.assign(new EventEmitter(), {
      setHeader() {},
      removeHeader() {},
      setTimeout() {},
      write() {},
      end() {},
      destroyed: false,
      destroy(error?: Error) {
        stalled.destroyed = true;
        if (error) queueMicrotask(() => stalled.emit("error", error));
      },
    });
    const spy = spyOn(http, "request").mockImplementation((() => stalled) as never);
    try {
      const failure = await antigravityFetch(
        `${base}/x`,
        { method: "POST", headers: HEADERS, body: "{}" },
        { idleTimeoutMs: 100, bunVersion: process.versions.bun }
      ).catch((error) => error);
      expect((failure as { code?: string }).code).toBe("ETIMEDOUT");
      expect(stalled.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("a header value with a line break rejects, sends nothing and destroys the request", async () => {
    const made: http.ClientRequest[] = [];
    const real = http.request;
    const spy = spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
      const request = (real as (...a: unknown[]) => http.ClientRequest)(...args);
      made.push(request);
      return request;
    }) as never);
    try {
      const failure = await antigravityFetch(`${base}/x`, {
        method: "POST",
        headers: { ...HEADERS, Authorization: "Bearer a\r\nX-Injected: 1" },
        body: "{}",
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(made).toHaveLength(1);
      expect(made[0].destroyed).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  test("a 307 to another origin keeps the body and drops Authorization", async () => {
    let elsewhere = "";
    const other = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          elsewhere += Buffer.from(data).toString("latin1");
          if (!requestComplete(elsewhere)) return;
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
          socket.end();
        },
      },
    });
    try {
      mode = "redirect";
      redirectTo = `http://127.0.0.1:${other.port}/elsewhere`;
      const res = await antigravityFetch(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: HEADERS,
        body: '{"a":1}',
      });
      expect(await res.text()).toBe("ok");
      expect(received).toContain("Authorization: Bearer token");
      expect(elsewhere).toContain("POST /elsewhere HTTP/1.1");
      expect(elsewhere).toContain("User-Agent: antigravity/cli/1.5.9 (aidev_client)");
      expect(elsewhere.toLowerCase()).not.toContain("authorization");
      expect(elsewhere.endsWith('{"a":1}')).toBe(true);
    } finally {
      other.stop(true);
    }
  });

  test("a 307 is followed with the same method and body", async () => {
    mode = "redirect";
    const res = await antigravityFetch(`${base}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: HEADERS,
      body: '{"a":1}',
    });
    expect(res.status).toBe(429);
    const [first, second] = received.split("\n--next--\n");
    expect(first).toContain("POST /v1internal:loadCodeAssist HTTP/1.1");
    expect(second).toContain("POST /moved HTTP/1.1");
    expect(second).toContain("Authorization: Bearer");
    expect(second.endsWith('{"a":1}')).toBe(true);
  });

  test("redirect manual returns the 307 itself", async () => {
    mode = "redirect";
    const res = await antigravityFetch(`${base}/x`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/moved");
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

test.skipIf(!nodeHttpWritesOwnHead(process.versions.bun))(
  "NO_PROXY with the target's port sends the request itself; another port does not",
  async () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:9";
    const port = new URL(base).port;
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("via fetch");
    }) as typeof fetch;
    try {
      process.env.NO_PROXY = `127.0.0.1:${port}`;
      const direct = await antigravityFetch(`${base}/x`, {
        method: "POST",
        headers: HEADERS,
        body: "{}",
      });
      await direct.text();
      expect(calls).toEqual([]);
      expect(received).toContain("POST /x HTTP/1.1");

      process.env.NO_PROXY = "127.0.0.1:1";
      const proxied = await antigravityFetch(`${base}/y`, {
        method: "POST",
        headers: HEADERS,
        body: "{}",
      });
      expect(await proxied.text()).toBe("via fetch");
      expect(calls).toEqual([`${base}/y`]);
    } finally {
      globalThis.fetch = original;
    }
  }
);

test("the plain-fetch switch hands the request to the runtime's fetch", async () => {
  process.env[ANTIGRAVITY_PLAIN_FETCH_ENV] = "1";
  const res = await antigravityFetch(`${base}/x`, { method: "POST", headers: HEADERS, body: "{}" });
  await res.text();
  expect(received).toContain("Connection: keep-alive");
});
