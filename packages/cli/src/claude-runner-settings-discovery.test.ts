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

// Claude Code applies the later of two `--settings` values: measured on 2.1.325
// for an `env` key, in both spellings. The same order for `statusLine` and
// `advisorModel` is inferred, not measured.
describe("the user's status line, on a listing launch", () => {
  test("a --settings=<v> after --settings <v> wins, as the merge applies it", () => {
    const args = ["--settings", statusLine("echo first"), `--settings=${statusLine("echo last")}`];
    expect(discoverUserStatusLineCommand(args, cwd, { scope: "every" })).toBe("echo last");
  });

  test("a lone --settings=<v> is read", () => {
    expect(
      discoverUserStatusLineCommand([`--settings=${statusLine("echo inline")}`], cwd, {
        scope: "every",
      })
    ).toBe("echo inline");
  });

  test("a later --settings <v> wins", () => {
    const args = ["--settings", statusLine("echo first"), "--settings", statusLine("echo last")];
    expect(discoverUserStatusLineCommand(args, cwd, { scope: "every" })).toBe("echo last");
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
    expect(discoverUserAdvisorModel(args, cwd, { scope: "every" })).toBe("last-model");
    expect(
      resolveAdvisorModelArg(config({ advisor: true, claudeArgs: args, modelLineup: lineup }), cwd)
    ).toEqual({ args: [], model: "last-model", source: "inherited" });
  });

  // With no listing entry only the first `--settings <v>` is merged into claudish's
  // own file, the child's first `--settings`; the `--settings=<v>` before it is
  // forwarded after that file, so the child applies it last and it wins.
  const inlineFirst = [
    `--settings=${advisor("inline-model")}`,
    "--settings",
    advisor("separate-model"),
  ];

  test("a launch with no listing entry applies a forwarded value after the merged one", () => {
    expect(discoverUserAdvisorModel(inlineFirst, cwd)).toBe("inline-model");
    expect(resolveAdvisorModelArg(config({ advisor: true, claudeArgs: inlineFirst }), cwd)).toEqual(
      { args: [], model: "inline-model", source: "inherited" }
    );
  });

  test("a listing launch merges the same values in argv order, the later one winning", () => {
    expect(discoverUserAdvisorModel(inlineFirst, cwd, { scope: "every" })).toBe("separate-model");
    expect(
      resolveAdvisorModelArg(
        config({ advisor: true, claudeArgs: inlineFirst, modelLineup: lineup }),
        cwd
      )
    ).toEqual({ args: [], model: "separate-model", source: "inherited" });
  });
});

describe("an unreadable --settings value on a listing launch", () => {
  // The merge drops a value it cannot read, so the child never receives it.
  test("is skipped, and the readable value before it still applies", () => {
    const args = ["--settings", advisor("kept-model"), "--settings=/nonexistent/settings.json"];
    expect(discoverUserAdvisorModel(args, cwd, { scope: "every" })).toBe("kept-model");
    const lines = ["--settings", statusLine("echo kept"), "--settings=/nonexistent/settings.json"];
    expect(discoverUserStatusLineCommand(lines, cwd, { scope: "every" })).toBe("echo kept");
  });
});
