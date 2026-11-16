import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "./config-override.js";
import { loadConfig, saveConfig } from "./profile-config.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-gateway-roundtrip-"));
  file = join(dir, "config.json");
  setConfigFileOverride(file);
});

afterEach(() => {
  setConfigFileOverride(null);
  rmSync(dir, { recursive: true, force: true });
});

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("harnessGateway global config persistence", () => {
  test("REQ-4: loadConfig returns the configured harnessGateway block unchanged", () => {
    const block = { url: " \thttp://127.0.0.1:18081/gateway\n " };
    writeFileSync(file, JSON.stringify({ harnessGateway: block }));

    expect(loadConfig().harnessGateway).toEqual(block);
  });

  test("REQ-4: global save preserves harnessGateway across repeated round trips", () => {
    const block = { url: "https://localhost:18081/gateway" };
    writeFileSync(file, JSON.stringify({ harnessGateway: block, proOnUltracode: true }));

    for (let round = 0; round < 3; round++) {
      saveConfig(loadConfig());
      expect(onDisk().harnessGateway).toEqual(block);
      expect(loadConfig().harnessGateway).toEqual(block);
    }
    expect(onDisk().proOnUltracode).toBe(true);
  });

  test("REQ-4: a global save retains an empty harnessGateway block", () => {
    writeFileSync(file, JSON.stringify({ harnessGateway: {} }));

    expect(loadConfig().harnessGateway).toEqual({});
    saveConfig(loadConfig());

    expect(onDisk().harnessGateway).toEqual({});
  });

  test("REQ-4: saving does not normalize the gateway URL or remove other block fields", () => {
    const block = {
      url: " \thttp://127.0.0.1:18081/gateway\n ",
      extra: { note: "preserve this data", values: [1, false, null] },
    };
    writeFileSync(file, JSON.stringify({ harnessGateway: block }));

    expect(loadConfig().harnessGateway).toEqual(block);
    saveConfig(loadConfig());

    expect(onDisk().harnessGateway).toEqual(block);
  });
});
