/**
 * Run one GitHub Actions job of this repository on this Mac with `act`, inside Docker, before a
 * tag ever reaches GitHub.
 *
 * act cannot run in a worktree (its `.git` is a file pointing outside the tree), so the script
 * builds a new repository in a temp dir holding only the current HEAD commit and the v* tags
 * merged into it, fetched from the toplevel of the current directory, and checks HEAD out there.
 * No other branch, tag or object of the source is in it, so none reaches the job container. Uncommitted edits are not in the run; the script warns when the working tree
 * has any. The clone's `origin` fetch URL is the GitHub repository (act names the repository from
 * it) and its push URL is the literal `push-disabled-by-act-local`, so nothing in the clone can
 * push anywhere.
 *
 * `--tag-case` simulates a `v*` tag push: the clone's HEAD is tagged `v0.0.0-act.base`, one new
 * commit is made (`changed`: a newline appended to the bundled recommended list or the
 * `--change` file; `unchanged`: an empty commit) and tagged `v0.0.0-act.tag`, and act receives a
 * push event for `refs/tags/v0.0.0-act.tag`. Those tags and commits exist only in the clone.
 *
 * No secret reaches act:
 * - argv carries empty `--secret-file`, `--var-file`, `--env-file` and `--input-file` files the
 *   script creates, so act reads no `.secrets`, `.vars`, `.env` or `.input` file; never `-s`,
 *   `--secret`, `--var`, `--env` or `--input`. `--container-daemon-socket -` keeps the Docker
 *   socket out of the job containers, `--rm` removes them.
 * - act's environment is an allowlist (PATH, USER, LANG, TMPDIR, DOCKER_CONTEXT); HOME and
 *   XDG_CONFIG_HOME are new empty dirs, so act reads no user actrc. DOCKER_HOST names the
 *   caller's Docker endpoint. DOCKER_CONFIG is a new dir holding only a `config.json` of `{}`, so
 *   act reads no registry credential, even when it pulls an image that is not present.
 * - Every git subprocess runs with no GIT_* variable, so a caller's GIT_DIR or GIT_WORK_TREE
 *   cannot point the clone's commands at the source repository, and with
 *   `-c core.hooksPath=/dev/null` (`git init` also with `--template=`), so no hook of the
 *   caller's runs.
 * - SIGINT, SIGTERM and SIGHUP reach act; the temp dir is removed once act has exited.
 * - Any actrc in the user's or the clone's config locations stops the run (one could add `-s`).
 * - A real run is allowed only for a job in RUNNABLE_JOBS. `--list` and `--dry-run` (act's own
 *   dry run: plans the steps, starts no container) take any job, or the whole workflow.
 * - No step here runs `git push`, `npm publish` or `gh`.
 *
 * Usage:
 *   bun scripts/act-local.ts --job <id> [--workflow <file>] [--tag-case changed|unchanged]
 *     [--change <path>] [--keep]
 *   bun scripts/act-local.ts --list [--workflow <file>]
 *   bun scripts/act-local.ts --dry-run [--job <id>] [--workflow <file>] [--tag-case ...]
 * `--workflow` is a file name under .github/workflows, default release.yml. The temp dir is
 * removed at exit unless `--keep`, which prints its path.
 * Exit: act's own exit code; 2 on a usage error or a job outside RUNNABLE_JOBS; 1 when the setup
 * fails (git, a found actrc, a missing workflow) or act cannot start.
 */

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

export const RUNNABLE_JOBS: Record<string, readonly string[]> = {
  "release.yml": ["bundled-list"],
};

export const IMAGE = "catthehacker/ubuntu:act-latest";
export const BASE_TAG = "v0.0.0-act.base";
export const CASE_TAG = "v0.0.0-act.tag";
export const ORIGIN_URL = "https://github.com/MadAppGang/claudish.git";
export const PUSH_URL = "push-disabled-by-act-local";
export const BUNDLED_LIST = "packages/cli/src/providers/bundled-recommended-list.json";

/** Caller variables act may see; everything else, every token included, stays out. */
export const ENV_ALLOWLIST = ["PATH", "USER", "LANG", "TMPDIR", "DOCKER_CONTEXT"] as const;

