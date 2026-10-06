# Phase 7 — live validation of pane-based `team` and channel sessions

**Date:** 2026-10-06, 12:44–12:58 UTC. **Verdict: PASS** — V1–V9 all pass; extras R3, R8, R13,
R14, R16, R17 and R7 pass or are recorded.

**Setup.**

- Build under test: claudish **10.4.0** at head `d9b7290f`, built with `bun run build`. The installed
  global claudish is 10.3.0 and was never spawned.
- Server: the BUILT entry, `bun packages/cli/dist/index.js --mcp`, run as a JSON-RPC stdio child of a
  Bun driver script that reuses `test-helpers/contract-mcp.ts`'s `McpServer`. Its cwd is the
  worktree, its environment is the operator's real environment and config (real `~/.claude`, real
  keychain login), and `CLAUDISH_BIN=<repo>/packages/cli/dist/index.js`.
- Pane root: the production default, `/tmp/claudish-mux-501`, which did not exist at baseline.
- Versions: Claude Code 2.1.291, magmux 0.14.0 (1900271), Bun 1.4.0.
- Proof that every child is the build under test: each `ps` snapshot shows panes running
  `bun run <repo>/packages/cli/dist/index.js -i --model … -y --quiet --session-id <uuid> --add-dir …`.
  `~/.claudish/startup-metrics.jsonl` logged `"version":"10.4.0"` at each slot start: 12:45:14.707Z,
  12:45:16.296Z, 12:45:16.651Z (the V1 slots) through 12:57:53.645Z (R17), 24 entries in all.

The driver scripts, raw transcripts of every call and every `ps`/socket snapshot are in the
gitignored session `dev-feature-mcp-magmux-panes-20261002-a7c3/validation/` (`scripts/`,
`evidence/*.stdout`). Below, `<repo>` is the worktree and `<runs>` is
`<repo>/ai-docs/sessions/…/validation/runs`. The snapshot filter is
`claudish-pane-watcher|magmux --headless|claudish-mux-|dist/index.js`, because the machine runs
~40 unrelated Claude Code sessions. Twenty-one `/tmp/magmux-e2e-*.sock` files from other suites
existed at baseline. They are excluded from every listing, and the count was still 21 at the end.

Spend: metered gpt-5-mini $0.076294 (V1) + $0.050062 (R13) = **$0.13**. The Antigravity slots
(gemini-2.5-flash) report `cost_usd: 0`, and the native slots run on the Claude Max subscription.

---

## V1 — `team(mode="run")`, 3 models (native `haiku`, native `internal`, foreign `gpt-5-mini`)

The foreign model was picked by a `preflight` on the server under test. That preflight reported
`gpt-5-mini` → OpenAI, metered, ✅ live (`oai@gpt-5-mini`), and `gemini-2.5-flash` → Antigravity,
SUB, ✅ live.

```
team {"mode":"run","path":"<runs>/team-pear-muwo8klf","models":["haiku","internal","gpt-5-mini"],
      "input":"Reply with exactly PEAR and nothing else."}  → isError=false (9484 ms)
run_id: team-pear-muwo8klf-muwo8lc1-bf1f98   slots: {"haiku":"02","internal":"01","gpt-5-mini":"03"}
```

**R14 run latency: 9,484 ms** for three slots. The expected range was 12–20 s and the fail line
60 s. Slot 01 was already COMPLETED inside that window.

Poll (`team(mode="status")` every 1.5 s):

```
t+0.0s  01:COMPLETED 02:RUNNING(thinking) 03:RUNNING(thinking)
t+4.5s  01:COMPLETED 02:COMPLETED 03:RUNNING(thinking)
t+19.6s 01:COMPLETED 02:COMPLETED 03:COMPLETED
```

Final `run` (from `status`):

