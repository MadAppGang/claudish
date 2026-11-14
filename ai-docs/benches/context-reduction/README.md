# context-reduction

Does a context-reduction tool cut tokens and cost on a long coding session
without costing the result?

One Scenario, four variants. Claude Code on `claude-sonnet-5-5` gets claudish
as it was one commit before `--context-window` landed, and a prompt that asks
for that feature with subagents for exploration and review. The feature's own
tests grade the result. The agent never sees them.

| Variant | What differs |
|---|---|
| `baseline` | nothing: plain Claude Code |
| `rtk` | a `PreToolUse` hook on `Bash` that runs `/opt/homebrew/bin/rtk hook claude`, plus the instruction file `rtk init` writes |
| `context-mode` | the context-mode plugin, staged from `vendor/context-mode` |
| `context-gateway` | `ANTHROPIC_BASE_URL` points at a local Context Gateway, started by a provision step |

## Before a run

1. Put a node of version 24.15.0 or later first on `PATH`. context-mode
   refuses an older one. On this machine: `PATH=/opt/homebrew/bin:$PATH`.
2. Fetch context-mode: `sh fetch-context-mode.sh`. It clones the pinned tag
   into `vendor/context-mode`, which git ignores. The licence of context-mode
   is Elastic License 2.0, so its code is never committed here.
3. Make the output folder: `mkdir -p out`. madbench refuses a share whose
   source folder does not exist. Git ignores `out/`.
4. The tools must be installed: `rtk` 1.2.0 at `/opt/homebrew/bin/rtk`,
   `context-gateway` v0.5.3 at `~/.local/bin/context-gateway`.

## Run

From the repository root. Do not pipe the command and do not put it in the
background: madbench drops to its plain log when stdout is not a terminal.

```
madbench list ai-docs/benches/context-reduction/context-reduction.experiment.yaml
madbench preflight ai-docs/benches/context-reduction/context-reduction.experiment.yaml
madbench check ai-docs/benches/context-reduction/context-reduction.experiment.yaml
madbench ai-docs/benches/context-reduction/context-reduction.experiment.yaml \
  --trials 3 --concurrency 1 --report-json /absolute/path/report.json
```

`--variant baseline` runs one variant. `--concurrency 1` is required: the
gateway variant listens on one fixed port, 18431.

## The grade

`checks/grade-check.ts` copies the seven files under `hidden-tests/` into the
finished workspace and runs them with `bun test`. The untouched checkout gives
`82 pass`, `19 fail`. The finished feature gives `114 pass`, `0 fail`. The
Check passes only on exit 0 with no failed test; its score is the share of the
114 tests that passed.

## The Context Gateway life cycle

madbench has a provision step that runs before the agent, and no step that
runs after it. So:

- `tools/context-gateway/start.sh` runs as the second provision step. It stops
  a stale listener on the port, starts the gateway with
  `tools/context-gateway/config.yaml`, and waits for `/health`. A timer stops
  the gateway after 6000 seconds if nothing else did.
- `tools/context-gateway/evidence.sh` runs inside the `ToolEvidence` Check,
  after the agent stopped. It prints the gateway's counts, copies its logs to
  `out/`, and stops the gateway.

The gateway config uses no third-party service. The summarizer is Haiku on
the Anthropic API, signed with the same Claude login the session uses
(`auth: oauth`). The `compresr` strategy is off and its URL is empty.
The gateway makes one call that the config cannot turn off: a release check
to `api.github.com`. That call carries no workspace data.

## What each variant's evidence shows

The `ToolEvidence` Check is a readout: it does not grade. Its output tail is
in the report JSON under the Check's `evidence.output`.

| Variant | Evidence |
|---|---|
| `baseline` | none |
| `rtk` | `rtk gain`: the tokens rtk counts as saved |
| `context-mode` | the files in its data folders, copied to `out/` |
| `context-gateway` | line counts of its compression and summary logs, `session_stats.json`, logs copied to `out/` |
