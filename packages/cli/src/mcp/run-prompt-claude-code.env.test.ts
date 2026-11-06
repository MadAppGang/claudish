import { describe, expect, test } from "bun:test";
import { applyProxyFastModeGates } from "../fast-mode-gates.js";
import { STRIPPED_CHILD_VARS } from "../launcher/magmux-wrapper.js";
import { nestedLaunchRefusal } from "../pane/child-env.js";
import {
  HOST_IDENTITY_VARS,
  TERMINAL_IDENTITY_PREFIXES,
  TERMINAL_IDENTITY_VARS,
  isStrippedFromChildEnv,
} from "../pane/pane-launch.js";
import { claudeCodePrintEnv } from "./run-prompt-claude-code.js";

describe("claudeCodePrintEnv", () => {
  test("drops all three pane markers from a pane-launch environment", () => {
    const parent = Object.freeze({
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_PANE_ENV: JSON.stringify({ FOO: "bar" }),
      CLAUDISH_PANE_CWD: "/sandbox/work",
      FOO: "bar",
    });

    const child = claudeCodePrintEnv(parent);
    for (const key of ["CLAUDISH_PANE_CHILD", "CLAUDISH_PANE_ENV", "CLAUDISH_PANE_CWD"]) {
      expect(Object.hasOwn(child, key)).toBe(false);
    }
    expect(child).toEqual({ FOO: "bar" });
  });

  test.each(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"])(
    "drops %s regardless of its value",
    (key) => {
      for (const value of ["inherited", ""]) {
        const parent = Object.freeze({ [key]: value, FOO: "bar" });
        const child = claudeCodePrintEnv(parent);
        expect(Object.hasOwn(child, key)).toBe(false);
        expect(child).toEqual({ FOO: "bar" });
      }
    }
  );

  test("closes the fast-mode gates a parent proxied session opened, keeps the user's", () => {
    const proxied: Record<string, string | undefined> = {
      FOO: "bar",
      CLAUDE_CODE_MODEL_CAPABILITIES: "a=b",
    };
    applyProxyFastModeGates(proxied);
    expect(claudeCodePrintEnv(proxied)).toEqual({
      FOO: "bar",
      CLAUDE_CODE_MODEL_CAPABILITIES: "a=b",
    });
  });

  test("strips every shared child-env key and terminal-identity prefix", () => {
    const strippedKeys = [
      ...STRIPPED_CHILD_VARS,
      ...HOST_IDENTITY_VARS,
      ...TERMINAL_IDENTITY_VARS,
      "MAGMUX_SOCK",
      "MAGMUX_UNRECOGNIZED",
      ...TERMINAL_IDENTITY_PREFIXES.map((prefix) => `${prefix}UNRECOGNIZED`),
    ];
    const parent = Object.freeze({
      ...Object.fromEntries(strippedKeys.map((key) => [key, "inherited"])),
      FOO: "bar",
    });
    const child = claudeCodePrintEnv(parent);

    for (const key of strippedKeys) {
      expect(isStrippedFromChildEnv(key)).toBe(true);
      expect(Object.hasOwn(child, key)).toBe(false);
    }
    expect(child).toEqual({ FOO: "bar" });
  });

  test("keeps unrelated values unchanged, omits undefined, and does not mutate the parent", () => {
    const parent = Object.freeze({
      PATH: "/sandbox/bin:/usr/bin:/bin",
      HOME: "/sandbox/home",
      FOO: "bar",
      EMPTY: "",
      ZERO: "0",
      UNSET: undefined,
    });
    const child = claudeCodePrintEnv(parent);

    expect(child).toEqual({
      PATH: parent.PATH,
      HOME: parent.HOME,
      FOO: "bar",
      EMPTY: "",
      ZERO: "0",
    });
    expect(Object.hasOwn(child, "UNSET")).toBe(false);
    expect(child).not.toBe(parent);
    expect(parent).toEqual({
      PATH: "/sandbox/bin:/usr/bin:/bin",
      HOME: "/sandbox/home",
      FOO: "bar",
      EMPTY: "",
      ZERO: "0",
      UNSET: undefined,
    });
  });

  test("a nested server's print child does not trigger the nested launch refusal", () => {
    // A nested server inherits the flag but no longer has the pane launch cwd.
    const parent = Object.freeze({
      PATH: "/sandbox/bin:/usr/bin:/bin",
      HOME: "/sandbox/home",
      FOO: "bar",
      CLAUDISH_PANE_CHILD: "1",
    });
    expect(nestedLaunchRefusal(parent)).toContain("one level of nesting is the limit");

    const child = claudeCodePrintEnv(parent);
    expect(nestedLaunchRefusal(child)).toBeNull();
    expect(child).toEqual({ PATH: parent.PATH, HOME: parent.HOME, FOO: "bar" });
    expect(parent.CLAUDISH_PANE_CHILD).toBe("1");
  });
});
