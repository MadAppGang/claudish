import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const OWN = "dca:TESTTOKEN0001";
const BORROWED = "dca:TESTTOKEN0002";
const KEYCHAIN = "dca:TESTTOKEN0003";
const KEY = "LLM|TESTKEY0001";
const TIER = "Muse Code Power Usage";
const children: ReturnType<typeof Bun.spawn>[] = [];
let dir: string;
let savedEnv: Map<string, string | undefined>;
let savedFetch: typeof fetch;
let core: typeof import("./muse-credentials.js");
let store: typeof import("./muse-store.js");
let keychain: typeof import("./muse-keychain.js");
let generic: typeof import("../keychain.js");
let roles: typeof import("../../auth/credentials/prompt-role.js");
let billing: typeof import("../../auth/credentials/billing-probe.js");
let mint: typeof import("./muse-mint.js");
let authority: import("../../auth/credentials/authority.js").CredentialAuthority;
let tier: string | undefined;
let mintStatus: number;
let mintTokens: string[];
let valueReads: number;
let keychainUses: number;
let keychainPresent: boolean;
let meteredSigns: number;

// Section 8 of contract/wire-capture.md, with inert ASCII credentials.
function capturedMint() {
  return {
    api_key: KEY,
    base_url: "https://api.meta.ai/v1",
    has_payment_method: true,
    require_payment: false,
    is_subs_active: true,
    can_subscribe: false,
    show_subs_upsell: true,
    user_full_name: "…",
    user_email: "…",
    user_avatar_url: null,
    payment_method: "…",
    action_url: null,
    subs_tier_id: "<tier-id>",
    subs_tier_name: tier,
    is_subs_upgrade_available: true,
    subs_usage: {
      window: { used_percent: 1, window_duration_mins: 300, resets_at: 1792136182 },
      weekly: { used_percent: 0, resets_at: 1792368000 },
      tier: "<tier-id>",
    },
  };
}

function rejectedMessage(status: number) {
  return `Meta rejected the Muse Code login (HTTP ${status}): it has expired or been revoked. Run \`claudish login muse\`, or one interactive \`claudish --model muse@<model>\` and allow Keychain access.`;
}

function sign() {
  return authority.getRequestAuth("meta-muse-code", { model: "muse-spark-1.3" });
}

function description(opts?: Parameters<typeof core.describeMuseSigningSource>[0]) {
  const result = core.describeMuseSigningSource(opts);
  for (const text of [result.label, result.detail]) {
    expect(text).not.toContain("dca:");
    expect(text).not.toContain("TESTTOKEN");
    expect(text).not.toContain("TESTKEY");
  }
  expect(valueReads).toBe(0);
  return result;
}

async function keyLine(result: import("./muse-credentials.js").MuseSigningDescription) {
  const { keyLineText } = await import("../../probe/probe-chain.js");
  const provenance: import("../api-key-provenance.js").KeyProvenance = {
    envVar: "",
    hasValue: result.present,
    effectiveMasked: null,
    effectiveLabel: result.label,
    effectiveSource: result.detail,
    layers: [],
  };
  return keyLineText(provenance);
}

