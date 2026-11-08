import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as credentials from "./providers/devin/devin-credentials.js";
import {
  type SubscriptionProbeDeps,
  type SubscriptionProbeEnvelope,
  subscriptionProbeCommand,
} from "./subscription-probe-command.js";

const CLEAN_CAPTURE = new Uint8Array(
  await Bun.file(
    new URL("./test-fixtures/devin/GetChatMessage-claude-haiku-5-5-low.res.bin", import.meta.url)
  ).arrayBuffer()
);
const ERROR_CAPTURE = new Uint8Array(
  await Bun.file(
    new URL("./test-fixtures/devin/GetChatMessage-claude-opus-99.res.bin", import.meta.url)
  ).arrayBuffer()
);
const KEY = "devin-session-token$fake.jwt.value";
const JWT = "fake.jwt.value";
const SERVER = "https://devin.invalid";
const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const CHAT_URL = SERVER + CHAT_PATH;
const MODEL = "claude-haiku-5-5-low";
const NOW = Date.parse("2026-11-07T12:34:56.789Z");
const FETCHED_AT = new Date(NOW).toISOString();
const BODY_CAP = 512 * 1024;
const REQUEST_CAP = 8 * 1024 * 1024;
const USAGE =
  "usage: claudish subscription probe antigravity|devin --model <wire-model-id> --request-file <path> --raw --json\n";
const FILE_MESSAGE =
  "[claudish subscription] the request file must hold one JSON object (an Anthropic Messages request)\n";
const REFUSAL = "[claudish subscription] refused: output contained a credential value\n";
const INTERNAL = "[claudish subscription] internal error\n";
const ORDER = [
  "schema",
  "provider",
  "claudishVersion",
  "model",
  "fetchedAt",
  "sourceUrl",
  "clientVersion",
  "tokenRefreshed",
  "httpStatus",
  "servedModel",
  "streamError",
  "failure",
  "bodyRedacted",
  "body",
];
const ORIGINAL_FETCH = globalThis.fetch;
const DECODER = new TextDecoder();
let originalEnv: Record<string, string | undefined>;
let tempDirectory: string;
let requestPath: string;
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
  redirect: RequestRedirect | undefined;
}
type Responder = (request: RequestRecord) => Response | Promise<Response>;
interface Harness {
  deps: SubscriptionProbeDeps;
  stdout: string[];
  stderr: string[];
  requestReads: string[];
  foreignAuthCalls: number;
}
interface Message {
  id: string;
  type: string;
  role: string;
  model: string;
  content: Array<{ type: string; text?: string; thinking?: string }>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// Independent read-only protobuf inspection; no response protobuf is constructed.
interface Field {
  number: number;
  wire: number;
  data?: Uint8Array;
  value?: number;
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
    throw new Error("Truncated protobuf varint");
  }
  while (cursor < bytes.length) {
    const key = varint();
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (!number) throw new Error("Invalid protobuf tag");
    if (wire === 0) {
      result.push({ number, wire, value: varint() });
    } else {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (length < 0 || cursor + length > bytes.length) throw new Error("Invalid protobuf length");
      result.push({ number, wire, data: bytes.subarray(cursor, cursor + length) });
      cursor += length;
    }
  }
  return result;
}

function nested(field: Field): Field[] {
  if (!field.data) throw new Error("Expected a length-delimited nested message");
  return fields(field.data);
}
function stringField(message: Field[], number: number): string | undefined {
  const field = message.find((item) => item.number === number && item.wire === 2);
  return field?.data ? DECODER.decode(field.data) : undefined;
}
interface Frame {
  flags: number;
  raw: Uint8Array;
  payload: Uint8Array;
}
function frames(bytes: Uint8Array): Frame[] {
  const result: Frame[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    if (cursor + 5 > bytes.length) throw new Error("Incomplete captured Connect header");
    const length = new DataView(bytes.buffer, bytes.byteOffset + cursor + 1, 4).getUint32(0);
    const end = cursor + 5 + length;
    if (end > bytes.length) throw new Error("Incomplete captured Connect frame");
    result.push({
      flags: bytes[cursor]!,
      raw: bytes.subarray(cursor, end),
      payload: bytes.subarray(cursor + 5, end),
    });
    cursor = end;
  }
  return result;
}
function concatenate(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return bytes;
}

