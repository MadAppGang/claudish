/**
 * picker/layout.ts — every column and row budget the picker dialog spends, in one
 * place.
 *
 * Flexbox owns the BOXES; arithmetic owns the widths of the cells inside a row,
 * because a row is one `<text>` of `<span>`s and a span cannot `flexGrow`. So a
 * full-width row is a column budget, and a budget that lives at its call site
 * drifts between the header and the rows it labels.
 *
 * THE PROVIDER COMES FIRST AND IT IS SPELLED OUT. The column used to print the
 * routing shortcut — `or@`, `oai@`, `cx@` — and the owner's question was exactly
 * *"what is 'or' means"*. A routing shortcut is information only to someone who
 * already knows it; it does not teach, it obscures. So the leftmost cell is the
 * provider's readable display name (`OpenRouter`, `OpenAI Codex`, `Kimi /
 * Moonshot`), the shortcut moves to the `p` dialog where it sits beside the name
 * that explains it, and the exact routable spec stays on the detail line, which
 * prints it in full.
 *
 * THE MODEL ID IS STILL THE ELASTIC CELL, and every other cell is fixed at every
 * width. There is no responsive ladder: the four fixed cells are the four facts a
 * reader chooses on (which provider, how much context, what it costs, and whether
 * the row is verified) and the name takes everything left. One layout at 80
 * columns and at 145.
 *
 * TWO DIFFERENT PROVIDERS MUST NEVER RENDER IDENTICALLY. That collision — two
 * providers both drawn as `opencod…` — is what the previous provider rail was
 * rejected for, and a readable name column can reproduce it (`OpenCode Zen` and
 * `OpenCode Zen Go` share a twelve-character prefix). `providerColumn` therefore
 * derives the width from the names actually on screen and widens until every one
 * of them is distinct; `MIN_PROVIDER_CELLS` is set from the whole 31-provider
 * list, at which no pair collides.
 *
 * THE DIALOG IS CENTRED AND CONTENT-SIZED. It renders in `main-screen` mode, but
 * `CliRendererConfig` at `@opentui/core@0.1.107` carries no `height` key — the
 * renderer is sized to `stdout.rows` whatever the mode — so "inline" never meant a
 * small region: the previous build simply pinned its dialog to the top and left
 * the rest of a 45-row terminal black. It is now centred in a full-height flex
 * root, vertically and horizontally, which is what the owner asked for and what
 * the row budget below is sized against.
 */

/**
 * The provider name column, and the bound that makes it collision-proof.
 *
 * MEASURED over all 31 providers: at 14 columns every display name
 * truncates to a distinct string, and at 12 `OpenCode Zen` and `OpenCode Zen Go`
 * collide. 14 is therefore the floor, not a taste. The cap keeps one long
 * subscription name (`Grok Build (subscription)`, 25) from eating the model id.
 */
const MIN_PROVIDER_CELLS = 14;
const MAX_PROVIDER_CELLS = 20;
/** `262K`, `1M`, `N/A`. */
const CTX_CELLS = 6;
/** `$30.00`, `FREE`, `SUB`, `local`, `N/A`. */
const PRICE_CELLS = 9;
/** ` catalog` — reserved ONLY on a fallback list, so a live list is not indented. */
const MARK_CELLS = 8;
/** `▶ ` / `  ` — the cursor gutter, which carries its own trailing space. */
const CURSOR_CELLS = 2;
/** Air after the provider name, after the model id, and between the numerals. */
const GAP_AFTER_PROVIDER = 2;
const GAP_AFTER_ID = 3;
const GAP_AFTER_CTX = 4;
/** Below this the name is no longer a name. */
const MIN_ID_CELLS = 10;
/**
 * The model id column the provider name is not allowed to eat into.
 *
 * MEASURED against the ids actually on screen: `deepseek-v4-flash-vision-exp` is
 * 28 cells and `kimi-k2.7-code-highspeed` is 24, so 30 fits the long tail whole.
 * Every column past this belongs to the provider name, which is why the column is
 * 14 wide at 80 and 20 at 145 rather than a constant that is wrong at both.
 */
