/**
 * keychain-guard.ts against a FAKE `security` only: no test here runs `/usr/bin/security`.
 * The real runners are exercised with `/bin/sleep`, `/bin/echo` and `/bin/cat`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Producer } from "./direct.ts";
import {
  ALLOWED_SUBCOMMANDS,
  BANNED_CHILD_ENV,
  BANNED_SUBCOMMANDS,
  BENCH_ACCOUNT,
  BENCH_SERVICE,
  type ChildRunner,
  CleanupError,
  DeadlineError,
  GuardRefusal,
  KeychainGuard,
  KeychainTimeoutError,
  LockHeldError,
  MANUAL_DELETE_COMMAND,
  RECOVERY_COMMAND,
  SERVE_SECURITY_LIMIT_MS,
  type SecResult,
  type SecurityRunner,
  TRIPPED_MESSAGE,
  assertChildEnv,
  assertFakeItem,
  assertFakeOnlyConfig,
  assertSecurityCall,
  decodeSecurityOutput,
  deleteArgs,
  describeUnparsable,
  longSecurityCall,
  makeChildRunner,
  makeSecurityRunner,
  parseEtime,
  parsePsRows,
  presenceArgs,
  readArgs,
  recoverKeychain,
  redact,
  takeLock,
} from "./keychain-guard.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REAL_ACCOUNT = "openai-codex:dc53ea1b2616";
const VALUE = JSON.stringify({ accessToken: "access-A", refreshToken: "refresh-A", generation: 1 });

const ok = (stdout = ""): SecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const exit = (code: number): SecResult => ({ code, stdout: "", stderr: "", timedOut: false });
const hung = (): SecResult => ({ code: null, stdout: "", stderr: "", timedOut: true });

interface Fake {
  run: SecurityRunner;
  calls: string[][];
  present: boolean;
  /** Return a result to override the default behaviour of one call. */
  hook?: (args: string[], n: number) => SecResult | undefined;
}

/** A fake `security` holding at most the one bench item. */
function fakeSecurity(hook?: Fake["hook"], present = false): Fake {
  const f: Fake = {
    calls: [],
    present,
    hook,
    run: async (args) => {
      const n = f.calls.length;
      f.calls.push([...args]);
      const forced = f.hook?.(args, n);
      if (forced) return forced;
      if (args[0] === "find-generic-password") {
        if (!f.present) return exit(44);
        return args.includes("-w") ? ok(`${VALUE}\n`) : ok("attributes");
      }
      if (args[0] === "delete-generic-password") {
        if (!f.present) return exit(44);
        f.present = false;
        return ok();
      }
      return exit(1);
    },
  };
  return f;
}

/** A V2e config naming only the fake account (what the row writes). */
const FAKE_ONLY_CONFIG = JSON.stringify({
  subscriptionAccounts: { "openai-codex": { accounts: [{ id: "aaaaaaaaaaaa", store: "file" }] } },
});

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kg-test-")));
  dirs.push(base);
  const configPath = join(base, "config.json");
  writeFileSync(configPath, FAKE_ONLY_CONFIG);
  return {
    base,
    recoveryFile: join(base, "recovery.json"),
    lockFile: join(base, "lock"),
    stateDir: base,
    configPath,
  };
}

const noSignals = { on: () => process, off: () => process };

const guardOf = (fake: Fake, s: ReturnType<typeof setup>, extra = {}) =>
  new KeychainGuard({
    run: fake.run,
    recoveryFile: s.recoveryFile,
    lockFile: s.lockFile,
    stateDir: s.stateDir,
    proc: noSignals,
    runChild: async () => ok("seeded"),
    ...extra,
  });

/** The guard's private chokepoint, for allowlist tests. */
const callOf = (g: KeychainGuard) =>
  (g as unknown as { call: (a: string[], k?: "work" | "cleanup") => Promise<SecResult> }).call.bind(
    g
  );

type ChildCall = { cmd: string[]; env: Record<string, string>; cwd: string; timeoutMs: number };

const item = (
  s: ReturnType<typeof setup>,
  over: Partial<{ id: string; recordJson: string }> = {}
) => ({
  id: "aaaaaaaaaaaa",
  label: "A",
  recordJson: VALUE,
  home: join(s.base, "row-home"),
  accountsDir: join(s.base, "row-home", ".claudish", "accounts"),
  cwd: s.base,
  configPath: s.configPath,
  ...over,
});

/** A child that "writes" the item into the fake keychain, as the product writer would. */
const writerChild =
  (f: Fake, calls: ChildCall[] = [], spy?: () => void): ChildRunner =>
  async (cmd, o) => {
    spy?.();
    calls.push({ cmd, ...o });
    f.present = true;
    return ok("seeded");
  };

// ---------------------------------------------------------------------------

