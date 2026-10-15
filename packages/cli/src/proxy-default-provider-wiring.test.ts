/**
 * Structural pin — the proxy passes the resolved default provider to every
 * route() call (upstream 9f8364f5).
 *
 * Why structural: route() with a rules override and NO default override reads
 * no default provider at all (routing-rules.ts guard keeps the host machine's
 * config out of unit tests). The proxy holds a rules snapshot, so until the
 * fix its three route() call sites appended NO fallback hop — whatever
 * `defaultProvider` said, disk config included. A behavioral proxy test would
 * need a hermetic child with a fixture catalog; this pin locks the wiring
 * itself, and its mutation proof (dropping the third argument at any call
 * site) is the exact regression it exists to catch.
 *
 * Run: bun test packages/cli/src/proxy-default-provider-wiring.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "proxy-server.ts"), "utf-8");

describe("proxy wiring — default provider reaches route() (upstream 9f8364f5)", () => {
  test("the fallback hop is resolved beside the rules snapshot", () => {
    expect(SOURCE).toContain("const effectiveFallbackProvider = effectiveDefaultProvider();");
    expect(SOURCE).toContain("effectiveDefaultProvider,");
  });

  test("every route() call site inside the proxy passes the fallback hop", () => {
    const wired = SOURCE.match(/route\((?:decision\.routeModel|parsedForFallback\.model), effectiveRoutingRules, effectiveFallbackProvider\)/g) ?? [];
    const bare = SOURCE.match(/route\((?:decision\.routeModel|parsedForFallback\.model), effectiveRoutingRules\)/g) ?? [];
    // 2× bucket classifiers (nominalBucketOfModel, concreteStepBucketOf) +
    // 1× the serving path — the exact sites measured pre-fix.
    expect(wired.length).toBe(3);
    expect(bare.length).toBe(0);
  });
});
