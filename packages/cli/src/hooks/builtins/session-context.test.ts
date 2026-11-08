/** Ported 1:1 from behavior/rules/session-context.test.ts. */

import { describe, expect, it } from "bun:test";
import type { RequestContext } from "../public.js";
import { BUILTIN_HOOKS } from "./index.js";
import {
  SESSION_CONTEXT_HOOK_ID,
  hasInjectedSessionContext,
  sessionContextHook,
  sessionContextRequest,
} from "./session-context.js";

const MARKER = "SessionStart hook additional context";

function requestContext(systemText = "", messages: unknown[] = []): RequestContext {
  return {
    hookId: SESSION_CONTEXT_HOOK_ID,
    severity: "fix",
    log: () => {},
    signal: new AbortController().signal,
    prior: [],
    event: "request",
    host: { mode: "other" },
    route: { modelId: "m", provider: "p", native: false },
    request: {
      model: "m",
      stream: true,
      systemText,
      messages: messages as RequestContext["request"]["messages"],
      tools: [],
    },
    harness: { planModeActive: false },
    session: null,
  };
}

describe("hasInjectedSessionContext", () => {
  it("detects the marker in system text", () => {
    expect(hasInjectedSessionContext(MARKER, [])).toBe(true);
  });

  it("detects the marker in the first message's string content", () => {
    expect(hasInjectedSessionContext("", [{ content: MARKER }])).toBe(true);
  });

  it("detects the marker in a text content block in the first message", () => {
    const messages = [{ content: [{ type: "text", text: MARKER }] }];

    expect(hasInjectedSessionContext("", messages)).toBe(true);
  });

  it("returns false for ordinary and empty input", () => {
    expect(hasInjectedSessionContext("You are a helpful assistant.", [])).toBe(false);
    expect(hasInjectedSessionContext("", [])).toBe(false);
  });

  it("does not scan later messages", () => {
    // Only messages[0] is scanned so the model's own earlier echo cannot re-arm the hook.
    expect(
      hasInjectedSessionContext("", [
        { content: "An ordinary first message." },
        { content: MARKER },
      ])
    ).toBe(false);
  });

  it("matches upper- and lower-case marker variants", () => {
    expect(hasInjectedSessionContext("SESSIONSTART HOOK ADDITIONAL CONTEXT", [])).toBe(true);
    expect(hasInjectedSessionContext("sessionstart hook additional context", [])).toBe(true);
  });
});

describe("session-context/no-harness-echo", () => {
  it("is scoped to foreign routes (was appliesTo: !isNativeAnthropic)", () => {
    expect(sessionContextHook.routes).toBe("foreign");
    expect(sessionContextHook.defaultSeverity).toBe("fix");
  });

  it("injects exactly one system note when context is present", () => {
    const actions = sessionContextRequest(requestContext(MARKER));

    expect(actions).toEqual([{ type: "injectSystemNote", text: expect.any(String) }]);
  });

  it("returns no actions when context is absent", () => {
    expect(sessionContextRequest(requestContext("An ordinary system prompt."))).toEqual([]);
  });
});

describe("BUILTIN_HOOKS", () => {
  it("contains the session-context hook under its unchanged id", () => {
    expect(BUILTIN_HOOKS).toContain(sessionContextHook);
    expect(sessionContextHook.id).toBe("session-context/no-harness-echo");
  });
});
