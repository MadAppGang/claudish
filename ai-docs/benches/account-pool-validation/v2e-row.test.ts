/**
 * Row V2e with a FAKE `security` and a fake row context: no test here runs `/usr/bin/security`,
 * starts a serve process or touches a keychain.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Producer } from "./direct.ts";
import {
  BANNED_CHILD_ENV,
  KeychainGuard,
  KeychainTimeoutError,
  type SecResult,
  TRIPPED_MESSAGE,
  deleteArgs,
  presenceArgs,
  psLister,
  readArgs,
} from "./keychain-guard.ts";
import { MUTANTS } from "./mutants.ts";
import { ROWS, V2E_MEMO_WINDOW_MS, defaultV2eGuardOptions, v2eBody, v2ePlan } from "./rows.ts";
import { harnessErrorOf, offlineFor } from "./run-row.ts";
import { tokenPathOf } from "./seed.ts";

describe("row V2e registration", () => {
  const row = ROWS.find((r) => r.id === "V2e");

  test("is registered as a keychain row with a required red mutant", () => {
    expect(row?.keychain).toBe(true);
    expect(row?.mutants.map((m) => [m.id, m.expected])).toEqual([
      ["V2e-keychain-reads-memoized", "red"],
    ]);
    expect(row?.canary).toBe(0);
  });

  test("its mutant exists, targets V2e and has a single anchor edit", () => {
    const m = MUTANTS.find((x) => x.id === "V2e-keychain-reads-memoized");
    expect(m?.rows).toEqual(["V2e"]);
    expect(m?.edits.length).toBe(1);
  });

  test("only V2e needs a keychain, so --all (which skips keychain rows) never reaches it", () => {
    expect(ROWS.filter((r) => r.keychain).map((r) => r.id)).toEqual(["V2e"]);
  });

  test("the steps describe the default keychain, the native writer and no temporary keychain", () => {
    expect(row?.steps).toContain("default (login) keychain");
    expect(row?.steps).toContain("KeychainTokenStore.write");
    expect(row?.steps).toContain("no temporary keychain");
    expect(row?.steps).toContain("no search-list");
    for (const name of BANNED_CHILD_ENV) expect(row?.steps).not.toContain(name);
  });

  test("the memo window is the bundle's MEMO_TTL_MS", () => {
    expect(V2E_MEMO_WINDOW_MS).toBe(3000);
  });

  test("the red predicate fires only on the memo's own evidence: a rejected or a second accepted exchange", () => {
    const red = row?.mutants[0]?.red;
    const obs = (ok: number, invalidGrant: number, failedChecks: string[] = []) =>
      ({
        exchanges: { ok, invalidGrant },
        failedChecks,
        notes: {},
        canary: 0,
        mainCount: 0,
      }) as never;
    expect(red?.(obs(1, 1))).toContain("invalid_grant=1");
    expect(red?.(obs(2, 0))).toContain("ok=2");
    // failed row checks alone are never red: only the memo's own evidence (a second exchange)
    expect(red?.(obs(1, 0, ["[third] two HTTP 200"]))).toBeNull();
    expect(red?.(obs(0, 0, ["[third] two HTTP 200"]))).toBeNull();
    expect(red?.(obs(1, 0))).toBeNull();
  });
});

describe("run-row helpers for V2e", () => {
  test("harnessErrorOf reads only a string note", () => {
    expect(harnessErrorOf({ harnessError: "slow runner" })).toBe("slow runner");
    expect(harnessErrorOf({ harnessError: 3 })).toBeNull();
    expect(harnessErrorOf({})).toBeNull();
  });

  test("the sandbox stays on by default and for every other row", () => {
    expect(offlineFor({ keychain: true }, true, { noSandbox: false })).toEqual({ offline: true });
    expect(offlineFor({}, true, { noSandbox: true, reason: "x" })).toEqual({ offline: true });
  });

  test("dropping the sandbox needs a recorded reason", () => {
    expect(offlineFor({ keychain: true }, true, { noSandbox: true })).toHaveProperty("error");
    expect(offlineFor({ keychain: true }, true, { noSandbox: true, reason: "  " })).toHaveProperty(
      "error"
    );
    expect(
      offlineFor({ keychain: true }, true, { noSandbox: true, reason: "securityd denied" })
    ).toEqual({ offline: false, reason: "securityd denied" });
  });
});

// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ID = "aaaaaaaaaaaa";
const REC = { accessToken: "access-A", refreshToken: "refresh-A", generation: 1 };

/** A row tree with A's token file and a file-store config, as the seed leaves it. */
function setupTree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "v2e-body-")));
  roots.push(root);
  const home = join(root, "home");
  const accountsDir = join(home, ".claudish", "accounts");
  mkdirSync(dirname(tokenPathOf(accountsDir, ID)), { recursive: true });
  writeFileSync(tokenPathOf(accountsDir, ID), `${JSON.stringify(REC, null, 2)}\n`);
  writeFileSync(
    join(home, ".claudish", "config.json"),
    JSON.stringify({
      subscriptionAccounts: { "openai-codex": { accounts: [{ id: ID, store: "file" }] } },
    })
  );
  const cwd = join(root, "work");
  mkdirSync(cwd);
  return { root, home, accountsDir, cwd };
}

