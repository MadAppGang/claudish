/** @jsxImportSource @opentui/react */
/**
 * picker/DiscoveryNotice.tsx — the four non-`rows` outcomes, rendered.
 *
 * THE WORDS ARE NOT THE DEFECT. Measured against a real 401, the old stderr warning
 * survived on screen in full — provider, cause, HTTP status, endpoint, upstream body,
 * the env var to inspect, where to get a key — and the user still read the short
 * fallback list below it as "this provider has no models". What was wrong was its
 * PRESENTATION: plain white body text for the most severe thing on screen, inline
 * rather than pinned, and a JSON body wrapped mid-word. So this file changes no
 * wording it can avoid changing; it supplies severity, a border, a row budget and a
 * truncation point.
 *
 * THREE TIERS, NEVER COLLAPSED TO ok/fail, copied from `TestResult`
 * (`tui/types.ts:79-107`) whose own comment says `unavailable` is "deliberately
 * neutral, not red":
 *
 *   · `failed`                                   → ERROR  (red on `C.bgError`)
 *   · `empty-models-catalog` / `all-filtered` / `collapsed-empty` → NOTICE (`tokens.warn`)
 *   · `rows` / `unsupported`                     → nothing at all
 *
 * `unsupported` rendering nothing is the load-bearing half of that last row: ~25
 * pickable providers declare no `modelDiscovery`, and for them the catalog list IS
 * the normal, correct UI. A panel there would be noise on the majority case, which
 * is how a user learns to ignore the panel.
 */

import type { ReactNode } from "react";
import type { PickerDiscoveryOutcome } from "../model-selector.js";
import { type BannerSeverity, ErrorBanner } from "../tui/components/ErrorBanner.js";
import { displayWidth } from "../tui/viz/text.js";

/** What a notice is, before it is a component — pure, so it can be asserted. */
export interface NoticeContent {
  severity: BannerSeverity;
  /** One row each, in priority order. Never re-ordered by the renderer. */
  lines: string[];
  /** A chip at the head of row one, e.g. `HTTP 401`. */
  badge?: string;
  /**
   * The dialog's right-hand status — `live model list unavailable`, `empty model list`.
   *
   * It is the FIRST of the three encodings of one fact, and it is the loudest,
   * because a title in a border is read before anything inside it. The others are
   * the per-row `catalog` mark and the provenance sentence. All three derive from
   * this same `NoticeContent`, so they cannot disagree.
   */
  title: string;
}

/**
 * Collapse the stderr formatter's embedded newlines and indentation to one row, and drop
 * its leading `⚠`.
 *
 * The glyph is the STDERR path's severity marker, and it is the only one that path has.
 * Here the severity is carried by the banner's colour, its left rule and its title, so
 * the glyph would be a fourth encoding of a fact already stated three times — and it
 * costs two columns of a headline measured at exactly the frame width (MEASURED: an
 * 80-column banner line that fits without it wrapped with it, spending a row out of a
 * four-row budget). The stderr wording keeps it, unchanged, which is the whole point of
 * the formatter and the sink being separate.
 *
 * `.trim()` runs BEFORE the strip: the formatter's first line starts with a newline,
 * which the whitespace collapse turns into a leading SPACE, and `^⚠` then matches
 * nothing at all. Measured — the glyph survived the first version of this line.
 */
function oneRow(line: string): string {
  return line.replace(/\s+/g, " ").trim().replace(/^⚠\s*/, "");
}

/**
 * The provenance sentence — the line that says the list below is NOT the
 * provider's dynamic models catalog, AND that being in the list does not mean it
 * will run.
 *
 * IT IS TWO CLAIMS, AND THE SECOND ONE IS THE ONE THAT WAS MISSING. The stderr
 * wording says where the rows came from ("cloud-catalog entries … not its live
 * model list"), which is a statement about provenance. What it never said is the
 * CONSEQUENCE: discovery failed because the credential was rejected, so nothing
 * has confirmed that this account can call any of these models. A reader who is
 * told only "these are catalog entries" reasonably concludes the list is merely
 * differently-sourced, picks one, and finds out at launch. So the sentence names
 * the count, the provenance and the risk in that order.
 *
 * This is the third of the three encodings of the same fact — the dialog title
 * (`live model list unavailable`), the per-row `catalog` mark, and this — and all
 * three derive from ONE value, the outcome variant, so they cannot disagree.
 */
