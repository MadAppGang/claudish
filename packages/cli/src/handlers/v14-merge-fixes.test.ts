import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dir, "..");

// implementation-log.md § v14 merge fixes (2026-10-22), M2–M6.
// Status/echo faults are simulated; successful Responses bytes are recorded test data.
// All patches run in an isolated child, on an instance/prototype or a disposable COPY.
const program = String.raw`
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const src = process.env.TEST_SRC, root = process.env.HOME;
const scenario = process.env.SCENARIO, mutation = process.env.MUTATION;
mkdirSync(join(root, ".claudish"), { recursive: true });
writeFileSync(process.env.CLAUDISH_CONFIG, "{}");
const contacts = [], exchanges = [], signContexts = [];
let canary = 0, forced = 0;
const capture = readFileSync(join(src, "test-fixtures/sse-responses/codex-zero-delta-multicall.sse"), "utf8");
const inbound = JSON.parse(readFileSync(join(src, "test-fixtures/code-mode/claude-code-request-body.json"), "utf8"));
const request = {
  model: inbound.model, max_tokens: inbound.max_output_tokens, stream: scenario.startsWith("M5"),
  messages: inbound.input.filter(item => item.type === "message" && item.role === "user").slice(0, 1)
    .map(item => ({ role: item.role, content: item.content.filter(block => block.type === "input_text").map(block => ({ type: "text", text: block.text })) }))
};
const meter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { canary++; return new Response("METERED CANARY"); } });
let onInference;
const vendor = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (new URL(req.url).pathname.includes("token")) {
    exchanges.push(JSON.parse(await req.text()).refresh_token);
    if (scenario === "M2-invalid-grant") return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 });
  }
  contacts.push({ bearer: req.headers.get("authorization"), body: await req.text() });
  return onInference();
} });
process.env.CLAUDISH_TEST_UPSTREAM = "default=" + vendor.url.origin + ",api.openai.com=" + meter.url.origin;
const networkFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "127.0.0.1") throw new Error("Test forbids non-loopback network: " + url);
  return networkFetch(input, init);
};
function copyModule(path, text, name) {
  const out = join(root, name);
  writeFileSync(out, text.replace(/(from\s+|import\s*\(\s*)(["'])([^"']+)\2/g,
    (all, lead, quote, spec) => {
      if (!spec.startsWith(".")) {
        try { return lead + quote + Bun.resolveSync(spec, dirname(path)) + quote; }
        catch { return all; } // Comments containing 'from "..."' are not imports.
      }
      return lead + quote + Bun.resolveSync(spec, dirname(path)) + quote;
    }));
  return out;
}
const { Hono } = await import("hono");
const { setConfigFileOverride } = await import(src + "/config-override.ts");
setConfigFileOverride(process.env.CLAUDISH_CONFIG);
const { recordSignedArm } = await import(src + "/auth/credentials/billing-probe.ts");
await import(src + "/auth/credentials/authority.ts");
const { isSubscriptionProvider } = await import(src + "/handlers/shared/remote-provider-types.ts");
const { CodexOAuth, CodexOAuthLocalError, CodexOAuthRefreshError } = await import(src + "/auth/codex-oauth.ts");
let composedPath = src + "/handlers/composed-handler.ts";
let source = readFileSync(composedPath, "utf8"), patched = source;
let issuerPath;
if (scenario.startsWith("M5")) {
  issuerPath = join(root, "observe-issuer.ts");
  const real = src + "/handlers/shared/responses-leg-issuer.ts";
  writeFileSync(issuerPath, 'import {createLegIssuer as real} from ' + JSON.stringify(real) + ';\nexport * from ' + JSON.stringify(real) + ';\nexport let issue; export function createLegIssuer(deps) { issue = real(deps); return issue; }');
  patched = patched.replace('"./shared/responses-leg-issuer.js"', JSON.stringify(issuerPath));
}
const beforeMutation = patched;
if (mutation === "global-billing" && scenario.startsWith("M3"))
  patched = patched.replaceAll("this.signedBilling(binding).subscription &&", "isSubscriptionProvider(this.provider.name) &&");
if (mutation === "spend-before-connect" && scenario.startsWith("M5"))
  patched = patched.replace("const refreshed = await providerForceRefresh({", "state.forcedSignSpent = true;\n              const refreshed = await providerForceRefresh({");
if (mutation === "unspent-terminal" && scenario.startsWith("M5"))
  patched = patched.replace("if (!classifyConnectionError(err)) state.forcedSignSpent = true;", "");
if (mutation === "not-resent-401" && scenario === "M6")
  patched = patched.replace(/if \(!resent\) \{\s*return c\.json\([\s\S]*?\n\s*\);\s*\}/,
    'if (!resent) { return c.json(wrapAnthropicError(401, errorText), 401); }');
if (mutation && !scenario.startsWith("M2") && patched === beforeMutation) throw new Error("mutation did not reach source seam");
if (patched !== source) composedPath = copyModule(composedPath, patched, "composed-handler.ts");
const { ComposedHandler } = await import(composedPath);
const { FallbackHandler } = await import(src + "/handlers/fallback-handler.ts");
const { CodexAPIFormat } = await import(src + "/adapters/codex-api-format.ts");
let transport, faultPath, billingProjection;
let explicit = false;
const auth = (arm = "oauth", account = "account-a", token = "TOKEN_A") => ({
  auth: { arm, endpoint: vendor.url.origin + "/responses", headers: { Authorization: "Bearer " + token, "chatgpt-account-id": account } }
});
if (scenario.startsWith("M2")) {
  const legacy = join(root, ".claudish/codex-oauth.json");
  writeFileSync(legacy, JSON.stringify({ access_token: "legacy-access", refresh_token: "legacy-refresh", expires_at: Date.now() + (scenario === "M2-lock" || scenario === "M2-save" || scenario === "M2-invalid-grant" ? -1000 : 3600000), account_id: "account-a" }));
  const { getAccountRegistry } = await import(src + "/auth/accounts/registry.ts");
  // Prime last-known-good before corrupting the legacy file so the facade's
  // local-error boundary, not merely the cold registry boundary, is exercised.
  getAccountRegistry().snapshot("openai-codex");
  const oauth = CodexOAuth.getInstance();
  oauth.reloadCredentials();
  faultPath = legacy;
  if (scenario === "M2-lock") {
    const blocked = join(root, "blocked"); writeFileSync(blocked, "not a directory");
    faultPath = join(blocked, "refresh.lock");
    oauth._setRefreshGateOptionsForTests({ path: faultPath });
  }
  if (scenario === "M2-malformed") writeFileSync(legacy, "{");
  if (scenario === "M2-denied") chmodSync(legacy, 0);
  if (scenario === "M2-emfile") oauth._setCredentialFileReaderForTests(() => { throw Object.assign(new Error("simulated EMFILE"), { code: "EMFILE" }); });
  if (scenario === "M2-save") oauth.saveCredentials = () => { throw Object.assign(new Error("simulated EACCES saving login"), { code: "EACCES" }); };
  if (scenario === "M2-malformed" || scenario === "M2-denied" || scenario === "M2-emfile") oauth.reloadCredentials();
  if (mutation === "local-terminal") {
    CodexOAuthLocalError.prototype.terminal = true;
    CodexOAuthLocalError.prototype.upstreamStatus = 401;
  }
  if (mutation === "vendor-transient" && scenario === "M2-invalid-grant") {
    const exchange = oauth.exchangeRefreshToken.bind(oauth);
    oauth.exchangeRefreshToken = async (...args) => {
      try { return await exchange(...args); }
      catch (err) { Object.assign(err, { terminal: false, transient: true, upstreamStatus: 503 }); throw err; }
    };
  }
  explicit = scenario === "M2-invalid-grant";
  const { OpenAICodexTransport } = await import(src + "/providers/transport/openai-codex.ts");
  transport = new OpenAICodexTransport({ name: "openai-codex", baseUrl: "https://api.openai.com", apiPath: "/v1/responses", apiKeyEnvVar: "OPENAI_CODEX_API_KEY", prefixes: ["cx@"] }, inbound.model, "METERED_KEY");
  onInference = () => new Response(capture, { headers: { "content-type": "text/event-stream" } });
} else {
  const arm = scenario.includes("api-key") ? "api-key" : "oauth";
  const initial = auth(arm);
  recordSignedArm("openai-codex", arm === "oauth" ? "subscription" : "metered");
  transport = {
    name: "openai-codex", displayName: "OpenAI Codex", streamFormat: "openai-responses-sse",
    refreshAuth: async () => initial,
    getEndpoint: (_model, binding) => binding?.auth?.endpoint,
    getHeaders: async (_request, binding) => binding?.auth?.headers ?? {}
  };
  if (scenario.startsWith("M3")) {
    if (scenario.includes("forced")) transport.forceRefreshAuth = async () => { forced++; return auth(arm, "account-a", "FRESH_TOKEN"); };
    onInference = () => {
      recordSignedArm("openai-codex", arm === "oauth" ? "metered" : "subscription");
      billingProjection = isSubscriptionProvider("openai-codex");
      const status = scenario.endsWith("403") && (contacts.length > 1 || !scenario.includes("forced")) ? 403 : 401;
      return Response.json({ error: { message: "The credential was rejected" } }, { status });
    };
  } else if (scenario === "M6") {
    transport.forceRefreshAuth = async () => { forced++; return auth("oauth", "account-b", "TOKEN_B"); };
    onInference = () => Response.json({ error: { message: "The credential was rejected" } }, { status: 401 });
  } else {
    transport.signRequest = async ctx => { signContexts.push(ctx); return initial.auth; };
    delete transport.refreshAuth;
    transport.forceRefreshAuth = async () => {
      forced++;
      if (scenario === "M5-terminal") throw new CodexOAuthRefreshError("simulated vendor rejection");
      if (forced === 1) throw Object.assign(new TypeError("simulated token host refused"), { code: "ConnectionRefused" });
      return auth("oauth", "account-a", "FRESH_TOKEN");
    };
    onInference = () => contacts.length === 1
      ? new Response(capture, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ error: { message: "The credential was rejected" } }, { status: 401 });
  }
}
const composed = new ComposedHandler(transport, explicit ? "cx@" + inbound.model : inbound.model, inbound.model, 0, {
  codeMode: "off", adapter: new CodexAPIFormat(inbound.model)
});
let handler = composed;
if ((scenario.startsWith("M2") && !explicit) || scenario === "M6")
  handler = new FallbackHandler([
    { name: "Codex subscription", provider: "openai-codex", handler: composed },
    { name: "Metered next", provider: "openai", handler: { handle: () => fetch(meter.url) } }
  ]);
try {
  const app = new Hono();
  app.post("/", c => handler.handle(c, request));
  const response = await app.request("http://local.test/", { method: "POST", headers: { "x-claudish-no-recovery": "1" } });
  const text = await response.text();
  let legs;
  if (scenario.startsWith("M5")) {
    // Observe the actual issuer built by ComposedHandler; invoke two legs on
    // THAT request's closure even though a driver stops after its first error.
    const { issue } = await import(issuerPath);
    if (!issue) throw new Error("ComposedHandler did not construct its Responses issuer");
    legs = [];
    for (let i = 0; i < 2; i++) legs.push(await issue(undefined, new AbortController().signal));
  }
  console.log("RESULT " + JSON.stringify({ status: response.status, verdict: response.headers.get("x-claudish-auth-verdict"), text, canary, contacts, exchanges, forced, legs, signContexts, faultPath, billingProjection }));
} finally {
  await composed.shutdown();
  vendor.stop(true); meter.stop(true);
}
process.exit(0);
`;

