// Relay strip v3: v2 plus fuel left per account, switch row with "likely between" spans,
// and next Monday so the work refill that ends the shortage is visible. Example data.
// One cell = 4 hours. Hour 0 = Mon 19 Oct 00:00; 90 cells = two weeks + next Monday.
const esc = (c: string) => (s: string) => `\x1b[${c}m${s}\x1b[0m`;
const fg = (n: number) => esc(`38;5;${n}`);
const bold = esc("1"), dim = esc("90"), white = esc("1;97");
const vis = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vis(s)));

const RED = 196, GOOD = 42, WASTE = 220, OUTSIDE = 244;
const acct = { second: 141, work: 39, personal: 44, client: 214 } as const;
type Acct = keyof typeof acct;
type Who = Acct | "gap";
const CELLS = 90, LBL = 15, NOW_H = 168 + 38; // Tue 27 Oct 14:00
const cellOf = (h: number) => Math.floor(h / 4);
const mid = (i: number) => i * 4 + 2;
// Now is 14:08 in this example, so durations count minutes from there.
const NOW_MIN = NOW_H * 60 + 8;
// Time from now to an hour mark: "7h 52m", "1d 4h". Every time on screen is a duration.
const dur = (h: number, fromMin = NOW_MIN) => {
  const t = h * 60 - fromMin, d = Math.floor(t / 1440), hr = Math.floor((t % 1440) / 60), m = t % 60;
  return d ? `${d}d ${hr}h` : `${hr}h ${m}m`;
};
const hoursFromNow = (h: number) => Math.round((h * 60 - NOW_MIN) / 60);
const NOWC = cellOf(NOW_H);
const FOG = "\x1b[48;5;237m";
const faded = (n: number) => esc(`2;38;5;${n}`);
// Everything after now sits on a grey background; the now cell is a white line on every row.
const zone = (i: number, s: string) =>
  i === NOWC ? white("┃") : i > NOWC ? `${FOG}${s.replaceAll("\x1b[0m", "\x1b[0m" + FOG)}\x1b[0m` : s;

const usual: [number, Who][] = [
  [0, "second"], [8, "work"], [63, "personal"], [114, "second"],
  [214, "work"], [235, "personal"], [258, "second"], [282, "client"], [285, "gap"], [332, "client"], [342, "work"],
];
const slower: [number, Who][] = [[214, "work"], [238, "personal"], [274, "second"], [302, "client"], [342, "work"]];
const whoAt = (plan: [number, Who][], h: number) => {
  let w: Who | undefined;
  for (const [s, x] of plan) if (h >= s) w = x;
  return w;
};
const weekday = (h: number) => Math.floor(h / 24) % 7 < 5;
const level = (h: number) => {
  const hod = h % 24;
  if (weekday(h) && hod >= 9 && hod < 19) return 3; // busy
  if (weekday(h) && hod >= 19) return 2; // evening
  return 1; // night, weekend
};

const strip = (plan: [number, Who][], from = 0) =>
  [3, 2, 1].map((row) =>
    Array.from({ length: CELLS }, (_, i) => {
      const h = mid(i);
      const w = h < from ? undefined : whoAt(plan, h);
      const c = (() => {
        if (!w) return " ";
        if (w === "gap") return fg(RED)("█");
        if (level(h) < row) return " ";
        return h < NOW_H ? fg(acct[w])("█") : faded(acct[w])("▓");
      })();
      return zone(i, c);
    }).join(""),
  );

// Switches: past ones are exact; predicted ones carry a "likely between" span [from, to].
const pastSwitches: [number, Acct][] = [[8, "work"], [63, "personal"], [114, "second"]];
const nextSwitches: [number, number, number, Acct, string][] = [
  [214, 212, 217, "work", "Tue 22:00"],
  [235, 231, 240, "personal", "Wed 19:00"],
  [258, 251, 265, "second", "Thu 18:00"],
  [282, 273, 292, "client", "Fri 18:00"],
];
const switchRow = Array.from({ length: CELLS }, () => " ");
for (const [h, a] of pastSwitches) switchRow[cellOf(h)] = fg(acct[a])(bold("│"));
for (const [h, from, to, a] of nextSwitches) {
  const c = fg(acct[a]);
  for (let i = cellOf(from); i <= cellOf(to); i++) switchRow[i] = c("─");
  switchRow[cellOf(from)] = c("├");
  switchRow[cellOf(to)] = c("┤");
  switchRow[cellOf(h)] = c(bold("┼"));
}

