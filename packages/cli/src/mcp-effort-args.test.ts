import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { effortArg, modelEffortsArg } from "./mcp-server.js";

const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const capture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "test-fixtures/effort-recommendations/recommended-2.3.0.json"),
    "utf8"
  )
) as { data: { recommendations: { efforts: Record<string, unknown> } } };
const capturedModels = Object.keys(capture.data.recommendations.efforts);
const models = capturedModels.slice(0, 2);

describe("effortArg", () => {
  test.each([undefined, null, "", "default"].map((value) => ({ value })))(
    "treats $value as absent",
    ({ value }) => {
      expect(effortArg(value)).toBeUndefined();
    }
  );

  test.each([...LEVELS])("returns the canonical level %s unchanged", (level) => {
    expect(effortArg(level)).toBe(level);
  });

  test.each(["High", "ultra", 3].map((value) => ({ value })))(
    "rejects $value and names every valid level",
    ({ value }) => {
      expect(() => effortArg(value)).toThrow(LEVELS.join(", "));
      expect(() => effortArg(value)).toThrow("Invalid 'effort'");
      expect(() => effortArg(value)).toThrow('"default"');
    }
  );
});

describe("modelEffortsArg", () => {
  test.each([undefined, null, {}].map((value) => ({ value })))(
    "treats absent or empty efforts $value as undefined",
    ({ value }) => {
      expect(modelEffortsArg(value, models)).toBeUndefined();
    }
  );

  test("returns a valid per-model map without mutating the caller's input", () => {
    const value = Object.freeze({ [models[0]]: "high", [models[1]]: "minimal" });
    const beforeModels = [...models];
    expect(modelEffortsArg(value, models)).toEqual(value);
    expect(value).toEqual({ [models[0]]: "high", [models[1]]: "minimal" });
    expect(models).toEqual(beforeModels);
  });

  test("permits a partial map without filling in the other model", () => {
    expect(modelEffortsArg({ [models[1]]: "max" }, models)).toEqual({
      [models[1]]: "max",
    });
  });

  test.each([...LEVELS])("accepts the canonical level %s in a map", (level) => {
    expect(modelEffortsArg({ [models[0]]: level }, models)).toEqual({
      [models[0]]: level,
    });
  });

  test.each([capturedModels[2], `or@${models[0]}`])(
    "rejects a key %s that is not an exact models entry and names the allowed keys",
    (key) => {
      const call = () => modelEffortsArg({ [key]: "high" }, models);
      expect(call).toThrow(key);
      expect(call).toThrow(models.join(", "));
      expect(call).toThrow("Keys must match a 'models' entry exactly");
    }
  );

  test.each(["High", "ultra", 3, undefined, null, ""].map((level) => ({ level })))(
    "rejects invalid map level $level, naming the model and every valid level",
    ({ level }) => {
      const call = () => modelEffortsArg({ [models[0]]: level }, models);
      expect(call).toThrow(models[0]);
      expect(call).toThrow(LEVELS.join(", "));
    }
  );

  test.each([[], ["high"], "high"].map((value) => ({ value })))(
    "rejects non-object efforts $value",
    ({ value }) => {
      expect(() => modelEffortsArg(value, models)).toThrow("expected an object");
    }
  );
});
