/**
 * The ONE list of the hermetic test files, split into named groups and balanced slices, and the
 * runner for them.
 *
 *   bun scripts/ci-tests.ts --list
 *   bun scripts/ci-tests.ts --plan pane@6
 *   bun scripts/ci-tests.ts --run pane@1/6,pane@2/6,rest [-- <bun test args>]
 *   bun scripts/ci-tests.ts --update-times <junit.xml>…
 *
 * `--run` takes groups (`rest`) and slices (`pane@2/6`: the 2nd of 6 slices of `pane`). Several
 * run as concurrent `bun test` processes, each output line prefixed with its label. `{label}` in
 * a passed-through argument becomes the label (`pane-2of6`), so each process can write its own
 * `--reporter-outfile`. The exit code is non-zero when any process fails.
 *
 * Slices are balanced by the measured seconds in ci-test-times.json, which `--update-times`
 * rewrites from Bun junit reports. A file missing from the table weighs 1 s, so a stale table
 * only unbalances the slices: every file of a group is still in exactly one of its slices.
 *
 * Files are passed WITHOUT a leading `./`: Bun then reads them as filters on its own discovery
 * and keeps a bare `bun test`'s file order. `./` paths run in argument order instead, and a few
 * suites share process state across files, so a new order is a new suite.
 *
 * src/hooks/blind is not here: it runs under Bun 1.4.0 in its own job (test.yml).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..");
const TIMES = join(import.meta.dir, "ci-test-times.json");

/** Bun's own test-file name rule. */
const TEST_FILE = /(\.test|_test_|\.spec|_spec_)[^/]*\.[cm]?[jt]sx?$/;
const EXCLUDED = ["node_modules/", "src/hooks/blind/"];
const UNMEASURED_SECONDS = 1;

/**
 * Each file belongs to the first group whose prefix it starts with; `rest` takes the others.
 * - idle: CPU-idle waits on real retry ladders and token-refresh ceilings, with no magmux.
 *   Passes on Linux.
 * - pane: real magmux panes and the MCP session machinery on top of them. macOS only.
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

/** Files that share process state across files: a slice takes all of them or none. */
const TOGETHER = ["src/recovery/"];

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

