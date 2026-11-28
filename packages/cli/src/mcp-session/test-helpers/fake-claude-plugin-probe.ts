/**
 * A stand-in `claude` for the plugin probe. Test-only. Never Claude Code.
 *
 * `writeFakeClaude(dir)` writes an executable `<dir>/fake-claude` (a shell wrapper that execs
 * this file under the running Bun with `FAKE_CLAUDE_PLAN` naming the plan, since the probe hands
 * its child an allowlisted environment) and a plan file. Point `CLAUDE_PATH` at the executable.
 * Run as a program, this file reads the plan and acts on it:
 *
 * - `ok`: prints a `system`/`init` line whose `plugins` is `lists[<real cwd>]` (or `[]`), then
 *   the synthetic `/effort` answer and a successful result with `num_turns: 0`, and exits 0, as
 *   Claude Code 2.1.332 does
 * - `assistant`: prints an `assistant` event carrying usage first, then stays alive
 * - `noinit`: prints nothing and stays alive
 * - `exit1`: exits 1 at once
 * - `malformed`: prints an init line whose `plugins` is not a list, then stays alive
 * - `hang`: prints the init line, then nothing, and stays alive
 * - `fatal`: prints the init line and an error result, and exits 1
 * - `fatalzero`: prints the init line and an error result, and exits 0
 * - `turn`: prints the init line and a successful result with `num_turns: 1`, and exits 0
 * - `model`: prints the init line and a model's assistant event, then stays alive
 * - `noresult`: prints the init line and exits 0
 * - `resultfirst`: prints a successful result, the init line and a successful result, exits 0
 * - `tworesults`: prints the init line and two successful results, and exits 0
 * - `errorthenok`: prints the init line, an error result, then a successful result, exits 0
 * - `errorzero`: prints the init line and an `error_during_execution` result with `num_turns: 0`
 *   and no `is_error`, and exits 0
 * - `nosubtype`: prints the init line and a result with `is_error: false`, `num_turns: 0` and no
 *   `subtype`, and exits 0
 * - `okexit1`: prints the init line and a successful result, and exits 1
 * - `wrapper`: starts a long-lived child in the fake's process group, holding stdout open
 *   (recorded as `descendantPid`), prints nothing, and exits 0, as a `CLAUDE_PATH` wrapper
 *   that starts Claude Code and exits early
 *
 * Every run appends one JSON line to `record`: its pid, real cwd, argv, the `--settings` file's
 * content, `ANTHROPIC_BASE_URL`, and the names of the credential variables it was given. Before
 * that, the shell wrapper's first command appends its pid (the same pid once it execs Bun) to
 * `startsFile`, so a run killed before Bun started is still named.
 */

import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeClaudeMode =
  | "ok"
  | "assistant"
  | "noinit"
  | "exit1"
  | "malformed"
  | "hang"
  | "fatal"
  | "fatalzero"
  | "turn"
  | "model"
  | "noresult"
  | "resultfirst"
  | "tworesults"
  | "errorthenok"
  | "errorzero"
  | "nosubtype"
  | "okexit1"
  | "wrapper";

export interface FakeClaudePlan {
  mode: FakeClaudeMode;
  /** The init `plugins` list per real cwd. */
  lists?: Record<string, unknown[]>;
  /**
   * Leaves out of the init list every entry whose `source` the `--settings` file's
   * `enabledPlugins` sets to false, as Claude Code would not load it.
   */
  unlessDisabled?: boolean;
  /** Where each run appends its record line. */
  record: string;
}

export interface FakeClaudeRun {
  pid: number;
  cwd: string;
  argv: string[];
  settings: unknown;
  baseUrl: string | null;
  credentialVars: string[];
  /** `wrapper` only: the long-lived child it left behind. */
  descendantPid?: number;
}

export interface FakeClaude {
  binary: string;
  planFile: string;
  recordFile: string;
  /** One pid per line, written by the wrapper's first command. */
  startsFile: string;
  /** Replaces the plan (the record file stays). */
  setPlan(plan: Omit<FakeClaudePlan, "record">): void;
  /** Every run so far, in start order. */
  runs(): FakeClaudeRun[];
  /** The pid of every run whose wrapper got to its first command, in start order. */
  starts(): number[];
}

const CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

