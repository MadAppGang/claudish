import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { _resetAgyClientVersion } from "./auth/antigravity-client-version.js";
import {
  type AntigravityStoreRead,
  _resetAntigravityTokenState,
} from "./auth/antigravity-token.js";
import {
  _resetAntigravityServedModelsCache,
  resetAntigravityUserCache,
} from "./auth/antigravity-user.js";
import { newSecrets } from "./subscription-antigravity-session.js";
import { probeLoadFailureLine } from "./subscription-dispatch.js";
import { parseSubscriptionModelsArgs } from "./subscription-models-command.js";
import {
  MAX_UNESCAPE_ROUNDS,
  PROBE_BODY_CAP_BYTES,
  PROBE_FAILURE_CODES,
  PROBE_REQUEST_FILE_MESSAGE,
  REDACTED,
  SUBSCRIPTION_PROBE_USAGE,
  type SubscriptionProbeDeps,
  type SubscriptionProbeEnvelope,
  buildProbeEnvelopeBody,
  isSubscriptionProbeArgv,
  jsonUnescapedForms,
  parseSubscriptionProbeArgs,
  redactSecretValues,
  reportProbeInternalError,
  subscriptionProbeCommand,
} from "./subscription-probe-command.js";
import { VERSION } from "./version.js";

const NOW = Date.parse("2026-11-02T01:02:03.456Z");
const HOST = "https://daily-cloudcode-pa.googleapis.com";
const GENERATE_URL = `${HOST}/v1internal:generateContent`;
const ACCESS = "CANARY_ACCESS_TOKEN_aaaa";
const REFRESH = "1//CANARY_REFRESH_TOKEN_bbbb";
const PROJECT = "CANARY_PROJECT_ID_cccc";
const CANARIES = [ACCESS, REFRESH, PROJECT, "CANARY_REFRESH_TOKEN_bbbb"];
const MODEL = "gemini-3.8-flash";
// Spelled the way a caller writes it: `1.0` and the key order must reach the wire unchanged.
const REQUEST_TEXT =
  '{"contents":[{"role":"user","parts":[{"text":"ping"}]}],"generationConfig":{"temperature":1.0,"thinkingConfig":{"thinkingLevel":"high"}}}';
const REQUEST_PATH = "/probe/request.json";
const ARGS = [
  "probe",
  "antigravity",
  "--model",
  MODEL,
  "--request-file",
  REQUEST_PATH,
  "--raw",
  "--json",
];
const VENDOR_OK =
  '{\n  "response": {\n    "candidates": [{"content": {"role": "model", "parts": [{"text": "pong"}]}, "finishReason": "STOP"}],\n    "modelVersion": "gemini-3.8-flash"\n  },\n  "traceId": "abc"\n}\n';
const ENVELOPE_KEYS = [
  "schema",
  "provider",
  "claudishVersion",
  "model",
  "fetchedAt",
  "sourceUrl",
  "clientVersion",
  "clientVersionSource",
  "tokenRefreshed",
  "httpStatus",
  "failure",
  "bodyRedacted",
  "body",
];

const realFetch = globalThis.fetch;
let outputs: string[] = [];
let restoreStderr = () => {};

interface Recorded {
  url: string;
  headers: Headers;
  bodyText: string;
  signal: AbortSignal | null;
  redirect: RequestRedirect | undefined;
}
type Responder = (request: Recorded) => Response | Promise<Response>;

interface HarnessOptions {
  platform?: string;
  store?: AntigravityStoreRead;
  tier?: string;
  requestFile?: string | null | Error;
}
interface Harness {
  deps: SubscriptionProbeDeps;
  stdout: string[];
  stderr: string[];
  storeReads: number;
}

