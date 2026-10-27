import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dir, "../..");
const program = String.raw`
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const src = process.env.TEST_SRC, root = process.env.HOME, scenario = process.env.SCENARIO;
const config = process.env.CLAUDISH_CONFIG;
const legacy = join(root, ".claudish/codex-oauth.json");
mkdirSync(join(root, ".claudish"), { recursive: true });
writeFileSync(config, JSON.stringify({ version: "1.0.0", defaultProfile: "default", profiles: {}, unknownOwnerField: { keep: true } }));
const legacyBytes = JSON.stringify({ access_token: "legacy-access-marker", refresh_token: "legacy-refresh-marker", expires_at: Date.now() + 3600000, account_id: "legacy-owned" });
if (scenario.includes("legacy") || scenario.includes("suppression") || scenario.startsWith("crash")) writeFileSync(legacy, legacyBytes);
const { setConfigFileOverride } = await import(src + "/config-override.ts");
setConfigFileOverride(config);
const { CodexAccountManagement } = await import(src + "/auth/accounts/management.ts");
const { FileTokenStore, LegacyCodexFileStore, fingerprintOf } = await import(src + "/auth/accounts/token-store.ts");
const { AccountRegistry } = await import(src + "/auth/accounts/registry.ts");
const { StateStore } = await import(src + "/auth/accounts/state-store.ts");
const { accountTokenPath } = await import(src + "/auth/accounts/paths.ts");
let { loadConfig, saveConfig } = await import(src + "/profile-config.ts");
if (process.env.ACCOUNTS_2A_MUTATION === "stale-global-save") {
  const original = readFileSync(src + "/profile-config.ts", "utf8");
  const target = "if (raw.subscriptionAccounts === undefined) delete next.subscriptionAccounts;\n    else next.subscriptionAccounts = raw.subscriptionAccounts;";
  let copy = original.replace(target, "// MUTATION: trust stale in-memory accounts");
  if (copy === original) throw new Error("mutation target was not reached");
  copy = copy.replace(/(from\s+["'])(\.[^"']+)/g, (_, prefix, relative) => prefix + resolve(src, relative));
  const path = join(root, "mutant-profile-config.ts");
  writeFileSync(path, copy);
  ({ saveConfig } = await import(path));
}
const { loginCodexPkce } = await import(src + "/auth/codex-pkce.ts");
const store = new FileTokenStore();
const legacyStore = new LegacyCodexFileStore();
const state = new StateStore();
let identity = "owned-new", sequence = 0, exchanges = 0, callbackMode = "valid";
const output = [], callbacks = [], exchangesSeen = [], notices = [];
const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"];
let refreshArrived, releaseRefresh;
const atRefresh = new Promise(resolve => { refreshArrived = resolve; });
const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
const jwt = id => "header." + Buffer.from(JSON.stringify({ email: "display@example.test", "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_plan_type: "test-plan" } })).toString("base64url") + ".signature";
const token = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  exchanges++;
  const text = await req.text();
  if (text.startsWith("{")) {
    const request = JSON.parse(text);
    exchangesSeen.push({ refresh: request.refresh_token });
    refreshArrived();
    if (scenario === "login-refresh-wait" || scenario === "refresh-newer-material") await refreshGate;
    return Response.json({ access_token: "refresh-access-marker", refresh_token: "refresh-rotated-marker", expires_in: 3600, id_token: jwt(identity) });
  }
  const body = new URLSearchParams(text);
  exchangesSeen.push(Object.fromEntries(body));
  return Response.json({ access_token: "access-secret-marker", refresh_token: "refresh-secret-marker", expires_in: 3600, id_token: jwt(identity) });
} });
process.env.CLAUDISH_TEST_UPSTREAM = token.url.origin;
const networkFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "127.0.0.1") throw new Error("Test forbids non-loopback network");
  return networkFetch(input, init);
};
const pkce = () => loginCodexPkce({
  now: () => 1700000000000,
  browser: async url => { callbacks.push({ browser: url }); },
  callback: async options => {
    const redirectUri = "http://localhost:1455/auth/callback";
    await options.openBrowser(options.authorize(redirectUri));
    callbacks.push({ port: options.port, timeout: options.timeoutMs });
    if (callbackMode === "cancel") throw new Error("simulated cancellation");
    if (callbackMode === "timeout") throw new Error("OAuth login timed out after 5 minutes");
    return { authCode: "code-secret-marker", state: callbackMode === "wrong-state" ? "wrong" : options.state, redirectUri };
  },
});
const deps = {
  configPath: () => config, state,
  newId: () => ids[sequence++],
  pkce,
  confirm: async message => { notices.push(message); return callbackMode !== "decline"; },
  print: message => output.push(message),
  newStore: () => store,
  store: kind => kind === "legacy-codex-file" ? legacyStore : store,
  invalidate: () => {},
};
const management = new CodexAccountManagement(deps);
if (process.env.ACCOUNTS_2A_MUTATION === "skip-duplicate-check") management.refuseDuplicate = () => {};
const raw = () => JSON.parse(readFileSync(config, "utf8"));
const entry = () => raw().subscriptionAccounts?.["openai-codex"];
const registry = () => new AccountRegistry({ configPath: () => config, legacyCodexPath: () => legacy });
const catchFailure = async fn => { try { await fn(); return null; } catch (err) { return err.message; } };
let result;
try {
  if (scenario === "disabled-keychain") {
    const { setKeychainTestDeps } = await import(src + "/providers/keychain.ts");
    const { KeychainTokenStore, defaultAccountStore } = await import(src + "/auth/accounts/token-store.ts");
    let runnerCalls = 0;
    const forbidden = () => { runnerCalls++; throw new Error("disabled Keychain reached injected runner"); };
    setKeychainTestDeps({ platform: () => "darwin", run: forbidden, runAsync: forbidden, spawnAsync: forbidden });
    const selected = defaultAccountStore();
    const protectedStore = new KeychainTokenStore();
    const ref = { provider: "openai-codex", id: ids[0], label: "isolated" };
    const record = { accessToken: "disabled-access", refreshToken: "disabled-refresh", expiresAt: Date.now() + 3600000, generation: 1, fingerprint: fingerprintOf("disabled-refresh"), updatedAt: Date.now() };
    await protectedStore.write(ref, record);
    const read = await protectedStore.read(ref, { uncached: true });
    const mode = statSync(accountTokenPath(ref.provider, ref.id)).mode & 0o777;
    await protectedStore.delete(ref);
    result = { kind: selected.kind, read, mode, runnerCalls, tokenExists: existsSync(accountTokenPath(ref.provider, ref.id)) };
    setKeychainTestDeps(null);
  } else if (scenario === "grammar") {
    const { parseAccountMutation } = await import(src + "/account-command.ts");
    const invalid = [[], ["add", "claude"], ["use", "codex", "work"], ["add", "codex", "extra"], ["add", "codex", "--id", ids[0]], ["add", "codex", "--token", "secret"], ["remove", "codex"], ["disable", "codex", "A", "--yes"], ["login", "codex", "A", "--delete-file"], ["add", "codex", "--label"], ["add", "codex", "--label", "A", "--label", "B"], ["remove", "codex", "A", "--id", "../invalid"]];
    result = { refused: await Promise.all(invalid.map(args => catchFailure(() => management.run(parseAccountMutation(args))))), parsed: parseAccountMutation(["remove", "codex", "work", "--yes", "--id", ids[0]]), config: raw(), exchanges };
  } else if (scenario.startsWith("concurrent-")) {
    const pendingCallbacks = [];
    const loginResult = id => ({ credentials: { access_token: "concurrent-access", refresh_token: "concurrent-refresh", expires_at: Date.now() + 3600000, account_id: id }, identity: { chatgptAccountId: id } });
    const command = (label, id) => {
      const manager = new CodexAccountManagement({ ...deps, pkce: () => new Promise(resolve => pendingCallbacks.push(() => resolve(loginResult(id)))) });
      if (process.env.ACCOUNTS_2A_MUTATION === "skip-duplicate-check") manager.refuseDuplicate = () => {};
      return catchFailure(() => manager.run({ verb: "add", label }));
    };
    const first = command("work", "same-identity");
    const second = command(scenario === "concurrent-label" ? "work" : "spare", scenario === "concurrent-identity" ? "same-identity" : "other-identity");
    const deadline = Date.now() + 3000;
    while (pendingCallbacks.length < 2 && Date.now() < deadline) await Bun.sleep(1);
    if (pendingCallbacks.length !== 2) throw new Error("both adds must reach the browser barrier");
    pendingCallbacks[0]();
    const firstError = await first;
    const published = entry();
    const winner = published.accounts[0];
    const winnerPath = accountTokenPath("openai-codex", winner.id);
    const winnerBytes = readFileSync(winnerPath, "utf8");
    pendingCallbacks[1]();
    const secondError = await second;
    result = { firstError, secondError, config: raw(), before: published, winnerUnchanged: readFileSync(winnerPath, "utf8") === winnerBytes, tokenIds: ids.filter(id => existsSync(accountTokenPath("openai-codex", id))) };
  } else if (scenario.startsWith("cancel-")) {
    callbackMode = scenario.slice(7);
    const before = readFileSync(config, "utf8");
    const error = await catchFailure(() => management.run({ verb: "add", label: "work" }));
    result = { error, unchanged: readFileSync(config, "utf8") === before, exchanges, tokenExists: existsSync(accountTokenPath("openai-codex", ids[0])) };
  } else if (scenario.startsWith("suppression") || scenario.startsWith("crash")) {
    const enrolled = scenario.endsWith("enrolled");
    if (enrolled) await management.run({ verb: "disable", selector: "default" });
    const stale = loadConfig();
    legacyStore.delete = async () => {
      if (scenario.startsWith("crash")) process.exit(41);
      throw new Error("simulated legacy file deletion denied");
    };
    const lines = await management.run({ verb: "remove", selector: "default", yes: true, deleteFile: true });
    saveConfig(stale);
    result = { lines, config: raw(), legacyUnchanged: readFileSync(legacy, "utf8") === legacyBytes, accounts: registry().listAccounts("openai-codex") };
  } else {
    const stale = loadConfig();
    const beforeRead = readFileSync(config, "utf8");
    const beforeAccounts = registry().listAccounts("openai-codex");
    const readOnlyUnchanged = readFileSync(config, "utf8") === beforeRead;
    await management.run({ verb: "add", label: "work" });
    const added = entry();
    const row = added.accounts.find(row => row.label === "work");
    const ref = { provider: "openai-codex", id: row.id, label: row.label };
    const firstRecord = await store.read(ref);
    const bytes = readFileSync(accountTokenPath(ref.provider, ref.id), "utf8");
    if (scenario === "stale-save") {
      saveConfig(stale);
      result = { before: added, after: entry(), unknownBeforeSave: added && readOnlyUnchanged };
    } else if (scenario.startsWith("duplicate-")) {
      const before = readFileSync(config, "utf8");
      if (scenario === "duplicate-label") identity = "different-account";
      if (scenario === "duplicate-missing") identity = undefined;
      if (scenario === "duplicate-login") identity = "different-account";
      const error = await catchFailure(() => management.run(scenario === "duplicate-login" ? { verb: "login", selector: "work" } : { verb: "add", label: scenario === "duplicate-label" ? "work" : "spare" }));
      result = { error, unchanged: readFileSync(config, "utf8") === before, tokensUnchanged: readFileSync(accountTokenPath(ref.provider, ref.id), "utf8") === bytes };
    } else if (scenario === "disable-remove") {
      await management.run({ verb: "disable", selector: "work" });
      const disabled = entry();
      await management.run({ verb: "disable", selector: "work" });
      const idempotent = entry();
      await management.run({ verb: "enable", id: row.id });
      const enabled = entry();
      const lines = await management.run({ verb: "remove", id: row.id, yes: true });
      result = { disabled, idempotent, enabled, lines, config: raw(), tokenExists: existsSync(accountTokenPath(ref.provider, ref.id)) };
    } else if (scenario.startsWith("login-refresh-") || scenario === "refresh-newer-material") {
      const { AccountPool } = await import(src + "/auth/accounts/pool.ts");
      const { withRefreshGate } = await import(src + "/auth/accounts/refresh-lock.ts");
      const pool = new AccountPool("openai-codex", { registry: registry(), state, storeFactory: () => store });
      if (process.env.ACCOUNTS_2A_MUTATION === "drop-reauth-baseline") { const clear = state.clearNeedsReauth.bind(state); state.clearNeedsReauth = ref => clear(ref); }
      let browserRelease, browserArrived;
      const atBrowser = new Promise(resolve => { browserArrived = resolve; });
      const login = new CodexAccountManagement({ ...deps, pkce: () => { browserArrived(); return new Promise(resolve => { browserRelease = resolve; }); } });
      const loginValue = { credentials: { access_token: "login-new-access", refresh_token: "login-new-refresh", expires_at: Date.now() + 3600000, account_id: "owned-new" }, identity: { chatgptAccountId: "owned-new", email: "display@example.test", plan: "test-plan" } };
      const pendingLogin = scenario === "refresh-newer-material" ? undefined : catchFailure(() => login.run({ verb: "login", id: row.id }));
      if (pendingLogin) await atBrowser;
      const refreshing = pool.acquire({ pin: ref, forceRefresh: true, rejectedAccessToken: firstRecord.accessToken });
      await Promise.race([atRefresh, Bun.sleep(3000).then(() => { throw new Error("refresh did not reach loopback exchange"); })]);
      if (scenario === "refresh-newer-material") {
        const newer = { ...firstRecord, accessToken: "ungated-newer-access", refreshToken: "ungated-newer-refresh", expiresAt: Date.now() + 3600000, generation: 9, fingerprint: fingerprintOf("ungated-newer-refresh"), updatedAt: Date.now() };
        await store.write(ref, newer);
        releaseRefresh();
        const leased = await refreshing;
        result = { after: await store.read(ref), leased, exchangesSeen };
      } else if (scenario === "login-refresh-wait") {
        browserRelease(loginValue);
        let loginFinished = false;
        pendingLogin.then(() => { loginFinished = true; });
        await Bun.sleep(30);
        const beforeRelease = { loginFinished, record: await store.read(ref) };
        releaseRefresh();
        const refreshed = await refreshing;
        const loginError = await pendingLogin;
        result = { beforeRelease, refreshed, loginError, after: await store.read(ref), entry: entry(), original: added, exchangesSeen };
      } else {
        const refreshed = await refreshing;
        const afterRefresh = await store.read(ref);
        const oldMark = { since: Date.now(), attempts: 1, lastReason: "simulated old login rejection", failedGeneration: afterRefresh.generation, failedFingerprint: afterRefresh.fingerprint };
        await withRefreshGate(ref.provider, ref.id, () => state.setNeedsReauth(ref, oldMark));
        const quotaReset = Date.now() + 3600000;
        await state.markExhausted(ref, quotaReset);
        browserRelease(loginValue);
        const loginError = await pendingLogin;
        const afterLogin = await store.read(ref);
        const markAfterLogin = state.stateFor(ref).state.needsReauth;
        let newerMark;
        if (scenario === "login-refresh-newer-mark") {
          const clear = state.clearNeedsReauth.bind(state);
          let injected = false;
          state.clearNeedsReauth = async (target, options) => {
            if (!injected) { injected = true; newerMark = { ...oldMark, lastReason: "newer concurrent failure", failedGeneration: afterLogin.generation, failedFingerprint: afterLogin.fingerprint }; await withRefreshGate(ref.provider, ref.id, () => state.setNeedsReauth(ref, newerMark)); }
            return clear(target, options);
          };
        }
        const nextError = await catchFailure(() => pool.acquire());
        result = { refreshed, afterRefresh, afterLogin, loginError, oldMark, markAfterLogin, newerMark, stateAfterUse: state.stateFor(ref).state, nextError, quotaReset, entry: entry(), original: added, exchangesSeen };
      }
    } else if (scenario === "login-remove-race") {
      let release, arrived;
      const parked = new Promise(resolve => { arrived = resolve; });
      const login = new CodexAccountManagement({ ...deps, pkce: () => { arrived(); return new Promise(resolve => { release = resolve; }); } });
      const pending = catchFailure(() => login.run({ verb: "login", id: row.id }));
      await parked;
      await management.run({ verb: "remove", id: row.id, yes: true });
      release({ credentials: { access_token: "newer-secret", refresh_token: "newer-refresh", expires_at: Date.now() + 3600000, account_id: "owned-new" }, identity: { chatgptAccountId: "owned-new" } });
      const error = await pending;
      result = { error, config: raw(), tokenExists: existsSync(accountTokenPath(ref.provider, ref.id)) };
    } else if (scenario === "login") {
      await state.markExhausted(ref, Date.now() + 3600000);
      await management.run({ verb: "login", selector: "work" });
      result = { before: firstRecord, after: await store.read(ref), entry: entry(), original: added, exhausted: state.stateFor(ref).state.exhaustedUntil, output };
    } else {
      const tokenPath = accountTokenPath(ref.provider, ref.id);
      result = { config: raw(), record: firstRecord, fingerprint: fingerprintOf("refresh-secret-marker"), legacyUnchanged: !existsSync(legacy) || readFileSync(legacy, "utf8") === legacyBytes, beforeAccounts, readOnlyUnchanged, output, notices, exchanges, callbacks, exchangesSeen, fileMode: statSync(tokenPath).mode & 0o777, dirMode: statSync(join(process.env.CLAUDISH_ACCOUNTS_DIR, "tokens/openai-codex")).mode & 0o777 };
    }
  }
  console.log("RESULT " + JSON.stringify(result));
} finally { token.stop(true); }
process.exit(0);
`;

