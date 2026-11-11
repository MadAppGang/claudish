/**
 * The Herdr.app mod's pure parts: reading the feed, rows from `ViewItem` through the shared state
 * map, the argv of every hc terminal it starts, the window it shows a session in, and where its
 * own panel sits in the shown layout. Nothing here touches the host; `controller.ts` does.
 */

import type { ViewItem } from "../../pane/view-contract.js";
import { type HcState, clipText, hcStatus, shortModel } from "../state-map.js";

export const MOD_NAME = "claudish";
/** the hidden hc terminal that runs `claudish view --feed` */
export const FEED_TERMINAL = "claudish-feed";
export const VIEW_TERMINAL_PREFIX = "claudish-view-";
/** opening a window with the same key replaces the open one in its place */
export const VIEW_WINDOW_KEY = "claudish-view";
/** the polling path, while no relay can run */
export const POLL_MS = 2_000;
/** how often the stamped relay is checked while the panel is visible */
export const LIVENESS_MS = 15_000;
/** where `claudish` and `bun` are usually installed; ahead of the user's PATH for every call */
export const PATH_HEAD = [
  "$HOME/.bun/bin",
  "$HOME/.local/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
];
/** an hc name: 1-32 of a-z 0-9 - _ */
const HC_NAME_RE = /^[a-z0-9_-]{1,32}$/;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface FeedServer {
  endpoint: string;
  pid: number;
  version: string;
}

export interface FeedView {
  relay: { pid: number; start36: string } | null;
  servers: FeedServer[];
  items: ViewItem[];
}

/** What the mod resolved about the user's claudish once at load. */
export interface ClaudishInstall {
  /** absolute path of the `claudish` command */
  path: string;
  /** the PATH that found it; hc terminals and every exec get it */
  pathEnv: string;
  /** `claudish view --print-root` */
  root: string;
  version: string;
}

function isFeedShape(v: unknown): v is { servers: unknown[]; items: unknown[]; relay?: unknown } {
  const o = v as { servers?: unknown; items?: unknown } | null;
  return Boolean(o) && Array.isArray(o?.servers) && Array.isArray(o?.items);
}

/** `feed.json` as written by the relay; null when absent, half-written or not a feed. */
export function parseFeed(text: string | null): FeedView | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (!isFeedShape(v)) return null;
    const r = v.relay as { pid?: unknown; start36?: unknown } | undefined;
    const relay =
      r && typeof r.pid === "number" && typeof r.start36 === "string"
        ? { pid: r.pid, start36: r.start36 }
        : null;
    return { relay, servers: v.servers as FeedServer[], items: v.items as ViewItem[] };
  } catch {
    return null;
  }
}

/** `claudish view --list --json`, the polling path. */
export function parseListing(stdout: string): Pick<FeedView, "servers" | "items"> | null {
  const feed = parseFeed(stdout.trim());
  return feed ? { servers: feed.servers, items: feed.items } : null;
}

export function sameRelay(a: FeedView["relay"], b: FeedView["relay"]): boolean {
  return Boolean(a && b && a.pid === b.pid && a.start36 === b.start36);
}

export interface ModRow {
  target: string;
  /** the prompt summary, or the model */
  title: string;
  /** model, state word, where it is viewed */
  detail: string;
  state: HcState;
  finished: boolean;
  selected: boolean;
}