/** Leads every git call: no hook of the caller's (core.hooksPath) runs in the source or the clone. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

const COMMIT_IDENTITY = [
  "-c",
  "user.name=act-local",
  "-c",
  "user.email=act-local@localhost",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
];

const USAGE = [
  "usage: bun scripts/act-local.ts --job <id> [--workflow <file>] [--tag-case changed|unchanged] [--change <path>] [--keep]",
  "       bun scripts/act-local.ts --list [--workflow <file>]",
  "       bun scripts/act-local.ts --dry-run [--job <id>] [--workflow <file>] [--tag-case changed|unchanged]",
].join("\n");

export type TagCase = "changed" | "unchanged";
export type ActMode = "list" | "dry-run" | "run";

export interface ActArgs {
  job?: string;
  workflow: string;
  tagCase?: TagCase;
  change?: string;
  list: boolean;
  dryRun: boolean;
  keep: boolean;
}

const BOOL_FLAGS = { "--list": "list", "--dry-run": "dryRun", "--keep": "keep" } as const;
const VALUE_FLAGS = ["--job", "--workflow", "--tag-case", "--change"];

/** Stores one flag's value; a string is the usage error. */
function setValue(args: ActArgs, flag: string, value: string | undefined): string | null {
  switch (flag) {
    case "--job":
      if (!value) return "--job needs a job id";
      args.job = value;
      return null;
    case "--workflow":
      if (!value || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(value)) {
        return "--workflow needs a .yml file name under .github/workflows, not a path";
      }
      args.workflow = value;
      return null;
    case "--tag-case":
      if (value !== "changed" && value !== "unchanged") return "--tag-case is changed or unchanged";
      args.tagCase = value;
      return null;
    default:
      if (!value) return "--change needs a path";
      args.change = value;
      return null;
  }
}

/** The rules between flags; a string is the usage error. */
function checkArgs(args: ActArgs): string | null {
  if (args.list && args.dryRun) return "--list and --dry-run cannot be combined";
  if (args.list && args.tagCase) return "--list takes no --tag-case";
  if (!args.list && !args.dryRun && !args.job) return "--job is required for a real run";
  if (args.change === undefined) return null;
  if (args.tagCase !== "changed") return "--change needs --tag-case changed";
  const path = normalize(args.change);
  if (isAbsolute(args.change) || path === ".." || path.startsWith("../")) {
    return "--change takes a path inside the repository";
  }
  return null;
}

/** Parses the command line; a string is the usage error. */
export function parseArgs(argv: string[]): ActArgs | string {
  const args: ActArgs = { workflow: "release.yml", list: false, dryRun: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (Object.hasOwn(BOOL_FLAGS, flag)) {
      args[BOOL_FLAGS[flag as keyof typeof BOOL_FLAGS]] = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) return `unknown argument ${flag}`;
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? undefined : next;
    if (value !== undefined) i++;
    const error = setValue(args, flag, value);
    if (error) return error;
  }
  return checkArgs(args) ?? args;
}

/** Why a real run is refused, or null. `--list` and `--dry-run` start no job and are allowed. */
export function runRefusal(args: ActArgs): string | null {
  if (args.list || args.dryRun) return null;
  const allowed = RUNNABLE_JOBS[args.workflow] ?? [];
  if (args.job && allowed.includes(args.job)) return null;
  const listed = Object.entries(RUNNABLE_JOBS)
    .map(([workflow, jobs]) => `${workflow}: ${jobs.join(", ")}`)
    .join("; ");
  return `${args.workflow} job ${args.job} is not in RUNNABLE_JOBS (${listed}); use --list or --dry-run for it`;
}

export interface ActArgvOptions {
  mode: ActMode;
  workflow: string;
  job?: string;
  eventFile?: string;
  secretFile: string;
  varFile: string;
  envFile: string;
  inputFile: string;
}

