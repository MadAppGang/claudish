import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  buildInheritedSettingsLayer,
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
  expect((thrown as Error).message).toContain(source);
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

  test("rejects malformed inline settings and names the offending value", () => {
    // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
    const { setupFrom } = writeSetupFiles();
    const value = "{not json";

    expectInvalidArgs(() => buildInheritedSettingsLayer(setupFrom, ["--settings", value]), value);
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
