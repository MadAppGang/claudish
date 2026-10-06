import { describe, expect, it } from "bun:test";
import { NEXT_STEP, formatTeamResult } from "./mcp-server.js";
import { FAILURE_REASONS, type FailureReason, type SlotState } from "./pane/index.js";
import type { ModelError, ModelStatus, TeamStatus } from "./team-orchestrator.js";

type ModelState = SlotState;

const SESSION_PATH = "/tmp/team-result-card";
const STARTED_AT = "2026-07-30T00:00:00.000Z";
const COMPLETED_AT = "2026-07-30T00:01:00.000Z";

function modelStatus(
  state: ModelState,
  options: {
    id?: string;
    outputSize?: number;
    reason?: FailureReason;
    screenSnippet?: string;
    answerSnippet?: string;
    withError?: boolean;
    detail?: string;
    anomalies?: string[];
  } = {}
): ModelStatus {
  const id = options.id ?? "01";
  const isCompleted = state === "COMPLETED";
  const isFailure =
    state === "FAILED" || state === "TIMEOUT" || state === "EMPTY" || state === "CANCELLED";
  const withError = options.withError ?? isFailure;

  let error: ModelError | undefined;
  if (withError) {
    const reason = options.reason ?? "child_exited";
    error = {
      model: id,
      command: `claudish --model test-${id}`,
      reason,
      detail: options.detail ?? `diagnostic detail for ${reason}`,
      screenSnippet: options.screenSnippet,
      answerSnippet: options.answerSnippet,
      errorLogPath: `${SESSION_PATH}/errors/${id}.log`,
      workDir: `${SESSION_PATH}/work/${id}`,
    };
  }

  return {
    state,
    exitCode: isCompleted ? 0 : state === "TIMEOUT" ? null : 1,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    outputSize: options.outputSize ?? (isCompleted ? 1024 : 0),
    error,
    ...(options.anomalies ? { anomalies: options.anomalies } : {}),
  };
}

function status(models: Record<string, ModelStatus>): TeamStatus {
  return {
    startedAt: STARTED_AT,
    models,
  };
}

