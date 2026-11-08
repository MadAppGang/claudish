// Which environment names Bun's env-file autoload sets in a directory — asked of Bun.
//
// Bun loads `.env`, `.env.local`, `.env.<NODE_ENV>` and `.env.<NODE_ENV>.local` (plus
// any `--env-file`) into `process.env` before a script runs, and marks nothing as
// coming from a file. Every claudish launch path turns that off with `--no-env-file`.
// When a process was started without it anyway (`bun <path>/claudish.cjs`,
// `bun <path>/index.ts`), claudish cannot recover the real environment, but it can
// learn which NAMES the files set, and drop those. Bun is asked rather than imitated:
// its file list and its parser differ from dotenv's and change between releases, and a
// re-implementation of either is how an earlier check was bypassed.
//
// The probe runs Bun in the same directory with an empty environment and prints the
// names it ends up with. It runs once with NODE_ENV unset and once with the current
// value, because NODE_ENV picks the file list and a `.env` may itself have set it.
// `--config=<null device>` keeps the directory's `bunfig.toml` out, so the probe runs
// no `preload` from the checkout; a bunfig can only turn the autoload off, which makes
// this answer a superset of what was loaded, the safe direction.
//
// Shared on purpose: the npm launcher requires it, and so does `src/launch-env.ts`
// (lazily, from the package's `bin/`), so there is one implementation.

const { spawnSync } = require("node:child_process");
const { devNull } = require("node:os");

const PROBE_TIMEOUT_MS = 15_000;
const PRINT_NAMES = "JSON.stringify(Object.keys(process.env))";

/** Bun's flag that turns its env-file autoload off. */
const NO_ENV_FILE_FLAG = "--no-env-file";

/** The `--env-file` arguments in Bun's own argv, so the probe loads the same files. */
function envFileArgs(execArgv) {
  const out = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if (arg.startsWith("--env-file=")) out.push(arg);
    else if (arg === "--env-file" && i + 1 < execArgv.length) out.push(arg, execArgv[++i]);
  }
  return out;
}

/** The minimal environment a probe needs to start on this platform. */
function probeBaseEnv(platform, env) {
  if (platform !== "win32") return {};
  const base = {};
  for (const key of ["SystemRoot", "SYSTEMROOT"]) if (env[key]) base[key] = env[key];
  return base;
}

/** One probe run: the names Bun's process has under `runEnv`, or null on any failure. */
function probeNames(bunPath, args, cwd, runEnv) {
  const r = spawnSync(bunPath, args, {
    cwd,
    env: runEnv,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  try {
    const parsed = JSON.parse(r.stdout.trim().split("\n").pop() || "");
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : null;
  } catch {
    return null;
  }
}

/**
 * The names Bun's env-file loading sets in `cwd` for a Bun started with `execArgv`.
 * Returns null when Bun could not answer: the caller must then fail closed.
 */
function envFileKeys({ bunPath, execArgv, cwd, env, platform = process.platform }) {
  const base = probeBaseEnv(platform, env);
  const runs = [base];
  if (env.NODE_ENV !== undefined) runs.push({ ...base, NODE_ENV: env.NODE_ENV });
  const args = [...envFileArgs(execArgv), `--config=${devNull}`, "--print", PRINT_NAMES];
  const names = new Set();
  for (const runEnv of runs) {
    const found = probeNames(bunPath, args, cwd, runEnv);
    if (found === null) return null;
    for (const name of found) if (!Object.hasOwn(runEnv, name)) names.add(name);
  }
  return [...names];
}

/** The one stderr line for names dropped because Bun's env-file autoload was on. */
function droppedByAutoloadNotice(names) {
  const them = names.length === 1 ? "it" : "them";
  return `[claudish] ignoring ${names.join(", ")}: Bun loaded this directory's env files before claudish started, so a repository may have set ${them}. claudish reads provider API keys and model settings from .env itself. Run the installed claudish command, or start Bun with ${NO_ENV_FILE_FLAG}.`;
}

/** The one stderr line when Bun could not say which names its env files set. */
function probeFailedNotice() {
  return `[claudish] Bun loaded this directory's env files before claudish started, and claudish could not tell which values came from them, so it will not start. Run the installed claudish command, or start Bun with ${NO_ENV_FILE_FLAG}.`;
}

module.exports = {
  NO_ENV_FILE_FLAG,
  envFileArgs,
  envFileKeys,
  droppedByAutoloadNotice,
  probeFailedNotice,
};