function encodeStore(): string {
  return (
    "go-keyring-base64:" +
    Buffer.from(
      JSON.stringify({
        token: {
          access_token: ACCESS,
          token_type: "Bearer",
          refresh_token: REFRESH,
          expiry: new Date(NOW + 3_600_000).toISOString(),
        },
      }),
      "utf8"
    ).toString("base64")
  );
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const store = encodeStore();
  const harness: Harness = {
    stdout: [],
    stderr: [],
    storeReads: 0,
    deps: undefined as unknown as SubscriptionProbeDeps,
  };
  harness.deps = {
    platform: () => options.platform ?? "darwin",
    readStore: async () => {
      harness.storeReads++;
      return options.store ?? { kind: "present", raw: store };
    },
    tokenDeps: () => ({
      readStore: () => store,
      writeStore: () => {},
      deleteStore: () => {},
      runAgyRefresh: () => ({ kind: "ran" }),
      readAgyVersion: () => "1.4.9",
      now: () => NOW,
    }),
    now: () => NOW,
    httpTimeoutMs: 50,
    keychainDeadlineMs: 10,
    requestTimeoutMs: 50,
    readRequestFile: async (path) => {
      expect(path).toBe(REQUEST_PATH);
      const file = options.requestFile === undefined ? REQUEST_TEXT : options.requestFile;
      if (file instanceof Error) throw file;
      return file;
    },
    writeStdout: async (line) => {
      harness.stdout.push(line);
      outputs.push(line);
    },
    writeStderr: (line) => {
      harness.stderr.push(line);
      outputs.push(line);
    },
  };
  return harness;
}

function installFetch(generate: Responder = () => new Response(VENDOR_OK), tier = "g1-ultra-tier") {
  const requests: Recorded[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(input),
      headers: new Headers(init?.headers),
      bodyText: String(init?.body ?? ""),
      signal: init?.signal ?? null,
      redirect: init?.redirect,
    };
    requests.push(recorded);
    const path = new URL(recorded.url).pathname;
    if (path.endsWith(":loadCodeAssist")) {
      return Response.json({ cloudaicompanionProject: PROJECT, paidTier: { id: tier } });
    }
    if (path.endsWith(":generateContent")) return generate(recorded);
    throw new Error(`unexpected endpoint ${recorded.url}`);
  }) as typeof fetch;
  return requests;
}

function generateRequests(requests: Recorded[]): Recorded[] {
  return requests.filter((r) => r.url.endsWith(":generateContent"));
}

function parseLine(harness: Harness): SubscriptionProbeEnvelope {
  expect(harness.stdout).toHaveLength(1);
  const line = harness.stdout[0];
  expect(line.endsWith("\n")).toBe(true);
  expect(line.split("\n")).toHaveLength(2);
  const envelope: SubscriptionProbeEnvelope = JSON.parse(line);
  expect(Object.keys(envelope)).toEqual(ENVELOPE_KEYS.filter((k) => Object.hasOwn(envelope, k)));
  return envelope;
}

const BASE = {
  schema: "claudish.subscription-probe.v1",
  provider: "antigravity",
  claudishVersion: VERSION,
  model: MODEL,
};
const SENT = {
  sourceUrl: GENERATE_URL,
  clientVersion: "1.4.9",
  clientVersionSource: "agy",
};
const ANSWERED = { fetchedAt: new Date(NOW).toISOString(), ...SENT };

function resetState(): void {
  _resetAgyClientVersion();
  _resetAntigravityServedModelsCache();
  resetAntigravityUserCache();
  _resetAntigravityTokenState();
  delete process.env.AICODE_ENDPOINT_URL;
}

beforeEach(() => {
  resetState();
  outputs = [];
  const spy = spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
    outputs.push(String(args[0]));
    const cb = args.find((a) => typeof a === "function");
    if (typeof cb === "function") cb();
    return true;
  });
  restoreStderr = () => spy.mockRestore();
  globalThis.fetch = (async () => {
    throw new Error("Unexpected network request in hermetic test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  try {
    const all = outputs.join("");
    for (const canary of CANARIES) expect(all).not.toContain(canary);
  } finally {
    restoreStderr();
    globalThis.fetch = realFetch;
    resetState();
  }
});

