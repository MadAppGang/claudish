import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { connect as netConnect, type Socket } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import {
  setupSession,
  type TeamManifest,
  type TeamStatus,
  type ModelStatus,
} from "./team-orchestrator.js";
import { parseModelSpec } from "./providers/model-parser.js";
import {
  matchRoutingRule,
  buildRoutingChain,
  loadRoutingRules,
} from "./providers/routing-rules.js";
import { loadConfig, loadLocalConfig } from "./profile-config.js";

// ─── Routing Resolution ──────────────────────────────────────────────────────

interface RouteInfo {
  chain: string[];       // e.g. ["LiteLLM", "OpenRouter"]
  source: string;        // "direct", "project routing", "user routing", "auto"
  sourceDetail?: string; // matched pattern for custom rules
}

function resolveRouteInfo(modelId: string): RouteInfo {
  const parsed = parseModelSpec(modelId);

  // Explicit provider prefix (e.g. or@model) — no fallback chain
  if (parsed.isExplicitProvider) {
    return { chain: [parsed.provider], source: "direct" };
  }

  // Check local (project-scope) routing rules first
  const local = loadLocalConfig();
  if (local?.routing && Object.keys(local.routing).length > 0) {
    const matched = matchRoutingRule(parsed.model, local.routing);
    if (matched) {
      const routes = buildRoutingChain(matched, parsed.model);
      const pattern = Object.keys(local.routing).find((k) => {
        if (k === parsed.model) return true;
        if (k.includes("*")) {
          const star = k.indexOf("*");
          return parsed.model.startsWith(k.slice(0, star)) && parsed.model.endsWith(k.slice(star + 1));
        }
        return false;
      });
      return {
        chain: routes.map((r) => r.displayName),
        source: "project routing",
        sourceDetail: pattern,
      };
    }
  }

  // Check global (user-scope) routing rules
  const global_ = loadConfig();
  if (global_.routing && Object.keys(global_.routing).length > 0) {
    const matched = matchRoutingRule(parsed.model, global_.routing);
    if (matched) {
      const routes = buildRoutingChain(matched, parsed.model);
      const pattern = Object.keys(global_.routing).find((k) => {
        if (k === parsed.model) return true;
        if (k.includes("*")) {
          const star = k.indexOf("*");
          return parsed.model.startsWith(k.slice(0, star)) && parsed.model.endsWith(k.slice(star + 1));
        }
        return false;
      });
      return {
        chain: routes.map((r) => r.displayName),
        source: "user routing",
        sourceDetail: pattern,
      };
    }
  }

  // Default auto-routing — consult merged routing rules (defaults + user
  // config). Returns an empty chain only if the catch-all "*" was deliberately
  // disabled by the user.
  const merged = loadRoutingRules();
  const matched = matchRoutingRule(parsed.model, merged);
  if (matched) {
    const routes = buildRoutingChain(matched, parsed.model);
    return {
      chain: routes.map((r) => r.displayName),
      source: "auto",
    };
  }
  return {
    chain: [],
    source: "auto",
  };
}

/**
 * Build shell commands for the pane header.
 * Layout:
 *   ┌──────────────────────────────────────┐
 *   │  ██ model-name ██                    │  (white on colored bg)
 *   │  route: LiteLLM → OpenRouter (auto)  │  (dim)
 *   │  ──────────────────────────────────── │  (dim line)
 *   │  The full prompt text, word-wrapped   │  (normal)
 *   │  across multiple lines if needed...   │
 *   │  ──────────────────────────────────── │  (dim line)
 *   └──────────────────────────────────────┘
 */
