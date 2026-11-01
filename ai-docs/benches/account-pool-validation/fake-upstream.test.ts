import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type Fake,
  type FakeOptions,
  type LoggedRequest,
  classifyResponsesRequest,
  responsesSse,
  startFake,
} from "./fake-upstream.ts";

const RESPONSE_PATH = "/backend-api/codex/responses";
const roots = new Set<string>();
const listeners = new Set<Fake>();

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
  const root = mkdtempSync(join(base, "pool-fake-test-"));
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

function start(options: Partial<Omit<FakeOptions, "logPath">> = {}): {
  fake: Fake;
  logPath: string;
} {
  const logPath = join(scratchRoot(), "requests.jsonl");
  const fake = startFake({
    script: () => ({ type: "text", text: "default loopback answer" }),
    ...options,
    logPath,
  });
  listeners.add(fake);
  return { fake, logPath };
}

function postResponses(fake: Fake, json: unknown): Promise<HttpResult> {
  return send(fake.origin, RESPONSE_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json),
  });
}

function exchange(fake: Fake, refreshToken: string): Promise<HttpResult> {
  const fields = { grant_type: "refresh_token", refresh_token: refreshToken };
  return send(fake.origin, "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}

function jsonObject(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  expect(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)).toBe(true);
  return parsed as Record<string, unknown>;
}

function issued(response: HttpResult, presented: string): { access: string; refresh: string } {
  expect(response.status).toBe(200);
  const body = jsonObject(response.body);
  // REQ-7.1a: avoid toMatchObject with asymmetric matchers; Bun mutates its input.
  const access = body.access_token;
  const refresh = body.refresh_token;
  expect(typeof access).toBe("string");
  expect(typeof refresh).toBe("string");
  expect(typeof body.expires_in).toBe("number");
  if (typeof access !== "string" || typeof refresh !== "string") {
    throw new TypeError("Issued access_token and refresh_token must be strings");
  }
  expect(access.length).toBeGreaterThan(0);
  expect(refresh.length).toBeGreaterThan(0);
  expect(refresh).not.toBe(presented);
  expect(access).not.toBe(presented);
  expect(access).not.toBe(refresh);
  return { access, refresh };
}

function invalidGrant(response: HttpResult): void {
  expect(response.status).toBe(400);
  expect(jsonObject(response.body)).toMatchObject({ error: "invalid_grant" });
}

function readRequests(logPath: string): LoggedRequest[] {
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/);
  expect(lines.pop()).toBe("");
  expect(lines.every((line) => line.length > 0)).toBe(true);
  return lines.map((line) => JSON.parse(line) as LoggedRequest);
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(stringValues);
  return [];
}

function expectCompletedSse(source: string, text: string): void {
  const frames = source
    .trim()
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim() !== "");
  expect(frames.length).toBeGreaterThan(0);
  const decoded = frames.map((frame) => {
    const lines = frame.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"));
    const data = lines.filter((line) => line.startsWith("data:"));
    expect(event).toBeDefined();
    expect(data.length).toBeGreaterThan(0);
    return {
      event: event!.slice("event:".length).trim(),
      data: JSON.parse(
        data.map((line) => line.slice("data:".length).trimStart()).join("\n")
      ) as unknown,
    };
  });

  expect(stringValues(decoded.map((frame) => frame.data))).toContain(text);
  expect(decoded.at(-1)!.event).toBe("response.completed");
  expect(decoded.at(-1)!.data).toMatchObject({ type: "response.completed" });
}

afterEach(() => {
  try {
    for (const fake of listeners) fake.stop();
  } finally {
    listeners.clear();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.clear();
  }
});

