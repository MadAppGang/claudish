/**
 * `claudish account forecast` human view (allowance architecture §3.1): pure,
 * `AllowanceReport` → lines. The header, each active alert with its binding
 * windows and remedy, a 60 × 10 trajectory graph (the CLI's own; every other
 * surface draws `spark48`), and the ranked session list of each binding window
 * with its unattributed row. Colours come in through `paint`, so the caller
 * reads the theme at render time and a snapshot test passes identity.
 */

import type { AllowanceReport } from "./auth/accounts/allowance-report-schema.js";
import { alertStrategy } from "./auth/accounts/allowance/constants.js";

export interface ForecastPaint {
  ok(text: string): string;
  warn(text: string): string;
  bad(text: string): string;
  dim(text: string): string;
  strong(text: string): string;
}

const PLAIN: ForecastPaint = {
  ok: (t) => t,
  warn: (t) => t,
  bad: (t) => t,
  dim: (t) => t,
  strong: (t) => t,
};

const HOUR_MS = 3_600_000;
const GRAPH_COLS = 60;
const GRAPH_ROWS = 10;
/** The human view ranks this many sessions; `--json` carries all of them. */
const SESSIONS_SHOWN = 10;
/** A window this short is a 5h-class window (the model's SHORT_WINDOW_MAX_MIN). */
const SHORT_WINDOW_MAX_MIN = 360;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * One line when the alerts and the graph simulate another strategy than the
 * one that selects (`alertStrategy`): `lookahead` selects, `ebr` forecasts.
 */
export function alertModelLine(strategy: AllowanceReport["strategy"]): string | null {
  const simulated = alertStrategy(strategy);
  return simulated === strategy
    ? null
    : `alerts simulate ${simulated} (${strategy} alert model pending)`;
}

export const NO_USAGE_LINE =
  "No usage observed yet — the forecast starts after the first pooled response.";

