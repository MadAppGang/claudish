import { describe, expect, it } from "bun:test";
import { isTerminalState } from "./pane/contract.js";
import { isTerminalPhase, nextPhase, wireState } from "./pane/slot-state.js";
import { type TeamStatus, classifyRunOutput, teamRunRowFromDisk } from "./team-orchestrator.js";

/*
 * An answer that misses the caller's `require_pattern` is its own terminal state,
 * SHAPE_MISMATCH (reason `shape_mismatch`), apart from EMPTY: the slot DID answer, and
 * the caller reads the answer to see the near miss. An empty answer stays EMPTY.
 */

const read = {
  mode: "file" as const,
  linesTotal: 4,
  linesRead: 4,
  complete: true,
  preambleBytes: 0,
};

describe("SHAPE_MISMATCH slot state", () => {
  it("classifies an answer that misses require_pattern as SHAPE_MISMATCH", () => {
    const v = classifyRunOutput({
      answer: "Here is some prose without the expected shape.",
      apiError: null,
      promptRead: read,
      requirePattern: "```vote",
    });
    expect(v?.state).toBe("SHAPE_MISMATCH");
    expect(v?.reason).toBe("shape_mismatch");
  });

  it("keeps a whitespace-only answer EMPTY", () => {
    const v = classifyRunOutput({
      answer: "  \n",
      apiError: null,
      promptRead: read,
      requirePattern: "```vote",
    });
    expect(v?.state).toBe("EMPTY");
    expect(v?.reason).toBe("empty_output");
  });

  it("is a terminal state and a terminal phase reached from a settled turn", () => {
    expect(isTerminalState("SHAPE_MISMATCH")).toBe(true);
    expect(nextPhase("RUNNING", "verdict_shape_mismatch")).toBe("SHAPE_MISMATCH");
    expect(nextPhase("SETTLING", "verdict_shape_mismatch")).toBe("SHAPE_MISMATCH");
    expect(isTerminalPhase("SHAPE_MISMATCH")).toBe(true);
    expect(wireState("SHAPE_MISMATCH", false)).toBe("SHAPE_MISMATCH");
  });

  it("settles a run whose only slot is SHAPE_MISMATCH, as a failed outcome", () => {
    const status: TeamStatus = {
      startedAt: "2026-11-21T00:00:00.000Z",
      models: {
        "01": {
          state: "SHAPE_MISMATCH",
          exitCode: null,
          startedAt: "2026-11-21T00:00:00.000Z",
          completedAt: "2026-11-21T00:01:00.000Z",
          outputSize: 47,
          error: {
            model: "m",
            command: "",
            reason: "shape_mismatch",
            detail: "No reply text or written file matched /```vote/",
            errorLogPath: "/tmp/x.log",
            workDir: "/tmp",
          },
        },
      },
    };
    const run = teamRunRowFromDisk("/tmp/team-shape-mismatch-test", status);
    expect(run.state).toBe("SETTLED");
    expect(run.outcome).toBe("all-failed");
    expect(run.slots[0]?.state).toBe("SHAPE_MISMATCH");
    expect(run.slots[0]?.reason).toBe("shape_mismatch");
  });
});
