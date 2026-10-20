# resize_session and team resize: live validation, 2026-10-20

Branch `worktree-claudish-mcp-session-size` on `main` v12.0.0, built with `bun run build`, run as
`bun packages/cli/dist/index.js --mcp` over stdio and driven by an MCP client script
(`ai-docs/sessions/dev-feature-session-resize-20261014-222741-f3b4cc44/validation/live-resize.ts`,
gitignored). Child: real Claude Code on `haiku` through the native passthrough. magmux 0.17.0
(`/opt/homebrew/bin/magmux`, `magmux 0.17.0 (1fb6377)`).

"Rule" is the longest run of `─` on any captured line. A full-width input-box rule equals the
terminal width, so it is the edge-to-edge check the feature request asked for.

| Check | Result |
|---|---|
| boot reaches AWAITING_INPUT | PASS |
| `resize_session` 400×100 answers the size set | PASS `{"cols":400,"rows":100,"changed":true,"seq":4}` |
| capture after it is 400×100, rule edge to edge | PASS seq 4, rule 400 |
| the same size again | PASS `changed:false`, seq unchanged (4) |
| mid-turn resize 600×120 | PASS seq 5 |
| mid-turn resize back to 400×100 | PASS seq 12 |
| the turn settles after both mid-turn resizes | PASS AWAITING_INPUT, turns 1, answer ends `DONE` |
| capture after the turn is 400×100, rule edge to edge | PASS seq 15, rule 400 |
| 1000×200, rule edge to edge | PASS seq 16, rule 1000 |
| turn 2 settles at 1000×200 | PASS |
| (50, 10) clamps to 80×24 | PASS |
| (10000, 50) clamps to 9999×50 | PASS |
| `team(mode:"resize")` slot 01 to 400×100 | PASS seq 4 |
| `team(mode:"capture")` is 400×100 | PASS rule 400 |
| the team slot settles COMPLETED after the resize | PASS |

16/16 checks passed.

## Full suite on the same tree

`bun run test:safe` in a terminal (`script -q`): 6230 pass, 48 skip, 3 todo, 1 fail in 1383 s; then
`packages/macos-bridge` 23/23 and `scripts/` 9/9, which the `&&` chain had skipped.

The one failure is `onepassword.test.ts` "a peer denial counts down and retries once the peer
releases the prompt" (`Expected to contain: "try 1/3"`). It is unrelated to this branch and
depends on stderr being a TTY: `countdownForUnlock` (`providers/onepassword.ts:1602`) prints the
countdown line up front only when stderr is not a TTY, and on a TTY only inside the loop, which
the test's probe ("held" once, then "released") exits before the first tick. It passes without a
TTY, which is how CI runs it.
