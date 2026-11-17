/**
 * The ONE list of the hermetic test files, split into named groups and balanced slices, and the
 * runner for them.
 *
 *   bun scripts/ci-tests.ts --list
 *   bun scripts/ci-tests.ts --plan pane@6 [--tier essential|full]
 *   bun scripts/ci-tests.ts --run pane@1/6,pane@2/6,rest [--tier essential|full] [-- <bun test args>]
 *   bun scripts/ci-tests.ts --update-times <junit.xml>…
 *   bun scripts/ci-tests.ts --local <junit.xml> [-- <bun test args>]
 *
 * Two tiers. `full` is every file. `essential` (the default of `--plan` and `--run`) is what a
 * pull request and `bun run test:macos` run: test-tiers.json names at most three files for each
 * slow category, and every other file of a slow category is weekly; any file outside the slow
 * categories is essential unless ci-test-times.json measures it at the data file's
 * `heavySeconds` or more. The weekly runs use `full`. A data file with no `slow` array, a category
 * without a non-empty `category` or `prefix`, a prefix that matches no test file, a missing file,
 * a file twice, more than three files for one category, a category twice, or a prefix twice or
 * sharing files with another, stops `--plan` and `--run`.
 *
 * `--local` is the package's `test` script: a plain `bun test` that also writes a junit report
 * and prints the slowest files from it, so a slow local run names its slow files.
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
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

const CLI = join(import.meta.dir, "..");
const TIMES = join(import.meta.dir, "ci-test-times.json");
const TIERS = join(import.meta.dir, "test-tiers.json");

/** Bun's own test-file name rule. */
const TEST_FILE = /(\.test|_test_|\.spec|_spec_)[^/]*\.[cm]?[jt]sx?$/;
const EXCLUDED = ["node_modules/", "src/hooks/blind/"];
const UNMEASURED_SECONDS = 1;
const LOCAL_REPORT_ROWS = 25;

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

export const TIER_NAMES = ["essential", "full"] as const;
export type Tier = (typeof TIER_NAMES)[number];
export const MAX_ESSENTIAL_PER_CATEGORY = 3;

/** test-tiers.json. */
export interface TierData {
  /** A file outside the slow categories measured at this many seconds or more is weekly. */
  heavySeconds: number;
  slow: SlowCategory[];
  /** Files outside the slow categories that stay essential whatever their measured time. */
  pinned?: TierEntry[];
}

export interface TierEntry {
  file: string;
  /** What a regression in this file would break, in one sentence. */
  guards: string;
}

export interface SlowCategory {
  category: string;
  /**
   * `src/pane/` takes every file under that directory; a prefix that does not end in `/`
   * (`src/team`) takes only the files directly in its directory whose names start with it.
   */
  prefix: string;
  essential: TierEntry[];
}

export function loadTiers(path: string = TIERS): TierData {
  return JSON.parse(readFileSync(path, "utf8")) as TierData;
}

function inPrefix(file: string, prefix: string): boolean {
  if (!file.startsWith(prefix)) return false;
  return prefix.endsWith("/") || !file.slice(prefix.length).includes("/");
}

/** The slow category a file belongs to, or undefined for every other file. */
export function slowCategoryOf(file: string, data: TierData): string | undefined {
  return data.slow.find((c) => inPrefix(file, c.prefix))?.category;
}

/** `essential` or `weekly`: whether a file runs on every pull request or only in the full run. */
export function tierOf(
  file: string,
  data: TierData,
  times: Record<string, number>
): "essential" | "weekly" {
  const category = data.slow.find((c) => inPrefix(file, c.prefix));
  if (category) return category.essential.some((e) => e.file === file) ? "essential" : "weekly";
  if (data.pinned?.some((e) => e.file === file)) return "essential";
  const measured = times[file];
  return measured !== undefined && measured >= data.heavySeconds ? "weekly" : "essential";
}

/** The files of `files` a tier runs, in their own order. */
export function filesInTier(
  files: string[],
  tier: Tier,
  data: TierData,
  times: Record<string, number>
): string[] {
  if (tier === "full") return files;
  return files.filter((f) => tierOf(f, data, times) === "essential");
}

/** Every reason the data file cannot be used; empty when it can. */
export function validateTiers(data: TierData, known: string[]): string[] {
  const errors: string[] = [];
  const exists = new Set(known);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [`the tiers file must be a JSON object, not ${JSON.stringify(data)}`];
  }
  if (
    typeof data.heavySeconds !== "number" ||
    !Number.isFinite(data.heavySeconds) ||
    !(data.heavySeconds > 0)
  ) {
    errors.push(`heavySeconds must be a positive number of seconds, not ${data.heavySeconds}`);
  }
  // A malformed list or category would crash the checks below (and tierOf), so stop at the shape.
  if (!Array.isArray(data.slow)) {
    errors.push(`slow must be an array of categories, not ${JSON.stringify(data.slow)}`);
    return errors;
  }
  const shape = data.slow.flatMap(shapeErrors);
  if (shape.length > 0) return [...errors, ...shape];
  errors.push(...categorySetErrors(data.slow));
  errors.push(...pinnedErrors(data, exists));
  const seen = new Set<string>();
  for (const c of data.slow) {
    // A misspelt prefix takes no file, so the directory it meant stays essential in full.
    if (!known.some((f) => inPrefix(f, c.prefix))) {
      errors.push(`prefix ${c.prefix} (category ${c.category}) matches no test file`);
    }
    errors.push(...categoryErrors(c, data, exists, seen));
  }
  return errors;
}

