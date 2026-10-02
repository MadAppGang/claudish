/**
 * The version claudish reports is a contract with the magus `claudish` plugin
 * monitor. 10.4.0 is the first claudish that writes the session records the
 * monitor reads (`spawn.json`, `waits.jsonl`, team-run `meta.json`); the
 * monitor's MIN_CLAUDISH_VERSION is 10.4.0, and it tells a window running an
 * older claudish that its runs cannot be reported. A build carrying these
 * records under a lower number is told it is too old.
 *
 * claudish keeps its version in three places: the root package.json,
 * packages/cli/package.json (what npm publishes, and what the monitor's
 * package walk finds in a source checkout) and the generated src/version.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { VERSION } from "./version.js";

const SESSION_RECORDS_VERSION = [10, 4, 0];

const readVersion = (path: string): string =>
  JSON.parse(readFileSync(path, "utf-8")).version as string;

const parse = (version: string): number[] => version.split(/[.-]/).slice(0, 3).map(Number);

function atLeast(version: string, floor: number[]): boolean {
  const parts = parse(version);
  for (let i = 0; i < floor.length; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}

describe("claudish version contract", () => {
  const cliPackage = readVersion(join(import.meta.dir, "..", "package.json"));
  const rootPackage = readVersion(join(import.meta.dir, "..", "..", "..", "package.json"));

  test("every place that keeps the version agrees", () => {
    expect(rootPackage).toBe(cliPackage);
    expect(VERSION).toBe(cliPackage);
  });

  test("the version is at least the plugin monitor's minimum, 10.4.0", () => {
    expect(atLeast(cliPackage, SESSION_RECORDS_VERSION)).toBe(true);
  });
});
