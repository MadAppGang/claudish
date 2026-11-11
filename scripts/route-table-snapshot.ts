#!/usr/bin/env bun
/**
 * The routing gate: pin the route of every catalog model, then prove a change moved
 * only what it meant to move.
 *
 * The routing redesign replaces a hand-written table with candidates gathered from
 * the cloud models catalog. That changes EVERY bare-name route at once, so the only
 * honest gate is the whole table, read twice. A passing test suite cannot show this:
 * the suite asserts the routes someone thought to write down, and the ones nobody
 * wrote down are exactly where a silent removal hides.
 *
 * Capture BEFORE the change, capture again after, then diff:
 *
 *   bun run scripts/route-table-snapshot.ts capture before.json
 *   # ... make the change ...
 *   bun run scripts/route-table-snapshot.ts capture after.json
 *   bun run scripts/route-table-snapshot.ts diff before.json after.json
 *
 * The diff classifies every difference. `lost` is the one that must be empty unless
 * the design names that removal: a provider that used to serve a model and no longer
 * appears is a user whose key stopped working, with no error to read.
 *
 * `diff --strict` is the gate for a change meant to move NOTHING, such as a refactor.
 * The plain diff fails only on removals: a gained hop, a new order and a different
 * catalog generation are printed for review, and a no-route row whose reason changed is
 * not compared at all. Under `--strict` any difference fails the run, including those,
 * a kind change, a changed header field and a column a later capture adds. A generation
 * mismatch is an error there, not a warning, because a diff across two generations
 * cannot tell the code change from the catalog change.
 *
 * Two flags make `--strict` usable for a change meant to move a KNOWN set of things:
 *
 *   diff --strict --expect expected.json before.json after.json
 *   diff --strict --new-column decision before.json after.json
 *
 * `--expect` names each allowed difference in advance, as a JSON list of
 * `{ "model", "column", "old", "new" }` (a missing `old` or `new` means the column is
 * absent on that side). A difference the list names exactly is allowed; any other
 * difference fails, and so does a listed difference the two snapshots do not show.
 * `--new-column <name>` (repeatable) skips a column the before snapshot does not carry
 * at all, which is how a capture that gained a column is compared with one that
 * predates it. Naming a column the before snapshot does carry is refused.
 *
 * Each row also records `decision`: what the proxy does with the id before `route()`
 * could see it (`proxyRouteDecision`). The row's chain is `route()`'s answer whatever
 * the decision says; the proxy asks `route()` only when the decision is `bare`.
 *
 * Environment-dependent by design. It calls the real `route()`, so it sees this
 * machine's credentials and default provider. Both snapshots must come from the
 * same machine with the same configuration, which is why each file records them.
 * The header's `defaultProvider` is `{ provider, source }` as `route()` resolves it
 * (CLAUDISH_DEFAULT_PROVIDER, then the config file, then an OpenRouter key in any
 * store, then `openrouter`), read before
 * the first route is resolved. `--strict` fails when the two differ, source included.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedDefaultProvider } from "../packages/cli/src/default-provider.js";
import { readAllModelsCache } from "../packages/cli/src/providers/all-models-cache.js";
import {
  type ProxyRouteDecision,
  proxyRouteDecision,
} from "../packages/cli/src/providers/native-route.js";
import {
  effectiveDefaultProviderResolution,
  route,
} from "../packages/cli/src/providers/routing-rules.js";

/** One model's resolved chain, flattened to the strings a request would carry. */
interface RouteRow {
  modelId: string;
  /**
   * What the proxy does with the id before routing; only `bare` reaches `route()`.
   * Absent from snapshots captured before this column existed.
   */
  decision?: ProxyRouteDecision["type"];
  kind: "ok" | "no-route";
  /** `provider@model` per hop, primary first. Empty for `no-route`. */
  chain: string[];
  /** Why there is no route, verbatim. Only for `no-route`. */
  reason?: string;
}

/** The fallback position `route()` fills for this capture, and where that value came from. */
type CapturedDefaultProvider = Pick<ResolvedDefaultProvider, "provider" | "source">;

