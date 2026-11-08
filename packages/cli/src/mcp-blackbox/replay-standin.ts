/**
 * Stand-in `claude` binary and scenario wrapper generator for `replay.blackbox.test.ts`.
 *
 * The replay pane environment allowlist removes every `FAKE_*` variable by design, so
 * `writeStandinWrapper` embeds the scenario configuration JSON and output directory path
 * directly in the generated executable wrapper script passed as `CLAUDE_PATH`.
 *
 * When invoked directly with `--standin-config <configPath>`, this file acts as the
 * stand-in `claude` process:
 *   1. Records its exact `pid`, `argv`, `env`, and `cwd` (realpath) to `<outDir>/spawn-<n>.json`.
 *   2. Optionally traps and ignores `SIGTERM` and `SIGHUP`.
 *   3. Optionally writes `<CLAUDE_CONFIG_DIR>/projects/<slug>/<--session-id>.jsonl`.
 *   4. Puts `process.stdin` in raw mode and appends every stdin byte to `<outDir>/stdin-<n>.bin`.
 *   5. Executes the requested screen scenario on the alternate screen (`\x1b[?1049h`):
 *      - `box`: draws history rows (up to 60 rows, scrollable 1 row per wheel event
 *        `ESC[<64;1;1M` / `ESC[<65;1;1M` and returning to bottom on ctrl-End `ESC[1;5F`),
 *        followed by the input box (`─` rule row, `❯ ` prompt row, `─` rule row) with
 *        the terminal cursor positioned on the prompt row (`col 3`).
 *      - `dialog`: draws `Is this a project you created or one you trust` and
 *        `Yes, I trust this folder` with no input box.
 *      - `quoted_trust_then_box`: draws conversation text quoting the trust words, followed
 *        by a valid input box so the gate sees a ready REPL, not a dialog.
 *      - `hang_before_box`: draws nothing (or partial non-box text) for `delayMs` while
 *        optionally trapping `SIGTERM`/`SIGHUP`.
 *      - `exit`: exits with `exitCode` immediately or after `delayMs` (before or after drawing box).
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type StandinScenarioKind =
  | "box"
  | "dialog"
  | "quoted_trust_then_box"
  | "hang_before_box"
  | "exit_before_box"
  | "box_then_exit";

export interface StandinScenario {
  kind: StandinScenarioKind;
  /** Delay in ms before drawing the box/dialog or exiting. */
  delayMs?: number;
  /** Exit code for exit scenarios (default 1 for exit_before_box, 0 for box_then_exit). */
  exitCode?: number;
  /** Number of history lines above the input box (default 60). */
  historyLines?: number;
  /** Marker text drawn on the last history line so tests can assert the session's end was drawn. */
  endMarker?: string;
  /** Write `<CLAUDE_CONFIG_DIR>/projects/<slug>/<--session-id>.jsonl` when spawned. */
  writeForkRecord?: boolean;
  /** Trap and ignore SIGTERM and SIGHUP. */
  trapSignals?: boolean;
  /** Respond to SIGWINCH by redrawing the box at the new terminal size. */
  redrawOnResize?: boolean;
}

export interface StandinSpawnRecord {
  index: number;
  pid: number;
  ppid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdinLogPath: string;
  forkRecordPath: string | null;
  startedAt: number;
}

export interface StandinHarness {
  outDir: string;
  wrapperPath: string;
  /** Read all spawn records written so far, sorted by index. */
  spawns(): StandinSpawnRecord[];
  /** Read raw stdin bytes received by spawn `index` (default: latest spawn). */
  stdinBytes(index?: number): string;
  /** Update the scenario used by subsequent spawns. */
  setScenario(scenario: StandinScenario): void;
}

const SELF_PATH = fileURLToPath(import.meta.url);

export function slugOfCwd(cwd: string): string {
  return realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

export function createStandinHarness(baseDir: string, initial: StandinScenario): StandinHarness {
  const outDir = join(baseDir, "standin-" + Math.random().toString(16).slice(2, 10));
  mkdirSync(outDir, { recursive: true });
  const configPath = join(outDir, "scenario.json");
  const wrapperPath = join(outDir, "claude-standin.sh");

  const setScenario = (scenario: StandinScenario): void => {
    writeFileSync(configPath, JSON.stringify({ outDir, scenario }, null, 2));
  };
  setScenario(initial);

  const script = [
    "#!/bin/sh",
    `exec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(SELF_PATH)} --standin-config ${JSON.stringify(configPath)} "$@"`,
    "",
  ].join("\n");
  writeFileSync(wrapperPath, script, { mode: 0o755 });
  chmodSync(wrapperPath, 0o755);

  function spawns(): StandinSpawnRecord[] {
    if (!existsSync(outDir)) return [];
    return readdirSync(outDir)
      .filter((f) => /^spawn-\d+\.json$/.test(f))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(outDir, f), "utf8")) as StandinSpawnRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is StandinSpawnRecord => r !== undefined)
      .sort((a, b) => a.index - b.index);
  }

  function stdinBytes(index?: number): string {
    const list = spawns();
    const target = index !== undefined ? list.find((s) => s.index === index) : list.at(-1);
    if (!target || !existsSync(target.stdinLogPath)) return "";
    return readFileSync(target.stdinLogPath, "utf8");
  }

  return { outDir, wrapperPath, spawns, stdinBytes, setScenario };
}