const COMFORTABLE_ID_CELLS = 30;

/**
 * One model row's cells, left to right. Every number is COLUMNS, and they sum to
 * exactly `inner` — asserted over the whole width range by `layout.test.ts`.
 */
export interface RowLayout {
  /** Total columns the row must paint, exactly. */
  inner: number;
  cursor: number;
  /** The provider's readable display name, left-aligned. FIRST cell after the gutter. */
  provider: number;
  /** Model id, padded/truncated. Absorbs every column the fixed cells do not use. */
  id: number;
  /** Context window numeral, right-aligned. */
  ctx: number;
  /** Price / `SUB` / `FREE` / `local`, right-aligned. */
  price: number;
  /** ` catalog` — 0 on a live list. */
  mark: number;
  /** Single-space separators the renderer emits. Part of the sum. */
  gaps: number;
}

/**
 * The cell widths for a row `inner` columns wide.
 *
 * Clamped, never trusted: a caller that hands this a negative, fractional or
 * non-finite width gets a floor rather than NaN columns, because a NaN width
 * reaches `padTo` as a zero-width cell — nothing painted, nothing thrown.
 */
export function deriveRowLayout(
  inner: number,
  opts: { mark?: boolean; providerCells?: number; provider?: boolean } = {}
): RowLayout {
  const cells = Number.isFinite(inner) ? Math.max(0, Math.floor(inner)) : 0;
  const mark = opts.mark === true ? MARK_CELLS : 0;
  // A DROPPED COLUMN TAKES ITS SEPARATOR WITH IT. `provider: false` that left
  // `GAP_AFTER_PROVIDER` in the sum would indent every model id by two columns
  // for a cell that is no longer drawn — the row would still total `inner`, so
  // the sum test would pass over it and only a screenshot would show the gutter.
  const showProvider = opts.provider !== false;
  const gaps = (showProvider ? GAP_AFTER_PROVIDER : 0) + GAP_AFTER_ID + GAP_AFTER_CTX;

  // Everything except the elastic id. The mark carries no separator of its own —
  // the price column is right-aligned, so the gap is already inside it.
  let provider = showProvider ? clampProviderCells(opts.providerCells ?? MIN_PROVIDER_CELLS) : 0;
  let ctx = CTX_CELLS;
  let price = PRICE_CELLS;
  let id = cells - (CURSOR_CELLS + provider + ctx + price + mark + gaps);

  if (id < MIN_ID_CELLS) {
    // Absurdly narrow. The columns give way in the order they are least missed:
    // the provider name shrinks toward its collision-proof floor first, then the
    // price. Nothing here drops the CONTEXT numeral or the name, because those
    // two are the row — and the provider never goes below the floor, because a
    // provider that cannot be told apart from another one is worse than absent.
    const shortfall = MIN_ID_CELLS - id;
    const floor = showProvider ? MIN_PROVIDER_CELLS : 0;
    const takeFromProvider = Math.min(Math.max(0, provider - floor), shortfall);
    provider -= takeFromProvider;
    const stillShort = shortfall - takeFromProvider;
    const takeFromPrice = Math.min(Math.max(0, price - 4), stillShort);
    price -= takeFromPrice;
    id = cells - (CURSOR_CELLS + provider + ctx + price + mark + gaps);
  }
  if (id < 0) {
    // Narrower than the fixed cells themselves. Give the name what is left and
    // let the row paint short rather than overflow, which Yoga would claw back
    // from whichever cell it liked.
    const deficit = -id;
    const fromProvider = Math.min(provider, deficit);
    provider -= fromProvider;
    ctx = Math.max(0, ctx - (deficit - fromProvider));
    id = 0;
  }

  return { inner: cells, cursor: CURSOR_CELLS, provider, id, ctx, price, mark, gaps };
}

function clampProviderCells(n: number): number {
  const v = Number.isFinite(n) ? Math.floor(n) : MIN_PROVIDER_CELLS;
  return Math.max(MIN_PROVIDER_CELLS, Math.min(MAX_PROVIDER_CELLS, v));
}

