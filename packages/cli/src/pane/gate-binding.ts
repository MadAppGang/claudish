/**
 * The binding check (architecture-v2 R1.0): claudish trusts magmux's input gate for a pane
 * only when magmux bound that pane to claudish's OWN transcript.
 *
 * A pane is launched declared (`--controller claude-code --session-id <uuid> --transcript
 * <path>`, magmux >= 0.17.0), so magmux claims exactly that file and never runs its mtime
 * discovery, which could otherwise lock onto the parent's or a sibling's session. This
 * module reads one `list` reply and says whether pane 0 is gated and bound by name to the
 * same session id and the same path claudish's transcript follower reads.
 *
 * `transcriptSeen: false` is normal before the first prompt (Claude Code writes no
 * transcript until then) and is not read here.
 *
 * Pure apart from `realpathSync` on the path's existing ancestors.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gateBasisOf, parseGateBinding, parseGateInput } from "./input-gate.js";

export type GateBindingCheck = { ok: true } | { ok: false; detail: string };

/**
 * `p` made absolute, with its deepest EXISTING ancestor realpath-resolved and the rest
 * appended as written: the transcript file, and often its `projects/<slug>` directory, do
 * not exist before the first prompt, and `/var` vs `/private/var` must still compare equal.
 */
export function normaliseTranscriptPath(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return tail.length ? join(realpathSync(cur), ...tail.reverse()) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * One `list` result → whether pane 0's gate may be trusted for this session. Fails with
 * `input_gate_unavailable` when pane 0 is not gated as a declared pane, and with
 * `input_gate_unbound` when the binding is not by name, or names another session or path.
 */
export function checkGateBinding(
  listResult: unknown,
  expected: { sessionUuid: string; transcriptPath: string; magmuxVersion: string }
): GateBindingCheck {
  const v = expected.magmuxVersion || "?";
  const basis = gateBasisOf(listResult);
  if (basis !== "declared" || !parseGateInput(listResult, 0)) {
    return {
      ok: false,
      detail: `input_gate_unavailable: magmux ${v} did not gate pane 0 (gateBasis ${basis ?? "none"})`,
    };
  }
  const b = parseGateBinding(listResult);
  const ours = normaliseTranscriptPath(expected.transcriptPath);
  const theirs = b?.transcriptPath ? normaliseTranscriptPath(b.transcriptPath) : null;
  const differs: string[] = [];
  if (b?.bound !== "named") differs.push(`bound ${b?.boundRaw ?? "none"}`);
  if (b?.sessionId !== expected.sessionUuid)
    differs.push(`sessionId ${b?.sessionId ?? "none"}, not ${expected.sessionUuid}`);
  if (theirs !== ours) differs.push(`transcriptPath ${theirs ?? "none"}, not ${ours}`);
  if (differs.length === 0) return { ok: true };
  return {
    ok: false,
    detail: `input_gate_unbound: magmux ${v} bound pane 0 to ${theirs ?? "none"} (${b?.boundRaw ?? "none"}), not ${ours}: ${differs.join("; ")}`,
  };
}
