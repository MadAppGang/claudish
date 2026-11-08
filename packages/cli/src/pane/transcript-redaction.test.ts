/**
 * The transcript line redaction pipeline (pane/transcript-redaction.ts, review fixes C1,
 * C2, M6 and L1 of MTL-373). The MCP surface cannot hold a signing lease, so these run
 * the pipeline in process against the REAL signing-value registry.
 *
 * Every credential here is synthetic and assembled by concatenation, so no scanner
 * reads a literal key in this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type SigningLease,
  acquireSigningLease,
  redactPatterns,
  redactPatternsMapped,
} from "../redact.js";
import { TRANSCRIPT_LINE_MAX_CHARS, TRANSCRIPT_LINE_MAX_JSON_BYTES } from "./contract.js";
import { TOOL_ARG_MAX_CHARS } from "./transcript-lines.js";
import { linesOfEntry } from "./transcript-redaction.js";

const leases: SigningLease[] = [];
function sign(...values: string[]): void {
  const lease = acquireSigningLease();
  lease.add(values);
  leases.push(lease);
}
afterEach(() => {
  for (const l of leases.splice(0)) l.release();
});

function assistant(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}
function bash(command: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
  });
}

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every 6-character window of `secret` that is not all one repeated character. */
function fragments(secret: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= secret.length; i++) {
    const f = secret.slice(i, i + 6);
    if (new Set(f).size > 1) out.push(f);
  }
  return out;
}

describe("tool argument straddling the 160-character cut (C1)", () => {
  test("an opaque signing value is masked before the cut: no fragment survives", () => {
    const secret = `opaque-${"MTL373"}-demo-credential-${"abcdef"}-0123456789`;
    sign(secret);
    const command = `${"a".repeat(140)} ${secret}`;
    const [line] = linesOfEntry(bash(command));
    expect(line?.kind).toBe("tool");
    const text = line?.text ?? "";
    for (const f of fragments(secret)) expect(text).not.toContain(f);
    // the argument is cut where it would be with no lease: 160 characters ending `…`
    expect(text).toBe(`Bash(${"a".repeat(140)} ${"*".repeat(TOOL_ARG_MAX_CHARS - 142)}…)`);
  });

  test("a pattern-shaped credential is masked whole before the cut", () => {
    const key = `sk-${"proj"}-${"B".repeat(40)}`;
    const command = `${"a".repeat(150)} ${key}`;
    const [line] = linesOfEntry(bash(command));
    const text = line?.text ?? "";
    expect(text).not.toContain("sk-proj");
    expect(text).not.toContain("BBBBBB");
    // 151 characters, then the first 8 of the mask, then `…`: 160
    expect(text).toBe(`Bash(${"a".repeat(150)} ***REDAC…)`);
  });

  test("the same line, cut at the same place, with and without the lease", () => {
    const secret = `opaque-${"sk-"}${"A".repeat(24)}/straddle-${"tail"}`;
    const command = `${"b".repeat(150)}  ${secret} more words`;
    const without = linesOfEntry(bash(command));
    sign(secret);
    const withLease = linesOfEntry(bash(command));
    expect(withLease.length).toBe(without.length);
    expect(withLease[0]?.text.length).toBe(without[0]?.text.length);
    expect(withLease[0]?.text).not.toContain("straddle");
    expect(withLease[0]?.text).not.toContain("opaque");
  });
});

describe("signing ranges are found on the original text (C2)", () => {
  test("a pattern-shaped substring inside a signing value does not unmask the rest", () => {
    const secret = `opaque-${"sk-"}${"A".repeat(24)}/private-${"suffix"}`;
    sign(secret);
    const [line] = linesOfEntry(assistant(`see ${secret} end`));
    // `opaque-` and `/private-suffix` masked one-for-one; the pattern's own mask stays
    expect(line?.text).toBe(`see ${"*".repeat(7)}***REDACTED***${"*".repeat(15)} end`);
    expect(line?.text).not.toContain("private");
  });

  test("a signing value cut by an assignment's value class is masked past the cut", () => {
    const secret = `secret-${"part1"},secret-${"part2"}-long`;
    sign(secret);
    const [line] = linesOfEntry(assistant(`CUSTOM_TOKEN=${secret}`));
    expect(line?.text).not.toContain("part2");
    expect(line?.text).not.toContain("part1");
  });

  test("with no lease the output is exactly redactPatterns of the text", () => {
    const text = `X_API_KEY=${"val"}ue1 Bearer ${"C".repeat(20)} ${"sk-"}${"D".repeat(20)} plain`;
    const [line] = linesOfEntry(assistant(text));
    expect(line?.text).toBe(redactPatterns(text));
  });

  test("whitespace inside a signing value is kept, so separators do not move", () => {
    const secret = `opaque one${"-two"} three`;
    sign(secret);
    const [line] = linesOfEntry(assistant(`x ${secret} y`));
    expect(line?.text).toBe("x ****** ******* ***** y");
  });
});

