# CLI `claudish team run` without --grid ran the grid and emptied input.md

Date: 2026-10-17. Status: **fixed in 11.0.0** — `fix(team): keep an existing input.md when `team run` has no --input` and `fix(team)!: run `team run` as panes when --grid is not given`.

## Symptom (claudish 10.6.3)

`claudish team run --path P --models gpt-6.1-sol`, with P/input.md holding the task (238 bytes) and no `--input`, `--grid` or `--mode`:

- P/input.md was 0 bytes afterwards.
- P/gridfile.txt existed and ended in `claudish --model gpt-6.1-sol -y --quiet ''`: the magmux GRID ran, with an empty prompt.
- status.json: slot 01 `FAILED`, `exitCode` 1 after 2 s, `spawnModel`/`provider`/`pane` null (the placeholders `buildTeamStatus` in team-grid.ts writes for a grid slot).

The help text (`--input <text>  Task prompt (or create input.md in --path beforehand)`), the doc comment of team-cli.ts and team-capture.md all say a bare `team run` runs interactive panes, like the MCP `team` tool.

## Causes — two independent defects, both in the CLI `team run` branch

- **Mode.** `teamCommand` defaulted `--mode` to `"default"`, which selects `runWithGrid`; only the undocumented `--mode json` reached `runPaneTeam`, and `--grid` mapped to the same `"default"`. History: the default dates from v6.7.0 (the magmux grid); the commit that added pane mode, its help text and its doc comment did not change it. An unknown `--mode` value also ran the grid.
- **Input.** The grid branch passed `input ?? ""` to `runWithGrid`, and `setupSession` (team-orchestrator.ts) writes input.md for any value that is not `undefined`, so the empty string replaced the task. `runWithGrid` then read the empty file back as every pane's prompt.

Neither affects the MCP `team` tool: it never calls `runWithGrid`, and passes the inline text, the `input_file` content or `undefined`, never `""`. The other CLI entry, `claudish --team a,b "prompt"`, refuses an empty prompt first, and its grid default matches its own help.

## Decision (Jack, 2026-10-17)

A bare `team run` runs panes, as documented. `--grid` / `--mode default` and `--interactive` keep the grid. An unknown `--mode` exits 2, naming `default`, `interactive` and `json`, before anything is written to the session path. This is a breaking change for anyone who used the bare command to get the grid.

## Verification

- `packages/cli/src/team-cli-run-mode.test.ts` (hermetic, fake model `contract-fake-a`): before the fix a bare run wrote gridfile.txt with a null pane and an emptied input.md, and `--mode bogus` exited 0 and wrote manifest.json; after it, 3 pass / 0 fail.
- The input defect was reproduced against the real `setupSession`: `undefined` kept a 15-byte input.md, `""` left 0 bytes.
- Live, 2026-10-17, built CLI: a bare `team run` with a pre-written input.md ran on a pane, kept input.md at 238 bytes, and the slot COMPLETED.
