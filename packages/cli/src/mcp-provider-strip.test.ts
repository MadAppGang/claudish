import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  stripUnrequestedProvider,
  strippedProviders,
  userRequiredProvidersArg,
} from "./mcp-server.js";

const capture = JSON.parse(
  readFileSync(
    new URL("./test-fixtures/catalog-v3/rows-g-20260919013346169.json", import.meta.url),
    "utf8"
  )
) as { entries: Array<{ modelId: string; aliases?: string[] }> };
const canonicalIds = new Set(capture.entries.map((entry) => entry.modelId));
const model = capture.entries[0].modelId;
const secondModel = capture.entries.at(-1)!.modelId;
const wireId = capture.entries[0].aliases!.find((id) => id === "k3")!;
const isCatalogModel = (id: string): boolean => canonicalIds.has(id);

describe("stripUnrequestedProvider with captured canonical model ids", () => {
  test("uses real canonical ids and a distinct captured wire id", () => {
    expect(model).toBe("kimi-k3");
    expect(canonicalIds.has(secondModel)).toBe(true);
    expect(wireId).toBe("k3");
    expect(canonicalIds.has(wireId)).toBe(false);
  });

  test.each([
    { name: "catalog model", spec: `kc@${model}`, required: false, expected: model },
    {
      name: "explicitly required provider",
      spec: `kc@${model}`,
      required: true,
      expected: `kc@${model}`,
    },
    {
      name: "non-canonical wire id",
      spec: `kc@${wireId}`,
      required: false,
      expected: `kc@${wireId}`,
    },
    { name: "Ollama", spec: `ollama@${model}`, required: false, expected: `ollama@${model}` },
    {
      name: "LM Studio",
      spec: `lmstudio@${model}`,
      required: false,
      expected: `lmstudio@${model}`,
    },
    {
      name: "HTTP endpoint",
      spec: `http://localhost:8000@${model}`,
      required: false,
      expected: `http://localhost:8000@${model}`,
    },
    {
      name: "HTTPS endpoint",
      spec: `https://endpoint.test/v1@${model}`,
      required: false,
      expected: `https://endpoint.test/v1@${model}`,
    },
    {
      name: "routing chain",
      spec: `kc@${model}+openrouter@${secondModel}`,
      required: false,
      expected: `kc@${model}+openrouter@${secondModel}`,
    },
    { name: "+pro marker", spec: `kc@${model}+pro`, required: false, expected: `${model}+pro` },
    { name: "#fast marker", spec: `kc@${model}#fast`, required: false, expected: `${model}#fast` },
    {
      name: "required markers",
      spec: `kc@${model}+pro#fast`,
      required: true,
      expected: `kc@${model}+pro#fast`,
    },
    { name: "bare name", spec: model, required: false, expected: model },
    {
      name: "bare name with marker",
      spec: `${model}+pro`,
      required: false,
      expected: `${model}+pro`,
    },
    { name: "legacy syntax", spec: `kc/${model}`, required: false, expected: `kc/${model}` },
    {
      name: "canonical id with different case",
      spec: `kc@${model.toUpperCase()}`,
      required: false,
      expected: `kc@${model.toUpperCase()}`,
    },
  ])("$name", ({ spec, required, expected }) => {
    expect(stripUnrequestedProvider(spec, required, isCatalogModel)).toBe(expected);
  });
});

describe("userRequiredProvidersArg", () => {
  const specs = [`kc@${model}`, `openrouter@${secondModel}`];

  for (const value of [undefined, null, []]) {
    test(`${JSON.stringify(value) ?? "undefined"} means no required provider`, () => {
      expect([...userRequiredProvidersArg(value, specs)]).toEqual([]);
    });
  }

  test("accepts exact model and judge specs and deduplicates them", () => {
    expect([...userRequiredProvidersArg([specs[1], specs[0], specs[1]], specs)]).toEqual([
      specs[1],
      specs[0],
    ]);
  });

  for (const value of [true, false, 1, "", specs[0], {}, [null], [1], [specs[0], false]]) {
    test(`rejects non-array/non-string input ${JSON.stringify(value)}`, () => {
      expect(() => userRequiredProvidersArg(value, specs)).toThrow(
        "Invalid 'user_required_provider': expected an array of model specs."
      );
    });
  }

  test("rejects an entry absent from models/judges and names the available specs", () => {
    expect(() => userRequiredProvidersArg([model], specs)).toThrow(
      `Invalid 'user_required_provider': ${JSON.stringify(model)} is not one of the models (${specs.join(", ")}). Entries must match a 'models' or 'judges' entry exactly.`
    );
  });
});

describe("strippedProviders", () => {
  test("returns stripped specs and ordered notes without mutating caller spellings", () => {
    const specs = [
      `kc@${model}+pro`,
      `ollama@${model}`,
      `openrouter@${secondModel}#fast`,
      `kc@${model}`,
      model,
      `kc@${model}+pro`,
    ];
    const original = [...specs];
    expect(strippedProviders(specs, new Set([`kc@${model}`]), isCatalogModel)).toEqual({
      specs: [`${model}+pro`, specs[1], `${secondModel}#fast`, specs[3], model, `${model}+pro`],
      stripped: [
        { from: specs[0], to: `${model}+pro` },
        { from: specs[2], to: `${secondModel}#fast` },
        { from: specs[5], to: `${model}+pro` },
      ],
    });
    expect(specs).toEqual(original);
  });

  test("all required specs stay unchanged with no note", () => {
    const specs = [`kc@${model}`, `openrouter@${secondModel}`];
    expect(strippedProviders(specs, new Set(specs), isCatalogModel)).toEqual({
      specs,
      stripped: [],
    });
  });

  test("empty input returns empty arrays", () => {
    expect(strippedProviders([], new Set(), isCatalogModel)).toEqual({ specs: [], stripped: [] });
  });
});
