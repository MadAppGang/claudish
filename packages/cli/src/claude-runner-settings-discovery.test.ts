import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverUserAdvisorModel,
  discoverUserStatusLineCommand,
  resolveAdvisorModelArg,
} from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

/** A cwd with no project settings, so only the --settings values can decide. */
const cwd = mkdtempSync(join(tmpdir(), "settings-discovery-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const statusLine = (command: string) =>
  JSON.stringify({ statusLine: { type: "command", command } });
const advisor = (model: string) => JSON.stringify({ advisorModel: model });

function config(overrides: Partial<ClaudishConfig> = {}): ClaudishConfig {
  return {
    autoApprove: false,
    dangerous: false,
    interactive: false,
    debug: false,
    logLevel: "info",
    quiet: false,
    jsonOutput: false,
    monitor: false,
    stdin: false,
    claudeArgs: [],
    noLogs: false,
    diagMode: "auto",
    ...overrides,
  };
}

const lineup: ClaudishConfig["modelLineup"] = {
  rows: [],
  picker: { options: [{ model: "or@x", label: "x" }] },
} as unknown as ClaudishConfig["modelLineup"];

describe("the user's status line, on a listing launch", () => {
  test("a --settings=<v> after --settings <v> wins, as the merge applies it", () => {
    const args = ["--settings", statusLine("echo first"), `--settings=${statusLine("echo last")}`];
    expect(discoverUserStatusLineCommand(args, cwd, "every")).toBe("echo last");
  });

  test("a lone --settings=<v> is read", () => {
    expect(
      discoverUserStatusLineCommand([`--settings=${statusLine("echo inline")}`], cwd, "every")
    ).toBe("echo inline");
  });

  test("a later --settings <v> wins", () => {
    const args = ["--settings", statusLine("echo first"), "--settings", statusLine("echo last")];
    expect(discoverUserStatusLineCommand(args, cwd, "every")).toBe("echo last");
  });
});

describe("the user's status line, with no listing entry", () => {
  test("only the first --settings <v> is read, as before", () => {
    const args = ["--settings", statusLine("echo first"), "--settings", statusLine("echo last")];
    expect(discoverUserStatusLineCommand(args, cwd)).toBe("echo first");
    const inline = ["--settings", statusLine("echo first"), `--settings=${statusLine("echo i")}`];
    expect(discoverUserStatusLineCommand(inline, cwd)).toBe("echo first");
  });
});

describe("the user's advisorModel", () => {
  const args = ["--settings", advisor("first-model"), `--settings=${advisor("last-model")}`];

  test("a listing launch reads every --settings value, later wins", () => {
    expect(discoverUserAdvisorModel(args, cwd, "every")).toBe("last-model");
    expect(
      resolveAdvisorModelArg(config({ advisor: true, claudeArgs: args, modelLineup: lineup }), cwd)
    ).toEqual({ args: [], model: "last-model", source: "inherited" });
  });

  test("a launch with no listing entry reads only the first --settings <v>", () => {
    expect(discoverUserAdvisorModel(args, cwd)).toBe("first-model");
    expect(resolveAdvisorModelArg(config({ advisor: true, claudeArgs: args }), cwd)).toEqual({
      args: [],
      model: "first-model",
      source: "inherited",
    });
  });
});
