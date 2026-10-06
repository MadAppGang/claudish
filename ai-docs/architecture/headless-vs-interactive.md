# Headless is not a faithful subset of interactive

Claude Code's print/headless mode (`-p`, `--output-format stream-json`, `--input-format
stream-json`) is not merely "interactive without a TTY". It diverges behaviourally, and at least
one divergence turns a hard, self-explaining error into silence. This is why claudish drives a
CONTROLLED INTERACTIVE session (magmux) wherever the answer has to be trustworthy, rather than
treating `-p` as the general-purpose interface.

Measured 2026-08-22 against Claude Code v2.1.239.

## The measurement

`--agent <name>` with a name that does not exist. One variable — the input format — and
`claude` invoked DIRECTLY, with no claudish in the path:

| invocation | exit | stderr | agent applied? |
|---|---|---|---|
| `claude --agent zzz-not-real` (interactive, TTY) | — | `--agent 'zzz-not-real' not found. Available agents: …` | run refused |
| `claude -p --output-format stream-json --agent zzz-not-real` | **1** | same, lists all 24 agents | run refused |
| `claude -p --output-format stream-json --input-format stream-json --agent zzz-not-real` | **0** | *(empty)* | **no — silently default** |

Adding `--input-format stream-json` is the whole difference.

The flag is NOT inert in that mode — a VALID name IS honoured. The `system/init` frame proves
it, via the tool allowlist:

    --agent dev:reviewer   -> tools: ["Read", "Bash"]                      (agent applied)
    --agent zzz-not-real   -> tools: ["Task","Bash","CronCreate","Edit",…] (full default set)

So the agent loads correctly; only its VALIDATION is skipped.

## It is not "errors moved into the stream"

The obvious defence of this design is that an SDK-facing mode should keep the protocol stream
alive rather than exit, surfacing problems as frames. It does not do that. Searching the entire
stream for the bogus name and for any error frame:

    mentions of "zzz-not-real" anywhere in the stream: 0
    frame types: system/init, system/hook_started, system/hook_response,
                 assistant, rate_limit_event, result/success
    result.is_error: false

The run reports SUCCESS. There is no signal in any channel — not the exit code, not stderr, not
the stream. A typo silently runs the default agent with the FULL tool set and reports success.

## Upstream status: documented nowhere, and closed as not planned

The official CLI reference defines both flags and says nothing about their interaction or about
validation of unknown agent names:

> `--agent` — Specify an agent for the current session (overrides the `agent` setting)
> `--input-format` — Specify input format for print mode (options: `text`, `stream-json`)

<https://code.claude.com/docs/en/cli-reference>

The nearest report, [anthropics/claude-code#15815](https://github.com/anthropics/claude-code/issues/15815)
("`--agent` Flag Not Working for Non Interactive (Affects SDK)"), was **closed as not planned**,
with no maintainer explanation in the thread. Two caveats on citing it:

- That report (v2.0.76, Dec 2025) was that the agent NEVER LOADS headlessly. On v2.1.239 a valid
  agent does load — measured above — so that part appears fixed since.
- What remains is narrower: the agent loads, but an invalid name is not validated.

**Treat this as settled upstream behaviour, not as a bug awaiting a fix.** Anthropic saw the
adjacent complaint and declined it. Design around it; do not wait for it.

## Why magmux exists

`docs/usage/magmux.md` used to present magmux as a side-by-side viewer for `--grid`. That is a
FEATURE, not the reason it is in the dependency tree. The reason is agent-drives-agent: `magmux
mcp` runs magmux as an MCP server so one AI agent can spawn and DRIVE another agent's session —
"real PTYs running real interactive tools, with a human watching every one of them". The tool
surface is `list_sessions`, `attach_session`, `request_session`, `list_panes`, `open_pane`,
`close_pane`, `read_pane`, `send_keys`.

**The critical property, and the one that connects to the measurement above: a magmux pane is a
real PTY running a real interactive session, and that stays true with no terminal of your own.**
`--headless` is about MAGMUX's output, not the pane's:

> `--headless`  Run with no terminal: no raw mode, no alternate screen, and not one byte on
> stdout. The socket is the whole interface — read `results` for the outcome. Turned on
> automatically when stdin is not a terminal.

So the choice is NOT "visible interactive session" vs "headless `-p`". It is:

| | child sees | validation behaviour | needs a terminal? |
|---|---|---|---|
| `claude -p --input-format stream-json` | no TTY, print mode | **skipped, silently** | no |
| `claude` in a magmux pane, `magmux --headless` | real PTY, interactive | correct — refuses, lists agents | **no** |

That is the whole point. Automation does not have to accept print mode's divergences to get a
programmable interface; it drives a genuinely interactive child over a socket instead.

Both halves measured, not assumed. The child gets a real PTY even though magmux has no terminal:

    magmux --headless -w --id ttyprobe2 -e 'sh -c "… [ -t 0 ] …; tty > FILE"'  < /dev/null
      -> STDIN_IS_TTY
      -> tty=/dev/ttys021

(NB the first attempt at this measured `[ -t 1 ]` while redirecting stdout to a file, so it
reported NO_TTY by construction. Isolate stdin.)

And the behaviour that actually matters follows from it — same bogus agent, inside a headless
magmux pane:

    magmux --headless -w --id agentprobe -e 'sh -c "claude --agent zzz-not-real > FILE 2>&1; …"'
      -> --agent 'zzz-not-real' not found. Available agents: claude, code-analysis:detective, …
      -> EXIT=1

Refused, with the list, from a magmux that never touched a terminal.

`Controlled Sessions` closes the loop — a subscriber can drive a pane, not merely watch it,
reading state off the socket and pushing the next instruction back in.

One deliberate constraint worth knowing before you try to automate around it (`mcp_spawn.go`):

> Deliberately absent: spawning. We never fork a magmux and we never exec tmux. A magmux that
> nobody is watching defeats the whole design, in which a human sees every pane the agent drives;
> `request_session` hands the command to the human instead.

So the MCP server will not create a session for you. That is accountability, not an omission —
an agent driving another agent is exactly the case where a human needs to be able to look.

`packages/magmux-{darwin,linux}-*` ship with the CLI; `team-grid.ts` is the current consumer, and
`--grid` is the side-by-side feature rather than the rationale.

## Driving an interactive session to completion — the part that bites

A real session does not exit on its own. Measured 2026-08-22, both naive options FAIL, in
opposite directions:

    magmux --headless -w   --id t -e 'claude'   -> exit 0 after 6s, NOTHING done
    magmux --headless      --id t -e 'claude'   -> still running at 40s (hangs forever)

`-w` is the dangerous one because it reports success. The cause is `main.go`:

    if p.dead || p.inputReady { done++ } else { running++ }

`done` means dead OR **inputReady**. That is right for a one-shot child — `claudish --model X
--stdin` runs and dies, which is why `team-grid.ts` can use `-g … -w` safely — and wrong for a
REPL, which reaches its prompt immediately and sits there. `-w` sees "idle" and quits before any
work happens.

So neither flag drives a session. The controlled-session loop does.

### The validated sequence

1. Launch WITHOUT `-w`: `magmux --headless --id <name> -e 'claude'`.
2. **Strip `CLAUDE_CODE_CHILD_SESSION` and `CLAUDECODE` from the child env.** Inherited from a
   parent Claude Code session they turn TRANSCRIPT SAVING OFF, and the transcript is
   `ClaudeCodeController`'s primary signal. Symptom in the pane: `⚠ Transcript saving is off —
   inherited CLAUDE_CODE_CHILD_SESSION marker`. Detection then degrades to the terminal-idle
   heuristics, which is the fallback, not the contract.
3. Connect to `/tmp/magmux-<name>.sock` (newline-delimited JSON; `id` round-trips verbatim).
4. **Wait for pane state `awaiting_input` before sending anything.** Do NOT accept `running` — at
   startup that is the splash screen, and keystrokes sent into a still-booting TUI land in the
   input box without submitting. Measured boot: ~11s.
5. `{"type":"send","pane":0,"text":"…"}` — types AND submits.
6. **Wait for `running`** — proves the turn actually started.
7. **Then wait for `awaiting_input`** — the turn settled. Measured: ~13s for a trivial prompt.
8. Verify CONTENT, not just the state flag (`capture`, or the cost on the status line).
9. `{"type":"close_pane","pane":0}` — magmux then exits 0 (measured ~2s).
10. Wrap all of it in a hard timeout, and reap the process if it trips.

Steps 4/6/7 are three separate edges and all three are load-bearing. Skipping any of them
produces a run that reports settled while nothing happened — the pane shows the prompt text
sitting unsubmitted and the status line reads `$0.00`. A correct run shows the answer and a
non-zero cost:

    ❯ Reply with exactly OK and nothing else.
    ⏺ OK
      * Opus | … | $0.36 | 13s

Both of my first two harness attempts failed exactly this way. The state flag is not the oracle;
the content is. Same lesson as `require_pattern` in `team-capture.md`, one layer down.

### A working implementation

`packages/cli/src/pane/` (`PaneSession`) implements the sequence above for MCP `team` slots and
`create_session`, and `scripts/pane-drive.ts` drives one session through it from the command
line (it replaced the polling reference driver `magmux-drive-session.ts`, whose measurements
follow):

    bun scripts/pane-drive.ts "Reply with exactly OK and nothing else."
    bun scripts/pane-drive.ts --fake answer "hello"      # the test fake, hermetic, no cost

Measured: 8/8 deterministic runs, 14-25s each; distinct prompts return their real answers
(`BANANA`, `51` for 17x3, `PEAR`), so it reports model output rather than a fixed string; a
forced turn deadline returns `turn_timeout` in 16.7s instead of hanging; and no run left an
orphaned process or a stale socket.

It POLLS `list` every 600ms, which was enough to validate the sequence but is not the best
design. The protocol is built for event SUBSCRIPTION (`snapshot` / `exit` frames) — madbench's
`internal/magmux/socket.go` consumes those instead, deriving terminal state from an `exit` event
and its code. Prefer events over polling for anything long-lived; there is no poll-interval race
in that model.

### Permission prompts

`ClaudeCodeController` models `CtrlAwaitingPermission` distinctly from `CtrlAwaitingInput`, so a
driver CAN see "it asked a question" rather than hanging. The cheaper route for automation is not
to be asked: claudish's team children already spawn with `-y`.

## What this means when you are writing code here

- **Do not assume a headless run behaves like the interactive one.** Where the difference would
  be silent, measure both — the A/B above is the pattern, and it took two commands.
- **`exit 0` from a headless child is not evidence the flags were honoured.** This is the same
  lesson `team-capture.md` records for output: exit 0 proves nothing, which is why
  `require_pattern` exists. Argument handling has the same hole.
- **Validate at the claudish boundary when the child will not.** `agent-availability.ts` does
  this for `--agent`: it discovers the agent names live (`claude --agent <sentinel> -p`, ~0.5s, no
  API call, no tokens), caches them PER CWD because that list is cwd-dependent (24 names in this
  repo, 5 in `/tmp`), and fails OPEN when the list cannot be determined — blocking every session
  because a probe broke would be a worse failure than the one it guards.
- **Prefer magmux over `-p`** for anything where a silent behavioural difference would corrupt
  the result rather than merely degrade it.
