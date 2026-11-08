#!/usr/bin/env bun
/**
 * Public-process fake for the MCP print path; never loads claudish or credentials.
 * Frame projections copied from the real Claude Code 2.1.301 measurements:
 * ai-docs/sessions/dev-feature-mcp-run-prompt-claude-20261016-a7c3/measure/a1.stdout
 * ai-docs/sessions/dev-feature-mcp-run-prompt-claude-20261016-a7c3/measure/a3-badmodel.stdout
 * Only result text and usage counters are overridden as the architecture contract specifies.
 * Projecting frames here keeps the tests independent of gitignored session artifacts.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const cwdEntriesAtStart = readdirSync(process.cwd());
const stdin = await Bun.stdin.text();
const model = argv[argv.indexOf("--model") + 1];
const systemFileIndex = argv.indexOf("--system-prompt-file");
const recordPath = process.env.FAKE_PRINT_RECORD;
if (!recordPath) throw new Error("FAKE_PRINT_RECORD must name a test-owned file");

const names = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDISH_PANE_CHILD",
  "CLAUDISH_PANE_ENV",
  "CLAUDISH_PANE_CWD",
  "PATH",
  "HOME",
];
const previousCount = existsSync(recordPath)
  ? (JSON.parse(readFileSync(recordPath, "utf8")) as { invocationCount: number }).invocationCount
  : 0;
const pendingRecordPath = `${recordPath}.${process.pid}.tmp`;
writeFileSync(
  pendingRecordPath,
  JSON.stringify({
    pid: process.pid,
    invocationCount: previousCount + 1,
    argv,
    cwd: process.cwd(),
    stdin,
    env: Object.fromEntries(names.map((name) => [name, Object.hasOwn(process.env, name)])),
    envValues: { ...process.env },
    cwdEntriesAtStart,
    systemPromptFileContent:
      systemFileIndex === -1 ? null : readFileSync(argv[systemFileIndex + 1]!, "utf8"),
    recordedAt: Date.now(),
  })
);

// Publish atomically so a cancellation test never sees a half-written pid record.
renameSync(pendingRecordPath, recordPath);

// These discriminators/fields are projections of the measured init and result frames.
const init = { type: "system", subtype: "init", apiKeySource: "none" };
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  result: "7723",
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 80,
    output_tokens: 4,
  },
};
const failure = {
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 404,
  result: "There's an issue with the selected model",
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  },
};

switch (model) {
  case "claude-fake-ok":
    console.log(JSON.stringify([init, success]));
    break;
  case "claude-fake-404":
    console.log(JSON.stringify([init, failure]));
    process.exit(1);
    break;
  case "claude-fake-garbage":
    console.log("not json");
    console.error("boom");
    process.exit(3);
    break;
  case "claude-fake-empty":
    console.log(JSON.stringify([init, { ...success, result: "" }]));
    break;
  case "claude-fake-object":
    console.log(JSON.stringify(success));
    break;
  case "claude-fake-hang":
    // No successful output or early exit: only cancellation/teardown can stop this child.
    await new Promise(() => setInterval(() => {}, 60_000));
    break;
  default:
    console.error(`Unexpected fake model: ${model}`);
    process.exit(2);
}