describe("the security allowlist", () => {
  test("the banned list covers every subcommand the old design used", () => {
    expect([...BANNED_SUBCOMMANDS].sort()).toEqual(
      [
        "create-keychain",
        "delete-keychain",
        "list-keychains",
        "default-keychain",
        "unlock-keychain",
        "lock-keychain",
        "set-keychain-settings",
        "show-keychain-info",
        "set-generic-password-partition-list",
        "add-generic-password",
      ].sort()
    );
    expect([...ALLOWED_SUBCOMMANDS].sort()).toEqual([
      "delete-generic-password",
      "find-generic-password",
    ]);
    for (const b of BANNED_SUBCOMMANDS) expect(ALLOWED_SUBCOMMANDS.has(b)).toBe(false);
  });

  const bannedCalls: string[][] = [
    ["create-keychain", "-p", "x", "/tmp/k.keychain-db"],
    ["delete-keychain", "/tmp/k.keychain-db"],
    ["list-keychains"],
    ["list-keychains", "-d", "user", "-s", "/tmp/k.keychain-db"],
    ["default-keychain"],
    ["default-keychain", "-d", "user", "-s", "/tmp/k.keychain-db"],
    ["unlock-keychain", "-p", "x"],
    ["lock-keychain"],
    ["set-keychain-settings"],
    ["show-keychain-info"],
    [
      "set-generic-password-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      BENCH_SERVICE,
      "-a",
      BENCH_ACCOUNT,
    ],
    ["add-generic-password", "-s", BENCH_SERVICE, "-a", BENCH_ACCOUNT, "-w", "v", "-A"],
    ["add-generic-password", "-s", BENCH_SERVICE, "-a", BENCH_ACCOUNT, "-w", "v", "-U"],
    ["-i"],
    ["dump-keychain", "-a"],
    [],
  ];

  test.each(bannedCalls.map((a) => [a.join(" ") || "(empty)", a] as const))(
    "%s throws without spawning",
    async (_name, args) => {
      expect(() => assertSecurityCall(args)).toThrow(GuardRefusal);
      const s = setup();
      const f = fakeSecurity();
      const g = guardOf(f, s);
      await expect(callOf(g)([...args])).rejects.toBeInstanceOf(GuardRefusal);
      await expect(callOf(g)([...args], "cleanup")).rejects.toBeInstanceOf(GuardRefusal);
      expect(f.calls).toEqual([]);
    }
  );

  test("each banned subcommand throws before spawning, even in the allowed shape and as a cleanup call", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s);
    for (const sub of BANNED_SUBCOMMANDS) {
      // bare, and in the exact allowed shape on the fake item: the subcommand alone decides
      for (const args of [[sub], [sub, "-s", BENCH_SERVICE, "-a", BENCH_ACCOUNT]]) {
        expect(() => assertSecurityCall(args)).toThrow(/is not allowed/);
        await expect(callOf(g)([...args])).rejects.toThrow(/is not allowed/);
        await expect(callOf(g)([...args], "cleanup")).rejects.toThrow(/is not allowed/);
      }
    }
    expect(f.calls).toEqual([]);
  });

  test("only the exact shapes on the one fake item are accepted", () => {
    expect(() => assertSecurityCall(presenceArgs())).not.toThrow();
    expect(() => assertSecurityCall(readArgs())).not.toThrow();
    expect(() => assertSecurityCall(deleteArgs())).not.toThrow();
    expect(presenceArgs()).toEqual([
      "find-generic-password",
      "-s",
      "claudish-accounts",
      "-a",
      "openai-codex:aaaaaaaaaaaa",
    ]);
    expect(presenceArgs()).not.toContain("-w");
    expect(deleteArgs()).toEqual([
      "delete-generic-password",
      "-s",
      "claudish-accounts",
      "-a",
      "openai-codex:aaaaaaaaaaaa",
    ]);
    const S = BENCH_SERVICE;
    const A = BENCH_ACCOUNT;
    for (const bad of [
      ["find-generic-password", "-s", S, "-a", REAL_ACCOUNT, "-w"], // the user's real account
      ["delete-generic-password", "-s", S, "-a", REAL_ACCOUNT],
      ["find-generic-password", "-s", "claudish", "-a", "OPENAI_API_KEY", "-w"],
      ["delete-generic-password", "-s", "claudish", "-a", A],
      ["delete-generic-password", "-s", S], // no -a
      ["delete-generic-password", "-a", A], // no -s
      ["delete-generic-password", "-a", A, "-s", S], // swapped
      ["delete-generic-password", "-s", S, "-a", A, "-w"],
      ["delete-generic-password", "-s", S, "-a", A, "/tmp/other.keychain-db"],
      ["find-generic-password", "-s", S, "-a", A, "-w", "/tmp/other.keychain-db"],
      ["find-generic-password", "-s", S, "-a", A, "-g"],
      ["find-generic-password", "-s", S, "-a", A, "-w", "-w"],
      ["find-generic-password", "-s", S],
      ["find-generic-password", "-a", A, "-s", S],
      ["find-generic-password", "-s", S, "-a", "openai-codex:bbbbbbbbbbbb"],
    ])
      expect(() => assertSecurityCall(bad)).toThrow(GuardRefusal);
  });

  test("assertFakeItem accepts only claudish-accounts / openai-codex:aaaaaaaaaaaa", () => {
    expect(() => assertFakeItem("claudish-accounts", "openai-codex:aaaaaaaaaaaa")).not.toThrow();
    expect(() => assertFakeItem("claudish-accounts", REAL_ACCOUNT)).toThrow();
    expect(() => assertFakeItem("claudish-accounts", "openai-codex:bbbbbbbbbbbb")).toThrow();
    expect(() => assertFakeItem("claudish", "openai-codex:aaaaaaaaaaaa")).toThrow();
    expect(() => assertFakeItem("claudish", "OPENAI_API_KEY")).toThrow();
    expect(() => assertFakeItem("Claude Code-credentials", BENCH_ACCOUNT)).toThrow();
  });

  test("a child env that redirects the keychain file is refused", () => {
    expect(BANNED_CHILD_ENV).toEqual(["CLAUDISH_KEYCHAIN_FILE"]);
    expect(() => assertChildEnv({ CLAUDISH_KEYCHAIN_FILE: "/tmp/x.keychain-db" })).toThrow(
      GuardRefusal
    );
    expect(() => assertChildEnv({ CLAUDISH_KEYCHAIN_FILE: "" })).toThrow(GuardRefusal);
    expect(() => assertChildEnv({ CLAUDISH_DISABLE_KEYCHAIN: "0" })).not.toThrow();
  });

  test("redact masks a value after -w and leaves a bare -w alone", () => {
    expect(redact(["x", "-w", "secret", "y"])).toBe("x -w <value> y");
    expect(redact(readArgs())).toBe(readArgs().join(" "));
  });
});