describe("subscription probe envelope", () => {
  test("P1: a 2xx answer prints one line with the body text as read", async () => {
    const requests = installFetch();
    const harness = makeHarness();
    const exit = await subscriptionProbeCommand(ARGS, harness.deps);
    expect(exit).toBe(0);
    expect(parseLine(harness)).toEqual({
      ...BASE,
      ...ANSWERED,
      tokenRefreshed: false,
      httpStatus: 200,
      bodyRedacted: false,
      body: VENDOR_OK,
    } as SubscriptionProbeEnvelope);
    expect(harness.stderr).toEqual([]);
    expect(generateRequests(requests)).toHaveLength(1);
  });

  test("P2: sends the CodeAssist envelope with the file's bytes and the model unchanged", async () => {
    const requests = installFetch();
    const harness = makeHarness();
    await subscriptionProbeCommand(ARGS, harness.deps);
    const [sent] = generateRequests(requests);
    expect(sent.url).toBe(GENERATE_URL);
    expect(sent.headers.get("Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(sent.headers.get("Content-Type")).toBe("application/json");
    expect(sent.headers.get("User-Agent")).toBe(
      `antigravity/cli/1.4.9 (aidev_client; os_type=${process.platform}; arch=${process.arch}; auth_method=consumer)`
    );
    expect(sent.headers.get("x-activity-request-id")).toBeTruthy();
    // Byte-exact: `1.0` would read back as `1` after a parse and re-serialize.
    expect(sent.bodyText).toContain(`"request":${REQUEST_TEXT}`);
    const body = JSON.parse(sent.bodyText);
    expect(Object.keys(body)).toEqual([
      "model",
      "project",
      "user_prompt_id",
      "request",
      "enabled_credit_types",
    ]);
    expect(body.model).toBe(MODEL);
    expect(body.project).toBe(PROJECT);
    expect(body.user_prompt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.request).toEqual(JSON.parse(REQUEST_TEXT));
    expect(body.enabled_credit_types).toEqual(["GOOGLE_ONE_AI"]);
    // No discovery call: the id is not resolved against the dynamic models catalog.
    expect(requests.some((r) => r.url.endsWith(":fetchAvailableModels"))).toBe(false);
  });

  test("P3: a free-tier account sends no enabled_credit_types", async () => {
    const requests = installFetch(undefined, "free-tier");
    const harness = makeHarness();
    await subscriptionProbeCommand(ARGS, harness.deps);
    const body = JSON.parse(generateRequests(requests)[0].bodyText);
    expect(Object.hasOwn(body, "enabled_credit_types")).toBe(false);
  });

  test("P4: honours AICODE_ENDPOINT_URL and strips its userinfo from sourceUrl", async () => {
    process.env.AICODE_ENDPOINT_URL = "https://user:pw@example.test/";
    const requests = installFetch();
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(0);
    expect(generateRequests(requests)[0].url).toBe(
      "https://user:pw@example.test/v1internal:generateContent"
    );
    expect(parseLine(harness).sourceUrl).toBe("https://example.test/v1internal:generateContent");
  });
});

describe("subscription probe non-2xx answers", () => {
  for (const status of [400, 404, 429, 500]) {
    test(`N${status}: exit 0 with httpStatus and the vendor error body, sent once`, async () => {
      const errorBody = `{"error":{"code":${status},"message":"vendor says no","status":"X"}}`;
      const requests = installFetch(() => new Response(errorBody, { status }));
      const harness = makeHarness();
      expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(0);
      expect(parseLine(harness)).toEqual({
        ...BASE,
        ...ANSWERED,
        tokenRefreshed: false,
        httpStatus: status,
        bodyRedacted: false,
        body: errorBody,
      } as SubscriptionProbeEnvelope);
      // No retry, whatever the status.
      expect(generateRequests(requests)).toHaveLength(1);
    });
  }

  test("N-html: a non-JSON non-2xx body is still printed", async () => {
    installFetch(() => new Response("<html>502</html>", { status: 502 }));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(0);
    const envelope = parseLine(harness);
    expect(envelope.httpStatus).toBe(502);
    expect(envelope.body).toBe("<html>502</html>");
  });
});

describe("subscription probe secret guard", () => {
  test("G1: credential values in the vendor body are redacted and flagged", async () => {
    const leaky = `{"error":{"message":"project ${PROJECT} denied for ${ACCESS}; refresh ${REFRESH.replaceAll("/", "\\/")}"}}`;
    installFetch(() => new Response(leaky, { status: 403 }));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(0);
    const envelope = parseLine(harness);
    expect(envelope.bodyRedacted).toBe(true);
    expect(envelope.body).toBe(
      `{"error":{"message":"project ${REDACTED} denied for ${REDACTED}; refresh ${REDACTED}"}}`
    );
    // afterEach checks every canary is absent from every output.
  });

  test("G2: redactSecretValues replaces the longest value first", () => {
    const secrets = newSecrets();
    secrets.values.add("abc");
    secrets.values.add("abcdef");
    expect(redactSecretValues("x abcdef y abc", secrets)).toEqual({
      text: `x ${REDACTED} y ${REDACTED}`,
      redacted: true,
    });
    expect(redactSecretValues("clean", secrets)).toEqual({ text: "clean", redacted: false });
  });

  test("G3: an aborted request's error text never reaches any output", async () => {
    installFetch(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () =>
            reject(new DOMException(`${ACCESS} ${PROJECT}`, "AbortError"))
          );
        })
    );
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(6);
    expect(parseLine(harness).failure).toEqual({
      class: "network",
      code: "generate_content_timeout",
    });
  });
});

