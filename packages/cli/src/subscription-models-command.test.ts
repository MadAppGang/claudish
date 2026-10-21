import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { _resetAgyClientVersion } from "./auth/antigravity-client-version.js";
import {
  type AgyRefreshOutcome,
  type AntigravityStoreRead,
  type AntigravityTokenDeps,
  _resetAntigravityTokenState,
} from "./auth/antigravity-token.js";
import {
  _resetAntigravityServedModelsCache,
  fetchAntigravityAvailableModelsRaw,
  resetAntigravityUserCache,
} from "./auth/antigravity-user.js";
import {
  EXIT,
  FAILURE_CODES,
  INTERNAL_ERROR_MESSAGE,
  SECRET_GUARD_MESSAGE,
  SUBSCRIPTION_MODELS_USAGE,
  type SubscriptionModelListEnvelope,
  type SubscriptionModelListFailure,
  type SubscriptionModelsDeps,
  parseSubscriptionModelsArgs,
  runAntigravityRawModelList,
  subscriptionModelsCommand,
} from "./subscription-models-command.js";
import { VERSION } from "./version.js";

interface CapturedModels {
  models: Record<string, Record<string, unknown>>;
  agentModelSorts: unknown;
  deprecatedModelIds?: Record<string, { newModelId: string }>;
  [key: string]: unknown;
}

const oldCaptureText = await Bun.file(
  new URL("./auth/fixtures/antigravity-fetchAvailableModels-1.1.9.json", import.meta.url)
).text();
const newCaptureText = await Bun.file(
  new URL("./auth/fixtures/antigravity-fetchAvailableModels-1.3.5.json", import.meta.url)
).text();
const oldCapture: CapturedModels = JSON.parse(oldCaptureText);
const newCapture: CapturedModels = JSON.parse(newCaptureText);
const NOW = Date.parse("2026-10-21T12:34:56.789Z");
const HOST = "https://daily-cloudcode-pa.googleapis.com";
const MODELS_URL = `${HOST}/v1internal:fetchAvailableModels`;
const ACCESS = "CANARY_ACCESS_TOKEN_aaaa";
const REFRESH = "CANARY_REFRESH_TOKEN_bbbb";
const PROJECT = "CANARY_PROJECT_ID_cccc";
const RESPONSE_HEADER = "CANARY_RESPONSE_HEADER_dddd";
const REMINTED_ACCESS = "CANARY_ACCESS_TOKEN_reminted_eeee";
const REMINTED_REFRESH = "CANARY_REFRESH_TOKEN_reminted_ffff";
const CANARIES = [ACCESS, REFRESH, PROJECT, RESPONSE_HEADER, REMINTED_ACCESS, REMINTED_REFRESH];
const VALID_ARGS = ["models", "antigravity", "--raw", "--json"];
const VERSION_FIELDS = { clientVersion: "1.3.5", clientVersionSource: "agy" as const };
const ATTEMPT_FIELDS = { sourceUrl: MODELS_URL, ...VERSION_FIELDS };
const ENVELOPE_KEYS = [
  "schema",
  "provider",
  "claudishVersion",
  "fetchedAt",
  "sourceUrl",
  "clientVersion",
  "clientVersionSource",
  "tokenRefreshed",
  "httpStatus",
  "failure",
  "body",
];
const FAILURE_EXITS = {
  credential_missing: 3,
  keychain_locked: 4,
  mint_failed: 5,
  network: 6,
  list_incomplete: 7,
} as const;
const realFetch = globalThis.fetch;
let directStderr: string[] = [];
let restoreStderr = () => {};
let harnesses: Harness[] = [];

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null;
}
type Responder = (request: RecordedRequest) => Response | Promise<Response>;
interface HarnessOptions {
  platform?: string;
  store?: AntigravityStoreRead;
  expired?: boolean;
  refreshOutcome?: AgyRefreshOutcome;
  remint?: boolean;
}
interface Harness {
  deps: SubscriptionModelsDeps;
  tokenDeps: AntigravityTokenDeps;
  stdout: string[];
  stderr: string[];
}

function encodeStore(expired = false, reminted = false): string {
  return (
    "go-keyring-base64:" +
    Buffer.from(
      JSON.stringify({
        token: {
          access_token: reminted ? REMINTED_ACCESS : ACCESS,
          token_type: "Bearer",
          refresh_token: reminted ? REMINTED_REFRESH : REFRESH,
          expiry: new Date(NOW + (expired ? -60_000 : 3_600_000)).toISOString(),
        },
      }),
      "utf8"
    ).toString("base64")
  );
}

