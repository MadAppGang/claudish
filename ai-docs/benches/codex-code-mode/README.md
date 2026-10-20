# codex-code-mode: zero-delta tool calls and code-mode resume on `cx@`

A re-runnable regression check for two shipped changes on the claudish provider
`openai-codex` (`cx@`, the ChatGPT Codex subscription, signed with the OAuth credential in
`~/.claudish/codex-oauth.json`):

1. **Zero-delta function calls.** In a multi-call turn Codex sends no argument deltas, only the
   finished arguments in `.done`. claudish must still hand Claude Code the full tool input.
   Before the fix, parallel Reads came back as `InputValidationError: ... The required
   parameter 'file_path' is missing`.
2. **Code mode** (`--code-mode auto|on|off`, default `auto`). The model gets one freeform `exec`
   tool; claudish runs its JavaScript in a QuickJS sandbox, relays each `tools.X()` call to
   Claude Code as a `tool_use` block, and resumes the script from the `tool_result`s. Defect D1
   (fixed in `4cb34e54`): Claude Code 2.1.303 appended a trailing `role: "system"` message, so
   no script ever resumed, while the final answers still looked right because the nested results
   followed claudish's lost-state note. **A correct answer proves nothing here; only claudish's
   debug log shows whether the script resumed.**

Design rationale: `ai-docs/architecture/code-mode.md` and `ai-docs/architecture/adapters.md`.
The hand-run validation this Bench replaces is in
`ai-docs/sessions/dev-feature-codex-tool-calls-20261016-143706-dc2c/validation/` (gitignored; it
does not survive a fresh clone).

Real Claude Code drives this worktree's claudish build against the real Codex backend. There is
no mock upstream, and nothing is billed per token: every request must sign with the Codex OAuth
credential.

## The Scenarios

| Scenario | Code mode | Prompt | Passes when |
|---|---|---|---|
| `classic` | off (`CLAUDISH_CODE_MODE=off`) | Phase 7's parallel-Read prompt; the answer is 6 | answer 6; three Reads reached Claude Code with `file_path` ending in `a.ts`, `b.ts`, `c.ts`; no tool_result carries `InputValidationError` or a missing `file_path`; the log says `[CodeMode] off (` |
| `auto` | default (`auto`) | the same | answer 6; the same argument Checks; the log says `[CodeMode] on (<shape>, discovery: …)`; **every relayed exec resumed** and none took the lost-state path |
| `auto-edit` | default (`auto`) | Phase 7 V4: create `notes.txt` containing `alpha`, run `wc -c notes.txt` through Bash, report the byte count | `notes.txt` contains `alpha`; the number `wc` printed is in the answer; Bash was used with no input error; code mode on; every relayed exec resumed |

Every Scenario also carries:

- **`subscription`**: every `Calling API:` line in the log is
  `https://chatgpt.com/backend-api/codex/…` (only the OAuth credential signs there; the API-key
  path goes to `api.openai.com`), at least one exists, and every `Handler: provider=` line is
  `openai-codex`. A metered hop or a fallback to another provider fails it.
- **`provenance`**: `claudish-under-test` wrote `claudish-provenance.txt` naming the
  `dist/index.js` it ran and its `claudish version`, so the report records which build ran.

`classic` also has the readout `zero_delta_seen`: the log has
`[ResponsesSSE] zero-delta function_call … emitted N bytes from done` with no `emitted 0 bytes`.
It is a readout because a session whose model happened to stream deltas is a weaker sample, not
a failure.

The testdata (`a.ts`, `b.ts`, `c.ts`) is copied from the Phase 7 run directories
(`it2/V2a/p7i2-V2a-304-1`, `it2/V4/p7i2-V4-304-1`). `notes.txt` is absent, so a session that does
nothing fails `auto-edit`.

## Running it

Build first. The Bench runs `packages/cli/dist/index.js` from this worktree, never the claudish
on `PATH`:

```bash
bun run build                                   # from the repo root
```

The free gates, from this folder:

```bash
madbench list      madbench.yaml
madbench preflight madbench.yaml
madbench check     madbench.yaml                # negative control: all 19 Checks must fail
madbench madbench.yaml --harness mock           # offline dry run
```

The real run, in a visible terminal (not piped, not backgrounded):

```bash
CODEX_CODE_MODE_KEEP_LOGS=<dir> \
  madbench madbench.yaml --concurrency 1 --trials 5 --report-json <out.json>
```