```json
{"run_id":"team-pear-muwo8klf-muwo8lc1-bf1f98","kind":"run","started_at":"2026-10-06T12:45:09.505Z",
 "finished_at":"2026-10-06T12:45:37.598Z","state":"SETTLED","outcome":"ok","slots":[
 {"slot":"01","model":"internal","provider":"Anthropic (Native)","state":"COMPLETED","reason":null,
  "tokens_in":65593,"tokens_out":6,"cost_usd":null,"tool_calls":0,"turns_completed":1,
  "last_activity_at":"2026-10-06T12:45:17.707Z","idle_seconds":null,"activity":null,"pane":"c91040-muwo8knd-t01-b1ff43"},
 {"slot":"02","model":"haiku","provider":"Anthropic (Native)","state":"COMPLETED","reason":null,
  "tokens_in":55205,"tokens_out":57,"cost_usd":null,"tool_calls":0,"turns_completed":1,
  "last_activity_at":"2026-10-06T12:45:21.480Z","idle_seconds":null,"activity":null,"pane":"c91040-muwo8knd-t02-f0df96"},
 {"slot":"03","model":"gpt-5-mini","provider":"OpenAI","state":"COMPLETED","reason":null,
  "tokens_in":24219,"tokens_out":3482,"cost_usd":0.076294,"tool_calls":0,"turns_completed":1,
  "last_activity_at":"2026-10-06T12:45:37.093Z","idle_seconds":null,"activity":null,"pane":"c91040-muwo8knd-t03-b0b136"}]}
```

`summary`: `status: ok — 3/3 succeeded`. Response files: `response-01.md` = `PEAR`,
`response-02.md` = `PEAR`, `response-03.md` = `PEAR` (4 B each). `status.json` carries, per slot,
`captureSource:"transcript"`, `turnSource:"transcript"`, `stopReason:"end_turn"`,
`claudeCodeVersion:"2.1.291"` and `anomalies:[]`.

**R16 accounting.** For each native slot, the row equals the transcript at the derived path:
input + cache-creation + cache-read tokens summed over unique `message.id`s.

| slot | row in/out | transcript (dedup) in/out | assistant text |
|---|---|---|---|
| 02 haiku (`4b21cbe5-…`) | 55205 / 57 | 55205 / 57 | `"PEAR"` |
| 01 internal (`603be4d2-…`) | 65593 / 6 | 65593 / 6 | `"PEAR"` |
| 03 gpt-5-mini (`408f0d21-…`) | 24219 / 3482 | 24219 / 2059 | `"PEAR"` |

The foreign row equals the token file `stats/03.json`
(`input_tokens:24219, output_tokens:3482, total_cost:0.076294`), as §R16 specifies. Claude Code's
own Anthropic-shaped usage in the transcript shows 2059 output tokens. The run used xhigh effort,
and the 1,423-token difference is consistent with reasoning tokens that the token file counts and
the transcript does not.

R1 capture mid-run (slot 03 booting into its turn; empty rows dropped, `NN|` = row index):

```
 1|  ▐▛███▛█   Claude Code v2.1.291
 2| ▝▜██████▀  oai@gpt-5-mini with xhigh effort · API Usage Billing
 6| ❯ Reply with exactly PEAR and nothing else.
43| ✻ Booping… (0s)
46| ❯
48|   * oai@gpt-5-mini |  wt:claudish-mcp-magmux  |  I  | $0.00 | 0s | …
```

Snapshots:

- Mid-run: 3 watchers, 3 `magmux --headless --id c91040-…`, the pane children
  (`bun run …/dist/index.js -i …` → `claude --settings … --session-id <uuid>`), 3 sockets
  `magmux-c91040-*.sock` and 3 `panes/*.json` records.
- 15 s after the last slot settled, with the server still up: only the server process, root =
  `panes/`, `panes/` empty.
- After stdin EOF: nothing.

## V2 — unknown agent

```
team {"mode":"run","models":["haiku","gemini-2.5-flash"],"input":"…PEAR…","agent":"zzz-not-real"}  → isError=false (10675 ms)
```

