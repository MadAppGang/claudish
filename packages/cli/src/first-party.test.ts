import { describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { isPassthroughSession } from "./claude-runner.js";
import {
  bodyToForward,
  recordInboundBody,
  requestHeadersToForward,
  responseHeadersToReturn,
} from "./handlers/shared/anthropic-forward.js";
import type { ClaudishConfig } from "./types.js";

const config = (over: Partial<ClaudishConfig>): ClaudishConfig =>
  ({ monitor: false, ...over }) as ClaudishConfig;

/** The two Context methods the forwarding helpers use, over a plain map. */
function fakeContext(): Context {
  const vars = new Map<string, unknown>();
  return {
    set: (key: string, value: unknown) => vars.set(key, value),
    get: (key: string) => vars.get(key),
  } as unknown as Context;
}

describe("isPassthroughSession", () => {
  it("holds for --monitor, where every request goes to Anthropic unchanged", () => {
    expect(isPassthroughSession(config({ monitor: true }))).toBe(true);
  });

  it("does not hold with the advisor, whose decorator rewrites requests", () => {
    expect(isPassthroughSession(config({ monitor: true, advisor: true }))).toBe(false);
  });

  it("does not hold for a routed session", () => {
    expect(isPassthroughSession(config({ monitor: false }))).toBe(false);
  });
});

describe("requestHeadersToForward", () => {
  it("keeps Claude Code's own headers and drops the per-connection ones", () => {
    const out = requestHeadersToForward(
      new Headers({
        authorization: "Bearer t",
        "anthropic-beta": "claude-code-20250219",
        "x-app": "cli",
        "x-claude-code-session-id": "s1",
        "anthropic-usage-limit": "slow",
        host: "127.0.0.1:7856",
        "content-length": "12",
        connection: "keep-alive, x-per-hop",
        "x-per-hop": "1",
        "transfer-encoding": "chunked",
      })
    );
    expect(out).toEqual({
      authorization: "Bearer t",
      "anthropic-beta": "claude-code-20250219",
      "x-app": "cli",
      "x-claude-code-session-id": "s1",
      "anthropic-usage-limit": "slow",
    });
  });
});

describe("responseHeadersToReturn", () => {
  it("returns Anthropic's headers, less the encoding fetch already undid", () => {
    const out = responseHeadersToReturn(
      new Headers({
        "anthropic-ratelimit-unified-status": "allowed_warning",
        "request-id": "req_1",
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "99",
        connection: "keep-alive",
      })
    );
    const returned: Record<string, string> = {};
    out.forEach((value, name) => {
      returned[name] = value;
    });
    expect(returned).toEqual({
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "request-id": "req_1",
      "content-type": "application/json",
    });
  });
});

describe("bodyToForward", () => {
  // Spacing JSON.stringify would never produce, so a re-serialisation shows.
  const RAW = '{"model": "claude-opus-5-5", "system": [{"type": "text", "text": "cch=abcde;"}]}';

  it("sends the inbound bytes when nothing changed the payload", () => {
    const c = fakeContext();
    const payload = JSON.parse(RAW);
    recordInboundBody(c, RAW, payload);
    expect(bodyToForward(c, payload)).toBe(RAW);
  });

  it("sends the new serialisation once something changed it", () => {
    const c = fakeContext();
    const payload = JSON.parse(RAW);
    recordInboundBody(c, RAW, payload);
    payload.model = "claude-sonnet-5";
    expect(bodyToForward(c, payload)).toBe(JSON.stringify(payload));
  });

  it("serialises when no inbound body was recorded", () => {
    const payload = JSON.parse(RAW);
    expect(bodyToForward(fakeContext(), payload)).toBe(JSON.stringify(payload));
  });
});
