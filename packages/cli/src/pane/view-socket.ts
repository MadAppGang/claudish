/**
 * The read-only view socket magmux can serve beside a pane's control socket, and the one check
 * that decides whether claudish tells anybody its path.
 *
 * A path is published only after both halves agree: the control socket names exactly the path
 * claudish derives for this pane, and a dial of that path answers `readOnly: true`. Any other
 * outcome leaves the pane running with no published path.
 */

import { MagmuxClient } from "./magmux-client.js";
import { viewSockPathOf } from "./process-identity.js";

/**
 * Whether claudish starts panes with a view socket. While false no pane has one, attach runs no
 * check, and every snapshot reports `viewSockPath: null`.
 */
export const PANES_SERVE_VIEW_SOCKET: boolean = false;

const VIEW_PROBE_MS = 2_000;

export type ViewSocketCheck = { ok: true; path: string } | { ok: false; detail: string };

/** What attach read from the control socket's `capabilities`, or nothing when that failed. */
export interface ControlCapabilities {
  viewSocket?: unknown;
}

/**
 * The two-socket check, run at every attach. The dial is a plain connect, never a `chdir`: an MCP
 * server resolves relative paths and spawns children concurrently, so a path too long for
 * `sun_path` reads as unverified here.
 */
export async function verifyViewSocket(
  caps: ControlCapabilities | null,
  root: string,
  paneId: string,
  dial: (path: string) => Promise<MagmuxClient> = (p) => MagmuxClient.dial(p)
): Promise<ViewSocketCheck> {
  const expected = viewSockPathOf(root, paneId);
  if (caps?.viewSocket !== expected)
    return {
      ok: false,
      detail: `the control socket reports view socket ${JSON.stringify(caps?.viewSocket ?? null)}`,
    };
  let client: MagmuxClient;
  try {
    client = await dial(expected);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    const reply = await client.request<{ readOnly?: unknown }>(
      { type: "capabilities" },
      VIEW_PROBE_MS
    );
    if (!reply.ok) return { ok: false, detail: `${reply.code}: ${reply.error}` };
    if (reply.result.readOnly !== true) return { ok: false, detail: "the socket is not read-only" };
    return { ok: true, path: expected };
  } finally {
    client.close();
  }
}