const CLEAN_FRAMES = frames(CLEAN_CAPTURE);
const CLEAN_MESSAGES = CLEAN_FRAMES.filter((frame) => frame.flags === 0).map((frame) =>
  fields(frame.payload)
);
const EXPECTED_TEXT = CLEAN_MESSAGES.map((message) => stringField(message, 3) ?? "").join("");
const EXPECTED_THINKING = CLEAN_MESSAGES.map((message) => stringField(message, 9) ?? "").join("");
const EXPECTED_SERVED = CLEAN_MESSAGES.flat()
  .filter((field) => field.number === 7 && field.wire === 2)
  .map((field) => stringField(nested(field), 9))
  .find((value) => value !== undefined);
const ERROR_FRAME = frames(ERROR_CAPTURE).find((frame) => frame.flags === 2);
if (!ERROR_FRAME) throw new Error("The supplied error capture lacks its Connect error frame");
const EXPECTED_ERROR = JSON.parse(DECODER.decode(ERROR_FRAME.payload)) as {
  error: { code: string; message: string };
};

function capturedCounters(): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const message of CLEAN_MESSAGES) {
    for (const group of message.filter((field) => field.number === 28 && field.wire === 2)) {
      for (const row of nested(group).filter((field) => field.number === 2 && field.wire === 2)) {
        const entry = nested(row);
        const name = stringField(entry, 5);
        const metric = entry.find((field) => field.number === 4 && field.wire === 2);
        if (!name || !metric) continue;
        const numeric = nested(metric).find((field) => field.number === 2 && field.wire === 5);
        counters[name] = numeric?.data
          ? new DataView(numeric.data.buffer, numeric.data.byteOffset, 4).getFloat32(0, true)
          : 0;
      }
    }
  }
  return counters;
}
const EXPECTED_COUNTERS = capturedCounters();

function harness(): Harness {
  const h: Harness = {
    deps: undefined as unknown as SubscriptionProbeDeps,
    stdout: [],
    stderr: [],
    requestReads: [],
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
    requestTimeoutMs: 1_000,
    readRequestFile: async (path) => {
      h.requestReads.push(path);
      const file = Bun.file(path);
      if (file.size > REQUEST_CAP) return null;
      return file.text();
    },
    writeStdout: async (line) => {
      h.stdout.push(line);
    },
    writeStderr: (line) => {
      h.stderr.push(line);
    },
  };
  return h;
}

function args(model = MODEL, file = requestPath): string[] {
  return ["probe", "devin", "--model", model, "--request-file", file, "--raw", "--json"];
}
function request(effort?: string): Record<string, unknown> {
  return {
    model: "ignored-file-model",
    max_tokens: 1024,
    system: "Answer the question directly.",
    messages: [{ role: "user", content: "What is two plus two?" }],
    ...(effort === undefined ? {} : { output_config: { effort } }),
  };
}
function capturedClean(): Response {
  return new Response(CLEAN_CAPTURE.slice().buffer, {
    headers: { "content-type": "application/connect+proto" },
  });
}

function installFetch(respond: Responder = capturedClean): RequestRecord[] {
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
      redirect: init?.redirect ?? supplied?.redirect,
    };
    calls.push(record);
    if (!new URL(record.url).pathname.endsWith(CHAT_PATH)) {
      throw new Error("The probe must not perform discovery, retries, or other requests");
    }
    return respond(record);
  }) as typeof fetch;
  return calls;
}

function forbidCredentialRead() {
  const spy = spyOn(credentials, "readDevinApiKey").mockImplementation(() => {
    throw new Error("The request file must be validated before credentials are read");
  });
  restoreSpies.push(() => spy.mockRestore());
  return spy;
}

