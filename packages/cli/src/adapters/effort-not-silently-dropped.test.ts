/**
 * Structural guard against model/version gates that silently discard Claude
 * Code's requested reasoning effort when a provider ships a new model.
 */

import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DiskCacheV3 } from "../providers/all-models-cache.js";
import { shapeRequestFromWire } from "../providers/wire-request.js";
import { DeepSeekModelDialect } from "./deepseek-model-dialect.js";
import { resetReasoningEffortMemo } from "./grok-effort-support.js";
import { GrokModelDialect } from "./grok-model-dialect.js";

beforeEach(() => {
  resetReasoningEffortMemo();
});

const fixture: DiskCacheV3 = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json", import.meta.url),
    "utf8"
  )
);

test("every published effort-controlled connection emits its wire effort field", () => {
  let checked = 0;
  for (const entry of fixture.entries) {
    for (const connection of entry.aggregators ?? []) {
      const wire = connection.wire;
      if (
        wire?.status !== "known" ||
        wire.reasoning.status !== "supported" ||
        !("path" in wire.reasoning.effort)
      )
        continue;
      const body: Record<string, unknown> = {};
      const shaped = shapeRequestFromWire(body, wire, { effort: "high", hasTools: false });
      const label = `${entry.modelId} ${connection.route?.routeId}/${connection.route?.routeProfileId}`;
      expect(shaped.sentEffort, label).toBeDefined();
      const path = wire.reasoning.effort.path
        .split("/")
        .slice(1)
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      let emitted: unknown = body;
      for (const part of path) emitted = (emitted as Record<string, unknown> | undefined)?.[part];
      expect(emitted, label).toBeDefined();
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test("future Grok and DeepSeek model-name fallbacks are rules, not version pins", () => {
  const highEffort = { output_config: { effort: "high" } };

  const futureGrok = new GrokModelDialect("grok-9-experimental").prepareRequest(
    { messages: [] },
    highEffort
  );
  expect(futureGrok.reasoning_effort).toBeDefined();

  for (const modelId of ["deepseek-v5", "deepseek-v9-reasoner"]) {
    const result = new DeepSeekModelDialect(modelId).prepareRequest({ messages: [] }, highEffort);
    expect(result.reasoning_effort).toBeDefined();
  }

  for (const modelId of ["deepseek-v3.2", "deepseek-r1"]) {
    const result = new DeepSeekModelDialect(modelId).prepareRequest({ messages: [] }, highEffort);
    expect(result.reasoning_effort).toBeUndefined();
  }
});