interface Snapshot {
  capturedAt: string;
  catalogGenerationId: string;
  /**
   * Recorded because the fallback hop decides the last position of every gathered
   * chain. Snapshots captured before the resolver was recorded carry the config
   * file's raw value, or nothing.
   */
  defaultProvider: CapturedDefaultProvider | string | undefined;
  entryCount: number;
  rows: RouteRow[];
}

/**
 * Read the default provider the way `route()` does
 * (`effectiveDefaultProviderResolution`, an OpenRouter key in any store counted),
 * keeping its source. Called BEFORE any route is resolved: resolving a credential
 * can write a key into `process.env`, and `OPENROUTER_API_KEY` appearing there
 * mid-capture would turn a `hardcoded` source into `openrouter-key`.
 */
function captureDefaultProvider(): CapturedDefaultProvider {
  const { provider, source } = effectiveDefaultProviderResolution();
  return { provider, source };
}

/** A header value for a message: `openrouter (hardcoded)`, `"" (env-var)`, or a legacy string. */
function describeDefaultProvider(value: Snapshot["defaultProvider"]): string {
  if (value === undefined) return "(none)";
  if (typeof value === "string") return value === "" ? '""' : value;
  return `${value.provider === "" ? '""' : value.provider} (${value.source})`;
}

/** How many routes to resolve at once. `route()` can touch discovery, so it is not free. */
const CONCURRENCY = 8;

