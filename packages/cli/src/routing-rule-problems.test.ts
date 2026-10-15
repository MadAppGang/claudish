/**
 * Pins for routingRuleProblems (upstream 5af1bf3f, feature-ported): rule
 * problems are PURE (read nothing, print nothing) and the proxy prints them
 * once at startup through logStderr.
 *
 * Port note (écart from upstream): upstream also reports case-collisions —
 * their matchRoutingRuleKey compares keys case-INSENSITIVELY, so two keys
 * differing only in case silently shadow each other. Our matchRoutingRule is
 * case-sensitive (exact object lookup, case-sensitive globMatch), so two
 * casings are two live rules and that warning would be false here. Not ported.
 *
 * Run: bun test packages/cli/src/routing-rule-problems.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeRoutingRuleProblem,
  routingRuleProblems,
} from "./providers/routing-rules.js";
import {
  clearRuntimeRegistry,
  registerRuntimeProvider,
} from "./providers/runtime-providers.js";

afterEach(() => {
  clearRuntimeRegistry();
});

describe("routingRuleProblems (upstream 5af1bf3f)", () => {
  test("multi-wildcard patterns are reported per file, with their scope", () => {
    const problems = routingRuleProblems({
      globalRules: { "gpt-*-*": ["openrouter"], "kimi-*": ["moonshot"] },
      localRules: { "claude-*-sonnet-*": ["native-anthropic"] },
    });
    expect(problems).toEqual([
      { scope: "global", pattern: "gpt-*-*", problem: "multiple-wildcards" },
      { scope: "project", pattern: "claude-*-sonnet-*", problem: "multiple-wildcards" },
    ]);
  });

  test("catch-all and single-wildcard keys are exempt; empty tables are clean", () => {
    expect(
      routingRuleProblems({
        globalRules: { "*": [], "kimi-*": ["moonshot"], "gpt-4o": ["openrouter"] },
        localRules: {},
      })
    ).toEqual([]);
  });

  test("an empty chain is not a problem — explicit no-route", () => {
    expect(routingRuleProblems({ globalRules: { "mistral-*": [] }, localRules: {} })).toEqual([]);
  });

  test("describeRoutingRuleProblem: one line, no [claudish] prefix (logStderr adds it)", () => {
    const line = describeRoutingRuleProblem({
      scope: "global",
      pattern: "gpt-*-*",
      problem: "multiple-wildcards",
    });
    expect(line).toBe(
      'routing pattern "gpt-*-*" (global) has more than one * — only a single * is supported, so it may not match as expected.'
    );
    expect(line.startsWith("[claudish]")).toBe(false);
  });
});

describe("unknown-provider (upstream 8a23cf3e)", () => {
  test("an entry naming a provider claudish does not know is reported", () => {
    const problems = routingRuleProblems({
      globalRules: { "my-model": ["typo@my-model"] },
      localRules: {},
    });
    expect(problems).toEqual([
      { scope: "global", pattern: "my-model", problem: "unknown-provider", entry: "typo@my-model" },
    ]);
  });

  test("shortcuts are resolved before the lookup (or@ -> openrouter is known)", () => {
    expect(
      routingRuleProblems({ globalRules: { "gpt-*": ["or@openai/gpt-4o"] }, localRules: {} })
    ).toEqual([]);
  });

  test("a runtime-registered custom endpoint is known — not a typo", () => {
    // isKnownProvider only consults the registry key; a name-only def is the
    // minimal honest fixture for that lookup.
    registerRuntimeProvider({ name: "vllm-myia" } as Parameters<
      typeof registerRuntimeProvider
    >[0]);
    expect(
      routingRuleProblems({
        globalRules: { "local-coding": ["vllm-myia@qwen3.6-35b-a3b"] },
        localRules: {},
      })
    ).toEqual([]);
  });

  test("a bare builtin entry is known", () => {
    expect(
      routingRuleProblems({ globalRules: { "kimi-*": ["moonshot"] }, localRules: {} })
    ).toEqual([]);
  });

  test("describeRoutingRuleProblem names the entry and the resolved provider", () => {
    const line = describeRoutingRuleProblem({
      scope: "project",
      pattern: "my-model",
      problem: "unknown-provider",
      entry: "typo@my-model",
    });
    expect(line).toBe(
      'routing rule "my-model" (project) names "typo@my-model", but no provider "typo" exists, so that entry never routes.'
    );
    expect(line.startsWith("[claudish]")).toBe(false);
  });
});

// --- structural pins ---------------------------------------------------------

const ROUTING_RULES_SOURCE = readFileSync(
  join(import.meta.dir, "providers", "routing-rules.ts"),
  "utf-8"
);
const PROXY_SOURCE = readFileSync(join(import.meta.dir, "proxy-server.ts"), "utf-8");

describe("silence on the load path (upstream 5af1bf3f)", () => {
  test("routing-rules.ts writes nothing to stderr — no console.error anywhere", () => {
    // The old validateRoutingRules console.error'd on every load, including
    // per-request via route() → loadRoutingRules() and inside TUIs, tearing
    // frames mid-draw. This file stays silent; the proxy reports instead.
    expect(ROUTING_RULES_SOURCE).not.toMatch(/console\.error/);
  });

  test("the proxy prints each problem once at startup, through logStderr", () => {
    expect(PROXY_SOURCE).toContain(
      "for (const problem of routingRuleProblems(routingRuleSources))"
    );
    expect(PROXY_SOURCE).toMatch(
      /logStderr\(`Warning: \$\{describeRoutingRuleProblem\(problem\)\}`\);/
    );
  });
});
