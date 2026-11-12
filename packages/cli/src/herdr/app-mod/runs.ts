/**
 * The panel's runs, as pure values: `ViewItem`s grouped into runs (a team run is one run, a single
 * `create_session` is its own), each with its header and band rows; the run tabs and the "+N
 * earlier" list; the session tabs; the footer; the card a session that never started shows in
 * place of a screen; and transcript lines as text. The cells are spelled as the claudish band in
 * the magus plugin spells them (state codes, `↑in ↓out`, `ƒ`, `↻`, `SUB`).
 */

import type { SlotState, TranscriptLine } from "../../pane/contract.js";
import type { SessionViewItem, TeamSlotViewItem, ViewItem } from "../../pane/view-contract.js";
import { clipText, shortModel } from "../state-map.js";

/** A badge hue, as the band's palette names them. */
export type Tone = "run" | "ask" | "done" | "fail" | "stopped";

type Group = "running" | "needs you" | "done" | "failed" | "stopped";

/** The band's three-letter code, hue and header group per state. */
export const STATE_LOOK: Readonly<Record<SlotState, { code: string; tone: Tone; group: Group }>> = {
  STARTING: { code: "NEW", tone: "run", group: "running" },
  RUNNING: { code: "RUN", tone: "run", group: "running" },
  AWAITING_INPUT: { code: "ASK", tone: "ask", group: "needs you" },
  AWAITING_PERMISSION: { code: "ASK", tone: "ask", group: "needs you" },
  COMPLETED: { code: "END", tone: "done", group: "done" },
  FAILED: { code: "ERR", tone: "fail", group: "failed" },
  TIMEOUT: { code: "TMO", tone: "fail", group: "failed" },
  EMPTY: { code: "NIL", tone: "fail", group: "failed" },
  CANCELLED: { code: "STP", tone: "stopped", group: "stopped" },
};

const GROUP_ORDER: readonly Group[] = ["running", "needs you", "done", "failed", "stopped"];
const TERMINAL: ReadonlySet<SlotState> = new Set([
  "COMPLETED",
  "FAILED",
  "TIMEOUT",
  "CANCELLED",
  "EMPTY",
]);
const DASH = "—";
/** at least this many run tabs, however narrow the panel */
export const EARLIER_MIN_TABS = 1;
/** a run tab's width in px, for how many fit */
const RUN_TAB_PX = 150;
/** what the "+N earlier" tab and the strip's padding take */
const RUN_STRIP_RESERVE_PX = 110;

type RowItem = SessionViewItem | TeamSlotViewItem;

/** One band row of a run. */
export interface PanelRow {
  target: string;
  /** a team slot id; `··` for a session, which has no slot of its own */
  slot: string;
  state: SlotState;
  code: string;
  tone: Tone;
  elapsed: string;
  model: string;
  provider: string;
  tokens: string;
  tools: string;
  turns: string;
  /** `SUB`, a dollar figure, or — */
  billing: string;
  /** the agent, only when the run's slots differ (the header has it otherwise) */
  agent: string | null;
  /** the answer's first line, the step in progress, or the error's reason */
  note: string;
  error: boolean;
  finished: boolean;
  /** failed before Claude Code started: no screen and no transcript to show */
  noScreen: boolean;
  /** what the failure card reads */
  reason: string | null;
  reasonDetail: string | null;
  modelSpec: string;
  providerName: string | null;
  recordsPath: string;
}

export interface PanelRun {
  /** a team run's run_id, or the session's target */
  key: string;
  kind: "team" | "session";
  name: string;
  /** ms since the epoch; null when unknown */
  startedAt: number | null;
  tone: Tone;
  /** `1 running · 1 done` */
  counts: string;
  /** `research · agent dev:architect`; null when there is neither */
  meta: string | null;
  rows: PanelRow[];
}

function isRowItem(item: ViewItem): item is RowItem {
  return item.kind === "session" || item.kind === "team_slot";
}

/** `<dir>-<base36 start ms>-<6 hex>`, as `mintRunId` writes a run id; null for anything else. */
export function runStartMs(runId: string): number | null {
  const parts = runId.split("-");
  if (parts.length < 3) return null;
  const ms = Number.parseInt(parts[parts.length - 2] ?? "", 36);
  // a plausible epoch: 2020 to 2100
  return Number.isFinite(ms) && ms > 1_577_836_800_000 && ms < 4_102_444_800_000 ? ms : null;
}

/** A count in at most 6 cells: 850, 3.0k, 41k, 2.3M; null → —. */
function count(n: number | null): string {
  if (n === null) return DASH;
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 9_950) return `${(n / 1000).toFixed(1)}k`;
  if (a < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 42s, 17m, 3h12m, 13h, 6d02h; null → —. */
export function runtime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return DASH;
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (s < 60) return `${s}s`;
  if (m < 60) return `${m}m`;
  if (h < 10) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  if (h < 24) return `${h}h`;
  if (d < 10) return `${d}d${String(h % 24).padStart(2, "0")}h`;
  return `${Math.min(d, 999)}d`;
}

