import { existsSync, readFileSync } from "node:fs";

/** A turn file's content, kept once read: a session's turn directory goes when it is reaped. */
const turnFileContent = new Map<string, string>();
const POINTER_RE = /^Your task is in the file `([^`]+)`\./;

/**
 * Every line the fake child logged as submitted (`FAKE_KEYLOG`), a pointer line read as the
 * content of the turn file it names: what the prompt said, however it was delivered.
 */
export function readKeylog(path: string): string[] {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  return lines.map((line) => {
    const file = POINTER_RE.exec(line)?.[1];
    if (!file) return line;
    if (!turnFileContent.has(file) && existsSync(file))
      turnFileContent.set(file, readFileSync(file, "utf8"));
    return turnFileContent.get(file) ?? line;
  });
}
