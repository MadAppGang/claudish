import { afterEach, describe, expect, test } from "bun:test";
import { VERSION } from "../version.js";
import { _setBundledListRawForTest } from "./bundled-list-data.js";
import {
  type ProviderResolution,
  type RouteRefusal,
  getMissingKeyError,
} from "./provider-resolver.js";

const GENERATION = "g-20990101000000000-testtest";

function refusalFor(name: string, refusal: Partial<RouteRefusal>): ProviderResolution {
  return {
    fullModelId: name,
    routeRefusal: {
      cause: "no-credential",
      reason: "no route",
      catalogSource: "bundled",
      reachability: { state: "unreachable", reason: "fetch-failed" },
      dropped: [],
      ...refusal,
    } as RouteRefusal,
  } as unknown as ProviderResolution;
}

describe("launch error for a bare name refused with the bundled recommended list", () => {
  afterEach(() => _setBundledListRawForTest(undefined));

  test("a bundled list that left no usable hop names the list's release and generation", () => {
    _setBundledListRawForTest({
      catalogGenerationId: GENERATION,
      bundle: { fetchedAt: "2099-01-01T00:00:00Z" },
    });
    const message = getMissingKeyError(
      refusalFor("gpt-6.1-sol", { dropped: [{ displayName: "OpenAI", outcome: "no-credential" }] })
    );
    expect(message).toContain("from the bundled recommended list");
    expect(message).toContain(`claudish ${VERSION}, generation ${GENERATION}`);
  });

  test("a name outside the bundled list names the list's release and generation", () => {
    _setBundledListRawForTest({
      catalogGenerationId: GENERATION,
      bundle: { fetchedAt: "2099-01-01T00:00:00Z" },
    });
    const message = getMissingKeyError(
      refusalFor("mistral-large-3", { cause: "catalog-unreadable" })
    );
    expect(message).toContain("not in the bundled recommended list");
    expect(message).toContain(`claudish ${VERSION}, generation ${GENERATION}`);
  });
});
