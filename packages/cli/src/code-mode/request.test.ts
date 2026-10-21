import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CodexModelInfo } from "../providers/codex-models-discovery.js";
import { type ExecToolDefinition, renderExecTool } from "./exec-tool.js";
import { decideCodeMode } from "./policy.js";
import {
  CODE_MODE_NOTE,
  type CodeModePayloadContext,
  LITE_FALLBACK_TTL_MS,
  LITE_HEADER_NAME,
  applyCodeModeToPayload,
  isLiteFallbackActive,
  isLiteRejection,
  markLiteFallback,
  rebuildAsClassic,
  resetCodeModeRequestStateForTests,
  withoutLiteHeader,
} from "./request.js";

type CapturedPayload = {
  model: string;
  input: CodeModePayloadContext["input"];
  instructions?: string;
  tools?: ExecToolDefinition[];
  reasoning?: { effort?: string; context?: string; summary?: string };
  store?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  parallel_tool_calls?: boolean;
  tool_choice?: string;
};
type Capture = { headers: Record<string, string>; body: CapturedPayload };
const readData = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test-fixtures/code-mode/${name}`, import.meta.url), "utf8"));
const lite = readData("lite-request.json") as Capture;
const classic = readData("classic-request.json") as Capture;
const capturedBase = readData("claude-code-request-body.json") as Omit<CapturedPayload, "tools"> & {
  tools: Array<{ name: string; description: string; parameters: unknown }>;
};
const discovery = readData("codex-models-response.json") as {
  models: Array<{
    slug: string;
    tool_mode?: string;
    use_responses_lite?: boolean;
    default_reasoning_level?: string;
  }>;
};
const discovered = discovery.models.find((model) => model.slug === lite.body.model)!;
const modelInfo: CodexModelInfo = {
  slug: discovered.slug,
  toolMode: discovered.tool_mode,
  useResponsesLite: discovered.use_responses_lite,
  defaultReasoningLevel: discovered.default_reasoning_level,
};
const rendered = renderExecTool(
  capturedBase.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
);

const context = (shape: "lite" | "classic"): CodeModePayloadContext => ({
  shape,
  execTool: rendered.tool,
  input: structuredClone(classic.body.input),
  sessionKey: "session-account-test-key",
  modelInfo,
});
// Derived exclusively from the real classic request: its message/tool parts are not
// fabricated. The production builder appends CODE_MODE_NOTE and chooses a shape.
const payload = () => structuredClone(classic.body);

afterEach(() => resetCodeModeRequestStateForTests());

describe("code-mode payload shapes", () => {
  test("lite matches the captured structure and supplies the required header", () => {
    const ctx = context("lite");
    const request = applyCodeModeToPayload(payload(), ctx);
    const body = request.payload;
    expect(request.shape).toBe("lite");
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(lite.body.parallel_tool_calls);
    expect(body.tool_choice).toBe(lite.body.tool_choice);
    expect(body.reasoning.context).toBe(lite.body.reasoning!.context);
    expect(body.reasoning.effort).toBe(classic.body.reasoning!.effort);
    const capturedTools = lite.body.input[0]!;
    const capturedDeveloper = lite.body.input[1]!;
    expect(body.input[0]).toMatchObject({
      type: capturedTools.type,
      role: capturedTools.role,
      tools: [rendered.tool],
    });
    expect(body.input[0].id).toMatch(/^at_[0-9a-f-]{36}$/);
    expect(body.input[1]).toEqual({
      type: capturedDeveloper.type,
      role: capturedDeveloper.role,
      content: [{ type: "input_text", text: `${classic.body.instructions}\n\n${CODE_MODE_NOTE}` }],
    });
    expect(body.input.slice(2)).toEqual(ctx.input);
    expect(request.headers).toContainEqual({
      name: LITE_HEADER_NAME,
      value: lite.headers[LITE_HEADER_NAME],
      merge: "append-comma",
    });
  });

  test("classic matches the captured top-level exec structure and never adds the lite header", () => {
    const ctx = context("classic");
    const request = applyCodeModeToPayload(payload(), ctx);
    expect(request.shape).toBe("classic");
    expect(request.payload.tools).toEqual([rendered.tool]);
    expect(request.payload.tools[0].type).toBe(classic.body.tools![0]!.type);
    expect(request.payload.input).toEqual(ctx.input);
    expect(request.payload.instructions).toBe(`${classic.body.instructions}\n\n${CODE_MODE_NOTE}`);
    expect(request.payload.parallel_tool_calls).toBe(false);
    expect(request.payload.tool_choice).toBe("auto");
    expect(request.headers.some((header) => header.name.toLowerCase() === LITE_HEADER_NAME)).toBe(
      false
    );
    expect(request.payload.reasoning).toEqual(classic.body.reasoning);
  });

  test("post-5c cache/store/include/reasoning fields survive either shape", () => {
    for (const shape of ["lite", "classic"] as const) {
      // Derived from the real B request, which carries the post-5c cache key.
      const original = structuredClone(capturedBase);
      const request = applyCodeModeToPayload(original, context(shape));
      expect(request.payload.prompt_cache_key).toBe(capturedBase.prompt_cache_key);
      expect(request.payload.store).toBe(capturedBase.store);
      expect(request.payload.include).toEqual(capturedBase.include);
      expect(request.payload.reasoning.effort).toBe(capturedBase.reasoning!.effort);
      expect(request.payload.reasoning.summary).toBe(capturedBase.reasoning!.summary);
    }
  });

  test("lite uses discovery's default effort only when none was supplied", () => {
    const noEffort = payload();
    delete noEffort.reasoning;
    const request = applyCodeModeToPayload(noEffort, context("lite"));
    expect(request.shape).toBe("lite");
    expect(request.payload.reasoning).toMatchObject({
      effort: modelInfo.defaultReasoningLevel,
      context: "all_turns",
      summary: "auto",
    });
  });

  test("lite without request effort or discovery default becomes classic with no header", () => {
    const noEffort = payload();
    delete noEffort.reasoning;
    const ctx = context("lite");
    ctx.modelInfo = { ...modelInfo, defaultReasoningLevel: undefined };
    const request = applyCodeModeToPayload(noEffort, ctx);
    expect(request.shape).toBe("classic");
    expect(request.payload.tools).toEqual([rendered.tool]);
    expect(request.payload.input).toEqual(ctx.input);
    expect(request.headers).toEqual([]);
  });

  test("identical session and tools produce stable additional_tools ids", () => {
    const first = applyCodeModeToPayload(payload(), context("lite"));
    const second = applyCodeModeToPayload(payload(), context("lite"));
    expect(first.payload.input[0].id).toBe(second.payload.input[0].id);
    const other = applyCodeModeToPayload(payload(), {
      ...context("lite"),
      sessionKey: "another-account-session",
    });
    expect(first.payload.input[0].id).not.toBe(other.payload.input[0].id);
  });
});

describe("lite rejection state", () => {
  test("only raw HTTP 400 naming the lite header or reasoning.context qualifies", () => {
    for (const message of [LITE_HEADER_NAME, "REASONING.CONTEXT must be all_turns"]) {
      expect(isLiteRejection(400, message)).toBe(true);
      expect(isLiteRejection(401, message)).toBe(false);
      expect(isLiteRejection(500, message)).toBe(false);
    }
    expect(isLiteRejection(400, "unrelated invalid parameter")).toBe(false);
  });

  test("fallback rebuilds classic exec shape, marks the model, and the next decision is classic", () => {
    const pre = payload();
    const saved = structuredClone(pre);
    const ctx = context("lite");
    expect(isLiteFallbackActive(pre.model)).toBe(false);
    const rebuilt = rebuildAsClassic(pre, ctx, pre.model);
    expect(rebuilt.shape).toBe("classic");
    expect(rebuilt.payload.tools).toEqual([rendered.tool]);
    expect(rebuilt.payload.input).toEqual(ctx.input);
    expect(rebuilt.headers).toEqual([]);
    expect(pre).toEqual(saved);
    expect(isLiteFallbackActive(pre.model)).toBe(true);
    const decision = decideCodeMode({
      providerName: "openai-codex",
      arm: "oauth",
      accountKey: "account-a",
      api: "responses",
      hasTools: true,
      toolChoice: undefined,
      hasSessionId: true,
      setting: "auto",
      modelInfo,
      pinned: false,
      sandboxAvailable: true,
      liteFallbackActive: isLiteFallbackActive(pre.model),
    });
    expect(decision).toEqual({ on: true, shape: "classic", reason: "discovery" });
    if (!decision.on) throw new Error("code mode unexpectedly disabled");
    expect(applyCodeModeToPayload(payload(), context(decision.shape)).payload.tools).toEqual([
      rendered.tool,
    ]);
    resetCodeModeRequestStateForTests();
    expect(isLiteFallbackActive(pre.model)).toBe(false);
  });

  test("fallback TTL uses an injected clock and does not mark a different model", () => {
    const start = 1000;
    markLiteFallback(classic.body.model, start);
    expect(isLiteFallbackActive(classic.body.model, start)).toBe(true);
    expect(isLiteFallbackActive("unrelated-test-model", start)).toBe(false);
    expect(isLiteFallbackActive(classic.body.model, start + LITE_FALLBACK_TTL_MS - 1)).toBe(true);
    expect(isLiteFallbackActive(classic.body.model, start + LITE_FALLBACK_TTL_MS + 1)).toBe(false);
    markLiteFallback(classic.body.model, start);
    resetCodeModeRequestStateForTests();
    expect(isLiteFallbackActive(classic.body.model, start)).toBe(false);
  });

  test("removes every case spelling of the lite header while retaining other wire headers", () => {
    const other = { name: "other-header", value: "kept", merge: "append-comma" as const };
    expect(
      withoutLiteHeader([
        { name: LITE_HEADER_NAME, value: "true", merge: "append-comma" },
        other,
        { name: LITE_HEADER_NAME.toUpperCase(), value: "true", merge: "append-comma" },
      ])
    ).toEqual([other]);
  });
});
