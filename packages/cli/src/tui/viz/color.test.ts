/** Every assertion fails on a SPECIFIC known regression, not on "it runs". All
 * `color.ts` output is lowercase `#rrggbb`, so tokens compare through `lo()`. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { blend1D, blendStops, darken, heatRamp, lighten, pickInk } from "./color";
import {
  displayWidth,
  fallbackClusterWidth,
  padStartTo,
  padTo,
  splitCells,
  truncate,
} from "./text";
import { ramps, tokens } from "./tokens";

const lo = (s: string) => s.toLowerCase();
const chan = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

const readPinnedBunVersion = (): string | undefined => {
  try {
    const workflow = readFileSync(
      new URL("../../../../../.github/workflows/test.yml", import.meta.url),
      "utf8"
    );
    const lines = workflow.split(/\r?\n/);
    const setupBunLine = lines.findIndex((line) =>
      /^\s*-\s+uses:\s*oven-sh\/setup-bun@/.test(line)
    );
    if (setupBunLine === -1) return undefined;

    const stepIndent = lines[setupBunLine]!.search(/\S/);
    for (const line of lines.slice(setupBunLine + 1)) {
      if (line.trim() === "") continue;
      if (line.search(/\S/) === stepIndent && /^\s*-\s+/.test(line)) break;
      const pin = line.match(/^\s*bun-version:\s*"(\d+\.\d+\.\d+)"\s*$/);
      if (pin) return pin[1];
    }
  } catch {
    // Fail open: an unavailable workflow must not silently disable coverage.
  }
  return undefined;
};

/** WCAG 2.x relative luminance and contrast ratio, reimplemented from the spec.
 * INDEPENDENT of `color.ts` on purpose — a test that measures contrast with the
 * implementation's own luminance function agrees with itself no matter how wrong
 * both are, and would have passed on the code this replaces. */