describe("responses classification and SSE", () => {
  test.each([
    { name: "null", value: null, expected: "title" },
    { name: "undefined", value: undefined, expected: "title" },
    { name: "a string", value: "tools", expected: "title" },
    { name: "a number", value: 7, expected: "title" },
    { name: "a boolean", value: true, expected: "title" },
    { name: "an empty array", value: [], expected: "title" },
    { name: "an empty object", value: {}, expected: "title" },
    { name: "empty tools", value: { tools: [] }, expected: "title" },
    { name: "null tools", value: { tools: null }, expected: "title" },
    { name: "a tools string", value: { tools: "nonempty" }, expected: "title" },
    { name: "an array-like tools object", value: { tools: { length: 1 } }, expected: "title" },
    { name: "one tool", value: { tools: [{}] }, expected: "main" },
    { name: "multiple tools", value: { tools: [{}, {}] }, expected: "main" },
  ])("TEST-31 REQ-6.2 classifies $name as $expected without throwing", ({ value, expected }) => {
    expect(classifyResponsesRequest(value)).toBe(expected);
  });

  test.each([
    "ordinary loopback answer",
    'café ☕\n"quoted" \\ backslash\n\nevent: not-a-real-event',
    "",
  ])("TEST-32 REQ-6.6 preserves text %p and ends with a completed-response event", (text) => {
    expectCompletedSse(responsesSse(text), text);
  });
});