describe("subscription probe body limits", () => {
  test("O1: a body over 512 KiB is body_too_large, exit 7, no body", async () => {
    const huge = `{"pad":"${"x".repeat(PROBE_BODY_CAP_BYTES)}"}`;
    installFetch(() => new Response(huge));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(7);
    expect(parseLine(harness)).toEqual({
      ...BASE,
      ...ANSWERED,
      tokenRefreshed: false,
      httpStatus: 200,
      failure: { class: "list_incomplete", code: "body_too_large", httpStatus: 200 },
    } as SubscriptionProbeEnvelope);
  });

  test("O2: an oversize non-2xx body is body_too_large too", async () => {
    installFetch(() => new Response("e".repeat(PROBE_BODY_CAP_BYTES + 1), { status: 500 }));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(7);
    expect(parseLine(harness).failure).toEqual({
      class: "list_incomplete",
      code: "body_too_large",
      httpStatus: 500,
    });
  });

  test("O3: a body of exactly 512 KiB is printed", async () => {
    const exact = `{"pad":"${"x".repeat(PROBE_BODY_CAP_BYTES - 10)}"}`;
    expect(Buffer.byteLength(exact)).toBe(PROBE_BODY_CAP_BYTES);
    installFetch(() => new Response(exact));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(0);
    expect(parseLine(harness).body).toBe(exact);
  });

  test("O4: a 2xx body that is not JSON is body_not_json, exit 7", async () => {
    installFetch(() => new Response("data: {}\n\n"));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(7);
    expect(parseLine(harness).failure).toEqual({
      class: "list_incomplete",
      code: "body_not_json",
      httpStatus: 200,
    });
  });
});

describe("subscription probe missing login and network", () => {
  test("L1: no keychain item is credential_missing, exit 3, no request sent", async () => {
    const requests = installFetch();
    const harness = makeHarness({ store: { kind: "absent" } });
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(3);
    expect(parseLine(harness)).toEqual({
      ...BASE,
      tokenRefreshed: false,
      failure: { class: "credential_missing", code: "keychain_item_absent" },
    } as SubscriptionProbeEnvelope);
    expect(requests).toHaveLength(0);
  });

  test("L2: a locked keychain is exit 4", async () => {
    installFetch();
    const harness = makeHarness({ store: { kind: "locked" } });
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(4);
    expect(parseLine(harness).failure).toEqual({
      class: "keychain_locked",
      code: "keychain_locked",
    });
  });

  test("L3: a non-macOS platform is platform_unsupported, exit 3", async () => {
    const harness = makeHarness({ platform: "linux" });
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(3);
    expect(parseLine(harness).failure).toEqual({
      class: "credential_missing",
      code: "platform_unsupported",
    });
  });

  test("L4: fetch throwing is generate_content_network_error, exit 6", async () => {
    installFetch(() => {
      throw new TypeError(`connect failed ${ACCESS}`);
    });
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(6);
    expect(parseLine(harness)).toEqual({
      ...BASE,
      ...SENT,
      tokenRefreshed: false,
      failure: { class: "network", code: "generate_content_network_error" },
    } as SubscriptionProbeEnvelope);
  });
});