/**
 * How many columns the provider NAME can afford at this row width.
 *
 * A constant would be wrong at both ends: 14 cells elides `OpenCode Zen Go` on a
 * 145-column terminal that has 22 spare columns doing nothing, and 20 cells eats
 * the model id at 80. So the floor is the collision-proof minimum and everything
 * past a comfortable id column goes to the name, capped so one 25-character
 * subscription name cannot take the row over.
 */
export function providerCellsFor(inner: number, mark = false): number {
  const base = deriveRowLayout(inner, { mark });
  return clampProviderCells(MIN_PROVIDER_CELLS + Math.max(0, base.id - COMFORTABLE_ID_CELLS));
}

/** Sum of every cell plus the separators — must equal `inner`. */
export function rowLayoutTotal(l: RowLayout): number {
  return l.cursor + l.provider + l.id + l.ctx + l.price + l.mark + l.gaps;
}

/** The separators, named so the renderer and the budget cannot disagree. */
export const GAPS = {
  afterProvider: GAP_AFTER_PROVIDER,
  afterId: GAP_AFTER_ID,
  afterCtx: GAP_AFTER_CTX,
} as const;

/**
 * How wide the provider column must be for these names, and what each one prints.
 *
 * THE INVARIANT IS UNIQUENESS, NOT WIDTH: no two providers may render the same
 * string. The search starts at what the row can afford (`providerCellsFor`) and
 * WIDENS until every truncated name is distinct — and if even the cap collides
 * (it does not for today's provider list; a user's custom endpoints can make it), the
 * colliding names fall back to their routing shortcut, which is unique by
 * construction because it is the shortest prefix that parses back to exactly one
 * provider.
 *
 * Pure, so the guarantee can be asserted without a renderer.
 */
export function providerColumn(
  entries: readonly { value: string; label: string; shortcut: string }[],
  truncate: (s: string, width: number) => string,
  /** What the row can afford — `providerCellsFor`. The floor is still the minimum. */
  want: number = MIN_PROVIDER_CELLS
): { cells: number; text: ReadonlyMap<string, string> } {
  const distinct = new Map<string, { label: string; shortcut: string }>();
  for (const e of entries) distinct.set(e.value, { label: e.label, shortcut: e.shortcut });

  const from = clampProviderCells(want);
  const start = Math.min(
    MAX_PROVIDER_CELLS,
    Math.max(from, ...[...distinct.values()].map((e) => e.label.length))
  );
  for (let cells = from; cells <= start; cells++) {
    const text = new Map<string, string>();
    const seen = new Set<string>();
    let ok = true;
    for (const [value, e] of distinct) {
      const cut = truncate(e.label, cells);
      if (seen.has(cut)) {
        ok = false;
        break;
      }
      seen.add(cut);
      text.set(value, cut);
    }
    if (ok) return { cells, text };
  }

  // Nothing in range separates them. Keep the widest column and disambiguate the
  // colliding names with the one string that cannot collide.
  const cells = start;
  const text = new Map<string, string>();
  const seen = new Set<string>();
  for (const [value, e] of distinct) {
    const cut = truncate(e.label, cells);
    text.set(value, seen.has(cut) ? truncate(e.shortcut, cells) : cut);
    seen.add(cut);
  }
  return { cells, text };
}

/**
 * ONE PROVIDER ROW'S CELLS — the provider list's budget, in the same file as the
 * model row's and for the same reason.
 *
 * It used to live inside `ProviderRow` as four `const`s and an `inner - 2 - 2 -
 * … - 3` expression, which is exactly the drift this file's header warns about:
 * the numbers summed to two columns SHORT of the row, so every provider row
 * painted two unused cells on its right edge and nothing said so. A budget with
 * a test that pins the sum cannot do that.
 *
 * THE TAIL IS SIZED FOR THE ENV VAR, NOT FOR THE COUNT. It carries either a model
 * count (`263 models`) or the credential a keyless provider wants (`needs
 * MOONSHOT_API_KEY`, 22 cells), and a truncated variable name is worse than
 * useless — `needs MOON…` sends the reader looking for a variable that does not
 * exist. Keyless providers are hidden by default now, but `k` reveals them in
 * this same list, so the cell is still theirs to fit. It fits the NAMED case and
 * not the longest one: see `PROVIDER_TAIL_CELLS`.
 */