const refills: Record<Acct, number[]> = {
  second: [81, 249], work: [6, 174, 342], personal: [57, 225], client: [164, 332],
};
const fiveHour: Partial<Record<Acct, number[]>> = { second: [168 + 41] }; // Tue 17:00
const wasted: Partial<Record<Acct, [number, number]>> = { personal: [0, 57], second: [8, 81], client: [0, 164] };

// Words written on a fill, dark text on the fill's colour, so no legend lookup is needed.
const tags: Partial<Record<Acct, [number, number, string, number][]>> = {
  personal: [[0, 57, "unused → lost", WASTE]],
  second: [[8, 81, "unused → lost", WASTE]],
  client: [[0, 164, "unused all week → lost", WASTE], [164, 206, "ChatGPT", OUTSIDE]],
};
const lane = (a: Acct) => {
  const cells = Array.from({ length: CELLS }, (_, i) => laneCell(a, i));
  for (const [from, to, text, colour] of tags[a] ?? []) {
    const c0 = Math.ceil(from / 4), c1 = Math.floor(to / 4) - 1;
    const start = c0 + Math.max(0, Math.floor((c1 - c0 + 1 - text.length) / 2));
    [...text].forEach((ch, k) => (cells[start + k] = `\x1b[48;5;${colour};38;5;16;1m${ch}\x1b[0m`));
  }
  return cells.map((c, i) => zone(i, c)).join("");
};
const laneCell = (a: Acct, i: number) => {
  {
    const h = mid(i);
    if (refills[a].some((r) => cellOf(r) === i)) return fg(acct[a])(bold("┃"));
    if (fiveHour[a]?.some((r) => cellOf(r) === i)) return white("◆");
    if (whoAt(usual, h) === a) return h < NOW_H ? fg(acct[a])("█") : faded(acct[a])("▓");
    const span = wasted[a];
    if (span && h >= span[0] && h < span[1]) return fg(WASTE)("░");
    if (a === "client" && h >= 164 && h < NOW_H) return fg(OUTSIDE)("▓");
    return dim("·");
  }
};

// Fuel left right now, in quarters.
const fuel = (a: Acct, q: number) => fg(acct[a])("▰".repeat(q)) + dim("▱".repeat(4 - q));
const fuelNow: Record<Acct, number> = { second: 1, work: 4, personal: 0, client: 1 };

const out: string[] = [];
const P = (s = "") => out.push(s);
const L = (s: string) => pad(s, LBL);
const n = (a: Acct) => fg(acct[a])(bold(a));
const marker = (ch: string, label: string) => {
  const r = Array.from({ length: CELLS }, () => " ");
  r[cellOf(NOW_H)] = white(ch + label);
  return `${L("")}${r.join("")}`;
};

P(`${fg(RED)(bold(`⚠  Codex runs out in ${dur(285)}, and stays out for ${dur(332, 285 * 60)}.`))}          likely ${fg(RED)("●●●●●●●")}${dim("○○○")}`);
P(`   ${bold("Use about a third less from Wednesday morning and it lasts.")}`);
P(`   Now on ${n("second")}: its 5-hour limit refills in ${white("◆ 2h 52m")}, its week runs out in 7h 52m.`);
P();
// Next switch card: a large countdown, the hand-off as two account chips, and a bar of the
// current account's week draining toward the switch. Example: now 14:08, switch Tue 22:00.
const DIGITS: Record<string, string[]> = {
  "0": ["█▀▀█", "█  █", "█▄▄█"], "1": [" ▄█ ", "  █ ", " ▄█▄"], "2": ["▀▀▀█", "█▀▀▀", "█▄▄▄"],
  "3": ["▀▀▀█", " ▀▀█", "▄▄▄█"], "4": ["█  █", "▀▀▀█", "   █"], "5": ["█▀▀▀", "▀▀▀█", "▄▄▄█"],
  "6": ["█▀▀▀", "█▀▀█", "█▄▄█"], "7": ["▀▀▀█", "  █ ", " █  "], "8": ["█▀▀█", "█▀▀█", "█▄▄█"],
  "9": ["█▀▀█", "▀▀▀█", "▄▄▄█"],
};
const bigNumber = (parts: [number, string][], colour: number) =>
  [0, 1, 2].map((row) =>
    parts
      .map(([v, unit]) => [...String(v)].map((d) => fg(colour)(DIGITS[d]![row]!)).join(" ") + (row === 2 ? ` ${bold(unit)}` : "  "))
      .join("  "),
  );
