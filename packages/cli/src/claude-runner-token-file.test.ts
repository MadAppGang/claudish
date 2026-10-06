/**
 * F3: a parent that hands a child `CLAUDISH_TOKEN_FILE` (team, the channel, a pane)
 * names the file the child's proxy writes. `createTempSettingsFile` used to ignore it
 * and point the status line at `~/.claudish/tokens-<port>.json`, then publish THAT
 * path as `CLAUDISH_TOKEN_FILE` to Claude Code, so the status line read a file nobody
 * wrote. One resolver, `resolveTokenFilePath`, now serves the writer's override, the
 * status line and the end-of-session summary.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempSettingsFile } from "./claude-runner.js";
import { resolveTokenFilePath } from "./session/session-stats.js";

let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "CLAUDISH_TOKEN_FILE"] as const;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "claudish-token-file-"));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

function withEnv<T>(values: Partial<Record<(typeof KEYS)[number], string>>, fn: () => T): T {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  try {
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const created: string[] = [];
afterEach(() => {
  for (const p of created.splice(0)) rmSync(p, { force: true });
});

describe("resolveTokenFilePath", () => {
  test("an inherited CLAUDISH_TOKEN_FILE wins", () => {
    expect(
      resolveTokenFilePath(4000, { CLAUDISH_TOKEN_FILE: "/run/stats/a.json", HOME: home })
    ).toBe("/run/stats/a.json");
  });

  test("otherwise the port-keyed file under $HOME/.claudish", () => {
    expect(resolveTokenFilePath(4000, { HOME: home })).toBe(
      join(home, ".claudish", "tokens-4000.json")
    );
  });
});

describe("createTempSettingsFile", () => {
  test("returns, and points the status line at, an inherited CLAUDISH_TOKEN_FILE", () => {
    const inherited = join(home, "team-run", "stats", "slot-1.json");
    const settings = withEnv({ HOME: home, CLAUDISH_TOKEN_FILE: inherited }, () =>
      createTempSettingsFile("m", "4321", false)
    );
    created.push(settings.path);
    expect(settings.tokenFilePath).toBe(inherited);
    expect(settings.statusLine.command).toContain(inherited);
    expect(settings.statusLine.command).not.toContain("tokens-4321.json");
  });

  test("without one, keeps the port-keyed file", () => {
    const settings = withEnv({ HOME: home }, () => createTempSettingsFile("m", "4322", false));
    created.push(settings.path);
    expect(settings.tokenFilePath).toBe(join(home, ".claudish", "tokens-4322.json"));
  });
});
