/**
 * Type-check the blind hook tests (tsconfig.blind.json), allowing exactly one thing the
 * locked bun-types rejects: Bun's label-only `test.todo("name")` / `it.todo("name")`.
 *
 * Bun runs a body-less todo (it lists the test and calls nothing), but bun-types declares
 * `todo` with the full `Test` signature, so the call is TS2554 "Expected 2-3 arguments,
 * but got 1". The blind tests use that form and are written by another model, so they are
 * not edited to suit the checker. A declaration-merging shim cannot narrow `todo` alone —
 * `todo` is typed as `Test<T>` itself, so any extra call signature also lets a body-less
 * `test("x")` or `it("x")` through — hence this filter: a TS2554 is accepted only when it
 * sits on the `todo` of a one-argument `test.todo(…)` / `it.todo(…)` call. Every other
 * diagnostic fails the check.
 *
 *   bun run scripts/typecheck-blind.ts [tsconfig]   default: tsconfig.blind.json
 */
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "..");
const projectPath = resolve(root, process.argv[2] ?? "tsconfig.blind.json");

const read = ts.readConfigFile(projectPath, ts.sys.readFile);
if (read.error) {
  console.error(ts.formatDiagnostics([read.error], host()));
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(projectPath));
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });

const TODO_RECEIVERS = new Set(["test", "it"]);

/** Spans of the `todo` name in every `test.todo(x)` / `it.todo(x)` call with one argument. */
function labelOnlyTodoSpans(file: ts.SourceFile): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "todo" &&
      ts.isIdentifier(node.expression.expression) &&
      TODO_RECEIVERS.has(node.expression.expression.text)
    ) {
      spans.push([node.expression.name.getStart(file), node.expression.name.getEnd()]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return spans;
}

const spansByFile = new Map<string, Array<[number, number]>>();
function isLabelOnlyTodo(d: ts.Diagnostic): boolean {
  if (d.code !== 2554 || !d.file || d.start === undefined) return false;
  let spans = spansByFile.get(d.file.fileName);
  if (!spans) {
    spans = labelOnlyTodoSpans(d.file);
    spansByFile.set(d.file.fileName, spans);
  }
  const start = d.start;
  return spans.some(([from, to]) => start >= from && start < to);
}

function host(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  };
}

const all = ts.getPreEmitDiagnostics(program);
const failing = all.filter((d) => !isLabelOnlyTodo(d));
const allowed = all.length - failing.length;
if (failing.length > 0) {
  console.error(ts.formatDiagnostics(failing, host()));
  console.error(
    `[typecheck-blind] ${failing.length} error(s); ${allowed} label-only test.todo call(s) allowed`
  );
  process.exit(1);
}
console.log(`[typecheck-blind] ok; ${allowed} label-only test.todo call(s) allowed`);
