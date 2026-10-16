import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
});
async function waitForChild(child: ReturnType<typeof Bun.spawn>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          child.kill();
          resolve(124);
        }, 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let home: string;
let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;
let savedExit: typeof process.exit;
// Any unexpected CLI exit must fail the case instead of terminating Bun's runner.
class UnexpectedProcessExit extends Error {
  constructor(code?: string | number | null) {
    super(`RUN5_PROCESS_EXIT:${code ?? 0}`);
    this.name = "UnexpectedProcessExit";
  }
}
beforeEach(() => {
  savedEnv = { CLAUDISH_DISABLE_KEYCHAIN: process.env.CLAUDISH_DISABLE_KEYCHAIN };
  home = mkdtempSync(join(tmpdir(), "muse-run5-"));
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  savedExit = process.exit;
  process.exit = (code?: string | number | null): never => {
    throw new UnexpectedProcessExit(code);
  };
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Unexpected network in Run 5 test");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
});
function restoreHarness() {
  process.exit = savedExit;
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}

// HOME is not an isolation seam in Bun. Every filesystem-capable dependency
// below is explicit and test-owned; omitted production defaults are forbidden.
function fakeCoreDeps(
  overrides: Partial<import("../meta-muse/muse-credentials.js").MuseCoreDeps> = {}
): import("../meta-muse/muse-credentials.js").MuseCoreDeps {
  return {
    dir: () => home,
    now: () => 1792088000000,
    readStore: () => null,
    writeBorrowedCopy: () => {
      throw new Error("Unexpected borrowed-copy write");
    },
    mint: async () => {
      throw new Error("Unexpected mint");
    },
    keychainLogin: async () => {
      throw new Error("Keychain forbidden");
    },
    ...overrides,
  };
}
function fakeMuseKeychainDeps(
  overrides: Partial<import("../meta-muse/muse-keychain.js").MuseKeychainDeps> = {}
): import("../meta-muse/muse-keychain.js").MuseKeychainDeps {
  return {
    dir: () => home,
    env: () => ({}),
    now: () => 1792088000000,
    sleep: async () => {
      throw new Error("Unexpected Keychain wait");
    },
    pid: () => 424242,
    isAlive: () => false,
    presence: async () => ({ kind: "absent" }),
    startRead: () => {
      throw new Error("Keychain forbidden");
    },
    ...overrides,
  };
}
let previousConfigPath: string | null;
const restoreRegistrations: (() => void)[] = [];
beforeEach(async () => {
  const keychain = await import("../keychain.js");
  const forbidden = () => {
    throw new Error("Real Keychain process forbidden");
  };
  keychain.setKeychainTestDeps({
    platform: () => "darwin",
    run: forbidden,
    runAsync: async () => forbidden(),
    spawnAsync: forbidden,
  });
  const core = await import("../meta-muse/muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(fakeCoreDeps());
  const museKeychain = await import("../meta-muse/muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(fakeMuseKeychainDeps());
  (await import("../../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  const config = await import("../../config-override.js");
  previousConfigPath = config.getConfigFileOverride();
  config.setConfigFileOverride(join(home, "config.json"));
});
afterEach(async () => {
  for (const restore of restoreRegistrations.splice(0).reverse()) restore();
  const core = await import("../meta-muse/muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  const museKeychain = await import("../meta-muse/muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(null);
  const keychain = await import("../keychain.js");
  keychain.invalidateKeychainCache();
  keychain.setKeychainTestDeps(null);
  (await import("../../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  (await import("../../auth/credentials/billing-probe.js")).clearSignedArm();
  (await import("../model-discovery.js")).invalidateModelDiscovery("meta-muse-code");
  (await import("../all-models-cache.js"))._clearAllModelsCacheMemo();
  (await import("../catalog-client.js"))._resetCatalogClient();
  (await import("../../config-override.js")).setConfigFileOverride(previousConfigPath);
  restoreHarness();
});

test("T2: mint ignores hostile endpoint env and uses the fixed HTTPS Meta root", async () => {
  const names = ["META_BASE_URL", "MUSE_BASE_URL", "MUSE_CODE_BASE_URL"] as const;
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const requests: { url: string; authorization: string | null; body: unknown }[] = [];
  let hostileRequests = 0;
  const hostile = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hostileRequests++;
      return new Response("must not receive a Muse credential", { status: 500 });
    },
  });
  try {
    for (const name of names) process.env[name] = hostile.url.origin;
    const { mintMuseApiKey } = await import("../meta-muse/muse-mint.js");
    const { MUSE_MODELS_URL } = await import("../meta-muse/muse-models.js");
    // §8 response structure with ASCII credential placeholders and a hostile base_url mutation.
    await mintMuseApiKey("dca:TESTTOKEN0001", {
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const authorization = new Headers(init?.headers).get("authorization");
          expect(typeof init?.body).toBe("string");
          requests.push({
            url: input instanceof Request ? input.url : String(input),
            authorization,
            body: JSON.parse(String(init?.body)),
          });
          return Response.json({
            api_key: "LLM|TESTKEY0001",
            base_url: hostile.url.origin,
            has_payment_method: true,
            require_payment: false,
            is_subs_active: true,
            can_subscribe: false,
            show_subs_upsell: true,
            user_full_name: "TEST USER",
            user_email: "test@example.invalid",
            user_avatar_url: null,
            payment_method: "TEST PAYMENT METHOD",
            action_url: null,
            subs_tier_id: "<tier-id>",
            subs_tier_name: "Muse Code Power Usage",
            is_subs_upgrade_available: true,
            subs_usage: {
              window: { used_percent: 1, window_duration_mins: 300, resets_at: 1792136182 },
              weekly: { used_percent: 0, resets_at: 1792368000 },
              tier: "<tier-id>",
            },
          });
        },
        { preconnect: () => {} }
      ) as typeof fetch,
    });
    expect(requests).toEqual([
      {
        url: "https://api.meta.ai/muse-code/key",
        authorization: "Bearer dca:TESTTOKEN0001",
        body: { onboard: false },
      },
    ]);
    expect(MUSE_MODELS_URL).toBe("https://api.meta.ai/muse-code/models");
    expect(hostileRequests).toBe(0);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await hostile.stop(true);
  }
});

// Install the real credential implementation through the declared authority seam.
async function withTransport(
  run: (
    t: import("./meta-muse-code.js").MuseCodeTransport,
    counts: { mints: number }
  ) => Promise<void>,
  baseUrl = "https://api.meta.ai/v1"
) {
  const core = await import("../meta-muse/muse-credentials.js");
  const d = await import("../model-discovery.js");
  await import("../model-discovery-builtins.js");
  const { credentials } = await import("../../auth/credentials/authority.js");
  const { MuseCodeCredentialProvider } = await import(
    "../../auth/credentials/muse-code-credential.js"
  );
  const { setCredentialPromptRole } = await import("../../auth/credentials/prompt-role.js");
  const { clearSignedArm } = await import("../../auth/credentials/billing-probe.js");
  const { MuseCodeTransport } = await import("./meta-muse-code.js");
  const prior = credentials.get("meta-muse-code");
  if (!prior) throw new Error("default Muse credential missing");
  const fetcher = d.getModelDiscoveryFetcher("muse-code-models");
  if (!fetcher) throw new Error("default discovery missing");
  restoreRegistrations.push(() => {
    credentials.register(prior);
    credentials.invalidate("meta-muse-code");
    d.registerModelDiscoveryFetcher("muse-code-models", fetcher);
  });
  const role = setCredentialPromptRole("never");
  const counts = { mints: 0 };
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps({
    ...fakeCoreDeps(),
    dir: () => home,
    readStore: (kind) => (kind === "borrowed-copy" ? { access_token: "dca:TESTTOKEN0001" } : null),
    keychainLogin: async () => {
      throw new Error("Keychain forbidden");
    },
    mint: async () => ({ apiKey: ++counts.mints === 1 ? "LLM|TESTKEY0001" : "LLM|TESTKEY0002" }),
  });
  credentials.register(new MuseCodeCredentialProvider());
  d.invalidateModelDiscovery("meta-muse-code");
  d.registerModelDiscoveryFetcher("muse-code-models", async () => ({
    kind: "models",
    models: [{ id: "muse-spark-1.3", contextWindow: 262144, reported: "chat" }],
  }));
  const transport = new MuseCodeTransport(
    {
      name: "meta-muse-code",
      baseUrl,
      apiPath: "/hostile",
      prefixes: ["muse@"],
      apiKeyEnvVar: "",
      streamFormatOverride: "openai-responses-sse",
    },
    "muse-spark-1.3",
    "constructor-key-must-not-sign"
  );
  try {
    await run(transport, counts);
  } finally {
    credentials.register(prior);
    credentials.invalidate("meta-muse-code");
    clearSignedArm();
    d.registerModelDiscoveryFetcher("muse-code-models", fetcher);
    d.invalidateModelDiscovery("meta-muse-code");
    core.resetMuseCredentialState();
    core.setMuseCoreTestDeps(null);
    setCredentialPromptRole(role);
  }
}

test("T1: Responses endpoint, minted bearer and stateless tool/reasoning payload", async () => {
  await withTransport(async (t, counts) => {
    await t.refreshAuth();
    expect(t.getEndpoint()).toBe("https://api.meta.ai/v1/responses");
    expect(t.overrideStreamFormat() ?? t.streamFormat).toBe("openai-responses-sse");
    expect(
      Object.entries(await t.getHeaders()).find(
        ([name]) => name.toLowerCase() === "authorization"
      )?.[1]
    ).toBe("Bearer LLM|TESTKEY0001");
    // Tool-round-trip item structures from §2.3 with ASCII placeholder values.
    const input = [
      {
        type: "reasoning",
        id: "rs_TEST0001:rs_TEST0002",
        encrypted_content: "Q-PaDgTESTENCRYPTED0001",
      },
      {
        type: "function_call",
        id: "fc_TEST0001",
        call_id: "call_TEST0001",
        name: "muse.read_file",
        arguments: '{"path":"note.txt"}',
      },
      {
        type: "function_call_output",
        call_id: "call_TEST0001",
        output: "Read text file `note.txt`.\n1|The secret word is MANGO-42.",
      },
    ];
    const payload = t.transformPayload({
      model: "muse-spark-1.3",
      input,
      store: true,
      reasoning: { effort: "high" },
    });
    expect(payload).toMatchObject({ store: false, reasoning: { summary: "auto", effort: "high" } });
    expect(payload.include).toContain("reasoning.encrypted_content");
    expect(payload.input).toEqual(input);
    expect(counts.mints).toBe(1);
  });
});

test("T1: subscription_usage after completed preserves text, tools, usage and one completion", async () => {
  const { Hono } = await import("hono");
  const { createResponsesStreamHandler } = await import(
    "../../handlers/shared/stream-parsers/openai-responses-sse.js"
  );
  // Capture-derived reconstruction: §2.4 event fields, §2.3 tool item.
  const call = {
    type: "function_call",
    id: "fc_TEST0001",
    call_id: "call_TEST0001",
    name: "muse.read_file",
    arguments: '{"path":"note.txt"}',
  };
  const reasoning = {
    type: "reasoning",
    id: "rs_TEST0001:rs_TEST0002",
    encrypted_content: "Q-PaDgTESTENCRYPTED0001",
  };
  const events = [
    { type: "response.created", response: { id: "resp_[redacted]" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_[redacted]", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "PONG" },
    { type: "response.output_item.added", output_index: 2, item: reasoning },
    { type: "response.output_item.done", output_index: 2, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: call.id,
      delta: call.arguments,
    },
    { type: "response.output_item.done", output_index: 1, item: call },
    {
      type: "response.completed",
      response: {
        id: "resp_[redacted]",
        usage: {
          input_tokens: 27,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 9,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    },
    {
      type: "response.subscription_usage",
      subscription: {
        tier: "<tier-id>",
        weekly: { resets_at: 1792368000, used_percent: 0 },
        window: { resets_at: 1792088451, used_percent: 2, window_duration_mins: 300 },
      },
    },
  ];
  const wire =
    events
      .map(
        (e, sequence_number) =>
          `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number })}\n\n`
      )
      .join("") + "data: [DONE]\n\n";
  const usage: number[][] = [];
  let ends = 0;
  const app = new Hono();
  app.get("/", (c) =>
    createResponsesStreamHandler(
      c,
      new Response(wire, { headers: { "content-type": "text/event-stream" } }),
      {
        modelName: "muse-spark-1.3",
        onTokenUpdate: (i, o) => usage.push([i, o]),
        onTurnEnd: () => {
          ends++;
        },
      }
    )
  );
  const response = await app.request("http://localhost/");
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain("PONG");
  expect(body).toContain("muse.read_file");
  expect(body).toContain("note.txt");
  expect(body.match(/event: message_stop/g) ?? []).toHaveLength(1);
  expect(usage.at(-1)).toEqual([27, 9]);
  expect(ends).toBe(1);
  // Replay the parsed reasoning cache through the Responses converter on the
  // next Anthropic tool-result turn; use the public adapter constructor/methods.
  const { CodexAPIFormat } = await import("../../adapters/codex-api-format.js");
  const adapter = new CodexAPIFormat("muse-spark-1.3", "openai-responses-sse", {
    codexExtras: false,
  });
  const emittedTool = body.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!data || data.slice(6) === "[DONE]") return [];
    const event = JSON.parse(data.slice(6));
    return event.type === "content_block_start" && event.content_block?.type === "tool_use"
      ? [event.content_block]
      : [];
  });
  expect(emittedTool).toHaveLength(1);
  expect(typeof emittedTool[0].id).toBe("string");
  expect(emittedTool[0].id.length).toBeGreaterThan(0);
  const emittedToolId = emittedTool[0].id;
  const original = {
    model: "muse-spark-1.3",
    max_tokens: 64,
    stream: true,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: emittedToolId, name: call.name, input: { path: "note.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: emittedToolId,
            content: "Read text file `note.txt`.\n1|The secret word is MANGO-42.",
          },
        ],
      },
    ],
  };
  const replay = adapter.buildPayload(original, adapter.convertMessages(original), []);
  expect(replay.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "reasoning",
        encrypted_content: reasoning.encrypted_content,
      }),
      expect.objectContaining({
        type: "function_call",
        call_id: emittedToolId,
        name: call.name,
        arguments: call.arguments,
      }),
      expect.objectContaining({
        type: "function_call_output",
        call_id: emittedToolId,
        output: "Read text file `note.txt`.\n1|The secret word is MANGO-42.",
      }),
    ])
  );
});