describe("fake responses HTTP endpoint", () => {
  test.each([
    {
      name: "body session overrides header",
      bodySession: true,
      headerSession: "header-session",
      authorization: "Bearer fake-wire-value",
      expectedSession: "body-session",
    },
    {
      name: "header session fallback",
      bodySession: false,
      headerSession: "header-session",
      authorization: "Bearer fake-wire-value",
      expectedSession: "header-session",
    },
    {
      name: "absent authorization and session",
      bodySession: false,
      headerSession: null,
      authorization: null,
      expectedSession: null,
    },
  ])(
    "TEST-33 REQ-6.1 records raw metadata with $name",
    async ({ bodySession, headerSession, authorization, expectedSession }) => {
      const { fake } = start();
      const raw =
        '{\n  "tools": [ {} ],\n  "input": "café ☕",\n' +
        (bodySession ? '  "prompt_cache_key": "body-session",\n' : "") +
        '  "marker": 7\n}\n';
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (headerSession !== null) headers.session_id = headerSession;
      if (authorization !== null) headers.Authorization = authorization;

      const response = await send(fake.origin, RESPONSE_PATH, {
        method: "POST",
        headers,
        body: raw,
      });

      expect(response.status).toBe(200);
      expect(fake.port).toBe(Number(loopbackUrl(fake.origin).port));
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]).toMatchObject({
        method: "POST",
        path: RESPONSE_PATH,
        kind: "main",
        mainIndex: 1,
        bearer: authorization,
        bytes: Buffer.byteLength(raw, "utf8"),
        bodySha256: createHash("sha256").update(raw, "utf8").digest("hex"),
        sessionId: expectedSession,
        status: 200,
      });
      expect(fake.requests[0]!.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    }
  );

  test("TEST-34 REQ-6.3 increments mainIndex only for main requests", async () => {
    const { fake } = start({ validRefreshTokens: ["counter-seed"] });

    await postResponses(fake, { input: "title" });
    await postResponses(fake, { tools: [{}], input: "main one" });
    issued(await exchange(fake, "counter-seed"), "counter-seed");
    await postResponses(fake, { tools: [], input: "another title" });
    await send(fake.origin, "/unrelated");
    await postResponses(fake, { tools: [{}], input: "main two" });

    expect(fake.requests).toHaveLength(6);
    expect(fake.requests.map((entry) => entry.mainIndex)).toEqual([null, 1, null, null, null, 2]);
    expect(
      fake.requests.filter((entry) => entry.kind === "main").map((entry) => entry.mainIndex)
    ).toEqual([1, 2]);
    expect(fake.requests[0]!.kind).toBe("title");
    expect(fake.requests[2]!.kind).toBe("token");
    expect(fake.requests[3]!.kind).toBe("title");
    for (const entry of fake.requests.filter((item) => item.kind !== "main")) {
      expect(entry.mainIndex).toBeNull();
    }
  });

  test.each([
    { forced: "main" as const, json: { tools: [] }, index: 1 },
    { forced: "title" as const, json: { tools: [{}] }, index: null },
  ])(
    "TEST-35 REQ-6.4 uses a classifier forcing $forced over the default",
    async ({ forced, json, index }) => {
      const { fake } = start({ classify: () => forced });

      expect((await postResponses(fake, json)).status).toBe(200);

      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]).toMatchObject({ kind: forced, mainIndex: index });
    }
  );

  test("TEST-36 REQ-6.5 returns scripted text as 200 Responses SSE using request context", async () => {
    const { fake } = start({
      script: (ctx) => ({
        type: "text",
        text: [
          ctx.kind,
          String(ctx.mainIndex),
          ctx.bearer ?? "none",
          ctx.body,
          JSON.stringify(ctx.json),
        ].join("\n"),
      }),
    });
    const raw = JSON.stringify({ tools: [{}], input: 'café\n"quoted"' });
    const expectedText = ["main", "1", "Bearer fake-context-value", raw, raw].join("\n");

    const response = await send(fake.origin, RESPONSE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer fake-context-value" },
      body: raw,
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/event-stream(?:;|$)/i);
    expectCompletedSse(response.body, expectedText);
    expect(fake.requests[0]!.status).toBe(200);
  });

  test("TEST-37 REQ-6.5 returns and logs 429 for a quota reply", async () => {
    const { fake } = start({ script: () => ({ type: "quota", resetsAt: 2_000_000_000 }) });

    const response = await postResponses(fake, { tools: [{}] });

    expect(response.status).toBe(429);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.status).toBe(429);
  });

  test.each([418, 422, 503])(
    "TEST-38 REQ-6.5 preserves scripted status %i, body, and headers",
    async (status) => {
      const body = { error: { code: "scripted-status", status }, marker: ["unchanged", 7] };
      const { fake } = start({
        script: () => ({
          type: "status",
          status,
          body,
          headers: { "x-script-marker": "preserved-value" },
        }),
      });

      const response = await postResponses(fake, { tools: [{}] });

      expect({
        status: response.status,
        body: JSON.parse(response.body),
        marker: response.headers["x-script-marker"],
      }).toEqual({ status, body, marker: "preserved-value" });
      expect(fake.requests[0]!.status).toBe(status);
    }
  );

  test("TEST-38 REQ-6.5 permits a status reply without optional body and headers", async () => {
    const { fake } = start({ script: () => ({ type: "status", status: 410 }) });

    const response = await postResponses(fake, { tools: [{}] });

    expect(response.status).toBe(410);
    expect(fake.requests[0]!.status).toBe(410);
  });

  test("TEST-39 REQ-6.7 appends responses, token, and unrelated paths once to both logs", async () => {
    const { fake, logPath } = start({ validRefreshTokens: ["log-seed"] });

    await postResponses(fake, { tools: [{}], input: "log me" });
    const first = readRequests(logPath);
    expect(first).toHaveLength(1);
    await send(fake.origin, "/not-a-route", { method: "GET" });
    issued(await exchange(fake, "log-seed"), "log-seed");
    await send(fake.origin, "/another-missing-path", {
      method: "DELETE",
      body: "raw unrelated body",
    });

    const expectedPaths = [RESPONSE_PATH, "/not-a-route", "/oauth/token", "/another-missing-path"];
    expect(fake.requests).toHaveLength(expectedPaths.length);
    expect(fake.requests.map((entry) => entry.path)).toEqual(expectedPaths);
    expect(fake.requests.map((entry) => entry.method)).toEqual(["POST", "GET", "POST", "DELETE"]);
    const logged = readRequests(logPath);
    expect(logged).toEqual(fake.requests);
    expect(logged[0]).toEqual(first[0]);
  });

  test("TEST-40 REQ-6.7 bodyDir preserves raw responses and token bodies under padded names", async () => {
    const bodyDir = join(scratchRoot(), "bodies");
    mkdirSync(bodyDir);
    const token = "body-capture-seed";
    const { fake } = start({ bodyDir, validRefreshTokens: [token] });
    const raw = '{\n  "tools": [ {} ], "input": "raw café body"\n}\n';
    const rawToken =
      '{\n  "grant_type": "refresh_token", "refresh_token": "body-capture-seed"\n}\n';

    await send(fake.origin, RESPONSE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    expect(fake.requests).toHaveLength(1);
    issued(
      await send(fake.origin, "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawToken,
      }),
      token
    );

    expect(fake.requests).toHaveLength(2);
    const expectedBodies: { kind: LoggedRequest["kind"]; raw: string }[] = [
      { kind: "main", raw },
      { kind: "token", raw: rawToken },
    ];
    for (const [index, expected] of expectedBodies.entries()) {
      const entry = fake.requests[index]!;
      // Verify that the public log cannot turn this test's read into a path escape.
      expect(Number.isInteger(entry.seq) && entry.seq >= 0).toBe(true);
      expect(entry.kind).toBe(expected.kind);
      const filename = String(entry.seq).padStart(3, "0") + "-" + expected.kind + ".json";
      expect(readFileSync(join(bodyDir, filename), "utf8")).toBe(expected.raw);
    }
  });
});

