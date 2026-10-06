## 8. Mod contract (frozen)

> Paste-ready for the peer session `claudish-mcp-feedback`. Contract version **1**, shipping in the claudish
> release that lands this migration (minor bump: **[amended r-base]** 10.5.0 if the session-records release
> 10.4.0 ships on its own first, else 10.4.0; §20.6). Amendments to the peer's original spec are
> marked **[amended]**; changes made by plan revision 2 are marked **[amended r2]** (one new failure reason,
> one new `activity` value, `run_id` addressing any retained run, wording fixes, two error codes that no
> verb below emits removed).

### Reaching claudish

- **Server name for `$.mcp.call`.** `plugin:claudish:claudish` when claudish is installed through the magus
  `claudish` plugin (tools appear as `mcp__plugin_claudish_claudish__<tool>`); `claudish` when registered
  directly under that key in `.mcp.json` / `~/.claude.json` (tools appear as `mcp__claudish__<tool>`). The
  general rule is `plugin:<plugin-name>:<server-key>`. Try `plugin:claudish:claudish` first, then `claudish`.
- **Envelope.** Every tool returns `content: [{ "type": "text", "text": "<JSON>" }]`. Parse `text`. Errors
  from the verbs below arrive with `isError: true` and `text` = the `ContractError` JSON (§E).
- **Detecting the contract [amended, CA-12].** `team(mode="list")`, `team(mode="status")` and `list_sessions`
  answers carry `contract_version: 1` and `capabilities`. A pre-contract claudish (≤ 10.3.0, or 10.4.x when
  10.4.0 ships on its own **[amended r-base]**) answers
  `team(mode="list")` with `isError: true` and text `Error: Unknown mode: list`, and `capture_session` with
  `Error: Unknown tool "capture_session"`; its `status`/`list_sessions` answers have no `contract_version`.
  A transport failure is neither: the call itself fails.
- **Polling.** Every verb below is non-blocking and reads memory (the one exception: `team(status)` for a run
  this server no longer holds reads its `status.json` once). Polling each about once per second is intended.
- **Compatibility.** Fields listed here never change meaning or type within contract version 1. New fields
  may be **added**; ignore keys you do not know. A future capability is announced in `capabilities` before
  you may rely on it.

### Types (TypeScript, authoritative)

