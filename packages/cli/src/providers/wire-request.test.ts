import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiskCacheV3 } from "./all-models-cache.js";
import { resolveConnection } from "./connection-resolver.js";
import type { KnownWire } from "./connection-wire.js";
import {
  clampEffort,
  deletePointer,
  mergeWireHeaders,
  recoverBorrowedWireFields,
  setPointer,
  shapeRequestFromWire,
  stripWireDecisions,
  wireChoicesFromClaudeRequest,
} from "./wire-request.js";
const cachePath = new URL(
  "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
  import.meta.url
).pathname;
function connection(provider = "openai", model = "gpt-6.1-sol", path = cachePath) {
  const r = resolveConnection(provider, model, path);
  if (!r.ok || r.connection.wire.status !== "known") throw new Error("missing fixture wire");
  return { ...r.connection, wire: structuredClone(r.connection.wire) };
}
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
// Negative fixtures change one property of an actual published wire and are
// round-tripped through a temporary cache, never assembled as invented rows.
function changedWire(provider: string, model: string, change: (wire: KnownWire) => void) {
  const selected = connection(provider, model);
  const cache: DiskCacheV3 = JSON.parse(readFileSync(cachePath, "utf8"));
  const entry = cache.entries.find((e) => e.modelId === selected.modelId)!;
  const published = entry.aggregators!.find(
    (c) =>
      c.route?.routeId === selected.route.routeId &&
      c.route?.routeProfileId === selected.route.routeProfileId &&
      c.externalModelId === selected.externalModelId
  )!;
  if (published.wire?.status !== "known") throw new Error("missing known wire");
  change(published.wire);
  const dir = mkdtempSync(join(tmpdir(), "wire-request-"));
  tempDirs.push(dir);
  const path = join(dir, "catalog.json");
  writeFileSync(path, JSON.stringify(cache));
  return connection(provider, model, path);
}
test("JSON pointers create objects, overwrite non-objects and decode escapes", () => {
  const body: Record<string, unknown> = { a: 3 };
  setPointer(body, "/a/~0/~1/~01", 7);
  expect(body).toEqual({ a: { "~": { "/": { "~1": 7 } } } });
  deletePointer(body, "/a/~0/~1/~01");
  expect(body).toEqual({});
});
test.each([{ value: null }, { value: [] }, { value: "scalar" }])(
  "overwrites intermediate %j",
  ({ value }) => {
    const body: Record<string, unknown> = { a: value };
    setPointer(body, "/a/b/c", true);
    expect(body).toEqual({ a: { b: { c: true } } });
  }
);
test("delete preserves nonempty parents and ignores absent paths", () => {
  const body: Record<string, unknown> = { a: { keep: 1, drop: 2 } };
  deletePointer(body, "/a/drop");
  deletePointer(body, "/missing/x");
  expect(body).toEqual({ a: { keep: 1 } });
  expect(() => setPointer(body, "", 1)).toThrow("root");
  expect(() => setPointer(body, "invalid", 1)).toThrow("invalid JSON pointer");
});
test("strips every decision while preserving structured output and unrelated fields", () => {
  const body: Record<string, unknown> = {
    max_tokens: 1,
    max_completion_tokens: 2,
    max_output_tokens: 3,
    reasoning_effort: "high",
    reasoning: {},
    thinking: {},
    enable_thinking: true,
    thinking_budget: 5,
    include_reasoning: true,
    output_config: { effort: "high", format: { type: "json_schema" } },
    text: { verbosity: "high" },
    generationConfig: { thinkingConfig: {}, maxOutputTokens: 42 },
    service_tier: "priority",
    speed: "fast",
    messages: [],
  };
  stripWireDecisions(body, "responses");
  expect(body).toEqual({
    output_config: { format: { type: "json_schema" } },
    generationConfig: { maxOutputTokens: 42 },
    messages: [],
  });
});
test.each([
  ["high", ["low", "high"], "high"],
  ["minimal", ["low", "high"], "low"],
  ["medium", ["low", "high"], "high"],
  ["mystery", ["low"], undefined],
  ["mystery", ["mystery"], "mystery"],
  ["high", [], undefined],
] as const)("clamps %s against %j", (value, values, expected) =>
  expect(clampEffort(value, [...values])).toBe(expected)
);
test("pinned effort wins over output config and budget", () =>
  expect(
    wireChoicesFromClaudeRequest(
      {
        output_config: { effort: "low" },
        thinking: { budget_tokens: 1 },
        tools: [{}],
        max_tokens: 12,
      },
      "high"
    )
  ).toEqual({ effort: "high", reasoningOff: false, hasTools: true, maxTokens: 12 }));
