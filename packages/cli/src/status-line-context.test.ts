import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_CODE_DEFAULT_MAX_CONTEXT,
  createStatusLineScript,
  createTempSettingsFile,
} from "./claude-runner.js";
import { TokenTracker } from "./handlers/shared/token-tracker.js";

interface TokenFile {
  input_tokens: number;
  output_tokens: number;
  context_left_percent: number;
}

interface StatusCase {
  name: string;
  inputTokens: number;
  contextWindow: number;
  contextLeftPercent: number;
  env: Record<string, string>;
  bashExpected: string;
  nodeExpected: string;
  clamped: boolean;
}

const createdFiles = new Set<string>();
let nextPort = 40_000 + (process.pid % 20_000);
let testHome: string;
let testClaudishDir: string;

const statusCases: StatusCase[] = [
  {
    name: "no clamp",
    inputTokens: 94_018,
    contextWindow: 372_000,
    contextLeftPercent: 75,
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "372000" },
    bashExpected: "75% (94k/372k)",
    nodeExpected: "[████░░░░░░░░░░░] 94k/372k",
    clamped: false,
  },
  {
    name: "default max when unset",
    inputTokens: 164_000,
    contextWindow: 372_000,
    contextLeftPercent: 56,
    env: {},
    bashExpected: "18% (164k/200k of 372k)",
    nodeExpected: "[████████████░░░] 164k/200k of 372k",
    clamped: true,
  },
  {
    name: "smaller auto-compact window",
    inputTokens: 50_000,
    contextWindow: 372_000,
    contextLeftPercent: 87,
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "120000" },
    bashExpected: "58% (50k/120k of 372k)",
    nodeExpected: "[██████░░░░░░░░░] 50k/120k of 372k",
    clamped: true,
  },
  {
    name: "garbage max",
    inputTokens: 100_000,
    contextWindow: 372_000,
    contextLeftPercent: 73,
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "garbage" },
    bashExpected: "50% (100k/200k of 372k)",
    nodeExpected: "[████████░░░░░░░] 100k/200k of 372k",
    clamped: true,
  },
  {
    name: "unknown window",
    inputTokens: 12_000,
    contextWindow: 0,
    contextLeftPercent: -1,
    env: {},
    bashExpected: "12k tokens",
    nodeExpected: "12k tokens",
    clamped: false,
  },
  {
    name: "known window before the first reply",
    inputTokens: 0,
    contextWindow: 128_000,
    contextLeftPercent: 100,
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "128000" },
    bashExpected: "100% (0/128k)",
    nodeExpected: "[░░░░░░░░░░░░░░░] 0/128k",
    clamped: false,
  },
  {
    name: "input beyond effective window",
    inputTokens: 250_000,
    contextWindow: 372_000,
    contextLeftPercent: 33,
    env: {},
    bashExpected: "0% (250k/200k of 372k)",
    nodeExpected: "[███████████████] 250k/200k of 372k",
    clamped: true,
  },
];

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), "claudish-status-line-context-"));
  testClaudishDir = join(testHome, ".claudish");
  mkdirSync(testClaudishDir, { recursive: true });
});

afterEach(() => {
  for (const path of createdFiles) {
    rmSync(path, { force: true });
  }
  createdFiles.clear();
});

afterAll(() => {
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

function reserveTokenFile(directory: string): { port: number; tokenFile: string } {
  let port: number;
  let tokenFile: string;

  do {
    port = nextPort++;
    tokenFile = join(directory, `tokens-${port}.json`);
  } while (existsSync(tokenFile));

  createdFiles.add(tokenFile);
  return { port, tokenFile };
}

function createTracker(contextWindow: number): { tracker: TokenTracker; tokenFile: string } {
  const { port, tokenFile } = reserveTokenFile(testClaudishDir);
  return {
    tracker: new TokenTracker(port, {
      contextWindow,
      providerName: "openai",
      modelName: "test-model",
    }),
    tokenFile,
  };
}

function readTokenFile(path: string): TokenFile {
  return JSON.parse(readFileSync(path, "utf8")) as TokenFile;
}

function withTestHome<T>(fn: () => T): T {
  const previousHome = process.env.HOME;
  const previousTokenFile = process.env.CLAUDISH_TOKEN_FILE;
  process.env.HOME = testHome;
  delete process.env.CLAUDISH_TOKEN_FILE;
  try {
    return fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTokenFile === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
    else process.env.CLAUDISH_TOKEN_FILE = previousTokenFile;
  }
}

function withTokenFile<T>(tokenFile: string, fn: () => T): T {
  const previousTokenFile = process.env.CLAUDISH_TOKEN_FILE;
  process.env.CLAUDISH_TOKEN_FILE = tokenFile;
  try {
    return fn();
  } finally {
    if (previousTokenFile === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
    else process.env.CLAUDISH_TOKEN_FILE = previousTokenFile;
  }
}

function writeSyntheticTokenFile(tokenFile: string, statusCase: StatusCase): void {
  writeFileSync(
    tokenFile,
    JSON.stringify({
      input_tokens: statusCase.inputTokens,
      output_tokens: 0,
      total_tokens: statusCase.inputTokens,
      total_cost: 0,
      context_window: statusCase.contextWindow,
      context_left_percent: statusCase.contextLeftPercent,
      provider_name: "Test",
      model_name: "test-model",
      is_free: false,
      is_estimated: false,
    }),
    "utf8"
  );
}

function statusEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== "CLAUDE_CODE_MAX_CONTEXT_TOKENS" &&
      key !== "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
    ) {
      env[key] = value;
    }
  }
  return {
    ...env,
    HOME: testHome,
    USERPROFILE: testHome,
    CLAUDISH_ACTIVE_MODEL_NAME: "test-model",
    CLAUDISH_IS_LOCAL: "false",
    ...overrides,
  };
}

