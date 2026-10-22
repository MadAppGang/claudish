import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dir, "..");

// Scripted loopback replies verify Phase 2a wiring, not vendor captures or D8.
const program = String.raw`
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const src = process.env.TEST_SRC;
const root = process.env.HOME;
mkdirSync(join(root, ".claudish"), { recursive: true });
const scenario = process.env.SCENARIO;
const responseCapture = name => readFileSync(join(src, "test-fixtures/sse-responses", name), "utf8");
const codeModeCapture = scenario === "R1-code-mode" ? JSON.parse(readFileSync(join(src, "test-fixtures/code-mode/claude-code-request-body.json"), "utf8")) : undefined;
const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"];
const rows = ids.slice(0, scenario.startsWith("E4") || scenario === "S1-after-http" ? 3 : scenario.startsWith("E11") || scenario === "S1-one" ? 1 : 2).map((id, i) => ({ id, label: ["A", "B", "C"][i], store: "file", ...((scenario === "E4-disabled" && i === 2) || scenario === "E11-disabled" ? { enabled: false } : {}), addedAt: "2026-09-12T00:00:00.000Z", identity: { chatgptAccountId: "stale-display-" + i } }));
const configPath = process.env.CLAUDISH_CONFIG;
writeFileSync(configPath, JSON.stringify({ version: "1.0.0", defaultProfile: "default", profiles: {}, subscriptionAccounts: { "openai-codex": { generation: 1, accounts: rows, ...(scenario === "E11-pool-disabled" ? { enabled: false } : {}) } } }));
if (scenario === "E5-api-key") writeFileSync(configPath, JSON.stringify({ subscriptionAccounts: { "openai-codex": { generation: 1, accounts: [], legacyCodexSuppressed: true } } }));
const contacts = [];
const meteredContacts = [];
let canary = 0, exchanges = 0, dropped = false;
const subscriptionContacts = [];
let originalStop;
let injectedRegistry, faultActive = false, ioSource;
let recovery, firstContacts, failedSources;
const exchangeAccounts = [];
const reset = Math.floor(Date.now() / 1000) + 3600;
let firstHeadersReady, releaseFirstHeaders;
const atFirstHeaders = new Promise(resolve => { firstHeadersReady = resolve; });
const firstHeadersGate = new Promise(resolve => { releaseFirstHeaders = resolve; });
async function upstream(req) {
  const body = await req.text();
  if (new URL(req.url).pathname.includes("token")) {
    exchanges++;
    const account = JSON.parse(body).refresh_token?.slice(-1);
    exchangeAccounts.push(account);
    if (scenario.startsWith("E14") || scenario.startsWith("E15") || scenario === "E19-auth-settlement" || scenario === "E18-interleaved" || scenario.startsWith("R2-")) return Response.json({ access_token: "access-" + account + "-fresh", refresh_token: "rotated-" + account, expires_in: 3600 });
    if (scenario === "E12-slow") return new Promise(() => {});
    if (scenario === "E12-reset") { oauth.stop(true); return new Promise(() => {}); }
    if (scenario === "E13-429" || scenario === "E13-503") return Response.json({ error: "temporarily_unavailable" }, { status: Number(scenario.slice(4)) });
    if (scenario === "E13-invalid-grant") return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (scenario === "E13-invalid-2xx") return new Response("not JSON", { status: 200 });
    return Response.json({ access_token: "refreshed-C", refresh_token: "new-refresh-C", expires_in: 3600 });
  }
  const bearer = req.headers.get("authorization");
  contacts.push({ bearer, account: req.headers.get("chatgpt-account-id"), hash: createHash("sha256").update(body).digest("hex"), init: req.headers.get("x-test-init"), body });
  if (scenario.startsWith("R2-")) {
    const step = contacts.length;
    // Actual captured degenerate/healthy streams trigger the production turn driver.
    const rejected = scenario === "R2-primary-first" ? step === 1 || step === 3
      : step === 2 || (scenario === "R2-two-legs" && step === 4);
    if (rejected) return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
    const broken = scenario === "R2-primary-first" ? step === 2
      : step === 1 || (scenario === "R2-two-legs" && step === 3);
    return new Response(responseCapture(broken ? "codex-parallel-degenerate-stall.sse" : "codex-zero-delta-multicall.sse"), { headers: { "content-type": "text/event-stream" } });
  }
  if (scenario === "E18-interleaved" && !bearer.endsWith("-fresh")) {
    if (body.includes("second-interleaved")) {
      const changed = JSON.parse(readFileSync(configPath, "utf8"));
      changed.subscriptionAccounts["openai-codex"].generation++;
      changed.subscriptionAccounts["openai-codex"].accounts[0].enabled = true;
      writeFileSync(configPath, JSON.stringify(changed));
      releaseFirstHeaders();
    }
    return Response.json({ error: { message: "rejected bearer for this turn" } }, { status: 401 });
  }
  if (scenario === "E19-inactive" && bearer === "Bearer access-A") {
    const { getStateStore } = await import(src + "/auth/accounts/state-store.ts");
    await getStateStore().setActive("openai-codex", ids[1]);
    return Response.json({ error: { type: "usage_limit_reached", message: "You have hit your usage limit", resets_at: reset } }, { status: 429, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(reset) } });
  }
  if (scenario === "E19-inactive" && bearer === "Bearer access-B") return new Response('data: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream", "x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(reset) } });
  if (scenario.startsWith("E9:") && bearer === "Bearer access-A") return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
  if (scenario === "E19-auth-settlement") return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
  if (scenario.startsWith("E5-")) {
    const negative = {
      "E5-rpm": [429, "rate_limit_exceeded", "Rate limit reached for requests per minute"],
      "E5-forbidden": [403, "permission_error", "Access denied for this operation"],
      "E5-model": [403, "invalid_request_error", "Model gpt-test is not supported"],
      "E5-region": [403, "RegionError", "This model is only available in another region"],
    }[scenario];
    if (negative) return Response.json({ error: { type: negative[1], message: negative[2] } }, { status: negative[0] });
    if (scenario === "E5-quota-403" && bearer === "Bearer access-A") return Response.json({ error: { type: "usage_limit_reached", message: "You have hit your usage limit", resets_at: reset } }, { status: 403 });
  }
  if (((scenario === "E14-quota-401" || scenario === "E14-budget") && bearer === "Bearer access-B") || ((scenario === "E14-401-quota" || scenario === "E14-budget" || scenario === "E15-forced") && bearer === "Bearer access-A")) return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
  if ((scenario === "E15-replacement" && bearer === "Bearer access-B" || scenario === "E15-forced" && bearer === "Bearer access-A-fresh") && !dropped) {
    dropped = true;
    const port = oauth.port;
    oauth.stop(true);
    setTimeout(() => { oauth = Bun.serve({ hostname: "127.0.0.1", port, fetch: upstream }); }, 100);
    return new Promise(() => {});
  }
  if ((scenario === "S1-one" || scenario === "S1-eligible") && bearer === "Bearer access-A" || scenario === "S1-after-http" && bearer === "Bearer access-B") return new Response("data: " + JSON.stringify({ type: "error", error: { type: "api_error", code: "usage_limit_reached", message: "You have hit your usage limit", resets_at: reset } }) + "\n\n", { headers: { "content-type": "text/event-stream" } });
  if (scenario === "E16-param" && contacts.length === 1) return Response.json({ error: { message: "Unknown parameter: max_tokens", param: "max_tokens", code: "unknown_parameter" } }, { status: 400 });
  if (scenario === "E17-replacement" || scenario === "E17-forced") process.env.CLAUDISH_ACCOUNTS_FAULT = "non-oauth-artifact";
  if (scenario === "E17-remove-quota" || scenario === "E17-remove-401") writeFileSync(configPath, JSON.stringify({ subscriptionAccounts: { "openai-codex": { generation: 2, accounts: [], legacyCodexSuppressed: true } } }));
  if ((scenario.startsWith("E8:forced:") || scenario === "E17-forced" || scenario === "E17-remove-401") && bearer === "Bearer access-A") return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
  if ((bearer === "Bearer access-A" && !scenario.startsWith("E10-io:")) || ((scenario === "E14-401-quota" || scenario === "E14-budget") && bearer === "Bearer access-A-fresh") || ((scenario.startsWith("E4") || scenario.startsWith("E8:query:")) && bearer === "Bearer access-B")) return Response.json({ error: { type: "usage_limit_reached", message: "You have hit your usage limit", resets_at: reset } }, { status: 429 });
  return new Response('data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"gpt-test","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\ndata: {"type":"content_block_stop","index":0}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } });
}
let oauth = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: upstream });
const metered = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { canary++; meteredContacts.push({ bearer: req.headers.get("authorization"), body: await req.text() }); return scenario === "E5-api-key" ? Response.json({ error: { type: "insufficient_quota", message: "You exceeded your current quota" } }, { status: 429 }) : new Response("CANARY SUCCESS"); } });
const subscription = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { const mode = new URL(req.url).pathname.slice(1); subscriptionContacts.push(mode); return new Response(mode === "success" ? "SUBSCRIPTION SUCCESS" : "model is not supported", { status: mode === "success" ? 200 : 404 }); } });
process.env.CLAUDISH_TEST_UPSTREAM = "default=" + oauth.url.origin + ",api.openai.com=" + metered.url.origin;
if (scenario === "E12-refused") {
  const refused = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(); } });
  const origin = refused.url.origin;
  refused.stop(true);
  process.env.CLAUDISH_TEST_UPSTREAM += ",auth.openai.com=" + origin;
}
const networkFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (scenario === "R1-code-mode" && url.pathname.endsWith("/codex/models")) return Promise.resolve(Response.json(JSON.parse(readFileSync(join(src, "test-fixtures/code-mode/codex-models-response.json"), "utf8"))));
  if (url.hostname !== "127.0.0.1") throw new Error("Test forbids non-loopback network: " + url.origin);
  return networkFetch(input, init);
};
try {
  const { setConfigFileOverride } = await import(src + "/config-override.ts");
  setConfigFileOverride(configPath);
  const { FileTokenStore, fingerprintOf } = await import(src + "/auth/accounts/token-store.ts");
  const store = new FileTokenStore();
  for (const [i, row] of rows.entries()) await store.write({ provider: "openai-codex", id: row.id, label: row.label }, { accessToken: "access-" + row.label, refreshToken: "refresh-" + row.label, expiresAt: row.label === "C" || scenario.startsWith("E12") || scenario.startsWith("E13") ? 0 : Date.now() + 3600000, accountId: "leased-" + row.label, generation: 1, fingerprint: fingerprintOf("refresh-" + row.label), updatedAt: Date.now() });
  if (scenario.startsWith("E10")) {
    if (scenario === "E10-config-io") { rmSync(configPath); mkdirSync(configPath); }
    if (scenario === "E10-config-invalid") writeFileSync(configPath, "{ secret-marker invalid JSON");
    if (scenario === "E10-config-schema") writeFileSync(configPath, JSON.stringify({ subscriptionAccounts: { "openai-codex": { accounts: [{ id: "../invalid" }] } } }));
    if (scenario.startsWith("E10-legacy")) {
      writeFileSync(configPath, "{}");
      const legacy = join(root, ".claudish/codex-oauth.json");
      if (scenario === "E10-legacy-io") mkdirSync(legacy);
      else writeFileSync(legacy, "{ secret-marker invalid JSON");
    }
  }
  if (scenario.startsWith("E10-io:")) {
    const [, source, code, mode] = scenario.split(":");
    ioSource = source;
    const legacy = join(root, ".claudish/codex-oauth.json");
    if (source === "legacy") {
      writeFileSync(configPath, "{}");
      writeFileSync(legacy, JSON.stringify({ access_token: "legacy-access", refresh_token: "legacy-refresh", expires_at: Date.now() + 3600000, account_id: "legacy-id" }));
    }
    const { AccountRegistry, setAccountRegistryForTests } = await import(src + "/auth/accounts/registry.ts");
    injectedRegistry = new AccountRegistry({ configPath: () => configPath, legacyCodexPath: () => legacy, readFile: path => { if (faultActive && path === (source === "config" ? configPath : legacy)) throw Object.assign(new Error("simulated " + code), { code }); return readFileSync(path, "utf8"); } });
    setAccountRegistryForTests(injectedRegistry);
    if (mode === "last-good") { injectedRegistry.snapshot("openai-codex"); injectedRegistry.invalidate(); }
    faultActive = true;
  }
  const { OpenAICodexTransport } = await import(src + "/providers/transport/openai-codex.ts");
  let composedPath = src + "/handlers/composed-handler.ts";
  if ((process.env.MUTATION === "code-mode-rotation" && scenario === "R1-code-mode") ||
      (process.env.MUTATION === "leg-budget" && scenario.startsWith("R2-"))) {
    // Mutation proof uses a disposable COPY, never production source.
    const original = readFileSync(composedPath, "utf8");
    const mutated = process.env.MUTATION === "code-mode-rotation"
      ? original.replace("codeModeShape !== undefined", "false")
      : original.replace("mayForceRefresh: () => !state.forcedSignSpent,", "mayForceRefresh: () => true,");
    if (mutated === original) throw new Error("mutation did not reach its source seam");
    composedPath = join(root, "composed-handler.ts");
    writeFileSync(composedPath, mutated.replace(/(from\s+|import\s*\(\s*)(["'])(\.[^"']+)\2/g,
      (_all, lead, quote, spec) => lead + quote + join(src, "handlers", spec).replace(/\.js$/, ".ts") + quote));
  }
  const { ComposedHandler } = await import(composedPath);
  const { getStateStore } = await import(src + "/auth/accounts/state-store.ts");
  const { getAccountPool } = await import(src + "/auth/accounts/pool.ts");
  if (scenario === "E2" || scenario === "E3" || scenario.startsWith("E7")) {
    for (const row of rows.filter(row => scenario !== "E3" || row.label === "B")) await getStateStore().markExhausted({ provider: "openai-codex", id: row.id, label: row.label }, reset * 1000);
  }
  const reads = [], queries = [];
  const read = FileTokenStore.prototype.read;
  FileTokenStore.prototype.read = function(ref, opts) { reads.push(ref.id); return read.call(this, ref, opts); };
  const pool = getAccountPool("openai-codex");
  if (scenario.startsWith("E12")) {
    const started = Date.now();
    let failure;
    try { await pool.acquire(); } catch (err) { failure = err; }
    const { classifyConnectionError } = await import(src + "/handlers/shared/connection-error.ts");
    const records = await Promise.all(rows.map(row => store.read({ provider: "openai-codex", id: row.id, label: row.label })));
    console.log("RESULT " + JSON.stringify({ name: failure?.name, endpoint: failure?.claudishEndpoint, connection: classifyConnectionError(failure), elapsed: Date.now() - started, records, state: getStateStore().read().state, contacts, canary, exchanges }));
    oauth.stop(true); metered.stop(true); subscription.stop(true); process.exit(0);
  }
  const query = pool.errorIfNoEligible.bind(pool);
  pool.errorIfNoEligible = opts => {
    const before = getStateStore().activeId("openai-codex"), count = reads.length;
    if (process.env.MUTATION === "query-reads-C" && scenario === "E4") void store.read({ provider: "openai-codex", id: ids[2], label: "C" });
    const answer = query(opts);
    queries.push({ before, after: getStateStore().activeId("openai-codex"), reads: reads.length - count });
    return answer;
  };
  const transport = new OpenAICodexTransport({ name: "openai-codex", baseUrl: "https://api.openai.com", apiPath: "/v1/responses", apiKeyEnvVar: "OPENAI_CODEX_API_KEY", prefixes: ["cx@"], streamFormatOverride: scenario.startsWith("S1") || scenario.startsWith("R") ? "openai-responses-sse" : "anthropic-sse" }, "gpt-test", "metered-test");
  let enqueues = 0, inits = 0;
  const enqueue = transport.enqueueRequest.bind(transport);
  transport.enqueueRequest = async (fn, opts) => { enqueues++; return enqueue(fn, opts); };
  transport.getRequestInit = () => { inits++; return { signal: new AbortController().signal }; };
  const header = transport.getHeaders.bind(transport);
  let latestArtifact;
  transport.getHeaders = async (...args) => {
    if (scenario === "E18-interleaved" && args[1]?.auth?.headers.Authorization === "Bearer access-A") { firstHeadersReady(); await firstHeadersGate; }
    if (process.env.MUTATION === "shared-artifact" && latestArtifact) args[1] = { auth: latestArtifact };
    return { ...await header(...args), "x-test-init": String(inits + 1) };
  };
  if (process.env.MUTATION === "no-rotation") {
    const sign = transport.signRequest.bind(transport);
    let first;
    transport.signRequest = async ctx => first ??= await sign(ctx);
  }
  if (process.env.MUTATION === "reuse-A") {
    let first;
    transport.getHeaders = async (...args) => first ??= await header(...args);
  }
  if (process.env.MUTATION === "skip-mark") {
    const pool = getAccountPool("openai-codex");
    const stage = pool.stageOutcome.bind(pool), report = pool.report.bind(pool);
    pool.stageOutcome = (ref, outcome, ctx) => { if (outcome.kind !== "quota") stage(ref, outcome, ctx); };
    pool.report = async (ref, outcome, ctx) => { if (outcome.kind !== "quota") await report(ref, outcome, ctx); };
  }
  if (process.env.MUTATION === "bare-fetch") transport.enqueueRequest = async fn => fn();
  if (process.env.MUTATION === "change-bytes") {
    transport.getRequestInit = () => { inits++; return inits === 2 ? { body: "mutated retry bytes" } : {}; };
  }
  let probeCalls = 0;
  let projection, safety, routing;
  if (scenario.startsWith("E10") || scenario.startsWith("E11")) {
    const { isSubscriptionProvider } = await import(src + "/handlers/shared/remote-provider-types.ts");
    if (process.env.MUTATION === "false-disabled-projection" && scenario.startsWith("E11")) { const { getAccountRegistry } = await import(src + "/auth/accounts/registry.ts"); getAccountRegistry().mayHaveConfiguredAccounts = () => false; }
    projection = isSubscriptionProvider("openai-codex");
    safety = transport.poolConfigured();
    const { route } = await import(src + "/providers/routing-rules.ts");
    routing = await route("gpt-test", { "gpt-*": ["openai-codex", "openai"] }, undefined, join(root, "availability.json"));
  }
  if (scenario.startsWith("E8:")) {
    const [, site, name, explicit] = scenario.split(":");
    const errors = await import(src + "/auth/accounts/errors.ts");
    const status = explicit ? Number(explicit) : undefined;
    const err = name === "RefreshUnavailableError" ? new errors.RefreshUnavailableError("test gate", undefined, [], status)
      : name === "AccountListUnavailableError" ? new errors.AccountListUnavailableError(configPath, "test I/O", status)
      : name === "PersistOutcomeUnknownError" ? new errors.PersistOutcomeUnknownError("test persist", status)
      : name === "AccountListInvalidError" ? new errors.AccountListInvalidError({ source: "config", path: configPath, type: "invalid", detail: "subscriptionAccounts invalid" })
      : new errors[name]("test failure");
    if (process.env.MUTATION === "transient-401" && err.transient) err.upstreamStatus = 401;
    const { registerSubscriptionCredentialProbe } = await import(src + "/handlers/shared/remote-provider-types.ts");
    const fail = () => { registerSubscriptionCredentialProbe(() => { probeCalls++; throw new Error("typed responder consulted billing"); }); throw err; };
    const sign = transport.signRequest.bind(transport);
    transport.signRequest = async ctx => {
      if (site === "initial" || (site === "rotation" && ctx.exclude?.length) || (site === "forced" && ctx.forceRefresh)) fail();
      return sign(ctx);
    };
    if (site === "query") pool.errorIfNoEligible = fail;
    if (site === "headers") transport.getHeaders = fail;
  }
  if (scenario.startsWith("E9:")) {
    const [, name] = scenario.split(":");
    const errors = await import(src + "/auth/accounts/errors.ts");
    const sign = transport.signRequest.bind(transport);
    transport.signRequest = async ctx => { if (ctx.forceRefresh || name === "RefreshUnavailableError") throw new errors[name]("original E9 credential stop"); return sign(ctx); };
  }
  const signContexts = [];
  const contextIds = new WeakMap();
  let contextSequence = 0;
  const acceptedSign = transport.signRequest.bind(transport);
  transport.signRequest = async ctx => {
    if (process.env.MUTATION === "leg-drop-pin" && scenario.startsWith("R2-") && ctx.requireOAuth) ctx = { ...ctx, pin: undefined };
    if (ctx.selectionContext && !contextIds.has(ctx.selectionContext)) contextIds.set(ctx.selectionContext, ++contextSequence);
    const observation = { requireOAuth: ctx.requireOAuth, forceRefresh: ctx.forceRefresh, pin: ctx.pin, rejectedBearer: ctx.rejected?.headers?.Authorization, contextId: ctx.selectionContext && contextIds.get(ctx.selectionContext) };
    signContexts.push(observation);
    latestArtifact = await acceptedSign(ctx);
    observation.accountId = latestArtifact.account?.id;
    return latestArtifact;
  };
  if (scenario === "E17-initial") process.env.CLAUDISH_ACCOUNTS_FAULT = "non-oauth-artifact";
  if (scenario === "E17-backstop") {
    const { recordSignedArm } = await import(src + "/auth/credentials/billing-probe.ts");
    transport.signRequest = async () => { recordSignedArm("openai-codex", "metered"); return { arm: "api-key", headers: {}, endpoint: metered.url.href }; };
    if (process.env.MUTATION === "backstop-force-sub") {
      const { spyOn } = await import("bun:test");
      const billing = await import(src + "/handlers/shared/remote-provider-types.ts");
      const original = billing.isSubscriptionProvider;
      spyOn(billing, "isSubscriptionProvider").mockImplementation(provider => provider === "openai-codex" || original(provider));
    }
  }
  if (scenario === "E17-initial" && process.env.MUTATION === "guard-escape") {
    const { recordSignedArm } = await import(src + "/auth/credentials/billing-probe.ts");
    transport.poolConfigured = () => false;
    transport.signRequest = async () => { recordSignedArm("openai-codex", "metered"); return { arm: "api-key", headers: {}, endpoint: metered.url.href }; };
  }
  if (scenario === "E8-report-failure") pool.report = async () => { throw new Error("simulated outcome writer failure"); };
  const { CodexAPIFormat } = await import(src + "/adapters/codex-api-format.ts");
  let handler = new ComposedHandler(transport, "cx@gpt-test", "gpt-test", 8080, {
    codeMode: scenario === "R1-code-mode" ? "on" : "off",
    ...(scenario.startsWith("R") ? { adapter: new CodexAPIFormat("gpt-test") } : {})
  });
  const captures = [], publications = [];
  const capture = handler.capturePlanUsage.bind(handler);
  handler.capturePlanUsage = (response, account) => {
    const returned = process.env.MUTATION === "capture-async" ? Promise.resolve(capture(response, account)) : capture(response, account);
    captures.push({ status: response.status, account: account?.id, synchronous: returned === undefined, caller: new Error().stack?.split("\n").find(line => line.includes("composed-handler.ts:")) });
    return returned;
  };
  const tracker = handler.getTokenTracker();
  const publish = tracker.setPlanUsage.bind(tracker);
  tracker.setPlanUsage = plan => { publications.push(plan); return publish(plan); };
  if (process.env.MUTATION === "publish-inactive") pool.isActive = () => true;
  if (scenario === "E16-param") {
    // Isolate dispatch composition from wire-specific parameter recognition.
    handler.getAdapter().recoverFromRejection = payload => ({ payload: { ...payload, max_tokens: undefined, max_completion_tokens: 16 }, note: "simulated parameter repair" });
  }
  if (process.env.MUTATION === "quota-verdict") {
    const handle = handler.handle.bind(handler);
    handler.handle = async (...args) => { const response = await handle(...args); if (response.status === 400) response.headers.set("x-claudish-auth-verdict", "terminal"); return response; };
  }
  if (scenario === "E7-bare" || scenario.startsWith("E10") || scenario === "E17-backstop") {
    if (scenario.startsWith("E10")) {
      const handle = handler.handle.bind(handler);
      handler.handle = async (...args) => { const response = await handle(...args); originalStop = { status: response.status, verdict: response.headers.get("x-claudish-auth-verdict"), text: await response.clone().text() }; return response; };
    }
    const { FallbackHandler } = await import(src + "/handlers/fallback-handler.ts");
    handler = new FallbackHandler([
      { name: "Codex subscription", provider: "openai-codex", handler },
      ...(scenario === "E17-backstop" ? [{ name: "Subscription next", provider: "kimi-coding", handler: { handle: () => fetch(metered.url) } }] : []),
      { name: "Metered canary", provider: "openai", handler: { handle: () => fetch(metered.url) } },
    ]);
  }
  if (scenario.startsWith("E9:") && !scenario.endsWith(":explicit")) {
    const [, name, order] = scenario.split(":");
    const { FallbackHandler } = await import(src + "/handlers/fallback-handler.ts");
    const handle = handler.handle.bind(handler);
    handler.handle = async (...args) => { const response = await handle(...args); originalStop = { status: response.status, verdict: response.headers.get("x-claudish-auth-verdict"), text: await response.clone().text() }; return response; };
    const codex = { name: "Codex subscription", provider: "openai-codex", handler };
    const sub = mode => ({ name: "Metered-looking display", provider: "kimi-coding", handler: { handle: () => fetch(new URL(mode, subscription.url)) } });
    const meter = { name: "Subscription-looking display", provider: "openai", handler: { handle: () => fetch(metered.url) } };
    const next = order === "sub-first" ? [sub("success"), meter] : order === "meter-first" ? [meter, sub("success")] : order === "fail-then-success" ? [sub("failure"), meter, sub("success")] : order === "all-fail" ? [sub("failure"), meter, sub("failure")] : [meter];
    handler = new FallbackHandler(name === "RefreshUnavailableError" ? [sub("failure"), codex, meter] : [codex, ...next]);
  }
  const { Hono } = await import("hono");
  const app = new Hono();
  app.post("/v1/messages", c => handler.handle(c, { model: "gpt-test", max_tokens: 16, stream: true, messages: [{ role: "user", content: c.req.header("x-test-turn") ?? "hello" }], ...(codeModeCapture ? {
    metadata: { user_id: JSON.stringify({ session_id: "019c7f9e-5555-7000-8000-555555555555" }) },
    tools: codeModeCapture.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
  } : {}) }));
  if (scenario === "E18-interleaved") {
    const first = app.request("http://localhost/v1/messages", { method: "POST", headers: { "x-test-turn": "first-interleaved" } });
    await Promise.race([atFirstHeaders, Bun.sleep(3000).then(() => { throw new Error("first request never reached header barrier"); })]);
    const changed = JSON.parse(readFileSync(configPath, "utf8"));
    changed.subscriptionAccounts["openai-codex"].generation++;
    changed.subscriptionAccounts["openai-codex"].accounts[0].enabled = false;
    writeFileSync(configPath, JSON.stringify(changed));
    const second = app.request("http://localhost/v1/messages", { method: "POST", headers: { "x-test-turn": "second-interleaved" } });
    const responses = await Promise.all([first, second]);
    const texts = await Promise.all(responses.map(response => response.text()));
    console.log("RESULT " + JSON.stringify({ statuses: responses.map(response => response.status), texts, contacts, signContexts, exchangeAccounts, canary, enqueues, inits }));
    oauth.stop(true); metered.stop(true); subscription.stop(true); process.exit(0);
  }
  const response = await app.request("http://localhost/v1/messages", { method: "POST" });
  const text = await response.text();
  if (injectedRegistry) {
    firstContacts = contacts.length;
    failedSources = injectedRegistry.sources();
    faultActive = false;
    const repaired = await app.request("http://localhost/v1/messages", { method: "POST" });
    recovery = { status: repaired.status, text: await repaired.text(), sources: injectedRegistry.sources() };
  }
  const state = getStateStore().read().state;
  let signedProjection;
  if (scenario.startsWith("E17")) {
    const { getAccountRegistry } = await import(src + "/auth/accounts/registry.ts");
    const { isSubscriptionProvider } = await import(src + "/handlers/shared/remote-provider-types.ts");
    getAccountRegistry().mayHaveConfiguredAccounts = () => false;
    signedProjection = isSubscriptionProvider("openai-codex");
  }
  const records = scenario.startsWith("E13") ? await Promise.all(rows.map(row => store.read({ provider: "openai-codex", id: row.id, label: row.label }))) : undefined;
  console.log("RESULT " + JSON.stringify({ records, status: response.status, verdict: response.headers.get("x-claudish-auth-verdict"), text, contacts, meteredContacts, captures, publications, originalStop, subscriptionContacts, firstContacts, failedSources, recovery, canary, exchanges, exchangeAccounts, reads, queries, enqueues, inits, reset, state, pending: pool.observationState({ provider: "openai-codex", id: ids[0], label: "A" }), probeCalls, projection, safety, routing, signedProjection, signContexts }));
} finally { oauth.stop(true); metered.stop(true); subscription.stop(true); }
process.exit(0);
`;

