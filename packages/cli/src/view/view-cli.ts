/**
 * `claudish view`: read-only access to the sessions of every claudish MCP server on this machine:
 * `--list` prints them, `<target>` shows one of them live in this terminal (`viewer.ts`).
 * It discovers servers by listing `<root>/endpoints/`, so it needs no knowledge of which Claude
 * Code started them.
 */

import { setStderrQuiet } from "../logger.js";
import { sockRootFor } from "../pane/pane-launch.js";
import { readProcessTableAsync } from "../pane/process-identity.js";
import type { ViewItem, ViewListResult } from "../pane/view-contract.js";
import { detectAndSetThemeModeSync } from "../theme/theme-mode.js";
import { endpointOwnerAlive, endpointPathOf, listEndpoints } from "./endpoints.js";
import { DEFAULT_FPS } from "./magmux-view-client.js";
import { ViewClient } from "./view-client.js";
import { Viewer, type ViewerIo } from "./viewer.js";

const USAGE = [
  "usage: claudish view <target> [--passive] [--fps N] [--front-end auto|none]",
  "       claudish view --list [--json]",
  "",
  "  <target>   s:<session_id>, t:<run_id>/<slot>, r:<replay_id>, or the same without the prefix",
  "  --passive  do not take the view at start; Enter takes it",
  "  --fps N    frames per second to ask the pane for, 1..30 (default 15)",
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
}

/** The `<target>` form's argv, or the reason it is refused. */
export function parseViewArgs(args: string[]): ViewArgs | { error: string } {
  const out: ViewArgs = { target: "", passive: false, fps: DEFAULT_FPS };
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
    // auto resolves to the plain terminal: no other front end is built into this claudish
    return value === "auto" || value === "none"
      ? null
      : `front end ${value ?? "(missing)"} is not supported`;
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

async function viewTarget(parsed: ViewArgs): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("claudish view <target> needs a terminal on stdin and stdout\n");
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
  });
  const stop = (): void => viewer.quit();
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  try {
    const outcome = await viewer.run();
    if (outcome.message) process.stdout.write(`${outcome.message}\n`);
    return outcome.code;
  } finally {
    setStderrQuiet(false);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
  }
}

export async function viewCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
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
