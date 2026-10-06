import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Socket, connect as netConnect } from "node:net";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { findMagmuxBinary } from "./launcher/magmux-binary.js";
import {
  type RouteExplanation,
  describeRouteExplanation,
  explainRoute,
} from "./providers/routing-rules.js";
import {
  type ModelStatus,
  type TeamManifest,
  type TeamStatus,
  setupSession,
} from "./team-orchestrator.js";

// ─── Routing Resolution ──────────────────────────────────────────────────────

/**
 * A pane's route line: the hops a request for the model would use, then where
 * the chain came from, worded by `describeRouteExplanation` exactly as
 * `--probe` and the config TUI word it. Pure over one `explainRoute` decision,
 * the decision a pane's own `claudish --model` makes when it routes.
 *
 * This file used to match the rules itself: project then global, with a
 * prefix/suffix test instead of the router's longest glob, and a last step that
 * read a built-in table that no longer exists. It named rules the router did
 * not pick and showed no chain at all for a model the catalog routes.
 */
export function paneRouteLine(explanation: RouteExplanation): string {
  const origin = describeRouteExplanation(explanation);
  if (explanation.outcome.kind === "no-route") {
    return `no route — ${explanation.outcome.reason}  (${origin})`;
  }
  if (explanation.native) return `${explanation.native.displayName}  (${origin})`;
  const hops = explanation.candidates
    .filter((candidate) => candidate.outcome === "kept")
    .map((candidate) => candidate.displayName);
  return `${hops.join(" → ")}  (${origin})`;
}

/**
 * Every model's route line, resolved BEFORE the grid file is written:
 * `buildPaneHeader` is synchronous and `explainRoute` is not. An error becomes
 * the line, so a model whose route cannot be calculated still gets its pane.
 * `explainRoute` never writes to stderr, which is the user's terminal here.
 */
async function resolvePaneRouteLines(models: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(models)];
  const entries = await Promise.all(
    unique.map(async (model): Promise<[string, string]> => {
      try {
        return [model, paneRouteLine(await explainRoute(model))];
      } catch (err) {
        return [model, `unknown — ${err instanceof Error ? err.message : String(err)}`];
      }
    })
  );
  return new Map(entries);
}

/**
 * Build shell commands for the pane header.
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │  ██ model-name ██                                     │  (white on colored bg)
 *   │  route: Kimi Coding → OpenRouter  (catalog · subscr…  │  (dim)
 *   │  ──────────────────────────────────────────────────── │  (dim line)
 *   │  The full prompt text, word-wrapped                   │  (normal)
 *   │  across multiple lines if needed...                   │
 *   │  ──────────────────────────────────────────────────── │  (dim line)
 *   └──────────────────────────────────────────────────────┘
 */
// Palette for model name backgrounds. Index is passed around between panes
// via pickBannerColor() so visually-adjacent panes never share a color.
// Theme-independent by design: each fill is a self-contained mid-dark bg + the
// bright-white ink painted on top, readable on both light and dark pages.
const BANNER_BG_COLORS = [
  "48;2;40;90;180", // blue
  "48;2;140;60;160", // purple
  "48;2;30;130;100", // teal
  "48;2;160;80;40", // orange
  "48;2;60;120;60", // green
  "48;2;160;50;70", // red
];

// Deterministic-first color assignment with collision avoidance.
// Uses the hashed slot as the starting point, then linear-probes forward until
// a free slot is found. Mutates `used` by inserting the chosen index.
// If every slot is taken (more models than palette colors), reuses the
// hashed slot so coloring stays deterministic.
function pickBannerColor(model: string, used: Set<number>): string {
  let hash = 0;
  for (let i = 0; i < model.length; i++) hash = ((hash << 5) - hash + model.charCodeAt(i)) | 0;
  const start = Math.abs(hash) % BANNER_BG_COLORS.length;
  let idx = start;
  if (used.size < BANNER_BG_COLORS.length) {
    while (used.has(idx)) idx = (idx + 1) % BANNER_BG_COLORS.length;
  }
  used.add(idx);
  return BANNER_BG_COLORS[idx];
}