async function run(
  scenario = "E1",
  mutation = process.env.ACCOUNTS_2A_MUTATION ?? ""
): Promise<{ result: any; stderr: string }> {
  const root = mkdtempSync(join(tmpdir(), "claudish-2a-http-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", program], {
      cwd: resolve(src, ".."),
      env: {
        ...process.env,
        HOME: root,
        TZ: "UTC",
        CLAUDISH_CONFIG: join(root, "config.json"),
        CLAUDISH_ACCOUNTS_DIR: join(root, "accounts"),
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_ACCOUNTS_LOG: join(root, "accounts.jsonl"),
        CLAUDISH_ACCOUNTS_FAULT: "",
        CLAUDISH_TEST_UPSTREAM: "",
        OPENAI_CODEX_API_KEY: "metered-test",
        TEST_SRC: src,
        MUTATION: mutation,
        SCENARIO: scenario,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const line = stdout.split("\n").find((line) => line.startsWith("RESULT "));
    expect(line, stdout + stderr).toBeDefined();
    return { result: JSON.parse(line!.slice(7)), stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFlagship(result: any, stderr: string): void {
  expect(result.status).toBe(200);
  expect(result.text).toContain("OK");
  expect(result.contacts, JSON.stringify(result) + stderr).toHaveLength(2);
  expect(result.contacts.map((c: any) => c.bearer)).toEqual(["Bearer access-A", "Bearer access-B"]);
  expect(result.contacts.map((c: any) => c.account)).toEqual(["leased-A", "leased-B"]);
  expect(result.contacts[0].hash).toBe(result.contacts[1].hash);
  expect(result.canary).toBe(0);
  expect(result.enqueues).toBe(2);
  expect(result.inits).toBe(2);
  expect(result.state.providers["openai-codex"].accounts.aaaaaaaaaaaa.exhaustedUntil).toBe(
    result.reset * 1000
  );
  expect(result.state.providers["openai-codex"].active).toBe("bbbbbbbbbbbb");
  expect(stderr).not.toMatch(/HTTP 429|Check API key|Auth.*failed|✗/);
}

for (const source of ["config", "legacy"]) {
  for (const code of ["EACCES", "EMFILE", "EIO"]) {
    for (const mode of ["cold", "last-good"]) {
      test(`E10 ${source} ${code} ${mode} reserves OAuth and recovers on the next readable request`, async () => {
        const { result } = await run(`E10-io:${source}:${code}:${mode}`);
        expect(result.status).toBe(mode === "cold" ? 503 : 200);
        if (mode === "cold") {
          expect(result.verdict).toBe("transient");
          expect(JSON.parse(result.text).error.upstream_status).toBe(503);
        }
        expect(result.firstContacts).toBe(mode === "cold" ? 0 : 1);
        expect(result.canary).toBe(0);
        expect(result.projection).toBe(true);
        expect(result.safety).toBe(true);
        expect(result.routing.primary.provider).toBe("openai-codex");
        expect(result.failedSources[source]).toMatchObject({
          state: "failed",
          servingLastKnownGood: mode === "last-good",
          failure: { type: "io" },
        });
        expect(result.failedSources[source].error).toContain(code);
        expect(result.recovery.status).toBe(200);
        expect(result.recovery.sources[source].state).toBe("present");
        expect(
          result.contacts.every((contact: any) => contact.bearer !== "Bearer metered-test")
        ).toBe(true);
      });
    }
  }
}

for (const name of ["NeedsReauthError", "NoUsableAccountError", "MeteredEscapeError"]) {
  test(`E9 ${name} on explicit cx@ still stops after terminal rejection`, async () => {
    const { result, stderr } = await run(`E9:${name}:explicit`);
    expect(result.status).toBe(400);
    expect(result.verdict).toBe("terminal");
    expect(result.text).toContain("original E9 credential stop");
    expect(result.contacts).toHaveLength(1);
    expect(result.canary).toBe(0);
    expect(result.subscriptionContacts).toEqual([]);
    expect(stderr).not.toContain("billed per token");
  });
  for (const order of ["sub-first", "meter-first", "fail-then-success", "all-fail", "meter-only"]) {
    // v14 rebase, 9ace3fe5: terminal credential rejection advances in chain order,
    // including metered hops, with a notice. The explicit cx@ case below still stops.
    test(`E9 ${name} after OAuth advances past terminal rejection: ${order}`, async () => {
      const { result, stderr } = await run(`E9:${name}:${order}`);
      const metered = order !== "sub-first";
      expect(result.status).toBe(200);
      expect(result.canary).toBe(metered ? 1 : 0);
      expect(result.contacts).toHaveLength(1);
      expect(result.originalStop).toMatchObject({ status: 400, verdict: "terminal" });
      expect(result.originalStop.text).toContain("original E9 credential stop");
      expect(result.subscriptionContacts).toEqual(
        order === "sub-first"
          ? ["success"]
          : order === "fail-then-success" || order === "all-fail"
            ? ["failure"]
            : []
      );
      expect(result.text).toBe(metered ? "CANARY SUCCESS" : "SUBSCRIPTION SUCCESS");
      expect(stderr).toContain("rejected its credential");
      // The notice names the immediate next hop, before any later 404 advances.
      expect(stderr).toContain(
        order === "meter-first" || order === "meter-only"
          ? "metered, billed per token"
          : "moving to Metered-looking display (subscription)"
      );
      expect(stderr).not.toContain("metered providers were skipped");
    });
  }
}

test("E9 marked transient behind an earlier 404 survives verbatim without metered continuation", async () => {
  const { result, stderr } = await run("E9:RefreshUnavailableError:earlier-404");
  expect(result.status).toBe(503);
  expect(result.verdict).toBe("transient");
  expect({ status: result.status, verdict: result.verdict, text: result.text }).toEqual(
    result.originalStop
  );
  expect(result.subscriptionContacts).toEqual(["failure"]);
  expect(result.canary).toBe(0);
  expect(result.contacts).toEqual([]);
  expect(stderr).not.toContain("billed PER TOKEN");
});

test("E18 one transport keeps interleaved A/B artifacts, pins, contexts and forced-sign budgets separate", async () => {
  const { result, stderr } = await run("E18-interleaved");
  expect(result.statuses, result.texts.join("\n") + stderr).toEqual([200, 200]);
  expect(result.contacts).toHaveLength(4);
  for (const [turn, account] of [
    ["first", "A"],
    ["second", "B"],
  ]) {
    const contacts = result.contacts.filter((contact: any) =>
      contact.body.includes(`${turn}-interleaved`)
    );
    expect(contacts.map((contact: any) => contact.bearer)).toEqual([
      `Bearer access-${account}`,
      `Bearer access-${account}-fresh`,
    ]);
    expect(contacts.map((contact: any) => contact.account)).toEqual([
      `leased-${account}`,
      `leased-${account}`,
    ]);
    expect(contacts[0].hash).toBe(contacts[1].hash);
  }
  expect(result.exchangeAccounts.sort()).toEqual(["A", "B"]);
  const initial = result.signContexts.filter((context: any) => !context.forceRefresh);
  const forced = result.signContexts.filter((context: any) => context.forceRefresh);
  expect(new Set(initial.map((context: any) => context.contextId)).size).toBe(2);
  expect(forced).toHaveLength(2);
  for (const context of forced) {
    expect(context.requireOAuth).toBe(true);
    expect(context.pin.id).toBe(context.accountId);
    expect(context.contextId).toBe(
      initial.find((first: any) => first.accountId === context.accountId).contextId
    );
    expect(context.rejectedBearer).toBe(
      context.accountId === "aaaaaaaaaaaa" ? "Bearer access-A" : "Bearer access-B"
    );
  }
  expect(result.canary).toBe(0);
  expect(result.enqueues).toBe(4);
  expect(result.inits).toBe(4);
});

test("E19 inactive A persists usage without replacing active B publication", async () => {
  const { result, stderr } = await run("E19-inactive");
  expect(result.status, result.text + stderr).toBe(200);
  expect(result.canary).toBe(0);
  expect(result.contacts).toHaveLength(2);
  expect(result.publications.length).toBeGreaterThan(0);
  expect(result.publications.every((plan: any) => plan.windows[0].used_pct === 20)).toBe(true);
  expect(
    result.state.providers["openai-codex"].accounts.aaaaaaaaaaaa.usage.windows[0].usedFraction
  ).toBe(1);
  expect(
    result.state.providers["openai-codex"].accounts.bbbbbbbbbbbb.usage.windows[0].usedFraction
  ).toBe(0.2);
  expect(result.state.providers["openai-codex"].active).toBe("bbbbbbbbbbbb");
  expect(result.captures.every((capture: any) => capture.synchronous)).toBe(true);
});

test("E19 capture is synchronous at pre-error, auth-retry settlement and final post-settle sites", async () => {
  const normal = await run("E1");
  const retry = await run("E19-auth-settlement");
  expect(normal.result.status).toBe(200);
  expect(retry.result.status).toBe(400);
  expect(retry.result.exchangeAccounts).toEqual(["A"]);
  const captures = [...normal.result.captures, ...retry.result.captures];
  expect(captures.every((capture: any) => capture.synchronous)).toBe(true);
  const sites = readFileSync(join(src, "handlers/composed-handler.ts"), "utf8")
    .split("\n")
    .flatMap((line, index) => (line.includes("this.capturePlanUsage(") ? [index + 1] : []));
  expect(sites).toHaveLength(4); // Original three sites plus the unified attempt observer.
  for (const line of sites)
    expect(
      captures.some((capture: any) => capture.caller?.includes(`composed-handler.ts:${line}:`)),
      JSON.stringify(captures)
    ).toBe(true);
  expect(retry.result.canary).toBe(0);
});

test("E5 pooled HTTP 403 quota rotates before credential rejection", async () => {
  const { result, stderr } = await run("E5-quota-403");
  assertFlagship(result, stderr);
});

for (const scenario of ["E5-rpm", "E5-forbidden", "E5-model", "E5-region"]) {
  test(`${scenario} does not select B or mark subscription exhaustion`, async () => {
    const { result } = await run(scenario);
    expect(result.status).not.toBe(200);
    // RPM may use the existing bounded same-account retry; it must not rotate.
    expect(result.contacts.length).toBeGreaterThan(0);
    expect(result.contacts.every((contact: any) => contact.bearer === "Bearer access-A")).toBe(
      true
    );
    expect(result.signContexts).toHaveLength(1);
    expect(result.reads).not.toContain("bbbbbbbbbbbb");
    expect(result.exchanges).toBe(0);
    expect(result.canary).toBe(0);
    expect(
      result.state.providers["openai-codex"].accounts.aaaaaaaaaaaa?.exhaustedUntil
    ).toBeUndefined();
  });
}

test("E5 API-key insufficient_quota neither reads pool tokens nor rotates", async () => {
  const { result } = await run("E5-api-key");
  expect(result.status).toBe(400);
  expect(result.contacts).toHaveLength(0);
  expect(result.canary).toBe(1); // The intended metered API, not a routing continuation.
  expect(result.meteredContacts).toHaveLength(1);
  expect(result.meteredContacts[0].bearer).toBe("Bearer metered-test");
  expect(result.reads).toEqual([]);
  expect(result.signContexts).toHaveLength(1);
  expect(result.exchanges).toBe(0);
  expect(result.queries).toEqual([]);
});

test("E1 production factory rotates A quota to B with identical bytes and fresh queued attempts", async () => {
  const { result, stderr } = await run();
  assertFlagship(result, stderr);
}, 30_000);

for (const [scenario, contacts, total] of [
  ["E2", 0, 2],
  ["E3", 1, 2],
  ["E4-disabled", 2, 3],
] as const) {
  test(`${scenario} true exhaustion preserves pinned reset lines without an auth verdict`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(400);
    expect(JSON.parse(result.text).error.upstream_status).toBe(429);
    expect(result.text).toContain(
      `Codex subscription usage limit reached on every account (${total} of ${total}).`
    );
    expect(result.text).toContain("A");
    expect(result.text).toContain("B");
    const reset = new Date(result.reset * 1000);
    const clock = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
    expect(result.text).toContain(`A — resets ${clock}`);
    expect(result.text).toContain(`B — resets ${clock}`);
    if (total === 3) expect(result.text).toMatch(/C.*disabled/);
    expect(result.verdict).toBeNull();
    expect(result.contacts).toHaveLength(contacts);
    expect(result.canary).toBe(0);
    expect(stderr).not.toMatch(/Check API key|Auth.*failed/);
  }, 30_000);
}

for (const scenario of ["E11-disabled", "E11-pool-disabled"]) {
  test(`${scenario} final disabled account still reserves OAuth without reading tokens`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(400);
    expect(result.verdict).toBe("terminal");
    expect(result.text).toContain("No Codex subscription account can serve this request");
    expect(result.text).not.toContain("usage limit");
    expect(result.projection).toBe(true);
    expect(result.safety).toBe(true);
    expect(result.contacts).toHaveLength(0);
    expect(result.reads).toHaveLength(0);
    expect(result.canary).toBe(0);
  }, 30_000);
}

for (const scenario of [
  "E17-initial",
  "E17-replacement",
  "E17-forced",
  "E17-remove-quota",
  "E17-remove-401",
  "E17-backstop",
]) {
  test(`${scenario} rejects metered signing without poisoning accepted-arm evidence`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.canary, JSON.stringify(result)).toBe(0);
    expect(result.status, result.text + stderr).toBe(400);
    expect(result.verdict).toBe("terminal");
    expect(result.contacts).toHaveLength(
      scenario === "E17-initial" || scenario === "E17-backstop" ? 0 : 1
    );
    expect(result.signedProjection).toBe(scenario !== "E17-initial" && scenario !== "E17-backstop");
    if (scenario !== "E17-remove-401")
      expect(JSON.parse(result.text).error.upstream_status).toBeUndefined();
    if (scenario.includes("remove") || scenario === "E17-forced" || scenario === "E17-replacement")
      expect(result.signContexts[1].requireOAuth).toBe(true);
    if (scenario === "E17-remove-401") {
      expect(result.signContexts[1].pin.id).toBe("aaaaaaaaaaaa");
      expect(result.signContexts[1].rejectedBearer).toBe("Bearer access-A");
    }
  }, 30_000);
}

for (const scenario of ["E12-refused", "E12-reset", "E12-slow"]) {
  test(`${scenario} preserves token endpoint and unknown journal without leasing around an outage`, async () => {
    const { result } = await run(scenario);
    expect(result.connection, JSON.stringify(result)).toBeTruthy();
    expect(result.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/token$/);
    expect(result.records[0].journal.state).toBe("unknown");
    expect(result.records[1].journal).toBeUndefined();
    expect(result.contacts).toHaveLength(0);
    expect(result.canary).toBe(0);
    expect(
      Object.values(result.state.providers["openai-codex"]?.accounts ?? {}).some(
        (state: any) => state.exhaustedUntil || state.needsReauth
      )
    ).toBe(false);
    if (scenario === "E12-slow") {
      expect(result.elapsed).toBeGreaterThanOrEqual(9_000);
      expect(result.elapsed).toBeLessThan(15_000);
    }
  }, 30_000);
}

for (const scenario of ["E13-429", "E13-503", "E13-invalid-grant", "E13-invalid-2xx"]) {
  test(`${scenario} retains token-host classification through real pool aggregation`, async () => {
    const { result, stderr } = await run(scenario);
    const grant = scenario === "E13-invalid-grant";
    const status = scenario === "E13-429" ? 429 : grant ? 400 : 503;
    expect(result.status, result.text + stderr).toBe(status);
    expect(result.verdict).toBe(grant ? "terminal" : "transient");
    expect(JSON.parse(result.text).error.upstream_status).toBe(grant ? 401 : status);
    expect(result.exchanges).toBe(2);
    expect(result.contacts).toHaveLength(0);
    expect(result.canary).toBe(0);
    if (scenario === "E13-invalid-2xx") {
      expect(result.records.map((record: any) => record.journal.state)).toEqual([
        "unknown",
        "unknown",
      ]);
      expect(result.records.map((record: any) => record.accessToken)).toEqual([
        "access-A",
        "access-B",
      ]);
    }
    if (grant)
      expect(
        Object.values(result.state.providers["openai-codex"].accounts).every(
          (state: any) => state.needsReauth
        )
      ).toBe(true);
  }, 30_000);
}

for (const [scenario, bearers, exchange] of [
  ["E14-quota-401", ["access-A", "access-B", "access-B-fresh"], "B"],
  ["E14-401-quota", ["access-A", "access-A-fresh", "access-B"], "A"],
  ["E14-budget", ["access-A", "access-A-fresh", "access-B"], "A"],
  ["E15-replacement", ["access-A", "access-B", "access-B"], undefined],
  ["E15-forced", ["access-A", "access-A-fresh", "access-A-fresh"], "A"],
] as const) {
  test(`${scenario} shares forced-sign budgets and keeps the selected artifact through recovery`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(scenario === "E14-budget" ? 400 : 200);
    expect(result.contacts.map((contact: any) => contact.bearer)).toEqual(
      bearers.map((bearer) => `Bearer ${bearer}`)
    );
    expect(result.exchangeAccounts).toEqual(exchange ? [exchange] : []);
    expect(result.canary).toBe(0);
    expect(result.enqueues).toBe(bearers.length);
    expect(result.inits).toBe(bearers.length);
    if (exchange) {
      const forced = result.signContexts.filter((ctx: any) => ctx.forceRefresh);
      expect(forced).toHaveLength(1);
      expect(forced[0].pin.id).toBe(exchange === "A" ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb");
      expect(forced[0].requireOAuth).toBe(true);
      expect(forced[0].rejectedBearer).toBe(`Bearer access-${exchange}`);
    }
    if (scenario === "E15-replacement") expect(result.signContexts).toHaveLength(2);
    if (scenario === "E15-forced") expect(result.signContexts).toHaveLength(2);
  }, 30_000);
}

test("E16 parameter rewrite quota rotates using only the corrected payload version", async () => {
  const { result, stderr } = await run("E16-param");
  expect(result.status, result.text + stderr).toBe(200);
  expect(result.contacts).toHaveLength(3);
  expect(result.contacts[0].hash).not.toBe(result.contacts[1].hash);
  expect(result.contacts[1].hash).toBe(result.contacts[2].hash);
  expect(result.contacts.map((contact: any) => contact.bearer)).toEqual([
    "Bearer access-A",
    "Bearer access-A",
    "Bearer access-B",
  ]);
  expect(result.enqueues).toBe(3);
  expect(result.inits).toBe(3);
  expect(result.canary).toBe(0);
}, 30_000);

test("E8 reporter failure preserves successful rotation and pending exhaustion", async () => {
  const { result } = await run("E8-report-failure");
  expect(result.status).toBe(200);
  expect(result.contacts).toHaveLength(2);
  expect(result.canary).toBe(0);
  expect(result.pending.exhaustedUntil).toBe(result.reset * 1000);
}, 30_000);

for (const scenario of ["S1-one", "S1-eligible", "S1-after-http"]) {
  test(`${scenario} false-mode stream quota marks without rotating or leasing capacity`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(scenario === "S1-one" ? 400 : 429);
    expect(JSON.parse(result.text).error.upstream_status).toBe(429);
    expect(result.contacts).toHaveLength(scenario === "S1-after-http" ? 2 : 1);
    const active = scenario === "S1-after-http" ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa";
    expect(result.state.providers["openai-codex"].accounts[active].exhaustedUntil).toBe(
      result.reset * 1000
    );
    expect(result.state.providers["openai-codex"].active).toBe(active);
    expect(result.exchanges).toBe(0);
    expect(result.canary).toBe(0);
    if (scenario === "S1-one") {
      expect(result.verdict).toBeNull();
      expect(result.text).toContain(
        "Codex subscription usage limit reached on every account (1 of 1)."
      );
    } else {
      expect(result.verdict).toBe("transient");
      expect(JSON.parse(result.text).error.message).toBe(
        "Codex account retry deferred; retry this request."
      );
      expect(result.queries).toEqual([{ before: active, after: active, reads: 0 }]);
    }
  }, 30_000);
}

