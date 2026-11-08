import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { KeychainDeps, KeychainRunResult } from "./keychain.js";
import {
  KeychainError,
  deleteKeychainSecret,
  enumerateKeychainVars,
  invalidateKeychainCache,
  listKeychainVars,
  lookupKeychainVar,
  parseDumpAccounts,
  readKeychainSecret,
  setKeychainTestDeps,
  valueTail,
  writeKeychainSecret,
} from "./keychain.js";

const NOT_FOUND_STDERR =
  "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
const ITEM_EXISTS_STDERR =
  "security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.";
const UNKNOWN_COMMAND_STDERR = 'security: unknown command "..."';

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

let fakePlatform: string;
let runCalls: RunCall[];
let runAsyncCalls: RunCall[];
let runImpl: KeychainDeps["run"];
let runAsyncImpl: KeychainDeps["runAsync"];

function result(code: number, stdout = "", stderr = ""): KeychainRunResult {
  return { code, stdout, stderr };
}

function thrownKeychainError(action: () => unknown): KeychainError {
  let thrown: unknown;
  try {
    action();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(KeychainError);
  return thrown as KeychainError;
}

beforeEach(() => {
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
});

afterEach(() => {
  setKeychainTestDeps(null);
});

describe("readKeychainSecret", () => {
  it("strips exactly one trailing newline from a hit", () => {
    runImpl = () => result(0, "value\n");

    expect(readKeychainSecret("GEMINI_API_KEY")).toBe("value");
  });

  it("preserves meaningful trailing whitespace", () => {
    runImpl = () => result(0, "value \t\n");

    expect(readKeychainSecret("GEMINI_API_KEY")).toBe("value \t");
  });

  it("returns null for the captured item-not-found exit", () => {
    runImpl = () => result(44, "", NOT_FOUND_STDERR);

    expect(readKeychainSecret("GEMINI_API_KEY")).toBeNull();
  });

  it("throws KeychainError with the exit code for another failure", () => {
    runImpl = () => result(1, "", UNKNOWN_COMMAND_STDERR);

    const error = thrownKeychainError(() => readKeychainSecret("GEMINI_API_KEY"));
    expect(error.exitCode).toBe(1);
  });

  it("reports a signal-killed spawn without fabricating exit code 1", () => {
    runImpl = () => result(-1, "", "security killed by SIGTERM");

    const error = thrownKeychainError(() => readKeychainSecret("GEMINI_API_KEY"));
    expect(error.exitCode).toBe(-1);
    expect(error.message).toContain("killed by SIGTERM");
    expect(error.message).not.toContain("exited 1");
  });

  it("returns null without running security on a non-darwin platform", () => {
    fakePlatform = "linux";

    expect(readKeychainSecret("GEMINI_API_KEY")).toBeNull();
    expect(runCalls).toHaveLength(0);
    expect(runAsyncCalls).toHaveLength(0);
  });

  it("memoizes repeated hits in the same burst", () => {
    runImpl = () => result(0, "value\n");

    expect(readKeychainSecret("GEMINI_API_KEY")).toBe("value");
    expect(readKeychainSecret("GEMINI_API_KEY")).toBe("value");
    expect(runCalls).toHaveLength(1);
  });

  it("memoizes misses in the same burst", () => {
    runImpl = () => result(44, "", NOT_FOUND_STDERR);

    expect(readKeychainSecret("GEMINI_API_KEY")).toBeNull();
    expect(readKeychainSecret("GEMINI_API_KEY")).toBeNull();
    expect(runCalls).toHaveLength(1);
  });

  it("reads again after invalidateKeychainCache", () => {
    runImpl = () => result(0, "value\n");

    expect(readKeychainSecret("GEMINI_API_KEY")).toBe("value");
    expect(readKeychainSecret("GEMINI_API_KEY")).toBe("value");
    invalidateKeychainCache();
    expect(readKeychainSecret("GEMINI_API_KEY")).toBe("value");
    expect(runCalls).toHaveLength(2);
  });
});

describe("parseDumpAccounts and keychain enumeration", () => {
  it("extracts GEMINI_API_KEY from the captured dump block", () => {
    expect(parseDumpAccounts(REAL_DUMP_BLOCK)).toEqual(["GEMINI_API_KEY"]);
  });

  it("does not prefix-match a different service", () => {
    const probeBlock = REAL_DUMP_BLOCK.replace(
      '"svce"<blob>="claudish"',
      '"svce"<blob>="claudish-probe"'
    );

    expect(probeBlock).toContain('"svce"<blob>="claudish-probe"');
    expect(parseDumpAccounts(probeBlock)).toEqual([]);
  });

  it("ignores accounts that are not valid environment variable names", () => {
    const invalidAccountBlock = REAL_DUMP_BLOCK.replace(
      '"acct"<blob>="GEMINI_API_KEY"',
      '"acct"<blob>="not-an-env-var"'
    );

    expect(parseDumpAccounts(invalidAccountBlock)).toEqual([]);
  });

  it("returns names with failed false for a successful real dump", () => {
    runImpl = () => result(0, REAL_DUMP_BLOCK);

    expect(enumerateKeychainVars()).toEqual({
      names: ["GEMINI_API_KEY"],
      failed: false,
    });
    expect(listKeychainVars()).toEqual(["GEMINI_API_KEY"]);
    expect(runCalls).toHaveLength(1);
  });

  it("returns a failed enumeration without exposing key material", () => {
    const keyMaterial = 'canary value with "quotes" and \\backslashes';
    runImpl = () => result(1, keyMaterial, UNKNOWN_COMMAND_STDERR);

    const enumerated = enumerateKeychainVars();

    expect(enumerated).toEqual({
      names: [],
      failed: true,
      error: "security exited 1",
    });
    expect(typeof enumerated.error).toBe("string");
    expect(enumerated.error).not.toContain(keyMaterial);
  });

  it("memoizes an enumeration failure for the burst and retries after the TTL", () => {
    let nowMs = 1_000;
    let attempt = 0;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => nowMs);
    runImpl = () => {
      attempt++;
      return attempt === 1 ? result(1, "", UNKNOWN_COMMAND_STDERR) : result(0, REAL_DUMP_BLOCK);
    };

    try {
      expect(enumerateKeychainVars().failed).toBe(true);
      expect(enumerateKeychainVars().failed).toBe(true);
      expect(runCalls).toHaveLength(1);

      nowMs += 3_001;

      expect(enumerateKeychainVars()).toEqual({
        names: ["GEMINI_API_KEY"],
        failed: false,
      });
      expect(runCalls).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns an empty list when dump-keychain exits non-zero", () => {
    runImpl = () => result(1, "", UNKNOWN_COMMAND_STDERR);

    expect(listKeychainVars()).toEqual([]);
    expect(runCalls).toEqual([{ args: ["dump-keychain"], stdin: undefined }]);
  });
});

describe("lookupKeychainVar", () => {
  it("reports a present variable after successful enumeration", () => {
    runImpl = () => result(0, REAL_DUMP_BLOCK);

    expect(lookupKeychainVar("GEMINI_API_KEY")).toEqual({
      present: true,
      failed: false,
    });
  });

  it("reports a genuine absence after successful enumeration", () => {
    runImpl = () => result(0, REAL_DUMP_BLOCK);

    expect(lookupKeychainVar("MISSING_API_KEY")).toEqual({
      present: false,
      failed: false,
    });
  });

  it("reports an unknown presence when enumeration fails", () => {
    runImpl = () => result(1, "", UNKNOWN_COMMAND_STDERR);

    expect(lookupKeychainVar("GEMINI_API_KEY")).toEqual({
      present: false,
      failed: true,
    });
  });

  it("prefers a fresh value memo while enumeration is failing", () => {
    runImpl = (args) => {
      if (args[0] === "dump-keychain") return result(1, "", UNKNOWN_COMMAND_STDERR);
      if (args[0] === "find-generic-password") return result(0, "fresh-value\n");
      throw new Error(`unexpected keychain command: ${args[0]}`);
    };

    expect(enumerateKeychainVars().failed).toBe(true);
    expect(readKeychainSecret("GEMINI_API_KEY")).toBe("fresh-value");
    expect(lookupKeychainVar("GEMINI_API_KEY")).toEqual({
      present: true,
      failed: false,
    });
    expect(runCalls.map(({ args }) => args[0])).toEqual(["dump-keychain", "find-generic-password"]);
  });
});

describe("writeKeychainSecret", () => {
  it("uses security -i, plaintext stdin, quoted values, and -U without exposing plaintext in argv", () => {
    const value = 'value with spaces, "quotes", and \\backslashes';
    const quotedValue = '"value with spaces, \\"quotes\\", and \\\\backslashes"';
    runImpl = (args) => {
      if (args[0] === "-i") return result(0);
      if (args[0] === "find-generic-password") return result(0, `${value}\n`);
      throw new Error(`unexpected keychain command: ${args[0]}`);
    };

    writeKeychainSecret("GEMINI_API_KEY", value);

    expect(runCalls).toHaveLength(2);
    const write = runCalls[0];
    expect(write?.args).toEqual(["-i"]);
    expect({
      argvHasPlaintextPayload: write?.args.join(" ").includes(`-w ${quotedValue}`) ?? false,
      stdinHasPlaintextPayload: write?.stdin?.includes(`-w ${quotedValue}`) ?? false,
    }).toEqual({ argvHasPlaintextPayload: false, stdinHasPlaintextPayload: true });
    expect(write?.args.join(" ")).not.toContain(value);
    expect(write?.stdin).toContain(`-w ${quotedValue}`);
    expect(write?.stdin).not.toContain(" -X ");
    expect(write?.stdin).toContain('-s "claudish"');
    expect(write?.stdin).toContain('-a "GEMINI_API_KEY"');
    expect(write?.stdin).toContain('-l "claudish: GEMINI_API_KEY"');
    expect(write?.stdin).toContain('-D "application password"');
    expect(write?.stdin).toContain('-j "Stored by claudish"');
    expect(write?.stdin).toContain(" -U ");
    expect(write?.stdin).toContain('-T "/usr/bin/security"');
  });

  it("uses hex stdin for an accepted non-ASCII value without exposing it in argv", () => {
    const value = "café";
    const hex = Buffer.from(value, "utf8").toString("hex");
    runImpl = (args) => {
      if (args[0] === "-i") return result(0);
      if (args[0] === "find-generic-password") return result(0, `${value}\n`);
      throw new Error(`unexpected keychain command: ${args[0]}`);
    };

    writeKeychainSecret("GEMINI_API_KEY", value);

    expect(runCalls).toHaveLength(2);
    const write = runCalls[0];
    expect(write?.args).toEqual(["-i"]);
    expect(write?.args.join(" ")).not.toContain(value);
    expect(write?.args.join(" ")).not.toContain(hex);
    expect(write?.stdin).toContain(`-X "${hex}"`);
    expect(write?.stdin).not.toContain(value);
    expect(write?.stdin).not.toContain(" -w ");
  });

  it("rejects control characters before running security", () => {
    const error = thrownKeychainError(() =>
      writeKeychainSecret("GEMINI_API_KEY", "value\twith-tab")
    );

    expect(error.message).toContain("control characters");
    expect(runCalls).toHaveLength(0);
  });

  it("rejects an empty value before running security", () => {
    const error = thrownKeychainError(() => writeKeychainSecret("GEMINI_API_KEY", ""));

    expect(error.message).toContain("value is empty");
    expect(runCalls).toHaveLength(0);
  });

  it("rejects an invalid environment variable name before running security", () => {
    const error = thrownKeychainError(() => writeKeychainSecret("not-an-env-var", "value"));

    expect(error.message).toContain("not a valid environment variable name");
    expect(runCalls).toHaveLength(0);
  });

  it("throws KeychainError for a non-zero write exit", () => {
    runImpl = () => result(45, "", ITEM_EXISTS_STDERR);

    const error = thrownKeychainError(() => writeKeychainSecret("GEMINI_API_KEY", "value"));
    expect(error.exitCode).toBe(45);
    expect(runCalls).toHaveLength(1);
  });

  it("throws when the verification read returns a different value", () => {
    runImpl = (args) => (args[0] === "-i" ? result(0) : result(0, "different-value\n"));

    const error = thrownKeychainError(() =>
      writeKeychainSecret("GEMINI_API_KEY", "expected-value")
    );
    expect(error.message).toContain("did not round-trip");
    expect(runCalls).toHaveLength(2);
  });
});

describe("deleteKeychainSecret", () => {
  it("returns true when security deletes the item", () => {
    runImpl = () => result(0);

    expect(deleteKeychainSecret("GEMINI_API_KEY")).toBe(true);
    expect(runCalls).toEqual([
      {
        args: ["delete-generic-password", "-s", "claudish", "-a", "GEMINI_API_KEY"],
        stdin: undefined,
      },
    ]);
  });

  it("returns false for the captured item-not-found exit", () => {
    runImpl = () => result(44, "", NOT_FOUND_STDERR);

    expect(deleteKeychainSecret("GEMINI_API_KEY")).toBe(false);
  });

  it("throws KeychainError for another delete failure", () => {
    runImpl = () => result(1, "", UNKNOWN_COMMAND_STDERR);

    const error = thrownKeychainError(() => deleteKeychainSecret("GEMINI_API_KEY"));
    expect(error.exitCode).toBe(1);
  });
});

describe("valueTail", () => {
  it("shows the last four characters only for a sufficiently long value", () => {
    expect(valueTail("long-value-1234")).toBe("••••1234");
    expect(valueTail("short6")).toBe("••••");
    expect(valueTail("short6")).not.toContain("short6");
  });
});
