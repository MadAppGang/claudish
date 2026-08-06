import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigFileOverride, setConfigFileOverride } from "../../config-override.js";
import {
  DEFAULT_DEVIN_SERVER_URL,
  DEVIN_API_KEY_ENV,
  DEVIN_SERVER_URL_ENV,
  readDevinApiKey,
  readDevinServerUrl,
  setDevinCredentialsPathForTesting,
} from "./devin-credentials.js";

function withHermeticCredentials(run: (credentialsPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "claudish-devin-credentials-"));
  const credentialsPath = join(dir, "credentials.toml");
  const configPath = join(dir, "empty-claudish-config.json");
  const savedApiKey = process.env[DEVIN_API_KEY_ENV];
  const savedServerUrl = process.env[DEVIN_SERVER_URL_ENV];
  const savedConfigOverride = getConfigFileOverride();

  delete process.env[DEVIN_API_KEY_ENV];
  delete process.env[DEVIN_SERVER_URL_ENV];
  setConfigFileOverride(configPath);
  setDevinCredentialsPathForTesting(credentialsPath);

  try {
    run(credentialsPath);
  } finally {
    setDevinCredentialsPathForTesting(null);
    setConfigFileOverride(savedConfigOverride);
    if (savedApiKey === undefined) delete process.env[DEVIN_API_KEY_ENV];
    else process.env[DEVIN_API_KEY_ENV] = savedApiKey;
    if (savedServerUrl === undefined) delete process.env[DEVIN_SERVER_URL_ENV];
    else process.env[DEVIN_SERVER_URL_ENV] = savedServerUrl;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Devin credential resolution", () => {
  test("WINDSURF_API_KEY wins over the injected credentials file", () => {
    withHermeticCredentials((credentialsPath) => {
      writeFileSync(credentialsPath, 'windsurf_api_key = "file-key"\n');
      process.env[DEVIN_API_KEY_ENV] = "env-key";

      expect(readDevinApiKey()).toBe("env-key");
    });
  });

  test("parses windsurf_api_key and api_server_url from the TOML fixture", () => {
    withHermeticCredentials((credentialsPath) => {
      writeFileSync(
        credentialsPath,
        [
          "# synthetic test credential",
          '  windsurf_api_key = "file-key"',
          'api_server_url = "https://fixture.devin.invalid/base/"',
        ].join("\n")
      );

      expect(readDevinApiKey()).toBe("file-key");
      expect(readDevinServerUrl()).toBe("https://fixture.devin.invalid/base");
    });
  });

  test("a missing credentials file degrades to undefined without throwing", () => {
    withHermeticCredentials(() => {
      expect(() => readDevinApiKey()).not.toThrow();
      expect(readDevinApiKey()).toBeUndefined();
    });
  });

  test("a garbled credentials file degrades to undefined without throwing", () => {
    withHermeticCredentials((credentialsPath) => {
      writeFileSync(credentialsPath, "not toml and definitely not a credential");

      expect(() => readDevinApiKey()).not.toThrow();
      expect(readDevinApiKey()).toBeUndefined();
    });
  });

  test("server URL defaults to Codeium and honours WINDSURF_API_SERVER_URL", () => {
    withHermeticCredentials(() => {
      expect(readDevinServerUrl()).toBe(DEFAULT_DEVIN_SERVER_URL);

      process.env[DEVIN_SERVER_URL_ENV] = "https://env.devin.invalid/proxy///";
      expect(readDevinServerUrl()).toBe("https://env.devin.invalid/proxy");
    });
  });
});
