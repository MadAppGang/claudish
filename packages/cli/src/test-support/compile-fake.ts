/**
 * Compile a fake claudish entry into a standalone executable (#533).
 *
 * The `posix-path-shim` env-gate exists because an extension-less
 * `#!/bin/sh` script cannot be spawned on win32 (spawn resolves .exe/.cmd
 * only). A `.cmd` wrapper solved the wire-format file (no kill/signal
 * semantics cross the cmd.exe boundary), but session-manager and
 * timeout-repro exercise kill/timeout semantics — through cmd.exe a
 * SIGTERM kills cmd.exe and the grandchild can survive. A compiled .exe in
 * the PATH is resolved natively by spawn and receives process signals like
 * any native binary: the route that makes those two files runnable on
 * win32.
 *
 * The compile cost (~2-5 s) is paid once per target directory: if the
 * executable already exists there, the call is a no-op — the tmpdir IS the
 * cache for the lifetime of a test file.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function compileFakeExe(sourceTs: string, targetDir: string): string {
  const exe = join(targetDir, process.platform === "win32" ? "claudish.exe" : "claudish");
  if (existsSync(exe)) return exe; // tmpdir cache hit

  // process.execPath = the bun running this suite (the #175 trick: a bare
  // "bun" may be an npm shim with no .exe for CreateProcess).
  const result = spawnSync(process.execPath, ["build", "--compile", sourceTs, "--outfile", exe], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (result.status !== 0 || !existsSync(exe)) {
    throw new Error(
      `fake-claudish compile failed (status=${result.status}): ${result.stderr || result.stdout}`
    );
  }
  return exe;
}
