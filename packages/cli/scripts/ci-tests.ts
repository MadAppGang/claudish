/**
 * The ONE list of the hermetic test files, split into named groups, and the runner for them.
 *
 *   bun scripts/ci-tests.ts --list
 *   bun scripts/ci-tests.ts --group pane,idle [-- <bun test args>]
 *
 * Several groups run as concurrent `bun test` processes, each line prefixed with its group.
 * `{group}` in a passed-through argument becomes the group name, so each process can write its
 * own `--reporter-outfile`. The exit code is non-zero when any group fails.
 *
 * Files are passed WITHOUT a leading `./`: Bun then reads them as filters on its own discovery
 * and keeps a bare `bun test`'s file order. `./` paths run in argument order instead, and a few
 * suites share process state across files, so a new order is a new suite.
 *
 * src/hooks/blind is not here: it runs under Bun 1.4.0 in its own job (test.yml).
 */
import { join } from "node:path";

const CLI = join(import.meta.dir, "..");

/** Bun's own test-file name rule. */
const TEST_FILE = /(\.test|_test_|\.spec|_spec_)[^/]*\.[cm]?[jt]sx?$/;
const EXCLUDED = ["node_modules/", "src/hooks/blind/"];

/**
 * Each file belongs to the first group whose prefix it starts with; `rest` takes the others.
 * - idle: CPU-idle waits on real retry ladders and token-refresh ceilings, with no magmux.
 * - pane: real magmux panes and the MCP session machinery on top of them.
 */
const GROUPS: { name: string; prefixes: string[] }[] = [
  { name: "idle", prefixes: ["src/recovery-contract/", "src/providers/grok/grok-refresh-timeout"] },
  {
    name: "pane",
    prefixes: [
      "src/pane/",
      "src/mcp-session/",
      "src/mcp-blackbox/",
      "src/hooks/session/",
      "src/recovery/",
      "src/team",
    ],
  },
];
const REST = "rest";

export function discover(): string[] {
  const files: string[] = [];
  for (const path of new Bun.Glob("**/*").scanSync({ cwd: CLI, onlyFiles: true })) {
    if (EXCLUDED.some((dir) => path.startsWith(dir) || path.includes(`/${dir}`))) continue;
    if (TEST_FILE.test(path)) files.push(path);
  }
  return files.sort();
}

export function groupOf(file: string): string {
  return GROUPS.find((g) => g.prefixes.some((p) => file.startsWith(p)))?.name ?? REST;
}

function byGroup(files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>([
    ...GROUPS.map((g) => [g.name, []] as [string, string[]]),
    [REST, []],
  ]);
  for (const f of files) out.get(groupOf(f))?.push(f);
  return out;
}

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string, sink: NodeJS.WriteStream) {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of stream) {
    const lines = (carry + decoder.decode(chunk, { stream: true })).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) sink.write(`${prefix}${line}\n`);
  }
  if (carry) sink.write(`${prefix}${carry}\n`);
}

async function run(
  group: string,
  files: string[],
  bunArgs: string[],
  prefixed: boolean
): Promise<number> {
  const args = bunArgs.map((a) => a.replaceAll("{group}", group));
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, "test", ...args, ...files], {
    cwd: CLI,
    stdout: prefixed ? "pipe" : "inherit",
    stderr: prefixed ? "pipe" : "inherit",
  });
  if (prefixed) {
    await Promise.all([
      pipe(proc.stdout as ReadableStream<Uint8Array>, `[${group}] `, process.stdout),
      pipe(proc.stderr as ReadableStream<Uint8Array>, `[${group}] `, process.stderr),
    ]);
  }
  const code = await proc.exited;
  const secs = ((performance.now() - started) / 1000).toFixed(0);
  console.log(`[ci-tests] ${group}: ${files.length} files, exit ${code}, ${secs} s`);
  return code;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf("--");
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const bunArgs = dash === -1 ? [] : argv.slice(dash + 1);
  const groups = byGroup(discover());

  if (own.includes("--list")) {
    for (const [name, files] of groups) console.log(`${name}\t${files.length}`);
    process.exit(0);
  }
  const i = own.indexOf("--group");
  const wanted = i === -1 ? [] : (own[i + 1] ?? "").split(",").filter(Boolean);
  if (wanted.length === 0)
    throw new Error("usage: ci-tests.ts --list | --group <name>[,<name>…] [-- <bun test args>]");
  for (const name of wanted) {
    const files = groups.get(name);
    if (!files)
      throw new Error(`unknown group "${name}"; groups: ${[...groups.keys()].join(", ")}`);
    if (files.length === 0) throw new Error(`group "${name}" has no test files`);
  }
  const codes = await Promise.all(
    wanted.map((name) => run(name, groups.get(name) ?? [], bunArgs, wanted.length > 1))
  );
  process.exit(codes.some((c) => c !== 0) ? 1 : 0);
}
