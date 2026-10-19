import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupSession,
  runModels,
  judgeResponses,
  getStatus,
  validateSessionPath,
  type TeamStatus,
} from "./team-orchestrator.js";

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
  --timeout <secs>    Timeout per model in seconds (default: 300)
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
  const timeout = timeoutStr ? parseInt(timeoutStr, 10) : 300;

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
  const effectiveMode = hasFlag(args, "--interactive") ? "interactive"
    : hasFlag(args, "--grid") ? "default"
    : mode;

  switch (subcommand) {
    case "run": {
      if (models.length === 0) {
        console.error("Error: --models is required");
        printHelp();
        process.exit(1);
      }
      if (effectiveMode === "json") {
        setupSession(sessionPath, models, input);
        const runStatus = await runModels(sessionPath, {
          timeout,
          onStatusChange: (id, s) => {
            process.stderr.write(`[team] ${id}: ${s.state}\n`);
          },
        });
        printStatus(runStatus);
      } else {
        const { runWithGrid } = await import("./team-grid.js");
        // G3 (#27): runWithGrid reads `mode` ("default" | "interactive"); the
        // old `interactive: true` key was never read, so --interactive and
        // --mode interactive silently ran the grid in default mode.
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
      setupSession(sessionPath, models, input);
      const status = await runModels(sessionPath, {
        timeout,
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
