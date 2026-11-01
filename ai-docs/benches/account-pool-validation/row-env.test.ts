import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type EnvInput,
  KNOWN_EGRESS,
  type RowRoot,
  assertNotRealHome,
  buildEnv,
  makeRowRoot,
  sha256File,
} from "./row-env.ts";

const roots = new Set<string>();

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function refuseRealHomePath(path: string): void {
  // Independent safety guard: do not trust the function under test for cleanup safety.
  if (inside(resolve(userInfo().homedir), resolve(path))) {
    throw new Error("Refuse a filesystem operation inside the actual home");
  }
}

function canonicalTempBase(path: string): string {
  refuseRealHomePath(path);
  const canonical = realpathSync(path);
  refuseRealHomePath(canonical);
  return canonical;
}

function scratchRoot(): string {
  const base = canonicalTempBase(tmpdir());
  const root = mkdtempSync(join(base, "pool-row-env-test-"));
  roots.add(root);
  return root;
}

function adoptRowRoot(path: string): string {
  refuseRealHomePath(path);
  const bases = [canonicalTempBase(tmpdir()), canonicalTempBase("/tmp")];
  function safe(candidate: string): boolean {
    return (
      bases.some((base) => candidate !== base && inside(base, candidate)) &&
      bases.every((base) => candidate !== base)
    );
  }
  const resolved = resolve(path);
  if (!safe(resolved)) throw new Error("Refuse to inspect or remove a non-temporary row root");
  const canonical = realpathSync(resolved);
  refuseRealHomePath(canonical);
  if (!safe(canonical)) throw new Error("Refuse a row root escaping the temporary bases");
  roots.add(canonical);
  return canonical;
}

function newRowTree(): { tree: RowRoot; canonical: string } {
  const tree = makeRowRoot();
  const canonical = adoptRowRoot(tree.root);
  return { tree, canonical };
}

function input(): EnvInput {
  // Keep environment tests independent of makeRowRoot's correctness.
  const root = scratchRoot();
  const tree: RowRoot = {
    root,
    home: join(root, "home"),
    claudeDir: join(root, "claude-config"),
    cwd: join(root, "work"),
    accountsDir: join(root, "home", ".claudish", "accounts"),
  };
  // REQ-8.2: only these directories must exist; the binary creates accountsDir.
  for (const path of [tree.home, tree.claudeDir, tree.cwd]) mkdirSync(path);
  return {
    tree,
    accountsLog: join(root, "accounts.jsonl"),
    fakeOrigin: "http://127.0.0.1:41001",
    canaryOrigin: "http://127.0.0.1:41002",
    sinkPort: 41003,
    claudePath: join(root, "not-an-executable"),
  };
}

