import { describe, expect, test } from "bun:test";
import type { RemoteProvider } from "./handlers/shared/remote-provider-types.js";
import { OpenAIProviderTransport } from "./providers/transport/openai.js";
import {
  ACCOUNTS_FAULTS,
  accountsFault,
  accountsFaultArmed,
  resolveUpstreamUrl,
  testUpstreamActive,
} from "./test-upstream.js";

describe("CLAUDISH_TEST_UPSTREAM", () => {
  test("rewrites a bare origin while preserving path/query and bare-origin shape", () => {
    const env = { CLAUDISH_TEST_UPSTREAM: "http://127.0.0.1:4010" };

    expect(testUpstreamActive(env)).toBe(true);
    expect(resolveUpstreamUrl("https://api.openai.com", env)).toBe("http://127.0.0.1:4010");
    expect(resolveUpstreamUrl("https://api.openai.com/v1/responses?stream=true", env)).toBe(
      "http://127.0.0.1:4010/v1/responses?stream=true"
    );

    // Mutations caught: append a slash to bare origins or drop the original
    // path/query while composing the loopback URL.
  });

  test("selects per-host loopback targets without rewriting an unmatched host", () => {
    const env = {
      CLAUDISH_TEST_UPSTREAM:
        "api.anthropic.com=http://localhost:4010,api.openai.com=http://[::1]:4011",
    };

    expect(resolveUpstreamUrl("https://api.anthropic.com/v1/messages", env)).toBe(
      "http://localhost:4010/v1/messages"
    );
    expect(resolveUpstreamUrl("https://api.openai.com/v1/responses", env)).toBe(
      "http://[::1]:4011/v1/responses"
    );
    expect(resolveUpstreamUrl("https://chatgpt.com/backend-api/codex/responses", env)).toBe(
      "https://chatgpt.com/backend-api/codex/responses"
    );

    // Mutation caught: collapse the host map to one catch-all target, which
    // makes a metered canary indistinguishable from the fake subscription host.
  });

  test.each([
    "https://example.com:4010",
    "http://0.0.0.0:4010",
    "file:///tmp/fake-upstream",
    "not-a-url",
  ])("rejects non-loopback target %s", (target) => {
    const original = "https://api.openai.com/v1/responses";
    const env = { CLAUDISH_TEST_UPSTREAM: target };

    expect(testUpstreamActive(env)).toBe(false);
    expect(resolveUpstreamUrl(original, env)).toBe(original);

    // Mutation caught: accept any parseable URL, accept the bind wildcard as a
    // destination, or permit non-HTTP schemes.
  });

  test("rejects the entire host map when one entry is unsafe", () => {
    const original = "https://api.openai.com/v1/responses";
    const env = {
      CLAUDISH_TEST_UPSTREAM:
        "api.openai.com=http://127.0.0.1:4011,api.anthropic.com=https://example.com:4010",
    };

    expect(testUpstreamActive(env)).toBe(false);
    expect(resolveUpstreamUrl(original, env)).toBe(original);

    // Mutation caught: discard only the bad entry and retain the apparently safe
    // one. The contract rejects one malformed/unsafe value as a whole.
  });

  test("the metered OpenAI transport honors its host-specific canary target", () => {
    const saved = process.env.CLAUDISH_TEST_UPSTREAM;
    process.env.CLAUDISH_TEST_UPSTREAM = "api.openai.com=http://127.0.0.1:4999";
    try {
      const provider: RemoteProvider = {
        name: "openai-codex",
        baseUrl: "https://api.openai.com",
        apiPath: "/v1/responses",
        apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
        prefixes: ["cx@"],
      };
      const transport = new OpenAIProviderTransport(provider, "gpt-5.1-codex", "canary-key");
      expect(transport.getEndpoint()).toBe("http://127.0.0.1:4999/v1/responses");
    } finally {
      if (saved === undefined) delete process.env.CLAUDISH_TEST_UPSTREAM;
      else process.env.CLAUDISH_TEST_UPSTREAM = saved;
    }

    // Mutation caught: omit resolveUpstreamUrl at the metered OpenAI endpoint.
  });
});

describe("CLAUDISH_ACCOUNTS_FAULT", () => {
  test("exports one unique, closed fault vocabulary and arms every exported name", () => {
    expect(ACCOUNTS_FAULTS).toHaveLength(13);
    expect(ACCOUNTS_FAULTS).toContain("non-oauth-artifact");
    expect(new Set(ACCOUNTS_FAULTS).size).toBe(ACCOUNTS_FAULTS.length);

    for (const name of ACCOUNTS_FAULTS) {
      const env = {
        CLAUDISH_TEST_UPSTREAM: "http://127.0.0.1:4010",
        CLAUDISH_ACCOUNTS_FAULT: name,
      };
      expect(accountsFault(env)).toBe(name);
      expect(accountsFaultArmed(name, env)).toBe(true);
    }

    // Mutation caught: accept a name outside the exported closed union, duplicate
    // a selector, or let any exported selector fail its own arming predicate.
    // The account tests exercise each name's production injection site.
  });

  test("arms no fault without a valid loopback override", () => {
    expect(accountsFault({ CLAUDISH_ACCOUNTS_FAULT: "persist-throw" })).toBeNull();
    expect(
      accountsFault({
        CLAUDISH_TEST_UPSTREAM: "https://example.com",
        CLAUDISH_ACCOUNTS_FAULT: "persist-throw",
      })
    ).toBeNull();
    expect(
      accountsFault({
        CLAUDISH_TEST_UPSTREAM: "http://127.0.0.1:4010",
        CLAUDISH_ACCOUNTS_FAULT: "unknown-fault",
      })
    ).toBeNull();

    // Mutation caught: decouple fault arming from the validated loopback gate or
    // accept an open-ended fault name that no injection site understands.
  });
});
