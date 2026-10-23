// Atomic JSON file writes: serialize first, write a temp file in the same
// directory, then rename over the target — a concurrent reader never sees a
// half-written file (an external monitor polls session meta.json while the
// session is live). Port of upstream 9aef742c, which relies on a helper this
// fork did not have.
//
// win32: a scanner (antivirus, indexer) can hold the fresh temp file open and
// fail the rename with EPERM/EBUSY/EACCES — the well-known reason graceful-fs
// retries renames. The whole fleet is Windows, so on any temp+rename failure
// we fall back to the direct write this helper replaced: never worse than the
// old code, and the caller (a proc exit listener) never sees a new error
// class from the rename itself.

import * as nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type AtomicFsSeam = Pick<typeof nodeFs, "writeFileSync" | "renameSync" | "unlinkSync">;

export function writeJsonAtomic(filePath: string, value: unknown, fs: AtomicFsSeam = nodeFs): void {
  // Serialize before touching the filesystem: a serialization failure must
  // leave any pre-existing target intact.
  const data = JSON.stringify(value, null, 2);
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, data, "utf-8");
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort: the tmp file may never have been created
    }
    // Never worse than the code this replaced: land the write directly.
    fs.writeFileSync(filePath, data, "utf-8");
  }
}
