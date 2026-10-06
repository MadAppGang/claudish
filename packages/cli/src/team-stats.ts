/**
 * Per-model live stats for team runs.
 *
 * Each child claudish process is pointed at its own token file via
 * CLAUDISH_TOKEN_FILE (see token-tracker.ts). This module reads those files and
 * renders them as a compact, colourless status line.
 *
 * Why colourless and at most a few lines: this text is consumed by a terminal
 * that already owns its own chrome, and by MCP channel notifications where ANSI
 * escapes would be rendered literally. Plain ASCII survives both.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelStatus, TeamManifest, TeamStatus } from "./team-orchestrator.js";

/** Subset of the token file (`token-tracker.ts` writeFile) that we surface. */
export interface ModelTokenStats {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
  /**
   * Cumulative input tokens billed across the session — the figure to pair with
   * `total_cost`. Never `input_tokens`, which is the CURRENT context size.
   */
  billed_input_tokens?: number;
  context_window?: number | string;
  context_left_percent?: number;
  provider_name?: string;
  model_name?: string;
  is_free?: boolean;
  is_estimated?: boolean;
  updated_at?: number;
  /**
   * Per-tool invocation counts, as the proxy counted them. The distribution,
   * not just a total — see `TokenTracker.getToolCalls`.
   */
  tool_calls?: { name?: string; count?: number }[];
}

/** Directory holding one token file per model, inside the session dir. */
export function statsDir(sessionPath: string): string {
  return join(sessionPath, "stats");
}

/** The token file a given model's child process writes to. */
export function tokenFileFor(sessionPath: string, anonId: string): string {
  return join(statsDir(sessionPath), `${anonId}.json`);
}

/**
 * Read a token file by PATH. Returns null when the child hasn't written yet.
 *
 * Path-addressed rather than port-addressed on purpose: `session-stats.ts`
 * resolves the file from `CLAUDISH_TOKEN_FILE` in the CURRENT process's
 * environment, which is the wrong file for any parent reading a CHILD's
 * accounting — team and the channel session manager both hand each child a path
 * of their own choosing.
 */
export function readTokenStatsAt(path: string): ModelTokenStats | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ModelTokenStats;
  } catch {
    // A partially-written file is expected — the child rewrites it on every
    // token update, so a read can land mid-write. Treat as "not ready yet".
    return null;
  }
}

/** Read one model's token stats. Returns null when the child hasn't written yet. */
export function readTokenStats(sessionPath: string, anonId: string): ModelTokenStats | null {
  return readTokenStatsAt(tokenFileFor(sessionPath, anonId));
}

