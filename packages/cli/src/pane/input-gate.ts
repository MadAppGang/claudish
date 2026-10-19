/**
 * magmux's input gate, translated (architecture-v2 §3.1, Revision 1).
 *
 * magmux 0.16 owns input readiness for a declared Claude Code pane: a gated `send` waits
 * for the box, types, verifies the box holds exactly the text, presses Enter and answers
 * once, when it has attributable evidence (magmux README "Claude Code panes: the input
 * gate"). Its reply vocabulary (codes, reasons, `typed`, `accept`, `evidence`,
 * `retypeCause`) is third-party; this module is the one place that reads it.
 *
 * Pure: no I/O, no clock, no policy. `classifySendReply` only TRANSLATES a reply into the
 * closed `SendOutcome` union; what to do about each outcome (retry, ctrl-u, fail) is the
 * admission loop's switch in `PaneSession`. Values copied from magmux v0.16.0 (4c6060c):
 * `protocol/sendbudget.go`, `protocol/reasons.go`, `mux/inputgate_send.go`. A pin bump
 * re-diffs those three, the two "unknown whether" strings, and the `list` binding fields.
 */

import type { MagmuxReply } from "./magmux-client.js";

// ── dialogs and readiness ────────────────────────────────────────────────────

/** The dialog kinds magmux names after `dialog:` (protocol/reasons.go). */
export type GateDialogKind =
  | "permission"
  | "question"
  | "plan"
  | "select"
  | "trust"
  | "bypass"
  | "api_key"
  | "onboarding";

const DIALOG_KINDS: ReadonlySet<string> = new Set<GateDialogKind>([
  "permission",
  "question",
  "plan",
  "select",
  "trust",
  "bypass",
  "api_key",
  "onboarding",
]);

/** Boot dialogs: questions for the human. claudish never accepts one and never Escapes one. */
export const BOOT_DIALOG_KINDS: ReadonlySet<GateDialogKind> = new Set<GateDialogKind>([
  "trust",
  "bypass",
  "api_key",
  "onboarding",
]);

const DIALOG_PREFIX = "dialog:";

/** `dialog:<kind>` → the kind; null for any other reason and for a kind magmux added later. */
export function dialogKindOf(reason: string | null | undefined): GateDialogKind | null {
  if (!reason?.startsWith(DIALOG_PREFIX)) return null;
  const kind = reason.slice(DIALOG_PREFIX.length);
  return DIALOG_KINDS.has(kind) ? (kind as GateDialogKind) : null;
}

/**
 * One reading of `list` → pane 0's `input`, the gate's published view (refreshed at 4 Hz,
 * advisory: every send decides on its own fresh reads). The view is computed with
 * `Types: true` (controller_claude.go:411), so `ready` already means the box is EMPTY and
 * `reason === "box_not_empty"` means it holds text with nothing else in the way.
 * `boxHasText` and `dismissable` are undocumented and `omitempty`; they are not read
 * (R1.5.1).
 */
export interface GateInput {
  ready: boolean;
  /**
   * `starting` | `terminal_not_ready` | `no_input_box` | `box_not_empty` | `vim_mode` |
   * `dialog:<kind>` | `typing_in_progress`, raw; null when ready (magmux omits it).
   */
  reason: string | null;
  /** parsed from `dialog:<kind>`; an unknown kind is null and `reason` keeps the raw value */
  dialog: GateDialogKind | null;
  detail: string | null;
  /** the caller's clock at the `list` reply */
  receivedAt: number;
}

/** How magmux bound pane 0 to a transcript. `unbound`: the field is absent or unknown. */
export type GateBindingKind = "named" | "prompt" | "mtime" | "unbound";

/**
 * Pane 0's transcript binding as `list` echoes it (R1.0, requested of magmux as M12).
 * v0.16.0 publishes none of these fields, so every 0.16.0 pane reads `unbound`, which the
 * binding check (commit 3) refuses.
 */
