import { describe, expect, test } from "bun:test";
import { checkChildFlags } from "./pane-launch.js";

describe("context-mode child flags", () => {
  test("REQ-8: accepts --plugin-dir with the context-mode plugin path", () => {
    expect(checkChildFlags(["--plugin-dir", "/tmp/cm/plugins/claude-code"])).toEqual({ ok: true });
  });

  test("REQ-8: accepts --mcp-config with the context-mode config path", () => {
    expect(checkChildFlags(["--mcp-config", "/tmp/cm.json"])).toEqual({ ok: true });
  });

  test("REQ-8: accepts both context-mode flags in the same child invocation", () => {
    expect(
      checkChildFlags([
        "--plugin-dir",
        "/tmp/cm/plugins/claude-code",
        "--mcp-config",
        "/tmp/cm.json",
      ])
    ).toEqual({ ok: true });
  });
});
