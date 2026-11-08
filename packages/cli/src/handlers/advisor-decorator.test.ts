import { describe, expect, it, mock } from "bun:test";
import type { Context } from "hono";
import {
  createAdvisorPresenceMonitor,
  toolsOfferAdvisor,
  withAdvisorSwap,
} from "./advisor-decorator.js";
import type { ModelHandler } from "./types.js";

const cfg = { enabled: true, logPath: undefined };
const fixturePath = `${import.meta.dir}/../test-fixtures/sse-responses/minimax-m3-anthropic-implicit-signature-r10324.sse`;

const serverAdvisorTool = {
  type: "advisor_20260301",
  name: "advisor",
};

function createContext(): Context {
  const values = new Map<string, unknown>();
  return {
    get(key: string) {
      return values.get(key);
    },
    set(key: string, value: unknown) {
      values.set(key, value);
    },
    req: {
      header() {
        return undefined;
      },
    },
  } as unknown as Context;
}

function createInner(
  response: () => Response = () => new Response(null, { status: 204 })
): ModelHandler & { received: Record<string, unknown>[] } {
  const received: Record<string, unknown>[] = [];
  return {
    received,
    async handle(_c, payload) {
      received.push(payload);
      return response();
    },
    async shutdown() {},
  };
}

function wrap(inner: ModelHandler, warn: (message: string) => void = () => {}): ModelHandler {
  return withAdvisorSwap(inner, cfg, {
    presence: createAdvisorPresenceMonitor(warn),
  });
}

describe("withAdvisorSwap", () => {
  it("returns byte-identical SSE response data to the client (BC7)", async () => {
    const fixture = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());
    const inner = createInner(
      () =>
        new Response(fixture, {
          headers: { "content-type": "text/event-stream" },
        })
    );

    const response = await wrap(inner).handle(createContext(), { model: "test-model" });
    const actual = new Uint8Array(await response.arrayBuffer());

    expect(actual).toEqual(fixture);
  });

  it("replaces the server advisor tool and preserves every other tool in order", async () => {
    const inner = createInner();
    const first = { name: "Read", description: "Read a file", input_schema: { type: "object" } };
    const last = { name: "Write", description: "Write a file", input_schema: { type: "object" } };
    const payload = { model: "test-model", tools: [first, serverAdvisorTool, last] };

    await wrap(inner).handle(createContext(), payload);

    expect(inner.received).toHaveLength(1);
    const tools = inner.received[0].tools as Record<string, unknown>[];
    expect(tools).toHaveLength(3);
    expect(tools[0]).toEqual(first);
    expect(tools[1].name).toBe("advisor");
    expect(tools[1].type).not.toBe("advisor_20260301");
    expect(tools[2]).toEqual(last);
  });

  it("passes a request with no advisor tool through with tools unchanged", async () => {
    const inner = createInner();
    const tools = [
      { name: "Read", input_schema: { type: "object" } },
      { name: "Write", input_schema: { type: "object" } },
    ];

    await wrap(inner).handle(createContext(), { model: "test-model", tools });

    expect(inner.received[0].tools).toBe(tools);
    expect(inner.received[0].tools).toEqual(tools);
  });

  it("processes a request only once when an already wrapped handler is wrapped again", async () => {
    const inner = createInner();
    const firstWrapper = wrap(inner);
    const forwardingHandler: ModelHandler = {
      handle: (context, payload) => firstWrapper.handle(context, payload),
      shutdown: () => firstWrapper.shutdown(),
    };
    const secondWrapper = wrap(forwardingHandler);

    await secondWrapper.handle(createContext(), {
      model: "test-model",
      tools: [serverAdvisorTool],
    });

    const tools = inner.received[0].tools as Record<string, unknown>[];
    expect(tools.filter((tool) => tool.name === "advisor")).toHaveLength(1);
    expect(tools.filter((tool) => tool.type === "advisor_20260301")).toHaveLength(0);
  });

  it("observes advisor presence only once per request through nested wrappers", async () => {
    const inner = createInner();
    const warn = mock((_message: string) => {});
    const presence = createAdvisorPresenceMonitor(warn);
    const deps = { presence };
    const firstWrapper = withAdvisorSwap(inner, cfg, deps);
    const forwardingHandler: ModelHandler = {
      handle: (context, payload) => firstWrapper.handle(context, payload),
      shutdown: () => firstWrapper.shutdown(),
    };
    const secondWrapper = withAdvisorSwap(forwardingHandler, cfg, deps);
    const payload = { model: "test-model", tools: [{ name: "Read" }] };

    await secondWrapper.handle(createContext(), payload);
    await secondWrapper.handle(createContext(), payload);

    // The shared monitor makes the already-handled guard testable: double observation would warn.
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("createAdvisorPresenceMonitor", () => {
  it("warns once after three consecutive tool-carrying requests without advisor", () => {
    const warnings: string[] = [];
    const monitor = createAdvisorPresenceMonitor((message) => warnings.push(message));
    const absent = { tools: [{ name: "Read" }] };

    monitor.observe(absent);
    monitor.observe(absent);
    expect(warnings).toEqual([]);
    monitor.observe(absent);
    expect(warnings).toHaveLength(1);

    monitor.observe(absent);
    monitor.observe(absent);
    expect(warnings).toHaveLength(1);
  });

  it("does not count or reset requests with no tools array", () => {
    const warnings: string[] = [];
    const monitor = createAdvisorPresenceMonitor((message) => warnings.push(message));
    const absent = { tools: [{ name: "Read" }] };

    monitor.observe(absent);
    monitor.observe({ model: "side-request" });
    monitor.observe(absent);
    monitor.observe({ model: "another-side-request" });
    expect(warnings).toEqual([]);
    monitor.observe(absent);

    expect(warnings).toHaveLength(1);
  });

  it("resets the consecutive count when advisor is offered and remains one-shot after warning", () => {
    const warnings: string[] = [];
    const monitor = createAdvisorPresenceMonitor((message) => warnings.push(message));
    const absent = { tools: [{ name: "Read" }] };

    monitor.observe(absent);
    monitor.observe(absent);
    monitor.observe({ tools: [serverAdvisorTool] });
    monitor.observe(absent);
    monitor.observe(absent);
    expect(warnings).toEqual([]);
    monitor.observe(absent);
    expect(warnings).toHaveLength(1);

    monitor.observe({ tools: [serverAdvisorTool] });
    monitor.observe(absent);
    monitor.observe(absent);
    monitor.observe(absent);
    expect(warnings).toHaveLength(1);
  });
});

describe("toolsOfferAdvisor", () => {
  it("recognizes server and function advisor tools only", () => {
    expect(toolsOfferAdvisor([serverAdvisorTool])).toBe(true);
    expect(toolsOfferAdvisor([{ name: "advisor", description: "Ask for advice" }])).toBe(true);
    expect(toolsOfferAdvisor([])).toBe(false);
    expect(toolsOfferAdvisor([{ name: "Read" }])).toBe(false);
    expect(toolsOfferAdvisor(undefined)).toBe(false);
  });
});