function stripAnsi(output: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences contain ESC
  return output.replace(/\x1b\[[0-9;]*m/g, "");
}

function contextDisplay(stdout: string): string {
  const sections = stripAnsi(stdout).trim().split(" • ");
  return sections.at(-1) ?? "";
}

function runStatusCommand(command: string[], env: Record<string, string>): string {
  const result = Bun.spawnSync(command, {
    env,
    stdin: new TextEncoder().encode("{}"),
  });
  if (result.exitCode !== 0) {
    throw new Error(`status command failed (${result.exitCode}): ${result.stderr.toString()}`);
  }
  return contextDisplay(result.stdout.toString());
}

describe("TokenTracker.context_left_percent", () => {
  test("ignores cumulative output while preserving the unknown-window sentinel", () => {
    const measured = createTracker(372_000);
    withTokenFile(measured.tokenFile, () => measured.tracker.update(94_018, 2_280_419));

    expect(readTokenFile(measured.tokenFile).context_left_percent).toBe(75);

    const unknown = createTracker(0);
    withTokenFile(unknown.tokenFile, () => unknown.tracker.update(12_000, 100));
    expect(readTokenFile(unknown.tokenFile).context_left_percent).toBe(-1);
  });

  test("raises context-left percentage after a compaction despite large lifetime output", () => {
    const { tracker, tokenFile } = createTracker(372_000);

    const [beforeCompaction, afterCompaction] = withTokenFile(tokenFile, () => {
      tracker.updateWithDelta(300_000, 1_000_000);
      const before = readTokenFile(tokenFile).context_left_percent;

      tracker.updateWithDelta(20_000, 1_280_419);
      return [before, readTokenFile(tokenFile).context_left_percent];
    });

    expect(afterCompaction).toBeGreaterThan(beforeCompaction);
    expect(afterCompaction).toBe(95);
  });
});

describe.skipIf(process.platform === "win32")("generated Bash status line", () => {
  test("renders percentages from the effective window and exposes every clamp", () => {
    expect(CLAUDE_CODE_DEFAULT_MAX_CONTEXT).toBe(200_000);
    const { port, tokenFile } = reserveTokenFile(testClaudishDir);
    const settings = withTestHome(() => createTempSettingsFile("test-model", String(port), false));
    createdFiles.add(settings.path);

    const displays: Record<string, string> = {};
    for (const statusCase of statusCases) {
      writeSyntheticTokenFile(tokenFile, statusCase);
      displays[statusCase.name] = runStatusCommand(
        ["bash", "-c", settings.statusLine.command],
        statusEnv(statusCase.env)
      );
    }

    expect(displays["input beyond effective window"]).not.toMatch(/-\d+%/);
    expect(displays).toEqual(
      Object.fromEntries(
        statusCases.map((statusCase) => [statusCase.name, statusCase.bashExpected])
      )
    );
  });
});

describe("generated Node status line", () => {
  test("renders bars against the effective window and mentions the spec only when clamped", () => {
    const { tokenFile } = reserveTokenFile(testClaudishDir);
    const scriptPath = withTestHome(() => createStatusLineScript(tokenFile));
    createdFiles.add(scriptPath);

    const displays: Record<string, string> = {};
    for (const statusCase of statusCases) {
      writeSyntheticTokenFile(tokenFile, statusCase);
      const display = runStatusCommand(["node", scriptPath], statusEnv(statusCase.env));
      displays[statusCase.name] = display;

      if (statusCase.contextWindow > 0) expect(display).toMatch(/^\[[█░]{15}\] /);
      expect(display.includes("of 372k")).toBe(statusCase.clamped);
    }

    expect(displays).toEqual(
      Object.fromEntries(
        statusCases.map((statusCase) => [statusCase.name, statusCase.nodeExpected])
      )
    );
  });
});