type Tree = ReturnType<typeof setupTree>;

interface FakeProc {
  killed: string[];
  kill(signal?: string): void;
}

const REPLY_503 = { status: 503, headers: {}, body: { error: { message: "x" } } as unknown };

/** A fake serve tree as the guard's producer: records kill and confirmation into `events`. */
function serveProducer(n: number, events: string[]): Producer {
  return {
    name: `serve ${n}`,
    pid: 90_000 + n,
    kill: () => {
      if (!events.includes(`kill serve ${n}`)) events.push(`kill serve ${n}`);
    },
    async confirmGone() {
      this.kill();
      events.push(`gone serve ${n}`);
      return true;
    },
    confirmGoneSync() {
      this.kill();
      events.push(`gone serve ${n}`);
      return true;
    },
  };
}

/** A fake RunCtx: records serve starts, notes, checks and saved files. */
function ctxOf(t: Tree, reply = REPLY_503, events: string[] = []) {
  const served: Array<{ env: Record<string, string> | undefined; proc: FakeProc }> = [];
  const notes: Record<string, unknown> = {};
  const saved: Record<string, string> = {};
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const c = {
    dir: t.root,
    tree: { root: t.root, home: t.home, accountsDir: t.accountsDir, cwd: t.cwd },
    check: (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail }),
    note: (k: string, v: unknown) => {
      notes[k] = v;
    },
    save: (n: string, text: string) => {
      saved[n] = text;
    },
    onCleanup: () => {},
    serve: async (env?: Record<string, string>, hooks?: { onSpawn?: (p: Producer) => void }) => {
      hooks?.onSpawn?.(serveProducer(served.length + 1, events));
      const proc: FakeProc = {
        killed: [],
        kill(signal = "SIGTERM") {
          proc.killed.push(signal);
        },
      };
      served.push({ env, proc });
      return proc;
    },
    post: async () => reply,
    fake: {
      exchanges: () => ({ ok: 0, invalidGrant: 0 }),
      requests: [] as Array<{ kind: string }>,
    },
    main: () => [],
    accounts: () => [],
    stateJson: () => null,
  };
  return { c, served, notes, saved, checks };
}

/** A fake `security` holding at most the bench item; `hook` overrides one call. */
function fakeSecurity(hook?: (args: string[]) => SecResult | undefined) {
  const state = { present: false, value: JSON.stringify(REC), calls: [] as string[][] };
  const res = (code: number, stdout = ""): SecResult => ({
    code,
    stdout,
    stderr: "",
    timedOut: false,
  });
  const run = async (args: string[]): Promise<SecResult> => {
    state.calls.push([...args]);
    const forced = hook?.(args);
    if (forced) return forced;
    if (args[0] === "find-generic-password")
      return state.present ? res(0, args.includes("-w") ? `${state.value}\n` : "") : res(44);
    if (args[0] === "delete-generic-password") {
      if (!state.present) return res(44);
      state.present = false;
      return res(0);
    }
    return res(1);
  };
  return { state, run };
}