const chip = (a: Acct) => `\x1b[48;5;${acct[a]};38;5;16;1m ${a} \x1b[0m`;
const drain = (left: number, of: number, w: number, a: Acct) =>
  fg(acct[a])("█".repeat(Math.round((left / of) * w))) + dim("░".repeat(w - Math.round((left / of) * w)));
DIGITS["-"] = ["    ", "▀▀▀ ", "    "];
// When the switch happens depends on how fast you burn: hours from now.
const SOONEST = hoursFromNow(212), USUAL = (214 * 60 - NOW_MIN) / 60, LATEST = hoursFromNow(217);
const bigRange = [0, 1, 2].map((row) =>
  [...`${SOONEST}-${LATEST}`].map((d) => fg(acct.work)(DIGITS[d]![row]!)).join(" ") + (row === 2 ? ` ${bold("h")}` : "  "),
);
// Likelihood hill over the next 12 hours, one column per 10 minutes, two rows of eighths.
const HILL_W = 72, HILL_H = 12;
const likelihood = (t: number) => Math.exp(-((Math.log(t) - Math.log(USUAL)) ** 2) / (2 * 0.2 ** 2));
const hill = [1, 0].map((row) =>
  Array.from({ length: HILL_W }, (_, c) => {
    const t = ((c + 0.5) / HILL_W) * HILL_H;
    const fill = Math.max(0, Math.min(8, Math.round(likelihood(t) * 16) - row * 8));
    const g = " ▁▂▃▄▅▆▇█"[fill]!;
    return t >= SOONEST && t <= LATEST ? fg(acct.work)(g) : fg(240)(g);
  }).join(""),
);
const colOf = (t: number) => Math.round((t / HILL_H) * HILL_W);
const axis = Array.from({ length: HILL_W + 4 }, () => dim("─"));
for (let hr = 0; hr <= HILL_H; hr += 2) {
  const tag = hr === 0 ? "now" : `${hr}h`;
  [...tag].forEach((ch, k) => (axis[colOf(hr) + k] = dim(ch)));
}
const marks = Array.from({ length: HILL_W + 12 }, () => " ");
const placeMark = (t: number, text: string, colour: number, side: "left" | "right" = "right") => {
  const label = side === "right" ? `▲ ${text}` : `${text} ▲`;
  const start = side === "right" ? colOf(t) : colOf(t) - label.length + 1;
  [...label].forEach((ch, k) => (marks[start + k] = fg(colour)(bold(ch))));
};
placeMark(SOONEST, "this speed", RED, "left");
placeMark(USUAL, "usual", acct.work);
placeMark(LATEST, "slower", GOOD);

const CARD_W = 100;
const cardLine = (body = "") => `   ${fg(acct.work)("┃")} ${pad(body, CARD_W - 3)}${fg(acct.work)("┃")}`;
P(`   ${fg(acct.work)("┏" + "━".repeat(CARD_W - 2) + "┓")}`);
P(cardLine(`${bold("NEXT SWITCH")}   ${chip("second")} ${fg(acct.work)("━━━━━━━━━▶")} ${chip("work")}`));
P(cardLine());
const rangeSide = [dim("most likely in"), bold(white(dur(214))), dim("at your usual speed")];
bigRange.forEach((r, k) => P(cardLine(`  ${pad(r, 34)}${rangeSide[k]}`)));
P(cardLine());
hill.forEach((r) => P(cardLine(`  ${r}`)));
P(cardLine(`  ${axis.join("")}`));
P(cardLine(`  ${marks.join("")}`));
P(cardLine(`  ${dim("At this speed (34k tokens / 10 min) it switches in")} ${fg(RED)(dur(212))}${dim(". Slow down and it lasts")} ${fg(GOOD)(dur(217))}${dim(".")}`));
P(`   ${fg(acct.work)("┗" + "━".repeat(CARD_W - 2) + "┛")}`);
P();
P(`${L("")}${pad(bold("LAST WEEK"), 42)}${pad(bold("THIS WEEK"), 42)}${dim("NEXT")}`);
P(`${L("")}${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => pad(d, 6)).join("").repeat(2)}${dim("Mon")}`);
const realTag = "real ◀ ", predTag = " ▶ predicted";
P(`${L("")}${" ".repeat(NOWC - realTag.length)}${bold(realTag)}${white("┃")}${FOG}${bold(predTag)}${" ".repeat(CELLS - NOWC - 1 - predTag.length)}\x1b[0m`);
const band = (plan: [number, Who][], from = 0) =>
  Array.from({ length: CELLS }, (_, i) => {
    const h = mid(i);
    const w = h < from ? undefined : whoAt(plan, h);
    const c = !w ? " " : w === "gap" ? fg(RED)("█") : h < NOW_H ? fg(acct[w])("█") : faded(acct[w])("▓");
    return zone(i, c);
  }).join("");
