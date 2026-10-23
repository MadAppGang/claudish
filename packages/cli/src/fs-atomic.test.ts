import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
    expect(readdirSync(root).filter((name) => name.startsWith("cache.json.tmp."))).toEqual([]);
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
    const prefix = `${path}.tmp.${process.pid}.`;
    expect(error?.path).toStartWith(prefix);
    expect(error?.path?.slice(prefix.length)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(readdirSync(root).filter((name) => name.startsWith("target-directory.tmp."))).toEqual(
      []
    );
    expect(readdirSync(root)).toEqual(["target-directory"]);
    expect(readdirSync(path)).toEqual([]);
  });
});