function base(model = MODEL, parsed = true) {
  return {
    schema: "claudish.subscription-probe.v1" as const,
    ...(parsed ? { provider: "devin" as const, model } : {}),
    claudishVersion: expect.any(String),
    tokenRefreshed: false,
  };
}
function attempted() {
  return { sourceUrl: CHAT_URL, clientVersion: expect.any(String) };
}
function answered(status = 200) {
  return { ...attempted(), fetchedAt: FETCHED_AT, httpStatus: status };
}
function output(h: Harness): SubscriptionProbeEnvelope {
  expect(h.stdout.length).toBe(1);
  const line = h.stdout[0] ?? "";
  expect(line).toMatch(/^\{[^\r\n]*\}\n$/);
  const value = JSON.parse(line) as SubscriptionProbeEnvelope;
  expect(value.schema).toBe("claudish.subscription-probe.v1");
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
  const activeKey = process.env.WINDSURF_API_KEY;
  const secrets = new Set([KEY, JWT]);
  if (activeKey) {
    secrets.add(activeKey);
    if (activeKey.startsWith("devin-session-token$")) {
      secrets.add(activeKey.slice("devin-session-token$".length));
    }
  }
  for (const secret of secrets) {
    expect(line.includes(secret)).toBe(false);
    expect([...h.stderr, ...directStderr].join("").includes(secret)).toBe(false);
  }
  expect(directStdout.length).toBe(0);
  expect(stdinReads).toBe(0);
  expect(h.foreignAuthCalls).toBe(0);
  return value;
}
function message(envelope: SubscriptionProbeEnvelope): Message {
  expect(typeof envelope.body).toBe("string");
  return JSON.parse(envelope.body!) as Message;
}
function text(body: Message): string {
  return body.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}
function assertCapturedAnswer(envelope: SubscriptionProbeEnvelope): void {
  expect(envelope).toEqual({
    ...base(),
    ...answered(),
    servedModel: EXPECTED_SERVED,
    bodyRedacted: false,
    body: expect.any(String),
  });
  const body = message(envelope);
  expect(body.type).toBe("message");
  expect(body.role).toBe("assistant");
  expect(typeof body.id).toBe("string");
  expect(body.id.length).toBeGreaterThan(0);
  expect(body.model).toBe(MODEL);
  expect(text(body)).toBe(EXPECTED_TEXT);
  expect(EXPECTED_TEXT.length).toBeGreaterThan(0);
  expect(
    body.content
      .filter((part) => part.type === "thinking")
      .map((part) => part.thinking ?? "")
      .join("")
  ).toBe(EXPECTED_THINKING);
  expect(EXPECTED_THINKING.length).toBeGreaterThan(0);
  expect(body.stop_reason).toBe("end_turn");
  expect(body.stop_sequence).toBeNull();
  expect(body.usage.input_tokens).toBe(EXPECTED_COUNTERS.input_tokens);
  expect(body.usage.output_tokens).toBe(EXPECTED_COUNTERS.output_tokens);
  expect(Object.keys(body.usage).sort()).toEqual(["input_tokens", "output_tokens"]);
}

function wireUid(record: RequestRecord): string | undefined {
  const encoded = frames(record.body);
  expect(encoded.length).toBe(1);
  expect(encoded[0]!.flags).toBe(0);
  const uidFields = fields(encoded[0]!.payload).filter((field) => field.number === 21);
  expect(uidFields.length).toBe(1);
  expect(uidFields[0]!.wire).toBe(2);
  return uidFields[0]!.data ? DECODER.decode(uidFields[0]!.data) : undefined;
}

function abortedFetch(record: RequestRecord): Promise<Response> {
  const signal = record.signal;
  if (!signal) throw new Error("The probe must carry an abort signal");
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException("probe deadline", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}
function stalledBody(record: RequestRecord, status: number): Response {
  const signal = record.signal;
  if (!signal) throw new Error("The response body must share the request deadline");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = () => controller.error(new DOMException("probe body deadline", "AbortError"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      },
    }),
    { status }
  );
}
function brokenBody(): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(CLEAN_FRAMES[0]!.raw.slice());
        } else {
          controller.error(new TypeError("broken stream " + KEY));
        }
      },
    }),
    { headers: { "content-type": "application/connect+proto" } }
  );
}