describe("preflight", () => {
  test("an absent item (exit 44) proceeds after exactly one attribute-only read", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s);
    await g.acquire();
    expect(f.calls).toEqual([presenceArgs()]);
    expect(existsSync(s.lockFile)).toBe(true);
    await g.cleanup();
    expect(f.calls.length).toBe(1); // nothing seeded: no delete
    expect(existsSync(s.lockFile)).toBe(false);
  });

  test("a leftover item refuses, names --recover-keychain, and is NOT deleted", async () => {
    const s = setup();
    const f = fakeSecurity(undefined, true);
    const g = guardOf(f, s);
    const err = (await g.acquire().catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(err.message).toBe("a leftover bench item exists; run `--recover-keychain` to delete it");
    await g.cleanup();
    expect(f.calls).toEqual([presenceArgs()]);
    expect(f.present).toBe(true);
    expect(existsSync(s.lockFile)).toBe(false);
  });

  test("any other exit refuses and changes nothing", async () => {
    const s = setup();
    const f = fakeSecurity(() => exit(51));
    const g = guardOf(f, s);
    await expect(g.acquire()).rejects.toThrow(/preflight read .* failed \(exit 51\)/);
    await g.cleanup();
    expect(f.calls).toEqual([presenceArgs()]);
    expect(existsSync(s.lockFile)).toBe(false);
  });

  test("a preflight timeout trips the guard and nothing else runs", async () => {
    const s = setup();
    const f = fakeSecurity(() => hung());
    const children: ChildCall[] = [];
    const g = guardOf(f, s, { runChild: writerChild(f, children) });
    const err = (await g.acquire().catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(KeychainTimeoutError);
    expect(err.message).toBe(TRIPPED_MESSAGE);
    expect(g.isTripped()).toBe(true);
    await expect(g.seedViaProduct(item(s))).rejects.toBeInstanceOf(KeychainTimeoutError);
    await g.cleanup();
    expect(f.calls).toEqual([presenceArgs()]);
    expect(children).toEqual([]);
  });

  test("a leftover recovery file refuses before any security call", async () => {
    const s = setup();
    writeFileSync(s.recoveryFile, "{}");
    const f = fakeSecurity();
    const err = (await guardOf(f, s)
      .acquire()
      .catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(err.message).toContain(RECOVERY_COMMAND);
    expect(f.calls).toEqual([]);
    expect(existsSync(s.recoveryFile)).toBe(true);
    expect(existsSync(s.lockFile)).toBe(false);
  });
});

describe("seeding through the product writer", () => {
  test("happy path: preflight, product child, read, one cleanup delete", async () => {
    const s = setup();
    const f = fakeSecurity();
    let recoveryAtChild: unknown = null;
    const children: ChildCall[] = [];
    const g = guardOf(f, s, {
      runChild: writerChild(f, children, () => {
        recoveryAtChild = JSON.parse(readFileSync(s.recoveryFile, "utf8"));
      }),
      childScript: "/x/seed.ts",
      lock: { pid: 4321 },
    });
    await g.acquire();
    await g.seedViaProduct(item(s));
    expect(await g.readItem()).toBe(VALUE);
    await g.cleanup();
    expect(f.calls).toEqual([presenceArgs(), readArgs(), deleteArgs()]);
    expect(f.present).toBe(false);
    // the recovery record existed before the writer started, with exactly these fields
    expect(Object.keys(recoveryAtChild as object).sort()).toEqual(
      ["account", "pid", "service", "startedAt"].sort()
    );
    expect(recoveryAtChild).toMatchObject({
      service: "claudish-accounts",
      account: "openai-codex:aaaaaaaaaaaa",
      pid: 4321,
    });
    expect(existsSync(s.recoveryFile)).toBe(false);
    expect(existsSync(s.lockFile)).toBe(false);
    expect(children[0]?.cmd).toEqual([
      "bun",
      "/x/seed.ts",
      "--keychain-seed-child",
      join(s.base, "keychain-seed-spec.json"),
    ]);
    expect(existsSync(join(s.base, "keychain-seed-spec.json"))).toBe(false);
  });

  test("the recovery file is 0600", async () => {
    const s = setup();
    const f = fakeSecurity();
    let mode = 0;
    const g = guardOf(f, s, {
      runChild: writerChild(f, [], () => {
        mode = statSync(s.recoveryFile).mode;
      }),
    });
    await g.acquire();
    await g.seedViaProduct(item(s));
    expect(mode & 0o777).toBe(0o600);
    await g.cleanup();
  });

  test("the child env is a whitelist with no keychain redirect, and the 15 s bound", async () => {
    const s = setup();
    const f = fakeSecurity();
    const children: ChildCall[] = [];
    const g = guardOf(f, s, { runChild: writerChild(f, children) });
    await g.acquire();
    await g.seedViaProduct(item(s));
    const c = children[0];
    for (const name of BANNED_CHILD_ENV) expect(name in (c?.env ?? {})).toBe(false);
    expect(Object.keys(c?.env ?? {}).sort()).toEqual(
      [
        "CLAUDISH_ACCOUNTS_DIR",
        "CLAUDISH_CONFIG",
        "CLAUDISH_DISABLE_KEYCHAIN",
        "HOME",
        "LANG",
        "PATH",
        "TMPDIR",
      ].sort()
    );
    // Review round 6 (A1): the seed child never reads the real ~/.claudish/config.json.
    expect(c?.env.CLAUDISH_CONFIG).toBe(s.configPath);
    expect(c?.env.CLAUDISH_DISABLE_KEYCHAIN).toBe("0");
    expect(c?.env.HOME).toBe(join(s.base, "row-home"));
    expect(c?.timeoutMs).toBe(15_000);
    await g.cleanup();
  });

  test("real tokens, another account id, bad JSON or no preflight are refused before any child", async () => {
    const s = setup();
    const f = fakeSecurity();
    const children: ChildCall[] = [];
    const g = guardOf(f, s, { runChild: writerChild(f, children) });
    await expect(g.seedViaProduct(item(s))).rejects.toThrow(/preflight/);
    await g.acquire();
    await expect(
      g.seedViaProduct(
        item(s, {
          recordJson: JSON.stringify({ accessToken: "sk-real", refreshToken: "refresh-A" }),
        })
      )
    ).rejects.toThrow(/fake ones/);
    await expect(g.seedViaProduct(item(s, { id: "dc53ea1b2616" }))).rejects.toBeInstanceOf(
      GuardRefusal
    );
    await expect(g.seedViaProduct(item(s, { id: "bbbbbbbbbbbb" }))).rejects.toBeInstanceOf(
      GuardRefusal
    );
    await expect(g.seedViaProduct(item(s, { recordJson: "not json" }))).rejects.toThrow(/not JSON/);
    expect(children).toEqual([]);
    expect(existsSync(s.recoveryFile)).toBe(false);
    await g.cleanup();
    expect(f.calls).toEqual([presenceArgs()]); // never seeded: no delete
  });

  test("a failing child (exit 3) is a GuardRefusal with its stderr, and cleanup still deletes once", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s, {
      runChild: async () => ({ code: 3, stdout: "", stderr: "read-back differs", timedOut: false }),
    });
    await g.acquire();
    await expect(g.seedViaProduct(item(s))).rejects.toThrow(/exit 3.*read-back differs/);
    await g.cleanup();
    expect(f.calls).toEqual([presenceArgs(), deleteArgs()]); // exit 44 on delete: fine
    expect(existsSync(s.recoveryFile)).toBe(false);
  });

  test("the call log records the child and masks nothing it should not show", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s, { runChild: writerChild(f) });
    await g.acquire();
    await g.seedViaProduct(item(s));
    await g.readItem();
    await g.cleanup();
    const log = g.callLog();
    expect(log.map((c) => c.cmd)).toEqual([
      `security ${presenceArgs().join(" ")}`,
      "bun seed.ts --keychain-seed-child (KeychainTokenStore.write into the default keychain)",
      `security ${readArgs().join(" ")}`,
      `security ${deleteArgs().join(" ")}`,
    ]);
    expect(JSON.stringify(log)).not.toContain("refresh-A");
  });
});

