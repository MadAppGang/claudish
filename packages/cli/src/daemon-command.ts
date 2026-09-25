/**
 * `claudish daemon`: Claude Code's supervisor, run behind a claudish proxy.
 *
 * `claude daemon run` is the supervisor that hosts Claude Code's background
 * sessions, the ones agent view lists and attaches to
 * (https://code.claude.com/docs/en/agent-view#the-supervisor-process). This
 * command starts a `--monitor` proxy on a fixed port and runs the supervisor as
 * its child, as the supervisor's service manager:
 *
 *   - The supervisor runs with `--origin service`. Only a `transient`
 *     supervisor, the kind a client starts on demand, exits once no client is
 *     attached; a service one stays up.
 *   - A service supervisor that finds its binary upgraded exits with code 70
 *     for its manager to start the new one, so on 70 this command starts it
 *     again. The proxy stays up across the restart.
 *   - Any other exit ends this command with the same code.
 *
 * The origins, the exit code and the reinstall wait below are read from the
 * `claude daemon` code of Claude Code 2.1.281; its help documents `run` and the
 * on-demand default, not the origins.
 *
 * Sessions reach the proxy through the `env` block of a settings file, where
 * Claude Code's docs put a base URL for background sessions
 * (https://code.claude.com/docs/en/agent-view#llm-gateway). The supervisor
 * builds a session's environment from its own, then removes each base URL
 * variable the dispatching client did not carry and keeps a carried one only
 * when it equals the supervisor's. The `ANTHROPIC_BASE_URL` given to the
 * supervisor here therefore reaches no session by itself: it is the value a
 * client's own must equal for Claude Code to forward it.
 *
 * Usage:
 *   claudish daemon --port <n> [-- <claude daemon run options>]
 */

import { type ChildProcess, spawn } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { findClaudeBinary, scrubInheritedClaudishPlaceholders } from "./claude-runner.js";
import { createProxyServer } from "./proxy-server.js";
import { signalExitCode } from "./signal-exit-code.js";
import { releaseSignalHandlers } from "./stats-buffer.js";

/**
 * The code `claude daemon run --origin service` exits with when it stops so
 * that an upgraded binary can take its place.
 */
export const SUPERVISOR_UPGRADE_EXIT = 70;

/**
 * How long a restart waits for the upgraded binary. These are the bounds
 * Claude Code uses when it restarts a supervisor while npm reinstalls it: every
 * 250 ms for 10 s, then every second up to 120 s while npm's staging directory
 * for the package was touched in the last 10 minutes. Inside the npm package it
 * does not count a file under 64 KiB as installed, taking it for npm's stub.
 */
export interface ReinstallWait {
  fastMs: number;
  fastPollMs: number;
  slowMs: number;
  slowPollMs: number;
  stagingFreshMs: number;
  stubMaxBytes: number;
}

export const CLAUDE_CODE_REINSTALL_WAIT: ReinstallWait = {
  fastMs: 10_000,
  fastPollMs: 250,
  slowMs: 120_000,
  slowPollMs: 1_000,
  stagingFreshMs: 600_000,
  stubMaxBytes: 64 * 1024,
};

const NPM_SCOPE = `${sep}node_modules${sep}@anthropic-ai${sep}`;

