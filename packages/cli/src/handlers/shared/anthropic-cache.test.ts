/**
 * Tests for anthropic-cache.ts — cache_control breakpoint injection.
 *
 * Run: bun test packages/cli/src/handlers/shared/anthropic-cache.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  EXTENDED_CACHE_TTL_BETA,
  countCacheBreakpoints,
  ensureExtendedCacheBeta,
  injectAnthropicCacheBreakpoints,
  loadCachingConfig,
  stripAnthropicCacheBreakpoints,
  stripIntermediateMessageBreakpoints,
} from "./anthropic-cache.js";

const EPHEMERAL = { type: "ephemeral" as const };

/** A body shaped like what Claude Code sends: tools + system array + messages. */
function sampleBody(): any {
  return {
    model: "claude-3-5-sonnet",
    system: [{ type: "text", text: "S".repeat(1000) }],
    tools: [
      { name: "Read", input_schema: {} },
      { name: "Write", input_schema: {} },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "first turn " + "x".repeat(600) }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "latest turn" }] },
    ],
  };
}

describe("injectAnthropicCacheBreakpoints — placement", () => {
  test("marks the last tool, last system block, messages[0], and the tail", () => {
    const body = sampleBody();
    const { tag } = injectAnthropicCacheBreakpoints(body);

    // Last tool carries the catalog breakpoint; earlier tools do not.
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect((body.tools[0] as any).cache_control).toBeUndefined();
    // Last (only) system block.
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    // messages[0] static-reminder breakpoint.
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    // Rolling tail on the final message.
    expect(body.messages[2].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });

    expect(tag).toContain("tools");
    expect(tag).toContain("system");
    expect(tag).toContain("msg0");
    expect(tag).toContain("tail:5m");
  });

  test("converts a string system prompt into a cached text block", () => {
    const body: any = {
      system: "you are a helpful assistant",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    const { tag } = injectAnthropicCacheBreakpoints(body);

    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0]).toEqual({
      type: "text",
      text: "you are a helpful assistant",
      cache_control: { type: "ephemeral", ttl: "5m" },
    });
    expect(tag).toContain("system-string");
  });

  test("does not add a second breakpoint where the client already placed one", () => {
    const body: any = {
      tools: [{ name: "Read", cache_control: { ...EPHEMERAL } }],
      system: [{ type: "text", text: "S".repeat(1000), cache_control: { ...EPHEMERAL } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    injectAnthropicCacheBreakpoints(body);
    // One on tools, one on system, one placed on the single-message tail = 3.
    expect(countCacheBreakpoints(body)).toBe(3);
  });
});

describe("injectAnthropicCacheBreakpoints — TTL", () => {
  test("static prefix takes prefixTtl, the rolling tail keeps tailTtl", () => {
    const body = sampleBody();
    injectAnthropicCacheBreakpoints(body, { prefixTtl: "1h", tailTtl: "5m" });

    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // The final message is the tail and stays short.
    expect(body.messages[2].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  test("normalizes a client tail breakpoint to tailTtl while prefix goes to prefixTtl", () => {
    const body: any = {
      system: [{ type: "text", text: "S".repeat(1000), cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "old" }] },
        { role: "user", content: [{ type: "text", text: "new", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      ],
    };
    injectAnthropicCacheBreakpoints(body, { prefixTtl: "1h", tailTtl: "5m" });

    // The client's stale 1h tail is pulled back to 5m; the system prefix is 1h.
    expect(body.messages[1].content[0].cache_control.ttl).toBe("5m");
    expect(body.system[0].cache_control.ttl).toBe("1h");
  });
});

describe("injectAnthropicCacheBreakpoints — slot economy", () => {
  test("never exceeds the four-breakpoint ceiling", () => {
    const body = sampleBody();
    injectAnthropicCacheBreakpoints(body);
    expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
  });

  test("adds nothing when the client already spent all four slots", () => {
    const body: any = {
      tools: [{ name: "Read", cache_control: { ...EPHEMERAL } }],
      system: [{ type: "text", text: "S".repeat(1000), cache_control: { ...EPHEMERAL } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "a", cache_control: { ...EPHEMERAL } }] },
        { role: "user", content: [{ type: "text", text: "b", cache_control: { ...EPHEMERAL } }] },
      ],
    };
    injectAnthropicCacheBreakpoints(body);
    expect(countCacheBreakpoints(body)).toBe(4);
  });

  test("is idempotent — a second pass adds no breakpoints", () => {
    const body = sampleBody();
    injectAnthropicCacheBreakpoints(body);
    const after1 = countCacheBreakpoints(body);
    injectAnthropicCacheBreakpoints(body);
    expect(countCacheBreakpoints(body)).toBe(after1);
  });

  test("reclaims a wasted breakpoint on a small non-terminal system block", () => {
    const body: any = {
      system: [
        { type: "text", text: "small", cache_control: { ...EPHEMERAL } },
        { type: "text", text: "B".repeat(1000) },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    injectAnthropicCacheBreakpoints(body);
    // The sub-500-char breakpoint is stripped; the real cache lands on the big block.
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });
});

describe("stripIntermediateMessageBreakpoints", () => {
  test("clears breakpoints on middle turns, leaves first and last", () => {
    const body: any = {
      messages: [
        { role: "user", content: [{ type: "text", text: "0", cache_control: { ...EPHEMERAL } }] },
        { role: "assistant", content: [{ type: "text", text: "1", cache_control: { ...EPHEMERAL } }] },
        { role: "user", content: [{ type: "text", text: "2", cache_control: { ...EPHEMERAL } }] },
        { role: "assistant", content: [{ type: "text", text: "3", cache_control: { ...EPHEMERAL } }] },
      ],
    };
    const stripped = stripIntermediateMessageBreakpoints(body);
    expect(stripped).toBe(2);
    expect(body.messages[0].content[0].cache_control).toBeDefined();
    expect(body.messages[1].content[0].cache_control).toBeUndefined();
    expect(body.messages[2].content[0].cache_control).toBeUndefined();
    expect(body.messages[3].content[0].cache_control).toBeDefined();
  });
});

describe("injectAnthropicCacheBreakpoints — guards", () => {
  test("no-ops on a body with nothing cacheable", () => {
    for (const body of [null, undefined, {}, { messages: [] }]) {
      expect(injectAnthropicCacheBreakpoints(body as any).tag).toBe("none");
    }
  });
});

describe("ensureExtendedCacheBeta", () => {
  test("adds the flag when the header is absent", () => {
    expect(ensureExtendedCacheBeta(undefined)).toBe(EXTENDED_CACHE_TTL_BETA);
  });

  test("appends the flag, preserving existing betas", () => {
    const out = ensureExtendedCacheBeta("prompt-caching-2024-07-31");
    expect(out).toBe(`prompt-caching-2024-07-31,${EXTENDED_CACHE_TTL_BETA}`);
  });

  test("leaves a header that already declares the flag unchanged", () => {
    const existing = `foo, ${EXTENDED_CACHE_TTL_BETA}`;
    expect(ensureExtendedCacheBeta(existing)).toBe(existing);
  });
});

describe("loadCachingConfig — env override", () => {
  afterEach(() => {
    delete process.env.CLAUDISH_CACHE;
    delete process.env.CLAUDISH_CACHE_EXTENDED_TTL;
  });

  test("CLAUDISH_CACHE=1 enables injection regardless of the config file", () => {
    process.env.CLAUDISH_CACHE = "1";
    expect(loadCachingConfig().enabled).toBe(true);
  });

  test("CLAUDISH_CACHE_EXTENDED_TTL=1 opts into the 1h TTL", () => {
    process.env.CLAUDISH_CACHE = "1";
    process.env.CLAUDISH_CACHE_EXTENDED_TTL = "1";
    expect(loadCachingConfig().extendedTtl).toBe(true);
  });

  test("an unset env var does not force the flag on", () => {
    expect(loadCachingConfig().enabled).toBe(false);
  });
});

describe("stripAnthropicCacheBreakpoints", () => {
  test("removes every cache_control, including client-set ones", () => {
    const body: any = {
      tools: [{ name: "Read", cache_control: { ...EPHEMERAL } }],
      system: [{ type: "text", text: "s", cache_control: { ...EPHEMERAL } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { ...EPHEMERAL } }] },
      ],
    };
    expect(stripAnthropicCacheBreakpoints(body)).toBe(3);
    expect(countCacheBreakpoints(body)).toBe(0);
  });

  test("returns 0 when there is nothing to strip", () => {
    expect(stripAnthropicCacheBreakpoints({ messages: [] })).toBe(0);
  });
});

describe("injectAnthropicCacheBreakpoints — minCacheTokens gate", () => {
  test("skips a prefix below the floor", () => {
    const body: any = {
      system: "tiny",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    };
    expect(injectAnthropicCacheBreakpoints(body, { minCacheTokens: 1024 }).tag).toBe("below-min");
    expect(countCacheBreakpoints(body)).toBe(0);
  });

  test("injects once the prefix clears the floor", () => {
    const body = sampleBody();
    body.system = [{ type: "text", text: "S".repeat(6000) }]; // ~1500 est. tokens
    const { tag } = injectAnthropicCacheBreakpoints(body, { minCacheTokens: 1024 });
    expect(tag).not.toBe("below-min");
    expect(countCacheBreakpoints(body)).toBeGreaterThan(0);
  });

  test("no gate by default (minCacheTokens 0): a tiny prefix still injects", () => {
    const body: any = {
      system: [{ type: "text", text: "small" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    expect(injectAnthropicCacheBreakpoints(body).tag).not.toBe("below-min");
  });

  test("an exact prefixTokens overrides the char estimate for the gate", () => {
    // Large char prefix, but the caller's exact count is under the floor -> skip.
    const big = sampleBody();
    big.system = [{ type: "text", text: "S".repeat(8000) }];
    expect(
      injectAnthropicCacheBreakpoints(big, { minCacheTokens: 1024, prefixTokens: 500 }).tag
    ).toBe("below-min");
    // Tiny char prefix, but the exact count clears the floor -> inject.
    const small: any = {
      system: [{ type: "text", text: "s" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "user", content: [{ type: "text", text: "b" }] },
      ],
    };
    expect(
      injectAnthropicCacheBreakpoints(small, { minCacheTokens: 1024, prefixTokens: 2000 }).tag
    ).not.toBe("below-min");
  });
});