describe("subscription probe request file", () => {
  test("F1: an unreadable file exits 2 before the keychain is read", async () => {
    const harness = makeHarness({ requestFile: new Error("ENOENT") });
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(2);
    expect(parseLine(harness)).toEqual({
      ...BASE,
      tokenRefreshed: false,
      failure: { class: "internal", code: "request_file_unreadable" },
    } as SubscriptionProbeEnvelope);
    expect(harness.stderr).toEqual([`${PROBE_REQUEST_FILE_MESSAGE}\n`]);
    expect(harness.storeReads).toBe(0);
  });

  for (const [name, file] of [
    ["array", "[1,2]"],
    ["not JSON", "{contents:"],
    ["null", "null"],
    ["over the cap", null],
  ] as const) {
    test(`F2 ${name}: request_file_invalid, exit 2`, async () => {
      const harness = makeHarness({ requestFile: file });
      expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(2);
      expect(parseLine(harness).failure).toEqual({
        class: "internal",
        code: "request_file_invalid",
      });
      expect(harness.storeReads).toBe(0);
    });
  }
});

describe("subscription probe argv", () => {
  test("A1: accepts the flags in any order", () => {
    expect(
      parseSubscriptionProbeArgs([
        "--json",
        "probe",
        "--request-file",
        "r.json",
        "antigravity",
        "--raw",
        "--model",
        "m",
      ])
    ).toEqual({ ok: true, provider: "antigravity", model: "m", requestFile: "r.json" });
  });

  const bad: string[][] = [
    ["probe", "antigravity", "--model", "m", "--request-file", "r", "--raw"],
    ["probe", "ag", "--model", "m", "--request-file", "r", "--raw", "--json"],
    ["probe", "antigravity", "--model=m", "--request-file", "r", "--raw", "--json"],
    ["probe", "antigravity", "--model", "--request-file", "r", "--raw", "--json"],
    ["probe", "antigravity", "--request-file", "r", "--raw", "--json"],
    [
      "probe",
      "antigravity",
      "--model",
      "m",
      "--model",
      "n",
      "--request-file",
      "r",
      "--raw",
      "--json",
    ],
    ["probe", "antigravity", "extra", "--model", "m", "--request-file", "r", "--raw", "--json"],
    ["probe", "antigravity", "--model", "m", "--request-file", "r", "--raw", "--json", "--json"],
  ];
  for (const argv of bad) {
    test(`A2: usage error for ${argv.join(" ")}`, async () => {
      const harness = makeHarness();
      expect(await subscriptionProbeCommand(argv, harness.deps)).toBe(2);
      expect(parseLine(harness)).toEqual({
        schema: "claudish.subscription-probe.v1",
        claudishVersion: VERSION,
        tokenRefreshed: false,
        failure: { class: "internal", code: "usage" },
      } as SubscriptionProbeEnvelope);
      expect(harness.stderr).toEqual([`${SUBSCRIPTION_PROBE_USAGE}\n`]);
      expect(harness.storeReads).toBe(0);
    });
  }

  test("A3: the models command still rejects a probe argv", () => {
    expect(parseSubscriptionModelsArgs(ARGS)).toEqual({ ok: false });
  });

  test("A4: the index.ts catch prints a probe-schema internal_error line", async () => {
    const harness = makeHarness();
    expect(await reportProbeInternalError(harness.deps)).toBe(1);
    expect(parseLine(harness)).toEqual({
      schema: "claudish.subscription-probe.v1",
      claudishVersion: VERSION,
      tokenRefreshed: false,
      failure: { class: "internal", code: "internal_error" },
    } as SubscriptionProbeEnvelope);
  });

  test("A5: every failure code is bounded", () => {
    for (const codes of Object.values(PROBE_FAILURE_CODES)) {
      for (const code of codes) expect(code).toMatch(/^[a-z0-9_.:-]{1,120}$/);
    }
  });

  test("A6: buildProbeEnvelopeBody splices the request text and is valid JSON", () => {
    const text = buildProbeEnvelopeBody("m", "p", "free-tier", '{"a":1.50}', "id");
    expect(text).toBe('{"model":"m","project":"p","user_prompt_id":"id","request":{"a":1.50}}');
    expect(JSON.parse(text).request).toEqual({ a: 1.5 });
  });
});