function provenance(displayName: string, rows: number): string {
  const n = rows === 1 ? "row" : "rows";
  return (
    `The ${rows} ${n} below are catalog entries, not ${displayName}'s live model list — ` +
    "they do not confirm access, so launching one may still fail."
  );
}

/**
 * Outcome → banner content, or `null` when the outcome has nothing to say.
 *
 * NO STRING HERE INTERPOLATES AN OPTIONAL FIELD WITHOUT A GUARD. `endpoint` and
 * `status` are both optional on `DiscoveryFailure` — a registered fetcher may report
 * `unauthorized` with neither — and a rendered `undefined` is worse than a shorter
 * sentence. A test sweeps every variant × present/absent for both.
 */
export function discoveryNoticeContent(
  outcome: PickerDiscoveryOutcome,
  displayName: string,
  /**
   * The account's stored list is what the rows below show, because the live
   * answer could not be had. Its closing sentence then describes those rows,
   * not a catalog fallback.
   */
  stored?: StoredRows
): NoticeContent | null {
  switch (outcome.kind) {
    case "rows":
    case "unsupported":
      // Nothing to say, and saying nothing is the decision — see the file header.
      return null;
    case "failed":
      return failedContent(outcome, displayName, stored);
    case "empty-models-catalog":
      return emptyModelsCatalogContent(outcome, displayName, stored);
    case "all-filtered":
      return allFilteredContent(outcome, displayName);
    case "collapsed-empty":
      return collapsedContent(outcome, displayName);
  }
}

/** The rows a stored dynamic models catalog put on screen, and how old they are. */
export interface StoredRows {
  rows: number;
  /** `as of 3 h ago`, or `null` for a list recent enough to need no age. */
  caption: string | null;
}

/** What to say when nothing supplied a fallback list either. */
function nextStep(rows: number, displayName: string, stored?: StoredRows): string {
  if (stored !== undefined && stored.rows > 0) {
    const n = stored.rows === 1 ? "row" : "rows";
    const when = stored.caption === null ? "" : ` (${stored.caption})`;
    return `The ${stored.rows} ${n} below are ${displayName}'s last model list for this account${when}.`;
  }
  return rows > 0 ? provenance(displayName, rows) : "Press c to type a model id directly.";
}

type Failed = Extract<PickerDiscoveryOutcome, { kind: "failed" }>;
type EmptyModelsCatalog = Extract<PickerDiscoveryOutcome, { kind: "empty-models-catalog" }>;
type AllFiltered = Extract<PickerDiscoveryOutcome, { kind: "all-filtered" }>;
type Collapsed = Extract<PickerDiscoveryOutcome, { kind: "collapsed-empty" }>;

/**
 * THE WORDS ARE THE FORMATTER'S, NOT THIS FILE'S. `notice` arrives from
 * `formatDiscoveryFailureNotice` — the same array the stderr path writes — so the panel
 * and the scrollback line cannot drift apart. All that happens here is one row per
 * line, and the HTTP status moved into a chip.
 */
