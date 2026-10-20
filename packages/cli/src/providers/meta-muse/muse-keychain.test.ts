import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

let home: string;
let billing: typeof import("../../auth/credentials/billing-probe.js");
let savedFetch: typeof fetch;
let savedDisable: string | undefined;
let savedFile: string | undefined;
let generic: typeof import("../keychain.js");
let kc: typeof import("./muse-keychain.js");
let store: typeof import("./muse-store.js");
let roles: typeof import("../../auth/credentials/prompt-role.js");
let core: typeof import("./muse-credentials.js");
let now: number;
let commands: string[][];
let presenceCode: number;
let savedKill: typeof process.kill;
let signals: Array<string | number | undefined>;
const TOKEN = "dca:TESTTOKEN0001";
// Corrected §7 schema. The stored api_key must never become a credential.
const SECRET = JSON.stringify({
  secret_schema_version: 1,
  api_key: "LLM|TESTKEY0001",
  access_token: TOKEN,
});
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
// The generic seam is always fully fake; these wrappers exercise its public API.
function installGeneric(overrides: Partial<import("../keychain.js").KeychainDeps> = {}) {
  generic.setKeychainTestDeps({
    platform: () => "darwin",
    run: (args) => {
      commands.push(args);
      return { code: 44, stdout: "", stderr: "absent" };
    },
    runAsync: async (args) => {
      commands.push(args);
      return { code: presenceCode, stdout: "", stderr: "" };
    },
    spawnAsync: (args) => {
      commands.push(args);
      return {
        pid: 12345,
        done: Promise.resolve(
          args.includes("-w")
            ? { code: 0, stdout: SECRET, stderr: "" }
            : { code: presenceCode, stdout: "", stderr: presenceCode ? "denied or absent" : "" }
        ),
      };
    },
    ...overrides,
  });
}
function installKeychain(overrides: Partial<import("./muse-keychain.js").MuseKeychainDeps> = {}) {
  kc.setMuseKeychainTestDeps({
    presence: (query) => generic.findGenericPasswordPresence(query),
    startRead: (query) => generic.startGenericPasswordRead(query),
    now: () => now,
    dir: () => home,
    env: () => ({}),
    pid: () => 98765,
    isAlive: () => false,
    sleep: async (ms) => {
      now += ms;
      await Promise.resolve();
    },
    ...overrides,
  });
}
beforeEach(async () => {
  savedDisable = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  savedFile = process.env.CLAUDISH_MUSE_KEYCHAIN_FILE;
  home = mkdtempSync(join(tmpdir(), "muse-keychain-test-"));
  delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  delete process.env.CLAUDISH_MUSE_KEYCHAIN_FILE;
  commands = [];
  now = 10000;
  presenceCode = 0;
  signals = [];
  savedKill = process.kill;
  process.kill = ((_pid: number, signal?: string | number) => {
    signals.push(signal);
    return true;
  }) as typeof process.kill;
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol === "http:" && url.hostname === "127.0.0.1") return savedFetch(input, init);
      throw new Error(`unexpected network request: ${url.origin}${url.pathname}`);
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  generic = await import("../keychain.js");
  installGeneric();
  kc = await import("./muse-keychain.js");
  store = await import("./muse-store.js");
  kc.resetMuseKeychainState();
  installKeychain();
  roles = await import("../../auth/credentials/prompt-role.js");
  roles._resetCredentialPromptRoleForTest();
  core = await import("./muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps({
    dir: () => home,
    now: () => now,
    readStore: (kind) => store.readMuseStore(kind, home),
    writeBorrowedCopy: (token, tier) =>
      store.writeBorrowedCopy(token, tier, home, () => new Date(now)),
    mint: async () => {
      throw new Error("unexpected mint");
    },
    keychainLogin: async () => {
      throw new Error("unexpected core Keychain read");
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
  globalThis.fetch = savedFetch;
  process.kill = savedKill;
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  roles._resetCredentialPromptRoleForTest();
  kc.resetMuseKeychainState();
  kc.setMuseKeychainTestDeps(null);
  generic.invalidateKeychainCache();
  generic.setKeychainTestDeps(null);
  restore("CLAUDISH_DISABLE_KEYCHAIN", savedDisable);
  restore("CLAUDISH_MUSE_KEYCHAIN_FILE", savedFile);
  rmSync(home, { recursive: true, force: true });
  expect(signals.filter((signal) => signal !== 0)).toEqual([]);
});
function assertReadOnly() {
  expect(signals.filter((signal) => signal !== 0)).toEqual([]);
  for (const args of commands) {
    expect(args[0]).toBe("find-generic-password");
    expect(args).toContain("ai.meta.dev.credentials");
    expect(args).toContain("meta");
    expect(args).not.toContain("delete-generic-password");
    expect(args).not.toContain("add-generic-password");
  }
}

describe("K1: metadata presence and corrected secret schema", () => {
  test("presence uses exact service/account without -w and memoizes for 3 seconds", async () => {
    expect(kc.MUSE_KEYCHAIN_SERVICE).toBe("ai.meta.dev.credentials");
    expect(kc.MUSE_KEYCHAIN_ACCOUNT).toBe("meta");
    expect(kc.museKeychainPresenceCached()).toBe("unknown");
    expect(commands).toEqual([]);
    expect(await kc.museKeychainPresence()).toBe("present");
    expect(await kc.museKeychainPresence()).toBe("present");
    now += 2999;
    expect(await kc.museKeychainPresence()).toBe("present");
    expect(commands.filter((args) => !args.includes("-w"))).toHaveLength(1);
    presenceCode = 44;
    now += 2;
    expect(await kc.museKeychainPresence()).toBe("absent");
    expect(commands.filter((args) => !args.includes("-w"))).toHaveLength(2);
    expect(kc.museKeychainPresenceCached()).toBe("absent");
    for (const args of commands) {
      expect(args).not.toContain("-w");
      expect(args).not.toContain("-g");
    }
    assertReadOnly();
  });
  test("K1: Providers tab render and display use metadata only in an isolated HOME child", async () => {
    // The script is a sibling of HOME; application mutations are confined to HOME.
    // The existing afterEach removes this entire test-owned root.
    const tempHome = join(home, "home");
    mkdirSync(tempHome);
    const scriptPath = join(home, "render-scenario.ts");
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

const generic = await import(${JSON.stringify(resolve(import.meta.dir, "../keychain.js"))});
generic.setKeychainTestDeps({ platform: () => "darwin",
  run: args => { commands.push(args); return { code: 44, stdout: "", stderr: "absent" }; },
  runAsync: async args => { commands.push(args); return { code: 0, stdout: "", stderr: "" }; },
  spawnAsync: args => { commands.push(args); return { pid: undefined,
    done: Promise.resolve({ code: 0, stdout: "", stderr: "" }) }; } });
const kc = await import(${JSON.stringify(resolve(import.meta.dir, "./muse-keychain.js"))});
const store = await import(${JSON.stringify(resolve(import.meta.dir, "./muse-store.js"))});
const dir = store.defaultMuseStoreDir();
assert.ok(isInside(dir));
kc.resetMuseKeychainState();
kc.setMuseKeychainTestDeps({ dir: () => dir, env: () => ({}), now: () => 10000,
  sleep: async () => {}, pid: () => 98765, isAlive: () => false,
  presence: query => generic.findGenericPasswordPresence(query),
  startRead: () => { throw new Error("render must not read Keychain value"); } });
const core = await import(${JSON.stringify(resolve(import.meta.dir, "./muse-credentials.js"))});
const roles = await import(${JSON.stringify(resolve(import.meta.dir, "../../auth/credentials/prompt-role.js"))});
core.resetMuseCredentialState(); roles._resetCredentialPromptRoleForTest();
core.setMuseCoreTestDeps({ dir: () => dir, now: () => 10000,
  readStore: kind => store.readMuseStore(kind, dir),
  writeBorrowedCopy: (token, tier) => store.writeBorrowedCopy(token, tier, dir),
  mint: async () => { throw new Error("unexpected mint"); },
  keychainLogin: async () => { throw new Error("unexpected core Keychain read"); } });
const providers = await import(${JSON.stringify(resolve(import.meta.dir, "../../tui/providers.js"))});
const { ProvidersContent } = await import(${JSON.stringify(resolve(import.meta.dir, "../../tui/components/ProvidersContent.js"))});
const provider = providers.getProviderDefs().find(p => p.catalogName === "meta-muse-code");
assert.ok(provider, "Muse Providers tab entry missing");
const config = { version: "1", defaultProfile: "", profiles: {}, apiKeys: {} };
const readyBefore = providers.providerIsReadyForDisplay(provider, config, {});
assert.equal(readyBefore, false);
assert.equal(providers.providerAuthCapabilities(provider, config).oauth.supported, true);
assert.equal(core.museCredentialStatus(dir), "unknown");
function render(animTick) {
  const rendered = ProvidersContent({ config, displayProviders: [provider], providerIndex: 0,
    testResults: {}, localLiveness: {}, contentH: 20, isInputMode: false, animTick });
  assert.notEqual(rendered, null); assert.notEqual(rendered, undefined);
}
render(0);
assert.deepEqual(commands, []);
assert.equal(await kc.museKeychainPresence(), "present");
const count = commands.length;
assert.ok(count > 0);
const readyAfter = providers.providerIsReadyForDisplay(provider, config, {});
assert.equal(readyAfter, true);
const status = core.museCredentialStatus(dir);
assert.equal(status, "keychain");
assert.notEqual(providers.providerCredentialNote(provider), undefined);
render(1);
assert.equal(commands.length, count);
assert.ok(commands.every(args => args[0] === "find-generic-password" && !args.includes("-w")));
assert.deepEqual(urls, []);
assert.ok(writes.every(isInside));
const billing = await import(${JSON.stringify(resolve(import.meta.dir, "../../auth/credentials/billing-probe.js"))});
billing.clearSignedArm();
core.resetMuseCredentialState(); core.setMuseCoreTestDeps(null);
kc.resetMuseKeychainState(); kc.setMuseKeychainTestDeps(null);
generic.invalidateKeychainCache(); generic.setKeychainTestDeps(null);
roles._resetCredentialPromptRoleForTest();
process.stdout.write(JSON.stringify({ readyBefore, readyAfter, status, renders: 2,
  commands: commands.length, valueReads: commands.filter(args => args.includes("-w")).length,
  requests: urls.length, outsideWrites: writes.filter(path => !isInside(path)) }) + "\\n");
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
    const result = JSON.parse(lines[0]!);
    expect(result).toEqual({
      readyBefore: false,
      readyAfter: true,
      status: "keychain",
      renders: 2,
      commands: result.commands,
      valueReads: 0,
      requests: 0,
      outsideWrites: [],
    });
    expect(result.commands).toBeGreaterThan(0);
    expect(readFileSync(scriptPath, "utf8")).toBe(script);
    expect(readdirSync(home).sort()).toEqual(["home", "render-scenario.ts"]);
  });
  test("parses only nonempty access_token; ignores api_key", () => {
    expect(kc.parseMuseKeychainValue(SECRET)).toBe(TOKEN);
    for (const raw of [
      "not json",
      "null",
      "{}",
      JSON.stringify({ secret_schema_version: 1, api_key: "LLM|TESTKEY0001" }),
      JSON.stringify({ secret_schema_version: 1, access_token: "", api_key: "LLM|TESTKEY0001" }),
    ]) {
      expect(kc.parseMuseKeychainValue(raw)).toBeNull();
    }
    expect(commands).toEqual([]);
  });
  test("never role denies the value read with zero spawns", async () => {
    expect(roles.credentialPromptRole()).toBe("never");
    let used = 0;
    expect(
      await kc.withMuseKeychainLogin(async () => {
        used++;
      })
    ).toEqual({ kind: "not-allowed" });
    expect(used).toBe(0);
    expect(commands).toEqual([]);
    assertReadOnly();
  });
  test("value read supplies the durable token and cannot mutate Muse's item", async () => {
    roles.setCredentialPromptRole("interactive-launch");
    const seen: string[] = [];
    await kc.withMuseKeychainLogin(async (token) => {
      seen.push(token);
      return token;
    });
    expect(seen).toEqual([TOKEN]);
    expect(commands.filter((args) => args.includes("-w"))).toHaveLength(1);
    assertReadOnly();
  });
  test("disabled Keychain does not issue metadata or value reads", async () => {
    roles.setCredentialPromptRole("interactive-launch");
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    installKeychain({ env: () => ({ CLAUDISH_DISABLE_KEYCHAIN: "1" }) });
    expect(await kc.museKeychainPresence()).toBe("absent");
    let used = 0;
    await kc.withMuseKeychainLogin(async () => {
      used++;
    });
    expect(used).toBe(0);
    expect(commands).toEqual([]);
  });
  test("non-macOS cannot issue a security process", async () => {
    roles.setCredentialPromptRole("interactive-launch");
    installGeneric({ platform: () => "linux" });
    expect(await kc.museKeychainPresence()).toBe("absent");
    let used = 0;
    await kc.withMuseKeychainLogin(async () => {
      used++;
    });
    expect(used).toBe(0);
    expect(commands).toEqual([]);
  });
  for (const code of [44, 36]) {
    test(`presence/read exit ${code} never provides a token`, async () => {
      roles.setCredentialPromptRole("interactive-launch");
      presenceCode = code;
      expect(await kc.museKeychainPresence()).toBe(code === 44 ? "absent" : "failed");
      installGeneric({
        spawnAsync: (args) => {
          commands.push(args);
          return {
            pid: 12345,
            done: Promise.resolve({ code, stdout: "", stderr: "access denied or absent" }),
          };
        },
      });
      let used = 0;
      await kc.withMuseKeychainLogin(async () => {
        used++;
      });
      expect(used).toBe(0);
      assertReadOnly();
    });
  }
});

describe("K2: joinable reads and process locks", () => {
  test("timeout leaves read alive; late approval is joined without another spawn", async () => {
    let finish!: (v: import("../keychain.js").KeychainRunResult) => void;
    const done = new Promise<import("../keychain.js").KeychainRunResult>((resolve) => {
      finish = resolve;
    });
    installGeneric({
      spawnAsync: (args) => {
        commands.push(args);
        return {
          pid: 12345,
          done: args.includes("-w") ? done : Promise.resolve({ code: 0, stdout: "", stderr: "" }),
        };
      },
    });
    roles.setCredentialPromptRole("interactive-launch");
    const seen: string[] = [];
    const first = await kc.withMuseKeychainLogin(async (token) => {
      seen.push(token);
      return token;
    }, 10);
    expect(first).toEqual({ kind: "timeout" });
    expect(seen).toEqual([]);
    expect(commands.filter((args) => args.includes("-w"))).toHaveLength(1);
    finish({ code: 0, stdout: SECRET, stderr: "" });
    await kc.withMuseKeychainLogin(async (token) => {
      seen.push(token);
      return token;
    }, 1000);
    expect(seen).toEqual([TOKEN]);
    expect(commands.filter((args) => args.includes("-w"))).toHaveLength(1);
    assertReadOnly();
  });
  test("live-pid lock waits and consumes the winner's borrowed copy without spawning", async () => {
    const lock = join(home, "muse-keychain-read.lock");
    writeFileSync(lock, JSON.stringify({ pid: 22222, startedAt: now }));
    let waits = 0;
    installKeychain({
      isAlive: (pid) => pid === 22222,
      sleep: async (ms) => {
        waits++;
        now += ms;
        store.writeBorrowedCopy(TOKEN, "Muse Code Power Usage", home);
        rmSync(lock, { force: true });
      },
    });
    roles.setCredentialPromptRole("interactive-launch");
    const seen: string[] = [];
    await kc.withMuseKeychainLogin(async (token) => {
      seen.push(token);
      return token;
    }, 1000);
    expect(waits).toBeGreaterThan(0);
    expect(seen).toEqual([TOKEN]);
    expect(commands).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });
  test("dead-pid lock is removed and a new read succeeds", async () => {
    const lock = join(home, "muse-keychain-read.lock");
    writeFileSync(lock, JSON.stringify({ pid: 22222, startedAt: now }));
    installKeychain({ isAlive: () => false });
    roles.setCredentialPromptRole("interactive-launch");
    const seen: string[] = [];
    await kc.withMuseKeychainLogin(async (token) => {
      seen.push(token);
    });
    expect(seen).toEqual([TOKEN]);
    expect(existsSync(lock)).toBe(false);
    expect(commands.filter((args) => args.includes("-w"))).toHaveLength(1);
    assertReadOnly();
  });
});