for (const site of ["initial", "rotation", "forced", "headers", "query"]) {
  for (const name of [
    "RefreshUnavailableError",
    "AccountListUnavailableError",
    "PersistOutcomeUnknownError",
  ]) {
    for (const upstream of [503, 429, 502]) {
      test(`E8 ${site} ${name} upstream ${upstream} is classified without billing`, async () => {
        const { result, stderr } = await run(
          `E8:${site}:${name}${upstream === 503 ? "" : `:${upstream}`}`
        );
        expect(result.status, result.text + stderr).toBe(upstream === 429 ? 429 : 503);
        expect(JSON.parse(result.text).error.upstream_status).toBe(upstream);
        expect(result.verdict).toBe("transient");
        expect(result.probeCalls).toBe(0);
        expect(result.canary).toBe(0);
        expect(stderr).not.toMatch(/Check API key|Auth.*failed/);
      }, 30_000);
    }
  }
  for (const [name, upstream] of [
    ["NeedsReauthError", 401],
    ["NoUsableAccountError", 401],
    ["AccountListInvalidError", 400],
    ["MeteredEscapeError", undefined],
  ] as const) {
    test(`E8 ${site} ${name} is terminal without billing`, async () => {
      const { result, stderr } = await run(`E8:${site}:${name}`);
      expect(result.status, result.text + stderr).toBe(400);
      expect(JSON.parse(result.text).error.upstream_status).toBe(upstream);
      expect(result.verdict).toBe("terminal");
      expect(result.probeCalls).toBe(0);
      expect(result.canary).toBe(0);
      expect(stderr).not.toMatch(/Check API key|Auth.*failed/);
    }, 30_000);
  }
}

