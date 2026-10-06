import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_IDENTITY_VARS,
  LINUX_ENV_STRING_LIMIT,
  OWNER_START36,
  PaneEnvTooLargeError,
  PaneRootError,
  SHELL_SHIM,
  buildClaudishPaneArgv,
  buildPaneEnv,
  createLaunchDirs,
  ensureSockRoot,
  isValidPaneId,
  launcherScript,
  mintPaneId,
  paneCommand,
  sockPathFor,
  sockRootFor,
  versionAtLeast,
} from "./pane-launch.js";
import { WATCHER_ARGV0, WATCHER_SCRIPT, isLaunchDirPath, watcherArgv } from "./process-identity.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pl-"));
  dirs.push(d);
  return d;
}

describe("launcher and shim", () => {
  test("the launcher cds to the realpath cwd, then execs claudish; no watcher, no PATH line", () => {
    const s = launcherScript(
      "/tmp/a b/it's",
      { command: "/opt/bun", prefixArgs: ["run", "/x/index.ts"] },
      ["-i", "--model", "fake-answer"]
    );
    expect(s).toBe(
      `cd -- '/tmp/a b/it'\\''s' || exit 97\nexec '/opt/bun' 'run' '/x/index.ts' '-i' '--model' 'fake-answer'\n`
    );
    expect(s).not.toContain("PATH");
    expect(s).not.toContain("watcher");
  });

  test("the shim drops -l and execs /bin/sh, so no login profile runs", () => {
    expect(SHELL_SHIM).toBe('#!/bin/sh\n[ "$1" = -l ] && shift\nexec /bin/sh "$@"\n');
  });

  test("the -e value never names claude (magmux's controller would attach)", () => {
    expect(paneCommand("/tmp/claudish-mux-501/launch-AbC123")).toBe(
      ". '/tmp/claudish-mux-501/launch-AbC123/pane-launch.sh'"
    );
    expect(() => paneCommand("/tmp/claude ")).toThrow();
  });

  test("argv is -i --model X -y --quiet --session-id U --add-dir D, then the caller flags", () => {
    expect(buildClaudishPaneArgv("m", "u", "/d", ["--agent", "x"])).toEqual([
      "-i",
      "--model",
      "m",
      "-y",
      "--quiet",
      "--session-id",
      "u",
      "--add-dir",
      "/d",
      "--agent",
      "x",
    ]);
  });
});

