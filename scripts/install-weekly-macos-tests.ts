#!/usr/bin/env bun
/**
 * Installs (or removes) the launchd agent that runs scripts/weekly-macos-tests.ts every Sunday at
 * 03:00 local time:
 *
 *   bun scripts/install-weekly-macos-tests.ts [--home <dir>] [--repo-url <url>]
 *   bun scripts/install-weekly-macos-tests.ts --uninstall [--home <dir>]
 *
 * Any other argument (a misspelt `--uninstall` included), or a flag with no value, is refused
 * (exit 2) before anything is cloned, written or loaded. The home is `--home`, else a non-empty
 * HOME, else the account's home, and must be an absolute path.
 *
 * Install clones origin's main into the weekly run's own directory when it is not there yet
 * (`<home>/Library/Caches/claudish-weekly-tests/repo`), or, when it is, fetches, hard-resets and
 * cleans that clone (and nothing else) to origin's main, as the weekly run does. It refuses
 * when that main has no
 * scripts/weekly-macos-tests.ts, writes
 * `<home>/Library/LaunchAgents/com.madappgang.claudish.weekly-macos-tests.plist` and loads it
 * into the user's GUI domain (`launchctl bootout`, then `launchctl bootstrap gui/<uid>`). The agent
 * runs the CLONE's copy of the weekly script, which updates the clone first, so each week runs
 * main's own version of it.
 *
 * A Mac asleep at 03:00 runs the job when it next wakes (launchd's StartCalendarInterval); a
 * Mac that is off skips that week.
 *
 * Uninstall unloads the agent and removes the plist. The clone and the logs stay: remove
 * `~/Library/Caches/claudish-weekly-tests` and `~/Library/Logs/claudish-weekly-tests` by hand.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Command,
  REPO_URL,
  type WeeklyArgs,
  cloneCommands,
  parseWeeklyArgs,
  resolveHome,
  weeklyPaths,
} from "./weekly-macos-tests.ts";

export const LABEL = "com.madappgang.claudish.weekly-macos-tests";
const WEEKLY_SCRIPT = join("scripts", "weekly-macos-tests.ts");

export function plistPathFor(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The agent's plist: the clone's weekly script under `bun`, Sunday 03:00 local time. */
export function plistXml(p: { home: string; bun: string; path: string }): string {
  const paths = weeklyPaths(p.home);
  const s = (value: string) => `<string>${xmlText(value)}</string>`;
  const program = [p.bun, "--no-env-file", join(paths.repoDir, WEEKLY_SCRIPT), "--home", p.home];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${s(LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...program.map((arg) => `    ${s(arg)}`),
    "  </array>",
    "  <key>StartCalendarInterval</key>",
    "  <dict>",
    "    <key>Weekday</key>",
    "    <integer>0</integer>",
    "    <key>Hour</key>",
    "    <integer>3</integer>",
    "    <key>Minute</key>",
    "    <integer>0</integer>",
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  ${s(paths.cacheDir)}`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    ${s(p.path)}`,
    "    <key>HOME</key>",
    `    ${s(p.home)}`,
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  ${s(join(paths.logDir, "launchd.log"))}`,
    "  <key>StandardErrorPath</key>",
    `  ${s(join(paths.logDir, "launchd.log"))}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin; the run also needs bun, gh and git. */
export function agentPath(bun: string): string {
  return [
    dirname(bun),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((dir, i, all) => all.indexOf(dir) === i)
    .join(":");
}

function execInherit(cmd: Command): number {
  const r = spawnSync(cmd.argv[0] as string, cmd.argv.slice(1), { cwd: cmd.cwd, stdio: "inherit" });
  return r.status ?? 1;
}

export type InstallResult = { ok: true; plist: string } | { ok: false; error: string };

export function install(p: {
  home: string;
  uid: number;
  bun: string;
  repoUrl: string;
  exec?: (cmd: Command) => number;
}): InstallResult {
  const exec = p.exec ?? execInherit;
  const paths = weeklyPaths(p.home);
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
  // An existing clone is brought to origin's main first: a run refused before the merge left a
  // clone without the weekly script, and only an update can give it one.
  const cloned = existsSync(join(paths.repoDir, ".git"));
  for (const cmd of cloneCommands({ paths, repoUrl: p.repoUrl, cloned })) {
    if (exec(cmd) !== 0) {
      return {
        ok: false,
        error: `${cmd.name} failed: ${cmd.argv.join(" ")} (in ${cmd.cwd}), so ${paths.repoDir} is not origin's main`,
      };
    }
  }
  if (!existsSync(join(paths.repoDir, WEEKLY_SCRIPT))) {
    return {
      ok: false,
      error: `${paths.repoDir} has no ${WEEKLY_SCRIPT}: origin's main does not carry it yet. Merge it, then install again.`,
    };
  }
  const plist = plistPathFor(p.home);
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, plistXml({ home: p.home, bun: p.bun, path: agentPath(p.bun) }));
  // A loaded agent keeps its old definition until it is booted out; not loaded is fine.
  exec({ name: "bootout", cwd: p.home, argv: ["launchctl", "bootout", `gui/${p.uid}/${LABEL}`] });
  const loaded = exec({
    name: "bootstrap",
    cwd: p.home,
    argv: ["launchctl", "bootstrap", `gui/${p.uid}`, plist],
  });
  if (loaded !== 0) return { ok: false, error: `launchctl bootstrap gui/${p.uid} ${plist} failed` };
  return { ok: true, plist };
}

export function uninstall(p: { home: string; uid: number; exec?: (cmd: Command) => number }): void {
  const exec = p.exec ?? execInherit;
  exec({ name: "bootout", cwd: p.home, argv: ["launchctl", "bootout", `gui/${p.uid}/${LABEL}`] });
  rmSync(plistPathFor(p.home), { force: true });
}

if (import.meta.main) {
  if (process.platform !== "darwin") {
    console.error(`[weekly] launchd agents exist on macOS only, not ${process.platform}`);
    process.exit(1);
  }
  let args: WeeklyArgs;
  let home: string;
  try {
    args = parseWeeklyArgs(process.argv.slice(2), { uninstall: true });
    home = resolveHome({ flag: args.home, env: process.env.HOME });
  } catch (err) {
    console.error(`[weekly] ${(err as Error).message}`);
    process.exit(2);
  }
  const uid = process.getuid?.() ?? 0;
  if (args.uninstall) {
    uninstall({ home, uid });
    console.log(`[weekly] removed ${plistPathFor(home)}; the clone and the logs stay`);
  } else {
    const result = install({
      home,
      uid,
      bun: process.execPath,
      repoUrl: args.repoUrl ?? REPO_URL,
    });
    if (!result.ok) {
      console.error(`[weekly] ${result.error}`);
      process.exit(1);
    }
    console.log(`[weekly] installed ${result.plist}: Sunday 03:00 local time`);
    console.log(`[weekly] logs: ${weeklyPaths(home).logDir}`);
  }
}