beforeEach(async () => {
  dir = mkdtempSync(join(import.meta.dir, ".muse-reporting-"));
  savedEnv = new Map(
    ["CLAUDISH_DISABLE_KEYCHAIN", "CLAUDISH_DISABLE_CATALOG_WARM", "META_API_KEY"].map((name) => [
      name,
      process.env[name],
    ])
  );
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  process.env.CLAUDISH_DISABLE_CATALOG_WARM = "1";
  process.env.META_API_KEY = "TESTMETEREDKEY0001";
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("unexpected network request");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  tier = TIER;
  mintStatus = 200;
  mintTokens = [];
  valueReads = 0;
  keychainUses = 0;
  keychainPresent = false;
  meteredSigns = 0;
  generic = await import("../keychain.js");
  generic.setKeychainTestDeps({
    platform: () => "darwin",
    run: () => {
      throw new Error("unexpected Keychain process");
    },
    runAsync: async () => {
      throw new Error("unexpected Keychain process");
    },
    spawnAsync: () => {
      throw new Error("unexpected Keychain process");
    },
  });
  keychain = await import("./muse-keychain.js");
  keychain.resetMuseKeychainState();
  keychain.setMuseKeychainTestDeps({
    presence: async () => (keychainPresent ? { kind: "found" } : { kind: "absent" }),
    startRead: () => {
      valueReads++;
      throw new Error("reporting must never read a Keychain value");
    },
    isAlive: () => false,
    now: () => 1000000,
    sleep: async () => {},
    dir: () => dir,
    env: () => ({}),
    pid: () => 98765,
  });
  roles = await import("../../auth/credentials/prompt-role.js");
  roles._resetCredentialPromptRoleForTest();
  roles.setCredentialPromptRole("never");
  store = await import("./muse-store.js");
  mint = await import("./muse-mint.js");
  core = await import("./muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps({
    mint: async (token) => {
      mintTokens.push(token);
      return mint.mintMuseApiKey(token, {
        fetch: Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            expect(String(input)).toBe("https://api.meta.ai/muse-code/key");
            expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
            return mintStatus === 200
              ? Response.json(capturedMint())
              : Response.json(
                  {
                    error: {
                      code: "invalid_api_key",
                      message: "Unauthorized",
                      param: null,
                      type: "authentication_error",
                    },
                  },
                  { status: mintStatus }
                );
          },
          { preconnect: () => {} }
        ) as typeof fetch,
      });
    },
    readStore: (kind) => store.readMuseStore(kind, dir),
    writeBorrowedCopy: (token, name) =>
      store.writeBorrowedCopy(token, name, dir, () => new Date(1000000)),
    keychainLogin: async (use) => {
      keychainUses++;
      return { kind: "used", value: await use(KEYCHAIN), source: "keychain" };
    },
    now: () => 1000000,
    dir: () => dir,
  });
  const { CredentialAuthority } = await import("../../auth/credentials/authority.js");
  const { MuseCodeCredentialProvider } = await import(
    "../../auth/credentials/muse-code-credential.js"
  );
  authority = new CredentialAuthority();
  authority.register(new MuseCodeCredentialProvider());
  authority.register({
    catalogName: "meta",
    isAvailable: async () => true,
    getRequestAuth: async () => {
      meteredSigns++;
      return { headers: { Authorization: `Bearer ${process.env.META_API_KEY}` }, arm: "api-key" };
    },
  });
  billing = await import("../../auth/credentials/billing-probe.js");
  billing.clearSignedArm();
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  billing.clearSignedArm();
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  keychain.resetMuseKeychainState();
  keychain.setMuseKeychainTestDeps(null);
  generic.invalidateKeychainCache();
  generic.setKeychainTestDeps(null);
  roles._resetCredentialPromptRoleForTest();
  globalThis.fetch = savedFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("F1: per-request Muse signing source reporting", () => {
  for (const [source, text] of [
    ["claudish-login", "claudish login"],
    ["borrowed-copy", "borrowed copy"],
    ["keychain", "Muse Code CLI Keychain login"],
  ] as const) {
    for (const hasTier of [true, false]) {
      test(`museSignerLabel: ${source}, tier ${hasTier ? "present" : "absent"}`, () => {
        expect(core.museSignerLabel({ source, subsTierName: hasTier ? TIER : undefined })).toBe(
          `Muse Code ${text} · ${hasTier ? TIER : "tier unknown"}`
        );
      });
    }
  }

  test("signed Key line uses this response's signer, even when process state differs", async () => {
    store.writeMuseStore("own-login", { access_token: OWN, subs_tier_name: "OTHER TIER" }, dir);
    await sign();
    const label = "Muse Code borrowed copy · Muse Code Power Usage";
    const result = description({ signedWith: label, probed: true });
    expect(await keyLine(result)).toBe(
      "Muse Code borrowed copy · Muse Code Power Usage  (signed this probe request)"
    );
    expect(keychainUses).toBe(0);
  });

  test("no-login Key line keeps the exact file-only remedy in role never", async () => {
    roles.setCredentialPromptRole("never");
    keychainPresent = true;
    await keychain.museKeychainPresence();
    expect(await keyLine(description({ probed: true }))).toBe(
      "no claudish Muse Code login  (this process reads login files only, so a Muse Code CLI Keychain login cannot be used here: run `claudish login muse`, or one interactive `claudish --model muse@<model>` and allow Keychain access)"
    );
    expect(keychainUses).toBe(0);
    expect(mintTokens).toEqual([]);
  });

  for (const status of [401, 403]) {
    test(`rejected Key line keeps the HTTP ${status} remedy`, async () => {
      roles.setCredentialPromptRole("never");
      store.writeMuseStore("own-login", { access_token: OWN }, dir);
      mintStatus = status;
      await expect(sign()).rejects.toThrow(rejectedMessage(status));
      expect(await keyLine(description({ probed: true }))).toBe(
        `Muse Code login rejected  (${rejectedMessage(status)})`
      );
      expect(keychainUses).toBe(0);
    });
  }
});

