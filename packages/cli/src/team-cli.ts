import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installPaneShutdownHooks } from "./pane/index.js";
import {
  type TeamRunOptions,
  type TeamStatus,
  getStatus,
  judgeResponses,
  preflightTeamRun,
  runModels,
  setupSession,
  validateSessionPath,
} from "./team-orchestrator.js";

/**
 * `claudish team run|run-and-judge` (json mode) runs every slot as an interactive pane,
 * like the MCP `team` tool (they share `runModels`). The refusals come first, before
 * the session directory is written: a bad flag exits 2, a missing magmux or a full pane
 * limit exits 1. Ctrl-C (and SIGTERM / SIGHUP) reaps every pane in ≤ 3 s, then exits
 * 128 + the signal number — 130 for Ctrl-C.
 */
async function runPaneTeam(
  sessionPath: string,
  models: string[],
  input: string | undefined,
  opts: TeamRunOptions
): Promise<TeamStatus> {
  installPaneShutdownHooks({ exitAfter: true });
  try {
    await preflightTeamRun({ path: sessionPath, slots: models.length, input });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(msg.startsWith("invalid_args") ? 2 : 1);
  }
  setupSession(sessionPath, models, input);
  return runModels(sessionPath, opts);
}

// ─── Arg Parsing Helpers ─────────────────────────────────────────────────────

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

function printStatus(status: TeamStatus): void {
  const modelIds = Object.keys(status.models).sort();
  console.log(`\nTeam Status (started: ${status.startedAt})`);
  console.log("─".repeat(60));
  for (const id of modelIds) {
    const m = status.models[id];
    const duration =
      m.startedAt && m.completedAt
        ? `${Math.round((new Date(m.completedAt).getTime() - new Date(m.startedAt).getTime()) / 1000)}s`
        : m.startedAt
          ? "running"
          : "pending";
    const size = m.outputSize > 0 ? ` (${m.outputSize} bytes)` : "";
    console.log(`  ${id}  ${m.state.padEnd(10)}  ${duration}${size}`);
  }
  console.log("");
}

function printHelp(): void {
  console.log(`
Usage: claudish team <subcommand> [options]

Subcommands:
  run             Run multiple models on a task in parallel
  judge           Blind-judge existing model outputs
  run-and-judge   Run models then judge their outputs
  status          Show current session status

Options (run / run-and-judge):
  --path <dir>        Session directory (default: .)
  --models <a,b,...>  Comma-separated model IDs to run
  --input <text>      Task prompt (or create input.md in --path beforehand)
  --timeout <secs>    Grid modes only: magmux's own per-pane timeout (default: 300).
                      json mode has no deadline — nothing kills a working model.
                      json mode runs each model as an interactive pane in a headless
                      magmux (>= 0.14.0; darwin and linux).
  --grid              Show all models in a magmux grid with live output + status bar

Options (judge / run-and-judge):
  --judges <a,b,...>  Comma-separated judge model IDs (default: same as runners)

Options (status):
  --path <dir>        Session directory (default: .)

Examples:
  claudish team run --path ./review --models minimax-m2.5,kimi-k2.5 --input "Review this code"
  claudish team run --grid --models kimi-k2.5,gpt-5.4,gemini-3.1-pro --input "Solve this"
  claudish team judge --path ./review
  claudish team run-and-judge --path ./review --models gpt-5.4,gemini-3.1-pro-preview --input "Evaluate this design"
  claudish team status --path ./review
`);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export async function teamCommand(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printHelp();
    process.exit(0);
  }

  // Detect legacy subcommand (run, judge, etc.) or new streamlined syntax
  const firstArg = args[0] ?? "";
  const legacySubs = ["run", "judge", "run-and-judge", "status"];
  const subcommand = legacySubs.includes(firstArg) ? firstArg : "run";

  const rawSessionPath = getFlag(args, "--path") ?? ".";
  let sessionPath: string;
  try {
    sessionPath = validateSessionPath(rawSessionPath);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const modelsRaw = getFlag(args, "--models");
  const judgesRaw = getFlag(args, "--judges");
  const mode = (getFlag(args, "--mode") ?? "default") as "default" | "interactive" | "json";
  const timeoutStr = getFlag(args, "--timeout");
  const timeout = timeoutStr ? Number.parseInt(timeoutStr, 10) : 300;

  // Collect input: --input flag or bare positional args
  let input = getFlag(args, "--input");
  if (!input) {
    const flagsWithValues = ["--models", "--judges", "--mode", "--path", "--timeout", "--input"];
    const positionals = args.filter((a, i) => {
      if (legacySubs.includes(a) && i === 0) return false;
      if (a.startsWith("--")) return false;
      const prev = args[i - 1];
      if (prev && flagsWithValues.includes(prev)) return false;
      return true;
    });
    if (positionals.length > 0) input = positionals.join(" ");
  }

  const models = modelsRaw
    ? modelsRaw
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : [];
  const judges = judgesRaw
    ? judgesRaw
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : undefined;

  // Legacy --grid/--interactive flags map to modes
  const effectiveMode = hasFlag(args, "--interactive")
    ? "interactive"
    : hasFlag(args, "--grid")
      ? "default"
      : mode;

  switch (subcommand) {
    case "run": {
      if (models.length === 0) {
        console.error("Error: --models is required");
        printHelp();
        process.exit(1);
      }
      if (effectiveMode === "json") {
        const runStatus = await runPaneTeam(sessionPath, models, input, {
          onStatusChange: (id, s) => {
            process.stderr.write(`[team] ${id}: ${s.state}\n`);
          },
        });
        printStatus(runStatus);
      } else {
        const { runWithGrid } = await import("./team-grid.js");
        const gridStatus = await runWithGrid(sessionPath, models, input ?? "", {
          timeout,
          mode: effectiveMode === "interactive" ? "interactive" : "default",
        });
        printStatus(gridStatus);
      }
      break;
    }

    case "judge": {
      await judgeResponses(sessionPath, { judges });
      console.log(readFileSync(join(sessionPath, "verdict.md"), "utf-8"));
      break;
    }

    case "run-and-judge": {
      if (models.length === 0) {
        console.error("Error: --models is required");
        process.exit(1);
      }
      const status = await runPaneTeam(sessionPath, models, input, {
        onStatusChange: (id, s) => {
          process.stderr.write(`[team] ${id}: ${s.state}\n`);
        },
      });
      printStatus(status);
      await judgeResponses(sessionPath, { judges });
      console.log(readFileSync(join(sessionPath, "verdict.md"), "utf-8"));
      break;
    }

    case "status": {
      const statusResult = getStatus(sessionPath);
      printStatus(statusResult);
      break;
    }
  }
}