beforeEach(async () => {
  originalEnv = {
    WINDSURF_API_KEY: process.env.WINDSURF_API_KEY,
    WINDSURF_API_SERVER_URL: process.env.WINDSURF_API_SERVER_URL,
  };
  tempDirectory = mkdtempSync(join(tmpdir(), "claudish-devin-probe-"));
  requestPath = join(tempDirectory, "request.json");
  await Bun.write(requestPath, JSON.stringify(request()));
  credentials.setDevinCredentialsPathForTesting(
    join(tempDirectory, "credentials-not-created.toml")
  );
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
  credentials.setDevinCredentialsPathForTesting(null);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("subscription probe devin", () => {
  const badArgv: Array<{ name: string; argv: () => string[] }> = [
    { name: "no arguments", argv: () => [] },
    { name: "dv shortcut", argv: () => ["probe", "dv", ...args().slice(2)] },
    { name: "ag shortcut", argv: () => ["probe", "ag", ...args().slice(2)] },
    { name: "missing --raw", argv: () => args().filter((token) => token !== "--raw") },
    { name: "missing --json", argv: () => args().filter((token) => token !== "--json") },
    { name: "duplicate --raw", argv: () => [...args(), "--raw"] },
    { name: "duplicate --json", argv: () => [...args(), "--json"] },
    { name: "duplicate --model", argv: () => [...args(), "--model", MODEL] },
    { name: "duplicate --request-file", argv: () => [...args(), "--request-file", requestPath] },
    { name: "missing model value", argv: () => args().filter((token) => token !== MODEL) },
    {
      name: "missing request-file value",
      argv: () => args().filter((token) => token !== requestPath),
    },
    { name: "model value begins with -", argv: () => args("-not-a-uid") },
    { name: "file value begins with -", argv: () => args(MODEL, "-not-a-path") },
    {
      name: "joined --model value",
      argv: () => [
        "probe",
        "devin",
        "--model=" + MODEL,
        "--request-file",
        requestPath,
        "--raw",
        "--json",
      ],
    },
    {
      name: "joined --request-file value",
      argv: () => [
        "probe",
        "devin",
        "--model",
        MODEL,
        "--request-file=" + requestPath,
        "--raw",
        "--json",
      ],
    },
    { name: "unknown flag", argv: () => [...args(), "--retry"] },
    { name: "extra positional", argv: () => [...args(), "extra"] },
  ];
  for (const { name, argv } of badArgv) {
    test("usage: " + name, async () => {
      const h = harness();
      const calls = installFetch();
      const credentialSpy = forbidCredentialRead();
      expect(await subscriptionProbeCommand(argv(), h.deps)).toBe(2);
      expect(output(h)).toEqual({
        ...base(MODEL, false),
        failure: { class: "internal", code: "usage" },
      });
      expect(h.stderr).toEqual([USAGE]);
      expect(h.requestReads.length).toBe(0);
      expect(credentialSpy).not.toHaveBeenCalled();
      expect(calls.length).toBe(0);
    });
  }

  test("accepts flags in a different order", async () => {
    const h = harness();
    const calls = installFetch();
    expect(
      await subscriptionProbeCommand(
        ["probe", "devin", "--json", "--request-file", requestPath, "--raw", "--model", MODEL],
        h.deps
      )
    ).toBe(0);
    assertCapturedAnswer(output(h));
    expect(h.requestReads).toEqual([requestPath]);
    expect(calls.length).toBe(1);
  });

  test("unreadable request file is rejected before any credential read", async () => {
    const h = harness();
    const calls = installFetch();
    const credentialSpy = forbidCredentialRead();
    const missing = join(tempDirectory, "not-created.json");
    expect(await subscriptionProbeCommand(args(MODEL, missing), h.deps)).toBe(2);
    expect(output(h)).toEqual({
      ...base(),
      failure: { class: "internal", code: "request_file_unreadable" },
    });
    expect(h.stderr).toEqual([FILE_MESSAGE]);
    expect(h.requestReads).toEqual([missing]);
    expect(credentialSpy).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  for (const [name, contents] of [
    ["empty file", ""],
    ["malformed JSON", "not JSON"],
    ["array", "[]"],
    ["null", "null"],
    ["number", "42"],
    ["boolean", "true"],
    ["string", '"a string"'],
    ["two JSON objects", "{}\n{}"],
  ]) {
    test("invalid request file: " + name, async () => {
      await Bun.write(requestPath, contents!);
      const h = harness();
      const calls = installFetch();
      const credentialSpy = forbidCredentialRead();
      expect(await subscriptionProbeCommand(args(), h.deps)).toBe(2);
      expect(output(h)).toEqual({
        ...base(),
        failure: { class: "internal", code: "request_file_invalid" },
      });
      expect(h.stderr).toEqual([FILE_MESSAGE]);
      expect(h.requestReads).toEqual([requestPath]);
      expect(credentialSpy).not.toHaveBeenCalled();
      expect(calls.length).toBe(0);
    });
  }

  test("over-cap request file is rejected before credentials or HTTP", async () => {
    await Bun.write(
      requestPath,
      JSON.stringify({ ...request(), padding: "x".repeat(REQUEST_CAP) })
    );
    const h = harness();
    const calls = installFetch();
    const credentialSpy = forbidCredentialRead();
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(2);
    expect(output(h)).toEqual({
      ...base(),
      failure: { class: "internal", code: "request_file_invalid" },
    });
    expect(h.stderr).toEqual([FILE_MESSAGE]);
    expect(credentialSpy).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  test("missing credential is reported only after reading a valid request", async () => {
    delete process.env.WINDSURF_API_KEY;
    const h = harness();
    const calls = installFetch();
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(3);
    expect(output(h)).toEqual({
      ...base(),
      failure: { class: "credential_missing", code: "devin_credential_absent" },
    });
    expect(h.requestReads).toEqual([requestPath]);
    expect(calls.length).toBe(0);
    expect(h.stderr).toEqual([]);
  });

  test("decodes the real clean capture, including thinking and field-28 usage", async () => {
    const h = harness();
    const calls = installFetch();
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    assertCapturedAnswer(output(h));
    expect(h.stderr).toEqual([]);
    expect(h.requestReads).toEqual([requestPath]);
    expect(calls.length).toBe(1);
    const sent = calls[0]!;
    expect(sent.url).toBe(CHAT_URL);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toBe("application/connect+proto");
    expect(sent.redirect).toBe("manual");
    expect(sent.signal).not.toBeNull();
    expect(wireUid(sent)).toBe(MODEL);
  });

  test("decodes the same capture when chunks split frame headers and payloads", async () => {
    let cursor = 0;
    let index = 0;
    const sizes = [1, 2, 3, 5, 13, 64];
    const h = harness();
    const calls = installFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (cursor === CLEAN_CAPTURE.length) {
                controller.close();
                return;
              }
              const end = Math.min(CLEAN_CAPTURE.length, cursor + sizes[index++ % sizes.length]!);
              controller.enqueue(CLEAN_CAPTURE.slice(cursor, end));
              cursor = end;
            },
          }),
          { headers: { "content-type": "application/connect+proto" } }
        )
    );
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    assertCapturedAnswer(output(h));
    expect(calls.length).toBe(1);
  });

  for (const { uid, effort } of [
    { uid: "glm-5-2-1m", effort: "high" },
    { uid: MODEL, effort: "max" },
    { uid: "custom.uid:exact-tier", effort: "low" },
    { uid: "glm-5-2-1m", effort: undefined },
  ]) {
    test("field 21 is verbatim for " + uid + " with effort " + String(effort), async () => {
      await Bun.write(requestPath, JSON.stringify(request(effort)));
      const h = harness();
      const calls = installFetch();
      expect(await subscriptionProbeCommand(args(uid), h.deps)).toBe(0);
      const line = output(h);
      expect(line.model).toBe(uid);
      expect(line.servedModel).toBe(EXPECTED_SERVED);
      expect(line.failure).toBeUndefined();
      expect(calls.length).toBe(1);
      expect(wireUid(calls[0]!)).toBe(uid);
    });
  }

  test("does not substitute estimated usage when no field-28 frame is present", async () => {
    const withoutUsage = concatenate(
      CLEAN_FRAMES.filter(
        (frame) => frame.flags !== 0 || !fields(frame.payload).some((field) => field.number === 28)
      ).map((frame) => frame.raw)
    );
    const h = harness();
    const calls = installFetch(() => new Response(withoutUsage.slice().buffer));
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    const line = output(h);
    const body = message(line);
    expect(line.servedModel).toBe(EXPECTED_SERVED);
    expect(text(body)).toBe(EXPECTED_TEXT);
    expect(body.usage.input_tokens).toBe(0);
    expect(body.usage.output_tokens).toBe(0);
    expect(Object.keys(body.usage).sort()).toEqual(["input_tokens", "output_tokens"]);
    expect(calls.length).toBe(1);
  });

  test("omits servedModel when no captured frame reports field 7.9", async () => {
    const withoutMetadata = concatenate(
      CLEAN_FRAMES.filter(
        (frame) => frame.flags !== 0 || !fields(frame.payload).some((field) => field.number === 7)
      ).map((frame) => frame.raw)
    );
    const h = harness();
    const calls = installFetch(() => new Response(withoutMetadata.slice().buffer));
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    const line = output(h);
    expect(line).not.toHaveProperty("servedModel");
    expect(line.model).toBe(MODEL);
    expect(text(message(line))).toBe(EXPECTED_TEXT);
    expect(calls.length).toBe(1);
  });

  test("reports the real permission error inside HTTP 200 without retrying", async () => {
    const h = harness();
    const calls = installFetch(() => new Response(ERROR_CAPTURE.slice().buffer));
    expect(await subscriptionProbeCommand(args("claude-opus-99"), h.deps)).toBe(0);
    const line = output(h);
    expect(line).toEqual({
      ...base("claude-opus-99"),
      ...answered(),
      streamError: { code: EXPECTED_ERROR.error.code, retryable: false },
      bodyRedacted: false,
      body: expect.any(String),
    });
    expect(JSON.parse(line.body!)).toEqual(EXPECTED_ERROR);
    expect(calls.length).toBe(1);
    expect(h.stderr).toEqual([]);
  });

  test("a captured mid-stream error clears already received content", async () => {
    const firstTextIndex = CLEAN_FRAMES.findIndex(
      (frame) => frame.flags === 0 && fields(frame.payload).some((field) => field.number === 3)
    );
    expect(firstTextIndex).toBeGreaterThan(0);
    const interrupted = concatenate([
      ...CLEAN_FRAMES.slice(0, firstTextIndex + 1).map((frame) => frame.raw),
      ERROR_CAPTURE,
    ]);
    const h = harness();
    const calls = installFetch(() => new Response(interrupted.slice().buffer));
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    const line = output(h);
    expect(line.httpStatus).toBe(200);
    expect(line.streamError).toEqual({ code: EXPECTED_ERROR.error.code, retryable: false });
    expect(line).not.toHaveProperty("failure");
    expect(message(line).content).toEqual([]);
    expect(calls.length).toBe(1);
  });

  for (const status of [302, 401, 429, 503]) {
    test("HTTP " + status + " preserves response text and performs no retry", async () => {
      const vendorBody = "  provider evidence\nstatus=" + status + "\n";
      const h = harness();
      const calls = installFetch(
        () =>
          new Response(vendorBody, {
            status,
            headers: { location: "https://must-not-follow.invalid" },
          })
      );
      expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
      expect(output(h)).toEqual({
        ...base(),
        ...answered(status),
        bodyRedacted: false,
        body: vendorBody,
      });
      expect(calls.length).toBe(1);
      expect(calls[0]!.redirect).toBe("manual");
    });
  }

  test("redacts all full-key and bare-JWT echoes in an HTTP error body", async () => {
    const vendorBody = "key=" + KEY + "; jwt=" + JWT + "; repeated=" + KEY + "\n";
    const h = harness();
    const calls = installFetch(() => new Response(vendorBody, { status: 401 }));
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    expect(output(h)).toEqual({
      ...base(),
      ...answered(401),
      bodyRedacted: true,
      body: "key=[REDACTED]; jwt=[REDACTED]; repeated=[REDACTED]\n",
    });
    expect(calls.length).toBe(1);
  });

  test("redacts a credential echo decoded from a clean protobuf capture", async () => {
    const fragment = CLEAN_MESSAGES.map((entry) => stringField(entry, 3)).find(
      (value) => value !== undefined && value.length > 20
    );
    if (!fragment) throw new Error("The capture has no suitable text fragment");
    // The key reader trims its value, so the trimmed fragment is what signs and is redacted.
    const secret = fragment.trim();
    process.env.WINDSURF_API_KEY = secret;
    const h = harness();
    const calls = installFetch();
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    const line = output(h);
    expect(line.bodyRedacted).toBe(true);
    expect(text(message(line))).toBe(EXPECTED_TEXT.split(secret).join("[REDACTED]"));
    expect(calls.length).toBe(1);
  });

  test("redacts a credential echo decoded from the real stream error", async () => {
    process.env.WINDSURF_API_KEY = EXPECTED_ERROR.error.message;
    const h = harness();
    const calls = installFetch(() => new Response(ERROR_CAPTURE.slice().buffer));
    expect(await subscriptionProbeCommand(args("claude-opus-99"), h.deps)).toBe(0);
    const line = output(h);
    expect(line.streamError).toEqual({ code: EXPECTED_ERROR.error.code, retryable: false });
    expect(line.bodyRedacted).toBe(true);
    expect(JSON.parse(line.body!)).toEqual({
      error: { code: EXPECTED_ERROR.error.code, message: "[REDACTED]" },
    });
    expect(calls.length).toBe(1);
  });

  test("refuses a JSON-escaped bare JWT instead of emitting an encoded credential", async () => {
    const h = harness();
    installFetch(() => new Response('{"error":"\\u0066ake.jwt.value"}', { status: 403 }));
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(1);
    const line = output(h);
    expect(line.failure).toEqual({ class: "internal", code: "secret_guard" });
    expect(line).not.toHaveProperty("body");
    expect(line).not.toHaveProperty("bodyRedacted");
    expect(h.stderr).toEqual([REFUSAL]);
  });

  for (const [name, value] of [
    ["full key", KEY],
    ["bare JWT", JWT],
  ]) {
    test("refuses the " + name + " in final envelope metadata", async () => {
      const h = harness();
      const calls = installFetch();
      expect(await subscriptionProbeCommand(args(value), h.deps)).toBe(1);
      const line = output(h);
      expect(line.failure).toEqual({ class: "internal", code: "secret_guard" });
      expect(line).not.toHaveProperty("body");
      expect(line).not.toHaveProperty("bodyRedacted");
      expect(h.stderr).toEqual([REFUSAL]);
      expect(calls.length).toBe(1);
    });
  }

  test("unreachable backend is get_chat_message_network_error with no retry", async () => {
    const h = harness();
    const calls = installFetch(() => {
      throw new TypeError("unreachable " + KEY);
    });
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(6);
    expect(output(h)).toEqual({
      ...base(),
      ...attempted(),
      failure: { class: "network", code: "get_chat_message_network_error" },
    });
    expect(calls.length).toBe(1);
  });

  test("a broken response read is a network failure rather than a stream error", async () => {
    const h = harness();
    const calls = installFetch(brokenBody);
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(6);
    expect(output(h)).toEqual({
      ...base(),
      ...answered(),
      failure: { class: "network", code: "get_chat_message_network_error", httpStatus: 200 },
    });
    expect(calls.length).toBe(1);
  });

  test("a 200 that ends without the end-of-stream frame is a network failure, not an answer", async () => {
    const endFrame = CLEAN_FRAMES.find((frame) => frame.flags === 2);
    if (!endFrame) throw new Error("The clean capture lacks its end frame");
    const truncated = concatenate(
      CLEAN_FRAMES.filter((frame) => frame !== endFrame).map((frame) => frame.raw)
    );
    const h = harness();
    const calls = installFetch(() => new Response(truncated.slice().buffer));
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(6);
    expect(output(h)).toEqual({
      ...base(),
      ...answered(),
      // Field 7.9 arrived before the stream broke, so the run determined it.
      servedModel: EXPECTED_SERVED,
      failure: { class: "network", code: "get_chat_message_network_error", httpStatus: 200 },
    });
    expect(calls.length).toBe(1);
  });

  test("an empty 200 body is a network failure, not an empty answer", async () => {
    const h = harness();
    installFetch(() => new Response(new Uint8Array(0)));
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(6);
    expect(output(h).failure).toEqual({
      class: "network",
      code: "get_chat_message_network_error",
      httpStatus: 200,
    });
  });

  test("the fetch deadline is get_chat_message_timeout", async () => {
    const h = harness();
    h.deps.requestTimeoutMs = 20;
    const calls = installFetch(abortedFetch);
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(6);
    expect(output(h)).toEqual({
      ...base(),
      ...attempted(),
      failure: { class: "network", code: "get_chat_message_timeout" },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  for (const status of [200, 503]) {
    test("the HTTP " + status + " body shares the probe deadline", async () => {
      const h = harness();
      h.deps.requestTimeoutMs = 20;
      const calls = installFetch((record) => stalledBody(record, status));
      expect(await subscriptionProbeCommand(args(), h.deps)).toBe(6);
      expect(output(h)).toEqual({
        ...base(),
        ...answered(status),
        failure: { class: "network", code: "get_chat_message_timeout", httpStatus: status },
      });
      expect(calls.length).toBe(1);
      expect(calls[0]!.signal?.aborted).toBe(true);
    });
  }

  test("accepts an HTTP error body exactly 512 KiB long", async () => {
    const vendorBody = "x".repeat(BODY_CAP);
    const h = harness();
    const calls = installFetch(() => new Response(vendorBody, { status: 503 }));
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    expect(output(h)).toEqual({
      ...base(),
      ...answered(503),
      bodyRedacted: false,
      body: vendorBody,
    });
    expect(calls.length).toBe(1);
  });

  for (const [name, vendorBody] of [
    ["ASCII", "x".repeat(BODY_CAP + 1)],
    ["UTF-8", "é".repeat(BODY_CAP / 2 + 1)],
  ]) {
    test("rejects an over-512-KiB " + name + " body by byte count", async () => {
      const h = harness();
      const calls = installFetch(() => new Response(vendorBody!, { status: 503 }));
      expect(await subscriptionProbeCommand(args(), h.deps)).toBe(7);
      expect(output(h)).toEqual({
        ...base(),
        ...answered(503),
        failure: { class: "list_incomplete", code: "body_too_large", httpStatus: 503 },
      });
      expect(calls.length).toBe(1);
    });
  }

  test("caps decoded HTTP 200 content made entirely from captured frames", async () => {
    const textFrame = CLEAN_FRAMES.find(
      (frame) => frame.flags === 0 && (stringField(fields(frame.payload), 3)?.length ?? 0) > 20
    );
    const endFrame = CLEAN_FRAMES.find((frame) => frame.flags === 2);
    if (!textFrame || !endFrame) throw new Error("The clean capture lacks text or its end frame");
    const fragment = stringField(fields(textFrame.payload), 3)!;
    const repetitions = Math.ceil((BODY_CAP + 1) / new TextEncoder().encode(fragment).byteLength);
    const oversized = concatenate([
      CLEAN_FRAMES[0]!.raw,
      ...Array.from({ length: repetitions }, () => textFrame.raw),
      endFrame.raw,
    ]);
    const h = harness();
    h.deps.requestTimeoutMs = 5_000;
    const calls = installFetch(() => new Response(oversized.slice().buffer));
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(7);
    const line = output(h);
    expect(line.failure).toEqual({
      class: "list_incomplete",
      code: "body_too_large",
      httpStatus: 200,
    });
    expect(line.httpStatus).toBe(200);
    expect(line).not.toHaveProperty("body");
    expect(line).not.toHaveProperty("bodyRedacted");
    expect(calls.length).toBe(1);
  }, 10_000);

  test("fails closed when escaped response text cannot be verified to a fixed point", async () => {
    const escaped = "\\" + "u005c".repeat(16_384) + "u0066ake.jwt.value";
    const h = harness();
    const calls = installFetch(
      () => new Response(JSON.stringify({ error: escaped }), { status: 403 })
    );
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(7);
    expect(output(h)).toEqual({
      ...base(),
      ...answered(403),
      failure: { class: "list_incomplete", code: "body_unverifiable", httpStatus: 403 },
    });
    expect(calls.length).toBe(1);
  });

  test("honours the server override and never prints URL userinfo", async () => {
    process.env.WINDSURF_API_SERVER_URL = "https://safe-user:safe-password@devin.invalid/bridge";
    const h = harness();
    const calls = installFetch();
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    const line = output(h);
    expect(line.sourceUrl).toBe(SERVER + "/bridge" + CHAT_PATH);
    expect(calls.length).toBe(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/bridge" + CHAT_PATH);
    expect(h.stdout[0]!.includes("safe-user")).toBe(false);
    expect(h.stdout[0]!.includes("safe-password")).toBe(false);
  });

  test("uses server.codeium.com without an override", async () => {
    delete process.env.WINDSURF_API_SERVER_URL;
    const h = harness();
    const calls = installFetch();
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(0);
    expect(output(h).sourceUrl).toBe("https://server.codeium.com" + CHAT_PATH);
    expect(calls.map((call) => call.url)).toEqual(["https://server.codeium.com" + CHAT_PATH]);
  });

  test("unexpected exceptions produce the fixed internal failure", async () => {
    const h = harness();
    installFetch();
    h.deps.now = () => {
      throw new Error("clock failed " + KEY);
    };
    expect(await subscriptionProbeCommand(args(), h.deps)).toBe(1);
    const line = output(h);
    expect(line.failure).toEqual({ class: "internal", code: "internal_error" });
    expect(line).not.toHaveProperty("body");
    expect(h.stderr).toEqual([INTERNAL]);
  });

  test("waits for its one stdout write to flush", async () => {
    const h = harness();
    installFetch();
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
    const running = subscriptionProbeCommand(args(), h.deps).then((code) => {
      returned = true;
      return code;
    });
    await writing;
    expect(returned).toBe(false);
    release();
    expect(await running).toBe(0);
    assertCapturedAnswer(output(h));
  });
});
