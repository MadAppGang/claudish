import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PathLookupFs,
  findMagmuxBinary,
  findMagmuxCandidates,
  lookupOnPath,
} from "./magmux-binary.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "magmux-binary-"));
  tempDirs.push(d);
  return d;
}

function fakeMagmuxDir(): { dir: string; binary: string } {
  const dir = tempDir();
  const binary = join(dir, "magmux");
  writeFileSync(binary, "#!/bin/sh\necho 'magmux 0.0.0'\n");
  chmodSync(binary, 0o755);
  return { dir, binary };
}

function errnoError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: failure, stat '${path}'`), { code, path });
}

/** The real file system, except that `stat` of the paths in `failing` throws their error. */
function failingFs(failing: Record<string, string>): PathLookupFs {
  return {
    statSync: (p) => {
      const code = failing[p];
      if (code) throw errnoError(code, p);
      return fs.statSync(p);
    },
    accessSync: (p, mode) => fs.accessSync(p, mode),
  };
}

describe("lookupOnPath", () => {
  test("an EIO on a PATH entry, with no magmux anywhere else, is a lookup failure naming it", () => {
    const broken = join(tempDir(), "magmux");
    const empty = tempDir();
    const result = lookupOnPath(
      "magmux",
      `${join(broken, "..")}:${empty}`,
      failingFs({ [broken]: "EIO" })
    );
    expect(result).toEqual({ kind: "error", code: "EIO", path: broken });
    const candidates = findMagmuxCandidates(
      { PATH: `${join(broken, "..")}:${empty}` },
      failingFs({ [broken]: "EIO" })
    );
    expect(candidates.lookupError).toBe(`EIO on ${broken}`);
    if (candidates.paths.length === 0)
      expect(() =>
        findMagmuxBinary({ PATH: `${join(broken, "..")}:${empty}` }, failingFs({ [broken]: "EIO" }))
      ).toThrow(`magmux lookup failed: EIO on ${broken}`);
  });

  test("ENOENT, ENOTDIR and EACCES on a candidate mean keep looking", () => {
    const { dir, binary } = fakeMagmuxDir();
    const a = join(tempDir(), "magmux");
    const b = join(tempDir(), "magmux");
    const c = join(tempDir(), "magmux");
    const PATH = [a, b, c].map((p) => join(p, "..")).join(":") + `:${dir}`;
    expect(
      lookupOnPath("magmux", PATH, failingFs({ [a]: "ENOENT", [b]: "ENOTDIR", [c]: "EACCES" }))
    ).toEqual({ kind: "found", path: binary });
  });

  test("a later PATH entry holding magmux outranks an earlier lookup error", () => {
    const { dir, binary } = fakeMagmuxDir();
    const broken = join(tempDir(), "magmux");
    expect(
      lookupOnPath("magmux", `${join(broken, "..")}:${dir}`, failingFs({ [broken]: "EIO" }))
    ).toEqual({ kind: "found", path: binary });
  });

  test("a fake executable magmux in a temp dir on PATH is found", () => {
    const { dir, binary } = fakeMagmuxDir();
    expect(lookupOnPath("magmux", `/nonexistent:${dir}`)).toEqual({ kind: "found", path: binary });
    const candidates = findMagmuxCandidates({ PATH: `/nonexistent:${dir}` });
    expect(candidates.paths).toContain(binary);
    expect(candidates.lookupError).toBeNull();
  });

  test("a magmux that is not executable, or is a directory, is not found", () => {
    const plain = tempDir();
    writeFileSync(join(plain, "magmux"), "not a program\n");
    chmodSync(join(plain, "magmux"), 0o644);
    const holder = tempDir();
    mkdirSync(join(holder, "magmux"));
    expect(lookupOnPath("magmux", `${plain}:${holder}`)).toEqual({ kind: "not-found" });
  });

  test("an empty PATH is not found, with no lookup error", () => {
    expect(lookupOnPath("magmux", "")).toEqual({ kind: "not-found" });
    expect(findMagmuxCandidates({ PATH: "" }).lookupError).toBeNull();
  });
});
