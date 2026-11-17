/**
 * The weekly macOS run and its launchd installer, against a temporary home: no real clone, no
 * real launchctl, no notification. Every command is recorded by an injected runner.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, install, plistPathFor, plistXml, uninstall } from "./install-weekly-macos-tests.ts";
import {
  type Command,
  REPO_URL,
  logPathFor,
  notificationArgv,
  runWeekly,
  weeklyCommands,
  weeklyPaths,
} from "./weekly-macos-tests.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "weekly-macos-home-"));
  homes.push(home);
  return home;
}

describe("weeklyPaths and logPathFor", () => {
  test("the clone, its cache and the logs live under the given home's Library", () => {
    expect(weeklyPaths("/h")).toEqual({
      cacheDir: "/h/Library/Caches/claudish-weekly-tests",
      repoDir: "/h/Library/Caches/claudish-weekly-tests/repo",
      logDir: "/h/Library/Logs/claudish-weekly-tests",
    });
  });

  test("the log is named by the UTC date of the run", () => {
    // 23:30 on the 15th in Los Angeles is the 16th in UTC.
    const now = new Date("2026-11-15T23:30:00-08:00");
    expect(logPathFor("/logs", now)).toBe("/logs/2026-11-16.log");
  });
});

describe("weeklyCommands", () => {
  const paths = weeklyPaths("/h");

  test("a first run clones origin's main into the dedicated directory", () => {
    const cmds = weeklyCommands({ paths, repoUrl: REPO_URL, cloned: false, bun: "/bin/bun" });
    expect(cmds[0]).toEqual({
      name: "clone",
      cwd: paths.cacheDir,
      argv: ["git", "clone", "--branch", "main", REPO_URL, paths.repoDir],
    });
  });

  test("a later run fetches and hard-resets inside the clone only, then runs test:macos --full", () => {
    const cmds = weeklyCommands({ paths, repoUrl: REPO_URL, cloned: true, bun: "/bin/bun" });
    expect(cmds.map((c) => c.argv)).toEqual([
      ["git", "fetch", "origin", "main"],
      ["git", "reset", "--hard", "origin/main"],
      ["git", "clean", "-ffd"],
      ["/bin/bun", "--no-env-file", "install", "--frozen-lockfile"],
      ["/bin/bun", "--no-env-file", "run", "test:macos", "--full"],
    ]);
    for (const c of cmds) expect(c.cwd).toBe(paths.repoDir);
    // git never gets a path that could point it at another checkout
    for (const c of cmds.filter((c) => c.argv[0] === "git")) expect(c.argv).not.toContain("-C");
  });
});

describe("notificationArgv", () => {
  test("passes the log path as an argument, never inside the AppleScript text", () => {
    const argv = notificationArgv('/h/Library/Logs/x "quoted".log');
    expect(argv[0]).toBe("osascript");
    const script = argv.filter((_, i) => argv[i - 1] === "-e").join("\n");
    expect(script).not.toContain("/h/Library");
    expect(argv.some((a) => a.includes('/h/Library/Logs/x "quoted".log'))).toBe(true);
  });
});

describe("runWeekly", () => {
  const now = new Date("2026-11-22T11:00:00Z");

  function recorder(failAt?: string) {
    const ran: Command[] = [];
    const notified: string[][] = [];
    return {
      ran,
      notified,
      exec: (cmd: Command, logFd: number) => {
        ran.push(cmd);
        writeFileSync(logFd, `output of ${cmd.name}\n`);
        return cmd.name === failAt ? 1 : 0;
      },
      notify: (argv: string[]) => {
        notified.push(argv);
      },
    };
  }

  test("a green run writes the dated log and shows no notification", async () => {
    const home = tempHome();
    const r = recorder();
    const code = await runWeekly({ home, now, repoUrl: REPO_URL, bun: "/bin/bun", ...r });
    expect(code).toBe(0);
    expect(r.ran[0]?.name).toBe("clone");
    expect(r.ran.at(-1)?.argv).toEqual([
      "/bin/bun",
      "--no-env-file",
      "run",
      "test:macos",
      "--full",
    ]);
    expect(r.notified).toEqual([]);
    const log = readFileSync(
      join(home, "Library/Logs/claudish-weekly-tests/2026-11-22.log"),
      "utf8"
    );
    expect(log).toContain("output of test:macos --full");
    expect(log).toContain("PASS");
  });

  test("an existing clone is updated, not cloned again", async () => {
    const home = tempHome();
    mkdirSync(join(weeklyPaths(home).repoDir, ".git"), { recursive: true });
    const r = recorder();
    await runWeekly({ home, now, repoUrl: REPO_URL, bun: "/bin/bun", ...r });
    expect(r.ran.map((c) => c.name)).not.toContain("clone");
    expect(r.ran[0]?.argv).toEqual(["git", "fetch", "origin", "main"]);
  });

  test("a red step stops the run, exits 1 and notifies with the log path", async () => {
    const home = tempHome();
    const r = recorder("test:macos --full");
    const code = await runWeekly({ home, now, repoUrl: REPO_URL, bun: "/bin/bun", ...r });
    expect(code).toBe(1);
    const logPath = join(home, "Library/Logs/claudish-weekly-tests/2026-11-22.log");
    expect(r.notified).toHaveLength(1);
    expect(r.notified[0]).toContain(`Weekly claudish tests failed. Log: ${logPath}`);
    expect(readFileSync(logPath, "utf8")).toContain("FAIL test:macos --full (exit 1)");
  });

  test("a failed update runs no test and still notifies", async () => {
    const home = tempHome();
    const r = recorder("clone");
    expect(await runWeekly({ home, now, repoUrl: REPO_URL, bun: "/bin/bun", ...r })).toBe(1);
    expect(r.ran.map((c) => c.name)).toEqual(["clone"]);
    expect(r.notified).toHaveLength(1);
  });
});

describe("the launchd agent", () => {
  const xml = plistXml({ home: "/h", bun: "/opt/bun/bin/bun", path: "/opt/bun/bin:/usr/bin:/bin" });

  test("runs the clone's weekly script with the pinned home, Sunday 03:00 local", () => {
    expect(xml).toContain(`<key>Label</key>\n  <string>${LABEL}</string>`);
    expect(xml).toContain(
      [
        "<key>ProgramArguments</key>",
        "  <array>",
        "    <string>/opt/bun/bin/bun</string>",
        "    <string>--no-env-file</string>",
        "    <string>/h/Library/Caches/claudish-weekly-tests/repo/scripts/weekly-macos-tests.ts</string>",
        "    <string>--home</string>",
        "    <string>/h</string>",
        "  </array>",
      ].join("\n")
    );
    expect(xml).toContain(
      [
        "<key>StartCalendarInterval</key>",
        "  <dict>",
        "    <key>Weekday</key>",
        "    <integer>0</integer>",
        "    <key>Hour</key>",
        "    <integer>3</integer>",
        "    <key>Minute</key>",
        "    <integer>0</integer>",
        "  </dict>",
      ].join("\n")
    );
    expect(xml).toContain("<string>/opt/bun/bin:/usr/bin:/bin</string>");
    expect(xml).toContain("<string>/h/Library/Logs/claudish-weekly-tests/launchd.log</string>");
  });

  test("escapes XML in paths", () => {
    expect(plistXml({ home: "/a&b", bun: "/b<1>", path: "/p" })).toContain(
      "<string>/a&amp;b</string>"
    );
    expect(plistXml({ home: "/a&b", bun: "/b<1>", path: "/p" })).toContain(
      "<string>/b&lt;1&gt;</string>"
    );
  });

  test.skipIf(process.platform !== "darwin")("plutil accepts the plist", () => {
    const home = tempHome();
    const file = join(home, "agent.plist");
    writeFileSync(file, xml);
    const r = Bun.spawnSync(["plutil", "-lint", file], { env: { PATH: "/usr/bin:/bin" } });
    expect(r.exitCode).toBe(0);
  });
});

describe("install and uninstall", () => {
  function launchctl() {
    const ran: Command[] = [];
    return {
      ran,
      exec: (cmd: Command) => {
        ran.push(cmd);
        if (cmd.name === "clone") {
          // stands in for the clone: origin's main has the weekly script
          const repo = cmd.argv.at(-1) as string;
          mkdirSync(join(repo, ".git"), { recursive: true });
          mkdirSync(join(repo, "scripts"), { recursive: true });
          writeFileSync(join(repo, "scripts", "weekly-macos-tests.ts"), "");
        }
        return 0;
      },
    };
  }

  test("writes the plist into the given home and loads it into the user's GUI domain", () => {
    const home = tempHome();
    const l = launchctl();
    const result = install({ home, uid: 501, bun: "/bin/bun", repoUrl: REPO_URL, exec: l.exec });
    expect(result).toEqual({ ok: true, plist: plistPathFor(home) });
    expect(plistPathFor(home)).toBe(join(home, "Library/LaunchAgents", `${LABEL}.plist`));
    expect(readFileSync(plistPathFor(home), "utf8")).toContain("<key>StartCalendarInterval</key>");
    expect(l.ran.map((c) => c.argv)).toEqual([
      ["git", "clone", "--branch", "main", REPO_URL, weeklyPaths(home).repoDir],
      ["launchctl", "bootout", `gui/501/${LABEL}`],
      ["launchctl", "bootstrap", "gui/501", plistPathFor(home)],
    ]);
    expect(existsSync(weeklyPaths(home).logDir)).toBe(true);
  });

  test("refuses when origin's main has no weekly script yet, and loads nothing", () => {
    const home = tempHome();
    const ran: Command[] = [];
    const exec = (cmd: Command) => {
      ran.push(cmd);
      mkdirSync(join(cmd.argv.at(-1) as string, ".git"), { recursive: true });
      return 0;
    };
    const result = install({ home, uid: 501, bun: "/bin/bun", repoUrl: REPO_URL, exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("scripts/weekly-macos-tests.ts");
    expect(ran.map((c) => c.argv[0])).toEqual(["git"]);
    expect(existsSync(plistPathFor(home))).toBe(false);
  });

  test("uninstall unloads the agent and removes the plist, keeping the clone and the logs", () => {
    const home = tempHome();
    const l = launchctl();
    install({ home, uid: 501, bun: "/bin/bun", repoUrl: REPO_URL, exec: l.exec });
    l.ran.length = 0;
    uninstall({ home, uid: 501, exec: l.exec });
    expect(l.ran.map((c) => c.argv)).toEqual([["launchctl", "bootout", `gui/501/${LABEL}`]]);
    expect(existsSync(plistPathFor(home))).toBe(false);
    expect(existsSync(weeklyPaths(home).repoDir)).toBe(true);
    expect(existsSync(weeklyPaths(home).logDir)).toBe(true);
  });
});