// Palette for model name backgrounds. Index is passed around between panes
// via pickBannerColor() so visually-adjacent panes never share a color.
const BANNER_BG_COLORS = [
  "48;2;40;90;180",   // blue
  "48;2;140;60;160",  // purple
  "48;2;30;130;100",  // teal
  "48;2;160;80;40",   // orange
  "48;2;60;120;60",   // green
  "48;2;160;50;70",   // red
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

function buildPaneHeader(model: string, prompt: string, bg: string): string {
  const route = resolveRouteInfo(model);

  // Shell-escape single quotes in model name and route strings
  const esc = (s: string) => s.replace(/'/g, "'\\''");

  // Route chain string: "LiteLLM → OpenRouter"
  const chainStr = route.chain.join(" → ");
  const sourceLabel = route.sourceDetail
    ? `${route.source}: ${route.sourceDetail}`
    : route.source;

  const lines: string[] = [];

  // Line 1: model name with colored background, padded
  lines.push(`printf '\\033[1;97;${bg}m  %s  \\033[0m\\n' '${esc(model)}';`);

  // Line 2: route chain in dim with arrow symbols
  lines.push(`printf '\\033[2m  route: ${esc(chainStr)}  (${esc(sourceLabel)})\\033[0m\\n' ;`);

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

// ─── Multiplexer Binary Detection ────────────────────────────────────────────

/**
 * Find the magmux binary. Priority:
 * 1. Bundled magmux (native/magmux-<platform>-<arch>)
 * 2. Platform-specific npm package (@claudish/magmux-<platform>-<arch>)
 * 3. magmux in PATH (e.g. via Homebrew)
 */
function findMagmuxBinary(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  const pkgRoot = join(thisDir, "..");
  const platform = process.platform;
  const arch = process.arch;

  // 1. Bundled magmux (native/magmux-<platform>-<arch>)
  const bundledMagmux = join(pkgRoot, "native", `magmux-${platform}-${arch}`);
  if (existsSync(bundledMagmux)) return bundledMagmux;

  // 2. Platform-specific npm package (@claudish/magmux-<platform>-<arch>)
  //    npm installs only the matching platform's optional dep
  try {
    const pkgName = `@claudish/magmux-${platform}-${arch}`;
    // Walk up from this file to find node_modules
    let searchDir = pkgRoot;
    for (let i = 0; i < 5; i++) {
      const candidate = join(searchDir, "node_modules", pkgName, "bin", "magmux");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(searchDir);
      if (parent === searchDir) break;
      searchDir = parent;
    }
  } catch { /* not installed */ }

  // 3. magmux in PATH
  try {
    const result = execSync("which magmux", { encoding: "utf-8" }).trim();
    if (result) return result;
  } catch {
    /* not in PATH */
  }

  throw new Error(
    "magmux not found. Install it:\n  brew install MadAppGang/tap/magmux"
  );
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
  state: string;       // "completed" | "failed" | "awaiting_input" | "running"
  exitCode: number;
  dead: boolean;
  controller?: string;
  model?: string;
  project?: string;
  prompt?: string;
  response?: string;
  tool?: string;
  startedAt?: string;
  completedAt?: string;
}

export type { PaneResult };

interface MagmuxResultsEvent {
  type: "results";
  panes: PaneResult[];
  endedAt: string;
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
            finalResults = evt as unknown as MagmuxResultsEvent;
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
 *
 * Exported for the #578 pin: the grid path is a second ModelStatus producer
 * beside runModels, and it must not silently drop the failure details the
 * MCP report renders.
 */
export function buildTeamStatus(
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

    const status: ModelStatus = {
      state,
      exitCode: result.exitCode,
      startedAt: result.startedAt ?? startedAt,
      completedAt: result.completedAt ?? new Date().toISOString(),
      outputSize: result.response?.length ?? 0,
    };

    // #578: a FAILED pane on the grid path must still render the failure
    // detail block. magmux's PaneResult carries no stderr and no log path
    // (state/exitCode/response only), so say that honestly instead of
    // leaving the block silently absent — the renderer skips the log-path
    // and workDir lines when they are empty.
    if (state === "FAILED") {
      status.error = {
        model: result.model ?? manifest.models[anonId].model,
        command: `team run (grid, pane ${result.pane})`,
        stderrSnippet:
          "not captured in grid mode - magmux reports state/exit code only; rerun the model with `team run --no-grid` to capture stderr and an error log",
        errorLogPath: "",
        workDir: "",
      };
    }

    models[anonId] = status;
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
    const header = buildPaneHeader(model, rawPrompt, bg);
    return `${header} claudish --model ${model} -y --quiet '${prompt}'`;
  });
  writeFileSync(gridfilePath, gridLines.join("\n") + "\n", "utf-8");

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
