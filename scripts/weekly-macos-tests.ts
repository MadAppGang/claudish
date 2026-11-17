#!/usr/bin/env bun
/**
 * The nightly macOS test part, started by launchd on the owner's Mac every night
 * (scripts/install-weekly-macos-tests.ts installs the agent), and the release check that reads
 * the parts:
 *
 *   bun scripts/weekly-macos-tests.ts [--home <dir>] [--repo-url <url>] [--part <k>]
 *   bun scripts/weekly-macos-tests.ts --check [--home <dir>]
 *
 * Any other argument, or a flag with no value, is refused (exit 2) before anything runs. The
 * home is `--home`, else a non-empty HOME, else the account's home, and must be absolute; every
 * command runs with it as HOME.
 *
 * The weekly tier (every hermetic file the essential tier leaves out) is cut into
 * `NIGHTLY_PARTS` parts; each night runs one (`bun run test:macos --part <k>/7`): the part with
 * no result, else the one whose result is oldest (`nextPart`), so any 7 runs run every part once,
 * whatever time the Mac wakes. `--part <k>` runs part k now: the bootstrap runs the seven parts by
 * hand, one after another, never two at once.
 *
 * It works in a clone of its own, `<home>/Library/Caches/claudish-weekly-tests/repo`: cloned on
 * the first run, then `git fetch origin main` and `git reset --hard origin/main` inside that clone
 * only, so no developer checkout or worktree is ever touched. Untracked files are cleaned;
 * ignored ones (node_modules) are kept. In `<home>/Library/Logs/claudish-weekly-tests/`:
 *
 * - `<UTC date>-part<k>.log`: every command's output;
 * - `part<k>.json`: the latest result of part k (`PartResult`), green or red;
 * - `RED-<UTC date>-part<k>.json`: written by a red run, with the date, the part, the commit,
 *   the failing tests and the log path. A later green run never deletes it: triage deletes it
 *   once the failures are filed. A red run also shows a macOS notification naming the marker.
 *
 * `--check` is the release gate's half that the nightly runs feed: it exits 0 only when every
 * part has a green result dated within the last 7 days (`checkGate`), and lists each part.
 *
 * The agent runs this file from the clone, so each night runs main's own copy of it.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

export const REPO_URL = "https://github.com/MadAppGang/claudish.git";
const TITLE = "claudish nightly tests";

/** How many parts the weekly tier is cut into: one a night, every test once a week. */
export const NIGHTLY_PARTS = 7;

/** How old the newest green run of a part may be for the release gate. */
const GATE_DAYS = 7;
const DAY_MS = 86_400_000;

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

const utcDate = (now: Date) => now.toISOString().slice(0, 10);

/** `<logDir>/<YYYY-MM-DD>-part<k>.log`, the date in UTC. */
export function logPathFor(logDir: string, now: Date, part: number): string {
  return join(logDir, `${utcDate(now)}-part${part}.log`);
}

/**
 * The part a run takes: the lowest part with no result of this part count, else the part whose
 * result is oldest (a tie takes the lowest part). It orders the results by their dates, not by
 * the day the run falls on, so a Mac that sleeps through a night, wakes late or changes time zone
 * still runs every part once in any 7 runs. A date after `now` or one that does not parse counts
 * as oldest: after the clock is set back, the parts that ran while it was ahead are run again
 * first instead of waiting for the clock to catch up. A red part is not run again sooner: its
 * RED marker goes to triage.
 */
export function nextPart(results: PartResult[], now: Date, n: number = NIGHTLY_PARTS): number {
  let oldest = 1;
  let oldestTime = Number.POSITIVE_INFINITY;
  for (let k = 1; k <= n; k++) {
    const r = results.find((x) => x.part === k && x.n === n);
    if (!r) return k;
    const t = Date.parse(r.date);
    const time = Number.isNaN(t) || t > now.getTime() ? Number.NEGATIVE_INFINITY : t;
    if (time < oldestTime) {
      oldest = k;
      oldestTime = time;
    }
  }
  return oldest;
}

