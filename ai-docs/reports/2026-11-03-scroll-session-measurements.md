# Scrolling a child Claude Code pane: measurements behind `scroll_session` (MTL-369, 2026-11-03)

Setup for every run: Claude Code 2.1.316, magmux 0.18.1, `magmux --headless --no-status
--controller claude-code`, pane 160x50, child `claude --model haiku`. Inputs went as a magmux
`send` with `noGate:true, enter:false`: raw SGR bytes in `text`, or named `keys`. The scripts
lived in the gitignored session directory `ai-docs/sessions/dev-feature-capture-history-*`;
this file keeps their results.

## Why not scrollback (`capture` with history)

- The child draws on the ALTERNATE screen (`alt=true`). magmux keeps scrollback only for the
  primary screen, so `scrollback=0` and every capture offset clamps to 0.
- `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` puts the child on the primary screen and magmux keeps
  330–344 rows, but they are a log of repaints: ascending runs `2..146 2..170`, banner and prompt
  twice. They are not "the lines above the screen".
- Decision (Jack, via the status-mod session): forward the person's scroll to the child.
  The `history` argument and the `capture_history` capability were dropped before any code.

## Claude Code's own bindings (2.1.316 bundle)

Context `Scroll` (the live chat): `pageup`→`scroll:pageUp`, `pagedown`→`scroll:pageDown`,
`wheelup`→`scroll:lineUp`, `wheeldown`→`scroll:lineDown`, `ctrl+home`→`scroll:top`,
`ctrl+end`→`scroll:bottom`. The `ctrl+p` / `ctrl+n` / `j` / `k` line bindings belong to the
separate `Transcript` viewer, not the chat. Rows per wheel event come from an acceleration
function gated by the setting `wheelScrollAccelerationEnabled` (default true, "fullscreen mode
only"). With it false, each event moves `max(1, floor(base))` rows; `CLAUDE_CODE_SCROLL_SPEED`
scales `base`.

## Acceleration ON (default): not usable for a row count

Answer `1..400` on screen; "first" is the first number visible.

| Input | Rows |
|---|---|
| single wheel-up, 1.2 s gaps | 0 for the first (a `Jump to bottom` marker appears), then 1 each |
| single wheel-down after ups | 0 for the first (direction change), then 1 each |
| 10 wheel-ups in one send, from the bottom | 15 |
| 10 more in one send | 19 |
| 50 wheel-ups in one send | 237 |
| Page Up / Page Up / Page Down | 20–21 each (half the ~42-row view) |
| ctrl-End `ESC[1;5F` | back to the live bottom, marker gone |
| plain End `ESC[F` | 0: End is a prompt-editing key |

## Acceleration OFF (`--settings '{"wheelScrollAccelerationEnabled":false}'`)

| Input | Rows |
|---|---|
| 10 wheel-ups in one send, from the bottom | 8–9 |
| 11 wheel-ups in one send, from the bottom | 10 |
| 10 more, same direction | 10 |
| 10 same-direction wheel-ups after 30 s idle | 10 |
| 50 wheel-ups after a direction change | 49 |
| 201 wheel-ups in one send (2010 bytes, the shipped `ESC[<64;1;1M`) | 200 |
| 101 wheel-downs after a direction change | 100 |

Rule: one row per event; the first event after a direction change moves 0; leaving the live
bottom costs one event. `planScroll` adds one event in both cases, so `by` is a target ± 1 row.
`MAX_SCROLL_ROWS = 200` comes from the 201-event row.

## Safety (acceleration off, shipped bytes)

| State | Inputs | Result |
|---|---|---|
| empty prompt | wheel up/down, Page Up, ctrl-End | prompt unchanged |
| `hello world` typed, not submitted | 201 wheel-ups, wheel-downs, Page Up/Down, ctrl-End | `❯ hello world` unchanged, no paste |
| RUNNING streaming turn | 201-event burst | no interrupt; turn completed; no stray `[<64;` text |
| AskUserQuestion open | 201 wheel-ups | the dialog scrolls out of view (it is in the scroll region); not answered; ctrl-End brings it back with `1. Red` still highlighted |
| AskUserQuestion opens while scrolled | — | the view does not snap; magmux's gate still reports `dialog:question` (Claude's session registry) |
| permission dialog open | 201 wheel-ups | stays visible (fixed bottom area); `1. Yes` highlighted; not answered; gate `dialog:permission` |
| permission dialog opens while scrolled | — | visible at once; gate `dialog:permission` |
| claudish gated submit while scrolled up 30 | — | accepted at once (`waitedMs:0`); the view snapped to the bottom |
| output arrives while scrolled (no submit) | — | the view stays put while new rows arrive; ctrl-End shows them |

## What claudish does with these numbers

- Pane children run with `wheelScrollAccelerationEnabled: false` (`buildClaudishSettingsOverlay`).
- One call = one magmux `send` of wheel or ctrl-End bytes, `enter:false`, `noGate:true`.
- Before claudish delivers a prompt, a scrolled view gets ctrl-End first, so delivery never
  depends on Claude Code's own submit snap.
- Rationale and state rules: `ai-docs/architecture/pane-session.md` § Scrolling the child's view.
