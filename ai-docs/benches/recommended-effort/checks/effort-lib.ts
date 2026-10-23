/**
 * Shared by the three Checks of this Bench. Pure reading: the effort sidecar
 * claudish writes, the claudish MCP calls in the Session, and the debug logs the
 * MCP server and its children wrote into the workspace.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Cell {
  effort: string;
}

/**
 * The newest generation of `~/.claudish/cloud-models-catalog-v3.efforts.json`,
 * chosen exactly as `latestEffortRecommendations` chooses it (largest
 * `writtenAt`), so the Check grades against the table `list_models` rendered.
 */
export function newestEfforts(path = join(homedir(), ".claudish", "cloud-models-catalog-v3.efforts.json")): {
  generationId: string;
  efforts: Record<string, Record<string, Cell>>;
} {
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    generations: Record<string, { writtenAt: number; efforts: Record<string, Record<string, Cell>> }>;
  };
  const [id, gen] = Object.entries(doc.generations).sort(([, a], [, b]) => b.writtenAt - a.writtenAt)[0];
  return { generationId: id, efforts: gen.efforts };
}

/** `cx@gpt-6-astra` → `gpt-6-astra`; a bare name is returned unchanged. */
export function canonicalOf(spec: string): string {
  const at = spec.indexOf("@");
  return at >= 0 ? spec.slice(at + 1) : spec;
}

export type Tool = "team" | "create_session" | "run_prompt";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  tool_call_id?: string;
}

export interface SessionLike {
  calls?: ToolCall[];
  events?: { type?: string; tool_call_id?: string; tool_out?: unknown }[];
}

/** The text the tool returned for one call, from the Session's tool_result Events. */
export function resultText(session: SessionLike, call: ToolCall): string {
  if (!call.tool_call_id) return "";
  const ev = (session.events ?? []).find((e) => e.type === "tool_result" && e.tool_call_id === call.tool_call_id);
  const out = ev?.tool_out;
  return typeof out === "string" ? out : out === undefined ? "" : JSON.stringify(out);
}

/** claudish refused to start because no effort was passed for a model with a row. */
export function isNeedsEffort(session: SessionLike, call: ToolCall): boolean {
  return resultText(session, call).includes("needs_effort:");
}

/**
 * The start call that actually STARTED work: the LAST one whose answer is neither
 * needs_effort nor an `Error:` text (a retry after a failed run supersedes it), else
 * the last call. Also returns the needs_effort answers before it.
 * (run10 graded the FIRST non-needs_effort call; one Session then graded a run of the
 * literal family names "gpt"/"minimax" instead of the agent's working retry.)
 */
export function startedCall(session: SessionLike, tool: Tool): {
  call?: ToolCall;
  all: ToolCall[];
  needsEffortBefore: ToolCall[];
} {
  const all = startCalls(session, tool);
  const ok = (c: ToolCall) => !isNeedsEffort(session, c) && !resultText(session, c).trimStart().startsWith("Error");
  let at = -1;
  for (let i = all.length - 1; i >= 0; i--) if (ok(all[i])) { at = i; break; }
  if (at < 0) at = all.length - 1;
  return { call: all[at], all, needsEffortBefore: all.slice(0, Math.max(at, 0)).filter((c) => isNeedsEffort(session, c)) };
}

/** Every call of `mcp__claudish__<tool>` that starts work (team: mode run / run-and-judge). */
export function startCalls(session: { calls?: ToolCall[] }, tool: Tool): ToolCall[] {
  return (session.calls ?? []).filter((c) => {
    if (c.name !== `mcp__claudish__${tool}`) return false;
    if (tool !== "team") return true;
    const mode = c.args?.mode;
    return mode === "run" || mode === "run-and-judge";
  });
}

/**
 * What one start call asked for: the models it ran and the effort it passed for
 * each (undefined = no effort for that model). `efforts` arriving as a JSON string
 * is parsed and flagged, because the tool schema declares an object.
 */
export function requested(call: ToolCall, tool: Tool): {
  models: string[];
  efforts: Record<string, string | undefined>;
  note?: string;
} {
  const a = call.args ?? {};
  if (tool === "team") {
    const models = Array.isArray(a.models) ? (a.models as unknown[]).map(String) : [];
    let raw = a.efforts as unknown;
    let note: string | undefined;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
        note = "efforts arrived as a JSON string, not an object";
      } catch {
        note = `efforts is an unparseable string: ${raw}`;
        raw = undefined;
      }
    }
    const map = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const efforts: Record<string, string | undefined> = {};
    for (const m of models) efforts[m] = typeof map[m] === "string" ? (map[m] as string) : undefined;
    for (const k of Object.keys(map)) if (!models.includes(k)) efforts[k] = String(map[k]);
    return { models, efforts, note };
  }
  const model = typeof a.model === "string" ? a.model : "";
  // "default" is the needs_effort opt-out: Claude Code's own effort, i.e. none passed.
  const effort = typeof a.effort === "string" && a.effort !== "" && a.effort !== "default" ? a.effort : undefined;
  return { models: model ? [model] : [], efforts: model ? { [model]: effort } : {} };
}

export interface LogFile {
  path: string;
  lines: string[];
}

/** Every claudish debug log in `<workDir>/logs/` (the MCP server's and each child's). */
export function debugLogs(workDir: string | undefined): LogFile[] {
  if (!workDir) return [];
  const dir = join(workDir, "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("claudish_") && f.endsWith(".log"))
    .map((f) => ({ path: join(dir, f), lines: readFileSync(join(dir, f), "utf8").split("\n") }));
}

/** The `[Wire] <provider>@<model> → route · wire id: api …` lines that name this model. */
export function wireLinesFor(log: LogFile, model: string): string[] {
  const c = canonicalOf(model);
  return log.lines.filter((l) => {
    const m = l.match(/\[Wire\] ([^@\s]+)@(\S+) → \S+ · (\S+):/);
    if (!m) return false;
    const names = [m[2], m[3]];
    return names.some((n) => n === c || n === model || c.endsWith(n) || n.endsWith(c));
  });
}

/** Clip a log line for Evidence: the timestamp, the head and the matched part. */
export function clip(line: string, max = 400): string {
  return line.length <= max ? line : `${line.slice(0, max)} …(${line.length} chars)`;
}