export interface GateBinding {
  bound: GateBindingKind;
  /** the `bound` value as sent, for the `input_gate_unbound` detail; null when absent */
  boundRaw: string | null;
  sessionId: string | null;
  transcriptPath: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Pane 0's row of a `list` (or `results`) result. Found by its `pane` field: ids are sparse. */
function paneZero(listResult: unknown): Record<string, unknown> | null {
  const panes = record(listResult)?.panes;
  if (!Array.isArray(panes)) return null;
  for (const p of panes) {
    const row = record(p);
    if (row?.pane === 0) return row;
  }
  return null;
}

/** null: no pane 0, or pane 0 is not gated (magmux omits `input` then). */
export function parseGateInput(listResult: unknown, now: number): GateInput | null {
  const input = record(paneZero(listResult)?.input);
  if (!input || typeof input.ready !== "boolean") return null;
  const reason = input.ready ? null : str(input.reason);
  return {
    ready: input.ready,
    reason,
    dialog: dialogKindOf(reason),
    detail: str(input.detail),
    receivedAt: now,
  };
}

/** Why pane 0 is gated: `direct` (a visible `claude` launch), `declared` (`--controller`); null: not gated. */
export function gateBasisOf(listResult: unknown): "direct" | "declared" | null {
  const basis = paneZero(listResult)?.gateBasis;
  return basis === "direct" || basis === "declared" ? basis : null;
}

/** null: no pane 0. Otherwise the binding, `unbound` when magmux published no binding. */
export function parseGateBinding(listResult: unknown): GateBinding | null {
  const row = paneZero(listResult);
  if (!row) return null;
  const boundRaw = str(row.bound);
  const bound: GateBindingKind =
    boundRaw === "named" || boundRaw === "prompt" || boundRaw === "mtime" ? boundRaw : "unbound";
  return {
    bound,
    boundRaw,
    sessionId: str(row.sessionId),
    transcriptPath: str(row.transcriptPath),
  };
}

// ── the send reply ───────────────────────────────────────────────────────────

/** `not_accepted` reasons. `text_mismatch`/`empty_box`: Enter NOT pressed; the other two: it was. */
export type NotAcceptedReason = "text_mismatch" | "empty_box" | "still_in_box" | "unconfirmed";

/** The loss signal behind magmux's one automatic retype (inputgate_send.go:67-78). */
export type RetypeCause = "terminal_reset" | "never_drawn";

/**
 * The phrase both "it is unknown whether the text was submitted" `text_mismatch` details
 * carry (inputgate_send.go:884 leftBox, :893 convMoved). magmux 0.17.0 answers M11 with the
 * machine field `maybeSubmitted: true` on both; this prose is read only for a reply that
 * lacks the field.
 */
export const MAYBE_SUBMITTED_MARKER = "check the conversation before sending";

/**
 * Every gated-send reply, closed (§3.1 as revised by R1.1-R1.3).
 *
 * - `accepted`: Enter was pressed, by magmux (`enterByMagmux`) or, for
 *   `submitted_by_other`, by another writer, and evidence appeared. `evidence:
 *   "transcript"` is not attributable to this pane until the binding check passes (§5.6).
 * - `in_box`: a TYPE send (no Enter) verified in the box.
 * - `busy`: Enter NOT pressed. `typed`: the text (or part) may be in the box.
 * - `not_accepted`: `maybeSubmitted` only on the two "unknown whether" `text_mismatch`
 *   variants (R1.3); `typed` as magmux reported it.
 * - `bad_request`: nothing written.
 * - `reply_lost`: written; the delivery carries on and its outcome is unknown.
 * - `unsent`: never written.
 * - `pane_gone`: the pane is dead or closed; `typed` if it died partway through the send.
 * - `unexpected`: any other code, or an `ok` this module cannot read (an ungated reply,
 *   an unknown `accept`, an accept with no evidence).
 */
export type SendOutcome =
  | {
      kind: "accepted";
      accept: "confirmed" | "resent_enter" | "submitted_by_other";
      evidence: "history" | "transcript";
      /** the reply's `enter`: on a gated reply, whether MAGMUX pressed Enter */
      enterByMagmux: boolean;
      retyped: boolean;
      /** null iff not retyped; `unknown` for a retype with an absent or unrecognised cause */
      retypeCause: RetypeCause | "unknown" | null;
      dismissed: string[];
      waitedMs: number;
      verified: string | null;
    }
  | {
      kind: "in_box";
      retyped: boolean;
      retypeCause: RetypeCause | "unknown" | null;
      waitedMs: number;
      verified: string | null;
    }
  | { kind: "busy"; reason: string; dialog: GateDialogKind | null; typed: boolean }
  | {
      kind: "not_accepted";
      reason: NotAcceptedReason;
      maybeSubmitted: boolean;
      typed: boolean;
      detail: string;
    }
  | { kind: "bad_request"; error: string }
  | { kind: "reply_lost"; code: "client_timeout" | "client_lost" | "timeout" }
  | { kind: "unsent"; code: "client_closed" | "no_client" }
  | { kind: "pane_gone"; code: "pane_dead" | "no_such_pane"; typed: boolean }
  | { kind: "unexpected"; code: string; error: string };

export type SendOutcomeKind = SendOutcome["kind"];

/** Exhaustiveness check for a `switch` over a closed union. */
export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

function retypeOf(result: Record<string, unknown>): {
  retyped: boolean;
  retypeCause: RetypeCause | "unknown" | null;
} {
  if (result.retyped !== true) return { retyped: false, retypeCause: null };
  const cause = result.retypeCause;
  return {
    retyped: true,
    retypeCause: cause === "terminal_reset" || cause === "never_drawn" ? cause : "unknown",
  };
}

function okOutcome(result: Record<string, unknown>): SendOutcome {
  const { retyped, retypeCause } = retypeOf(result);
  const waitedMs = typeof result.waitedMs === "number" ? result.waitedMs : 0;
  const verified = str(result.verified);
  const accept = result.accept;
  if (accept === "in_box") return { kind: "in_box", retyped, retypeCause, waitedMs, verified };
  if (accept === undefined) {
    return {
      kind: "unexpected",
      code: "ungated_reply",
      error: "ok with no accept: the pane is not gated",
    };
  }
  if (accept !== "confirmed" && accept !== "resent_enter" && accept !== "submitted_by_other") {
    return {
      kind: "unexpected",
      code: "unknown_accept",
      error: `accept ${JSON.stringify(accept)}`,
    };
  }
  const evidence = result.evidence;
  if (evidence !== "history" && evidence !== "transcript") {
    return {
      kind: "unexpected",
      code: "unknown_evidence",
      error: `accept ${accept} with evidence ${JSON.stringify(evidence)}`,
    };
  }
  const dismissed = Array.isArray(result.dismissed)
    ? result.dismissed.filter((d): d is string => typeof d === "string")
    : [];
  return {
    kind: "accepted",
    accept,
    evidence,
    enterByMagmux: result.enter === true,
    retyped,
    retypeCause,
    dismissed,
    waitedMs,
    verified,
  };
}

function notAcceptedOutcome(r: Extract<MagmuxReply, { ok: false }>): SendOutcome {
  const typed = r.typed === true;
  switch (r.reason) {
    case "text_mismatch":
      return {
        kind: "not_accepted",
        reason: "text_mismatch",
        // The field is the contract (magmux 0.17.0, M11). The text match is a fallback for a
        // reply without the field, so a magmux that predates it is not read as "not submitted".
        maybeSubmitted: r.maybeSubmitted === true || r.error.includes(MAYBE_SUBMITTED_MARKER),
        typed,
        detail: r.error,
      };
    case "empty_box":
    case "still_in_box":
    case "unconfirmed":
      return {
        kind: "not_accepted",
        reason: r.reason,
        maybeSubmitted: false,
        typed,
        detail: r.error,
      };
    default:
      // Whether Enter was pressed is unknown for a reason this module has never seen.
      return {
        kind: "unexpected",
        code: `not_accepted:${r.reason ?? ""}`,
        error: r.error,
      };
  }
}

/** One reply to a gated `send` → claudish's outcome. Translation only; no policy. */
export function classifySendReply(r: MagmuxReply): SendOutcome {
  if (r.ok) return okOutcome(record(r.result) ?? {});
  switch (r.code) {
    case "busy": {
      // An unknown reason stays `busy` with the raw value: Enter was not pressed either way.
      const reason = r.reason ?? "";
      return { kind: "busy", reason, dialog: dialogKindOf(reason), typed: r.typed === true };
    }
    case "not_accepted":
      return notAcceptedOutcome(r);
    case "bad_request":
      return { kind: "bad_request", error: r.error };
    case "client_timeout":
    case "client_lost":
    case "timeout":
      return { kind: "reply_lost", code: r.code };
    case "client_closed":
    case "no_client":
      return { kind: "unsent", code: r.code };
    case "pane_dead":
    case "no_such_pane":
      return { kind: "pane_gone", code: r.code, typed: r.typed === true };
    default:
      return { kind: "unexpected", code: r.code, error: r.error };
  }
}

// ── how long a gated send can take (protocol.SendBudget at 4c6060c) ──────────

export const SEND_READY_WAIT_DEFAULT_MS = 10_000;
export const SEND_READY_WAIT_MAX_MS = 60_000;
const SEND_TYPED_CHUNK_RUNES = 32;
const SEND_TYPED_CHUNK_GAP_MS = 8;
const SEND_KEY_GAP_MS = 20;
const SEND_SETTLE_MS = 150;
/** The verify's minimum window, which the `readyTimeoutMs` deadline never cuts. */
const SEND_VERIFY_MIN_MS = 1_200;
const SEND_VERIFY_STEP_MS = 40;
const SEND_GATE_CHECK_COST_MS = 2;
const SEND_ACCEPT_WINDOW_MS = 2_000;
const SEND_ACCEPT_WINDOWS = 3;
const SEND_BUDGET_SLACK_MS = 2_000;

/** `readyTimeoutMs` → the readiness deadline: ≤ 0 is the default, above the max is clamped. */
export function readyWaitMs(readyTimeoutMs: number): number {
  if (readyTimeoutMs <= 0) return SEND_READY_WAIT_DEFAULT_MS;
  return Math.min(readyTimeoutMs, SEND_READY_WAIT_MAX_MS);
}

/** Writes a typed send makes: runs of ≤ 32 runes, and one per newline (`\n`, `\r\n`, `\r`). */
export function typedWriteCount(text: string): number {
  const rs = Array.from(text);
  let n = 0;
  let run = 0;
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    if (r === "\r" || r === "\n") {
      if (r === "\r" && rs[i + 1] === "\n") i++;
      if (run > 0) {
        n++;
        run = 0;
      }
      n++;
    } else {
      run++;
      if (run === SEND_TYPED_CHUNK_RUNES) {
        n++;
        run = 0;
      }
    }
  }
  return run > 0 ? n + 1 : n;
}