/** act's argv. Every mode carries the empty secret, var, env and input files. */
export function actArgv(o: ActArgvOptions): string[] {
  const argv = o.mode === "list" ? ["-l"] : ["push"];
  if (o.mode === "dry-run") argv.push("-n");
  argv.push("-W", `.github/workflows/${o.workflow}`);
  if (o.job) argv.push("-j", o.job);
  if (o.eventFile && o.mode !== "list") argv.push("-e", o.eventFile);
  argv.push(
    "--secret-file",
    o.secretFile,
    "--var-file",
    o.varFile,
    "--env-file",
    o.envFile,
    "--input-file",
    o.inputFile,
    "--rm",
    "--container-daemon-socket",
    "-",
    "--actor",
    "act-local",
    "-P",
    `ubuntu-latest=${IMAGE}`,
    "-P",
    `ubuntu-24.04-arm=${IMAGE}`,
    "--pull=false"
  );
  return argv;
}

export interface ActEnvDirs {
  home: string;
  xdgConfigHome: string;
  dockerHost: string;
  /** A dir of the run's own (`writeEmptyDockerConfig`), never the caller's `~/.docker`. */
  dockerConfig: string;
}

/** act's environment: the allowlist from the caller, plus the dirs and Docker settings given. */
export function actEnv(
  env: Record<string, string | undefined>,
  dirs: ActEnvDirs
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  out.HOME = dirs.home;
  out.XDG_CONFIG_HOME = dirs.xdgConfigHome;
  out.DOCKER_HOST = dirs.dockerHost;
  out.DOCKER_CONFIG = dirs.dockerConfig;
  return out;
}

/**
 * The Docker endpoint act talks to. With HOME replaced by an empty dir, Docker Desktop's socket
 * under the real HOME would not be found, so it is named explicitly.
 */
export function dockerHostFor(
  env: Record<string, string | undefined>,
  realHome: string,
  exists: (path: string) => boolean
): string {
  if (env.DOCKER_HOST) return env.DOCKER_HOST;
  const desktop = join(realHome, ".docker", "run", "docker.sock");
  if (exists(desktop)) return `unix://${desktop}`;
  return "unix:///var/run/docker.sock";
}

/** Every place act reads an actrc from: the user's config locations and the project's. */
export function actrcPaths(
  realHome: string,
  env: Record<string, string | undefined>,
  repo: string
): string[] {
  const xdg = env.XDG_CONFIG_HOME || join(realHome, ".config");
  return [
    join(realHome, ".actrc"),
    join(xdg, "act", "actrc"),
    join(realHome, "Library", "Application Support", "act", "actrc"),
    join(repo, ".actrc"),
  ];
}

export function tagEvent(tag: string): { ref: string } {
  return { ref: `refs/tags/${tag}` };
}

/**
 * The environment of every git subprocess: the caller's, without any GIT_* variable. A GIT_DIR or
 * GIT_WORK_TREE set by the caller would point the clone's checkout, tag and remote commands at
 * the source repository instead of the temp clone.
 */
export function gitEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.startsWith("GIT_")) out[key] = value;
  }
  return out;
}

/**
 * Makes `dir` act's Docker config: a `config.json` holding `{}`, so act finds no registry
 * credential when it pulls an image that is not present (`--pull=false` does not stop that pull).
 */
export function writeEmptyDockerConfig(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}\n");
}

export interface ActDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  realHome: string;
  /** Runs git in `cwd` with exactly `env` and returns its stdout; throws on a non-zero exit. */
  git: (args: string[], cwd: string, env: Record<string, string>) => string;
  exists: (path: string) => boolean;
  makeTemp: () => string;
  remove: (path: string) => void;
  /** Runs act and resolves with its exit code. */
  spawnAct: (argv: string[], cwd: string, env: Record<string, string>) => Promise<number>;
}

/** git with the scrubbed environment already bound; every git call of a run goes through one. */
type Git = (args: string[], cwd: string) => string;

