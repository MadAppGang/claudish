import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudish-fs-atomic-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("writes exact UTF-8 content and leaves no temp file", () => {
    const path = join(root, "cache.json");
    const content = '{"value":"hello 🌍"}\n';
    writeFileAtomic(path, content);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(readdirSync(root)).toEqual(["cache.json"]);
    expect(existsSync(`${path}.tmp.${process.pid}`)).toBe(false);
  });

  test("creates parent directories and replaces previous content completely", () => {
    const path = join(root, "nested", "cache.json");
    writeFileAtomic(path, "a longer previous value");
    writeFileAtomic(path, "");
    expect(readFileSync(path, "utf8")).toBe("");
    expect(readdirSync(join(root, "nested"))).toEqual(["cache.json"]);
  });

  test("a failing rename rethrows the filesystem error and removes the temp file", () => {
    const path = join(root, "target-directory");
    mkdirSync(path);
    let error: NodeJS.ErrnoException | undefined;
    try {
      writeFileAtomic(path, "cannot replace a directory");
    } catch (caught) {
      error = caught as NodeJS.ErrnoException;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.syscall).toBe("rename");
    expect(error?.code).toBe("EISDIR");
    expect(error?.path).toBe(`${path}.tmp.${process.pid}`);
    expect(existsSync(`${path}.tmp.${process.pid}`)).toBe(false);
    expect(readdirSync(root)).toEqual(["target-directory"]);
    expect(readdirSync(path)).toEqual([]);
  });
});