async function run(scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "claudish-2a-management-"));
  const env = {
    ...process.env,
    HOME: root,
    CLAUDISH_CONFIG: join(root, "alternate-config.json"),
    CLAUDISH_ACCOUNTS_DIR: join(root, "accounts"),
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    CLAUDISH_ACCOUNTS_FAULT: "",
    CLAUDISH_TEST_UPSTREAM: "",
    TEST_SRC: src,
    SCENARIO: scenario,
  };
  try {
    const child = Bun.spawn([process.execPath, "-e", program], {
      cwd: resolve(src, ".."),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (scenario.startsWith("crash")) {
      expect(exit, stdout + stderr).toBe(41);
      const reader = Bun.spawn(
        [
          process.execPath,
          "-e",
          String.raw`
        import { readFileSync } from "node:fs";
        const { setConfigFileOverride } = await import(process.env.TEST_SRC + "/config-override.ts");
        setConfigFileOverride(process.env.CLAUDISH_CONFIG);
        const { getAccountRegistry } = await import(process.env.TEST_SRC + "/auth/accounts/registry.ts");
        const { makeCodexCredential } = await import(process.env.TEST_SRC + "/auth/credentials/codex-credential.ts");
        const auth = await makeCodexCredential().getRequestAuth({ model: "gpt-test" });
        console.log("RESULT " + JSON.stringify({ config: JSON.parse(readFileSync(process.env.CLAUDISH_CONFIG, "utf8")), accounts: getAccountRegistry().listAccounts("openai-codex"), arm: auth.arm, headers: auth.headers }));
        process.exit(0);
      `,
        ],
        { cwd: resolve(src, ".."), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      );
      const [out, err, code] = await Promise.all([
        new Response(reader.stdout).text(),
        new Response(reader.stderr).text(),
        reader.exited,
      ]);
      expect(code, err).toBe(0);
      return JSON.parse(
        out
          .split("\n")
          .find((line) => line.startsWith("RESULT "))!
          .slice(7)
      );
    }
    expect(exit, stdout + stderr).toBe(0);
    const line = stdout.split("\n").find((line) => line.startsWith("RESULT "));
    expect(line, stdout + stderr).toBeDefined();
    return { ...JSON.parse(line!.slice(7)), stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const scenario of ["add", "add-legacy"]) {
  test(`C1/C4/C7 ${scenario} uses injected PKCE and only the selected protected pool store`, async () => {
    const result = await run(scenario);
    const entry = result.config.subscriptionAccounts["openai-codex"];
    expect(entry.noticeAcceptedAt).toBeDefined();
    expect(entry.accounts).toHaveLength(scenario === "add-legacy" ? 2 : 1);
    expect(result.config.unknownOwnerField).toEqual({ keep: true });
    expect(result.record.generation).toBe(1);
    expect(result.record.writeId).toBeTruthy();
    expect(result.record.fingerprint).toBe(result.fingerprint);
    expect(result.record.accountId).toBe("owned-new");
    expect(result.legacyUnchanged).toBe(true);
    expect(result.readOnlyUnchanged).toBe(true);
    expect(result.fileMode).toBe(0o600);
    expect(result.dirMode).toBe(0o700);
    expect(result.exchanges).toBe(1);
    expect(result.callbacks[1]).toEqual({ port: 1455, timeout: 300_000 });
    const authorization = new URL(result.callbacks[0].browser);
    expect(authorization.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const exchange = result.exchangesSeen[0];
    expect(exchange.grant_type).toBe("authorization_code");
    expect(exchange.redirect_uri).toBe("http://localhost:1455/auth/callback");
    expect(exchange.client_id).toBe(authorization.searchParams.get("client_id"));
    const challenge = new Bun.CryptoHasher("sha256")
      .update(exchange.code_verifier)
      .digest("base64url");
    expect(authorization.searchParams.has("code_challenge")).toBe(true);
    expect(challenge).toBe(authorization.searchParams.get("code_challenge")!);
    const visible = JSON.stringify([result.config, result.output, result.stderr]);
    expect(visible).not.toMatch(/access-secret-marker|refresh-secret-marker|code-secret-marker/);
    if (scenario === "add-legacy") {
      const legacy = entry.accounts.find((row: any) => row.store === "legacy-codex-file");
      expect(legacy.id).toMatch(/^[a-z0-9]{12}$/);
      expect(legacy.id).not.toBe("legacy-codex");
      expect(result.beforeAccounts[0].id).toBe("legacy-codex");
    }
  }, 30_000);
}

for (const mode of ["wrong-state", "cancel", "timeout", "decline"]) {
  test(`C1 ${mode} publishes neither an account nor token material`, async () => {
    const result = await run(`cancel-${mode}`);
    if (mode !== "decline") expect(result.error).toBeTruthy();
    expect(result.unchanged).toBe(true);
    expect(result.exchanges).toBe(0);
    expect(result.tokenExists).toBe(false);
  }, 30_000);
}

for (const kind of ["identity", "label", "missing", "login"]) {
  test(`C2 duplicate-${kind} leaves original metadata and material intact`, async () => {
    const result = await run(`duplicate-${kind}`);
    expect(result.error).toBeTruthy();
    expect(result.unchanged).toBe(true);
    expect(result.tokensUnchanged).toBe(true);
  }, 30_000);
}

test("C3 stale saveConfig preserves an account published after the TUI loaded", async () => {
  const result = await run("stale-save");
  expect(result.after).toEqual(result.before);
  expect(result.after.accounts).toHaveLength(1);
}, 30_000);

for (const scenario of [
  "suppression-synthesized",
  "suppression-enrolled",
  "crash-synthesized",
  "crash-enrolled",
]) {
  test(`C5/R5/R12 ${scenario} keeps suppression durable before legacy cleanup`, async () => {
    const result = await run(scenario);
    const entry = result.config.subscriptionAccounts["openai-codex"];
    expect(entry.accounts).toEqual([]);
    expect(entry.legacyCodexSuppressed).toBe(true);
    expect(result.accounts).toEqual([]);
    if (scenario.startsWith("crash")) expect(result.arm).not.toBe("oauth");
    else {
      expect(result.legacyUnchanged).toBe(true);
      expect(JSON.stringify(result.lines)).toContain(
        "deleting default's token item (legacy-codex-file) failed"
      );
      expect(JSON.stringify(result.lines)).toContain("the legacy login stays suppressed");
    }
  }, 30_000);
}

test("C5 disable is idempotent and removal reports the effective credential", async () => {
  const result = await run("disable-remove");
  expect(result.disabled.accounts[0].enabled).toBe(false);
  expect(result.idempotent.generation).toBe(result.disabled.generation);
  expect(result.enabled.accounts[0].enabled).toBe(true);
  expect(result.enabled.generation).toBe(result.disabled.generation + 1);
  expect(result.tokenExists).toBe(false);
  expect(JSON.stringify(result.lines)).toContain("OPENAI_CODEX_API_KEY");
}, 30_000);

test("C6 login preserves identity metadata and actual quota while advancing material generation", async () => {
  const result = await run("login");
  expect(result.after.generation).toBe(result.before.generation + 1);
  expect(result.entry.accounts).toEqual(result.original.accounts);
  expect(result.exhausted).toBeGreaterThan(Date.now());
}, 30_000);

test("C6 parked browser holds no account gate and a concurrent removal prevents resurrection", async () => {
  const result = await run("login-remove-race");
  expect(result.error).toMatch(/No such|changed while/);
  expect(result.config.subscriptionAccounts["openai-codex"].accounts).toEqual([]);
  expect(result.tokenExists).toBe(false);
}, 30_000);

test("C7 disabled Keychain selects files and read/write/delete never call its injected runner", async () => {
  const result = await run("disabled-keychain");
  expect(result.kind).toBe("file");
  expect(result.runnerCalls).toBe(0);
  expect(result.read.accessToken).toBe("disabled-access");
  expect(result.mode).toBe(0o600);
  expect(result.tokenExists).toBe(false);
});

for (const scenario of ["concurrent-identity", "concurrent-label", "concurrent-distinct"]) {
  test(`C2/C3 ${scenario} rechecks after both browser flows passed preflight`, async () => {
    const result = await run(scenario);
    expect(result.firstError).toBeNull();
    expect(result.winnerUnchanged).toBe(true);
    expect(result.config.unknownOwnerField).toEqual({ keep: true });
    const entry = result.config.subscriptionAccounts["openai-codex"];
    if (scenario === "concurrent-distinct") {
      expect(result.secondError).toBeNull();
      expect(entry.accounts.map((row: any) => row.label)).toEqual(["work", "spare"]);
      expect(entry.generation).toBe(2);
      expect(result.tokenIds).toHaveLength(2);
    } else {
      expect(result.secondError).toBeTruthy();
      expect(entry).toEqual(result.before);
      expect(entry.accounts).toHaveLength(1);
      expect(result.tokenIds).toEqual([entry.accounts[0].id]);
    }
  });
}

for (const scenario of ["login-refresh-old-mark", "login-refresh-newer-mark"]) {
  test(`C6 ${scenario} refresh runs while browser is parked and login preserves quota/baseline`, async () => {
    const result = await run(scenario);
    expect(result.loginError).toBeNull();
    expect(result.afterRefresh.generation).toBe(2);
    expect(result.afterLogin.generation).toBe(3);
    expect(result.afterLogin.accessToken).toBe("login-new-access");
    expect(result.markAfterLogin).toEqual(result.oldMark);
    expect(result.stateAfterUse.exhaustedUntil).toBe(result.quotaReset);
    if (scenario === "login-refresh-newer-mark")
      expect(result.stateAfterUse.needsReauth).toEqual(result.newerMark);
    else expect(result.stateAfterUse.needsReauth).toBeUndefined();
    expect(result.entry.accounts[0]).toEqual(result.original.accounts[0]);
    expect(result.exchangesSeen.filter((exchange: any) => exchange.refresh)).toHaveLength(1);
  });
}

test("C6 finished browser login waits behind the refresh gate and advances its material", async () => {
  const result = await run("login-refresh-wait");
  expect(result.beforeRelease.loginFinished).toBe(false);
  expect(result.beforeRelease.record.generation).toBe(1);
  expect(result.refreshed.accessToken).toBe("refresh-access-marker");
  expect(result.loginError).toBeNull();
  expect(result.after.generation).toBe(3);
  expect(result.after.accessToken).toBe("login-new-access");
  expect(result.entry.accounts[0]).toEqual(result.original.accounts[0]);
});

test("C6 refresh pre-persist reread adopts newer material instead of overwriting it", async () => {
  const result = await run("refresh-newer-material");
  expect(result.after.generation).toBe(9);
  expect(result.after.accessToken).toBe("ungated-newer-access");
  expect(result.leased.accessToken).toBe("ungated-newer-access");
  expect(result.exchangesSeen.filter((exchange: any) => exchange.refresh)).toHaveLength(1);
});

test("C5 mutation grammar rejects malformed arguments before touching files", async () => {
  const result = await run("grammar");
  expect(result.refused.every(Boolean)).toBe(true);
  expect(result.exchanges).toBe(0);
  expect(result.config.subscriptionAccounts).toBeUndefined();
  expect(result.parsed).toEqual({
    verb: "remove",
    selector: "work",
    id: "aaaaaaaaaaaa",
    yes: true,
    deleteFile: false,
  });
}, 30_000);
