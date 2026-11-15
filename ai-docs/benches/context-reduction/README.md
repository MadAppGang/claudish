# context-reduction

Does a context-reduction tool cut tokens and cost on a long coding session
without costing the result?

One Scenario, six variants. Claude Code on `claude-sonnet-5-5` gets claudish
as it was one commit before `--context-window` landed, and a prompt that asks
for that feature with subagents for exploration and review. The feature's own
tests grade the result. The agent never sees them.

| Variant | What differs |
|---|---|
| `baseline` | nothing: plain Claude Code |
| `rtk` | a `PreToolUse` hook on `Bash` that runs `/opt/homebrew/bin/rtk hook claude`, plus the instruction file `rtk init` writes |
| `context-mode` | the context-mode plugin, staged from `vendor/context-mode` |
| `context-gateway-local` | `ANTHROPIC_BASE_URL` points at a local Context Gateway, started by a provision step. The gateway trims tool output itself (`trimming`), summarizes nothing and makes no model call |
| `haiku-subagent` | the overlay `config/haiku-subagent`: a Claude Code subagent `output-digest` with `model: claude-haiku-5-5`, which runs a large command or reads a large file region and returns only what the main agent asked for, plus a `CLAUDE.md` that tells the main agent to use it |
| `context-gateway-haiku-key` | a local Context Gateway that compresses tool output and summarizes history with its own calls to `claude-haiku-5-5`, signed with an Anthropic API key, while Claude Code's requests stay on the subscription. Needs `--param gateway_env=<key file>`; see "The gateway key variant" |

A gateway variant that signs its Haiku calls with the captured Claude login is
not here: the API refuses each such call with `429 rate_limit_error "Error"`
(the shape refusal in `ai-docs/architecture/advisor.md`), and the gateway then
sends every output on unchanged.

### Through claudish