export interface ProviderRowLayout {
  inner: number;
  /** `▶ ` / `  `, carrying its own trailing space. */
  cursor: number;
  /** `● ` — the readiness glyph and one space. */
  glyph: number;
  /** The readable display name. The elastic cell. */
  name: number;
  /** `zengo@` — the routing shortcut. */
  shortcut: number;
  /** `SUB` / `local` / `$`. */
  billing: number;
  /** Right-aligned: the count, or what a keyless provider needs. */
  tail: number;
  /** One space after the name. Part of the sum. */
  gaps: number;
}

const PROVIDER_GLYPH_CELLS = 2;
/**
 * The one cell after the shortcut. The shortcut itself is as wide as the widest one
 * the list shows (`deriveProviderRowLayout`'s `widestShortcut`), so no shortcut is
 * cut while the row has room: a measured constant went stale as soon as a longer
 * shortcut joined the list (`anthropic@`, 10, under a 9-cell column). It is TEXT, not
 * a chip: 17 filled prefixes in a column fused into one grey band (`rows.tsx`
 * header), so it needs only its own width plus this separator.
 */
const PROVIDER_SHORTCUT_GAP = 1;
/**
 * `local` is the longest billing word: 5 + 2 for the fill every state now carries.
 *
 * SIZED FOR THE CHIP, AND ALL THREE STATES TAKE ONE. A cell that fitted the word and
 * not the fill would clip `local`'s chip by exactly two cells, and Yoga claws those
 * out of a NEIGHBOURING cell rather than reporting anything — `widgets.tsx` measured
 * the result as a 1-column stub of background under the next column's first letter,
 * which `captureCharFrame` cannot see. `$` is the same chip with its label centred in
 * the same fill, which is what makes the column's edges straight (`rows.tsx`'s
 * `CHIP_FILL_CELLS`, derived from this same longest word — `row-semantics.test.ts`
 * pins that this cell never sits under it). No separator column: the chip carries one
 * padded space of its own on each side.
 */
const PROVIDER_BILLING_CELLS = 7;
/**
 * 25, DOWN FROM 26 — and the header's claim above needs the correction it implies.
 *
 * "Sized for the env var" was already aspirational: MEASURED over the provider list, the
 * longest is `needs SAKANA_SUBSCRIPTION_API_KEY` at 33 cells, so 26 truncated it too.
 * What 25 buys is the one cell the billing chip's fill needs without touching the
 * NAME, which at 80 columns sits exactly on its 26-cell cap — and `needs
 * MOONSHOT_API_KEY`, the case the header names, is 22 and still fits whole.
 */
const PROVIDER_TAIL_CELLS = 25;
/**
 * What the tail keeps when it gives cells to the name: the NAMED case above,
 * `needs MOONSHOT_API_KEY`, 22 cells.
 */
const PROVIDER_TAIL_NAMED_CELLS = 22;
const PROVIDER_GAP_AFTER_NAME = 1;
/** Below this a provider name is no longer a name. */
const MIN_PROVIDER_NAME_CELLS = 6;
/**
 * The widest a provider NAME column is ever drawn, whatever the terminal gives it.
 *
 * MEASURED over the whole provider list: `Grok Build (subscription)` is 25 cells and
 * nothing is longer, so 26 fits every name whole. Past that the cell is dead air,
 * and at 92 columns it was 46 — twenty blank cells between `OpenRouter` and the
 * `or@` that qualifies it, which reads as two unrelated columns rather than one
 * fact. The surplus goes to the TAIL, which is right-aligned: the count then sits
 * on the dialog's right edge where a number belongs, and the row still sums to
 * `inner` exactly.
 */
const MAX_PROVIDER_NAME_CELLS = 26;

