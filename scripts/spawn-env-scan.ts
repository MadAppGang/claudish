/**
 * Find every child-process spawn in test code that does not pass an `env` option.
 *
 * Why: the bun test preload (`test-preload.ts`) deletes the claudish session-identity
 * variables from `process.env`, but a child spawned with NO `env` option is handed the
 * ORIGINAL environment, deletions undone. Measured: `Bun.spawn`/`Bun.spawnSync` on bun
 * 1.3.10 and 1.4.0, and `node:child_process` on 1.3.10 (the CI pin). Such a child can
 * append a test's doubles to a real session's records (D5), so test code must say what
 * environment its children get — `env: { ...process.env }` at minimum.
 *
 * The scan parses each file with the TypeScript compiler API (no regex over source), so a
 * comment or a string that mentions `env` cannot satisfy it.
 *
 * Rule: the call's options argument must be an OBJECT LITERAL with an `env` property
 * (`env: …` or shorthand `env`). A call with no options argument is a violation. A call
 * whose options are not an object literal (a variable, a call) or whose literal has no
 * `env` key but spreads something (`{ ...opts }`) cannot be decided statically, and is a
 * violation unless it is listed in the allowlist the caller passes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** The spawn functions `node:child_process` exports. */
const CHILD_PROCESS_FNS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);

export type SpawnFamily = "Bun" | "child_process";

export interface SpawnEnvViolation {
  /** Path relative to the scan root, `/`-separated. */
  file: string;
  /** 1-based. */
  line: number;
  /** The callee as written: `Bun.spawn`, `spawnSync`, `cp.execFileSync`. */
  callee: string;
  family: SpawnFamily;
  /** "no options" | "options not an object literal" | "no env key (spread)" | "no env key". */
  problem: string;
  /** The trimmed source line, for the allowlist and the failure message. */
  text: string;
}

export interface AllowlistEntry {
  file: string;
  /** The trimmed source line text (line numbers move; text is what the reviewer reads). */
  text: string;
  reason: string;
}

/** Whether a repo-relative path is test code: a test file, or anything under a test-helpers dir. */
export function isTestCodePath(relPath: string): boolean {
  const p = relPath.split(sep).join("/");
  if (!/\.(ts|tsx)$/.test(p) || p.endsWith(".d.ts")) return false;
  if (/\.test\.tsx?$/.test(p)) return true;
  return p.split("/").includes("test-helpers");
}

/** The directories the suite runs test code from (package.json `test`). */
export const TEST_CODE_ROOTS = [
  "packages/cli/src",
  "packages/cli/scripts",
  "packages/macos-bridge/src",
  "scripts",
];

/** Every test-code file under the roots, relative to `repoRoot`. */
export function listTestCodeFiles(repoRoot: string, roots: string[] = TEST_CODE_ROOTS): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (isTestCodePath(relative(repoRoot, abs))) out.push(relative(repoRoot, abs));
    }
  };
  for (const r of roots) walk(join(repoRoot, r));
  return out.sort();
}

/** Names bound to `node:child_process` in this file: direct imports and namespace/default. */
function childProcessBindings(sf: ts.SourceFile): { fns: Map<string, string>; namespaces: Set<string> } {
  const fns = new Map<string, string>(); // local name → exported name
  const namespaces = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const mod = stmt.moduleSpecifier.text;
    if (mod !== "node:child_process" && mod !== "child_process") continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else
      for (const el of bindings.elements) {
        const exported = (el.propertyName ?? el.name).text;
        if (CHILD_PROCESS_FNS.has(exported)) fns.set(el.name.text, exported);
      }
  }
  return { fns, namespaces };
}

/** Which argument carries the options, or undefined when the call has none. */
function optionsArgument(
  family: SpawnFamily,
  fn: string,
  args: readonly ts.Expression[]
): ts.Expression | undefined {
  if (family === "Bun") {
    // Bun.spawn(opts) or Bun.spawn(cmd, opts).
    if (args.length >= 1 && ts.isObjectLiteralExpression(args[0])) return args[0];
    return args[1];
  }
  // child_process: the options follow the command and an optional argv array; a trailing
  // callback (exec/execFile) is not options.
  const rest = args.slice(1).filter((a) => !ts.isArrowFunction(a) && !ts.isFunctionExpression(a));
  if (fn === "exec" || fn === "execSync") return rest[0];
  if (rest.length === 0) return undefined;
  if (ts.isArrayLiteralExpression(rest[0])) return rest[1];
  // spawn(cmd, opts) / execFileSync(file, opts) with no argv, or a variable argv.
  return rest.length >= 2 ? rest[1] : rest[0];
}

function hasEnvKey(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((p) => {
    if (ts.isShorthandPropertyAssignment(p)) return p.name.text === "env";
    if (ts.isPropertyAssignment(p)) {
      const n = p.name;
      return (ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === "env";
    }
    return false;
  });
}

/** Scan one file's source. `file` is only used to label the result. */
export function scanSource(file: string, source: string): SpawnEnvViolation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { fns, namespaces } = childProcessBindings(sf);
  const lines = source.split("\n");
  const out: SpawnEnvViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let family: SpawnFamily | null = null;
      let fn = "";
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const obj = callee.expression.text;
        const prop = callee.name.text;
        if (obj === "Bun" && (prop === "spawn" || prop === "spawnSync")) {
          family = "Bun";
          fn = prop;
        } else if (namespaces.has(obj) && CHILD_PROCESS_FNS.has(prop)) {
          family = "child_process";
          fn = prop;
        }
      } else if (ts.isIdentifier(callee) && fns.has(callee.text)) {
        family = "child_process";
        fn = fns.get(callee.text) ?? callee.text;
      }
      if (family) {
        const opts = optionsArgument(family, fn, node.arguments);
        let problem: string | null = null;
        if (!opts) problem = "no options";
        else if (!ts.isObjectLiteralExpression(opts)) problem = "options not an object literal";
        else if (!hasEnvKey(opts))
          problem = opts.properties.some(ts.isSpreadAssignment)
            ? "no env key (spread)"
            : "no env key";
        if (problem) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          out.push({
            file: file.split(sep).join("/"),
            line,
            callee: callee.getText(sf),
            family,
            problem,
            text: (lines[line - 1] ?? "").trim(),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Scan every test-code file under `repoRoot`, minus the allowlisted sites. */
export function scanRepo(repoRoot: string, allowlist: AllowlistEntry[] = []): SpawnEnvViolation[] {
  const out: SpawnEnvViolation[] = [];
  for (const rel of listTestCodeFiles(repoRoot)) {
    const source = readFileSync(join(repoRoot, rel), "utf-8");
    for (const v of scanSource(rel, source)) {
      if (allowlist.some((a) => a.file === v.file && a.text === v.text)) continue;
      out.push(v);
    }
  }
  return out;
}
