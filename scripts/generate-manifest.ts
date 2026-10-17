#!/usr/bin/env bun
/**
 * Generate release manifest with checksums
 *
 * Usage: bun scripts/generate-manifest.ts <version> <release-dir>
 *
 * Creates manifest.json with checksums and file sizes for all platforms
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
  platforms: Record<string, PlatformInfo>;
}

const PLATFORM_MAP: Record<string, string> = {
  "claudish-darwin-arm64": "darwin-arm64",
  "claudish-darwin-x64": "darwin-x64",
  "claudish-linux-x64": "linux-x64",
  "claudish-linux-arm64": "linux-arm64",
};

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function generateManifest(version: string, releaseDir: string): Manifest {
  const platforms: Record<string, PlatformInfo> = {};

  const files = readdirSync(releaseDir);

  for (const file of files) {
    const platform = PLATFORM_MAP[file];
    if (!platform) continue;

    const filePath = join(releaseDir, file);
    const stats = statSync(filePath);

    platforms[platform] = {
      checksum: computeSha256(filePath),
      size: stats.size,
    };
  }

  return {
    version,
    buildDate: new Date().toISOString(),
    platforms,
  };
}

// Main
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error("Usage: bun scripts/generate-manifest.ts <version> <release-dir>");
  process.exit(1);
}

const [version, releaseDir] = args;

const manifest = generateManifest(version, releaseDir);

// Write manifest.json
const manifestPath = join(releaseDir, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log("Generated manifest.json:");
console.log(JSON.stringify(manifest, null, 2));

// Also write checksums.txt for backwards compatibility
const checksumsPath = join(releaseDir, "checksums.txt");
const checksums = Object.entries(PLATFORM_MAP)
  .filter(([file]) => manifest.platforms[PLATFORM_MAP[file]])
  .map(([file, platform]) => `${manifest.platforms[platform].checksum}  ${file}`)
  .join("\n");

writeFileSync(checksumsPath, `${checksums}\n`);
console.log("\nGenerated checksums.txt");