export interface Command {
  name: string;
  cwd: string;
  argv: string[];
}

/**
 * The clone (when there is none yet), or the update of the existing clone to origin's main, every
 * git command inside the dedicated clone only. The installer runs the same commands.
 */
export function cloneCommands(p: {
  paths: WeeklyPaths;
  repoUrl: string;
  cloned: boolean;
}): Command[] {
  const repo = p.paths.repoDir;
  return p.cloned
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
}

/**
 * Whether the dedicated clone exists. A clone directory with no `.git`, left by a clone that was
 * killed, is renamed to `repo.broken-<ms>` beside it: `git clone` refuses a non-empty directory,
 * so it would fail every later run. A rename deletes nothing, whatever the path resolves to, so
 * a symlinked cache directory cannot turn this into a deletion elsewhere. A throw here is a red
 * run (`runWeekly`) or a refused install.
 */
export function cloneReady(paths: WeeklyPaths, nowMs: number = Date.now()): boolean {
  if (existsSync(join(paths.repoDir, ".git"))) return true;
  let present = true;
  try {
    lstatSync(paths.repoDir);
  } catch {
    present = false;
  }
  if (present) renameSync(paths.repoDir, `${paths.repoDir}.broken-${nowMs}`);
  return false;
}

/** The clone (first run only), its update to origin's main, the install and one part. */
export function weeklyCommands(p: {
  paths: WeeklyPaths;
  repoUrl: string;
  cloned: boolean;
  bun: string;
  part: number;
}): Command[] {
  const repo = p.paths.repoDir;
  const part = `${p.part}/${NIGHTLY_PARTS}`;
  return [
    ...cloneCommands(p),
    {
      name: "install",
      cwd: repo,
      argv: [p.bun, "--no-env-file", "install", "--frozen-lockfile"],
    },
    {
      name: `test:macos --part ${part}`,
      cwd: repo,
      argv: [p.bun, "--no-env-file", "run", "test:macos", "--part", part],
    },
  ];
}

/** osascript argv for a notification. The text travels as argv, never as script. */
export function notificationArgv(text: string): string[] {
  return [
    "osascript",
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e",
    "end run",
    text,
    TITLE,
  ];
}

/**
 * Each failing test of a Bun log, once, from its `(fail) <name> [<ms>]` lines. ci-tests.ts puts
 * a `[<group>-<k>of<n>] ` label in front of each line of a group run beside others.
 */
export function failingTests(log: string): string[] {
  const names: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /^(?:\[[^\]]+\] )?\(fail\) (.*)$/.exec(line);
    if (m) names.push((m[1] as string).replace(/\s*\[[\d.]+m?s\]\s*$/, ""));
  }
  return [...new Set(names)];
}

/** `part<k>.json`: the latest result of one part. */
export interface PartResult {
  part: number;
  n: number;
  /** ISO time the run started. */
  date: string;
  /** The clone's commit, or null when it could not be read. */
  commit: string | null;
  pass: boolean;
  log: string;
}

function isPartResult(r: unknown, part: number): r is PartResult {
  if (typeof r !== "object" || r === null) return false;
  const x = r as Record<string, unknown>;
  return (
    x.part === part &&
    Number.isInteger(x.n) &&
    typeof x.date === "string" &&
    (typeof x.commit === "string" || x.commit === null) &&
    typeof x.pass === "boolean" &&
    typeof x.log === "string"
  );
}

/**
 * Every `part<k>.json` in the log directory, the name spelt as `runWeekly` writes it and its
 * `part` field equal to k. Unreadable, malformed or misnamed files are skipped.
 */
export function readPartResults(logDir: string): PartResult[] {
  if (!existsSync(logDir)) return [];
  const results: PartResult[] = [];
  for (const name of readdirSync(logDir).sort()) {
    const m = /^part([1-9]\d*)\.json$/.exec(name);
    if (!m) continue;
    try {
      const r: unknown = JSON.parse(readFileSync(join(logDir, name), "utf8"));
      if (isPartResult(r, Number(m[1]))) results.push(r);
    } catch {
      // A torn or foreign file proves nothing; the part reads as having no run.
    }
  }
  return results;
}