```ts
export const CONTRACT_VERSION = 1;
/** v1 announces exactly these. */
export const CAPABILITIES = ["list", "status", "cancel", "capture", "capture_since_seq", "capture_spans"] as const;

export interface ContractMeta {
  contract_version: 1;
  capabilities: string[];          // v1: exactly CAPABILITIES
}

/** Closed set. The mod colours by it. */
export type SlotState =
  | "STARTING"            // pane spawned; Claude Code booting (claudish boot ≈ 11 s), or the prompt the session was
                          // CREATED with delivered but not yet accepted [amended r2: a promptless session's first
                          // send_input goes AWAITING_INPUT → RUNNING, never back to STARTING].
                          // Bounded: leaves within 90 s + 30 s. Non-terminal.
  | "RUNNING"             // a turn is in progress: prompt accepted; the model thinking, a tool running, Stop hooks
                          // or background agents still finishing. Never ended by a timer (team). Non-terminal.
  | "AWAITING_INPUT"      // waiting for text. Either an interactive create_session between turns (activity null), or a
                          // turn blocked on a question (activity "AskUserQuestion"). [amended r2] A send_input during a
                          // question does NOT answer it: claudish presses Esc, which declines the question and
                          // interrupts the turn, and the text becomes the next prompt. Team slots never stay here:
                          // team cannot answer, so a blocked team slot becomes FAILED "blocked". Non-terminal.
  | "AWAITING_PERMISSION" // a permission / plan-approval dialog is showing (only when caller flags override -y).
                          // A send_input declines it the same way. Same team rule as above. Non-terminal.
  | "COMPLETED"           // turn settled with a usable answer (team: passed require_pattern / min_output_bytes), or an
                          // interactive session whose child exited with code 0 while idle after /exit or after at
                          // least one settled turn [amended r2]. Terminal.
  | "FAILED"              // the session broke: boot failure, prompt never accepted, task file not fully read
                          // [amended r2], child exited (incl. unknown agent), API error, blocked (team), pane lost.
                          // Terminal.
  | "CANCELLED"           // stopped by team(mode="cancel") or cancel_session. Terminal.
  | "TIMEOUT"             // create_session timeout_seconds elapsed (team slots never time out). Terminal.
  | "EMPTY";              // turn settled but the answer is unusable: empty, refused, below min_output_bytes, or
                          // shape_mismatch. Terminal.

export const TERMINAL_STATES: readonly SlotState[] = ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "EMPTY"];

export type FailureReason =
  | "cancelled" | "timeout"
  | "boot_timeout" | "boot_blocked" | "first_run_dialog" | "agent_rejected" | "prompt_not_accepted"
  | "prompt_not_read"    // [amended r2] FAILED: the prompt was delivered as a file and the child's Read calls did not
                         // return every line of it (never read, or paged incompletely); detail says which lines
  | "child_exited" | "pane_lost" | "blocked"
  | "api_error" | "refused" | "empty_output" | "shape_mismatch";

/** B — one row per team slot, and the base of every list_sessions row. */
export interface SlotRow {
  slot: string;                  // team: anonymised slot id ("01"); session: the session_id
  model: string;                 // as requested
  provider: string | null;       // display name of the claudish provider serving it; null until known
  state: SlotState;
  reason: FailureReason | null;  // set on FAILED / EMPTY / CANCELLED / TIMEOUT; null otherwise (incl. COMPLETED).
                                 // [amended r2] One exception: a pre-contract state read from disk is FAILED with null (§B)
  tokens_in: number | null;      // billed input incl. cache reads/writes, main conversation + subagents; null = no source yet
  tokens_out: number | null;
  cost_usd: number | null;       // null = unknown (always null for native Claude routes)
  tool_calls: number;            // includes the child's Read call(s) of a file-delivered prompt
  turns_completed: number;       // prompts whose turn settled (one per prompt, however many internal loops)
  last_activity_at: string | null; // ISO 8601: last screen change or transcript append
  idle_seconds: number | null;   // seconds since last_activity_at; null in terminal states
  activity: string | null;       // RUNNING: tool name, "thinking", "background" (waiting on background agents), or
                                 // [amended r2] "finishing" (the model's message ended; waiting for Claude Code's
                                 // end-of-turn record, typically while Stop hooks run);
                                 // AWAITING_PERMISSION: blocked tool; AWAITING_INPUT on a question: "AskUserQuestion";
                                 // otherwise null. Treat unknown values as "busy".
  pane: string | null;           // informational only (do not parse, no verb takes it); null if no pane was ever spawned
}

/** list_sessions row = SlotRow + session fields. `slot` equals `session_id`. */
export interface SessionRow extends SlotRow {
  session_id: string;
  started_at: string;            // ISO
  completed_at: string | null;   // ISO
  elapsed_seconds: number;
}

/** A — one team run this server knows. */
export interface TeamRunRow {
  run_id: string;                // [amended, CA-13] unique per team(mode="run") start, distinct even when `path` is reused
                                 // (opaque; format `<team_session_id>-<base36 start ms>-<6 hex>`). Same value as the
                                 // start answer's `run_id`. A judge sub-run has its own run_id.
  path: string;                  // absolute session directory (the `path` every other team mode takes)
  kind: "run" | "judge";         // "judge" = the judging/ sub-run of a judge or run-and-judge
  started_at: string;            // ISO
  finished_at: string | null;    // ISO, set when the last slot turned terminal
  state: "ACTIVE" | "SETTLED";   // [amended] run-level, distinct from SlotState: SETTLED ⇔ every slot terminal
  outcome: "ok" | "partial" | "all-failed" | null;  // null while ACTIVE; same words as the result card
  slots: SlotRow[];              // sorted by slot id
}

export interface TeamListResult extends ContractMeta { runs: TeamRunRow[] }    // [amended] an object, not a bare array
export interface SessionListResult extends ContractMeta { sessions: SessionRow[] }
/** team(mode="status") adds these keys to its existing payload. */
export interface TeamStatusAdditions extends ContractMeta { run: TeamRunRow }

/** C */
export interface TeamCancelResult {
  run_id: string;                // [amended, CA-13]
  path: string;
  results: Array<{ slot: string; state: SlotState; changed: boolean }>; // changed = this call moved it to CANCELLED
}
export interface SessionCancelResult { session_id: string; state: SlotState; changed: boolean }

/** D */
export interface CaptureResult {
  seq: number;                   // claudish-owned. 0 = no frame received yet (lines all ""); ≥ 1 after the first frame;
                                 // +1 per visible change (text, colours, cursor, alt screen); never resets for a pane's life
  cols: number;                  // 160
  rows: number;                  // 50
  cursor: { x: number; y: number };
  lines: string[];               // exactly `rows` entries, plain text, right-trimmed; Claude Code's screen (no scrollback)
  final: boolean;                // true = the pane is closed and this is its last screen
  spans?: Array<Array<[col: number, len: number, fg: number, bg: number, attr: number]>>; // only when spans:true was asked
}
export interface CaptureUnchanged { unchanged: true; seq: number; final: boolean }

/** E */
export interface ContractError {
  error: {
    code: "unknown_run" | "unknown_slot" | "unknown_session" | "invalid_args";  // [amended r2] magmux_unavailable and
                                 // pane_limit removed: no verb in A–D can produce them (spawning verbs answer in text)
    message: string;
  };
}
```

