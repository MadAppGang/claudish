/**
 * #578 - the grid path (buildTeamStatus, the default `team run`) is a second
 * ModelStatus producer beside runModels, and it must not silently drop the
 * failure details the MCP report renders: before this pin, a FAILED pane
 * listed state and exit code only, so the `## Failures Detected` block never
 * printed the `**Error output:**` lines it prints for subprocess runs.
 *
 * Pins:
 *  - the producer (buildTeamStatus): a FAILED PaneResult attaches error with
 *    the pane's real model id (falling back to the manifest), the honest
 *    "not captured in grid mode" notice as the snippet, and NO advertised log
 *    path or cwd (both empty; the renderer skips both);
 *  - the renderer (formatTeamResult), asserted INSIDE the `## Failures
 *    Detected` block - the report's leading JSON dump embeds status.error,
 *    so whole-report assertions are vacuous (the #538 lesson);
 *  - non-FAILED panes (completed, and the no-data TIMEOUT case) stay
 *    detail-free.
 *
 * Mutation target (replayed in the PR, restored byte-clean): dropping the
 * `if (state === "FAILED") status.error = ...` attach in buildTeamStatus
 * turns every renderer pin below red - the block goes back to silent.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { formatTeamResult } from "./mcp-server.js";
import { type PaneResult, buildTeamStatus } from "./team-grid.js";
import type { TeamManifest, TeamStatus } from "./team-orchestrator.js";

const manifest: TeamManifest = {
  created: "2026-10-21T00:00:00Z",
  models: {
    alpha: { model: "or@deepseek/deepseek-r1", assignedAt: "2026-10-21T00:00:01Z" },
    beta: { model: "g@gemini-2.0-flash", assignedAt: "2026-10-21T00:00:02Z" },
    gamma: { model: "gc@glm-4.7", assignedAt: "2026-10-21T00:00:03Z" },
  },
  shuffleOrder: ["alpha", "beta", "gamma"],
};

function pane(overrides: Partial<PaneResult>): PaneResult {
  return {
    pane: 0,
    state: "completed",
    exitCode: 0,
    dead: false,
    response: "ok",
    ...overrides,
  };
}

function failuresBlock(report: string): string {
  const start = report.indexOf("## Failures Detected");
  expect(start).toBeGreaterThanOrEqual(0);
  return report.slice(start);
}

// ─── Unit: buildTeamStatus (the grid producer) ────────────────────────────────

describe("#578 buildTeamStatus attaches grid failure details", () => {
  it("a FAILED pane carries error: pane model id, honest notice, no advertised path/cwd", () => {
    const status = buildTeamStatus(manifest, "2026-10-21T00:00:00Z", [
      pane({ pane: 0, state: "failed", exitCode: 3, model: "deepseek/deepseek-r1" }),
      pane({ pane: 1, state: "completed", exitCode: 0 }),
    ]);
    const err = status.models.alpha.error;
    expect(err).toBeDefined();
    expect(err!.model).toBe("deepseek/deepseek-r1");
    expect(err!.command).toContain("grid");
    expect(err!.stderrSnippet).toContain("not captured in grid mode");
    expect(err!.errorLogPath).toBe("");
    expect(err!.workDir).toBe("");
    // completed neighbour stays detail-free
    expect(status.models.beta.error).toBeUndefined();
  });

  it("falls back to the manifest model id when the pane result carries none", () => {
    const status = buildTeamStatus(manifest, "2026-10-21T00:00:00Z", [
      pane({ pane: 0, state: "failed", exitCode: 1 }),
    ]);
    expect(status.models.alpha.error!.model).toBe("or@deepseek/deepseek-r1");
  });

  it("a pane with no magmux data (TIMEOUT) carries no error either", () => {
    const status = buildTeamStatus(manifest, "2026-10-21T00:00:00Z", null);
    expect(status.models.gamma.state).toBe("TIMEOUT");
    expect(status.models.gamma.error).toBeUndefined();
  });
});

// ─── Renderer: the `## Failures Detected` block, scoped ──────────────────────

describe("#578 formatTeamResult renders grid failure details", () => {
  let report: string;

  beforeAll(() => {
    const status: TeamStatus = buildTeamStatus(manifest, "2026-10-21T00:00:00Z", [
      pane({ pane: 0, state: "failed", exitCode: 3, model: "deepseek/deepseek-r1" }),
      pane({ pane: 1, state: "completed", exitCode: 0 }),
      pane({ pane: 2, state: "completed", exitCode: 0 }),
    ]);
    report = formatTeamResult(status, "/sess");
  });

  it("renders the `**Error output:**` line with the honest grid notice", () => {
    const block = failuresBlock(report);
    expect(block).toContain("**Model:** deepseek/deepseek-r1");
    expect(block).toContain("**Error output:**");
    expect(block).toContain("not captured in grid mode");
  });

  it("never advertises an error log or a working directory it does not have", () => {
    const block = failuresBlock(report);
    expect(block).not.toContain("**Full error log:**");
    expect(block).not.toContain("**Working directory:**");
  });

  it("still names the failing model and its exit code", () => {
    const block = failuresBlock(report);
    expect(block).toContain("**Exit code:** 3");
    expect(block).toContain("FAILED");
  });
});