- **`--concurrency 1` is required.** On the first real run, with three claudish sessions starting
  at once, two were reported `agent never started: agent did not start within 1m0s`, although
  their panes showed Claude Code ready at the prompt. One at a time, all three started. The cause
  has not been isolated.
- `--trials 5` gives 15 sessions (about 15 minutes), all on the subscription. Phase 7 used
  10/10/3 sessions by hand; `--scenario auto --trials 10` adds depth where D1 lived.
- A graded miss exits 0. Add `--fail-on-failure` where a miss must turn the job red.
- `madbench grade <out.json> --bench madbench.yaml` re-grades a stored report offline. The `exec`
  and `ts` Checks show their recorded verdicts, because the workspace is gone.

Why each setting:

- **`sandbox: workspace`**, not `home`. `home` replaces `HOME`, which hides
  `~/.claudish/codex-oauth.json`; `cx@` could then only sign with an API key (metered) or not at
  all. `workspace` keeps the real `HOME`, and that is the subscription.
- **`binary: ./claudish-under-test`**: a shim that derives `packages/cli/dist/index.js` from its
  own path, writes `claudish-provenance.txt`, and adds `--debug-claudish --log-level debug -q`.
  The debug log in `logs/claudish_*.log` is what the `exec` Checks read; `-q` returns before the
  update prompt, which would otherwise wait on a TTY nobody answers.
- **`CLAUDISH_CODE_MODE=off`** on `classic` is claudish's documented equivalent of
  `--code-mode off` (`code-mode/policy.ts`: flag > env > project > global > `auto`). Nothing
  passes the flag, and `harness.args` belongs to the whole Bench, so the environment is how one
  Scenario turns code mode off.
- **`driver: false`**: every prompt is an order, so a question from the agent fails the Scenario
  by name instead of being answered by a model and becoming a variable.

## Reading a failure

Read `.summary.errors` before `.summary.failed`: an errored Scenario never graded.

```bash
jq -c '.summary' out.json
jq -r '.results[] | "\(.scenario_id) \(.status)", (.checks[] | select(.result.pass==false) | "  \(.spec.metric): \(.result.reason)")' out.json
```

| Failed Check | Means | Look at |
|---|---|---|
| `resumed` with `relayed=N resumed=0` | **D1 is back**: scripts were relayed and never resumed. The answers may still be right | the inbound request's last message (`code-mode/resume.ts`, `lastMessageResults`); Claude Code's version |
| `resumed` with `lost>0` | a script took the lost-state path (`script lost`, `answered as Script failed`) | the log line the reason prints |
| `resumed` with `relayed=0` | code mode was on but the model never called a nested tool through exec | the transcript; `code_mode_on` |
| `args_intact` | a Read lost its `file_path`, or a tool_result carries `InputValidationError`: the zero-delta defect | `zero_delta_seen`, and the `[ResponsesSSE] zero-delta` lines |
| `code_mode_on` | auto did not choose code mode from discovery | the `[CodeMode] off (<reason>)` line; Codex `/models` (`[CodexDiscovery]`) |
| `code_mode_off` | `classic` ran with code mode on: the environment did not reach claudish | the Scenario's `sandbox.env` |
| `subscription` | a call went somewhere other than `chatgpt.com/backend-api/codex`, or another handler served the request. **That is metered spend or a fallback, never a pass** | the `uniq -c` table in the reason |
| `provenance` | the shim did not run, so the build under test is unknown | `harness.binary`; `bun run build` |
| `bash_output_reported` | `wc` ran but its number is not in the answer, or Bash never ran | the Session's Bash `tool_result` |
| `answer` | the final answer has no 6 | read the other Checks first: on `auto` a right answer with a failed `resumed` is D1 |

An exec Check's reason ends with the tail of its own output on failure (the matching log lines and
the `relayed= resumed= lost=` tally), so most failures can be read straight from the report.

## Keeping the logs

An `exec` Check keeps its output only on failure, and madbench deletes the workspace after the run,
so a passing Check keeps none of the log lines it passed on. Until madbench keeps that output in the
report (feature request drafted, not yet filed), the `provenance` Check carries a TEMPORARY first
line: with `CODEX_CODE_MODE_KEEP_LOGS=<dir>` set it copies `logs/claudish_*.log` and
`claudish-provenance.txt` to `<dir>/<workspace name>/`. Match a folder to its Scenario with the
report's `.results[].session.work_dir`. Delete that line when madbench ships the feature.