async function run(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "claudish-v14-merge-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", program], {
      cwd: resolve(src, ".."),
      env: {
        ...process.env,
        HOME: root,
        TEST_SRC: src,
        SCENARIO: scenario,
        MUTATION: process.env.V14_MERGE_MUTATION ?? "",
        CLAUDISH_CONFIG: join(root, "config.json"),
        CLAUDISH_ACCOUNTS_DIR: join(root, "accounts"),
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_ACCOUNTS_FAULT: "",
        CLAUDISH_TEST_UPSTREAM: "",
        OPENAI_CODEX_API_KEY: "METERED_KEY",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const line = stdout.split("\n").find((line) => line.startsWith("RESULT "));
    expect(line, stdout + stderr).toBeDefined();
    return { result: JSON.parse(line!.slice(7)), stderr };
  } finally {
    // Restore permissions for cleanup even when a denied-file assertion failed.
    rmSync(root, { recursive: true, force: true });
  }
}

for (const fault of ["lock", "malformed", "emfile", "denied", "save"]) {
  test.skipIf(fault === "denied" && process.getuid?.() === 0)(
    `M2 legacy ${fault} is transient and never contacts a metered next hop`,
    async () => {
      const { result, stderr } = await run("M2-" + fault);
      expect(result.canary, result.text + stderr).toBe(0);
      expect(result.status).toBe(503);
      expect(result.verdict).toBe("transient");
      const body = JSON.parse(result.text);
      expect(body.error.type).toBe("overloaded_error");
      expect(body.error.upstream_status).not.toBe(401);
      expect(result.contacts).toHaveLength(0);
      expect(result.exchanges).toEqual(fault === "save" ? ["legacy-refresh"] : []);
      expect(body.error.message).toContain(fault === "lock" ? "refresh lock" : "login");
      expect(stderr).not.toContain("rejected its credential");
    }
  );
}