function sixModelStatus(snippetLength: number): TeamStatus {
  const screenSnippet = "E".repeat(snippetLength);
  const answerSnippet = "O".repeat(snippetLength);

  return status({
    "01": modelStatus("COMPLETED", { id: "01", outputSize: 1200 }),
    "02": modelStatus("FAILED", {
      id: "02",
      reason: "child_exited",
      screenSnippet,
      answerSnippet,
    }),
    "03": modelStatus("COMPLETED", { id: "03", outputSize: 2300 }),
    "04": modelStatus("TIMEOUT", {
      id: "04",
      reason: "timeout",
      screenSnippet,
      answerSnippet,
    }),
    "05": modelStatus("COMPLETED", { id: "05", outputSize: 3400 }),
    "06": modelStatus("EMPTY", {
      id: "06",
      reason: "empty_output",
      screenSnippet,
      answerSnippet,
    }),
  });
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

describe("formatTeamResult", () => {
  it("never emits stderr or stdout snippets", () => {
    const screenMarker = "UNIQUE-SCREEN-MARKER-7F3A";
    const answerMarker = "UNIQUE-ANSWER-MARKER-91BC";
    const output = formatTeamResult(
      status({
        "01": modelStatus("FAILED", {
          id: "01",
          reason: "child_exited",
          screenSnippet: `before ${screenMarker} after`,
          answerSnippet: `before ${answerMarker} after`,
        }),
      }),
      SESSION_PATH
    );

    expect(occurrences(output, screenMarker)).toBe(0);
    expect(occurrences(output, answerMarker)).toBe(0);
    expect(output).not.toContain("screenSnippet");
    expect(output).not.toContain("answerSnippet");
  });

  it("stays under 2,500 bytes for six models and three capped failures", () => {
    const output = formatTeamResult(sixModelStatus(2000), SESSION_PATH);

    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(2500);
  });

  it("is byte-identical regardless of snippet size", () => {
    const shortSnippetOutput = formatTeamResult(sixModelStatus(10), SESSION_PATH);
    const cappedSnippetOutput = formatTeamResult(sixModelStatus(2000), SESSION_PATH);

    expect(cappedSnippetOutput).toBe(shortSnippetOutput);
    expect(Buffer.from(cappedSnippetOutput)).toEqual(Buffer.from(shortSnippetOutput));
  });

  it("is self-delimiting", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", { id: "01" }),
      }),
      SESSION_PATH
    );

    expect(output.startsWith("<<<TEAM_RESULT")).toBe(true);
    expect(output.endsWith("<<<END_TEAM_RESULT>>>")).toBe(true);
  });

  it("counts EMPTY, FAILED, TIMEOUT and CANCELLED as failures", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", { id: "01" }),
        "02": modelStatus("FAILED", { id: "02", reason: "child_exited" }),
        "03": modelStatus("TIMEOUT", { id: "03", reason: "timeout" }),
        "04": modelStatus("EMPTY", { id: "04", reason: "empty_output" }),
        "05": modelStatus("CANCELLED", { id: "05", reason: "cancelled" }),
      }),
      SESSION_PATH
    );
    const failures = output.split("failures:\n")[1]?.split("\nactions:")[0] ?? "";

    expect(output).toContain("status: partial — 1/5 succeeded");
    expect(failures).toContain("02  FAILED");
    expect(failures).toContain("03  TIMEOUT");
    expect(failures).toContain("04  EMPTY");
    expect(failures).toContain("05  CANCELLED  reason=cancelled");
  });

  it.each([...FAILURE_REASONS])(
    "includes reason, next step, and evidence for %s",
    (reason: FailureReason) => {
      const state: ModelState =
        reason === "timeout"
          ? "TIMEOUT"
          : reason === "cancelled"
            ? "CANCELLED"
            : ["shape_mismatch", "empty_output", "refused"].includes(reason)
              ? "EMPTY"
              : "FAILED";
      const output = formatTeamResult(
        status({ "01": modelStatus(state, { id: "01", reason }) }),
        SESSION_PATH
      );

      expect(output).toContain(`reason=${reason}`);
      expect(output).toContain(`next: ${NEXT_STEP[reason]}`);
      expect(output).toContain(`evidence: ${SESSION_PATH}/errors/01.log`);

      if (reason === "api_error") {
        expect(output).toContain("or@");
      }
    }
  );

  it("has a deterministic next step for every reason in the closed set", () => {
    for (const reason of FAILURE_REASONS) expect(NEXT_STEP[reason]?.length).toBeGreaterThan(10);
    expect(Object.keys(NEXT_STEP).sort()).toEqual([...FAILURE_REASONS].sort());
  });

  it("lists a blocked slot with the question it stopped on", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("FAILED", {
          id: "01",
          reason: "blocked",
          detail: "Which database should the migration target?",
        }),
      }),
      SESSION_PATH
    );

    expect(output).toContain("01  FAILED  reason=blocked");
    expect(output).toContain("question: Which database should the migration target?");
    expect(output).toContain("make the prompt self-contained or use create_session");
  });

  it("names an open background shell under a succeeded slot (R3-M5)", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", {
          id: "01",
          anomalies: ["background_shell_open: npm run dev"],
        }),
      }),
      SESSION_PATH
    );

    expect(output).toContain("status: ok — 1/1 succeeded");
    expect(output).toContain("note: background_shell_open: npm run dev");
  });

  it("reads a pre-contract state outside the closed set as FAILED", () => {
    const legacy = {
      ...modelStatus("FAILED", { id: "01" }),
      state: "PENDING",
    } as unknown as ModelStatus;
    const output = formatTeamResult(status({ "01": legacy }), SESSION_PATH);

    expect(output).toContain("01  FAILED");
  });

  it("warns that a shape-mismatch answer was not produced and must not become a vote", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("EMPTY", { id: "01", reason: "shape_mismatch" }),
      }),
      SESSION_PATH
    );

    expect(output).toContain("the model did not produce it");
    expect(output).toContain("do NOT count this slot as a vote");
  });

  it("reports a vote-less shape_mismatch slot as a failure, not a success", () => {
    // Measured late turns reduced 7,743 and 4,737 output tokens to 250 B and 396 B epilogues.
    const output = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", { id: "01" }),
        "02": modelStatus("EMPTY", { id: "02", reason: "shape_mismatch" }),
      }),
      SESSION_PATH
    );
    const failures = output.split("failures:\n")[1]?.split("\nactions:")[0] ?? "";

    expect(output).toContain("status: partial — 1/2 succeeded");
    expect(output).not.toContain("2/2 succeeded");
    expect(failures).toContain("02  EMPTY");
    expect(failures).toContain("reason=shape_mismatch");
  });

  it("calls out missing diagnostics and tells the caller to report_error", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("FAILED", { id: "01", withError: false }),
      }),
      SESSION_PATH
    );

    expect(output).toMatch(/^\s+evidence:.*NONE CAPTURED.*report_error$/m);
  });

  it("keeps all-succeeded runs tiny and omits failures", () => {
    const output = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", { id: "01", outputSize: 100 }),
        "02": modelStatus("COMPLETED", { id: "02", outputSize: 2048 }),
        "03": modelStatus("COMPLETED", { id: "03", outputSize: 3_000_000 }),
      }),
      SESSION_PATH
    );

    expect(output).toContain("status: ok — 3/3 succeeded");
    expect(output).not.toContain("failures:");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(400);
  });

  it("distinguishes all-failed from partial runs", () => {
    const allFailed = formatTeamResult(
      status({
        "01": modelStatus("FAILED", { id: "01", reason: "child_exited" }),
        "02": modelStatus("EMPTY", { id: "02", reason: "empty_output" }),
      }),
      SESSION_PATH
    );
    const partial = formatTeamResult(
      status({
        "01": modelStatus("COMPLETED", { id: "01" }),
        "02": modelStatus("TIMEOUT", { id: "02", reason: "timeout" }),
      }),
      SESSION_PATH
    );

    expect(allFailed).toContain("status: all-failed — 0/2 succeeded");
    expect(partial).toContain("status: partial — 1/2 succeeded");
  });

  it("sorts model ids regardless of fixture insertion order", () => {
    const output = formatTeamResult(
      status({
        "03": modelStatus("FAILED", { id: "03", reason: "child_exited" }),
        "01": modelStatus("FAILED", { id: "01", reason: "child_exited" }),
        "02": modelStatus("FAILED", { id: "02", reason: "child_exited" }),
      }),
      SESSION_PATH
    );

    const model01 = output.indexOf("  01  FAILED");
    const model02 = output.indexOf("  02  FAILED");
    const model03 = output.indexOf("  03  FAILED");

    expect(model01).toBeGreaterThan(-1);
    expect(model02).toBeGreaterThan(model01);
    expect(model03).toBeGreaterThan(model02);
  });
});
