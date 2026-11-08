import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDevinCredentialsPathForTesting } from "./providers/devin/devin-credentials.js";
import {
  type SubscriptionModelListEnvelope,
  type SubscriptionModelsDeps,
  subscriptionModelsCommand,
} from "./subscription-models-command.js";

const CONFIGS_CAPTURE = new Uint8Array(
  await Bun.file(
    new URL("./test-fixtures/devin/GetCliModelConfigs.res.bin", import.meta.url)
  ).arrayBuffer()
);
const KEY = "devin-session-token$fake.jwt.value";
const JWT = "fake.jwt.value";
const SERVER = "https://devin.invalid";
const CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const TEAM_PATH = "/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings";
const CONFIGS_URL = SERVER + CONFIGS_PATH;
const TEAM_URL = SERVER + TEAM_PATH;
const NOW = Date.parse("2026-11-07T12:34:56.789Z");
const FETCHED_AT = new Date(NOW).toISOString();
const ARGV = ["models", "devin", "--raw", "--json"];
const USAGE = "usage: claudish subscription models antigravity|devin --raw --json\n";
const REFUSAL = "[claudish subscription] refused: output contained a credential value\n";
const INTERNAL = "[claudish subscription] internal error\n";
const ORDER = [
  "schema",
  "provider",
  "claudishVersion",
  "fetchedAt",
  "sourceUrl",
  "clientVersion",
  "tokenRefreshed",
  "httpStatus",
  "teamSettingsUrl",
  "teamSettingsHttpStatus",
  "failure",
  "body",
];
const ORIGINAL_FETCH = globalThis.fetch;
let originalEnv: Record<string, string | undefined>;
let tempDirectory: string;
let restoreSpies: Array<() => void>;
let directStdout: string[];
let directStderr: string[];
let stdinReads: number;

interface RequestRecord {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
  signal: AbortSignal | null;
}
type Responder = (request: RequestRecord) => Response | Promise<Response>;
interface Harness {
  deps: SubscriptionModelsDeps;
  stdout: string[];
  stderr: string[];
  foreignAuthCalls: number;
}

function harness(): Harness {
  const h: Harness = {
    deps: undefined as unknown as SubscriptionModelsDeps,
    stdout: [],
    stderr: [],
    foreignAuthCalls: 0,
  };
  h.deps = {
    platform: () => "linux",
    readStore: async () => {
      h.foreignAuthCalls++;
      throw new Error("Devin must not read the Antigravity credential store");
    },
    tokenDeps: () => {
      h.foreignAuthCalls++;
      throw new Error("Devin must not mint or refresh an Antigravity token");
    },
    now: () => NOW,
    httpTimeoutMs: 20,
    keychainDeadlineMs: 20,
    writeStdout: async (line) => {
      h.stdout.push(line);
    },
    writeStderr: (line) => {
      h.stderr.push(line);
    },
  };
  return h;
}

function capturedConfigs(): Response {
  return new Response(CONFIGS_CAPTURE.slice().buffer, {
    headers: { "content-type": "application/proto" },
  });
}

function installFetch(
  configs: Responder = capturedConfigs,
  team: Responder = () => new Response(null, { status: 200 })
): RequestRecord[] {
  const calls: RequestRecord[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const supplied = input instanceof Request ? input : undefined;
    const body =
      init?.body != null
        ? await new Response(init.body).arrayBuffer()
        : supplied
          ? await supplied.clone().arrayBuffer()
          : new ArrayBuffer(0);
    const record: RequestRecord = {
      url: supplied ? supplied.url : String(input),
      method: init?.method ?? supplied?.method ?? "GET",
      headers: new Headers(init?.headers ?? supplied?.headers),
      body: new Uint8Array(body),
      signal: init?.signal ?? supplied?.signal ?? null,
    };
    calls.push(record);
    const path = new URL(record.url).pathname;
    if (path.endsWith(CONFIGS_PATH)) return configs(record);
    if (path.endsWith(TEAM_PATH)) return team(record);
    throw new Error("Unexpected endpoint; the test never uses the real network");
  }) as typeof fetch;
  return calls;
}

function abortedFetch(request: RequestRecord): Promise<Response> {
  const signal = request.signal;
  if (!signal) throw new Error("The metadata request must carry an abort signal");
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException("metadata deadline", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

function stalledBody(request: RequestRecord): Response {
  const signal = request.signal;
  if (!signal) throw new Error("The metadata body must share the request deadline");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = () =>
          controller.error(new DOMException("metadata body deadline", "AbortError"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      },
    })
  );
}