describe("first timeout stops everything", () => {
  test("a timed-out read trips: later calls throw without spawning, listeners fire, one cleanup delete runs", async () => {
    const s = setup();
    let armed = false;
    const f = fakeSecurity((args) => (armed && args.includes("-w") ? hung() : undefined));
    const g = guardOf(f, s, { runChild: writerChild(f) });
    const killed: string[] = [];
    g.onTrip(() => killed.push("p1"));
    await g.acquire();
    await g.seedViaProduct(item(s));
    armed = true;
    const err = (await g.readItem().catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(KeychainTimeoutError);
    expect(err.message).toBe(TRIPPED_MESSAGE);
    expect(g.isTripped()).toBe(true);
    expect(killed).toEqual(["p1"]);
    g.onTrip(() => killed.push("p2")); // registered after the trip: runs at once
    expect(killed).toEqual(["p1", "p2"]);
    const n = f.calls.length;
    await expect(g.readItem()).rejects.toBeInstanceOf(KeychainTimeoutError);
    await expect(callOf(g)(presenceArgs())).rejects.toBeInstanceOf(KeychainTimeoutError);
    await expect(callOf(g)(deleteArgs())).rejects.toBeInstanceOf(KeychainTimeoutError);
    expect(() => g.assertRunnable()).toThrow(TRIPPED_MESSAGE);
    expect(f.calls.length).toBe(n); // nothing spawned
    await g.cleanup();
    expect(f.calls.slice(n)).toEqual([deleteArgs()]); // exactly the one cleanup delete
    expect(f.present).toBe(false);
    // a second cleanup-kind delete is refused
    await expect(callOf(g)(deleteArgs(), "cleanup")).rejects.toThrow(/only one cleanup delete/);
    expect(f.calls.slice(n)).toEqual([deleteArgs()]);
    expect(killed).toEqual(["p1", "p2"]); // listeners fire once
  });

  test("a timed-out product writer trips the guard; cleanup deletes once", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s, {
      runChild: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
    });
    await g.acquire();
    await expect(g.seedViaProduct(item(s))).rejects.toBeInstanceOf(KeychainTimeoutError);
    expect(g.isTripped()).toBe(true);
    expect(g.callLog()[1]).toMatchObject({ timedOut: true });
    await expect(g.readItem()).rejects.toBeInstanceOf(KeychainTimeoutError);
    await g.cleanup();
    expect(f.calls).toEqual([presenceArgs(), deleteArgs()]);
  });

  test("a timed-out cleanup delete is a CleanupError that keeps the recovery file and is not retried", async () => {
    const s = setup();
    const f = fakeSecurity((args) => (args[0] === "delete-generic-password" ? hung() : undefined));
    const g = guardOf(f, s, { runChild: writerChild(f) });
    await g.acquire();
    await g.seedViaProduct(item(s));
    const err = (await g.cleanup().catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(CleanupError);
    expect(err.message).toContain(RECOVERY_COMMAND);
    expect(err.message).toContain(MANUAL_DELETE_COMMAND);
    expect(f.calls.filter((c) => c[0] === "delete-generic-password").length).toBe(1);
    expect(existsSync(s.recoveryFile)).toBe(true);
    expect(existsSync(s.lockFile)).toBe(false);
    await g.cleanup().catch(() => {}); // idempotent: same promise, no second delete
    expect(f.calls.filter((c) => c[0] === "delete-generic-password").length).toBe(1);
  });
});

describe("cleanup", () => {
  test("is idempotent: one delete however often it is called", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s, { runChild: writerChild(f) });
    await g.acquire();
    await g.seedViaProduct(item(s));
    await Promise.all([g.cleanup(), g.cleanup()]);
    await g.cleanup();
    expect(f.calls.filter((c) => c[0] === "delete-generic-password")).toEqual([deleteArgs()]);
  });

  test("exit 44 on delete means already gone: success, recovery file removed", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s); // the default child seeds nothing in the fake keychain
    await g.acquire();
    await g.seedViaProduct(item(s));
    await g.cleanup();
    expect(f.calls.at(-1)).toEqual(deleteArgs());
    expect(existsSync(s.recoveryFile)).toBe(false);
  });

  test("a failing delete keeps the recovery file and names the recovery command", async () => {
    const s = setup();
    const f = fakeSecurity((args) => (args[0] === "delete-generic-password" ? exit(1) : undefined));
    const g = guardOf(f, s, { runChild: writerChild(f) });
    await g.acquire();
    await g.seedViaProduct(item(s));
    await expect(g.cleanup()).rejects.toThrow(/exit 1.*--recover-keychain/);
    expect(existsSync(s.recoveryFile)).toBe(true);
  });

  test("after cleanup the guard is closed: no further work call runs", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s, { runChild: writerChild(f) });
    await g.acquire();
    await g.cleanup();
    await expect(g.readItem()).rejects.toThrow(/closed/);
    expect(() => g.assertRunnable()).toThrow(/closed/);
    expect(f.calls).toEqual([presenceArgs()]);
  });
});

