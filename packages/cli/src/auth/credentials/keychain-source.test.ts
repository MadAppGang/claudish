import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigFileOverride, setConfigFileOverride } from "../../config-override.js";
import type { KeychainDeps, KeychainRunResult } from "../../providers/keychain.js";
import { setKeychainTestDeps } from "../../providers/keychain.js";
import {
  hasKeychainSource,
  hydrateKeychainIntoEnv,
  isKeychainHydratedVar,
  keychainHasAnyOf,
  resetKeychainHydrationRecord,
  resolveKeychainKeyForEnvVars,
} from "./keychain-source.js";

// Captured in ai-docs/reports/keychain-security-cli-measurements.md §2.
const SEARCH_FAILURE_STDERR =
  "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
const PRIMARY_ENV = "GEMINI_API_KEY";
const ALIAS_ENV = "GOOGLE_API_KEY";
const MISSING_ENV = "CLAUDISH_KEYCHAIN_TEST_MISSING_API_KEY";
const TOUCHED_ENV_VARS = [PRIMARY_ENV, ALIAS_ENV, MISSING_ENV] as const;

const REAL_DUMP_BLOCK = `keychain: "/Users/jack/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="claudish: GEMINI_API_KEY"
    "acct"<blob>="GEMINI_API_KEY"
    "cdat"<timedate>=0x32303236303832323132333235385A00
    "desc"<blob>="application password"
    "icmt"<blob>="Stored by claudish"
    "svce"<blob>="claudish"`;

interface RunCall {
  args: string[];
  stdin: string | undefined;
}

let tempDirectory: string;
let configFile: string;
let savedConfigOverride: string | null;
let savedDisableKeychain: string | undefined;
let savedEnv: Map<string, string | undefined>;
let fakePlatform: string;
let runCalls: RunCall[];
let runAsyncCalls: RunCall[];
let runImpl: KeychainDeps["run"];
let runAsyncImpl: KeychainDeps["runAsync"];

function result(code: number, stdout = "", stderr = ""): KeychainRunResult {
  return { code, stdout, stderr };
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(configFile, JSON.stringify(config));
}

function blockForAccount(envVar: string): string {
  return REAL_DUMP_BLOCK.replaceAll(PRIMARY_ENV, envVar);
}

function enableKeychainSource(): void {
  writeConfig({ keychain: { enabled: true } });
}

beforeAll(() => {
  savedDisableKeychain = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
});