// How much is used per 4-hour cell, 0..1: each day has its own height, and the day
// rises in the morning, peaks in the afternoon and falls in the evening. Example data.
const dayHeight = [1, 0.85, 1, 0.8, 0.6, 0.2, 0.15, 0.9, 1, 0.85, 0.85, 0.75, 0.2, 0.15, 0.9];
const hourShape: Record<number, number> = { 2: 0.04, 6: 0.15, 10: 0.8, 14: 1, 18: 0.65, 22: 0.3 };
const intensity = (h: number) => dayHeight[Math.floor(h / 24)]! * hourShape[h % 24]!;
// Three rows tall, filled in eighths: busy hours reach the top, nights stay near the bottom.
const BUSY_ROWS = 3;
const busyRows = (plan: [number, Who][], from = 0, scale = 1) => {
  return Array.from({ length: BUSY_ROWS }, (_, k) => {
    const row = BUSY_ROWS - 1 - k; // top row first
    return Array.from({ length: CELLS }, (_, i) => {
      const h = mid(i);
      const w = h < from ? undefined : whoAt(plan, h);
      if (!w || w === "gap") return zone(i, row === BUSY_ROWS - 1 && h >= NOW_H ? fg(240)("┈") : " ");
      const eighths = Math.round(intensity(h) * scale * BUSY_ROWS * 8);
      const fill = Math.max(0, Math.min(8, eighths - row * 8));
      const g = " ▁▂▃▄▅▆▇█"[fill]!;
      if (h < NOW_H) return zone(i, fg(acct[w])(g));
      // Predicted: the top row is above the safe pace.
      if (row === BUSY_ROWS - 1) return zone(i, fill ? fg(RED)(g) : fg(240)("┈"));
      return zone(i, faded(acct[w])(g));
    }).join("");
  });
};
P(`${L(bold("in use"))}${band(usual)}`);
const busyNow = busyRows(usual);
const busyLabels = [fg(RED)("too fast ▲"), dim("how busy"), dim(" quiet ▼")];
busyNow.forEach((r, k) => P(`${L(busyLabels[k]!)}${r}`));
P(`${L(dim("switch"))}${switchRow.map((c, i) => zone(i, c)).join("")}`);
P(`${L("")}${Array.from({ length: CELLS }, (_, i) => zone(i, " ")).join("")}`);
for (const a of Object.keys(acct) as Acct[]) P(`${L(n(a))}${lane(a)}`);
P(`${L(dim("old  off"))}${Array.from({ length: CELLS }, (_, i) => zone(i, dim("╌"))).join("")}`);
P(`${L("")}${Array.from({ length: CELLS }, (_, i) => zone(i, " ")).join("")}`);
P(`${L(fg(GOOD)(bold("slower")))}${band(slower, 206)}`);
const busySlow = busyRows(slower, 206, 0.67);
const slowLabels = [dim("⅓ less busy"), fg(GOOD)("→ no gap"), ""];
busySlow.forEach((r, k) => P(`${L(slowLabels[k]!)}${r}`));
P();
const nx = nextSwitches.map(([h, , , a]) => `${n(a)} ${dim("in")} ${dur(h)}`).join(` ${dim("→")} `);
P(`${L(dim("next"))}${nx} ${dim("→")} ${fg(RED)(bold("nothing"))} ${dim("in")} ${dur(285)}`);
P();

