/**
 * F3: checksums.txt names every binary the release uploads (claudish-* and magmux-*),
 * and the two shell consumers of that file still resolve exactly one checksum per
 * claudish binary.
 *
 * Black box: the script runs as a child process against a temp release directory of
 * dummy files. The consumers (.github/workflows/release.yml, install.sh) are not
 * re-implemented here: their own grep lines are extracted from the files and run
 * against the generated checksums.txt, so whatever anchoring they use is what is tested.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "generate-manifest.ts");
const RELEASE_WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");
const INSTALL_SH = join(ROOT, "install.sh");

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
const CLAUDISH = PLATFORMS.map((p) => `claudish-${p}`);
const MAGMUX = PLATFORMS.map((p) => `magmux-${p}`);
const ALL_BINARIES = [...CLAUDISH, ...MAGMUX];

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
/** Distinct content per file, so a line pointing at the wrong file cannot pass by luck. */
const contentOf = (name: string) => `dummy binary for ${name}\n`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function releaseDir(files: string[] = ALL_BINARIES): string {
  const dir = mkdtempSync(join(tmpdir(), "gen-manifest-"));
  made.push(dir);
  for (const name of files) writeFileSync(join(dir, name), contentOf(name));
  return dir;
}

function generate(dir: string, version = "9.9.9") {
  const proc = Bun.spawnSync(["bun", "--no-env-file", SCRIPT, version, dir], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "" },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function checksumLines(dir: string): string[] {
  return readFileSync(join(dir, "checksums.txt"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function sh(command: string, cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["sh", "-c", command], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("F3 checksums.txt covers every uploaded binary", () => {
  test("F3-1: the script exits 0 and writes checksums.txt and manifest.json", () => {
    const dir = releaseDir();
    const r = generate(dir);
    expect(r.code).toBe(0);
    const names = readdirSync(dir);
    expect(names).toContain("checksums.txt");
    expect(names).toContain("manifest.json");
  });

  test("F3-2: every claudish-* and magmux-* file has exactly one `<sha256>  <name>` line", () => {
    const dir = releaseDir();
    expect(generate(dir).code).toBe(0);
    const lines = checksumLines(dir);
    for (const name of ALL_BINARIES) {
      const expected = `${sha256(contentOf(name))}  ${name}`;
      expect(lines.filter((line) => line === expected)).toHaveLength(1);
    }
  });

  test("F3-3: checksums.txt holds only binaries, in `<64 hex>  <name>` form, ending in a newline", () => {
    const dir = releaseDir();
    expect(generate(dir).code).toBe(0);
    const raw = readFileSync(join(dir, "checksums.txt"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = checksumLines(dir);
    for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64} {2}\S+$/);
    expect(lines.map((line) => line.split("  ")[1]).sort()).toEqual([...ALL_BINARIES].sort());
  });

  test("F3-4: a magmux binary missing from the release dir gets no line, and the others still do", () => {
    const present = ALL_BINARIES.filter((name) => name !== "magmux-linux-arm64");
    const dir = releaseDir(present);
    expect(generate(dir).code).toBe(0);
    const names = checksumLines(dir).map((line) => line.split("  ")[1]);
    expect(names).not.toContain("magmux-linux-arm64");
    expect(names.sort()).toEqual([...present].sort());
  });

  test("F3-5: manifest.json keeps the claudish platform entries (checksum and size)", () => {
    const dir = releaseDir();
    expect(generate(dir, "4.5.6").code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.version).toBe("4.5.6");
    for (const platform of PLATFORMS) {
      const name = `claudish-${platform}`;
      expect(manifest.platforms[platform]).toEqual({
        checksum: sha256(contentOf(name)),
        size: Buffer.byteLength(contentOf(name)),
      });
    }
  });

  test("F3-6: manifest.json also carries every magmux binary's sha256 (spec: 'if that is the manifest's shape')", () => {
    const dir = releaseDir();
    expect(generate(dir).code).toBe(0);
    const manifestText = readFileSync(join(dir, "manifest.json"), "utf8");
    for (const name of MAGMUX) expect(manifestText).toContain(sha256(contentOf(name)));
  });
});

describe("F3 consumers of checksums.txt resolve one checksum per claudish binary", () => {
  test("F3-7: anchored greps for the claudish darwin binaries each return exactly one line", () => {
    const dir = releaseDir();
    expect(generate(dir).code).toBe(0);
    const lines = checksumLines(dir);
    for (const name of ["claudish-darwin-arm64", "claudish-darwin-x64"]) {
      const hits = lines.filter((line) => line.split("  ")[1] === name);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.split("  ")[0]).toBe(sha256(contentOf(name)));
    }
  });

  for (const [variable, platform] of [
    ["ARM64_SHA", "darwin-arm64"],
    ["X64_SHA", "darwin-x64"],
  ] as const) {
    test(`F3-8: release.yml's Homebrew grep for ${platform} yields one sha, the claudish one`, () => {
      const workflow = readFileSync(RELEASE_WORKFLOW, "utf8");
      const line = workflow
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith(`${variable}=`) && l.includes("checksums.txt"));
      if (!line) throw new Error(`release.yml has no ${variable}=... line reading checksums.txt`);
      const dir = releaseDir();
      expect(generate(dir).code).toBe(0);
      const r = sh(`${line}\nprintf '%s' "$${variable}"`, dir);
      expect(r.code).toBe(0);
      // Two lines would have been joined by a newline: a single 64-hex word is the contract.
      expect(r.stdout).toBe(sha256(contentOf(`claudish-${platform}`)));
    });
  }

  for (const platform of PLATFORMS) {
    test(`F3-9: install.sh's checksum lookup for ${platform} yields one sha, the claudish one`, () => {
      const script = readFileSync(INSTALL_SH, "utf8");
      const line = script
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("expected=$(") && l.includes("checksums_url"));
      if (!line) throw new Error("install.sh has no `expected=$(... checksums_url ...)` lookup");
      // Same pipeline, with the download replaced by the local file.
      const pipeline = line
        .replace(/^expected=\$\(/, "")
        .replace(/\)$/, "")
        .replace(/curl [^|]*\|/, "cat checksums.txt |");
      const dir = releaseDir();
      expect(generate(dir).code).toBe(0);
      const r = sh(`platform='${platform}'\n${pipeline}`, dir);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${sha256(contentOf(`claudish-${platform}`))}\n`);
    });
  }
});

// Keep the directory helper honest: the dummy release dir really holds the eight files.
test("F3-0: the test release directory holds the eight binaries it claims", () => {
  const dir = releaseDir();
  expect(
    readdirSync(dir)
      .filter((n) => /^(claudish|magmux)-/.test(n))
      .sort()
  ).toEqual([...ALL_BINARIES].sort());
});