function failedContent(
  { failure, notice, fallbackRows }: Failed,
  name: string,
  stored?: StoredRows
): NoticeContent {
  const badge = failure.status === undefined ? undefined : `HTTP ${failure.status}`;
  const lines: string[] = [];
  for (const raw of notice) {
    const line = oneRow(raw);
    if (line === "") continue;
    // The formatter's own closing line is REPLACED, not appended to. It says where
    // the rows came from and stops there; the panel's version says what that means
    // for the user's next keystroke (`provenance`, above). Two sentences making
    // overlapping claims about the same list is exactly the reconciliation this
    // file exists to avoid, so the shorter one gives way here — and the stderr path
    // keeps it verbatim, which is the whole reason the formatter and the sink are
    // separate.
    if (/^Showing .* not its live model list\.$/.test(line)) continue;
    if (line === "Falling back to manual model entry.") continue;
    // De-duplicate the status: it is the badge now, and spending nine columns of a
    // 78-column headline saying it twice costs the end of the sentence.
    lines.push(badge === undefined ? line : line.replace(` (${badge})`, ""));
  }
  lines.push(nextStep(fallbackRows.length, name, stored));
  return {
    severity: "error",
    lines,
    ...(badge === undefined ? {} : { badge }),
    // The dialog RIGHT-hand status. "unavailable" rather than "failed": the
    // provider is not broken, claudish could not read its dynamic models catalog, and the two read
    // very differently to someone deciding whether to trust the rows below.
    title: "live model list unavailable",
  };
}

/**
 * NOTICE, NOT ERROR, and the distinction is the point: an endpoint that answers
 * correctly with nothing has not failed. Painting it red would teach the user to
 * ignore red. It stays visibly distinct from a rejected key in BOTH tier and copy,
 * which is what V7 asks for.
 */
function emptyModelsCatalogContent(
  { failure, fallbackRows }: EmptyModelsCatalog,
  name: string,
  stored?: StoredRows
): NoticeContent {
  const at = failure.endpoint ? ` — the endpoint answered at ${failure.endpoint}` : "";
  return {
    severity: "notice",
    lines: [
      `${name}'s model list is empty${at} and listed nothing.`,
      nextStep(fallbackRows.length, name, stored),
    ],
    title: "empty model list",
  };
}

/**
 * The sample ids are what make this self-explaining: they are almost always
 * embeddings, speech models or wildcard routes, which a reader recognises at a glance
 * — and without them "none of them chat-capable" sounds like claudish's fault.
 */
function allFilteredContent(
  { servedCount, sampleIds, fallbackRows }: AllFiltered,
  name: string
): NoticeContent {
  const lines = [
    `${name} served ${servedCount} model${servedCount === 1 ? "" : "s"}, none of them chat-capable.`,
  ];
  if (sampleIds.length > 0) lines.push(`e.g. ${sampleIds.join(", ")}`);
  lines.push(nextStep(fallbackRows.length, name));
  return { severity: "notice", lines, title: "nothing chat-capable" };
}

/** Defensive: unreachable through the one shipped resolver, and still rendered. */
function collapsedContent({ chatCount, fallbackRows }: Collapsed, name: string): NoticeContent {
  const lines = [
    `${chatCount} chat-capable model${chatCount === 1 ? "" : "s"} collapsed to zero choices — please report this.`,
  ];
  if (fallbackRows.length > 0) lines.push(provenance(name, fallbackRows.length));
  return { severity: "notice", lines, title: "no choices" };
}

/**
 * Merge the two credential rows onto one when the width allows.
 *
 * `Check MOONSHOT_API_KEY (…)` and `Get a key: https://…` are one thought and, at
 * the measured 80-column case, 65 columns together — so merging buys a row back for
 * the list at no cost to the words. A long env var plus a long URL does not fit, and
 * then they stay two rows and the banner spends its fourth.
 */
export function mergeCredentialLines(lines: string[], width: number): string[] {
  const i = lines.findIndex((l) => l.startsWith("Check "));
  if (i < 0 || i + 1 >= lines.length) return lines;
  const next = lines[i + 1]!;
  if (!next.startsWith("Get a key:")) return lines;
  // The parenthetical ("a value in your shell overrides stored credentials") is the
  // part that does not fit, and it is advice rather than a fact the user must have —
  // the VARIABLE NAME is the fact, and it survives.
  // `\.?` because the formatter's line ends `(…).` — without it the parenthetical
  // survives, the merge overflows the width test, and the two rows never merge at all.
  const bare = lines[i]!.replace(/\s*\(.*\)\.?\s*$/, "");
  const merged = `${bare} · ${next}`;
  if (merged.length > width) return lines;
  return [...lines.slice(0, i), merged, ...lines.slice(i + 2)];
}

