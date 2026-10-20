/**
 * The pane child's bootstrap: the server's environment snapshot is applied exactly,
 * the cwd is entered, and a configuration that is not an interactive REPL is refused
 * with exit 64. The pure functions are tested on passed objects; subprocess tests
 * prove the import-time side effect and the `index.ts` wiring, each with its own
 * environment built from an allowlist (never `process.env`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  NESTED_SESSION_REFUSAL,
  PANE_CHILD_REFUSED_EXIT,
  PANE_LAUNCH_VARS,
  applyPaneEnvSnapshot,
  enterPaneCwd,
  inMcpSession,
  isPaneChild,
  nestedLaunchRefusal,
  paneChildRefusal,
} from "./child-env.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "claudish-child-env-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("MCP session and pane-child predicates", () => {
  test("T-U-1: only the exact session flag counts", () => {
    expect(inMcpSession({ CLAUDISH_PANE_CHILD: "1" })).toBe(true);
    expect(inMcpSession({ CLAUDISH_PANE_CHILD: "true" })).toBe(false);
    expect(inMcpSession({})).toBe(false);
  });

  test("T-U-2: a session flag alone is not a pane child", () => {
    expect(isPaneChild({ CLAUDISH_PANE_CHILD: "1" })).toBe(false);
  });

  test("T-U-3: a pane child needs both the exact flag and a non-empty cwd", () => {
    expect(isPaneChild({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "/w" })).toBe(true);
    expect(isPaneChild({ CLAUDISH_PANE_CWD: "/w" })).toBe(false);
    expect(isPaneChild({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "" })).toBe(false);
    expect(isPaneChild({ CLAUDISH_PANE_CHILD: "true", CLAUDISH_PANE_CWD: "/w" })).toBe(false);
  });

  test("T-U-4: launch variables exclude the inherited session flag", () => {
    expect([...PANE_LAUNCH_VARS]).toEqual(["CLAUDISH_PANE_ENV", "CLAUDISH_PANE_CWD"]);
  });

  test("T-U-5: only a session descendant without a pane cwd is refused", () => {
    expect(nestedLaunchRefusal({})).toBeNull();
    expect(nestedLaunchRefusal({ CLAUDISH_PANE_CHILD: "1" })).toBe(NESTED_SESSION_REFUSAL);
    expect(nestedLaunchRefusal({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "/w" })).toBeNull();
    expect(nestedLaunchRefusal({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "" })).toBe(
      NESTED_SESSION_REFUSAL
    );
    expect(nestedLaunchRefusal({ CLAUDISH_PANE_CHILD: "true" })).toBeNull();
  });

  test("T-U-6: the nested refusal text is exact", () => {
    expect(PANE_CHILD_REFUSED_EXIT).toBe(64);
    expect(NESTED_SESSION_REFUSAL).toBe(
      "already inside a session started by the claudish MCP server; one level of nesting is the limit"
    );
  });
});

describe("applyPaneEnvSnapshot", () => {
  test("sets snapshot keys, removes extras, keeps shell-managed keys, deletes the snapshot", () => {
    const env: Record<string, string | undefined> = {
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_PANE_CWD: "/w",
      OPENAI_API_KEY: "from-profile",
      PROFILE_ONLY: "x",
      SHELL: "/tmp/launch-abc/sh-shim",
      TERM: "xterm-256color",
      COLUMNS: "160",
      LINES: "50",
      SHLVL: "2",
      PWD: "/",
      OLDPWD: "/x",
      _: "/usr/bin/env",
      MAGMUX_SOCK: "/tmp/m.sock",
      CLAUDISH_PANE_ENV: JSON.stringify({
        CLAUDISH_PANE_CHILD: "1",
        CLAUDISH_PANE_CWD: "/w",
        OPENAI_API_KEY: "from-server",
        SHELL: "/bin/zsh",
        CLAUDE_CONFIG_DIR: "/cfg",
      }),
    };
    expect(applyPaneEnvSnapshot(env)).toEqual({ ok: true });
    expect(env).toEqual({
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_PANE_CWD: "/w",
      OPENAI_API_KEY: "from-server",
      SHELL: "/bin/zsh",
      CLAUDE_CONFIG_DIR: "/cfg",
      TERM: "xterm-256color",
      COLUMNS: "160",
      LINES: "50",
      SHLVL: "2",
      PWD: "/",
      OLDPWD: "/x",
      _: "/usr/bin/env",
      MAGMUX_SOCK: "/tmp/m.sock",
    });
  });

  test("a snapshot that lacks the markers does not remove them", () => {
    const env: Record<string, string | undefined> = {
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_PANE_CWD: "/w",
      CLAUDISH_PANE_ENV: JSON.stringify({ A: "1" }),
    };
    applyPaneEnvSnapshot(env);
    expect(env).toEqual({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "/w", A: "1" });
  });

  test("no snapshot leaves the environment alone", () => {
    const env = { CLAUDISH_PANE_CHILD: "1", KEEP: "me" };
    expect(applyPaneEnvSnapshot(env)).toEqual({ ok: true });
    expect(env).toEqual({ CLAUDISH_PANE_CHILD: "1", KEEP: "me" });
  });

  for (const [name, raw] of [
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["null", "null"],
    ["a non-string value", JSON.stringify({ A: 1 })],
  ] as const) {
    test(`refuses ${name} without changing anything`, () => {
      const env = { CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_ENV: raw, KEEP: "me" };
      expect(applyPaneEnvSnapshot(env)).toEqual({ ok: false, reason: "bad env snapshot" });
      expect(env.KEEP).toBe("me");
    });
  }

  test("snapshot application preserves shell-managed keys and replaces other keys", () => {
    const shellKeys = ["COLUMNS", "LINES", "TERM", "SHLVL", "PWD", "OLDPWD", "_", "MAGMUX_X"];
    const replacedKeys = ["SHELL", "PATH", "HOME", "CLAUDE_CONFIG_DIR"];
    const env: Record<string, string | undefined> = {
      ...Object.fromEntries([...shellKeys, ...replacedKeys].map((key) => [key, "shell"])),
      CLAUDISH_PANE_ENV: JSON.stringify(
        Object.fromEntries(replacedKeys.map((key) => [key, "snapshot"]))
      ),
    };
    expect(applyPaneEnvSnapshot(env)).toEqual({ ok: true });
    for (const key of shellKeys) expect(env[key]).toBe("shell");
    for (const key of replacedKeys) expect(env[key]).toBe("snapshot");
  });
});

describe("enterPaneCwd", () => {
  const ops = (here: string, chdirs: string[], fail = false) => ({
    cwd: () => here,
    realpath: (p: string) => p,
    chdir: (p: string) => {
      if (fail) throw new Error("ENOENT");
      chdirs.push(p);
    },
  });

  test("changes directory when the realpath differs, and says so", () => {
    const chdirs: string[] = [];
    const result = enterPaneCwd({ CLAUDISH_PANE_CWD: "/work" }, ops("/", chdirs));
    expect(chdirs).toEqual(["/work"]);
    expect(result).toEqual({ ok: true, note: "[pane-child] cwd / -> /work" });
  });

  test("does nothing when already there or when no cwd is named", () => {
    const chdirs: string[] = [];
    expect(enterPaneCwd({ CLAUDISH_PANE_CWD: "/work" }, ops("/work", chdirs))).toEqual({
      ok: true,
    });
    expect(enterPaneCwd({}, ops("/", chdirs))).toEqual({ ok: true });
    expect(chdirs).toEqual([]);
  });

  test("an unreachable cwd is a refusal", () => {
    const result = enterPaneCwd({ CLAUDISH_PANE_CWD: "/gone" }, ops("/", [], true));
    expect(result).toEqual({ ok: false, reason: "cannot enter /gone: ENOENT" });
  });
});

describe("paneChildRefusal", () => {
  test("an interactive REPL passes", () => {
    expect(paneChildRefusal({ interactive: true })).toBeNull();
  });

  test("each non-REPL shape names its reason", () => {
    expect(paneChildRefusal({ interactive: true, team: ["a", "b"] })).toContain("--team");
    expect(paneChildRefusal({ interactive: false, _hasPrintFlag: true })).toContain("-p/--print");
    expect(paneChildRefusal({ interactive: false, stdin: true })).toContain("--stdin");
    expect(paneChildRefusal({ interactive: false, _hasPositionalPrompt: true })).toContain(
      "positional prompt"
    );
    expect(paneChildRefusal({ interactive: false })).toBe("the child is not interactive");
  });
});

// ── Subprocesses ─────────────────────────────────────────────────────────────

const cliDir = resolve(import.meta.dir, "../..");
const childEnvPath = resolve(import.meta.dir, "child-env.ts");
// A regression must never find a real Claude Code, even if the old code passes the gate.
const claudeShim = join(scratch, "claude-exits-73");
writeFileSync(claudeShim, "#!/bin/sh\nexit 73\n", { mode: 0o755 });

/** An allowlisted environment with a scratch HOME — nothing from the real one. */
function hermeticEnv(extra: Record<string, string>): Record<string, string> {
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    CLAUDE_PATH: claudeShim,
    CLAUDISH_PANE_ROOT: join(scratch, "panes"),
    TMPDIR: tmpdir(),
    HOME: home,
    ZDOTDIR: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(scratch, "xdg"),
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
    ...extra,
  };
}

