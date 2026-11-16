import { describe, expect, test } from "bun:test";
import { detectFrontEnd, herdrPaneEnv } from "./front-end.js";

const HERDR = {
  TERM_PROGRAM: "herdr",
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
  HERDR_SOCKET_PATH: "/tmp/x/herdr.sock",
  HERDR_WORKSPACE_ID: "w1",
};

describe("detectFrontEnd", () => {
  test.each([
    ["no multiplexer variables", {}, "none"],
    ["a herdr pane", HERDR, "herdr"],
    [
      "herdr variables without TERM_PROGRAM=herdr (tmux inside herdr)",
      { ...HERDR, TERM_PROGRAM: "tmux" },
      "none",
    ],
    [
      "the same with CLAUDISH_HERDR=1",
      { ...HERDR, TERM_PROGRAM: "tmux", CLAUDISH_HERDR: "1" },
      "herdr",
    ],
    ["CLAUDISH_HERDR=0 in a herdr pane", { ...HERDR, CLAUDISH_HERDR: "0" }, "none"],
    ["HERDR_ENV missing", { ...HERDR, HERDR_ENV: undefined }, "none"],
    ["HERDR_SOCKET_PATH missing", { ...HERDR, HERDR_SOCKET_PATH: "" }, "none"],
    ["an hc terminal", { HC_TERMINAL_ID: "t7", TERM_PROGRAM: "ghostty" }, "herdr-core"],
    [
      "hc inside a herdr-started server: herdr markers leaked, TERM_PROGRAM rewritten",
      { ...HERDR, TERM_PROGRAM: "ghostty", HC_TERMINAL_ID: "t7" },
      "herdr-core",
    ],
    ["CLAUDISH_HERDR=0 in hc", { HC_TERMINAL_ID: "t7", CLAUDISH_HERDR: "0" }, "none"],
  ] as const)("%s", (_name, env, want) => {
    expect(detectFrontEnd(env as Record<string, string | undefined>)).toBe(want);
  });

  test("herdrPaneEnv is null unless the front end is herdr", () => {
    expect(herdrPaneEnv({ ...HERDR, TERM_PROGRAM: "tmux" })).toBeNull();
    expect(herdrPaneEnv(HERDR)).toEqual({
      socketPath: "/tmp/x/herdr.sock",
      paneId: "w1:p2",
    });
  });
});
