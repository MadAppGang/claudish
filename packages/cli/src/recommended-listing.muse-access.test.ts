import { expect, test } from "bun:test";
import { projectRecommendations } from "./model-loader.js";
import type { DiskCacheV3 } from "./providers/all-models-cache.js";
import {
  nativeShortcutForVendor,
  renderRecommendedMarkdown,
  renderRecommendedText,
} from "./recommended-listing.js";
import museCatalog from "./test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json";

// MTL-189 follow-up: CLI access lists published routes; MCP markdown names no provider.
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

function expectProviderFreeMarkdown(modelId: string): void {
  const markdown = renderRecommendedMarkdown(listing(modelId));
  expect(markdown).toContain(modelId);
  expect(markdown).not.toContain("**Access**");
  expect(markdown).not.toContain("meta@");
  expect(markdown).not.toContain("muse@");
  expect(markdown).not.toContain("@");
}

test("Wonder Full has no metered Meta connection in the real data", () => {
  const model = data.entries.find((entry) => entry.modelId === "muse-wonder-full")!;
  expect(
    model.aggregators!.every((row) => row.route?.routeProfileId === plan.route!.routeProfileId)
  ).toBe(true);
  expect(listing(model.modelId).models[0]!.subscription!.command).toBe("muse@muse-wonder-full-1.0");
});

test("Wonder Full markdown names no provider for its base model", () => {
  expectProviderFreeMarkdown("muse-wonder-full");
});

test("Wonder Full markdown omits the subscription command's provider", () => {
  const modelId = data.entries.find((entry) => entry.modelId === "muse-wonder-full")!.modelId;
  expectProviderFreeMarkdown(modelId);
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
  expectProviderFreeMarkdown(model.modelId);
  const text = renderRecommendedText(listing(model.modelId), nativeShortcutForVendor);
  const via = text.split("\n").find((line) => line.includes("via:"))!;
  expect(via).toContain("meta@");
  expect(via).toContain("muse@");
});
