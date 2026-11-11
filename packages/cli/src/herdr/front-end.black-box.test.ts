import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { detectFrontEnd, herdrPaneEnv, workspaceKeyOf, workspaceLockName } from "./front-end.js";

const full = {
  TERM_PROGRAM: "herdr",
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "/test-only/herdr.sock",
  HERDR_PANE_ID: "p1",
  HERDR_WORKSPACE_ID: "w1",
};
describe("front-end environment contract", () => {
  test.each([
    [{}, "none"],
    [full, "herdr"],
    [{ ...full, CLAUDISH_HERDR: "0", HC_TERMINAL_ID: "hc1" }, "none"],
    [{ ...full, TERM_PROGRAM: "tmux" }, "none"],
    [{ ...full, TERM_PROGRAM: "tmux", CLAUDISH_HERDR: "1" }, "herdr"],
    [{ ...full, TERM_PROGRAM: "Herdr.app", HC_TERMINAL_ID: "hc1" }, "herdr-core"],
    [{ HC_TERMINAL_ID: "hc1" }, "herdr-core"],
    [{ ...full, HC_TERMINAL_ID: "hc1" }, "herdr"],
    [{ ...full, HERDR_ENV: "0" }, "none"],
    [{ ...full, HERDR_SOCKET_PATH: undefined, CLAUDISH_HERDR: "1" }, "none"],
    [{ ...full, HERDR_PANE_ID: undefined }, "none"],
  ] as const)("TEST-1 REQ-14 REQ-19 %j selects %s", (env, expected) => {
    expect(detectFrontEnd(env)).toBe(expected);
    expect(herdrPaneEnv(env)).toEqual(
      expected === "herdr"
        ? { socketPath: full.HERDR_SOCKET_PATH, paneId: "p1", workspaceId: "w1" }
        : null
    );
  });

  test("TEST-2 REQ-15 workspace identity includes herdr socket hash and safe lock spelling", () => {
    const a = "/test-only/herdr-a.sock";
    const b = "/test-only/herdr-b.sock";
    const hash = createHash("sha256").update(a).digest("hex").slice(0, 8);

    const key = workspaceKeyOf(a, "w1");

    expect(key).toBe(`${hash}/w1`);
    expect(workspaceKeyOf(b, "w1")).not.toBe(key);
    expect(workspaceKeyOf(a, "w2")).not.toBe(key);
    expect(workspaceLockName(key)).toBe(`${hash}-w1.lock`);
  });
});
