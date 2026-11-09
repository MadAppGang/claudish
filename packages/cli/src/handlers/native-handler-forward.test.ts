/**
 * What NativeHandler sends upstream: Claude Code's own headers, its query
 * string and, while nothing changed the payload, its body bytes.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Context } from "hono";
import { BUILTIN_HOOKS } from "../hooks/builtins/index.js";
import { HookEngine } from "../hooks/engine.js";
import { type HookDefinition, act } from "../hooks/public.js";
import { HookRegistry, type UserHookInput } from "../hooks/registry.js";
import { withHooks } from "../hooks/response-seam.js";
import { ADVISOR_SWAPPED_CONTEXT_KEY } from "./advisor-decorator.js";
import { NativeHandler } from "./native-handler.js";
import { recordInboundBody } from "./shared/anthropic-forward.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function captureFetch(): Captured[] {
  const calls: Captured[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    url: unknown,
    init?: RequestInit
  ) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name] = value;
    }
    calls.push({ url: String(url), headers, body: String(init?.body) });
    return new Response(JSON.stringify({ type: "message", content: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

// Spacing JSON.stringify never produces, so a re-serialisation shows.
const RAW =
  '{ "model" : "claude-opus-4-8", "max_tokens":16, "messages": [ {"role": "user", "content": "hi"} ] }';

const CLAUDE_CODE_HEADERS: Record<string, string> = {
  authorization: "Bearer sk-ant-oat-forward-test",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,advisor-tool-2026-03-01",
  "x-app": "cli",
  "x-claude-code-session-id": "session-forward-1",
  "user-agent": "claude-cli/9.9.9 (external, cli)",
  "content-type": "application/json",
  host: "127.0.0.1:7856",
  "content-length": String(RAW.length),
  connection: "keep-alive",
};

/** A Hono-like context over a real inbound Request, with the body recorded as the proxy does. */
function inboundContext(
  headers: Record<string, string> = CLAUDE_CODE_HEADERS,
  url = "http://127.0.0.1:7856/v1/messages?beta=true"
): { c: Context; payload: Record<string, unknown> } {
  const vars = new Map<string, unknown>();
  const raw = new Request(url, { method: "POST", headers });
  const lowered: Record<string, string> = {};
  raw.headers.forEach((value, name) => {
    lowered[name] = value;
  });
  const c = {
    req: { raw, url: raw.url, header: (name?: string) => (name ? lowered[name] : lowered) },
    json: (body: unknown, init?: { status?: number } | number) =>
      new Response(JSON.stringify(body), {
        status: typeof init === "number" ? init : (init?.status ?? 200),
      }),
    body: (stream: unknown, init?: ResponseInit) => new Response(stream as BodyInit, init),
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
  } as unknown as Context;
  const payload = JSON.parse(RAW);
  recordInboundBody(c, RAW, payload);
  return { c, payload };
}

