#!/usr/bin/env bun
/**
 * Generate the release manifest and checksums
 *
 * Usage: bun scripts/generate-manifest.ts <version> <release-dir>
 *
 * Writes, for every release binary in <release-dir> (`claudish-<os>-<arch>` and
 * `magmux-<os>-<arch>`):
 * - manifest.json: checksum and size, claudish under `platforms`, magmux under `magmux`,
 *   both keyed by `<os>-<arch>`
 * - checksums.txt: one `<sha256>  <filename>` line per binary
 *
 * Readers of checksums.txt must match the whole filename field: `darwin-arm64` alone
 * matches both the claudish and the magmux line.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface PlatformInfo {
  checksum: string;
  size: number;
}

interface Manifest {
  version: string;
  buildDate: string;
  /** claudish binaries, keyed by `<os>-<arch>`. */
  platforms: Record<string, PlatformInfo>;
  /** magmux binaries, keyed by `<os>-<arch>`. */
  magmux: Record<string, PlatformInfo>;
}

/** A release binary's name: the product, then the platform it was built for. */
const BINARY_NAME = /^(claudish|magmux)-((?:darwin|linux)-(?:arm64|x64))$/;

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function generate(version: string, releaseDir: string): { manifest: Manifest; checksums: string } {
  const manifest: Manifest = {
    version,
    buildDate: new Date().toISOString(),
    platforms: {},
    magmux: {},
  };
  const lines: string[] = [];

  for (const file of readdirSync(releaseDir).sort()) {
    const match = BINARY_NAME.exec(file);
    if (!match) continue;
    const [, product, platform] = match as unknown as [string, "claudish" | "magmux", string];

    const filePath = join(releaseDir, file);
    const info: PlatformInfo = { checksum: computeSha256(filePath), size: statSync(filePath).size };
    (product === "claudish" ? manifest.platforms : manifest.magmux)[platform] = info;
    lines.push(`${info.checksum}  ${file}`);
  }

  return { manifest, checksums: lines.length ? `${lines.join("\n")}\n` : "" };
}

// Main
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error("Usage: bun scripts/generate-manifest.ts <version> <release-dir>");
  process.exit(1);
}

const [version, releaseDir] = args as [string, string];

const { manifest, checksums } = generate(version, releaseDir);

writeFileSync(join(releaseDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("Generated manifest.json:");
console.log(JSON.stringify(manifest, null, 2));

writeFileSync(join(releaseDir, "checksums.txt"), checksums);
console.log("\nGenerated checksums.txt");
