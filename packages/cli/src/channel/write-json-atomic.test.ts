import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { writeJsonAtomic } from "./write-json-atomic.js";

// The regression this pins (upstream 9aef742c, #586 grain 6): session
// meta.json used to be written by a bare writeFileSync while an external
// monitor polls the file — a reader could land on a half-written file.

describe("writeJsonAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudish-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes pretty-printed JSON readable back key by key", () => {
    const target = join(dir, "meta.json");
    writeJsonAtomic(target, { sessionId: "s1", status: "running", n: 3 });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({
      sessionId: "s1",
      status: "running",
      n: 3,
    });
    // exact formatting preserved from the previous writeFileSync call
    expect(readFileSync(target, "utf-8")).toBe(
      JSON.stringify({ sessionId: "s1", status: "running", n: 3 }, null, 2)
    );
  });

  test("replaces a pre-existing target and leaves no temp residue", () => {
    const target = join(dir, "meta.json");
    writeFileSync(target, '{"old":true}', "utf-8");
    writeJsonAtomic(target, { status: "completed" });
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ status: "completed" });
    expect(readdirSync(dir)).toEqual(["meta.json"]);
  });

  test("a serialization failure leaves the pre-existing target intact and throws", () => {
    const target = join(dir, "meta.json");
    writeFileSync(target, '{"old":true}', "utf-8");
    // BigInt cannot be serialized by JSON.stringify
    expect(() => writeJsonAtomic(target, { bad: 1n })).toThrow();
    expect(readFileSync(target, "utf-8")).toBe('{"old":true}');
    expect(readdirSync(dir)).toEqual(["meta.json"]);
  });

  test("repeated writes all land on the final value, no residue", () => {
    const target = join(dir, "meta.json");
    for (let i = 0; i < 20; i++) {
      writeJsonAtomic(target, { seq: i });
    }
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ seq: 19 });
    expect(readdirSync(dir)).toEqual(["meta.json"]);
  });
});

describe("writeJsonAtomic (atomicity, through the fs seam)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudish-atomic-seam-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the target is never written directly: one tmp write, one rename in the same directory", () => {
    const target = join(dir, "meta.json");
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const seam = {
      writeFileSync: (p: string, data: string, enc: BufferEncoding) => {
        writes.push(p);
        return nodeFs.writeFileSync(p, data, enc);
      },
      renameSync: (from: string, to: string) => {
        renames.push([from, to]);
        return nodeFs.renameSync(from, to);
      },
      unlinkSync: (p: string) => nodeFs.unlinkSync(p),
    };

    writeJsonAtomic(target, { ok: true }, seam);

    // RED on the direct-write mutant (writeFileSync(filePath, data)): the
    // target path must never reach writeFileSync, only the temp file.
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toBe(target);
    expect(renames).toHaveLength(1);
    expect(renames[0][0]).toBe(writes[0]);
    expect(renames[0][1]).toBe(target);
    expect(dirname(renames[0][0])).toBe(dirname(target));
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ ok: true });
  });

  test("a win32 rename failure (EPERM) falls back to the direct write and cleans the temp", () => {
    const target = join(dir, "meta.json");
    const seam = {
      writeFileSync: nodeFs.writeFileSync.bind(nodeFs),
      renameSync: () => {
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      },
      unlinkSync: nodeFs.unlinkSync.bind(nodeFs),
    };

    expect(() => writeJsonAtomic(target, { s: 1 }, seam)).not.toThrow();

    // never worse than the replaced code: the write landed, no residue
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ s: 1 });
    expect(readdirSync(dir)).toEqual(["meta.json"]);
  });

  test("if the fallback write fails too, it throws exactly like the old direct write", () => {
    const target = join(dir, "meta.json");
    const seam = {
      writeFileSync: (p: string, data: string, enc: BufferEncoding) => {
        if (p === target) {
          throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
        }
        return nodeFs.writeFileSync(p, data, enc);
      },
      renameSync: () => {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      },
      unlinkSync: nodeFs.unlinkSync.bind(nodeFs),
    };

    expect(() => writeJsonAtomic(target, { s: 2 }, seam)).toThrow(/ENOSPC/);
    // the temp file was still cleaned up
    expect(readdirSync(dir)).toEqual([]);
  });
});
