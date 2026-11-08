import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const children: ReturnType<typeof Bun.spawn>[] = [];
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

const roots: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runLogoutScenario(scenario: "stores" | "discovery" | "billing") {
  const root = mkdtempSync(join(tmpdir(), "muse-logout-child-"));
  roots.push(root);
  const tempHome = join(root, "home");
  mkdirSync(tempHome);
  const scriptPath = join(root, "scenario.ts");
  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { homedir } from "node:os";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const realExit = process.exit.bind(process);
const realFetch = globalThis.fetch;
try {
const tempHome = process.env.HOME;
assert.equal(homedir(), tempHome);
const isInside = path => {
  const rel = relative(tempHome, resolve(path instanceof URL ? fileURLToPath(path) : path));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
};
// Installed before application imports. Any filesystem mutation outside HOME fails
// before it reaches the filesystem, including an atomic rename's destination.
const writes = [];
function checkWrite(path) {
  assert.ok(typeof path === "string" || path instanceof URL, "untracked write target");
  assert.ok(isInside(path), "write outside child HOME: " + path);
  writes.push(String(path));
}
for (const [name, indices] of Object.entries({
  writeFile: [0], appendFile: [0], mkdir: [0], rm: [0], rmdir: [0], unlink: [0],
  rename: [0, 1], copyFile: [1], chmod: [0], chown: [0], truncate: [0],
  utimes: [0], link: [1], symlink: [1], mkdtemp: [0]
})) {
  for (const api of [name, name + "Sync"]) {
    if (typeof fs[api] !== "function") continue;
    const original = fs[api];
    fs[api] = function (...args) { for (const i of indices) checkWrite(args[i]); return original.apply(this, args); };
  }
  if (typeof fs.promises[name] === "function") {
    const original = fs.promises[name];
    fs.promises[name] = function (...args) { for (const i of indices) checkWrite(args[i]); return original.apply(this, args); };
  }
}
for (const target of [fs, fs.promises]) {
  for (const name of ["open", "openSync", "createWriteStream"]) {
    if (typeof target[name] !== "function") continue;
    const original = target[name];
    target[name] = function (path, flags, ...args) {
      if (name === "createWriteStream" || (typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : /[wa+]/.test(flags ?? "r"))) checkWrite(path);
      return original.call(this, path, flags, ...args);
    };
  }
}
const originalBunWrite = Bun.write;
Bun.write = (path, ...args) => { checkWrite(path); return originalBunWrite(path, ...args); };
syncBuiltinESMExports();
// CLI logging cannot pollute the single JSON result line.
console.log = (...args) => console.error(...args);
const { existsSync, readFileSync, writeFileSync } = fs;
const join = (...parts) => resolve(...parts);
const commands = [];
const urls = [];
const exitCodes = [];
process.exit = code => { exitCodes.push(code); };
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== "http:" && url.protocol !== "https:") return realFetch(input, init);
  urls.push(url.href);
  throw new Error("unexpected network request");
}, { preconnect() {} });

