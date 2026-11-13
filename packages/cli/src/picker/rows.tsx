/** @jsxImportSource @opentui/react */
/**
 * picker/rows.tsx — one model row, one provider row, one column header, and the
 * pure label arithmetic behind them.
 *
 * ALIGNED TEXT AND CHIPS. NO METERS, NO GRADIENTS. The build this replaces drew a
 * context meter and a price meter on every row, and the reason it had to is written
 * down: a whole-frame graphics-density gate counts a list row carrying a bar as a
 * graphics row, so on a screen whose content IS a list there is no way to pass it
 * without decorating every row. The result was measured — of 32 visible rows, 19
 * read `1M`, and their bars were indistinguishable. Two full columns of gradient
 * encoding one repeated value, beside the numerals that already said it. A CHIP IS
 * NOT A METER: it draws no magnitude and takes `displayWidth(label) + 2` cells, so
 * it costs the row nothing a padded word did not already cost.
 *
 * A meter belongs where a bounded value VARIES and where a reader is comparing
 * magnitudes rather than reading names. In this file there is exactly one such
 * place and it is not here — it is the loading dialog, where `done/total` is real
 * progress over countable work.
 *
 * THE PROVIDER COLUMN IS FIRST, AND IT IS A NAME. It used to be last-but-three and
 * printed the routing shortcut (`or@`, `oai@`, `cx@`); the owner's question on a
 * live run was *"what is 'or' means"*. A shortcut only reads as information to
 * someone who already knows it, so it teaches nothing about a screen whose whole
 * job is to say what is on offer. The column now prints the provider's readable
 * display name, sourced from the provider definitions through
 * `PickerProviderChoice.label` — never a name table here — and it leads the row,
 * because "which provider" is the question the user asked first. The shortcut is
 * not lost: it sits beside the full name in the `p` dialog, and inside the exact
 * `provider@model` spec on the detail line.
 *
 * A FILL IS FOR THE NOTABLE STATE, NOT FOR EVERY ROW — THE RULE THAT SHIPPED
 * BACKWARDS ONCE. A previous pass chipped the routing prefix and the billing mode on
 * EVERY provider row. Both columns then had a fill on all 17 rows, and with no blank
 * row between them the fills fused: the prefix column read as one solid grey vertical
 * band and the billing column as one solid green one, with the labels floating inside
 * them. That is the failure `widgets.tsx` already measured for 24 `UP` chips, and
 * correct padding does not prevent it — padding is not what makes the fills identical.
 * `ScopeTabs.tsx` in claudeup states the surviving rule: the ACTIVE tab is a filled
 * block, the inactive one is plain muted text with no background at all.
 *
 *   `or@` / `zengo@`  subtle TEXT             a routing IDENTIFIER, never a status
 *   `$$$`             QUIET chip, rose        metered — this one costs you per token
 *   `FREE` / `SUB`    SIGNAL chip, green      no per-token charge — the SAME claim
 *   `local`           SIGNAL chip, green      no charge either, by another mechanism
 *   `catalog`         warn text               NOT the dynamic models catalog — `DiscoveryNotice`
 *   `N/A`             dead text               the catalog does not say
 *   selection         accent + `C.bgHighlight`, and a `▶` so it survives greyscale
 *
 * THE PREFIX KEEPS NO FILL AND `$$$` GOT ONE — and the two are not the same
 * question. A routing prefix is an IDENTIFIER: every row has one, they have no
 * states, and a column with no notable member has nothing for a fill to mark. The
 * billing cell is a STATUS with a closed vocabulary, and the owner's instruction
 * after reading the shipped screen was *"make $$$ the same width and badge as
 * well"*: `SUB` filled beside a bare `$` left the column ragged, one chip floating
 * over a word with a different left edge. So the cell is now ALWAYS a chip, in one
 * of two fills.
 *
 * WHICH MEANS THE BANDING RISK IS REAL AND IS ANSWERED BY THE PAIR, NOT BY A GAP.
 * `$$$` and `SUB`/`local` partition the provider list, so this is a fill on all 17 rows —
 * exactly the shape that fused into one grey band when the PREFIX was chipped. What
 * failed there was that all 17 fills were the SAME colour; here they alternate, and
 * the two fills are held apart by measurement rather than by hope: ΔE76 44.9 on the
 * light palette (`#BCE5CD` vs `#EDABB4`) and 63.4 on the dark one (`#2f8250` vs
 * `#6B3B42`), where ~2.3 is a just-noticeable difference. Pinned by
 * `theme-contrast.test.ts` so a future tweak that collapses them fails a test rather
 * than a screenshot. Verified on `dialog8-*` at 80x24 and 145x45, dark and light.
 *
 * THE GATE IS OVER EVERY PAIR THE COLUMN CAN PAINT, NOT OVER THE TWO THAT CHANGED.
 * `CHIP_COLUMN_LABELS` is the closed vocabulary and `billingLabel`/`priceChipBg` map
 * it onto fills, so the test derives that map and measures every unordered pair of
 * DISTINCT fills — which also pins the other half of the design: `FREE`, `SUB` and
 * `local` must keep sharing ONE fill, because all three make the same claim, and a
 * third fill appearing there would be caught as a pair that has to be 20 apart.
 *
 * THE REDDISH HALF IS QUIET BY MEASUREMENT, AND THAT IS NOW A GATE ABOUT FAILURE.
 * The old measurement was that `$` carried less than half the CHROMA of `SUB` — the
 * axis that said "metered is the absence of a claim". That is no longer the design:
 * `$$$` is half of an opposition and carries a hue of its own (C* 25.9 light, 22.6
 * dark). What replaced it is the register test against the colour reddish now has to
 * coexist with: the cost fill stays under the QUIET CEILING off its own page while
 * `C.red` clears 3:1, it carries under half the chroma of `C.red`, and it is ΔE76 ≥ 20
 * from both `C.red` and `C.bgError`. Loud-versus-quiet is still the axis; the thing it
 * is measured against moved from `SUB` to the error.
 *
 * ONE FILL WIDTH FOR THE WHOLE COLUMN, WHICH IS THE ONE PLACE PADDING GOES INSIDE A
 * FILL. `aesthetics-and-color.md` forbids padding inside the label because 24 `UP`
 * chips in a ROW fused into a rectangle; that rule is about a row of identical
 * chips, and this is a single column whose whole point is a straight left and right
 * edge. So `CHIP_FILL_CELLS` is derived from the LONGEST label the column can ever
 * print (`local`, 5, + 2) and every chip paints exactly that, label centred inside —
 * a hardcoded 5 would have clipped `local` and `FREE` by the two cells Yoga then
 * steals from a neighbouring cell. Both columns that print these tokens use the same
 * number, so `$$$`, `SUB`, `FREE` and `local` line up in the provider list and in the
 * model list alike. `$$$` happens to be three cells, the same as `SUB` — which is what
 * the owner's earlier "same width" instruction asked for and this one delivers for
 * free — but the width is still DERIVED, because the coincidence is not a rule.
 *
 * `SUB` WAS `tokens.warn` UNTIL A PASS AGO, AND THAT WAS A ONE-COLOUR-ONE-MEANING
 * VIOLATION IN THE SHIPPED BUILD, not in a prototype. `warn` is `C.orange` —
 * `#ff8800` on dark and a rust `#c2410c` on light — which is the hue this app
 * spends on failure. `SUB` is the opposite of a failure: it is the route the user
 * already pays for, free at the point of use.
 *
 * RED NOW MEANS TWO THINGS HERE AND THAT IS DELIBERATE, WHICH IS NOT THE SAME AS
 * UNPRINCIPLED. Failure is SATURATED red — the `HTTP 4xx` badge, the discovery
 * banner's border and wash. Cost is a QUIET rose TINT. Rule 1 forbids one COLOUR
 * carrying two meanings; these are two registers of a hue, measured apart and pinned
 * apart, and the reason it is worth spending is that "costs money" has no other
 * natural colour — the alternative was the near-neutral nobody read as a claim.
 *
 * THREE CHIPS THAT LOOK THE SAME MEAN THE SAME THING. `FREE`, `SUB` and `local` share
 * one positive fill on purpose — all three say "running this costs you no per-token
 * money" — and the LABEL says by which mechanism. Splitting the hue would put three
 * meanings on one claim, which is rule 1 read backwards.
 *
 * A CHIP MARKS A TOKEN THAT VARIES DOWN ITS COLUMN. The price column varies in the
 * cross-provider list and inside a METERED provider (numerals, with the odd
 * `FREE`); inside a flat-rate or local provider every row carries the same word,
 * and identical fills stacked with no gap between rows is the failure the skill
 * MEASURED — 24 `UP` chips fusing into one solid rectangle with the labels floating
 * in it. There the word is drawn as coloured text instead. `chip` is that one
 * decision, taken by the caller that knows the scope.
 *
 * In particular the price NUMERAL is never colour-coded: a value takes discrete
 * buckets or nothing at all, and three buckets of dollars would put a third
 * meaning on `success` in a column already carrying `FREE`.
 *
 * ONE `<text>` PER ROW, ALWAYS. Yoga claws columns back from the LAST `<text>`
 * child of a row, which is how a branch name once rendered as `mai` with thirty
 * free columns beside it (`resume-picker.tsx:473-484`). So every cell is a
 * `<span>` inside a single text node.
 *
 * COLOUR IS READ AT RENDER TIME, never captured in a module-level `const`:
 * `C`/`tokens` are reassigned in place when the terminal theme is detected, and a
 * snapshot taken at import would ship the dark palette to a light terminal. That
 * bug has been found six times in this repo, once visible only in a live
 * screenshot.
 */