function brokenBody(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("broken body " + KEY));
      },
    })
  );
}

function base(provider = true) {
  return {
    schema: "claudish.subscription-model-list.v1" as const,
    ...(provider ? { provider: "devin" as const } : {}),
    claudishVersion: expect.any(String),
    tokenRefreshed: false,
  };
}

function attempted() {
  return { sourceUrl: CONFIGS_URL, clientVersion: expect.any(String) };
}

function configsAnswered() {
  return { ...attempted(), fetchedAt: FETCHED_AT, httpStatus: 200 };
}

function output(h: Harness): SubscriptionModelListEnvelope {
  expect(h.stdout.length).toBe(1);
  const line = h.stdout[0] ?? "";
  expect(line).toMatch(/^\{[^\r\n]*\}\n$/);
  const value = JSON.parse(line) as SubscriptionModelListEnvelope;
  expect(value.schema).toBe("claudish.subscription-model-list.v1");
  expect(typeof value.claudishVersion).toBe("string");
  expect(value.claudishVersion.length).toBeGreaterThan(0);
  expect(value.tokenRefreshed).toBe(false);
  let previous = -1;
  for (const key of Object.keys(value)) {
    const index = ORDER.indexOf(key);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
  expect(value).not.toHaveProperty("clientVersionSource");
  for (const secret of [KEY, JWT]) {
    expect(line.includes(secret)).toBe(false);
    expect([...h.stderr, ...directStderr].join("").includes(secret)).toBe(false);
  }
  expect(directStdout.length).toBe(0);
  expect(stdinReads).toBe(0);
  expect(h.foreignAuthCalls).toBe(0);
  return value;
}

// A reader only: response protobuf is always captured bytes or an empty body.
interface Field {
  number: number;
  wire: number;
  data?: Uint8Array;
}
function fields(bytes: Uint8Array): Field[] {
  let cursor = 0;
  const result: Field[] = [];
  function varint(): number {
    let value = 0;
    let shift = 0;
    while (cursor < bytes.length && shift <= 49) {
      const byte = bytes[cursor++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
      shift += 7;
    }
    throw new Error("Truncated request varint");
  }
  while (cursor < bytes.length) {
    const key = varint();
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (!number) throw new Error("Not a bare protobuf message");
    if (wire === 0) {
      varint();
      result.push({ number, wire });
    } else {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (length < 0 || cursor + length > bytes.length) throw new Error("Invalid protobuf field");
      result.push({ number, wire, data: bytes.subarray(cursor, cursor + length) });
      cursor += length;
    }
  }
  return result;
}

function stringField(message: Field[], number: number): string {
  const field = message.find((item) => item.number === number && item.wire === 2);
  if (!field?.data) throw new Error("Missing request string field " + number);
  return new TextDecoder().decode(field.data);
}

function assertUnary(request: RequestRecord, version: string): void {
  expect(request.method).toBe("POST");
  expect(request.headers.get("content-type")).toBe("application/proto");
  const metadataBytes = fields(request.body).find((item) => item.number === 1)?.data;
  if (!metadataBytes) throw new Error("Missing unary metadata");
  const metadata = fields(metadataBytes);
  expect(metadata.map((item) => item.number)).toEqual([1, 2, 3, 4, 5, 7]);
  expect(stringField(metadata, 1)).toBe("chisel");
  expect(stringField(metadata, 2)).toBe(version);
  expect(stringField(metadata, 3)).toBe(KEY);
  expect(stringField(metadata, 4)).toBe("en");
  expect(stringField(metadata, 5)).toBe(process.platform);
  expect(stringField(metadata, 7)).toBe(version);
}

beforeEach(() => {
  originalEnv = {
    WINDSURF_API_KEY: process.env.WINDSURF_API_KEY,
    WINDSURF_API_SERVER_URL: process.env.WINDSURF_API_SERVER_URL,
  };
  tempDirectory = mkdtempSync(join(tmpdir(), "claudish-devin-models-"));
  setDevinCredentialsPathForTesting(join(tempDirectory, "credentials-not-created.toml"));
  process.env.WINDSURF_API_KEY = KEY;
  process.env.WINDSURF_API_SERVER_URL = SERVER;
  directStdout = [];
  directStderr = [];
  stdinReads = 0;
  restoreSpies = [];
  for (const [stream, sink] of [
    [process.stdout, directStdout],
    [process.stderr, directStderr],
  ] as const) {
    const spy = spyOn(stream, "write").mockImplementation((...args: unknown[]) => {
      sink.push(String(args[0]));
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") callback();
      return true;
    });
    restoreSpies.push(() => spy.mockRestore());
  }
  const inputSpy = spyOn(process.stdin, "read").mockImplementation(() => {
    stdinReads++;
    throw new Error("An argv-only command must not read stdin");
  });
  restoreSpies.push(() => inputSpy.mockRestore());
  installFetch();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const restore of restoreSpies.reverse()) restore();
  setDevinCredentialsPathForTesting(null);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("subscription models devin", () => {
  const badArgv: Array<{ name: string; argv: string[] }> = [
    { name: "no arguments", argv: [] },
    { name: "missing provider", argv: ["models", "--raw", "--json"] },
    { name: "dv shortcut", argv: ["models", "dv", "--raw", "--json"] },
    { name: "ag shortcut", argv: ["models", "ag", "--raw", "--json"] },
    { name: "uppercase provider", argv: ["models", "Devin", "--raw", "--json"] },
    { name: "missing --raw", argv: ["models", "devin", "--json"] },
    { name: "missing --json", argv: ["models", "devin", "--raw"] },
    { name: "duplicate --raw", argv: [...ARGV, "--raw"] },
    { name: "duplicate --json", argv: [...ARGV, "--json"] },
    { name: "unknown flag", argv: [...ARGV, "--verbose"] },
    { name: "extra positional", argv: [...ARGV, "extra"] },
    { name: "wrong command", argv: ["probe", "devin", "--raw", "--json"] },
    { name: "joined flag value", argv: ["models", "devin", "--raw=true", "--json"] },
    { name: "option terminator", argv: [...ARGV, "--"] },
    { name: "second provider", argv: [...ARGV, "devin"] },
  ];
  for (const { name, argv } of badArgv) {
    test("usage: " + name, async () => {
      const h = harness();
      const calls = installFetch();
      expect(await subscriptionModelsCommand(argv, h.deps)).toBe(2);
      expect(output(h)).toEqual({
        ...base(false),
        failure: { class: "internal", code: "usage" },
      });
      expect(h.stderr).toEqual([USAGE]);
      expect(calls.length).toBe(0);
    });
  }

  for (const [index, argv] of [
    ["models", "devin", "--json", "--raw"],
    ["--json", "models", "--raw", "devin"],
  ].entries()) {
    test("accepts permitted flag ordering " + (index + 1), async () => {
      const h = harness();
      const calls = installFetch(() => new Response("not printed", { status: 401 }));
      expect(await subscriptionModelsCommand(argv, h.deps)).toBe(0);
      const line = output(h);
      expect(line).toEqual({
        ...base(),
        ...attempted(),
        fetchedAt: FETCHED_AT,
        httpStatus: 401,
      });
      expect(calls.map((request) => request.url)).toEqual([CONFIGS_URL]);
      assertUnary(calls[0]!, line.clientVersion!);
      expect(h.stderr).toEqual([]);
    });
  }

  test("missing credential exits before either RPC", async () => {
    delete process.env.WINDSURF_API_KEY;
    const h = harness();
    const calls = installFetch();
    expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(3);
    expect(output(h)).toEqual({
      ...base(),
      failure: { class: "credential_missing", code: "devin_credential_absent" },
    });
    expect(calls.length).toBe(0);
    expect(h.stderr).toEqual([]);
  });

  for (const status of [302, 401, 429, 503]) {
    test("configs HTTP " + status + " is a complete status-only answer", async () => {
      const h = harness();
      const calls = installFetch(
        () =>
          new Response("ignored vendor echo " + KEY, {
            status,
            headers: { location: "https://must-not-follow.invalid", "x-echo": JWT },
          })
      );
      expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(0);
      expect(output(h)).toEqual({
        ...base(),
        ...attempted(),
        fetchedAt: FETCHED_AT,
        httpStatus: status,
      });
      expect(calls.length).toBe(1);
      expect(h.stderr).toEqual([]);
    });
  }

  for (const status of [200, 204]) {
    test("configs HTTP " + status + " without rows is configs_empty", async () => {
      const h = harness();
      const calls = installFetch(() => new Response(null, { status }));
      expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(7);
      expect(output(h)).toEqual({
        ...base(),
        ...attempted(),
        fetchedAt: FETCHED_AT,
        httpStatus: status,
        failure: { class: "list_incomplete", code: "configs_empty", httpStatus: status },
      });
      expect(calls.length).toBe(1);
    });
  }

  for (const stage of ["fetch", "read"] as const) {
    test("configs " + stage + " failure is a network failure", async () => {
      const h = harness();
      const calls = installFetch(() => {
        if (stage === "read") return brokenBody();
        throw new TypeError("unreachable " + KEY);
      });
      expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(6);
      const line = output(h);
      expect(line.failure).toEqual({
        class: "network",
        code: "model_configs_network_error",
        ...(stage === "read" ? { httpStatus: 200 } : {}),
      });
      expect(line.sourceUrl).toBe(CONFIGS_URL);
      expect(line.clientVersion).toEqual(expect.any(String));
      expect(line).not.toHaveProperty("body");
      expect(line).not.toHaveProperty("teamSettingsUrl");
      expect(line).not.toHaveProperty("teamSettingsHttpStatus");
      if (stage === "fetch") {
        expect(line).not.toHaveProperty("fetchedAt");
        expect(line).not.toHaveProperty("httpStatus");
      } else {
        expect(line.fetchedAt).toBe(FETCHED_AT);
        expect(line.httpStatus).toBe(200);
      }
      expect(calls.length).toBe(1);
    });
  }

  for (const stage of ["fetch", "read"] as const) {
    test("configs " + stage + " deadline is model_configs_timeout", async () => {
      const h = harness();
      const calls = installFetch(stage === "fetch" ? abortedFetch : stalledBody);
      expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(6);
      const line = output(h);
      expect(line.failure).toEqual({
        class: "network",
        code: "model_configs_timeout",
        ...(stage === "read" ? { httpStatus: 200 } : {}),
      });
      expect(line).not.toHaveProperty("body");
      expect(line).not.toHaveProperty("teamSettingsUrl");
      expect(calls.length).toBe(1);
      expect(calls[0]!.signal?.aborted).toBe(true);
      if (stage === "fetch") {
        expect(line).not.toHaveProperty("httpStatus");
        expect(line).not.toHaveProperty("fetchedAt");
      } else {
        expect(line.httpStatus).toBe(200);
        expect(line.fetchedAt).toBe(FETCHED_AT);
      }
    });
  }

  for (const stage of ["fetch", "read"] as const) {
    test("team settings " + stage + " failure preserves the configs answer", async () => {
      const h = harness();
      const calls = installFetch(capturedConfigs, () => {
        if (stage === "read") return brokenBody();
        throw new TypeError("team unreachable " + JWT);
      });
      expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(6);
      expect(output(h)).toEqual({
        ...base(),
        ...configsAnswered(),
        teamSettingsUrl: TEAM_URL,
        ...(stage === "read" ? { teamSettingsHttpStatus: 200 } : {}),
        failure: {
          class: "network",
          code: "team_settings_network_error",
          ...(stage === "read" ? { httpStatus: 200 } : {}),
        },
      });
      expect(calls.map((request) => request.url)).toEqual([CONFIGS_URL, TEAM_URL]);
    });
  }

  for (const stage of ["fetch", "read"] as const) {
    test("team settings " + stage + " deadline is team_settings_timeout", async () => {
      const h = harness();
      const calls = installFetch(capturedConfigs, stage === "fetch" ? abortedFetch : stalledBody);
      expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(6);
      expect(output(h)).toEqual({
        ...base(),
        ...configsAnswered(),
        teamSettingsUrl: TEAM_URL,
        ...(stage === "read" ? { teamSettingsHttpStatus: 200 } : {}),
        failure: {
          class: "network",
          code: "team_settings_timeout",
          ...(stage === "read" ? { httpStatus: 200 } : {}),
        },
      });
      expect(calls.length).toBe(2);
      expect(calls[1]!.signal?.aborted).toBe(true);
    });
  }

  for (const status of [401, 429, 503]) {
    test("team settings HTTP " + status + " is an incomplete list", async () => {
      const h = harness();
      const calls = installFetch(capturedConfigs, () => new Response("not model data", { status }));
      expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(7);
      const line = output(h);
      expect(line).toEqual({
        ...base(),
        ...configsAnswered(),
        teamSettingsUrl: TEAM_URL,
        teamSettingsHttpStatus: status,
        failure: { class: "list_incomplete", code: "team_settings_http_error", httpStatus: status },
      });
      expect(calls.length).toBe(2);
      for (const request of calls) assertUnary(request, line.clientVersion!);
    });
  }

  for (const status of [200, 204]) {
    test("team settings HTTP " + status + " without allowed uids is incomplete", async () => {
      const h = harness();
      const calls = installFetch(capturedConfigs, () => new Response(null, { status }));
      expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(7);
      expect(output(h)).toEqual({
        ...base(),
        ...configsAnswered(),
        teamSettingsUrl: TEAM_URL,
        teamSettingsHttpStatus: status,
        failure: { class: "list_incomplete", code: "allowed_uids_empty", httpStatus: status },
      });
      expect(calls.length).toBe(2);
    });
  }

  test("honours the server override while stripping URL userinfo", async () => {
    process.env.WINDSURF_API_SERVER_URL = "https://safe-user:safe-password@devin.invalid/bridge";
    const h = harness();
    const calls = installFetch(capturedConfigs, () => new Response(null, { status: 200 }));
    expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(7);
    const line = output(h);
    expect(line.sourceUrl).toBe(SERVER + "/bridge" + CONFIGS_PATH);
    expect(line.teamSettingsUrl).toBe(SERVER + "/bridge" + TEAM_PATH);
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
      "/bridge" + CONFIGS_PATH,
      "/bridge" + TEAM_PATH,
    ]);
    expect(h.stdout[0]!.includes("safe-user")).toBe(false);
    expect(h.stdout[0]!.includes("safe-password")).toBe(false);
  });

  test("uses server.codeium.com when no server override is set", async () => {
    delete process.env.WINDSURF_API_SERVER_URL;
    const h = harness();
    const calls = installFetch(() => new Response(null, { status: 403 }));
    expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(0);
    expect(output(h).sourceUrl).toBe("https://server.codeium.com" + CONFIGS_PATH);
    expect(calls.map((request) => request.url)).toEqual([
      "https://server.codeium.com" + CONFIGS_PATH,
    ]);
  });

  for (const [name, value] of [
    ["full key", KEY],
    ["bare JWT", JWT],
  ]) {
    test("refuses a metadata line containing the " + name, async () => {
      process.env.WINDSURF_API_SERVER_URL = SERVER + "/" + value;
      const h = harness();
      installFetch(() => new Response(null, { status: 401 }));
      expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(1);
      const line = output(h);
      expect(line.failure).toEqual({ class: "internal", code: "secret_guard" });
      expect(line).not.toHaveProperty("body");
      expect(h.stderr).toEqual([REFUSAL]);
    });
  }

  test("unexpected exceptions produce the fixed internal failure", async () => {
    const h = harness();
    installFetch(() => new Response(null, { status: 401 }));
    h.deps.now = () => {
      throw new Error("clock failed " + KEY);
    };
    expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(1);
    const line = output(h);
    expect(line.failure).toEqual({ class: "internal", code: "internal_error" });
    expect(line).not.toHaveProperty("body");
    expect(h.stderr).toEqual([INTERNAL]);
  });

  test("waits for its single stdout write to flush", async () => {
    const h = harness();
    installFetch(() => new Response(null, { status: 401 }));
    let release!: () => void;
    let entered!: () => void;
    let returned = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.deps.writeStdout = async (line) => {
      h.stdout.push(line);
      entered();
      await gate;
    };
    const running = subscriptionModelsCommand(ARGV, h.deps).then((code) => {
      returned = true;
      return code;
    });
    await writing;
    expect(returned).toBe(false);
    release();
    expect(await running).toBe(0);
    expect(output(h).httpStatus).toBe(401);
  });

  test("returns unfiltered configs and allowed uids from the real captures", async () => {
    const team = new Uint8Array(
      await Bun.file(
        new URL("./test-fixtures/devin/GetCliTeamSettings.res.bin", import.meta.url)
      ).arrayBuffer()
    );
    const h = harness();
    const calls = installFetch(capturedConfigs, () => new Response(team.slice().buffer));
    expect(await subscriptionModelsCommand(ARGV, h.deps)).toBe(0);
    const line = output(h);
    const { body, ...envelope } = line;
    expect(envelope).toEqual({
      ...base(),
      ...configsAnswered(),
      teamSettingsUrl: TEAM_URL,
      teamSettingsHttpStatus: 200,
    });
    expect(typeof body).toBe("string");
    const parsed = JSON.parse(body!) as {
      configs: { uid: string; contextWindow: number }[];
      allowedModelUids: string[];
    };
    expect(Object.keys(parsed).sort()).toEqual(["allowedModelUids", "configs"]);
    // The capture README: 173 configs, 170 with a non-zero context window. Unfiltered.
    expect(parsed.configs.length).toBe(173);
    expect(parsed.configs.filter((c) => c.contextWindow === 0).length).toBe(3);
    expect(parsed.allowedModelUids.length).toBe(260);
    expect(parsed.allowedModelUids.every((uid) => /^[a-z0-9][a-z0-9.-]*$/i.test(uid))).toBe(true);
    expect(h.stdout[0]!.includes(JWT)).toBe(false);
    expect(calls.map((request) => request.url)).toEqual([CONFIGS_URL, TEAM_URL]);
  });
});
