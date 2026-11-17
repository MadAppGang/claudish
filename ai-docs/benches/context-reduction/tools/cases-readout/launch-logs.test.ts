import { describe, expect, test } from "bun:test";
import { launchCwd, sameLaunchCwd } from "./launch-logs";

describe("sameLaunchCwd", () => {
  test("matches the /private spelling of a macOS /var folder", () => {
    expect(
      sameLaunchCwd(
        "/private/var/folders/ch/x/T/madbench-284698458/work",
        "/var/folders/ch/x/T/madbench-284698458/work"
      )
    ).toBe(true);
  });

  test("matches /private/tmp and /tmp", () => {
    expect(sameLaunchCwd("/private/tmp/a/work", "/tmp/a/work")).toBe(true);
  });

  test("keeps two different sandboxes apart", () => {
    expect(
      sameLaunchCwd(
        "/var/folders/ch/x/T/madbench-1/work",
        "/private/var/folders/ch/x/T/madbench-2/work"
      )
    ).toBe(false);
  });

  test("does not strip /private from a folder outside /var, /tmp and /etc", () => {
    expect(sameLaunchCwd("/private/home/work", "/home/work")).toBe(false);
  });
});

describe("launchCwd", () => {
  test("reads the cwd line of a launch log", () => {
    expect(
      launchCwd("launch: build x\nlaunch: cwd /var/folders/a/work\nlaunch: claude version 2\n")
    ).toBe("/var/folders/a/work");
  });

  test("answers undefined when the log has no cwd line", () => {
    expect(launchCwd("launch: build x\n")).toBeUndefined();
  });
});