/** A regular, executable file, and not npm's placeholder when it lives in the npm package. */
export async function isRunnableClaudeBinary(path: string, stubMaxBytes: number): Promise<boolean> {
  try {
    const real = await realpath(path);
    const info = await stat(real);
    if (!info.isFile()) return false;
    if (real.includes(NPM_SCOPE) && info.size < stubMaxBytes) return false;
    await access(real, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether npm is reinstalling the package `binaryRealPath` belongs to: npm
 * moves the old package directory aside as `.<name>-<suffix>` next to it while
 * it installs the new one.
 */
export async function npmReinstallInProgress(
  binaryRealPath: string,
  freshMs: number
): Promise<boolean> {
  const at = binaryRealPath.indexOf(NPM_SCOPE);
  if (at === -1) return false;
  const scopeDir = binaryRealPath.slice(0, at + NPM_SCOPE.length - 1);
  const pkg = binaryRealPath.slice(at + NPM_SCOPE.length).split(sep)[0];
  if (!pkg) return false;
  let entries: Dirent[];
  try {
    entries = await readdir(scopeDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`.${pkg}-`)) continue;
    try {
      const info = await stat(join(scopeDir, entry.name));
      if (Date.now() - Math.max(info.ctimeMs, info.mtimeMs) < freshMs) return true;
    } catch {
      // Gone between the listing and the stat: npm finished with it.
    }
  }
  return false;
}

interface StartedBinary {
  path: string;
  /** Its real path when it started, which still names the npm package while the file is missing. */
  realPath: string | null;
}

/**
 * The binary to restart after an upgrade exit: the one that exited, once it is
 * runnable again, or wherever the install has moved to. Null once the wait is
 * over or `stopped()` says to give up.
 */
async function waitForRunnableBinary(
  previous: StartedBinary,
  resolveBinary: () => Promise<string | null>,
  bounds: ReinstallWait,
  stopped: () => boolean
): Promise<string | null> {
  const began = Date.now();
  let installing = false;
  for (;;) {
    if (await isRunnableClaudeBinary(previous.path, bounds.stubMaxBytes)) return previous.path;
    if (stopped()) return null;
    const elapsed = Date.now() - began;
    if (elapsed >= bounds.fastMs) {
      installing =
        elapsed < bounds.slowMs &&
        previous.realPath !== null &&
        (await npmReinstallInProgress(previous.realPath, bounds.stagingFreshMs));
      if (!installing) break;
    }
    await wait(installing ? bounds.slowPollMs : bounds.fastPollMs);
  }
  const moved = await resolveBinary();
  return moved !== null && (await isRunnableClaudeBinary(moved, bounds.stubMaxBytes))
    ? moved
    : null;
}

export interface DaemonArgs {
  port?: number;
  /** Everything after `--`, for `claude daemon run` itself. */
  supervisorArgs: string[];
}

/**
 * Parse `daemon`'s flags from the raw argv tail. Like `serve`, the flag surface
 * is fixed and does not go through the launch parser. An option this command
 * does not know is an error rather than ignored, because an ignored one reads
 * as applied: the supervisor's own options (`--json-path`, `--log-file`) go
 * after `--`.
 */
export function parseDaemonArgs(args: string[]): DaemonArgs {
  const out: DaemonArgs = { supervisorArgs: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.supervisorArgs = args.slice(i + 1);
      break;
    }
    if (a === "--port" || a === "-p") {
      const v = args[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new Error(`--port must be an integer 1-65535 (got ${v ?? "nothing"})`);
      }
      out.port = n;
    } else {
      throw new Error(`unknown argument ${a}; options for claude daemon run go after --`);
    }
  }
  return out;
}

/**
 * `claude daemon run`'s arguments. The CLI takes the last `--origin` it is
 * given, so the origin goes after the caller's options, where none of them can
 * replace it.
 */
export function supervisorArgv(supervisorArgs: string[]): string[] {
  return ["daemon", "run", ...supervisorArgs, "--origin", "service"];
}

/**
 * The supervisor's environment: claudish's own, with the proxy as the base URL.
 * First-party trust (`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`) is the
 * launcher's to grant and passes through as it arrived, as for a `--monitor`
 * session. claudish's placeholder credentials, inherited from a proxied session
 * that started this one, are removed so Claude Code never takes one for a key.
 */
export function supervisorEnv(parent: NodeJS.ProcessEnv, proxyUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, ANTHROPIC_BASE_URL: proxyUrl };
  scrubInheritedClaudishPlaceholders(env);
  return env;
}

export interface SupervisorOptions {
  /** Finds the binary for the first start, and for a restart whose binary has moved. */
  resolveBinary: () => Promise<string | null>;
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** claudish's own lines. The supervisor writes to the inherited stdout and stderr. */
  log: (line: string) => void;
  reinstallWait?: ReinstallWait;
}

export interface Supervision {
  /** Settles with the code this command exits with. */
  exitCode: Promise<number>;
  /**
   * Stop the supervisor and end the command with `128 + signum` of the first
   * signal. Each call sends the supervisor SIGTERM; `claude daemon run` shuts
   * down gracefully on the first and treats a second as a forced shutdown.
   */
  stop(signal: NodeJS.Signals): void;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  return signal ? signalExitCode(signal) : (code ?? 1);
}

/**
 * claudish's last line about the supervisor. The supervisor writes why it
 * stopped to its own log, not to stderr: a second supervisor for the same
 * config directory, for one, exits 1 with nothing on the terminal.
 */
function exitLine(code: number | null, signal: NodeJS.Signals | null, stopped: boolean): string {
  const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
  return `claude daemon run ${how}${stopped ? "" : "; `claude daemon logs` shows why"}`;
}