/**
 * `widestShortcut` is the display width of the widest shortcut among the rows the
 * list shows, so the column fits every one of them, separator included.
 */
export function deriveProviderRowLayout(inner: number, widestShortcut: number): ProviderRowLayout {
  const cells = Number.isFinite(inner) ? Math.max(0, Math.floor(inner)) : 0;
  const shortcutText = Number.isFinite(widestShortcut) ? Math.max(0, Math.ceil(widestShortcut)) : 0;
  let shortcut = shortcutText + PROVIDER_SHORTCUT_GAP;
  let billing = PROVIDER_BILLING_CELLS;
  let tail = PROVIDER_TAIL_CELLS;
  const fixed = (): number =>
    CURSOR_CELLS + PROVIDER_GLYPH_CELLS + shortcut + billing + tail + PROVIDER_GAP_AFTER_NAME;
  let name = cells - fixed();
  if (name < MAX_PROVIDER_NAME_CELLS && tail > PROVIDER_TAIL_NAMED_CELLS) {
    // The tail gives way first (see below), down to its named case, so a wider
    // shortcut column does not cut a name that fitted whole before it.
    const give = Math.min(MAX_PROVIDER_NAME_CELLS - name, tail - PROVIDER_TAIL_NAMED_CELLS);
    tail -= give;
    name = cells - fixed();
  }
  if (name < MIN_PROVIDER_NAME_CELLS) {
    // The tail gives way first — a count is re-stated in full on the detail line
    // below, so it is the one cell here that is a duplicate rather than a fact.
    tail = Math.max(0, tail - (MIN_PROVIDER_NAME_CELLS - name));
    name = cells - fixed();
  }
  if (name < MIN_PROVIDER_NAME_CELLS) {
    shortcut = Math.max(0, shortcut - (MIN_PROVIDER_NAME_CELLS - name));
    name = cells - fixed();
  }
  if (name < 0) {
    billing = Math.max(0, billing + name);
    name = Math.max(0, cells - fixed());
  }
  if (name > MAX_PROVIDER_NAME_CELLS) {
    tail += name - MAX_PROVIDER_NAME_CELLS;
    name = MAX_PROVIDER_NAME_CELLS;
  }
  return {
    inner: cells,
    cursor: CURSOR_CELLS,
    glyph: PROVIDER_GLYPH_CELLS,
    name,
    shortcut,
    billing,
    tail,
    gaps: PROVIDER_GAP_AFTER_NAME,
  };
}

/** Sum of every provider cell plus its separator — must equal `inner`. */
export function providerRowTotal(l: ProviderRowLayout): number {
  return l.cursor + l.glyph + l.name + l.shortcut + l.billing + l.tail + l.gaps;
}

/** The widest the dialog is ever drawn, however wide the terminal is. */
export const MAX_DIALOG_WIDTH = 96;
/** The tallest the dialog is ever drawn, however tall the terminal is. */
export const MAX_DIALOG_ROWS = 28;
/** The most model rows the list ever shows at once. Scroll, do not grow. */
export const MAX_LIST_ROWS = 17;
/** Fewer than this and the list stops being a list. */
const MIN_LIST_ROWS = 3;

/** Rows the description block always occupies, blank or not. */
export const DESCRIPTION_ROWS = 2;

/**
 * Chrome rows the populated dialog ALWAYS spends: two border rows, the filter
 * row, the column header, the status row, the rule, the selection spec line, the
 * provider line, two description rows and the key hints.
 *
 * "ALWAYS" IS THE LOAD-BEARING WORD. Every one of these is rendered even when it
 * is blank, so that a list which starts overflowing — or a description that
 * arrives after the catalog — does not shove every row below it by one. What is
 * deliberately NOT fixed is the LIST's height: it is content-sized up to
 * `listRows`, because the failure state's whole point is a four-row fallback list
 * that reads as four rows rather than as four rows in a panel built for
 * seventeen.
 *
 * THE DESCRIPTION IS TWO ROWS AND THE PROVIDER LINE IS ONE, which is three rows
 * of list surrendered. They earn it: the list says what a model COSTS, and until
 * this the screen never said what a model or a provider IS. The old inquirer
 * picker printed the same sentence and the owner asked for it back by name.
 *
 * The banner's rows come OUT of the list's budget rather than being added to the
 * box, so the dialog is bounded above in every state and only ever SHRINKS from
 * its cap. Shape changes between phases are remounted with `key={…}`, which is
 * the documented cure for inline reconciliation tearing.
 */
