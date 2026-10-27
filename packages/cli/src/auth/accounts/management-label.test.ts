import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A subprocess gets HOME before Bun starts; no in-process homedir override.
// Only the injected file stores below may handle credentials.
const program = String.raw`
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const { CodexAccountManagement, assertLegacyCodexLogoutPermitted } = await import(process.env.MANAGEMENT_URL);
const { FileTokenStore, LegacyCodexFileStore } = await import(process.env.TOKEN_URL);
const { StateStore } = await import(process.env.STATE_URL);
const { accountTokenPath } = await import(process.env.PATHS_URL);
globalThis.fetch = () => { throw new Error("Network forbidden in account-label tests"); };
const configPath = process.env.CLAUDISH_CONFIG;
mkdirSync(join(process.env.HOME, ".claudish"), {recursive: true});
writeFileSync(configPath, JSON.stringify({version:"1.0.0", defaultProfile:"default", profiles:{}, ownerField:{keep:true}}));
const raw = () => readFileSync(configPath, "utf8");
const config = () => JSON.parse(raw());
const entry = () => config().subscriptionAccounts?.["openai-codex"];
const rows = () => entry()?.accounts ?? [];
const fileStore = new FileTokenStore();
const legacyStore = new LegacyCodexFileStore();
const state = new StateStore();
let seq = 0, identitySeq = 0, pkceCount = 0;
let identity = {chatgptAccountId:"identity-1", email:"jack+x@example.com", plan:"Pro"};
const printed = [], prompts = [], beforeBrowser = [];
const login = value => ({credentials:{access_token:"test-access-marker", refresh_token:"test-refresh-marker", expires_at:2000000000000}, identity:value});
const deps = {
  configPath: () => configPath, now: () => 1700000000000,
  newId: () => (++seq).toString(36).padStart(12, "a"),
  pkce: async () => {
    pkceCount++;
    beforeBrowser.push({printed:[...printed], prompts:[...prompts]});
    return login(identity);
  },
  print: message => printed.push(message),
  confirm: async message => { prompts.push(message); return true; },
  newStore: () => fileStore,
  store: kind => kind === "legacy-codex-file" ? legacyStore : fileStore,
  state, invalidate: () => {},
};
const manager = new CodexAccountManagement(deps);
const add = async (label, email = "jack+x@example.com", plan = "Pro") => {
  identity = {chatgptAccountId:"identity-" + (++identitySeq), email:email ?? undefined, plan:plan ?? undefined};
  return manager.run({verb:"add", label});
};
const failure = async action => {
  try { await action(); return null; } catch (error) { return error.message; }
};
const refFor = row => ({provider:"openai-codex", id:row.id, label:row.label});
const tokenBytes = row => readFileSync(accountTokenPath("openai-codex", row.id), "utf8");
const snapshot = () => ({config:raw(), tokens:rows().filter(row => row.store !== "legacy-codex-file").map(row => [row.id, tokenBytes(row)])});
const seedLegacy = stable => {
  const path = join(process.env.HOME, ".claudish/codex-oauth.json");
  const bytes = JSON.stringify({access_token:"legacy-test-access", refresh_token:"legacy-test-refresh", expires_at:2000000000000, ...(stable ? {account_id:"legacy-owned"} : {})});
  writeFileSync(path, bytes);
  return {path, bytes};
};
const scenario = process.env.SCENARIO;
let result;
if (scenario === "default") {
  const lines = await add();
  result = {lines, rows:rows(), printed, prompts, beforeBrowser, config:config(), storeKind:fileStore.kind};
} else if (scenario === "display-c1") {
  const lines = await add("work", "jack\u009b@example.com");
  result = {lines};
} else if (scenario === "clashes") {
  await add();
  await manager.run({verb:"disable", id:rows()[0].id});
  await add(undefined, "JACK+X@example.com");
  await add();
  await add(undefined, "missing@example.com", null);
  await add(undefined, "missing@example.com", null);
  await add(undefined, "missing@example.com", null);
  result = {rows:rows()};
} else if (scenario === "override") {
  const lines = await add("work");
  const before = snapshot(), count = pkceCount;
  const error = await failure(() => add("WORK"));
  result = {lines, error, before, after:snapshot(), beforeCount:count, pkceCount, rows:rows()};
} else if (scenario === "invalid") {
  const errors = [];
  const before = snapshot();
  for (const label of ["a;b", "a(b)", "a\n", "a".repeat(65), "", "-a"]) errors.push(await failure(() => add(label)));
  result = {errors, before, after:snapshot(), pkceCount};
} else if (scenario === "duplicate") {
  await add("work");
  const before = snapshot();
  const error = await failure(() => manager.run({verb:"add", label:"other"}));
  result = {error, before, after:snapshot(), pkceCount};
} else if (scenario === "missing-identity") {
  identity = {email:"x@example.com"};
  const before = snapshot();
  const error = await failure(() => manager.run({verb:"add"}));
  result = {error, before, after:snapshot()};
} else if (scenario === "fallback") {
  await add(undefined, null);
  result = {rows:rows()};
} else if (scenario === "warning") {
  const lines = await add("a".repeat(33));
  result = {lines, printed};
} else if (scenario === "concurrent") {
  let arrive;
  const both = new Promise(resolve => { arrive = resolve; });
  const releases = [];
  const concurrent = new CodexAccountManagement({...deps, pkce: () => new Promise(resolve => {
    const n = releases.length;
    releases.push(() => resolve(login({chatgptAccountId:"racing-" + n, email:"same@example.com", plan:"Pro"})));
    if (releases.length === 2) arrive();
  })});
  const first = concurrent.run({verb:"add"});
  const second = concurrent.run({verb:"add"});
  await both;
  releases[0]();
  await first;
  releases[1]();
  await second;
  result = {rows:rows()};
} else if (scenario.startsWith("select-")) {
  const verb = scenario.slice(7);
  await add("work", "o'brien@x.com");
  const row = rows()[0];
  const command = {verb, selector:"O'BRIEN@X.COM", ...(verb === "rename" ? {newLabel:"renamed"} : {}), ...(verb === "remove" ? {yes:true} : {})};
  const lines = await manager.run(command);
  result = {lines, row, rows:rows(), pkceCount};
} else if (scenario.startsWith("ambiguous-")) {
  const verb = scenario.slice(10);
  await add("work", "same@example.com");
  await add("spare", "same@example.com");
  const before = snapshot(), oldRows = rows(), count = pkceCount;
  const error = await failure(() => manager.run({verb, selector:"SAME@example.com", newLabel:"renamed", yes:true}));
  result = {error, before, after:snapshot(), oldRows, beforeCount:count, pkceCount};
} else if (scenario === "exact-label") {
  await add("same@example.com", "other@example.com");
  await add("spare", "same@example.com");
  const lines = await manager.run({verb:"disable", selector:"same@example.com"});
  result = {lines, rows:rows()};
} else if (scenario === "id") {
  await add("work", "same@example.com");
  await add("spare", "same@example.com");
  const id = rows()[1].id;
  const lines = await manager.run({verb:"disable", selector:"same@example.com", id});
  result = {lines, rows:rows(), id};
} else if (scenario === "invalid-selectors") {
  await add("work");
  const before = snapshot();
  const errors = [];
  for (const selector of ["missing@example.com", "x\n", "a".repeat(255), undefined]) {
    errors.push(await failure(() => manager.run({verb:"disable", selector})));
  }
  result = {errors, before, after:snapshot()};
} else if (scenario === "rename") {
  await add("work");
  await add("spare");
  const row = rows()[0], ref = refFor(row);
  await manager.run({verb:"disable", id:row.id});
  await state.markExhausted(ref, 1800000000000);
  const stateBefore = JSON.parse(JSON.stringify(state.stateFor(ref)));
  const before = config(), tokensBefore = tokenBytes(row);
  const lines = await manager.run({verb:"rename", selector:"work", newLabel:"jack@example.com"});
  const after = config(), tokensAfter = tokenBytes(row);
  const stateAfter = JSON.parse(JSON.stringify(state.stateFor(ref)));
  const oldError = await failure(() => manager.run({verb:"disable", selector:"work"}));
  const selected = await manager.run({verb:"disable", selector:"jack@example.com"});
  result = {before, after, lines, tokensBefore, tokensAfter, stateBefore, stateAfter, oldError, selected};
} else if (scenario === "noop") {
  await add("work");
  const before = snapshot();
  const lines = await manager.run({verb:"rename", selector:"work", newLabel:"work"});
  result = {before, after:snapshot(), lines};
} else if (scenario === "taken-rename" || scenario === "invalid-rename") {
  await add("work");
  await add("spare");
  const before = snapshot();
  const error = await failure(() => manager.run({verb:"rename", selector:"work", newLabel:scenario === "taken-rename" ? "SPARE" : "a;b"}));
  result = {before, after:snapshot(), error};
} else if (scenario === "case-rename") {
  await add("Work");
  const before = entry();
  const lines = await manager.run({verb:"rename", selector:"Work", newLabel:"work"});
  result = {before, after:entry(), lines};
} else if (scenario.startsWith("legacy-")) {
  const legacy = seedLegacy(scenario !== "legacy-missing");
  const before = raw();
  if (scenario === "legacy-logout-hint") {
    await manager.run({verb:"rename", selector:"default", newLabel:"legacy renamed"});
    const error = await failure(() => assertLegacyCodexLogoutPermitted(configPath));
    result = {error, legacyUnchanged:readFileSync(legacy.path,"utf8") === legacy.bytes};
  } else if (scenario === "legacy-refused-rename") {
    const refusing = new CodexAccountManagement({...deps, newId: () => { throw new Error("Enrollment write refused"); }});
    const error = await failure(() => refusing.run({verb:"rename", selector:"default", newLabel:"legacy renamed"}));
    result = {error, before, after:raw(), printed, legacyUnchanged:readFileSync(legacy.path,"utf8") === legacy.bytes};
  } else if (scenario === "legacy-add") {
    await add(undefined, "default");
    result = {rows:rows(), printed, legacyUnchanged:readFileSync(legacy.path,"utf8") === legacy.bytes};
  } else {
    const newLabel = scenario === "legacy-noop" ? "default" : "legacy renamed";
    const error = await failure(async () => {
      result = {lines:await manager.run({verb:"rename", selector:"default", newLabel})};
    });
    result = {...result, error, before, after:raw(), rows:rows(), printed, legacyUnchanged:readFileSync(legacy.path,"utf8") === legacy.bytes};
  }
} else if (scenario === "saved-validation") {
  await add("work");
  const initial = config();
  const cases = ["jack+x@example.com", "my work", "a".repeat(64), "a;b", "a(b)", "a\n", "a".repeat(65)];
  const outcomes = [];
  for (const label of cases) {
    const next = structuredClone(initial);
    const row = next.subscriptionAccounts["openai-codex"].accounts[0];
    row.label = label;
    writeFileSync(configPath, JSON.stringify(next));
    const isolated = new CodexAccountManagement(deps);
    const error = await failure(() => isolated.run({verb:"rename", id:row.id, newLabel:"work"}));
    outcomes.push({label, error});
  }
  const next = structuredClone(initial);
  const original = next.subscriptionAccounts["openai-codex"].accounts[0];
  original.label = "Work";
  next.subscriptionAccounts["openai-codex"].accounts.push({...original, id:"zzzzzzzzzzzz", label:"work", identity:{chatgptAccountId:"other"}});
  writeFileSync(configPath, JSON.stringify(next));
  const error = await failure(() => new CodexAccountManagement(deps).run({verb:"rename", id:original.id, newLabel:"Work"}));
  result = {outcomes, exactDuplicatesError:error};
} else throw new Error("Unknown scenario " + scenario);
console.log("RESULT " + JSON.stringify(result));
`;

