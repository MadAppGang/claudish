import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { type IncomingHttpHeaders, request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Canary, type CanaryHit, startCanary } from "./canary.ts";

const roots = new Set<string>();
const listeners = new Set<Canary>();

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function scratchRoot(): string {
  const home = resolve(userInfo().homedir);
  const configured = resolve(tmpdir());
  if (inside(home, configured)) throw new Error("Refuse a temporary base inside the real home");
  const base = realpathSync(configured);
  if (inside(home, base)) throw new Error("Refuse a canonical temporary base inside the real home");
  const root = mkdtempSync(join(base, "pool-canary-test-"));
  roots.add(root);
  return root;
}

function loopbackUrl(origin: string): URL {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) < 1 ||
    Number(url.port) > 65_535 ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Refuse a non-loopback or invalid test origin");
  }
  return url;
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  origin: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<HttpResult> {
  const base = loopbackUrl(origin);
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error("Refuse an off-origin request");

  return new Promise((resolveResult, reject) => {
    // A fresh direct agent neither uses a proxy nor follows a redirect.
    const req = request(
      {
        hostname: "127.0.0.1",
        family: 4,
        port: Number(base.port),
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => {
          resolveResult({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.once("error", reject);
    req.setTimeout(2_000, () => req.destroy(new Error("Loopback HTTP request timed out")));
    req.end(options.body);
  });
}

function connect(origin: string): Promise<void> {
  const url = loopbackUrl(origin);
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(url.port), family: 4 });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection();
    });
    socket.setTimeout(2_000, () => {
      socket.destroy(new Error("Loopback TCP connection timed out"));
    });
  });
}

function start(): { canary: Canary; logPath: string } {
  const logPath = join(scratchRoot(), "canary.jsonl");
  const canary = startCanary(logPath);
  listeners.add(canary);
  return { canary, logPath };
}

function readHits(logPath: string): CanaryHit[] {
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/);
  expect(lines.pop()).toBe("");
  expect(lines.every((line) => line.length > 0)).toBe(true);
  return lines.map((line) => JSON.parse(line) as CanaryHit);
}

afterEach(() => {
  try {
    for (const canary of listeners) canary.stop();
  } finally {
    listeners.clear();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.clear();
  }
});

describe("loopback metered canary", () => {
  test("TEST-26 REQ-5.1 advertises a nonzero 127.0.0.1 HTTP origin", () => {
    const { canary } = start();

    expect(canary.origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    const url = loopbackUrl(canary.origin);
    expect(Number.isInteger(Number(url.port))).toBe(true);
    expect(canary.hits).toEqual([]);
  });

  test.each([
    { method: "GET", path: "/unlisted", authorization: null },
    { method: "POST", path: "/v1/responses", authorization: "Bearer fake-canary-test-value" },
    { method: "PUT", path: "/arbitrary/put", authorization: null },
    {
      method: "PATCH",
      path: "/arbitrary/patch",
      authorization: "Bearer another-fake-canary-value",
    },
    { method: "DELETE", path: "/arbitrary/delete", authorization: null },
    { method: "HEAD", path: "/head-only", authorization: "Bearer fake-head-value" },
    { method: "OPTIONS", path: "/options-only", authorization: null },
  ])(
    "TEST-27 REQ-5.2 records $method $path and answers 500",
    async ({ method, path, authorization }) => {
      const { canary } = start();
      const headers: Record<string, string> =
        authorization === null ? {} : { Authorization: authorization };

      const response = await send(canary.origin, path, { method, headers });

      expect(response.status).toBe(500);
      expect(canary.hits).toHaveLength(1);
      expect(canary.hits[0]).toEqual({
        method,
        path,
        authorization,
        at: expect.any(Number),
      });
      expect(Number.isFinite(canary.hits[0]!.at)).toBe(true);
    }
  );

  test("TEST-28 REQ-5.3 appends one exact JSON line for every hit without truncating", async () => {
    const { canary, logPath } = start();

    await send(canary.origin, "/first", {
      method: "POST",
      headers: { Authorization: "Bearer first-fake-value" },
      body: "first request",
    });
    const first = readHits(logPath);
    expect(first).toHaveLength(1);
    expect(first).toEqual(canary.hits);
    await send(canary.origin, "/second", { method: "DELETE" });

    const all = readHits(logPath);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(first[0]);
    expect(all).toEqual(canary.hits);
    expect(all.map((hit) => hit.path)).toEqual(["/first", "/second"]);
  });

  test("TEST-29 REQ-5.4 reset empties both sources and records the next request afresh", async () => {
    const { canary, logPath } = start();
    await send(canary.origin, "/old-one");
    await send(canary.origin, "/old-two", { method: "POST" });
    expect(canary.hits).toHaveLength(2);
    expect(readHits(logPath)).toHaveLength(2);

    canary.reset();

    expect(canary.hits).toEqual([]);
    expect(readFileSync(logPath, "utf8")).toBe("");

    await send(canary.origin, "/after-reset", {
      method: "POST",
      headers: { Authorization: "Bearer after-reset-fake-value" },
    });

    expect(canary.hits).toHaveLength(1);
    expect(canary.hits[0]!.path).toBe("/after-reset");
    expect(readHits(logPath)).toEqual(canary.hits);
  });

  test("TEST-30 REQ-5.5 stop refuses a fresh TCP connection", async () => {
    const { canary } = start();
    const origin = canary.origin;
    expect((await send(origin, "/before-stop")).status).toBe(500);

    canary.stop();
    listeners.delete(canary);

    await expect(connect(origin)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
