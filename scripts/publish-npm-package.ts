#!/usr/bin/env bun
/**
 * Publish the npm package in the given directory, with provenance.
 *
 * Exit 0 when the publish succeeds, or when npm answers that this version is already published
 * (a rerun of the release job). Exit 1 on every other failure, so a package that did not publish
 * (a provenance error, a staged version, an auth error) fails the release step instead of
 * leaving an install that silently lacks it.
 *
 * Usage: bun scripts/publish-npm-package.ts <package-dir>
 */

const ALREADY_PUBLISHED = "cannot publish over the previously published versions";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: publish-npm-package.ts <package-dir>");
  process.exit(2);
}

const r = Bun.spawnSync(["npm", "publish", "--access", "public", "--provenance"], {
  cwd: dir,
  env: process.env,
  stdout: "inherit",
  stderr: "pipe",
});
const stderr = r.stderr.toString();
process.stderr.write(stderr);

if (r.exitCode === 0) process.exit(0);
if (stderr.includes(ALREADY_PUBLISHED)) {
  console.log(`${dir}: this version is already published; nothing to do`);
  process.exit(0);
}
console.error(`${dir}: npm publish failed (exit ${r.exitCode})`);
process.exit(1);
