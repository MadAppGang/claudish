/**
 * `claudish herdr rows`: the Agent sidebar rows that show a claudish viewer's model, activity and
 * token counts. Printed for the user to paste into their own herdr `config.toml`; claudish never
 * writes that file.
 *
 * herdr applies `rows_by_agent` only to its own canonical agent ids, never to a reported agent such
 * as `claudish`, so the rows go into the global `ui.sidebar.agents.rows`. A `$name` token a pane
 * does not report disappears with its separator, so other agents' rows are unchanged.
 */

import { SIDEBAR_TOKENS } from "./state-map.js";

const USAGE = [
  "usage: claudish herdr rows",
  "",
  "  rows   print herdr Agent sidebar rows showing each claudish viewer's model, activity and",
  "         tokens; paste them into herdr's config.toml (claudish does not edit it)",
  "",
].join("\n");

/** The TOML block, the default rows of herdr 0.9.5 plus one row of claudish tokens. */
export function sidebarRowsToml(): string {
  const tokens = SIDEBAR_TOKENS.map((t) => `"$${t}"`).join(", ");
  return [
    "[ui.sidebar.agents]",
    "rows = [",
    '  ["state_icon", "machine", "workspace", "tab"],',
    '  ["agent"],',
    `  [${tokens}],`,
    "]",
    "",
  ].join("\n");
}

export function herdrCommand(
  args: string[],
  out: (s: string) => void = (s) => process.stdout.write(s)
): number {
  const [sub, ...rest] = args;
  if (sub === "rows" && rest.length === 0) {
    out(sidebarRowsToml());
    return 0;
  }
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    out(USAGE);
    return sub === undefined ? 2 : 0;
  }
  process.stderr.write(USAGE);
  return 2;
}
