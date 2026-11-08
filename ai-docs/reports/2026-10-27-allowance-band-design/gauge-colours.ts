// Gauge E (heights) colour options. Same shape: bars rise away from the centre (safe pace); the
// part from the centre to the current speed is lit. Only the colours differ. Dark and light.
const hex = (h: string) => { const n = Number.parseInt(h.slice(1), 16); return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`; };
const vis = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
const mix = (a: string, b: string, p: number) => {
  const [x, y] = [a, b].map((h) => [16, 8, 0].map((s) => (Number.parseInt(h.slice(1), 16) >> s) & 255));
  return "#" + x!.map((v, i) => Math.round(v + (y![i]! - v) * p).toString(16).padStart(2, "0")).join("");
};
// heat[1..4]: the colour of a lit bar that far from the centre, per side.
type Theme = { name: string; page: string; text: string; dim: string; track: string; ok: string; warn: string; bad: string; under: string[]; over: string[] };
const DARK: Theme = {
  name: "DARK", page: "#16171D", text: "#D8DAE5", dim: "#9AA0BC", track: "#3A3D4E", ok: "#22E06B", warn: "#FFB454", bad: "#FF4D5E",
  under: ["#FFD166", "#FFB454", "#FF9A3C"], over: ["#FACC15", "#FB923C", "#FF4D5E"],
};
const LIGHT: Theme = {
  name: "LIGHT", page: "#FFFFFF", text: "#0B0B12", dim: "#4B5068", track: "#D4D6E0", ok: "#15803D", warn: "#B45309", bad: "#B91C1C",
  under: ["#A16207", "#B45309", "#C2410C"], over: ["#CA8A04", "#EA580C", "#B91C1C"],
};
const STATES: [string, number][] = [["very slow", 0.36], ["a bit slow", 0.84], ["slow", 0.6], ["on pace", 1], ["fast", 1.4], ["very fast", 2.6]];

const draw = (t: Theme) => {
  const page = `\x1b[48;2;${hex(t.page)}m`;
  const f = (c: string, b = false) => (x: string) => `\x1b[${b ? "1;" : ""}38;2;${hex(c)}m${x}\x1b[22;39m`;
  const GW = 9, C = 4, H = "▁▂▄▆█";
  const posOf = (r: number) => C + Math.max(-C, Math.min(C, Math.round(Math.log2(r) * 4)));
  // The three middle bars are the safe band: green. Amber or red starts two steps out.
  const safe = (i: number) => Math.abs(i - C) <= 1;
  const side = (i: number) => (safe(i) ? t.ok : i < C ? t.warn : t.bad);
  const heat = (i: number) => (safe(i) ? t.ok : (i < C ? t.under : t.over)[Math.abs(i - C) - 2]!);
  const tint = (c: string) => mix(c, t.page, t.name === "DARK" ? 0.72 : 0.78);
  // lit(i, p): is bar i between the centre and the speed p (the centre bar is lit only on pace)?
  const lit = (i: number, p: number) => (p < C && i >= p && i < C) || (p > C && i <= p && i > C);
  const gauge = (litColour: (i: number) => string, dark: (i: number) => string, centre: (p: number) => string) => (r: number) => {
    const p = posOf(r);
    return Array.from({ length: GW }, (_, i) => {
      const h = H[Math.abs(i - C)]!;
      if (i === C) return p === C ? f(t.ok, true)("█") : f(t.ok, true)("▁");
      return lit(i, p) ? f(litColour(i), true)(h) : f(dark(i))(h);
    }).join("");
  };
  return {
    page, f,
        G2: gauge(side, (i) => tint(side(i)), () => t.ok),        // the unlit scale tinted by its side
        G4: gauge(heat, (i) => tint(heat(i)), () => t.ok),        // heat on both: lit full, unlit tinted
  };
};

const NAMES = { G2: "G2 tinted scale", G4: "G4 heat + tint" } as const;
const out: string[] = [];
for (const t of [DARK, LIGHT]) {
  const d = draw(t);
  const line = (x: string) => out.push(`${d.page}${x}${" ".repeat(Math.max(0, 100 - vis(x)))}\x1b[0m`);
  out.push(`\x1b[1;48;5;53;38;5;231m  ${t.name}  \x1b[0m`);
  line(" " + " ".repeat(17) + STATES.map(([n]) => d.f(t.dim)(n.padEnd(14))).join(""));
  for (const k of Object.keys(NAMES) as (keyof typeof NAMES)[]) {
    line(" " + d.f(t.text)(NAMES[k].padEnd(17)) + STATES.map(([, r]) => d[k](r) + " ".repeat(5)).join(""));
    line("");
  }
}
console.log(out.join("\n"));
