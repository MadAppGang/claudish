import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../config-override.js";
import { resolveApiKeyProvenance } from "./api-key-provenance.js";

const VAR = "CLAUDISH_PROVENANCE_TEST_KEY";
const KEY = "sk-provenance-test-not-real-0123456789";

describe("resolveApiKeyProvenance on a key only the config file holds", () => {
  let dir: string;
  let configPath: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provenance-"));
    configPath = join(dir, "config.json");
    previous = process.env[VAR];
    delete process.env[VAR];
    setConfigFileOverride(configPath);
  });

  afterEach(() => {
    setConfigFileOverride(null);
    if (previous === undefined) delete process.env[VAR];
    else process.env[VAR] = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (value: string) =>
    writeFileSync(configPath, JSON.stringify({ apiKeys: { [VAR]: value } }));

  test("names the config file as the source, masked", () => {
    writeConfig(KEY);
    const p = resolveApiKeyProvenance(VAR);
    expect(p.hasValue).toBe(true);
    expect(p.effectiveSource).toBe(configPath);
    expect(p.effectiveMasked).toBeTruthy();
    expect(p.effectiveMasked).not.toBe(KEY);
    expect(p.layers[1]).toMatchObject({ source: configPath, isActive: true });
    expect(p.layers[2].isActive).toBe(false);
    expect(JSON.stringify(p)).not.toContain(KEY);
  });

  test("an op:// reference in the config is not a key", () => {
    writeConfig("op://Vault/Item/credential");
    const p = resolveApiKeyProvenance(VAR);
    expect(p.hasValue).toBe(false);
    expect(p.effectiveSource).toBe("not set");
    expect(p.layers.some((l) => l.isActive)).toBe(false);
  });

  test("a runtime value still outranks the config file", () => {
    writeConfig(KEY);
    process.env[VAR] = "sk-provenance-shell-not-real-9876543210";
    const p = resolveApiKeyProvenance(VAR);
    expect(p.effectiveSource).toBe("shell environment");
    expect(p.layers[1].isActive).toBe(false);
    expect(p.layers[2].isActive).toBe(true);
  });
});
