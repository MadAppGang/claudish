/**
 * readProcessTableAsync must never reject: every caller (`void ….then(…)` in setPanePid, the
 * registry tick, the reap) assumes "[] on failure", the contract its sync twin already honours.
 *
 * Node's spawn contract (Bun copies it) reports only ENOENT/EACCES/EAGAIN/EMFILE/ENFILE through
 * the execFile callback and THROWS every other errno synchronously. A macOS sandbox refuses to
 * exec the setuid /bin/ps with EPERM, so the throw escapes the Promise executor, the promise
 * rejects, and the unhandled rejection exits the MCP server with code 1.
 *
 * Kept apart from process-identity.test.ts because it mocks node:child_process, and Bun's
 * mock.module is process-global: the mock below passes every call through to the real execFile
 * unless a test arms it, and the real module is restored in afterAll.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as __realChildProcess from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const __realChildProcessExports = { ...__realChildProcess };

/** When set, the mocked execFile throws this synchronously, as spawn does for EPERM. */
let syncSpawnError: NodeJS.ErrnoException | null = null;

mock.module("node:child_process", () => ({
  ...__realChildProcessExports,
  execFile: (...args: unknown[]) => {
    if (syncSpawnError) throw syncSpawnError;
    return (__realChildProcessExports.execFile as (...a: unknown[]) => unknown)(...args);
  },
}));

afterEach(() => {
  syncSpawnError = null;
});

afterAll(() => {
  mock.module("node:child_process", () => __realChildProcessExports);
});

import { readProcessTableAsync } from "./process-identity.js";

function epermSpawnError(): NodeJS.ErrnoException {
  const err = new Error(
    "EPERM: operation not permitted, posix_spawn 'ps'"
  ) as NodeJS.ErrnoException;
  err.code = "EPERM";
  err.errno = -1;
  err.syscall = "spawn";
  err.path = "ps";
  return err;
}

describe("readProcessTableAsync — spawn failure", () => {
  // REGRESSION: readProcessTableAsync rejects when execFile throws synchronously (EPERM from a macOS sandbox refusing setuid /bin/ps) — Fixed in /dev:fix session dev-fix-20261020-182839-b87ae677
  test("resolves to [] instead of rejecting when execFile throws EPERM synchronously", async () => {
    syncSpawnError = epermSpawnError();

    const rows = await readProcessTableAsync();

    expect(rows).toEqual([]);
  });

  test("reads the real table when spawn succeeds (control: the mock passes through)", async () => {
    const rows = await readProcessTableAsync();

    expect(rows.some((r) => r.pid === process.pid)).toBe(true);
  });
});

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const IS_DARWIN = process.platform === "darwin";
const HAVE_SANDBOX = IS_DARWIN && existsSync(SANDBOX_EXEC);
if (!HAVE_SANDBOX) {
  console.warn(
    `SKIP readProcessTableAsync sandbox test: needs macOS with ${SANDBOX_EXEC} (platform=${process.platform}). ` +
      "CI's macOS runner must satisfy this, or the real EPERM path is untested."
  );
}

describe.skipIf(!HAVE_SANDBOX)(
  "readProcessTableAsync — inside a macOS sandbox (darwin only)",
  () => {
    // REGRESSION: readProcessTableAsync rejects when execFile throws synchronously (EPERM from a macOS sandbox refusing setuid /bin/ps) — Fixed in /dev:fix session dev-fix-20261020-182839-b87ae677
    test("resolves to 0 rows and the process exits 0 when the sandbox refuses /bin/ps", () => {
      const modulePath = join(import.meta.dir, "process-identity.ts");
      // `void …then(…)` is the shape of the real call site (pane-session setPanePid): a rejection
      // here is unhandled and exits the process with code 1.
      const script =
        `import { readProcessTableAsync } from ${JSON.stringify(modulePath)};\n` +
        `void readProcessTableAsync().then((t) => { console.log("rows " + t.length); process.exit(0); });\n` +
        "setInterval(() => {}, 1000);\n" +
        `setTimeout(() => { console.log("timeout"); process.exit(3); }, 10000);\n`;

      const res = spawnSync(
        SANDBOX_EXEC,
        ["-p", "(version 1)(allow default)", process.execPath, "--no-env-file", "-e", script],
        { encoding: "utf8", timeout: 20_000 }
      );

      expect({
        status: res.status,
        stdout: res.stdout.trim(),
        stderr: res.stderr.includes("EPERM"),
      }).toEqual({
        status: 0,
        stdout: "rows 0",
        stderr: false,
      });
    });
  }
);