afterAll(() => {
  if (savedDisableKeychain === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedDisableKeychain;
});

beforeEach(() => {
  savedConfigOverride = getConfigFileOverride();
  tempDirectory = mkdtempSync(join(tmpdir(), "claudish-keychain-source-"));
  configFile = join(tempDirectory, "config.json");
  writeConfig({});
  setConfigFileOverride(configFile);

  savedEnv = new Map(TOUCHED_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of TOUCHED_ENV_VARS) delete process.env[name];

  fakePlatform = "darwin";
  runCalls = [];
  runAsyncCalls = [];
  runImpl = () => {
    throw new Error("unexpected synchronous keychain call");
  };
  runAsyncImpl = async () => {
    throw new Error("unexpected asynchronous keychain call");
  };
  setKeychainTestDeps({
    platform: () => fakePlatform,
    run: (args, stdin) => {
      runCalls.push({ args: [...args], stdin });
      return runImpl(args, stdin);
    },
    runAsync: async (args, stdin) => {
      runAsyncCalls.push({ args: [...args], stdin });
      return runAsyncImpl(args, stdin);
    },
  });
  resetKeychainHydrationRecord();
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetKeychainHydrationRecord();
  setKeychainTestDeps(null);
  setConfigFileOverride(savedConfigOverride);
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("hasKeychainSource", () => {
  it("is false when config has no keychain.enabled flag", () => {
    expect(hasKeychainSource()).toBe(false);
    expect(runCalls).toHaveLength(0);
  });

  it("is true when keychain.enabled is set", () => {
    enableKeychainSource();

    expect(hasKeychainSource()).toBe(true);
    expect(runCalls).toHaveLength(0);
  });

  it("honors CLAUDISH_DISABLE_KEYCHAIN after the source sniff is memoized", () => {
    enableKeychainSource();
    expect(hasKeychainSource()).toBe(true);

    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    try {
      expect(hasKeychainSource()).toBe(false);
      expect(resolveKeychainKeyForEnvVars([PRIMARY_ENV])).toEqual({ failed: false });
      expect(runCalls).toHaveLength(0);
      expect(runAsyncCalls).toHaveLength(0);
    } finally {
      delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    }
  });

  it("is false on a non-darwin platform regardless of config", () => {
    enableKeychainSource();
    fakePlatform = "linux";

    expect(hasKeychainSource()).toBe(false);
    expect(runCalls).toHaveLength(0);
  });
});

describe("resolveKeychainKeyForEnvVars", () => {
  it("returns a clean miss with no value when nothing is stored", () => {
    enableKeychainSource();
    const otherServiceBlock = REAL_DUMP_BLOCK.replace(
      '"svce"<blob>="claudish"',
      '"svce"<blob>="claudish-probe"'
    );
    runImpl = () => result(0, otherServiceBlock);

    const resolved = resolveKeychainKeyForEnvVars([PRIMARY_ENV]);

    expect(resolved).toEqual({ failed: false });
    expect("value" in resolved).toBe(false);
    expect(runCalls).toEqual([{ args: ["dump-keychain"], stdin: undefined }]);
  });

  it("returns the stored value for the primary variable", () => {
    enableKeychainSource();
    runImpl = (args) => {
      if (args[0] === "dump-keychain") return result(0, REAL_DUMP_BLOCK);
      if (args[0] === "find-generic-password") return result(0, "primary-value\n");
      throw new Error(`unexpected keychain command: ${args[0]}`);
    };

    expect(resolveKeychainKeyForEnvVars([PRIMARY_ENV, ALIAS_ENV])).toEqual({
      value: "primary-value",
      failed: false,
    });
  });

  it("falls back to an alias when the primary variable is absent", () => {
    enableKeychainSource();
    const aliasBlock = blockForAccount(ALIAS_ENV);
    runImpl = (args) => {
      if (args[0] === "dump-keychain") return result(0, aliasBlock);
      if (args[0] === "find-generic-password") return result(0, "alias-value\n");
      throw new Error(`unexpected keychain command: ${args[0]}`);
    };

    expect(resolveKeychainKeyForEnvVars([MISSING_ENV, ALIAS_ENV])).toEqual({
      value: "alias-value",
      failed: false,
    });
    expect(runCalls.at(-1)?.args).toEqual([
      "find-generic-password",
      "-s",
      "claudish",
      "-a",
      ALIAS_ENV,
      "-w",
    ]);
  });

  it("propagates an enumeration failure as a transient failure", () => {
    enableKeychainSource();
    runImpl = () => result(1, "", SEARCH_FAILURE_STDERR);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const resolved = resolveKeychainKeyForEnvVars([PRIMARY_ENV]);

      // The reason travels with the flag. Without it the caller can say
      // "unavailable" but not WHICH store was unreachable, which is the
      // difference between telling a user to unlock their keychain and telling
      // them they have no subscription.
      expect(resolved).toEqual({ failed: true, error: SEARCH_FAILURE_STDERR });
      expect("value" in resolved).toBe(false);
      expect(runCalls).toEqual([{ args: ["dump-keychain"], stdin: undefined }]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("marks an underlying read failure as transient", () => {
    enableKeychainSource();
    runImpl = (args) =>
      args[0] === "dump-keychain"
        ? result(0, REAL_DUMP_BLOCK)
        : result(1, "", SEARCH_FAILURE_STDERR);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const resolved = resolveKeychainKeyForEnvVars([PRIMARY_ENV]);
      expect(resolved.failed).toBe(true);
      // A per-item read failure surfaces the engine's KeychainError message,
      // not the enumeration diagnostic — enumeration succeeded here.
      expect(resolved.error).toContain(SEARCH_FAILURE_STDERR);
      expect("value" in resolved).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("hydrateKeychainIntoEnv", () => {
  it("preserves env values and records only variables absent from env and config", async () => {
    enableKeychainSource();
    process.env[PRIMARY_ENV] = "shell-value";
    delete process.env[ALIAS_ENV];
    runImpl = () => result(0, `${REAL_DUMP_BLOCK}\n${blockForAccount(ALIAS_ENV)}`);
    runAsyncImpl = async (args) => {
      if (args[0] === "find-generic-password" && args[4] === ALIAS_ENV) {
        return result(0, "keychain-alias-value\n");
      }
      throw new Error(`unexpected asynchronous keychain command: ${args.join(" ")}`);
    };

    const hydrated = await hydrateKeychainIntoEnv();

    expect(hydrated).toBe(1);
    expect(process.env[PRIMARY_ENV]).toBe("shell-value");
    expect(process.env[ALIAS_ENV]).toBe("keychain-alias-value");
    expect(isKeychainHydratedVar(PRIMARY_ENV)).toBe(false);
    expect(isKeychainHydratedVar(ALIAS_ENV)).toBe(true);
    expect(isKeychainHydratedVar(MISSING_ENV)).toBe(false);
    expect(runAsyncCalls).toHaveLength(1);
    expect(runAsyncCalls[0]?.args[4]).toBe(ALIAS_ENV);
  });

  it("does not hydrate a variable already stored in config.apiKeys", async () => {
    writeConfig({
      keychain: { enabled: true },
      apiKeys: { [PRIMARY_ENV]: "config-value" },
    });
    runImpl = () => result(0, REAL_DUMP_BLOCK);

    const hydrated = await hydrateKeychainIntoEnv();

    expect(hydrated).toBe(0);
    expect(process.env[PRIMARY_ENV]).toBeUndefined();
    expect(isKeychainHydratedVar(PRIMARY_ENV)).toBe(false);
    expect(runCalls).toEqual([{ args: ["dump-keychain"], stdin: undefined }]);
    expect(runAsyncCalls).toHaveLength(0);
  });

  it("hydrates nothing when enumeration fails", async () => {
    enableKeychainSource();
    runImpl = () => result(1, "", SEARCH_FAILURE_STDERR);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const hydrated = await hydrateKeychainIntoEnv();

      expect(hydrated).toBe(0);
      expect(process.env[PRIMARY_ENV]).toBeUndefined();
      expect(isKeychainHydratedVar(PRIMARY_ENV)).toBe(false);
      expect(runCalls).toEqual([{ args: ["dump-keychain"], stdin: undefined }]);
      expect(runAsyncCalls).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("keychainHasAnyOf", () => {
  it("checks presence without reading any stored value", () => {
    enableKeychainSource();
    runImpl = () => result(0, REAL_DUMP_BLOCK);

    expect(keychainHasAnyOf([MISSING_ENV, PRIMARY_ENV])).toBe(true);
    expect(keychainHasAnyOf([MISSING_ENV])).toBe(false);
    expect(runCalls).toEqual([{ args: ["dump-keychain"], stdin: undefined }]);
    expect(runCalls.some(({ args }) => args[0] === "find-generic-password")).toBe(false);
    expect(runAsyncCalls).toHaveLength(0);
  });
});