export const CHROME_ROWS =
  2 /* border */ +
  1 /* filter */ +
  1 /* column header */ +
  1 /* status */ +
  1 /* rule */ +
  1 /* selection spec */ +
  1 /* provider line */ +
  DESCRIPTION_ROWS +
  1; /* key hints */

/** Below this the dialog cannot carry its own chrome plus a usable list. */
const MIN_DIALOG_ROWS = CHROME_ROWS + MIN_LIST_ROWS;

export interface DialogLayout {
  /** Outer width including the border columns. */
  width: number;
  /** Columns of terminal to the left of the border. Flexbox centres; this is the floor. */
  marginLeft: number;
  /** Usable content columns: `width` less two border columns and two of padding. */
  inner: number;
  /** How many model rows fit. The list scrolls within this. */
  listRows: number;
}

/**
 * Size the dialog for a terminal, and for however many rows a banner has taken.
 *
 * `extraRows` is the honest coupling between the failure banner and the list: a
 * five-row 401 explanation and seventeen model rows do not both fit, and the rows
 * that must give way are the list's — the banner is the REASON the list is short,
 * so hiding the banner to show more of an unverified list would invert the whole
 * point of the state.
 *
 * `- 2` LEAVES ONE ROW OF AIR ABOVE AND BELOW, which is what makes a centred
 * dialog read as centred rather than as clipped. It grows with the terminal up to
 * `MAX_DIALOG_ROWS` now that the dialog is centred in a full-height root: the old
 * fixed 18 rows existed to keep an "inline" region small, and inline never held —
 * `CliRendererConfig` at this pin has no `height` key, so the renderer has always
 * owned every row of the terminal.
 */
export function deriveDialogLayout(
  termWidth: number,
  termHeight: number,
  extraRows = 0
): DialogLayout {
  const w = Number.isFinite(termWidth) ? Math.max(24, Math.floor(termWidth)) : 80;
  const h = Number.isFinite(termHeight) ? Math.floor(termHeight) : 24;
  const width = Math.min(w - 4, MAX_DIALOG_WIDTH);
  // Two columns of margin at 80, centred once the terminal is wider than the cap.
  const marginLeft = Math.max(2, Math.floor((w - width) / 2));
  const budget = Math.min(MAX_DIALOG_ROWS, Math.max(MIN_DIALOG_ROWS, h - 2));
  const listRows = Math.max(
    MIN_LIST_ROWS,
    Math.min(MAX_LIST_ROWS, budget - CHROME_ROWS - Math.max(0, Math.floor(extraRows)))
  );
  return { width, marginLeft, inner: Math.max(8, width - 4), listRows };
}

/**
 * The scroll window for a cursor in a list — the offset that keeps the cursor
 * visible while moving the viewport as little as possible.
 *
 * Pure, and computed rather than held in a ref, because there is no `<scrollbox>`
 * here: the visible rows are sliced out of the array and rendered as plain
 * `<text>` rows. That deletes two measured OpenTUI traps at once — a scrollbox's
 * intrinsic height is its WHOLE content, which starves every sibling in the same
 * column, and its reconciler desyncs when a content-derived key changes under it.
 */
export function scrollWindow(cursor: number, total: number, rows: number): number {
  const size = Math.max(1, Math.floor(rows));
  if (total <= size) return 0;
  const c = Math.max(0, Math.min(total - 1, Math.floor(cursor)));
  // Keep the cursor one row inside the window where there is room, so the next
  // press reveals a row rather than only moving the highlight.
  const top = Math.min(Math.max(0, c - Math.floor(size / 2)), total - size);
  return Math.max(0, top);
}
