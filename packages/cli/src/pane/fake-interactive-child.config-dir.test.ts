/**
 * The fake interactive child writes its transcript where Claude Code would:
 * under the config directory `CLAUDE_CONFIG_DIR` names, resolved against the
 * child's working directory, so an empty value names that directory itself.
 */

import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirNameFor } from "../mcp-session/home-dir.js";
import { FAKE_CHILD } from "./test-helpers/hermetic-env.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "claudish-fake-child-config-dir-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// REGRESSION: the fake child read an empty CLAUDE_CONFIG_DIR as unset and wrote under $HOME/.claude
test("an empty CLAUDE_CONFIG_DIR puts the transcript under the working directory", async () => {
  const cwd = join(root, "work");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const sessionId = randomUUID();
  const child = Bun.spawn(
    [process.execPath, FAKE_CHILD, "--model", "fake-empty_transcript", "--session-id", sessionId],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CLAUDE_CONFIG_DIR: "",
        CONTRACT_FAKE_MAX_MS: "300",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }
  );
  try {
    await child.exited;
  } finally {
    child.kill();
  }
  const name = `${sessionId}.jsonl`;
  expect(existsSync(join(cwd, "projects", projectDirNameFor(cwd), name))).toBe(true);
  expect(existsSync(join(home, ".claude", "projects", projectDirNameFor(cwd), name))).toBe(false);
}, 15_000);
