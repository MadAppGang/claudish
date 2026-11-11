# Phase 7 progress notes (live, herdr session claudish-mtl399-check)

Setup: Ghostty window runs `herdr --session claudish-mtl399-check` (open-check-session.sh).
Driver `validation/driver.ts` in pane w1:p1, built binary, `CLAUDISH_DEBUG=1`.

## Iteration 1 (server pid 84037, session 0441fed6): check 1 FAIL
- No claudish tab. Debug log: `[herdr] placement for s:0441fed6 abandoned` x3.
- Cause measured with `probe-one-connection.ts`: herdr 0.9.5 answers one request per
  connection, then closes it (+102ms data, +103ms close; 2nd request unanswered).
  HerdrSocket shared one connection, so tab.list after layout.apply was dropped.
- Fix 7094c707 `fix(herdr): open one socket connection per herdr request`, test-first
  (2 new herdr-socket tests red with "no reply (dropped)", then green; herdr/view/pane
  1345 pass 0 fail). Rebuilt.

## Iteration 2 (server pid 5488, session e0754148)
- Check 1 PASS: tab `claudish` w1:t8, pane w1:p8, caller tab w1:t1 keeps focus.
  Evidence c1-after-panes.json, c1-after-agents.json.
- Check 2 PASS: working(Bash) -> working(thinking) -> working(finishing) -> done
  "awaiting input", tokens and turns update. Evidence c2-agent-states.log.
- Check 3 PASS: one magmux (pid 6597, parent 5488) before and after focus; focused view
  pane screen equals capture_session screen. Evidence c3-processes.txt,
  c3-capture-session.txt, c3-view-pane-focused.txt. Before focus the passive pane shows
  the band (claim on focus, as decided).
- Check 5 PASS (claudish side): resize_session -> 120x40 holder claude_code, pane band;
  Enter in pane -> 219x56 holder herdr; resize_session -> 120x40 claude_code. First
  capture right after Enter still read 120x40 (resize not yet applied); 2nd read 219x56.
  GAP: the mod's "viewing in herdr" band rendering is in magus-src PR #311 (waits MTL-419).

- Check 8 PASS: caller pane w1:p1 has no agent (agent_status unknown) after a full turn.
  `ps eww`: 0 HERDR_/HC_ vars in magmux 6597, claudish 6598, claude 6653; positive control
  on server 5488 finds 7 HERDR_ names. Evidence c8-caller-pane.json.
- Check 4 PASS: team run team-c4-mwbtrl9j-6c162b, 2 slots -> rows w1:p9 (slot 01) and w1:pA
  (slot 02), working -> done COMPLETED, both rows and panes gone by +14.3 s; claudish tab back
  to 1 pane; no slot magmux left. Evidence c4-agent-rows.log, c4-after-tabs.txt.
- Check 7 PASS: driver with every HERDR_/HC_ unset, TERM_PROGRAM=ghostty: session f781a5a7
  AWAITING_INPUT, view=null; check and main herdr tab lists identical before/after; debug
  log claudish_2026-11-11_07-58-10_69929.log has 0 `[herdr]` lines. Evidence c7-plain.log.
- cancel_session e0754148 -> claudish tab closed with its last pane, magmux gone.
- Check 6 PASS:
  (a) replay_session -> replay-57fe64ef4639da5f, placer tab w1:tB pane w1:pB (passive band);
      resize (expand) -> claude_code; Enter in pB -> capture answers herdr 218x56; resize
      (band click) -> claude_code, pB shows band; close_replay -> pane and tab closed, 0 magmux.
  (b) `claudish view e0754148` in new herdr tab w1:tC -> opens replay-580346732a9e37da, holds
      (218x56); mod replay_session -> SAME replay_id, holder herdr; expand -> claude_code,
      herdr viewer shows band. q in viewer -> its pane closes, replay stays (mcp hold);
      close_replay -> closed:true, 0 magmux.
  (c) one replay magmux per replay throughout (79841 in a, 92535 in b).

Remaining: 9 (Herdr.app), 10 (pane-hooks under herdr).