/**
 * magmux's upper bound on one gated send, from when it starts running: the readiness wait
 * once, the per-attempt typing + settle + minimum verify + one late verify read twice (for
 * the one retype), and the three acceptance windows for a submit. `keys` counts named keys,
 * a final Enter key included (an upper bound either way). `typed` defaults to true:
 * every claudish send is typed (R1.2), and only the Go test table needs it false.
 * Drift from magmux is safe in direction: an under-estimate becomes `reply_lost`, never a
 * second copy.
 */
export function sendBudgetMs(s: {
  readyTimeoutMs: number;
  text: string;
  keys: number;
  submit: boolean;
  typed?: boolean;
}): number {
  let attempt = 0;
  if (s.typed ?? true)
    attempt += typedWriteCount(s.text) * (SEND_TYPED_CHUNK_GAP_MS + SEND_GATE_CHECK_COST_MS);
  attempt += s.keys * (SEND_KEY_GAP_MS + SEND_GATE_CHECK_COST_MS);
  attempt += SEND_SETTLE_MS + SEND_VERIFY_MIN_MS + SEND_VERIFY_STEP_MS;
  const accept = s.submit ? SEND_ACCEPT_WINDOWS * SEND_ACCEPT_WINDOW_MS : 0;
  return readyWaitMs(s.readyTimeoutMs) + 2 * attempt + accept + SEND_BUDGET_SLACK_MS;
}
