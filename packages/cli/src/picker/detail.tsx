/** @jsxImportSource @opentui/react */
/**
 * picker/detail.tsx — the pane under the list that says what Enter will do, what
 * the provider IS, and what the model IS.
 *
 * IT ANSWERS THE QUESTION A PICKER MUST NEVER LEAVE OPEN: what EXACTLY does Enter
 * return? It prints the spec verbatim — `google@gemini-3.8-flash`, the same string
 * `buildExplicitModelSpec` hands the launcher and the same string the user could
 * have typed on argv — so the picker teaches its own CLI instead of hiding behind
 * a private label.
 *
 * THEN TWO THINGS THE LIST CANNOT SAY, BOTH ADDED BECAUSE THE OWNER ASKED FOR THEM
 * BY NAME:
 *
 *   · **What the provider is.** "we need add more details about provider — now it
 *     has no sense, like what is 'or' means". A row now carries the readable name;
 *     this line carries the rest of the answer — how it bills (a flat-rate plan
 *     charges nothing per token, which is the single most decision-relevant fact
 *     about a route) and which credential it authenticates with, named exactly, so
 *     a reader can go and check the variable rather than guess at it. Every field
 *     comes from `ProviderDefinition` through `PickerProviderChoice`; nothing here
 *     is a table.
 *   · **What the model is.** The old inquirer picker printed the catalog's prose
 *     sentence under the highlighted row and the new dialog dropped it, leaving
 *     `spec · capabilities · date` — four facts about a model's shape and none
 *     about its purpose. It is back, wrapped to the dialog and capped at
 *     `DESCRIPTION_ROWS`. The slim catalog carries no description (0 of 704
 *     entries), so it arrives on its own clock from `providers/model-descriptions`
 *     and the rows are rendered blank until it does — never collapsed, or every
 *     row below would jump when it lands.
 *
 * THE WHOLE PANE IS CHROME, AND IT RECEDES BY ITS INK — NEVER BY A FILL. Rule 6 of
 * `aesthetics-and-color.md` is "dim the chrome, saturate the signal": the list rows
 * are the signal — they are what the cursor moves through and what Enter returns —
 * and this pane is the footnote under them. It used to open with a BOLD ACCENT-BLUE
 * spec line, the loudest text on the screen, under a list drawn in body ink, and the
 * owner asked for the detail to be less prominent.
 *
 * A PASS THAT ANSWERED THAT WITH A BACKGROUND FILL WAS REJECTED, and the rule it
 * broke is the first one claudeup's theme states: panels sit on the terminal's own
 * background and are separated by their border, never by an absolute fill that
 * fights the user's theme. Here the separator already exists — `Rule` draws it one
 * row above — so a fill was a second separator that also painted three rows in a
 * colour the terminal never asked for. The owner's words: "all text in description
 * has different background colours. please bring it back... please remove that
 * different background colours."
 *
 * So the recession is entirely in the INK, three weights, brightest first: the spec
 * and the provider name in `debug` (`C.fgMuted` — a full tier under the body ink the
 * rows above use), everything qualifying them in `subtle`, and the catalog sentence
 * in `subtle` too, which is the dimmest tier there is, because it is the only part a
 * reader can skip without losing a fact. The footer keycaps below stay bright: they
 * are affordances, not prose.
 *
 * CAPABILITIES ARE EXCEPTION-ONLY AND THEY LIVE HERE, NOT ON EVERY ROW. The
 * previous build printed `[TRV]` on all 21 rows of a dynamic models catalog where every model had
 * all three — a column with no variance, in the place a reader is scanning names.
 * On the selected row they are worth three words; on forty rows they are noise.
 */