function dollars(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return DASH;
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return usd < 10 ? `$${usd.toFixed(2)}` : usd < 100 ? `$${usd.toFixed(1)}` : `$${Math.round(usd)}`;
}

/** The band's cost cell: SUB on a subscription (claudish reports 0, or a native Claude route). */
function billing(item: RowItem): string {
  if (item.cost_usd === 0 || (item.cost_usd === null && /native/i.test(item.provider ?? "")))
    return "SUB";
  return item.cost_usd === null ? DASH : dollars(item.cost_usd);
}

/** `Anthropic (Native)` reads `Anthropic`, as the band shows it. */
function providerLabel(provider: string | null): string {
  return (provider ?? "").replace(/\s*\(native\)\s*$/i, "") || DASH;
}

function agentOf(item: RowItem): string | null {
  return item.agent ?? item.agent_requested ?? null;
}

function elapsedOf(item: RowItem, runStart: number | null, now: number): string {
  if (item.kind === "session") return runtime(item.elapsed_seconds * 1000);
  if (runStart === null) return DASH;
  if (!TERMINAL.has(item.state)) return runtime(now - runStart);
  const last = item.last_activity_at ? Date.parse(item.last_activity_at) : Number.NaN;
  return Number.isFinite(last) ? runtime(last - runStart) : DASH;
}

/** A finished slot's answer: the first line of its last text step. */
function answerLine(item: RowItem): string | null {
  const text = [...(item.recent ?? [])].reverse().find((s) => s.kind === "text");
  return text ? text.summary : null;
}

/** A live slot's step in progress (`Read: <file>`), else its activity. */
function stepLine(item: RowItem): string | null {
  const step = item.recent?.at(-1);
  if (!step) return item.activity;
  if (!step.tool) return step.summary;
  return step.summary ? `${step.tool}: ${step.summary}` : step.tool;
}

/** The error's reason, the step in progress, or the answer's first line; else the prompt. */
function noteOf(item: RowItem): { note: string; error: boolean } {
  const terminal = TERMINAL.has(item.state);
  const why = item.reason_detail ?? item.reason;
  if (terminal && item.state !== "COMPLETED" && why)
    return { note: clipText(why, 160), error: true };
  const line = (terminal ? answerLine(item) : stepLine(item)) ?? item.prompt_summary ?? "";
  return { note: clipText(line, 160), error: false };
}

function rowOf(item: RowItem, runStart: number | null, now: number): PanelRow {
  const look = STATE_LOOK[item.state] ?? STATE_LOOK.FAILED;
  const terminal = TERMINAL.has(item.state);
  const { note, error } = noteOf(item);
  return {
    target: item.target,
    slot: item.kind === "team_slot" ? item.slot : "··",
    state: item.state,
    code: look.code,
    tone: look.tone,
    elapsed: elapsedOf(item, runStart, now),
    model: shortModel(item.model),
    provider: providerLabel(item.provider),
    tokens:
      item.tokens_in === null && item.tokens_out === null
        ? DASH
        : `↑${count(item.tokens_in)} ↓${count(item.tokens_out)}`,
    tools: `ƒ ${item.tool_calls}`,
    turns: `↻ ${item.turns_completed}`,
    billing: billing(item),
    agent: agentOf(item),
    note,
    error,
    finished: terminal,
    noScreen:
      terminal &&
      item.state !== "COMPLETED" &&
      item.turns_completed === 0 &&
      item.tool_calls === 0 &&
      (item.tokens_in ?? 0) === 0,
    reason: item.reason,
    reasonDetail: item.reason_detail,
    modelSpec: item.model,
    providerName: item.provider,
    recordsPath:
      item.kind === "team_slot" ? `${item.run_path}/` : `~/.claudish/sessions/${item.session_id}/`,
  };
}

function toneOf(rows: PanelRow[]): Tone {
  if (rows.some((r) => r.tone === "ask")) return "ask";
  if (rows.some((r) => r.tone === "run")) return "run";
  if (rows.some((r) => r.tone === "done")) return "done";
  if (rows.length > 0 && rows.every((r) => r.tone === "stopped")) return "stopped";
  return "fail";
}

function countsOf(rows: PanelRow[]): string {
  const n = new Map<Group, number>();
  for (const r of rows) {
    const g = STATE_LOOK[r.state]?.group ?? "failed";
    n.set(g, (n.get(g) ?? 0) + 1);
  }
  return GROUP_ORDER.filter((g) => n.has(g))
    .map((g) => `${n.get(g)} ${g}`)
    .join(" · ");
}

/** The run's name: a team run's directory (`<dir>/judging` reads `<dir> judges`), or `s:<4 hex>`. */
function nameOf(item: RowItem): string {
  if (item.kind === "session") return `s:${item.session_id.slice(0, 4)}`;
  const parts = item.run_path.split("/").filter(Boolean);
  const last = parts.at(-1) ?? item.run_id;
  return last === "judging" && parts.length > 1 ? `${parts.at(-2)} judges` : last;
}

/** The one value every element has, else null. */
function sharedValue<T>(values: T[]): T | null {
  const set = new Set(values);
  return set.size === 1 ? ([...set][0] as T) : null;
}