describe("subscription probe review fixes", () => {
  test("D1: index.ts dispatch agrees with the parser when flags come first", () => {
    const flagsFirst = [
      "--json",
      "probe",
      "antigravity",
      "--model",
      "m",
      "--request-file",
      "r",
      "--raw",
    ];
    expect(parseSubscriptionProbeArgs(flagsFirst).ok).toBe(true);
    expect(isSubscriptionProbeArgv(flagsFirst)).toBe(true);
    expect(isSubscriptionProbeArgv(["--model", "probe", "x"])).toBe(false);
    expect(isSubscriptionProbeArgv(["--model", "m", "probe", "antigravity"])).toBe(true);
    // Everything the models command owns stays with it.
    expect(isSubscriptionProbeArgv(["models", "antigravity", "--raw", "--json"])).toBe(false);
    expect(isSubscriptionProbeArgv(["--raw", "--json", "models", "antigravity"])).toBe(false);
    expect(isSubscriptionProbeArgv([])).toBe(false);
  });

  test("B1: a 2xx body that errors mid-stream is a network failure with its status", async () => {
    installFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"response":'));
              controller.error(new TypeError(`reset ${ACCESS} ${PROJECT}`));
            },
          }),
          { status: 200 }
        )
    );
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(6);
    expect(parseLine(harness)).toEqual({
      ...BASE,
      ...ANSWERED,
      tokenRefreshed: false,
      httpStatus: 200,
      failure: { class: "network", code: "generate_content_network_error", httpStatus: 200 },
    } as SubscriptionProbeEnvelope);
  });

  test("B2: a loadCodeAssist 500 carries the version but no sourceUrl", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(6);
    expect(parseLine(harness)).toEqual({
      ...BASE,
      clientVersion: "1.4.9",
      clientVersionSource: "agy",
      tokenRefreshed: false,
      failure: { class: "network", code: "load_code_assist_5xx", httpStatus: 500 },
    } as SubscriptionProbeEnvelope);
  });
});

