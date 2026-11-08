import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_MAGMUX_VERSION,
  MagmuxUnavailableError,
  assertMagmuxAvailable,
} from "./pane-launch.js";

const tempDirs: string[] = [];
const testTimeout = 4_500;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fakeMagmux(body: string): { binary: string; runs: () => number } {
  const directory = mkdtempSync(join(tmpdir(), "pane-launch-version-probe-"));
  tempDirs.push(directory);
  const binary = join(directory, "magmux");
  const counter = join(directory, "runs");
  writeFileSync(
    binary,
    `#!/bin/sh
counter=${shellQuote(counter)}
printf '%s\\n' run >> "$counter"
if [ "$#" -ne 1 ] || [ "$1" != "--version" ]; then
  printf '%s\\n' 'expected exactly --version' >&2
  exit 64
fi
${body}
`
  );
  chmodSync(binary, 0o755);
  return {
    binary,
    runs: () => {
      if (!existsSync(counter)) return 0;
      return readFileSync(counter, "utf8").trim().split("\n").length;
    },
  };
}

async function expectUnavailable(binary: string, ...messageParts: string[]): Promise<void> {
  try {
    await assertMagmuxAvailable(binary);
  } catch (error) {
    expect(error).toBeInstanceOf(MagmuxUnavailableError);
    if (!(error instanceof MagmuxUnavailableError)) {
      throw error;
    }
    expect(error.code).toBe("magmux_unavailable");
    for (const part of messageParts) {
      expect(error.message).toContain(part);
    }
    return;
  }
  throw new Error("Expected assertMagmuxAvailable to reject");
}

afterAll(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("magmux version probe", () => {
  test(
    "B1: six overlapping callers share exactly one probe",
    async () => {
      const fake = fakeMagmux(`sleep 0.3
printf '%s\\n' 'magmux ${MIN_MAGMUX_VERSION} (test-build)'`);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => assertMagmuxAvailable(fake.binary))
      );

      expect(results).toHaveLength(6);
      for (const result of results) {
        expect(result).toEqual({ binary: fake.binary, version: MIN_MAGMUX_VERSION });
      }
      expect(fake.runs()).toBe(1);
    },
    testTimeout
  );

  test(
    "B2: accepts a version printed only on stderr",
    async () => {
      const fake = fakeMagmux(`printf '%s\\n' 'magmux ${MIN_MAGMUX_VERSION}' >&2`);

      expect(await assertMagmuxAvailable(fake.binary)).toEqual({
        binary: fake.binary,
        version: MIN_MAGMUX_VERSION,
      });
      expect(fake.runs()).toBe(1);
    },
    testTimeout
  );

  test(
    "B3: retries once when a successful first run prints nothing",
    async () => {
      const fake = fakeMagmux(`if [ "$(wc -l < "$counter")" -eq 1 ]; then
  exit 0
fi
printf '%s\\n' 'magmux ${MIN_MAGMUX_VERSION}'`);

      expect(await assertMagmuxAvailable(fake.binary)).toEqual({
        binary: fake.binary,
        version: MIN_MAGMUX_VERSION,
      });
      expect(fake.runs()).toBe(2);
    },
    testTimeout
  );

  test(
    "B4: rejects an unknown version after exactly two runs",
    async () => {
      const fake = fakeMagmux(`printf '%s\\n' 'magmux development build'
printf '%s\\n' 'version metadata unavailable' >&2`);

      await expectUnavailable(fake.binary, "is version unknown", `>= ${MIN_MAGMUX_VERSION}`);
      expect(fake.runs()).toBe(2);
    },
    testTimeout
  );

  test(
    "B5: rejects a version below the floor without retrying",
    async () => {
      const fake = fakeMagmux("printf '%s\\n' 'magmux 0.16.0'");

      await expectUnavailable(fake.binary, "is version 0.16.0", `>= ${MIN_MAGMUX_VERSION}`);
      expect(fake.runs()).toBe(1);
    },
    testTimeout
  );

  test(
    "B6: a rejected probe is not cached for the next call",
    async () => {
      const fake = fakeMagmux(`if [ "$(wc -l < "$counter")" -eq 1 ]; then
  printf '%s\\n' 'magmux 0.16.0'
else
  printf '%s\\n' 'magmux ${MIN_MAGMUX_VERSION}'
fi`);

      await expectUnavailable(fake.binary, "is version 0.16.0");
      expect(fake.runs()).toBe(1);

      expect(await assertMagmuxAvailable(fake.binary)).toEqual({
        binary: fake.binary,
        version: MIN_MAGMUX_VERSION,
      });
      expect(fake.runs()).toBe(2);
    },
    testTimeout
  );

  test(
    "B7: a successful probe is cached for subsequent calls",
    async () => {
      const fake = fakeMagmux(`printf '%s\\n' 'magmux ${MIN_MAGMUX_VERSION}'`);
      const expected = { binary: fake.binary, version: MIN_MAGMUX_VERSION };

      expect(await assertMagmuxAvailable(fake.binary)).toEqual(expected);
      expect(fake.runs()).toBe(1);

      for (let index = 0; index < 3; index++) {
        expect(await assertMagmuxAvailable(fake.binary)).toEqual(expected);
        expect(fake.runs()).toBe(1);
      }
    },
    testTimeout
  );

  test(
    "B8: a non-zero exit rejects with a version-command failure",
    async () => {
      const fake = fakeMagmux(`printf '%s\\n' 'magmux probe failed' >&2
exit 7`);

      await expectUnavailable(fake.binary, "--version failed");
      expect(fake.runs()).toBeGreaterThanOrEqual(1);
    },
    testTimeout
  );

  test(
    "B8: a non-executable binary rejects with a version-command failure",
    async () => {
      const fake = fakeMagmux(`printf '%s\\n' 'magmux ${MIN_MAGMUX_VERSION}'`);
      chmodSync(fake.binary, 0o644);

      await expectUnavailable(fake.binary, "--version failed");
      expect(fake.runs()).toBe(0);
    },
    testTimeout
  );

  test(
    "B9: accepts a release candidate and returns only its version triple",
    async () => {
      const fake = fakeMagmux(`printf '%s\\n' 'magmux ${MIN_MAGMUX_VERSION}-rc1'`);

      expect(await assertMagmuxAvailable(fake.binary)).toEqual({
        binary: fake.binary,
        version: MIN_MAGMUX_VERSION,
      });
      expect(fake.runs()).toBe(1);
    },
    testTimeout
  );

  test(
    "B9: accepts a newer version",
    async () => {
      const fake = fakeMagmux("printf '%s\\n' 'magmux 0.18.2'");

      expect(await assertMagmuxAvailable(fake.binary)).toEqual({
        binary: fake.binary,
        version: "0.18.2",
      });
      expect(fake.runs()).toBe(1);
    },
    testTimeout
  );
});