```json
"slots":[
 {"slot":"01","model":"haiku","provider":"Anthropic (Native)","state":"FAILED","reason":"agent_rejected","tokens_in":null,"tokens_out":null,"cost_usd":null,"tool_calls":0,"turns_completed":0,…},
 {"slot":"02","model":"gemini-2.5-flash","provider":null,"state":"FAILED","reason":"agent_rejected",…}],
"state":"SETTLED","outcome":"all-failed"
```

`status.json` `error.detail` for both slots, and the first line of `errors/01.log`:

```
=== FAILED: agent_rejected: --agent 'zzz-not-real' not found. Available agents: claude, claude-code-guide, Explore, general-purpose, Plan, statusline-setup ===
```

That is the child's own line (`exitCode: 1`, command
`claudish -i --model haiku -y --quiet --agent zzz-not-real`). Neither slot made a model call
(`tokens_in: null`). Under `-p` the same agent name was silently accepted. The next script's
"before" snapshot, taken after this server exited, showed nothing left.

## V3 — `require_pattern`

Negative control, `require_pattern:"^ZEBRA$"` on the PEAR prompt:

```
t+0.0s 01:RUNNING(thinking)   t+1.5s 01:RUNNING(finishing)   t+3.0s 01:EMPTY
{"slot":"01","model":"haiku","state":"EMPTY","reason":"shape_mismatch","tokens_in":55204,"tokens_out":44,"turns_completed":1,…}
what: The answer (4 B of assistant text after the task was read) does not match the required pattern /^ZEBRA$/.
      Every assistant message of the turn was read from the transcript, so nothing was lost: the model did not produce the shape.
```

Positive control, `require_pattern:"PEAR"`, same path (cleared first):
`{"slot":"01","state":"COMPLETED","reason":null,"tokens_in":55204,"tokens_out":96,"turns_completed":1,…}`,
`outcome:"ok"`.

## V4 — capture on a RUNNING slot, `since_seq` on an idle session

Team slot `haiku`, prompt "Use the Bash tool to run the command `sleep 15`…". Three captures while
the row read `state=RUNNING activity=Bash tool_calls=1`. The first one:

```json
{"seq":13,"cols":160,"rows":50,"cursor":{"x":2,"y":46},"final":false,"lines":[
 " 1|  ▐▛███▛█   Claude Code v2.1.291"," 2| ▝▜██████▀  Haiku 4.5 · Claude Max",
 " 7| ❯ Use the Bash tool to run the command sleep 15. After it finishes, reply with exactly DONE and nothing else.",
 " 9|   Bash(sleep 15)","43| ✻ Architecting… (2s · ↓ 125 tokens)","46| ❯",
 "48|   * Haiku |  wt:claudish-mcp-magmux  |  I  | $0.04 | 3s | … | █░░░░░ 28% • $0.000 • N/A",
 "49|   -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 5 agents"]}
```

The later captures were seq 28 (`(ctrl+b to run in background)`, 6 s) and seq 44 (`⏺ Bash(sleep 15)`,
10 s). An immediate `since_seq` equal to each returned `{"unchanged":true,"seq":13|28|44,"final":false}`.
The slot then went `RUNNING(Bash)` → `RUNNING(thinking)` → COMPLETED, with `tool_calls:1` and
`tokens_in:110630`.

Idle promptless `create_session {"model":"haiku"}` → `{"session_id":"6808abd2","state":"STARTING"}`,
then AWAITING_INPUT 5 s later. `capture_session` → `seq:3` (full 50-row screen: banner, prompt box,
status line). `capture_session {since_seq:3}` twice, 2 s apart, returned
`{"unchanged":true,"seq":3,"final":false}` both times.

**R7 on the operator's real status line:** seq went 3 → 4 over 10.0 s of idle, one visible change in
10 s.

## V5 — cancel mid-run, idempotent, nothing left; R8 SIGKILL

