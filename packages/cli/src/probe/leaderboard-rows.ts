/**
 * The Leaderboard's rows, for the static printer and the probe TUI alike.
 *
 * The Leaderboard ranks ROUTES, not models: every link that probed live and
 * came back with timing is its own row, so the routes of one model sit beside
 * each other (the Claude API beside OpenRouter for the same Claude model, three
 * live hops of a routed `gpt-*`). Rows are sorted by total time across every
 * model, fastest first.
 *
 * A model with no ranked row is still listed, once, unranked: `no live route`
 * when it has a link, `no route` when it has none. A model whose chain carries
 * the Claude subscription's not-probed link gets one more unranked row naming
 * it, also when other routes of that model are ranked: the route a launch of
 * the name takes is never silently missing from the comparison.
 *
 * Pure: the two renderers map their own link shapes onto these inputs.
 */
import type { ProbeTiming } from "../providers/probe-live.js";

/** One link of a model's chain, as the Leaderboard reads it. */
export interface LeaderboardLinkInput {
  displayName: string;
  probe?: { state: string; timing?: ProbeTiming };
  notProbed?: "native-auth";
  comparison?: true;
}

/** One model and its links, in chain order. */
export interface LeaderboardModelInput {
  model: string;
  links: LeaderboardLinkInput[];
  /** What a model with no link at all is listed under (its explanation line). */
  emptyLabel?: string;
}

export interface LeaderboardRow {
  model: string;
  /** The link's display name. */
  provider: string;
  /** Present exactly when the row is ranked. */
  timing?: ProbeTiming;
  /** The first live, timed link of the ROUTING chain: the route a request uses. */
  representative?: true;
  missing?: "no live route" | "no route" | "not probed (Claude subscription)";
}

/** Ranked rows ascending by total time (stable); unranked rows per model, in input order. */
export function leaderboardRows(models: LeaderboardModelInput[]): {
  ranked: LeaderboardRow[];
  unranked: LeaderboardRow[];
} {
  const ranked: LeaderboardRow[] = [];
  const unranked: LeaderboardRow[] = [];
  for (const { model, links, emptyLabel } of models) {
    let representativeTaken = false;
    let rankedHere = 0;
    for (const link of links) {
      const timing = link.probe?.state === "live" ? link.probe.timing : undefined;
      if (!timing) continue;
      const representative = !link.comparison && !link.notProbed && !representativeTaken;
      if (representative) representativeTaken = true;
      ranked.push({
        model,
        provider: link.displayName,
        timing,
        ...(representative ? { representative: true as const } : {}),
      });
      rankedHere++;
    }
    const subscription = links.find((link) => link.notProbed === "native-auth");
    if (subscription) {
      unranked.push({
        model,
        provider: subscription.displayName,
        missing: "not probed (Claude subscription)",
      });
    }
    if (rankedHere === 0 && !subscription) {
      const first = links[0];
      unranked.push({
        model,
        provider: first?.displayName ?? emptyLabel ?? "",
        missing: first ? "no live route" : "no route",
      });
    }
  }
  // Array.prototype.sort is stable, so equal totals keep their input order.
  ranked.sort((a, b) => (a.timing?.totalMs ?? 0) - (b.timing?.totalMs ?? 0));
  return { ranked, unranked };
}
