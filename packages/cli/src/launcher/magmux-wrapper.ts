/**
 * Launch Claude Code inside a magmux pane, so claudish owns a surface it can
 * draw a recovery banner on.
 *
 * There is no other surface. The status line repaints on Claude Code's
 * schedule and has no input channel; stderr is firewalled precisely because a
 * stray write corrupted the TUI; an OSC-9 notification cannot render a
 * countdown; a second terminal window is platform-specific and hostile; and
 * allocating our own PTY is writing a multiplexer. A pane is the cheapest thing
 * claudish can own.
 *
 * APPLIES ONLY WHEN `interactive === true` AND stdout is a TTY AND the binary
 * resolves. `-p`, `--stdin`, `serve`, the MCP server and the `team --grid`
 * panes are untouched, by construction rather than by a flag.
 *
 * ── RISK-5, and why the launcher script exists ──────────────────────────────
 * magmux runs a pane command through the LOGIN SHELL. Measured, verbatim from
 * a live `list` reply: `"cmd": "/bin/zsh -l -c bash -c '…'"`. So a user's
 * `.zprofile` runs between claudish and Claude Code, and claudish's entire
 * contract with Claude Code travels in the environment — `ANTHROPIC_BASE_URL`
 * is the whole proxy. A profile that sets any of those variables would silently
 * take the session off the proxy.
 *
 * The mitigation is a generated script that re-exports ONLY claudish's own
 * DELTAS immediately before `exec`. Only the deltas: writing the full
 * environment to disk would put every secret the user has exported into a file.
 *
 * ── C-16, and why the exit code comes off the socket ────────────────────────
 * magmux's own exit status does not carry the pane's — measured: pane 0 exited
 * 42 while magmux stayed alive waiting for a second pane. It does announce the
 * death on the control socket (`{"type":"exit","pane":0,"exitCode":42}`), so
 * that event is the authority for the child's exit code, and it is also what
 * lets the recovery pane be closed the instant Claude Code is gone rather than
 * after its linger.
 */

import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Socket, connect as netConnect } from "node:net";
import { join } from "node:path";
import { findMagmuxBinaryOrNull } from "./magmux-binary.js";

/**
 * Variables that must NOT reach the child.
 *
 * `claude-runner.ts` spreads `...process.env` and deletes `CLAUDECODE` but not
 * `CLAUDE_CODE_CHILD_SESSION`; inherited, the pair turns transcript saving off
 * and degrades magmux's own controller to terminal-idle heuristics. Stripping
 * them here covers both the magmux process and the login shell, which is a
 * second place they could have re-entered from.
 */
export const STRIPPED_CHILD_VARS = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"] as const;

export interface MagmuxWrapInput {
  claudeBinary: string;
  claudeArgs: string[];
  /** The environment `claude-runner` built for Claude Code. */
  childEnv: Record<string, string>;
  /** What the login shell will start from. Defaults to `process.env`. */
  parentEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  interactive: boolean;
  stdoutIsTty: boolean;
  /** Overridable so a test does not need magmux installed. */
  magmuxBinary?: string | null;
  /** Overridable so a test does not write into the real temp directory. */
  tmpRoot?: string;
  pid?: number;
}

export interface MagmuxWrapPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** `/tmp/magmux-claudish-<pid>.sock` — known BEFORE magmux starts. */
  controlSocket: string;
  scriptPath: string;
  /** Start watching the control socket. Call once, after spawning. */
  watch(proc: ChildProcess): void;
  /** Claude Code's own exit code, once magmux has announced it. */
  paneExitCode(): number | null;
  /** Called when pane 0 dies, before magmux itself exits. */
  onClaudeExit(fn: (exitCode: number | null) => void): void;
  cleanup(): void;
}

/**
 * What claudish added to, changed in, or removed from the environment.
 *
 * The delta — not the whole environment — is what the launcher script carries,
 * and the difference is whether a user's API keys end up in a file on disk.
 */
export function envDeltas(
  parentEnv: NodeJS.ProcessEnv,
  childEnv: Record<string, string>
): { set: Array<[string, string]>; unset: string[] } {
  const set: Array<[string, string]> = [];
  const unset: string[] = [];
  for (const [k, v] of Object.entries(childEnv)) {
    if (STRIPPED_CHILD_VARS.includes(k as (typeof STRIPPED_CHILD_VARS)[number])) continue;
    if (parentEnv[k] !== v) set.push([k, v]);
  }
  for (const k of Object.keys(parentEnv)) {
    if (!(k in childEnv)) unset.push(k);
  }
  for (const k of STRIPPED_CHILD_VARS) {
    if (!unset.includes(k)) unset.push(k);
  }
  return { set, unset };
}

/** POSIX single-quoting. The only escaping a `'…'` string ever needs. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The script magmux's login shell sources, then `exec`s.
 *
 * Pure, so the exact bytes that will land on disk can be asserted in a test —
 * which matters because the thing being asserted is a security property (only
 * deltas) and a correctness property (the exports come AFTER the profile).
 */
