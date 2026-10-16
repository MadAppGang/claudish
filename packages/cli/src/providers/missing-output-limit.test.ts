import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makePaneTestEnv } from "../pane/test-helpers/hermetic-env.js";
import type { DiskCacheV3 } from "./all-models-cache.js";
import type { KnownWire } from "./connection-wire.js";
import { shapeRequestFromWire, wireChoicesFromClaudeRequest } from "./wire-request.js";

const fixturePath = new URL(
  "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
  import.meta.url
).pathname;
const fixture: DiskCacheV3 = JSON.parse(readFileSync(fixturePath, "utf8"));
// Reuse a real request message and published wires; do not invent catalog records.
const userMessage = readFileSync(
  new URL("../pane/test-fixtures/transcripts/pear-hookless.jsonl", import.meta.url),
  "utf8"
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((record) => record.type === "user").message;

function published(api: KnownWire["api"], hasCeiling: boolean) {
  for (const entry of fixture.entries) {
    if ((typeof entry.maxOutputTokens === "number" && entry.maxOutputTokens > 0) !== hasCeiling)
      continue;
    const connection = entry.aggregators?.find(
      (candidate) =>
        candidate.routeStatus === "mapped" &&
        candidate.wire?.status === "known" &&
        candidate.wire.api === api
    );
    if (connection?.wire?.status === "known") return { entry, wire: connection.wire };
  }
  throw new Error(`Missing captured ${api} wire (ceiling=${hasCeiling})`);
}

function request() {
  return { messages: [structuredClone(userMessage)] };
}

function expectNoOutputLimit(body: Record<string, unknown>): void {
  for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
    expect(body).not.toHaveProperty(field);
  expect(body).not.toHaveProperty("generationConfig.maxOutputTokens");
}

describe("missing output limits follow the published wire contract", () => {
  test("anthropic-messages fills a missing max_tokens with the positive catalog ceiling", () => {
    const { entry, wire } = published("anthropic-messages", true);
    const inbound = request();
    const body: Record<string, unknown> = structuredClone(inbound);
    expect(entry.maxOutputTokens).toBeGreaterThan(4096);
    const result = shapeRequestFromWire(body, wire, {
      ...wireChoicesFromClaudeRequest(inbound),
      catalogMaxOutputTokens: entry.maxOutputTokens,
    });
    expect(result.refusal).toBeUndefined();
    expect(body.max_tokens).toBe(entry.maxOutputTokens);
    expect(body.messages).toEqual(inbound.messages);
    expect(inbound).not.toHaveProperty("max_tokens");
  });

  test("anthropic-messages with no catalog ceiling omits max_tokens and reports none sent", () => {
    const { entry, wire } = published("anthropic-messages", false);
    const inbound = request();
    const body: Record<string, unknown> = structuredClone(inbound);
    const result = shapeRequestFromWire(body, wire, {
      ...wireChoicesFromClaudeRequest(inbound),
      catalogMaxOutputTokens: entry.maxOutputTokens,
    });
    expect(result.refusal).toBeUndefined();
    expectNoOutputLimit(body);
    expect(result.notes.join(" ")).toContain("none sent");
  });

  test("anthropic-messages keeps inbound max_tokens unchanged instead of the catalog ceiling", () => {
    const { entry, wire } = published("anthropic-messages", true);
    const inbound = { ...request(), max_tokens: 8193 };
    const body: Record<string, unknown> = structuredClone(inbound);
    const result = shapeRequestFromWire(body, wire, {
      ...wireChoicesFromClaudeRequest(inbound),
      catalogMaxOutputTokens: entry.maxOutputTokens,
    });
    expect(result.refusal).toBeUndefined();
    expect(body.max_tokens).toBe(inbound.max_tokens);
  });

  for (const api of ["chat-completions", "responses"] as const) {
    test(`${api} without an inbound limit emits no output-limit field despite a catalog ceiling`, () => {
      const { entry, wire } = published(api, true);
      const inbound = request();
      const body: Record<string, unknown> = structuredClone(inbound);
      const result = shapeRequestFromWire(body, wire, {
        ...wireChoicesFromClaudeRequest(inbound),
        catalogMaxOutputTokens: entry.maxOutputTokens,
      });
      expect(result.refusal).toBeUndefined();
      expectNoOutputLimit(body);
    });
  }
});

describe("AnthropicAPIFormat without an inbound max_tokens", () => {
  test("uses the captured ceiling or omits the field, never inserts 4096", () => {
    const withCeiling = published("anthropic-messages", true).entry;
    const withoutCeiling = published("anthropic-messages", false).entry;
    // Import the adapter only inside a child whose HOME is already hermetic:
    // its normal metadata lookup reads the captured cloud models catalog on disk.
    const env = makePaneTestEnv();
    try {
      const script = `
        import { readFileSync } from "node:fs";
        import { writeAllModelsCache } from ${JSON.stringify(new URL("./all-models-cache.ts", import.meta.url).pathname)};
        import { AnthropicAPIFormat } from ${JSON.stringify(new URL("../adapters/anthropic-api-format.ts", import.meta.url).pathname)};
        writeAllModelsCache(JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, "utf8")));
        const request = ${JSON.stringify(request())};
        const payloads = ${JSON.stringify([withCeiling.modelId, withoutCeiling.modelId])}.map(model => {
          const adapter = new AnthropicAPIFormat(model);
          return adapter.buildPayload(request, adapter.convertMessages(request), adapter.convertTools(request));
        });
        console.log(JSON.stringify(payloads));
      `;
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: env.cwd,
        env: env.env,
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const payloads = JSON.parse(result.stdout.toString()) as Record<string, unknown>[];
      expect(payloads).toHaveLength(2);
      expect(payloads[0]?.max_tokens).toBe(withCeiling.maxOutputTokens);
      expectNoOutputLimit(payloads[1]!);
      for (const payload of payloads) expect(JSON.stringify(payload)).not.toContain("4096");
      expect(join(env.home, ".claudish")).not.toBe(join(process.env.HOME ?? "", ".claudish"));
    } finally {
      env.cleanup();
    }
  });
});
