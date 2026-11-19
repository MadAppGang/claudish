/**
 * The child program and its runner for the Codex pool request-path tests
 * (`../composed-handler-accounts-2a-*.test.ts`). `run(scenario)` starts `program` in a child
 * process with a temporary HOME, scripted loopback servers for the token host, the
 * subscription API and the metered API, and returns the one RESULT line the child prints.
 */
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dir, "../..");

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

export async function run(
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

export function assertFlagship(result: any, stderr: string): void {
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

export { program, src };