for (const scenario of [
  "E10-config-io",
  "E10-config-invalid",
  "E10-config-schema",
  "E10-legacy-io",
  "E10-legacy-invalid",
]) {
  test(`${scenario} cold failure retains real bare-name Codex routing and reserves OAuth`, async () => {
    const { result, stderr } = await run(scenario);
    const invalid = scenario === "E10-config-invalid" || scenario === "E10-config-schema";
    // 9ace3fe5 changes the bare chain only; the retained Codex failure is still
    // terminal for invalid config and transient for I/O/legacy failure.
    const stop = result.originalStop;
    expect(stop.status, stop.text + stderr).toBe(invalid ? 400 : 503);
    expect(stop.verdict).toBe(invalid ? "terminal" : "transient");
    expect(JSON.parse(stop.text).error.upstream_status).toBe(invalid ? 400 : 503);
    expect(stop.text).toContain(scenario.includes("legacy") ? "codex-oauth.json" : "config.json");
    expect(stop.text).not.toContain("secret-marker");
    expect(result.status).toBe(invalid ? 200 : 503);
    expect(result.verdict).toBe(invalid ? null : "transient");
    if (invalid) {
      expect(result.text).toBe("CANARY SUCCESS");
      expect(stderr).toContain("rejected its credential");
      expect(stderr).toContain("metered, billed per token");
    }
    expect(result.projection).toBe(true);
    expect(result.safety).toBe(true);
    expect(result.routing.kind).toBe("ok");
    expect(result.routing.primary.provider).toBe("openai-codex");
    expect(result.contacts).toHaveLength(0);
    expect(result.canary).toBe(invalid ? 1 : 0);
  }, 30_000);
}

