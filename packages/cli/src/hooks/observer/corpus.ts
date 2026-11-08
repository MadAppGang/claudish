/**
 * Offline divergence corpus builder.
 *
 * Replays recorded Claude Code transcripts to find where a behavior rule would
 * have fired, WITHOUT any live traffic. This exists so the observer can be tuned
 * against real evidence instead of guesses — the risk with any "add an LLM to
 * watch things" design is that it gets built before anyone knows what it should
 * be watching for.
 *
 * The corpus is LABELLED, which is the useful part. Transcripts do not persist
 * system reminders, so the assigned plan path cannot be recovered the way the
 * live layer recovers it. But Claude Code records the ground truth directly on
 * the ExitPlanMode tool result:
 *
 *   toolUseResult: { plan: null, filePath: "/Users/…/plans/<slug>.md" }
 *
 * `filePath` is the path CC actually read, and `plan: null` means it found
 * nothing there. So every replayed session is known-good or known-degraded with
 * no inference at all.
 */

import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Divergence {
  transcript: string;
  timestamp?: string;
  model?: string;
  ruleId: string;
  /** The plan file Claude Code actually read. */
  assignedPath: string;
  /** Plan-dir paths the model wrote to instead, if any. */
  observedPaths: string[];
  /** Ground truth from the tool result: did CC end up with a plan? */
  outcome: "degraded" | "ok";
}

const RULE_ID = "plan-mode/plan-file-path";

function directoryOf(filePath: string): string | undefined {
  const slash = filePath.lastIndexOf("/");
  return slash > 0 ? filePath.slice(0, slash) : undefined;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/** File paths targeted by write-ish tool calls in a single transcript row. */
function writeTargetsOf(row: any): string[] {
  const content = row?.message?.content;
  if (!Array.isArray(content)) return [];
  const paths: string[] = [];
  for (const block of content) {
    if (block?.type !== "tool_use" || !WRITE_TOOLS.has(block.name)) continue;
    const p = block.input?.file_path;
    if (typeof p === "string") paths.push(p);
  }
  return paths;
}

/** Replay one transcript. Returns one record per ExitPlanMode call it contains. */
export function replayTranscript(file: string): Divergence[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (!text.includes("ExitPlanMode")) return [];

  const out: Divergence[] = [];
  const planWrites: string[] = [];
  // The ExitPlanMode RESULT is a user-role row and carries no model, so the
  // attribution has to come from the most recent assistant row before it.
  let lastModel: string | undefined;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row?.message?.role === "assistant" && typeof row?.message?.model === "string") {
      lastModel = row.message.model;
    }

    planWrites.push(...writeTargetsOf(row));

    const record = divergenceOf(row, file, planWrites, lastModel);
    if (record) out.push(record);
  }

  return out;
}

/**
 * Turn an ExitPlanMode tool-result row into a labelled record.
 * Returns null for any row that is not one.
 */
function divergenceOf(
  row: any,
  file: string,
  planWrites: string[],
  lastModel: string | undefined
): Divergence | null {
  const result = row?.toolUseResult;
  if (!result || typeof result !== "object") return null;
  if (!("plan" in result) || typeof result.filePath !== "string") return null;

  const assignedPath: string = result.filePath;
  const planDir = directoryOf(assignedPath);
  const observedPaths = planDir
    ? [...new Set(planWrites.filter((p) => directoryOf(p) === planDir && p !== assignedPath))]
    : [];

  return {
    transcript: file,
    timestamp: row?.timestamp,
    model: row?.message?.model ?? lastModel,
    ruleId: RULE_ID,
    assignedPath,
    observedPaths,
    outcome: result.plan === null ? "degraded" : "ok",
  };
}

/** Every `*.jsonl` under ~/.claude/projects, newest-first is not required. */
function listTranscripts(root: string): string[] {
  const files: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return files;
  }
  for (const project of projects) {
    const dir = join(root, project);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl")) files.push(join(dir, f));
      }
    } catch {
      // Unreadable project dir is not worth failing the whole scan over.
    }
  }
  return files;
}

export interface CorpusResult {
  scanned: number;
  records: Divergence[];
  outputPath?: string;
}

/**
 * Scan recorded transcripts and optionally append the findings to
 * ~/.claudish/behavior-divergences.jsonl.
 */
export function buildCorpus(
  options: {
    projectsRoot?: string;
    outputPath?: string;
    write?: boolean;
  } = {}
): CorpusResult {
  const root = options.projectsRoot ?? join(homedir(), ".claude", "projects");
  const files = listTranscripts(root);

  const records: Divergence[] = [];
  for (const f of files) records.push(...replayTranscript(f));

  if (options.write && records.length > 0) {
    const outputPath =
      options.outputPath ?? join(homedir(), ".claudish", "behavior-divergences.jsonl");
    try {
      appendFileSync(outputPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
      return { scanned: files.length, records, outputPath };
    } catch {
      // Corpus building is a diagnostic convenience; failing to persist it must
      // not be treated as an error by callers.
    }
  }

  return { scanned: files.length, records };
}
