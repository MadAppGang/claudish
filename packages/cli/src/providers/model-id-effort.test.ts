import { describe, expect, test } from "bun:test";
import { chooseModelIdForEffort, publishedEffortWireId } from "./model-id-effort.js";
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

describe("chooseModelIdForEffort", () => {
  const sendableAll = { sendable: (id: string) => id };

  test("does not choose an opt-in id for an effort level", () => {
    const map = effortMap({ low: "example-model-contributor" });

    expect(chooseModelIdForEffort(map, "low", sendableAll)).toBeUndefined();
  });

  test("does not choose an opt-in off id for none", () => {
    const map = effortMap({}, { off: "example-model-contributor" });

    expect(chooseModelIdForEffort(map, "none", sendableAll)).toBeUndefined();
  });
});
