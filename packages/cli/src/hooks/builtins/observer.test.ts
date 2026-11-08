/**
 * The observer built-in (`observer/divergence`): an observe-mode `toolCall` hook
 * over `hooks.observer.watchTools`, off unless the observer is enabled, and
 * never holding the stream.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { HookEngine } from "../engine.js";
import { UnavailableSink } from "../injection/sinks.js";
import type { RequestContext, ToolCallContext } from "../public.js";
import { HookRegistry } from "../registry.js";
import { RequestHooks } from "../request-stage.js";
import { applyResponseSeam, planSeam } from "../response-seam.js";
import { builtinHooks } from "./index.js";
import {
  DEFAULT_WATCH_TOOLS,
  OBSERVER_HOOK_ID,
  createObserverHook,
  observerEnabled,
} from "./observer.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = {} as RequestContext;

describe("observer built-in definition", () => {
  it("keeps the observer's id, is foreign-scoped, and observes without holding", () => {
    const hook = createObserverHook({}, ["plan-mode/plan-file-path"]);
    expect(hook.id).toBe(OBSERVER_HOOK_ID);
    expect(hook.routes).toBe("foreign");
    expect(hook.on?.toolCall?.observe).toBe(true);
    expect(hook.on?.toolCall?.tools).toEqual(DEFAULT_WATCH_TOOLS);
    expect(DEFAULT_WATCH_TOOLS).toEqual(["Write", "Edit", "NotebookEdit", "ExitPlanMode"]);
  });

  it("watches hooks.observer.watchTools when set", () => {
    const hook = createObserverHook({ observer: { watchTools: ["Bash"] } }, []);
    expect(hook.on?.toolCall?.tools).toEqual(["Bash"]);
  });

  it("is armed only when enabled and not in mode off", () => {
    const armed = (observer: object | undefined) =>
      createObserverHook({ observer } as never, []).on?.toolCall?.armed?.(ctx);
    expect(armed(undefined)).toBe(false);
    expect(armed({ enabled: false })).toBe(false);
    expect(armed({ enabled: true })).toBe(true);
    expect(armed({ enabled: true, mode: "suggest" })).toBe(true);
    expect(armed({ enabled: true, mode: "off" })).toBe(false);
    expect(observerEnabled({ observer: { enabled: true, mode: "off" } })).toBe(false);
  });

  it("returns no actions at once: the consultation is fire-and-forget", () => {
    const hook = createObserverHook({}, []);
    const result = hook.on?.toolCall?.handle({
      route: { modelId: "m", provider: "p", native: false },
      request: { tools: [] },
      harness: { planModeActive: false },
      tool: { id: "t", name: "Write", args: {}, rawArgs: "{}" },
    } as unknown as ToolCallContext);
    expect(result).toEqual([]);
  });

  it("is registered among the built-ins with the other built-ins as its vocabulary", () => {
    const ids = builtinHooks({}).map((h) => h.id);
    expect(ids).toEqual([
      "plan-mode/plan-file-path",
      "session-context/no-harness-echo",
      "gemini/thought-signature",
      OBSERVER_HOOK_ID,
    ]);
  });
});

describe("observer through the seam", () => {
  it("consults the local model about the delivered call, without holding or changing the stream", async () => {
    const digests: any[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      digests.push(JSON.parse(body.messages[1].content));
      return new Response(
        JSON.stringify({ message: { content: JSON.stringify({ ruleId: null, confidence: 0 }) } }),
        { headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const config = { observer: { enabled: true, model: "tiny-local" } };
    const engine = new HookEngine({
      registry: new HookRegistry(builtinHooks(config), [], undefined),
      config,
      hostMode: "other",
      journalSink: () => {},
      warn: () => {},
      drainTelemetryOutbox: false,
    });
    const c = new Map<string, unknown>();
    const scope = await new RequestHooks(engine, null, new UnavailableSink(() => {})).beginAttempt(
      { get: (k: string) => c.get(k), set: (k: string, v: unknown) => c.set(k, v) } as never,
      {
        claudeRequest: {
          messages: [{ role: "user", content: "write it" }],
          tools: [{ name: "Write", input_schema: { type: "object" } }],
        },
        route: { modelId: "glm-5", provider: "zai", native: false },
        model: "glm-5",
        stream: true,
      }
    );
    expect(planSeam(scope)).toEqual({ mode: "none", raw: 0, tap: true });

    const wire = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Write","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/p/x.md\\",\\"content\\":\\"secret\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const res = await applyResponseSeam(
      new Response(wire.join(""), { headers: { "content-type": "text/event-stream" } }),
      scope
    );
    expect(await res.text()).toBe(wire.join(""));

    const deadline = Date.now() + 2_000;
    while (digests.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(digests).toHaveLength(1);
    expect(digests[0].proposedCall).toEqual({
      name: "Write",
      argKeys: ["file_path", "content"],
      paths: ["/p/x.md"],
    });
    // A digest carries no argument values other than paths.
    expect(JSON.stringify(digests[0])).not.toContain("secret");
    expect(digests[0].ruleVocabulary).toEqual([
      "plan-mode/plan-file-path",
      "session-context/no-harness-echo",
    ]);
  });
});
