import { expect, test } from "bun:test";
import { projectRecommendations } from "./model-loader.js";
import type { DiskCacheV3 } from "./providers/all-models-cache.js";
import {
  nativeShortcutForVendor,
  renderRecommendedMarkdown,
  renderRecommendedText,
} from "./recommended-listing.js";
import museCatalog from "./test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json";

// MTL-189 follow-up: D — Access lists only published routes and wire ids (generation g-20261021063612126-17350b71).
const data = museCatalog as DiskCacheV3;
const plan = data.plans[0]!;

function listing(modelId: string) {
  return projectRecommendations(
    {
      contractVersion: plan.contractVersion!,
      generationId: data.catalogGenerationId,
      entries: [{ modelId, tier: "subscription", route: plan.route, planId: plan.id }],
    },
    data,
    [],
    new Date(data.lastUpdated)
  );
}

function access(modelId: string): string {
  return renderRecommendedMarkdown(listing(modelId), nativeShortcutForVendor)
    .split("\n")
    .find((line) => line.startsWith("- **Access**:"))!;
}

test("Wonder Full has no metered Meta connection in the real data", () => {
  const model = data.entries.find((entry) => entry.modelId === "muse-wonder-full")!;
  expect(
    model.aggregators!.every((row) => row.route?.routeProfileId === plan.route!.routeProfileId)
  ).toBe(true);
  expect(listing(model.modelId).models[0]!.subscription!.command).toBe("muse@muse-wonder-full-1.0");
});

test("Wonder Full Access does not offer the unserved meta@ route", () => {
  expect(access("muse-wonder-full")).not.toContain("`meta@muse-wonder-full`");
});

test("Wonder Full Access offers the muse@ subscription shortcut", () => {
  expect(access("muse-wonder-full")).toContain("`muse@muse-wonder-full`");
});

test("Wonder Full text lists muse@ without the unserved meta@ route", () => {
  const text = renderRecommendedText(listing("muse-wonder-full"), nativeShortcutForVendor);
  const via = text.split("\n").find((line) => line.includes("via:"))!;
  expect(via).toContain("muse@");
  expect(via).not.toContain("meta@");
});

test("Spark retains meta@ where the native API publishes a connection", () => {
  const model = data.entries.find((entry) => entry.modelId === "muse-spark-1.3")!;
  expect(model.aggregators).toContainEqual(
    expect.objectContaining({ route: { routeId: "meta", routeProfileId: "direct-api" } })
  );
  expect(access(model.modelId)).toContain("`meta@muse-spark-1.3`");
  expect(access(model.modelId)).toContain("`muse@muse-spark-1.3`");
  const text = renderRecommendedText(listing(model.modelId), nativeShortcutForVendor);
  const via = text.split("\n").find((line) => line.includes("via:"))!;
  expect(via).toContain("meta@");
  expect(via).toContain("muse@");
});
