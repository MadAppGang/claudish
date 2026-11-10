import { describe, expect, test } from "bun:test";
import { herdrCommand, sidebarRowsToml } from "./herdr-cli.js";

describe("claudish herdr rows", () => {
  test("prints global agent rows with the claudish tokens and herdr's default rows kept", () => {
    let out = "";
    expect(
      herdrCommand(["rows"], (s) => {
        out += s;
      })
    ).toBe(0);
    expect(out).toBe(sidebarRowsToml());
    expect(out).toContain("[ui.sidebar.agents]");
    expect(out).toContain('["state_icon", "machine", "workspace", "tab"]');
    expect(out).toContain('["$model", "$activity", "$tokens"]');
    expect(out).not.toContain("rows_by_agent");
  });

  test("anything else prints the usage and exits 2", () => {
    let out = "";
    expect(
      herdrCommand([], (s) => {
        out += s;
      })
    ).toBe(2);
    expect(out).toContain("usage: claudish herdr rows");
  });
});