function engineWith(users: UserHookInput[]) {
  return new HookEngine({
    registry: new HookRegistry(BUILTIN_HOOKS, users, undefined),
    config: {},
    hostMode: "other",
    journalSink: () => {},
    warn: () => {},
    drainTelemetryOutbox: false,
  });
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

describe("NativeHandler forwards the request as Claude Code sent it", () => {
  it("sends Claude Code's headers, its query string and its body bytes", async () => {
    const calls = captureFetch();
    const { c, payload } = inboundContext();
    const res = await new NativeHandler("sk-unused").handle(c, payload);

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toEndWith("/v1/messages?beta=true");
    expect(calls[0]!.headers).toEqual({
      authorization: "Bearer sk-ant-oat-forward-test",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,advisor-tool-2026-03-01",
      "x-app": "cli",
      "x-claude-code-session-id": "session-forward-1",
      "user-agent": "claude-cli/9.9.9 (external, cli)",
      "content-type": "application/json",
    });
    expect(calls[0]!.body).toBe(RAW);
  });

  it("never carries a cookie or another destination's header upstream", async () => {
    const calls = captureFetch();
    const { c, payload } = inboundContext({
      ...CLAUDE_CODE_HEADERS,
      Cookie: "corp_session=abc123",
      "X-Gateway-Token": "gw-token-forward-test",
    });
    await new NativeHandler().handle(c, payload);

    expect(calls).toHaveLength(1);
    const sent = Object.keys(calls[0]!.headers).map((name) => name.toLowerCase());
    expect(sent).not.toContain("cookie");
    expect(sent).not.toContain("x-gateway-token");
    expect(JSON.stringify(calls[0]!.headers)).not.toContain("gw-token-forward-test");
    expect(calls[0]!.headers["x-claude-code-session-id"]).toBe("session-forward-1");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-ant-oat-forward-test");
  });

  it("never carries an unknown header that only looks like one of Claude Code's own", async () => {
    const calls = captureFetch();
    const { c, payload } = inboundContext({
      ...CLAUDE_CODE_HEADERS,
      "Anthropic-Gateway-Token": "gw-anthropic-family",
      "X-Stainless-Gateway-Key": "gw-stainless-family",
      "X-Claude-Code-Gateway-Secret": "gw-claude-code-family",
    });
    await new NativeHandler().handle(c, payload);

    const sent = JSON.stringify(calls[0]!.headers);
    expect(sent).not.toContain("gw-anthropic-family");
    expect(sent).not.toContain("gw-stainless-family");
    expect(sent).not.toContain("gw-claude-code-family");
    expect(calls[0]!.headers["x-claude-code-session-id"]).toBe("session-forward-1");
  });

  it("sends the inbound bearer as received when Connection names it, and no fallback key", async () => {
    const calls = captureFetch();
    const { c, payload } = inboundContext({
      authorization: "Bearer sk-ant-oat-connection-named",
      connection: "authorization",
      "anthropic-version": "2023-06-01",
    });
    await new NativeHandler("sk-metered-fallback").handle(c, payload);

    expect(calls[0]!.headers.authorization).toBe("Bearer sk-ant-oat-connection-named");
    expect(calls[0]!.headers).not.toHaveProperty("x-api-key");
    expect(JSON.stringify(calls[0]!.headers)).not.toContain("sk-metered-fallback");
  });

  it("sends the inbound key as received when Connection names it, and no fallback key", async () => {
    const calls = captureFetch();
    const { c, payload } = inboundContext({
      "x-api-key": "sk-ant-inbound-key",
      connection: "x-api-key",
    });
    await new NativeHandler("sk-metered-fallback").handle(c, payload);

    expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant-inbound-key");
    expect(calls[0]!.headers).not.toHaveProperty("authorization");
  });

  it("falls back to its own key and default version when the request carries neither", async () => {
    const calls = captureFetch();
    const { c, payload } = inboundContext(
      { "x-app": "cli", "content-type": "text/plain" },
      "http://127.0.0.1:7856/v1/messages"
    );
    await new NativeHandler("sk-fallback").handle(c, payload);

    expect(calls[0]!.url).toEndWith("/v1/messages");
    expect(calls[0]!.headers).toEqual({
      "x-app": "cli",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-fallback",
    });
  });

  it("strips the advisor beta on a swapped request, and the header once it is empty", async () => {
    const calls = captureFetch();
    const swapped = inboundContext();
    swapped.c.set(ADVISOR_SWAPPED_CONTEXT_KEY, true);
    await new NativeHandler().handle(swapped.c, swapped.payload);
    expect(calls[0]!.headers["anthropic-beta"]).toBe("claude-code-20250219");
    expect(calls[0]!.headers["x-claude-code-session-id"]).toBe("session-forward-1");

    const onlyAdvisor = inboundContext({
      ...CLAUDE_CODE_HEADERS,
      "anthropic-beta": "advisor-tool-2026-03-01",
    });
    onlyAdvisor.c.set(ADVISOR_SWAPPED_CONTEXT_KEY, true);
    await new NativeHandler().handle(onlyAdvisor.c, onlyAdvisor.payload);
    expect(calls[1]!.headers).not.toHaveProperty("anthropic-beta");
  });

  it("sends the new serialisation once a hook changed the payload", async () => {
    const calls = captureFetch();
    const engine = engineWith([
      userHook("native", {
        routes: "native",
        on: { request: () => [act.injectSystemNote("NATIVE-NOTE")] },
      }),
    ]);
    const { c, payload } = inboundContext();
    await withHooks(new NativeHandler(), engine).handle(c, payload);

    expect(calls[0]!.body).not.toBe(RAW);
    const sent = JSON.parse(calls[0]!.body);
    expect(JSON.stringify(sent.system)).toContain("NATIVE-NOTE");
    expect(calls[0]!.body).toBe(JSON.stringify(sent));
  });

  it("sends the new serialisation once the payload was changed in place", async () => {
    const calls = captureFetch();
    const { c, payload } = inboundContext();
    payload.model = "claude-sonnet-5";
    await new NativeHandler().handle(c, payload);

    expect(calls[0]!.body).toBe(JSON.stringify(payload));
  });
});