/** `Thu 14:00`, local, 24 h. */
function at(isoTime: string): string {
  const d = new Date(isoTime);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${hh}:${mm}`;
}

function hours(h: number): string {
  return `${Math.round(h)} h`;
}

function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function header(r: AllowanceReport): string {
  const n = r.accounts.length;
  const days = r.trajectory.history.length > 0 ? r.trajectory.history.length / 24 : 0;
  const parts = [
    `${n} account${n === 1 ? "" : "s"}`,
    r.strategy,
    `evidence: ${r.evidence}${days >= 1 ? ` (${Math.floor(days)} d of history)` : ""}`,
  ];
  if (r.assumption === "equal-capacity") parts.push("assuming equal-size accounts");
  return `Codex allowance · ${parts.join(" · ")}`;
}

function alertLines(r: AllowanceReport, paint: ForecastPaint): string[] {
  const out: string[] = [];
  for (const a of r.alerts) {
    const tag = a.level === "critical" ? paint.bad("⛔ CRIT") : paint.warn("⚠ WARN");
    const start = a.gapStart?.p50 ?? new Date(a.gapStartEpoch).toISOString();
    const end = a.gapEnd ? ` → ${at(a.gapEnd.p50)}` : "";
    const len = a.gapHours
      ? ` (${hours(a.gapHours.p50)}, p10–p90 ${Math.round(a.gapHours.p10)}–${Math.round(a.gapHours.p90)} h)`
      : "";
    out.push(`${tag}  blocked ${at(start)}${end}${len} · p(gap) ${a.pGap.toFixed(2)}`);
    const bound = a.binding.map((b) => `${b.account} ${b.window}`).join(", ");
    out.push(`        ${bound ? `bound by: ${bound} · ` : ""}${a.remedy.text}`);
  }
  if (r.alerts.length === 0 && r.status === "ok") {
    out.push(
      paint.ok(r.blockedNow ? "Blocked now; no projected gap past it." : "No projected gap.")
    );
  }
  return out;
}

interface Column {
  value: number | null;
  lo: number | null;
  hi: number | null;
  forecast: boolean;
  block: boolean;
  reset: boolean;
}

/** The 60 × 10 graph: history `▇`, p50 `─`, band `▒`, projected block `█`, reset `┃`. */
function graphLines(r: AllowanceReport, paint: ForecastPaint): string[] {
  const t = r.trajectory;
  const lastHistory = t.history.at(-1)?.at;
  const points = [
    ...t.history.map((h) => ({
      at: Date.parse(h.at),
      v: h.remaining,
      lo: null,
      hi: null,
      f: false,
    })),
    ...t.forecast
      .filter((f) => lastHistory === undefined || f.at > lastHistory)
      .map((f) => ({ at: Date.parse(f.at), v: f.p50, lo: f.p10, hi: f.p90, f: true })),
  ];
  if (points.length === 0) return [];
  const start = points[0]?.at ?? 0;
  const span = Math.max(HOUR_MS, (points.at(-1)?.at ?? start) - start + HOUR_MS);
  const col = (ms: number) =>
    Math.min(GRAPH_COLS - 1, Math.max(0, Math.floor(((ms - start) / span) * GRAPH_COLS)));
  const scale =
    r.unit === "account-fraction"
      ? Math.max(1, r.accounts.length)
      : Math.max(...points.map((p) => Math.max(p.v, p.hi ?? 0)), 0);
  const cols: Column[] = Array.from({ length: GRAPH_COLS }, () => ({
    value: null,
    lo: null,
    hi: null,
    forecast: false,
    block: false,
    reset: false,
  }));
  for (const p of points) {
    const c = cols[col(p.at)];
    if (!c) continue;
    c.value = p.v;
    c.lo = p.lo;
    c.hi = p.hi;
    c.forecast = p.f;
  }
  for (const b of t.blocked) {
    for (let i = col(Date.parse(b.from)); i <= col(Date.parse(b.to) - 1); i++) {
      const c = cols[i];
      if (c) c.block = true;
    }
  }
  // Governing resets only: every 5h refill of every account would fill the forecast with `┃`.
  for (const reset of t.resets) {
    const minutes = /^len:(\d+)$/.exec(reset.window)?.[1];
    if (minutes !== undefined && Number(minutes) <= SHORT_WINDOW_MAX_MIN) continue;
    const ms = Date.parse(reset.at);
    if (ms < start || ms > start + span) continue;
    const c = cols[col(ms)];
    if (c) c.reset = true;
  }
  const level = (v: number | null) =>
    v === null || !(scale > 0) ? -1 : Math.round((v / scale) * (GRAPH_ROWS - 1));

  const rows: string[] = [];
  for (let row = GRAPH_ROWS - 1; row >= 0; row--) {
    let line = "";
    for (const c of cols) {
      if (c.reset) line += "┃";
      else if (c.block && row === 0) line += "█";
      else if (!c.forecast) line += c.value !== null && level(c.value) >= row ? "▇" : " ";
      else if (level(c.value) === row) line += "─";
      else if (level(c.lo) <= row && row <= level(c.hi)) line += "▒";
      else line += " ";
    }
    const axis =
      row === GRAPH_ROWS - 1
        ? "100%┤"
        : row === Math.floor((GRAPH_ROWS - 1) / 2)
          ? " 50%┤"
          : row === 0
            ? "  0%┤"
            : "    │";
    rows.push(`${axis}${line}`);
  }
  // Day ticks at local midnight.
  let ticks = "";
  let labels = "";
  for (let i = 0; i < GRAPH_COLS; i++) {
    const ms = start + (i * span) / GRAPH_COLS;
    const prev = start + ((i - 1) * span) / GRAPH_COLS;
    const day = new Date(ms).getDay();
    const isTick = i === 0 || new Date(prev).getDay() !== day;
    ticks += isTick ? "┬" : "─";
    if (isTick && labels.length <= i) labels = `${labels.padEnd(i)}${DAYS[day]}`;
  }
  rows.push(`    └${ticks}`);
  rows.push(`     ${labels}`);
  rows.push(paint.dim("     ▇ history  ─ p50  ▒ p10–p90  █ projected block  ┃ reset"));
  return rows;
}

function sessionLines(r: AllowanceReport, paint: ForecastPaint): string[] {
  if (r.sessions.length === 0) return [];
  const windows = [...new Set(r.sessions.map((s) => `${s.account} ${s.window}`))];
  const first = r.sessions.reduce(
    (min, s) => (s.firstAt < min ? s.firstAt : min),
    r.sessions[0]?.firstAt ?? ""
  );
  const out = [`Sessions this window (${windows.join(", ")}, since ${at(first)})`];
  out.push(paint.dim("  #  session       share  used   tokens in/out     model           account"));
  const ranked = r.sessions
    .filter((s) => s.session !== "unattributed")
    .sort((a, b) => b.share - a.share);
  ranked.slice(0, SESSIONS_SHOWN).forEach((s, i) => {
    const model = Object.entries(s.models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
    out.push(
      `  ${String(i + 1).padEnd(2)} ${s.session.padEnd(13)} ${`${Math.round(s.share * 100)} %`.padStart(5)}  ${(s.usedFraction === null ? "—" : s.usedFraction.toFixed(2)).padEnd(5)}  ${`${tokens(s.tokens.in)} / ${tokens(s.tokens.out)}`.padEnd(16)}  ${model.padEnd(14)}  ${s.account}`
    );
  });
  if (ranked.length > SESSIONS_SHOWN) {
    out.push(
      paint.dim(`     … ${ranked.length - SESSIONS_SHOWN} more (--json lists every session)`)
    );
  }
  for (const s of r.sessions.filter((x) => x.session === "unattributed")) {
    out.push(
      `  -  ${"unattributed".padEnd(13)} ${`${Math.round(s.share * 100)} %`.padStart(5)}  ${(s.usedFraction === null ? "—" : s.usedFraction.toFixed(2)).padEnd(5)}  ${"—".padEnd(16)}  ${"".padEnd(14)}  ${paint.dim("(Codex CLI / ChatGPT app)")}`
    );
  }
  return out;
}

/** The whole human view; evidence `none` is the one no-usage line. */
export function renderForecast(r: AllowanceReport, paint: ForecastPaint = PLAIN): string[] {
  if (r.status === "insufficient-evidence") return [NO_USAGE_LINE];
  const model = alertModelLine(r.strategy);
  return [
    paint.strong(header(r)),
    ...(model ? [paint.dim(model)] : []),
    ...alertLines(r, paint),
    ...graphLines(r, paint),
    ...sessionLines(r, paint),
  ];
}