/**
 * The release gate's nightly half: every part 1..n has a green result no older than 7 days. A
 * missing part, a red part and an old green each fail it, and each is named.
 */
export function checkGate(
  results: PartResult[],
  now: Date,
  n: number = NIGHTLY_PARTS
): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  for (let k = 1; k <= n; k++) {
    const r = results.find((x) => x.part === k && x.n === n);
    const label = `part ${k}/${n}`;
    if (!r) {
      ok = false;
      lines.push(`${label}: no run`);
      continue;
    }
    const age = now.getTime() - Date.parse(r.date);
    const where = `${r.date} ${r.commit ?? "unknown commit"} (${r.log})`;
    if (!r.pass) {
      ok = false;
      lines.push(`${label}: RED ${where}`);
    } else if (age < 0) {
      ok = false;
      lines.push(`${label}: green but dated in the future, ${where}`);
    } else if (!(age <= GATE_DAYS * DAY_MS)) {
      ok = false;
      lines.push(`${label}: green but older than ${GATE_DAYS} days, ${where}`);
    } else {
      lines.push(`${label}: green ${where}`);
    }
  }
  return { ok, lines };
}

/**
 * Runs one command with its output appended to the log; returns its exit code. The command's
 * HOME is the run's home, so a run started by hand with `--home <dir>` keeps every child there.
 */
export function execToLog(cmd: Command, logFd: number, home: string): number {
  const r = spawnSync(cmd.argv[0] as string, cmd.argv.slice(1), {
    cwd: cmd.cwd,
    env: { ...process.env, HOME: home },
    stdio: ["ignore", logFd, logFd],
  });
  if (r.error) writeSync(logFd, `could not start ${cmd.argv[0]}: ${r.error.message}\n`);
  return r.status ?? 1;
}

function notifyMac(argv: string[]): void {
  spawnSync(argv[0] as string, argv.slice(1), { stdio: "ignore" });
}