describe("F2: rejected login reporting", () => {
  for (const status of [401, 403]) {
    test(`HTTP ${status} has the exact remedy`, () => {
      expect(core.museLoginRejectedMessage(status)).toBe(rejectedMessage(status));
      expect(core.museLoginRejectedMessage(status)).not.toContain("dca:");
    });
    for (const kind of ["own-login", "borrowed-copy"] as const) {
      test(`${kind} rejected with ${status} stays on disk and cannot sign with META_API_KEY`, async () => {
        const token = kind === "own-login" ? OWN : BORROWED;
        store.writeMuseStore(kind, { access_token: token, subs_tier_name: TIER }, dir);
        const path = store.museStorePath(kind, dir);
        const before = readFileSync(path, "utf8");
        mintStatus = status;
        const outcome = await sign().then(
          (auth) => ({ auth, message: "" }),
          (error: unknown) => ({
            auth: undefined,
            message: error instanceof Error ? error.message : String(error),
          })
        );
        expect(outcome.message).toBe(rejectedMessage(status));
        expect(outcome.message).not.toContain("dca:");
        expect(outcome.auth).toBeUndefined();
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(mintTokens).toEqual([token]);
        expect(core.currentMuseState()).toBeUndefined();
        expect(meteredSigns).toBe(0);
        expect(keychainUses).toBe(0);
        expect(valueReads).toBe(0);
      });
    }
  }

  test("no file retains the earlier team/MCP needs-a-claudish-login message", async () => {
    const message = await sign().then(
      () => "unexpected successful signing",
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    expect(message).toBe(
      "muse@ in a team slot / MCP session needs a claudish login: run `claudish login muse`, or one interactive `claudish --model muse@<model>` and allow Keychain access."
    );
    expect(message).not.toContain("dca:");
    expect(mintTokens).toEqual([]);
    expect(meteredSigns).toBe(0);
    expect(valueReads).toBe(0);
  });
});

// Production modules are imported only after the child's HOME and network guard
// are installed. The parent uses explicit file seams, never HOME mutation.
async function responseScenario(
  mode: "signed" | "concurrent" | "rejected",
  status = 200,
  kind: "own-login" | "borrowed-copy" = "borrowed-copy"
) {
  const root = resolve(import.meta.dir, "../..");
  const moduleUrl = (path: string) => JSON.stringify(`${root}/${path}.js`);
  const script = `
    const exit = process.exit.bind(process);
    globalThis.fetch = Object.assign(async () => {
      throw new Error("unexpected network request");
    }, { preconnect: () => {} });
    const { readFileSync, existsSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = process.env.HOME;
    const core = await import(${moduleUrl("providers/meta-muse/muse-credentials")});
    const store = await import(${moduleUrl("providers/meta-muse/muse-store")});
    const mint = await import(${moduleUrl("providers/meta-muse/muse-mint")});
    const generic = await import(${moduleUrl("providers/keychain")});
    const keychain = await import(${moduleUrl("providers/meta-muse/muse-keychain")});
    const roles = await import(${moduleUrl("auth/credentials/prompt-role")});
    const billing = await import(${moduleUrl("auth/credentials/billing-probe")});
    const config = await import(${moduleUrl("config-override")});
    const previousConfig = config.getConfigFileOverride();
    config.setConfigFileOverride(join(dir, "config.json"));
    let valueReads = 0, keychainUses = 0, meteredSigns = 0, inferenceCalls = 0;
    const mintTokens = [];
    const inferenceKeys = [];
    generic.setKeychainTestDeps({
      platform: () => "darwin",
      run: () => { throw new Error("Keychain forbidden"); },
      runAsync: async () => { throw new Error("Keychain forbidden"); },
      spawnAsync: () => { throw new Error("Keychain forbidden"); },
    });
    keychain.resetMuseKeychainState();
    keychain.setMuseKeychainTestDeps({
      presence: async () => ({ kind: "absent" }),
      startRead: () => { valueReads++; throw new Error("Keychain value forbidden"); },
      isAlive: () => false, now: () => 1000000, sleep: async () => {},
      dir: () => dir, env: () => ({}), pid: () => 98765,
    });
    core.resetMuseCredentialState();
    core.setMuseCoreTestDeps({
      dir: () => dir, now: () => 1000000,
      readStore: kind => store.readMuseStore(kind, dir),
      writeBorrowedCopy: (token, tier) => store.writeBorrowedCopy(token, tier, dir),
      keychainLogin: async () => { keychainUses++; throw new Error("Keychain forbidden"); },
      mint: async token => {
        mintTokens.push(token);
        return mint.mintMuseApiKey(token, {
          fetch: Object.assign(async (input, init) => {
            if (String(input) !== "https://api.meta.ai/muse-code/key") throw new Error("wrong mint URL");
            if (new Headers(init.headers).get("authorization") !== "Bearer " + token)
              throw new Error("wrong mint credential");
            return ${status} === 200
              ? Response.json({ ...${JSON.stringify(capturedMint())},
                  api_key: token === ${JSON.stringify(OWN)} ? "LLM|TESTKEY0001" : "LLM|TESTKEY0002" })
              : Response.json({ error: { code: "invalid_api_key", message: "Unauthorized",
                  param: null, type: "authentication_error" } }, { status: ${status} });
          }, { preconnect: () => {} }),
        });
      },
    });
    roles._resetCredentialPromptRoleForTest();
    roles.setCredentialPromptRole("never");
    const { credentials } = await import(${moduleUrl("auth/credentials/authority")});
    const { MuseCodeCredentialProvider } = await import(${moduleUrl("auth/credentials/muse-code-credential")});
    const previousMuse = credentials.get("meta-muse-code");
    const previousMeta = credentials.get("meta");
    if (!previousMuse || !previousMeta) throw new Error("default credentials missing");
    credentials.register(new MuseCodeCredentialProvider());
    credentials.register({ catalogName: "meta", isAvailable: async () => true,
      getRequestAuth: async () => {
        meteredSigns++;
        return { headers: { Authorization: "Bearer " + process.env.META_API_KEY }, arm: "api-key" };
      } });
    const discovery = await import(${moduleUrl("providers/model-discovery")});
    await import(${moduleUrl("providers/model-discovery-builtins")});
    const previousDiscovery = discovery.getModelDiscoveryFetcher("muse-code-models");
    if (!previousDiscovery) throw new Error("default Muse discovery missing");
    discovery.invalidateModelDiscovery("meta-muse-code");
    discovery.registerModelDiscoveryFetcher("muse-code-models", async () => ({
      kind: "models", models: [{ id: "muse-spark-1.3", reported: "chat" }],
    }));
    const handlers = [];
    try {
      const { Hono } = await import("hono");
      const { MuseCodeTransport } = await import(${moduleUrl("providers/transport/meta-muse-code")});
      const { ComposedHandler } = await import(${moduleUrl("handlers/composed-handler")});
      const { FallbackHandler } = await import(${moduleUrl("handlers/fallback-handler")});
      const { CodexAPIFormat } = await import(${moduleUrl("adapters/codex-api-format")});
      const { extractUpstreamStatus } = await import(${moduleUrl("handlers/shared/anthropic-error")});
      let transport;
      function handler() {
        transport = new MuseCodeTransport({ name: "meta-muse-code",
          baseUrl: "https://api.meta.ai/v1", apiPath: "/responses", apiKeyEnvVar: "",
          prefixes: ["muse@"], streamFormatOverride: "openai-responses-sse" }, "muse-spark-1.3", "");
        const result = new ComposedHandler(transport, "muse@muse-spark-1.3", "muse-spark-1.3", 0, {
          adapter: new CodexAPIFormat("muse-spark-1.3", "openai-responses-sse", { codexExtras: false }),
          isInteractive: false, invocationMode: "explicit-model",
          catalogCachePath: join(dir, "empty-catalog.json"),
        });
        handlers.push(result);
        return result;
      }
      const payload = { model: "muse-spark-1.3", messages: [{ role: "user", content: "PONG" }],
        max_tokens: 16, stream: true };
      function request(handler) {
        const app = new Hono();
        app.post("/v1/messages", c => handler.handle(c, payload));
        return app.request("http://localhost/v1/messages", { method: "POST" });
      }
      // Capture-derived response events: wire-capture.md section 2.4.
      const events = [
        { type: "response.created", response: { id: "resp_[redacted]" } },
        { type: "response.output_item.added", output_index: 0,
          item: { type: "message", id: "msg_[redacted]", role: "assistant", content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "PONG" },
        { type: "response.completed", response: { id: "resp_[redacted]",
          usage: { input_tokens: 27, input_tokens_details: { cached_tokens: 0 },
            output_tokens: 9, output_tokens_details: { reasoning_tokens: 2 } } } },
      ];
      function success() {
        return new Response(events.map((e, sequence_number) =>
          "event: " + e.type + "\\ndata: " + JSON.stringify({ ...e, sequence_number }) + "\\n\\n"
        ).join("") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });
      }
      let releaseFirst;
      let markFirst;
      const firstEntered = new Promise(resolve => { markFirst = resolve; });
      const firstGate = new Promise(resolve => { releaseFirst = resolve; });
      globalThis.fetch = Object.assign(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== "https://api.meta.ai/v1/responses") throw new Error("unexpected URL " + url);
        inferenceCalls++;
        const auth = new Headers(init?.headers).get("authorization");
        if (auth !== "Bearer LLM|TESTKEY0001" && auth !== "Bearer LLM|TESTKEY0002")
          throw new Error("unexpected inference credential");
        inferenceKeys.push(auth);
        if (${JSON.stringify(mode)} === "concurrent" && inferenceCalls === 1) {
          markFirst();
          await firstGate;
        }
        return success();
      }, { preconnect: () => {} });
      const kind = ${JSON.stringify(kind)};
      const token = kind === "own-login" ? ${JSON.stringify(OWN)} : ${JSON.stringify(BORROWED)};
      store.writeMuseStore(kind, { access_token: token, subs_tier_name: ${JSON.stringify(TIER)} }, dir);
      const path = store.museStorePath(kind, dir);
      const before = readFileSync(path, "utf8");
      let responses;
      if (${JSON.stringify(mode)} === "concurrent") {
        // Keep the first request in flight while a different source signs the second.
        store.deleteMuseStores(dir);
        store.writeMuseStore("own-login", { access_token: ${JSON.stringify(OWN)} }, dir);
        const sharedHandler = handler();
        const first = request(sharedHandler);
        await firstEntered;
        rmSync(store.museStorePath("own-login", dir));
        store.writeBorrowedCopy(${JSON.stringify(BORROWED)}, ${JSON.stringify(TIER)}, dir);
        // Rotate the SAME transport while its first signed request is held.
        await transport.forceRefreshAuth({
          rejectedHeaders: { Authorization: "Bearer LLM|TESTKEY0001" },
        });
        const secondResponse = await request(sharedHandler);
        releaseFirst();
        responses = [await first, secondResponse];
      } else if (${JSON.stringify(mode)} === "rejected") {
        const chain = new FallbackHandler([
          { name: "muse@muse-spark-1.3", provider: "meta-muse-code", handler: handler() },
          { name: "meta@muse-spark-1.3", provider: "meta", handler: {
            handle: async () => {
              await credentials.getRequestAuth("meta", { model: "muse-spark-1.3" });
              return new Response("metered fallback");
            }, shutdown: async () => {},
          } },
        ]);
        responses = [await request(chain)];
      } else responses = [await request(handler())];
      const results = [];
      for (const response of responses) {
        const body = await response.text();
        results.push({ status: response.status, body,
          signedWith: response.headers.get("x-claudish-signed-with"),
          verdict: response.headers.get("x-claudish-auth-verdict"),
          upstreamStatus: extractUpstreamStatus(body) });
      }
      console.log(JSON.stringify({ results, mintTokens, inferenceKeys, meteredSigns, inferenceCalls,
        valueReads, keychainUses, fileKept: existsSync(path) && readFileSync(path, "utf8") === before }));
    } finally {
      for (const handler of handlers) await handler.shutdown();
      credentials.register(previousMuse);
      credentials.register(previousMeta);
      credentials.invalidate("meta-muse-code");
      discovery.registerModelDiscoveryFetcher("muse-code-models", previousDiscovery);
      discovery.invalidateModelDiscovery("meta-muse-code");
      billing.clearSignedArm();
      core.resetMuseCredentialState();
      core.setMuseCoreTestDeps(null);
      keychain.resetMuseKeychainState();
      keychain.setMuseKeychainTestDeps(null);
      generic.invalidateKeychainCache();
      generic.setKeychainTestDeps(null);
      roles._resetCredentialPromptRoleForTest();
      config.setConfigFileOverride(previousConfig);
    }
    exit(0);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      TMPDIR: dir,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
      META_API_KEY: "TESTMETEREDKEY0001",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let code: number;
  try {
    code = await Promise.race([
      child.exited,
      new Promise<number>((done) => {
        timer = setTimeout(() => {
          child.kill();
          done(124);
        }, 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  expect({ code, stderr: code === 0 ? "" : await stderr }).toEqual({ code: 0, stderr: "" });
  await stderr;
  return JSON.parse((await stdout).trim()) as {
    results: {
      status: number;
      body: string;
      signedWith: string | null;
      verdict: string | null;
      upstreamStatus?: number;
    }[];
    mintTokens: string[];
    inferenceKeys: string[];
    meteredSigns: number;
    inferenceCalls: number;
    valueReads: number;
    keychainUses: number;
    fileKept: boolean;
  };
}

function expectSignerHeader(header: string | null, label: string) {
  expect(header).not.toBeNull();
  expect(header).toBe(encodeURIComponent(label));
  expect(decodeURIComponent(header!)).toBe(label);
  for (const text of [header!, decodeURIComponent(header!)]) {
    expect(text).not.toContain("dca:");
    expect(text).not.toContain("TESTTOKEN");
    expect(text).not.toContain("TESTKEY");
    expect(text).not.toContain("LLM|");
  }
}

describe("revision 2: HTTP reporting and terminal routing", () => {
  test("a signed Muse response URI-encodes only its source and tier", async () => {
    // Header encoding must also support a tier with non-header characters.
    tier = "Muse Code Power Usage · テスト";
    const result = await responseScenario("signed");
    expect(result.results[0].status).toBe(200);
    expect(result.results[0].body).toContain("PONG");
    expectSignerHeader(result.results[0].signedWith, `Muse Code borrowed copy · ${tier}`);
    expect(result.mintTokens).toEqual([BORROWED]);
    expect(result.valueReads).toBe(0);
    expect(result.keychainUses).toBe(0);
    expect(result.meteredSigns).toBe(0);
  }, 12000);

  test("two requests retain their signers when the shared transport rotates before response", async () => {
    const result = await responseScenario("concurrent");
    expect(result.results.map((response) => response.status)).toEqual([200, 200]);
    expectSignerHeader(result.results[0].signedWith, `Muse Code claudish login · ${TIER}`);
    expectSignerHeader(result.results[1].signedWith, `Muse Code borrowed copy · ${TIER}`);
    for (const response of result.results) {
      expect(response.body).toContain("PONG");
      expect(
        await keyLine(
          description({ signedWith: decodeURIComponent(response.signedWith!), probed: true })
        )
      ).toBe(`${decodeURIComponent(response.signedWith!)}  (signed this probe request)`);
    }
    expect(result.mintTokens).toEqual([OWN, BORROWED]);
    expect(result.inferenceKeys).toEqual(["Bearer LLM|TESTKEY0001", "Bearer LLM|TESTKEY0002"]);
    expect(result.inferenceCalls).toBe(2);
    expect(result.meteredSigns).toBe(0);
    expect(result.keychainUses).toBe(0);
    expect(result.valueReads).toBe(0);
  }, 12000);

  for (const status of [401, 403]) {
    for (const kind of ["own-login", "borrowed-copy"] as const) {
      // Owner rule 2026-10-21: a rejected subscription login moves a routing
      // chain on to its next hop, metered included. This test pinned the
      // earlier stop (no metered signing) and was updated.
      test(`${kind} mint ${status}: the chain moves past the rejected login to metered Meta and keeps the file`, async () => {
        const result = await responseScenario("rejected", status, kind);
        const response = result.results[0];
        expect(response.status).toBe(200);
        expect(response.body).toBe("metered fallback");
        expect(response.body).not.toContain("dca:");
        expect(result.fileKept).toBe(true);
        expect(result.mintTokens).toEqual([kind === "own-login" ? OWN : BORROWED]);
        expect(result.meteredSigns).toBe(1);
        expect(result.inferenceCalls).toBe(0);
        expect(result.keychainUses).toBe(0);
        expect(result.valueReads).toBe(0);
      }, 12000);
    }
  }
});

describe("revision 3: winner Key line and signed failures", () => {
  test("Details omits a dropped Muse Key line for a metered env-var winner", async () => {
    const { detailsKeyLine } = await import("../../probe/probe-tui-app.js");
    const muse: import("../../probe/probe-tui-app.js").ProbeResultLink = {
      provider: "meta-muse-code",
      displayName: "Muse Code",
      modelId: "muse-spark-1.3",
      hasCredentials: false,
      dropped: "no-credential",
      keyLine: "no claudish Muse Code login  (run `claudish login muse`)",
    };
    const metered: import("../../probe/probe-tui-app.js").ProbeResultLink = {
      provider: "meta",
      displayName: "Meta",
      modelId: "muse-spark-1.3",
      hasCredentials: true,
      credentialHint: "META_API_KEY",
      probe: { state: "live", latencyMs: 1, httpStatus: 200 },
    };
    expect(detailsKeyLine([muse, metered], metered)).toBeUndefined();
    expect(detailsKeyLine([metered, muse], metered)).toBeUndefined();
    expect(detailsKeyLine([muse, metered], undefined)).toBeUndefined();
  });

  test("Details returns the Muse winner's exact Key text", async () => {
    const { detailsKeyLine } = await import("../../probe/probe-tui-app.js");
    const text = "Muse Code borrowed copy · Muse Code Power Usage  (signed this probe request)";
    const muse: import("../../probe/probe-tui-app.js").ProbeResultLink = {
      provider: "meta-muse-code",
      displayName: "Muse Code",
      modelId: "muse-spark-1.3",
      hasCredentials: true,
      probe: { state: "live", latencyMs: 1, httpStatus: 200 },
      keyLine: text,
    };
    const other: import("../../probe/probe-tui-app.js").ProbeResultLink = {
      provider: "meta",
      displayName: "Meta",
      modelId: "muse-spark-1.3",
      hasCredentials: true,
    };
    expect(detailsKeyLine([other, muse], muse)).toBe(text);
    // The screen owns the label; both helpers return only its text.
    expect(`Key  ${detailsKeyLine([muse], muse)}`).toBe(
      "Key  Muse Code borrowed copy · Muse Code Power Usage  (signed this probe request)"
    );
  });

  test("rejected login 401 remains visible without a signer or failure", async () => {
    store.writeMuseStore("own-login", { access_token: OWN }, dir);
    mintStatus = 401;
    await expect(sign()).rejects.toThrow(rejectedMessage(401));
    const result = description({ probed: true });
    expect(await keyLine(result)).toBe(`Muse Code login rejected  (${rejectedMessage(401)})`);
    expect(keychainUses).toBe(0);
  });

  test("no provenance has no Key text", async () => {
    const { keyLineText } = await import("../../probe/probe-chain.js");
    expect(keyLineText(undefined)).toBeUndefined();
  });

  for (const state of ["server-error", "rate-limited", "model-not-found"] as const) {
    test(`signed then ${state} retains the response signer and exact failure detail`, async () => {
      const label = "Muse Code borrowed copy · Muse Code Power Usage";
      const result = description({ signedWith: label, probed: true, failure: state });
      const text = `${label}  (signed this probe request, which then failed: ${state})`;
      expect(await keyLine(result)).toBe(text);
      expect(`Key  ${await keyLine(result)}`).toBe(`Key  ${text}`);
      expect(keychainUses).toBe(0);
      expect(mintTokens).toEqual([]);
    });
  }

  for (const status of [401, 403]) {
    test(`signed-and-live probe takes precedence over rejected login ${status}`, async () => {
      store.writeMuseStore("own-login", { access_token: OWN }, dir);
      mintStatus = status;
      await expect(sign()).rejects.toThrow(rejectedMessage(status));
      const label = "Muse Code borrowed copy · Muse Code Power Usage";
      const result = description({ signedWith: label, probed: true });
      expect(result.present).toBe(true);
      expect(result.label).toBe(label);
      expect(result.detail).toBe("signed this probe request");
      expect(await keyLine(result)).toBe(
        "Muse Code borrowed copy · Muse Code Power Usage  (signed this probe request)"
      );
      expect(keychainUses).toBe(0);
    });
    test(`rejected login ${status} takes precedence over a supplied signer and failure`, async () => {
      store.writeMuseStore("own-login", { access_token: OWN }, dir);
      mintStatus = status;
      await expect(sign()).rejects.toThrow(rejectedMessage(status));
      const result = description({
        signedWith: "Muse Code borrowed copy · Muse Code Power Usage",
        probed: true,
        failure: "server-error",
      });
      expect(await keyLine(result)).toBe(`Muse Code login rejected  (${rejectedMessage(status)})`);
      expect(result.detail).not.toContain("signed this probe request");
      expect(keychainUses).toBe(0);
    });
  }
});