function makeHarness(options: HarnessOptions = {}): Harness {
  let store = options.store?.kind === "present" ? options.store.raw : encodeStore(options.expired);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const tokenDeps: AntigravityTokenDeps = {
    readStore: () => store,
    writeStore: (raw) => {
      store = raw;
    },
    deleteStore: () => {
      store = "";
    },
    runAgyRefresh: () => {
      if (options.remint) store = encodeStore(false, true);
      return options.refreshOutcome ?? { kind: "ran" };
    },
    readAgyVersion: () => "1.3.5",
    now: () => NOW,
  };
  const deps: SubscriptionModelsDeps = {
    platform: () => options.platform ?? "darwin",
    readStore: async () => options.store ?? { kind: "present", raw: store },
    tokenDeps: () => tokenDeps,
    now: () => NOW,
    httpTimeoutMs: 50,
    keychainDeadlineMs: 10,
    writeStdout: async (line) => {
      stdout.push(line);
    },
    writeStderr: (line) => {
      stderr.push(line);
    },
  };
  const harness = { deps, tokenDeps, stdout, stderr };
  harnesses.push(harness);
  return harness;
}

function vendorJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "X-Response-Canary": RESPONSE_HEADER } });
}

function vendorText(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "X-Response-Canary": RESPONSE_HEADER } });
}

function loadCodeAssistSuccess(): Response {
  return vendorJson({
    cloudaicompanionProject: PROJECT,
    paidTier: { id: "g1-ultra-tier", name: "Ultra" },
  });
}

function installFetch(
  overrides: { setup?: Responder; models?: Responder } = {}
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const rawBody = init?.body ?? (request ? await request.clone().text() : undefined);
    const recorded: RecordedRequest = {
      url: request ? request.url : String(input),
      method: init?.method ?? request?.method ?? "GET",
      headers: new Headers(init?.headers ?? request?.headers),
      body:
        rawBody === undefined || rawBody === null || rawBody === ""
          ? undefined
          : JSON.parse(String(rawBody)),
      signal: init?.signal ?? request?.signal ?? null,
    };
    requests.push(recorded);
    if (new URL(recorded.url).pathname.endsWith(":loadCodeAssist")) {
      return overrides.setup ? overrides.setup(recorded) : loadCodeAssistSuccess();
    }
    if (new URL(recorded.url).pathname.endsWith(":fetchAvailableModels")) {
      return overrides.models ? overrides.models(recorded) : vendorText(newCaptureText);
    }
    throw new Error("Unexpected HTTP endpoint in hermetic test");
  }) as typeof fetch;
  return requests;
}

function pendingResponse(request: RecordedRequest): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = request.signal;
    const abort = () => reject(new DOMException(`${ACCESS} ${REFRESH} ${PROJECT}`, "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function brokenBodyResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError(`${ACCESS} ${REFRESH} ${PROJECT}`));
      },
    }),
    { status: 200 }
  );
}

function baseEnvelope(tokenRefreshed = false) {
  return {
    schema: "claudish.subscription-model-list.v1" as const,
    provider: "antigravity" as const,
    claudishVersion: VERSION,
    tokenRefreshed,
  };
}

function answeredFields(status = 200) {
  return { fetchedAt: new Date(NOW).toISOString(), ...ATTEMPT_FIELDS, httpStatus: status };
}

function expectStderr(harness: Harness, expected = "", expectedDirectStderr = ""): void {
  expect(harness.stderr.join("")).toBe(expected);
  expect(directStderr.join("")).toBe(expectedDirectStderr);
}

function expectEnvelope(
  harness: Harness,
  expected: SubscriptionModelListEnvelope
): SubscriptionModelListEnvelope {
  expect(harness.stdout).toHaveLength(1);
  const line = harness.stdout[0];
  expect(line.endsWith("\n")).toBe(true);
  expect(line.split("\n")).toHaveLength(2);
  const envelope: SubscriptionModelListEnvelope = JSON.parse(line);
  expect(envelope).toEqual(expected);
  if (Object.hasOwn(expected, "body")) {
    expect(typeof envelope.body).toBe("string");
    expect(envelope.body).toBe(expected.body);
  }
  expect(Object.keys(envelope)).toEqual(
    ENVELOPE_KEYS.filter((key) => Object.hasOwn(envelope, key))
  );
  return envelope;
}

function expectFailure(
  harness: Harness,
  exit: number,
  failure: SubscriptionModelListFailure & { class: keyof typeof FAILURE_EXITS },
  known: Partial<SubscriptionModelListEnvelope> = {},
  tokenRefreshed = false,
  expectedDirectStderr = ""
): void {
  expect(exit).toBe(EXIT[failure.class]);
  expect(exit).toBe(FAILURE_EXITS[failure.class]);
  expectEnvelope(harness, { ...baseEnvelope(tokenRefreshed), ...known, failure });
  expectStderr(harness, "", expectedDirectStderr);
}

