import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let billing: typeof import("./billing-probe.js");
let savedFetch: typeof fetch;
let savedDisable: string | undefined;
let roles: typeof import("./prompt-role.js");
let store: typeof import("../../providers/meta-muse/muse-store.js");
let core: typeof import("../../providers/meta-muse/muse-credentials.js");
let kc: typeof import("../../providers/meta-muse/muse-keychain.js");
let generic: typeof import("../../providers/keychain.js");
let reads: number;
let mints: number;
const TOKEN = "dca:TESTTOKEN0001";
const KEY = "LLM|TESTKEY0001";
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
beforeEach(async () => {
  savedDisable = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  home = mkdtempSync(join(tmpdir(), "muse-role-test-"));
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol === "http:" && url.hostname === "127.0.0.1") return savedFetch(input, init);
      throw new Error(`unexpected network request: ${url.origin}${url.pathname}`);
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  generic = await import("../../providers/keychain.js");
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
  kc = await import("../../providers/meta-muse/muse-keychain.js");
  kc.setMuseKeychainTestDeps({
    dir: () => home,
    env: () => ({ CLAUDISH_DISABLE_KEYCHAIN: "1" }),
    now: () => 1000000,
    sleep: async () => {},
    pid: () => 98765,
    isAlive: () => false,
    presence: async () => ({ kind: "absent" }),
    startRead: () => {
      throw new Error("unexpected value read");
    },
  });
  roles = await import("./prompt-role.js");
  store = await import("../../providers/meta-muse/muse-store.js");
  core = await import("../../providers/meta-muse/muse-credentials.js");
  roles._resetCredentialPromptRoleForTest();
  core.resetMuseCredentialState();
  reads = 0;
  mints = 0;
  core.setMuseCoreTestDeps({
    readStore: (kind) => store.readMuseStore(kind, home),
    writeBorrowedCopy: (token, tier) =>
      store.writeBorrowedCopy(token, tier, home, () => new Date(1000000)),
    dir: () => home,
    now: () => 1000000,
    keychainLogin: async (use) => {
      reads++;
      return { kind: "used", value: await use(TOKEN), source: "keychain" };
    },
    // Exported MuseMint outcome, projected from the §8 confirmed capture.
    mint: async () => {
      mints++;
      return { apiKey: KEY, subsTierName: "Muse Code Power Usage" };
    },
  });
  billing = await import("./billing-probe.js");
  billing.clearSignedArm();
});
afterEach(() => {
  billing.clearSignedArm();
  globalThis.fetch = savedFetch;
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  kc.resetMuseKeychainState();
  kc.setMuseKeychainTestDeps(null);
  generic.invalidateKeychainCache();
  generic.setKeychainTestDeps(null);
  roles._resetCredentialPromptRoleForTest();
  restore("CLAUDISH_DISABLE_KEYCHAIN", savedDisable);
  rmSync(home, { recursive: true, force: true });
});

