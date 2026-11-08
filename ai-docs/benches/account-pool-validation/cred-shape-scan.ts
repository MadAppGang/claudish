/**
 * Two scanning primitives every leak scan of the bench shares.
 *
 * 1. `fileWindows`: a file is read in fixed-size windows with an overlap, so a file of
 *    any size is scanned whole. No file is ever skipped for its size (review finding:
 *    the leak scan silently skipped files over 5 MB).
 * 2. `scanCredentialShapes`: a REAL credential that enters a run from outside (run 14
 *    recorded a real 1821-char JWT bearer in `fake.jsonl`) is invisible to a scan that
 *    searches only for the values the bench itself created. This scan looks for the
 *    SHAPE of a real credential in every evidence and output file, the request logs and
 *    bodies included, and reports any match that is not one of the bench's own values.
 *
 * Shapes (review round 6 widened the net): a JWT (three segments, >= 100 chars); a JWT
 * PREFIX cut by a truncation (`eyJ…{15,}.…{20,}`, >= 60 chars: a `.slice(0, 200)` of a real
 * 1821-char bearer keeps one dot); an `sk-` key (>= 20 chars); an `rt_` refresh token
 * (>= 20 chars); and the value of a JSON or form field named refresh_token, refreshToken,
 * access_token, accessToken or presented that is not one of the bench's own values.
 *
 * Encodings: each window is also read through bounded decoders, so an encoded credential
 * is found too: JSON string escapes (`.` for a dot, `\/`, `\"`), UTF-16LE text, and
 * base64 runs of at least 80 characters (decoded whole, in overlapping blocks of
 * `BASE64_MAX_RUN` characters).
 * NOT covered (documented gaps): a value split across separate strings, compression,
 * encryption, other text encodings, and encodings nested more than one level deep.
 *
 * A finding never carries the value: it names the file, the byte offset, the length and
 * a sha256 prefix, so the report itself cannot leak what it found.
 *
 * Text is decoded as latin1: one byte is one character, so an offset in the text is the
 * byte offset in the file, and a window boundary never splits a character.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Bytes read per window. */
export const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
/**
 * Bytes each window reads past its owned range. A match of at most this length is whole
 * in the window that owns its first byte (a real JWT bearer measured 1821 chars).
 */
export const SCAN_OVERLAP_BYTES = 64 * 1024;

export interface FileWindow {
  /** latin1 text of the window: `text[i]` is byte `base + i` of the file. */
  text: string;
  base: number;
  /** A match starting at `ownedFrom <= i < ownedTo` belongs to this window (no duplicates). */
  ownedFrom: number;
  ownedTo: number;
}

/**
 * Every window of `path`. Window k owns bytes [k*chunk, (k+1)*chunk), reads `overlap` bytes
 * past that range and ONE byte before it (so a look-behind sees the preceding byte).
 */
export function* fileWindows(
  path: string,
  chunkBytes = SCAN_CHUNK_BYTES,
  overlapBytes = SCAN_OVERLAP_BYTES
): Generator<FileWindow> {
  if (chunkBytes < 1) throw new Error(`fileWindows: chunkBytes must be >= 1, got ${chunkBytes}`);
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    for (let start = 0; start < size || (start === 0 && size === 0); start += chunkBytes) {
      const before = start > 0 ? 1 : 0;
      const from = start - before;
      const length = Math.min(size - from, before + chunkBytes + overlapBytes);
      const buf = Buffer.alloc(Math.max(0, length));
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buf, read, length - read, from + read);
        if (n === 0) break;
        read += n;
      }
      yield {
        text: buf.subarray(0, read).toString("latin1"),
        base: from,
        ownedFrom: before,
        ownedTo: before + chunkBytes,
      };
      if (size === 0) return;
    }
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Shapes

/**
 * One `eyJ` token with one or two dots; classified as a JWT or a truncated JWT prefix. A
 * preceding dot excludes it: a JWT's PAYLOAD also starts with `eyJ`, and a window that begins
 * inside a token would otherwise report its `payload.signature` tail a second time.
 */