test("T2: hostile provider/config/.env cannot redirect inference or models", async () => {
  const { getConfigFileOverride, setConfigFileOverride } = await import("../../config-override.js");
  const { getProviderByName, getEffectiveBaseUrl } = await import("../provider-definitions.js");
  const previous = getConfigFileOverride();
  const names = ["META_BASE_URL", "MUSE_BASE_URL", "MUSE_CODE_BASE_URL"];
  const saved = names.map((n) => [n, process.env[n]] as const);
  let hostileRequests = 0;
  const hostile = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hostileRequests++;
      return new Response("forbidden");
    },
  });
  const urls: string[] = [];
  try {
    for (const n of names) process.env[n] = hostile.url.origin;
    writeFileSync(join(home, ".env"), names.map((n) => `${n}=${hostile.url.origin}`).join("\n"));
    const config = join(home, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        version: "1",
        defaultProfile: "default",
        profiles: {},
        endpoints: { "meta-muse-code": hostile.url.origin, muse: hostile.url.origin },
      })
    );
    setConfigFileOverride(config);
    const def = getProviderByName("meta-muse-code");
    if (!def) throw new Error("Muse definition missing");
    expect(new URL(getEffectiveBaseUrl(def)).hostname).toBe("api.meta.ai");
    await withTransport(async (t) => {
      await t.refreshAuth();
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request) => {
          const url = input instanceof Request ? input.url : String(input);
          urls.push(url);
          if (url === "https://api.meta.ai/muse-code/models") return Response.json({ data: [] });
          if (url === "https://api.meta.ai/v1/responses")
            return new Response("data: [DONE]\n\n", {
              headers: { "content-type": "text/event-stream" },
            });
          throw new Error(`Unexpected URL ${url}`);
        },
        { preconnect: () => {} }
      ) as typeof fetch;
      const { fetchMuseCodeModelsCatalog } = await import("../meta-muse/muse-models.js");
      await fetchMuseCodeModelsCatalog();
      await fetch(t.getEndpoint(), {
        method: "POST",
        headers: await t.getHeaders(),
        body: JSON.stringify(t.transformPayload({ input: [] })),
      });
    }, hostile.url.origin);
    expect(urls).toEqual([
      "https://api.meta.ai/muse-code/models",
      "https://api.meta.ai/v1/responses",
    ]);
    expect(hostileRequests).toBe(0);
    // Bun's fresh process loads this test-owned .env before any module import.
    // Remove the parent overrides so that this assertion actually tests .env.
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
    };
    for (const n of names) delete childEnv[n];
    const script = `
const realExit = process.exit.bind(process);
process.on("uncaughtException", error => { console.error(error); realExit(1); });
process.on("unhandledRejection", error => { console.error(error); realExit(1); });
      globalThis.fetch = async () => { throw new Error("network forbidden"); };
      const { setConfigFileOverride } = await import(${JSON.stringify(new URL("../../config-override.js", import.meta.url).href)});
      setConfigFileOverride(${JSON.stringify(config)});
      const core = await import(${JSON.stringify(new URL("../meta-muse/muse-credentials.js", import.meta.url).href)});
      core.setMuseCoreTestDeps({ dir: () => ${JSON.stringify(home)}, now: () => 1792088000000,
        readStore: () => null, writeBorrowedCopy: () => { throw new Error("write forbidden"); },
        keychainLogin: async () => { throw new Error("Keychain forbidden"); },
        mint: async () => { throw new Error("mint forbidden"); } });
      const { MuseCodeTransport } = await import(${JSON.stringify(new URL("./meta-muse-code.js", import.meta.url).href)});
      const { MUSE_MODELS_URL } = await import(${JSON.stringify(new URL("../meta-muse/muse-models.js", import.meta.url).href)});
      const t = new MuseCodeTransport({ name: "meta-muse-code", baseUrl: process.env.MUSE_CODE_BASE_URL,
        apiPath: "/hostile", apiKeyEnvVar: "", prefixes: ["muse@"] }, "muse-spark-1.3", "");
      console.log(JSON.stringify([process.env.MUSE_CODE_BASE_URL, t.getEndpoint(), MUSE_MODELS_URL]));
      realExit(0);
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: home,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      waitForChild(child),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout.trim())).toEqual([
      hostile.url.origin,
      "https://api.meta.ai/v1/responses",
      "https://api.meta.ai/muse-code/models",
    ]);
  } finally {
    setConfigFileOverride(previous);
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    await hostile.stop(true);
  }
});

for (const freshRejected of [false, true]) {
  test(`T3: handler remints once after 401; fresh-key rejection=${freshRejected}`, async () => {
    await withTransport(async (t, counts) => {
      const { Hono } = await import("hono");
      const { ComposedHandler } = await import("../../handlers/composed-handler.js");
      const requests: { url: string; headers: unknown }[] = [];
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          expect(url).toBe("https://api.meta.ai/v1/responses");
          requests.push({ url, headers: init?.headers });
          if (requests.length === 2 && !freshRejected) {
            // Capture-derived reconstruction from §2.4.
            const events = [
              { type: "response.created", response: { id: "resp_[redacted]" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "msg_[redacted]", role: "assistant", content: [] },
              },
              {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                delta: "PONG",
              },
              {
                type: "response.completed",
                response: { id: "resp_[redacted]", usage: { input_tokens: 27, output_tokens: 9 } },
              },
            ];
            return new Response(
              events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") +
                "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } }
            );
          }
          // Captured §7 synthetic invalid-key body, repeated on rejected refresh.
          return Response.json(
            { error: { type: "invalid_api_key", message: "Unauthorized" } },
            { status: 401 }
          );
        },
        { preconnect: () => {} }
      ) as typeof fetch;
      const handler = new ComposedHandler(t, "muse@muse-spark-1.3", "muse-spark-1.3", 0);
      const app = new Hono();
      app.post("/", (c) =>
        handler.handle(c, {
          model: "muse-spark-1.3",
          messages: [{ role: "user", content: "PONG" }],
          max_tokens: 16,
          stream: true,
        })
      );
      try {
        const response = await app.request("http://localhost/", { method: "POST" });
        expect(response.status).toBe(freshRejected ? 400 : 200);
        const body = await response.text();
        if (freshRejected) {
          expect(response.headers.get("x-claudish-auth-verdict")).toBe("terminal");
          expect(body).toContain("claudish login muse");
        } else expect(body).toContain("PONG");
        expect(counts.mints).toBe(2);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[0].headers)).toContain("Bearer LLM|TESTKEY0001");
        expect(JSON.stringify(requests[1].headers)).toContain("Bearer LLM|TESTKEY0002");
        expect(JSON.stringify(requests)).not.toContain("constructor-key-must-not-sign");
      } finally {
        await handler.shutdown();
      }
    });
  });
}

// The parser and Responses converter share a process-wide reasoning cache.
beforeEach(async () => {
  (await import("../../adapters/reasoning-cache.js")).clearReasoningCache();
});
afterEach(async () => {
  (await import("../../adapters/reasoning-cache.js")).clearReasoningCache();
});
