import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import * as runner from "../claude-runner.js";
import * as logger from "../logger.js";
import * as inherited from "./inherited-settings.js";
import {
  buildInheritedMcpConfig,
  buildInheritedSettingsLayer,
  isWithin,
  mergeSettingsLayers,
  resolveSetupFrom,
} from "./inherited-settings.js";

const PROJECT_SETTINGS = {
  enabledPlugins: { "dev@magus": true, "claudish@magus": true },
  permissions: { allow: ["Read"] },
};
const LOCAL_SETTINGS = {
  enabledPlugins: { "mnemex@magus": true },
  permissions: { allow: ["Bash(ls)"], additionalDirectories: ["/secret"] },
  env: { X: "1" },
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "claudish-inherited-settings-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSetupFiles(
  project: Record<string, unknown> = PROJECT_SETTINGS,
  local: Record<string, unknown> = LOCAL_SETTINGS
): { setupFrom: string; projectFile: string; localFile: string } {
  const setupFrom = join(tmp, "caller");
  const settingsDir = join(setupFrom, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const projectFile = join(settingsDir, "settings.json");
  const localFile = join(settingsDir, "settings.local.json");
  writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`);
  writeFileSync(localFile, `${JSON.stringify(local, null, 2)}\n`);
  return { setupFrom, projectFile, localFile };
}

function expectInvalidArgs(action: () => unknown, source: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/^invalid_args:/);
  expectNamesPath((thrown as Error).message, source);
}

/** `path`'s realpath when it exists, else `path`. */
function realIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * `message` names `path`, either as given or by its realpath: the builders report real
 * paths, and a temp dir can sit under a symlink (macOS `/var` is `/private/var`).
 */
function expectNamesPath(message: string | undefined, path: string): void {
  const names = message?.includes(path) || message?.includes(realIfExists(path)) || false;
  expect({ message, names }).toEqual({ message, names: true });
}

describe("mergeSettingsLayers", () => {
  test("merges nested objects and keeps enabledPlugins from both layers", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const base = {
      enabledPlugins: { "dev@magus": true },
      nested: { settings: { first: "a" } },
    };
    const over = {
      enabledPlugins: { "claudish@magus": true },
      nested: { settings: { second: "b" } },
    };

    expect(mergeSettingsLayers(base, over)).toEqual({
      enabledPlugins: { "dev@magus": true, "claudish@magus": true },
      nested: { settings: { first: "a", second: "b" } },
    });
  });

  test("concatenates arrays and keeps the first occurrence of each JSON value", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const base = {
      permissions: { allow: ["A", "B"] },
      values: [{ tool: "Read" }, ["x"]],
    };
    const over = {
      permissions: { allow: ["B", "C"] },
      values: [{ tool: "Read" }, ["x"], { tool: "Write" }],
    };

    expect(mergeSettingsLayers(base, over)).toEqual({
      permissions: { allow: ["A", "B", "C"] },
      values: [{ tool: "Read" }, ["x"], { tool: "Write" }],
    });
  });

  test("uses the overriding scalar or replacement value", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    expect(
      mergeSettingsLayers(
        { model: "a", enabled: true, count: 1, nested: { value: "a" } },
        { model: "b", enabled: false, count: 0, nested: null }
      )
    ).toEqual({ model: "b", enabled: false, count: 0, nested: null });
  });

  test("does not mutate either input", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const base = {
      enabledPlugins: { "dev@magus": true },
      permissions: { allow: ["A", "B"] },
      model: "a",
    };
    const over = {
      enabledPlugins: { "claudish@magus": true },
      permissions: { allow: ["B", "C"] },
      model: "b",
    };
    const beforeBase = structuredClone(base);
    const beforeOver = structuredClone(over);

    mergeSettingsLayers(base, over);

    expect(base).toEqual(beforeBase);
    expect(over).toEqual(beforeOver);
  });
});

describe("buildInheritedSettingsLayer", () => {
  test("inherits project and local settings without additionalDirectories", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom } = writeSetupFiles();
    const { layer, restFlags } = buildInheritedSettingsLayer(setupFrom, []);

    expect(layer).toEqual({
      enabledPlugins: { "dev@magus": true, "claudish@magus": true, "mnemex@magus": true },
      permissions: { allow: ["Read", "Bash(ls)"] },
      env: { X: "1" },
    });
    expect(layer).not.toHaveProperty("permissions.additionalDirectories");
    expect(restFlags).toEqual([]);
  });

  test("lets a local scalar override the project scalar", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom } = writeSetupFiles(
      { ...PROJECT_SETTINGS, model: "a" },
      { ...LOCAL_SETTINGS, model: "b" }
    );

    expect(buildInheritedSettingsLayer(setupFrom, []).layer?.model).toBe("b");
  });

  test("folds separate and equals settings flags into the layer and removes both", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom } = writeSetupFiles(
      { ...PROJECT_SETTINGS, model: "a" },
      { ...LOCAL_SETTINGS, model: "b" }
    );
    const settingsFile = join(tmp, "caller-settings.json");
    writeFileSync(settingsFile, '{"outputStyle":"x"}');
    const flags = ["--effort", "high", "--settings", '{"model":"c"}', `--settings=${settingsFile}`];

    const { layer, restFlags } = buildInheritedSettingsLayer(setupFrom, flags);

    expect(layer?.model).toBe("c");
    expect(layer?.outputStyle).toBe("x");
    expect(layer).toHaveProperty("enabledPlugins.dev@magus", true);
    expect(restFlags).toEqual(["--effort", "high"]);
  });

  test("applies every caller settings value in order before removing additionalDirectories", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom } = writeSetupFiles();
    const settingsFile = join(tmp, "ordered-settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        model: "d",
        permissions: { allow: ["Read", "Bash(pwd)"], additionalDirectories: ["/caller-only"] },
      })
    );
    const flags = [
      "--effort",
      "high",
      "--settings",
      '  {"model":"c"}',
      "--resume",
      "session-id",
      "--settings",
      settingsFile,
      '--settings={"model":"e"}',
      "--quiet",
    ];

    const { layer, restFlags } = buildInheritedSettingsLayer(setupFrom, flags);

    expect(layer?.model).toBe("e");
    expect(layer).toHaveProperty("permissions.allow", ["Read", "Bash(ls)", "Bash(pwd)"]);
    expect(layer).not.toHaveProperty("permissions.additionalDirectories");
    expect(restFlags).toEqual(["--effort", "high", "--resume", "session-id", "--quiet"]);
  });

  test("returns a null layer and unchanged flags when there are no settings sources", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const flags = ["--effort", "high"];

    expect(buildInheritedSettingsLayer(tmp, flags)).toEqual({ layer: null, restFlags: flags });
  });

  test("skips a missing project settings file and reads local settings", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const settingsDir = join(tmp, ".claude");
    mkdirSync(settingsDir);
    writeFileSync(join(settingsDir, "settings.local.json"), '{"model":"local"}');

    expect(buildInheritedSettingsLayer(tmp, [])).toEqual({
      layer: { model: "local" },
      restFlags: [],
    });
  });

  test("skips a missing local settings file and reads project settings", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const settingsDir = join(tmp, ".claude");
    mkdirSync(settingsDir);
    writeFileSync(join(settingsDir, "settings.json"), '{"model":"project"}');

    expect(buildInheritedSettingsLayer(tmp, [])).toEqual({
      layer: { model: "project" },
      restFlags: [],
    });
  });

  test("builds a caller-only layer even when setupFrom has no settings files", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    expect(buildInheritedSettingsLayer(tmp, ["--settings", '{"model":"c"}'])).toEqual({
      layer: { model: "c" },
      restFlags: [],
    });
  });

  test("rejects malformed project JSON with invalid_args and the offending path", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom, projectFile } = writeSetupFiles();
    writeFileSync(projectFile, "{not json");

    expectInvalidArgs(() => buildInheritedSettingsLayer(setupFrom, []), projectFile);
  });

  test("rejects project JSON that is not an object", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom, projectFile } = writeSetupFiles();
    writeFileSync(projectFile, "[]");

    expectInvalidArgs(() => buildInheritedSettingsLayer(setupFrom, []), projectFile);
  });

  test("rejects malformed local JSON with invalid_args and the offending path", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom, localFile } = writeSetupFiles();
    writeFileSync(localFile, "{not json");

    expectInvalidArgs(() => buildInheritedSettingsLayer(setupFrom, []), localFile);
  });

  test("rejects malformed inline settings, naming the source and never the value", () => {
    const { setupFrom } = writeSetupFiles();
    const value = '{"env":{"TOKEN":"fakeTokenForTest123"},';

    for (const flags of [["--settings", value], [`--settings=${value}`]]) {
      const message = thrownMessage(() => buildInheritedSettingsLayer(setupFrom, flags));
      expect(message).toMatch(/^invalid_args:/);
      expect(message).toContain("inline --settings value");
      expect(message).not.toContain("fakeTokenForTest123");
      expect(message).not.toContain(value);
    }
  });

  test("rejects a caller settings file whose JSON is not an object", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom } = writeSetupFiles();
    const settingsFile = join(tmp, "invalid-caller-settings.json");
    writeFileSync(settingsFile, "null");

    expectInvalidArgs(
      () => buildInheritedSettingsLayer(setupFrom, [`--settings=${settingsFile}`]),
      settingsFile
    );
  });

  test("reads the main checkout's settings.local.json when setupFrom is a linked worktree", () => {
    const main = join(tmp, "main");
    const worktree = join(tmp, "wt");
    const gitDir = join(main, ".git", "worktrees", "wt");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    mkdirSync(join(main, ".claude"), { recursive: true });
    writeFileSync(
      join(main, ".claude", "settings.local.json"),
      JSON.stringify({ enabledMcpjsonServers: ["linear"], disabledMcpjsonServers: ["dropped"] })
    );
    mkdirSync(join(worktree, ".claude"), { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(
      join(worktree, ".claude", "settings.local.json"),
      JSON.stringify({ enabledPlugins: { "dev@magus": true } })
    );

    expect(buildInheritedSettingsLayer(worktree, []).layer).toEqual({
      enabledMcpjsonServers: ["linear"],
      disabledMcpjsonServers: ["dropped"],
      enabledPlugins: { "dev@magus": true },
    });
  });

  test("leaves project, local, and caller settings files byte-identical", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom, projectFile, localFile } = writeSetupFiles();
    const settingsFile = join(tmp, "unchanged-caller-settings.json");
    writeFileSync(settingsFile, ' \n{"outputStyle": "x"}\n');
    const files = [projectFile, localFile, settingsFile];
    const before = files.map((file) => readFileSync(file));

    buildInheritedSettingsLayer(setupFrom, [
      "--settings",
      '{"model":"c"}',
      `--settings=${settingsFile}`,
    ]);

    expect(files.map((file) => readFileSync(file))).toEqual(before);
  });
});

describe("isWithin", () => {
  test("compares by path segment, so a sibling sharing a prefix is outside", () => {
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
    expect(isWithin("/a/b/c", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a", "/a/b")).toBe(false);
  });

  test("compares a missing path by the real path of its nearest existing ancestor", () => {
    const real = join(tmp, "real");
    const link = join(tmp, "link");
    mkdirSync(real);
    symlinkSync(real, link);

    expect(isWithin(join(link, "missing", "deeper"), real)).toBe(true);
    expect(isWithin(join(real, "missing"), link)).toBe(true);
    expect(isWithin(join(link, "missing"), join(tmp, "other"))).toBe(false);
  });
});

describe("resolveSetupFrom", () => {
  test("treats null as an explicit opt-out", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    expect(resolveSetupFrom(null, join(tmp, "work"), join(tmp, "caller"))).toBeUndefined();
  });

  test("defaults undefined to serverCwd when the work directory differs", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const serverCwd = join(tmp, "caller");

    expect(resolveSetupFrom(undefined, join(tmp, "work"), serverCwd)).toBe(serverCwd);
  });

  test("resolves a relative setup directory against the process cwd", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const setupFrom = join(tmp, "rel", "x");
    mkdirSync(setupFrom, { recursive: true });
    const relativeSetupFrom = relative(process.cwd(), setupFrom);

    expect(resolveSetupFrom(relativeSetupFrom, join(tmp, "work"), join(tmp, "server"))).toBe(
      resolve(relativeSetupFrom)
    );
  });

  test("omits inheritance when work_dir is absent and setup resolves to serverCwd", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const serverCwd = join(tmp, "caller");
    mkdirSync(serverCwd);

    expect(resolveSetupFrom(undefined, undefined, serverCwd)).toBeUndefined();
    expect(resolveSetupFrom(serverCwd, undefined, serverCwd)).toBeUndefined();
  });

  test("omits inheritance when the resolved setup directory equals work_dir", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const workDir = join(tmp, "caller");
    mkdirSync(workDir);
    const relativeWorkDir = relative(process.cwd(), workDir);

    expect(resolveSetupFrom(`${workDir}/nested/..`, workDir, join(tmp, "server"))).toBeUndefined();
    expect(
      resolveSetupFrom(resolve(relativeWorkDir), relativeWorkDir, join(tmp, "server"))
    ).toBeUndefined();
  });

  test("rejects an explicit nonexistent setup directory with its resolved path", () => {
    // REGRESSION: a mistyped setup_from silently disabled inheritance — /dev:fix session dev-fix-20261022-023522-f75563b5
    const setupFrom = relative(process.cwd(), join(tmp, "missing"));
    const action = () => resolveSetupFrom(setupFrom, join(tmp, "work"), join(tmp, "server"));

    expectInvalidArgs(action, "setup_from");
    expect(action).toThrow(resolve(setupFrom));
  });

  test("rejects an explicit setup path that is a file", () => {
    // REGRESSION: a mistyped setup_from silently disabled inheritance — /dev:fix session dev-fix-20261022-023522-f75563b5
    const setupFrom = join(tmp, "setup.txt");
    writeFileSync(setupFrom, "settings");

    expectInvalidArgs(
      () => resolveSetupFrom(setupFrom, join(tmp, "work"), join(tmp, "server")),
      "setup_from"
    );
  });

  test("rejects false as setup_from", () => {
    // REGRESSION: a mistyped setup_from silently disabled inheritance — /dev:fix session dev-fix-20261022-023522-f75563b5
    expectInvalidArgs(
      () => resolveSetupFrom(false, join(tmp, "work"), join(tmp, "server")),
      "setup_from"
    );
  });

  test("rejects 0 as setup_from", () => {
    // REGRESSION: a mistyped setup_from silently disabled inheritance — /dev:fix session dev-fix-20261022-023522-f75563b5
    expectInvalidArgs(
      () => resolveSetupFrom(0, join(tmp, "work"), join(tmp, "server")),
      "setup_from"
    );
  });

  test("rejects an object as setup_from", () => {
    // REGRESSION: a mistyped setup_from silently disabled inheritance — /dev:fix session dev-fix-20261022-023522-f75563b5
    expectInvalidArgs(
      () => resolveSetupFrom({}, join(tmp, "work"), join(tmp, "server")),
      "setup_from"
    );
  });

  test("rejects an array as setup_from", () => {
    // REGRESSION: a mistyped setup_from silently disabled inheritance — /dev:fix session dev-fix-20261022-023522-f75563b5
    expectInvalidArgs(
      () => resolveSetupFrom([], join(tmp, "work"), join(tmp, "server")),
      "setup_from"
    );
  });

  test("returns the resolved path of an explicit existing setup directory", () => {
    // REGRESSION: a mistyped setup_from silently disabled inheritance — /dev:fix session dev-fix-20261022-023522-f75563b5
    const setupFrom = join(tmp, "setup");
    mkdirSync(setupFrom);

    expect(resolveSetupFrom(setupFrom, join(tmp, "work"), join(tmp, "server"))).toBe(
      resolve(setupFrom)
    );
  });

  test("returns a nonexistent serverCwd for the implicit default", () => {
    // REGRESSION: a mistyped setup_from silently disabled inheritance — /dev:fix session dev-fix-20261022-023522-f75563b5
    const serverCwd = join(tmp, "missing-server");

    expect(resolveSetupFrom(undefined, join(tmp, "work"), serverCwd)).toBe(serverCwd);
  });
});

const FAKE_TOKEN = "fakeTokenForTest123";

function put(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** An env whose Claude Code config dir and HOME are both under the test's temp dir. */
function mcpEnv(): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: join(tmp, "config"), HOME: join(tmp, "home") };
}

/** Claude Code's global config under {@link mcpEnv}, with these project entries. */
function writeGlobalConfig(projects: Record<string, unknown>): void {
  put(join(tmp, "config", ".claude.json"), { projects });
}

/** A main checkout: a `.git` directory. */
function mainCheckout(dir: string): string {
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** The message `action` throws, or undefined. */
function thrownMessage(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

const srv = (label: string) => ({ command: "/usr/bin/true", args: [label] });

/** Every line `action` writes through `logger.log`, with the logger silenced meanwhile. */
function loggedLines(action: () => unknown): { result: unknown; lines: string[] } {
  const logged = spyOn(logger, "log").mockImplementation(() => {});
  try {
    const result = action();
    return { result, lines: logged.mock.calls.map(([line]) => String(line)) };
  } finally {
    logged.mockRestore();
  }
}

describe("a .mcp.json Claude Code skips is skipped, and no message quotes its contents", () => {
  test("a malformed .mcp.json is skipped with a log line naming the file and leaving the value out", () => {
    const outer = join(tmp, "outer");
    const caller = join(outer, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(outer, ".mcp.json"), { mcpServers: { far: srv("far") } });
    const file = join(caller, ".mcp.json");
    put(
      file,
      `{"mcpServers":{"x":{"type":"http","url":"https://h","headers":{"Authorization":${FAKE_TOKEN}}}}}`
    );

    const { result, lines } = loggedLines(() =>
      buildInheritedMcpConfig(caller, work, null, mcpEnv())
    );

    expect((result as { mcpServers: unknown } | null)?.mcpServers).toEqual({ far: srv("far") });
    expect(lines.some((line) => line.includes(realpathSync(file)))).toBe(true);
    for (const line of lines) expect(line).not.toContain(FAKE_TOKEN);
  });

  test("an unreadable .mcp.json is skipped with a log line saying it cannot be read", () => {
    const outer = join(tmp, "outer");
    const caller = join(outer, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(outer, ".mcp.json"), { mcpServers: { far: srv("far") } });
    const file = join(caller, ".mcp.json");
    put(file, { mcpServers: { a: srv("a") } });
    chmodSync(file, 0o000);

    let outcome: { result: unknown; lines: string[] };
    try {
      outcome = loggedLines(() => buildInheritedMcpConfig(caller, work, null, mcpEnv()));
    } finally {
      chmodSync(file, 0o600);
    }

    expect((outcome.result as { mcpServers: unknown } | null)?.mcpServers).toEqual({
      far: srv("far"),
    });
    const line = outcome.lines.find((l) => l.includes(realpathSync(file)));
    expect(line).toContain("cannot be read");
    expect(line).not.toContain("not valid JSON");
  });

  test("a .mcp.json over 2 MiB is skipped by its size before it is read, naming only its path", () => {
    const outer = join(tmp, "outer");
    const caller = join(outer, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(outer, ".mcp.json"), { mcpServers: { far: srv("far") } });
    const file = join(caller, ".mcp.json");
    const body = JSON.stringify({ mcpServers: { oversizedServer: srv("oversizedServer") } });
    put(file, body + " ".repeat(2 * 1024 * 1024 + 1 - body.length));
    // Unreadable as well: a reader that opened the file first would log "cannot be read".
    chmodSync(file, 0o000);

    let outcome: { result: unknown; lines: string[] };
    try {
      outcome = loggedLines(() => buildInheritedMcpConfig(caller, work, null, mcpEnv()));
    } finally {
      chmodSync(file, 0o600);
    }

    expect((outcome.result as { mcpServers: unknown } | null)?.mcpServers).toEqual({
      far: srv("far"),
    });
    const line = outcome.lines.find((l) => l.includes(realpathSync(file)));
    expect(line).toContain("larger than 2097152 bytes");
    expect(line).not.toContain("cannot be read");
    expect(line).not.toContain("oversizedServer");
  });

  test("a .mcp.json of exactly 2 MiB is read", () => {
    const outer = join(tmp, "outer");
    const caller = join(outer, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    const body = JSON.stringify({ mcpServers: { edge: srv("edge") } });
    put(join(caller, ".mcp.json"), body + " ".repeat(2 * 1024 * 1024 - body.length));

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      edge: srv("edge"),
    });
  });

  test("a blank or whitespace-only .mcp.json is no servers and the walk goes on", () => {
    for (const blank of ["", " \n\t \n"]) {
      const outer = join(tmp, `outer-${blank.length}`);
      const caller = join(outer, "caller");
      const work = join(tmp, "work");
      mkdirSync(work, { recursive: true });
      put(join(outer, ".mcp.json"), { mcpServers: { far: srv("far") } });
      put(join(caller, ".mcp.json"), blank);

      expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
        far: srv("far"),
      });
    }
  });

  test("a malformed settings.local.json names the file and leaves the value out", () => {
    const { setupFrom, localFile } = writeSetupFiles();
    writeFileSync(localFile, `{"env":{"TOKEN":${FAKE_TOKEN}}}`);

    const message = thrownMessage(() => buildInheritedSettingsLayer(setupFrom, []));

    expect(message).toMatch(/^invalid_args:/);
    expectNamesPath(message, localFile);
    expect(message).not.toContain(FAKE_TOKEN);
  });
});

describe("buildInheritedMcpConfig", () => {
  test("returns null for a child inside setupFrom's tree of the same repository", () => {
    const caller = mainCheckout(join(tmp, "caller"));
    put(join(caller, ".mcp.json"), { mcpServers: { a: srv("a") } });
    writeGlobalConfig({ [realpathSync(caller)]: { mcpServers: { loc: srv("loc") } } });
    const work = join(caller, "sub");
    mkdirSync(work);

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())).toBeNull();
  });

  test("returns null when setupFrom has no server at all", () => {
    const caller = join(tmp, "caller");
    const work = join(tmp, "work");
    mkdirSync(caller);
    mkdirSync(work);

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())).toBeNull();
  });

  test("walks up from setupFrom and the nearest .mcp.json wins a name clash", () => {
    const outer = join(tmp, "outer");
    const caller = join(outer, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(outer, ".mcp.json"), { mcpServers: { s: srv("far"), t: srv("far") } });
    put(join(caller, ".mcp.json"), { mcpServers: { s: srv("near") } });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      s: srv("near"),
      t: srv("far"),
    });
  });

  test("local scope wins a name clash over .mcp.json when both gates are open", () => {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(caller, ".mcp.json"), { mcpServers: { s: srv("project"), p: srv("project") } });
    writeGlobalConfig({ [realpathSync(caller)]: { mcpServers: { s: srv("local") } } });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      s: srv("local"),
      p: srv("project"),
    });
  });

  test("drops names in the settings layer's and the .claude.json entry's disabledMcpjsonServers", () => {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(caller, ".mcp.json"), {
      mcpServers: { a: srv("a"), b: srv("b"), c: srv("c") },
    });
    writeGlobalConfig({ [realpathSync(caller)]: { disabledMcpjsonServers: ["b"] } });

    const result = buildInheritedMcpConfig(
      caller,
      work,
      { disabledMcpjsonServers: ["a"] },
      mcpEnv()
    );

    expect(result?.mcpServers).toEqual({ c: srv("c") });
  });

  test("skips local scope without throwing when .claude.json is malformed", () => {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(caller, ".mcp.json"), { mcpServers: { a: srv("a") } });
    put(join(tmp, "config", ".claude.json"), `{"projects": {"x": ${FAKE_TOKEN}}}`);

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      a: srv("a"),
    });
  });

  test("drops a .mcp.json server disabled in CLAUDE_CONFIG_DIR's user settings.json", () => {
    const caller = join(tmp, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(caller, ".mcp.json"), { mcpServers: { a: srv("a"), b: srv("b") } });
    put(join(tmp, "config", "settings.json"), { disabledMcpjsonServers: ["a"] });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      b: srv("b"),
    });
  });

  test("drops a .mcp.json server disabled in HOME's user settings.json when CLAUDE_CONFIG_DIR is unset", () => {
    const caller = join(tmp, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(caller, ".mcp.json"), { mcpServers: { a: srv("a"), b: srv("b") } });
    put(join(tmp, "home", ".claude", "settings.json"), { disabledMcpjsonServers: ["b"] });

    const result = buildInheritedMcpConfig(caller, work, null, { HOME: join(tmp, "home") });

    expect(result?.mcpServers).toEqual({ a: srv("a") });
  });

  test("drops a .mcp.json server disabled in the managed settings file", () => {
    const caller = join(tmp, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(caller, ".mcp.json"), { mcpServers: { a: srv("a"), b: srv("b") } });
    const managed = join(tmp, "managed", "managed-settings.json");
    put(managed, { disabledMcpjsonServers: ["a"] });

    const result = buildInheritedMcpConfig(caller, work, null, mcpEnv(), {
      managedSettingsFile: managed,
    });

    expect(result?.mcpServers).toEqual({ b: srv("b") });
  });

  test("leaves a name the child's shared local scope defines to the child (same repository, outside setupFrom)", () => {
    const repo = mainCheckout(join(tmp, "repo"));
    const caller = join(repo, "sub");
    const work = join(repo, "sibling");
    mkdirSync(work, { recursive: true });
    put(join(caller, ".mcp.json"), {
      mcpServers: { demo: srv("project"), other: srv("project") },
    });
    writeGlobalConfig({ [realpathSync(repo)]: { mcpServers: { demo: srv("local") } } });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      other: srv("project"),
    });
  });

  test("follows a symlinked setupFrom to the real tree: real-path .claude.json key and real ancestors", () => {
    const realParent = join(tmp, "real");
    const caller = mainCheckout(join(realParent, "caller"));
    const link = join(tmp, "link");
    symlinkSync(caller, link);
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(realParent, ".mcp.json"), { mcpServers: { ancestor: srv("ancestor") } });
    writeGlobalConfig({ [realpathSync(caller)]: { mcpServers: { loc: srv("loc") } } });

    expect(buildInheritedMcpConfig(link, work, null, mcpEnv())?.mcpServers).toEqual({
      ancestor: srv("ancestor"),
      loc: srv("loc"),
    });
  });
});

describe("buildInheritedMcpConfig under the caller's --setting-sources", () => {
  /** Both gates open: setupFrom is its own repository, the child is outside it. */
  function bothGatesOpen(): { caller: string; work: string } {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(caller, ".mcp.json"), { mcpServers: { proj: srv("proj") } });
    writeGlobalConfig({ [realpathSync(caller)]: { mcpServers: { loc: srv("loc") } } });
    return { caller, work };
  }

  function withSources(flags: string[]): Record<string, unknown> | undefined {
    const { caller, work } = bothGatesOpen();
    const settingSources = runner.enabledSettingSources(flags);
    expect(settingSources).toBeInstanceOf(Set);
    return buildInheritedMcpConfig(caller, work, null, mcpEnv(), { settingSources })?.mcpServers;
  }

  test("--setting-sources user hands over no project and no local server", () => {
    expect(withSources(["--setting-sources", "user"])).toBeUndefined();
  });

  test("--setting-sources=user hands over no project and no local server", () => {
    expect(withSources(["--setting-sources=user"])).toBeUndefined();
  });

  test("--setting-sources user,project hands over project servers only", () => {
    expect(withSources(["--setting-sources", "user,project"])).toEqual({ proj: srv("proj") });
  });

  test("--setting-sources=local hands over local-scope servers only", () => {
    expect(withSources(["--setting-sources=local"])).toEqual({ loc: srv("loc") });
  });
});

describe("writePrivateJson", () => {
  test("leaves an existing 0644 file at 0600 with the new content", () => {
    const file = join(tmp, "inherited-mcp.json");
    writeFileSync(file, "old\n");
    chmodSync(file, 0o644);

    inherited.writePrivateJson(file, { mcpServers: { a: srv("a") } });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ mcpServers: { a: srv("a") } });
  });
});

/**
 * Every managed policy source under the test's temp dir; none exists until a test writes it.
 * The plists are read as JSON text by a stand-in for plutil.
 */
function tempManaged(): inherited.ManagedPaths & {
  managedPreferencePlists: [string, string];
  remoteSettingsFile: string;
} {
  const dir = join(tmp, "managed");
  return {
    managedSettingsFile: join(dir, "managed-settings.json"),
    managedSettingsDropInDir: join(dir, "managed-settings.d"),
    managedMcpFile: join(dir, "managed-mcp.json"),
    managedPreferencePlists: [
      join(dir, "prefs", "user", "com.anthropic.claudecode.plist"),
      join(dir, "prefs", "com.anthropic.claudecode.plist"),
    ],
    remoteSettingsFile: join(dir, "remote", "remote-settings.json"),
    hybridSettingsDir: join(dir, "remote", "state"),
    registryPolicyKeys: [],
    readPlist: (path) => readFileSync(path, "utf-8"),
  };
}

/** setupFrom outside the child's tree, with two `.mcp.json` servers `a` and `b`. */
function callerWithAB(): { caller: string; work: string } {
  const caller = join(tmp, "caller");
  const work = join(tmp, "work");
  mkdirSync(work, { recursive: true });
  put(join(caller, ".mcp.json"), { mcpServers: { a: srv("a"), b: srv("b") } });
  return { caller, work };
}

describe("an enterprise managed-mcp.json", () => {
  test("a present managed MCP file hands over no server and logs its path", () => {
    const { caller, work } = callerWithAB();
    const managed = tempManaged();
    put(managed.managedMcpFile, { mcpServers: {} });
    const logged = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const result = buildInheritedMcpConfig(caller, work, null, mcpEnv(), managed);

      expect(result).toBeNull();
      const lines = logged.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes(managed.managedMcpFile))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  test("an absent managed MCP file leaves the inherited servers in place", () => {
    const { caller, work } = callerWithAB();

    expect(
      buildInheritedMcpConfig(caller, work, null, mcpEnv(), tempManaged())?.mcpServers
    ).toEqual({ a: srv("a"), b: srv("b") });
  });
});

describe("disabledMcpjsonServers forms", () => {
  test("a string in the user settings drops that server", () => {
    const { caller, work } = callerWithAB();
    put(join(tmp, "config", "settings.json"), { disabledMcpjsonServers: "a" });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      b: srv("b"),
    });
  });

  test("a string in the .claude.json project entry drops that server", () => {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(caller, ".mcp.json"), { mcpServers: { a: srv("a"), b: srv("b") } });
    writeGlobalConfig({ [realpathSync(caller)]: { disabledMcpjsonServers: "b" } });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      a: srv("a"),
    });
  });

  test("the settings layer folds a string list from one file and an array from another", () => {
    const { setupFrom } = writeSetupFiles(
      { disabledMcpjsonServers: "a" },
      { disabledMcpjsonServers: ["b"] }
    );

    const { layer } = buildInheritedSettingsLayer(setupFrom, []);

    expect(layer?.disabledMcpjsonServers).toEqual(["a", "b"]);
  });

  test("a managed-settings.d drop-in's list applies; dot files and non-.json names do not", () => {
    const { caller, work } = callerWithAB();
    put(join(caller, ".mcp.json"), { mcpServers: { a: srv("a"), b: srv("b"), c: srv("c") } });
    const managed = tempManaged();
    put(join(managed.managedSettingsDropInDir, "10-policy.json"), {
      disabledMcpjsonServers: ["a"],
    });
    put(join(managed.managedSettingsDropInDir, ".hidden.json"), {
      disabledMcpjsonServers: ["b"],
    });
    put(join(managed.managedSettingsDropInDir, "notes.txt"), { disabledMcpjsonServers: ["c"] });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv(), managed)?.mcpServers).toEqual({
      b: srv("b"),
      c: srv("c"),
    });
  });

  test("the base managed file and every drop-in add to one list", () => {
    const { caller, work } = callerWithAB();
    put(join(caller, ".mcp.json"), { mcpServers: { a: srv("a"), b: srv("b"), c: srv("c") } });
    const managed = tempManaged();
    put(managed.managedSettingsFile, { disabledMcpjsonServers: ["a"] });
    put(join(managed.managedSettingsDropInDir, "20-b.json"), { disabledMcpjsonServers: ["b"] });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv(), managed)?.mcpServers).toEqual({
      c: srv("c"),
    });
  });

  test("a string in managed settings is not a list, as Claude Code reads managed settings", () => {
    const { caller, work } = callerWithAB();
    const managed = tempManaged();
    put(managed.managedSettingsFile, { disabledMcpjsonServers: "a" });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv(), managed)?.mcpServers).toEqual({
      a: srv("a"),
      b: srv("b"),
    });
  });

  test("a disabled name matches a server whose name differs only in characters outside [A-Za-z0-9_-]", () => {
    const caller = join(tmp, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(caller, ".mcp.json"), { mcpServers: { "my.db": srv("db"), keep: srv("keep") } });

    const result = buildInheritedMcpConfig(
      caller,
      work,
      { disabledMcpjsonServers: ["my_db"] },
      mcpEnv()
    );

    expect(result?.mcpServers).toEqual({ keep: srv("keep") });
  });
});

/**
 * Runs `body` (a module body that may use `mod`, the inherited-settings module) in a
 * separate Bun process: a blocking read of a named pipe would hang this test process.
 */
function runIsolated(body: string): { exitCode: number | null; stdout: string; stderr: string } {
  const modPath = join(import.meta.dir, "inherited-settings.ts");
  const script = `const mod = await import(${JSON.stringify(modPath)});\n${body}\n`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: tmp,
    env: { PATH: process.env.PATH ?? "", HOME: join(tmp, "home") },
    timeout: 8000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function mkfifo(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const made = Bun.spawnSync(["mkfifo", path], { env: { PATH: "/usr/bin:/bin" } });
  expect(made.exitCode).toBe(0);
}

describe("non-regular files are skipped, never read", () => {
  test("a named-pipe .mcp.json, user settings and .claude.json do not block the build", () => {
    const outer = join(tmp, "outer");
    const caller = join(outer, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(outer, ".mcp.json"), { mcpServers: { a: srv("a") } });
    mkfifo(join(caller, ".mcp.json"));
    mkfifo(join(tmp, "config", "settings.json"));
    mkfifo(join(tmp, "config", ".claude.json"));
    const env = mcpEnv();

    const run = runIsolated(
      `const r = mod.buildInheritedMcpConfig(${JSON.stringify(caller)}, ${JSON.stringify(work)}, null, ${JSON.stringify(env)});\nconsole.log(JSON.stringify(r));`
    );

    expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(run.stdout)).toEqual({ mcpServers: { a: srv("a") } });
  });

  test("a named-pipe settings.local.json in setupFrom does not block the layer", () => {
    const { setupFrom, localFile } = writeSetupFiles({ model: "project" }, {});
    rmSync(localFile);
    mkfifo(localFile);

    const run = runIsolated(
      `const r = mod.buildInheritedSettingsLayer(${JSON.stringify(setupFrom)}, []);\nconsole.log(JSON.stringify(r.layer));`
    );

    expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(run.stdout)).toEqual({ model: "project" });
  });
});

describe("a symlinked setup_from below a repository root", () => {
  /** repo (a main checkout) whose local settings disable `dropped`; link → repo/sub. */
  function linkedSubdir(): { link: string; work: string } {
    const repo = mainCheckout(join(tmp, "repo"));
    put(join(repo, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["dropped"],
      enabledPlugins: { "dev@magus": true },
    });
    const sub = join(repo, "sub");
    put(join(sub, ".mcp.json"), { mcpServers: { keep: srv("keep"), dropped: srv("dropped") } });
    const link = join(tmp, "link");
    symlinkSync(sub, link);
    const work = join(tmp, "work");
    mkdirSync(work);
    return { link, work };
  }

  test("the settings layer reads the main checkout's settings.local.json", () => {
    const { link } = linkedSubdir();

    expect(buildInheritedSettingsLayer(link, []).layer).toEqual({
      disabledMcpjsonServers: ["dropped"],
      enabledPlugins: { "dev@magus": true },
    });
  });

  test("the layer chained into the MCP builder drops the disabled server", () => {
    const { link, work } = linkedSubdir();

    const { layer } = buildInheritedSettingsLayer(link, []);
    const result = buildInheritedMcpConfig(link, work, layer, mcpEnv());

    expect(result?.mcpServers).toEqual({ keep: srv("keep") });
  });
});

describe("buildInheritedSettingsLayer under the caller's --setting-sources", () => {
  test("user only: neither the project nor the local settings file is read", () => {
    const { setupFrom } = writeSetupFiles();
    const flags = ["--setting-sources", "user"];

    const result = buildInheritedSettingsLayer(setupFrom, flags, {
      settingSources: runner.enabledSettingSources(flags),
    });

    expect(result).toEqual({ layer: null, restFlags: flags });
  });

  test("project only: the project file is read and the local file is not", () => {
    const { setupFrom } = writeSetupFiles({ model: "project" }, { env: { X: "1" } });

    const { layer } = buildInheritedSettingsLayer(setupFrom, [], {
      settingSources: new Set(["project"] as const),
    });

    expect(layer).toEqual({ model: "project" });
  });

  test("a caller --settings value still applies under user only", () => {
    const { setupFrom } = writeSetupFiles();

    const { layer } = buildInheritedSettingsLayer(setupFrom, ["--settings", '{"model":"c"}'], {
      settingSources: new Set(["user"] as const),
    });

    expect(layer).toEqual({ model: "c" });
  });
});

describe("Claude Code's global config under a relative CLAUDE_CONFIG_DIR", () => {
  test("is read from the child's cwd, as the child resolves it", () => {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(work, "cfg", ".claude.json"), {
      projects: { [realpathSync(caller)]: { mcpServers: { loc: srv("loc") } } },
    });

    const result = buildInheritedMcpConfig(caller, work, null, {
      CLAUDE_CONFIG_DIR: "cfg",
      HOME: join(tmp, "home"),
    });

    expect(result?.mcpServers).toEqual({ loc: srv("loc") });
  });
});

describe("inheritedMcpFor", () => {
  /** Both gates open: setupFrom is its own repository, the child is outside it. */
  function openCaller(): { caller: string; work: string } {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(caller, ".mcp.json"), { mcpServers: { proj: srv("proj"), off: srv("off") } });
    writeGlobalConfig({ [realpathSync(caller)]: { mcpServers: { loc: srv("loc") } } });
    return { caller, work };
  }

  test("hands over the servers, minus a name a managed drop-in disables", () => {
    const { caller, work } = openCaller();
    const managed = tempManaged();
    put(join(managed.managedSettingsDropInDir, "a.json"), { disabledMcpjsonServers: ["off"] });

    const result = inherited.inheritedMcpFor(caller, work, null, [], mcpEnv(), managed);

    expect(result?.mcpServers).toEqual({ proj: srv("proj"), loc: srv("loc") });
  });

  test("--setting-sources user hands over nothing", () => {
    const { caller, work } = openCaller();
    const flags = ["--setting-sources", "user"];

    expect(
      inherited.inheritedMcpFor(caller, work, null, flags, mcpEnv(), tempManaged())
    ).toBeNull();
  });

  test("--strict-mcp-config hands over nothing", () => {
    const { caller, work } = openCaller();
    const flags = ["--strict-mcp-config"];

    expect(
      inherited.inheritedMcpFor(caller, work, null, flags, mcpEnv(), tempManaged())
    ).toBeNull();
  });

  test("no setupFrom hands over nothing", () => {
    const { work } = openCaller();

    expect(
      inherited.inheritedMcpFor(undefined, work, null, [], mcpEnv(), tempManaged())
    ).toBeNull();
  });

  test("a present managed MCP file hands over nothing", () => {
    const { caller, work } = openCaller();
    const managed = tempManaged();
    put(managed.managedMcpFile, { mcpServers: {} });
    const logged = spyOn(logger, "log").mockImplementation(() => {});
    try {
      expect(inherited.inheritedMcpFor(caller, work, null, [], mcpEnv(), managed)).toBeNull();
    } finally {
      logged.mockRestore();
    }
  });
});

describe("disabledMcpServers in the caller's .claude.json project entry", () => {
  test("withholds a .mcp.json server and a local-scope server it names, by exact name only", () => {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(caller, ".mcp.json"), {
      mcpServers: { proj: srv("proj"), keep: srv("keep"), "my.db": srv("db") },
    });
    writeGlobalConfig({
      [realpathSync(caller)]: {
        mcpServers: { loc: srv("loc"), loc2: srv("loc2") },
        disabledMcpServers: ["proj", "loc", "my_db"],
      },
    });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      keep: srv("keep"),
      "my.db": srv("db"),
      loc2: srv("loc2"),
    });
  });
});

describe("a .mcp.json in a folder above both setupFrom and the child", () => {
  test("is left to the child's own walk-up (no repository)", () => {
    const root = join(tmp, "root");
    const caller = join(root, "a");
    const work = join(root, "b");
    mkdirSync(work, { recursive: true });
    put(join(root, ".mcp.json"), { mcpServers: { shared: srv("shared") } });
    put(join(caller, ".mcp.json"), { mcpServers: { own: srv("own") } });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      own: srv("own"),
    });
  });

  test("is left to the child's own walk-up (same repository)", () => {
    const root = mainCheckout(join(tmp, "root"));
    const caller = join(root, "a");
    const work = join(root, "b");
    mkdirSync(work, { recursive: true });
    put(join(root, ".mcp.json"), { mcpServers: { shared: srv("shared") } });
    put(join(caller, ".mcp.json"), { mcpServers: { own: srv("own") } });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      own: srv("own"),
    });
  });
});

describe("the .mcp.json walk-up folders", () => {
  test("stop before the filesystem root, which is never read", () => {
    expect(inherited.mcpJsonWalkDirs("/claudish-no-such-dir/x", { env: {} })).toEqual([
      "/claudish-no-such-dir/x",
      "/claudish-no-such-dir",
    ]);
  });

  test("stop before an injected root", () => {
    const root = join(tmp, "r");
    const start = join(root, "a", "b");

    expect(inherited.mcpJsonWalkDirs(start, { root, env: {} })).toEqual([start, join(root, "a")]);
  });

  test("a .mcp.json inside a connector-downloads folder is not handed over", () => {
    const outer = join(tmp, "outer");
    const caller = join(outer, "Connector-Downloads", "proj");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(outer, ".mcp.json"), { mcpServers: { far: srv("far") } });
    put(join(outer, "Connector-Downloads", ".mcp.json"), { mcpServers: { dl: srv("dl") } });
    put(join(caller, ".mcp.json"), { mcpServers: { inner: srv("inner") } });

    expect(buildInheritedMcpConfig(caller, work, null, mcpEnv())?.mcpServers).toEqual({
      far: srv("far"),
    });
  });

  test("a folder at or under a browser-downloads root is skipped", () => {
    for (const root of [
      "/mnt/user-data/browser-downloads",
      "/mnt/user-data/desktop-browser-downloads",
    ]) {
      expect(inherited.mcpJsonWalkDirs(`${root}/proj/sub`, { env: {} })).toEqual([
        "/mnt/user-data",
        "/mnt",
      ]);
      expect(inherited.mcpJsonWalkDirs(root, { env: {} })).toEqual(["/mnt/user-data", "/mnt"]);
    }
  });

  test("a sibling whose name only starts like a browser-downloads root is walked", () => {
    expect(inherited.mcpJsonWalkDirs("/mnt/user-data/browser-downloads-old", { env: {} })).toEqual([
      "/mnt/user-data/browser-downloads-old",
      "/mnt/user-data",
      "/mnt",
    ]);
  });

  test("a folder named in CLAUDE_CODE_AUTOMOUNT_ROOTS is skipped", () => {
    const outer = join(tmp, "outer");
    const caller = join(outer, "caller");
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(outer, ".mcp.json"), { mcpServers: { mount: srv("mount") } });
    put(join(caller, ".mcp.json"), { mcpServers: { own: srv("own") } });
    const env = { ...mcpEnv(), CLAUDE_CODE_AUTOMOUNT_ROOTS: realpathSync(outer) };

    expect(buildInheritedMcpConfig(caller, work, null, env)?.mcpServers).toEqual({
      own: srv("own"),
    });
  });

  test("an autofs map root is a top-level folder whose statfs type is autofs, on Linux only", () => {
    const autofs = () => ({ type: 391 });
    const other = () => ({ type: 26 });

    expect(inherited.isAutofsMapRoot("/net", {}, "linux", autofs)).toBe(true);
    expect(inherited.isAutofsMapRoot("/net/host", {}, "linux", autofs)).toBe(false);
    expect(inherited.isAutofsMapRoot("/", {}, "linux", autofs)).toBe(false);
    expect(inherited.isAutofsMapRoot("/net", {}, "linux", other)).toBe(false);
    expect(inherited.isAutofsMapRoot("/net", {}, "darwin", autofs)).toBe(false);
  });
});

/** Like {@link runIsolated}, with `runner` bound to the claude-runner module. */
function runRunnerIsolated(body: string): { exitCode: number | null; stdout: string } {
  const modPath = join(import.meta.dir, "..", "claude-runner.ts");
  const script = `const runner = await import(${JSON.stringify(modPath)});\n${body}\n`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: tmp,
    env: { PATH: process.env.PATH ?? "", HOME: join(tmp, "home") },
    timeout: 4000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

describe("mainCheckoutRoot and a non-regular commondir", () => {
  test("a named-pipe commondir is not read: the worktree is its own root", () => {
    const gitDir = join(tmp, "main", ".git", "worktrees", "wt");
    mkdirSync(gitDir, { recursive: true });
    mkfifo(join(gitDir, "commondir"));
    const worktree = join(tmp, "wt");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    const run = runRunnerIsolated(
      [
        `const fs = await import("node:fs");`,
        `const kind = (p) => { try { const s = fs.statSync(p); return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined; } catch { return undefined; } };`,
        `console.log(JSON.stringify(runner.mainCheckoutRoot(${JSON.stringify(worktree)}, (p) => fs.readFileSync(p, "utf-8"), kind)));`,
      ].join("\n")
    );

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toBe(worktree);
  });
});

describe("realManagedPaths", () => {
  test("puts managed-mcp.json and managed-settings.d beside the managed settings file", () => {
    const dir = dirname(runner.managedSettingsPath());

    expect(inherited.realManagedPaths("linux")).toEqual({
      managedSettingsFile: runner.managedSettingsPath(),
      managedSettingsDropInDir: join(dir, "managed-settings.d"),
      managedMcpFile: join(dir, "managed-mcp.json"),
      managedPreferencePlists: [],
      remoteSettingsFile: null,
      hybridSettingsDir: null,
      registryPolicyKeys: [],
    });
  });

  test("on macOS adds the managed preference plists, per-user first, then the device one", () => {
    const plists = inherited.realManagedPaths("darwin").managedPreferencePlists;

    expect(plists).toHaveLength(2);
    expect(plists[1]).toBe("/Library/Managed Preferences/com.anthropic.claudecode.plist");
    expect(plists[0]).toMatch(
      /^\/Library\/Managed Preferences\/[^/]+\/com\.anthropic\.claudecode\.plist$/
    );
  });

  test("on win32 names the registry policy keys Claude Code reads", () => {
    expect(inherited.realManagedPaths("win32").registryPolicyKeys).toEqual([
      "HKLM\\SOFTWARE\\Policies\\ClaudeCode",
      "HKCU\\SOFTWARE\\Policies\\ClaudeCode",
    ]);
  });

  test("leaves out the per-user plist for a user name Claude Code would not read", () => {
    const device = "/Library/Managed Preferences/com.anthropic.claudecode.plist";
    for (const name of ["", ".", "..", "a/b", "a\nb"]) {
      expect(inherited.managedPreferencePlistsFor(name)).toEqual([device]);
    }
    expect(inherited.managedPreferencePlistsFor("jo")).toEqual([
      "/Library/Managed Preferences/jo/com.anthropic.claudecode.plist",
      device,
    ]);
  });
});

describe("the managed policy sources beyond managed-settings.json", () => {
  function openCaller(): { caller: string; work: string } {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work, { recursive: true });
    put(join(caller, ".mcp.json"), { mcpServers: { proj: srv("proj"), off: srv("off") } });
    return { caller, work };
  }

  function mcpWithLog(managed: Partial<inherited.ManagedPaths>, env = mcpEnv()) {
    const { caller, work } = openCaller();
    const logged = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const result = buildInheritedMcpConfig(caller, work, null, env, managed);
      return { result, lines: logged.mock.calls.map(([line]) => String(line)) };
    } finally {
      logged.mockRestore();
    }
  }

  for (const [which, pick] of [
    ["per-user plist", (m: ReturnType<typeof tempManaged>) => m.managedPreferencePlists[0]],
    ["device plist", (m: ReturnType<typeof tempManaged>) => m.managedPreferencePlists[1]],
    ["remote-settings.json", (m: ReturnType<typeof tempManaged>) => m.remoteSettingsFile],
  ] as const) {
    test(`a ${which} disableSideloadFlags hands over no --mcp-config server and logs its path`, () => {
      const managed = tempManaged();
      put(pick(managed), { disableSideloadFlags: true });

      const { result, lines } = mcpWithLog(managed);

      expect(result).toBeNull();
      expectNamesPath(
        lines.find((line) => line.includes("disableSideloadFlags")),
        pick(managed)
      );
    });

    test(`a ${which} that cannot be parsed is skipped, as Claude Code skips it`, () => {
      const managed = tempManaged();
      put(pick(managed), "{ broken");

      expect(mcpWithLog(managed).result?.mcpServers).toEqual({
        proj: srv("proj"),
        off: srv("off"),
      });
    });

    test(`a ${which} that is not a JSON object is skipped`, () => {
      const managed = tempManaged();
      put(pick(managed), "[1]");

      expect(mcpWithLog(managed).result?.mcpServers).toEqual({
        proj: srv("proj"),
        off: srv("off"),
      });
    });

    test(`a ${which} disabledMcpjsonServers list applies to the handed-over servers`, () => {
      const managed = tempManaged();
      put(pick(managed), { disabledMcpjsonServers: ["off"] });

      expect(mcpWithLog(managed).result?.mcpServers).toEqual({ proj: srv("proj") });
    });
  }

  test("a managed settings file that cannot be parsed is skipped, beside a readable disableSideloadFlags", () => {
    const managed = tempManaged();
    put(managed.managedSettingsFile, "{ broken");
    expect(mcpWithLog(managed).result?.mcpServers).toEqual({ proj: srv("proj"), off: srv("off") });

    put(join(managed.managedSettingsDropInDir, "10-policy.json"), { disableSideloadFlags: true });
    expect(mcpWithLog(managed).result).toBeNull();
  });

  test("a plist plutil cannot convert is skipped; a readable plist disableSideloadFlags withholds", () => {
    const managed = tempManaged();
    put(managed.managedPreferencePlists[0], "binary plist bytes");
    put(managed.managedPreferencePlists[1], { disableSideloadFlags: true });
    const unconvertible = managed.managedPreferencePlists[0];
    const readPlist = (path: string) =>
      path === unconvertible ? null : readFileSync(path, "utf-8");

    expect(mcpWithLog({ ...managed, readPlist }).result).toBeNull();
    rmSync(managed.managedPreferencePlists[1]);
    expect(mcpWithLog({ ...managed, readPlist }).result?.mcpServers).toEqual({
      proj: srv("proj"),
      off: srv("off"),
    });
  });

  test("the first plist that converts wins: a per-user plist without disableSideloadFlags keeps --mcp-config beside a device plist that sets it", () => {
    const managed = tempManaged();
    put(managed.managedPreferencePlists[0], { permissions: { allow: ["Read"] } });
    put(managed.managedPreferencePlists[1], { disableSideloadFlags: true });

    expect(mcpWithLog(managed).result?.mcpServers).toEqual({ proj: srv("proj"), off: srv("off") });
  });

  test("a per-user plist that converts to no object, or a damaged one plutil answers empty, still wins over the device plist", () => {
    const managed = tempManaged();
    put(managed.managedPreferencePlists[1], { disableSideloadFlags: true });
    for (const text of ["[1, 2]", ""]) {
      put(managed.managedPreferencePlists[0], "x");
      const readPlist = (path: string) =>
        path === managed.managedPreferencePlists[0] ? text : readFileSync(path, "utf-8");
      expect(mcpWithLog({ ...managed, readPlist }).result?.mcpServers).toEqual({
        proj: srv("proj"),
        off: srv("off"),
      });
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "plutilJson answers a damaged plist with empty text, as Claude Code does, and a plist with a date value with null",
    () => {
      const damaged = join(tmp, "damaged.plist");
      put(damaged, "this is not a plist");
      expect(inherited.plutilJson(damaged)).toBe("");

      const dated = join(tmp, "dated.plist");
      put(
        dated,
        '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>d</key><date>2026-01-01T00:00:00Z</date></dict></plist>\n'
      );
      expect(inherited.plutilJson(dated)).toBeNull();

      const good = join(tmp, "good.plist");
      put(good, { disableSideloadFlags: true });
      expect(JSON.parse(inherited.plutilJson(good) ?? "null")).toEqual({
        disableSideloadFlags: true,
      });
    }
  );

  test("a remote-settings.json over Claude Code's size limit is skipped", () => {
    const managed = tempManaged();
    const pad = "x".repeat(8 * 1024 * 1024);
    put(managed.remoteSettingsFile, `{"disableSideloadFlags":true,"pad":"${pad}"}`);

    expect(mcpWithLog(managed).result?.mcpServers).toEqual({ proj: srv("proj"), off: srv("off") });
  });

  test("a named-pipe policy source is never opened, and is skipped", () => {
    const managed = tempManaged();
    const path = managed.managedPreferencePlists[0];
    mkdirSync(dirname(path), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", path], { env: { PATH: "/usr/bin:/bin" } }).exitCode).toBe(0);
    let opened = false;
    const readPlist = () => {
      opened = true;
      return "{}";
    };

    expect(mcpWithLog({ ...managed, readPlist }).result?.mcpServers).toEqual({
      proj: srv("proj"),
      off: srv("off"),
    });
    expect(opened).toBe(false);
  });

  test("a linked-worktree child outside setup_from keeps --mcp-config beside a malformed plist", () => {
    const main = mainCheckout(join(tmp, "main"));
    put(join(main, ".mcp.json"), { mcpServers: { proj: srv("proj") } });
    const gitDir = join(main, ".git", "worktrees", "wt");
    put(join(gitDir, "commondir"), "../..\n");
    const worktree = join(tmp, "wt");
    put(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    const managed = tempManaged();
    put(managed.managedPreferencePlists[1], "{ not a plist");

    const logged = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const result = buildInheritedMcpConfig(main, worktree, null, mcpEnv(), managed);
      expect(result?.mcpServers).toEqual({ proj: srv("proj") });
    } finally {
      logged.mockRestore();
    }
  });

  describe("the Windows policy keys", () => {
    const HKLM = "HKLM\\SOFTWARE\\Policies\\ClaudeCode";
    const HKCU = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";
    const missing = {
      status: 1,
      stdout: "",
      stderr: "ERROR: The system was unable to find the specified registry key or value.\r\n",
    };
    const settingsValue = {
      status: 0,
      stdout: `\r\n${HKLM}\r\n    Settings    REG_SZ    {"disableSideloadFlags":false}\r\n`,
      stderr: "",
    };

    function underRegistry(answer: (key: string) => inherited.RegistryAnswer | null) {
      const asked: string[] = [];
      const managed = {
        ...tempManaged(),
        registryPolicyKeys: [HKLM, HKCU],
        readRegistry: (key: string) => {
          asked.push(key);
          return answer(key);
        },
      };
      return { ...mcpWithLog(managed), asked };
    }

    test("both keys absent hand the servers over", () => {
      const { result, asked } = underRegistry(() => missing);
      expect(result?.mcpServers).toEqual({ proj: srv("proj"), off: srv("off") });
      expect(asked).toEqual([HKLM, HKCU]);
    });

    test("a Settings value under either key withholds the servers and names the key", () => {
      for (const present of [HKLM, HKCU]) {
        const { result, lines } = underRegistry((key) =>
          key === present ? settingsValue : missing
        );
        expect(result).toBeNull();
        expect(lines.some((line) => line.includes(present))).toBe(true);
      }
    });

    test("a query that times out, cannot run or answers otherwise withholds the servers", () => {
      for (const answer of [
        null,
        { status: 5, stdout: "", stderr: "Zugriff verweigert" },
        { status: null, stdout: "", stderr: "" },
        { status: 0, stdout: `\r\n${HKLM}\r\n`, stderr: "" },
        { status: 1, stdout: settingsValue.stdout, stderr: "" },
      ]) {
        expect(underRegistry((key) => (key === HKLM ? missing : answer)).result).toBeNull();
      }
    });

    test("reads exit status 1 with no Settings line as absent, in any language", () => {
      const missingIn = [
        "FEHLER: Der angegebene Registrierungsschlüssel bzw. Wert wurde nicht gefunden.\r\n",
        "ERREUR : le système n’a pas trouvé la clé ou la valeur de Registre spécifiée.\r\n",
        "",
      ];
      for (const stderr of missingIn) {
        const { result, asked } = underRegistry(() => ({ status: 1, stdout: "", stderr }));
        expect(result?.mcpServers).toEqual({ proj: srv("proj"), off: srv("off") });
        expect(asked).toEqual([HKLM, HKCU]);
      }
    });
  });

  test("a remote-settings.json in the child's config dir gates when the path is left to it", () => {
    put(join(tmp, "config", "remote-settings.json"), { disableSideloadFlags: true });

    expect(mcpWithLog({ ...tempManaged(), remoteSettingsFile: null }).result).toBeNull();
  });

  test("a cached remote-settings.json disableSideloadFlags withholds a linked worktree's --mcp-config even beside a signature that does not verify", () => {
    // Claude Code checks the cached copy's trust (its `<file>.signature.json`, the account's
    // organisation pin) and may ignore it; claudish reads the cache as in effect. Fail safe: a
    // --mcp-config under a policy that IS in effect makes Claude Code exit at startup.
    const caller = mainCheckout(join(tmp, "caller"));
    put(join(caller, ".mcp.json"), { mcpServers: { proj: srv("proj") } });
    const gitDir = join(caller, ".git", "worktrees", "wt");
    put(join(gitDir, "commondir"), "../..\n");
    const worktree = join(tmp, "wt");
    put(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    const cache = join(tmp, "config", "remote-settings.json");
    put(cache, { disableSideloadFlags: true });
    put(`${cache}.signature.json`, { jws: "not-a-signature", receivedAt: 0 });
    const managed = { ...tempManaged(), remoteSettingsFile: null };

    const { result, lines } = loggedLines(() =>
      buildInheritedMcpConfig(caller, worktree, null, mcpEnv(), managed)
    );

    expect(result).toBeNull();
    expectNamesPath(
      lines.find((line) => line.includes("disableSideloadFlags")),
      cache
    );
    // without the cache the same worktree child gets the project server
    rmSync(cache);
    expect(buildInheritedMcpConfig(caller, worktree, null, mcpEnv(), managed)).toEqual({
      mcpServers: { proj: srv("proj") },
    });
  });

  test("absent sources hand the servers over as before", () => {
    expect(mcpWithLog(tempManaged()).result?.mcpServers).toEqual({
      proj: srv("proj"),
      off: srv("off"),
    });
  });

  test.skipIf(process.platform !== "darwin")(
    "a binary plist disableSideloadFlags read through the real plutil gates --mcp-config",
    () => {
      const { readPlist: _fake, ...managed } = tempManaged();
      const json = join(tmp, "policy.json");
      put(json, { disableSideloadFlags: true });
      mkdirSync(dirname(managed.managedPreferencePlists[1]), { recursive: true });
      const run = Bun.spawnSync(
        ["/usr/bin/plutil", "-convert", "binary1", "-o", managed.managedPreferencePlists[1], json],
        { env: { PATH: "/usr/bin:/bin" } }
      );
      expect(run.exitCode).toBe(0);

      expect(mcpWithLog(managed).result).toBeNull();
    }
  );
});

describe("a managed disableSideloadFlags", () => {
  /** Both gates open: setupFrom is its own repository, the child is outside it. */
  function openCaller(): { caller: string; work: string } {
    const caller = mainCheckout(join(tmp, "caller"));
    const work = join(tmp, "work");
    mkdirSync(work);
    put(join(caller, ".mcp.json"), { mcpServers: { proj: srv("proj") } });
    return { caller, work };
  }

  function forWithLog(
    caller: string,
    work: string,
    layer: Record<string, unknown> | null,
    managed: ReturnType<typeof tempManaged>
  ): { result: ReturnType<typeof inherited.inheritedMcpFor>; lines: string[] } {
    const logged = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const result = inherited.inheritedMcpFor(caller, work, layer, [], mcpEnv(), managed);
      return { result, lines: logged.mock.calls.map(([line]) => String(line)) };
    } finally {
      logged.mockRestore();
    }
  }

  test("true in the managed settings file hands over nothing and logs only its path", () => {
    const { caller, work } = openCaller();
    const managed = tempManaged();
    put(managed.managedSettingsFile, { disableSideloadFlags: true, note: "secret-value" });

    const { result, lines } = forWithLog(caller, work, null, managed);

    expect(result).toBeNull();
    expectNamesPath(
      lines.find((line) => line.includes("disableSideloadFlags")),
      managed.managedSettingsFile
    );
    expect(lines.some((line) => line.includes("secret-value"))).toBe(false);
  });

  test("true in a managed drop-in hands over nothing and logs the drop-in's path", () => {
    const { caller, work } = openCaller();
    const managed = tempManaged();
    const dropIn = join(managed.managedSettingsDropInDir, "20-policy.json");
    put(dropIn, { disableSideloadFlags: true });

    const { result, lines } = forWithLog(caller, work, null, managed);

    expect(result).toBeNull();
    expectNamesPath(
      lines.find((line) => line.includes("disableSideloadFlags")),
      dropIn
    );
  });

  test("a later drop-in's false does not undo an earlier true", () => {
    const { caller, work } = openCaller();
    const managed = tempManaged();
    put(managed.managedSettingsFile, { disableSideloadFlags: true });
    put(join(managed.managedSettingsDropInDir, "90-relax.json"), { disableSideloadFlags: false });

    expect(forWithLog(caller, work, null, managed).result).toBeNull();
  });

  test("a hidden or non-.json drop-in is not read", () => {
    const { caller, work } = openCaller();
    const managed = tempManaged();
    put(join(managed.managedSettingsDropInDir, ".hidden.json"), { disableSideloadFlags: true });
    put(join(managed.managedSettingsDropInDir, "notes.txt"), { disableSideloadFlags: true });

    expect(forWithLog(caller, work, null, managed).result?.mcpServers).toEqual({
      proj: srv("proj"),
    });
  });

  test("false hands the servers over as before", () => {
    const { caller, work } = openCaller();
    const managed = tempManaged();
    put(managed.managedSettingsFile, { disableSideloadFlags: false });
    put(join(managed.managedSettingsDropInDir, "a.json"), { disableSideloadFlags: false });

    expect(forWithLog(caller, work, null, managed).result?.mcpServers).toEqual({
      proj: srv("proj"),
    });
  });

  test("absent hands the servers over as before", () => {
    const { caller, work } = openCaller();
    const managed = tempManaged();
    put(managed.managedSettingsFile, { disabledMcpjsonServers: [] });

    expect(forWithLog(caller, work, null, managed).result?.mcpServers).toEqual({
      proj: srv("proj"),
    });
  });

  test("a string value does not gate: Claude Code compares with true", () => {
    const { caller, work } = openCaller();
    const managed = tempManaged();
    put(managed.managedSettingsFile, { disableSideloadFlags: "true" });

    expect(forWithLog(caller, work, null, managed).result?.mcpServers).toEqual({
      proj: srv("proj"),
    });
  });

  test("true outside managed settings does not gate: Claude Code reads it from policy only", () => {
    const { caller, work } = openCaller();
    put(join(caller, ".claude", "settings.json"), { disableSideloadFlags: true });
    put(join(caller, ".claude", "settings.local.json"), { disableSideloadFlags: true });
    put(join(tmp, "config", "settings.json"), { disableSideloadFlags: true });
    const layer = { disableSideloadFlags: true };

    expect(forWithLog(caller, work, layer, tempManaged()).result?.mcpServers).toEqual({
      proj: srv("proj"),
    });
  });
});