export function superviseClaudeDaemon(options: SupervisorOptions): Supervision {
  let child: ChildProcess | null = null;
  let stopSignal: NodeJS.Signals | null = null;
  let settle: (code: number) => void = () => {};
  const exitCode = new Promise<number>((resolve) => {
    settle = resolve;
  });

  const finish = (code: number) => {
    child = null;
    settle(stopSignal ? signalExitCode(stopSignal) : code);
  };

  const start = async (previous: StartedBinary | null): Promise<void> => {
    const binary = previous
      ? await waitForRunnableBinary(
          previous,
          options.resolveBinary,
          options.reinstallWait ?? CLAUDE_CODE_REINSTALL_WAIT,
          () => stopSignal !== null
        )
      : await options.resolveBinary();
    if (stopSignal) return finish(0);
    if (!binary) {
      options.log(
        previous
          ? `${previous.path} is not runnable after the upgrade; giving up`
          : "Claude Code CLI not found; set CLAUDE_PATH to its binary"
      );
      return finish(1);
    }
    const started: StartedBinary = {
      path: binary,
      realPath: await realpath(binary).catch(() => null),
    };
    const needsShell = process.platform === "win32" && binary.endsWith(".cmd");
    const proc = spawn(needsShell ? `"${binary}"` : binary, options.argv, {
      env: options.env,
      // Its own process group, as Claude Code starts a supervisor itself. A
      // terminal's Ctrl-C or hangup then reaches claudish alone, which passes
      // on one signal: the supervisor takes a second as a forced shutdown and
      // does not handle SIGHUP.
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
      shell: needsShell,
    });
    child = proc;
    options.log(`started claude daemon run (pid ${proc.pid ?? "unknown"})`);

    let settled = false;
    proc.once("error", (err) => {
      if (settled) return;
      settled = true;
      options.log(`could not start ${binary}: ${err.message}`);
      finish(1);
    });
    proc.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === SUPERVISOR_UPGRADE_EXIT && !stopSignal) {
        options.log("supervisor exited to upgrade; starting it again");
        child = null;
        void start(started);
        return;
      }
      options.log(exitLine(code, signal, stopSignal !== null));
      finish(exitCodeOf(code, signal));
    });
  };

  void start(null);

  return {
    exitCode,
    stop(signal) {
      stopSignal ??= signal;
      child?.kill("SIGTERM");
    },
  };
}

export async function daemonCommand(args: string[]): Promise<void> {
  let daemonArgs: DaemonArgs;
  try {
    daemonArgs = parseDaemonArgs(args);
  } catch (e) {
    console.error(`[claudish daemon] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (daemonArgs.port == null) {
    console.error("[claudish daemon] --port <n> is required");
    process.exit(1);
  }

  // A `--monitor` proxy without an advisor, the session `isPassthroughSession`
  // describes: every request reaches Anthropic as Claude Code built it.
  const proxy = await createProxyServer(
    daemonArgs.port,
    undefined, // no OpenRouter key: nothing is routed to another provider
    undefined, // no default model: each request keeps the model Claude Code chose
    true, // monitorMode
    process.env.ANTHROPIC_API_KEY, // only for a request that carries no auth of its own
    undefined,
    { passthrough: true }
  );

  // stderr, as for a launched session: stdout is shared with the supervisor.
  const log = (line: string) => console.error(`[claudish daemon] ${line}`);
  log(`proxy listening on ${proxy.url}`);
  log(`point sessions at it in a settings file: "env": { "ANTHROPIC_BASE_URL": "${proxy.url}" }`);

  const supervision = superviseClaudeDaemon({
    resolveBinary: findClaudeBinary,
    argv: supervisorArgv(daemonArgs.supervisorArgs),
    env: supervisorEnv(process.env, proxy.url),
    log,
  });

  // stats-buffer exits the process at once on SIGINT and SIGTERM, which would take
  // the proxy down while the supervisor is still shutting down, and leave nothing
  // to pass a second signal on. This command exits when the supervisor has.
  releaseSignalHandlers();
  const signals: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    process.on(signal, () => supervision.stop(signal));
  }
  // However claudish ends, the supervisor does not outlive the proxy it was
  // started with.
  process.on("exit", () => supervision.stop("SIGTERM"));

  const code = await supervision.exitCode;
  await proxy.shutdown();
  process.exit(code);
}
