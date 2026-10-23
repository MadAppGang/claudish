import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `text` to `path` through a temp file and a rename, so another claudish
 * process never reads a half-written file. An in-place write truncates first, and
 * a reader in that window parses broken JSON, which every catalog reader takes for
 * "no cache": several MCP servers starting together hit it.
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // pid alone can repeat across PID namespaces sharing one ~/.claudish (containers).
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmp, text, "utf-8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing was left behind.
    }
    throw error;
  }
}