describe("fake OAuth token endpoint", () => {
  test("TEST-41 REQ-7.1 REQ-7.1a REQ-7.4 accepts and records a valid JSON exchange", async () => {
    const token = "seed with + and / and = and é";
    const { fake, logPath } = start({ validRefreshTokens: [token] });
    expect(fake.exchanges()).toEqual({ ok: 0, invalidGrant: 0 });

    issued(await exchange(fake, token), token);

    expect(fake.exchanges()).toEqual({ ok: 1, invalidGrant: 0 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/oauth/token",
      kind: "token",
      mainIndex: null,
      status: 200,
      exchange: { presented: token, outcome: "ok" },
    });
    expect(readRequests(logPath)).toEqual(fake.requests);
  });

  test("TEST-42 REQ-7.2 REQ-7.4 revokes each generation once for JSON exchanges", async () => {
    const { fake, logPath } = start({ validRefreshTokens: ["lineage-seed"] });

    const first = issued(await exchange(fake, "lineage-seed"), "lineage-seed");
    invalidGrant(await exchange(fake, "lineage-seed"));
    const second = issued(await exchange(fake, first.refresh), first.refresh);
    invalidGrant(await exchange(fake, first.refresh));
    const third = issued(await exchange(fake, second.refresh), second.refresh);

    expect(new Set([first.access, second.access, third.access]).size).toBe(3);
    expect(new Set(["lineage-seed", first.refresh, second.refresh, third.refresh]).size).toBe(4);
    expect(fake.exchanges()).toEqual({ ok: 3, invalidGrant: 2 });
    expect(fake.requests.map((entry) => entry.kind)).toEqual([
      "token",
      "token",
      "token",
      "token",
      "token",
    ]);
    expect(fake.requests.map((entry) => entry.exchange?.outcome)).toEqual([
      "ok",
      "invalid_grant",
      "ok",
      "invalid_grant",
      "ok",
    ]);
    expect(fake.requests.map((entry) => entry.exchange?.presented)).toEqual([
      "lineage-seed",
      "lineage-seed",
      first.refresh,
      first.refresh,
      second.refresh,
    ]);
    expect(readRequests(logPath)).toEqual(fake.requests);
  });

  test("TEST-43 REQ-7.3 REQ-7.4 rejects an unknown token and counts one invalid grant", async () => {
    const { fake, logPath } = start({ validRefreshTokens: ["listed-seed"] });

    invalidGrant(await exchange(fake, "not-listed"));

    expect(fake.exchanges()).toEqual({ ok: 0, invalidGrant: 1 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      kind: "token",
      mainIndex: null,
      status: 400,
      exchange: { presented: "not-listed", outcome: "invalid_grant" },
    });
    expect(readRequests(logPath)).toEqual(fake.requests);
  });

  test("TEST-44 REQ-7.1 REQ-7.2 preserves independent one-use validity for every configured seed", async () => {
    const { fake } = start({ validRefreshTokens: new Set(["seed-a", "seed-b"]) });

    issued(await exchange(fake, "seed-a"), "seed-a");
    issued(await exchange(fake, "seed-b"), "seed-b");
    invalidGrant(await exchange(fake, "seed-a"));
    invalidGrant(await exchange(fake, "seed-b"));

    expect(fake.exchanges()).toEqual({ ok: 2, invalidGrant: 2 });
  });

  test("TEST-45 REQ-7.5 forced invalid_grant rejects repeatedly without consuming the seed", async () => {
    const { fake } = start({
      validRefreshTokens: ["mode-seed"],
      tokenMode: "invalid_grant",
    });

    invalidGrant(await exchange(fake, "mode-seed"));
    invalidGrant(await exchange(fake, "mode-seed"));
    expect(fake.exchanges()).toEqual({ ok: 0, invalidGrant: 2 });
    fake.setTokenMode("ok");
    issued(await exchange(fake, "mode-seed"), "mode-seed");
    invalidGrant(await exchange(fake, "mode-seed"));

    expect(fake.exchanges()).toEqual({ ok: 1, invalidGrant: 3 });
    expect(fake.requests.map((entry) => entry.exchange?.outcome)).toEqual([
      "invalid_grant",
      "invalid_grant",
      "ok",
      "invalid_grant",
    ]);
  });

  test("TEST-46 REQ-7.5 setter toggles rejection and recovery after an accepted exchange", async () => {
    const { fake } = start({ validRefreshTokens: ["toggle-seed"] });
    const first = issued(await exchange(fake, "toggle-seed"), "toggle-seed");

    fake.setTokenMode("invalid_grant");
    invalidGrant(await exchange(fake, first.refresh));
    fake.setTokenMode("ok");
    issued(await exchange(fake, first.refresh), first.refresh);

    expect(fake.exchanges()).toEqual({ ok: 2, invalidGrant: 1 });
    expect(fake.requests.map((entry) => entry.exchange?.outcome)).toEqual([
      "ok",
      "invalid_grant",
      "ok",
    ]);
  });

  test.each(["option", "setter"] as const)(
    "TEST-47 REQ-7.6 delays both concurrent responses using the %s",
    async (source) => {
      const delayMs = 120;
      const { fake } = start({
        validRefreshTokens: ["delay-seed"],
        tokenDelayMs: source === "option" ? delayMs : 0,
      });
      if (source === "setter") fake.setTokenDelayMs(delayMs);
      async function timed(token: string) {
        const began = performance.now();
        const response = await exchange(fake, token);
        return { response, elapsed: performance.now() - began };
      }

      const [accepted, rejected] = await Promise.all([
        timed("delay-seed"),
        timed("unknown-delay-seed"),
      ]);

      issued(accepted.response, "delay-seed");
      invalidGrant(rejected.response);
      expect(accepted.elapsed).toBeGreaterThanOrEqual(delayMs);
      expect(rejected.elapsed).toBeGreaterThanOrEqual(delayMs);
      expect(fake.exchanges()).toEqual({ ok: 1, invalidGrant: 1 });
    }
  );

  test("TEST-48 REQ-7.2 REQ-7.4 accepts only one concurrent reuse of the same seed", async () => {
    const { fake } = start({ validRefreshTokens: ["race-seed"], tokenDelayMs: 40 });

    const responses = await Promise.all([exchange(fake, "race-seed"), exchange(fake, "race-seed")]);

    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 400]);
    for (const response of responses) {
      if (response.status === 200) issued(response, "race-seed");
      else invalidGrant(response);
    }
    expect(fake.exchanges()).toEqual({ ok: 1, invalidGrant: 1 });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map((entry) => entry.exchange?.outcome).sort()).toEqual([
      "invalid_grant",
      "ok",
    ]);
  });
});
