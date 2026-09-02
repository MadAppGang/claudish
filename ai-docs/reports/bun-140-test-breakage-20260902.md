# Bun 1.4.0 breaks five tests, and CI cannot see it

**Date:** 2026-09-02
**Status:** unowned. Not caused by, and not fixable within, the v9.0.0 release.
**Why this is written down:** CI pins Bun 1.3.10 while local development now gets
1.4.0, so the suite is green in CI and red on a developer's machine. That gap
hides the failures until someone bumps the pin, at which point they become a
blocking surprise.

## What happens

`bun --version` on the developer machine: **1.4.0**.
`.github/workflows/test.yml:58`: `bun-version: "1.3.10"`.

Full suite locally on 1.4.0:

```
3074 pass / 14 skip / 5 fail across 195 files
```

The five failures sit in exactly two files:

```
(fail) team run cancellation > returns a live handle before children finish and removes liveness on settle
(fail) team run cancellation > cancels one slot while leaving the other slot running
(fail) team run cancellation > cancels every slot when no slot id is supplied
(fail) displayWidth fallback — measured against the oracle … zero disagreement on every class that reaches a dashboard
(fail) displayWidth fallback — measured against the oracle … the whole-Unicode disagreement budget holds, by category
```

## 1. `tui/viz/color.test.ts` — the oracle moved, and the test is doing its job

This test measures claudish's hand-maintained `displayWidth` table against
`Bun.stringWidth`, deliberately. Its own comment says so:

> `Bun.stringWidth`, a maintained Unicode width table, so drift fails the suite

Bun 1.4.0 ships an updated Unicode width table. The disagreement budget:

```
expect(total).toBeLessThanOrEqual(1081);   // the previous hand table scored 11,205
Received: 3017
```

**This is not a broken test. It is a working detector reporting real drift.**
claudish's table now disagrees with the current Unicode data on 3017 codepoints,
up from a tuned budget of 1081. Anything that renders those codepoints in the TUI
will mis-measure their width and misalign.

The fix is to re-derive the table against 1.4.0's oracle and re-tune the budget,
or to decide the table should defer to `Bun.stringWidth` where it is available.
Deleting or raising the budget without re-deriving throws away the only mechanism
that noticed.

## 2. `team-cancel.test.ts` — an EPIPE from a runtime internal

Three tests throw rather than fail an assertion:

```
code: "EPIPE"
  at end (unknown:1:1)
  at internal:fs/streams:402:23
  at _destroy (internal:streams/destroy:63:18)
```

No assertion failed. Bun 1.4.0 changed stream teardown behaviour and the test's
process/pipe handling no longer survives it. This needs someone who owns the team
orchestrator to decide whether the test's harness or the orchestrator's stream
handling is at fault.

## Why it is definitely the toolchain, not the v9.0.0 change

Checked mechanically rather than asserted:

- `packages/cli/src/tui/viz/color.test.ts` imports `./color`, `./text`, `./tokens`.
  `git status --porcelain packages/cli/src/tui/viz/` was **empty** across the whole
  change — not one file in that directory was touched.
- `packages/cli/src/team-cancel.test.ts` imports only `./team-orchestrator.js`,
  which is not in the change set.
- The green baseline that this release was measured against
  (3066 pass / 14 skip / **0 fail**) was captured with `bun test v1.3.10` in its
  header. That header is what made the attribution a one-step check rather than a
  bisect.

## What to do

1. **Do not bump `test.yml`'s pin to 1.4.0 until both are fixed.** Doing so turns
   a hidden problem into a blocked pipeline.
2. Re-derive the `displayWidth` table against 1.4.0's `Bun.stringWidth` and re-tune
   the budget. Treat the 3017 figure as a real defect count in the TUI's width
   handling, not as a number to raise.
3. Diagnose the `team-cancel` EPIPE against 1.4.0 stream teardown.
4. Note that `release.yml` uses `bun-version: latest`, so the **release** workflow
   already runs on 1.4.0. It builds and publishes rather than testing, so it is
   unaffected today — but that is a second place where the toolchain floats while
   the test gate is pinned.

## The general lesson

A pinned CI toolchain and a floating local one produce a suite that is green where
it is enforced and red where it is developed. Both readings are correct and they
disagree, which is the same shape as every other defect this release fixed: two
sources of truth, no mechanism to reconcile them. Recording the interpreter version
in the test capture is what made this cheap to diagnose; keep doing that.