describe("overall deadline", () => {
  test("a thrown error in the body still cleans up", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s, { runChild: writerChild(f) });
    await expect(
      g.runWithDeadline(async () => {
        await g.acquire();
        await g.seedViaProduct(item(s));
        throw new Error("row exploded");
      })
    ).rejects.toThrow("row exploded");
    expect(f.present).toBe(false);
    expect(existsSync(s.recoveryFile)).toBe(false);
    expect(existsSync(s.lockFile)).toBe(false);
  });

  test("a body that never ends is cut off, cleaned up, and its later calls are refused", async () => {
    const s = setup();
    const f = fakeSecurity();
    const g = guardOf(f, s, { runChild: writerChild(f) });
    const t0 = Date.now();
    const err = await g
      .runWithDeadline(async () => {
        await g.acquire();
        await g.seedViaProduct(item(s));
        await new Promise(() => {}); // never resolves
      }, 100)
      .catch((e) => e as Error);
    expect(err).toBeInstanceOf(DeadlineError);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(f.present).toBe(false);
    expect(f.calls).toEqual([presenceArgs(), deleteArgs()]);
    await expect(g.readItem()).rejects.toThrow(/closed/);
  });
});

describe("signals and exit", () => {
  test("SIGINT cleans up (one delete), then exits 130", async () => {
    const s = setup();
    const f = fakeSecurity();
    const registry = new Map<string, () => void>();
    const exits: number[] = [];
    const g = guardOf(f, s, {
      runChild: writerChild(f),
      proc: {
        on: (ev: string, fn: () => void) => {
          registry.set(ev, fn);
          return process;
        },
        off: (ev: string) => {
          registry.delete(ev);
          return process;
        },
      },
      exit: (code: number) => exits.push(code),
    });
    await g.acquire();
    await g.seedViaProduct(item(s));
    expect([...registry.keys()].sort()).toEqual(["SIGINT", "SIGTERM", "exit"]);
    registry.get("SIGINT")?.();
    await Bun.sleep(50);
    expect(exits).toEqual([130]);
    expect(f.calls.at(-1)).toEqual(deleteArgs());
    expect(existsSync(s.recoveryFile)).toBe(false);
    expect(registry.size).toBe(0);
  });

  test("the exit handler deletes synchronously, once, with the sync runner", async () => {
    const s = setup();
    const f = fakeSecurity();
    const syncCalls: string[][] = [];
    const registry = new Map<string, () => void>();
    const g = guardOf(f, s, {
      runChild: writerChild(f),
      proc: {
        on: (ev: string, fn: () => void) => {
          registry.set(ev, fn);
          return process;
        },
        off: () => process,
      },
      runSync: (args: string[]): SecResult => {
        syncCalls.push(args);
        return ok();
      },
    });
    await g.acquire();
    await g.seedViaProduct(item(s));
    registry.get("exit")?.();
    registry.get("exit")?.();
    expect(syncCalls).toEqual([deleteArgs()]);
    expect(existsSync(s.recoveryFile)).toBe(false);
    expect(existsSync(s.lockFile)).toBe(false);
    await g.cleanup(); // the async path does not delete a second time
    expect(f.calls.filter((c) => c[0] === "delete-generic-password")).toEqual([]);
  });

  test("the exit handler does nothing when nothing was seeded", async () => {
    const s = setup();
    const f = fakeSecurity();
    const syncCalls: string[][] = [];
    const registry = new Map<string, () => void>();
    const g = guardOf(f, s, {
      proc: {
        on: (ev: string, fn: () => void) => {
          registry.set(ev, fn);
          return process;
        },
        off: () => process,
      },
      runSync: (args: string[]): SecResult => {
        syncCalls.push(args);
        return ok();
      },
    });
    await g.acquire();
    registry.get("exit")?.();
    expect(syncCalls).toEqual([]);
  });
});

describe("--recover-keychain", () => {
  test("deletes the one item once and removes the recovery file", async () => {
    const s = setup();
    writeFileSync(
      s.recoveryFile,
      JSON.stringify({ service: BENCH_SERVICE, account: BENCH_ACCOUNT, pid: 1, startedAt: "x" })
    );
    const f = fakeSecurity(undefined, true);
    const msg = await recoverKeychain(f.run, {
      recoveryFile: s.recoveryFile,
      lockFile: s.lockFile,
    });
    expect(msg).toContain("deleted the bench item");
    expect(f.calls).toEqual([deleteArgs()]);
    expect(existsSync(s.recoveryFile)).toBe(false);
    expect(existsSync(s.lockFile)).toBe(false);
  });

  test("without a recovery file it still deletes a leftover item (the preflight's advice)", async () => {
    const s = setup();
    const f = fakeSecurity(undefined, true);
    await recoverKeychain(f.run, { recoveryFile: s.recoveryFile, lockFile: s.lockFile });
    expect(f.calls).toEqual([deleteArgs()]);
    expect(f.present).toBe(false);
  });

  test("exit 44 is already gone", async () => {
    const s = setup();
    const f = fakeSecurity();
    expect(
      await recoverKeychain(f.run, { recoveryFile: s.recoveryFile, lockFile: s.lockFile })
    ).toContain("already gone");
  });

  test("a record naming another item is refused without a call", async () => {
    const s = setup();
    writeFileSync(
      s.recoveryFile,
      JSON.stringify({ service: BENCH_SERVICE, account: REAL_ACCOUNT, pid: 1, startedAt: "x" })
    );
    const f = fakeSecurity();
    await expect(
      recoverKeychain(f.run, { recoveryFile: s.recoveryFile, lockFile: s.lockFile })
    ).rejects.toBeInstanceOf(GuardRefusal);
    expect(f.calls).toEqual([]);
    expect(existsSync(s.recoveryFile)).toBe(true);
  });

  test("a timeout is a CleanupError, the file stays", async () => {
    const s = setup();
    writeFileSync(s.recoveryFile, "{}");
    const f = fakeSecurity(() => hung());
    await expect(
      recoverKeychain(f.run, { recoveryFile: s.recoveryFile, lockFile: s.lockFile })
    ).rejects.toBeInstanceOf(CleanupError);
    expect(f.calls).toEqual([deleteArgs()]);
    expect(existsSync(s.recoveryFile)).toBe(true);
  });

  test("fails fast while a live run holds the lock", async () => {
    const s = setup();
    takeLock(s.lockFile, { pid: 4242, isAlive: () => true });
    const f = fakeSecurity();
    await expect(
      recoverKeychain(f.run, {
        recoveryFile: s.recoveryFile,
        lockFile: s.lockFile,
        lock: { isAlive: () => true },
      })
    ).rejects.toBeInstanceOf(LockHeldError);
    expect(f.calls).toEqual([]);
  });
});

