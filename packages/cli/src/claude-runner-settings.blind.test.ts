import { expect, test } from "bun:test";
import { join } from "node:path";
import type { ChildAuthControlDeps } from "./claude-runner.js";
import { contractConfig, isolatedFile } from "./test-helpers/claude-behaviour.js";
import { json, put, useSandbox } from "./test-helpers/model-lineup-blind.js";

await isolatedFile(import.meta, async () => {
  const sandbox = useSandbox();
  const {
    modelPickerSources,
    settingsCredentialFindings,
    unreadableSettingsArgs,
    buildClaudishSettingsOverlay,
    mergeUserSettingsIfPresent,
  } = await import("./claude-runner.js");
  const { decideModelListings } = await import("./launcher/claude-launch.js");
  const { parseModelFlags } = await import("./providers/model-parser.js");

  function reads(files: Record<string, unknown>): ChildAuthControlDeps {
    const home = sandbox().home;
    const cwd = join(home, "project");
    return {
      home,
      cwd,
      readFile: (path) => {
        if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        const value = files[path];
        return typeof value === "string" ? value : JSON.stringify(value);
      },
      pathKind: (path) => (path === join(cwd, ".git") ? "dir" : path in files ? "file" : undefined),
    };
  }

  // REQ-20
  test("TEST-29 highest CLI picker wins rather than merging user/project/local options", () => {
    const home = sandbox().home;
    const first = join(home, "first.json");
    const last = join(home, "last.json");
    const user = { modelPicker: { options: [{ model: "user", label: "User" }] } };
    const project = { modelPicker: { options: [{ model: "project", label: "Project" }] } };
    const local = { modelPicker: { options: [{ model: "local", label: "Local" }] } };
    const firstValue = { modelPicker: { options: [{ model: "first-cli", label: "First" }] } };
    const lastValue = {
      modelPicker: { options: [{ model: "last-cli", label: "Last", extra: 3 }] },
    };
    const config = contractConfig({ claudeArgs: ["--settings", first, "--settings=" + last] });
    const result = modelPickerSources(
      config,
      { CLAUDE_CONFIG_DIR: join(home, ".claude") },
      reads({
        [sandbox().settingsFile]: user,
        [join(home, "project", ".claude", "settings.json")]: project,
        [join(home, "project", ".claude", "settings.local.json")]: local,
        [first]: firstValue,
        [last]: lastValue,
      })
    );
    expect(result.user).toMatchObject({ where: last, options: lastValue.modelPicker.options });
    expect(result.user?.options).toHaveLength(1);
  });

  test("TEST-30 empty setting-sources disables the user picker source", () => {
    const env = { CLAUDE_CONFIG_DIR: join(sandbox().home, ".claude") };
    const dependency = reads({
      [sandbox().settingsFile]: { modelPicker: { options: [{ model: "disabled-user-row" }] } },
    });
    expect(
      modelPickerSources(contractConfig({ claudeArgs: [] }), env, dependency).user
    ).toMatchObject({ options: [{ model: "disabled-user-row" }] });
    expect(
      modelPickerSources(contractConfig({ claudeArgs: ["--setting-sources", ""] }), env, dependency)
        .user
    ).toBeNull();
  });

  // REQ-18, REQ-21
  test("TEST-31 both overlay writers keep the same final picker and remove every settings occurrence", () => {
    const home = sandbox().home;
    const statusLine = { type: "command", command: "test-status", padding: 0 };
    const picker = {
      options: [
        { model: "my-gw/user", label: "User", behavesAs: "claude-haiku-4-5", extra: 7 },
        { model: "ollama@listed", label: "Listed", description: "local" },
      ],
    };
    const overlay = buildClaudishSettingsOverlay(statusLine, true, false, picker);
    expect(overlay.modelPicker).toEqual(picker);
    expect(overlay.modelPicker).not.toHaveProperty("replaceBuiltInOptions");
    expect(buildClaudishSettingsOverlay(statusLine, true)).not.toHaveProperty("modelPicker");

    const firstPath = join(home, "settings-first.json");
    const lastPath = join(home, "settings-last.json");
    put(firstPath, {
      firstOnly: true,
      shared: "first",
      modelPicker: { replaceBuiltInOptions: true, options: [{ model: "dropped-first" }] },
    });
    put(lastPath, {
      lastOnly: true,
      shared: "last",
      modelPicker: { replaceBuiltInOptions: true, options: [{ model: "dropped-last" }] },
    });
    const temp = join(home, "merged-settings.json");
    put(temp, overlay);
    const config = contractConfig({
      claudeArgs: [
        "--verbose",
        "--settings",
        firstPath,
        "--settings=" + JSON.stringify({ middleOnly: 1, shared: "middle" }),
        "--settings=" + lastPath,
      ],
    });

    mergeUserSettingsIfPresent(config, temp, statusLine, true, false, picker);

    expect(config.claudeArgs).toEqual(["--verbose"]);
    const merged = json(temp);
    expect(merged).toMatchObject({
      firstOnly: true,
      middleOnly: 1,
      lastOnly: true,
      shared: "last",
      statusLine,
      modelPicker: picker,
    });
    expect(merged.modelPicker).not.toHaveProperty("replaceBuiltInOptions");
    expect(picker.options[0]).toHaveProperty("behavesAs", "claude-haiku-4-5");
  });

  // REQ-22, §4 response-01
  test("TEST-32 array settings files are unreadable and object settings are readable", () => {
    const array = join(sandbox().home, "array.json");
    const object = join(sandbox().home, "object.json");
    put(array, []);
    put(object, {});
    expect(unreadableSettingsArgs(contractConfig({ claudeArgs: ["--settings", array] }))).toEqual([
      1,
    ]);
    expect(unreadableSettingsArgs(contractConfig({ claudeArgs: ["--settings=" + array] }))).toEqual(
      [1]
    );
    expect(unreadableSettingsArgs(contractConfig({ claudeArgs: ["--settings", object] }))).toEqual(
      []
    );
    expect(unreadableSettingsArgs(contractConfig({ claudeArgs: ["--settings", "{}"] }))).toEqual(
      []
    );
    expect(
      unreadableSettingsArgs(
        contractConfig({
          claudeArgs: ["--settings", "{}", "--settings=" + array, "--settings", object],
        })
      )
    ).toEqual([2]);
  });

  test.each([false, true])(
    "TEST-33 unreadable settings refuse a lineup even in print=%s without exposing the value",
    (print) => {
      const array = join(sandbox().home, "array.json");
      put(array, []);
      const parsed = parseModelFlags(["devin@"]);
      if (!parsed.ok) throw new Error(parsed.message);

      for (const value of [array, '{"secret":"do-not-print-this-value"']) {
        const config = contractConfig({
          claudeArgs: ["--settings", value],
          monitor: false,
          _hasPrintFlag: print,
        });
        const result = decideModelListings(config, parsed.value, {
          keepsLogin: () => false,
          settingsFindings: () => [],
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected unreadable settings refusal");
        expect(result.message).toContain("cannot read --settings");
        expect(result.message).toContain("occurrence 1");
        expect(result.message).not.toContain(value);
        expect(result.message).not.toContain("do-not-print-this-value");
      }
    }
  );

  test("TEST-34 settings layers containing an array are absent to exported settings readers", () => {
    const env = { CLAUDE_CONFIG_DIR: join(sandbox().home, ".claude") };
    const dependency = reads({ [sandbox().settingsFile]: [] });
    const config = contractConfig({ claudeArgs: [] });
    expect(modelPickerSources(config, env, dependency).user).toBeNull();
    expect(settingsCredentialFindings(config, env, dependency)).toEqual([]);
  });
});