async function capture(outPath: string, limit?: number): Promise<void> {
  const cache = readAllModelsCache();
  if (!cache || cache.entries.length === 0) {
    console.error(
      `No cloud models catalog cache at ${join(homedir(), ".claudish", "cloud-models-catalog-v3.json")}.\n` +
        "Refresh it first — an empty catalog captures an empty table, which would make any diff look clean."
    );
    process.exit(1);
  }

  const defaultProvider = captureDefaultProvider();
  const modelIds = cache.entries.map((entry) => entry.modelId);
  const ids = limit ? modelIds.slice(0, limit) : modelIds;
  const rows: RouteRow[] = [];
  let done = 0;

  for (let start = 0; start < ids.length; start += CONCURRENCY) {
    const batch = ids.slice(start, start + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (modelId): Promise<RouteRow> => {
        const decision = proxyRouteDecision(modelId).type;
        try {
          const plan = await route(modelId);
          if (plan.kind === "ok") {
            return {
              modelId,
              decision,
              kind: "ok",
              chain: [plan.primary, ...plan.fallbacks].map((hop) => hop.modelSpec),
            };
          }
          return { modelId, decision, kind: "no-route", chain: [], reason: plan.reason };
        } catch (error) {
          // A throw is itself a finding: record it rather than losing the row.
          return {
            modelId,
            decision,
            kind: "no-route",
            chain: [],
            reason: `threw: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      })
    );
    rows.push(...settled);
    done += batch.length;
    if (done % 200 === 0 || done === ids.length) {
      process.stderr.write(`  resolved ${done}/${ids.length}\n`);
    }
  }

  const snapshot: Snapshot = {
    capturedAt: new Date().toISOString(),
    catalogGenerationId: cache.catalogGenerationId,
    defaultProvider,
    entryCount: cache.entries.length,
    rows,
  };
  await Bun.write(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const routed = rows.filter((row) => row.kind === "ok").length;
  console.log(
    `Wrote ${outPath}: ${rows.length} models, ${routed} routed, ${rows.length - routed} with no route, generation ${snapshot.catalogGenerationId}.`
  );
  console.log(`Default provider: ${describeDefaultProvider(defaultProvider)}.`);
  const decisions = new Map<string, number>();
  for (const row of rows) {
    const decision = row.decision ?? "(none)";
    decisions.set(decision, (decisions.get(decision) ?? 0) + 1);
  }
  console.log(
    `Proxy decision per row: ${[...decisions].map(([decision, count]) => `${decision} ${count}`).join(", ")}.`
  );
}

function loadSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, "utf-8")) as Snapshot;
}

/** Every difference between two tables, one list per class. */
interface TableDiff {
  /** A provider that used to serve this model no longer appears. */
  lost: string[];
  /** A new provider appears. */
  gained: string[];
  /** Same providers, different order. */
  reordered: string[];
  becameNoRoute: string[];
  becameRouted: string[];
  /** The model is absent from the after snapshot. */
  disappeared: string[];
  appeared: string[];
  /** Still no-route, but it tells the user something different. Read by `--strict` only. */
  noRouteTextChanged: string[];
  /** Any other column, including one a later capture adds. Read by `--strict` only. */
  otherFieldChanged: string[];
}

/** Header keys that describe the capture run, not the table. `rows` is compared row by row. */
const HEADER_KEYS_NOT_COMPARED = new Set(["capturedAt", "rows"]);

/**
 * What a no-route row tells the user. `capture` records only `reason` today; `hint` is
 * compared whenever a snapshot carries it.
 */
const NO_ROUTE_TEXT_KEYS = new Set(["reason", "hint"]);

/** Two JSON values compared by content. `undefined` stands for a key the file does not carry. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function showValue(value: unknown): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

/** Each key either object carries, `include` permitting, whose value differs: `key: before => after`. */
function changedFields(before: object, after: object, include: (key: string) => boolean): string[] {
  const beforeFields = Object.fromEntries(Object.entries(before));
  const afterFields = Object.fromEntries(Object.entries(after));
  const keys = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]);
  return [...keys]
    .filter((key) => include(key) && !sameValue(beforeFields[key], afterFields[key]))
    .map((key) => `${key}: ${showValue(beforeFields[key])} => ${showValue(afterFields[key])}`);
}

function compareChains(
  modelId: string,
  beforeChain: string[],
  afterChain: string[],
  result: TableDiff
): void {
  const beforeSet = new Set(beforeChain);
  const afterSet = new Set(afterChain);
  const missing = beforeChain.filter((hop) => !afterSet.has(hop));
  const extra = afterChain.filter((hop) => !beforeSet.has(hop));
  if (missing.length > 0) {
    result.lost.push(`${modelId}: lost ${missing.join(", ")}  (was ${beforeChain.join(" -> ")})`);
  }
  if (extra.length > 0) {
    result.gained.push(`${modelId}: gained ${extra.join(", ")}`);
  }
  if (
    missing.length === 0 &&
    extra.length === 0 &&
    beforeChain.join("|") !== afterChain.join("|")
  ) {
    result.reordered.push(
      `${modelId}: ${beforeChain.join(" -> ")}  =>  ${afterChain.join(" -> ")}`
    );
  }
}

/** Records the kind, chain and no-route text classes; returns the row keys they account for. */
function classifyRow(
  modelId: string,
  beforeRow: RouteRow,
  afterRow: RouteRow,
  result: TableDiff
): Set<string> {
  // A kind flip changes the chain, reason and hint by definition; its class line says so.
  const flipKeys = ["modelId", "kind", "chain", ...NO_ROUTE_TEXT_KEYS];
  if (beforeRow.kind === "ok" && afterRow.kind === "no-route") {
    result.becameNoRoute.push(
      `${modelId}: had ${beforeRow.chain.join(" -> ")}; now ${afterRow.reason ?? "no reason"}`
    );
    return new Set(flipKeys);
  }
  if (beforeRow.kind === "no-route" && afterRow.kind === "ok") {
    result.becameRouted.push(`${modelId}: now ${afterRow.chain.join(" -> ")}`);
    return new Set(flipKeys);
  }
  compareChains(modelId, beforeRow.chain, afterRow.chain, result);
  if (beforeRow.kind !== "no-route" || afterRow.kind !== "no-route") {
    // `kind` stays unclassified, so a kind other than `ok`/`no-route` still shows as a change.
    return new Set(["modelId", "chain"]);
  }
  const text = changedFields(beforeRow, afterRow, (key) => NO_ROUTE_TEXT_KEYS.has(key));
  result.noRouteTextChanged.push(...text.map((field) => `${modelId}: ${field}`));
  return new Set(["modelId", "chain", ...NO_ROUTE_TEXT_KEYS]);
}

function compareRow(
  modelId: string,
  beforeRow: RouteRow,
  afterRow: RouteRow,
  result: TableDiff
): void {
  const classified = classifyRow(modelId, beforeRow, afterRow, result);
  // Every key no class accounts for, so a column a later capture adds is compared too.
  const other = changedFields(beforeRow, afterRow, (key) => !classified.has(key));
  result.otherFieldChanged.push(...other.map((field) => `${modelId}: ${field}`));
}

function compareTables(before: Snapshot, after: Snapshot): TableDiff {
  const beforeRows = new Map(before.rows.map((row) => [row.modelId, row]));
  const afterRows = new Map(after.rows.map((row) => [row.modelId, row]));
  const result: TableDiff = {
    lost: [],
    gained: [],
    reordered: [],
    becameNoRoute: [],
    becameRouted: [],
    disappeared: [],
    appeared: [],
    noRouteTextChanged: [],
    otherFieldChanged: [],
  };

  for (const [modelId, beforeRow] of beforeRows) {
    const afterRow = afterRows.get(modelId);
    if (afterRow) compareRow(modelId, beforeRow, afterRow, result);
    else result.disappeared.push(modelId);
  }
  for (const modelId of afterRows.keys()) {
    if (!beforeRows.has(modelId)) result.appeared.push(modelId);
  }
  return result;
}

/** Model ids one snapshot lists twice. The row map keeps only the last, so the rest would go unread. */
function duplicateRows(label: string, snapshot: Snapshot): string[] {
  const counts = new Map<string, number>();
  for (const row of snapshot.rows) counts.set(row.modelId, (counts.get(row.modelId) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([modelId, count]) => `${label}: ${modelId} listed ${count} times`);
}

/** Plain: a warning to read past. Strict: an error, and the header section counts it. */
function reportSetupMismatch(before: Snapshot, after: Snapshot, strict: boolean): void {
  const report = (message: string): void => {
    if (strict) console.error(`ERROR: ${message}`);
    else console.warn(`WARNING: ${message}`);
  };
  if (before.catalogGenerationId !== after.catalogGenerationId) {
    report(
      `different catalog generations (${before.catalogGenerationId} vs ${after.catalogGenerationId}).\n` +
        "Differences below mix the code change with a catalog change and cannot be attributed to either.\n" +
        (strict ? "--strict fails on this alone: capture both snapshots on one generation.\n" : "")
    );
  }
  // By content: the header value is an object, and two parsed objects are never `===`.
  if (!sameValue(before.defaultProvider, after.defaultProvider)) {
    report(
      `defaultProvider differs (${describeDefaultProvider(before.defaultProvider)} vs ${describeDefaultProvider(after.defaultProvider)}). The fallback hop may differ for every model.\n`
    );
  }
}

function section(title: string, lines: string[], verdict: "must-be-empty" | "review"): void {
  const mark = lines.length === 0 ? "none" : `${lines.length}`;
  console.log(
    `\n## ${title} — ${mark}${verdict === "must-be-empty" && lines.length > 0 ? "  <-- MUST be named by the design" : ""}`
  );
  for (const line of lines.slice(0, 40)) console.log(`  ${line}`);
  if (lines.length > 40) console.log(`  … ${lines.length - 40} more`);
}

/** An invocation or input the gate cannot run with. Printed as an error; exit 2. */
class UsageError extends Error {}

/**
 * One difference the design names in advance: `column` of `model` goes from `old` to
 * `new`. A missing `old` or `new` means the column is absent on that side.
 */
interface ExpectedDifference {
  model: string;
  column: string;
  old?: unknown;
  new?: unknown;
}

const EXPECTATION_KEYS = new Set(["model", "column", "old", "new"]);

function readJson(path: string, flag: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new UsageError(`${flag} ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function toExpectation(item: unknown, where: string): ExpectedDifference {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new UsageError(`${where}: not an object`);
  }
  const fields = item as Record<string, unknown>;
  const unknownKeys = Object.keys(fields).filter((key) => !EXPECTATION_KEYS.has(key));
  if (unknownKeys.length > 0)
    throw new UsageError(`${where}: unknown key ${unknownKeys.join(", ")}`);
  if (typeof fields.model !== "string" || typeof fields.column !== "string") {
    throw new UsageError(`${where}: needs a string "model" and a string "column"`);
  }
  if (fields.column === "modelId") throw new UsageError(`${where}: modelId names the row`);
  if (sameValue(fields.old, fields.new)) {
    throw new UsageError(`${where}: "old" equals "new", so it names no difference`);
  }
  return { model: fields.model, column: fields.column, old: fields.old, new: fields.new };
}

/** The `--expect` file, refused whole if any entry is malformed or listed twice. */
function loadExpectations(path: string): ExpectedDifference[] {
  const parsed = readJson(path, "--expect");
  if (!Array.isArray(parsed)) throw new UsageError(`--expect ${path}: not a JSON list`);
  const seen = new Set<string>();
  return parsed.map((item: unknown, index) => {
    const where = `--expect ${path}, entry ${index}`;
    const expectation = toExpectation(item, where);
    const key = JSON.stringify([expectation.model, expectation.column]);
    if (seen.has(key)) {
      throw new UsageError(`${where}: ${expectation.model} ${expectation.column} is listed twice`);
    }
    seen.add(key);
    return expectation;
  });
}

function columnOf(row: RouteRow, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column];
}

/** A copy of `row` with `column` set to `value`, or without it when `value` is undefined. */
function withColumn(row: RouteRow, column: string, value: unknown): RouteRow {
  const copy: Record<string, unknown> = { ...row };
  if (value === undefined) delete copy[column];
  else copy[column] = value;
  return copy as unknown as RouteRow;
}

/**
 * Take each new column out of `after`, once `before` is shown to carry it on no row.
 * A column `before` does carry is not new, and skipping it would hide a real difference.
 */
function dropNewColumns(
  before: Snapshot,
  after: Snapshot,
  columns: string[]
): { after: Snapshot; notes: string[] } {
  const notes: string[] = [];
  let rows = after.rows;
  for (const column of columns) {
    const carriedBefore = before.rows.filter((row) => Object.hasOwn(row, column)).length;
    if (carriedBefore > 0) {
      throw new UsageError(
        `--new-column ${column}: the before snapshot carries it on ${carriedBefore} of ${before.rows.length} rows, so it is not new. Drop the flag to compare it.`
      );
    }
    const carriedAfter = rows.filter((row) => Object.hasOwn(row, column)).length;
    notes.push(
      `New column "${column}": on no before row and ${carriedAfter} of ${rows.length} after rows; not compared.`
    );
    rows = rows.map((row) => withColumn(row, column, undefined));
  }
  return { after: { ...after, rows }, notes };
}

/**
 * Match each expected difference against the two snapshots. A match is taken out of
 * `after` (its column set back to the before value), so the comparison never sees it.
 * Anything else is unmet: the model is missing, or a side holds another value.
 */
function applyExpectations(
  before: Snapshot,
  after: Snapshot,
  expected: ExpectedDifference[]
): { after: Snapshot; matched: string[]; unmet: string[] } {
  const beforeRows = new Map(before.rows.map((row) => [row.modelId, row]));
  const afterRows = new Map(after.rows.map((row) => [row.modelId, row]));
  const matched: string[] = [];
  const unmet: string[] = [];
  for (const expectation of expected) {
    const { model, column } = expectation;
    const named = `${model}: ${column}: ${showValue(expectation.old)} => ${showValue(expectation.new)}`;
    const beforeRow = beforeRows.get(model);
    const afterRow = afterRows.get(model);
    if (!beforeRow || !afterRow) {
      unmet.push(`${named}  (no such model in the ${beforeRow ? "after" : "before"} snapshot)`);
      continue;
    }
    const was = columnOf(beforeRow, column);
    const now = columnOf(afterRow, column);
    if (sameValue(was, expectation.old) && sameValue(now, expectation.new)) {
      matched.push(named);
      afterRows.set(model, withColumn(afterRow, column, was));
    } else {
      unmet.push(`${named}  (found ${showValue(was)} => ${showValue(now)})`);
    }
  }
  const rows = after.rows.map((row) => afterRows.get(row.modelId) ?? row);
  return { after: { ...after, rows }, matched, unmet };
}

interface StrictOptions {
  /** A JSON list of expected differences. */
  expectPath?: string;
  /** Columns the before snapshot does not carry; not compared. */
  newColumns: string[];
}

interface StrictAdjustment {
  after: Snapshot;
  notes: string[];
  matched: string[];
  unmet: string[];
}

function adjustForStrict(
  before: Snapshot,
  after: Snapshot,
  options: StrictOptions
): StrictAdjustment {
  const expected = options.expectPath ? loadExpectations(options.expectPath) : [];
  const both = expected.find((expectation) => options.newColumns.includes(expectation.column));
  if (both) {
    throw new UsageError(
      `${both.column} is both a --new-column (not compared) and an --expect column (compared)`
    );
  }
  const dropped = dropNewColumns(before, after, options.newColumns);
  const applied = applyExpectations(before, dropped.after, expected);
  return { notes: dropped.notes, ...applied };
}

function diff(
  beforePath: string,
  afterPath: string,
  strict: boolean,
  options: StrictOptions
): void {
  const before = loadSnapshot(beforePath);
  const loaded = loadSnapshot(afterPath);
  const adjusted: StrictAdjustment = strict
    ? adjustForStrict(before, loaded, options)
    : { after: loaded, notes: [], matched: [], unmet: [] };
  const after = adjusted.after;
  reportSetupMismatch(before, after, strict);

  const table = compareTables(before, after);
  // Under --strict nothing is for review: the change was meant to move nothing.
  const review = strict ? "must-be-empty" : "review";
  const header = strict
    ? changedFields(before, after, (key) => !HEADER_KEYS_NOT_COMPARED.has(key))
    : [];
  const duplicates = strict
    ? [...duplicateRows("before", before), ...duplicateRows("after", after)]
    : [];

  console.log(
    `Route table: ${before.rows.length} models before, ${after.rows.length} after, generation ${after.catalogGenerationId}.`
  );
  for (const note of adjusted.notes) console.log(note);
  if (strict) {
    section("Snapshot header changed", header, "must-be-empty");
    section("Model listed twice in one snapshot", duplicates, "must-be-empty");
  }
  section("Routes LOST", table.lost, "must-be-empty");
  section("Became no-route", table.becameNoRoute, "must-be-empty");
  section("Models disappeared from the table", table.disappeared, "must-be-empty");
  section("Routes GAINED", table.gained, review);
  section("Became routed", table.becameRouted, review);
  section("Order changed, same providers", table.reordered, review);
  section("Models appeared in the table", table.appeared, review);

  if (!strict) {
    const blocking = table.lost.length + table.becameNoRoute.length + table.disappeared.length;
    console.log(
      `\nVerdict: ${blocking === 0 ? "no route was removed" : `${blocking} removals to justify or fix`}.`
    );
    process.exit(blocking === 0 ? 0 : 1);
  }

  section("No-route reason or hint changed", table.noRouteTextChanged, "must-be-empty");
  section("Other row fields changed", table.otherFieldChanged, "must-be-empty");
  if (options.expectPath) {
    section("Expected differences NOT found", adjusted.unmet, "must-be-empty");
    section("Expected differences found, allowed", adjusted.matched, "review");
  }
  strictVerdict(header.length + duplicates.length, table, adjusted);
}

/** Print the strict verdict and exit: 0 only when nothing but expected differences remain. */
function strictVerdict(headerAndDuplicates: number, table: TableDiff, adjusted: StrictAdjustment) {
  const differences =
    headerAndDuplicates +
    adjusted.unmet.length +
    Object.values(table).reduce((sum, lines) => sum + lines.length, 0);
  const clean =
    adjusted.matched.length === 0
      ? "no difference"
      : `no difference beyond the ${adjusted.matched.length} expected`;
  console.log(
    `\nVerdict (strict): ${differences === 0 ? clean : `${differences} difference${differences === 1 ? "" : "s"}, each to be named by the design or fixed`}.`
  );
  process.exit(differences === 0 ? 0 : 1);
}

/** Flags that take a value, as `--name value` or `--name=value`. */
const VALUE_FLAGS = new Set(["--expect", "--new-column"]);

interface CommandLine {
  positional: string[];
  /** Every other `--` token, verbatim (`--strict`, `--limit=N`, or a typo). */
  flags: string[];
  values: Map<string, string[]>;
  problems: string[];
}

/** Record the value flag at `argv[index]`; returns the index of the last token it used. */
function readValueFlag(argv: string[], index: number, line: CommandLine): number {
  const arg = argv[index];
  const name = arg.split("=")[0];
  const inline = arg.includes("=") ? arg.slice(name.length + 1) : undefined;
  const used = inline === undefined ? index + 1 : index;
  const value = inline ?? argv[used];
  if (!value || value.startsWith("--")) line.problems.push(`${name} needs a value`);
  else line.values.set(name, [...(line.values.get(name) ?? []), value]);
  return used;
}

function parseCommandLine(argv: string[]): CommandLine {
  const line: CommandLine = { positional: [], flags: [], values: new Map(), problems: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) line.positional.push(arg);
    else if (!VALUE_FLAGS.has(arg.split("=")[0])) line.flags.push(arg);
    else index = readValueFlag(argv, index, line);
  }
  return line;
}

/** Why a `diff` command line cannot run; empty when it can. */
function diffProblems(line: CommandLine): string[] {
  const problems = [...line.problems];
  // An unknown flag is refused, not ignored: a mistyped --strict must not run the plain gate and pass.
  const unknown = line.flags.filter((flag) => flag !== "--strict");
  if (unknown.length > 0) problems.push(`unknown flag ${unknown.join(", ")}`);
  if (line.values.size > 0 && !line.flags.includes("--strict")) {
    problems.push("--expect and --new-column apply only with --strict");
  }
  if ((line.values.get("--expect") ?? []).length > 1) problems.push("--expect may be given once");
  return problems;
}

function runDiff(line: CommandLine, beforePath: string, afterPath: string): void {
  try {
    diff(beforePath, afterPath, line.flags.includes("--strict"), {
      expectPath: line.values.get("--expect")?.[0],
      newColumns: line.values.get("--new-column") ?? [],
    });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`ERROR: ${error.message}`);
    process.exit(2);
  }
}

const commandLine = parseCommandLine(process.argv.slice(2));
const [command, a, b] = commandLine.positional;
const problems = command === "diff" ? diffProblems(commandLine) : [];
if (command === "capture" && a) {
  const limitArg = commandLine.flags.find((arg) => arg.startsWith("--limit="));
  await capture(a, limitArg ? Number(limitArg.split("=")[1]) : undefined);
} else if (command === "diff" && a && b && problems.length === 0) {
  runDiff(commandLine, a, b);
} else {
  for (const problem of problems) console.error(`ERROR: ${problem}`);
  console.error(
    "usage:\n" +
      "  bun run scripts/route-table-snapshot.ts capture <out.json> [--limit=N]\n" +
      "  bun run scripts/route-table-snapshot.ts diff [--strict] <before.json> <after.json>\n" +
      "  bun run scripts/route-table-snapshot.ts diff --strict [--expect <expected.json>]\n" +
      "      [--new-column <name>]... <before.json> <after.json>"
  );
  process.exit(2);
}
