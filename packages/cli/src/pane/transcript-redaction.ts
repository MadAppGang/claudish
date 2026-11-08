/**
 * Redaction and splitting of one rendered transcript line (`transcript_session`, MTL-373;
 * architecture § 4 `text`). ONE pipeline for every text that becomes a line, a tool
 * call's argument included:
 *
 *   1. t0 is the sanitised FULL text (for a tool line: its whole salient argument, before
 *      whitespace is collapsed or the 160-character cut).
 *   2. Signing-value ranges are found on t0, the original: a pattern replacement that ran
 *      first could break a registered value apart, and its tail would never match.
 *   3. Pattern redaction runs on t0 while carrying those ranges (`redactPatternsMapped`).
 *      Every code unit of t0 inside a signing range that survives into the output becomes
 *      `*`, one for one, EXCEPT whitespace, which is kept. Code units a pattern replaced
 *      are already masked (`***REDACTED***`).
 *   4. Only then is the text cut: a tool argument is collapsed and cut to 160, and every
 *      text is split into chunks of at most 8,000 code units and 16,000 JSON bytes.
 *   5. A lone surrogate never survives: a range that ends inside a pair masks both halves,
 *      and each emitted chunk passes a length-preserving U+FFFD replacement last.
 *
 * WHY the cuts cannot move with the leases. The cursor `v1.<offset>.<k>.<id8>` names the
 * k-th line of an entry, so the number of lines and where each chunk ends must not depend
 * on which signing leases are live (a lease starts and ends with every request). Every cut
 * is therefore computed on the pattern-redacted text BEFORE the signing mask (a pure
 * function of t0), and applied to the masked text unchanged. That is sound because the mask
 * is length-preserving and keeps every whitespace code unit where it was: the separators
 * the splitter and the collapse look for (`\n`, space, tab, `\s`) sit at the same positions
 * in both, and a masked chunk is never longer than its unmasked one, in code units or in
 * JSON bytes (`*` costs 1 byte, the least any code unit costs). So a masked line can never
 * exceed the 8,000-character or the 16,000-byte bound.
 */

import { type TextSegment, redactPatternsMapped, signingValueRanges } from "../redact.js";
import {
  TRANSCRIPT_LINE_MAX_CHARS,
  TRANSCRIPT_LINE_MAX_JSON_BYTES,
  type TranscriptKind,
  type TranscriptLine,
} from "./contract.js";
import { parseRecord } from "./transcript-follower.js";
import {
  type RenderedLine,
  TOOL_ARG_MAX_CHARS,
  collapseWhitespace,
  ellipsisCut,
  nextCut,
  renderEntry,
} from "./transcript-lines.js";

/** The signing-value ranges of a text, `[start, end)`, sorted and merged (`signingValueRanges`). */
export type SigningRangeFinder = (text: string) => ReadonlyArray<readonly [number, number]>;

/** What masks one signing-value code unit. One code unit, one JSON byte. */
const SIGNING_UNIT_MASK = "*";

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A pattern-redacted text and the intervals of it that a signing value covers.
 * `plain` is lease-independent; `masked` are `[start, end)` positions IN `plain`, sorted,
 * disjoint, never splitting a surrogate pair.
 */
export interface RedactedText {
  plain: string;
  masked: Array<[number, number]>;
}

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** The first range index whose end is past `pos` (ranges sorted and disjoint). */
function firstRangeEndingAfter(ranges: ReadonlyArray<readonly [number, number]>, pos: number) {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ranges[mid] as readonly [number, number])[1] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Steps 1–3: pattern-redact `t0` and carry the signing ranges found on `t0` into it.
 * `find` defaults to the live registry; a test passes its own.
 */