/** The clone's HEAD, or null when there is no clone or git fails. */
function gitHead(repoDir: string, home: string): string | null {
  if (!existsSync(join(repoDir, ".git"))) return null;
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs the steps in order and stops at the first failure. A step that exits non-zero and a
 * step whose runner throws both fail the run; neither ends it before its result is written.
 */
function runSteps(
  commands: Command[],
  exec: (cmd: Command) => number,
  say: (line: string) => void
): boolean {
  for (const cmd of commands) {
    say(`▶ ${cmd.name}: ${cmd.argv.join(" ")} (${cmd.cwd})`);
    let code: number;
    try {
      code = exec(cmd);
    } catch (e) {
      say(`FAIL ${cmd.name} threw: ${errorText(e)}`);
      return false;
    }
    if (code !== 0) {
      say(`FAIL ${cmd.name} (exit ${code})`);
      return false;
    }
    say(`PASS ${cmd.name}`);
  }
  say("PASS: every step");
  return true;
}

/**
 * The failing tests this run wrote: the bytes of the open log from `from` on. The log of one part
 * and day is appended to by every run of it that day, so `from` is its size when this run opened
 * it. It reads through `fd`, the file this run wrote to, so a log renamed or replaced meanwhile
 * changes nothing. A log that shrank below `from` is read from its start, and `logError` says so.
 * A read that fails gives no names and its error.
 */
function readFailing(fd: number, from: number): { failing: string[]; logError?: string } {
  try {
    const size = fstatSync(fd).size;
    const start = size < from ? 0 : from;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const failing = failingTests(buf.subarray(0, got).toString("utf8"));
    if (start === from) return { failing };
    return { failing, logError: `the log shrank during the run (${from} → ${size} bytes)` };
  } catch (e) {
    return { failing: [], logError: errorText(e) };
  }
}

/**
 * Prepares the clone and runs the part's steps. Anything that throws, the preparation included,
 * is a red run, so the result, the RED marker and the notification are still written.
 */
function runPart(p: {
  paths: WeeklyPaths;
  part: number;
  opts: { now: Date; repoUrl: string; bun: string };
  say: (line: string) => void;
  exec: (cmd: Command) => number;
}): boolean {
  try {
    const cloned = cloneReady(p.paths, p.opts.now.getTime());
    const commands = weeklyCommands({
      paths: p.paths,
      repoUrl: p.opts.repoUrl,
      cloned,
      bun: p.opts.bun,
      part: p.part,
    });
    p.say(
      `start ${p.opts.now.toISOString()} part ${p.part}/${NIGHTLY_PARTS} in ${p.paths.repoDir}`
    );
    return runSteps(commands, p.exec, p.say);
  } catch (e) {
    try {
      p.say(`FAIL preparing the run: ${errorText(e)}`);
    } catch {
      // The log itself failed; the result and the marker still record the red run.
    }
    return false;
  }
}

/** One nightly part. Returns the exit code: 0 when every step passed. */
export async function runWeekly(opts: {
  home: string;
  now: Date;
  repoUrl: string;
  bun: string;
  part?: number;
  exec?: (cmd: Command, logFd: number, home: string) => number;
  notify?: (argv: string[]) => void;
  revParse?: (repoDir: string) => string | null;
}): Promise<number> {
  const exec = opts.exec ?? execToLog;
  const notify = opts.notify ?? notifyMac;
  const revParse = opts.revParse ?? ((dir: string) => gitHead(dir, opts.home));
  const part = opts.part ?? nextPart(readPartResults(weeklyPaths(opts.home).logDir), opts.now);
  const paths = weeklyPaths(opts.home);
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
  const logPath = logPathFor(paths.logDir, opts.now, part);
  // a+: appended to like any log, and read back through this descriptor for the RED marker.
  const fd = openSync(logPath, "a+");
  const logStart = fstatSync(fd).size;
  const say = (line: string) => writeSync(fd, `[nightly] ${line}\n`);
  let pass = false;
  let failed: { failing: string[]; logError?: string } = { failing: [] };
  try {
    pass = runPart({ paths, part, opts, say, exec: (cmd) => exec(cmd, fd, opts.home) });
    if (!pass) failed = readFailing(fd, logStart);
  } finally {
    closeSync(fd);
  }
  const commit = revParse(paths.repoDir);
  const result: PartResult = {
    part,
    n: NIGHTLY_PARTS,
    date: opts.now.toISOString(),
    commit,
    pass,
    log: logPath,
  };
  writeFileSync(join(paths.logDir, `part${part}.json`), `${JSON.stringify(result, null, 2)}\n`);
  if (pass) return 0;
  const marker = join(paths.logDir, `RED-${utcDate(opts.now)}-part${part}.json`);
  const red = {
    date: result.date,
    part: `${part}/${NIGHTLY_PARTS}`,
    commit,
    ...failed,
    report: logPath,
  };
  writeFileSync(marker, `${JSON.stringify(red, null, 2)}\n`);
  notify(
    notificationArgv(
      `Nightly claudish tests part ${part}/${NIGHTLY_PARTS} failed. Marker: ${marker}`
    )
  );
  return 1;
}

export interface WeeklyArgs {
  home?: string;
  repoUrl?: string;
  uninstall?: boolean;
  part?: number;
  check?: boolean;
}

const VALUE_FLAGS = { "--home": "home", "--repo-url": "repoUrl" } as const;

/**
 * The scripts' flags: `--home <dir>` and `--repo-url <url>` for both; `--uninstall` where
 * `o.uninstall` allows it (the installer); `--part <k>` and `--check` where it does not (the
 * nightly run). Anything else, and a missing, empty or flag-shaped value, throws, so a misspelt
 * `--uninstall` never installs and `--home --uninstall` never reads a flag as a path.
 */
export function parseWeeklyArgs(argv: string[], o: { uninstall: boolean }): WeeklyArgs {
  const out: WeeklyArgs = o.uninstall ? { uninstall: false } : {};
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i] as string;
    const taken = takeFlag(out, arg, argv[i + 1], o.uninstall);
    if (taken === 0) {
      const usage = o.uninstall
        ? "[--uninstall] [--home <dir>] [--repo-url <url>]"
        : "[--home <dir>] [--repo-url <url>] [--part <k> | --check]";
      throw new Error(`unknown argument ${arg}; usage: ${usage}`);
    }
    i += taken;
  }
  if (out.check && out.part !== undefined) {
    throw new Error("--check and --part cannot be used together: --check reads every part");
  }
  return out;
}