test("output config wins over legacy budget", () =>
  expect(
    wireChoicesFromClaudeRequest({
      output_config: { effort: "HIGH" },
      thinking: { budget_tokens: 1 },
    }).effort
  ).toBe("high"));
test.each([
  [0, undefined],
  [1, "low"],
  [3999, "low"],
  [4000, "medium"],
  [15999, "medium"],
  [16000, "high"],
  [31999, "high"],
  [32000, "xhigh"],
] as const)("budget %s maps to %s", (budget, effort) => {
  const result = wireChoicesFromClaudeRequest({ thinking: { budget_tokens: budget } });
  expect(result.effort).toBe(effort);
  expect(result.reasoningOff).toBe(budget === 0);
});
test.each([
  ["fast", { value: "fast", explicit: false }],
  ["standard", undefined],
  [undefined, undefined],
] as const)("Claude Code speed %s maps to a non-explicit choice %j", (speed, expected) =>
  expect(wireChoicesFromClaudeRequest({ speed }).speed).toEqual(expected)
);
test.each([{ thinking: { type: "disabled" } }, { output_config: { effort: "none" } }])(
  "off intent %j",
  (request) =>
    expect(wireChoicesFromClaudeRequest(request)).toMatchObject({
      reasoningOff: true,
      effort: undefined,
    })
);
test("tools requiring Responses drop reasoning", () => {
  const { wire } = changedWire("openrouter", "gpt-6.1-sol", (wire) => {
    wire.toolsWithReasoning = "requires-responses";
  });
  const body: Record<string, unknown> = { reasoning: { effort: "high" } };
  shapeRequestFromWire(body, wire, { hasTools: true, effort: "high" });
  expect(body).toEqual({});
});
test.each([true, false])("tools requiring effort none (published=%s)", (published) => {
  const { wire } = changedWire("openrouter", published ? "gpt-5.5" : "gpt-6.1-sol", (wire) => {
    wire.toolsWithReasoning = "requires-effort-none";
  });
  const body: any = {};
  const result = shapeRequestFromWire(body, wire, { hasTools: true, effort: "high" });
  expect(body.reasoning).toEqual(published ? { enabled: true, effort: "none" } : { enabled: true });
  expect(result.sentEffort).toBe(published ? "none" : undefined);
});
test("not applicable disable keeps enable and least effort with a note", () => {
  const body = {};
  const result = shapeRequestFromWire(body, connection("openrouter", "gpt-6.1-sol").wire, {
    reasoningOff: true,
  });
  expect(body).toEqual({ reasoning: { enabled: true, effort: "low" } });
  expect(result.notes.join(" ")).toContain("disable not_applicable");
});
test.each([false, true])("served-model warning accepted=%s", (accepted) => {
  const body = {};
  const result = shapeRequestFromWire(body, connection("kimi-coding", "k3").wire, {
    reasoningOff: true,
    acceptServedModelChange: accepted,
  });
  expect(body).toEqual({ reasoning_effort: accepted ? "none" : "low" });
  expect(result.notes.join(" ")).toContain("served_model_changes");
});
test.each([true, false])("unoffered explicit=%s controls", (explicit) => {
  const body = {};
  const result = shapeRequestFromWire(body, connection("x-ai", "grok-4.7").wire, {
    speed: { value: "fast", explicit },
  });
  expect(result.refusal !== undefined).toBe(explicit);
  expect(result.refusal ?? result.notes.join(" ")).toContain("standard, priority");
  expect(body).not.toHaveProperty("service_tier");
  const mode = shapeRequestFromWire({}, connection("openrouter", "gpt-5.5").wire, {
    mode: { value: "pro", explicit },
  });
  expect(mode.refusal !== undefined).toBe(explicit);
  if (!explicit) expect(mode.notes.join(" ")).toContain("mode");
});
test("standard with no explicit standard value omits the control", () => {
  const body = {};
  const result = shapeRequestFromWire(body, connection("openrouter", "gpt-5.5").wire, {
    speed: { value: "standard", explicit: true },
  });
  expect(result.refusal).toBeUndefined();
  expect(body).not.toHaveProperty("service_tier");
  expect(result.notes.join(" ")).toContain("field omitted");
});
test("unknown fields borrow only same-API owner token and reasoning pointers", () => {
  const c = connection("opencode-zen", "minimax-m3");
  expect(c.ownerWire?.api).toBe("chat-completions");
  expect(c.ownerWire?.tokenParam).toBe("max_completion_tokens");
  const body = {};
  const result = shapeRequestFromWire(
    body,
    c.wire,
    { maxTokens: 32000, effort: "high" },
    c.ownerWire
  );
  expect(body).toEqual({ max_completion_tokens: 32000, thinking: { type: "adaptive" } });
  expect(result.borrowed).toEqual(["/max_completion_tokens", "/thinking/type"]);
});
test("different API owner cannot lend any fields", () => {
  const c = connection("opencode-zen", "minimax-m3");
  const body = {};
  const result = shapeRequestFromWire(
    body,
    c.wire,
    { maxTokens: 32000, effort: "high" },
    connection().wire
  );
  expect(body).toEqual({});
  expect(result.borrowed).toEqual([]);
});
test("mode and speed are never borrowed", () => {
  const c = connection("opencode-zen", "gpt-5.5");
  const owner = connection().wire;
  const body = {};
  const result = shapeRequestFromWire(
    body,
    c.wire,
    { mode: { value: "pro", explicit: true }, speed: { value: "fast", explicit: true } },
    owner
  );
  expect(body).not.toHaveProperty("service_tier");
  expect(body).not.toHaveProperty("reasoning.mode");
  expect(result.borrowed).toEqual(["/reasoning/effort"]);
  expect(result.refusal).toBeDefined();
});
test.each([
  ["Unsupported parameter: max_tokens", { reasoning: { effort: "high" }, keep: true }],
  ["Unknown parameter", { keep: true }],
] as const)("recovery drops borrowed fields for %s without mutation", (error, expected) => {
  const body = { max_tokens: 42, reasoning: { effort: "high" }, keep: true };
  const original = structuredClone(body);
  expect(
    recoverBorrowedWireFields(body, ["/max_tokens", "/reasoning/effort"], error)?.payload
  ).toEqual(expected);
  expect(body).toEqual(original);
});
test("recovery declines unrelated errors and empty borrowed list", () => {
  expect(
    recoverBorrowedWireFields({ reasoning_effort: "high" }, ["/reasoning_effort"], "quota exceeded")
  ).toBeNull();
  expect(recoverBorrowedWireFields({ x: 1 }, [], "Unknown parameter x")).toBeNull();
});
test("wire headers append case-insensitively without duplicate tokens", () => {
  const headers = { "Anthropic-Beta": "oauth, fast" };
  mergeWireHeaders(headers, [
    { name: "anthropic-beta", value: "fast", merge: "append-comma" },
    { name: "ANTHROPIC-BETA", value: "new", merge: "append-comma" },
  ]);
  expect(headers).toEqual({ "Anthropic-Beta": "oauth, fast,new" });
});
const cases = [
  {
    provider: "openai",
    model: "gpt-6.1-sol",
    url: "https://api.openai.com/v1/responses",
    expected: {
      max_output_tokens: 32000,
      reasoning: {
        effort: "high",
      },
    },
    absent: ["store", "include", "text", "reasoning_effort"],
    opts: {},
    req: {},
  },
  {
    provider: "openai",
    model: "gpt-6.1-sol",
    url: "https://api.openai.com/v1/responses",
    expected: {
      max_output_tokens: 32000,
      reasoning: {
        effort: "high",
        mode: "pro",
      },
      service_tier: "priority",
    },
    absent: ["store", "include", "text", "reasoning_effort"],
    opts: {
      wireMode: "pro",
      wireSpeed: "fast",
    },
    req: {},
  },
  {
    provider: "openai",
    model: "gpt-6.1-sol",
    url: "https://api.openai.com/v1/responses",
    expected: {
      reasoning: {
        effort: "low",
      },
      max_output_tokens: 32000,
    },
    absent: ["reasoning_effort"],
    opts: {},
    req: {
      output_config: {
        effort: "minimal",
      },
    },
  },
  {
    provider: "openrouter",
    model: "openai/gpt-6.1-sol",
    url: "https://openrouter.ai/api/v1/chat/completions",
    expected: {
      max_tokens: 32000,
      reasoning: {
        enabled: true,
        effort: "high",
      },
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "opencode-zen-go",
    model: "grok-4.7",
    url: "https://opencode.ai/zen/go/v1/responses",
    expected: {
      max_output_tokens: 32000,
      reasoning: {
        effort: "high",
      },
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "opencode-zen-go",
    model: "minimax-m3",
    url: "https://opencode.ai/zen/go/v1/messages",
    expected: {
      max_tokens: 32000,
    },
    absent: ["thinking"],
    opts: {},
    req: {},
  },
  {
    provider: "opencode-zen",
    model: "minimax-m3",
    url: "https://opencode.ai/zen/v1/chat/completions",
    expected: {
      max_completion_tokens: 32000,
      thinking: {
        type: "adaptive",
      },
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "z-ai",
    model: "glm-5.3",
    url: "https://api.z.ai/api/paas/v4/chat/completions",
    expected: {
      max_tokens: 32000,
      thinking: {
        type: "enabled",
      },
      reasoning_effort: "high",
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "kimi-coding",
    model: "k3",
    url: "https://api.kimi.ai/coding/v1/chat/completions",
    expected: {
      max_completion_tokens: 32000,
      reasoning_effort: "low",
    },
    absent: [],
    opts: {},
    req: {
      thinking: {
        type: "disabled",
      },
      output_config: null,
    },
  },
  {
    provider: "ollamacloud",
    model: "kimi-k3",
    url: "https://ollama.com/v1/chat/completions",
    expected: {
      max_tokens: 32000,
      reasoning_effort: "high",
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "qwen-token-plan",
    model: "qwen3.7-plus",
    url: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/chat/completions",
    expected: {
      max_completion_tokens: 32000,
      enable_thinking: true,
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "fireworks",
    model: "accounts/fireworks/models/qwen3p8-max",
    url: "https://api.fireworks.ai/inference/v1/chat/completions",
    expected: {
      max_tokens: 32000,
    },
    absent: ["reasoning", "reasoning_effort", "thinking", "enable_thinking"],
    opts: {},
    req: {},
  },
  {
    provider: "google",
    model: "gemini-3.8-flash",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    expected: {
      "generationConfig.maxOutputTokens": 32000,
    },
    absent: ["generationConfig.thinkingConfig", "thinkingConfig"],
    opts: {},
    req: {},
  },
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    url: "https://api.anthropic.com/v1/messages",
    expected: {
      max_tokens: 32000,
      "output_config.effort": "high",
      speed: "fast",
    },
    absent: ["thinking"],
    opts: {
      wireSpeed: "fast",
    },
    req: {},
  },
];

for (const [index, tc] of cases.entries())
  test(`fixture decisions ${index}: ${tc.provider}@${tc.model}`, () => {
    const c = connection(tc.provider, tc.model);
    const body: Record<string, unknown> =
      c.wire.api === "gemini"
        ? { generationConfig: { maxOutputTokens: 32000, thinkingConfig: {} } }
        : {};
    const choices = wireChoicesFromClaudeRequest({
      max_tokens: 32000,
      tools: [{}],
      output_config: { effort: "high" },
      ...tc.req,
    });
    shapeRequestFromWire(
      body,
      c.wire,
      {
        ...choices,
        ...(tc.opts.wireMode ? { mode: { value: "pro", explicit: true } as const } : {}),
        ...(tc.opts.wireSpeed ? { speed: { value: "fast", explicit: true } as const } : {}),
      },
      c.ownerWire
    );
    for (const [key, value] of Object.entries(tc.expected)) expect(body).toHaveProperty(key, value);
    for (const key of tc.absent) expect(body).not.toHaveProperty(key);
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
      if (!(key in tc.expected)) expect(body).not.toHaveProperty(key);
  });

test("recovery does not mistake a pointer token substring for a named field", () => {
  expect(recoverBorrowedWireFields({ x: 1 }, ["/x"], "quota exceeded")).toBeNull();
});

test("recovery preserves an unborrowed field even when the error names it too", () => {
  expect(
    recoverBorrowedWireFields(
      { max_tokens: 42, speed: "fast" },
      ["/max_tokens"],
      "Unknown parameters: max_tokens, speed"
    )?.payload
  ).toEqual({ speed: "fast" });
});
test("headers are created when no prior header exists", () => {
  const headers = {};
  mergeWireHeaders(headers, [
    { name: "anthropic-beta", value: "fast-mode-2026-02-01", merge: "append-comma" },
  ]);
  expect(headers).toEqual({ "anthropic-beta": "fast-mode-2026-02-01" });
});

test("not-applicable token limit cannot borrow the owner's parameter", () => {
  const c = changedWire("opencode-zen", "minimax-m3", (wire) => {
    wire.tokenParam = { status: "not_applicable" };
  });
  const body = {};
  const result = shapeRequestFromWire(body, c.wire, { maxTokens: 32000 }, c.ownerWire);
  expect(body).not.toHaveProperty("max_completion_tokens");
  expect(result.borrowed).toEqual(["/thinking/type"]);
});
