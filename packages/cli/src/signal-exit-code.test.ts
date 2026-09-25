import { describe, expect, test } from "bun:test";
import { constants } from "node:os";
import { signalExitCode } from "./signal-exit-code.js";

describe("signalExitCode", () => {
  test.each([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGKILL", 137],
    ["SIGTERM", 143],
  ] as const)("%s gives %i", (signal, code) => {
    expect(signalExitCode(signal)).toBe(code);
  });

  test.skipIf(process.platform === "win32")("takes a platform's own number from the OS", () => {
    expect(signalExitCode("SIGBUS")).toBe(128 + constants.signals.SIGBUS);
  });

  test("gives 128, never 0, for a signal this platform does not know", () => {
    expect(signalExitCode("SIGNOTASIGNAL" as NodeJS.Signals)).toBe(128);
  });
});