function isFinished(item: ViewItem): boolean {
  if (item.kind === "replay") return item.final;
  return ["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "EMPTY"].includes(item.state);
}

function stateWord(item: ViewItem, msg: string): string {
  if (item.kind === "replay") return item.final ? "replay ended" : "replay";
  return msg || item.state.toLowerCase().replace(/_/g, " ");
}

/** One row per item: running ones first, then finished ones, each in the feed's order. */
export function rowsOf(items: ViewItem[], selected: string | null): ModRow[] {
  const rows = items.map((item): ModRow => {
    const s = hcStatus(item);
    const parts = [shortModel(item.model), stateWord(item, s.msg)];
    if (item.kind === "team_slot") parts.unshift(`${clipText(item.run_id, 12)}/${item.slot}`);
    if (item.view) parts.push(`viewed in ${item.view.label}`);
    return {
      target: item.target,
      title: s.title,
      detail: clipText(parts.join(" · "), 120),
      state: s.state,
      finished: isFinished(item),
      selected: item.target === selected,
    };
  });
  return [...rows.filter((r) => !r.finished), ...rows.filter((r) => r.finished)];
}

/** `claudish-view-<12 hex of sha256(target)>`: 26 characters, valid for any target. */
export function viewTerminalName(target: string, sha256Hex: (s: string) => string): string {
  const name = `${VIEW_TERMINAL_PREFIX}${sha256Hex(target).slice(0, 12)}`;
  if (!HC_NAME_RE.test(name)) throw new Error(`not an hc terminal name: ${name}`);
  return name;
}

/**
 * The argv that runs claudish with the PATH and socket root the mod resolved. An hc terminal
 * starts with the core's environment, not the mod's, so both go in explicitly.
 */
export function claudishArgv(install: ClaudishInstall, args: string[]): string[] {
  return [
    "/usr/bin/env",
    `PATH=${install.pathEnv}`,
    `CLAUDISH_PANE_ROOT=${install.root}`,
    install.path,
    ...args,
  ];
}

function hcRunArgs(name: string, cwd: string, argv: string[]): string[] {
  return [
    "run",
    "--bg",
    "--json",
    "--no-parent",
    "--no-notify",
    "--rm",
    "--name",
    name,
    "--cwd",
    cwd,
    "--",
    ...argv,
  ];
}

/** `hc run` for the hidden feed relay. No `herdr.*` label, so Herdr.app never shows it. */
export function feedRunArgs(install: ClaudishInstall, home: string): string[] {
  return hcRunArgs(FEED_TERMINAL, home, claudishArgv(install, ["view", "--feed"]));
}

/** `hc run` for one session's viewer, a hand-run viewer that takes the view at start. */
export function viewRunArgs(
  install: ClaudishInstall,
  target: string,
  name: string,
  home: string
): string[] {
  return hcRunArgs(
    name,
    home,
    claudishArgv(install, ["view", target, "--front-end", "herdr-core"])
  );
}

export type HcRunOutcome =
  | { kind: "started"; address: string }
  | { kind: "name_taken" }
  | { kind: "failed"; message: string };

/** What `hc run --json` answered. */
export function parseHcRun(r: ExecResult): HcRunOutcome {
  type HcRunBody = { address?: unknown; error?: { kind?: unknown; message?: unknown } };
  let body: HcRunBody | null;
  try {
    body = JSON.parse(r.stdout.trim() || r.stderr.trim()) as HcRunBody;
  } catch {
    body = null;
  }
  if (r.code === 0 && typeof body?.address === "string")
    return { kind: "started", address: body.address };
  if (body?.error?.kind === "name_taken") return { kind: "name_taken" };
  const message =
    typeof body?.error?.message === "string"
      ? body.error.message
      : (r.stderr || r.stdout).trim() || `hc exited ${r.code}`;
  return { kind: "failed", message: clipText(message, 160) };
}

export interface TerminalInfo {
  address: string;
  name?: string | null;
  state?: string;
}

/** The live hc terminal with that name, as Herdr's `terminals()` lists them. */
export function liveTerminal(list: TerminalInfo[], name: string): TerminalInfo | null {
  return list.find((t) => t.name === name && (t.state ?? "live") === "live") ?? null;
}

/** The floating window that shows a viewer's terminal, under a title bar of this mod. */
export function viewWindowSpec(address: string, target: string, title: string) {
  return {
    kind: "window",
    key: VIEW_WINDOW_KEY,
    width: 0.62,
    height: 0.72,
    layout: {
      type: "column",
      children: [
        {
          type: "block",
          size: { px: 28 },
          content: { mod: MOD_NAME, props: { role: "titlebar", terminal: address, target, title } },
        },
        { type: "block", content: { terminal: address } },
      ],
    },
  };
}

interface LayoutNode {
  id?: string;
  type?: string;
  hidden?: boolean;
  active?: string;
  content?: { mod?: string; props?: { role?: string } };
  children?: LayoutNode[];
  floating?: LayoutNode[];
}

function isPanel(node: LayoutNode): boolean {
  const role = node.content?.props?.role;
  return node.content?.mod === MOD_NAME && (role === undefined || role === "panel");
}

/** The chain of nodes from the root to this mod's panel block, or null when it is not in the layout. */
function pathToPanel(node: LayoutNode | null | undefined): LayoutNode[] | null {
  if (!node || typeof node !== "object") return null;
  if (isPanel(node)) return [node];
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const below = pathToPanel(child);
    if (below) return [node, ...below];
  }
  return null;
}

/** The id of the layout node holding the panel: the one a toggle shows and hides. */
export function panelNodeId(layout: unknown): string | null {
  const path = pathToPanel(layout as LayoutNode);
  return path?.[path.length - 1]?.id ?? null;
}

/**
 * Whether the panel is on screen: in the layout, no node on its way hidden, and the active child
 * of every stack above it. A panel the layout does not hold (an overlay copy) counts as shown.
 */
export function isPanelVisible(layout: unknown): boolean {
  const path = pathToPanel(layout as LayoutNode);
  if (!path) return true;
  return path.every((node, i) => {
    if (node.hidden) return false;
    const next = path[i + 1];
    return !(node.type === "stack" && next && node.active !== undefined && node.active !== next.id);
  });
}
