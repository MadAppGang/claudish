import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli.js";
import { setConfigFileOverride } from "./config-override.js";
import { loadConfig, readCodeMode, saveConfig } from "./profile-config.js";

let dir: string;
let file: string;
let previousSetting: string | undefined;
const realFetch = globalThis.fetch;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-t5-code-mode-"));
  file = join(dir, "config.json");
  setConfigFileOverride(file);
  previousSetting = process.env.CLAUDISH_CODE_MODE;
  delete process.env.CLAUDISH_CODE_MODE;
  globalThis.fetch = (async () => {
    throw new Error("T5 forbids network access");
  }) as unknown as typeof fetch;
  writeFileSync(file, JSON.stringify({ profiles: {}, apiKeys: {} }));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousSetting === undefined) delete process.env.CLAUDISH_CODE_MODE;
  else process.env.CLAUDISH_CODE_MODE = previousSetting;
  setConfigFileOverride(null);
  rmSync(dir, { recursive: true, force: true });
});
const args = ["--model", "cx@gpt-6.1-sol", "--stdin", "--quiet"];

describe("T5 code-mode configuration", () => {
  test.each(["auto", "on", "off"] as const)(
    "REQ-16 TEST-23 --code-mode %s beats conflicting environment and profile settings",
    async (setting) => {
      writeFileSync(file, JSON.stringify({ codeMode: setting === "off" ? "on" : "off" }));
      process.env.CLAUDISH_CODE_MODE = setting === "auto" ? "off" : "auto";

      const config = await parseArgs([...args, "--code-mode", setting]);

      expect(config.codeMode).toBe(setting);
      expect(config.claudeArgs).not.toContain("--code-mode");
    }
  );

  test("REQ-16 TEST-24 environment setting beats the conflicting profile setting", async () => {
    writeFileSync(file, JSON.stringify({ codeMode: "on" }));
    process.env.CLAUDISH_CODE_MODE = "off";

    expect((await parseArgs(args)).codeMode).toBe("off");
  });

  test("REQ-16 TEST-25 the profile setting is used without a flag or environment override", async () => {
    writeFileSync(file, JSON.stringify({ codeMode: "auto" }));

    expect((await parseArgs(args)).codeMode).toBe("auto");
  });

  test("REQ-16 TEST-26 an absent setting defaults to off", async () => {
    expect((await parseArgs(args)).codeMode).toBe("off");
  });

  test.each(["auto", "on", "off"] as const)(
    "REQ-17 TEST-27 loadConfig/saveConfig preserves codeMode %s through repeated round trips",
    (setting) => {
      writeFileSync(file, JSON.stringify({ codeMode: setting }));

      for (let cycle = 0; cycle < 3; cycle++) saveConfig(loadConfig());

      expect(loadConfig().codeMode).toBe(setting);
      expect(JSON.parse(readFileSync(file, "utf8")).codeMode).toBe(setting);
    }
  );

  test("REQ-18 TEST-28 a project setting overrides the global setting through injected paths", () => {
    const project = join(dir, ".claudish.json");
    writeFileSync(file, JSON.stringify({ codeMode: "off" }));
    writeFileSync(project, JSON.stringify({ codeMode: "on" }));

    expect(readCodeMode({ global: () => file, project: () => project })).toBe("on");
  });

  test("REQ-18 TEST-29 a project with no codeMode falls back to the global setting", () => {
    const project = join(dir, ".claudish.json");
    writeFileSync(file, JSON.stringify({ codeMode: "auto" }));
    writeFileSync(project, "{}");

    expect(readCodeMode({ global: () => file, project: () => project })).toBe("auto");
  });
});