test("M2 control: token-host invalid_grant stays terminal with upstream 401", async () => {
  const { result } = await run("M2-invalid-grant");
  expect(result.status).toBe(400);
  expect(result.verdict).toBe("terminal");
  expect(JSON.parse(result.text).error.upstream_status).toBe(401);
  expect(result.exchanges).toEqual(["legacy-refresh"]);
  expect(result.contacts).toHaveLength(0);
});

for (const phase of ["generic", "forced"]) {
  for (const status of [401, 403]) {
    test(`M3 ${phase} OAuth ${status} verdict ignores another request's metered record`, async () => {
      const { result } = await run(`M3-${phase}-oauth-${status}`);
      expect(result.billingProjection).toBe(false);
      expect(result.status).toBe(400);
      expect(result.verdict).toBe("terminal");
      expect(JSON.parse(result.text).error.upstream_status).toBe(status);
      expect(result.forced).toBe(phase === "forced" ? 1 : 0);
      expect(result.contacts).toHaveLength(phase === "forced" ? 2 : 1);
    });
  }
}

for (const status of [401, 403]) {
  test(`M3 generic api-key ${status} has no verdict despite another request's subscription record`, async () => {
    const { result } = await run(`M3-generic-api-key-${status}`);
    expect(result.billingProjection).toBe(true);
    expect(result.status).toBe(400);
    expect(result.verdict).toBeNull();
    expect(JSON.parse(result.text).error.upstream_status).toBe(status);
    expect(result.forced).toBe(0);
    expect(result.contacts).toHaveLength(1);
  });
}