function defaultGit(args: string[], cwd: string, env: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** The signals passed on to act, which runs in its own process group and sees none itself. */
export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Where the signals come from: `process` in a run, an emitter in a test. */
export interface SignalSource {
  on(event: NodeJS.Signals, handler: () => void): unknown;
  off(event: NodeJS.Signals, handler: () => void): unknown;
}

/**
 * Passes every FORWARDED_SIGNALS signal `target` receives to `kill`. Returns the function that
 * removes the handlers again.
 */
export function forwardSignals(
  target: SignalSource,
  kill: (sig: NodeJS.Signals) => void
): () => void {
  const handlers = FORWARDED_SIGNALS.map((sig) => {
    const handler = () => kill(sig);
    target.on(sig, handler);
    return [sig, handler] as const;
  });
  return () => {
    for (const [sig, handler] of handlers) target.off(sig, handler);
  };
}

/**
 * Starts act in its own process group and forwards FORWARDED_SIGNALS to it, then waits for it
 * to exit, so the caller's cleanup runs after act has removed its containers.
 */
function defaultSpawnAct(
  argv: string[],
  cwd: string,
  env: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("act", argv, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    // act leads its own process group (detached), so the signal goes to the whole group.
    const detach = forwardSignals(process, (sig) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        child.kill(sig);
      }
    });
    child.on("error", (error) => {
      detach();
      reject(error);
    });
    child.on("close", (code, signal) => {
      detach();
      if (code !== null) resolve(code);
      else resolve(128 + ((signal && osConstants.signals[signal]) || 1));
    });
  });
}

function defaultDeps(): ActDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    realHome: homedir(),
    git: defaultGit,
    exists: existsSync,
    makeTemp: () => mkdtempSync(join(tmpdir(), "claudish-act-")),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    spawnAct: defaultSpawnAct,
  };
}

/**
 * Builds `repo` from the toplevel's commit `sha` and the v* tags merged into it, nothing else:
 * no other branch, tag or object of the source reaches the job container, where any of them
 * could be read. `git init --template=` copies no hook from a template dir. A fetch by sha the
 * local transport refuses falls back to the source's HEAD, which must then be `sha`. The remote
 * is pointed at GitHub (act names the repository from it) with pushes disabled.
 */
function prepareClone(git: Git, cwd: string, toplevel: string, sha: string, repo: string): void {
  git(["init", "--quiet", "--template=", repo], cwd);
  try {
    git(["fetch", "--quiet", "--no-tags", toplevel, sha], repo);
  } catch {
    git(["fetch", "--quiet", "--no-tags", toplevel, "HEAD"], repo);
    const fetched = git(["rev-parse", "FETCH_HEAD"], repo);
    if (fetched !== sha) throw new Error(`the source's HEAD is ${fetched}, not ${sha}`);
  }
  const tags = git(["tag", "--merged", sha, "--list", "v*"], cwd)
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (tags.length > 0) {
    git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        toplevel,
        ...tags.map((t) => `refs/tags/${t}:refs/tags/${t}`),
      ],
      repo
    );
  }
  git(["checkout", "--quiet", "--detach", sha], repo);
  git(["remote", "add", "origin", ORIGIN_URL], repo);
  git(["remote", "set-url", "--push", "origin", PUSH_URL], repo);
}

/** Tags HEAD as the base, makes the case commit, tags it, and writes the push event file. */
function prepareTagCase(
  git: Git,
  exists: (path: string) => boolean,
  repo: string,
  work: string,
  tagCase: TagCase,
  change: string
): string {
  git([...COMMIT_IDENTITY, "tag", BASE_TAG, "HEAD"], repo);
  if (tagCase === "changed") {
    const target = join(repo, change);
    if (!exists(target)) throw new Error(`${change} does not exist in the commit`);
    appendFileSync(target, "\n");
    git(["add", "--", change], repo);
    git([...COMMIT_IDENTITY, "commit", "--quiet", "-m", `act-local: change ${change}`], repo);
  } else {
    git(
      [...COMMIT_IDENTITY, "commit", "--quiet", "--allow-empty", "-m", "act-local: no change"],
      repo
    );
  }
  git([...COMMIT_IDENTITY, "tag", CASE_TAG, "HEAD"], repo);
  const eventFile = join(work, "event.json");
  writeFileSync(eventFile, `${JSON.stringify(tagEvent(CASE_TAG))}\n`);
  return eventFile;
}

interface WorkLayout {
  repo: string;
  home: string;
  xdgConfigHome: string;
  dockerConfig: string;
  files: { secretFile: string; varFile: string; envFile: string; inputFile: string };
}