import type { ReactNode } from "react";
import type { ModelInfo } from "../model-selector.js";
import { truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import { wrapWords } from "./DiscoveryNotice.js";
import type { BillingMode } from "./PickerDataSource.js";
import { DESCRIPTION_ROWS } from "./layout.js";

/**
 * `tools reasoning vision`, and ONLY the ones the catalog affirmatively says are
 * there.
 *
 * `undefined` is not `false`. The slim catalog carries `supportsTools` for most
 * models and `supportsReasoning` for some, and a missing flag means "the catalog
 * does not say" — printing its absence would be claiming a fact nobody has.
 */
export function capabilityWords(model: ModelInfo): string[] {
  const words: string[] = [];
  if (model.supportsTools === true) words.push("tools");
  if (model.supportsReasoning === true) words.push("reasoning");
  if (model.supportsVision === true) words.push("vision");
  return words;
}

/**
 * The detail line's text, as one pure function so the sentence can be asserted
 * without a renderer.
 *
 * The one exception that is LOUD rather than quiet: a model the catalog says
 * takes no tools cannot drive Claude Code at all, which is disqualifying rather
 * than comparative. It is stated in words on the row the cursor is on, in the
 * error colour, instead of being one dim letter in a column of forty.
 */
export function detailText(spec: string, model: ModelInfo): { text: string; warn: string } {
  const parts = [spec];
  const caps = capabilityWords(model);
  if (caps.length > 0) parts.push(caps.join(" "));
  if (model.releaseDate) parts.push(model.releaseDate.slice(0, 7));
  return {
    text: parts.join(" · "),
    warn: model.supportsTools === false ? "no tool support — Claude Code cannot run it" : "",
  };
}

/** What a provider IS, in one row: how it bills and what it authenticates with. */
export interface ProviderFacts {
  label: string;
  shortcut: string;
  billing: BillingMode;
  /** The env var it reads. Empty for a provider that signs in instead. */
  envVar: string;
}

/**
 * The words for a provider, as one pure function.
 *
 * BILLING LEADS, because it is the fact that changes a decision: a flat-rate plan
 * costs nothing at the point of use, which is why `SUB` rows are worth finding and
 * why the row above prints `SUB` rather than a per-token number it does not have.
 * The credential comes second, named exactly — "check your API key" gives no clue
 * which of thirty variables to inspect, and a key shadowed by a stale value in the
 * shell is the single most common cause of a rejected provider in this repo's
 * issue history.
 */
export function providerFactsText(facts: ProviderFacts): {
  billing: string;
  /** The same claim in the fewest words, for a row that cannot afford the sentence. */
  billingShort: string;
  auth: string;
} {
  const billing =
    facts.billing === "sub"
      ? "flat-rate subscription — no per-token charge"
      : facts.billing === "local"
        ? "self-hosted — no per-token charge"
        : "metered — billed per token";
  const billingShort =
    facts.billing === "sub" ? "flat-rate plan" : facts.billing === "local" ? "local" : "metered";
  const auth = facts.envVar === "" ? "signs in — no API key variable" : facts.envVar;
  return { billing, billingShort, auth };
}

export function SelectionLine({
  model,
  spec,
  width,
}: {
  model: ModelInfo | null;
  spec: string | null;
  width: number;
}): ReactNode {
  const inner = Math.max(8, Math.floor(width));
  if (model === null || spec === null) {
    return (
      <box height={1} flexShrink={0}>
        <text>
          <span fg={tokens.trace}>nothing selected</span>
        </text>
      </box>
    );
  }
  const { text, warn } = detailText(spec, model);
  const room = warn === "" ? inner : Math.max(8, inner - warn.length - 3);
  return (
    <box height={1} flexShrink={0}>
      <text>
        {/* `debug`, NOT bold accent. This line is a restatement of the row the
            cursor is already on; it earns its place by being EXACT, not by being
            loud, and the accent hue belongs to focus and titles. */}
        <span fg={tokens.debug}>{truncate(text, room)}</span>
        {warn === "" ? null : (
          <>
            <span fg={tokens.subtle}>{" · "}</span>
            <span fg={tokens.error}>{warn}</span>
          </>
        )}
      </text>
    </box>
  );
}

/**
 * One row: which provider this is, how it bills, what key it wants.
 *
 * ALWAYS ONE ROW, blank when nothing is selected, because the list above is
 * content-sized and a detail pane that collapsed would move every row on the
 * screen each time the cursor left the last item.
 */
export function ProviderLine({
  facts,
  width,
  /** Models this provider serves. `null` in the model list, a number in the `p` dialog. */
  count = null,
}: {
  facts: ProviderFacts | null;
  width: number;
  count?: number | null;
}): ReactNode {
  const inner = Math.max(8, Math.floor(width));
  if (facts === null) {
    return (
      <box height={1} flexShrink={0}>
        <text>
          <span fg={tokens.trace}> </span>
        </text>
      </box>
    );
  }
  const { billing, billingShort, auth } = providerFactsText(facts);
  // `flat-rate subscription — no per-token charge` WAS PAINTED IN THE FAILURE HUE.
  // It is the most positive fact on the screen — the user pays nothing to run this
  // route — and `tokens.warn` is `C.orange`, a rust red on the light palette. Same
  // inversion as the `SUB` chip, same fix: the positive tier. Red is for failure.
  const billingFg =
    facts.billing === "sub"
      ? tokens.success
      : facts.billing === "local"
        ? tokens.trace
        : tokens.subtle;
  const tail = count === null ? "" : ` · ${count} model${count === 1 ? "" : "s"}`;
  // THE VARIABLE NAME IS NEVER THE FIELD THAT GIVES WAY, and the BILLING CLAUSE
  // is. A truncated env var (`OPENCODE_GO…`) sends the reader hunting for a
  // variable that does not exist — this dialog shipped that defect once already —
  // and a dangling ` · ` with nothing after it is the same lie with worse manners.
  // MEASURED at 80 columns: the long sentence plus `OPENCODE_GO_API_KEY` is 71 of
  // 72 usable cells, so the short form is not a fallback for freak widths, it is
  // what 80 columns gets. Both forms make the same claim.
  const name = truncate(facts.label, Math.max(4, inner - 12));
  const fixed = name.length + facts.shortcut.length + 1 + 3 + 3 + auth.length + tail.length;
  const clause = fixed + billing.length <= inner ? billing : billingShort;
  const room = Math.max(0, inner - (fixed - auth.length) - clause.length);
  const shown = truncate(auth, room);
  return (
    <box height={1} flexShrink={0}>
      <text>
        <span fg={tokens.debug}>{name}</span>
        <span fg={tokens.trace}>{` ${facts.shortcut}`}</span>
        <span fg={tokens.subtle}>{" · "}</span>
        <span fg={billingFg}>{clause}</span>
        {shown === "" ? null : (
          <>
            <span fg={tokens.subtle}>{" · "}</span>
            <span fg={tokens.subtle}>{shown}</span>
          </>
        )}
        {tail === "" ? null : <span fg={tokens.trace}>{tail}</span>}
      </text>
    </box>
  );
}

/**
 * The catalog's prose sentence for the selected model, wrapped and capped.
 *
 * FIXED HEIGHT, ALWAYS RENDERED. The sentence arrives on its own clock — the slim
 * catalog carries none, so it comes from a bulk fetch that resolves seconds after
 * the list is already usable — and a block that grew from zero rows to two when it
 * landed would shove the footer down under the reader's cursor.
 *
 * TRUNCATED WITH AN ELLIPSIS AT THE CAP rather than scrolled: a description is
 * orientation, not documentation, and the models that carry a 1 183-character one
 * are describing an API, not answering "is this the model I want".
 */
export function descriptionLines(text: string, width: number, rows = DESCRIPTION_ROWS): string[] {
  const inner = Math.max(8, Math.floor(width));
  const cap = Math.max(1, Math.floor(rows));
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") return [];
  const wrapped = wrapWords(clean, inner);
  if (wrapped.length <= cap) return wrapped;
  const kept = wrapped.slice(0, cap);
  const last = kept[cap - 1] ?? "";
  // `truncate` puts the ellipsis in the last column, so shave a column first —
  // otherwise the row is one cell over budget and Yoga claws it back somewhere.
  kept[cap - 1] = truncate(`${last} ${wrapped.slice(cap).join(" ")}`, inner);
  return kept;
}

export function DescriptionBlock({
  text,
  width,
  rows = DESCRIPTION_ROWS,
}: {
  /** Empty while the index is still loading, or when the catalog has no sentence. */
  text: string;
  width: number;
  rows?: number;
}): ReactNode {
  const lines = descriptionLines(text, width, rows);
  const cap = Math.max(1, Math.floor(rows));
  return (
    <box flexDirection="column" height={cap} flexShrink={0} overflow="hidden">
      {Array.from({ length: cap }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a wrapped row is position-addressed — its index IS its identity
        <box key={i} height={1} flexShrink={0}>
          <text>
            <span fg={tokens.subtle}>{lines[i] ?? " "}</span>
          </text>
        </box>
      ))}
    </box>
  );
}
