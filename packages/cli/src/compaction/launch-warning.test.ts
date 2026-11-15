import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSigningLease } from "../redact.js";
import { compactionLaunchArgs } from "./launch.js";

// A path segment equal to a value on a signing lease: the folder error quotes it.
const SECRET_SEGMENT = "FAKE-lease-value-launch-0123456789";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-launch-warn-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a folder that cannot be prepared adds nothing and warns through the redacting logger", () => {
  // The root is a file, so its session folder cannot be created.
  const root = join(dir, SECRET_SEGMENT);
  writeFileSync(root, "not a directory");
  const lease = acquireSigningLease();
  lease.add([SECRET_SEGMENT]);
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let result: ReturnType<typeof compactionLaunchArgs>;
  try {
    result = compactionLaunchArgs([], root);
  } finally {
    process.stderr.write = write;
    lease.release();
  }
  expect(result).toEqual({ leadingArgs: [], mintedSessionId: null });
  const text = written.join("");
  expect(text).toContain("[compaction] the session folder could not be prepared");
  expect(text).not.toContain(SECRET_SEGMENT);
});

test("a folder that can be prepared returns the leading arguments", () => {
  const result = compactionLaunchArgs([], join(dir, "root"), () => "minted-id");
  expect(result.mintedSessionId).toBe("minted-id");
  expect(result.leadingArgs).toEqual([
    "--session-id",
    "minted-id",
    "--add-dir",
    join(dir, "root", "minted-id"),
  ]);
});