const JWT_CANDIDATE = /(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?/g;
export const JWT_MIN_LENGTH = 100;
/** A truncated JWT: `eyJ` + >= 15, a dot, >= 20, and >= 60 characters in total. */
export const JWT_PREFIX_MIN_LENGTH = 60;
/** An `sk-` key of at least 20 characters in total. */
const SK_SHAPE = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{17,}/g;
/** An OpenAI-style `rt_` refresh token of at least 20 characters in total. */
const RT_SHAPE = /(?<![A-Za-z0-9_-])rt_[A-Za-z0-9_.-]{17,}/g;
/** A credential-named JSON field with a string value (the value is group 2). */
const JSON_FIELD =
  /"(refresh_token|refreshToken|access_token|accessToken|presented)"\s*:\s*"((?:[^"\\\n]|\\.){1,8192})"/g;
/** The same names in a form body or query string (the value is group 2). */
const FORM_FIELD = /(?<![A-Za-z0-9_])(refresh_token|access_token)=([^&\s"'<>]{1,8192})/g;
/** A field value shorter than this is a placeholder, not a credential. */
const FIELD_MIN_LENGTH = 8;

/** Values the bench creates by construction (seed, fake upstream, E20 fake, canary). */
export const BENCH_FAKE_VALUE =
  /^(?:(?:access|refresh)-(?:[A-Z]\d*|legacy)|(?:at|rt)-rotated-\d+|sk-canary-must-never-be-used)$/;

export type ShapeKind = "jwt" | "jwt-prefix" | "sk-key" | "rt-token" | "credential-field";

/** How the bytes held the value: as written, or through one of the bounded decoders. */
export type ShapeEncoding = "json-escaped" | "utf16le" | "base64";

export interface ShapeFinding {
  /** Path relative to the scanned root. */
  file: string;
  /** Byte offset of the first character in the file (for base64: of the first encoded group carrying it). */
  offset: number;
  kind: ShapeKind;
  /** Absent: the value was in the bytes as written. */
  encoding?: ShapeEncoding;
  length: number;
  /** First 12 hex characters of the value's sha256: enough to match two findings, not to recover it. */
  sha256Prefix: string;
}

const sha256Prefix = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

/** A value described without any part of it: length and a sha256 prefix. */
export function describeSecret(value: string): string {
  return `${value.length} chars, sha256 ${sha256Prefix(value)}`;
}

/** The finding as one line. It holds no character of the value. */
export function formatShapeFinding(f: ShapeFinding): string {
  return `${f.file} @${f.offset}: ${f.kind}-shaped credential${f.encoding ? ` (${f.encoding})` : ""} the bench did not create (${f.length} chars, sha256 ${f.sha256Prefix})`;
}

/** A value the bench created: in `known`, or of the bench's own fake grammar. */
const isBenchValue = (value: string, known: ReadonlySet<string>) =>
  known.has(value) || BENCH_FAKE_VALUE.test(value);

/** A field value that is a placeholder or a redaction marker, not a credential. */
const isPlaceholder = (value: string) =>
  value.length < FIELD_MIN_LENGTH || /^<[^>]*>$/.test(value) || /^\*+$/.test(value);

interface RawMatch {
  /** Index in the scanned text. */
  index: number;
  /** Characters of the scanned text the match covers. */
  span: number;
  kind: ShapeKind;
  value: string;
}

/** Every credential-shaped match in `text` that the bench did not create. */
function matchesIn(text: string, known: ReadonlySet<string>): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(JWT_CANDIDATE)) {
    const value = m[0].replace(/\.+$/, "");
    const [head = "", body = "", sig] = value.split(".");
    const full = sig !== undefined && sig.length > 0 && value.length >= JWT_MIN_LENGTH;
    const prefix = head.length >= 18 && body.length >= 20 && value.length >= JWT_PREFIX_MIN_LENGTH;
    if (!full && !prefix) continue;
    if (isBenchValue(value, known)) continue;
    out.push({
      index: m.index ?? 0,
      span: value.length,
      kind: full ? "jwt" : "jwt-prefix",
      value,
    });
  }
  for (const [kind, re] of [
    ["sk-key", SK_SHAPE],
    ["rt-token", RT_SHAPE],
  ] as const) {
    for (const m of text.matchAll(re)) {
      if (isBenchValue(m[0], known)) continue;
      out.push({ index: m.index ?? 0, span: m[0].length, kind, value: m[0] });
    }
  }
  for (const re of [JSON_FIELD, FORM_FIELD]) {
    for (const m of text.matchAll(re)) {
      const value = m[2] ?? "";
      if (isPlaceholder(value) || isBenchValue(value, known)) continue;
      const index = (m.index ?? 0) + m[0].length - value.length - (re === JSON_FIELD ? 1 : 0);
      out.push({ index, span: value.length, kind: "credential-field", value });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounded decoders. Each maps a decoded index back to an index of the window text.

interface View {
  text: string;
  /** `map[i]` is the window index of decoded character i; `map[text.length]` its end. */
  map: Int32Array;
  encoding: ShapeEncoding;
}

const JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** JSON string escapes undone (`.`, `\/`, `\"`, ...). Null when the text has none. */
export function jsonUnescapeView(text: string): View | null {
  if (!text.includes("\\")) return null;
  const chars: string[] = [];
  const map = new Int32Array(text.length + 1);
  let i = 0;
  while (i < text.length) {
    map[chars.length] = i;
    if (text[i] === "\\") {
      const next = text[i + 1] ?? "";
      const hex = text.slice(i + 2, i + 6);
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(hex)) {
        chars.push(String.fromCharCode(Number.parseInt(hex, 16)));
        i += 6;
        continue;
      }
      const simple = JSON_ESCAPES[next];
      if (simple !== undefined) {
        chars.push(simple);
        i += 2;
        continue;
      }
    }
    chars.push(text[i] as string);
    i += 1;
  }
  map[chars.length] = text.length;
  return { text: chars.join(""), map: map.subarray(0, chars.length + 1), encoding: "json-escaped" };
}

/** UTF-16LE text collapsed to one byte per character. Null when the text has no NUL byte. */
export function utf16leView(text: string): View | null {
  if (!text.includes("\0")) return null;
  const chars: string[] = [];
  const map = new Int32Array(text.length + 1);
  let i = 0;
  while (i < text.length) {
    map[chars.length] = i;
    const ch = text[i] as string;
    if (ch !== "\0" && text[i + 1] === "\0") {
      chars.push(ch);
      i += 2;
    } else {
      chars.push(ch);
      i += 1;
    }
  }
  map[chars.length] = text.length;
  return { text: chars.join(""), map: map.subarray(0, chars.length + 1), encoding: "utf16le" };
}

/** A base64 (or base64url) run long enough to carry a credential. */
const BASE64_RUN = /[A-Za-z0-9+/_-]{80,}={0,2}/g;
/**
 * Characters of one run decoded at a time. A longer run is decoded WHOLE, in blocks of this
 * size that overlap by `BASE64_BLOCK_OVERLAP` (review round 7: a credential after the first
 * 256 KiB of a 349,588-char body was never decoded).
 */
export const BASE64_MAX_RUN = 256 * 1024;
/**
 * Encoded characters two consecutive blocks share: 48 KiB decoded, more than the longest
 * shape the scan matches (a field value is capped at 8192 escaped characters; a real JWT
 * bearer measured 1821). Any decoded value up to that length is whole in one block. A
 * multiple of 4, so every block starts on the run's own base64 alignment.
 */
export const BASE64_BLOCK_OVERLAP = 64 * 1024;

/** `[from, to)` blocks covering a run of `length` characters, overlapping, 4-aligned. */
export function base64Blocks(
  length: number,
  block = BASE64_MAX_RUN,
  overlap = BASE64_BLOCK_OVERLAP
): Array<[number, number]> {
  if (block % 4 || overlap % 4 || overlap >= block)
    throw new Error(
      `base64Blocks: block ${block} and overlap ${overlap} must be 4-aligned, overlap < block`
    );
  const out: Array<[number, number]> = [];
  const step = block - overlap;
  for (let from = 0; ; from += step) {
    out.push([from, Math.min(length, from + block)]);
    if (from + block >= length) return out;
  }
}

interface Located {
  /** Window index where the value (or its encoded run) starts and ends. */
  start: number;
  end: number;
  kind: ShapeKind;
  encoding?: ShapeEncoding;
  value: string;
}

/**
 * Matches in one decoded base64 block, as decoded and JSON-unescaped, each placed at the
 * ENCODED characters that carry it: `[start, end)` relative to `encoded` (review round 8, GPT
 * MEDIUM: every match used to be placed at its run's start, so a match in a run that began in
 * an earlier file window was dropped as that window's, and that window never saw it).
 * Decoded byte `d` of alignment `shift` comes from the 4-character group at
 * `shift + 4 * floor(d / 3)`: the run holds only base64 characters (`=` only at its end), so
 * the decoder maps groups one to one.
 */
function base64BlockMatches(
  encoded: string,
  known: ReadonlySet<string>
): Array<RawMatch & { start: number; end: number }> {
  const out: Array<RawMatch & { start: number; end: number }> = [];
  // Four alignments: a run may begin with characters that are not part of the encoding.
  for (let shift = 0; shift < 4; shift++) {
    const decoded = Buffer.from(encoded.slice(shift), "base64").toString("latin1");
    const place = (m: RawMatch, from: number, to: number) => ({
      ...m,
      start: shift + 4 * Math.floor(from / 3),
      end: Math.min(encoded.length, shift + 4 * Math.ceil(to / 3)),
    });
    for (const m of matchesIn(decoded, known)) out.push(place(m, m.index, m.index + m.span));
    const unescaped = jsonUnescapeView(decoded);
    if (unescaped)
      for (const m of matchesIn(unescaped.text, known))
        out.push(
          place(m, unescaped.map[m.index] ?? 0, unescaped.map[m.index + m.span] ?? decoded.length)
        );
  }
  return out;
}

/** Matches in the window text as written and through each decoder. */
function locate(text: string, known: ReadonlySet<string>): Located[] {
  const out: Located[] = [];
  for (const m of matchesIn(text, known))
    out.push({ start: m.index, end: m.index + m.span, kind: m.kind, value: m.value });
  const views: View[] = [];
  const json = jsonUnescapeView(text);
  if (json) views.push(json);
  const utf16 = utf16leView(text);
  if (utf16) {
    views.push(utf16);
    const inner = jsonUnescapeView(utf16.text);
    if (inner)
      views.push({
        text: inner.text,
        map: inner.map.map((i) => utf16.map[i] ?? text.length),
        encoding: "utf16le",
      });
  }
  for (const v of views)
    for (const m of matchesIn(v.text, known))
      out.push({
        start: v.map[m.index] ?? 0,
        end: v.map[m.index + m.span] ?? text.length,
        kind: m.kind,
        encoding: v.encoding,
        value: m.value,
      });
  for (const run of text.matchAll(BASE64_RUN)) {
    const runStart = run.index ?? 0;
    // The whole run, in overlapping 4-aligned blocks. A match is placed at its own encoded
    // characters, so the same value seen by two blocks has one start and is deduped below,
    // and window ownership is decided by where the value is, not where its run began.
    for (const [from, to] of base64Blocks(run[0].length)) {
      for (const m of base64BlockMatches(run[0].slice(from, to), known))
        out.push({
          start: runStart + from + m.start,
          end: runStart + from + m.end,
          kind: m.kind,
          encoding: "base64",
          value: m.value,
        });
    }
  }
  return out;
}

/** One finding per (offset, value), the encoding-free one first. */
function dedupe<T extends { start: number; value: string; encoding?: ShapeEncoding }>(
  list: T[]
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of [...list].sort((a, b) => Number(!!a.encoding) - Number(!!b.encoding))) {
    const key = `${f.start}:${f.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Directory names that hold COPIES of a product bundle, not evidence: the bench's mutant
 * trees (`mutant-trees/`, a run's `mutant-tree/`, E20's `mutants/`), any `dist/` and
 * `node_modules/`, and a checkout's `.git/`. A minified bundle is not run output, and the
 * E20 baseline checkout is never under a scanned folder.
 */
export const BUNDLE_DIRS: ReadonlySet<string> = new Set([
  "mutant-trees",
  "mutant-tree",
  "mutants",
  "dist",
  "node_modules",
  ".git",
]);

export interface ShapeScanOptions {
  /** Skip a directory by base name. Default: `BUNDLE_DIRS`. */
  skipDir?: (name: string) => boolean;
  chunkBytes?: number;
  overlapBytes?: number;
}

/** Credential-shaped matches in one window's owned range that are not in `known`. */
function shapesIn(w: FileWindow, known: ReadonlySet<string>): Array<Omit<ShapeFinding, "file">> {
  return dedupe(locate(w.text, known))
    .filter((f) => f.start >= w.ownedFrom && f.start < w.ownedTo)
    .map((f) => ({
      offset: w.base + f.start,
      kind: f.kind,
      ...(f.encoding ? { encoding: f.encoding } : {}),
      length: f.value.length,
      sha256Prefix: sha256Prefix(f.value),
    }));
}

/**
 * Every real-credential-shaped string under `root` that is not one of `known` (the bench's
 * own seeded, issued and canary values). Every file is read whole, in windows.
 */
export function scanCredentialShapes(
  root: string,
  known: Iterable<string>,
  opts: ShapeScanOptions = {}
): { files: number; findings: ShapeFinding[] } {
  const knownSet = new Set(known);
  const skipDir = opts.skipDir ?? ((name: string) => BUNDLE_DIRS.has(name));
  const findings: ShapeFinding[] = [];
  let files = 0;
  const visit = (path: string, rel: string) => {
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        const child = join(path, name);
        if (skipDir(name) && statSync(child).isDirectory()) continue;
        visit(child, rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (!st.isFile()) return;
    files++;
    for (const w of fileWindows(path, opts.chunkBytes, opts.overlapBytes)) {
      for (const f of shapesIn(w, knownSet)) findings.push({ file: rel, ...f });
    }
  };
  visit(root, "");
  return { files, findings };
}

/**
 * The same scan over text held in memory (a result file BEFORE it is written). Every
 * credential-shaped range is replaced by `<redacted N chars sha256 X>`, so the text can be
 * written without the value; `findings` name the offsets in the ORIGINAL text.
 */
export function redactCredentialShapes(
  text: string,
  known: Iterable<string>,
  label = "(in memory)"
): { text: string; findings: ShapeFinding[] } {
  const knownSet = new Set(known);
  const found = dedupe(locate(text, knownSet));
  const findings: ShapeFinding[] = found.map((f) => ({
    file: label,
    offset: f.start,
    kind: f.kind,
    ...(f.encoding ? { encoding: f.encoding } : {}),
    length: f.value.length,
    sha256Prefix: sha256Prefix(f.value),
  }));
  // Merge overlapping ranges, then replace from the end so earlier indexes stay valid.
  const ranges = found
    .map((f) => ({ start: f.start, end: Math.max(f.end, f.start + 1), value: f.value }))
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number; value: string }> = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let out = text;
  for (const r of merged.reverse())
    out = `${out.slice(0, r.start)}<redacted ${describeSecret(text.slice(r.start, r.end))}>${out.slice(r.end)}`;
  return { text: out, findings };
}

/**
 * One string, scanned in the context it is serialized in (`{"key": "value"}`, so a field
 * named like a credential is recognised, and JSON escapes are read as the file would hold
 * them). A string whose redaction does not come back clean is replaced whole.
 */
function sanitizeString(s: string, key: string | null, known: ReadonlySet<string>): string {
  const ctxKey = key ?? "_";
  const inContext = (v: string) => JSON.stringify({ [ctxKey]: v });
  const r = redactCredentialShapes(inContext(s), known);
  if (r.findings.length === 0) return s;
  try {
    const back = (JSON.parse(r.text) as Record<string, unknown>)[ctxKey];
    if (
      typeof back === "string" &&
      redactCredentialShapes(inContext(back), known).findings.length === 0
    )
      return back;
  } catch {
    /* the redaction cut through an escape: replace the whole string */
  }
  return `<redacted ${describeSecret(s)}>`;
}

/**
 * A copy of `value` (a record or outcome about to be RETURNED or PRINTED) with every
 * credential-shaped string redacted, keys included (review round 7: the files were written
 * redacted, but the objects the caller printed were not). `findings` counts the strings
 * changed. JSON values only: functions and symbols are not expected.
 */
export function redactCredentialShapesDeep<T>(
  value: T,
  known: Iterable<string>
): { value: T; findings: number } {
  const knownSet = new Set(known);
  let findings = 0;
  const str = (s: string, key: string | null) => {
    const safe = sanitizeString(s, key, knownSet);
    if (safe !== s) findings++;
    return safe;
  };
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") return str(v, key);
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k, null), walk(x, k)]));
  };
  return { value: walk(value, null) as T, findings };
}

/**
 * Write `text` to `path` only after the in-memory scan: a credential-shaped value is written
 * redacted, and the findings are returned so the caller fails the run. Used for every file
 * the bench writes AFTER its directory scan ran (result.json, outcome.json, summaries).
 */
export function writeScanned(path: string, text: string, known: Iterable<string>): string[] {
  const r = redactCredentialShapes(text, known, path);
  writeFileSync(path, r.text);
  return r.findings.map(formatShapeFinding);
}
