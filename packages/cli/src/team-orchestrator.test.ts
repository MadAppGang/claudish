/**
 * Black box tests for team-orchestrator.ts
 *
 * Tests are derived from:
 *   - requirements.md: FR3 (file convention), FR4 (anonymous IDs / shuffle),
 *     FR5 (per-model work dirs), FR6 (status tracking), FR8 (model list)
 *   - architecture.md: public API signatures, manifest.json schema,
 *     status.json schema, security (path validation), revision #5 (zero-padded IDs)
 *
 * Most runModels and judgeResponses behavior lives in integration tests; this file
 * keeps hermetic pane runs (the fake interactive child in a real headless magmux) to
 * pin the manifest identity, the pane argv and the per-slot environment.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UPSTREAM_ERROR_LOG_ENV } from "./handlers/shared/upstream-error-capture.js";
import type { ModelStatus, TeamManifest, TeamStatus, VoteResult } from "./team-orchestrator.js";
import {
  MAGMUX,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  paneRunOptions,
  teamDirOf,
} from "./test-helpers/team-pane.js";

// ─── Dynamic imports (resolved at runtime so the module doesn't need to exist
//     until the tests actually run) ──────────────────────────────────────────

async function getOrchestrator() {
  return import("./team-orchestrator.js");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a fresh isolated temp directory for each test. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "team-orch-test-"));
}

/** Parse JSON file from disk, or return null on failure. */
function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

// ─── Test state ───────────────────────────────────────────────────────────────

let tempDir: string;

/** The hermetic pane env of the current pane test (set by `usePaneHooks`). */
let t: PaneTestEnv;