function shapeErrors(c: SlowCategory, i: number): string[] {
  const errors: string[] = [];
  for (const key of ["category", "prefix"] as const) {
    const value: unknown = c?.[key];
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`slow[${i}] needs a non-empty string "${key}"`);
    }
  }
  if (!Array.isArray(c?.essential)) {
    errors.push(`slow[${i}] needs an "essential" array`);
    return errors;
  }
  const name = typeof c.category === "string" && c.category ? c.category : `slow[${i}]`;
  c.essential.forEach((entry: unknown, j) => errors.push(...essentialEntryErrors(entry, name, j)));
  return errors;
}

/** A pinned file must exist, sit outside every slow category, and be listed once with guards text. */
function pinnedErrors(data: TierData, exists: Set<string>): string[] {
  if (data.pinned === undefined) return [];
  if (!Array.isArray(data.pinned)) {
    return [`pinned must be an array of entries, not ${JSON.stringify(data.pinned)}`];
  }
  const shape = data.pinned.flatMap((entry: unknown, j) => entryErrors(entry, `pinned[${j}]`));
  if (shape.length > 0) return shape;
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const { file, guards } of data.pinned) {
    if (!exists.has(file)) errors.push(`pinned ${file} is not a test file`);
    const category = slowCategoryOf(file, data);
    if (category !== undefined) {
      errors.push(
        `pinned ${file} is in slow category ${category}; list it in that category's essential files`
      );
    }
    if (seen.has(file)) errors.push(`pinned ${file} is listed twice`);
    seen.add(file);
    if (!guards.trim()) errors.push(`pinned ${file} has no guards text`);
  }
  return errors;
}

function essentialEntryErrors(entry: unknown, category: string, j: number): string[] {
  return entryErrors(entry, `category ${category} essential[${j}]`);
}

function entryErrors(entry: unknown, where: string): string[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [`${where} must be an object with non-empty strings "file" and "guards"`];
  }
  const errors: string[] = [];
  for (const key of ["file", "guards"] as const) {
    const value: unknown = (entry as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`${where} needs a non-empty string "${key}"`);
    }
  }
  return errors;
}

/** True when some file path is taken by both prefixes (`inPrefix` of each). */
export function prefixesOverlap(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.startsWith(short)) return false;
  // A bare prefix takes only files directly in its directory: a longer prefix that reaches
  // into a subdirectory shares no file with it.
  return short.endsWith("/") || !long.slice(short.length).includes("/");
}

/**
 * A file takes the FIRST category whose prefix it matches, so a second category with the same
 * name or a prefix that shares files with an earlier one would be ignored, its essential files
 * left weekly while every per-category check passes.
 */
