# Validation Result - Iteration 2

## Summary
- **Status**: PASS (checks 1-8 and 10 pass with evidence; check 9 passes in part, with two named gaps)
- **Timestamp**: 2026-11-11T08:15Z
- **Where**: herdr 0.9.5 session `claudish-mtl399-check` in a visible Ghostty window; Herdr.app window;
  built binary `packages/cli/dist/index.js` driven over MCP stdio by `validation/driver.ts` (pane w1:p1,
  server pid 5488); magmux `/opt/homebrew/bin/magmux 0.19.0 (9c45e07)`.
- **Iteration 1** (server 84037): check 1 FAILED, no claudish tab, `[herdr] placement ... abandoned`.
  Cause: herdr answers one request per connection and closes it; HerdrSocket reused one connection.
  Fixed test-first in 7094c707. Details in `progress-notes.md`.

## Checks
| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | claudish tab and view pane; caller focus unchanged | PASS | tab `claudish` w1:t8, pane w1:p8; caller tab w1:t1 keeps `focused:true`; no scratch tab left. `c1-after-panes.json`, `c1-after-agents.json` |
| 2 | Agent panel states | PASS | `claudish · gpt-6-luna`: working(Bash) -> working(thinking) -> working(finishing) -> done "awaiting input", tokens and turns update live. `c2-agent-states.log` |
| 3 | one magmux; view shows the live screen | PASS | one magmux (6597, parent 5488) before and after focus; focused view pane screen = `capture_session` screen. `c3-processes.txt`, `c3-capture-session.txt`, `c3-view-pane-focused.txt` |
| 4 | 2-slot team: two rows, two panes, both close | PASS | rows w1:p9 (slot 01), w1:pA (slot 02), each working -> done COMPLETED; both rows and panes gone by +14.3 s; no slot magmux left. `c4-agent-rows.log`, `c4-after-tabs.txt` |
| 5 | width handover | PASS (claudish side) | resize_session 120x40 `claude_code`, pane band -> Enter in herdr 219x56 `herdr` -> resize_session 120x40 `claude_code`. `driver-log.jsonl`. Gap: the mod's band drawing lives in magus-src PR #311 (held for MTL-419); the `view` field it reads is verified |
| 6 | replay both directions, one replay magmux | PASS | (a) replay-57fe64ef4639da5f: placer pane w1:pB; claude_code -> herdr (218x56) -> claude_code; close_replay closes the pane. (b) `claudish view e0754148` -> replay-580346732a9e37da; mod replay_session returns the SAME id with holder `herdr`; expand -> `claude_code`; `q` drops only the viewer's hold; close_replay `closed:true`. (c) one magmux per replay (79841, 92535) |
| 7 | no herdr call outside herdr | PASS | HERDR_/HC_ unset: session f781a5a7 runs, `view=null`; check and main herdr tab lists identical; 0 `[herdr]` lines in its debug log. `c7-plain.log` |
| 8 | pane child does not report into the caller | PASS | caller pane w1:p1 has no agent after a full turn; 0 HERDR_/HC_ vars in magmux, claudish, claude (positive control: 7 in server 5488). `c8-caller-pane.json` |
| 9 | Herdr.app mod | PARTIAL | `claudish herdr install-app-mod` installs; `herdr-app check` passes (`c9-check.txt`); the panel opens beside a terminal (`c9-shot-split.png`). Live run found the panel calling an outdated claudish "not installed"; fixed test-first in b88aec6d, hot-reloaded (`c9-shot-update-line.png`). Gaps below |
| 10 | pane-hooks.integration.test.ts under herdr | PASS, 1 flaky run | under herdr: 4 of 5 runs 55/55; run 1 had 6 fails, a no-herdr control run had 3; all in `done()`'s 10 s leftover wait (watcher not finished). origin/main 4 of 4 runs 55/55. `c10-*.log` |

## Named gaps
- **Check 9, live list and screen.** The mod runs the first `claudish` on `~/.bun/bin:...`, which is the
  released 14.19.1 (no `view`). Showing this branch there needs the release, or replacing the user's
  global claudish, which every claudish MCP server on the machine runs. Checked after the release.
- **Check 9, docking.** `mod.json` `"place": "right"` did not dock the panel when the app first ran with
  the folder present; `seen.json` never listed `claudish`. `herdr-app do pane.split
  '{"direction":"right","mod":"claudish"}'` shows it. Cause not yet known.
- **Check 5, mod band.** Drawn by PR #311 (held for MTL-419).
- **Check 10, intermittent cleanup timing.** 2 of 6 branch runs exceeded the 10 s leftover wait on a
  loaded machine (load 10-14 on 18 cores); 0 of 4 origin/main runs. No change in the cleanup path
  explains it (the watcher gained one `rm -f`). Reported to triage.

## Defects found and fixed in this phase
- 7094c707 `fix(herdr): open one socket connection per herdr request`
- b88aec6d `fix(herdr): name an outdated claudish in the Herdr.app panel, not missing`

## Rejection Rules Applied
- [x] No "should work" assumptions accepted
- [x] No "tests pass" as final proof: every check ran live in herdr
- [x] No "pre-existing issue" excuses: check 10's failures were compared against origin/main
- [x] Screenshot and capture evidence saved under `validation/`
