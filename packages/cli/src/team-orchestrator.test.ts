/**
 * Black box tests for team-orchestrator.ts
 *
 * Tests are derived from:
 *   - requirements.md: FR3 (file convention), FR4 (anonymous IDs / shuffle),
 *     FR5 (per-model work dirs), FR6 (status tracking), FR8 (model list)
 *   - architecture.md: public API signatures, manifest.json schema,
 *     status.json schema, security (path validation), revision #5 (zero-padded IDs)
 *
 * Most runModels and judgeResponses behavior lives in integration tests; this
 * file keeps one hermetic fake-child run to pin the manifest identity contract.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelStatus, TeamManifest, TeamStatus, VoteResult } from "./team-orchestrator.js";

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
    it("TEST-08: all models start with PENDING state in status.json", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-a", "model-b", "model-c"];

      setupSession(tempDir, models, "task");

      const status = readJson<TeamStatus>(join(tempDir, "status.json"));
      const states = Object.values(status.models).map((m) => m.state);
      expect(states.every((s) => s === "PENDING")).toBe(true);
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

  describe("setupSession — input validation", () => {
    it("TEST-13: throws for an empty models array", async () => {
      const { setupSession } = await getOrchestrator();

      expect(() => setupSession(tempDir, [], "task")).toThrow();
    });
  });

  // ── Sentinel model rejection ────────────────────────────────────────────
  // REGRESSION: sentinel model names leaked to claudish child processes — Fixed in /dev:fix session dev-fix-20260406-131846-32b9662c

  describe("setupSession — sentinel model rejection", () => {
    it("TEST-17: rejects 'internal' sentinel model", async () => {
      const { setupSession } = await getOrchestrator();

      expect(() => setupSession(tempDir, ["internal"], "task")).toThrow(/internal/i);
    });

    it("TEST-18: rejects 'default' sentinel model", async () => {
      const { setupSession } = await getOrchestrator();

      expect(() => setupSession(tempDir, ["default"], "task")).toThrow(/default/i);
    });

    it("TEST-19: rejects Claude tier sentinels (opus, sonnet, haiku)", async () => {
      const { setupSession } = await getOrchestrator();

      expect(() => setupSession(tempDir, ["opus"], "task")).toThrow(/opus/i);
      expect(() => setupSession(tempDir, ["sonnet"], "task")).toThrow(/sonnet/i);
      expect(() => setupSession(tempDir, ["haiku"], "task")).toThrow(/haiku/i);
    });

    it("TEST-20: rejects claude-* model IDs", async () => {
      const { setupSession } = await getOrchestrator();

      expect(() => setupSession(tempDir, ["claude-sonnet-4-6"], "task")).toThrow(
        /claude-sonnet-4-6/i
      );
      expect(() => setupSession(tempDir, ["claude-3-opus-20240229"], "task")).toThrow(
        /claude-3-opus/i
      );
    });

    it("TEST-21: rejects sentinels case-insensitively", async () => {
      const { setupSession } = await getOrchestrator();

      expect(() => setupSession(tempDir, ["Internal"], "task")).toThrow(/Internal/i);
      expect(() => setupSession(tempDir, ["OPUS"], "task")).toThrow(/OPUS/i);
    });

    it("TEST-22: rejects mixed arrays containing sentinels alongside valid models", async () => {
      const { setupSession } = await getOrchestrator();

      expect(() =>
        setupSession(tempDir, ["gemini-2.0-flash", "internal", "gpt-4o"], "task")
      ).toThrow(/internal/i);
    });

    it("TEST-23: accepts valid external model names", async () => {
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
    it("TEST-16: returns parsed status.json with PENDING state after setupSession", async () => {
      const { setupSession, getStatus } = await getOrchestrator();

      setupSession(tempDir, ["model-a", "model-b"], "task");

      const status = getStatus(tempDir);

      expect(status).toBeDefined();
      expect(typeof status.models).toBe("object");

      const states = Object.values(status.models).map((m: ModelStatus) => m.state);
      expect(states.every((s) => s === "PENDING")).toBe(true);
    });

    it("TEST-17: getStatus throws when status.json does not exist", async () => {
      const { getStatus } = await getOrchestrator();

      // tempDir exists but has no status.json
      expect(() => getStatus(tempDir)).toThrow();
    });
  });

  describe("runModels — pinned spawn identity", () => {
    it("keeps manifest.models[].model unchanged after a pinned run", async () => {
      const { runModels, setupSession } = await getOrchestrator();
      const originalPath = process.env.PATH;
      const shimDir = mkdtempSync(join(tmpdir(), "team-pinned-shim-"));
      const fakeClaudish = join(
        dirname(fileURLToPath(import.meta.url)),
        "channel",
        "test-helpers",
        "fake-claudish.ts"
      );
      const spawnPlanner = mock(async () => ({
        pinned: new Map([["vendor/model", "or@vendor/model"]]),
      }));
      writeFileSync(join(shimDir, "claudish"), `#!/bin/sh\nexec bun run "${fakeClaudish}" "$@"\n`, {
        mode: 0o755,
      });

      try {
        process.env.PATH = `${shimDir}:${originalPath ?? ""}`;

        setupSession(tempDir, ["vendor/model"], "Analyze this input");
        const status = await runModels(tempDir, {
          timeout: 5,
          claudeFlags: ["--print-argv"],
          spawnPlanner,
        });
        expect(Object.values(status.models)[0].state).toBe("COMPLETED");
        expect(spawnPlanner).toHaveBeenCalledWith(["vendor/model"]);

        const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
        const [anonId, entry] = Object.entries(manifest.models)[0];
        expect(entry.model).toBe("vendor/model");

        const argv = JSON.parse(
          readFileSync(join(tempDir, `response-${anonId}.md`), "utf-8").trim()
        ) as string[];
        const modelFlag = argv.indexOf("--model");
        expect(argv[modelFlag + 1]).toBe("or@vendor/model");

        // The manifest identity is re-used by the judge round; the pinned argv
        // must never replace it with the provider wire spec.
        const reread = readJson<TeamManifest>(join(tempDir, "manifest.json"));
        expect(reread.models[anonId].model).toBe("vendor/model");
      } finally {
        process.env.PATH = originalPath;
        rmSync(shimDir, { recursive: true, force: true });
      }
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