// ---------------------------------------------------------------------------
// Stand-in child entrypoint when invoked via `--standin-config <path>`
// ---------------------------------------------------------------------------

if (process.argv[2] === "--standin-config") {
  const configPath = process.argv[3]!;
  const claudeArgv = process.argv.slice(4);
  await runStandinChild(configPath, claudeArgv);
}

async function runStandinChild(configPath: string, argv: string[]): Promise<void> {
  const { outDir, scenario } = JSON.parse(readFileSync(configPath, "utf8")) as {
    outDir: string;
    scenario: StandinScenario;
  };

  if (scenario.trapSignals) {
    process.on("SIGTERM", () => {});
    process.on("SIGHUP", () => {});
  }

  // Claim a unique spawn index atomically enough for sequential/concurrent opens in one test.
  const existing = readdirSync(outDir).filter((f) => /^spawn-\d+\.json$/.test(f)).length;
  const index = existing + 1 + Math.floor(Math.random() * 1000) * 0;
  let chosenIndex = index;
  while (existsSync(join(outDir, `spawn-${chosenIndex}.json`))) {
    chosenIndex++;
  }

  const stdinLogPath = join(outDir, `stdin-${chosenIndex}.bin`);
  writeFileSync(stdinLogPath, "");

  const cwd = realpathSync(process.cwd());
  let forkRecordPath: string | null = null;
  const sessionIdIdx = argv.indexOf("--session-id");
  const forkId = sessionIdIdx >= 0 ? argv[sessionIdIdx + 1] : undefined;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (scenario.writeForkRecord && forkId && configDir) {
    const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
    forkRecordPath = join(configDir, "projects", slug, `${forkId}.jsonl`);
    mkdirSync(dirname(forkRecordPath), { recursive: true });
    writeFileSync(
      forkRecordPath,
      JSON.stringify({
        type: "user",
        sessionId: forkId,
        message: { role: "user", content: "fork" },
      }) + "\n"
    );
  }

  const envCopy: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) envCopy[k] = v;
  }

  const record: StandinSpawnRecord = {
    index: chosenIndex,
    pid: process.pid,
    ppid: process.ppid,
    argv,
    env: envCopy,
    cwd,
    stdinLogPath,
    forkRecordPath,
    startedAt: Date.now(),
  };
  writeFileSync(join(outDir, `spawn-${chosenIndex}.json`), JSON.stringify(record, null, 2));

  // Set up raw stdin and scroll state
  const totalHistory = scenario.historyLines ?? 60;
  const endMarker = scenario.endMarker ?? "REPLAY-END-MARKER";
  const history: string[] = [];
  for (let i = 1; i <= totalHistory; i++) {
    const suffix = i === totalHistory ? ` ${endMarker}` : "";
    history.push(`HISTORY-ROW-${String(i).padStart(2, "0")}${suffix}`);
  }
  let scrollOffset = 0; // 0 = at bottom (newest rows visible), >0 = scrolled up by scrollOffset rows
  let lastWheelDir: "up" | "down" | null = null;
  let boxActive = false;

  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
  } catch {
    // ignore if not a tty
  }
  process.stdin.resume();

  // Bun's process.stdout.columns/rows may not update on SIGWINCH in a non-interactive
  // child or may report 0; read `stty size` from the controlling tty (/dev/tty or fd 0)
  // before falling back to process.stdout and env vars.
  const readTtyDims = (): { cols: number; rows: number } | undefined => {
    try {
      const res = Bun.spawnSync(["stty", "size"], {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "ignore",
      });
      if (res.exitCode === 0) {
        const parts = res.stdout.toString().trim().split(/\s+/);
        const r = Number.parseInt(parts[0] ?? "", 10);
        const c = Number.parseInt(parts[1] ?? "", 10);
        if (r > 0 && c > 0) return { cols: c, rows: r };
      }
    } catch {
      // fall back
    }
    return undefined;
  };

  let cachedDims = readTtyDims();

  const dims = (): { cols: number; rows: number } => {
    const cols = cachedDims?.cols || process.stdout.columns || Number(process.env.COLUMNS) || 160;
    const rows = cachedDims?.rows || process.stdout.rows || Number(process.env.LINES) || 50;
    return { cols: Math.max(20, cols), rows: Math.max(10, rows) };
  };

  const renderBox = (quoteTrustInHistory = false): void => {
    const { cols, rows } = dims();
    const rule = "─".repeat(cols);
    const viewHeight = Math.max(1, rows - 4); // leave 3 rows at bottom for input box + 1 status line
    const maxOffset = Math.max(0, history.length - viewHeight);
    if (scrollOffset > maxOffset) scrollOffset = maxOffset;
    if (scrollOffset < 0) scrollOffset = 0;

    const endIdx = history.length - scrollOffset;
    const startIdx = Math.max(0, endIdx - viewHeight);
    const visible = history.slice(startIdx, endIdx);
    if (quoteTrustInHistory && visible.length >= 2) {
      visible[0] = "Quoted: Is this a project you created or one you trust";
      visible[1] = "Quoted: Yes, I trust this folder";
    }

    let out = "\x1b[?1049h\x1b[2J\x1b[H";
    for (let r = 0; r < viewHeight; r++) {
      const line = (visible[r] ?? "").slice(0, cols);
      out += `\x1b[${r + 1};1H${line}`;
    }
    const topRuleRow = rows - 3;
    const promptRow = rows - 2;
    const bottomRuleRow = rows - 1;
    const statusRow = rows;
    out += `\x1b[${topRuleRow};1H${rule}`;
    out += `\x1b[${promptRow};1H❯ `;
    out += `\x1b[${bottomRuleRow};1H${rule}`;
    out += `\x1b[${statusRow};1Hstatus: offset=${scrollOffset} cols=${cols} rows=${rows}`;
    // Place terminal cursor on the prompt row right after `❯ `
    out += `\x1b[${promptRow};3H`;
    process.stdout.write(out);
  };

  const renderDialog = (): void => {
    let out = "\x1b[?1049h\x1b[2J\x1b[H";
    out += "\x1b[2;1HIs this a project you created or one you trust\r\n";
    out += "\x1b[4;1H❯ 1. Yes, I trust this folder\r\n";
    out += "\x1b[5;1H  2. No, exit\r\n";
    process.stdout.write(out);
  };

  const esc = String.fromCharCode(0x1b);
  const wheelUpSeq = `${esc}[<64;1;1M`;
  const wheelDownSeq = `${esc}[<65;1;1M`;
  const ctrlEndSeq = `${esc}[1;5F`;
  const tokenPattern = `${esc}\\[<64;1;1M|${esc}\\[<65;1;1M|${esc}\\[1;5F`;

  let inputBuffer = "";
  process.stdin.on("data", (chunk: Buffer) => {
    appendFileSync(stdinLogPath, chunk);
    if (!boxActive) return;
    inputBuffer += chunk.toString("utf8");
    const tokenRe = new RegExp(tokenPattern, "g");
    let changed = false;
    for (const match of inputBuffer.matchAll(tokenRe)) {
      const seq = match[0];
      if (seq === wheelUpSeq) {
        // Real Claude Code moves 0 rows on the first wheel event after leaving the live
        // bottom or after a change of direction, and 1 row on every subsequent event.
        if (lastWheelDir !== "up") {
          lastWheelDir = "up";
        } else {
          scrollOffset += 1;
          changed = true;
        }
      } else if (seq === wheelDownSeq) {
        if (lastWheelDir !== "down") {
          lastWheelDir = "down";
        } else {
          scrollOffset = Math.max(0, scrollOffset - 1);
          changed = true;
        }
      } else if (seq === ctrlEndSeq) {
        scrollOffset = 0;
        lastWheelDir = null;
        changed = true;
      }
    }
    // Keep only a trailing partial escape sequence if any
    const lastEsc = inputBuffer.lastIndexOf(esc);
    if (lastEsc >= 0 && lastEsc > inputBuffer.length - 12) {
      const tail = inputBuffer.slice(lastEsc);
      if (!new RegExp(tokenPattern).test(tail)) {
        inputBuffer = tail;
      } else {
        inputBuffer = "";
      }
    } else {
      inputBuffer = "";
    }
    if (changed) {
      renderBox(scenario.kind === "quoted_trust_then_box");
    }
  });

  if (scenario.redrawOnResize !== false) {
    process.on("SIGWINCH", () => {
      cachedDims = readTtyDims();
      if (boxActive) {
        renderBox(scenario.kind === "quoted_trust_then_box");
      }
    });
  }

  // Enter the alternate screen immediately so magmux sees an active alt-screen surface
  // before any delayed box/dialog/exit scenario runs.
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");

  const delayMs = scenario.delayMs ?? 0;
  if (delayMs > 0 && scenario.kind !== "box_then_exit") {
    await Bun.sleep(delayMs);
  }

  switch (scenario.kind) {
    case "exit_before_box": {
      process.exit(scenario.exitCode ?? 1);
      break;
    }
    case "dialog": {
      renderDialog();
      await new Promise(() => {});
      break;
    }
    case "hang_before_box": {
      process.stdout.write("\x1b[?1049h\x1b[2J\x1b[Hbooting replay...\r\n");
      await new Promise(() => {});
      break;
    }
    case "quoted_trust_then_box": {
      boxActive = true;
      renderBox(true);
      await new Promise(() => {});
      break;
    }
    case "box_then_exit": {
      boxActive = true;
      renderBox(false);
      await Bun.sleep(delayMs > 0 ? delayMs : 300);
      process.exit(scenario.exitCode ?? 0);
      break;
    }
    default: {
      boxActive = true;
      renderBox(false);
      await new Promise(() => {});
      break;
    }
  }
}