/**
 * Greedy word wrap, measured in CELLS.
 *
 * `ErrorBanner` deliberately does not wrap — it truncates, so a JSON body cannot
 * spill three rows mid-token — and that is right for a headline whose tail is an
 * upstream payload. It is wrong for the provenance sentence, whose tail ("so
 * launching one may still fail") is the single most useful clause in the state and
 * the one a truncation would take first. So the caller wraps, and the banner still
 * truncates whatever a wrap could not fix.
 *
 * Built on `displayWidth` rather than `String.length`: a CJK model id counts double
 * in cells and half in code units, which is the same reason `padEnd`/`slice` are
 * banned in `viz/text.ts`.
 */
export function wrapWords(text: string, width: number): string[] {
  const w = Math.max(8, Math.floor(width));
  if (displayWidth(text) <= w) return [text];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line === "" ? word : `${line} ${word}`;
    if (displayWidth(next) <= w) {
      line = next;
      continue;
    }
    if (line !== "") out.push(line);
    line = word;
  }
  if (line !== "") out.push(line);
  return out;
}

/**
 * The rows a notice will actually paint — merged, wrapped and capped.
 *
 * PURE, AND EXPORTED, because the dialog has to know the COUNT before it lays out:
 * the banner and the list share one inline row budget, and the rows that give way
 * are the list's. A component that only knew its own height would have to be
 * measured after the fact, which inline mode does not forgive.
 *
 * Lines past `maxRows` are dropped from the END, which is the priority order the
 * caller built them in: cause, then recovery, then provenance. Nothing is lost —
 * the full text goes to the deferred stderr write after teardown and to the debug
 * log.
 */
export function noticeRows(
  content: NoticeContent,
  width: number,
  maxRows: number
): { severity: BannerSeverity; badge?: string; lines: string[] } {
  const merged = mergeCredentialLines(content.lines, width);
  const wrapped: string[] = [];
  for (const [i, line] of merged.entries()) {
    // Row one carries the badge, so it wraps against a shorter width. It is also
    // the one line allowed to be truncated rather than wrapped: its tail is the
    // upstream error body, which reads no better across two rows than across one.
    if (i === 0) wrapped.push(line);
    else wrapped.push(...wrapWords(line, width));
  }
  return {
    severity: content.severity,
    ...(content.badge === undefined ? {} : { badge: content.badge }),
    lines: wrapped.slice(0, Math.max(1, Math.floor(maxRows))),
  };
}

export interface DiscoveryNoticeProps {
  outcome: PickerDiscoveryOutcome;
  displayName: string;
  /** Usable columns, for truncation, wrapping and the merge decision. */
  width: number;
  /** Hard cap on content rows — the banner's half of the dialog's row budget. */
  maxRows: number;
  /** The stored list the rows below show instead of the live answer. */
  stored?: StoredRows;
}

/**
 * The banner, inside the dialog, as a 1-column left rule in the severity colour.
 *
 * BORDERLESS, UNCONDITIONALLY. The previous build gated a full border on terminal
 * height, which was one more responsive branch to reason about and to photograph.
 * Inside a dialog that already has a border, a second one is chrome around chrome:
 * the rule costs one COLUMN and zero ROWS, and rows are the scarce axis when the
 * whole thing is inline in someone's scrollback.
 */
export function DiscoveryNotice({
  outcome,
  displayName,
  width,
  maxRows,
  stored,
}: DiscoveryNoticeProps): ReactNode {
  const content = discoveryNoticeContent(outcome, displayName, stored);
  if (content === null) return null;
  const rows = noticeRows(content, width, maxRows);
  return (
    <ErrorBanner
      severity={rows.severity}
      lines={rows.lines}
      width={width}
      {...(rows.badge === undefined ? {} : { badge: rows.badge })}
    />
  );
}