for (const failure of ["connection", "terminal"]) {
  test(`M5 a Responses leg ${failure} refresh failure ${failure === "connection" ? "preserves" : "spends"} the forced-sign budget`, async () => {
    const { result } = await run("M5-" + failure);
    expect(result.forced).toBe(failure === "connection" ? 2 : 1);
    expect(result.legs.map((leg: { kind: string }) => leg.kind)).toEqual(["error", "error"]);
    expect(result.legs[0].message).toContain(
      failure === "connection" ? "token host refused" : "vendor rejection"
    );
    expect(result.legs[1].message).toContain("HTTP 401");
    expect(result.contacts).toHaveLength(failure === "connection" ? 4 : 3);
    expect(
      result.signContexts.every(
        (ctx: { requireOAuth?: boolean }, i: number) => i === 0 || ctx.requireOAuth
      )
    ).toBe(true);
    expect(result.canary).toBe(0);
  });
}

test("M6 changed sign-in answers transient 503 and never advances a bare chain to metered", async () => {
  const { result, stderr } = await run("M6");
  expect(result.canary, result.text + stderr).toBe(0);
  expect(result.status).toBe(503);
  expect(result.verdict).toBe("transient");
  const body = JSON.parse(result.text);
  expect(body.error.type).toBe("overloaded_error");
  expect(body.error.upstream_status).toBeUndefined();
  expect(body.error.message).toContain("it was not resent");
  expect(body.error.message).not.toMatch(/credential|rejected|login/i);
  expect(result.contacts).toHaveLength(1);
  expect(result.forced).toBe(1);
  expect(stderr).not.toContain("rejected its credential");
});