describe("lock", () => {
  test("contention fails fast and the second run touches nothing", async () => {
    const s = setup();
    const f1 = fakeSecurity();
    const g1 = guardOf(f1, s, { lock: { pid: 1111, isAlive: () => true } });
    await g1.acquire();
    const f2 = fakeSecurity();
    const t0 = Date.now();
    const err = await guardOf(f2, s, { lock: { pid: 2222, isAlive: () => true } })
      .acquire()
      .catch((e) => e as Error);
    expect(err).toBeInstanceOf(LockHeldError);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(f2.calls).toEqual([]);
    expect(existsSync(s.lockFile)).toBe(true);
    await g1.cleanup();
  });

  test("a lock whose owner is dead is taken over", () => {
    const s = setup();
    takeLock(s.lockFile, { pid: 1111, isAlive: () => true });
    const release = takeLock(s.lockFile, { pid: 2222, isAlive: (p) => p !== 1111 });
    expect(JSON.parse(readFileSync(s.lockFile, "utf8")).pid).toBe(2222);
    release();
    expect(existsSync(s.lockFile)).toBe(false);
  });

  test("a lock older than the stale timeout is taken over even if its pid is alive", () => {
    const s = setup();
    let clock = 1_000_000;
    takeLock(s.lockFile, { pid: 1111, now: () => clock, isAlive: () => true });
    clock += 5 * 60_000 - 1;
    expect(() =>
      takeLock(s.lockFile, { pid: 2222, now: () => clock, isAlive: () => true })
    ).toThrow(LockHeldError);
    clock += 2;
    const release = takeLock(s.lockFile, { pid: 2222, now: () => clock, isAlive: () => true });
    expect(JSON.parse(readFileSync(s.lockFile, "utf8")).pid).toBe(2222);
    release();
  });

  test("release only removes a lock the caller owns", () => {
    const s = setup();
    const release = takeLock(s.lockFile, { pid: 1111, isAlive: () => true });
    writeFileSync(s.lockFile, JSON.stringify({ pid: 3333, at: Date.now() }));
    release();
    expect(existsSync(s.lockFile)).toBe(true);
  });
});