describe("pane environment", () => {
  const parentEnv = {
    PATH: "/usr/bin",
    HOME: "/h",
    SHELL: "/bin/zsh",
    OPENAI_API_KEY: "k",
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    MAGMUX_SOCK: "/tmp/outer.sock",
    MAGMUX_SOCK_DIR: "/tmp/outer",
    TMUX: "/tmp/tmux-501/default,1,0",
    TERM_PROGRAM: "iTerm.app",
    ITERM_SESSION_ID: "w0",
    VSCODE_PID: "1",
    COLUMNS: "80",
    LINES: "24",
    TERM: "xterm",
    SHLVL: "2",
    PWD: "/elsewhere",
    CLAUDISH_LAUNCHER_PID: "10",
    CLAUDISH_LAUNCHER_PPID: "9",
    CLAUDE_CODE_SESSION_ID: "host-session",
  };

  test("strips child, magmux, terminal-identity and host-identity keys; sets geometry and markers", () => {
    const { magmuxEnv } = buildPaneEnv({
      parentEnv,
      slotEnv: { CLAUDISH_TOKEN_FILE: "/t.json" },
      cwd: "/real/cwd",
      ctlDir: "/root/launch-AAAAAA",
    });
    for (const k of [
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "MAGMUX_SOCK",
      "MAGMUX_SOCK_DIR",
      "TMUX",
      "TERM_PROGRAM",
      "ITERM_SESSION_ID",
      "VSCODE_PID",
      ...HOST_IDENTITY_VARS,
    ])
      expect(magmuxEnv[k]).toBeUndefined();
    expect(magmuxEnv.COLUMNS).toBe("160");
    expect(magmuxEnv.LINES).toBe("50");
    expect(magmuxEnv.CLAUDISH_PANE_CHILD).toBe("1");
    expect(magmuxEnv.CLAUDISH_PANE_CWD).toBe("/real/cwd");
    expect(magmuxEnv.CLAUDISH_TOKEN_FILE).toBe("/t.json");
    expect(magmuxEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(magmuxEnv.SHELL).toBe("/root/launch-AAAAAA/sh-shim");
  });

  test("the snapshot keeps the REAL SHELL and excludes shell-managed keys and itself", () => {
    const { magmuxEnv } = buildPaneEnv({
      parentEnv,
      slotEnv: {},
      cwd: "/c",
      ctlDir: "/r/launch-AAAAAA",
    });
    const snap = JSON.parse(magmuxEnv.CLAUDISH_PANE_ENV as string);
    expect(snap.SHELL).toBe("/bin/zsh");
    expect(snap.OPENAI_API_KEY).toBe("k");
    for (const k of [
      "COLUMNS",
      "LINES",
      "TERM",
      "SHLVL",
      "PWD",
      "MAGMUX_SOCK",
      "CLAUDISH_PANE_ENV",
      "TMUX",
    ])
      expect(snap[k]).toBeUndefined();
    expect(snap.CLAUDISH_PANE_CHILD).toBe("1");
  });

  test("a caller's own CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is kept", () => {
    const { magmuxEnv } = buildPaneEnv({
      parentEnv: { ...parentEnv, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" },
      slotEnv: {},
      cwd: "/c",
      ctlDir: "/r/launch-AAAAAA",
    });
    expect(magmuxEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("0");
  });

  test("Linux refuses a snapshot over 131,000 bytes; macOS has no per-string limit", () => {
    const big = { ...parentEnv, BIG: "x".repeat(LINUX_ENV_STRING_LIMIT) };
    expect(() =>
      buildPaneEnv({
        parentEnv: big,
        slotEnv: {},
        cwd: "/c",
        ctlDir: "/r/launch-AAAAAA",
        platform: "linux",
      })
    ).toThrow(PaneEnvTooLargeError);
    expect(() =>
      buildPaneEnv({
        parentEnv: big,
        slotEnv: {},
        cwd: "/c",
        ctlDir: "/r/launch-AAAAAA",
        platform: "linux",
      })
    ).toThrow(/over Linux's 131072-byte limit per variable/);
    expect(() =>
      buildPaneEnv({
        parentEnv: big,
        slotEnv: {},
        cwd: "/c",
        ctlDir: "/r/launch-AAAAAA",
        platform: "darwin",
      })
    ).not.toThrow();
  });
});

describe("ids, socket paths and the socket root", () => {
  test("minted ids are valid, ≤ 40 chars, embed the owner pid and start", () => {
    const id = mintPaneId("t", "01-slot/with spaces");
    expect(isValidPaneId(id)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.startsWith(`c${process.pid}-${OWNER_START36}-t`)).toBe(true);
    expect(mintPaneId("s", "x")).not.toBe(mintPaneId("s", "x"));
  });

  test("ids: all digits and bad characters are refused (magmux would ignore them)", () => {
    expect(isValidPaneId("12345")).toBe(false);
    expect(isValidPaneId("a/b")).toBe(false);
    expect(isValidPaneId("x".repeat(65))).toBe(false);
    expect(isValidPaneId("c1-a-t01-abcdef")).toBe(true);
  });

  test("a socket path of 100 bytes or more is refused", () => {
    expect(sockPathFor("/tmp/r", "c1-x")).toBe("/tmp/r/magmux-c1-x.sock");
    expect(() => sockPathFor(`/tmp/${"d".repeat(80)}`, "c1-abcdefghij")).toThrow(PaneRootError);
  });

  test("CLAUDISH_PANE_ROOT overrides the default root", () => {
    expect(sockRootFor({ CLAUDISH_PANE_ROOT: "/tmp/cpt-1" })).toBe("/tmp/cpt-1");
    expect(sockRootFor({})).toMatch(/^\/tmp\/claudish-mux-\d+$/);
  });

  test("a trailing-slash or relative root is resolved once, so the launch-dir check still matches", () => {
    expect(sockRootFor({ CLAUDISH_PANE_ROOT: "/tmp/cpt-1/" })).toBe("/tmp/cpt-1");
    expect(sockRootFor({ CLAUDISH_PANE_ROOT: "rel/root" })).toBe(join(process.cwd(), "rel/root"));
    const base = tmp();
    const root = ensureSockRoot(`${join(base, "r")}/`);
    expect(root).toBe(join(base, "r"));
    const dirs = createLaunchDirs(root);
    expect(isLaunchDirPath(root, dirs.ctlDir)).toBe(true);
  });

  test("ensureSockRoot creates 0700 dirs and refuses a symlink or a group/world-readable dir", () => {
    const base = tmp();
    const root = join(base, "root");
    expect(ensureSockRoot(root)).toBe(root);
    const link = join(base, "link");
    symlinkSync(root, link);
    expect(() => ensureSockRoot(link)).toThrow(/not a real directory/);
    const open = join(base, "open");
    mkdirSync(open);
    chmodSync(open, 0o755);
    expect(() => ensureSockRoot(open)).toThrow(/must be 0700/);
  });
});

describe("watcher argv and version gate", () => {
  test("values reach the watcher only as positional parameters, under argv0 claudish-pane-watcher", () => {
    const a = watcherArgv({
      paneId: "c1-x-t01-abcdef",
      sessionUuid: "u'; rm -rf /",
      ctlDir: "/r/launch-AAAAAA",
      sockPath: "/r/magmux-c1-x-t01-abcdef.sock",
      recordPath: "/r/panes/c1-x-t01-abcdef.json",
      turnDir: "/r/launch-BBBBBB",
      sockRoot: "/r",
    });
    expect(a[0]).toBe("-c");
    expect(a[1]).toBe(WATCHER_SCRIPT);
    expect(a[2]).toBe(WATCHER_ARGV0);
    expect(a.slice(3)).toEqual([
      "c1-x-t01-abcdef",
      "u'; rm -rf /",
      "/r/launch-AAAAAA",
      "/r/magmux-c1-x-t01-abcdef.sock",
      "/r/panes/c1-x-t01-abcdef.json",
      "/r/launch-BBBBBB",
      "/r",
    ]);
    expect(WATCHER_SCRIPT).not.toContain("u'; rm -rf /");
  });

  test("versionAtLeast", () => {
    expect(versionAtLeast("0.14.0", "0.14.0")).toBe(true);
    expect(versionAtLeast("0.15.2", "0.14.0")).toBe(true);
    expect(versionAtLeast("0.13.9", "0.14.0")).toBe(false);
    expect(versionAtLeast("1.0.0", "0.14.0")).toBe(true);
  });
});
