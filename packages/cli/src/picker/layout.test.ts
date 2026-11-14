import { describe, expect, test } from "bun:test";
/**
 * The dialog's two budgets — columns in a row, rows in a box — asserted so they can
 * FAIL ON THEIR OWN DEFECT.
 *
 * An earlier formulation of the column test checked only that a row's cells did not
 * EXCEED the budget. That would have passed the very configuration a colour
 * screenshot fails: a row that sums 39 columns short of its width leaves a dead tail
 * the panel paints as background. A test that cannot fail on the defect it guards is
 * not a guard, so the claim is that the cells sum EXACTLY.
 *
 * The row budget is the one that inline mode makes load-bearing. The dialog reserves
 * rows by scrolling the user's terminal, so a populated dialog and a
 * discovery-failure dialog that were different heights would rewrite rows already
 * handed back to the shell. `deriveDialogLayout` takes the banner's rows out of the
 * LIST's rather than adding them to the box, and that invariant is asserted here
 * rather than left to a screenshot.
 */
import {
  CHROME_ROWS,
  GAPS,
  MAX_DIALOG_ROWS,
  MAX_DIALOG_WIDTH,
  MAX_LIST_ROWS,
  deriveDialogLayout,
  deriveProviderRowLayout,
  deriveRowLayout,
  providerRowTotal,
  rowLayoutTotal,
  scrollWindow,
} from "./layout.js";

const WIDTHS = Array.from({ length: 161 }, (_, i) => i + 40);

