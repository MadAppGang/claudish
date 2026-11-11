import { afterEach, describe, expect, test } from "bun:test";
import { runRoutingContractChild } from "../test-helpers/routing-contract-child.js";
import { probeQueue, probeRowsFrom } from "../tui/hooks/useRouteProbe.js";
import { PROBE_HOP_ORIGIN_HEADER } from "./probe-hop-origin.js";
import { probeLink } from "./probe-live.js";
import { probeTargets } from "./probe-runner.js";
import type { RouteExplanation } from "./routing-rules.js";

describe("RB-2 RB-27: a probe proxy builds a routed hop only on the marker", () => {
  for (const [scenario, outcome] of [
    [
      "probe-routed",
      "probe proxy: a marked hop with no bundled connection tries the provider's APIs in turn",
    ],
    ["normal-routed", "a proxy serving Claude Code ignores the marker and refuses the spec"],
    ["probe-unmarked", "probe proxy: an unmarked explicit spec is still refused offline"],
  ]) {
    test(
      outcome!,
      () =>
        runRoutingContractChild(
          new URL("./test-helpers/probe-hop-origin-child.ts", import.meta.url).pathname,
          scenario!
        ),
      20_000
    );
  }
});

function kept(provider: string, wireId: string): RouteExplanation["candidates"][number] {
  return {
    provider,
    displayName: provider,
    modelSpec: `${provider}@${wireId}`,
    wireId,
    position: "candidate",
    tier: "dynamic-subscription",
    outcome: "kept",
  };
}

function explanation(source: "catalog" | "user-rule" | "explicit"): RouteExplanation {
  const requestedModel =
    source === "explicit" ? "opencode-zen-go@gemini-4-argon" : "gemini-4-argon";
  return {
    requestedModel,
    routedModel: "gemini-4-argon",
    source,
    ...(source === "explicit" ? { via: "model-spec" as const } : {}),
    ...(source === "user-rule"
      ? { matchedPattern: "gemini-*", ruleScope: "project" as const }
      : {}),
    candidates: [kept("opencode-zen-go", "gemini-4-argon")],
    outcome: { kind: "ok" },
    warnings: [],
  } as RouteExplanation;
}

describe("probe links carry whether the hop is routed", () => {
  test("probeTargets marks every hop of a bare name's routing chain, never an explicit spec", () => {
    expect(probeTargets(explanation("catalog")).map((t) => t.hopOrigin)).toEqual(["routed"]);
    expect(probeTargets(explanation("user-rule")).map((t) => t.hopOrigin)).toEqual(["routed"]);
    expect(probeTargets(explanation("explicit")).map((t) => t.hopOrigin)).toEqual([undefined]);
  });

  test("the TUI probe rows mark a routed chain's hops, never an explicit spec", () => {
    const routed = probeRowsFrom(explanation("catalog")).rows;
    expect(routed.map((row) => row.hopOrigin)).toEqual(["routed"]);
    expect(probeQueue(routed).map((item) => routed[item.index]!.hopOrigin)).toEqual(["routed"]);
    const typed = probeRowsFrom(explanation("explicit")).rows;
    expect(typed.map((row) => row.hopOrigin)).toEqual([undefined]);
  });
});

describe("probeLink sends the routed-hop marker only for a routed link", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  async function headerSent(hopOrigin: "routed" | undefined): Promise<string | null> {
    let seen: string | null | undefined;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        seen = req.headers.get(PROBE_HOP_ORIGIN_HEADER);
        return Response.json({ error: { message: "test proxy" } }, { status: 400 });
      },
    });
    await probeLink(
      `http://127.0.0.1:${server.port}`,
      {
        provider: "opencode-zen-go",
        modelSpec: "opencode-zen-go@gemini-4-argon",
        hasCredentials: true,
        ...(hopOrigin ? { hopOrigin } : {}),
      },
      5_000
    );
    expect(seen).not.toBeUndefined();
    return seen ?? null;
  }

  test("a routed link carries the marker", async () => {
    expect(await headerSent("routed")).toBe("routed");
  });

  test("a user-typed explicit spec carries no marker", async () => {
    expect(await headerSent(undefined)).toBeNull();
  });
});