Colour values in `spans`: `-1` = default, `0..255` = indexed, `≥ 16777216` = truecolor (`c & 0xFFFFFF`).
`attr` is a bitmask in which 1 = bold. The magmux frame encoding is passed through.

### A. `team(mode="list")` → `TeamListResult`

```json
{"contract_version":1,"capabilities":["list","status","cancel","capture","capture_since_seq","capture_spans"],
 "runs":[{"run_id":"review-mfz3k2a1-9c41e0","path":"/Users/jack/proj/ai-docs/sessions/x/review","kind":"run","started_at":"2026-10-02T11:00:00.000Z",
  "finished_at":null,"state":"ACTIVE","outcome":null,
  "slots":[{"slot":"01","model":"internal","provider":"Anthropic (native)","state":"RUNNING","reason":null,
            "tokens_in":61211,"tokens_out":812,"cost_usd":null,"tool_calls":3,"turns_completed":0,
            "last_activity_at":"2026-10-02T11:00:41.120Z","idle_seconds":0,"activity":"Bash",
            "pane":"c48211-kq3j9x2-t01-a1b2c3"}]}]}
```

- Args: `{ "mode": "list" }`, with no `path`.
- **[amended, CA-13] `run_id`.** `team(mode="run")` and `team(mode="run-and-judge")` answers carry
  `run_id` (top level, and inside `run`). `/dev:dev` reuses one review `path` every round, so `path` alone
  names several runs over time; `run_id` names one. A path holds at most one ACTIVE run at a time (starting a
  run on a path whose run is ACTIVE is refused; `run` is not a verb of this contract, so the refusal is its
  usual text error, `Error: invalid_args: …` [amended r2]); a SETTLED run at that path stays in `list` under
  its own `run_id` until retention drops it. `status`, `cancel` and `capture` accept an optional `run_id`
  **[amended r2]**: when given, they address **that** run for as long as this server retains it — including a
  run superseded at the same `path` — and answer `unknown_run` once it is no longer retained; never another
  run's data. Omitted, they address the newest run at `path`. A superseded run is always SETTLED, so `cancel`
  on it returns `changed:false` for every slot, and `status` on it returns `run` plus the contract keys but
  not the legacy path-based keys of §B (`models`, `summary`, …), which describe the newest run.