describe("deriveRowLayout", () => {
  test("cells sum EXACTLY to the row width at every width in [40, 200]", () => {
    const wrong = WIDTHS.map((w) => ({ w, sum: rowLayoutTotal(deriveRowLayout(w)) })).filter(
      ({ w, sum }) => sum !== w
    );
    expect(wrong).toEqual([]);
  });

  test("cells still sum EXACTLY when the fallback mark is reserved", () => {
    const wrong = WIDTHS.map((w) => ({
      w,
      sum: rowLayoutTotal(deriveRowLayout(w, { mark: true })),
    })).filter(({ w, sum }) => sum !== w);
    expect(wrong).toEqual([]);
  });

  test("no cell is ever negative", () => {
    const bad = WIDTHS.flatMap((w) =>
      Object.entries(deriveRowLayout(w)).filter(([, v]) => (v as number) < 0)
    );
    expect(bad).toEqual([]);
  });

  test("the model name is the elastic cell — it grows, and nothing else does", () => {
    // The whole point of deleting the five-tier ladder: one layout at every width,
    // with every column the reader compares on held constant and the NAME absorbing
    // the difference. A regression that started widening the price column would show
    // up here and nowhere else.
    const narrow = deriveRowLayout(72);
    const wide = deriveRowLayout(88);
    expect(wide.id - narrow.id).toBe(16);
    expect(wide.provider).toBe(narrow.provider);
    expect(wide.ctx).toBe(narrow.ctx);
    expect(wide.price).toBe(narrow.price);
  });

  test("the fallback mark comes out of the NAME, never out of a compared column", () => {
    const live = deriveRowLayout(72);
    const fallback = deriveRowLayout(72, { mark: true });
    expect(fallback.provider).toBe(live.provider);
    expect(fallback.ctx).toBe(live.ctx);
    expect(fallback.price).toBe(live.price);
    expect(fallback.id).toBeLessThan(live.id);
  });

  test("`provider: false` sums EXACTLY too — the dropped cell takes its GAP with it", () => {
    // THE FAILURE THIS EXISTS FOR IS INVISIBLE TO A SUM THAT STOPS AT THE CELLS.
    // Dropping the provider column while leaving `GAP_AFTER_PROVIDER` in the budget
    // still totals `inner`, so a cell-only assertion passes — and every model id in
    // every provider-scoped list is indented two columns for a column that is not
    // drawn. The gap is part of `rowLayoutTotal`, so this catches it.
    const wrong = WIDTHS.map((w) => ({
      w,
      sum: rowLayoutTotal(deriveRowLayout(w, { provider: false })),
    })).filter(({ w, sum }) => sum !== w);
    expect(wrong).toEqual([]);
    expect(deriveRowLayout(80, { provider: false }).provider).toBe(0);
    expect(deriveRowLayout(80, { provider: false }).gaps).toBe(
      deriveRowLayout(80).gaps - GAPS.afterProvider
    );
  });

  test("EVERY column the provider cell gave up goes to the model id", () => {
    // The owner's complaint was that `OpenAI Codex` printed 49 times under a dialog
    // titled `OpenAI Codex` was eating the id column. If the cells went anywhere
    // else — a wider price, a wider ctx — the change would have bought nothing.
    const withCol = deriveRowLayout(96, { providerCells: 18 });
    const without = deriveRowLayout(96, { provider: false });
    expect(without.id - withCol.id).toBe(withCol.provider + GAPS.afterProvider);
    expect(without.ctx).toBe(withCol.ctx);
    expect(without.price).toBe(withCol.price);
  });

  test("`provider: false` stays non-negative at absurd widths", () => {
    const bad = WIDTHS.concat([0, 10, 20]).flatMap((w) =>
      Object.entries(deriveRowLayout(w, { provider: false })).filter(([, v]) => (v as number) < 0)
    );
    expect(bad).toEqual([]);
  });

  test("a non-finite or negative width yields finite columns, never NaN", () => {
    for (const w of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
      const l = deriveRowLayout(w);
      expect(Object.values(l).every((v) => Number.isFinite(v))).toBe(true);
      expect(l.id).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("deriveProviderRowLayout", () => {
  /** `anthropic@`, the widest shortcut in the provider list. */
  const SHORTCUT = "anthropic@".length;

  test("cells sum EXACTLY to the row width at every width in [40, 200]", () => {
    // THE DEFECT THIS WOULD HAVE CAUGHT IS THE ONE THAT WAS THERE. The provider
    // row's four widths used to be `const`s inside the component with an
    // `inner - 2 - 2 - … - 3` for the name, and they summed two columns SHORT —
    // every provider row painted a two-cell dead tail and nothing said so.
    const wrong = WIDTHS.map((w) => ({
      w,
      sum: providerRowTotal(deriveProviderRowLayout(w, SHORTCUT)),
    })).filter(({ w, sum }) => sum !== w);
    expect(wrong).toEqual([]);
  });

  test("no cell is ever negative, at any width including absurd ones", () => {
    for (const w of [...WIDTHS, 0, 1, 8, 20, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const l = deriveProviderRowLayout(w, SHORTCUT);
      for (const [cell, n] of Object.entries(l)) {
        expect({ w, cell, ok: Number.isFinite(n) && n >= 0 }).toEqual({ w, cell, ok: true });
      }
    }
  });

  test("the name is CAPPED at the longest name there is — the surplus goes right", () => {
    // `Grok Build (subscription)` is 25 cells, the longest in the provider list, so a name
    // column wider than 26 is dead air between a provider and the shortcut that
    // qualifies it. Past the cap the extra columns go to the right-aligned tail,
    // which is where a count belongs.
    const narrow = deriveProviderRowLayout(72, SHORTCUT);
    const wide = deriveProviderRowLayout(140, SHORTCUT);
    expect(narrow.name).toBe(26);
    expect(wide.name).toBe(26);
    expect(wide.tail - narrow.tail).toBe(140 - 72);
    expect(wide.shortcut).toBe(narrow.shortcut);
    expect(wide.billing).toBe(narrow.billing);
  });

  test("the shortcut column is the widest shortcut shown plus its separator", () => {
    expect(deriveProviderRowLayout(72, SHORTCUT).shortcut).toBe(SHORTCUT + 1);
    expect(deriveProviderRowLayout(72, "or@".length).shortcut).toBe("or@".length + 1);
  });

  test("a wider shortcut column takes its cells from the tail, never below the named case", () => {
    // 72 is the dialog's inner width at 80 columns, where the name sits on its cap.
    const short = deriveProviderRowLayout(72, "mistral@".length);
    const wide = deriveProviderRowLayout(72, SHORTCUT);
    expect(wide.name).toBe(short.name);
    expect(wide.tail).toBe(short.tail - (SHORTCUT - "mistral@".length));
    expect(wide.tail).toBeGreaterThanOrEqual("needs MOONSHOT_API_KEY".length);
  });
});

describe("deriveDialogLayout", () => {
  test("the dialog FITS 80x24 and 145x45 — it is centred in the terminal, never clipped", () => {
    const small = deriveDialogLayout(80, 24);
    const large = deriveDialogLayout(145, 45);
    expect(small.width).toBe(76);
    expect(small.marginLeft).toBe(2);
    // Capped in WIDTH, not stretched: a picker is a question, not a viewport.
    expect(large.width).toBe(MAX_DIALOG_WIDTH);
    expect(large.marginLeft).toBeGreaterThan(2);
    // It DOES grow in height with the terminal, and that is the change: the old
    // fixed 18 rows existed to keep an "inline" region small, and inline never
    // held — the renderer is sized to `stdout.rows` at this pin whatever the
    // screen mode. Growth is bounded by the cap and by the terminal itself.
    expect(large.listRows).toBeGreaterThan(small.listRows);
    expect(small.listRows + CHROME_ROWS).toBeLessThanOrEqual(24);
    expect(large.listRows + CHROME_ROWS).toBeLessThanOrEqual(MAX_DIALOG_ROWS);
    expect(large.listRows + CHROME_ROWS).toBeLessThanOrEqual(45);
  });

  test("a centred dialog leaves air above and below at every height it can be drawn", () => {
    // What makes a centred box read as centred. A dialog exactly as tall as the
    // terminal is not centred, it is full-screen — which is the build that was
    // rejected — and one taller than the terminal is clipped at both ends.
    for (const h of [20, 24, 30, 45, 60]) {
      const l = deriveDialogLayout(120, h);
      expect(l.listRows + CHROME_ROWS).toBeLessThanOrEqual(h - 2);
    }
  });

  test("a banner takes its rows OUT of the list, so the dialog height never changes", () => {
    // The inline-mode invariant. `listRows + CHROME_ROWS + banner` is the whole box.
    for (const [w, h] of [
      [80, 24],
      [145, 45],
      [100, 30],
    ] as const) {
      const plain = deriveDialogLayout(w, h);
      for (const banner of [1, 3, 5]) {
        const withBanner = deriveDialogLayout(w, h, banner);
        expect({ banner, total: withBanner.listRows + banner }).toEqual({
          banner,
          total: plain.listRows,
        });
      }
    }
  });

  test("a tiny or non-finite terminal still yields positive, finite budgets", () => {
    for (const [w, h] of [
      [10, 6],
      [24, 8],
      [Number.NaN, Number.NaN],
    ] as const) {
      const l = deriveDialogLayout(w, h);
      expect(l.width).toBeGreaterThan(0);
      expect(l.inner).toBeGreaterThan(0);
      expect(l.listRows).toBeGreaterThan(0);
      expect(Number.isFinite(l.marginLeft)).toBe(true);
    }
  });

  test("the list never exceeds its cap however tall the terminal is", () => {
    for (const h of [24, 45, 80, 200]) {
      expect(deriveDialogLayout(120, h).listRows).toBeLessThanOrEqual(MAX_LIST_ROWS);
    }
  });
});

describe("scrollWindow", () => {
  test("a list that fits is never scrolled", () => {
    for (const c of [0, 3, 9]) expect(scrollWindow(c, 10, 11)).toBe(0);
  });

  test("the cursor is always inside the window", () => {
    const total = 312;
    const rows = 11;
    for (let c = 0; c < total; c++) {
      const top = scrollWindow(c, total, rows);
      expect({ c, inside: c >= top && c < top + rows }).toEqual({ c, inside: true });
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + rows).toBeLessThanOrEqual(total);
    }
  });

  test("an out-of-range cursor is clamped rather than scrolling past the end", () => {
    expect(scrollWindow(9999, 20, 5)).toBe(15);
    expect(scrollWindow(-4, 20, 5)).toBe(0);
  });
});