Before cancel (row `activity:"Bash"`, the model running `sleep 120`), the pane was live: 1 watcher,
`magmux --headless --id c11405-muwod6gu-t01-637326`, the pane child and `claude …`,
`magmux-c11405-…-637326.sock`, 2 launch dirs and `panes/c11405-…-637326.json`.

```json
team {"mode":"cancel",…}  → {"run_id":"team-cancel-muwoe7xg-muwoe7zd-8458e8","results":[{"slot":"01","state":"CANCELLED","changed":true}]}
team {"mode":"cancel",…}  → {"run_id":"team-cancel-muwoe7xg-muwoe7zd-8458e8","results":[{"slot":"01","state":"CANCELLED","changed":false}]}
status run.slots[0]: {"state":"CANCELLED","reason":"cancelled","tokens_in":55219,"tokens_out":135,"tool_calls":1,"turns_completed":0,…}
```

Thirteen seconds after the cancel, with the server still up, only the server process remained:
`/tmp/claudish-mux-501: panes`, `panes/` empty, no `/tmp/magmux-*.sock`.

**R8: SIGKILL the server mid-run with 3 live slots** (`haiku`, `internal`, `gemini-2.5-flash`, all
in `sleep 120`; rows `01:RUNNING(Bash) 02:RUNNING(thinking) 03:RUNNING(Bash)`). An unrelated
`/bin/sleep 900` canary was started beforehand. Just before the kill there were 3 watchers,
3 magmux, 3 pane children + 3 `claude`, 3 sockets, 6 launch dirs and 3 records.

```
SIGKILL sent to server 45778 at 2026-10-06T12:55:15.748Z
R8: processes, sockets, launch dirs and records all gone 1703 ms after SIGKILL
snapshot ~15 s after: (no processes)  /tmp/claudish-mux-501: panes   panes: (empty)   sockets: (none)
canary pid 45772 alive after reap: true
```

Everything was gone in 1.7 s, inside the 5 s criterion, with no server restart. The unrelated
process survived.

## V6 — transcript saving

- `grep -r 'Transcript saving is off'` over every evidence file and run directory matches only the
  section heading the V1 script wrote. No capture contains it. That covers 15 full
  `CaptureResult` screens and 3 screen snippets or final-screen dumps across V1–V7 and the extras.
- The transcript exists at the derived path for every slot checked: the 3 V1 slots, R3 and R17.
  The path is `~/.claude/projects/-Users-jack-mag-claudish--claude-worktrees-claudish-mcp-magmux/<uuid>.jsonl`.
  The slug is the realpath of the cwd with non-alphanumerics replaced by `-`, it equals
  `status.json`'s `transcriptPath`, and `exists=true`.

## V7 — channel sessions

`create_session {"model":"gemini-2.5-flash","prompt":"Reply with exactly APPLE and nothing else.","timeout_seconds":300}`
returned `{"session_id":"a4a1994e","state":"STARTING"}` and went STARTING → RUNNING/thinking (9 s) →
COMPLETED (14 s).

```json
get_output → {"sessionId":"a4a1994e","state":"COMPLETED","output":"APPLE","totalLines":1,"turnsCompleted":1,"tokensIn":27713,"tokensOut":13,"elapsedSeconds":14,"idleSeconds":null}
```

`create_session {"model":"haiku"}` (no prompt) returned `{"session_id":"3f808e07","state":"STARTING"}`.
`send_input` was sent while the session was STARTING and answered `{"success":true,"queued":1}`.
The session went STARTING → RUNNING/thinking (6 s) → AWAITING_INPUT, turns=1 (8 s).