function expectRequestIdentity(request: RecordedRequest, access = ACCESS, version = "1.3.5"): void {
  expect(request.method).toBe("POST");
  expect(request.headers.get("Authorization")).toBe(`Bearer ${access}`);
  expect(request.headers.get("User-Agent")).toBe(
    `antigravity/cli/${version} (aidev_client; os_type=${process.platform}; arch=${process.arch}; auth_method=consumer)`
  );
}

function resetState(): void {
  _resetAgyClientVersion();
  _resetAntigravityServedModelsCache();
  resetAntigravityUserCache();
  _resetAntigravityTokenState();
  delete process.env.AICODE_ENDPOINT_URL;
}

beforeEach(() => {
  resetState();
  harnesses = [];
  directStderr = [];
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
    const chunk = args[0];
    directStderr.push(
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk)
    );
    const callback = args.find((arg) => typeof arg === "function");
    if (typeof callback === "function") callback();
    return true;
  });
  restoreStderr = () => stderrSpy.mockRestore();
  globalThis.fetch = (async () => {
    throw new Error("Unexpected network request in hermetic test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  try {
    const output = [
      ...harnesses.flatMap((harness) => [...harness.stdout, ...harness.stderr]),
      ...directStderr,
    ].join("");
    for (const canary of CANARIES) expect(output).not.toContain(canary);
  } finally {
    restoreStderr();
    globalThis.fetch = realFetch;
    resetState();
  }
});