/** Applies one flag to `out`; returns how many arguments it took, 0 for an unknown flag. */
function takeFlag(
  out: WeeklyArgs,
  arg: string,
  next: string | undefined,
  installer: boolean
): number {
  if (installer && arg === "--uninstall") {
    out.uninstall = true;
    return 1;
  }
  if (!installer && arg === "--check") {
    out.check = true;
    return 1;
  }
  if (!installer && arg === "--part") {
    out.part = partNumber(next);
    return 2;
  }
  if (!(arg in VALUE_FLAGS)) return 0;
  if (!next || next.startsWith("-")) throw new Error(`${arg} needs a value`);
  out[VALUE_FLAGS[arg as keyof typeof VALUE_FLAGS]] = next;
  return 2;
}

/** `--part`'s value: a whole number from 1 to NIGHTLY_PARTS. */
function partNumber(value: string | undefined): number {
  const k = Number(value);
  if (!value || !/^\d+$/.test(value) || k < 1 || k > NIGHTLY_PARTS) {
    throw new Error(`--part needs a part number from 1 to ${NIGHTLY_PARTS}`);
  }
  return k;
}

/** The account's home from the user database, which an empty or unset HOME does not change. */
function accountHome(): string {
  return homedir() || userInfo().homedir;
}

/**
 * The home the nightly run works under: `--home`, else a non-empty HOME, else the account's home.
 * A relative or empty path is refused, not resolved: the plist and every command's cwd would
 * otherwise depend on the directory the script was started from.
 */
export function resolveHome(p: {
  flag?: string;
  env?: string;
  account?: () => string;
}): string {
  const home = p.flag ?? (p.env || (p.account ?? accountHome)());
  if (!home || !isAbsolute(home)) {
    throw new Error(`the home must be an absolute path, not "${home}"`);
  }
  return home;
}

if (import.meta.main) {
  if (process.platform !== "darwin") {
    console.error(`[nightly] runs on macOS only, not ${process.platform}`);
    process.exit(1);
  }
  let args: WeeklyArgs;
  let home: string;
  try {
    args = parseWeeklyArgs(process.argv.slice(2), { uninstall: false });
    home = resolveHome({ flag: args.home, env: process.env.HOME });
  } catch (err) {
    console.error(`[nightly] ${(err as Error).message}`);
    process.exit(2);
  }
  const now = new Date();
  const { logDir } = weeklyPaths(home);
  if (args.check) {
    const verdict = checkGate(readPartResults(logDir), now);
    for (const line of verdict.lines) console.log(`[nightly] ${line}`);
    console.log(
      `[nightly] ${verdict.ok ? "PASS" : "FAIL"}: every part green within the last ${GATE_DAYS} days`
    );
    process.exit(verdict.ok ? 0 : 1);
  }
  const part = args.part ?? nextPart(readPartResults(logDir), now);
  const code = await runWeekly({
    home,
    now,
    repoUrl: args.repoUrl ?? REPO_URL,
    bun: process.execPath,
    part,
  });
  console.log(
    `[nightly] part ${part}/${NIGHTLY_PARTS} ${code === 0 ? "PASS" : "FAIL"}: ${logPathFor(logDir, now, part)}`
  );
  process.exit(code);
}
