/**
 * Which terminal front end this process runs in, from its environment only.
 *
 * herdr terminal: `TERM_PROGRAM=herdr` with `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` and `HERDR_ENV=1`.
 * herdr-core (Herdr.app): `HC_TERMINAL_ID`. Anything else is a plain terminal.
 *
 * The markers leak across products (herdr does not remove `HC_*`, hc does not remove `HERDR_*`), so
 * herdr wins only on `TERM_PROGRAM`, which hc rewrites. tmux inside herdr rewrites `TERM_PROGRAM`
 * too, which is what `CLAUDISH_HERDR=1` is for: it forces herdr when the three `HERDR_*` variables
 * are set. `CLAUDISH_HERDR=0` turns both herdr front ends off.
 */

import type { ViewFrontEnd } from "../pane/view-contract.js";

type Env = Readonly<Record<string, string | undefined>>;

/** What a process inside a herdr pane knows about its pane. */
export interface HerdrPaneEnv {
  socketPath: string;
  paneId: string;
}

function herdrVars(env: Env): HerdrPaneEnv | null {
  const socketPath = env.HERDR_SOCKET_PATH?.trim();
  const paneId = env.HERDR_PANE_ID?.trim();
  if (!socketPath || !paneId || env.HERDR_ENV !== "1") return null;
  return { socketPath, paneId };
}

export function detectFrontEnd(env: Env = process.env): ViewFrontEnd {
  const forced = env.CLAUDISH_HERDR?.trim();
  if (forced === "0") return "none";
  const vars = herdrVars(env);
  if (vars && (env.TERM_PROGRAM === "herdr" || forced === "1")) return "herdr";
  if (env.HC_TERMINAL_ID?.trim()) return "herdr-core";
  return "none";
}

/** The herdr pane this process runs in, only when the front end is herdr. */
export function herdrPaneEnv(env: Env = process.env): HerdrPaneEnv | null {
  return detectFrontEnd(env) === "herdr" ? herdrVars(env) : null;
}