function buildPaneHeader(model: string, routeLine: string, prompt: string, bg: string): string {
  // Shell-escape single quotes in model name and route strings
  const esc = (s: string) => s.replace(/'/g, "'\\''");

  const lines: string[] = [];

  // Line 1: model name with colored background, padded
  lines.push(`printf '\\033[1;97;${bg}m  %s  \\033[0m\\n' '${esc(model)}';`);

  // Line 2: the calculated route, dim. An argument, not part of the format
  // string, so a `%` in a no-route reason prints as itself.
  lines.push(`printf '\\033[2m  route: %s\\033[0m\\n' '${esc(routeLine)}';`);

  // Line 3: thin separator
  lines.push(`printf '\\033[2m  %s\\033[0m\\n' '────────────────────────────────────────';`);

  // Lines 4+: prompt text, word-wrapped via fold
  // Replace newlines with \n escape for printf %b (gridfile must be single-line)
  const promptForShell = esc(prompt).replace(/\n/g, "\\n");
  lines.push(`printf '%b\\n' '${promptForShell}' | fold -s -w 78 | sed 's/^/  /';`);

  // Final separator
  lines.push(`printf '\\033[2m  %s\\033[0m\\n\\n' '────────────────────────────────────────';`);

  return lines.join(" ");
}

// ─── Magmux Event Protocol ───────────────────────────────────────────────────
//
// magmux pushes events over its Unix socket. We care about:
//   {"type":"snapshot", pane, state, response, tool, startedAt, completedAt}
//   {"type":"exit",     pane, exitCode, duration, response, prompt, tool, model}
//   {"type":"results",  panes:[{pane, state, exitCode, response, ...}], endedAt}
//   {"type":"shutdown"}
//
// Claudish subscribes as a client, tracks events in real time, and uses the
// final "results" event as the authoritative per-pane state.
//
// Magmux handles: idle detection, DONE/FAIL overlays, green/red tints,
// status bar updates, auto-exit. Claudish does NOT need to duplicate any of it.

interface PaneResult {
  pane: number;
  state: string; // "completed" | "failed" | "awaiting_input" | "running"
  exitCode: number;
  dead: boolean;
  /**
   * magmux's own control panel, not a model. It ALWAYS exists (hidden without
   * `-c`) and since magmux 0.7.0 it is reported in `results` like any other
   * pane, as `{control: true, hidden: true, state: "panel"}`.
   */
  control?: boolean;
  hidden?: boolean;
  controller?: string;
  model?: string;
  project?: string;
  prompt?: string;
  response?: string;
  tool?: string;
  startedAt?: string;
  completedAt?: string;
}

interface MagmuxResultsEvent {
  type: "results";
  panes: PaneResult[];
  endedAt: string;
}

/**
 * Drop magmux's control panel from a results event, so `panes` means "the
 * models this run launched" and nothing else.
 *
 * magmux 0.7.0 reports the always-present control panel alongside the command
 * panes (`{control: true, hidden: true, state: "panel"}`). Today it lands at
 * index N — one past the last model — so `buildTeamStatus`, which looks up
 * panes 0..N-1 by index, happens to miss it. That is arithmetic luck, not a
 * contract: a magmux release that ordered the panel first would silently map a
 * `state: "panel"` entry onto a real model and record it TIMEOUT.
 *
 * Filtering here, at the single point where the event enters claudish, makes
 * that impossible and keeps the rest of the file talking about models only.
 */
function withoutControlPanes(evt: MagmuxResultsEvent): MagmuxResultsEvent {
  if (!Array.isArray(evt.panes)) return evt;
  return { ...evt, panes: evt.panes.filter((p) => p?.control !== true) };
}

/**
 * Connect to magmux's IPC socket and collect events. Resolves with the final
 * "results" payload (or null if the session died before sending one).
 *
 * Uses a retry loop for the initial connect because magmux creates the socket
 * asynchronously after spawn.
 */
async function subscribeToMagmux(
  sockPath: string,
  onEvent?: (event: Record<string, unknown>) => void
): Promise<{ results: MagmuxResultsEvent | null; client: Socket | null }> {
  // Retry connect up to ~2s — magmux may not have created the socket yet.
  let client: Socket | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (existsSync(sockPath)) {
      try {
        client = await new Promise<Socket>((resolve, reject) => {
          const s = netConnect(sockPath);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        break;
      } catch {
        /* socket not ready, retry */
      }
    }
    await wait(50);
  }

  if (!client) {
    return { results: null, client: null };
  }

  return await new Promise((resolve) => {
    let buf = "";
    let finalResults: MagmuxResultsEvent | null = null;

    client!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      // Split on newlines — magmux writes one JSON event per line.
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          onEvent?.(evt);
          if (evt.type === "results") {
            finalResults = withoutControlPanes(evt as unknown as MagmuxResultsEvent);
          }
        } catch {
          /* ignore malformed events */
        }
      }
    });

    const done = () => resolve({ results: finalResults, client });
    client!.once("end", done);
    client!.once("close", done);
    client!.once("error", done);
  });
}

/**
 * Translate magmux's PaneResult[] into claudish's TeamStatus.
 * Pane indices map to anonIds via insertion order in the manifest.
 */
