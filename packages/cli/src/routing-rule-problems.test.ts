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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeRoutingRuleProblem,
  routingRuleProblems,
} from "./providers/routing-rules.js";

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