let home;
let generic;
let kc;
let roles;
let store;
let core;
let auth;
let discovery;
let probe;
let providerProbe;
let authority;
let billing;
let billingTypes;
let previous;
let previousFetcher;
let discoveryCalls;
let discoveredId;
  generic = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/keychain.js"))});
  generic.setKeychainTestDeps({ platform: () => "darwin",
    run: (args) => { commands.push(args); return { code: 44, stdout: "", stderr: "absent" }; },
    runAsync: async (args) => { commands.push(args); return { code: 44, stdout: "", stderr: "absent" }; },
    spawnAsync: (args) => { commands.push(args); return { pid: undefined,
      done: Promise.resolve({ code: 44, stdout: "", stderr: "absent" }) }; } });
  kc = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/meta-muse/muse-keychain.js"))});
  kc.setMuseKeychainTestDeps({ dir: () => home, env: () => ({ CLAUDISH_DISABLE_KEYCHAIN: "1" }),
    now: () => 1000000, sleep: async () => {}, pid: () => 98765, isAlive: () => false,
    presence: async () => ({ kind: "absent" }), startRead: () => { throw new Error("unexpected Keychain read"); } });
  roles = await import(${JSON.stringify(resolve(import.meta.dir, "./credentials/prompt-role.js"))});
  store = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/meta-muse/muse-store.js"))});
  home = store.defaultMuseStoreDir();
  assert.ok(isInside(home));
  core = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/meta-muse/muse-credentials.js"))});
  roles._resetCredentialPromptRoleForTest(); core.resetMuseCredentialState();
  core.setMuseCoreTestDeps({
    readStore: (kind) => store.readMuseStore(kind, home),
    writeBorrowedCopy: (token, tier) => store.writeBorrowedCopy(token, tier, home, () => new Date(1000000)),
    dir: () => home, now: () => 1000000,
    // Exported MuseMint projection of the §8 confirmed capture.
    mint: async () => ({ apiKey: "LLM|TESTKEY0001", subsTierName: "Muse Code Power Usage" }),
    keychainLogin: async () => ({ kind: "absent" as const }) });
  auth = await import(${JSON.stringify(resolve(import.meta.dir, "./auth-commands.js"))});
  discovery = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/model-discovery.js"))});
  probe = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/transport/probe-discovery.js"))});
  providerProbe = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/transport/provider-model-discovery.js"))});
  authority = await import(${JSON.stringify(resolve(import.meta.dir, "./credentials/authority.js"))});
  billing = await import(${JSON.stringify(resolve(import.meta.dir, "./credentials/billing-probe.js"))});
  billingTypes = await import(${JSON.stringify(resolve(import.meta.dir, "../handlers/shared/remote-provider-types.js"))});
  const old = authority.credentials.get("meta-muse-code");
  if (!old) throw new Error("default Muse credential registration missing");
  previous = old;
  const { MuseCodeCredentialProvider } = await import(${JSON.stringify(resolve(import.meta.dir, "./credentials/muse-code-credential.js"))});
  authority.credentials.register(new MuseCodeCredentialProvider(), ["meta-muse-code"]);
  await import(${JSON.stringify(resolve(import.meta.dir, "../providers/model-discovery-builtins.js"))});
  const oldFetcher = discovery.getModelDiscoveryFetcher("muse-code-models");
  if (!oldFetcher) throw new Error("Muse discovery fetcher registration missing");
  previousFetcher = oldFetcher; discoveryCalls = 0; discoveredId = "muse-spark-1.3";
  // Contract-typed discovery projection of §4, not an invented Meta wire body.
  discovery.registerModelDiscoveryFetcher("muse-code-models", async provider => {
    discoveryCalls++;
    if (!await authority.credentials.isAvailable(provider)) return { kind: "failed",
      failure: { kind: "no-credentials", detail: "run claudish login muse" } };
    return { kind: "models", models: [{ id: discoveredId, reported: "chat", contextWindow: 1007997 }] };
  });
  discovery.invalidateModelDiscovery("meta-muse-code"); probe.invalidateProbeDiscovery("meta-muse-code");
  billing.clearSignedArm();