describe("subscription probe second review fixes", () => {
  test("G4: a credential spelled with JSON escapes is refused, never printed", async () => {
    const escaped = `\\u0043${ACCESS.slice(1)}`;
    installFetch(() => new Response(`{"error":{"message":"${escaped}"}}`, { status: 401 }));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(1);
    expect(parseLine(harness)).toEqual({
      ...BASE,
      ...ANSWERED,
      tokenRefreshed: false,
      httpStatus: 401,
      failure: { class: "internal", code: "secret_guard" },
    } as SubscriptionProbeEnvelope);
    expect(harness.stderr).toEqual([
      "[claudish subscription] refused: output contained a credential value\n",
    ]);
    expect(harness.stdout[0]).not.toContain(escaped);
  });

  test("G5: jsonUnescapedForms decodes one level per round to a fixed point", () => {
    expect(jsonUnescapedForms("\\u0043\\/x")).toEqual({ forms: ["C/x"], complete: true });
    expect(jsonUnescapedForms("\\\\u0043")).toEqual({ forms: ["\\u0043", "C"], complete: true });
    expect(jsonUnescapedForms("plain")).toEqual({ forms: [], complete: true });
    expect(jsonUnescapedForms(undefined)).toEqual({ forms: [], complete: true });
  });

  test("G7: an escaped credential in a duplicate member a parse would drop is refused", async () => {
    const escaped = `\\u0043${ACCESS.slice(1)}`;
    const body = `{"message":"${escaped}","message":"safe"}`;
    // The bypass: one parse of the whole body keeps only the last member.
    expect(JSON.stringify(JSON.parse(body))).toBe('{"message":"safe"}');
    installFetch(() => new Response(body, { status: 401 }));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(1);
    expect(parseLine(harness).failure).toEqual({ class: "internal", code: "secret_guard" });
    expect(harness.stdout[0]).not.toContain(escaped);
  });

  test("G8: a credential escaped inside JSON nested in a JSON string is refused", async () => {
    // Round-3 trigger: {"message":"{\"token\":\"\\u0043ANARY...\"}"}
    const body = `{"message":"{\\"token\\":\\"\\\\u0043${ACCESS.slice(1)}\\"}"}`;
    expect(JSON.parse(JSON.parse(body).message).token).toBe(ACCESS);
    installFetch(() => new Response(body));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(1);
    expect(parseLine(harness).failure).toEqual({ class: "internal", code: "secret_guard" });
  });

  test("G9: a stray quote before an escaped credential does not hide it", async () => {
    const body = `" {"message":"\\u0043${ACCESS.slice(1)}"}`;
    expect(JSON.parse(body.slice(2)).message).toBe(ACCESS);
    installFetch(() => new Response(body, { status: 401 }));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(1);
    expect(parseLine(harness).failure).toEqual({ class: "internal", code: "secret_guard" });
  });

  test("D2: the load-failure line is the probe schema's internal_error line", () => {
    const line = probeLoadFailureLine();
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      schema: "claudish.subscription-probe.v1",
      claudishVersion: VERSION,
      tokenRefreshed: false,
      failure: { class: "internal", code: "internal_error" },
    });
    expect(isSubscriptionProbeArgv(["--model", "m", "probe", "antigravity"])).toBe(true);
  });

  /** An escape of one character nested `depth` deep, growing 5 bytes per level. */
  function nestedEscape(depth: number, hex: string): string {
    return depth === 1 ? `\\u${hex}` : `\\u005c${"u005c".repeat(depth - 2)}u${hex}`;
  }

  test("G10: a credential nested past the old 16-round cap is refused", async () => {
    const escaped = nestedEscape(20, "0043");
    expect(jsonUnescapedForms(escaped).forms.at(-1)).toBe("C");
    const body = `{"message":"${escaped}${ACCESS.slice(1)}"}`;
    installFetch(() => new Response(body, { status: 403 }));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(1);
    expect(parseLine(harness).failure).toEqual({ class: "internal", code: "secret_guard" });
  });

  test("G11: a body nested past the decode budget is withheld, exit 7", async () => {
    const depth = MAX_UNESCAPE_ROUNDS + 6;
    expect(jsonUnescapedForms(nestedEscape(depth, "0041")).complete).toBe(false);
    const body = `{"message":"${nestedEscape(depth, "0041")}"}`;
    installFetch(() => new Response(body, { status: 400 }));
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(7);
    expect(parseLine(harness)).toEqual({
      ...BASE,
      ...ANSWERED,
      tokenRefreshed: false,
      httpStatus: 400,
      failure: { class: "list_incomplete", code: "body_unverifiable", httpStatus: 400 },
    } as SubscriptionProbeEnvelope);
  });

  test("G12: the worst case at the body cap finishes quickly and fails closed", async () => {
    const depth = Math.floor((PROBE_BODY_CAP_BYTES - 64) / 5);
    const body = `{"m":"${nestedEscape(depth, "0041")}"}`;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(PROBE_BODY_CAP_BYTES);
    installFetch(() => new Response(body));
    const harness = makeHarness();
    const started = performance.now();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(7);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(parseLine(harness).failure?.code).toBe("body_unverifiable");
  });

  test("G6: a --model equal to the project id still prints exactly one line", async () => {
    installFetch();
    const harness = makeHarness();
    const argv = [...ARGS];
    argv[argv.indexOf(MODEL)] = PROJECT;
    expect(await subscriptionProbeCommand(argv, harness.deps)).toBe(1);
    expect(parseLine(harness)).toEqual({
      schema: "claudish.subscription-probe.v1",
      claudishVersion: VERSION,
      tokenRefreshed: false,
      failure: { class: "internal", code: "secret_guard" },
    } as SubscriptionProbeEnvelope);
  });

  test("R1: a 307 is the answer: not followed, one request, exit 0 with its body", async () => {
    const requests = installFetch(
      () =>
        new Response('{"moved":true}', {
          status: 307,
          headers: { Location: "https://elsewhere.test/v1internal:generateContent" },
        })
    );
    const harness = makeHarness();
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(0);
    const sent = generateRequests(requests);
    expect(sent).toHaveLength(1);
    expect(sent[0].redirect).toBe("manual");
    const envelope = parseLine(harness);
    expect(envelope.httpStatus).toBe(307);
    expect(envelope.body).toBe('{"moved":true}');
  });

  test("T1: the request file's surrounding whitespace reaches the wire unchanged", async () => {
    const file = ` \n${REQUEST_TEXT}\n`;
    const requests = installFetch();
    const harness = makeHarness({ requestFile: file });
    expect(await subscriptionProbeCommand(ARGS, harness.deps)).toBe(0);
    const sent = generateRequests(requests)[0].bodyText;
    expect(sent).toContain(`"request":${file}`);
    expect(JSON.parse(sent).request).toEqual(JSON.parse(REQUEST_TEXT));
  });
});
