/**
 * Hermetic environments for process-spawning pane tests (architecture §12.1). Test-only.
 *
 * The environment is built by ALLOWLIST, never by deleting from `process.env`: no
 * `ANTHROPIC_*` or provider key survives because none is listed, and `HOME`,
 * `CLAUDE_CONFIG_DIR`, `ZDOTDIR` and `XDG_CONFIG_HOME` all point into a temp dir, so
 * nothing reads or writes the real `~/.claude`, `~/.claudish` or the keychain.
 *
 * `sockRoot` is a short `/tmp/cpt-<8 hex>` so socket paths stay under 100 bytes.
 *
 * `assertNoOrphans` is the per-test no-orphan check: no process whose argv contains the
 * test's sockRoot or a session id, no process in any of the pane pgids, and no socket,
 * record or launcher dir left in sockRoot.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirNameFor } from "../../channel/parent-proof.js";
import { findMagmuxBinaryOrNull } from "../../launcher/magmux-binary.js";
import { readProcessTable } from "../process-identity.js";

export const FAKE_CHILD = join(import.meta.dir, "fake-interactive-child.ts");
export const MAGMUX = findMagmuxBinaryOrNull();
export const NO_MAGMUX_MESSAGE = "magmux not installed — not checked";

export interface PaneTestEnv {
  tmp: string;
  home: string;
  configDir: string;
  cwd: string;
  sockRoot: string;
  env: Record<string, string>;
  /** a transcript path for `uuid` in this env's config dir (F1 slug of the realpath cwd) */
  transcriptPathFor(uuid: string): string;
  cleanup(): void;
}

export function makePaneTestEnv(extra: Record<string, string> = {}): PaneTestEnv {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pane-test-")));
  const home = join(tmp, "home");
  const configDir = join(home, ".claude");
  const cwd = join(tmp, "cwd");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(tmp, "xdg"), { recursive: true });
  const sockRoot = `/tmp/cpt-${randomBytes(4).toString("hex")}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    USER: process.env.USER ?? "test",
    LOGNAME: process.env.USER ?? "test",
    LANG: "en_US.UTF-8",
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ZDOTDIR: home,
    XDG_CONFIG_HOME: join(tmp, "xdg"),
    SHELL: "/bin/zsh",
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
    CLAUDISH_BIN: FAKE_CHILD,
    CLAUDISH_PANE_ROOT: sockRoot,
    ...extra,
  };
  assertHermetic(env);
  const realCwd = realpathSync(cwd);
  return {
    tmp,
    home,
    configDir,
    cwd,
    sockRoot,
    env,
    transcriptPathFor: (uuid) =>
      join(configDir, "projects", projectDirNameFor(realCwd), `${uuid}.jsonl`),
    cleanup() {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(sockRoot, { recursive: true, force: true });
    },
  };
}

/** Fail when HOME, CLAUDE_CONFIG_DIR or ZDOTDIR resolve under the real home. */
export function assertHermetic(env: Record<string, string>): void {
  const realHome = homedir();
  for (const k of ["HOME", "CLAUDE_CONFIG_DIR", "ZDOTDIR"]) {
    const v = env[k];
    if (!v) throw new Error(`hermetic env lacks ${k}`);
    if (v === realHome || v.startsWith(`${realHome}/`))
      throw new Error(`hermetic env ${k}=${v} is under the real home ${realHome}`);
  }
}

export function newSessionUuid(): string {
  return randomUUID();
}

/** A CLAUDE_PATH wrapper that runs the fake child in "claude" mode. */
export function writeFakeClaudeWrapper(dir: string): string {
  const p = join(dir, "fake-claude");
  writeFileSync(
    p,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CHILD)} --fake-as-claude "$@"\n`,
    {
      mode: 0o755,
    }
  );
  return p;
}

export interface OrphanReport {
  processes: string[];
  files: string[];
}

export function orphanReport(o: {
  sockRoot: string;
  ids?: string[];
  pgids?: number[];
}): OrphanReport {
  const needles = [o.sockRoot, ...(o.ids ?? [])];
  const pgids = new Set((o.pgids ?? []).filter((p) => p > 1));
  const processes = readProcessTable()
    .filter((r) => r.pid !== process.pid)
    .filter((r) => needles.some((n) => r.command.includes(n)) || pgids.has(r.pgid))
    .map((r) => `${r.pid} ${r.pgid} ${r.command.slice(0, 200)}`);
  const files: string[] = [];
  if (existsSync(o.sockRoot)) {
    for (const n of readdirSync(o.sockRoot)) if (n !== "panes") files.push(n);
    if (existsSync(join(o.sockRoot, "panes")))
      for (const n of readdirSync(join(o.sockRoot, "panes"))) files.push(`panes/${n}`);
  }
  return { processes, files };
}

/** Wait up to `ms` for nothing of the test to remain; returns the last report. */
export async function waitNoOrphans(
  o: { sockRoot: string; ids?: string[]; pgids?: number[] },
  ms = 8000
): Promise<OrphanReport> {
  const end = Date.now() + ms;
  let r = orphanReport(o);
  while ((r.processes.length || r.files.length) && Date.now() < end) {
    await Bun.sleep(200);
    r = orphanReport(o);
  }
  return r;
}

/** SIGKILL anything a failed test left behind (by sockRoot / session id needles only). */
export function killLeftovers(o: { sockRoot: string; ids?: string[] }): void {
  const needles = [o.sockRoot, ...(o.ids ?? [])];
  for (const r of readProcessTable()) {
    if (r.pid === process.pid) continue;
    if (needles.some((n) => r.command.includes(n))) {
      try {
        process.kill(r.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
}
