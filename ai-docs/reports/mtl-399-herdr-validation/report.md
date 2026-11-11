# MTL-399 report: claudish sessions as native herdr items

Branch `worktree-mtl-399-herdr-native-sessions`, 17 commits on origin/main 7edda7c4 (v14.19.1).
139 files changed, +18,964 / −206. Depth full, automation guided. Not pushed or released yet.

## What it does

Each claudish MCP session (`create_session` and `team` slots) and each replay runs in one magmux
pane, as before. magmux 0.19.0 now also opens a read-only `.view` socket for that pane. claudish
publishes only that socket, and three front ends read it:

- **herdr terminal.** The MCP server places one read-only viewer pane per session in a `claudish`
  tab. The pane reports the session's state, model, tokens and turns to herdr's Agent panel, and
  closes when the session ends.
- **Herdr.app.** A mod lists the sessions and opens a view of one.
- **Any terminal.** `claudish view <target>` and `claudish view --list`.

Only one view sets the width at a time. A Claude Code `resize_session` takes the view. Enter or
focus in a herdr viewer takes it back. The rows carry the holder in an additive `view` field, which
the Claude Code mod (magus-src PR #311) reads to collapse to a band.

## Requirements

| Req | State | Where |
|---|---|---|
| FR1 several readers per session | done | `view/view-server.ts`, magmux `.view` |
| FR2 details and status | done | `view/view-directory.ts`, `ViewItem`, subagent rows (`033dbc86`) |
| FR3 live screen from magmux | done | `view/magmux-view-client.ts`, `view/ansi-painter.ts`; check 3 |
| FR4 one active view | done | `view/view-claims.ts`; check 5 |
| FR5 herdr terminal | done | `herdr/placer.ts`; checks 1, 2, 4 |
| FR6 Herdr.app | partial | mod installs, passes `herdr-app check`, panel opens; live list waits for the release |
| FR7 replays | done | cross-server replay sharing (`4194e7b2`); check 6 |
| FR8 Claude Code mod | waiting | magus-src PR #311, held until MTL-419 makes its CI green |
| FR9 env strip | done | `b1c1892e`; check 8 |
| NFR (idle cost, security, tests) | done | two-stage change gate, no timers while idle; only `.view` published; HERDR_*/HC_* stripped |

## Architecture decisions

The plan is `architecture.md`. These decisions changed during review (Phase 3):

- Claims come only from user acts, mode `take` only. `if_free` gave the view to background panes.
- Replays are shared across MCP servers under a kernel `flock`. File locks failed two review
  rounds (stale takeover).
- Placement uses `layout.apply` into a scratch tab, then `pane.move`. It does not type an `exec` line.
- The placer closes only its own panes, after a 4 s grace.
- The `.view` socket is dialed once at attach, and `readOnly: true` is required (the two-socket
  check).
- The magmux floor is 0.19.0. A version off the 0.x line is refused.

Phase 4 changes are listed in `implementation-log.md` § Decisions changed (mostly optional type
fields, so that existing test literals still compile).

## Reviews

- Plan review: 3 rounds plus a targeted check. It ended CONDITIONAL (0 CRITICAL, 2 HIGH, 1 MEDIUM).
  Jack approved it with the three fixed in P5.
- Code review round 1: FAIL (6 HIGH). All six were fixed test-first.
- Code review round 2: PASS (0 CRITICAL, 1 HIGH, 3 MEDIUM; gpt-6.1-sol, gemini-4-argon, internal).
  The HIGH (concurrent reconnect loops, 3,167 dials in 40 s) was fixed in `64c556d5`. The three
  MEDIUMs were fixed test-first (`implementation-log.md` lines 950-952).

## Tests

- Full suite, `bun run test:safe`: 9739 pass, 6 fail, all 6 in `provider-fallback.blackbox.test.ts:335`.
  That test was fixed afterwards, and 3 runs in a row then passed 26/26.
- After the rebase: `scripts/spawn-env.test.ts` found 4 test spawns with no `env`. Fixed in
  `f60baee5`; it now passes 2/2.
- `bun run typecheck` exit 0, `bun run lint` exit 0 (warnings only), `bun run build` exit 0.
- Negative controls: `tests/negative-control.md`.

## Real validation

Run live in herdr 0.9.5 and Herdr.app with the built binary. Details and evidence are in
`validation/result.md`.

| # | Check | Result |
|---|---|---|
| 1 | tab and view pane, caller focus kept | PASS (failed first; fixed `1bdadf9b`) |
| 2 | Agent panel states | PASS |
| 3 | one magmux, live screen | PASS |
| 4 | team slots: two rows, both close | PASS |
| 5 | width handover | PASS (claudish side) |
| 6 | replay both ways, one magmux | PASS |
| 7 | no herdr call outside herdr | PASS |
| 8 | pane child does not report into the caller | PASS |
| 9 | Herdr.app mod | PARTIAL (outdated-claudish message fixed `c97e5991`) |
| 10 | pane-hooks tests under herdr | PASS, a timing flake that main shares |

Outer loop: 2 validation iterations.

## Known issues

- Check 9: the live list in Herdr.app needs the released build. The mod runs the global claudish
  (14.19.1, which has no `view`). I did not replace it, because every claudish MCP server on the
  machine uses it.
- Check 9: `mod.json` `"place": "right"` did not dock the panel. `herdr-app do pane.split` shows it.
  The cause is unknown.
- FR8: the band in the Claude Code mod is in PR #311, which waits on MTL-419.
- pane-hooks timing flake: after the rebase, branch 8/10 runs with failures against main 4/10
  (p ≈ 0.17). The same tests fail on both sides, and per-test times show no branch-only cost
  (+2.8%, in both directions). Sent to triage2. Main's residual is not changed on this branch.

## Next steps

1. Wait for triage2's call on the pane-hooks numbers.
2. Push the branch, open the PR, merge when CI is green, and release with `/dev:release`.
3. On the released build: check 9 live list and screen in Herdr.app, and the docking cause.
4. When MTL-419 merges, merge PR #311 and close the child's pane.
5. Clean up: stop the herdr check session, the driver, `logs/` debug files and the scratchpad main
   baseline.
