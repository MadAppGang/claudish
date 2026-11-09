import { describe, expect, it } from "bun:test";
import type { Context } from "hono";
import {
  bodyToForward,
  forwardedSearch,
  recordInboundBody,
  requestHeadersToForward,
} from "./anthropic-forward.js";

/** The Context members the forwarding helpers use, over a plain map. */
function fakeContext(url = "http://127.0.0.1:7856/v1/messages"): Context {
  const vars = new Map<string, unknown>();
  return {
    req: { url },
    set: (key: string, value: unknown) => vars.set(key, value),
    get: (key: string) => vars.get(key),
  } as unknown as Context;
}

describe("requestHeadersToForward", () => {
  it("keeps every end-to-end header, lowercased, and drops the hop-by-hop ones", () => {
    const out = requestHeadersToForward(
      new Headers({
        Authorization: "Bearer t",
        "anthropic-beta": "claude-code-20250219",
        "anthropic-version": "2023-06-01",
        "x-app": "cli",
        "X-Claude-Code-Session-Id": "s1",
        "user-agent": "claude-cli/9.9.9",
        host: "127.0.0.1:7856",
        "content-length": "12",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "proxy-connection": "keep-alive",
        "proxy-authenticate": "Basic",
        "proxy-authorization": "Basic Zm9v",
        te: "trailers",
        trailer: "x-checksum",
        "transfer-encoding": "chunked",
        upgrade: "h2c",
      })
    );
    expect(out).toEqual({
      authorization: "Bearer t",
      "anthropic-beta": "claude-code-20250219",
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
      "x-claude-code-session-id": "s1",
      "user-agent": "claude-cli/9.9.9",
    });
  });

  it("drops every header a Connection header names, an allowed one included, whatever its case", () => {
    const out = requestHeadersToForward(
      new Headers({
        connection: "close, X-App ,x-stainless-os",
        "x-app": "cli",
        "x-stainless-os": "MacOS",
        "x-stainless-lang": "js",
      })
    );
    expect(out).toEqual({ "x-stainless-lang": "js" });
  });
});

describe("requestHeadersToForward allows only what Claude Code sends to Anthropic", () => {
  it("drops cookies and headers meant for another destination, and keeps Claude Code's own", () => {
    const out = requestHeadersToForward(
      new Headers({
        cookie: "session=abc",
        "X-Gateway-Token": "gw-secret",
        "x-request-tag": "team-a",
        authorization: "Bearer t",
        "x-api-key": "sk-k",
        "x-claude-code-session-id": "s1",
        "x-app": "cli",
        "anthropic-beta": "claude-code-20250219",
        "anthropic-dangerous-direct-browser-access": "true",
        "x-stainless-lang": "js",
        "x-stainless-retry-count": "0",
        accept: "application/json",
        "accept-encoding": "gzip, deflate, br, zstd",
        "content-type": "application/json",
      })
    );
    expect(out).toEqual({
      authorization: "Bearer t",
      "x-api-key": "sk-k",
      "x-claude-code-session-id": "s1",
      "x-app": "cli",
      "anthropic-beta": "claude-code-20250219",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-stainless-lang": "js",
      "x-stainless-retry-count": "0",
      accept: "application/json",
      "accept-encoding": "gzip, deflate, br, zstd",
      "content-type": "application/json",
    });
  });

  it("drops every x-claudish- header, whatever its case", () => {
    const out = requestHeadersToForward(
      new Headers({
        "x-claudish-no-recovery": "advisor",
        "X-Claudish-Future-Signal": "1",
        "x-claude-code-session-id": "s1",
      })
    );
    expect(out).toEqual({ "x-claude-code-session-id": "s1" });
  });
});

describe("forwardedSearch", () => {
  it("returns the inbound query string with its leading ?", () => {
    expect(forwardedSearch(fakeContext("http://127.0.0.1:7856/v1/messages?beta=true"))).toBe(
      "?beta=true"
    );
  });

  it("returns an empty string when the request has no query", () => {
    expect(forwardedSearch(fakeContext("http://127.0.0.1:7856/v1/messages"))).toBe("");
  });
});

describe("bodyToForward", () => {
  // Spacing JSON.stringify never produces, so a re-serialisation shows.
  const RAW =
    '{ "model" : "claude-opus-5-5",  "max_tokens":16, "system": [ {"type": "text", "text": "cch=abcde;"} ] }';

  it("sends the inbound bytes when nothing changed the payload", () => {
    const c = fakeContext();
    const payload = JSON.parse(RAW);
    recordInboundBody(c, RAW, payload);
    expect(bodyToForward(c, payload)).toBe(RAW);
  });

  it("sends the inbound bytes for an equal copy of the payload", () => {
    const c = fakeContext();
    const payload = JSON.parse(RAW);
    recordInboundBody(c, RAW, payload);
    expect(bodyToForward(c, { ...payload })).toBe(RAW);
  });

  it("sends the new serialisation once something changed the payload in place", () => {
    const c = fakeContext();
    const payload = JSON.parse(RAW);
    recordInboundBody(c, RAW, payload);
    payload.model = "claude-sonnet-5";
    expect(bodyToForward(c, payload)).toBe(JSON.stringify(payload));
  });

  it("sends the new serialisation for a replaced payload", () => {
    const c = fakeContext();
    recordInboundBody(c, RAW, JSON.parse(RAW));
    const view = { ...JSON.parse(RAW), system: [{ type: "text", text: "NOTE" }] };
    expect(bodyToForward(c, view)).toBe(JSON.stringify(view));
  });

  it("serialises when no inbound body was recorded", () => {
    const payload = JSON.parse(RAW);
    expect(bodyToForward(fakeContext(), payload)).toBe(JSON.stringify(payload));
  });
});
