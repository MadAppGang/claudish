/** @jsxImportSource @opentui/react */
/**
 * The probe TUI's Leaderboard tab, rendered: its PROVIDER column is as wide as
 * the longest route name it shows, so no display name is cut while the
 * terminal has room for it, and a name the terminal cannot fit ends in an
 * ellipsis rather than mid-word.
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ProbeTiming } from "../providers/probe-live.js";
import { ProbeApp, type ProbeModelResult, ProbeStore } from "./probe-tui-app.js";

const timing: ProbeTiming = {
  ttfbMs: 800,
  ttftMs: 1100,
  totalMs: 1400,
  tokens: 90,
  tokensPerSec: 300,
};

function result(subscriptionName: string): ProbeModelResult {
  return {
    model: "claude-haiku-5-5",
    isExplicit: false,
    routingSource: "native",
    routingExplanation: "native · Claude Code's own auth · not probed",
    links: [
      {
        provider: "native-anthropic",
        displayName: subscriptionName,
        modelId: "claude-haiku-5-5",
        hasCredentials: true,
        notProbed: "native-auth",
      },
      {
        provider: "anthropic",
        displayName: "Claude API",
        modelId: "claude-haiku-5-5",
        hasCredentials: true,
        comparison: true,
        probe: { state: "live", latencyMs: timing.totalMs, timing },
      },
    ],
  };
}

/** Always destroy in `finally`: a leaked renderer keeps native threads alive and hangs `bun test`. */
async function leaderboardFrame(subscriptionName: string, width: number): Promise<string> {
  const store = new ProbeStore({
    steps: [],
    links: [],
    phase: "done",
    results: [result(subscriptionName)],
    activeTab: "leaderboard",
  });
  const { renderOnce, captureCharFrame, renderer } = await testRender(<ProbeApp store={store} />, {
    width,
    height: 30,
  });
  try {
    await renderOnce();
    return captureCharFrame();
  } finally {
    renderer.destroy();
  }
}

function unrankedRow(frame: string): string {
  const row = frame.split("\n").find((line) => line.includes("— not probed"));
  expect(row).toBeDefined();
  return row ?? "";
}

test("the PROVIDER column shows the full name 'Claude subscription'", async () => {
  const row = unrankedRow(await leaderboardFrame("Claude subscription", 120));

  expect(row).toContain("Claude subscription — not probed (Claude subscription)");
});

test("the PROVIDER column widens to the longest route name the rows show", async () => {
  const longName = "Claude subscription on a very long route name";
  const row = unrankedRow(await leaderboardFrame(longName, 160));

  expect(row).toContain(`${longName} — not probed`);
});

test("a route name wider than the terminal leaves room for ends in an ellipsis", async () => {
  const longName = `Claude subscription ${"x".repeat(80)}`;
  const row = unrankedRow(await leaderboardFrame(longName, 100));

  expect(row).toMatch(/Claude subscription x+… — not probed/);
});