/** Makes the empty HOME, XDG_CONFIG_HOME, Docker config and the four empty files act is pointed at. */
function layoutWork(work: string): WorkLayout {
  const empty = join(work, "empty");
  const layout: WorkLayout = {
    repo: join(work, "repo"),
    home: join(work, "home"),
    xdgConfigHome: join(work, "xdg-config"),
    dockerConfig: join(work, "docker-config"),
    files: {
      secretFile: join(empty, "secrets"),
      varFile: join(empty, "vars"),
      envFile: join(empty, "env"),
      inputFile: join(empty, "inputs"),
    },
  };
  for (const dir of [layout.home, layout.xdgConfigHome, empty]) mkdirSync(dir, { recursive: true });
  for (const file of Object.values(layout.files)) writeFileSync(file, "");
  writeEmptyDockerConfig(layout.dockerConfig);
  return layout;
}

/** Everything after the temp dir exists: clone, checks, tag case, act. Returns the exit code. */
async function runInWork(
  args: ActArgs,
  deps: ActDeps,
  git: Git,
  source: { toplevel: string; sha: string },
  work: string
): Promise<number> {
  const { repo, home, xdgConfigHome, dockerConfig, files } = layoutWork(work);
  try {
    prepareClone(git, deps.cwd, source.toplevel, source.sha, repo);
  } catch (error) {
    console.error(`act-local: could not clone ${source.toplevel}: ${(error as Error).message}`);
    return 1;
  }
  console.error(`act-local: running ${source.sha} from ${source.toplevel}`);

  const found = actrcPaths(deps.realHome, deps.env, repo).filter((p) => deps.exists(p));
  if (found.length > 0) {
    console.error(
      `act-local: refused: an actrc can add flags such as -s; remove it first: ${found.join(", ")}`
    );
    return 1;
  }
  if (!deps.exists(join(repo, ".github", "workflows", args.workflow))) {
    console.error(`act-local: .github/workflows/${args.workflow} does not exist in ${source.sha}`);
    return 1;
  }

  let eventFile: string | undefined;
  if (args.tagCase) {
    try {
      eventFile = prepareTagCase(
        git,
        deps.exists,
        repo,
        work,
        args.tagCase,
        args.change ?? BUNDLED_LIST
      );
    } catch (error) {
      console.error(`act-local: could not make the tag case: ${(error as Error).message}`);
      return 1;
    }
    console.error(
      `act-local: tag case ${args.tagCase}: ${BASE_TAG} -> ${CASE_TAG}, in the clone only`
    );
  }

  const mode: ActMode = args.list ? "list" : args.dryRun ? "dry-run" : "run";
  const actArgs = actArgv({ mode, workflow: args.workflow, job: args.job, eventFile, ...files });
  const env = actEnv(deps.env, {
    home,
    xdgConfigHome,
    dockerHost: dockerHostFor(deps.env, deps.realHome, deps.exists),
    dockerConfig,
  });
  console.error(`act-local: act ${actArgs.join(" ")}`);

  let code: number;
  try {
    code = await deps.spawnAct(actArgs, repo, env);
  } catch (error) {
    console.error(`act-local: act could not start: ${(error as Error).message}`);
    return 1;
  }
  console.log(`act-local: act exited ${code}`);
  return code;
}

export async function runActLocal(argv: string[], deps: ActDeps = defaultDeps()): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(`act-local: ${args}`);
    console.error(USAGE);
    return 2;
  }
  const refused = runRefusal(args);
  if (refused) {
    console.error(`act-local: refused: ${refused}`);
    return 2;
  }

  const scrubbed = gitEnv(deps.env);
  const git: Git = (gitArgs, cwd) => deps.git([...NO_HOOKS, ...gitArgs], cwd, scrubbed);
  let source: { toplevel: string; sha: string };
  try {
    source = {
      toplevel: git(["rev-parse", "--show-toplevel"], deps.cwd),
      sha: git(["rev-parse", "HEAD"], deps.cwd),
    };
    if (git(["status", "--porcelain"], deps.cwd) !== "") {
      console.error(
        "act-local: the working tree has uncommitted changes; they are NOT in the run, only the commit is"
      );
    }
  } catch (error) {
    console.error(`act-local: not in a git repository: ${(error as Error).message}`);
    return 1;
  }

  const work = deps.makeTemp();
  try {
    return await runInWork(args, deps, git, source, work);
  } finally {
    if (args.keep) console.error(`act-local: kept ${work}`);
    else deps.remove(work);
  }
}

if (import.meta.main) {
  process.exit(await runActLocal(process.argv.slice(2)));
}