function readTimes(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(TIMES, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * Split `files` into `n` slices of about equal measured time: longest unit first, each to the
 * lightest slice. Each slice keeps the discovery order.
 */
export function slices(
  files: string[],
  n: number,
  times: Record<string, number>
): { files: string[]; seconds: number }[] {
  const units = new Map<string, string[]>();
  for (const f of files) {
    const key = TOGETHER.find((p) => f.startsWith(p)) ?? f;
    units.set(key, [...(units.get(key) ?? []), f]);
  }
  const weigh = (fs: string[]) => fs.reduce((s, f) => s + (times[f] ?? UNMEASURED_SECONDS), 0);
  const out = Array.from({ length: n }, () => ({ files: [] as string[], seconds: 0 }));
  for (const unit of [...units.values()].sort((a, b) => weigh(b) - weigh(a))) {
    const lightest = out.reduce((min, s) => (s.seconds < min.seconds ? s : min));
    lightest.files.push(...unit);
    lightest.seconds += weigh(unit);
  }
  for (const s of out) s.files.sort();
  return out;
}

/** `rest` or `pane@2/6` → the label and the files it names. */
function resolve(
  spec: string,
  groups: Map<string, string[]>,
  times: Record<string, number>
): { label: string; files: string[] } {
  const m = spec.match(/^([a-z]+)(?:@(\d+)\/(\d+))?$/);
  if (!m) throw new Error(`"${spec}" is not a group or a slice like pane@2/6`);
  const [, name, index, count] = m;
  const files = groups.get(name);
  if (!files) throw new Error(`unknown group "${name}"; groups: ${[...groups.keys()].join(", ")}`);
  if (!index) return { label: name, files };
  const i = Number(index);
  const n = Number(count);
  if (i < 1 || i > n) throw new Error(`slice ${i} of ${n} does not exist`);
  return { label: `${name}-${i}of${n}`, files: slices(files, n, times)[i - 1]?.files ?? [] };
}

/**
 * Per-file wall seconds from Bun junit: the sum of each file's top-level describes and tests.
 * Bun reports a `describe.concurrent` as 0 s; such a file's wall time is its longest test.
 */
export function junitSeconds(xml: string): Record<string, number> {
  const w: JunitWalk = { depth: 0, file: "", sums: new Map(), longest: new Map() };
  for (const [tag] of xml.matchAll(/<\/testsuite>|<testsuite\b[^>]*>|<testcase\b[^>]*>/g)) {
    if (tag === "</testsuite>") w.depth--;
    else if (tag.startsWith("<testsuite")) enterSuite(w, tag);
    else visitCase(w, tag);
  }
  const files = new Set([...w.sums.keys(), ...w.longest.keys()]);
  return Object.fromEntries(
    [...files].map((f) => [f, Math.max(w.sums.get(f) ?? 0, w.longest.get(f) ?? 0)])
  );
}

interface JunitWalk {
  depth: number;
  file: string;
  /** a file's direct children: its top-level describes, and tests outside any describe */
  sums: Map<string, number>;
  longest: Map<string, number>;
}

function enterSuite(w: JunitWalk, tag: string): void {
  w.depth++;
  if (w.depth === 1) w.file = xmlAttr(tag, "file") || xmlAttr(tag, "name");
  if (w.depth === 2) w.sums.set(w.file, (w.sums.get(w.file) ?? 0) + seconds(tag));
}

function visitCase(w: JunitWalk, tag: string): void {
  if (w.depth === 1) w.sums.set(w.file, (w.sums.get(w.file) ?? 0) + seconds(tag));
  w.longest.set(w.file, Math.max(w.longest.get(w.file) ?? 0, seconds(tag)));
}

function seconds(tag: string): number {
  return Number(xmlAttr(tag, "time") || 0);
}

function xmlAttr(tag: string, name: string): string {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
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
  label: string,
  files: string[],
  bunArgs: string[],
  prefixed: boolean
): Promise<number> {
  const args = bunArgs.map((a) => a.replaceAll("{label}", label));
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, "test", ...args, ...files], {
    cwd: CLI,
    stdout: prefixed ? "pipe" : "inherit",
    stderr: prefixed ? "pipe" : "inherit",
  });
  if (prefixed) {
    await Promise.all([
      pipe(proc.stdout as ReadableStream<Uint8Array>, `[${label}] `, process.stdout),
      pipe(proc.stderr as ReadableStream<Uint8Array>, `[${label}] `, process.stderr),
    ]);
  }
  const code = await proc.exited;
  const secs = ((performance.now() - started) / 1000).toFixed(0);
  console.log(`[ci-tests] ${label}: ${files.length} files, exit ${code}, ${secs} s`);
  return code;
}

const USAGE =
  "usage: ci-tests.ts --list | --plan <group>@<n> | --run <group|group@i/n>[,…] [-- <bun test args>] | --update-times <junit.xml>…";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf("--");
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const bunArgs = dash === -1 ? [] : argv.slice(dash + 1);
  const groups = byGroup(discover());
  const times = readTimes();
  const [command, value] = own;

  if (command === "--list") {
    for (const [name, files] of groups) {
      const secs = files.reduce((s, f) => s + (times[f] ?? UNMEASURED_SECONDS), 0);
      console.log(`${name}\t${files.length} files\t${secs.toFixed(0)} s measured`);
    }
  } else if (command === "--plan" && value) {
    const [name, n] = value.split("@");
    for (const [i, s] of slices(groups.get(name ?? "") ?? [], Number(n), times).entries())
      console.log(`${name}@${i + 1}/${n}\t${s.files.length} files\t${s.seconds.toFixed(0)} s`);
  } else if (command === "--update-times" && own.length > 1) {
    const next = { ...times };
    for (const path of own.slice(1)) Object.assign(next, junitSeconds(readFileSync(path, "utf8")));
    const known = new Set(discover());
    const sorted = Object.fromEntries(
      Object.entries(next)
        .filter(([f]) => known.has(f))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([f, s]) => [f, Math.round(s * 10) / 10])
    );
    writeFileSync(TIMES, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`[ci-tests] ${Object.keys(sorted).length} files timed in ${TIMES}`);
  } else if (command === "--run" && value) {
    const wanted = value.split(",").filter(Boolean);
    const runs = wanted.map((spec) => resolve(spec, groups, times));
    for (const r of runs) if (r.files.length === 0) throw new Error(`${r.label} has no test files`);
    const codes = await Promise.all(
      runs.map((r) => run(r.label, r.files, bunArgs, runs.length > 1))
    );
    process.exit(codes.some((c) => c !== 0) ? 1 : 0);
  } else {
    throw new Error(USAGE);
  }
}