describe("the import-time bootstrap", () => {
  test("applies the snapshot and enters the cwd before anything else runs", () => {
    const work = join(scratch, "work dir_1");
    mkdirSync(work, { recursive: true });
    const script = `await import(${JSON.stringify(childEnvPath)});
process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env }));`;
    const env = hermeticEnv({
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_PANE_CWD: work,
      INHERITED_ONLY: "drop me",
    });
    env.CLAUDISH_PANE_ENV = JSON.stringify({
      ...env,
      FROM_SERVER: "yes",
      INHERITED_ONLY: undefined,
    });
    const r = Bun.spawnSync([process.execPath, "-e", script], { cwd: scratch, env });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { cwd: string; env: Record<string, string> };
    expect(out.cwd).toBe(work);
    expect(out.env.FROM_SERVER).toBe("yes");
    expect(out.env.INHERITED_ONLY).toBeUndefined();
    expect(out.env.CLAUDISH_PANE_ENV).toBeUndefined();
    expect(out.env.CLAUDISH_PANE_CHILD).toBe("1");
  });

  test("a bad snapshot exits 64 with the refusal line", () => {
    const r = Bun.spawnSync(
      [process.execPath, "-e", `await import(${JSON.stringify(childEnvPath)});`],
      {
        cwd: scratch,
        env: hermeticEnv({
          CLAUDISH_PANE_CHILD: "1",
          CLAUDISH_PANE_CWD: scratch,
          CLAUDISH_PANE_ENV: "{bad",
        }),
      }
    );
    expect(r.exitCode).toBe(PANE_CHILD_REFUSED_EXIT);
    expect(r.stderr.toString()).toBe("claudish: pane child refused: bad env snapshot\n");
  });

  test("without the marker the snapshot is ignored", () => {
    const script = `await import(${JSON.stringify(childEnvPath)});
process.stdout.write(process.env.CLAUDISH_PANE_ENV ?? "gone");`;
    const r = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: scratch,
      env: hermeticEnv({ CLAUDISH_PANE_ENV: "{bad" }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("{bad");
  });
});

describe("the CLI entry asserts an interactive REPL after parseArgs", () => {
  for (const [name, argv, reason] of [
    ["a positional prompt", ["-i", "--model", "claude-sonnet-4-5", "hello"], "positional prompt"],
    ["a team run", ["-i", "--team", "a,b"], "--team"],
    ["print mode", ["--model", "claude-sonnet-4-5", "-p", "hi"], "-p/--print"],
  ] as const) {
    test(`T-CLI-7: ${name} exits 64 with the pane-child refusal`, () => {
      const r = Bun.spawnSync([process.execPath, "run", "src/index.ts", ...argv], {
        cwd: cliDir,
        env: hermeticEnv({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: scratch }),
        timeout: 60_000,
      });
      expect(r.stderr.toString()).toContain("claudish: pane child refused: ");
      expect(r.stderr.toString()).toContain(reason);
      expect(r.stderr.toString()).not.toContain("nested session refused");
      expect(r.exitCode).toBe(PANE_CHILD_REFUSED_EXIT);
    }, 60_000);
  }
});

describe("nested CLI launches", () => {
  for (const [id, name, argv] of [
    ["T-CLI-1", "print mode", ["--model", "claude-sonnet-4-5", "-p", "hi"]],
    ["T-CLI-2", "stdin mode", ["--stdin", "--model", "claude-sonnet-4-5"]],
    ["T-CLI-3", "interactive mode", ["-i", "--model", "claude-sonnet-4-5"]],
    ["T-CLI-4", "team run before argument validation", ["team", "run"]],
  ] as const) {
    test(`${id}: ${name} exits 64 with the exact nested refusal line`, () => {
      const r = Bun.spawnSync([process.execPath, "run", "src/index.ts", ...argv], {
        cwd: cliDir,
        env: hermeticEnv({ CLAUDISH_PANE_CHILD: "1" }),
        stdin: "ignore",
        timeout: 60_000,
      });
      expect(r.exitCode).toBe(PANE_CHILD_REFUSED_EXIT);
      expect(r.stderr.toString().split("\n")).toContain(
        "claudish: nested session refused: already inside a session started by the claudish MCP server; one level of nesting is the limit"
      );
      expect(r.stderr.toString()).toEndWith("\n");
      expect(r.stderr.toString()).not.toContain("pane child refused");
    }, 60_000);
  }

  test("T-CLI-5: --version still succeeds inside an MCP session", () => {
    const r = Bun.spawnSync([process.execPath, "run", "src/index.ts", "--version"], {
      cwd: cliDir,
      env: hermeticEnv({ CLAUDISH_PANE_CHILD: "1" }),
      timeout: 60_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toMatch(/\b\d+\.\d+\.\d+\b/);
    expect(r.stderr.toString()).not.toContain("refused");
  }, 60_000);

  test("T-CLI-6: team status is allowed with a path under its cwd", () => {
    const statusPath = mkdtempSync(join(cliDir, ".nested-team-status-"));
    try {
      const r = Bun.spawnSync(
        [process.execPath, "run", "src/index.ts", "team", "status", "--path", statusPath],
        {
          cwd: cliDir,
          env: hermeticEnv({ CLAUDISH_PANE_CHILD: "1" }),
          timeout: 60_000,
        }
      );
      expect(r.stderr.toString()).not.toContain("nested session refused");
    } finally {
      rmSync(statusPath, { recursive: true, force: true });
    }
  }, 60_000);

  test("T-CLI-8: importing child-env with only the session flag keeps cwd and the flag", () => {
    const script = `await import(${JSON.stringify(childEnvPath)});
process.stdout.write(JSON.stringify({ cwd: process.cwd(), flag: process.env.CLAUDISH_PANE_CHILD }));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: scratch,
      env: hermeticEnv({ CLAUDISH_PANE_CHILD: "1" }),
      timeout: 60_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual({ cwd: scratch, flag: "1" });
  }, 60_000);
});
