import { afterEach, describe, expect, test } from "bun:test";
import { CAPABILITIES, CONTRACT_VERSION } from "./contract.js";
import {
  buildPaneEnv,
  buildReplayEnv,
  isStrippedFromChildEnv,
  isUsableMagmuxVersion,
  replayLauncherScript,
} from "./pane-launch.js";
import { type PaneTestEnv, makePaneTestEnv } from "./test-helpers/hermetic-env.js";

let layout: PaneTestEnv | undefined;
afterEach(() => {
  layout?.cleanup();
  layout = undefined;
});
const identities = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "parent-pane",
  HERDR_TAB_ID: "parent-tab",
  HERDR_WORKSPACE_ID: "w1",
  HERDR_SOCKET_PATH: "/test-only/herdr.sock",
  HERDR_FUTURE_INTEGRATION: "parent-id",
  HC_TERMINAL_ID: "parent-hc",
  HC_TERMINAL_SOCKET: "/test-only/hc.sock",
  HC_SCOPE: "parent",
  HC_SESSION: "parent-session",
  HC_SOCKET: "/test-only/core.sock",
};

describe("child isolation and additive contract", () => {
  test("TEST-3 REQ-26 REQ-29 pane environment and serialized snapshot strip caller identities, retain nesting marker", () => {
    layout = makePaneTestEnv();
    const parentEnv = { ...layout.env, ...identities, CLAUDISH_PANE_CHILD: "1" };

    const { magmuxEnv } = buildPaneEnv({
      parentEnv,
      slotEnv: {},
      cwd: layout.cwd,
      ctlDir: layout.tmp,
      configFile: null,
    });
    const snapshot = JSON.parse(magmuxEnv.CLAUDISH_PANE_ENV ?? "null") as Record<string, unknown>;

    expect(snapshot).not.toBeNull();
    for (const key of Object.keys(identities)) {
      expect(isStrippedFromChildEnv(key)).toBe(true);
      expect(magmuxEnv).not.toHaveProperty(key);
      expect(JSON.stringify(snapshot)).not.toContain(JSON.stringify(key) + ":");
    }
    expect(magmuxEnv.CLAUDISH_PANE_CHILD).toBe("1");
    expect(JSON.stringify(snapshot)).toContain('"CLAUDISH_PANE_CHILD":"1"');
    expect(magmuxEnv.HOME).toBe(layout.home);
  });

  test("TEST-4 REQ-10 REQ-23 REQ-26 REQ-29 REQ-41 replay inherits no caller identity or credential and closes lock descriptor", () => {
    layout = makePaneTestEnv();
    const env = buildReplayEnv({
      parentEnv: {
        ...layout.env,
        ...identities,
        ANTHROPIC_API_KEY: "test-data-not-a-key",
        CUSTOM_TEST_KEY: "test-data",
      },
      ctlDir: layout.tmp,
      cols: 80,
      rows: 24,
    });

    for (const key of [
      ...Object.keys(identities),
      "ANTHROPIC_API_KEY",
      "CUSTOM_TEST_KEY",
      "CLAUDISH_PANE_ENV",
    ])
      expect(env).not.toHaveProperty(key);
    expect(env.HOME).toBe(layout.home);
    const script = replayLauncherScript(
      "/bin/sh",
      layout.cwd,
      { command: "/test-only/claude", prefixArgs: [] },
      ["--resume", "test-data"]
    );
    const firstExecutable = script.split("\n").find((line) => line.trim() && !line.startsWith("#"));
    expect(firstExecutable?.trim()).toBe("exec 3>&-");
  });

  test("TEST-5 REQ-8 REQ-25 REQ-29 preserves contract v1 capability order and appends view", () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect([...CAPABILITIES]).toEqual([
      "list",
      "status",
      "cancel",
      "capture",
      "capture_since_seq",
      "capture_spans",
      "resize",
      "allowance",
      "scroll",
      "transcript",
      "replay",
      "view",
    ]);
  });

  test.each([
    ["0.18.1", false],
    ["0.19.0", true],
    ["0.19.0-rc1", true],
    ["0.20.0", true],
    ["0.100.0", true],
    ["1.0.0", false],
    ["3.4.2", false],
  ] as const)("TEST-41 REQ-40 version %s usability is %s", (version, expected) => {
    expect(isUsableMagmuxVersion(version)).toBe(expected);
  });
});
