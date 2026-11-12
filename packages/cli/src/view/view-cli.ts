/**
 * `claudish view`: read-only access to the sessions of every claudish MCP server on this machine:
 * `--list` prints them, `<target>` shows one of them live in this terminal (`viewer.ts`).
 * It discovers servers by listing `<root>/endpoints/`, so it needs no knowledge of which Claude
 * Code started them.
 */

import { detectFrontEnd, herdrPaneEnv, workspaceKeyOf } from "../herdr/front-end.js";
import { HcStatusReporter } from "../herdr/hc-reporter.js";
import { HerdrSocket } from "../herdr/herdr-socket.js";
import { HerdrReporter } from "../herdr/reporter.js";
import { setStderrQuiet } from "../logger.js";
import { sockRootFor } from "../pane/pane-launch.js";
import { readProcessTableAsync } from "../pane/process-identity.js";
import {
  ViewError,
  type ViewErrorCode,
  type ViewItem,
  type ViewListResult,
  type ViewTranscriptAnswer,
} from "../pane/view-contract.js";
import { detectAndSetThemeModeSync } from "../theme/theme-mode.js";
import { endpointOwnerAlive, endpointPathOf, listEndpoints } from "./endpoints.js";
import { checkFeed, defaultFeedPath, runFeedRelay } from "./feed-relay.js";
import { DEFAULT_FPS } from "./magmux-view-client.js";
import { ViewClient } from "./view-client.js";
import { type FrontEnd, PLAIN_TERMINAL, Viewer, type ViewerIo } from "./viewer.js";

const USAGE = [
  "usage: claudish view <target> [--passive] [--fps N] [--front-end auto|herdr|herdr-core|none]",
  "       claudish view --list [--json]",
  "       claudish view --feed [file]",
  "       claudish view --feed-check [file]",
  "       claudish view --print-root",
  "       claudish view --transcript <target> [--since <cursor>]",
  "",
  "  <target>   s:<session_id>, t:<run_id>/<slot>, r:<replay_id>, or the same without the prefix",
  "  --passive  do not take the view at start; Enter takes it",
  "  --fps N    frames per second to ask the pane for, 1..30 (default 15)",
  "  --front-end  auto (default) reports to herdr in a herdr pane and to herdr-core (OSC 7501) in",
  "             an hc terminal; none reports nothing",
  "  --feed     keep a file listing every server's sessions up to date (default",
  "             <root>/feed/feed.json); the file is removed when the relay exits",
  "  --feed-check  exit 0 when the relay stamped in the feed file still runs, 1 otherwise",
  "  --print-root  the socket root this claudish uses",
  "  --transcript  the target's conversation as text lines, JSON on stdout; --since takes the",
  "             `cursor` of an earlier answer and returns only the lines after it",
  "",
  "  Keys: Enter shows the session here, q quits. Nothing typed here reaches the session.",
  "",
].join("\n");

export interface ViewListing {
  servers: Array<{ endpoint: string; pid: number; version: string }>;
  items: ViewItem[];
}

/** Every live server's items. A server that refuses or does not answer is left out. */
export async function collectListing(root: string = sockRootFor()): Promise<ViewListing> {
  const table = await readProcessTableAsync();
  const names = listEndpoints(root).filter((n) => endpointOwnerAlive(n, table));
  const results = await Promise.allSettled(names.map((n) => listOne(root, n)));
  const listing: ViewListing = { servers: [], items: [] };
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    listing.servers.push(r.value.server);
    listing.items.push(...r.value.items);
  }
  return listing;
}

async function listOne(
  root: string,
  name: string
): Promise<{ server: ViewListing["servers"][number]; items: ViewItem[] }> {
  const client = await ViewClient.connect(endpointPathOf(root, name), {
    hello: { name: "claudish view --list", kind: "viewer" },
  });
  try {
    const { items } = await client.request<ViewListResult>("list");
    const hello = client.helloResult;
    return {
      server: { endpoint: name, pid: hello?.server.pid ?? 0, version: hello?.server.version ?? "" },
      items,
    };
  } finally {
    client.close();
  }
}

export type TranscriptOutcome =
  | { ok: true; result: ViewTranscriptAnswer }
  | { ok: false; error: { code: ViewErrorCode; message: string } };

/** `--transcript <target> [--since <cursor>]`, or the reason it is refused. */
export function parseTranscriptArgs(
  args: string[]
): { target: string; since?: string } | { error: string } {
  let target = "";
  let since: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--since") {
      const value = args[++i];
      if (!value || value.startsWith("-")) return { error: "--since needs a cursor" };
      since = value;
    } else if (a.startsWith("-")) return { error: `unknown option ${a}` };
    else if (target) return { error: "one target at a time" };
    else target = a;
  }
  if (!target) return { error: "a target is required" };
  return since === undefined ? { target } : { target, since };
}

/**
 * The target's transcript from the live server that holds it. Servers are asked in endpoint order;
 * the first answer wins. When none holds it, the last server's own error (`unknown_session`,
 * `unknown_run`, …), or `server_gone` when no server is running.
 */