export function buildLauncherScript(
  claudeBinary: string,
  claudeArgs: string[],
  deltas: { set: Array<[string, string]>; unset: string[] }
): string {
  const lines = [
    "#!/bin/sh",
    "# Generated by claudish. Re-asserts claudish's OWN environment deltas after",
    "# the login shell has run the user's profile, then hands the terminal to",
    "# Claude Code. Only deltas are written here: the full environment would put",
    "# every exported secret into a file.",
  ];
  for (const k of deltas.unset) lines.push(`unset ${k}`);
  for (const [k, v] of deltas.set) lines.push(`export ${k}=${shq(v)}`);
  lines.push(`exec ${shq(claudeBinary)} ${claudeArgs.map(shq).join(" ")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Can this launch obtain a recovery pane at all, and how?
 *
 * SIDE-EFFECT FREE — it writes nothing, spawns nothing, and may therefore be
 * asked BEFORE the child environment is finalised. That ordering is the whole
 * reason it exists as its own function: `CLAUDE_CODE_RETRY_WATCHDOG` expands
 * Claude Code's retry budget from ~11 attempts to ~300 for EVERY 503 the
 * session sees, so it may only be exported by a launch that can actually put
 * the reason on a surface. Exporting it from the UI preference alone applied
 * the accepted duplicate-request exposure (RISK-6) in `-p`, under
 * `--no-recovery`, and on machines without magmux — the configurations that
 * opted out — where it buys nothing at all.
 *
 * `wrap`    — we will start magmux ourselves and own the control socket.
 * `ambient` — already inside someone else's magmux (`team --grid`, or a user
 *             who launched claudish in a pane): nothing to wrap, but there IS a
 *             multiplexer to ask for a pane.
 * `none`    — no surface is reachable from this launch.
 */
export type MagmuxPaneCapability =
  | { kind: "wrap"; magmux: string }
  | { kind: "ambient"; sock: string }
  | { kind: "none"; reason: "not-interactive" | "no-tty" | "no-magmux" };

export function magmuxPaneCapability(
  input: Pick<MagmuxWrapInput, "interactive" | "stdoutIsTty" | "parentEnv" | "magmuxBinary">
): MagmuxPaneCapability {
  const parentEnv = input.parentEnv ?? process.env;
  if (!input.interactive) return { kind: "none", reason: "not-interactive" };
  // ALREADY INSIDE A MULTIPLEXER — do not nest one.
  //
  // `team --grid --mode interactive` launches one `claudish --model X -i` per
  // pane, and each of those is interactive with a real TTY, so without this it
  // would wrap ITSELF in a second magmux inside the grid pane it is already
  // running in — N nested multiplexers, each with its own control socket and
  // its own idea of the layout. magmux exports `MAGMUX_SOCK` to its children
  // precisely so a child can tell, and a process that finds it does not need a
  // new magmux: it already has one it can ask for a pane. The recovery UI is
  // installed against that AMBIENT socket instead, and the cross-process
  // `O_EXCL` lock in `magmux-ui.ts` is what keeps the grid to ONE banner rather
  // than N.
  //
  // Checked BEFORE the TTY gate on purpose: the ambient recovery UI has always
  // installed against an ambient socket without asking for a TTY.
  // `claude-runner.ts`'s ambient branch reads this result (`kind === "ambient"`)
  // rather than restating the rule.
  const ambient = parentEnv.MAGMUX_SOCK;
  if (ambient) return { kind: "ambient", sock: ambient };
  if (!input.stdoutIsTty) return { kind: "none", reason: "no-tty" };
  const magmux = input.magmuxBinary === undefined ? findMagmuxBinaryOrNull() : input.magmuxBinary;
  if (!magmux) return { kind: "none", reason: "no-magmux" };
  return { kind: "wrap", magmux };
}

/**
 * Build the plan, or null when this launch must not be wrapped.
 *
 * Returns null — never throws — for every "not applicable" case, because a
 * missing multiplexer means the session should launch exactly as it did before
 * this feature existed. The "not applicable" set is `magmuxPaneCapability`'s,
 * so the gate that decides the watchdog and the gate that decides the wrap
 * cannot drift apart.
 */
export function planMagmuxWrap(input: MagmuxWrapInput): MagmuxWrapPlan | null {
  const capability = magmuxPaneCapability(input);
  if (capability.kind !== "wrap") return null;
  const magmux = capability.magmux;

  const pid = input.pid ?? process.pid;
  const id = `claudish-${pid}`;
  const controlSocket = `/tmp/magmux-${id}.sock`;

  // ── 0700 UNGUESSABLE directory, 0600 O_EXCL file ──────────────────────────
  //
  // The file below is SOURCED by the login shell immediately before `exec`, and
  // it carries claudish's env deltas — on the proxy path that includes the
  // `ANTHROPIC_API_KEY` Claude Code authenticates to us with. So both halves of
  // this matter, and the previous shape got both wrong:
  //
  //   - the name was `claudish-launch-<pid>`, which is ENUMERABLE, and
  //     `mkdirSync(..., { recursive: true })` neither throws on `EEXIST` nor
  //     applies `mode` to a directory that already exists — so a directory
  //     another uid had pre-created (or symlinked elsewhere) was adopted
  //     silently, and `writeFileSync` follows an existing path. That is
  //     CWE-377/CWE-59: read the session's secrets, or swap the script between
  //     the write and the `exec`, and get code execution as the claudish user.
  //   - `writeFileSync`'s `mode` is a CREATION mode; on an existing file it is
  //     ignored, so the `chmod` was load-bearing and silent when it failed.
  //
  // `mkdtempSync` gives an unguessable name AND fails rather than adopting, and
  // `wx` is `O_CREAT | O_EXCL`, so the file cannot pre-exist as a symlink to
  // somewhere else.
  const tmpRoot = input.tmpRoot ?? "/tmp";
  mkdirSync(tmpRoot, { recursive: true });
  const scriptDir = mkdtempSync(join(tmpRoot, "claudish-launch-"));
  chmodSync(scriptDir, 0o700);
  // Named for Claude Code on purpose: magmux attaches its controller by
  // spotting `claude`/`claudish` in the pane's command.
  const scriptPath = join(scriptDir, "claude-launch.sh");

  const parentEnv = input.parentEnv ?? process.env;
  const deltas = envDeltas(parentEnv, input.childEnv);
  const fd = openSync(scriptPath, "wx", 0o600);
  try {
    writeFileSync(fd, buildLauncherScript(input.claudeBinary, input.claudeArgs, deltas));
  } finally {
    closeSync(fd);
  }

  const env: Record<string, string> = { ...input.childEnv };
  for (const k of STRIPPED_CHILD_VARS) delete env[k];
  // RISK-4: the pane replaces the emulator's native scrollback with magmux's
  // ring, which is the single most user-visible cost of wrapping by default.
  // A bigger ring does not give the emulator's selection back, but it does stop
  // the session's history from being the thing that is lost.
  if (!env.MAGMUX_SCROLLBACK) env.MAGMUX_SCROLLBACK = "10000";

  const args = [
    "--id",
    id,
    // An idle pane is a resting session, not a finished one — and with this
    // flag `-w` waits for the process to exit rather than for a turn to end,
    // which is the exact trap `headless-vs-interactive.md` records.
    "--no-idle-done",
    "-w",
    "--no-status",
    "-e",
    // Sourced, not executed: `exec` then replaces the login shell itself, so
    // the pane's process IS Claude Code rather than a shell holding it.
    `. ${shq(scriptPath)}`,
  ];

  let paneExit: number | null = null;
  const exitListeners: Array<(code: number | null) => void> = [];
  let control: Socket | null = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.removeListener("exit", cleanup);
    try {
      control?.destroy();
    } catch {
      /* already gone */
    }
    control = null;
    try {
      rmSync(scriptDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
    try {
      // magmux's startup reaper only removes PID-named sockets whose owner it
      // can prove is dead, so a `--id` socket is never reaped for us.
      if (existsSync(controlSocket)) rmSync(controlSocket, { force: true });
    } catch {
      /* already gone */
    }
  };

  // A file holding the session's `ANTHROPIC_API_KEY` must not outlive the
  // process on a SIGTERM or a crash-out — `watch()`'s `proc.exit` hook only
  // covers the ordinary path, and claudish is not always the one that dies
  // last. The listener removes itself in `cleanup` so a long-lived host
  // cannot accumulate them.
  process.on("exit", cleanup);

  return {
    command: magmux,
    args,
    env,
    controlSocket,
    scriptPath,
    paneExitCode: () => paneExit,
    onClaudeExit(fn) {
      exitListeners.push(fn);
    },
    watch(proc: ChildProcess) {
      let stopped = false;
      const attempt = async () => {
        for (let i = 0; i < 60 && !stopped; i++) {
          if (existsSync(controlSocket)) {
            try {
              const s = await new Promise<Socket>((resolve, reject) => {
                const sock = netConnect(controlSocket);
                sock.once("connect", () => resolve(sock));
                sock.once("error", reject);
              });
              control = s;
              let buf = "";
              s.on("data", (chunk: Buffer) => {
                buf += chunk.toString("utf-8");
                let nl = buf.indexOf("\n");
                while (nl >= 0) {
                  const line = buf.slice(0, nl).trim();
                  buf = buf.slice(nl + 1);
                  nl = buf.indexOf("\n");
                  if (!line) continue;
                  try {
                    const evt = JSON.parse(line) as Record<string, unknown>;
                    // Pane 0 is Claude Code: `-e` panes get ids 0..N-1 in
                    // argument order and magmux's own panes are appended after.
                    if (evt.type === "exit" && evt.pane === 0) {
                      paneExit = typeof evt.exitCode === "number" ? evt.exitCode : null;
                      for (const fn of exitListeners) fn(paneExit);
                    }
                  } catch {
                    /* not ours */
                  }
                }
              });
              s.on("error", () => {
                control = null;
              });
              return;
            } catch {
              /* magmux binds the socket a moment after the file appears */
            }
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      proc.once("exit", () => {
        stopped = true;
        cleanup();
      });
      void attempt();
    },
    cleanup,
  };
}
