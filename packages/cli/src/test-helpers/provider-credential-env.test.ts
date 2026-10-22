import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");
const helperPath = resolve(import.meta.dir, "provider-credential-env.ts");
const definitionsPath = resolve(import.meta.dir, "../providers/provider-definitions.ts");
const endpointsPath = resolve(import.meta.dir, "../providers/predefined-catalog.ts");

function checkInIsolatedHome(source: string): void {
  const home = mkdtempSync(resolve(tmpdir(), "w3-provider-env-"));
  try {
    const child = Bun.spawnSync([process.execPath, "--eval", source], {
      cwd: repoRoot,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8_000,
    });
    expect({
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const imports = `
  import assert from "node:assert/strict";
  import { BUILTIN_PROVIDERS } from ${JSON.stringify(definitionsPath)};
  import { PREDEFINED_ENDPOINTS } from ${JSON.stringify(endpointsPath)};
  import {
    providerCredentialEnvVars,
    providerBaseUrlEnvVars,
    clearProviderCredentialEnv,
  } from ${JSON.stringify(helperPath)};
  const definitions = [...BUILTIN_PROVIDERS, ...PREDEFINED_ENDPOINTS];
`;

describe("R4 provider credential environment isolation", () => {
  test("4.1 derives every declared credential and alias, including POE_API_KEY", () => {
    checkInIsolatedHome(`${imports}
      const actual = new Set(providerCredentialEnvVars({}));
      const required = definitions.flatMap(def => [
        def.apiKeyEnvVar, ...(def.apiKeyAliases ?? []),
      ]).filter(Boolean);
      assert.ok(required.length > 0);
      for (const name of [...required, "ANTHROPIC_API_KEY", "POE_API_KEY"]) {
        assert.ok(actual.has(name), "missing declared credential variable: " + name);
      }
      assert.ok(!actual.has(""), "empty credential names are not variables");
    `);
  }, 10_000);

  test("4.1 derives every declared base-URL variable", () => {
    checkInIsolatedHome(`${imports}
      const actual = new Set(providerBaseUrlEnvVars());
      const required = definitions.flatMap(def => def.baseUrlEnvVars ?? []);
      assert.ok(required.length > 0);
      for (const name of required) {
        assert.ok(actual.has(name), "missing declared base-URL variable: " + name);
      }
    `);
  }, 10_000);

  test("4.1 includes new provider definitions rather than a fixed credential list", () => {
    checkInIsolatedHome(`
      import assert from "node:assert/strict";
      import { BUILTIN_PROVIDERS } from ${JSON.stringify(definitionsPath)};
      import { PREDEFINED_ENDPOINTS } from ${JSON.stringify(endpointsPath)};
      BUILTIN_PROVIDERS.push({
        ...BUILTIN_PROVIDERS[0],
        name: "w3-test-provider",
        apiKeyEnvVar: "W3_TEST_API_KEY",
        apiKeyAliases: ["W3_TEST_API_KEY_ALIAS"],
        baseUrlEnvVars: ["W3_TEST_BASE_URL"],
      });
      PREDEFINED_ENDPOINTS.push({
        ...PREDEFINED_ENDPOINTS[0],
        name: "w3-test-endpoint",
        apiKeyEnvVar: "W3_ENDPOINT_API_KEY",
        apiKeyAliases: ["W3_ENDPOINT_API_KEY_ALIAS"],
        baseUrlEnvVars: ["W3_ENDPOINT_BASE_URL"],
      });
      const { providerCredentialEnvVars, providerBaseUrlEnvVars } =
        await import(${JSON.stringify(helperPath)});
      const credentials = new Set(providerCredentialEnvVars({}));
      for (const name of [
        "W3_TEST_API_KEY", "W3_TEST_API_KEY_ALIAS",
        "W3_ENDPOINT_API_KEY", "W3_ENDPOINT_API_KEY_ALIAS",
      ]) {
        assert.ok(credentials.has(name), "new definition omitted: " + name);
      }
      const baseUrls = new Set(providerBaseUrlEnvVars());
      for (const name of ["W3_TEST_BASE_URL", "W3_ENDPOINT_BASE_URL"]) {
        assert.ok(baseUrls.has(name), "new base-URL definition omitted: " + name);
      }
    `);
  }, 10_000);

  test("4.2/4.3 clears every declared key and base URL and restores the caller environment", () => {
    checkInIsolatedHome(`${imports}
      const credentials = [
        ...definitions.flatMap(def => [
          def.apiKeyEnvVar, ...(def.apiKeyAliases ?? []),
        ]).filter(Boolean),
        "ANTHROPIC_API_KEY",
      ];
      const baseUrls = definitions.flatMap(def => def.baseUrlEnvVars ?? []);
      const seeded = new Map();
      for (const name of credentials) seeded.set(name, "OPAQUE_TEST_TOKEN_abc");
      for (const name of baseUrls) seeded.set(name, "http://127.0.0.1:1");
      for (const [name, value] of seeded) process.env[name] = value;
      process.env.W3_KEEP_UNRELATED = "keep";
      const restore = clearProviderCredentialEnv();
      try {
        for (const name of seeded.keys()) {
          assert.equal(process.env[name], undefined, "not cleared: " + name);
        }
        assert.equal(process.env.W3_KEEP_UNRELATED, "keep");
      } finally {
        restore();
      }
      for (const [name, value] of seeded) {
        assert.equal(process.env[name], value, "not restored: " + name);
      }
    `);
  }, 10_000);
});