- Scope: runs started by **this server process**. ACTIVE runs, plus SETTLED runs for **30 minutes** after
  `finished_at`, at most **20** settled runs (oldest dropped first). A server restart forgets every run;
  `status` still reads finished runs off disk. `create_session` sessions are in `list_sessions`, not here.

### B. `team(mode="status", path)` and `list_sessions`

- `team(mode="status", path)` returns the existing payload **plus** `contract_version`, `capabilities` and
  `run: TeamRunRow`. The mod reads `run.slots`.
- Kept beside it for existing callers: `startedAt`, `models` (keyed by slot; `models[slot].state` uses the same
  `SlotState` set), `live_output_bytes_by_slot`, `idle_seconds_by_slot`, `activity_by_slot`, `note`, and
  `summary` once every slot is terminal.
- For a run not live in this server, `run` is built from `status.json`: rows have `idle_seconds:null` and
  `activity:null`, `state` is whatever was last written, and a persisted value outside the closed set (from a
  pre-contract claudish) is reported as `FAILED` with `reason:null`.
- `list_sessions(include_completed?)` → `SessionListResult`:
  `{ "contract_version": 1, "capabilities": [...], "sessions": SessionRow[] }`.

### C. Stop

- `team(mode="cancel", path, slot?, run_id?)` → `TeamCancelResult` (which also carries `run_id`); omitting
  `slot` cancels every slot.
  `cancel_session(session_id)` → `SessionCancelResult`.
- Idempotent: a second call returns the same `state` with `changed:false`.
- Returns once the state has turned CANCELLED. The pane close and process-group reap finish in the
  background within about 12 s.
- Unknown path → `unknown_run`; unknown slot → `unknown_slot`; unknown session → `unknown_session`.

### D. Show

- `team(mode="capture", path, slot, since_seq?, spans?, run_id?)` and `capture_session(session_id, since_seq?, spans?)`
  → `CaptureResult`, or `CaptureUnchanged` when `since_seq === seq`. **Any other `since_seq`** (lower, higher —
  e.g. from a previous server — or absent) returns a full `CaptureResult`.
- Before the first frame: `seq:0`, 50 empty lines, `final:false`. Polling with `since_seq:0` therefore returns
  `unchanged` only while no frame has arrived.
- A closed pane returns its last screen with `final:true` for as long as the run or session is retained
  (30 min); after that `unknown_run` or `unknown_session`.
- **[amended r2]** A slot whose pane never spawned (its row is FAILED with `pane:null`) returns `seq:0`,
  `cols:160`, `rows:50`, cursor `{x:0,y:0}`, 50 empty lines and `final:true`.
- Captures are addressed only by `(path, slot)` or `session_id`; the row's `pane` is informational.

```json
{"seq":57,"cols":160,"rows":50,"cursor":{"x":2,"y":44},"final":false,
 "lines":[" ▐▛███▛█   Claude Code v2.1.287","▝▜██████▀  Haiku 4.5 · Claude Max","", "❯ Reply with exactly PEAR","","⏺ PEAR", "…"]}
{"unchanged":true,"seq":57,"final":false}
```

### E. Errors and channel frames

- Errors: `ContractError` as above, with `isError:true`, from every verb in A–D (including `team(status)` and
  `list_sessions`).
- `notifications/claude/channel` frames keep their shape. The `event` vocabulary gains `awaiting_permission`
  (`status: input_required`); new optional `meta` keys: `activity`, `send_rejected`, and **[amended r2]**
  `prompt_not_read` (an interactive turn whose task file was not fully read; the session continues).
  **[amended r-base]** The `finishing` event of the session-records build (10.4.0) is not emitted: a one-shot
  session goes from `running` straight to its terminal event, and the wait for Claude Code's end-of-turn record
  is `activity: "finishing"` on a RUNNING row. `SlotState` is unchanged.
- Terminal states reach `list` and `status` in the same tick they are decided. A 1 Hz poll is enough for the
  mod's wake-up.

---

