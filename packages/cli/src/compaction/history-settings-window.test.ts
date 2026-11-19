import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as runner from "../claude-runner.js";
import type { ClaudishConfig } from "../types.js";
import {
  effectiveHistoryLimit,
  getLaunchAutoCompactWindow,
  setLaunchAutoCompactWindow,
} from "./history.js";

// Claude Code applies the `env` block of its enabled settings layers over the
// environment it was given, so the auto-compact window it compacts at is the
// highest enabled layer's value, else the launch environment's.

const ONE_MILLION = 1_000_000;

let root: string;
let home: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-settings-window-"));
  home = join(root, "home");
  project = join(root, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  setLaunchAutoCompactWindow(undefined);
});
afterEach(() => {
  setLaunchAutoCompactWindow(undefined);
  rmSync(root, { recursive: true, force: true });
});

/** Reads and stats confined to the temp tree: the real managed file and ~/.claude are never seen. */
function deps() {
  const inside = (path: string) => path.startsWith(`${root}/`);
  return {
    home,
    cwd: project,
    readFile: (path: string) => {
      if (!inside(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return readFileSync(path, "utf-8");
    },
    pathKind: (path: string): "dir" | "file" | undefined => {
      if (!inside(path)) return undefined;
      try {
        return statSync(path).isDirectory() ? "dir" : "file";
      } catch {
        return undefined;
      }
    },
  };
}

function writeSettings(path: string, env: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ env }));
}

const userFile = () => join(home, ".claude", "settings.json");
const localFile = () => join(project, ".claude", "settings.local.json");
const config = (claudeArgs: string[] = []) => ({ claudeArgs }) as unknown as ClaudishConfig;

function record(claudeArgs: string[], env: NodeJS.ProcessEnv): number | undefined {
  runner.recordLaunchAutoCompactWindow(config(claudeArgs), env, deps());
  return getLaunchAutoCompactWindow();
}

test("a user settings value the shell does not set is the recorded window", () => {
  writeSettings(userFile(), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" });
  expect(record([], {})).toBe(200_000);
  expect(effectiveHistoryLimit(ONE_MILLION, getLaunchAutoCompactWindow())).toBe(200_000);
});

test("a user settings value replaces the launch environment's", () => {
  writeSettings(userFile(), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" });
  expect(record([], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" })).toBe(200_000);
});

test("project-local settings outrank user settings", () => {
  writeSettings(userFile(), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" });
  writeSettings(localFile(), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" });
  expect(record([], {})).toBe(300_000);
});

test("--setting-sources without user ignores the user file", () => {
  writeSettings(userFile(), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" });
  expect(record(["--setting-sources", "project,local"], {})).toBeUndefined();
  expect(
    record(["--setting-sources", "project,local"], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" })
  ).toBe(400_000);
});

test("the launch environment's value stands when no layer sets the variable", () => {
  writeSettings(userFile(), { SOME_OTHER_VARIABLE: "1" });
  expect(record([], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" })).toBe(400_000);
});

test("an empty settings value replaces the launch environment's and records no window", () => {
  writeSettings(userFile(), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "" });
  expect(record([], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" })).toBeUndefined();
});

test("an unreadable --settings value keeps the launch environment's value", () => {
  writeSettings(userFile(), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" });
  const missing = join(root, "missing.json");
  expect(record([`--settings=${missing}`], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" })).toBe(
    400_000
  );
});