/** Writes the fake into `dir` with an `ok` plan and no plugin lists. */
export function writeFakeClaude(dir: string): FakeClaude {
  const binary = join(dir, "fake-claude");
  const planFile = join(dir, "fake-claude-plan.json");
  const recordFile = join(dir, "fake-claude-runs.jsonl");
  const startsFile = join(dir, "fake-claude-starts.txt");
  writeFileSync(
    binary,
    `#!/bin/sh\necho $$ >> ${JSON.stringify(startsFile)}\nFAKE_CLAUDE_PLAN=${JSON.stringify(planFile)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.path)} "$@"\n`,
    { mode: 0o755 }
  );
  chmodSync(binary, 0o755);
  const setPlan = (plan: Omit<FakeClaudePlan, "record">) =>
    writeFileSync(planFile, JSON.stringify({ ...plan, record: recordFile }));
  setPlan({ mode: "ok" });
  return {
    binary,
    planFile,
    recordFile,
    startsFile,
    setPlan,
    starts() {
      let text = "";
      try {
        text = readFileSync(startsFile, "utf-8");
      } catch {
        return [];
      }
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => Number(line));
    },
    runs() {
      let text = "";
      try {
        text = readFileSync(recordFile, "utf-8");
      } catch {
        return [];
      }
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeClaudeRun);
    },
  };
}

/** Whether a process with `pid` still exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function settingsOf(argv: string[]): unknown {
  const i = argv.indexOf("--settings");
  if (i < 0) return null;
  const value = argv[i + 1] ?? "";
  try {
    return JSON.parse(value.trim().startsWith("{") ? value : readFileSync(value, "utf-8"));
  } catch {
    return "unreadable";
  }
}

function stayAlive(): void {
  setTimeout(() => process.exit(0), 60_000);
}

function main(): void {
  const plan = JSON.parse(
    readFileSync(process.env.FAKE_CLAUDE_PLAN ?? "", "utf-8")
  ) as FakeClaudePlan;
  const argv = process.argv.slice(2);
  const cwd = realpathSync(process.cwd());
  const run: FakeClaudeRun = {
    pid: process.pid,
    cwd,
    argv,
    settings: settingsOf(argv),
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
    credentialVars: CREDENTIAL_VARS.filter((k) => process.env[k] !== undefined),
  };
  if (plan.mode === "wrapper") {
    // not detached: the child stays in this process's group, holding stdout open
    const descendant = spawn("/bin/sleep", ["60"], {
      stdio: ["ignore", "inherit", "ignore"],
      env: { PATH: "/usr/bin:/bin" },
    });
    descendant.unref();
    run.descendantPid = descendant.pid;
  }
  appendFileSync(plan.record, `${JSON.stringify(run)}\n`);
  const print = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const enabled = (run.settings as { enabledPlugins?: Record<string, unknown> } | null)
    ?.enabledPlugins;
  const listed = (plan.lists?.[cwd] ?? []).filter(
    (p) => !plan.unlessDisabled || enabled?.[(p as { source: string }).source] !== false
  );
  const init = () => print({ type: "system", subtype: "init", cwd, plugins: listed });
  const result = (isError: boolean, turns: number) =>
    print({
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      num_turns: turns,
      total_cost_usd: 0,
    });
  // exit only once stdout is flushed: a pipe write can be asynchronous
  const exitAfter = (code: number) => process.stdout.write("", () => process.exit(code));
  switch (plan.mode) {
    case "errorzero":
      init();
      print({ type: "result", subtype: "error_during_execution", num_turns: 0 });
      exitAfter(0);
      break;
    case "nosubtype":
      init();
      print({ type: "result", is_error: false, num_turns: 0, total_cost_usd: 0 });
      exitAfter(0);
      break;
    case "wrapper":
      process.exit(0);
      break;
    case "hang":
      init();
      stayAlive();
      break;
    case "fatal":
    case "fatalzero":
      init();
      print({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0 });
      exitAfter(plan.mode === "fatal" ? 1 : 0);
      break;
    case "turn":
      init();
      result(false, 1);
      exitAfter(0);
      break;
    case "model":
      init();
      print({ type: "assistant", message: { model: "claude-fake", content: [] } });
      stayAlive();
      break;
    case "noresult":
      init();
      exitAfter(0);
      break;
    case "resultfirst":
      result(false, 0);
      init();
      result(false, 0);
      exitAfter(0);
      break;
    case "tworesults":
      init();
      result(false, 0);
      result(false, 0);
      exitAfter(0);
      break;
    case "errorthenok":
      init();
      result(true, 0);
      result(false, 0);
      exitAfter(0);
      break;
    case "okexit1":
      init();
      result(false, 0);
      exitAfter(1);
      break;
    case "exit1":
      process.exit(1);
      break;
    case "noinit":
      stayAlive();
      break;
    case "assistant":
      print({
        type: "assistant",
        message: { model: "claude-fake", usage: { input_tokens: 1, output_tokens: 1 } },
      });
      stayAlive();
      break;
    case "malformed":
      print({ type: "system", subtype: "init", plugins: { not: "a list" } });
      stayAlive();
      break;
    case "ok":
      init();
      print({ type: "assistant", message: { model: "<synthetic>", content: [] } });
      result(false, 0);
      exitAfter(0);
      break;
  }
}

if (import.meta.main) main();