function guardFor(t: Tree, sec: ReturnType<typeof fakeSecurity>) {
  const childEnvs: Array<Record<string, string>> = [];
  const guard = new KeychainGuard({
    run: sec.run,
    recoveryFile: join(t.root, "recovery.json"),
    lockFile: join(t.root, "lock"),
    stateDir: t.root,
    proc: { on: () => process, off: () => process },
    runChild: async (_cmd, o) => {
      childEnvs.push(o.env);
      sec.state.present = true; // the product writer stored the item
      return { code: 0, stdout: "seeded", stderr: "", timedOut: false };
    },
  });
  return { guard, childEnvs };
}

const hung = (): SecResult => ({ code: null, stdout: "", stderr: "", timedOut: true });

describe("v2eBody on the default keychain", () => {
  test("order: preflight, product writer, value read, two serve processes, one cleanup delete", async () => {
    const t = setupTree();
    const sec = fakeSecurity();
    const { guard, childEnvs } = guardFor(t, sec);
    const { c, served } = ctxOf(t);
    await guard.runWithDeadline(() => v2eBody(c as never, guard));
    expect(sec.state.calls).toEqual([presenceArgs(), readArgs(), readArgs(), deleteArgs()]);
    expect(served.length).toBe(2);
    expect(childEnvs.length).toBe(1);
    // no keychain redirect anywhere: not the writer, not the serve processes
    for (const name of BANNED_CHILD_ENV) {
      expect(name in (childEnvs[0] ?? {})).toBe(false);
      for (const s of served) expect(name in (s.env ?? {})).toBe(false);
    }
    // Real HOME: `security` finds the login keychain only through $HOME/Library. The row's own
    // config (review round 6, A1): without it the real HOME means the real account list.
    for (const s of served)
      expect(s.env).toEqual({
        HOME: userInfo().homedir,
        CLAUDISH_CONFIG: join(t.home, ".claudish", "config.json"),
        CLAUDISH_DISABLE_KEYCHAIN: "0",
        CLAUDISH_ACCOUNT_STORE: "",
      });
    expect(childEnvs[0]?.CLAUDISH_CONFIG).toBe(join(t.home, ".claudish", "config.json"));
    const cfg = JSON.parse(readFileSync(join(t.home, ".claudish", "config.json"), "utf8"));
    expect(cfg.subscriptionAccounts["openai-codex"].accounts[0].store).toBe("keychain");
    expect(sec.state.present).toBe(false);
  });

  test("a value that is not JSON records a failing, masked check and starts no process", async () => {
    const t = setupTree();
    const sec = fakeSecurity((args) =>
      args.includes("-w")
        ? { code: 0, stdout: `${"7b2261223a".repeat(30)}\n`, stderr: "", timedOut: false }
        : undefined
    );
    const { guard } = guardFor(t, sec);
    const { c, served, checks } = ctxOf(t);
    await guard.runWithDeadline(() => v2eBody(c as never, guard));
    const bad = checks.filter((x) => !x.ok);
    expect(bad.map((x) => x.name).join("|")).toContain("readable JSON");
    expect(bad[0]?.detail).toContain("hex value, length 300");
    expect(served.length).toBe(0);
  });

  test("no token request at all ends as a harness error that points at the serve logs", async () => {
    const t = setupTree();
    const sec = fakeSecurity();
    const { guard } = guardFor(t, sec);
    const { c, notes } = ctxOf(t, {
      status: 503,
      headers: {},
      body: { error: { message: "journal could not be written" } },
    });
    await guard.runWithDeadline(() => v2eBody(c as never, guard));
    expect(String(notes.harnessError)).toContain("the race never started");
    expect(String(notes.harnessError)).toContain("journal could not be written");
    expect(String(notes.harnessError)).toContain("serve-*-stderr.txt");
    expect(Array.isArray(notes.replyMs)).toBe(true);
  });
});