```json
get_output → {"sessionId":"3f808e07","state":"AWAITING_INPUT","output":"KIWI","turnsCompleted":1,"tokensIn":55206,"tokensOut":47,…}
cancel_session → {"session_id":"3f808e07","state":"CANCELLED","changed":true}
cancel_session → {"session_id":"3f808e07","state":"CANCELLED","changed":false}
list_sessions {"include_completed":true} →
{"contract_version":1,"capabilities":["list","status","cancel","capture","capture_since_seq","capture_spans"],"sessions":[
 {"slot":"a4a1994e","model":"gemini-2.5-flash","provider":"Antigravity Ultra","state":"COMPLETED","reason":null,"tokens_in":27713,"tokens_out":13,"cost_usd":0,"tool_calls":0,"turns_completed":1,"last_activity_at":"2026-10-06T12:56:05.175Z","idle_seconds":null,"activity":null,"pane":"c51874-muwoma52-sa4a1994e-ab9190","session_id":"a4a1994e","started_at":"2026-10-06T12:55:51.391Z","completed_at":"2026-10-06T12:56:05.176Z","elapsed_seconds":14},
 {"slot":"3f808e07","model":"haiku","provider":"Anthropic (Native)","state":"CANCELLED","reason":"cancelled","tokens_in":55206,"tokens_out":47,"cost_usd":null,"tool_calls":0,"turns_completed":1,"last_activity_at":"2026-10-06T12:56:13.144Z","idle_seconds":null,"activity":null,"pane":"c51874-muwoma52-s3f808e07-6fa02d","session_id":"3f808e07","started_at":"2026-10-06T12:56:05.604Z","completed_at":"2026-10-06T12:56:13.676Z","elapsed_seconds":8}]}
```

`get_diagnostics` for a4a1994e reports `captureSource:"transcript"`, `turnSource:"transcript"`,
`claudeCodeVersion:"2.1.291"`, `anomalies:[]` and the transcript path. Thirteen seconds later only
the server process remained; after the close, nothing.

## V8 — `team(mode="list")`

- **While ACTIVE:** called immediately after V1's `run` returned, the run was listed with
  `"state":"ACTIVE","finished_at":null,"outcome":null`, slot 02 `RUNNING`/`thinking`
  `idle_seconds:0`, and `contract_version:1` + `capabilities`.
- **After settling:** the same run_id with `"state":"SETTLED"`,
  `"finished_at":"2026-10-06T12:45:37.598Z"`, `"outcome":"ok"`.
- **CA-13 path reuse**, with the directory cleared between rounds as `/dev:dev` does. Reusing a
  path WITHOUT clearing it is refused by design: `Session already exists at … delete the existing
  session first`.

```
round 1 run_id team-pattern-muwoc0pz-muwoc0w1-c42413 (ZEBRA → EMPTY)
round 2 run_id team-pattern-muwoc0pz-muwoc7tv-ce16c9 (PEAR → COMPLETED)
third start while round 2 ACTIVE → isError: "Error: invalid_args: a team run is already ACTIVE at <runs>/team-pattern-muwoc0pz (run_id team-pattern-muwoc0pz-muwoc7tv-ce16c9); cancel it or wait for it"
list → run_ids at path: ["team-pattern-muwoc0pz-muwoc7tv-ce16c9","team-pattern-muwoc0pz-muwoc0w1-c42413"]  distinct=true
status {run_id: round 1} → keys contract_version, capabilities, run only; run = round 1 (EMPTY shape_mismatch, SETTLED)
cancel {run_id: round 1} → {"results":[{"slot":"01","state":"EMPTY","changed":false}]}
```

## V9 — channel frames

The server ran with `CLAUDISH_CHANNEL_TRACE=1 CLAUDISH_CHANNEL_TRACE_FILE=…`. The driver, acting as
the host, received 5 `notifications/claude/channel` frames: a4a1994e `running`/`working`,
`completed`/`completed`; 3f808e07 `running`/`working`, `waiting_for_input`/`input_required`,
`cancelled`/`cancelled`. One traced frame:

