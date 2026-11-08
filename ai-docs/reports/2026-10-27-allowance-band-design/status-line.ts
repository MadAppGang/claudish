// Short forms of the allowance view: the claudish mod band (above the prompt) and the
// status line (below it). Same example data as relay-strip-v12. Now: Tue 14:08.
const esc = (c: string) => (s: string) => `\x1b[${c}m${s}\x1b[0m`;
const fg = (n: number) => esc(`38;5;${n}`);
const bg = (b: number, f = 16) => esc(`48;5;${b};38;5;${f}`);
const bold = esc("1"), dim = esc("90"), white = esc("1;97");
const vis = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vis(s)));

const RED = 196, YEL = 220, GOOD = 42;
const acct = { second: 141, work: 39, personal: 44, client: 214 } as const;
const chip = (a: keyof typeof acct) => bg(acct[a])(bold(` ${a} `));
const gauge = (n: number, w = 8) => {
  const c = n / w > 0.5 ? GOOD : n / w > 0.2 ? YEL : RED;
  return fg(c)("█".repeat(n)) + fg(238)("█".repeat(w - n));
};
const mini = (n: number, w = 4) => {
  const c = n / w > 0.5 ? GOOD : n / w > 0.2 ? YEL : RED;
  return fg(c)("▮".repeat(n)) + fg(238)("▮".repeat(w - n));
};
// Speed: last 10 min against the safe pace; the needle sits in green/yellow/red zones.
const speedo = (v: number, safe: number, w = 12) => {
  const max = safe * 1.6, pos = Math.min(w - 1, Math.round((v / max) * (w - 1)));
  return Array.from({ length: w }, (_, i) => {
    const f = i / (w - 1), z = f < 2 / 3 ? GOOD : f < 5 / 6 ? YEL : RED;
    return i === pos ? white("┃") : fg(z)("━");
  }).join("");
};
// Next switch as a range on a 0-12h track: soonest..latest filled, usual marked.
const range = (soon: number, usual: number, late: number, w = 24, span = 12) =>
  Array.from({ length: w }, (_, i) => {
    const h = (i + 0.5) * (span / w);
    if (Math.abs(h - usual) < span / w / 2) return fg(acct.work)(bold("●"));
    if (h >= soon && h <= late) return fg(acct.work)("━");
    return fg(238)("─");
  }).join("");
const sparks = [2, 3, 3, 5, 4, 6, 7, 5, 8, 7].map((v) => fg(v > 6 ? RED : v > 4 ? YEL : GOOD)("▁▂▃▄▅▆▇█"[v - 1]!)).join("");

const W = 100;
const out: string[] = [];
const P = (s = "") => out.push(s);
const title = (t: string) => P(`\n${bg(53, 231)(bold(`  ${t}  `))}`);
const frame = (rows: string[]) => {
  P(dim("╭" + "─".repeat(W - 2) + "╮"));
  for (const r of rows) P(dim("│") + " " + pad(r, W - 4) + " " + dim("│"));
  P(dim("╰" + "─".repeat(W - 2) + "╯"));
  P(dim("  ❯ ") + dim("type a prompt…"));
};

// ── Band ──────────────────────────────────────────────────────────────────────
title("BAND A · one row, everything");
frame([
  `${bold("CODEX")} ${chip("second")}  5h ${gauge(4)} ${dim("↻")} 2h 52m   week ${gauge(1)}   ` +
    `${fg(RED)("⚡")} 34k${dim("/10m")} ${fg(RED)("too fast")}  ${dim("⇄")} ${chip("work")} in ${white("6–11h")}`,
]);

title("BAND B · two rows: now, then next switch as a range");
frame([
  `${bold("CODEX")} ${chip("second")}  5h ${gauge(4)} ${dim("↻ 2h 52m")}  week ${gauge(1)}  ` +
    `speed ${speedo(34, 25)} ${fg(RED)(bold("34k"))}${dim("/10m · safe 25k")}`,
  `${dim("next switch")}  ${dim("now")} ${range(5.9, 7.9, 10.9)} ${dim("12h")}   ` +
    `${chip("work")} in ${white(bold("6–11h"))} ${dim("· likely 7h 52m")}  ${fg(RED)("⚠ out 3d 6h")}`,
]);

title("BAND C · calm when fine, loud only when it matters");
frame([
  `${bold("CODEX")} ${chip("second")}  ${fg(GOOD)("● fine")}  ${dim("5h")} ${mini(2)}  ${dim("week")} ${mini(3)}  ${dim("⇄")} ${chip("work")} ${dim("in 1d 2h–1d 9h")}`,
]);
P(dim("  …and when burning too fast:"));
frame([
  `${bold("CODEX")} ${chip("second")}  ${bg(RED, 231)(bold(" ⚡ TOO FAST "))} ${sparks} 34k${dim("/10m vs 25k")}  ` +
    `${dim("⇄")} ${chip("work")} in ${white(bold("6–11h"))}  ${fg(RED)("⚠ out in 3d 6h")}`,
]);

// ── Status line ───────────────────────────────────────────────────────────────
const sep = ` ${dim("•")} `;
const base = `${fg(51)(bold("multi-subscriptin"))}${sep}${fg(YEL)("cx@gpt-6-astra")}${sep}${fg(GOOD)("$0.00")}${sep}${fg(201)("ctx 34%")}`;
title("STATUS LINE · today");
P(`  ${base}${sep}${fg(GOOD)("pool 62%")}`);
title("STATUS LINE S1 · account, two gauges, speed, switch range");
P(`  ${base}${sep}${fg(acct.second)(bold("second"))} 5h${mini(2)} wk${mini(1)}${sep}${fg(RED)("⚡34k/10m")}${sep}${dim("⇄")}${fg(acct.work)("work")} 6–11h`);
title("STATUS LINE S2 · shortest");
P(`  ${base}${sep}${fg(acct.second)("●second")} ${fg(YEL)("5h 50%")} ${fg(RED)("wk 12%")} ${fg(RED)("⚡")} ${dim("⇄")}6–11h`);
title("STATUS LINE S3 · when a gap is predicted (existing warn kept, appended)");
P(`  ${base}${sep}${fg(acct.second)("●second")} 5h${mini(2)} wk${mini(1)} ${fg(RED)("⚡")} ${dim("⇄")}6–11h${sep}${fg(YEL)("⚠ out 3d 6h")}`);

P();
P(dim("  ▮ = quarter left  ⚡ = faster than safe pace  ⇄ = next switch, soonest–latest  ↻ = 5h limit refills"));
console.log(out.join("\n"));