describe("P1: permission to read a credential", () => {
  test("default role is never, and explicit role setter returns the effective role", () => {
    expect(roles.credentialPromptRole()).toBe("never");
    expect(core.requestPathMayPrompt()).toBe(false);
    const prior = roles.credentialPromptRole();
    expect(prior).toBe("never");
    expect(roles.setCredentialPromptRole("interactive-launch")).toBe("interactive-launch");
    expect(roles.credentialPromptRole()).toBe("interactive-launch");
    expect(core.requestPathMayPrompt()).toBe(true);
    expect(roles.setCredentialPromptRole("tui")).toBe("interactive-launch");
    expect(roles.credentialPromptRole()).toBe("interactive-launch");
    expect(roles.setCredentialPromptRole("never")).toBe("never");
    expect(roles.credentialPromptRole()).toBe("never");
    expect(core.requestPathMayPrompt()).toBe(false);
  });
  test("eligible interactive launch receives prompt rights", () => {
    expect(roles.decideLaunchRole({ argv: [], env: {}, stdinIsTTY: true, stderrIsTTY: true })).toBe(
      "interactive-launch"
    );
  });
  for (const facts of [
    { argv: [], env: {}, stdinIsTTY: false, stderrIsTTY: true },
    { argv: [], env: {}, stdinIsTTY: true, stderrIsTTY: false },
    { argv: ["-p", "reply PONG"], env: {}, stdinIsTTY: false, stderrIsTTY: false },
    { argv: ["--probe", "muse@muse-spark-1.3"], env: {}, stdinIsTTY: true, stderrIsTTY: true },
  ]) {
    test(`denies launch rights for ${JSON.stringify(facts)}`, () => {
      expect(roles.decideLaunchRole(facts)).toBe("never");
    });
  }
  describe("decideTuiRole", () => {
    test("standalone TUI receives tui rights", () => {
      expect(roles.decideTuiRole({})).toBe("tui");
    });
    test("MCP session marker denies TUI rights without a cwd", () => {
      expect(roles.decideTuiRole({ CLAUDISH_PANE_CHILD: "1" })).toBe("never");
    });
    test("MCP session marker denies TUI rights with a cwd", () => {
      expect(roles.decideTuiRole({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "/x" })).toBe(
        "never"
      );
    });
    test("MCP session TUI role cannot later be raised to tui", () => {
      roles._resetCredentialPromptRoleForTest();
      roles.setCredentialPromptRole(roles.decideTuiRole({ CLAUDISH_PANE_CHILD: "1" }));
      expect(roles.credentialPromptRole()).toBe("never");
      roles.setCredentialPromptRole("tui");
      expect(roles.credentialPromptRole()).toBe("never");
    });
  });
  test("never role cannot gain rights from prompt:true", async () => {
    await expect(core.ensureMuseCredentialReady({ prompt: true })).rejects.toThrow("login");
    expect(reads).toBe(0);
    expect(mints).toBe(0);
    expect(core.currentMuseState()).toBeUndefined();
  });
  test("TUI proxy request cannot read Keychain", async () => {
    roles.setCredentialPromptRole("tui");
    await expect(
      core.ensureMuseCredentialReady({ prompt: core.requestPathMayPrompt() })
    ).rejects.toThrow("login");
    expect(reads).toBe(0);
    expect(mints).toBe(0);
    expect(core.currentMuseState()).toBeUndefined();
  });
  for (const action of ["Test", "Test All", "route probe"]) {
    test(`explicit wrapped ${action} prepares the credential before the action`, async () => {
      roles.setCredentialPromptRole("tui");
      const output = await core.withInteractiveCredential(async () => {
        expect(core.currentMuseState()).toMatchObject({ key: KEY, source: "keychain" });
        expect(core.requestPathMayPrompt()).toBe(false);
        await core.ensureMuseCredentialReady({ prompt: core.requestPathMayPrompt() });
        return action;
      });
      expect(output).toBe(action);
      expect(reads).toBe(1);
      expect(mints).toBe(1);
      expect(roles.credentialPromptRole()).toBe("tui");
      expect(core.requestPathMayPrompt()).toBe(false);
    });
  }
  test("overlapping requests in a never role cannot prompt", async () => {
    const results = await Promise.allSettled([
      core.ensureMuseCredentialReady({ prompt: false }),
      core.ensureMuseCredentialReady({ prompt: false }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of results)
      if (result.status === "rejected") expect(String(result.reason)).toContain("login");
    expect(reads).toBe(0);
    expect(mints).toBe(0);
  });
  test("P1: only the exact pane session marker identifies an MCP session", async () => {
    const pane = await import("../../pane/child-env.js");
    expect(pane.PANE_LAUNCH_VARS).toEqual(["CLAUDISH_PANE_ENV", "CLAUDISH_PANE_CWD"]);
    for (const marker of ["1", "0", "", "true", undefined]) {
      const env = marker === undefined ? {} : { CLAUDISH_PANE_CHILD: marker };
      expect(pane.inMcpSession(env)).toBe(marker === "1");
    }
  });
  test("P1: a pane child needs the exact session marker and a non-empty cwd", async () => {
    const pane = await import("../../pane/child-env.js");
    for (const marker of ["1", "0", "", "true", undefined]) {
      for (const cwd of ["/test/pane", "", undefined]) {
        const env = {
          ...(marker === undefined ? {} : { CLAUDISH_PANE_CHILD: marker }),
          ...(cwd === undefined ? {} : { CLAUDISH_PANE_CWD: cwd }),
        };
        expect(pane.isPaneChild(env)).toBe(marker === "1" && cwd === "/test/pane");
      }
    }
  });
  for (const cwd of [undefined, "/test/pane"]) {
    test(`P1: ${cwd === undefined ? "process nested below the pane child" : "pane/team child"} with real PTY facts never gains prompt rights`, async () => {
      const pane = await import("../../pane/child-env.js");
      const env = {
        CLAUDISH_PANE_CHILD: "1",
        ...(cwd === undefined ? {} : { CLAUDISH_PANE_CWD: cwd }),
      };
      expect(pane.inMcpSession(env)).toBe(true);
      expect(pane.isPaneChild(env)).toBe(cwd !== undefined);
      const role = roles.decideLaunchRole({ argv: [], env, stdinIsTTY: true, stderrIsTTY: true });
      expect(role).toBe("never");
      roles.setCredentialPromptRole(role);
      await expect(
        core.ensureMuseCredentialReady({ prompt: core.requestPathMayPrompt() })
      ).rejects.toThrow("muse@ in a team slot / MCP session needs a claudish login");
      expect(reads).toBe(0);
      expect(mints).toBe(0);
    });
  }
  test.skip("P1 BLOCKED: actual MCP/preflight probe:true and probe:false handlers are not exported; startMcpServer has no injected server or tool-dispatch seam", () => {});
});