test("E7 bare-name exhaustion reaches the metered socket with its cost warning; explicit cx stops", async () => {
  const bare = await run("E7-bare");
  expect(bare.result.status, bare.result.text + bare.stderr).toBe(200);
  expect(bare.result.text).toBe("CANARY SUCCESS");
  expect(bare.result.canary).toBe(1);
  expect(bare.result.contacts).toHaveLength(0);
  expect(bare.stderr).toContain("billed PER TOKEN");
  const explicit = await run("E7-explicit");
  expect(explicit.result.status).toBe(400);
  expect(explicit.result.text).toContain(
    "Codex subscription usage limit reached on every account (2 of 2)."
  );
  expect(explicit.result.verdict).toBeNull();
  expect(explicit.result.canary).toBe(0);
  expect(explicit.stderr).not.toContain("billed PER TOKEN");
}, 30_000);

// Rebase resolution "Decisions for the owner", decision 1: the code-mode
// body belongs to A. The next inbound request may select B, never this request.
test("R1 code-mode pooled quota returns transient 429 without contacting a second account", async () => {
  const { result, stderr } = await run("R1-code-mode");
  expect(result.status, result.text + stderr).toBe(429);
  expect(result.verdict).toBe("transient");
  expect(JSON.parse(result.text).error).toMatchObject({
    type: "rate_limit_error",
    upstream_status: 429,
    message: "Codex account retry deferred; retry this request.",
  });
  expect(result.contacts).toHaveLength(1);
  expect(result.contacts[0].account).toBe("leased-A");
  const body = JSON.parse(result.contacts[0].body);
  expect(body.tools).toHaveLength(1);
  expect(body.tools[0].name).toBe("exec");
  expect(body.parallel_tool_calls).toBe(false);
  expect(result.signContexts).toHaveLength(1);
  expect(result.reads).not.toContain("bbbbbbbbbbbb");
  expect(result.exchanges).toBe(0);
  expect(result.queries).toEqual([{ before: "aaaaaaaaaaaa", after: "aaaaaaaaaaaa", reads: 0 }]);
  expect(result.state.providers["openai-codex"].accounts.aaaaaaaaaaaa.exhaustedUntil).toBe(
    result.reset * 1000
  );
  expect(result.canary).toBe(0);
  expect(stderr).not.toContain("billed PER TOKEN");
}, 30_000);