describe("V2e stops after the first timed-out keychain call", () => {
  test("a timed-out read before the race: no serve process starts, the row is ERROR, one delete", async () => {
    const t = setupTree();
    const sec = fakeSecurity((args) => (args.includes("-w") ? hung() : undefined));
    const { guard } = guardFor(t, sec);
    const { c, served, notes, saved } = ctxOf(t);
    await expect(v2ePlan(() => guard).run(c as never)).rejects.toBeInstanceOf(KeychainTimeoutError);
    expect(served).toEqual([]);
    expect(notes.harnessError).toBe(TRIPPED_MESSAGE);
    expect(sec.state.calls).toEqual([presenceArgs(), readArgs(), deleteArgs()]);
    const log = JSON.parse(saved["security-calls.json"] as string) as Array<{ timedOut: boolean }>;
    expect(log.filter((x) => x.timedOut).length).toBe(1);
  });

  test("a timed-out read after the race kills both serve processes", async () => {
    const t = setupTree();
    let reads = 0;
    const sec = fakeSecurity((args) => (args.includes("-w") && ++reads === 2 ? hung() : undefined));
    const { guard } = guardFor(t, sec);
    const { c, served, notes } = ctxOf(t);
    await expect(v2ePlan(() => guard).run(c as never)).rejects.toBeInstanceOf(KeychainTimeoutError);
    expect(served.length).toBe(2);
    for (const s of served) expect(s.proc.killed).toEqual(["SIGKILL"]);
    expect(notes.harnessError).toBe(TRIPPED_MESSAGE);
    expect(sec.state.calls.filter((x) => x[0] === "delete-generic-password")).toEqual([
      deleteArgs(),
    ]);
  });

  test("a timed-out preflight: no writer, no serve, no delete", async () => {
    const t = setupTree();
    const sec = fakeSecurity(() => hung());
    const { guard, childEnvs } = guardFor(t, sec);
    const { c, served, notes } = ctxOf(t);
    await expect(v2ePlan(() => guard).run(c as never)).rejects.toBeInstanceOf(KeychainTimeoutError);
    expect(childEnvs).toEqual([]);
    expect(served).toEqual([]);
    expect(sec.state.calls).toEqual([presenceArgs()]);
    expect(notes.harnessError).toBe(TRIPPED_MESSAGE);
  });

  test("a leftover item refuses the row with the recovery advice and deletes nothing", async () => {
    const t = setupTree();
    const sec = fakeSecurity();
    sec.state.present = true;
    const { guard } = guardFor(t, sec);
    const { c, served, notes } = ctxOf(t);
    await expect(v2ePlan(() => guard).run(c as never)).rejects.toThrow(/leftover bench item/);
    expect(notes.harnessError).toBe(
      "a leftover bench item exists; run `--recover-keychain` to delete it"
    );
    expect(served).toEqual([]);
    expect(sec.state.calls).toEqual([presenceArgs()]);
    expect(sec.state.present).toBe(true);
  });
});

describe("review round 6: V2e never reads the real account list and stops producers before the delete", () => {
  test("a row config that lists a real account is refused before the seed child or any serve", async () => {
    const t = setupTree();
    writeFileSync(
      join(t.home, ".claudish", "config.json"),
      JSON.stringify({
        subscriptionAccounts: {
          "openai-codex": { accounts: [{ id: ID, store: "file" }, { id: "dc53ea1b2616" }] },
        },
      })
    );
    const sec = fakeSecurity();
    const { guard, childEnvs } = guardFor(t, sec);
    const { c, served, notes } = ctxOf(t);
    await expect(v2ePlan(() => guard).run(c as never)).rejects.toThrow(
      /only openai-codex:aaaaaaaaaaaa/
    );
    expect(childEnvs).toEqual([]);
    expect(served).toEqual([]);
    expect(String(notes.harnessError)).toContain("dc53ea1b2616");
    expect(sec.state.calls).toEqual([presenceArgs()]);
  });

  test("both serve trees are registered, killed and confirmed gone before the one cleanup delete", async () => {
    const t = setupTree();
    const events: string[] = [];
    const sec = fakeSecurity((args) => {
      events.push(`security ${args[0]}`);
      return undefined;
    });
    const { guard } = guardFor(t, sec);
    const { c } = ctxOf(t, REPLY_503, events);
    await guard.runWithDeadline(() => v2eBody(c as never, guard));
    const del = events.indexOf("security delete-generic-password");
    expect(del).toBeGreaterThan(0);
    for (const n of [1, 2]) {
      expect(events.indexOf(`kill serve ${n}`)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(`gone serve ${n}`)).toBeLessThan(del);
    }
  });

  test("the real V2e guard watches every producer tree for a long security call", () => {
    const o = defaultV2eGuardOptions({ dir: "/nonexistent" });
    expect(o.watch?.list).toBe(psLister);
  });
});