import type { ReactNode } from "react";
import type { ModelInfo } from "../model-selector.js";
import { A, C } from "../tui/theme.js";
import { displayWidth, padStartTo, padTo, truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import { BadgeSpan } from "../tui/viz/widgets.js";
import type { BillingMode } from "./PickerDataSource.js";
import { GAPS, type RowLayout, deriveProviderRowLayout } from "./layout.js";

/** Readiness, in `ProvidersContent.tsx:225`'s exact vocabulary. */
export type Readiness = "pending" | "ready" | "missing";

/**
 * EVERY LABEL A CHIPPED STATUS CELL CAN EVER PRINT, in either of the two columns
 * that print them — the provider list's billing cell and the model list's price
 * cell. The list is the vocabulary, not a sample of it: `billingLabel` and
 * `priceChipBg` between them answer exactly these four words and nothing else.
 */
export const CHIP_COLUMN_LABELS = ["$$$", "SUB", "FREE", "local"] as const;

/**
 * The fill EVERY chip in a status column paints, in cells.
 *
 * DERIVED, NEVER TYPED OUT. The owner asked for one width across the column, and the
 * natural-looking number is 5 — `SUB` plus a space each side — which would clip
 * `FREE` and `local` by one and two cells. Yoga does not report a clipped cell: it
 * claws the columns out of a NEIGHBOURING cell and paints a stub of background under
 * its first letter, which `captureCharFrame` cannot see (`widgets.tsx` measured it).
 * So the width comes from the longest label the column can print, and a fifth state
 * added to `CHIP_COLUMN_LABELS` widens the column instead of overflowing it.
 */
export const CHIP_FILL_CELLS =
  Math.max(...CHIP_COLUMN_LABELS.map((label) => displayWidth(label))) + 2;

/** Where a list came from — the one value that drives every provenance encoding. */
export type ListOrigin = "discovered" | "catalog";

/**
 * What the price column prints.
 *
 * `resolveProviderDisplayPrice` is the ONE function allowed to decide what a row
 * costs (its `isSubscriptionProvider`-first rule is test-pinned) and it answers a
 * display string, so this only ever RESHAPES that answer — it never recomputes it.
 * Two reshapes, both to buy columns back for the model name: the `/1M` suffix goes
 * because the column header says `$/1M` once for the whole list, and `LOCAL`
 * becomes `local` because a local model has no price at all and shouting is for
 * things that cost money. A `sub` row prints `SUB` whatever string arrived: the
 * billing mode comes from the same `displayBillingOf` rule, so this agrees with
 * `resolveProviderDisplayPrice` and covers a row priced from the catalog alone.
 */
export function priceLabel(display: string, billing: BillingMode): string {
  if (billing === "local") return "local";
  if (billing === "sub") return "SUB";
  const s = (display || "N/A").trim();
  if (s === "LOCAL") return "local";
  if (s === "SUB" || s === "FREE" || s === "N/A") return s;
  return s.replace(/\s*\/\s*1M$/i, "");
}

/**
 * The FILL a discrete price token is chipped on, or `null` for a value rather
 * than a token.
 *
 * A NEON FOREGROUND IS NOT A FILL. `tokens.success` is `C.green`, `#39ff14`, and
 * the skill is explicit that a colour tuned to read as text is harsh as a solid
 * block. `C.pillKeyBg` is this repo's contrast-tuned SIGNAL green — `#2f8250` on the
 * dark palette and the deeper `#166534` on the light one, each measured against its
 * own page (`theme-contrast.test.ts`) — and it is ALREADY the `FREE` chip on the
 * session summary card (`session-summary.ts:176`), so this is the same object, not a
 * second invention. Read at RENDER time, which is why this is a function.
 */
export function priceChipBg(label: string): string | null {
  if (label === "FREE" || label === "SUB" || label === "local") return C.pillKeyBg;
  return null;
}

/** The one colour each price label is allowed to have when it is NOT chipped. */
export function priceFg(label: string): string {
  // `FREE`, `SUB` and `local` make the same claim — no per-token charge — so they
  // take the same positive tier. NEVER `tokens.warn`; see the file header.
  if (label === "FREE" || label === "SUB" || label === "local") return tokens.success;
  if (label === "N/A") return tokens.dead;
  return tokens.text;
}

/**
 * Does the price column VARY in this view, and so earn chips?
 *
 * `null` is the cross-provider list. A scoped provider FIXES the column when it
 * bills flat-rate or runs locally — `resolveProviderDisplayPrice` answers `SUB` for
 * every row a subscription provider lists — and a column of one repeated fill is the
 * rectangle the skill measured.
 */
export function priceVaries(scopeBilling: BillingMode | null): boolean {
  return scopeBilling === null || scopeBilling === "metered";
}

/**
 * `●` ready · `○` needs a key · `◌` probe in flight — `ProvidersContent.tsx:225`.
 *
 * PENDING IS `running`, NOT `warn`, for the reason `chrome.tsx` already gives for
 * the catalog shimmer: a probe in flight is not a warning, and spending the
 * failure hue on it teaches the reader to discount that hue everywhere else.
 */
export function readinessGlyph(r: Readiness): { glyph: string; fg: string } {
  if (r === "ready") return { glyph: "●", fg: tokens.success };
  if (r === "missing") return { glyph: "○", fg: tokens.dead };
  return { glyph: "◌", fg: tokens.running };
}

/**
 * The provider view's billing token — the vocabulary a model row prices with.
 *
 * ALL THREE ARE CHIPS, AT ONE WIDTH, AND THE FILL IS THE ONLY THING THAT DIFFERS.
 * `$` used to be drawn as muted text on the grounds that a fill on every row of the
 * column is the banding defect; what the owner saw on the shipped screen was the
 * other half of that trade — a 5-cell green chip beside a 1-cell word, so the column
 * had no edges. Two fills 45–63 ΔE apart alternate visibly, which a single fill on
 * every row could not.
 *
 * `$$$`, NOT `$`, AND THE TWO FILLS ARE NOW A SEMANTIC PAIR. The owner's instruction:
 * *"instead of $ it should be '$$$' with light reddish colour"*. It is three cells
 * like `SUB`, so the two labels are the same width by construction rather than by
 * padding — but `CHIP_FILL_CELLS` still derives from the longest label the column can
 * print (`local`), because the coincidence is not a rule.
 *
 * The colour is the substantive half. `$` was a near-neutral because metered was
 * framed as the UNREMARKABLE default; paired with a green `SUB` that made the column
 * "a claim and the absence of one". It now reads as one opposition — GREEN is free at
 * the point of use, REDDISH costs you per token — and a near-neutral cannot carry
 * half of an opposition. Each fill still states its own ink (`C.pillKeyFg`,
 * `C.pillCostFg`): on DARK, saturated/near-bg fills with light ink; on LIGHT, pale
 * TINTS with deep ink of their own hue, which is the inverted construction a white
 * page needs. All four are read at RENDER time — a module-level `const` ships not just
 * the wrong hex but the wrong recipe to the other theme.
 *
 * REDDISH IS THE HUE FAILURE ALREADY OWNS, AND THAT IS SETTLED BY REGISTER, NOT BY
 * AVOIDANCE. The `HTTP 401` badge and the discovery banner are SATURATED red with
 * light ink; the cost chip is a QUIET tint with deep ink, held under a 3:1 ceiling off
 * its own page. `theme-contrast.test.ts` pins ΔE76 ≥ 20 between the cost fill and BOTH
 * failure fills (`C.red` and the banner's `C.bgError` wash), per palette — the same
 * instrument and the same floor as the banding gate. Measured: 65.4 / 22.4 on light
 * and 73.7 / 20.8 on dark. If a future tweak moves them together it is the COST tint
 * that gives way; the error colour is the one that must not move.
 *
 * `$$$` IS THE CHIP AND NOTHING ELSE. The price column prints real numbers (`$2.25`,
 * `$30.00`) and its header prints the unit (`$/1M`); the detail line says
 * `metered — billed per token`. Those are values and words, not this token, and none
 * of them became `$$$`.
 */
export function billingLabel(mode: BillingMode): { text: string; fg: string; bg: string } {
  if (mode === "sub") return { text: "SUB", fg: C.pillKeyFg, bg: C.pillKeyBg };
  if (mode === "local") return { text: "local", fg: C.pillKeyFg, bg: C.pillKeyBg };
  return { text: "$$$", fg: C.pillCostFg, bg: C.pillCostBg };
}

/**
 * What a provider row says in its tail when it is not saying why it is unavailable.
 *
 * `null` PRINTS NOTHING — not `0`, not `—`, not a guess. See `ProviderRowProps.count`.
 *
 * `0 models` IS A DIFFERENT CLAIM FOR A DISCOVERY PROVIDER, and printing it there
 * would be the original defect in miniature: Devin and Antigravity carry no catalog
 * entries by design and ask their own endpoint the moment you scope to them, so
 * "0 models" reads as "this provider has nothing" about a provider nothing has asked.
 *
 * AND IT SAYS WHAT THE USER GETS, NOT HOW CLAUDISH FETCHES IT. The words were
 * `asks its own` followed by this codebase's since-retired internal word for a
 * provider's model list, which the owner read on a live run and rejected. That word
 * appeared nowhere else in the UI, so the row described an implementation detail of the thing the reader was
 * trying to choose between. His replacement, verbatim: *"subscription models"*.
 *
 * TWO PHRASINGS, BECAUSE ONE WOULD BE FALSE FOR HALF THE SET. Every provider that
 * reaches this branch today is flat-rate — Devin, Antigravity, OpenCode Zen Go — and
 * for those "subscription models" is exactly right: what you get is the model list
 * your plan includes. But `hasDiscovery` is a property of the PROVIDER DEFINITION and
 * not of its billing, so a metered or local provider with no catalog entries lands
 * here too (a self-hosted vLLM, an Ollama daemon), and telling that user he has a
 * subscription would be a lie the screen states as fact. So the billing mode picks the
 * words, and the other phrasing names the provider's OWN list — which is the real
 * distinction, since every counted row on this screen is counted from the shared
 * catalog.
 *
 * Pure and exported so the wording is asserted directly. The state that produces it
 * needs a warm catalog, a scoped visit and an empty count, which is three awaits away
 * from a screenshot.
 */
export function providerCountText(row: {
  count: number | null;
  hasDiscovery: boolean;
  billing: BillingMode;
}): string {
  if (row.count === null) return "";
  if (row.count === 0 && row.hasDiscovery) {
    return row.billing === "sub" ? "subscription models" : "lists its own models";
  }
  return `${row.count} model${row.count === 1 ? "" : "s"}`;
}

const SPACES = "                                        ";
const gap = (n: number): string => SPACES.slice(0, Math.max(0, n));

/**
 * A chip that has to sit inside a fixed COLUMN, at the column's ONE fill width.
 *
 * Two kinds of padding meet here and only one of them is inside the fill:
 *
 *  · the CELL's surplus — whatever the column has beyond `CHIP_FILL_CELLS` — is
 *    plain, unfilled space, emitted before the chip when the cell right-aligns
 *    (`badgePad` can only pad after it) and by `badgePad` when it left-aligns.
 *    This is the skill's rule and it is kept.
 *  · the LABEL's surplus — `local` is 5 cells and `SUB`/`$$$` are 3 — is centred INSIDE
 *    the fill, which is the sanctioned exception (file header). It is what makes one
 *    straight-edged column out of four labels of different lengths, and a column is
 *    not the row of 24 identical chips the rule was measured on.
 *
 * Below `CHIP_FILL_CELLS` the fill shrinks to the cell rather than overflow it, and
 * below three columns it declines to draw at all — there a chip could only ever be
 * part of a fill.
 */
function ChipCell({
  label,
  bg,
  fg,
  width,
  align = "left",
}: {
  label: string;
  bg: string;
  /** The ink THIS fill carries. Required: the column's two fills take different ink. */
  fg: string;
  width: number;
  align?: "left" | "right";
}): ReactNode {
  const cells = Math.max(0, Math.floor(width));
  if (cells < 3 || label === "") return cells > 0 ? <span>{gap(cells)}</span> : null;
  const fill = Math.min(cells, CHIP_FILL_CELLS);
  const fitted = truncate(label, fill - 2);
  const slack = Math.max(0, fill - 2 - displayWidth(fitted));
  const left = Math.floor(slack / 2);
  const centred = `${gap(left)}${fitted}${gap(slack - left)}`;
  const lead = align === "right" ? Math.max(0, cells - fill) : 0;
  return (
    <>
      {lead > 0 ? <span>{gap(lead)}</span> : null}
      {/* THE INK IS PASSED, never left to `pickInk`. `pickInk` picks from LUMINANCE
          alone, and a near-background fill straddles its threshold: measured on the
          old `#15803d` it answered white on the dark palette and BLACK on the light
          one for the SAME hex — one chip wearing two inks, at the worse ratio (4.02
          vs 5.02) on the page more likely to be squinted at. We chose the fill, so we
          choose its ink, and each palette states both together. */}
      <BadgeSpan label={centred} bg={bg} fg={fg} {...(align === "right" ? {} : { width: cells })} />
    </>
  );
}

/**
 * The column header. It exists so the four fixed cells are NAMED rather than
 * guessed at, which is the cheapest possible answer to "what is happening here":
 * the previous build printed `262K` and `$30.00/1M` beside two unlabelled bars.
 */
/**
 * The header of the last column. LM Studio rows on LM Link machines print the
 * machine there; a list that also holds priced rows (all models, once a local
 * provider was opened) keeps the price header, which most of its rows answer.
 */
export function lastColumnLabel(models: readonly ModelInfo[]): string {
  return models.length > 0 && models.every((m) => m.machine) ? "machine" : "$/1M";
}

export function ColumnHeader({
  layout,
  last = "$/1M",
}: { layout: RowLayout; last?: string }): ReactNode {
  return (
    <box height={1} flexShrink={0}>
      <text>
        <span fg={tokens.trace}>{"  "}</span>
        {/* THE HEADER FOLLOWS THE LAYOUT, it never re-decides it. `provider === 0`
            is the scoped view, where the dialog title already names the provider —
            a header cell for a column with no cells under it would be a label
            pointing at nothing, and the gutter would indent every id by two. */}
        {layout.provider > 0 ? (
          <>
            <span fg={tokens.trace}>{padTo("provider", layout.provider)}</span>
            <span>{gap(GAPS.afterProvider)}</span>
          </>
        ) : null}
        <span fg={tokens.trace}>{padTo("model", layout.id)}</span>
        <span>{gap(GAPS.afterId)}</span>
        <span fg={tokens.trace}>{padStartTo("ctx", layout.ctx)}</span>
        <span>{gap(GAPS.afterCtx)}</span>
        <span fg={tokens.trace}>{padStartTo(last, layout.price)}</span>
        {layout.mark > 0 ? <span fg={tokens.trace}>{padStartTo("", layout.mark)}</span> : null}
      </text>
    </box>
  );
}

export interface ModelRowProps {
  model: ModelInfo;
  /**
   * The provider's READABLE display name, already fitted to `layout.provider` and
   * guaranteed distinct from every other provider on screen (`providerColumn`).
   *
   * It replaced the routing shortcut — `or@`, `oai@`, `cx@` — because the owner
   * asked, verbatim, *"what is 'or' means"*. A shortcut is information only to
   * someone who already knows it. The shortcut still exists where it explains
   * itself: beside the full name in the `p` dialog, and inside the exact spec on
   * the detail line under this list.
   */
  providerLabel: string;
  /** Whatever `resolveProviderDisplayPrice` said, already reshaped by `priceLabel`. */
  price: string;
  layout: RowLayout;
  cursor: boolean;
  /** `catalog` marks a row that is NOT from the provider's dynamic models catalog. */
  origin: ListOrigin;
  /**
   * Draw a discrete price label as a CHIP rather than as coloured text.
   *
   * The caller decides because only the caller knows the scope — see `priceVaries`
   * and the file header. Default `false`: a chip is the exception a view opts into,
   * so a new call site cannot accidentally paint a rectangle.
   */
  chip?: boolean;
}

export function ModelRow({
  model,
  providerLabel,
  price,
  layout,
  cursor,
  origin,
  chip = false,
}: ModelRowProps): ReactNode {
  // Render-time reads — see the file header.
  const idFg = cursor ? C.strong : tokens.text;
  const chipBg = chip ? priceChipBg(price) : null;
  return (
    // THE WASH LIVES ON THE BOX, not on the `<text>`: a text node is only as wide
    // as its content, so a row highlighted that way stops at its last glyph and
    // reads as a floating chip rather than as a bar. `height={1}` keeps a row from
    // overprinting its neighbour.
    <box height={1} flexShrink={0} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text attributes={A.boldIf(cursor)}>
        <span fg={cursor ? tokens.accent : tokens.trace}>{cursor ? "▶ " : "  "}</span>
        {/* DROPPED ENTIRELY INSIDE A PROVIDER, not blanked. `OpenAI Codex` printed
            49 times under a dialog titled `OpenAI Codex` is the column with the
            least information on the screen, and it was eating the cells the model
            id wants. It is the whole point of the cross-provider list, so it stays
            there — one flag, one layout, no second row component. */}
        {layout.provider > 0 ? (
          <>
            <span fg={cursor ? C.strong : tokens.subtle}>
              {padTo(truncate(providerLabel, layout.provider), layout.provider)}
            </span>
            <span>{gap(GAPS.afterProvider)}</span>
          </>
        ) : null}
        <span fg={idFg}>{padTo(model.machine?.modelId ?? model.id, layout.id)}</span>
        <span>{gap(GAPS.afterId)}</span>
        <span fg={tokens.subtle}>{padStartTo(model.context || "N/A", layout.ctx)}</span>
        <span>{gap(GAPS.afterCtx)}</span>
        {model.machine ? (
          <span fg={cursor ? C.strong : tokens.text}>
            {padStartTo(truncate(model.machine.name, layout.price), layout.price)}
          </span>
        ) : chipBg === null ? (
          <span fg={priceFg(price)}>{padStartTo(price, layout.price)}</span>
        ) : (
          // `C.pillKeyFg` because `priceChipBg` only ever answers the SIGNAL fill — a
          // price numeral is never chipped, so this column has no quiet half.
          <ChipCell label={price} bg={chipBg} fg={C.pillKeyFg} width={layout.price} align="right" />
        )}
        {layout.mark > 0 ? (
          <span fg={tokens.warn}>
            {padStartTo(origin === "catalog" ? "catalog" : "", layout.mark)}
          </span>
        ) : null}
      </text>
    </box>
  );
}

export interface ProviderRowProps {
  label: string;
  shortcut: string;
  readiness: Readiness;
  billing: BillingMode;
  /**
   * How many models this provider offers, or `null` for "not known yet".
   *
   * `null` PRINTS NOTHING — not `0`, not `—`, not a guess. The owner's rule,
   * verbatim: *"we could not show number of models for some of them"*. This
   * column is now only filled for a provider whose dynamic models catalog the user has already
   * opened, or whose count is already in hand from a catalog the user asked for;
   * everything else is silent, because a wrong count is worse than no count and
   * an em dash still occupies the place where a number goes.
   */
  count: number | null;
  /** Does this provider list its own dynamic models catalog? Decides what a known `0` means. */
  hasDiscovery: boolean;
  /** Why it is not selectable — an env var name, or empty. */
  note: string;
  cursor: boolean;
  /** Usable content columns. */
  inner: number;
}

/**
 * One provider, in the list the picker now OPENS ON.
 *
 * IT IS THE DEFAULT SCREEN, NOT A DETOUR. The build this replaces landed on a flat
 * 574-row cross-provider list and reached the providers through `p`; the owner's
 * verdict was *"we should not show the full list of models, we should show a list
 * of providers by default and only when we go inside we load and resolve all
 * models"*. So this row is the first thing the picker draws, and entering one is
 * what makes that provider's dynamic models catalog be fetched at all.
 *
 * IT IS A DIALOG, NOT A RAIL. The rejected build put a 19-column provider rail
 * permanently beside the model list, which gave the screen two cursors with only a
 * border colour to say which one the arrow keys drove — "super unclear what is
 * happening", precisely described. It also truncated two different providers to
 * the same `opencod…`. At full dialog width the names are whole, and only one list
 * is ever on screen.
 */
export function ProviderRow({
  label,
  shortcut,
  readiness,
  billing,
  count,
  hasDiscovery,
  note,
  cursor,
  inner,
}: ProviderRowProps): ReactNode {
  const { glyph, fg } = readinessGlyph(readiness);
  const bill = billingLabel(billing);
  const L = deriveProviderRowLayout(inner);
  const tail =
    readiness === "missing" && note !== ""
      ? note
      : providerCountText({ count, hasDiscovery, billing });
  return (
    <box height={1} flexShrink={0} backgroundColor={cursor ? C.bgHighlight : undefined}>
      <text attributes={A.boldIf(cursor)}>
        <span fg={cursor ? tokens.accent : tokens.trace}>{cursor ? "▶ " : "  "}</span>
        <span fg={fg}>{padTo(glyph, L.glyph)}</span>
        <span fg={cursor ? C.strong : tokens.text}>{padTo(truncate(label, L.name), L.name)}</span>
        <span>{gap(L.gaps)}</span>
        {/* THE PREFIX IS AN IDENTIFIER AND EVERY ROW HAS ONE, so it is the muted
            hue AS TEXT. Chipped, it put a fill on all 17 rows of a column with no
            gap between them and the column fused into one grey band — the owner's
            word was "super ugly". A fill marks the notable member of a column; here
            there is no notable member, only a name. */}
        <span fg={tokens.subtle}>{padTo(truncate(shortcut, L.shortcut), L.shortcut)}</span>
        {/* BOTH STATES ARE CHIPS AND BOTH ARE `CHIP_FILL_CELLS` WIDE — the owner's
            "make $$$ the same width and badge as well". What keeps the column from
            reading as one band is the distance between the two fills, not a gap, and
            what keeps `$$$` from being read as an ERROR is that only one of the two
            reds is saturated: `theme-contrast.test.ts` pins both. */}
        <ChipCell label={bill.text} bg={bill.bg} fg={bill.fg} width={L.billing} />
        <span fg={readiness === "missing" ? tokens.dead : tokens.subtle}>
          {padStartTo(truncate(tail, L.tail), L.tail)}
        </span>
      </text>
    </box>
  );
}

/**
 * A dim, NON-SELECTABLE row for something a list is deliberately not showing.
 *
 * An unexplained absence is the defect class this whole feature is about, so the
 * number is said out loud. It stays unselectable because a row that cannot be
 * picked must not look like one that can: offering it would trade a silent absence
 * for a dead end.
 */
export function HintRow({ text, width }: { text: string; width: number }): ReactNode {
  return (
    <box height={1} flexShrink={0}>
      <text>
        <span fg={tokens.trace}>{truncate(`  ${text}`, width)}</span>
      </text>
    </box>
  );
}
