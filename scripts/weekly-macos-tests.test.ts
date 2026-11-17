/**
 * The weekly macOS run and its launchd installer, against a temporary home: no real clone, no
 * real launchctl, no notification. Every command is recorded by an injected runner.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, install, plistPathFor, plistXml, uninstall } from "./install-weekly-macos-tests.ts";
import {
  type Command,
  NIGHTLY_PARTS,
  type PartResult,
  REPO_URL,
  checkGate,
  execToLog,
  failingTests,
  logPathFor,
  notificationArgv,
  parseWeeklyArgs,
  partOfDate,
  readPartResults,
  resolveHome,
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

  test("the log is named by the UTC date of the run and its part", () => {
    // 23:30 on the 15th in Los Angeles is the 16th in UTC.
    const now = new Date("2026-11-15T23:30:00-08:00");
    expect(logPathFor("/logs", now, 4)).toBe("/logs/2026-11-16-part4.log");
  });
});

describe("partOfDate", () => {
  test("seven consecutive UTC days take parts 1 to 7 once each, then repeat", () => {
    const day = (i: number) => new Date(Date.UTC(2026, 10, 16 + i, 2));
    const week = Array.from({ length: 7 }, (_, i) => partOfDate(day(i)));
    expect([...week].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(partOfDate(day(7))).toBe(week[0] as number);
    expect(NIGHTLY_PARTS).toBe(7);
  });
});

describe("failingTests", () => {
  test("lists each failing test once, from Bun's (fail) lines", () => {
    const log = [
      "(pass) a > b",
      "(fail) suite > one [1.00ms]",
      "noise",
      "(fail) suite > two",
      "(fail) suite > one [1.00ms]",
    ].join("\n");
    expect(failingTests(log)).toEqual(["suite > one", "suite > two"]);
  });
});

describe("checkGate", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const green = (part: number, daysAgo: number): PartResult => ({
    part,
    n: 7,
    date: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
    commit: "abc",
    pass: true,
    log: `/logs/p${part}.log`,
  });
  const all = () => [1, 2, 3, 4, 5, 6, 7].map((p) => green(p, 1));

  test("passes when every part is green within the last 7 days", () => {
    expect(checkGate(all(), now).ok).toBe(true);
  });

  test("fails on a missing part, a red part or a green older than 7 days, naming each", () => {
    const results = all().filter((r) => r.part !== 2);
    results[0] = { ...green(1, 1), pass: false };
    results[1] = green(3, 8);
    const verdict = checkGate(results, now);
    expect(verdict.ok).toBe(false);
    const text = verdict.lines.join("\n");
    expect(text).toMatch(/part 1\/7.*RED/);
    expect(text).toMatch(/part 2\/7.*no run/);
    expect(text).toMatch(/part 3\/7.*older than 7 days/);
  });
});

describe("weeklyCommands", () => {
  const paths = weeklyPaths("/h");

  test("a first run clones origin's main into the dedicated directory", () => {
    const cmds = weeklyCommands({
      paths,
      repoUrl: REPO_URL,
      cloned: false,
      bun: "/bin/bun",
      part: 2,
    });
    expect(cmds[0]).toEqual({
      name: "clone",
      cwd: paths.cacheDir,
      argv: ["git", "clone", "--branch", "main", REPO_URL, paths.repoDir],
    });
  });

  test("a later run fetches and hard-resets inside the clone only, then runs its part", () => {
    const cmds = weeklyCommands({
      paths,
      repoUrl: REPO_URL,
      cloned: true,
      bun: "/bin/bun",
      part: 2,
    });
    expect(cmds.map((c) => c.argv)).toEqual([
      ["git", "fetch", "origin", "main"],
      ["git", "reset", "--hard", "origin/main"],
      ["git", "clean", "-ffd"],
      ["/bin/bun", "--no-env-file", "install", "--frozen-lockfile"],
      ["/bin/bun", "--no-env-file", "run", "test:macos", "--part", "2/7"],
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
  const part = 3;
  const testStep = "test:macos --part 3/7";
  const logs = (home: string) => join(home, "Library/Logs/claudish-weekly-tests");

  function recorder(failAt?: string) {
    const ran: Command[] = [];
    const notified: string[][] = [];
    return {
      ran,
      notified,
      exec: (cmd: Command, logFd: number) => {
        ran.push(cmd);
        writeFileSync(logFd, `output of ${cmd.name}\n`);
        if (cmd.name === failAt && cmd.name === testStep) {
          writeFileSync(logFd, "(fail) pane > a slot settles [5000.00ms]\n");
        }
        return cmd.name === failAt ? 1 : 0;
      },
      notify: (argv: string[]) => {
        notified.push(argv);
      },
      revParse: () => "0123abc",
    };
  }
  const run = (home: string, r: ReturnType<typeof recorder>) =>
    runWeekly({ home, now, repoUrl: REPO_URL, bun: "/bin/bun", part, ...r });

  test("a green run writes the dated log and a green part result, and no notification", async () => {
    const home = tempHome();
    const r = recorder();
    expect(await run(home, r)).toBe(0);
    expect(r.ran[0]?.name).toBe("clone");
    expect(r.ran.at(-1)?.argv.slice(-3)).toEqual(["test:macos", "--part", "3/7"]);
    expect(r.notified).toEqual([]);
    const logPath = join(logs(home), "2026-11-22-part3.log");
    expect(readFileSync(logPath, "utf8")).toContain(`output of ${testStep}`);
    const result = JSON.parse(readFileSync(join(logs(home), "part3.json"), "utf8"));
    expect(result).toEqual({
      part: 3,
      n: 7,
      date: now.toISOString(),
      commit: "0123abc",
      pass: true,
      log: logPath,
    });
    expect(readdirSync(logs(home)).filter((f) => f.startsWith("RED-"))).toEqual([]);
  });

  test("an existing clone is updated, not cloned again", async () => {
    const home = tempHome();
    mkdirSync(join(weeklyPaths(home).repoDir, ".git"), { recursive: true });
    const r = recorder();
    await run(home, r);
    expect(r.ran.map((c) => c.name)).not.toContain("clone");
    expect(r.ran[0]?.argv).toEqual(["git", "fetch", "origin", "main"]);
  });

  test("a red part writes a RED marker with the failing tests and notifies with its path", async () => {
    const home = tempHome();
    const r = recorder(testStep);
    expect(await run(home, r)).toBe(1);
    const logPath = join(logs(home), "2026-11-22-part3.log");
    const markerPath = join(logs(home), "RED-2026-11-22-part3.json");
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual({
      date: now.toISOString(),
      part: "3/7",
      commit: "0123abc",
      failing: ["pane > a slot settles"],
      report: logPath,
    });
    expect(JSON.parse(readFileSync(join(logs(home), "part3.json"), "utf8")).pass).toBe(false);
    expect(r.notified).toHaveLength(1);
    expect(r.notified[0]).toContain(
      `Nightly claudish tests part 3/7 failed. Marker: ${markerPath}`
    );
    expect(readFileSync(logPath, "utf8")).toContain(`FAIL ${testStep} (exit 1)`);
  });

  test("a later green run of the same part keeps an earlier RED marker", async () => {
    const home = tempHome();
    await run(home, recorder(testStep));
    await run(home, recorder());
    expect(existsSync(join(logs(home), "RED-2026-11-22-part3.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(logs(home), "part3.json"), "utf8")).pass).toBe(true);
  });

  test("a failed update runs no test, writes a red result and still notifies", async () => {
    const home = tempHome();
    const r = recorder("clone");
    expect(await run(home, r)).toBe(1);
    expect(r.ran.map((c) => c.name)).toEqual(["clone"]);
    expect(r.notified).toHaveLength(1);
    expect(existsSync(join(logs(home), "RED-2026-11-22-part3.json"))).toBe(true);
  });

  test("readPartResults reads every part<k>.json the runs wrote", async () => {
    const home = tempHome();
    await run(home, recorder());
    expect(readPartResults(logs(home)).map((p) => [p.part, p.pass])).toEqual([[3, true]]);
  });
});

describe("the launchd agent", () => {
  const xml = plistXml({ home: "/h", bun: "/opt/bun/bin/bun", path: "/opt/bun/bin:/usr/bin:/bin" });

  test("runs the clone's weekly script with the pinned home, every day at 03:00 local", () => {
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

  test("a run after a refusal updates the existing clone to origin's main, then installs", () => {
    const home = tempHome();
    const repo = weeklyPaths(home).repoDir;
    // origin's main gains the weekly script between the two runs
    let originHasScript = false;
    const ran: Command[] = [];
    const exec = (cmd: Command) => {
      ran.push(cmd);
      if (cmd.name === "clone") mkdirSync(join(repo, ".git"), { recursive: true });
      if ((cmd.name === "clone" || cmd.name === "reset") && originHasScript) {
        mkdirSync(join(repo, "scripts"), { recursive: true });
        writeFileSync(join(repo, "scripts", "weekly-macos-tests.ts"), "");
      }
      return 0;
    };

    const first = install({ home, uid: 501, bun: "/bin/bun", repoUrl: REPO_URL, exec });
    expect(first.ok).toBe(false);
    expect(ran.map((c) => c.name)).toEqual(["clone"]);

    originHasScript = true;
    ran.length = 0;
    const second = install({ home, uid: 501, bun: "/bin/bun", repoUrl: REPO_URL, exec });
    expect(second).toEqual({ ok: true, plist: plistPathFor(home) });
    expect(ran.map((c) => c.argv)).toEqual([
      ["git", "fetch", "origin", "main"],
      ["git", "reset", "--hard", "origin/main"],
      ["git", "clean", "-ffd"],
      ["launchctl", "bootout", `gui/501/${LABEL}`],
      ["launchctl", "bootstrap", "gui/501", plistPathFor(home)],
    ]);
    // the update runs inside the dedicated clone only
    for (const c of ran.filter((c) => c.argv[0] === "git")) {
      expect(c.cwd).toBe(repo);
      expect(c.argv).not.toContain("-C");
    }
  });

  test("a failed update of the existing clone refuses and loads nothing", () => {
    const home = tempHome();
    const repo = weeklyPaths(home).repoDir;
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "weekly-macos-tests.ts"), "");
    const ran: Command[] = [];
    const exec = (cmd: Command) => {
      ran.push(cmd);
      return cmd.name === "fetch" ? 128 : 0;
    };
    const result = install({ home, uid: 501, bun: "/bin/bun", repoUrl: REPO_URL, exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("fetch");
    expect(ran.map((c) => c.name)).toEqual(["fetch"]);
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

describe("arguments and home", () => {
  test("parseWeeklyArgs takes the known flags and their values", () => {
    expect(
      parseWeeklyArgs(["--home", "/h", "--repo-url", "https://x/y.git"], { uninstall: false })
    ).toEqual({ home: "/h", repoUrl: "https://x/y.git" });
    expect(parseWeeklyArgs(["--uninstall"], { uninstall: true })).toEqual({ uninstall: true });
    expect(parseWeeklyArgs(["--home", "/h"], { uninstall: true })).toEqual({
      home: "/h",
      uninstall: false,
    });
  });

  test("the nightly run takes --part <k> and --check; the installer takes neither", () => {
    expect(parseWeeklyArgs(["--part", "5"], { uninstall: false })).toEqual({ part: 5 });
    expect(parseWeeklyArgs(["--check"], { uninstall: false })).toEqual({ check: true });
    for (const bad of ["0", "8", "x", "2/7"]) {
      expect(() => parseWeeklyArgs(["--part", bad], { uninstall: false })).toThrow("--part");
    }
    expect(() => parseWeeklyArgs(["--part", "1"], { uninstall: true })).toThrow(
      "unknown argument --part"
    );
    expect(() => parseWeeklyArgs(["--check"], { uninstall: true })).toThrow(
      "unknown argument --check"
    );
  });

  test("parseWeeklyArgs refuses an unknown flag, a misspelt --uninstall included", () => {
    expect(() => parseWeeklyArgs(["--uninstal"], { uninstall: true })).toThrow(
      "unknown argument --uninstal"
    );
    expect(() => parseWeeklyArgs(["--uninstall"], { uninstall: false })).toThrow(
      "unknown argument --uninstall"
    );
    expect(() => parseWeeklyArgs(["extra"], { uninstall: false })).toThrow("unknown argument");
  });

  test("parseWeeklyArgs refuses a missing or flag-shaped option value", () => {
    expect(() => parseWeeklyArgs(["--home"], { uninstall: true })).toThrow("--home needs a value");
    expect(() => parseWeeklyArgs(["--home", "--uninstall"], { uninstall: true })).toThrow(
      "--home needs a value"
    );
    expect(() => parseWeeklyArgs(["--repo-url", ""], { uninstall: false })).toThrow(
      "--repo-url needs a value"
    );
  });

  const account = () => "/Users/someone";

  test("resolveHome takes --home, then a non-empty HOME, then the account's home", () => {
    expect(resolveHome({ flag: "/h", env: "/e", account })).toBe("/h");
    expect(resolveHome({ env: "/e", account })).toBe("/e");
    expect(resolveHome({ env: "", account })).toBe("/Users/someone");
    expect(resolveHome({ env: undefined, account })).toBe("/Users/someone");
  });

  test("resolveHome refuses a relative or empty home", () => {
    expect(() => resolveHome({ flag: "rel-home", account })).toThrow("absolute");
    expect(() => resolveHome({ flag: "./rel-home", account })).toThrow("absolute");
    expect(() => resolveHome({ env: "rel", account })).toThrow("absolute");
    expect(() => resolveHome({ env: "", account: () => "" })).toThrow("absolute");
  });

  test("execToLog gives the command the run's home as HOME", () => {
    const home = tempHome();
    const log = join(home, "out.log");
    const fd = openSync(log, "a");
    try {
      const code = execToLog(
        { name: "home", cwd: home, argv: ["/bin/sh", "-c", 'printf "%s" "$HOME"'] },
        fd,
        home
      );
      expect(code).toBe(0);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(log, "utf8")).toBe(home);
  });

  test("runWeekly hands every command the run's home", async () => {
    const home = tempHome();
    const seen: string[] = [];
    await runWeekly({
      home,
      now: new Date("2026-11-22T11:00:00Z"),
      repoUrl: REPO_URL,
      bun: "/bin/bun",
      exec: (_cmd, _fd, runHome) => {
        seen.push(runHome);
        return 0;
      },
      notify: () => {},
      revParse: () => "abc",
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) expect(h).toBe(home);
  });
});

/**
 * The scripts themselves, with fake git, launchctl and osascript first on PATH and a temporary
 * HOME: a refused argument runs no command and writes nothing.
 */
