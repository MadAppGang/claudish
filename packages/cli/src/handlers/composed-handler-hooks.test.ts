/**
 * The hook request stage inside ComposedHandler, driven through `withHooks`
 * with a fake ProviderTransport. Ported from the behavior-layer ordering test
 * (mutation before `buildPayload` for foreign models, none for `claude-*`),
 * plus the cases the hook system adds: `summarizeTools`, `forceForeignModel`,
 * the session-context note reaching a chat-completions payload, and attempt
 * isolation on one context.
 */

import { describe, expect, it } from "bun:test";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { BUILTIN_HOOKS } from "../hooks/builtins/index.js";
import { planFileInstruction } from "../hooks/builtins/plan-mode.js";
import { SESSION_CONTEXT_NOTE } from "../hooks/builtins/session-context.js";
import { HookEngine } from "../hooks/engine.js";
import type { JournalEntry } from "../hooks/journal.js";
import { type HookDefinition, act } from "../hooks/public.js";
import { HookRegistry, type UserHookInput } from "../hooks/registry.js";
import { withHooks } from "../hooks/response-seam.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler, type ComposedHandlerOptions } from "./composed-handler.js";

const PLAN_PATH = "/tmp/behavior-order-test/assigned-plan.md";

interface CapturedBuildInput {
  messages: any[];
  tools: any[];
  system: any;
  built: any;
}

class RecordingOpenAIAPIFormat extends OpenAIAPIFormat {
  captured: CapturedBuildInput[] = [];

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const built = super.buildPayload(claudeRequest, messages, tools);
    this.captured.push(
      JSON.parse(JSON.stringify({ messages, tools, system: claudeRequest.system, built }))
    );
    return built;
  }

  get last(): CapturedBuildInput | undefined {
    return this.captured[this.captured.length - 1];
  }
}

function makeFakeTransport(name = "test-provider"): ProviderTransport {
  return {
    name,
    displayName: "Test",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://127.0.0.1:1/",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

const EXIT_PLAN_MODE_DESCRIPTION =
  "Exit plan mode after writing the plan. This second sentence is what --summarize-tools drops, and it is long enough to matter.";

function makePayload(model: string, overrides: Record<string, unknown> = {}): any {
  return {
    model,
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content: `No plan file exists yet. You should create your plan at ${PLAN_PATH} using the Write tool.`,
      },
    ],
    tools: [
      {
        name: "ExitPlanMode",
        description: EXIT_PLAN_MODE_DESCRIPTION,
        input_schema: { type: "object", properties: {} },
      },
    ],
    ...overrides,
  };
}

function fakeContext(): any {
  const vars = new Map<string, unknown>();
  return {
    json: (body: any, status: number) => ({ body, status, ok: false }),
    body: (...args: any[]) => ({ args }),
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
  };
}

function engineWith(users: UserHookInput[] = []) {
  const journal: JournalEntry[] = [];
  const engine = new HookEngine({
    registry: new HookRegistry(BUILTIN_HOOKS, users, undefined),
    config: {},
    hostMode: "other",
    journalSink: (e) => journal.push(e),
    warn: () => {},
    drainTelemetryOutbox: false,
  });
  return { engine, journal };
}

async function handleOnce(
  handler: ComposedHandler,
  engine: HookEngine,
  payload: any,
  c: any = fakeContext()
): Promise<void> {
  try {
    await withHooks(handler, engine).handle(c, payload);
  } catch {
    // The fake transport deliberately points at an unroutable local endpoint.
  }
}

async function captureBuildInput(
  model: string,
  opts: {
    options?: ComposedHandlerOptions;
    payload?: any;
    withHooks?: boolean;
    provider?: string;
  } = {}
): Promise<RecordingOpenAIAPIFormat> {
  const adapter = new RecordingOpenAIAPIFormat(model);
  const handler = new ComposedHandler(makeFakeTransport(opts.provider), model, model, 8080, {
    adapter,
    ...opts.options,
  });
  const payload = opts.payload ?? makePayload(model);
  if (opts.withHooks === false) {
    try {
      await handler.handle(fakeContext(), payload);
    } catch {
      // unroutable endpoint, as above
    }
  } else {
    await handleOnce(handler, engineWith().engine, payload);
  }
  return adapter;
}

function exitPlanModeDescription(adapter: RecordingOpenAIAPIFormat): string {
  const tool = adapter.last?.tools.find(
    (candidate: any) => (candidate.function ?? candidate).name === "ExitPlanMode"
  );
  return (tool?.function ?? tool)?.description ?? "";
}