describe("masking never grows a line (M6)", () => {
  test("a short value repeated stays within both line bounds, cut where it is unleased", () => {
    const value = `demo8${"key"}`;
    const text = `${`${value} `.repeat(2000)}END`;
    const without = linesOfEntry(assistant(text));
    sign(value);
    const lines = linesOfEntry(assistant(text));
    expect(lines.length).toBe(without.length);
    lines.forEach((l, i) => {
      expect(l.text.length).toBeLessThanOrEqual(TRANSCRIPT_LINE_MAX_CHARS);
      expect(Buffer.byteLength(JSON.stringify(l.text))).toBeLessThanOrEqual(
        TRANSCRIPT_LINE_MAX_JSON_BYTES
      );
      expect(l.text.length).toBe(without[i]?.text.length);
      expect(l.text).not.toContain(value);
    });
  });

  test("a value across a hard chunk boundary is masked in both chunks, nothing grows", () => {
    const secret = `opaque-${"boundary"}-${"0123456789"}`;
    const text = `${"z".repeat(TRANSCRIPT_LINE_MAX_CHARS - 1)}${secret}${"z".repeat(9000)}`;
    const without = linesOfEntry(assistant(text));
    sign(secret);
    const lines = linesOfEntry(assistant(text));
    expect(lines.map((l) => l.text.length)).toEqual(without.map((l) => l.text.length));
    expect(lines[0]?.text.length).toBe(TRANSCRIPT_LINE_MAX_CHARS);
    expect(lines[0]?.text.endsWith("*")).toBe(true);
    expect(lines[1]?.text.startsWith("*".repeat(secret.length - 1))).toBe(true);
    for (const l of lines) for (const f of fragments(secret)) expect(l.text).not.toContain(f);
  });
});

describe("no lone surrogate survives (L1)", () => {
  test("a signing value ending on half of a surrogate pair masks the whole pair", () => {
    const secret = `opaque-${"half"}\uD83D`;
    sign(secret);
    const [line] = linesOfEntry(assistant(`a ${secret}\uDE00 b`));
    const text = line?.text ?? "";
    expect(LONE.test(text)).toBe(false);
    expect(text).toBe(`a ${"*".repeat(secret.length + 1)} b`);
  });
});

describe("an inserted mask never absorbs the original text after it (review round 2, CRITICAL 1)", () => {
  const MASK_LEN = "***REDACTED***".length;

  test("a signing value right after a 7-character assignment value is masked whole", () => {
    const secret = `opaque-${"round2"}-credential-${"abcdef"}`;
    sign(secret);
    const [line] = linesOfEntry(assistant(`X_KEY=${"abcdefg"},${secret}`));
    expect(line?.text).toBe(`X_KEY=***REDACTED***,${"*".repeat(secret.length)}`);
    for (const f of fragments(secret)) expect(line?.text).not.toContain(f);
  });

  test("the segment map keeps the original text after a mask as its own segment", () => {
    const t0 = `X_KEY=${"abcdefg"},opaque-${"round2"}-credential-${"abcdef"}`;
    const { segments } = redactPatternsMapped(t0);
    expect(segments).toEqual([
      { length: 6, origin: 0 },
      { length: MASK_LEN, origin: -1 },
      { length: t0.length - 13, origin: 13 },
    ]);
  });

  // The original text resumes at offsets around MASK_LEN - 1, the one value where
  // `-1 + MASK_LEN === origin` made the old contiguity test pass.
  const cases: Array<{ name: string; value: string; sep: string }> = [];
  for (const name of ["X_KEY", "AB_KEY", "A_TOKEN", "LONG_NAME_API_KEY"])
    for (let resume = MASK_LEN - 3; resume <= MASK_LEN + 3; resume++) {
      const valueLen = resume - name.length - 1;
      if (valueLen < 1) continue;
      // the characters an assignment's value class stops at (a quote would be consumed)
      for (const sep of [",", " ", "}"]) cases.push({ name, value: "v".repeat(valueLen), sep });
    }

  test("no code unit of a signing value survives at any resume offset", () => {
    const secret = `opaque-${"sweep"}-credential-${"q1w2e3r4"}`;
    sign(secret);
    for (const { name, value, sep } of cases) {
      const t0 = `${name}=${value}${sep}${secret}`;
      const [line] = linesOfEntry(assistant(t0));
      const text = line?.text ?? "";
      expect({ t0, text }).toEqual({
        t0,
        text: `${name}=***REDACTED***${sep}${"*".repeat(secret.length)}`,
      });
    }
  });

  test("origins are preserved: a run with an origin is verbatim, an inserted run is only masks", () => {
    const inputs = cases.map(({ name, value, sep }) => `${name}=${value}${sep}tail-${"text"}-x`);
    inputs.push(`Authorization: Bearer ${"C".repeat(20)} after`, `a ${"sk-"}${"D".repeat(20)}xyz`);
    for (const t0 of inputs) {
      const { text, segments } = redactPatternsMapped(t0);
      expect(text).toBe(redactPatterns(t0));
      let p = 0;
      for (const seg of segments) {
        if (seg.origin >= 0) {
          expect({ t0, run: text.slice(p, p + seg.length) }).toEqual({
            t0,
            run: t0.slice(seg.origin, seg.origin + seg.length),
          });
        } else {
          // inserted text is the mask and the space after a scheme word, nothing else
          expect({ t0, run: text.slice(p, p + seg.length) }).toEqual({
            t0,
            run: expect.stringMatching(/^(?: |\*\*\*REDACTED\*\*\*)+$/),
          });
        }
        p += seg.length;
      }
      expect(p).toBe(text.length);
    }
  });
});