/** Per-test pane env, and the no-orphan check after every pane test. */
function usePaneHooks(): void {
  beforeEach(() => {
    t = makePaneTestEnv();
  });
  afterEach(async () => {
    const report = await finishPaneTest(t);
    expect(report).toEqual({ processes: [], files: [] });
  });
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("team-orchestrator", () => {
  describe("snippetHeadAndTail", () => {
    it("returns short text unchanged without an elision marker", async () => {
      const { snippetHeadAndTail } = await getOrchestrator();
      const text = "Short diagnostic output\nwith its original line breaks.";

      expect(snippetHeadAndTail(text)).toBe(text);
      expect(snippetHeadAndTail(text)).not.toContain("bytes omitted");
    });

    it("keeps the first 600 and last 1400 bytes and reports the omitted count", async () => {
      const { snippetHeadAndTail } = await getOrchestrator();
      const head = "H".repeat(600);
      const omitted = "M".repeat(37);
      const tail = "T".repeat(1400);

      expect(snippetHeadAndTail(`${head}${omitted}${tail}`)).toBe(
        `${head}\n\n… [37 bytes omitted] …\n\n${tail}`
      );
    });

    it("preserves a bolded FAIL verdict near-miss from the head of a long response", async () => {
      const { snippetHeadAndTail } = await getOrchestrator();
      const verdict = "**Verdict**: **FAIL**";
      const response = `${verdict}\n${"Detailed analysis without a matching verdict. ".repeat(80)}Unrelated tail prose.`;

      expect(response.match(/\*\*Verdict\*\*: (PASS|CONDITIONAL|FAIL)/)).toBeNull();
      expect(snippetHeadAndTail(response)).toContain(verdict);
      expect(snippetHeadAndTail(response)).toContain("Unrelated tail prose.");
    });
  });
  // ── FR3 / FR5: Directory structure ────────────────────────────────────────

  describe("setupSession — directory structure", () => {
    it("TEST-01: creates work/ and errors/ subdirectories", async () => {
      const { setupSession } = await getOrchestrator();

      setupSession(tempDir, ["model-a", "model-b"], "task content");

      expect(existsSync(join(tempDir, "work"))).toBe(true);
      expect(existsSync(join(tempDir, "errors"))).toBe(true);
    });

    it("TEST-02: creates one work subdirectory per model", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-a", "model-b", "model-c"];

      setupSession(tempDir, models, "task content");

      const workEntries = readdirSync(join(tempDir, "work"));
      expect(workEntries.length).toBe(models.length);
    });
  });

  // ── FR4: manifest.json ────────────────────────────────────────────────────

  describe("setupSession — manifest.json", () => {
    it("TEST-03: manifest.json has correct number of model entries", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["m1", "m2", "m3", "m4"];

      setupSession(tempDir, models, "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      expect(Object.keys(manifest.models).length).toBe(models.length);
    });

    it("TEST-04: anonymous IDs are zero-padded numeric strings (01, 02, ...)", async () => {
      // Architecture revision #5: use zero-padded numeric IDs to support >26 models
      const { setupSession } = await getOrchestrator();

      setupSession(tempDir, ["model-a", "model-b", "model-c"], "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      const ids = Object.keys(manifest.models);

      const zeroPaddedNumeric = /^\d{2,}$/;
      for (const id of ids) {
        expect(zeroPaddedNumeric.test(id)).toBe(true);
      }
    });

    it("TEST-05: manifest model entries contain all provided model names", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-alpha", "model-beta"];

      setupSession(tempDir, models, "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      const storedModelNames = Object.values(manifest.models).map((e) => e.model);

      // Order may differ due to shuffle; use set equality
      expect(storedModelNames.sort()).toEqual(models.sort());
    });

    it("TEST-06: manifest.json has a valid ISO 8601 created timestamp", async () => {
      const { setupSession } = await getOrchestrator();

      setupSession(tempDir, ["model-a"], "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      expect(typeof manifest.created).toBe("string");
      const parsed = new Date(manifest.created);
      // A valid ISO date parses without NaN
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    });

    it("TEST-07: shuffle produces different order across multiple runs (statistical)", async () => {
      // With 6 models, probability of all 20 runs preserving original order is
      // (1/720)^20 ≈ 10^{-57} — effectively impossible if shuffle is implemented.
      const { setupSession } = await getOrchestrator();
      const models = ["m1", "m2", "m3", "m4", "m5", "m6"];

      // Collect the model-name arrays as ordered by the anonymous ID keys across runs
      const orderings: string[][] = [];

      for (let run = 0; run < 20; run++) {
        const runDir = mkdtempSync(join(tmpdir(), "team-shuffle-"));
        try {
          setupSession(runDir, models, "task");
          const manifest = readJson<TeamManifest>(join(runDir, "manifest.json"));
          // Sort by anonymous ID key to get a deterministic ordering per run
          const ordering = Object.keys(manifest.models)
            .sort()
            .map((k) => manifest.models[k].model);
          orderings.push(ordering);
        } finally {
          rmSync(runDir, { recursive: true, force: true });
        }
      }

      // At least one run should produce a different ordering from the first
      const first = orderings[0].join(",");
      const allIdentical = orderings.every((o) => o.join(",") === first);
      expect(allIdentical).toBe(false);
    });
  });

  // ── FR6: status.json ──────────────────────────────────────────────────────

  describe("setupSession — status.json", () => {
    it("TEST-08: all models start STARTING in status.json (the closed set has no PENDING)", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-a", "model-b", "model-c"];

      setupSession(tempDir, models, "task");

      const status = readJson<TeamStatus>(join(tempDir, "status.json"));
      const states = Object.values(status.models).map((m) => m.state);
      expect(states.every((s) => s === "STARTING")).toBe(true);
    });

    it("TEST-09: status.json model count matches input models array length", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["m1", "m2", "m3", "m4", "m5"];

      setupSession(tempDir, models, "task");

      const status = readJson<TeamStatus>(join(tempDir, "status.json"));
      expect(Object.keys(status.models).length).toBe(models.length);
    });
  });

  // ── FR3: input.md handling ────────────────────────────────────────────────

  describe("setupSession — input.md", () => {
    it("TEST-10: writes input.md with provided input text", async () => {
      const { setupSession } = await getOrchestrator();
      const inputText = "test task content for model evaluation";

      setupSession(tempDir, ["model-a"], inputText);

      const written = readFileSync(join(tempDir, "input.md"), "utf-8");
      expect(written).toBe(inputText);
    });

    it("TEST-11: succeeds when input.md already exists and no input text given", async () => {
      const { setupSession } = await getOrchestrator();
      const preExisting = "pre-existing task description";
      writeFileSync(join(tempDir, "input.md"), preExisting, "utf-8");

      // Must not throw
      expect(() => setupSession(tempDir, ["model-a"])).not.toThrow();

      // input.md content must be preserved
      const content = readFileSync(join(tempDir, "input.md"), "utf-8");
      expect(content).toBe(preExisting);
    });

    it("TEST-12: throws when no input.md exists and no input text is provided", async () => {
      const { setupSession } = await getOrchestrator();

      // No input.md in tempDir, no input argument
      expect(() => setupSession(tempDir, ["model-a"])).toThrow();
    });
  });

  // ── FR8: input validation — empty models ──────────────────────────────────

  // Moved from the deleted team-timeout-repro.test.ts (its bug #3).
  describe("setupSession — session directory overwrite protection", () => {
    it("rejects an existing session directory", async () => {
      const { setupSession } = await getOrchestrator();
      setupSession(tempDir, ["model-a"], "First run input");
      expect(() => setupSession(tempDir, ["model-b"], "Second run input")).toThrow(
        /Session already exists/
      );
    });

    it("preserves the session artifacts when a re-run is rejected", async () => {
      const { setupSession } = await getOrchestrator();
      setupSession(tempDir, ["model-a"], "First run input");
      const originalManifest = readFileSync(join(tempDir, "manifest.json"), "utf-8");
      const originalInput = readFileSync(join(tempDir, "input.md"), "utf-8");
      const originalStatus = readFileSync(join(tempDir, "status.json"), "utf-8");

      expect(() => setupSession(tempDir, ["model-b"], "DIFFERENT input")).toThrow();

      expect(readFileSync(join(tempDir, "manifest.json"), "utf-8")).toBe(originalManifest);
      expect(readFileSync(join(tempDir, "input.md"), "utf-8")).toBe(originalInput);
      expect(readFileSync(join(tempDir, "status.json"), "utf-8")).toBe(originalStatus);
    });
  });

  describe("setupSession — input validation", () => {
    it("TEST-13: throws for an empty models array", async () => {
      const { setupSession } = await getOrchestrator();

      expect(() => setupSession(tempDir, [], "task")).toThrow();
    });
  });

  // ── Native model slots ─────────────────────────────────────────────────────
  // Was "sentinel model rejection" (91ee9a8). That guard existed because
  // `internal`/`default` reached Claude Code as literal model names and it
  // "failed with cryptic model not found errors". The cause is fixed at the
  // `--model` boundary now (normalizeNativeModelSpec), and a native name is a
  // runnable slot — verified end to end: a team run with ["internal"] completed
  // exit 0 having spawned `claudish --model opus …`, and the same run with a
  // prompt that produced no vote block was reported EMPTY/shape_mismatch rather
  // than succeeded. Rejecting here would put the internal reviewer back outside
  // requirePattern, which is the guard that catches a voter that never voted.

  describe("setupSession — native model slots", () => {
    it("TEST-NS-01: accepts 'internal' as a runnable slot", async () => {
      const { setupSession } = await getOrchestrator();

      const manifest = setupSession(tempDir, ["internal"], "task");
      expect(Object.values(manifest.models).map((m) => m.model)).toEqual(["internal"]);
    });

    it("TEST-NS-02: accepts 'default' as a runnable slot", async () => {
      const { setupSession } = await getOrchestrator();

      const manifest = setupSession(tempDir, ["default"], "task");
      expect(Object.values(manifest.models).map((m) => m.model)).toEqual(["default"]);
    });

    it("TEST-NS-03: accepts Claude tier names (opus, sonnet, haiku)", async () => {
      const { setupSession } = await getOrchestrator();

      const manifest = setupSession(tempDir, ["opus", "sonnet", "haiku"], "task");
      expect(
        Object.values(manifest.models)
          .map((m) => m.model)
          .sort()
      ).toEqual(["haiku", "opus", "sonnet"]);
    });

    it("TEST-NS-04: accepts claude-* model IDs", async () => {
      const { setupSession } = await getOrchestrator();

      const manifest = setupSession(
        tempDir,
        ["claude-sonnet-4-6", "claude-3-opus-20240229"],
        "task"
      );
      expect(Object.values(manifest.models).map((m) => m.model)).toEqual([
        "claude-sonnet-4-6",
        "claude-3-opus-20240229",
      ]);
    });

    it("TEST-NS-05: preserves the caller's casing as the slot identity", async () => {
      const { setupSession } = await getOrchestrator();

      // The manifest is the run's identity and is echoed back in status//errors,
      // so it keeps the string the caller passed. Normalization happens in the
      // CHILD, at its own --model boundary.
      const manifest = setupSession(tempDir, ["Internal"], "task");
      expect(Object.values(manifest.models).map((m) => m.model)).toEqual(["Internal"]);
    });

    it("TEST-NS-06: accepts a native slot alongside external models in one manifest", async () => {
      const { setupSession } = await getOrchestrator();

      const manifest = setupSession(tempDir, ["gemini-2.0-flash", "internal", "gpt-4o"], "task");
      expect(Object.keys(manifest.models)).toHaveLength(3);
      expect(Object.values(manifest.models).map((m) => m.model)).toContain("internal");
    });

    it("TEST-NS-07: accepts valid external model names", async () => {
      const { setupSession } = await getOrchestrator();

      // These should NOT throw
      const manifest = setupSession(
        tempDir,
        ["gemini-2.0-flash", "gpt-4o", "or@deepseek/deepseek-r1"],
        "task"
      );
      expect(manifest).toBeDefined();
      expect(Object.keys(manifest.models)).toHaveLength(3);
    });
  });

  // ── Security: validateSessionPath ─────────────────────────────────────────

  describe("validateSessionPath", () => {
    it("TEST-14: throws when path resolves outside CWD", async () => {
      const { validateSessionPath } = await getOrchestrator();

      // /tmp is virtually always outside CWD (which is the project directory)
      const outsidePath = "/tmp/definitely-outside-cwd-test-path";

      // Only run if /tmp is actually outside CWD
      if (!resolve(outsidePath).startsWith(process.cwd())) {
        expect(() => validateSessionPath(outsidePath)).toThrow();
      } else {
        // CWD is /tmp or a subdir — skip this particular check
        console.warn("Skipping TEST-14: /tmp is inside CWD, cannot test outside-CWD rejection");
      }
    });

    it("TEST-15: accepts a path that resolves within CWD and returns resolved path", async () => {
      const { validateSessionPath } = await getOrchestrator();

      // Use a subdir of CWD that we know exists
      const insidePath = join(process.cwd(), "packages");

      const result = validateSessionPath(insidePath);

      // Should return the resolved absolute path without throwing
      expect(typeof result).toBe("string");
      expect(result.startsWith(process.cwd())).toBe(true);
    });
  });

  // ── FR6: getStatus ────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("TEST-16: returns parsed status.json with STARTING state after setupSession", async () => {
      const { setupSession, getStatus } = await getOrchestrator();

      setupSession(tempDir, ["model-a", "model-b"], "task");

      const status = getStatus(tempDir);

      expect(status).toBeDefined();
      expect(typeof status.models).toBe("object");

      const states = Object.values(status.models).map((m: ModelStatus) => m.state);
      expect(states.every((s) => s === "STARTING")).toBe(true);
    });

    it("TEST-17: getStatus throws when status.json does not exist", async () => {
      const { getStatus } = await getOrchestrator();

      // tempDir exists but has no status.json
      expect(() => getStatus(tempDir)).toThrow();
    });
  });

  describe.skipIf(!MAGMUX)("runModels on panes — spawn identity and argv", () => {
    usePaneHooks();

    it("keeps manifest identity and launches an interactive child with the pane argv", async () => {
      const { runModels, setupSession } = await getOrchestrator();
      const spawnPlanner = mock(async () => ({
        pinned: new Map([["vendor/model", "fake-env_probe"]]),
      }));
      const probe = join(t.tmp, "probe-{session}.json");
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["vendor/model"], "Analyze this input");

      const status = await runModels(sessionPath, {
        ...paneRunOptions(t, {}, { FAKE_PROBE_FILE: probe }),
        spawnPlanner,
      });
      const [anonId, slot] = Object.entries(status.models)[0] ?? [];
      expect(slot?.state).toBe("COMPLETED");
      expect(spawnPlanner).toHaveBeenCalledWith(["vendor/model"]);
      expect(slot?.model).toBe("vendor/model");
      expect(slot?.spawnModel).toBe("fake-env_probe");

      const { argv } = readJson<{ argv: string[] }>(
        probe.replace("{session}", slot?.sessionUuid as string)
      );
      // -i --model <spawnModel> -y --quiet --session-id <uuid> --add-dir <turn dir>
      expect(argv.slice(0, 6)).toEqual([
        "-i",
        "--model",
        "fake-env_probe",
        "-y",
        "--quiet",
        "--session-id",
      ]);
      expect(argv[6]).toBe(slot?.sessionUuid as string);
      expect(argv[7]).toBe("--add-dir");
      for (const banned of ["-p", "--print", "--stdin", "--output-format", "--verbose", "--json"])
        expect(argv).not.toContain(banned);

      // The manifest identity is re-used by the judge round; the pinned argv must never
      // replace it with the provider wire spec.
      const reread = readJson<TeamManifest>(join(sessionPath, "manifest.json"));
      expect(reread.models[anonId as string]?.model).toBe("vendor/model");
    }, 30_000);

    it("gives every model slot its own upstream-error log and token file", async () => {
      const { runModels, setupSession } = await getOrchestrator();
      const probe = join(t.tmp, "probe-{session}.json");
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-env_probe-1", "fake-env_probe-2"], "Analyze this input");

      const status = await runModels(
        sessionPath,
        paneRunOptions(t, {}, { FAKE_PROBE_FILE: probe })
      );

      const paths = Object.entries(status.models).map(([anonId, m]) => {
        expect(m.state).toBe("COMPLETED");
        const { env } = readJson<{ env: Record<string, string> }>(
          probe.replace("{session}", m.sessionUuid as string)
        );
        const path = env[UPSTREAM_ERROR_LOG_ENV];
        expect(path).toBe(join(sessionPath, "errors", `${anonId}-upstream.jsonl`));
        expect(env.CLAUDISH_TOKEN_FILE).toBe(join(sessionPath, "stats", `${anonId}.json`));
        return path;
      });
      expect(new Set(paths).size).toBe(paths.length);
    }, 30_000);

    it("omits upstreamErrorLogPath from a recorded error when the child wrote no file", async () => {
      const { runModels, setupSession } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-exit_mid_turn"], "Analyze this input");
      await runModels(sessionPath, paneRunOptions(t));

      const recorded = readJson<TeamStatus>(join(sessionPath, "status.json"));
      const [anonId, modelStatus] = Object.entries(recorded.models)[0] ?? [];
      expect(modelStatus?.state).toBe("FAILED");
      expect(modelStatus?.error?.reason).toBe("child_exited");
      expect(modelStatus?.error).not.toHaveProperty("upstreamErrorLogPath");
      expect(existsSync(join(sessionPath, "errors", `${anonId}-upstream.jsonl`))).toBe(false);
      expect(existsSync(join(sessionPath, "errors", `${anonId}.log`))).toBe(true);
    }, 30_000);
  });

  describe.skipIf(!MAGMUX)("startModels on panes — team policy", () => {
    usePaneHooks();
    const TWO_LINES = "Review the change below.\nReply starting with VERDICT:.";

    it("returns once every slot left STARTING (D9)", async () => {
      const { startModels, setupSession, getStatus } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["contract-fake-a", "contract-fake-b"], "@@HANG@@ hold");
      const handle = await startModels(sessionPath, paneRunOptions(t));
      const states = Object.values(getStatus(sessionPath).models).map((m) => m.state);
      expect(states).toEqual(["RUNNING", "RUNNING"]);
      const { cancelTeamRun } = await getOrchestrator();
      await cancelTeamRun(sessionPath);
      await handle.done;
    }, 30_000);

    it("fails a slot that stops on a question team cannot answer: FAILED blocked (D19)", async () => {
      const { runModels, setupSession } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-ask_user"], "Pick a fruit.");
      const status = await runModels(sessionPath, paneRunOptions(t));
      const [id, m] = Object.entries(status.models)[0] ?? [];
      expect(m?.state).toBe("FAILED");
      expect(m?.error?.reason).toBe("blocked");
      expect(m?.error?.detail.length).toBeGreaterThan(0);
      // The answer so far is kept for inspection.
      expect(existsSync(join(sessionPath, `response-${id}.md`))).toBe(true);
    }, 30_000);

    it("matches ^VERDICT: on the answer that starts after the task file was read (§2.13)", async () => {
      const { runModels, setupSession } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-narrate_then_read"], TWO_LINES);
      const status = await runModels(
        sessionPath,
        paneRunOptions(t, { requirePattern: "^VERDICT:" })
      );
      const [id, m] = Object.entries(status.models)[0] ?? [];
      expect(m?.state).toBe("COMPLETED");
      // The narration before the Read never reaches response-<id>.md.
      expect(readFileSync(join(sessionPath, `response-${id}.md`), "utf-8")).toBe("VERDICT: ok");
    }, 30_000);

    it("fails a slot that never read its task file: FAILED prompt_not_read", async () => {
      const { runModels, setupSession } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-no_read"], TWO_LINES);
      const status = await runModels(sessionPath, paneRunOptions(t));
      const m = Object.values(status.models)[0];
      expect(m?.state).toBe("FAILED");
      expect(m?.error?.reason).toBe("prompt_not_read");
      expect(m?.error?.detail).toContain("never read");
    }, 30_000);

    it("fails a slot whose child refuses --agent: FAILED agent_rejected (D11)", async () => {
      const { runModels, setupSession } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-answer"], "Reply with exactly PEAR");
      const status = await runModels(
        sessionPath,
        paneRunOptions(t, { claudeFlags: ["--agent", "zzz-missing"] })
      );
      const m = Object.values(status.models)[0];
      expect(m?.state).toBe("FAILED");
      expect(m?.error?.reason).toBe("agent_rejected");
    }, 30_000);

    it("names an open background shell in the slot's anomalies (R3-M5)", async () => {
      const { runModels, setupSession } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-bg_server"], "Start the dev server.");
      const status = await runModels(sessionPath, paneRunOptions(t));
      const m = Object.values(status.models)[0];
      expect(m?.state).toBe("COMPLETED");
      expect(m?.anomalies?.some((a) => a.startsWith("background_shell_open: "))).toBe(true);
    }, 30_000);

    it("refuses reserved claude_flags before anything is written or spawned", async () => {
      const { startModels, setupSession } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-answer"], "Reply with exactly PEAR");
      await expect(
        startModels(sessionPath, paneRunOptions(t, { claudeFlags: ["--max-budget-usd", "5"] }))
      ).rejects.toThrow(/^invalid_args: .*--max-budget-usd/);
      await expect(
        startModels(
          sessionPath,
          paneRunOptions(t, { claudeFlags: ["--allowedTools", "Read", "Bash"] })
        )
      ).rejects.toThrow(/^invalid_args: .*positional/);
      expect(existsSync(join(t.sockRoot, "panes"))).toBe(false);
    });

    it("refuses a non-plain prompt when the flags remove Read (§2.3 rule 4)", async () => {
      const { startModels, setupSession } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-answer"], TWO_LINES);
      await expect(
        startModels(sessionPath, paneRunOptions(t, { claudeFlags: ["--disallowedTools", "Read"] }))
      ).rejects.toThrow(/^invalid_args: .*Read tool is unavailable/);
    });
  });

  describe.skipIf(!MAGMUX)("runModels on panes — the whole turn is the answer", () => {
    usePaneHooks();

    it("keeps the voted answer AND the message a re-wake added after it", async () => {
      // Print mode kept only the final assistant message, so a late message replaced the
      // vote. A pane turn settles on Claude Code's own turn_duration, after the re-wake,
      // and its answer is every assistant text block of the turn.
      const { runModels, setupSession } = await getOrchestrator();
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-rewake"], "Review and vote.");
      const status = await runModels(sessionPath, {
        ...paneRunOptions(
          t,
          { requirePattern: "^ANSWER fake-rewake " },
          { FAKE_GAP_MS_REWAKE: "1000" }
        ),
        paneTimings: { replStableMs: 200, secondaryQuietMs: 4_000 },
      });

      const [id, model] = Object.entries(status.models)[0] ?? [];
      const response = readFileSync(join(sessionPath, `response-${id}.md`), "utf-8");
      expect(model?.state).toBe("COMPLETED");
      expect(response).toStartWith("ANSWER fake-rewake ");
      expect(response).toEndWith("\n\nLATE second message");
      expect(model?.outputSize).toBe(Buffer.byteLength(response));
    }, 30_000);
  });

  describe("runModels — requirePattern validation", () => {
    it("rejects an invalid pattern before reading manifest.json", async () => {
      const { runModels } = await getOrchestrator();

      // tempDir deliberately exists without a manifest. The pattern error must
      // win before any filesystem read or child-process work can begin.
      await expect(runModels(tempDir, { requirePattern: "(" })).rejects.toThrow(
        /^Invalid requirePattern \/\(/
      );
    });
  });

  // ── Directory names match manifest IDs ───────────────────────────────────

  describe("setupSession — work directory names", () => {
    it("TEST-18: work directory names match manifest model IDs exactly", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-a", "model-b", "model-c"];

      setupSession(tempDir, models, "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      const manifestIds = Object.keys(manifest.models).sort();
      const workDirNames = readdirSync(join(tempDir, "work")).sort();

      expect(workDirNames).toEqual(manifestIds);
    });
  });

  // ── shuffleOrder in manifest ──────────────────────────────────────────────

  describe("setupSession — shuffleOrder in manifest", () => {
    it("TEST-19: manifest contains shuffleOrder field with correct length", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-a", "model-b", "model-c", "model-d"];

      setupSession(tempDir, models, "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));

      expect(Array.isArray(manifest.shuffleOrder)).toBe(true);
      expect(manifest.shuffleOrder!.length).toBe(models.length);
    });

    it("TEST-20: shuffleOrder contains all manifest IDs", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-a", "model-b", "model-c"];

      setupSession(tempDir, models, "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      const manifestIds = Object.keys(manifest.models).sort();

      expect([...manifest.shuffleOrder!].sort()).toEqual(manifestIds);
    });
  });

  // ── validateSessionPath: security ────────────────────────────────────────

  describe("validateSessionPath — additional security", () => {
    it("TEST-21: deterministic outside-CWD path throws", async () => {
      const { validateSessionPath } = await getOrchestrator();

      const outsidePath = resolve(process.cwd(), "..", "sibling-dir-that-does-not-exist");
      expect(() => validateSessionPath(outsidePath)).toThrow();
    });

    it("TEST-22: path traversal sequence ../../etc/hosts throws", async () => {
      const { validateSessionPath } = await getOrchestrator();

      expect(() => validateSessionPath("../../etc/hosts")).toThrow();
    });
  });

  // ── judgeResponses: threshold ─────────────────────────────────────────────

  describe("judgeResponses — minimum responses", () => {
    it("TEST-23: throws when fewer than 2 response files are present", async () => {
      const { setupSession, judgeResponses } = await getOrchestrator();

      // Set up a session with two models but only write one response file
      setupSession(tempDir, ["model-a", "model-b"], "task");
      writeFileSync(join(tempDir, "response-01.md"), "Only one response", "utf-8");

      await expect(judgeResponses(tempDir)).rejects.toThrow("Need at least 2 responses");
    });
  });
});