function userHook(id: string, def: Omit<HookDefinition, "apiVersion" | "id">) {
  return {
    id: `hook:m/${id}`,
    module: "/hooks/m.ts",
    moduleIndex: 0,
    exportIndex: 0,
    def: { apiVersion: 1, id, ...def } as HookDefinition,
  } satisfies UserHookInput;
}

describe("ComposedHandler hook request stage ordering", () => {
  it("applies hook mutations before adapter.buildPayload for foreign models", async () => {
    const adapter = await captureBuildInput("gpt-5.6-sol");

    // This can only be captured if the request stage ran before buildPayload;
    // moving it after buildPayload must fail this regression test.
    expect(exitPlanModeDescription(adapter)).toContain("assigned-plan.md");
  });

  it("keeps foreign-scoped built-ins off for native Claude models", async () => {
    const adapter = await captureBuildInput("claude-opus-4-8");

    expect(exitPlanModeDescription(adapter)).not.toContain("assigned-plan.md");
  });

  it("keeps them off for the anthropic provider whatever the model is called", async () => {
    const adapter = await captureBuildInput("glm-5", { provider: "anthropic" });

    expect(exitPlanModeDescription(adapter)).not.toContain("assigned-plan.md");
  });

  it("runs no hooks without withHooks on the context (classifier passthrough, tests)", async () => {
    const adapter = await captureBuildInput("gpt-5.6-sol", { withHooks: false });

    expect(adapter.last).toBeDefined();
    expect(exitPlanModeDescription(adapter)).not.toContain("assigned-plan.md");
  });

  it("forceForeignModel makes a claude-* uid foreign, so plan mode is armed", async () => {
    const forced = await captureBuildInput("claude-sonnet-5-medium", {
      options: { forceForeignModel: true },
    });
    const control = await captureBuildInput("claude-sonnet-5-medium");

    expect(exitPlanModeDescription(forced)).toContain("assigned-plan.md");
    expect(exitPlanModeDescription(control)).not.toContain("assigned-plan.md");
  });

  it("summarizeTools keeps the full plan-mode append on the converted tool", async () => {
    const adapter = await captureBuildInput("gpt-5.6-sol", { options: { summarizeTools: true } });
    const description = exitPlanModeDescription(adapter);

    // Summarised to the first sentence…
    expect(description.startsWith("Exit plan mode after writing the plan.")).toBe(true);
    expect(description).not.toContain("second sentence");
    // …and the whole instruction appended after the cut.
    expect(description.endsWith(planFileInstruction(PLAN_PATH))).toBe(true);
  });

  it("puts the session-context note inside the system message of the built chat-completions payload", async () => {
    const adapter = await captureBuildInput("glm-5", {
      payload: makePayload("glm-5", {
        system: "Base prompt. SessionStart hook additional context: x",
      }),
    });
    const built = adapter.last?.built;
    const systemMessage = built?.messages?.find((m: any) => m.role === "system");

    expect(typeof systemMessage?.content).toBe("string");
    expect(systemMessage.content).toContain(SESSION_CONTEXT_NOTE);
    expect(JSON.stringify(built)).toContain(SESSION_CONTEXT_NOTE);
  });

  it("a second attempt on the same context does not carry the first attempt's injected note", async () => {
    let attempt = 0;
    const { engine } = engineWith([
      userHook("count", { on: { request: () => [act.injectSystemNote(`ATTEMPT-${++attempt}`)] } }),
    ]);
    const adapter = new RecordingOpenAIAPIFormat("glm-5");
    const handler = new ComposedHandler(makeFakeTransport(), "glm-5", "glm-5", 8080, { adapter });
    const c = fakeContext();
    const payload = makePayload("glm-5", { system: "base" });
    await handleOnce(handler, engine, payload, c);
    await handleOnce(handler, engine, payload, c);

    expect(adapter.captured).toHaveLength(2);
    expect(adapter.captured[0]?.system).toBe("base\n\nATTEMPT-1");
    expect(adapter.captured[1]?.system).toBe("base\n\nATTEMPT-2");
    // The inbound payload is never touched.
    expect(payload.system).toBe("base");
  });

  it("user stage-A actions reach the converted messages", async () => {
    const { engine } = engineWith([
      userHook("append", { on: { request: () => [act.appendUserText("APPENDED-BY-HOOK")] } }),
    ]);
    const adapter = new RecordingOpenAIAPIFormat("glm-5");
    const handler = new ComposedHandler(makeFakeTransport(), "glm-5", "glm-5", 8080, { adapter });
    await handleOnce(handler, engine, makePayload("glm-5"));

    expect(JSON.stringify(adapter.last?.built.messages)).toContain("APPENDED-BY-HOOK");
  });
});