describe("runners (no security involved)", () => {
  test("a hung real process is killed at the timeout", async () => {
    const run = makeSecurityRunner("/bin/sleep");
    const t0 = Date.now();
    const r = await run(["30"], 200);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("a quick real process returns its output and code", async () => {
    const r = await makeSecurityRunner("/bin/echo")(["hello"], 5000);
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(r.stdout.trim()).toBe("hello");
  });

  test("the real child runner kills a hung process at the timeout", async () => {
    const t0 = Date.now();
    const r = await makeChildRunner()(["/bin/sleep", "30"], {
      env: {},
      cwd: tmpdir(),
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("reading values", () => {
  test("readItem returns plain output unchanged (one trailing newline removed)", async () => {
    const s = setup();
    const f = fakeSecurity((args) => (args.includes("-w") ? ok('{"generation":2}\n') : undefined));
    const g = guardOf(f, s);
    await g.acquire();
    expect(await g.readItem()).toBe('{"generation":2}');
    expect(f.calls.at(-1)).toEqual(readArgs());
    await g.cleanup();
  });

  test("readItem decodes hex-encoded JSON output and returns null on exit 44", async () => {
    const hex = Buffer.from(JSON.stringify({ generation: 2, note: "line1\nline2" })).toString(
      "hex"
    );
    const s = setup();
    let absent = false;
    const f = fakeSecurity((args) =>
      args.includes("-w") ? (absent ? exit(44) : ok(`${hex}\n`)) : undefined
    );
    const g = guardOf(f, s);
    await g.acquire();
    expect(JSON.parse((await g.readItem()) as string)).toEqual({
      generation: 2,
      note: "line1\nline2",
    });
    absent = true;
    expect(await g.readItem()).toBeNull();
    await g.cleanup();
  });

  test("decodeSecurityOutput leaves hex that is not JSON, odd-length hex and plain text alone", () => {
    expect(decodeSecurityOutput(`${Buffer.from("not json").toString("hex")}\n`)).toBe(
      Buffer.from("not json").toString("hex")
    );
    expect(decodeSecurityOutput("abc")).toBe("abc");
    expect(decodeSecurityOutput("deadbeef")).toBe("deadbeef");
    expect(decodeSecurityOutput("")).toBe("");
  });

  // Review round 6 (C3): 60 raw characters could hold the head of a real token.
  test("describeUnparsable names the kind, length and a sha256 prefix, and no character of the value", () => {
    const hex = "7b".repeat(100);
    const d = describeUnparsable(hex);
    expect(d).toContain("hex value, length 200");
    expect(d).toMatch(/sha256 [0-9a-f]{12}/);
    expect(d).not.toContain("7b7b");
    const head = "eyJhbGciOiJSUzI1NiJ9";
    const t = describeUnparsable(`${head}.notjson ${"q".repeat(80)}`);
    expect(t).toContain("text value");
    expect(t).not.toContain(head.slice(0, 6));
    expect(t).not.toContain("qqqq");
    expect(describeUnparsable("x".repeat(500)).length).toBeLessThan(80);
  });
});

describe("the seed child refuses before touching any keychain (no security call)", () => {
  // The spec path does not exist, so even a broken refusal stops at the spec read, before the
  // product writer is imported.
  const seedScript = join(import.meta.dir, "seed.ts");
  const runChild = (env: Record<string, string>) =>
    Bun.spawnSync(["bun", seedScript, "--keychain-seed-child", "/nonexistent-spec.json"], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });

  test.each([
    ["a keychain file redirect", { [BANNED_CHILD_ENV[0] as string]: "/tmp/x.keychain-db" }],
    ["the keychain disabled", { CLAUDISH_DISABLE_KEYCHAIN: "1" }],
  ] as const)("exit 2 with %s", (_name, env) => {
    const p = runChild({ ...env });
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("refusing");
  });
});

// ---------------------------------------------------------------------------
// Review round 6

/** A fake process tree: `kill` stops it; `confirmGone` answers per `dies`. Records events. */
function fakeProducer(
  name: string,
  events: string[],
  opts: { pid?: number; dies?: boolean } = {}
): Producer & { killed: boolean } {
  const p = {
    name,
    pid: opts.pid ?? 99001,
    killed: false,
    kill() {
      if (!p.killed) events.push(`kill ${name}`);
      p.killed = true;
    },
    async confirmGone() {
      p.kill();
      if (opts.dies === false) return false;
      events.push(`gone ${name}`);
      return true;
    },
    confirmGoneSync() {
      p.kill();
      if (opts.dies === false) return false;
      events.push(`gone ${name}`);
      return true;
    },
  };
  return p;
}

/** A fake `security` that also logs each call into `events`. */
function loggedSecurity(events: string[]): Fake {
  const f = fakeSecurity();
  const inner = f.run;
  f.run = async (args, t) => {
    events.push(`security ${args[0]}`);
    return inner(args, t);
  };
  return f;
}

describe("A1: the V2e config may name only the fake account", () => {
  const cfg = (accounts: Record<string, string[]>) =>
    JSON.stringify({
      subscriptionAccounts: Object.fromEntries(
        Object.entries(accounts).map(([p, ids]) => [p, { accounts: ids.map((id) => ({ id })) }])
      ),
    });

  test("only openai-codex:aaaaaaaaaaaa passes", () => {
    expect(() => assertFakeOnlyConfig(cfg({ "openai-codex": ["aaaaaaaaaaaa"] }))).not.toThrow();
  });

  test.each([
    ["a real account beside the fake", { "openai-codex": ["aaaaaaaaaaaa", "dc53ea1b2616"] }],
    ["a real account instead", { "openai-codex": ["dc53ea1b2616"] }],
    ["another provider's account", { "openai-codex": ["aaaaaaaaaaaa"], claude: ["bbbbbbbbbbbb"] }],
    ["no account", {}],
  ] as const)("refuses %s", (_name, accounts) => {
    expect(() => assertFakeOnlyConfig(cfg(accounts as Record<string, string[]>))).toThrow(
      GuardRefusal
    );
  });

  test("seeding refuses a config with a real account before any child or keychain write", async () => {
    const s = setup();
    writeFileSync(s.configPath, cfg({ "openai-codex": ["aaaaaaaaaaaa", "dc53ea1b2616"] }));
    const f = fakeSecurity();
    const children: ChildCall[] = [];
    const g = guardOf(f, s, { runChild: writerChild(f, children) });
    await g.acquire();
    await expect(g.seedViaProduct(item(s))).rejects.toThrow(/only openai-codex:aaaaaaaaaaaa/);
    expect(children).toEqual([]);
    expect(existsSync(s.recoveryFile)).toBe(false);
    await g.cleanup();
  });
});

describe("A2: every producer is killed and awaited before the single cleanup delete", () => {
  // GPT's reproduction: the seed child is paused before it writes; cleanup (SIGINT) runs; then
  // the child is allowed to finish. Before the fix the item existed after cleanup with no
  // recovery file and no lock.
  test("a paused seed child is killed before the delete and never writes afterwards", async () => {
    const s = setup();
    const events: string[] = [];
    const f = loggedSecurity(events);
    const registry = new Map<string, () => void>();
    const exits: number[] = [];
    let release: () => void = () => {};
    const paused = new Promise<void>((r) => {
      release = r;
    });
    const child = fakeProducer("seed child", events);
    const g = guardOf(f, s, {
      proc: {
        on: (ev: string, fn: () => void) => {
          registry.set(ev, fn);
          return process;
        },
        off: (ev: string) => {
          registry.delete(ev);
          return process;
        },
      },
      exit: (code: number) => exits.push(code),
      runChild: (async (_cmd, o) => {
        o.onSpawn?.(child);
        await paused; // the child has started but has not written yet
        if (child.killed) return { code: null, stdout: "", stderr: "killed", timedOut: false };
        f.present = true; // the product writer stores the item
        events.push("child wrote the item");
        return ok("seeded");
      }) as ChildRunner,
    });
    await g.acquire();
    const seeding = g.seedViaProduct(item(s)).catch((e: Error) => e);
    await Bun.sleep(10);
    registry.get("SIGINT")?.();
    await Bun.sleep(30);
    release(); // the child is allowed to finish
    await seeding;
    await Bun.sleep(10);
    const itemExistsAfterCleanup = f.present;
    expect(itemExistsAfterCleanup).toBe(false);
    expect(events).toEqual([
      "security find-generic-password",
      "kill seed child",
      "gone seed child",
      "security delete-generic-password",
    ]);
    expect(exits).toEqual([130]);
    expect(existsSync(s.recoveryFile)).toBe(false);
    expect(existsSync(s.lockFile)).toBe(false);
  });

  test("on the deadline a live serve is killed and confirmed gone before the delete; it cannot write after", async () => {
    const s = setup();
    const events: string[] = [];
    const f = loggedSecurity(events);
    const g = guardOf(f, s, { runChild: writerChild(f) });
    const serve = fakeProducer("serve", events);
    const err = await g
      .runWithDeadline(async () => {
        await g.acquire();
        await g.seedViaProduct(item(s));
        g.registerProducer(serve);
        // The serve rotates and writes the item 150 ms later, unless it was killed.
        setTimeout(() => {
          if (!serve.killed) {
            f.present = true;
            events.push("serve wrote the item");
          }
        }, 150);
        await new Promise(() => {});
      }, 50)
      .catch((e) => e as Error);
    expect(err).toBeInstanceOf(DeadlineError);
    await Bun.sleep(250);
    expect(f.present).toBe(false);
    expect(events.indexOf("gone serve")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("gone serve")).toBeLessThan(
      events.indexOf("security delete-generic-password")
    );
    expect(events).not.toContain("serve wrote the item");
    expect(existsSync(s.recoveryFile)).toBe(false);
  });

  test("a producer not confirmed gone keeps the recovery file and the lock, after the one delete", async () => {
    const s = setup();
    const events: string[] = [];
    const f = loggedSecurity(events);
    const g = guardOf(f, s, { runChild: writerChild(f) });
    await g.acquire();
    await g.seedViaProduct(item(s));
    g.registerProducer(fakeProducer("serve", events, { dies: false }));
    await expect(g.cleanup()).rejects.toThrow(/not confirmed gone/);
    expect(events.filter((e) => e === "security delete-generic-password").length).toBe(1);
    expect(existsSync(s.recoveryFile)).toBe(true);
    expect(existsSync(s.lockFile)).toBe(true);
  });

  test("a producer that appears after the cleanup delete is killed at once and re-arms the recovery file", async () => {
    const s = setup();
    const events: string[] = [];
    const f = loggedSecurity(events);
    const g = guardOf(f, s, { runChild: writerChild(f) });
    await g.acquire();
    await g.seedViaProduct(item(s));
    await g.cleanup();
    expect(existsSync(s.recoveryFile)).toBe(false);
    const late = fakeProducer("serve", events);
    g.registerProducer(late);
    expect(late.killed).toBe(true);
    expect(existsSync(s.recoveryFile)).toBe(true);
  });

  test("the exit handler kills and confirms every producer before its delete", async () => {
    const s = setup();
    const events: string[] = [];
    const f = loggedSecurity(events);
    const registry = new Map<string, () => void>();
    const g = guardOf(f, s, {
      runChild: writerChild(f),
      proc: {
        on: (ev: string, fn: () => void) => {
          registry.set(ev, fn);
          return process;
        },
        off: () => process,
      },
      runSync: (args: string[]): SecResult => {
        events.push(`security ${args[0]} (sync)`);
        return ok();
      },
    });
    await g.acquire();
    await g.seedViaProduct(item(s));
    g.registerProducer(fakeProducer("serve", events));
    registry.get("exit")?.();
    expect(events.slice(-3)).toEqual([
      "kill serve",
      "gone serve",
      "security delete-generic-password (sync)",
    ]);
  });
});

describe("A3: the security watch over every producer tree", () => {
  test("parseEtime reads ps elapsed times", () => {
    expect(parseEtime("00:05")).toBe(5_000);
    expect(parseEtime("01:02:03")).toBe(3_723_000);
    expect(parseEtime("2-00:00:01")).toBe(172_801_000);
    expect(parseEtime("x")).toBeNaN();
  });

  test("parsePsRows keeps commands with spaces", () => {
    const rows = parsePsRows(
      "  501   1  00:07 /usr/bin/security\n 600 501 01:00 /Applications/A B.app/x\n"
    );
    expect(rows).toEqual([
      { pid: 501, ppid: 1, elapsedMs: 7_000, command: "/usr/bin/security" },
      { pid: 600, ppid: 501, elapsedMs: 60_000, command: "/Applications/A B.app/x" },
    ]);
  });

  test("longSecurityCall finds a long security call anywhere under a root, and only there", () => {
    const rows = [
      { pid: 10, ppid: 1, elapsedMs: 9_000, command: "node" },
      { pid: 11, ppid: 10, elapsedMs: 9_000, command: "node" },
      { pid: 12, ppid: 11, elapsedMs: 6_000, command: "/usr/bin/security" },
      { pid: 20, ppid: 1, elapsedMs: 60_000, command: "/usr/bin/security" },
    ];
    expect(longSecurityCall(rows, [10], 5_000)).toMatchObject({ pid: 12, root: 10 });
    expect(longSecurityCall(rows, [10], 7_000)).toBeNull();
    expect(longSecurityCall(rows, [99], 1)).toBeNull();
  });

  test("the threshold is below the product's own 10 s kill, or it could never fire", () => {
    expect(SERVE_SECURITY_LIMIT_MS).toBeLessThan(10_000);
  });

  test("a long security call under a serve trips the guard: every producer killed, listeners fire, no further call", async () => {
    const s = setup();
    const events: string[] = [];
    const f = loggedSecurity(events);
    let rows: Array<{ pid: number; ppid: number; elapsedMs: number; command: string }> = [];
    const g = guardOf(f, s, {
      runChild: writerChild(f),
      watch: { list: () => rows, intervalMs: 10, limitMs: 5_000 },
    });
    await g.acquire();
    await g.seedViaProduct(item(s));
    const a = fakeProducer("serve", events, { pid: 501 });
    const b = fakeProducer("serve", events, { pid: 502 });
    g.registerProducer(a);
    g.registerProducer(b);
    let listener = 0;
    g.onTrip(() => listener++);
    rows = [{ pid: 777, ppid: 501, elapsedMs: 1_000, command: "/usr/bin/security" }];
    await Bun.sleep(40);
    expect(g.isTripped()).toBe(false);
    rows = [{ pid: 777, ppid: 501, elapsedMs: 6_000, command: "/usr/bin/security" }];
    await Bun.sleep(40);
    expect(g.isTripped()).toBe(true);
    expect(a.killed && b.killed).toBe(true);
    expect(listener).toBe(1);
    expect(g.tripMessage()).toContain("security process (pid 777)");
    const callsBefore = f.calls.length;
    await expect(g.readItem()).rejects.toBeInstanceOf(KeychainTimeoutError);
    expect(f.calls.length).toBe(callsBefore);
    await g.cleanup();
    expect(f.calls.at(-1)).toEqual(deleteArgs());
  });
});