export async function transcriptOf(
  root: string,
  target: string,
  since?: string
): Promise<TranscriptOutcome> {
  const table = await readProcessTableAsync();
  const names = listEndpoints(root).filter((n) => endpointOwnerAlive(n, table));
  let last: { code: ViewErrorCode; message: string } = {
    code: "server_gone",
    message: "no claudish MCP server is running",
  };
  for (const name of names) {
    let client: ViewClient | null = null;
    try {
      client = await ViewClient.connect(endpointPathOf(root, name), {
        hello: { name: "claudish view --transcript", kind: "viewer" },
      });
      const result = await client.request<ViewTranscriptAnswer>("transcript", {
        target,
        ...(since === undefined ? {} : { since }),
      });
      return { ok: true, result };
    } catch (e) {
      last =
        e instanceof ViewError
          ? { code: e.code, message: e.message }
          : { code: "server_gone", message: e instanceof Error ? e.message : String(e) };
    } finally {
      client?.close();
    }
  }
  return { ok: false, error: last };
}

function stateOf(item: ViewItem): string {
  return item.kind === "replay" ? (item.final ? "FINISHED" : "REPLAY") : item.state;
}

function formatListing(listing: ViewListing): string {
  if (listing.items.length === 0)
    return listing.servers.length === 0
      ? "no claudish MCP server is running\n"
      : "no running sessions\n";
  const rows = listing.items.map((item) => [
    item.target,
    stateOf(item),
    item.model ?? "",
    item.view ? item.view.label : "",
  ]);
  const header = ["TARGET", "STATE", "MODEL", "VIEWED IN"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cols: string[]): string =>
    `${cols
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd()}\n`;
  return line(header) + rows.map(line).join("");
}

export interface ViewArgs {
  target: string;
  passive: boolean;
  fps: number;
  frontEnd: "auto" | "herdr" | "herdr-core" | "none";
}

/** The `<target>` form's argv, or the reason it is refused. */
export function parseViewArgs(args: string[]): ViewArgs | { error: string } {
  const out: ViewArgs = { target: "", passive: false, fps: DEFAULT_FPS, frontEnd: "auto" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const error = a.startsWith("-") ? applyOption(out, a, args[i + 1]) : applyTarget(out, a);
    if (error) return { error };
    if (a === "--fps" || a === "--front-end") i++;
  }
  return out.target ? out : { error: "a target is required" };
}

/** One option of the `<target>` form; the error, or null. */
function applyOption(out: ViewArgs, option: string, value: string | undefined): string | null {
  if (option === "--passive") {
    out.passive = true;
    return null;
  }
  if (option === "--fps") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 30) return "--fps must be 1..30";
    out.fps = n;
    return null;
  }
  if (option === "--front-end") {
    if (value === "auto" || value === "herdr" || value === "herdr-core" || value === "none") {
      out.frontEnd = value;
      return null;
    }
    return `front end ${value ?? "(missing)"} is not supported`;
  }
  return `unknown option ${option}`;
}

function applyTarget(out: ViewArgs, target: string): string | null {
  if (out.target) return "one target at a time";
  out.target = target;
  return null;
}