export function redactCarrying(
  t0: string,
  find: SigningRangeFinder = signingValueRanges
): RedactedText {
  const ranges = find(t0);
  const { text: plain, segments } = redactPatternsMapped(t0);
  if (ranges.length === 0) return { plain, masked: [] };
  const masked: Array<[number, number]> = [];
  const add = (from: number, to: number): void => {
    // a range that ends or starts inside a surrogate pair masks the whole pair
    const splitsStart =
      from > 0 && isLow(plain.charCodeAt(from)) && isHigh(plain.charCodeAt(from - 1));
    const splitsEnd =
      to < plain.length && isLow(plain.charCodeAt(to)) && isHigh(plain.charCodeAt(to - 1));
    const s = splitsStart ? from - 1 : from;
    const e = splitsEnd ? to + 1 : to;
    const last = masked[masked.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else masked.push([s, e]);
  };
  let p = 0;
  for (const seg of segments as TextSegment[]) {
    if (seg.origin >= 0) {
      const o = seg.origin;
      const oEnd = o + seg.length;
      for (let i = firstRangeEndingAfter(ranges, o); i < ranges.length; i++) {
        const [s, e] = ranges[i] as readonly [number, number];
        if (s >= oEnd) break;
        add(p + Math.max(s, o) - o, p + Math.min(e, oEnd) - o);
      }
    }
    p += seg.length;
  }
  return { plain, masked };
}

/**
 * `r.plain.slice(a, b)` with every non-whitespace code unit inside a masked interval
 * replaced by `*` — the same length — and any lone surrogate then as U+FFFD (also one
 * code unit). Never longer, in code units or JSON bytes, than the unmasked slice.
 */
export function maskedSlice(r: RedactedText, a: number, b: number): string {
  let out = "";
  if (r.masked.length > 0) {
    let at = a;
    for (let i = firstRangeEndingAfter(r.masked, a); i < r.masked.length; i++) {
      const [s, e] = r.masked[i] as [number, number];
      if (s >= b) break;
      const from = Math.max(s, a);
      const to = Math.min(e, b);
      out += r.plain.slice(at, from) + r.plain.slice(from, to).replace(/\S/g, SIGNING_UNIT_MASK);
      at = to;
    }
    out += r.plain.slice(at, b);
  } else out = r.plain.slice(a, b);
  return out.replace(LONE_SURROGATE_RE, "�");
}

/** One final line, built only when asked (a page skips to its chunk k without building). */
export interface PendingLine {
  kind: TranscriptKind;
  cont: boolean;
  build(): TranscriptLine;
}

/**
 * A tool line's text, `Name(arg)`, as a lease-independent plain string plus its masked
 * twin (equal length). The argument is redacted WHOLE (steps 1–3), then collapsed and cut
 * to TOOL_ARG_MAX_CHARS ending `…` (step 4); the cut is computed on the plain argument and
 * applied to the masked one, so it is where it would be with no lease live.
 */
function toolText(r: RenderedLine, find: SigningRangeFinder): { plain: string; masked: string } {
  const name = redactCarrying(r.text, find);
  const nameMasked = maskedSlice(name, 0, name.plain.length);
  if (!r.arg) return { plain: `${name.plain}()`, masked: `${nameMasked}()` };
  const arg = redactCarrying(r.arg, find);
  // collapse each independently: whitespace sits at the same positions in both
  const plain = collapseWhitespace(arg.plain);
  const masked = collapseWhitespace(maskedSlice(arg, 0, arg.plain.length));
  const end = ellipsisCut(plain, TOOL_ARG_MAX_CHARS);
  const cut = end < plain.length;
  const tail = cut ? "…" : "";
  return {
    plain: `${name.plain}(${plain.slice(0, end)}${tail})`,
    masked: `${nameMasked}(${masked.slice(0, end)}${tail})`,
  };
}

/**
 * The final lines of one rendered line, lazily: steps 1–5. The cuts come from the plain
 * text; the masked text is sliced at the same positions when a line is built.
 */
function* finishLine(r: RenderedLine, find: SigningRangeFinder): Generator<PendingLine> {
  let plain: string;
  let slice: (a: number, b: number) => string;
  if (r.kind === "tool") {
    const t = toolText(r, find);
    plain = t.plain;
    slice = (a, b) => t.masked.slice(a, b);
  } else {
    const red = redactCarrying(r.text, find);
    plain = red.plain;
    slice = (a, b) => maskedSlice(red, a, b);
  }
  let first = true;
  for (let pos = 0; pos < plain.length; ) {
    const a = pos;
    const b = nextCut(plain, pos, TRANSCRIPT_LINE_MAX_CHARS, TRANSCRIPT_LINE_MAX_JSON_BYTES);
    pos = b;
    const cont = !first;
    first = false;
    yield {
      kind: r.kind,
      cont,
      build: () =>
        cont
          ? { kind: r.kind, text: slice(a, b), cont: true }
          : { kind: r.kind, text: slice(a, b) },
    };
  }
}

/**
 * The final lines of one complete JSONL line, in order, lazily: rendered, redacted and
 * split (steps 1–5). Deterministic in count and cut positions whatever leases are live.
 * A consumer that stops early does no work for the lines after it, and a skipped line is
 * never masked or sliced (`PendingLine.build`).
 */
export function* entryLines(
  raw: string,
  find: SigningRangeFinder = signingValueRanges
): Generator<PendingLine> {
  const rec = parseRecord(raw);
  if (!rec || Array.isArray(rec)) return;
  for (const r of renderEntry(rec)) yield* finishLine(r, find);
}

/** Every final line of one complete JSONL line (`entryLines`, built). */
export function linesOfEntry(
  raw: string,
  find: SigningRangeFinder = signingValueRanges
): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const l of entryLines(raw, find)) out.push(l.build());
  return out;
}