/** `12400` → `12.4k`. Keeps the status line narrow. */
export function fmtTokens(n: number | undefined): string {
  if (!n || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** `0.0873` → `$0.087`. Free models render as `free`. */
export function fmtCost(cost: number | undefined, isFree?: boolean): string {
  if (isFree) return "free";
  if (cost === undefined || cost <= 0) return "$0";
  return `$${cost.toFixed(3)}`;
}

/** `17535` → `17.5KB`. */
export function fmtBytes(n: number): string {
  if (n <= 0) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** Short state token, fixed width so columns line up across refreshes. */
function fmtState(state: ModelStatus["state"]): string {
  switch (state) {
    case "COMPLETED":
      return "done";
    case "RUNNING":
      return "run ";
    case "FAILED":
      return "FAIL";
    case "TIMEOUT":
      return "TIME";
    case "EMPTY":
      return "EMPT";
    case "PENDING":
      return "wait";
    default:
      return "?   ";
  }
}

export interface RenderOptions {
  /** Wall-clock seconds since the run started. */
  elapsedSeconds: number;
  /** Max characters per model segment before truncating the model name. */
  modelNameWidth?: number;
}

/**
 * Render the whole run as a compact block: one header line plus one line per
 * model. No ANSI, no box drawing — safe for both a terminal and a channel frame.
 *
 * Example:
 *   team: 4 models, 2 done, 2 running, 41s, 33.9k tok, $0.108
 *     01 grok-4.5          done 17.5KB  12.4k/2.1k  $0.087
 *     02 gemini-3.6-flash  done 12.4KB   8.1k/0.9k  $0.011
 *     03 kimi-k3           run             5.1k/-   $0.004
 *     04 or@glm-5.2        run             3.2k/-   $0.006
 */
export function renderTeamStats(
  sessionPath: string,
  manifest: TeamManifest,
  status: TeamStatus,
  opts: RenderOptions
): string {
  const nameWidth = opts.modelNameWidth ?? 18;
  const ids = Object.keys(manifest.models).sort();

  let done = 0;
  let running = 0;
  let failed = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let anyFree = false;

  const rows: string[] = [];

  for (const id of ids) {
    const m = status.models[id];
    if (!m) continue;
    const model = manifest.models[id]?.model ?? "unknown";
    const stats = readTokenStats(sessionPath, id);

    if (m.state === "COMPLETED") done++;
    else if (m.state === "RUNNING" || m.state === "PENDING") running++;
    else failed++;

    const inTok = stats?.input_tokens ?? 0;
    const outTok = stats?.output_tokens ?? 0;
    totalTokens += stats?.total_tokens ?? inTok + outTok;
    totalCost += stats?.total_cost ?? 0;
    if (stats?.is_free) anyFree = true;

    const name = model.length > nameWidth ? `${model.slice(0, nameWidth - 1)}…` : model;
    const bytes = m.outputSize > 0 ? fmtBytes(m.outputSize) : "";
    const tokens = stats ? `${fmtTokens(inTok)}/${outTok > 0 ? fmtTokens(outTok) : "-"}` : "";
    const cost = stats ? fmtCost(stats.total_cost, stats.is_free) : "";

    rows.push(
      `  ${id} ${name.padEnd(nameWidth)} ${fmtState(m.state)} ` +
        `${bytes.padStart(7)} ${tokens.padStart(12)} ${cost.padStart(7)}`.trimEnd()
    );
  }

  const parts = [`${ids.length} models`];
  if (done) parts.push(`${done} done`);
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  parts.push(`${Math.round(opts.elapsedSeconds)}s`);
  if (totalTokens > 0) parts.push(`${fmtTokens(totalTokens)} tok`);
  if (totalCost > 0 || anyFree) parts.push(fmtCost(totalCost, anyFree && totalCost === 0));

  return [`team: ${parts.join(", ")}`, ...rows].join("\n");
}

/**
 * Budget for the FIRST line, measured against Claude Code 2.1.220.
 *
 * A channel frame renders in the terminal as a single row, `← claudish: <content>`,
 * with the content's newlines flattened to spaces and the whole thing clipped at
 * roughly 58 characters. Everything past that is replaced with `…` and is invisible
 * to the human — regardless of terminal width.
 *
 * The agent receives the complete multi-line body, so per-model detail is not lost;
 * it simply cannot appear in the terminal row. Therefore line 1 must carry the
 * whole story on its own and stay inside this budget.
 */
export const CHANNEL_LINE_BUDGET = 58;

/**
 * Render the compact form used for channel notifications.
 *
 * Line 1 is the human-visible summary and is kept under CHANNEL_LINE_BUDGET.
 * Line 2 carries per-model detail for the agent, which sees the full body.
 *
 * Example:
 *   team 4: 2 done 2 run · 41s · 33.9k tok · $0.108
 *   01 grok-4.5 done 17.5KB · 02 gemini done 12.4KB · 03 kimi-k3 run
 */
export function renderTeamStatsCompact(
  sessionPath: string,
  manifest: TeamManifest,
  status: TeamStatus,
  opts: RenderOptions
): string {
  const ids = Object.keys(manifest.models).sort();
  let done = 0;
  let running = 0;
  let failed = 0;
  let totalTokens = 0;
  let totalCost = 0;

  const segs: string[] = [];
  for (const id of ids) {
    const m = status.models[id];
    if (!m) continue;
    const model = manifest.models[id]?.model ?? "unknown";
    const stats = readTokenStats(sessionPath, id);

    if (m.state === "COMPLETED") done++;
    else if (m.state === "RUNNING" || m.state === "PENDING") running++;
    else failed++;

    totalTokens += stats?.total_tokens ?? 0;
    totalCost += stats?.total_cost ?? 0;

    const bits = [id, model, fmtState(m.state).trim()];
    if (m.outputSize > 0) bits.push(fmtBytes(m.outputSize));
    else if (stats?.total_tokens) bits.push(`${fmtTokens(stats.total_tokens)} tok`);
    segs.push(bits.join(" "));
  }

  // Line 1 is all the human sees. Build it densest-first so that if it still
  // overflows the budget, what survives the clip is what matters most:
  // how many finished, how long, what it cost.
  const counts: string[] = [];
  if (done) counts.push(`${done} done`);
  if (running) counts.push(`${running} run`);
  if (failed) counts.push(`${failed} fail`);

  const head = [`team ${ids.length}: ${counts.join(" ") || "starting"}`];
  head.push(`${Math.round(opts.elapsedSeconds)}s`);
  if (totalTokens > 0) head.push(`${fmtTokens(totalTokens)} tok`);
  if (totalCost > 0) head.push(fmtCost(totalCost));

  let line1 = head.join(" · ");
  if (line1.length > CHANNEL_LINE_BUDGET) {
    // Drop the model count word first — it is the least informative token.
    line1 = line1.replace(/^team \d+: /, `t${ids.length}: `);
  }

  return `${line1}\n${segs.join(" · ")}`;
}

/**
 * Write the human-tailable status file. Best-effort: a status write must never
 * take down a run.
 */
export function writeStatusFile(
  sessionPath: string,
  manifest: TeamManifest,
  status: TeamStatus,
  opts: RenderOptions
): void {
  try {
    writeFileSync(
      join(sessionPath, "status.txt"),
      `${renderTeamStats(sessionPath, manifest, status, opts)}\n`,
      "utf-8"
    );
  } catch {
    // best-effort
  }
}