function categorySetErrors(slow: SlowCategory[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  const prefixes = new Set<string>();
  slow.forEach((c, i) => {
    if (names.has(c.category)) errors.push(`category ${c.category} is named twice`);
    names.add(c.category);
    if (prefixes.has(c.prefix)) {
      errors.push(`prefix ${c.prefix} is named twice`);
    } else {
      for (const earlier of slow.slice(0, i)) {
        if (earlier.prefix !== c.prefix && prefixesOverlap(earlier.prefix, c.prefix)) {
          errors.push(
            `prefix ${c.prefix} (category ${c.category}) overlaps prefix ${earlier.prefix} (category ${earlier.category})`
          );
        }
      }
    }
    prefixes.add(c.prefix);
  });
  return errors;
}

function categoryErrors(
  c: SlowCategory,
  data: TierData,
  exists: Set<string>,
  seen: Set<string>
): string[] {
  const errors: string[] = [];
  if (c.essential.length > MAX_ESSENTIAL_PER_CATEGORY) {
    errors.push(
      `category ${c.category} lists ${c.essential.length} essential files; at most ${MAX_ESSENTIAL_PER_CATEGORY}`
    );
  }
  for (const { file, guards } of c.essential) {
    if (!exists.has(file)) errors.push(`${file} (category ${c.category}) is not a test file`);
    if (slowCategoryOf(file, data) !== c.category) {
      errors.push(`${file} is not in category ${c.category} (prefix ${c.prefix})`);
    }
    if (seen.has(file)) errors.push(`${file} is listed twice`);
    seen.add(file);
    if (!guards?.trim()) errors.push(`${file} has no guards text`);
  }
  return errors;
}

/** The tier data, refused with every error at once when it names something it cannot. */
function checkedTiers(): TierData {
  const data = loadTiers();
  const errors = validateTiers(data, discover());
  if (errors.length > 0) throw new Error(`${TIERS}:\n  ${errors.join("\n  ")}`);
  return data;
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

/** The `n` slowest files of a junit timing table, slowest first, under a header with the total. */
export function slowestReport(times: Record<string, number>, n: number): string[] {
  const rows = Object.entries(times).sort(([, a], [, b]) => b - a);
  if (rows.length === 0) return ["[ci-tests] no test file timings in the junit report"];
  const total = rows.reduce((s, [, t]) => s + t, 0);
  const top = rows.slice(0, n);
  return [
    `[ci-tests] slowest ${top.length} of ${rows.length} test files, ${total.toFixed(1)} s in all:`,
    ...top.map(([file, t]) => `${t.toFixed(1).padStart(7)} s  ${file}`),
  ];
}

/**
 * A plain `bun test` in this package (Bun's own discovery and file order, every file), with a
 * junit report written to `outfile` and the slowest files printed after it. The exit code is
 * `bun test`'s, report or not.
 */
async function local(outfile: string, bunArgs: string[]): Promise<number> {
  const out = resolvePath(process.cwd(), outfile);
  // a report left by an earlier run must not stand in for one this run never wrote
  rmSync(out, { force: true });
  const proc = Bun.spawn(
    [process.execPath, "test", "--reporter=junit", `--reporter-outfile=${out}`, ...bunArgs],
    { cwd: CLI, stdout: "inherit", stderr: "inherit" }
  );
  const code = await proc.exited;
  let times: Record<string, number> = {};
  try {
    times = junitSeconds(readFileSync(out, "utf8"));
  } catch {
    /* no report: bun test died before writing it; the empty table says so */
  }
  for (const line of slowestReport(times, LOCAL_REPORT_ROWS)) console.log(line);
  console.log(`[ci-tests] per-file junit report: ${out}`);
  return code;
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
  "usage: ci-tests.ts --list | --plan <group>@<n> [--tier essential|full] | --run <group|group@i/n>[,…] [--tier essential|full] [-- <bun test args>] | --update-times <junit.xml>… | --local <junit.xml> [-- <bun test args>]";

/** `--tier <name>` taken out of our own arguments; `essential` when absent. */
function takeTier(own: string[]): { tier: Tier; rest: string[] } {
  const at = own.indexOf("--tier");
  if (at === -1) return { tier: "essential", rest: own };
  const name = own[at + 1] ?? "";
  if (!(TIER_NAMES as readonly string[]).includes(name)) {
    console.error(`[ci-tests] unknown tier "${name}"; tiers: ${TIER_NAMES.join(", ")}`);
    process.exit(2);
  }
  return { tier: name as Tier, rest: [...own.slice(0, at), ...own.slice(at + 2)] };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf("--");
  const { tier, rest: own } = takeTier(dash === -1 ? argv : argv.slice(0, dash));
  const bunArgs = dash === -1 ? [] : argv.slice(dash + 1);
  const all = byGroup(discover());
  const times = readTimes();
  const [command, value] = own;
  const tiered = () => {
    const data = checkedTiers();
    return new Map([...all].map(([g, fs]) => [g, filesInTier(fs, tier, data, times)] as const));
  };
  const weigh = (fs: string[]) => fs.reduce((s, f) => s + (times[f] ?? UNMEASURED_SECONDS), 0);

  if (command === "--list") {
    const data = checkedTiers();
    for (const [name, files] of all) {
      const essential = filesInTier(files, "essential", data, times);
      console.log(
        `${name}\tfull ${files.length} files, ${weigh(files).toFixed(0)} s\tessential ${essential.length} files, ${weigh(essential).toFixed(0)} s`
      );
    }
  } else if (command === "--plan" && value) {
    const [name, n] = value.split("@");
    const files = tiered().get(name ?? "") ?? [];
    console.log(
      `[ci-tests] tier ${tier}: ${name} ${files.length} of ${(all.get(name ?? "") ?? []).length} files`
    );
    for (const [i, s] of slices(files, Number(n), times).entries())
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
  } else if (command === "--local" && value) {
    // `bun run test <file>` appends the file with no `--`, so it arrives as our own argument.
    process.exit(await local(value, [...own.slice(2), ...bunArgs]));
  } else if (command === "--run" && value) {
    const wanted = value.split(",").filter(Boolean);
    const groups = tiered();
    const runs = wanted.map((spec) => resolve(spec, groups, times));
    for (const spec of wanted) {
      const name = spec.split("@")[0] ?? "";
      if ((groups.get(name) ?? []).length === 0) {
        throw new Error(`${name} has no test files in the ${tier} tier`);
      }
    }
    console.log(`[ci-tests] tier ${tier}`);
    // A slice of a group the tier has thinned can be empty; the group's files are all in the
    // other slices, so it has nothing to run and nothing to fail.
    const codes = await Promise.all(
      runs.map((r) => {
        if (r.files.length > 0) return run(r.label, r.files, bunArgs, runs.length > 1);
        console.log(`[ci-tests] ${r.label}: no files in the ${tier} tier`);
        return Promise.resolve(0);
      })
    );
    process.exit(codes.some((c) => c !== 0) ? 1 : 0);
  } else {
    throw new Error(USAGE);
  }
}
