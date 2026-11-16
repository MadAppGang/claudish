/**
 * Which magmux pane this claudish process runs in, in a magmux claudish did not
 * launch (an ambient `MAGMUX_SOCK`: `team --grid --mode interactive`, or a pane the
 * user opened by hand).
 *
 * magmux exports `MAGMUX_SOCK` and `MAGMUX_THEME` to its panes and nothing that names
 * the pane, so the pane is found by process ancestry against `list`: the pane whose
 * pid is this process or one of its ancestors. Measured (hooks spike S2-2) in both
 * layouts that matter: claudish AS the pane process (matched at depth 0) and claudish
 * as the child of a shell that stays the pane process (matched at depth 1). In both
 * the pane was 1, not 0, so nothing may assume pane 0 outside a wrap.
 *
 * One rule, two callers: the recovery banner (`recovery/magmux-ui.ts`) and the
 * interactive driver (`hooks/session/interactive-driver.ts`). Each asks `list` over
 * its own connection and hands the reply's `result` here.
 */

import { type ChildProcess, spawn } from "node:child_process";

/** How many parents the ancestry walk visits above this process. */
export const ANCESTRY_DEPTH = 6;

/** How long one `ps` run may take before it is killed and counted as no answer. */
const PS_TIMEOUT_MS = 1_000;
/** After `ps` exits, how long its last output may take to arrive. */
const PS_EXIT_DRAIN_MS = 100;

/**
 * This process and its ancestors, up to `maxDepth` parents. The pane process is a
 * login shell or the claudish launcher, and this process runs somewhere beneath it.
 * Asynchronous on purpose: callers run inside the proxy while requests are served.
 * `ps` names the binary to run (a test seam).
 */
export async function ancestorPids(maxDepth = ANCESTRY_DEPTH, ps = "ps"): Promise<Set<number>> {
  const out = new Set<number>([process.pid]);
  let pid = process.ppid;
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    out.add(pid);
    const stdout = await readParentPid(ps, pid);
    if (stdout === null) break;
    const next = Number(stdout.trim());
    if (!Number.isFinite(next) || next <= 1) break;
    pid = next;
  }
  return out;
}

/**
 * The stdout of one `ps -o ppid= -p <pid>` run, or null when it failed or gave no
 * answer in time. It answers shortly after `ps` exits and never waits for the pipe to
 * close: a process spawned at the same moment can inherit the pipe's write end (macOS
 * has no pipe2(O_CLOEXEC)) and hold it open long after `ps` is gone. A deadline that
 * depends on neither the exit nor the pipe bounds the run; on expiry `ps` is SIGKILLed
 * and its pipe released.
 */
function readParentPid(ps: string, pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let out = "";
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(null);
    }, PS_TIMEOUT_MS);
    const finish = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdout?.destroy();
      resolve(answer);
    };
    try {
      child = spawn(ps, ["-o", "ppid=", "-p", String(pid)], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        out += chunk;
      });
      child.on("error", () => finish(null));
      child.on("exit", (code) => {
        // output written just before the exit can still be in flight
        setTimeout(() => finish(code === 0 ? out : null), PS_EXIT_DRAIN_MS);
      });
    } catch {
      finish(null);
    }
  });
}

/** The panes of a `list` reply's `result`: `{panes: [...]}` or a bare array. */
export function panesOfList(result: unknown): Array<{ pane: number; pid: number | null }> {
  const raw = Array.isArray(result)
    ? result
    : Array.isArray((result as { panes?: unknown } | null | undefined)?.panes)
      ? ((result as { panes: unknown[] }).panes as unknown[])
      : [];
  const out: Array<{ pane: number; pid: number | null }> = [];
  for (const p of raw) {
    const pane = (p as { pane?: unknown } | null)?.pane;
    const pid = (p as { pid?: unknown } | null)?.pid;
    if (typeof pane === "number") out.push({ pane, pid: typeof pid === "number" ? pid : null });
  }
  return out;
}

/**
 * The pane whose process is this process or one of its ancestors, or null when
 * none is. `list` returns the reply's `result` (null when the request failed);
 * `ancestors` is a test seam.
 */
export async function findOwnPane(
  list: () => Promise<unknown>,
  ancestors: () => Promise<Set<number>> = () => ancestorPids()
): Promise<number | null> {
  let result: unknown;
  try {
    result = await list();
  } catch {
    return null;
  }
  const panes = panesOfList(result);
  if (panes.length === 0) return null;
  const mine = await ancestors();
  for (const p of panes) if (p.pid !== null && mine.has(p.pid)) return p.pane;
  return null;
}