// Decision 2: legs use the same request-owned forced-sign budget as the primary,
// and every normal or forced leg sign remains pinned to the turn's account.
for (const scenario of ["R2-leg-first", "R2-primary-first", "R2-two-legs"]) {
  test(`${scenario} Responses leg 401 shares the single pinned forced re-sign`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(200);
    // implementation-log.md § v14 merge fixes / M4: no resend after the forced sign.
    if (scenario === "R2-leg-first") {
      expect(result.text).not.toContain("event: error");
      expect(result.text).toContain('"name":"Read"');
    } else {
      expect(result.text).toContain("event: error");
      expect(result.text).toContain("HTTP 401");
    }
    expect(result.canary).toBe(0);
    expect(result.exchanges).toBe(1);
    expect(result.exchangeAccounts).toEqual(["A"]);
    expect(result.contacts).toHaveLength(scenario === "R2-two-legs" ? 4 : 3);
    expect(new Set(result.contacts.map((contact: any) => contact.hash)).size).toBe(1);
    expect(new Set(result.contacts.map((contact: any) => contact.account))).toEqual(
      new Set(["leased-A"])
    );
    const forced = result.signContexts.filter((ctx: any) => ctx.forceRefresh);
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({
      requireOAuth: true,
      pin: { provider: "openai-codex", id: "aaaaaaaaaaaa" },
      rejectedBearer: "Bearer access-A",
      contextId: result.signContexts[0].contextId,
    });
    for (const ctx of result.signContexts.slice(1)) {
      expect(ctx.requireOAuth).toBe(true);
      expect(ctx.pin.id).toBe("aaaaaaaaaaaa");
      expect(ctx.contextId).toBe(result.signContexts[0].contextId);
    }
    expect(result.contacts.map((contact: any) => contact.bearer)).toEqual([
      "Bearer access-A",
      ...(scenario === "R2-primary-first" ? [] : ["Bearer access-A"]),
      ...Array(scenario === "R2-leg-first" ? 1 : 2).fill("Bearer access-A-fresh"),
    ]);
    expect(result.reads).not.toContain("bbbbbbbbbbbb");
    expect(result.enqueues).toBe(result.contacts.length);
    expect(result.inits).toBe(result.contacts.length);
  }, 30_000);
}

test("E4 spent rotation with expired eligible C answers transient 429 without leasing C", async () => {
  const { result, stderr } = await run("E4");
  expect(result.status, result.text + stderr).toBe(429);
  const error = JSON.parse(result.text).error;
  expect(error.type).toBe("rate_limit_error");
  expect(error.upstream_status).toBe(429);
  expect(error.message).toBe("Codex account retry deferred; retry this request.");
  expect(result.verdict).toBe("transient");
  expect(result.contacts).toHaveLength(2);
  expect(result.reads).not.toContain("cccccccccccc");
  expect(result.exchanges).toBe(0);
  expect(result.queries).toEqual([{ before: "bbbbbbbbbbbb", after: "bbbbbbbbbbbb", reads: 0 }]);
  expect(result.canary).toBe(0);
  expect(stderr).not.toContain("billed PER TOKEN");
}, 30_000);