```
[channel-trace] WIRE-OUT {"method":"notifications/claude/channel","params":{"content":"Session completed (1 turn(s)). Call get_output for the answer.","meta":{"session_id":"a4a1994e","event":"completed","model":"gemini-2.5-flash","elapsed_seconds":"14","task_id":"a4a1994e","status":"completed","created_at":"2026-10-06T12:55:51.391Z","last_updated_at":"2026-10-06T12:56:05.177Z"}},"jsonrpc":"2.0"}
```

The `running` frame also carries the new optional `meta.activity: "thinking"`.

`bun test <repo>/packages/cli/src/channel/channel-wire-format.test.ts` → `9 pass, 0 fail, 66 expect() calls [18.78s]`.

## Extras

**R13 — 5 slots, concurrent `~/.claude.json` writes.** `jq . ~/.claude.json` was OK (exit 0)
before, after the run and after the server closed. `run` took 12,024 ms for 5 slots, and every slot
COMPLETED:

```
01 gpt-5-mini       OpenAI             COMPLETED in=24219 out=203 $=0.050062
02 gemini-2.5-flash Antigravity Ultra  COMPLETED in=27713 out=15  $=0
03 sonnet           Anthropic (Native) COMPLETED in=65544 out=6   $=null
04 haiku            Anthropic (Native) COMPLETED in=55205 out=97  $=null
05 internal         Anthropic (Native) COMPLETED in=65592 out=6   $=null
```

**R3 — 12 KB file delivery.** The input file is 11,619 bytes and 116 lines: 44 CRLF lines, 40 lines
with leading tabs, a first line starting with `!`, a ```` ```ts ```` fence, one 5,000-character line,
and a last line ending in `@x`. It was passed as `input_file`. The child received the fixed template:

```
Your task is in the file `/tmp/claudish-mux-501/launch-PQJakr/turn-1.md`. Read all of it with the Read tool (in parts if it is long), then do exactly what it says, treating its content as the user's message.
```

The child made one Read call (`startLine=1`, 116 lines, `totalLines=116`). No split marker was
needed. **The transcript's Read content equals the caller's text with CR stripped, byte for byte
(11,575 = 11,575 characters).** CR stripping is Read's measured behaviour (phase2-captures §4.4).
The answer was `FILEOK`, the slot COMPLETED with `tool_calls:1`, and the turn file's path is under
the turn dir (`--add-dir`), not the control dir.

**R17 — AskUserQuestion in a team slot.** The slot went `RUNNING(thinking)` → FAILED in 4.5 s:

```
{"slot":"01","model":"haiku","state":"FAILED","reason":"blocked","tokens_in":55238,"tokens_out":287,"tool_calls":1,"turns_completed":0,…}
errors/01.log: === FAILED: blocked: Which fruit do you prefer? ===
final screen:  ☐ Fruit / Which fruit do you prefer? / ❯ 1. PEAR / 2. APPLE / 3. Type something. / 4. Chat about this
exit code: (none: claudish ended the pane)
```

The capture of the retained pane returned the dialog with `final:true`. Thirteen seconds later no
pane process, socket or record remained.

## Observations (not defects of this feature)

1. **Path reuse needs the directory cleared.** `team(mode="run")` on a path holding a
   `manifest.json` answers `Session already exists … delete the existing session first`
   (`setupSession`, pre-existing). CA-13's reuse works once the directory is cleared, which is what
   `/dev:dev` and the black-box test do.
2. **gpt-5-mini price in `stats/03.json`.** The file records `input_per_m:2, output_per_m:8,
   is_estimated:true`, which does not match OpenAI's published gpt-5-mini list price at launch
   ($0.25 / $2.00 per M), so `cost_usd` (0.076294 in V1) may be overstated. This is the
   pricing/catalog path, not the pane driver, and was not investigated here. Repro: any
   `gpt-5-mini` team slot, then `cat <path>/stats/<slot>.json`.
3. **Foreign `tokens_out`.** For a foreign model the row follows the token file (3482), and the
   transcript's Anthropic-shaped usage is lower (2059) under xhigh effort. The row follows the
   token file as §R16 specifies.