// Speed: tokens in the last 10 minutes and the average per hour today, against the safe
// pace (what the pool can afford until the next refills). Example data.
const SPEED_W = 36;
const speedGauge = (value: number, safe: number) => {
  const max = safe * 1.5, filled = Math.round(Math.min(1, value / max) * SPEED_W);
  const zoneOf = (c: number) => (c < SPEED_W * (2 / 3) ? GOOD : c < SPEED_W * (5 / 6) ? WASTE : RED);
  return Array.from({ length: SPEED_W }, (_, c) => (c < filled ? fg(zoneOf(c))("█") : faded(zoneOf(c))("░"))).join("");
};
const k = (n: number) => `${Math.round(n / 1000)}k`;
const verdict = (v: number, safe: number) =>
  v > safe * 1.2 ? fg(RED)(bold("too fast")) : v > safe ? fg(WASTE)(bold("a bit fast")) : fg(GOOD)(bold("fine"));
const speeds: [string, number, number][] = [
  ["last 10 min", 34_000, 25_000],
  ["per hour", 195_000, 150_000],
];
const SAFE_AT = Math.round(SPEED_W * (2 / 3));
P(`${pad(bold("SPEED"), 15)}${pad(dim("slow"), SAFE_AT - 4)}${dim("safe")}${white("│")}${" ".repeat(SPEED_W - SAFE_AT - 5)}${dim("fast")}`);
for (const [label, v, safe] of speeds)
  P(`${pad(label, 15)}${speedGauge(v, safe)}  ${pad(bold(k(v)) + dim(" tokens"), 14)}${dim(`safe ${k(safe)}`)}  ${verdict(v, safe)}`);
P(`${pad("", 15)}${dim(`About a third over the safe pace. At this speed every account is empty in ${dur(285)}.`)}`);
P();

// Left now: 5-hour and weekly allowance per account, plus what the last closed week threw away.
// Amounts are eighths (0-8). Example data.
const gauge = (eighths: number) => {
  const col = eighths >= 4 ? GOOD : eighths >= 2 ? WASTE : RED;
  return fg(col)("█".repeat(eighths)) + dim("░".repeat(8 - eighths));
};
// Time left until an hour mark, from now: "3h", "19h", "1d 19h".
const until = (h: number) => `${dim("↻")} ${dur(h)}`;
const lostBar = (eighths: number) => fg(WASTE)("█".repeat(eighths)) + dim("░".repeat(8 - eighths));
type Left = { a: Acct; state: string; h5: number; h5note: string; wk: number; wknote: string; lost: number; lostWord: string; closed: string };
const left: Left[] = [
  { a: "second", state: bold("in use"), h5: 4, h5note: white(until(168 + 41)), wk: 1, wknote: until(249), lost: 6, lostWord: "most", closed: "Thu 22 Oct" },
  { a: "work", state: "next", h5: 8, h5note: "full", wk: 8, wknote: until(342), lost: 0, lostWord: "none", closed: "Mon 26 Oct" },
  { a: "personal", state: "", h5: 8, h5note: "full", wk: 0, wknote: until(225), lost: 3, lostWord: "a third", closed: "Wed 21 Oct" },
  { a: "client", state: "", h5: 8, h5note: "full", wk: 1, wknote: until(332), lost: 8, lostWord: "all", closed: "Sun 25 Oct" },
];
P(`${pad(bold("LEFT NOW"), 19)}${pad(bold("5 HOURS"), 22)}${pad(bold("THIS WEEK"), 24)}${bold("LOST WHEN LAST WEEK CLOSED")}`);
for (const r of left)
  P(`${pad(n(r.a), 10)}${pad(r.state, 9)}${gauge(r.h5)}  ${pad(r.h5note, 12)}${gauge(r.wk)}  ${pad(r.wknote, 14)}${lostBar(r.lost)}  ${pad(r.lostWord, 8)}${dim(r.closed)}`);
P(`${pad(dim("old"), 10)}${dim("off")}`);
P();
P(`  █ ${dim("real")}   ${FOG}${faded(39)("▓")}${FOG} \x1b[0m${dim("predicted (grey zone)")}   ${fg(RED)("█")} ${dim("nothing left / too fast")}   ${fg(240)("┈")} ${dim("safe pace")}   ${fg(39)(bold("┃"))} ${dim("weekly refill")}   ${white("◆")} ${dim("5-hour refill")}`);
P(`  ${fg(39)("│")} ${dim("switched")}   ${fg(39)("├─") + fg(39)(bold("┼")) + fg(39)("─┤")} ${dim("will switch, likely between")}   ${dim("↻ refills in")}`);
P(`  ${fg(WASTE)("░")} ${dim("unused, lost at refill")}   ${fg(OUTSIDE)("▓")} ${dim("used outside the tool (ChatGPT app)")}`);

console.log(out.join("\n"));
