import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEEP_EFFORT, effortArg, effortClarification } from "./mcp-server.js";

type Efforts = Record<string, Record<string, { effort: string }>>;
const captured = JSON.parse(
  readFileSync(
    join(import.meta.dir, "test-fixtures/effort-recommendations/recommended-2.3.0.json"),
    "utf8"
  )
) as { data: { recommendations: { efforts: Efforts } } };
const efforts = captured.data.recommendations.efforts;
const foreign = "gpt-6-luna";
const native = Object.keys(efforts).find((id) => id.startsWith("claude-"))!;
const rows = JSON.parse(
  readFileSync(
    join(import.meta.dir, "test-fixtures/catalog-v3/rows-g-20260919013346169.json"),
    "utf8"
  )
) as { entries: Array<{ modelId: string }> };
const missing = rows.entries.find((entry) => !efforts[entry.modelId])!.modelId;
const levels = (id: string) =>
  Object.fromEntries(Object.entries(efforts[id]).map(([task, cell]) => [task, cell.effort]));

describe("effortClarification with real efforts data", () => {
  test("the data has native and foreign rows and a captured model with no row", () => {
    expect(efforts[foreign]).toBeDefined();
    expect(efforts[native]).toBeDefined();
    expect(efforts[missing]).toBeUndefined();
    expect(KEEP_EFFORT).toBe("default");
    expect(effortArg(KEEP_EFFORT)).toBeUndefined();
  });

  const cases: Array<{
    name: string;
    specs: string[];
    expected: Record<string, Record<string, string>> | undefined;
  }> = [
    { name: "bare canonical id", specs: [foreign], expected: { [foreign]: levels(foreign) } },
    {
      name: "provider lookup preserves caller key",
      specs: [`oai@${foreign}`],
      expected: { [`oai@${foreign}`]: levels(foreign) },
    },
    {
      name: "multiple spellings stay separate",
      specs: [foreign, `cx@${foreign}`],
      expected: { [foreign]: levels(foreign), [`cx@${foreign}`]: levels(foreign) },
    },
    { name: "native row skipped", specs: [native], expected: undefined },
    {
      name: "native aliases skipped",
      specs: ["opus", "sonnet", "haiku", "internal"],
      expected: undefined,
    },
    {
      name: "explicit Claude is foreign",
      specs: [`anthropic@${native}`],
      expected: { [`anthropic@${native}`]: levels(native) },
    },
    { name: "no matching row", specs: [missing], expected: undefined },
    {
      name: "mixed models only return matching foreign rows",
      specs: [native, missing, `oai@${foreign}`],
      expected: { [`oai@${foreign}`]: levels(foreign) },
    },
    { name: "empty specs", specs: [], expected: undefined },
  ];
  test.each(cases)("$name", ({ specs, expected }) => {
    const before = structuredClone(efforts);
    const frozen = Object.freeze([...specs]);
    expect(effortClarification(frozen, efforts)).toEqual(expected);
    expect(efforts).toEqual(before);
    expect(frozen).toEqual(specs);
  });

  test("an injected empty map never consults the disk sidecar", () => {
    expect(effortClarification([foreign], {})).toBeUndefined();
  });

  test("returned rows do not alias the injected cells", () => {
    const copy = structuredClone(efforts);
    const result = effortClarification([foreign], copy)!;
    const task = Object.keys(result[foreign])[0];
    result[foreign][task] = "changed by caller";
    expect(copy[foreign][task].effort).toBe(efforts[foreign][task].effort);
  });
});
