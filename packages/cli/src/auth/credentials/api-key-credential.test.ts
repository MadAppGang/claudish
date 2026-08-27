import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigFileOverride, setConfigFileOverride } from "../../config-override.js";
import { ApiKeyCredentialProvider, realValue } from "./api-key-credential.js";
import { __resetSniffForTests } from "./op-source.js";

const ENV_VAR = "CLAUDISH_TEST_PLACEHOLDER_ONLY_API_KEY";
const HERMETIC_CONFIG = join(
  tmpdir(),
  `claudish-api-key-credential-${process.pid}-does-not-exist.json`
);

let savedEnv: string | undefined;
let savedDisableKeychain: string | undefined;
let savedDisableOp: string | undefined;
let savedConfigOverride: string | null;

beforeEach(() => {
  savedEnv = process.env[ENV_VAR];
  savedDisableKeychain = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  savedDisableOp = process.env.CLAUDISH_DISABLE_OP;
  savedConfigOverride = getConfigFileOverride();

  delete process.env[ENV_VAR];
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  process.env.CLAUDISH_DISABLE_OP = "1";
  // Keep getApiKey() away from both the real global config and any project
  // overlay. A missing override file resolves as an empty config.
  setConfigFileOverride(HERMETIC_CONFIG);
  __resetSniffForTests();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv;
  if (savedDisableKeychain === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedDisableKeychain;
  if (savedDisableOp === undefined) delete process.env.CLAUDISH_DISABLE_OP;
  else process.env.CLAUDISH_DISABLE_OP = savedDisableOp;
  setConfigFileOverride(savedConfigOverride);
  __resetSniffForTests();
});

describe("realValue", () => {
  it("rejects an exact unexpanded environment placeholder", () => {
    expect(realValue("${OPENROUTER_API_KEY}")).toBeUndefined();
  });

  it("preserves real and merely placeholder-like values and handles empty-ish input", () => {
    expect(realValue("sk-real-key")).toBe("sk-real-key");
    expect(realValue(undefined)).toBeUndefined();
    expect(realValue("")).toBeUndefined();
    expect(realValue("prefix-${OPENROUTER_API_KEY}-suffix")).toBe(
      "prefix-${OPENROUTER_API_KEY}-suffix"
    );
  });
});

describe("ApiKeyCredentialProvider placeholder guard", () => {
  it("is unavailable when its only env value is an unexpanded placeholder", async () => {
    process.env[ENV_VAR] = `\${${ENV_VAR}}`;
    const provider = new ApiKeyCredentialProvider({
      catalogName: "placeholder-only-test",
      envVar: ENV_VAR,
    });

    expect(await provider.isAvailable()).toBe(false);
  });
});
