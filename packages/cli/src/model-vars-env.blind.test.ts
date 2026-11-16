import { expect, test } from "bun:test";
import { contractConfig, isolatedFile } from "./test-helpers/claude-behaviour.js";
import { useSandbox } from "./test-helpers/model-lineup-blind.js";

await isolatedFile(import.meta, async () => {
  useSandbox();
  const { recordModelVars, isModelVarSetByClaudish, scrubInheritedModelVars } = await import(
    "./model-vars-env.js"
  );
  const { childModelVarsFor, scrubChildModelVars } = await import("./claude-runner.js");

  // REQ-17, REQ-26
  test.each([false, true])("TEST-35 listing launch never sets small-fast, print=%s", (print) => {
    const config = contractConfig({
      model: "ollama@start",
      modelListings: [
        { provider: "ollama", typed: "ollama@", scope: "recommended", pinnedSpecs: [] },
      ],
      claudeArgs: print ? ["-p", "hello"] : [],
      _hasPrintFlag: print,
      monitor: false,
    });
    expect(childModelVarsFor(config)).toEqual({ ANTHROPIC_MODEL: "ollama@start" });

    const env = {
      ANTHROPIC_SMALL_FAST_MODEL: "or@user-background",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "user-haiku",
    };
    const result = scrubChildModelVars(config, env);
    expect(env).toEqual({
      ANTHROPIC_SMALL_FAST_MODEL: "or@user-background",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "user-haiku",
    });
    expect(result.survived).toEqual(
      expect.arrayContaining([
        { name: "ANTHROPIC_SMALL_FAST_MODEL", value: "or@user-background" },
        { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: "user-haiku" },
      ])
    );
  });

  test("TEST-36 records set values, recognizes exact provenance and removes inherited values", () => {
    const env: Record<string, string | undefined> = {};
    recordModelVars(env, { ANTHROPIC_MODEL: "or@parent", ANTHROPIC_SMALL_FAST_MODEL: "or@small" });
    expect(env.ANTHROPIC_MODEL).toBe("or@parent");
    expect(JSON.parse(env.CLAUDISH_SET_MODEL_VARS!)).toMatchObject({
      ANTHROPIC_MODEL: "or@parent",
      ANTHROPIC_SMALL_FAST_MODEL: "or@small",
    });
    expect(isModelVarSetByClaudish(env, "ANTHROPIC_MODEL")).toBe(true);

    const result = scrubInheritedModelVars(env, { model: false, smallFast: false });
    expect(result.removed.sort()).toEqual(["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"]);
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(env.CLAUDISH_SET_MODEL_VARS).toBeUndefined();
  });

  test.each([
    { ANTHROPIC_MODEL: "", CLAUDISH_SET_MODEL_VARS: '{"ANTHROPIC_MODEL":""}' },
    { ANTHROPIC_MODEL: "or@x", CLAUDISH_SET_MODEL_VARS: "{bad" },
    { ANTHROPIC_MODEL: "or@changed", CLAUDISH_SET_MODEL_VARS: '{"ANTHROPIC_MODEL":"or@old"}' },
  ])("TEST-36 does not attribute empty, malformed or changed user values to claudish", (env) => {
    expect(isModelVarSetByClaudish(env, "ANTHROPIC_MODEL")).toBe(false);
  });

  test.each([false, true])(
    "TEST-36 explicit user spec scrub respects keepsLogin=%s",
    (keepsLogin) => {
      const env: Record<string, string | undefined> = {
        ANTHROPIC_MODEL: "or@user-model",
        ANTHROPIC_SMALL_FAST_MODEL: "or@user-background",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "user-haiku",
      };
      scrubInheritedModelVars(env, { model: false, smallFast: false }, { keepsLogin });
      expect(env.ANTHROPIC_MODEL).toBe(keepsLogin ? undefined : "or@user-model");
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe(keepsLogin ? undefined : "or@user-background");
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("user-haiku");
    }
  );

  test("TEST-36 keeps variables being set by this launch and always drops the old record", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_MODEL: "or@new",
      CLAUDISH_SET_MODEL_VARS: '{"ANTHROPIC_MODEL":"or@new"}',
    };
    scrubInheritedModelVars(env, { model: true, smallFast: false }, { keepsLogin: true });
    expect(env.ANTHROPIC_MODEL).toBe("or@new");
    expect(env.CLAUDISH_SET_MODEL_VARS).toBeUndefined();

    const empty: Record<string, string | undefined> = {};
    recordModelVars(empty, {});
    expect(empty).toEqual({});
  });
});
