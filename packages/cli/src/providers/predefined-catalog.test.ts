/**
 * Structural invariants for the real bundled predefined-endpoint catalog.
 *
 * These assertions intentionally derive the reserved namespace from the live
 * builtin definitions and picker aliases. Adding a builtin must therefore make
 * a newly colliding catalog row fail without updating a second hand-written
 * list.
 */

import { describe, expect, test } from "bun:test";
import { PROVIDER_FILTER_ALIAS_EXTRA } from "./picker-alias-extra.js";
import { PREDEFINED_ENDPOINTS } from "./predefined-catalog.js";
import { PredefinedEndpointSchema } from "./predefined-endpoint-schema.js";
import { BUILTIN_PROVIDERS } from "./provider-definitions.js";

const FORBIDDEN_MODEL_FIELDS = [
  "models",
  "contextWindow",
  "maxOutputTokens",
  "pricing",
  "capabilities",
  "modelDiscovery",
] as const;

function reservedNamespace(): Map<string, string> {
  const reserved = new Map<string, string>();
  for (const def of BUILTIN_PROVIDERS) {
    reserved.set(def.name.toLowerCase(), `builtin name ${def.name}`);
    for (const shortcut of def.shortcuts) {
      reserved.set(shortcut.toLowerCase(), `shortcut ${shortcut} -> ${def.name}`);
    }
    for (const legacy of def.legacyPrefixes) {
      const prefix = legacy.prefix.replace(/[/:]+$/, "").toLowerCase();
      reserved.set(prefix, `legacy prefix ${legacy.prefix} -> ${def.name}`);
    }
  }
  for (const [alias, owner] of Object.entries(PROVIDER_FILTER_ALIAS_EXTRA)) {
    reserved.set(alias.toLowerCase(), `picker alias ${alias} -> ${owner}`);
  }
  return reserved;
}

describe("the shipped predefined endpoint catalog", () => {
  test("contains a broad catalog and every row parses the strict schema", () => {
    expect(PREDEFINED_ENDPOINTS.length).toBeGreaterThanOrEqual(15);
    for (const row of PREDEFINED_ENDPOINTS) {
      expect(() => PredefinedEndpointSchema.parse(row)).not.toThrow();
    }
  });

  test("contains connection facts only, never hardcoded model data", () => {
    for (const row of PREDEFINED_ENDPOINTS) {
      for (const field of FORBIDDEN_MODEL_FIELDS) {
        expect(row).not.toHaveProperty(field);
      }
    }
  });

  test("uses valid HTTPS base URLs and explicit absolute API paths", () => {
    for (const row of PREDEFINED_ENDPOINTS) {
      expect(row.apiPath.length).toBeGreaterThan(1);
      expect(row.apiPath.startsWith("/")).toBe(true);

      const url = new URL(row.baseUrl);
      expect(url.protocol).toBe("https:");
      expect(row.baseUrl.endsWith("/")).toBe(false);
    }
  });

  test("uses unique conventional credential variable names", () => {
    const envVars = PREDEFINED_ENDPOINTS.map((row) => row.apiKeyEnvVar);
    expect(new Set(envVars).size).toBe(envVars.length);
    for (const envVar of envVars) {
      expect(envVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("uses unique lowercase provider names", () => {
    const names = PREDEFINED_ENDPOINTS.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toBe(name.toLowerCase());
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("does not collide with any live builtin namespace", () => {
    const reserved = reservedNamespace();
    const collisions = PREDEFINED_ENDPOINTS.flatMap((row) => {
      const owner = reserved.get(row.name.toLowerCase());
      return owner ? [{ name: row.name, owner }] : [];
    });
    expect(collisions).toEqual([]);
  });

  test("records qualifying evidence for every row", () => {
    for (const row of PREDEFINED_ENDPOINTS) {
      expect(["live", "probe"]).toContain(row.evidence.tier);
      expect(row.evidence.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("contains env-var names but no values that look like secrets", () => {
    for (const row of PREDEFINED_ENDPOINTS) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toMatch(/(?:sk-|gsk_)/i);
      expect(serialized).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
    }
  });

  test("keeps apiPath explicit because at least one vendor uses a non-default path", () => {
    expect(PREDEFINED_ENDPOINTS.some((row) => row.apiPath !== "/v1/chat/completions")).toBe(true);
  });

  test("ships runcrate as an OpenAI-format row on the chat completions path", () => {
    const row = PREDEFINED_ENDPOINTS.find((r) => r.name === "runcrate");
    expect(row).toBeDefined();
    expect(row?.baseUrl).toBe("https://api.runcrate.ai");
    expect(row?.apiPath).toBe("/v1/chat/completions");
    expect(row?.format).toBe("openai");
    expect(row?.apiKeyEnvVar).toBe("RUNCRATE_API_KEY");
  });
});