describe("the scripts refuse bad arguments before they act", () => {
  function fakes(): { bin: string; log: string; home: string } {
    const home = tempHome();
    const bin = join(home, "fake-bin");
    const log = join(home, "fake-commands.log");
    mkdirSync(bin);
    for (const name of ["git", "launchctl", "osascript"]) {
      const file = join(bin, name);
      writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`);
      chmodSync(file, 0o755);
    }
    return { bin, log, home };
  }

  function runScript(script: string, args: string[], f: { bin: string; home: string }) {
    const cwd = join(f.home, "cwd");
    mkdirSync(cwd);
    mkdirSync(join(f.home, "env-home"));
    const r = Bun.spawnSync(
      [process.execPath, "--no-env-file", join(import.meta.dir, script), ...args],
      {
        cwd,
        env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: join(f.home, "env-home") },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    return { code: r.exitCode, err: r.stderr.toString(), cwd };
  }

  const cases: { script: string; args: (home: string) => string[]; message: string }[] = [
    {
      script: "install-weekly-macos-tests.ts",
      args: (h) => ["--home", h, "--uninstal"],
      message: "unknown argument --uninstal",
    },
    {
      script: "install-weekly-macos-tests.ts",
      args: () => ["--home", "--uninstall"],
      message: "--home needs a value",
    },
    {
      script: "install-weekly-macos-tests.ts",
      args: () => ["--home", "rel-home"],
      message: "absolute",
    },
    {
      script: "weekly-macos-tests.ts",
      args: (h) => ["--home", h, "--hme", h],
      message: "unknown argument --hme",
    },
    { script: "weekly-macos-tests.ts", args: () => ["--home"], message: "--home needs a value" },
    {
      script: "weekly-macos-tests.ts",
      args: (h) => ["--home", h, "--part", "9"],
      message: "--part",
    },
    {
      script: "weekly-macos-tests.ts",
      args: () => ["--home", "./rel-home"],
      message: "absolute",
    },
  ];

  for (const c of cases) {
    test.skipIf(process.platform !== "darwin")(
      `${c.script} ${c.args("<home>").join(" ")} exits non-zero and runs nothing`,
      () => {
        const f = fakes();
        const r = runScript(c.script, c.args(f.home), f);
        expect(r.code).not.toBe(0);
        expect(r.err).toContain(c.message);
        expect(existsSync(f.log)).toBe(false);
        // Bun's own transpiler cache may appear under HOME; the weekly directories may not.
        for (const home of [f.home, join(f.home, "env-home")]) {
          const paths = weeklyPaths(home);
          expect(existsSync(paths.cacheDir)).toBe(false);
          expect(existsSync(paths.logDir)).toBe(false);
          expect(existsSync(plistPathFor(home))).toBe(false);
        }
        expect(readdirSync(r.cwd)).toEqual([]);
      }
    );
  }
});
