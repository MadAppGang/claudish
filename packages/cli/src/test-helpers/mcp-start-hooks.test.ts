/**
 * Every hook that calls `McpServer.start` passes `MCP_START_HOOK_MS`. The start waits up to
 * `MCP_REQUEST_MS` for the server's `initialize` reply, and a hook left on Bun's 5 s default
 * times out inside that wait on a loaded machine ("a beforeEach/afterEach hook timed out for
 * this test"), so a server that would have answered fails the test instead.
 */

import { describe, expect, test } from "bun:test";
import { MCP_REQUEST_MS, MCP_START_HOOK_MS } from "./contract-mcp.js";
import { hooksCalling, hooksWithout } from "./hook-calls.js";

const HOOKS = ["beforeEach", "beforeAll", "afterEach", "afterAll"] as const;

describe("McpServer.start hooks", () => {
  test("the hook timeout leaves room for the whole initialize wait", () => {
    expect(MCP_START_HOOK_MS).toBeGreaterThan(MCP_REQUEST_MS);
  });

  test("every hook that calls McpServer.start passes MCP_START_HOOK_MS", () => {
    const hooks = hooksCalling(HOOKS, "McpServer.start(");
    expect(hooks.length).toBeGreaterThanOrEqual(12);
    expect(hooksWithout(hooks, "MCP_START_HOOK_MS")).toEqual([]);
  });
});
