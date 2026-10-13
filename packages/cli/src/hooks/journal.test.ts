import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOURNAL_SCHEMA_VERSION,
  type JournalEntry,
  MAX_JOURNAL_BYTES,
  classifyPath,
  isUploadDecision,
  isUploadSurface,
  recordDecision,
} from "./journal.js";

async function inTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "claudish-behavior-journal-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function journalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: "2026-08-04T00:00:00.000Z",
    model: "gpt-5.6-codex",
    provider: "openai",
    surface: "tool_call",
    decision: "repaired",
    ruleId: "plan-path",
    toolName: "Write",
    argKeys: ["file_path", "content"],
    pathRelation: "same_dir_wrong_name",
    ...overrides,
  };
}

describe("upload sets", () => {
  it("accepts only the surfaces and decisions the telemetry backend lists", () => {
    // docs/specs/behavior-telemetry-backend.md, "Enumerations" — closed sets.
    for (const surface of ["request", "tool_call", "model_output", "sequence"] as const) {
      expect(isUploadSurface(surface)).toBe(true);
    }
    for (const surface of ["response", "session"] as const) {
      expect(isUploadSurface(surface)).toBe(false);
    }
    for (const decision of ["ignored", "matched", "warned", "repaired", "novel"] as const) {
      expect(isUploadDecision(decision)).toBe(true);
    }
    for (const decision of [
      "superseded",
      "invalid",
      "timeout",
      "error",
      "disabled",
      "dropped",
      "queued",
      "delivered",
      "raw",
    ] as const) {
      expect(isUploadDecision(decision)).toBe(false);
    }
  });

  it("writes schema 2 locally", () => {
    expect(JOURNAL_SCHEMA_VERSION).toBe(2);
  });
});

describe("classifyPath", () => {
  it("classifies every path relationship", () => {
    const cases: Array<{
      observed?: string;
      expected?: string;
      relation: ReturnType<typeof classifyPath>;
    }> = [
      {
        observed: "/tmp/plans/assigned.md",
        expected: "/tmp/plans/assigned.md",
        relation: "as_expected",
      },
      { observed: "wrong.md", expected: "assigned.md", relation: "same_dir_wrong_name" },
      {
        observed: "/tmp/other/wrong.md",
        expected: "/tmp/plans/assigned.md",
        relation: "outside_expected_dir",
      },
      { observed: undefined, expected: "/tmp/plans/assigned.md", relation: "not_applicable" },
      { observed: "/tmp/plans/assigned.md", expected: undefined, relation: "no_expectation" },
    ];

    for (const { observed, expected, relation } of cases) {
      expect(classifyPath(observed, expected)).toBe(relation);
    }
  });
});

describe("recordDecision", () => {
  it("creates parent directories and appends one round-trippable JSON line per call", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "missing", "nested", "journal.jsonl");
      const first = journalEntry();
      const second = journalEntry({
        ts: "2026-08-04T00:00:01.000Z",
        decision: "warned",
        pathRelation: "outside_expected_dir",
      });

      expect(existsSync(join(dir, "missing", "nested"))).toBe(false);
      await recordDecision(first, path);
      await recordDecision(second, path);

      const lines = readFileSync(path, "utf8").split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe("");
      expect(JSON.parse(lines[0])).toEqual(first);
      expect(JSON.parse(lines[1])).toEqual(second);
    });
  });

  it("resolves when the journal path is unwritable", async () => {
    await inTempDir(async (dir) => {
      const parentFile = join(dir, "not-a-directory");
      writeFileSync(parentFile, "block parent directory creation");

      await expect(
        recordDecision(journalEntry(), join(parentFile, "journal.jsonl"))
      ).resolves.toBeUndefined();
    });
  });

  it("prunes an over-cap journal, resolves, and appends a valid entry", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "journal.jsonl");
      const entry = journalEntry();
      const serializedEntry = `${JSON.stringify(entry)}\n`;
      writeFileSync(path, `${JSON.stringify({ padding: "x".repeat(MAX_JOURNAL_BYTES) })}\n`);

      await expect(recordDecision(entry, path)).resolves.toBeUndefined();

      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      expect(JSON.parse(lines.at(-1)!)).toEqual(entry);
      expect(statSync(path).size).toBeLessThan(MAX_JOURNAL_BYTES);
      expect(statSync(path).size).toBeLessThanOrEqual(
        Math.floor(MAX_JOURNAL_BYTES * 0.6) + Buffer.byteLength(serializedEntry)
      );
    });
  });

  it("evicts the oldest entries and preserves a valid contiguous suffix", async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, "journal.jsonl");
      const padding = "x".repeat(4096);
      const sequenceCount = Math.ceil(MAX_JOURNAL_BYTES / padding.length) + 64;
      const originalLines = Array.from({ length: sequenceCount }, (_, seq) =>
        JSON.stringify({ seq, padding })
      );
      const seed = `${originalLines.join("\n")}\n`;
      expect(Buffer.byteLength(seed)).toBeGreaterThan(MAX_JOURNAL_BYTES);
      writeFileSync(path, seed);

      const entry = journalEntry({ ts: "2026-08-04T00:00:02.000Z" });
      await expect(recordDecision(entry, path)).resolves.toBeUndefined();

      const parsed = readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(parsed.at(-1)).toEqual(entry);

      const survivingSeqs = parsed.slice(0, -1).map(({ seq }) => seq as number);
      const firstSurvivingSeq = survivingSeqs[0];
      expect(firstSurvivingSeq).toBeGreaterThan(0);
      expect(survivingSeqs.at(-1)).toBe(sequenceCount - 1);
      expect(survivingSeqs).toEqual(
        Array.from(
          { length: sequenceCount - firstSurvivingSeq },
          (_, offset) => firstSurvivingSeq + offset
        )
      );
    });
  });
});
