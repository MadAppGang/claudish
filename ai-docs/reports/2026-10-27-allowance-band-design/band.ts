// Band, ONE row, future as a ruler: a time line now → 6d (square-root scale, ticks 1h 6h 1d 3d 6d),
// coloured by the account in use, a short-name badge at each usual switch, ┈ over the switch
// window, red ╳ while nothing is left, ◔ at a refill that wastes allowance. Light and dark.
const hex = (h: string) => { const n = Number.parseInt(h.slice(1), 16); return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`; };
const vis = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;

type Acct = "second" | "work" | "personal" | "client";
type Theme = {
  name: string; page: string; frame: string; text: string; dim: string; track: string; chipInk: string;
  ok: string; warn: string; bad: string; badInk: string; acct: Record<Acct, string>;
  under: string[]; over: string[]; // gauge heat stops, two to four steps from safe pace
};
const DARK: Theme = {
  name: "DARK", page: "#16171D", frame: "#5A5E78", text: "#D8DAE5", dim: "#9AA0BC", track: "#3A3D4E", chipInk: "#0B0B12",
  ok: "#22E06B", warn: "#FFB454", bad: "#FF4D5E", badInk: "#FFFFFF", under: ["#FFD166", "#FFB454", "#FF9A3C"], over: ["#FACC15", "#FB923C", "#FF4D5E"],
  acct: { second: "#B07CFF", work: "#4D9DFF", personal: "#22D3EE", client: "#F472B6" },
};
const LIGHT: Theme = {
  name: "LIGHT", page: "#FFFFFF", frame: "#8F94AC", text: "#0B0B12", dim: "#4B5068", track: "#D4D6E0", chipInk: "#FFFFFF",
  ok: "#166534", warn: "#B45309", bad: "#B91C1C", badInk: "#FFFFFF", under: ["#A16207", "#B45309", "#C2410C"], over: ["#CA8A04", "#EA580C", "#B91C1C"],
  acct: { second: "#7C3AED", work: "#2563EB", personal: "#0891B2", client: "#DB2777" },
};

type Who = Acct | "gap";
type State = {
  acct: Acct; h5: number; wk: number; perMin: number; safePerMin: number;
  plan: [number, Who][];          // [hour from now when it starts (usual), who]
  windows: [number, number][];    // per switch after the first segment: [soonest, latest]
  lost?: number;                  // hour of a refill that throws allowance away
  lostShare?: number;             // share of a week it throws away
};
const SLOW: State = {
  acct: "second", h5: 4, wk: 3, perMin: 0.9, safePerMin: 2.5,
  plan: [[0, "second"], [56, "work"], [130, "personal"]], windows: [[50, 62], [118, 144]], lost: 52, lostShare: 1 / 3,
};
const FINE: State = {
  acct: "second", h5: 2, wk: 3, perMin: 2.4, safePerMin: 2.5,
  plan: [[0, "second"], [29, "work"], [70, "personal"], [110, "second"]], windows: [[26, 33], [62, 78], [98, 122]],
};
const FAST: State = {
  acct: "second", h5: 2, wk: 1, perMin: 3.4, safePerMin: 2.5,
  plan: [[0, "second"], [8, "work"], [29, "personal"], [52, "second"], [76, "client"], [79, "gap"], [126, "client"], [136, "work"]],
  windows: [[6, 11], [25, 34], [45, 59], [67, 86], [74, 88], [126, 126], [136, 136]],
};

const k = (n: number) => (n >= 10 ? `${Math.round(n)}k` : `${n.toFixed(1)}k`);
const mix = (a: string, b: string, p: number) => {
  const [x, y] = [a, b].map((h) => [16, 8, 0].map((s) => (Number.parseInt(h.slice(1), 16) >> s) & 255));
  return "#" + x!.map((v, i) => Math.round(v + (y![i]! - v) * p).toString(16).padStart(2, "0")).join("");
};


// Under-use options. `share` is the part of the current profile's week that the refill throws away.
type UStyle = "rings" | "ringsPct" | "meter" | "chip" | "pct" | "acct" | "G" | "H" | "I" | "J" | "K";
const STYLE_NAME: Record<UStyle, string> = {
  rings: "A ○ count", ringsPct: "B ○ + %", meter: "C ●○ of 5", chip: "D % badge", pct: "E −%", acct: "F one box", G: "G grey│tint", H: "H amb│tint", I: "I grey▌tint", J: "J all tint", K: "K own hue",
};
const under = (s: State, t: Theme, share: number) => {
  const pctOf = `${Math.round(share * 100)}%`;
  return { share, pctOf };
};

const draw = (t: Theme) => {
  const NEUTRAL = mix(t.text, t.page, 0.25);
  // No background of our own: the terminal theme owns it. t.page is only the base the tints mix with.
  const page = "";
  const f = (c: string, b = false) => (x: string) => `\x1b[${b ? "1;" : ""}38;2;${hex(c)}m${x}\x1b[22;39m`;
  const cell = (bgc: string, fgc: string, ch: string, b = false) => `\x1b[${b ? "1;" : ""}48;2;${hex(bgc)};38;2;${hex(fgc)}m${ch}\x1b[22;39;49m`;
  const chip = (bgc: string, ink: string) => (x: string) => `\x1b[1;48;2;${hex(bgc)};38;2;${hex(ink)}m ${x} \x1b[22;39;49m`;
  const amber = f(t.warn, true);

  // The run drawn just before the wasteful refill, one string per cell, left to right.
  const run = (u: UStyle, share: number, who: string, hue: string): string[] => {
    // K: two tones of the profile's own colour: the number solid, the part thrown away on its tint.
    if (u === "K") { const tn = mix(hue, t.page, t.name === "DARK" ? 0.72 : 0.84); return [cell(hue, t.chipInk, who, true), ...[`−${Math.round(share * 100)}%`].flatMap((x) => [...x]).map((c) => cell(tn, hue, c, true))]; }
    // F: one badge for the profile that leaves allowance unused: its number and the part of its week thrown away.
    // Split badges: the profile number as a badge, the percent on a light amber tint beside it.
    const tint = mix(t.warn, t.page, t.name === "DARK" ? 0.72 : 0.84), p = `−${Math.round(share * 100)}%`;
    const soft = (x: string) => [...x].map((c) => cell(tint, t.warn, c, true));
    if (u === "G") return [cell(NEUTRAL, t.chipInk, who, true), ...soft(p)];
    if (u === "H") return [cell(t.warn, t.chipInk, who, true), ...soft(p)];
    if (u === "I") return [cell(NEUTRAL, t.chipInk, who, true), cell(tint, t.warn, "▌"), ...soft(p)];
    if (u === "J") return [cell(tint, t.text, who, true), cell(tint, t.warn, " "), ...soft(p)];
    if (u === "acct") return [...`${who} −${Math.round(share * 100)}%`].map((c) => cell(t.warn, t.chipInk, c, true));
    const pct = [...`${Math.round(share * 100)}%`];
    const rings = Array(Math.max(1, Math.round(share * 12))).fill(amber("○"));
    if (u === "rings") return rings;
    if (u === "ringsPct") return [...rings, ...pct.map((c) => amber(c))];
    if (u === "meter") {
      // Five places, 20% each: ● thrown away, ◐ half a place, dim ○ the part that gets used.
      const full = Math.floor(share * 5 + 1e-9), half = share * 5 - full >= 0.5;
      return Array.from({ length: 5 }, (_, i) => (i < full ? amber("●") : i === full && half ? amber("◐") : f(t.dim)("○")));
    }
    if (u === "chip") return [..." " + pct.join("") + " "].map((c) => cell(t.warn, t.chipInk, c, true));
    return [amber("−"), ...pct.map((c) => amber(c))];
  };

  const ruler = (s: State, u: UStyle, RW: number, hued = false) => {
    const badge = (w: Acct) => (hued ? t.acct[w] : NEUTRAL);
    const MAX = 144, X = (h: number) => Math.min(RW - 1, Math.round(Math.sqrt(h / MAX) * (RW - 1)));
    const NUM: Record<Acct, string> = { second: "1", work: "2", personal: "3", client: "4" };
    const whoAt = (h: number) => { let w: Who = s.plan[0]![1]; for (const [st, x] of s.plan) if (h >= st) w = x; return w; };
    const hourOf = (i: number) => ((i + 0.5) / (RW - 1)) ** 2 * MAX;
    const cells: (string | null)[] = Array(RW).fill(null);
    const free = (i: number, n: number) => i >= 0 && i + n <= RW && cells.slice(i, i + n).every((c) => c === null);
    s.plan.forEach(([h, w], n) => { if (n > 0 && w !== "gap" && free(X(h), 1)) cells[X(h)] = cell(badge(w), t.chipInk, NUM[w], true); });
    if (s.lost !== undefined) {
      const w = whoAt(s.lost - 0.01); const r = run(u, s.lostShare ?? 0, w === "gap" ? "?" : NUM[w], w === "gap" ? t.bad : t.acct[w]);
      let i = X(s.lost) - 1;
      for (let k = r.length - 1; k >= 0 && i >= 0; i--) if (cells[i] === null) cells[i] = r[k--]!;
    }
    for (const [h, lbl] of [[1, "1h"], [6, "6h"], [24, "1d"], [72, "3d"]] as const) {
      const i = X(h);
      // A tick needs a free cell on each side, so it never reads as part of a badge ("1d1−20%").
      if (free(i - 1, lbl.length + 2) && [...lbl].every((_, k) => whoAt(hourOf(i + k)) !== "gap")) [...lbl].forEach((c, k) => (cells[i + k] = f(t.dim)(c)));
    }
    for (let i = 0; i < RW; i++) if (cells[i] === null) {
      const h = hourOf(i), w = whoAt(h);
      if (w === "gap") { cells[i] = f(t.bad, true)("╳"); continue; }
      const win = s.windows.some(([lo, hi], n) => hi > lo && h >= lo && h < s.plan[n + 1]![0]);
      cells[i] = f(NEUTRAL)(win ? "┈" : "━");
    }
    return `${f(t.dim)("now")}${cells.join("")}${f(t.dim)("6d")}`;
  };

  const band = (s: State, u: UStyle, open: boolean, hued = false, W = 100) => {
    const level = (n: number) => (n > 2 ? t.ok : n > 1 ? t.warn : t.bad);
    const mini = (n: number) => f(level(n))("▮".repeat(n)) + f(t.track)("▮".repeat(4 - n));
    const GW = 9, C = 4, pos = C + Math.max(-C, Math.min(C, Math.round(Math.log2(s.perMin / s.safePerMin) * 4)));
    const zoneOf = (i: number) => (i < C - 1 ? t.warn : i > C + 1 ? t.bad : t.ok);
    // Heights: bars rise away from safe pace; centre-to-speed is lit. Middle three = safe (green),
    // then heat stops outward; the unlit scale is a tint of the colour each bar would light in.
    const heat = (i: number) => (Math.abs(i - C) <= 1 ? t.ok : (i < C ? t.under : t.over)[Math.abs(i - C) - 2]!);
    const tint = (c: string) => mix(c, t.page, t.name === "DARK" ? 0.72 : 0.78);
    const on = (i: number) => (pos < C && i >= pos && i < C) || (pos > C && i <= pos && i > C);
    const gauge = Array.from({ length: GW }, (_, i) => {
      const h = "▁▂▄▆█"[Math.abs(i - C)]!;
      if (i === C) return f(t.ok, true)(pos === C ? "█" : "▁");
      return on(i) ? f(heat(i), true)(h) : f(tint(heat(i)))(h);
    }).join("");
    // The rate takes the colour of the gauge's lit tip; plain text while inside the safe band.
    const tone = Math.abs(pos - C) <= 1 ? t.text : heat(pos);
    const rate = `${f(tone, true)(k(s.perMin))}${f(t.dim)("/m")} ${f(tone)(k(s.perMin * 60))}${f(t.dim)("/h")}`;
    // The mod's own button look (band.tsx `button`): `[ label ]`, no fill. Hide while the panel is open.
    const btn = open ? f(t.text, true)("[ Hide ]") : f(t.dim, true)("[ Show ]");
    const left = `${chip(hued ? t.acct[s.acct] : NEUTRAL, t.chipInk)("1")} ${f(t.dim)("5h")}${mini(s.h5)} ${f(t.dim)("wk")}${mini(s.wk)} ${gauge} ${rate} ${ruler(s, u, 38, hued)}`;
    const inner = W - 6, body = `${left}${" ".repeat(Math.max(1, inner - vis(left) - vis(btn)))}${btn}`;
    if (vis(body) > inner) throw new Error(`band body ${vis(body)} > ${inner}`);
    const line = (x: string) => `${page}${x}${" ".repeat(Math.max(0, W - vis(x)))}\x1b[0m`;
    const fr = f(t.frame);
    return [
      line(` ${fr("╭" + "─".repeat(W - 4) + "╮")}`),
      line(` ${fr("│")} ${body}${" ".repeat(Math.max(0, inner - vis(body)))} ${fr("│")}`),
      line(` ${fr("╰" + "─".repeat(W - 4) + "╯")}`),
    ];
  };
  return { ruler, band, f, page };
};

const at = (share: number): State => ({ ...SLOW, lostShare: share });
const out: string[] = [];
const head = (x: string) => out.push(`\x1b[1;48;5;53;38;5;231m  ${x}  \x1b[0m`);
for (const t of [DARK, LIGHT]) {
  const d = draw(t);
  const row = (x: string) => out.push(`${d.page}${x}${" ".repeat(Math.max(0, 100 - vis(x)))}\x1b[0m`);
  head(`${t.name} · under-use options, ruler only`);
  row(`${d.f(t.dim)("             20% thrown away                            50% thrown away")}`);
  for (const [u, hued] of [["K", true]] as [UStyle, boolean][]) {
    const a = d.ruler(at(0.2), u, 38, hued), b = d.ruler(at(0.5), u, 38, hued);
    row(` ${d.f(t.text)((STYLE_NAME[u] + (hued ? "s" : "")).padEnd(11))} ${a}  ${b}`);
  }
  head(`${t.name} · full band: under-use, on pace, too fast`);
  out.push(...d.band(at(1 / 3), "K", false, true), ...d.band(FINE, "K", false, true), ...d.band(FAST, "K", true, true));
}
out.push("\x1b[90m  1−33% profile 1 leaves a third of its week unused   2 profile 2 takes over   ╳ nothing left   [ Show ] opens the full forecast panel\x1b[0m");
console.log(out.join("\n"));
