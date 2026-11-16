import { describe, expect, test } from "bun:test";
import { resolveHarnessGateway } from "./harness-gateway.js";
import type { ClaudishProfileConfig } from "./profile-config.js";

function resolve(url: string) {
  return resolveHarnessGateway({ harnessGateway: { url } } as unknown as ClaudishProfileConfig);
}

describe("harnessGateway.url reaches Claude Code only in the form that was checked", () => {
  // Each of these parses to a loopback host, but another URL parser reads the raw
  // text differently, or the raw text carries bytes the check never saw.
  for (const [label, url] of [
    ["a backslash before userinfo", "http://127.0.0.1\\@evil.example:18081"],
    ["a CR LF inside the path", "http://127.0.0.1:18081/v1\r\nX-Injected: 1"],
    ["a line feed inside the host", "http://local\nhost:18081"],
    ["a tab inside the host", "http://127.0.0.1\t:18081"],
    ["userinfo", "http://user:secret@127.0.0.1:18081"],
    ["a username only", "http://user@127.0.0.1:18081"],
  ] as const) {
    test(`refuses ${label}, without echoing the value`, () => {
      const result = resolve(url);
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.message).not.toContain("evil");
        expect(result.message).not.toContain("secret");
        expect(result.message).toContain("harnessGateway.url");
      }
    });
  }

  for (const [input, canonical] of [
    ["http://0177.0.0.1:18081", "http://127.0.0.1:18081"],
    ["http://2130706433:18081", "http://127.0.0.1:18081"],
    ["HTTP://LOCALHOST:18081/", "http://localhost:18081/"],
    ["http://127.0.0.1:18081/gw/", "http://127.0.0.1:18081/gw/"],
    ["http://127.0.0.1:18081", "http://127.0.0.1:18081"],
  ] as const) {
    test(`hands over ${JSON.stringify(input)} as ${canonical}`, () => {
      expect(resolve(input)).toEqual({ kind: "on", url: canonical });
    });
  }
});
