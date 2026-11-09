import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { _resetAntigravityTokenState, defaultAntigravityTokenDeps } from "./antigravity-token.js";

let savedDisableKeychain: string | undefined;
let execSpy: ReturnType<typeof spyOn<typeof childProcess, "execFileSync">>;

beforeEach(() => {
  savedDisableKeychain = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  _resetAntigravityTokenState();
  execSpy = spyOn(childProcess, "execFileSync").mockReturnValue("");
});

afterEach(() => {
  if (savedDisableKeychain === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedDisableKeychain;
  _resetAntigravityTokenState();
  execSpy.mockRestore();
});

describe.skipIf(process.platform !== "darwin")("Antigravity default shared-store reads", () => {
  test("disabled Keychain returns null without spawning security", () => {
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    execSpy.mockReturnValue("offline-shared-store-value");

    expect({
      value: defaultAntigravityTokenDeps().readStore(),
      securityCalls: execSpy.mock.calls.length,
    }).toEqual({ value: null, securityCalls: 0 });
  });

  test("the security value read has no timeout or kill signal", () => {
    // The subprocess spy is installed before enabling this path.
    delete process.env.CLAUDISH_DISABLE_KEYCHAIN;

    expect(defaultAntigravityTokenDeps().readStore()).toBeNull();
    expect(execSpy).toHaveBeenCalledTimes(1);
    const [command, args, options] = execSpy.mock.calls[0]!;
    expect(command).toBe("security");
    expect(args).toEqual(["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
    // Killing security mid-transaction can restart securityd.
    const readOptions = options as childProcess.ExecFileSyncOptions | undefined;
    expect(readOptions?.timeout).toBeUndefined();
    expect(readOptions?.killSignal).toBeUndefined();
  });
});
