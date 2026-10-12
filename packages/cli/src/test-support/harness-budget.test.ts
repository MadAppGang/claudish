/**
 * #445 — byte budgets for the harness files an agent loads on every turn.
 *
 * Input tokens are re-read from cache on every turn, so a file that is always
 * loaded is paid (size × turns). On PAYG lanes (DeepSeek) that input dominates
 * the bill. Slimming passes do not hold on their own: `CLAUDE.md` went
 * 27 KB → 116 KB → 82 KB → 94 KB between 23/08 and 11/10 because every PR
 * appends its gotcha to the file that is always loaded. A budget nobody checks
 * is a wish; this test is the check.
 *
 * Rule of the budget: the always-loaded file holds DECISIONS (what an agent
 * must know before acting). Measurements, incident narratives and history go
 * to a non-loaded reference file, with a one-line pointer left behind.
 *
 * Adding a row: the path is repo-relative, the budget is in BYTES (UTF-8 —
 * accented French costs more than its character count), and `detail` names
 * where overflow goes, because that is what the failure message tells the
 * author to do.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

interface Budget {
  path: string;
  maxBytes: number;
  detail: string;
}

const BUDGETS: Budget[] = [
  {
    // Read once per coordinator cycle and kept in context for every turn of it.
    // 52 746 B before #445 (A3); the verbatim original lives in reference.md.
    path: ".claude/skills/claudish-coordinate/SKILL.md",
    maxBytes: 16 * 1024,
    detail: ".claude/skills/claudish-coordinate/reference.md (section of the same name)",
  },
];

describe("harness byte budgets (#445)", () => {
  test("positive control: every budgeted file exists and is non-empty", () => {
    // A renamed or deleted file would otherwise pass the size check vacuously.
    for (const b of BUDGETS) {
      const full = join(REPO_ROOT, b.path);
      expect(existsSync(full), `${b.path} is budgeted but does not exist — update BUDGETS`).toBe(true);
      expect(statSync(full).size).toBeGreaterThan(0);
    }
  });

  for (const b of BUDGETS) {
    test(`${b.path} ≤ ${b.maxBytes} bytes`, () => {
      // Measured as committed (LF), not as checked out: under core.autocrlf=true a
      // Windows working copy carries one extra byte per line, which would make the
      // verdict depend on the machine running the suite.
      const raw = readFileSync(join(REPO_ROOT, b.path), "utf-8");
      const size = Buffer.byteLength(raw.replace(/\r\n/g, "\n"), "utf-8");
      expect(
        size,
        `${b.path} is ${size} B, over its ${b.maxBytes} B budget (+${size - b.maxBytes}). ` +
          `It is loaded on every turn: move the measurements / incident narrative / history into ` +
          `${b.detail} and leave a one-line pointer. Raising the budget is a #445 decision, not a fix.`,
      ).toBeLessThanOrEqual(b.maxBytes);
    });

    test(`${b.path}: every reference.md pointer resolves`, () => {
      // A slimmed file is only lossless while the place it points to exists.
      const full = join(REPO_ROOT, b.path);
      const text = readFileSync(full, "utf-8");
      if (text.includes("reference.md")) {
        expect(existsSync(join(dirname(full), "reference.md")), `${b.path} points to reference.md, which is missing`).toBe(true);
      }
    });
  }
});