/** One run from its items: rows (running first, then by slot), header, tone. */
function runOf(key: string, list: RowItem[], now: number): PanelRun {
  const first = list[0] as RowItem;
  const startedAt =
    first.kind === "team_slot" ? runStartMs(first.run_id) : Date.parse(first.started_at);
  const start = startedAt !== null && Number.isFinite(startedAt) ? startedAt : null;
  const rows = list
    .map((item) => rowOf(item, start, now))
    .sort((a, b) => Number(a.finished) - Number(b.finished) || a.slot.localeCompare(b.slot));
  const differ = new Set(rows.map((r) => r.agent)).size > 1;
  const agent = sharedValue(rows.map((r) => r.agent));
  const taskType = sharedValue(list.map((i) => i.task_type ?? null));
  const meta = [taskType, agent ? `agent ${agent}` : null].filter(Boolean).join(" · ");
  // one agent for the run is the header's; slots that differ name their own
  for (const r of rows) r.agent = differ ? (r.agent ?? DASH) : null;
  return {
    key,
    kind: first.kind === "team_slot" ? "team" : "session",
    name: nameOf(first),
    startedAt: start,
    tone: toneOf(rows),
    counts: countsOf(rows),
    meta: meta || null,
    rows,
  };
}

/** Every run in the items, newest start first; replay items are not runs and are left out. */
export function runsOf(items: ViewItem[], now: number): PanelRun[] {
  const groups = new Map<string, RowItem[]>();
  for (const item of items) {
    if (!isRowItem(item)) continue;
    const key = item.kind === "team_slot" ? item.run_id : item.target;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups]
    .map(([key, list]) => runOf(key, list, now))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export interface RunTab {
  key: string;
  name: string;
  tone: Tone;
  /** `latest` for the newest run, else how long ago it started */
  age: string;
  selected: boolean;
}

/** How many run tabs fit a panel this many px wide. */
export function maxRunTabs(width: number): number {
  return Math.max(EARLIER_MIN_TABS, Math.floor((width - RUN_STRIP_RESERVE_PX) / RUN_TAB_PX));
}

/**
 * The first `max` runs as tabs, the rest as the "+N earlier" list. A selected run from the earlier
 * ones takes the last tab's place, so the selection is always a tab.
 */
export function runTabs(
  runs: PanelRun[],
  selected: string | null,
  max: number,
  now: number
): { tabs: RunTab[]; earlier: RunTab[] } {
  const fit = Math.max(EARLIER_MIN_TABS, max);
  const tab = (r: PanelRun): RunTab => ({
    key: r.key,
    name: r.name,
    tone: r.tone,
    age: r === runs[0] ? "latest" : r.startedAt === null ? "" : `${runtime(now - r.startedAt)} ago`,
    selected: r.key === selected,
  });
  const shown = runs.slice(0, fit);
  const at = runs.findIndex((r) => r.key === selected);
  if (at >= fit) shown[fit - 1] = runs[at] as PanelRun;
  const keys = new Set(shown.map((r) => r.key));
  return { tabs: shown.map(tab), earlier: runs.filter((r) => !keys.has(r.key)).map(tab) };
}

export interface SessionTab {
  target: string;
  label: string;
  tone: Tone;
  selected: boolean;
}

/** One tab per session of the run: its slot and short model, in the rows' order. */
export function sessionTabs(run: PanelRun, selected: string | null): SessionTab[] {
  return run.rows.map((r) => ({
    target: r.target,
    label: `${r.slot} ${clipText(r.model, 18)}`,
    tone: r.tone,
    selected: r.target === selected,
  }));
}

export type ScreenMode = "screen" | "text";

/** The line under the screen area: always read only, then what the area shows. */
export function footerLine(row: PanelRow, mode: ScreenMode): string {
  if (mode === "text") return `read only · transcript of slot ${row.slot}`;
  if (row.noScreen) return "read only · no screen: the reason and records are shown";
  if (!row.finished)
    return `read only · live screen of slot ${row.slot}; focusing it takes the view`;
  return "read only · finished: a replay of the real interface";
}

function tilde(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** What a session that ended before Claude Code started shows in place of a screen. */
export function failureCard(row: PanelRow, home: string): string[] {
  return [
    "This session ended before Claude Code started, so it has no screen to replay.",
    "",
    `reason   ${row.reason ?? row.state.toLowerCase()}`,
    `detail   ${row.reasonDetail ?? "none recorded"}`,
    `model    ${row.modelSpec} → ${row.providerName ?? "provider unknown"}`,
    `records  ${tilde(row.recordsPath, home)}`,
  ];
}

const SPEAKER: Readonly<Record<string, string>> = {
  user: "user",
  assistant: "asst",
  tool: "tool",
  task_file: "task",
  system: "sys ",
  error: "err ",
};

/** Transcript lines as `<speaker>  <text>`; a `cont` chunk joins the line before it. */
export function transcriptText(lines: readonly TranscriptLine[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.cont && out.length > 0) out[out.length - 1] += l.text;
    else out.push(`${SPEAKER[l.kind] ?? "    "}  ${l.text}`);
  }
  return out;
}