/** The real terminal: raw keys, the size from stdout, its resize events. */
function processIo(): ViewerIo {
  const stdin = process.stdin;
  return {
    write: (s) => {
      process.stdout.write(s);
    },
    term: () => ({ cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }),
    onKeys(fn) {
      const onData = (chunk: Buffer | string): void => fn(chunk.toString());
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("data", onData);
      return () => {
        stdin.off("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
      };
    },
    onResize(fn) {
      process.stdout.on("resize", fn);
      return () => process.stdout.off("resize", fn);
    },
  };
}

/** What a placer put in this pane's environment; read once and removed from ours. */
export interface PlacedPane {
  placed: boolean;
  endpoint: string | undefined;
  placement: string | undefined;
}

export function takePlacedEnv(env: NodeJS.ProcessEnv): PlacedPane {
  const out: PlacedPane = {
    placed: Boolean(env.CLAUDISH_VIEW_PLACED),
    endpoint: env.CLAUDISH_VIEW_ENDPOINT || undefined,
    placement: env.CLAUDISH_VIEW_PLACEMENT || undefined,
  };
  for (const k of ["CLAUDISH_VIEW_PLACED", "CLAUDISH_VIEW_ENDPOINT", "CLAUDISH_VIEW_PLACEMENT"])
    delete env[k];
  return out;
}

interface FrontEndChoice {
  frontEnd: FrontEnd;
  workspaceKey?: string;
}

/**
 * The herdr reporter when this runs in a herdr pane, the OSC 7501 reporter in an hc terminal, or
 * what `--front-end` names; the plain terminal otherwise. No herdr call is made outside a herdr
 * pane, and no OSC 7501 line is written outside an hc terminal.
 */
export async function chooseFrontEnd(
  wanted: ViewArgs["frontEnd"],
  env: NodeJS.ProcessEnv,
  placed: PlacedPane,
  write: (bytes: string) => void = (s) => {
    process.stdout.write(s);
  }
): Promise<FrontEndChoice | { error: string }> {
  const frontEnd = wanted === "auto" ? detectFrontEnd(env) : wanted;
  if (frontEnd === "none") return { frontEnd: PLAIN_TERMINAL };
  const titleMode = env.CLAUDISH_HERDR_TITLE === "model" ? "model" : "summary";
  if (frontEnd === "herdr-core") {
    if (!env.HC_TERMINAL_ID?.trim())
      return { error: "--front-end herdr-core needs an hc terminal (HC_TERMINAL_ID)" };
    return { frontEnd: new HcStatusReporter({ write, titleMode }) };
  }
  const pane = herdrPaneEnv(env);
  if (!pane)
    return { error: "--front-end herdr needs a herdr pane (HERDR_PANE_ID, HERDR_SOCKET_PATH)" };
  const herdr = new HerdrSocket(pane.socketPath);
  let workspaceId = pane.workspaceId;
  if (!workspaceId) {
    const got = await herdr.request("pane.get", { pane_id: pane.paneId }).catch(() => null);
    const p = got?.pane as { workspace_id?: unknown } | undefined;
    workspaceId = typeof p?.workspace_id === "string" ? p.workspace_id : null;
  }
  return {
    frontEnd: new HerdrReporter({
      herdr,
      paneId: pane.paneId,
      placed: placed.placed,
      titleMode,
      focusClaim: env.CLAUDISH_VIEW_FOCUS_CLAIM !== "0",
    }),
    ...(workspaceId ? { workspaceKey: workspaceKeyOf(pane.socketPath, workspaceId) } : {}),
  };
}

async function viewTarget(parsed: ViewArgs): Promise<number> {
  const placed = takePlacedEnv(process.env);
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("claudish view <target> needs a terminal on stdin and stdout\n");
    return 2;
  }
  const choice = await chooseFrontEnd(parsed.frontEnd, process.env, placed);
  if ("error" in choice) {
    process.stderr.write(`${choice.error}\n`);
    return 2;
  }
  detectAndSetThemeModeSync();
  // a log line on the shared terminal would land inside the picture
  setStderrQuiet(true);
  const viewer = new Viewer({
    root: sockRootFor(),
    target: parsed.target,
    passive: parsed.passive,
    fps: parsed.fps,
    io: processIo(),
    termProgram: process.env.TERM_PROGRAM,
    frontEnd: choice.frontEnd,
    ...(placed.endpoint ? { endpoint: placed.endpoint } : {}),
    ...(choice.workspaceKey ? { workspaceKey: choice.workspaceKey } : {}),
    ...(placed.placement ? { placement: placed.placement } : {}),
  });
  const stop = (): void => viewer.quit();
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  try {
    const outcome = await viewer.run();
    if (outcome.message) process.stdout.write(`${outcome.message}\n`);
    return outcome.code;
  } finally {
    // also when the viewer ended before following its target: a placed pane still closes
    await choice.frontEnd.close();
    setStderrQuiet(false);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
  }
}

/** `--feed`, `--feed-check` and `--print-root`: one optional file operand, nothing else. */
async function feedCommand(args: string[]): Promise<number | null> {
  const [mode, file, ...rest] = args;
  if (mode !== "--feed" && mode !== "--feed-check" && mode !== "--print-root") return null;
  if (rest.length > 0 || (file?.startsWith("-") ?? false) || (mode === "--print-root" && file)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const root = sockRootFor();
  if (mode === "--print-root") {
    process.stdout.write(`${root}\n`);
    return 0;
  }
  const path = file ?? defaultFeedPath(root);
  if (mode === "--feed-check") {
    const check = await checkFeed(path);
    process.stdout.write(`${JSON.stringify(check)}\n`);
    return check.alive ? 0 : 1;
  }
  return runFeedRelay({ root, path });
}

export async function viewCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const feed = await feedCommand(args);
  if (feed !== null) return feed;
  if (args[0] === "--transcript") {
    const parsed = parseTranscriptArgs(args);
    if ("error" in parsed) {
      process.stderr.write(`${parsed.error}\n${USAGE}`);
      return 2;
    }
    const out = await transcriptOf(sockRootFor(), parsed.target, parsed.since);
    process.stdout.write(`${JSON.stringify(out.ok ? out.result : { error: out.error })}\n`);
    return out.ok ? 0 : 1;
  }
  if (!args.includes("--list")) {
    const parsed = parseViewArgs(args);
    if ("error" in parsed) {
      process.stderr.write(`${parsed.error}\n${USAGE}`);
      return 2;
    }
    return viewTarget(parsed);
  }
  const known = new Set(["--list", "--json"]);
  if (args.some((a) => !known.has(a))) {
    process.stderr.write(USAGE);
    return 2;
  }
  const listing = await collectListing();
  process.stdout.write(
    args.includes("--json") ? `${JSON.stringify(listing)}\n` : formatListing(listing)
  );
  return 0;
}
