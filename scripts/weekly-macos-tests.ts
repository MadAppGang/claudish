#!/usr/bin/env bun
/**
 * The weekly full macOS test run, started by launchd on the owner's Mac
 * (scripts/install-weekly-macos-tests.ts installs the agent):
 *
 *   bun scripts/weekly-macos-tests.ts [--home <dir>] [--repo-url <url>]
 *
 * Pull requests and `bun run test:macos` run the essential tier; this runs everything
 * (`bun run test:macos --full`) on origin's main, once a week.
 *
 * It works in a clone of its own, `<home>/Library/Caches/claudish-weekly-tests/repo`: cloned on
 * the first run, then `git fetch origin main` and `git reset --hard origin/main` inside that clone
 * only, so no developer checkout or worktree is ever touched. Untracked files are cleaned;
 * ignored ones (node_modules) are kept. Every command's output goes to
 * `<home>/Library/Logs/claudish-weekly-tests/<UTC date>.log`. A failed step stops the run, exits
 * 1 and shows a macOS notification naming that log.
 *
 * The agent runs this file from the clone, so each week runs main's own copy of it.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REPO_URL = "https://github.com/MadAppGang/claudish.git";
const TITLE = "claudish weekly tests";

export interface WeeklyPaths {
  cacheDir: string;
  /** The dedicated clone. Nothing else is ever reset. */
  repoDir: string;
  logDir: string;
}

export function weeklyPaths(home: string): WeeklyPaths {
  const cacheDir = join(home, "Library", "Caches", "claudish-weekly-tests");
  return {
    cacheDir,
    repoDir: join(cacheDir, "repo"),
    logDir: join(home, "Library", "Logs", "claudish-weekly-tests"),
  };
}

/** `<logDir>/<YYYY-MM-DD>.log`, the date in UTC. */
export function logPathFor(logDir: string, now: Date): string {
  return join(logDir, `${now.toISOString().slice(0, 10)}.log`);
}

export interface Command {
  name: string;
  cwd: string;
  argv: string[];
}

/** The clone (first run only), its update to origin's main, the install and the full gate. */
export function weeklyCommands(p: {
  paths: WeeklyPaths;
  repoUrl: string;
  cloned: boolean;
  bun: string;
}): Command[] {
  const repo = p.paths.repoDir;
  const update: Command[] = p.cloned
    ? [
        { name: "fetch", cwd: repo, argv: ["git", "fetch", "origin", "main"] },
        { name: "reset", cwd: repo, argv: ["git", "reset", "--hard", "origin/main"] },
        // -ffd: untracked files and directories, a nested repository included; not -x, so
        // node_modules and other ignored files survive between runs.
        { name: "clean", cwd: repo, argv: ["git", "clean", "-ffd"] },
      ]
    : [
        {
          name: "clone",
          cwd: p.paths.cacheDir,
          argv: ["git", "clone", "--branch", "main", p.repoUrl, repo],
        },
      ];
  return [
    ...update,
    {
      name: "install",
      cwd: repo,
      argv: [p.bun, "--no-env-file", "install", "--frozen-lockfile"],
    },
    {
      name: "test:macos --full",
      cwd: repo,
      argv: [p.bun, "--no-env-file", "run", "test:macos", "--full"],
    },
  ];
}

/** osascript argv for the failure notification. The text travels as argv, never as script. */
export function notificationArgv(logPath: string): string[] {
  return [
    "osascript",
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e",
    "end run",
    `Weekly claudish tests failed. Log: ${logPath}`,
    TITLE,
  ];
}

/** Runs one command with its output appended to the log; returns its exit code. */
export function execToLog(cmd: Command, logFd: number): number {
  const r = spawnSync(cmd.argv[0] as string, cmd.argv.slice(1), {
    cwd: cmd.cwd,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  });
  if (r.error) writeSync(logFd, `could not start ${cmd.argv[0]}: ${r.error.message}\n`);
  return r.status ?? 1;
}

function notifyMac(argv: string[]): void {
  spawnSync(argv[0] as string, argv.slice(1), { stdio: "ignore" });
}

/** One weekly run. Returns the exit code: 0 when every step passed. */
export async function runWeekly(opts: {
  home: string;
  now: Date;
  repoUrl: string;
  bun: string;
  exec?: (cmd: Command, logFd: number) => number;
  notify?: (argv: string[]) => void;
}): Promise<number> {
  const exec = opts.exec ?? execToLog;
  const notify = opts.notify ?? notifyMac;
  const paths = weeklyPaths(opts.home);
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
  const logPath = logPathFor(paths.logDir, opts.now);
  const fd = openSync(logPath, "a");
  const say = (line: string) => writeSync(fd, `[weekly] ${line}\n`);
  try {
    const cloned = existsSync(join(paths.repoDir, ".git"));
    const commands = weeklyCommands({ paths, repoUrl: opts.repoUrl, cloned, bun: opts.bun });
    say(`start ${opts.now.toISOString()} in ${paths.repoDir}`);
    for (const cmd of commands) {
      say(`▶ ${cmd.name}: ${cmd.argv.join(" ")} (${cmd.cwd})`);
      const code = exec(cmd, fd);
      if (code !== 0) {
        say(`FAIL ${cmd.name} (exit ${code})`);
        notify(notificationArgv(logPath));
        return 1;
      }
      say(`PASS ${cmd.name}`);
    }
    say("PASS: every step");
    return 0;
  } finally {
    closeSync(fd);
  }
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

if (import.meta.main) {
  if (process.platform !== "darwin") {
    console.error(`[weekly] runs on macOS only, not ${process.platform}`);
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const home = flag(argv, "--home") ?? process.env.HOME ?? homedir();
  const now = new Date();
  const code = await runWeekly({
    home,
    now,
    repoUrl: flag(argv, "--repo-url") ?? REPO_URL,
    bun: process.execPath,
  });
  const log = logPathFor(weeklyPaths(home).logDir, now);
  console.log(`[weekly] ${code === 0 ? "PASS" : "FAIL"}: ${log}`);
  process.exit(code);
}