const relLum = (hex: string) =>
  chan(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((acc, v, i) => acc + [0.2126, 0.7152, 0.0722][i]! * v, 0);
const ratio = (a: string, b: string) => {
  const [x, y] = [relLum(a), relLum(b)];
  return x >= y ? (x + 0.05) / (y + 0.05) : (y + 0.05) / (x + 0.05);
};
/** HSL -> #rrggbb, so the sweep can walk the hue circle without a colour dependency. */
const hsl = (h: number, s: number, l: number): string => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

describe("ramps — granularity and endpoints", () => {
  const r = blend1D(24, tokens.success, tokens.error);
  test("blend1D: exactly `steps`, endpoints inclusive, >= 12 distinct", () => {
    expect(r).toHaveLength(24);
    expect(r[0]).toBe(lo(tokens.success));
    expect(r[23]).toBe(lo(tokens.error));
    expect(new Set(r).size).toBeGreaterThanOrEqual(12); // 4-glyph ░▒▓█ scores 1 here
  });
  test("blendStops: 40 cells over 3 stops, and 4 stops keep both ends", () => {
    const m = blendStops(40, ...ramps.load);
    expect(m).toHaveLength(40);
    expect(m[0]).toBe(lo(ramps.load[0]!));
    expect(m[39]).toBe(lo(ramps.load[2]!));
    expect(new Set(m).size).toBeGreaterThanOrEqual(12);
    const t = blendStops(24, ...ramps.temperature);
    expect(t[0]).toBe(lo(ramps.temperature[0]!));
    expect(t[23]).toBe(lo(ramps.temperature[3]!));
  });
  test("the specified degenerate inputs, not merely 'does not throw'", () => {
    expect(blend1D(1, tokens.success, tokens.error)).toEqual([lo(tokens.success)]);
    expect(blend1D(0, tokens.success, tokens.error)).toEqual([]);
    expect(blend1D(-3, tokens.success, tokens.error)).toEqual([]);
    expect(blend1D(2.5, tokens.success, tokens.error)).toEqual([]);
    expect(new Set(blendStops(5, tokens.warn)).size).toBe(1);
    expect(blendStops(5)).toEqual([]);
    expect(blendStops(1, ...ramps.load)).toEqual([lo(ramps.load[0]!)]);
  });
});

describe("darken / lighten / heatRamp", () => {
  const r = heatRamp(tokens.error);
  test("endpoints, clamping, and the exact go-tui identity", () => {
    expect(darken("#ffffff", 1)).toBe("#000000");
    expect(darken(tokens.error, 0)).toBe(lo(tokens.error));
    expect(lighten("#000000", 1)).toBe("#ffffff");
    expect(darken("#ffffff", 5)).toBe("#000000");
    expect(darken("#abcdef", -2)).toBe("#abcdef");
    expect(r).toEqual(blend1D(24, darken(tokens.error, 0.8), tokens.error));
    expect(heatRamp(tokens.warn, 8)).toHaveLength(8);
  });
  test("the floor is far darker than the top but KEEPS the hue", () => {
    const [fr, fg, fb] = chan(r[0]!);
    expect(fr! + fg! + fb!).toBeLessThan(255); // dark
    expect(fr!).toBeGreaterThan(0); // tinted, not black
    expect(fr!).toBeGreaterThan(fg!); // still recognisably red
    expect(chan(r[23]!)[0]!).toBeGreaterThan(fr!);
    expect(r[23]).toBe(lo(tokens.error));
  });
});

describe("pickInk — the MORE LEGIBLE of two inks, measured", () => {
  test("dark ink on bright backgrounds — the direction is not inverted", () => {
    expect(pickInk("#2ECC71")).toBe(lo(tokens.ink)); // bright -> dark ink
    expect(pickInk("#11111B")).toBe(lo(tokens.text)); // dark   -> light ink
    expect(pickInk("#ffffff")).toBe(lo(tokens.ink));
    expect(pickInk("#000000")).toBe(lo(tokens.text));
    expect(pickInk("#ffffff", "#010203", "#fefdfc")).toBe("#010203");
  });

  // DEFECT. A fixed YIQ threshold is a PROXY for contrast, and it is a bad one on
  // saturated hues because YIQ over-weights green. Both of these were measured
  // choosing the less legible of the two available inks. Inverting the threshold
  // does not fix them — `#ff00ff` sits on the DARK side of the YIQ cut (L=105) and
  // still needs the DARK ink, so no cut in either direction gets it and `bgPanel`
  // right at once. Only comparing the candidates does.
  // RE-MEASURED FOR CLAUDISH'S PALETTE. The skill shipped these as 5.98/2.17 and
  // 4.75/2.73, measured against ITS `ink` (#11111B) and `text` (#CDD6F4); ours are
  // `C.black` (#000000) and `C.fg` (#ffffff), so every ratio moves and all four
  // constants would be wrong by construction. What is asserted is unchanged: both
  // historically-broken hues still take the DARK ink, and it still beats the light
  // candidate. The relational assertion below each pair is the part that cannot rot —
  // it re-states the property the constants were only illustrating, so a future palette
  // change fails on a number instead of silently inverting the choice.
  test("the two measured failures now take the higher-contrast ink", () => {
    expect(pickInk("#ff00ff")).toBe(lo(tokens.ink));
    expect(ratio("#ff00ff", pickInk("#ff00ff"))).toBeCloseTo(6.7, 1);
    expect(ratio("#ff00ff", lo(tokens.text))).toBeCloseTo(3.14, 1); // the rejected candidate
    expect(ratio("#ff00ff", pickInk("#ff00ff"))).toBeGreaterThan(ratio("#ff00ff", lo(tokens.text)));

    expect(pickInk("#808080")).toBe(lo(tokens.ink));
    expect(ratio("#808080", pickInk("#808080"))).toBeCloseTo(5.32, 1);
    expect(ratio("#808080", lo(tokens.text))).toBeCloseTo(3.95, 1);
    expect(ratio("#808080", pickInk("#808080"))).toBeGreaterThan(ratio("#808080", lo(tokens.text)));
  });

  // The general property, not two lucky constants: over 24 fully-saturated hues, the
  // same 24 at half lightness, and 33 greys from black to white, the ink returned is
  // ALWAYS the one with the higher of the two contrast ratios.
  test("a hue + grey sweep: the chosen ink always wins on contrast", () => {
    const bgs = [
      ...Array.from({ length: 24 }, (_, i) => hsl(i * 15, 1, 0.5)),
      ...Array.from({ length: 24 }, (_, i) => hsl(i * 15, 1, 0.25)),
      ...Array.from({ length: 33 }, (_, i) => {
        const v = Math.min(255, i * 8)
          .toString(16)
          .padStart(2, "0");
        return `#${v}${v}${v}`;
      }),
      ...Object.values(tokens),
    ];
    const losers: string[] = [];
    for (const bg of bgs) {
      const chosen = pickInk(bg);
      const best = Math.max(ratio(bg, lo(tokens.ink)), ratio(bg, lo(tokens.text)));
      if (ratio(bg, chosen).toFixed(6) !== best.toFixed(6)) {
        losers.push(
          `${bg} chose ${chosen} @ ${ratio(bg, chosen).toFixed(2)}, best was ${best.toFixed(2)}`
        );
      }
    }
    expect(losers).toEqual([]);
  });

  // `Badge.bg` accepts any ColorInput, so `bg` can be translucent — and the old rule
  // read the channels of a colour nobody can see. A translucent fill is composited
  // over `tokens.bgPanel`, the surface it is really painted on.
  test("alpha is composited over the panel, not ignored", () => {
    expect(pickInk("#ff00ff00")).toBe(pickInk(tokens.bgPanel)); // invisible fill -> the panel's ink
    expect(pickInk("#ff00ff00")).toBe(lo(tokens.text));
    expect(pickInk("#ffffffff")).toBe(lo(tokens.ink)); // opaque white is unaffected
    // Half-transparent magenta over a near-black panel is much darker than magenta,
    // and flips the answer — proof the composite is real and not decorative.
    const half = pickInk("#ff00ff80");
    expect(half).toBe(lo(tokens.text));
    expect(half).not.toBe(pickInk("#ff00ff"));
    // Whatever it returns is opaque #rrggbb, never an 8-digit hex that would
    // re-composite a second time when handed to `fg=`.
    for (const c of ["#ff00ff00", "#ff00ff80", "#00000040"])
      expect(pickInk(c)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("splitCells — sums exactly", () => {
  test("200 randomized inputs: exact sum, >= 1 cell each when there is room", () => {
    for (let i = 0; i < 200; i++) {
      const parts = Array.from({ length: 1 + (i % 6) }, () => Math.floor(Math.random() * 1000));
      const cells = i % 61;
      const out = splitCells(parts, cells);
      const nz = parts.filter((p) => p > 0).length;
      expect(out).toHaveLength(parts.length);
      expect(out.reduce((a, b) => a + b, 0)).toBe(nz === 0 || cells <= 0 ? 0 : cells);
      if (nz > 0 && cells >= nz)
        parts.forEach((p, k) => {
          if (p > 0) expect(out[k]).toBeGreaterThanOrEqual(1);
        });
    }
  });
  test("the defined edge cases, including 4-parts-at-3-cells", () => {
    expect(splitCells([10, 1, 1, 1], 3)).toEqual([1, 1, 1, 0]); // over-subscribed
    expect(splitCells([0, 0, 0], 12)).toEqual([0, 0, 0]); // all zero: sum 0, NOT 12
    expect(splitCells([-5, 5], 4)).toEqual([0, 4]); // negative -> 0
    expect(splitCells([Number.NaN, 5], 4)).toEqual([0, 4]); // NaN -> 0
    expect(splitCells([Number.POSITIVE_INFINITY, 5], 4)).toEqual([0, 4]);
    expect(splitCells([1, 2], 0)).toEqual([0, 0]);
    expect(splitCells([1000, 1, 1], 3)).toEqual([1, 1, 1]); // min-1 guard steals a cell
  });
});

describe("truncate / padTo / padStartTo — display columns, not code units", () => {
  const HARD = [
    "CPU 78%",
    "日本語テスト",
    "éé",
    "👨‍👩‍👧👨‍👩‍👧",
    "𝄞𝄞",
    "🔥🔥🔥",
    "❤️",
    "a",
    "",
    "✅ ok",
    "⚠️ 3 warn",
    "❌⛔⭐",
  ];
  const WIDTHS = [0, 1, 2, 3, 5, 8, 20];
  test("truncate never exceeds and both pads are exact, over every hard cluster", () => {
    for (const s of HARD)
      for (const w of WIDTHS) {
        expect(displayWidth(truncate(s, w))).toBeLessThanOrEqual(w);
        expect(displayWidth(padTo(s, w))).toBe(w);
        expect(displayWidth(padStartTo(s, w))).toBe(w);
      }
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("日本語", 3)).toBe("日…"); // wide glyph dropped, never halved
  });
  test("each Unicode class measures as specified", () => {
    expect(displayWidth("日本語")).toBe(6); // CJK wide
    expect(displayWidth("éé")).toBe(2); // combining marks are 0
    expect(displayWidth("👨‍👩‍👧")).toBe(2); // ZWJ counts as its base cluster
    expect(displayWidth("𝄞")).toBe(1); // surrogate pair, narrow
    expect(displayWidth("❤️")).toBe(2); // U+FE0F forces emoji presentation
  });

  // DEFECT 2. The U+2300–U+2B55 band was absent from the width table, so the status
  // glyphs a dashboard leans on measured 1 and painted 2: `padTo("✅ ok", 8)` claimed 8
  // columns and painted 9, and every column right of it drifted.
  test("the U+2300–U+2B55 status glyphs measure 2, and the widget glyphs still measure 1", () => {
    for (const g of ["✅", "❌", "⛔", "⭐", "⏳", "⌚", "⚡", "❓", "⬛", "⭕", "♿", "☔"])
      expect(displayWidth(g)).toBe(2);
    // The same band holds every glyph the widgets draw with. One over-wide entry here
    // and every meter, sparkline and panel border in the skill mis-measures.
    for (const g of [
      "█",
      "░",
      "▁",
      "▂",
      "▃",
      "▄",
      "▅",
      "▆",
      "▇",
      "─",
      "│",
      "╭",
      "╮",
      "╰",
      "╯",
      "…",
      "✓",
      "✗",
      "●",
      "▲",
    ])
      expect(displayWidth(g)).toBe(1);
    expect(displayWidth("⚠")).toBe(1); // bare: EAW Ambiguous, one column
    expect(displayWidth("⚠️")).toBe(2); // + U+FE0F: emoji presentation, two
    expect(displayWidth("⛔︎")).toBe(2); // U+FE0E cannot narrow an intrinsically Wide glyph
    expect(displayWidth("✅ ok")).toBe(5);
    // Measured with the ORACLE, not with `displayWidth`: the bug was self-consistent —
    // the old table both under-counted the glyph and padded to its own wrong answer, so
    // `displayWidth(padTo(s, 8))` returned a happy 8 while the terminal painted 9.
    expect(Bun.stringWidth(padTo("✅ ok", 8))).toBe(8);
    expect(Bun.stringWidth(padStartTo("✅ ok", 8))).toBe(8);
  });

  // The table is not hand-checked: every codepoint in the band is re-derived from
  // `Bun.stringWidth`, a maintained Unicode width table, so drift fails the suite
  // rather than showing up as a crooked dashboard. Independent of the implementation —
  // `displayWidth` never calls it — so this can genuinely fail.
  test("all 2,134 codepoints in the band agree with Bun's width oracle", () => {
    const wrong: string[] = [];
    for (let cp = 0x2300; cp <= 0x2b55; cp++) {
      const c = String.fromCodePoint(cp);
      if (displayWidth(c) !== Bun.stringWidth(c))
        wrong.push(
          `U+${cp.toString(16).toUpperCase()} table=${displayWidth(c)} oracle=${Bun.stringWidth(c)}`
        );
    }
    expect(wrong).toEqual([]);
  });

  // DEFECT 4. `aesthetics-and-color.md` mandates right-aligned numerals padded to a
  // fixed width; `padTo` pads at the END and native `padStart` is banned for counting
  // code units, so the rule was unachievable with the shipped surface.
  test("padStartTo right-aligns to exact columns, and clips like padTo", () => {
    expect(padStartTo("42", 5)).toBe("   42");
    expect(padStartTo("100%", 6)).toBe("  100%");
    expect(padStartTo("", 3)).toBe("   ");
    expect(padStartTo("42", 0)).toBe("");
    expect(padStartTo("42", -3)).toBe("");
    expect(padStartTo("日本", 6)).toBe("  日本"); // 4 columns of CJK, 2 spaces — padStart would add 4
    expect("日本".padStart(6)).toBe("    日本"); // the native form, wrong by 2 columns
    expect(padStartTo("é", 3)).toBe("  é"); // combining mark is 0 columns
    expect(padStartTo("👨‍👩‍👧", 4)).toBe("  👨‍👩‍👧"); // ZWJ cluster is 2
    expect(padStartTo("✅", 4)).toBe("  ✅"); // and the newly-fixed band
    expect(padStartTo("1234567", 4)).toBe("123…"); // clips from the END, never a misleading tail
  });

  test("a padStartTo column cannot jitter as its values change length", () => {
    const col = [7, 42, 100, 1234].map((n) => padStartTo(`${n}%`, 6));
    expect(col).toEqual(["    7%", "   42%", "  100%", " 1234%"]);
    for (const cell of col) expect(displayWidth(cell)).toBe(6);
    expect(new Set(col.map((c) => c.length)).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DEFECT. `displayWidth` classified a grapheme by an incomplete block table, so it
// was wrong for valid Unicode in three separate directions at once: whole planes
// missing, zero-width characters billed a column, and a block-coarse emoji run
// force-widening symbols that default to TEXT presentation.
// ---------------------------------------------------------------------------
describe("displayWidth — Bun's oracle, not a hand table", () => {
  const MEASURED: Array<readonly [string, string, number]> = [
    ["U+17000 Tangut ideograph", "\u{17000}", 2], // was 1 — the plane was absent
    ["U+200B zero width space", "\u200B", 0], // was 1 — billed a column
    ["U+00AD soft hyphen", "\u00AD", 0], // was 1 — billed a column
    ["U+1F321 thermometer", "\u{1F321}", 1], // was 2 — text presentation, not emoji
    ["U+1F5A5 desktop computer", "\u{1F5A5}", 1], // was 2 — text presentation, not emoji
  ];
  test("every codepoint the reviewer measured wrong now matches", () => {
    // Compared as labelled strings so a failure names the codepoint, not just "1 != 2".
    const got = MEASURED.map(([name, ch]) => `${name} = ${displayWidth(ch)}`);
    expect(got).toEqual(MEASURED.map(([name, , want]) => `${name} = ${want}`));
    for (const [, ch] of MEASURED) expect(displayWidth(ch)).toBe(Bun.stringWidth(ch));
  });

  // The delegation itself, swept: 12,000 codepoints striding the whole assigned
  // range plus every plane boundary. `Bun.stringWidth` is the oracle AND the
  // implementation here, so this asserts the delegation is actually wired — it
  // fails the moment anyone reintroduces a hand table on the primary path.
  test("agrees with the oracle across the whole assigned range", () => {
    const wrong: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 93) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (displayWidth(c) !== Bun.stringWidth(c)) wrong.push(`U+${cp.toString(16).toUpperCase()}`);
    }
    expect(wrong).toEqual([]);
  });
});

// The fallback only runs where `Bun.stringWidth` does not exist, which is a runtime
// this skill does not test — so it is measured HERE, against the oracle, on the
// runtime that has one. Without this the fallback would ship unmeasured.
describe("displayWidth fallback — measured against the oracle, with a budget", () => {
  const fbSeg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const fbWidth = (s: string) => {
    let w = 0;
    for (const { segment } of fbSeg.segment(s)) w += fallbackClusterWidth(segment);
    return w;
  };

  test("the fallback fixes the same five codepoints the oracle path does", () => {
    expect(fbWidth("\u{17000}")).toBe(2);
    expect(fbWidth("\u200B")).toBe(0);
    expect(fbWidth("\u00AD")).toBe(0);
    expect(fbWidth("\u{1F321}")).toBe(1);
    expect(fbWidth("\u{1F5A5}")).toBe(1);
  });

  // These budgets are calibrated against one Bun build; `Bun.stringWidth` is a live
  // oracle whose Unicode tables move. Bun 1.4.0 measured total=3017 and
  // { marks: 2146, unassigned: 246, format: 23, regionalIndicator: 26, other: 576 },
  // with other sample U+980, U+C80, U+D3A, and U+1160..U+1168, plus band extras
  // U+2630..U+2637 and U+268A..U+268F. When the pin is bumped, re-baseline the
  // budgets; do not widen them because of a red local run.
  const pinnedBunVersion = readPinnedBunVersion();
  const skipOracleBudgets = pinnedBunVersion !== undefined && Bun.version !== pinnedBunVersion;
  const oracleBudgetSkipReason = skipOracleBudgets
    ? `running Bun ${Bun.version}; budgets are pinned to Bun ${pinnedBunVersion}`
    : "";
  const oracleBudgetTestNames = [
    "zero disagreement on every class that reaches a dashboard",
    "the whole-Unicode disagreement budget holds, by category",
  ] as const;
  const oracleBudgetName = (name: string) =>
    oracleBudgetSkipReason === "" ? name : `${name} — SKIPPED: ${oracleBudgetSkipReason}`;
  if (skipOracleBudgets) {
    for (const name of oracleBudgetTestNames)
      console.warn(`SKIPPED ${name} — ${oracleBudgetSkipReason}`);
  }

  test.skipIf(skipOracleBudgets)(oracleBudgetName(oracleBudgetTestNames[0]), () => {
    const REAL = [
      "CPU 78%",
      "日本語テスト",
      "éé",
      "👨‍👩‍👧",
      "𝄞",
      "🔥",
      "❤️",
      "✅ ok",
      "⚠️ 3 warn",
      "❌⛔⭐",
      "⚠",
      "⛔︎",
      "🇯🇵",
      "█░▁▂▃▄▅▆▇─│╭╮╰╯…✓✗●▲",
      "\u{17000}",
      "\u{1F321}",
    ];
    const wrong = REAL.filter((s) => fbWidth(s) !== Bun.stringWidth(s));
    expect(wrong).toEqual([]);
    // The band the previous table got wrong wholesale, re-derived cluster by cluster.
    const band: string[] = [];
    for (let cp = 0x2300; cp <= 0x2b55; cp++) {
      const c = String.fromCodePoint(cp);
      if (fallbackClusterWidth(c) !== Bun.stringWidth(c))
        band.push(`U+${cp.toString(16).toUpperCase()}`);
    }
    expect(band).toEqual([]);
  });

  // The full oracle sweep, and the numbers the source comment quotes. These are a
  // RATCHET: 11,205 was the old table's score and 1,081 is this one's. Widening a run
  // by guess moves this number and fails here.
  test.skipIf(skipOracleBudgets)(
    oracleBudgetName(oracleBudgetTestNames[1]),
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exhaustive oracle categorization
    () => {
      const isMark = /^\p{M}/u;
      const isUnassigned = /^\p{Cn}/u;
      const isFormat = /^\p{Cf}/u;
      let total = 0;
      const cat = { marks: 0, unassigned: 0, format: 0, regionalIndicator: 0, other: 0 };
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const c = String.fromCodePoint(cp);
        if (fallbackClusterWidth(c) === Bun.stringWidth(c)) continue;
        total++;
        if (isMark.test(c)) cat.marks++;
        else if (isUnassigned.test(c)) cat.unassigned++;
        else if (isFormat.test(c)) cat.format++;
        else if (cp >= 0x1f1e6 && cp <= 0x1f1ff) cat.regionalIndicator++;
        else cat.other++;
      }
      expect(total).toBeLessThanOrEqual(1081); // the previous hand table scored 11,205
      // None of the residual is reachable from real single-line text: a lone combining
      // mark, a codepoint this engine's Unicode tables predate, a bidi format control,
      // or one half of a flag pair (the PAIR is one cluster and measures 2 correctly).
      expect(
        cat.marks + cat.unassigned + cat.format + cat.regionalIndicator
      ).toBeGreaterThanOrEqual(total - 17);
      expect(cat.other).toBeLessThanOrEqual(17);
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// DEFECT. Control characters counted as ZERO width but were appended UNCHANGED, so
// three functions that promise an exact column count on ONE line returned multiline
// and tab-expanded output: `truncate("a\nbc", 2)` was `"a\n…"`, and it reached
// `padTo` and `padStartTo` too.
// ---------------------------------------------------------------------------
describe("control characters — the contract is REPLACE WITH ONE SPACE", () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control chars ARE the fixture
  const NASTY = /[\u0000-\u001f\u007f-\u009f]/;

  test("the exact reproductions from the review", () => {
    expect(truncate("a\nbc", 2)).toBe("a…"); // was "a\n…" — two rows claiming one
    expect(padTo("a\nbc", 4)).toBe("a bc"); // was "a\nbc "
    expect(padStartTo("a\nbc", 6)).toBe("  a bc"); // was " a\nbc"
    expect(padTo("a\tb", 4)).toBe("a b "); // was "a\tb  " — a tab is any number of columns
  });

  test("no output of any of the three can contain a control character", () => {
    const DIRTY = [
      "a\nbc",
      "a\tb",
      "line1\r\nline2",
      "\u001b[31mred\u001b[0m",
      "bell\u0007",
      "\u0000\u0000",
      "日本\n語",
      "✅\tok",
      "\u009fC1",
    ];
    for (const s of DIRTY) {
      for (const w of [0, 1, 2, 3, 5, 8, 20]) {
        for (const out of [truncate(s, w), padTo(s, w), padStartTo(s, w)]) {
          expect(NASTY.test(out)).toBe(false);
          expect(out.includes("\n")).toBe(false);
          expect(out.includes("\t")).toBe(false);
        }
        // The strong form of the promise, settled by the oracle rather than by the
        // implementation agreeing with itself.
        expect(Bun.stringWidth(padTo(s, w))).toBe(w);
        expect(Bun.stringWidth(padStartTo(s, w))).toBe(w);
        expect(Bun.stringWidth(truncate(s, w))).toBeLessThanOrEqual(w);
      }
    }
  });

  test("a replaced control costs exactly one column, so words stay separated", () => {
    expect(padTo("a\nb", 5)).toBe("a b  "); // not "ab   " — stripping would fuse the words
    expect(displayWidth(padTo("a\nb", 5))).toBe(5);
    expect(padTo("\r\n", 4)).toBe("    "); // two controls, two columns, then padding
  });

  test("MEASURING is unchanged: a control paints nothing, and that is the oracle's answer", () => {
    expect(displayWidth("a\nbc")).toBe(3);
    expect(displayWidth("a\nbc")).toBe(Bun.stringWidth("a\nbc"));
    expect(displayWidth("a\tb")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DEFECT. Column counts were unvalidated, so fractional, NaN and Infinity widths all
// produced silent nonsense — or, for Infinity, a `RangeError` from `String.repeat`
// that named neither the function nor the argument.
// ---------------------------------------------------------------------------
describe("numeric contracts — floor, clamp, and throw on non-finite", () => {
  test("fractional widths FLOOR — half a column cannot be painted", () => {
    expect(padTo("abcdef", 2.5)).toBe("a…"); // 2 columns, and it says 2
    expect(displayWidth(padTo("abcdef", 2.5))).toBe(2);
    expect(padTo("ab", 5.9)).toBe("ab   "); // 5, not 6
    expect(padStartTo("ab", 5.9)).toBe("   ab");
    expect(truncate("abcdef", 4.7)).toBe("abc…");
    expect(padTo("ab", 0.9)).toBe(""); // floors to 0
  });

  test("negative and zero widths clamp to the empty string", () => {
    for (const w of [0, -1, -0.5, -1e6]) {
      expect(padTo("abc", w)).toBe("");
      expect(padStartTo("abc", w)).toBe("");
      expect(truncate("abc", w)).toBe("");
    }
  });

  // NaN used to return SIX columns for "abcdef" while claiming a width of NaN, and
  // Infinity threw from inside `String.repeat`. Both now fail at the boundary, and
  // the message names the function and the argument.
  test("non-finite widths throw a RangeError that names the caller", () => {
    for (const fn of [padTo, padStartTo, truncate] as const) {
      for (const w of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() => fn("abcdef", w)).toThrow(RangeError);
      }
    }
    expect(() => padTo("abcdef", Number.NaN)).toThrow(
      "padTo: width must be a finite number, got NaN"
    );
    expect(() => padStartTo("abcdef", Number.POSITIVE_INFINITY)).toThrow(
      "padStartTo: width must be a finite number, got Infinity"
    );
    expect(() => truncate("abcdef", Number.NaN)).toThrow(
      "truncate: width must be a finite number, got NaN"
    );
    expect(() => splitCells([1, 1], Number.NaN)).toThrow(
      "splitCells: cells must be a finite number, got NaN"
    );
    expect(() => splitCells([1, 1], Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test("splitCells: fractional cells floor, and the sum is the FLOORED request", () => {
    expect(splitCells([1, 1], 2.5)).toEqual([1, 1]); // was [2, 1] — a sum of 3 from 2.5
    expect(splitCells([1, 1], 2.5).reduce((a, b) => a + b, 0)).toBe(2);
    expect(splitCells([3, 1], 7.9)).toEqual([5, 2]); // sums to 7, not 8
    expect(splitCells([1, 1], -4)).toEqual([0, 0]);
  });

  // Finite parts can still overflow their own sum. `[MAX_VALUE, MAX_VALUE]` summed to
  // Infinity and made every share `Infinity / Infinity` = NaN.
  test("parts near MAX_VALUE do not overflow into NaN allocations", () => {
    expect(splitCells([Number.MAX_VALUE, Number.MAX_VALUE], 10)).toEqual([5, 5]);
    expect(splitCells([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], 9)).toEqual([
      3, 3, 3,
    ]);
    expect(splitCells([Number.MAX_VALUE, 1], 10).reduce((a, b) => a + b, 0)).toBe(10);
    expect(splitCells([1e308, 1e308, 1], 12).reduce((a, b) => a + b, 0)).toBe(12);
    for (const parts of [
      [Number.MAX_VALUE, Number.MAX_VALUE],
      [1e308, 1],
      [Number.MAX_VALUE, 1e-308],
    ]) {
      for (const n of splitCells(parts, 16)) expect(Number.isInteger(n)).toBe(true);
    }
  });
});