`context-reduction-claudish.experiment.yaml` runs the same Scenario with
claudish between Claude Code and the Anthropic API. Its variants set the Bench
param `binary` to `./bin/claudish-unattended`, which runs the first claudish
on `PATH` with `--quiet -y`: no question ("Update now?", "Enable
auto-approve?") then stops claudish before Claude Code starts, which in an
unattended trial ends the Session after a minute. The model stays the bare name
`claude-sonnet-5-5`. A bare Claude name is a normal claudish session on the
Claude subscription, so claudish loads its hooks. A `claude@` model would be a
monitor session, which loads no hooks and ignores `harnessGateway`.

| Variant | What differs |
|---|---|
| `claudish-baseline` | nothing but claudish |
| `claudish-rtk` | the `toolCall` hook `rtk-bash-rewrite.ts` from `docs/advanced/hooks.md` |
| `claudish-context-mode` | the context-mode plugin, staged as in `context-mode` |
| `claudish-context-gateway-local` | `harnessGateway.url` in front of claudish, with the gateway config of `context-gateway-local` |

Provision step 2 runs `tools/claudish/start.sh`, which copies the variant's
`config.json` (and hook file) into the run's `~/.claudish`. claudish reads
hooks and `harnessGateway` from the global config only.

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
5. For the claudish Experiment, put the claudish build you want to measure
   first on `PATH`. `bin/claudish-unattended` runs the `claudish` it finds
   there; `MADBENCH_CLAUDISH` does not change it. A build older than
   `harnessGateway` runs the gateway variant without the gateway, and says
   nothing. On macOS a compiled build must be signed again before it runs,
   or the system kills it with exit code 137:

   ```
   (cd packages/cli && bun run build:binary)
   mkdir -p /path/to/bin && mv packages/cli/claudish /path/to/bin/claudish
   codesign --force --sign - /path/to/bin/claudish
   PATH=/path/to/bin:$PATH madbench …
   ```

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
gateway variants listen on fixed ports (18431; the key variant 18433 and
18434). The claudish Experiment runs the same way with
`context-reduction-claudish.experiment.yaml`.

A run of `context-gateway-haiku-key` without `--param gateway_env=<key file>`
errors at provision, before any spend. `madbench check` therefore reports
that variant as not graded unless it gets a key file too; a fake one is
enough, because the mock harness makes no call.

`--param gateway_bin=<path>` picks the Context Gateway executable (default
`~/.local/bin/context-gateway`). The gateway start script prints its
SHA-256, so the evidence names the build that served each trial.
`claudish-context-gateway-local-streamfix` is `claudish-context-gateway-local`
with a locally patched build; its own `gateway_bin` is
`config/no-gateway-bin`, which refuses to start, so the variant errors at
provision unless the command line names the build.

## The grade

`checks/grade-check.ts` copies the seven files under `hidden-tests/` into the
finished workspace and runs them with `bun test`. The untouched checkout gives
`82 pass`, `19 fail`. The finished feature gives `114 pass`, `0 fail`. The
Check passes only on exit 0 with no failed test; its score is the share of the
114 tests that passed.

## Subagents run in the foreground

`sandbox.env` sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for every variant.
The `Agent` call then returns the subagent's report inside the turn. With
background subagents the main thread's turn ends at once, and madbench 0.58.2
ends the Session while the subagents still run.

For the same reason the Scenario has no `follow_ups`: madbench types a
follow-up when the main thread's turn ends. The review by a third subagent is
step 4 of the prompt.

## The numbers

madbench's own token and cost metrics count the main thread only. To count
the subagents too, sum the `llm_call` Events of the report:

```
bun ai-docs/benches/context-reduction/summarize.ts /absolute/path/report.json
```

It prints one row per trial and one row per variant: prompt tokens (input,
cache creation and cache read together) and output tokens for the main thread
and for the subagents, requests, subagents, compactions, duration, and
madbench's cost figure, then the same sums per model and the subagents started
per trial by name. It takes several report files. A trial that errored before
it was graded goes in its own table and in no mean. `--json <file>` writes the
rows.

## VariantCheck

A graded Check that runs `tools/<tool>/variant-check.sh` when the variant's
tool folder has one, and otherwise passes when the run left a Claude Code
transcript, so it fails under the mock harness either way.

- `haiku-subagent`: every subagent answer in Claude Code's transcripts came
  from `claude-haiku-5-5`, at least one did, and none came from another Haiku.
- `context-gateway-haiku-key`: every request the gateway forwarded was
  signed with the subscription and none fell back to the key, at least one
  Haiku call answered 200, every answer names `claude-haiku-5-5`, no Haiku
  call was signed with a Bearer token, and the gateway compressed a tool
  output.

## The Context Gateway life cycle

madbench has a provision step that runs before the agent, and no step that
runs after it. So:

- `tools/context-gateway/start.sh` runs as the second provision step, called by
  the variant's own `start.sh` with the variant's `config.yaml`. It stops a
  stale listener on the port, starts the gateway with that config, and waits
  for `/health`. A timer stops the gateway after 6000 seconds if nothing else
  did.
- `tools/context-gateway/evidence.sh` runs inside the `ToolEvidence` Check,
  after the agent stopped. It prints the gateway's counts, copies its logs to
  `out/`, and stops the gateway.
- A trial that errors gets no Check, and madbench deletes its sandbox. So the
  start scripts write the gateway's and claudish's logs into `out/` from the
  start (`out/context-gateway-live-*`, `out/claudish-live-*`). The gateway of
  an errored trial keeps running until its timer ends.

The local gateway config (`tools/context-gateway-local/config.yaml`, used by
`context-gateway-local` and `claudish-context-gateway-local`) uses no
third-party service. The `compresr` strategy is off
and its URL is empty. It configures no provider: the gateway trims tool output
inside its own process and makes no model call. It holds no credential; it
forwards Claude Code's own requests. The claudish variant starts it with
`GATEWAY_ALLOWED_HOSTS=127.0.0.1`, because there it forwards to claudish's
proxy on loopback.

The gateway makes one call that the config cannot turn off: a release check
to `api.github.com`. That call carries no workspace data.

The gateway's `expand_context` append breaks Claude Code's stream when it
cuts an event across its 4096-byte reads (`internal/pipes/tool_output/stream_buffer.go`).
Through claudish it ended every trial; natively it ends some. The report
has the details.

## The gateway key variant

`tools/context-gateway-haiku-key/` holds the config, `start.sh`, a usage
recorder and `variant-check.sh`.

- The key travels as a file. The Bench copies the file named by
  `--param gateway_env` (one line `ANTHROPIC_API_KEY=sk-ant-…`, mode 0600) to
  `~/.config/context-gateway/.env`, which the gateway loads at startup. The
  generic provision step deletes that file in every run after `start.sh`, so
  the agent never finds it. The default param value holds no key.
- `start.sh` starts the gateway with `ANTHROPIC_API_KEY` removed from its
  environment. A provision step inherits madbench's environment, which holds
  madbench's own keychain key, and the gateway's `.env` loader never
  overrides a variable that is already set.
- `config.yaml` names `auth: "api_key"`. With no `auth` line, a provider that
  has a key gets the mode "both", and on a 429, 529 or 402 from the
  subscription the gateway signs the main session's requests with the key.
- `usage-recorder.ts` sits between the gateway and `api.anthropic.com` on port
  18434 and writes the model, status and usage of each Haiku answer to
  `logs/haiku_calls.jsonl`, never a header. It refuses a call signed with a
  Bearer token. The summarizer ignores the provider's endpoint, so the config
  names the recorder twice.

## What each variant's evidence shows

The `ToolEvidence` Check is a readout: it does not grade. Its output tail is
in the report JSON under the Check's `evidence.output`.

| Variant | Evidence |
|---|---|
| `baseline` | none |
| `rtk` | `rtk gain`: the tokens rtk counts as saved |
| `context-mode` | the files in its data folders, copied to `out/` |
| `context-gateway-local` | line counts of the gateway's compression, summary and telemetry logs, `session_stats.json`, logs copied to `out/` |
| `haiku-subagent` | the subagent Haiku calls by model, from `model-check.sh` |
| `context-gateway-haiku-key` | the Haiku calls' summed usage from the recorder, the summary events without the startup line, then the gateway's counts as for `context-gateway-local` |
| `claudish-*` | first `route=claudish` and the count of `[Proxy]` lines in claudish's own log, then the evidence of the matching native variant |
