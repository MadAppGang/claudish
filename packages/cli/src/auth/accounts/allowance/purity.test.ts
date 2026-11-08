/**
 * The allowance module's purity guard (architecture §1.1): a structural check,
 * not a behaviour test. Every non-test `allowance/**` file except `sim/cli.ts`
 * may import only other `allowance/` files, `../types.js` as types, and
 * `../policy.js` from `request.ts`, `strategies/sticky.ts` and `sim/`. None of
 * them may read a clock, draw a random number, touch `process`, fetch, or load
 * a module dynamically.
 *
 * Test files are not scanned: they name the forbidden tokens and import the
 * runner. Killing mutation: add `Date.now()` to `forecast.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = dirname(new URL(import.meta.url).pathname);
const ACCOUNTS = resolve(ROOT, "..");
const TYPES = join(ACCOUNTS, "types.ts");
const POLICY = join(ACCOUNTS, "policy.ts");

/** The files allowed to import the real `policy.ts`, relative to `allowance/`. */
function mayImportPolicy(rel: string): boolean {
  return rel === "request.ts" || rel === "strategies/sticky.ts" || rel.startsWith("sim/");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const FILES = sourceFiles(ROOT)
  .map((path) => ({ path, rel: relative(ROOT, path) }))
  .filter((f) => f.rel !== "sim/cli.ts");

/** Comments and string bodies removed, so prose and messages never trip the token scan. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "Date.now()", pattern: /\bDate\s*\.\s*now\s*\(/ },
  { name: "new Date()", pattern: /\bnew\s+Date\s*\(/ },
  { name: "Math.random()", pattern: /\bMath\s*\.\s*random\s*\(/ },
  { name: "performance.now()", pattern: /\bperformance\s*\.\s*now\s*\(/ },
  { name: "process", pattern: /\bprocess\b/ },
  { name: "fetch()", pattern: /\bfetch\s*\(/ },
  { name: "require()", pattern: /\brequire\s*\(/ },
  { name: "dynamic import()", pattern: /\bimport\s*\(/ },
  {
    name: "setTimeout/setInterval/setImmediate",
    pattern: /\bset(?:Timeout|Interval|Immediate)\s*\(/,
  },
];

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

function importsOf(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  const re = /\b(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(re)) {
    const clause = m[3] ?? "";
    // `import { type A, type B }` is type-only too.
    const named = clause.match(/^\{([\s\S]*)\}$/);
    const allTypeNamed =
      named !== null &&
      (named[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .every((s) => s.startsWith("type "));
    refs.push({ specifier: m[4] ?? "", typeOnly: m[2] !== undefined || allTypeNamed });
  }
  for (const m of stripped.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    refs.push({ specifier: m[1] ?? "", typeOnly: false });
  }
  return refs;
}

function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const abs = resolve(dirname(from), specifier);
  return abs.endsWith(".js") ? `${abs.slice(0, -3)}.ts` : abs;
}

describe("allowance purity (§1.1)", () => {
  test("the scan is not vacuous", () => {
    expect(FILES.some((f) => f.rel === "types.ts")).toBe(true);
  });

  for (const file of FILES) {
    test(`${file.rel}: imports stay inside allowance/`, () => {
      const source = readFileSync(file.path, "utf8");
      const violations: string[] = [];
      for (const ref of importsOf(source)) {
        const target = resolveSpecifier(file.path, ref.specifier);
        if (target === null) {
          violations.push(`${ref.specifier} (a package or node: module)`);
          continue;
        }
        if (target.startsWith(`${ROOT}/`)) continue;
        if (target === TYPES && ref.typeOnly) continue;
        if (target === POLICY && mayImportPolicy(file.rel)) continue;
        violations.push(`${ref.specifier} → ${relative(ACCOUNTS, target)}`);
      }
      expect(violations).toEqual([]);
    });

    test(`${file.rel}: no clock, randomness, process or I/O token`, () => {
      const code = codeOnly(readFileSync(file.path, "utf8"));
      const found = FORBIDDEN.filter((f) => f.pattern.test(code)).map((f) => f.name);
      expect(found).toEqual([]);
    });
  }
});