describe("subscription models raw command output", () => {
  test.skipIf(process.platform !== "darwin")(
    "S1: emits one complete 1.3.5 JSON envelope through the command",
    async () => {
      const harness = makeHarness();
      const requests = installFetch();

      const exit = await subscriptionModelsCommand(VALID_ARGS, harness.deps);

      expect(exit).toBe(0);
      expectEnvelope(harness, { ...baseEnvelope(), ...answeredFields(), body: newCaptureText });
      expectStderr(harness);
      expect(requests.map((request) => request.url)).toEqual([
        `${HOST}/v1internal:loadCodeAssist`,
        MODELS_URL,
      ]);
      for (const request of requests) expectRequestIdentity(request);
      expect(requests[1].body).toEqual({ project: PROJECT });
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "S2: preserves internal ids, deprecated ids, displayName and agentModelSorts verbatim",
    async () => {
      const body = newCaptureText.replace(
        "{",
        '{\n  "deprecatedModelIds": {"gemini-3.1-pro-high": {"newModelId": "gemini-pro-agent"}},'
      );
      const parsedBody: CapturedModels = JSON.parse(body);
      const harness = makeHarness();
      installFetch({ models: () => vendorText(body) });

      const exit = await runAntigravityRawModelList(harness.deps);

      expect(exit).toBe(0);
      const envelope = expectEnvelope(harness, { ...baseEnvelope(), ...answeredFields(), body });
      const actual: CapturedModels = JSON.parse(envelope.body as string);
      expect(actual.models.chat_20706?.isInternal).toBe(true);
      expect(actual.models["gemini-2.5-flash"]?.displayName).toBe("Gemini 3.5 Flash Lite");
      expect(actual.deprecatedModelIds?.["gemini-3.1-pro-high"]).toEqual({
        newModelId: "gemini-pro-agent",
      });
      expect(actual.agentModelSorts).toEqual(parsedBody.agentModelSorts);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(parsedBody));
      expectStderr(harness);
    }
  );

  for (const mode of ["omitted", "null"] as const) {
    test.skipIf(process.platform !== "darwin")(
      `S3-${mode}: reports the 1.1.9 fallback actually sent`,
      async () => {
        const harness = makeHarness();
        if (mode === "omitted") delete harness.tokenDeps.readAgyVersion;
        else harness.tokenDeps.readAgyVersion = () => null;
        const requests = installFetch({ models: () => vendorText(oldCaptureText) });

        const exit = await runAntigravityRawModelList(harness.deps);

        expect(exit).toBe(0);
        expectEnvelope(harness, {
          ...baseEnvelope(),
          ...answeredFields(),
          clientVersion: "1.1.9",
          clientVersionSource: "fallback",
          body: oldCaptureText,
        });
        for (const request of requests) expectRequestIdentity(request, ACCESS, "1.1.9");
        expect(requests[1].body).toEqual({ project: PROJECT });
        expectStderr(harness);
      }
    );
  }

  test.skipIf(process.platform !== "darwin")(
    "S4: reports a requested refresh and sends the reminted token",
    async () => {
      const harness = makeHarness({ expired: true, remint: true });
      const requests = installFetch();

      const exit = await runAntigravityRawModelList(harness.deps);

      expect(exit).toBe(0);
      expectEnvelope(harness, { ...baseEnvelope(true), ...answeredFields(), body: newCaptureText });
      for (const request of requests) expectRequestIdentity(request, REMINTED_ACCESS);
      expect(requests[1].body).toEqual({ project: PROJECT });
      expectStderr(harness);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "S5: fetches a new raw body on a second run without resetting the discovery cache",
    async () => {
      const first = makeHarness();
      const second = makeHarness();
      let nextBody = newCaptureText;
      const requests = installFetch({ models: () => vendorText(nextBody) });

      const firstExit = await runAntigravityRawModelList(first.deps);
      nextBody = oldCaptureText;
      const secondExit = await runAntigravityRawModelList(second.deps);

      expect(firstExit).toBe(0);
      expect(secondExit).toBe(0);
      expectEnvelope(first, { ...baseEnvelope(), ...answeredFields(), body: newCaptureText });
      expectEnvelope(second, { ...baseEnvelope(), ...answeredFields(), body: oldCaptureText });
      const modelRequests = requests.filter((request) =>
        request.url.endsWith(":fetchAvailableModels")
      );
      expect(modelRequests.map((request) => request.body)).toEqual([
        { project: PROJECT },
        { project: PROJECT },
      ]);
      for (const request of modelRequests) expectRequestIdentity(request);
      expectStderr(first);
      expectStderr(second);
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "S6: does not return an exit code until its large JSON line is flushed",
    async () => {
      const harness = makeHarness();
      installFetch();
      let announceWrite!: () => void;
      let releaseWrite!: () => void;
      const writeStarted = new Promise<void>((resolve) => {
        announceWrite = resolve;
      });
      const flush = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      harness.deps.writeStdout = async (line) => {
        harness.stdout.push(line);
        announceWrite();
        await flush;
      };
      const exits: number[] = [];
      const run = runAntigravityRawModelList(harness.deps).then((exit) => {
        exits.push(exit);
        return exit;
      });

      await writeStarted;
      await Promise.resolve();
      try {
        expect(exits).toEqual([]);
        expectEnvelope(harness, { ...baseEnvelope(), ...answeredFields(), body: newCaptureText });
      } finally {
        releaseWrite();
        await run;
      }

      expect(exits).toEqual([0]);
      expectStderr(harness);
    }
  );

  for (const status of [503, 401]) {
    test.skipIf(process.platform !== "darwin")(
      `S7-${status}: treats a non-2xx model response as exit 0 without body or failure`,
      async () => {
        const harness = makeHarness();
        installFetch({ models: () => new Response(`${ACCESS} ${REFRESH} ${PROJECT}`, { status }) });

        const exit = await runAntigravityRawModelList(harness.deps);

        expect(exit).toBe(0);
        expectEnvelope(harness, { ...baseEnvelope(), ...answeredFields(status) });
        expectStderr(harness);
      }
    );
  }

  test.skipIf(process.platform !== "darwin")(
    "S8: calls the configured host but removes userinfo from sourceUrl",
    async () => {
      process.env.AICODE_ENDPOINT_URL = "https://user:pw@example.test/";
      const harness = makeHarness();
      const requests = installFetch();

      const exit = await runAntigravityRawModelList(harness.deps);

      expect(exit).toBe(0);
      expectEnvelope(harness, {
        ...baseEnvelope(),
        ...answeredFields(),
        sourceUrl: "https://example.test/v1internal:fetchAvailableModels",
        body: newCaptureText,
      });
      expect(requests.map((request) => new URL(request.url).host)).toEqual([
        "example.test",
        "example.test",
      ]);
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/v1internal:loadCodeAssist",
        "/v1internal:fetchAvailableModels",
      ]);
      for (const request of requests) expectRequestIdentity(request);
      expect(requests[1].body).toEqual({ project: PROJECT });
      expect(harness.stdout.join("")).not.toContain("user:pw");
      expectStderr(harness);
    }
  );

  for (const [label, secret] of [
    ["project", PROJECT],
    ["access", ACCESS],
    ["refresh", REFRESH],
  ] as const) {
    test.skipIf(process.platform !== "darwin")(
      `S9-${label}: rejects an otherwise valid body containing a credential value`,
      async () => {
        const body = structuredClone(newCapture);
        body.secretGuardCanary = secret;
        const harness = makeHarness();
        installFetch({ models: () => vendorJson(body) });

        const exit = await runAntigravityRawModelList(harness.deps);

        expect(exit).toBe(1);
        expectEnvelope(harness, {
          ...baseEnvelope(),
          ...answeredFields(),
          failure: { class: "internal", code: "secret_guard" },
        });
        expectStderr(harness, `${SECRET_GUARD_MESSAGE}\n`);
      }
    );
  }

  test("S10: reports an unexpected dependency error with a fixed internal failure envelope", async () => {
    const harness = makeHarness();
    harness.deps.readStore = async () => {
      throw new Error(`${ACCESS} ${REFRESH} ${PROJECT}`);
    };

    const exit = await runAntigravityRawModelList(harness.deps);

    expect(exit).toBe(1);
    expectEnvelope(harness, {
      ...baseEnvelope(),
      failure: { class: "internal", code: "internal_error" },
    });
    expectStderr(harness, `${INTERNAL_ERROR_MESSAGE}\n`);
  });

  test.skipIf(process.platform !== "darwin")(
    "S11: preserves unusual JSON formatting and trailing whitespace byte for byte",
    async () => {
      const body = '{"models":{"a":{"maxTokens":1.0}} } ';
      const harness = makeHarness();
      installFetch({ models: () => vendorText(body) });

      const exit = await runAntigravityRawModelList(harness.deps);

      expect(exit).toBe(0);
      expectEnvelope(harness, { ...baseEnvelope(), ...answeredFields(), body });
      expectStderr(harness);
    }
  );
});

