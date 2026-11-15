import { expect, test } from "bun:test";
import { compactionStartupSettings } from "./config.js";

const invalidBlocks: unknown[] = [
  { enabled: "true" },
  { enabled: true, toolOutputs: { minTokens: 0 } },
  { history: { precomputeAt: 0.9, applyAt: 0.8 } },
];

test("an invalid compaction block warns once even when compaction is not enabled", () => {
  for (const block of invalidBlocks) {
    for (const enabled of [false, true]) {
      const warnings: string[] = [];
      const settings = compactionStartupSettings({ compaction: block } as never, enabled, (m) =>
        warnings.push(m)
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toStartWith("[compaction] compaction");
      expect(settings.enabled).toBe(enabled);
    }
  }
});

test("a valid or absent block says nothing", () => {
  for (const block of [undefined, {}, { enabled: true, model: "haiku" }]) {
    const warnings: string[] = [];
    compactionStartupSettings({ compaction: block } as never, false, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  }
});
