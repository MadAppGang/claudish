import { describe, expect, test } from "bun:test";
import { publishedEffortWireId } from "./model-id-effort.js";
import { effortMap } from "./test-helpers/model-id-effort.js";

describe("publishedEffortWireId", () => {
  test("rejects an ambiguous case-insensitive match but keeps exact spellings", () => {
    const connection = {
      modelIdEffort: effortMap({
        low: "Example-Model-Low",
        high: "example-model-low",
      }),
    };

    expect(publishedEffortWireId(connection, "EXAMPLE-MODEL-LOW")).toBeUndefined();
    expect(publishedEffortWireId(connection, "example-model-low")).toBe("example-model-low");
    expect(publishedEffortWireId(connection, "Example-Model-Low")).toBe("Example-Model-Low");
  });
});