describe("subscription models D5 failures and field presence", () => {
  for (const platform of ["linux", "win32"]) {
    test(`F1-${platform}: rejects unsupported platforms before determining token or HTTP fields`, async () => {
      const harness = makeHarness({ platform });

      const exit = await runAntigravityRawModelList(harness.deps);

      expectFailure(harness, exit, { class: "credential_missing", code: "platform_unsupported" });
    });
  }

  const storeFailures = [
    { kind: "absent", class: "credential_missing", code: "keychain_item_absent" },
    { kind: "locked", class: "keychain_locked", code: "keychain_locked" },
    { kind: "timeout", class: "keychain_locked", code: "keychain_read_timeout" },
    { kind: "failed", class: "keychain_locked", code: "keychain_read_failed" },
  ] as const;
  for (const row of storeFailures) {
    test(`F2-${row.kind}: classifies the store read without adding token or HTTP fields`, async () => {
      const harness = makeHarness({ store: { kind: row.kind } });

      const exit = await runAntigravityRawModelList(harness.deps);

      expectFailure(harness, exit, { class: row.class, code: row.code });
    });
  }

  for (const [label, raw, expectedDirectStderr] of [
    [
      "unsupported-prefix",
      "go-keyring-chunked:unparseable",
      "[claudish] [Antigravity] Shared token is in an unsupported keyring format (not go-keyring-base64) — skipping.\n",
    ],
    ["invalid-json", "go-keyring-base64:" + Buffer.from("not json", "utf8").toString("base64"), ""],
  ] as const) {
    test.skipIf(process.platform !== "darwin")(
      `F3-${label}: reports token_unparseable without version, fetch fields or a refresh`,
      async () => {
        const harness = makeHarness({ store: { kind: "present", raw } });

        const exit = await runAntigravityRawModelList(harness.deps);

        expectFailure(
          harness,
          exit,
          { class: "credential_missing", code: "token_unparseable" },
          {},
          false,
          expectedDirectStderr
        );
      }
    );
  }

  const refreshFailures = [
    { outcome: { kind: "not-installed" }, code: "agy_missing" },
    { outcome: { kind: "timeout" }, code: "agy_refresh_timeout" },
    {
      outcome: { kind: "failed", detail: `${ACCESS} ${REFRESH} ${PROJECT}` },
      code: "agy_refresh_failed",
    },
    { outcome: { kind: "ran" }, code: "agy_refresh_no_valid_token" },
  ] as const;
  for (const row of refreshFailures) {
    test.skipIf(process.platform !== "darwin")(
      `F4-${row.code}: records an attempted refresh even when it produces no valid token`,
      async () => {
        const harness = makeHarness({ expired: true, refreshOutcome: row.outcome });

        const exit = await runAntigravityRawModelList(harness.deps);

        expectFailure(harness, exit, { class: "mint_failed", code: row.code }, {}, true);
      }
    );
  }

  for (const status of [400, 401, 403]) {
    test.skipIf(process.platform !== "darwin")(
      `F5-${status}: classifies loadCodeAssist 4xx without exposing its secret-bearing body`,
      async () => {
        const harness = makeHarness();
        installFetch({
          setup: () =>
            vendorJson({ error: { message: `${ACCESS} ${REFRESH} ${PROJECT}` } }, status),
        });

        const exit = await runAntigravityRawModelList(harness.deps);

        expectFailure(
          harness,
          exit,
          { class: "mint_failed", code: "load_code_assist_4xx", httpStatus: status },
          VERSION_FIELDS
        );
      }
    );
  }

  for (const status of [429, 500, 503]) {
    test.skipIf(process.platform !== "darwin")(
      `F6-${status}: classifies transient loadCodeAssist responses as network failures`,
      async () => {
        const harness = makeHarness();
        installFetch({
          setup: () =>
            vendorJson({ error: { message: `${ACCESS} ${REFRESH} ${PROJECT}` } }, status),
        });

        const exit = await runAntigravityRawModelList(harness.deps);

        expectFailure(
          harness,
          exit,
          {
            class: "network",
            code: status === 429 ? "load_code_assist_429" : "load_code_assist_5xx",
            httpStatus: status,
          },
          VERSION_FIELDS
        );
      }
    );
  }

  test.skipIf(process.platform !== "darwin")(
    "F7: classifies loadCodeAssist JSON without a project",
    async () => {
      const harness = makeHarness();
      installFetch({
        setup: () => vendorJson({ paidTier: { id: "g1-ultra-tier", name: "Ultra" } }),
      });

      const exit = await runAntigravityRawModelList(harness.deps);

      expectFailure(
        harness,
        exit,
        { class: "mint_failed", code: "load_code_assist_no_project" },
        VERSION_FIELDS
      );
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "F8: classifies non-JSON loadCodeAssist success bodies",
    async () => {
      const harness = makeHarness();
      installFetch({
        setup: () => new Response(`${ACCESS} ${REFRESH} ${PROJECT}`, { status: 200 }),
      });

      const exit = await runAntigravityRawModelList(harness.deps);

      expectFailure(
        harness,
        exit,
        { class: "mint_failed", code: "load_code_assist_bad_body" },
        VERSION_FIELDS
      );
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "F9: classifies loadCodeAssist fetch throws without exposing error text",
    async () => {
      const harness = makeHarness();
      installFetch({
        setup: () => {
          throw new TypeError(`${ACCESS} ${REFRESH} ${PROJECT}`);
        },
      });

      const exit = await runAntigravityRawModelList(harness.deps);

      expectFailure(
        harness,
        exit,
        { class: "network", code: "load_code_assist_network_error" },
        VERSION_FIELDS
      );
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "F10: classifies a loadCodeAssist deadline without model-response fields",
    async () => {
      const harness = makeHarness();
      installFetch({ setup: pendingResponse });

      const exit = await runAntigravityRawModelList(harness.deps);

      expectFailure(
        harness,
        exit,
        { class: "network", code: "load_code_assist_timeout" },
        VERSION_FIELDS
      );
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "F11: retains sourceUrl but not response fields when fetchAvailableModels throws",
    async () => {
      const harness = makeHarness();
      installFetch({
        models: () => {
          throw new TypeError(`${ACCESS} ${REFRESH} ${PROJECT}`);
        },
      });

      const exit = await runAntigravityRawModelList(harness.deps);

      expectFailure(
        harness,
        exit,
        { class: "network", code: "fetch_available_models_network_error" },
        ATTEMPT_FIELDS
      );
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "F12: classifies a fetchAvailableModels abort before any HTTP response",
    async () => {
      const harness = makeHarness();
      installFetch({ models: pendingResponse });

      const exit = await runAntigravityRawModelList(harness.deps);

      expectFailure(
        harness,
        exit,
        { class: "network", code: "fetch_available_models_timeout" },
        ATTEMPT_FIELDS
      );
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "F13: retains HTTP evidence when reading a 2xx model body fails",
    async () => {
      const harness = makeHarness();
      installFetch({ models: brokenBodyResponse });

      const exit = await runAntigravityRawModelList(harness.deps);

      expectFailure(
        harness,
        exit,
        {
          class: "network",
          code: "fetch_available_models_network_error",
          httpStatus: 200,
        },
        answeredFields()
      );
    }
  );

  for (const code of ["models_absent", "models_empty", "body_not_json"] as const) {
    test.skipIf(process.platform !== "darwin")(
      `F14-${code}: suppresses incomplete 2xx bodies but retains HTTP evidence`,
      async () => {
        const body = structuredClone(newCapture) as Partial<CapturedModels>;
        if (code === "models_absent") delete body.models;
        if (code === "models_empty") body.models = {};
        const harness = makeHarness();
        installFetch({
          models: () =>
            code === "body_not_json"
              ? new Response(`${ACCESS} ${REFRESH} ${PROJECT}`, { status: 200 })
              : vendorJson(body),
        });

        const exit = await runAntigravityRawModelList(harness.deps);

        expectFailure(
          harness,
          exit,
          { class: "list_incomplete", code, httpStatus: 200 },
          answeredFields()
        );
      }
    );
  }

  test("F15: keeps every failure code bounded and pins the internal codes", () => {
    expect(FAILURE_CODES.internal).toEqual(["usage", "secret_guard", "internal_error"]);
    for (const codes of Object.values(FAILURE_CODES)) {
      for (const code of codes) expect(code).toMatch(/^[a-z0-9_.:-]{1,120}$/);
    }
  });
});

describe("subscription models argument contract", () => {
  const invalidCases = [
    { label: "missing-raw", argv: ["models", "antigravity", "--json"] },
    { label: "missing-json", argv: ["models", "antigravity", "--raw"] },
    { label: "ag-shortcut", argv: ["models", "ag", "--raw", "--json"] },
    { label: "unknown-provider", argv: ["models", "unknown", "--raw", "--json"] },
    { label: "extra-token", argv: [...VALID_ARGS, "extra"] },
    { label: "empty", argv: [] },
    { label: "missing-models", argv: ["antigravity", "--raw", "--json"] },
    { label: "missing-provider", argv: ["models", "--raw", "--json"] },
    { label: "duplicate-raw", argv: [...VALID_ARGS, "--raw"] },
    { label: "duplicate-json", argv: [...VALID_ARGS, "--json"] },
    { label: "unknown-flag", argv: [...VALID_ARGS, "--debug"] },
  ];
  for (const { label, argv } of invalidCases) {
    test(`U1-${label}: rejects usage with exit 2, one JSON envelope and one fixed stderr line`, async () => {
      const harness = makeHarness();

      expect(parseSubscriptionModelsArgs(argv)).toEqual({ ok: false });
      const exit = await subscriptionModelsCommand(argv, harness.deps);

      expect(exit).toBe(2);
      expectEnvelope(harness, {
        schema: "claudish.subscription-model-list.v1",
        claudishVersion: VERSION,
        tokenRefreshed: false,
        failure: { class: "internal", code: "usage" },
      });
      expectStderr(harness, `${SUBSCRIPTION_MODELS_USAGE}\n`);
    });
  }

  for (const flags of [
    ["--raw", "--json"],
    ["--json", "--raw"],
  ]) {
    test(`U2-${flags.join("-")}: accepts each flag order and dispatches to the credential check`, async () => {
      const argv = ["models", "antigravity", ...flags];
      const harness = makeHarness({ store: { kind: "absent" } });

      expect(parseSubscriptionModelsArgs(argv)).toEqual({ ok: true, provider: "antigravity" });
      const exit = await subscriptionModelsCommand(argv, harness.deps);

      expectFailure(harness, exit, { class: "credential_missing", code: "keychain_item_absent" });
    });
  }
});

describe("fetchAntigravityAvailableModelsRaw public seam", () => {
  for (const status of [503, 401]) {
    test(`R1-${status}: leaves non-2xx response bodies unread`, async () => {
      const response = new Response(`${ACCESS} ${REFRESH} ${PROJECT}`, { status });
      const requests = installFetch({ models: () => response });

      const result = await fetchAntigravityAvailableModelsRaw(ACCESS, PROJECT, { now: () => NOW });

      expect(result).toEqual({
        kind: "answered",
        url: MODELS_URL,
        clientVersion: "1.1.9",
        clientVersionSource: "fallback",
        status,
        fetchedAt: new Date(NOW).toISOString(),
        body: { kind: "unread" },
      });
      expect(response.bodyUsed).toBe(false);
      expectRequestIdentity(requests[0], ACCESS, "1.1.9");
      expect(requests[0].body).toEqual({ project: PROJECT });
    });
  }

  test("R2: distinguishes a non-JSON 2xx body from an unread body", async () => {
    const requests = installFetch({ models: () => new Response("not JSON", { status: 200 }) });

    const result = await fetchAntigravityAvailableModelsRaw(ACCESS, PROJECT, { now: () => NOW });

    expect(result).toEqual({
      kind: "answered",
      url: MODELS_URL,
      clientVersion: "1.1.9",
      clientVersionSource: "fallback",
      status: 200,
      fetchedAt: new Date(NOW).toISOString(),
      body: { kind: "not-json" },
    });
    expectRequestIdentity(requests[0], ACCESS, "1.1.9");
    expect(requests[0].body).toEqual({ project: PROJECT });
  });

  test("R3: returns unreachable with attempted URL and version when fetch throws", async () => {
    const error = new TypeError("offline");
    const requests = installFetch({
      models: () => {
        throw error;
      },
    });

    const result = await fetchAntigravityAvailableModelsRaw(ACCESS, PROJECT, { now: () => NOW });

    expect(result).toEqual({
      kind: "unreachable",
      url: MODELS_URL,
      clientVersion: "1.1.9",
      clientVersionSource: "fallback",
      error,
    });
    expectRequestIdentity(requests[0], ACCESS, "1.1.9");
    expect(requests[0].body).toEqual({ project: PROJECT });
  });

  test("R4: returns the unprocessed body, injected arrival clock and fallback version actually sent", async () => {
    const requests = installFetch({ models: () => vendorText(oldCaptureText) });

    const result = await fetchAntigravityAvailableModelsRaw(ACCESS, PROJECT, { now: () => NOW });

    expect(result).toEqual({
      kind: "answered",
      url: MODELS_URL,
      clientVersion: "1.1.9",
      clientVersionSource: "fallback",
      status: 200,
      fetchedAt: new Date(NOW).toISOString(),
      body: { kind: "json", value: oldCapture, text: oldCaptureText },
    });
    expectRequestIdentity(requests[0], ACCESS, "1.1.9");
    expect(requests[0].body).toEqual({ project: PROJECT });
    expect(requests[0].headers.get("User-Agent")?.split(" ")[0]).toBe(
      `antigravity/cli/${result.clientVersion}`
    );
  });

  test.skipIf(process.platform !== "darwin")(
    "R5: reports the captured agy version used by a subsequent raw request",
    async () => {
      const harness = makeHarness();
      const requests = installFetch();
      const exit = await runAntigravityRawModelList(harness.deps);

      const result = await fetchAntigravityAvailableModelsRaw(ACCESS, PROJECT, { now: () => NOW });

      expect(exit).toBe(0);
      expectEnvelope(harness, { ...baseEnvelope(), ...answeredFields(), body: newCaptureText });
      expect(result).toEqual({
        kind: "answered",
        url: MODELS_URL,
        clientVersion: "1.3.5",
        clientVersionSource: "agy",
        status: 200,
        fetchedAt: new Date(NOW).toISOString(),
        body: { kind: "json", value: newCapture, text: newCaptureText },
      });
      const lastRequest = requests[requests.length - 1];
      expectRequestIdentity(lastRequest);
      expect(lastRequest.body).toEqual({ project: PROJECT });
      expect(lastRequest.headers.get("User-Agent")?.split(" ")[0]).toBe(
        `antigravity/cli/${result.clientVersion}`
      );
      expectStderr(harness);
    }
  );

  test("R6: distinguishes an unreadable 2xx stream from invalid JSON", async () => {
    const requests = installFetch({ models: brokenBodyResponse });

    const result = await fetchAntigravityAvailableModelsRaw(ACCESS, PROJECT, { now: () => NOW });

    expect(result).toEqual({
      kind: "answered",
      url: MODELS_URL,
      clientVersion: "1.1.9",
      clientVersionSource: "fallback",
      status: 200,
      fetchedAt: new Date(NOW).toISOString(),
      body: { kind: "read-failed" },
    });
    expectRequestIdentity(requests[0], ACCESS, "1.1.9");
    expect(requests[0].body).toEqual({ project: PROJECT });
  });

  test("R7: uses the endpoint override and trims its trailing slash for a raw request", async () => {
    process.env.AICODE_ENDPOINT_URL = "https://example.test/";
    const requests = installFetch();

    const result = await fetchAntigravityAvailableModelsRaw(ACCESS, PROJECT, { now: () => NOW });

    expect(result).toEqual({
      kind: "answered",
      url: "https://example.test/v1internal:fetchAvailableModels",
      clientVersion: "1.1.9",
      clientVersionSource: "fallback",
      status: 200,
      fetchedAt: new Date(NOW).toISOString(),
      body: { kind: "json", value: newCapture, text: newCaptureText },
    });
    expect(new URL(requests[0].url).host).toBe("example.test");
    expect(new URL(requests[0].url).pathname).toBe("/v1internal:fetchAvailableModels");
    expectRequestIdentity(requests[0], ACCESS, "1.1.9");
    expect(requests[0].body).toEqual({ project: PROJECT });
  });
});