function noExternalEffects() {
  assert.deepEqual(urls, []);
  assert.ok(commands.every(args => args[0] === "find-generic-password" && !args.includes("-w")));
  assert.ok(writes.every(isInside));
}
const scenario = process.env.MUSE_SCENARIO;
let result;
if (scenario === "stores") {
  assert.notEqual(auth.findProvider("muse"), null);
  store.writeMuseStore("own-login", { access_token: "dca:TESTTOKEN0001" }, home);
  store.writeBorrowedCopy("dca:TESTTOKEN0001", "Muse Code Power Usage", home);
  const sentinel = join(home, "unrelated-sentinel.json"); writeFileSync(sentinel, "keep");
  await core.ensureMuseCredentialReady({ prompt: false });
  assert.equal(core.currentMuseState()?.key, "LLM|TESTKEY0001");
  await auth.logoutCommand("muse");
  assert.deepEqual(exitCodes, [0]);
  const ownExists = existsSync(store.museStorePath("own-login", home));
  const borrowedExists = existsSync(store.museStorePath("borrowed-copy", home));
  assert.equal(ownExists, false); assert.equal(borrowedExists, false);
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
  assert.equal(core.currentMuseState(), undefined);
  await assert.rejects(core.ensureMuseCredentialReady({ prompt: false }), /login/);
  result = { ownExists, borrowedExists, sentinel: readFileSync(sentinel, "utf8"), keyCleared: !core.currentMuseState() };
} else if (scenario === "discovery") {
  store.writeMuseStore("own-login", { access_token: "dca:TESTTOKEN0001" }, home);
  assert.equal((await discovery.discoverProviderModelsCatalog("meta-muse-code")).kind, "served");
  assert.equal((await providerProbe.discoverProviderProbeModel("meta-muse-code", "Muse Code")).model, "muse-spark-1.3");
  const warmed = discoveryCalls;
  assert.ok(warmed > 0);
  assert.equal((await discovery.discoverProviderModelsCatalog("meta-muse-code")).kind, "served");
  assert.equal(discoveryCalls, warmed);
  await auth.logoutCommand("muse");
  assert.deepEqual(exitCodes, [0]);
  assert.equal(existsSync(store.museStorePath("own-login", home)), false);
  assert.equal(existsSync(store.museStorePath("borrowed-copy", home)), false);
  assert.equal(core.currentMuseState(), undefined);
  await assert.rejects(core.ensureMuseCredentialReady({ prompt: false }), /login/);
  noExternalEffects();
  // The TUI explicitly invalidates discovery after a credential change.
  discovery.invalidateModelDiscovery("meta-muse-code");
  probe.invalidateProbeDiscovery("meta-muse-code");
  discoveredId = "muse-spark-1.2";
  store.writeMuseStore("own-login", { access_token: "dca:TESTTOKEN0001" }, home);
  const model = (await providerProbe.discoverProviderProbeModel("meta-muse-code", "Muse Code")).model;
  assert.equal(model, "muse-spark-1.2");
  const outcome = await discovery.discoverProviderModelsCatalog("meta-muse-code");
  assert.equal(outcome.kind, "served");
  assert.deepEqual(outcome.models.map(model => model.id), ["muse-spark-1.2"]);
  assert.ok(discoveryCalls > warmed);
  result = { model, ids: outcome.models.map(model => model.id), refreshed: discoveryCalls > warmed };
} else {
  assert.equal(scenario, "billing");
  const installed = billingTypes.registerSubscriptionCredentialProbe(null);
  billingTypes.registerSubscriptionCredentialProbe(installed);
  assert.notEqual(installed, null);
  billing.clearSignedArm("meta-muse-code");
  const baseline = installed("meta-muse-code");
  billing.recordSignedArm("meta-muse-code", baseline ? "metered" : "subscription");
  assert.equal(installed("meta-muse-code"), !baseline);
  await auth.logoutCommand("muse");
  assert.deepEqual(exitCodes, [0]);
  assert.equal(installed("meta-muse-code"), baseline);
  result = { reset: installed("meta-muse-code") === baseline };
}
noExternalEffects();
// Restore replacements even though the child is about to finish.
discovery.registerModelDiscoveryFetcher("muse-code-models", previousFetcher);
authority.credentials.register(previous, ["meta-muse-code"]);
authority.credentials.invalidate("meta-muse-code"); billing.clearSignedArm();
discovery.invalidateModelDiscovery("meta-muse-code"); probe.invalidateProbeDiscovery("meta-muse-code");
core.resetMuseCredentialState(); core.setMuseCoreTestDeps(null);
kc.resetMuseKeychainState(); kc.setMuseKeychainTestDeps(null);
generic.invalidateKeychainCache(); generic.setKeychainTestDeps(null);
roles._resetCredentialPromptRoleForTest();
process.stdout.write(JSON.stringify({ scenario, result, exitCodes, requests: urls.length,
  outsideWrites: writes.filter(path => !isInside(path)), writes: writes.length }) + "\\n");
realExit(0);
} catch (error) { console.error(error); realExit(1); }
`;
  writeFileSync(scriptPath, script);
  const child = Bun.spawn([process.execPath, scriptPath], {
    cwd: tempHome,
    env: {
      ...process.env,
      HOME: tempHome,
      TMPDIR: tempHome,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
      CLAUDISH_MUSE_KEYCHAIN_FILE: "",
      MUSE_SCENARIO: scenario,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    waitForChild(child),
  ]);
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const outcome = JSON.parse(lines[0]!);
  expect(outcome.scenario).toBe(scenario);
  expect(outcome.exitCodes).toEqual([0]);
  expect(outcome.requests).toBe(0);
  expect(outcome.outsideWrites).toEqual([]);
  // The only parent-owned file outside HOME remains byte-for-byte unchanged.
  expect(readFileSync(scriptPath, "utf8")).toBe(script);
  expect(readdirSync(root).sort()).toEqual(["home", "scenario.ts"]);
  return outcome;
}

describe("L1: public Muse logout with HOME set at process start", () => {
  test("findProvider recognizes muse and logout removes both local stores and process key", async () => {
    const { result, writes } = await runLogoutScenario("stores");
    expect(result).toEqual({
      ownExists: false,
      borrowedExists: false,
      sentinel: "keep",
      keyCleared: true,
    });
    expect(writes).toBeGreaterThan(0);
  });
  test("L1: logout clears credentials; explicit invalidation refreshes discovery", async () => {
    const { result } = await runLogoutScenario("discovery");
    expect(result).toEqual({ model: "muse-spark-1.2", ids: ["muse-spark-1.2"], refreshed: true });
  });
  test("L1: logout clears the signed-arm record through the installed billing probe", async () => {
    const { result } = await runLogoutScenario("billing");
    expect(result).toEqual({ reset: true });
  });
});