async function run(scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "claudish-account-label-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", program], {
      env: {
        ...process.env,
        HOME: root,
        CLAUDISH_CONFIG: join(root, "config.json"),
        CLAUDISH_ACCOUNTS_DIR: join(root, "accounts"),
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_ACCOUNTS_FAULT: "",
        CLAUDISH_TEST_UPSTREAM: "",
        SCENARIO: scenario,
        MANAGEMENT_URL: new URL("./management.js", import.meta.url).href,
        TOKEN_URL: new URL("./token-store.js", import.meta.url).href,
        STATE_URL: new URL("./state-store.js", import.meta.url).href,
        PATHS_URL: new URL("./paths.js", import.meta.url).href,
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
    expect(exit, stdout + stderr).toBe(0);
    const result = stdout.split("\n").find((line) => line.startsWith("RESULT "));
    expect(result, stdout + stderr).toBeDefined();
    return JSON.parse(result!.slice(7));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("REQ-1 REQ-9 derives email only after PKCE, never prompts for a label, and saves identity", async () => {
  const r = await run("default");
  expect(r.beforeBrowser).toHaveLength(1);
  expect(r.beforeBrowser[0].printed.join("\n")).not.toMatch(/jack\+x@example\.com|label/i);
  expect(r.prompts.join("\n")).not.toMatch(/label/i);
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({
    id: expect.stringMatching(/^[a-z0-9]{12}$/),
    label: "jack+x@example.com",
    enabled: true,
    store: r.storeKind,
    identity: { chatgptAccountId: "identity-1", email: "jack+x@example.com", plan: "Pro" },
  });
  expect(r.rows[0].addedAt).toBeDefined();
  expect(r.lines[0]).toStartWith("Added Codex account jack+x@example.com");
  expect([...r.lines, ...r.printed].join("\n")).not.toMatch(/older/i);
  expect(r.config.ownerField).toEqual({ keep: true });
}, 30_000);

test("REQ-2 disabled labels count and clashes use plan then numbers or numbers without a plan", async () => {
  const r = await run("clashes");
  expect(r.rows.map((row: any) => row.label)).toEqual([
    "jack+x@example.com",
    "jack+x@example.com-pro",
    "jack+x@example.com-pro-2",
    "missing@example.com",
    "missing@example.com-2",
    "missing@example.com-3",
  ]);
}, 30_000);

test("REQ-1 explicit override wins and its case-insensitive clash refuses before PKCE", async () => {
  const r = await run("override");
  expect(r.rows[0].label).toBe("work");
  expect(r.lines[0]).toStartWith("Added Codex account work");
  expect(r.error).toBe("A Codex account labelled WORK already exists.");
  expect(r.pkceCount).toBe(r.beforeCount);
  expect(r.after).toEqual(r.before);
}, 30_000);

test("REQ-3 invalid explicit labels fail before browser and leave disk unchanged", async () => {
  const r = await run("invalid");
  expect(r.errors).toHaveLength(6);
  for (const error of r.errors) expect(error).toBeTruthy();
  expect(r.pkceCount).toBe(0);
  expect(r.after).toEqual(r.before);
}, 30_000);

test("REQ-9 duplicate identity refuses unchanged after browser login", async () => {
  const r = await run("duplicate");
  expect(r.error).toBe("This Codex identity is already registered as work.");
  expect(r.pkceCount).toBe(2);
  expect(r.after).toEqual(r.before);
}, 30_000);

test("REQ-9 missing stable account id refuses without publishing", async () => {
  const r = await run("missing-identity");
  expect(r.error).toBeTruthy();
  expect(r.after).toEqual(r.before);
}, 30_000);

test("REQ-6 missing email uses first eight account-id characters", async () => {
  const r = await run("fallback");
  expect(r.rows[0].label).toBe("identity");
}, 30_000);

test("REQ-9 long explicit labels produce no older-build warning", async () => {
  const r = await run("warning");
  expect([...r.lines, ...r.printed].join("\n")).not.toMatch(/older/i);
}, 30_000);

test("REQ-2 racing browser logins derive against the live published labels", async () => {
  const r = await run("concurrent");
  expect(r.rows.map((row: any) => row.label)).toEqual(["same@example.com", "same@example.com-pro"]);
  expect(new Set(r.rows.map((row: any) => row.id)).size).toBe(2);
}, 30_000);

for (const verb of ["login", "enable", "disable", "remove", "rename"]) {
  test(`REQ-4 ${verb} selects a unique case-insensitive email outside the label pattern and prints label/id`, async () => {
    const r = await run("select-" + verb);
    expect(r.lines[0]).toContain("work (id " + r.row.id + ")");
    if (verb === "disable") expect(r.rows[0].enabled).toBe(false);
    if (verb === "enable") expect(r.rows[0].enabled).toBe(true);
    if (verb === "remove") expect(r.rows).toEqual([]);
    if (verb === "rename") expect(r.rows[0].label).toBe("renamed");
    if (verb === "login") expect(r.pkceCount).toBe(2);
  }, 30_000);

  test(`REQ-4 ${verb} refuses ambiguous email, lists both label/id pairs and writes nothing`, async () => {
    const r = await run("ambiguous-" + verb);
    expect(r.error).toStartWith("More than one Codex account has the email SAME@example.com:");
    for (const row of r.oldRows) expect(r.error).toContain(row.label + " (id " + row.id + ")");
    expect(r.after).toEqual(r.before);
    expect(r.pkceCount).toBe(r.beforeCount);
  }, 30_000);
}

test("REQ-4 exact label beats a different account's matching email", async () => {
  const r = await run("exact-label");
  expect(r.rows.map((row: any) => row.enabled)).toEqual([false, true]);
  expect(r.lines[0]).toContain("same@example.com (id " + r.rows[0].id + ")");
}, 30_000);

test("REQ-4 id disambiguates two matching email accounts", async () => {
  const r = await run("id");
  expect(r.rows.map((row: any) => row.enabled)).toEqual([true, false]);
  expect(r.lines[0]).toContain("spare (id " + r.id + ")");
}, 30_000);

test("REQ-4 unknown, control, oversized and absent selectors write nothing", async () => {
  const r = await run("invalid-selectors");
  for (const error of r.errors) expect(error).toBeTruthy();
  expect(r.errors[0]).toBe("No such Codex account; run `claudish account list`.");
  expect(r.after).toEqual(r.before);
}, 30_000);

test("REQ-5 rename changes only label and generation, preserving row order, disabled state, tokens and exhaustion", async () => {
  const r = await run("rename");
  const expected = structuredClone(r.before);
  const accounts = expected.subscriptionAccounts["openai-codex"];
  accounts.accounts[0].label = "jack@example.com";
  accounts.generation++;
  expect(r.after).toEqual(expected);
  expect(r.tokensAfter).toBe(r.tokensBefore);
  expect(r.stateAfter).toEqual(r.stateBefore);
  expect(r.lines[0]).toBe(
    "Renamed Codex account work (id " + accounts.accounts[0].id + ") to jack@example.com."
  );
  expect(r.lines[0]).toContain("work (id " + accounts.accounts[0].id + ")");
  expect(r.oldError).toBe("No such Codex account; run `claudish account list`.");
  expect(r.selected[0]).toContain("jack@example.com (id " + accounts.accounts[0].id + ")");
}, 30_000);

test("REQ-5 same-label rename is a byte-for-byte no-op", async () => {
  const r = await run("noop");
  expect(r.after).toEqual(r.before);
  expect(r.lines.join("\n")).toMatch(/already labelled/i);
}, 30_000);

for (const scenario of ["taken-rename", "invalid-rename"]) {
  test(`REQ-5 ${scenario} refuses without changing config or tokens`, async () => {
    const r = await run(scenario);
    expect(r.error).toBeTruthy();
    if (scenario === "taken-rename")
      expect(r.error).toBe("A Codex account labelled SPARE already exists.");
    expect(r.after).toEqual(r.before);
  }, 30_000);
}

test("REQ-5 case-only rename writes and advances generation exactly once", async () => {
  const r = await run("case-rename");
  const expected = structuredClone(r.before);
  expected.accounts[0].label = "work";
  expected.generation++;
  expect(r.after).toEqual(expected);
}, 30_000);

test("REQ-6 legacy default may be renamed and is disclosed as enrolled without changing its token file", async () => {
  const r = await run("legacy-rename");
  expect(r.error).toBeNull();
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({
    label: "legacy renamed",
    store: "legacy-codex-file",
    identity: { chatgptAccountId: "legacy-owned" },
  });
  expect([...r.lines, ...r.printed].join("\n")).toMatch(/enrolled/i);
  expect(r.legacyUnchanged).toBe(true);
}, 30_000);

test("display strips C1 control characters from the email", async () => {
  const r = await run("display-c1");
  expect(r.lines[0]).toBe("Added Codex account work (jack@example.com, Pro); store: file.");
  expect(r.lines.join("\n")).not.toContain("\u009b");
}, 30_000);

test("legacy logout refusal quotes a label containing a space", async () => {
  const r = await run("legacy-logout-hint");
  expect(r.error).toBe(
    "The legacy Codex login is account legacy renamed. Remove it with " +
      "`claudish account remove codex 'legacy renamed' --delete-file`."
  );
  expect(r.legacyUnchanged).toBe(true);
}, 30_000);

test("refused legacy rename prints no enrollment notice", async () => {
  const r = await run("legacy-refused-rename");
  expect(r.error).toBe("Enrollment write refused");
  expect(r.printed.join("\n")).not.toMatch(/enroll/i);
  expect(r.after).toBe(r.before);
  expect(r.legacyUnchanged).toBe(true);
}, 30_000);

test("REQ-6 legacy default-to-default rename enrolls nothing and writes nothing", async () => {
  const r = await run("legacy-noop");
  expect(r.error).toBeNull();
  expect(r.after).toBe(r.before);
  expect(r.rows).toEqual([]);
  expect(r.lines.join("\n")).toMatch(/already labelled/i);
  expect(r.legacyUnchanged).toBe(true);
}, 30_000);

test("REQ-6 legacy rename without stable identity is refused with no write", async () => {
  const r = await run("legacy-missing");
  expect(r.error).toBeTruthy();
  expect(r.after).toBe(r.before);
  expect(r.legacyUnchanged).toBe(true);
}, 30_000);

test("REQ-6 add enrolls the legacy default and reserves its label during derivation", async () => {
  const r = await run("legacy-add");
  expect(r.rows.map((row: any) => row.label)).toContain("default");
  expect(r.rows.map((row: any) => row.label)).toContain("default-pro");
  expect(r.rows.find((row: any) => row.label === "default").store).toBe("legacy-codex-file");
  expect(r.legacyUnchanged).toBe(true);
}, 30_000);

test("REQ-8 saved account-list validation accepts widened labels, rejects forbidden labels, and allows exact-case-distinct labels", async () => {
  const r = await run("saved-validation");
  for (const outcome of r.outcomes.slice(0, 3)) expect(outcome.error, outcome.label).toBeNull();
  for (const outcome of r.outcomes.slice(3)) expect(outcome.error, outcome.label).toBeTruthy();
  expect(r.exactDuplicatesError).toBeNull();
}, 30_000);