function withEnv(changes: Record<string, string | undefined>, body: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(changes)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function matchesTarget(target: string): boolean {
  const before = KNOWN_EGRESS.lastIndex;
  try {
    KNOWN_EGRESS.lastIndex = 0;
    return KNOWN_EGRESS.test(target);
  } finally {
    KNOWN_EGRESS.lastIndex = before;
  }
}

afterEach(() => {
  for (const root of roots) {
    // Paths were registered only after independent safety checks.
    refuseRealHomePath(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("real-home refusal and row directories", () => {
  test.each(["home", "trailing separator", "child", "deep child"] as const)(
    "TEST-49 REQ-8.1 refuses the actual %s when HOME points somewhere else",
    (which) => {
      const scratch = scratchRoot();
      const home = userInfo().homedir;
      const target =
        which === "home"
          ? home
          : which === "trailing separator"
            ? home + sep
            : which === "child"
              ? join(home, ".claudish")
              : join(home, ".claudish", "accounts", "not-opened.json");

      withEnv({ HOME: scratch }, () => {
        // Only pass these strings to the guard; do not inspect/create home paths.
        expect(() => assertNotRealHome(target)).toThrow();
      });
    }
  );

  test("refuses an existing directory under the actual home that is not under .claudish", () => {
    // The repository checkout is an existing directory; it sits under the home in the
    // normal layout. Only the string is passed to the guard, nothing under it is touched.
    const home = realpathSync(userInfo().homedir);
    const repo = realpathSync(resolve(import.meta.dir, "../../.."));
    if (!inside(home, repo) || inside(realpathSync(tmpdir()), repo)) return;
    expect(() => assertNotRealHome(repo)).toThrow(/real home/);
  });

  test("TEST-49 REQ-8.1 permits a fresh temporary directory despite spoofed HOME", () => {
    const scratch = scratchRoot();

    withEnv({ HOME: scratch }, () => {
      expect(() => assertNotRealHome(scratch)).not.toThrow();
    });
  });

  test("TEST-50 REQ-8.2 creates required directories and returns a contained accounts path", () => {
    const { tree, canonical } = newRowTree();

    expect(isAbsolute(tree.root)).toBe(true);
    expect(tree.root).toBe(canonical);
    expect(statSync(canonical).isDirectory()).toBe(true);
    expect(tree.accountsDir).toBe(join(tree.home, ".claudish", "accounts"));
    const accountsDir = resolve(tree.accountsDir);
    expect(accountsDir !== canonical && inside(canonical, accountsDir)).toBe(true);
    refuseRealHomePath(accountsDir);
    // Do not stat/realpath accountsDir: REQ-8.2 permits it to be absent.
    for (const field of ["home", "claudeDir", "cwd"] as const) {
      const path = resolve(tree[field]);
      // Assertions precede filesystem access to any returned child path.
      expect(path !== canonical && inside(canonical, path)).toBe(true);
      refuseRealHomePath(path);
      const realChild = realpathSync(path);
      refuseRealHomePath(realChild);
      expect(realChild !== canonical && inside(canonical, realChild)).toBe(true);
      expect(statSync(realChild).isDirectory()).toBe(true);
    }
  });

  test("TEST-51 REQ-8.2 returns a different existing canonical tree on every call", () => {
    const first = newRowTree();
    const second = newRowTree();

    expect(first.tree.root).toBe(first.canonical);
    expect(second.tree.root).toBe(second.canonical);
    expect(first.canonical).not.toBe(second.canonical);
    expect(statSync(first.canonical).isDirectory()).toBe(true);
    expect(statSync(second.canonical).isDirectory()).toBe(true);
  });
});

describe("whitelisted row environment", () => {
  test("TEST-52 REQ-8.3 excludes ambient credentials, tokens, and caller fault flags", () => {
    const options = input();
    const disallowed = {
      ANTHROPIC_API_KEY: "fake-anthropic-test-value",
      ANTHROPIC_AUTH_TOKEN: "fake-anthropic-auth-value",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:41004",
      OPENAI_API_KEY: "fake-openai-test-value",
      OPENAI_BASE_URL: "http://127.0.0.1:41005",
      CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-oauth-test-value",
      CLAUDISH_ACCOUNTS_FAULT: "ambient-test-fault",
      CLAUDISH_CALLER_ONLY: "ambient-claudish-value",
      BENCH_CALLER_ONLY: "ambient-unrelated-value",
    };

    withEnv(
      {
        ...disallowed,
        HOME: join(options.tree.root, "caller-home"),
        CLAUDE_CONFIG_DIR: join(options.tree.root, "caller-config"),
      },
      () => {
        const env = buildEnv(options);

        for (const name of Object.keys(disallowed)) {
          expect(Object.prototype.hasOwnProperty.call(env, name)).toBe(false);
        }
        expect(env.HOME).toBe(options.tree.home);
        expect(env.CLAUDE_CONFIG_DIR).toBe(options.tree.claudeDir);
      }
    );
  });

  test("TEST-53 REQ-8.4 pins the canary credential, disabled stores, and loopback bindings", () => {
    const options = input();

    withEnv(
      {
        OPENAI_CODEX_API_KEY: "ambient-codex-fake-value",
        CLAUDISH_DISABLE_KEYCHAIN: "0",
        CLAUDISH_DISABLE_OP: "0",
        CLAUDISH_ACCOUNT_STORE: "keychain",
        CLAUDISH_ACCOUNTS_LOG: join(options.tree.root, "caller-log.jsonl"),
        CLAUDISH_TEST_UPSTREAM: "default=http://127.0.0.1:41009",
      },
      () => {
        const env = buildEnv(options);

        expect(env).toMatchObject({
          HOME: options.tree.home,
          CLAUDE_CONFIG_DIR: options.tree.claudeDir,
          OPENAI_CODEX_API_KEY: "sk-canary-must-never-be-used",
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_ACCOUNT_STORE: "file",
          CLAUDISH_ACCOUNTS_LOG: options.accountsLog,
        });
        expect(typeof env.CLAUDISH_TEST_UPSTREAM).toBe("string");

        // The contracts document host=origin entries, not one exact separator.
        const bindings = Array.from(
          env.CLAUDISH_TEST_UPSTREAM!.matchAll(
            /(?:^|[,\s;])([^=,\s;]+)=(http:\/\/127\.0\.0\.1:\d+)(?=$|[,\s;])/g
          ),
          (match) => [match[1]!, match[2]!] as const
        );
        expect(bindings.filter(([host]) => host === "api.openai.com")).toEqual([
          ["api.openai.com", options.canaryOrigin],
        ]);
        expect(bindings.filter(([host]) => host === "default")).toEqual([
          ["default", options.fakeOrigin],
        ]);
      }
    );
  });

  test("TEST-54 REQ-8.3 REQ-8.5 admits fault flags and other entries only through explicit extra", () => {
    const options = input();
    options.extra = {
      CLAUDISH_ACCOUNTS_FAULT: "explicit-test-fault",
      BENCH_EXPLICIT: "row-specific-value",
      ANTHROPIC_API_KEY: "explicit-fake-test-value",
    };

    withEnv({ CLAUDISH_ACCOUNTS_FAULT: "ambient-test-fault" }, () => {
      const env = buildEnv(options);

      expect(env).toMatchObject(options.extra!);
      expect(env.CLAUDISH_ACCOUNTS_FAULT).toBe("explicit-test-fault");
    });
  });

  test("TEST-55 REQ-8.5 removes generated and extra keys with drop taking precedence", () => {
    const options = input();
    options.extra = {
      BENCH_EXPLICIT: "drop-me",
      CLAUDISH_ACCOUNTS_FAULT: "drop-this-fault",
      OPENAI_CODEX_API_KEY: "explicit-fake-override-to-drop",
    };
    options.drop = [
      "OPENAI_CODEX_API_KEY",
      "CLAUDISH_DISABLE_KEYCHAIN",
      "BENCH_EXPLICIT",
      "CLAUDISH_ACCOUNTS_FAULT",
      "NOT_PRESENT",
    ];

    const env = buildEnv(options);

    for (const key of options.drop) {
      expect(Object.prototype.hasOwnProperty.call(env, key)).toBe(false);
    }
    expect(env.HOME).toBe(options.tree.home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(options.tree.claudeDir);
    expect(env.CLAUDISH_DISABLE_OP).toBe("1");
    expect(env.CLAUDISH_ACCOUNT_STORE).toBe("file");
  });
});

describe("known egress and file hashes", () => {
  test("TEST-56 REQ-8.6 matches exactly the documented startup CONNECT target", () => {
    expect(matchesTarget("CONNECT us-central1-claudish-6da10.cloudfunctions.net:443")).toBe(true);
  });

  test.each([
    "CONNECT api.openai.com:443",
    "CONNECT us-central1-claudish-6da10.cloudfunctions.net:80",
    "CONNECT us-central1-claudish-6da10.cloudfunctions.net:4430",
    "CONNECT us-central1-claudish-6da10.cloudfunctions.net.evil.invalid:443",
    "CONNECT evil.us-central1-claudish-6da10.cloudfunctions.net:443",
    "CONNECT us-central1-claudish-6da10XcloudfunctionsYnet:443",
    "CONNECT us-central1-claudish-6da11.cloudfunctions.net:443",
    "CONNECT 127.0.0.1:443",
    "CONNECT example.invalid:443",
  ])("TEST-57 REQ-8.6 rejects other target %s without connecting", (target) => {
    expect(matchesTarget(target)).toBe(false);
  });

  const binary = Buffer.from([0, 255, 0, 10, 195, 169]);
  test.each([
    {
      name: "empty file",
      contents: Buffer.alloc(0),
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      name: "abc known answer",
      contents: Buffer.from("abc"),
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
    {
      name: "binary file",
      contents: binary,
      digest: createHash("sha256").update(binary).digest("hex"),
    },
  ])("TEST-58 REQ-8.7 returns the lowercase sha256 of $name", ({ contents, digest }) => {
    const path = join(scratchRoot(), "hash-input.bin");
    writeFileSync(path, contents);

    const actual = sha256File(path);

    expect(actual).toBe(digest);
    expect(actual).toMatch(/^[0-9a-f]{64}$/);
  });
});
