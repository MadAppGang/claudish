/**
 * View items and a polling assertion for the herdr and view tests. Test-only.
 */

import type { ViewItem } from "../../pane/view-contract.js";

export function sessionItem(
  id: string,
  o: { state?: string; viewSocket?: string | null; model?: string } = {}
): ViewItem {
  return {
    kind: "session",
    target: `s:${id}`,
    session_id: id,
    slot: id,
    model: o.model ?? "cx@gpt-6",
    provider: null,
    state: o.state ?? "RUNNING",
    reason: null,
    reason_detail: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    tool_calls: 0,
    turns_completed: 0,
    last_activity_at: null,
    idle_seconds: null,
    activity: null,
    pane: null,
    recent: null,
    agent_requested: null,
    agent: null,
    task_type: null,
    view: null,
    started_at: "2026-11-10T00:00:00.000Z",
    completed_at: null,
    elapsed_seconds: 0,
    prompt_summary: "say hi",
    prompts_sent: 1,
    pending_inputs: 0,
    subagents: [],
    magmux: {
      pane_id: `c1-${id}`,
      view_socket: o.viewSocket === undefined ? `/tmp/magmux-${id}.view` : o.viewSocket,
    },
  } as ViewItem;
}

export function replayItem(id: string, final = false): ViewItem {
  return {
    kind: "replay",
    target: `r:${id}`,
    replay_id: id,
    of: { session_id: "s" },
    model: "cx@gpt-6",
    final,
    magmux: { pane_id: `c1-${id}`, view_socket: `/tmp/magmux-${id}.view` },
    view: null,
  };
}

/** Polls until `check` passes or `ms` runs out; the last failure is thrown. */
export async function eventually(check: () => void, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      check();
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
    await Bun.sleep(20);
  }
}