function buildTeamStatus(
  manifest: TeamManifest,
  startedAt: string,
  results: PaneResult[] | null
): TeamStatus {
  const anonIds = Object.keys(manifest.models);
  const models: Record<string, ModelStatus> = {};

  for (let i = 0; i < anonIds.length; i++) {
    const anonId = anonIds[i];
    const result = results?.find((r) => r.pane === i);

    if (!result) {
      // No data from magmux — session likely died before finishing.
      models[anonId] = {
        state: "TIMEOUT",
        exitCode: null,
        startedAt,
        completedAt: null,
        outputSize: 0,
        model: manifest.models[anonId]?.model,
        spawnModel: null,
        provider: null,
        pane: null,
      };
      continue;
    }

    let state: ModelStatus["state"];
    switch (result.state) {
      case "completed":
      case "awaiting_input": // interactive mode: user quit while TUI was idle
        state = "COMPLETED";
        break;
      case "failed":
        state = "FAILED";
        break;
      default:
        state = "TIMEOUT";
    }

    models[anonId] = {
      state,
      exitCode: result.exitCode,
      startedAt: result.startedAt ?? startedAt,
      completedAt: result.completedAt ?? new Date().toISOString(),
      outputSize: result.response?.length ?? 0,
      model: manifest.models[anonId]?.model,
      spawnModel: null,
      provider: null,
      pane: null,
    };
  }

  return { startedAt, models };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run multiple models in grid mode using magmux.
 *
 * Magmux handles every piece of lifecycle management:
 *   - Idle / completion detection (via ClaudeCodeController JSONL parsing,
 *     OSC notifications, bracketed paste, text-idle fallback)
 *   - DONE/FAIL overlays + green/red pane tints
 *   - Status bar with per-pane counts and timing
 *   - Auto-exit when all panes are done (-w flag)
 *   - Final state broadcast via IPC socket
 *
 * Claudish only:
 *   1. Generates a gridfile with one shell command per pane (prompt header +
 *      `claudish --model X ...`).
 *   2. Spawns magmux with `-g gridfile`.
 *   3. Subscribes to magmux's Unix socket and collects events.
 *   4. Returns TeamStatus built from the final `results` event.
 *
 * @param sessionPath  Absolute path to the session directory
 * @param models       Model IDs to run in parallel
 * @param input        Task prompt text
 * @param opts         Optional keep (don't auto-exit) and mode (default/interactive)
 */
export async function runWithGrid(
  sessionPath: string,
  models: string[],
  input: string,
  opts?: { timeout?: number; keep?: boolean; mode?: "default" | "interactive" }
): Promise<TeamStatus> {
  const mode = opts?.mode ?? "default";
  const keep = opts?.keep ?? false;

  // 1. Set up session directory (manifest.json, status.json, input.md)
  const manifest: TeamManifest = setupSession(sessionPath, models, input);
  const startedAt = new Date().toISOString();

  // 2. Build gridfile — one command per pane, no IPC plumbing.
  //    Magmux attaches ClaudeCodeController automatically by detecting
  //    `claude` / `claudish` in the command args.
  const gridfilePath = join(sessionPath, "gridfile.txt");
  const prompt = readFileSync(join(sessionPath, "input.md"), "utf-8")
    .replace(/'/g, "'\\''")
    .replace(/\n/g, " "); // Flatten — gridfile is one command per line

  const rawPrompt = readFileSync(join(sessionPath, "input.md"), "utf-8");
  const usedBannerColors = new Set<number>();
  // Only default mode draws a pane header; interactive panes are Claude Code's TUI.
  const routeLines =
    mode === "interactive"
      ? new Map<string, string>()
      : await resolvePaneRouteLines(Object.values(manifest.models).map((entry) => entry.model));

  const gridLines = Object.entries(manifest.models).map(([anonId]) => {
    const model = manifest.models[anonId].model;

    if (mode === "interactive") {
      // Interactive: full Claude Code TUI — just launch claudish -i.
      // Magmux's ClaudeCodeController watches the JSONL transcript and
      // produces live snapshots via the IPC socket.
      return `claudish --model ${model} -i --dangerously-skip-permissions '${prompt}'`;
    }

    // Default: render a pane header banner, then run claudish headlessly.
    // Magmux auto-applies DONE/FAIL overlay and green/red tint when the
    // child exits, so no shell-level IPC is needed.
    const bg = pickBannerColor(model, usedBannerColors);
    const header = buildPaneHeader(model, routeLines.get(model) ?? "", rawPrompt, bg);
    return `${header} claudish --model ${model} -y --quiet '${prompt}'`;
  });
  writeFileSync(gridfilePath, `${gridLines.join("\n")}\n`, "utf-8");

  // 3. Spawn magmux with grid mode.
  const magmuxPath = findMagmuxBinary();
  const spawnArgs = ["-g", gridfilePath];
  if (!keep && mode === "default") {
    spawnArgs.push("-w"); // auto-exit when all panes complete
  }

  const proc = spawn(magmuxPath, spawnArgs, {
    stdio: "inherit",
    env: { ...process.env },
  });

  // 4. Subscribe to magmux's Unix socket for live events + final results.
  //    magmux names its socket /tmp/magmux-<pid>.sock.
  const sockPath = `/tmp/magmux-${proc.pid}.sock`;
  const subscription = subscribeToMagmux(sockPath);

  // 5. Wait for magmux process to exit.
  const procExit = new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve());
  });

  // Race: whichever finishes first. In practice the socket closes just
  // before the process exits (magmux pushes shutdown, then closes).
  const [{ results }] = await Promise.all([subscription, procExit]);

  // 6. Build TeamStatus from magmux's final results payload.
  const status = buildTeamStatus(manifest, startedAt, results?.panes ?? null);

  // Persist status.json for downstream tools that read the session directory.
  const statusPath = join(sessionPath, "status.json");
  writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf-8");

  return status;
}
