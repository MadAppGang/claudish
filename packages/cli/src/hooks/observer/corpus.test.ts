import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorpus, replayTranscript } from "./corpus.js";

function inTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "claudish-behavior-corpus-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assistantToolRow(model: string, writes: string[]): any {
  return {
    timestamp: "2026-08-01T00:00:00.000Z",
    message: {
      role: "assistant",
      model,
      content: [
        ...writes.map((filePath, index) => ({
          type: "tool_use",
          id: `write-${index}`,
          name: "Write",
          input: { file_path: filePath, content: "# Plan" },
        })),
        { type: "tool_use", id: "exit-1", name: "ExitPlanMode", input: {} },
      ],
    },
  };
}

function exitResultRow(assignedPath: string, plan: string | null): any {
  return {
    timestamp: "2026-08-01T00:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "exit-1", content: "done" }],
    },
    toolUseResult: { plan, filePath: assignedPath },
  };
}

function writeTranscript(path: string, rows: Array<any | string>): void {
  writeFileSync(
    path,
    `${rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`
  );
}

describe("replayTranscript", () => {
  it("labels a write to the assigned path as ok and attributes the preceding assistant model", () => {
    inTempDir((dir) => {
      const assignedPath = "/tmp/custom-plans/assigned.md";
      const transcript = join(dir, "ok.jsonl");
      writeTranscript(transcript, [
        assistantToolRow("gpt-5.6-codex", [assignedPath]),
        exitResultRow(assignedPath, "# Recovered plan"),
      ]);

      const records = replayTranscript(transcript);

      expect(records).toHaveLength(1);
      expect(records[0].outcome).toBe("ok");
      expect(records[0].observedPaths).toEqual([]);
      expect(records[0].model).toBe("gpt-5.6-codex");
      expect(records[0].assignedPath).toBe(assignedPath);
    });
  });

  it("labels a wrong plan-directory write as degraded and skips malformed lines", () => {
    inTempDir((dir) => {
      const assignedPath = "/tmp/custom-plans/assigned.md";
      const wrongPath = "/tmp/custom-plans/model-invented.md";
      const transcript = join(dir, "degraded.jsonl");
      writeTranscript(transcript, [
        "{malformed json",
        assistantToolRow("gpt-5.6-codex", [wrongPath]),
        "also not json",
        exitResultRow(assignedPath, null),
      ]);

      expect(() => replayTranscript(transcript)).not.toThrow();
      const records = replayTranscript(transcript);

      expect(records).toHaveLength(1);
      expect(records[0].outcome).toBe("degraded");
      expect(records[0].observedPaths).toEqual([wrongPath]);
      expect(records[0].model).toBe("gpt-5.6-codex");
    });
  });

  it("returns no records when the transcript contains no ExitPlanMode", () => {
    inTempDir((dir) => {
      const transcript = join(dir, "ordinary.jsonl");
      writeTranscript(transcript, [
        {
          message: {
            role: "assistant",
            model: "gpt-5.6-codex",
            content: [
              {
                type: "tool_use",
                id: "write-1",
                name: "Write",
                input: { file_path: "/workspace/src/file.ts", content: "source" },
              },
            ],
          },
        },
      ]);

      expect(replayTranscript(transcript)).toEqual([]);
    });
  });
});

describe("buildCorpus", () => {
  it("scans only the supplied synthetic projects root", () => {
    inTempDir((dir) => {
      const projectsRoot = join(dir, "projects");
      const projectDir = join(projectsRoot, "-workspace-project");
      const assignedPath = "/tmp/custom-plans/assigned.md";
      mkdirSync(projectDir, { recursive: true });
      writeTranscript(join(projectDir, "session.jsonl"), [
        assistantToolRow("test-model", [assignedPath]),
        exitResultRow(assignedPath, "# Plan"),
      ]);
      writeFileSync(join(projectDir, "ignored.txt"), "ExitPlanMode");

      const corpus = buildCorpus({ projectsRoot });

      expect(corpus.scanned).toBe(1);
      expect(corpus.records).toHaveLength(1);
      expect(corpus.records[0].outcome).toBe("ok");
      expect(corpus.records[0].model).toBe("test-model");
    });
  });
});