// ─── Pure function unit tests ─────────────────────────────────────────────────

describe("fisherYatesShuffle", () => {
  async function getShuffle() {
    const { fisherYatesShuffle } = await getOrchestrator();
    return fisherYatesShuffle;
  }

  it("TEST-S1: empty array returns empty array without crash", async () => {
    const shuffle = await getShuffle();
    expect(shuffle([])).toEqual([]);
  });

  it("TEST-S2: single-element array returns same element", async () => {
    const shuffle = await getShuffle();
    expect(shuffle([42])).toEqual([42]);
  });

  it("TEST-S4: output is a permutation (sorted equals sorted input)", async () => {
    const shuffle = await getShuffle();
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const result = shuffle([...input]);
    expect([...result].sort((a, b) => a - b)).toEqual([...input].sort((a, b) => a - b));
  });
});

describe("buildJudgePrompt", () => {
  async function getBuilder() {
    const { buildJudgePrompt } = await getOrchestrator();
    return buildJudgePrompt;
  }

  it("TEST-B1: contains the original input text", async () => {
    const build = await getBuilder();
    const prompt = build("my task description", { "01": "response body" });
    expect(prompt).toContain("my task description");
  });

  it("TEST-B2: contains all response IDs", async () => {
    const build = await getBuilder();
    const prompt = build("task", { "01": "resp-one", "02": "resp-two", "03": "resp-three" });
    expect(prompt).toContain("01");
    expect(prompt).toContain("02");
    expect(prompt).toContain("03");
  });

  it("TEST-B3: contains the vote block template", async () => {
    const build = await getBuilder();
    const prompt = build("task", { "01": "resp" });
    expect(prompt).toContain("```vote");
    expect(prompt).toContain("RESPONSE:");
    expect(prompt).toContain("VERDICT:");
    expect(prompt).toContain("CONFIDENCE:");
    expect(prompt).toContain("KEY_ISSUES:");
  });

  it("TEST-B4: contains correct number of response sections", async () => {
    const build = await getBuilder();
    const responses = { "01": "first", "02": "second", "03": "third" };
    const prompt = build("task", responses);
    // Each response has a "#### Response XX" heading
    const sectionMatches = prompt.match(/#### Response \d+/g);
    expect(sectionMatches?.length).toBe(3);
  });
});

describe("aggregateVerdict", () => {
  async function getAggregate() {
    const { aggregateVerdict } = await getOrchestrator();
    return aggregateVerdict;
  }

  it("TEST-A1: all APPROVE → score 1.0", async () => {
    const aggregate = await getAggregate();
    const votes: VoteResult[] = [
      {
        judgeId: "j1",
        responseId: "01",
        verdict: "APPROVE",
        confidence: 9,
        summary: "good",
        keyIssues: [],
      },
      {
        judgeId: "j2",
        responseId: "01",
        verdict: "APPROVE",
        confidence: 8,
        summary: "good",
        keyIssues: [],
      },
    ];
    const verdict = aggregate(votes, ["01"]);
    expect(verdict.responses["01"].score).toBe(1.0);
    expect(verdict.responses["01"].approvals).toBe(2);
    expect(verdict.responses["01"].rejections).toBe(0);
  });

  it("TEST-A2: all REJECT → score 0.0", async () => {
    const aggregate = await getAggregate();
    const votes: VoteResult[] = [
      {
        judgeId: "j1",
        responseId: "01",
        verdict: "REJECT",
        confidence: 3,
        summary: "bad",
        keyIssues: [],
      },
      {
        judgeId: "j2",
        responseId: "01",
        verdict: "REJECT",
        confidence: 2,
        summary: "bad",
        keyIssues: [],
      },
    ];
    const verdict = aggregate(votes, ["01"]);
    expect(verdict.responses["01"].score).toBe(0.0);
  });

  it("TEST-A3: mixed votes → correct percentages", async () => {
    const aggregate = await getAggregate();
    const votes: VoteResult[] = [
      {
        judgeId: "j1",
        responseId: "01",
        verdict: "APPROVE",
        confidence: 8,
        summary: "ok",
        keyIssues: [],
      },
      {
        judgeId: "j2",
        responseId: "01",
        verdict: "APPROVE",
        confidence: 7,
        summary: "ok",
        keyIssues: [],
      },
      {
        judgeId: "j3",
        responseId: "01",
        verdict: "REJECT",
        confidence: 4,
        summary: "no",
        keyIssues: [],
      },
    ];
    const verdict = aggregate(votes, ["01"]);
    // 2 approvals / (2 + 1 rejections) = 2/3
    expect(verdict.responses["01"].score).toBeCloseTo(2 / 3, 5);
    expect(verdict.responses["01"].approvals).toBe(2);
    expect(verdict.responses["01"].rejections).toBe(1);
  });

  it("TEST-A4: all ABSTAIN → score 0 (total=0 branch)", async () => {
    const aggregate = await getAggregate();
    const votes: VoteResult[] = [
      {
        judgeId: "j1",
        responseId: "01",
        verdict: "ABSTAIN",
        confidence: 5,
        summary: "unclear",
        keyIssues: [],
      },
    ];
    const verdict = aggregate(votes, ["01"]);
    expect(verdict.responses["01"].score).toBe(0);
    expect(verdict.responses["01"].abstentions).toBe(1);
  });

  it("TEST-A5: single response works correctly", async () => {
    const aggregate = await getAggregate();
    const votes: VoteResult[] = [
      {
        judgeId: "j1",
        responseId: "99",
        verdict: "APPROVE",
        confidence: 10,
        summary: "great",
        keyIssues: [],
      },
    ];
    const verdict = aggregate(votes, ["99"]);
    expect(verdict.ranking).toEqual(["99"]);
    expect(verdict.responses["99"].score).toBe(1.0);
  });

  it("TEST-A6: ranking is sorted by score descending", async () => {
    const aggregate = await getAggregate();
    const votes: VoteResult[] = [
      // "01" gets 1 approval, 1 rejection → 0.5
      {
        judgeId: "j1",
        responseId: "01",
        verdict: "APPROVE",
        confidence: 7,
        summary: "ok",
        keyIssues: [],
      },
      {
        judgeId: "j2",
        responseId: "01",
        verdict: "REJECT",
        confidence: 4,
        summary: "meh",
        keyIssues: [],
      },
      // "02" gets 2 approvals → 1.0
      {
        judgeId: "j1",
        responseId: "02",
        verdict: "APPROVE",
        confidence: 9,
        summary: "great",
        keyIssues: [],
      },
      {
        judgeId: "j2",
        responseId: "02",
        verdict: "APPROVE",
        confidence: 8,
        summary: "great",
        keyIssues: [],
      },
      // "03" gets 0 approvals, 2 rejections → 0.0
      {
        judgeId: "j1",
        responseId: "03",
        verdict: "REJECT",
        confidence: 2,
        summary: "bad",
        keyIssues: [],
      },
      {
        judgeId: "j2",
        responseId: "03",
        verdict: "REJECT",
        confidence: 1,
        summary: "bad",
        keyIssues: [],
      },
    ];
    const verdict = aggregate(votes, ["01", "02", "03"]);
    expect(verdict.ranking[0]).toBe("02"); // score 1.0
    expect(verdict.ranking[1]).toBe("01"); // score 0.5
    expect(verdict.ranking[2]).toBe("03"); // score 0.0
  });
});

describe("parseJudgeVotes", () => {
  let judgeDir: string;

  beforeEach(() => {
    judgeDir = mkdtempSync(join(tmpdir(), "judge-votes-test-"));
  });

  afterEach(() => {
    if (judgeDir && existsSync(judgeDir)) {
      rmSync(judgeDir, { recursive: true, force: true });
    }
  });

  async function getParser() {
    const { parseJudgeVotes } = await getOrchestrator();
    return parseJudgeVotes;
  }

  function writeResponse(filename: string, content: string) {
    writeFileSync(join(judgeDir, filename), content, "utf-8");
  }

  function makeVoteBlock(
    responseId: string,
    verdict: string,
    confidence = "8",
    summary = "Looks good",
    keyIssues = "None"
  ): string {
    return `\`\`\`vote\nRESPONSE: ${responseId}\nVERDICT: ${verdict}\nCONFIDENCE: ${confidence}\nSUMMARY: ${summary}\nKEY_ISSUES: ${keyIssues}\n\`\`\``;
  }

  it("TEST-P1: valid single vote block → 1 vote parsed correctly", async () => {
    const parse = await getParser();
    writeResponse("response-01.md", makeVoteBlock("r1", "APPROVE", "9", "Excellent work", "None"));

    const votes = parse(judgeDir, ["r1"]);

    expect(votes.length).toBe(1);
    expect(votes[0].judgeId).toBe("01");
    expect(votes[0].responseId).toBe("r1");
    expect(votes[0].verdict).toBe("APPROVE");
    expect(votes[0].confidence).toBe(9);
    expect(votes[0].summary).toBe("Excellent work");
    expect(votes[0].keyIssues).toEqual([]);
  });

  it("TEST-P2: multiple vote blocks in one file → all parsed", async () => {
    const parse = await getParser();
    const content = [
      makeVoteBlock("r1", "APPROVE"),
      makeVoteBlock("r2", "REJECT"),
      makeVoteBlock("r3", "ABSTAIN"),
    ].join("\n\n");
    writeResponse("response-01.md", content);

    const votes = parse(judgeDir, ["r1", "r2", "r3"]);
    expect(votes.length).toBe(3);
  });

  it("TEST-P3: unknown RESPONSE ID → filtered out (not in responseIds)", async () => {
    const parse = await getParser();
    writeResponse("response-01.md", makeVoteBlock("unknown-id", "APPROVE"));

    const votes = parse(judgeDir, ["r1", "r2"]);
    expect(votes.length).toBe(0);
  });

  it("TEST-P4: missing VERDICT field → vote skipped", async () => {
    const parse = await getParser();
    // Manually write a block without VERDICT
    const block = "```vote\nRESPONSE: r1\nCONFIDENCE: 7\nSUMMARY: Fine\nKEY_ISSUES: None\n```";
    writeResponse("response-01.md", block);

    const votes = parse(judgeDir, ["r1"]);
    expect(votes.length).toBe(0);
  });

  it("TEST-P5: non-numeric CONFIDENCE → defaults to 5", async () => {
    const parse = await getParser();
    // Write a block where CONFIDENCE is non-numeric
    const block =
      "```vote\nRESPONSE: r1\nVERDICT: APPROVE\nCONFIDENCE: high\nSUMMARY: Good\nKEY_ISSUES: None\n```";
    writeResponse("response-01.md", block);

    const votes = parse(judgeDir, ["r1"]);
    // CONFIDENCE regex requires \d+ so it won't match "high" → falls back to default "5"
    expect(votes.length).toBe(1);
    expect(votes[0].confidence).toBe(5);
  });

  it("TEST-P6: KEY_ISSUES 'None' → filtered to empty array", async () => {
    const parse = await getParser();
    writeResponse("response-01.md", makeVoteBlock("r1", "APPROVE", "7", "Summary", "None"));

    const votes = parse(judgeDir, ["r1"]);
    expect(votes[0].keyIssues).toEqual([]);
  });

  it("TEST-P7: KEY_ISSUES with multiple items → split correctly", async () => {
    const parse = await getParser();
    writeResponse(
      "response-01.md",
      makeVoteBlock("r1", "REJECT", "3", "Has issues", "bug in loop, off-by-one, missing test")
    );

    const votes = parse(judgeDir, ["r1"]);
    expect(votes[0].keyIssues).toEqual(["bug in loop", "off-by-one", "missing test"]);
  });

  it("TEST-P8: empty file → 0 votes", async () => {
    const parse = await getParser();
    writeResponse("response-01.md", "");

    const votes = parse(judgeDir, ["r1"]);
    expect(votes.length).toBe(0);
  });
});
