# recommended-effort: does the caller pass the recommended effort, and does it reach the wire?

The feature (`ai-docs/architecture/wire.md` § Recommended effort): MCP `list_models` appends a
"Recommended effort by task type" table read from
`~/.claudish/cloud-models-catalog-v3.efforts.json`. The calling agent maps its own task to a
column and passes one effort per model: `team` `efforts: {"<model>": "<level>"}`,
`create_session` `effort`, `run_prompt` `effort`. claudish does not choose a task type.

One Bench, `madbench.yaml`, five Scenarios, and one Experiment, `effort.experiment.yaml`, with
four variants. The prompts never mention effort (`hint` is empty).

| Variant | Staged claudish plugin (`harness.config.plugins`) | How the user names models |
|---|---|---|
| `installed-skill` (baseline) | `plugins/installed/claudish`: the installed `claudish@magus` 2.10.0 `claudish-usage` skill, no effort section | exact ids |
| `worktree-skill` | `plugins/worktree/claudish`: a copy of this worktree's `packages/cli/skills/claudish-usage/SKILL.md` | exact ids |
| `worktree-family` | the same worktree copy | families only ("two different OpenAI GPT models", "a GPT model and a MiniMax model"); no MiniMax model has a row, so its effort must still be omitted |
| `installed-family` | `plugins/installed/claudish` | families only, as `worktree-family`: the field case of a user whose claudish@magus plugin predates the model check (run10's `team ["gpt","minimax"]`) |

The two plugin folders hold the same `plugin.json` and differ only in `SKILL.md`, so the guard
(`allow: [harness/config/plugins]`) sees one changed file. **Refresh the worktree copy before
every run** (`cp packages/cli/skills/claudish-usage/SKILL.md
ai-docs/benches/recommended-effort/plugins/worktree/claudish/skills/claudish-usage/SKILL.md`).
It is a real copy because madbench copies a symlink as a symlink, and at `home` the read
confinement would deny its target. Staging replaces the host's plugin set, so neither variant
loads the installed plugin's hooks or any other host plugin. `config.plugins` needs sandbox
level `home`, so the run's real `~/.claudish` is shared back in with `share.paths` (`rw`).

Levels in the table below are generation `g-20261022002624894-85e83b1a`; the Checks read the
generation live, so they stay right when the table changes. The host is native Claude Code
(`{{host}}`, default `claude-sonnet-5-5`, billed to the subscription) with only the claudish MCP
server of THIS worktree's build. The prompts are written like a user's request: they name the
task and (except one) the models, and never mention effort or `list_models`. Whether the agent
finds the table from the tool descriptions and `list_models` output alone is the measurement.
The installed `claudish-usage` skill predates the feature and is not changed.

| Scenario | Tool | Task-type column | Models |
|---|---|---|---|
| `team-frontend` | `team` run | `frontend_ui` | `gpt-6-astra` (xhigh), `gpt-6.1-sol` (high); family variant: two GPT models |
| `session-code-review` | `create_session` | `code_review` | `gpt-6-luna` (xhigh); family variant: a GPT model |
| `run-prompt-pick` | `run_prompt` | `implementation` | the agent picks one recommended OpenAI GPT model (`gpt-6-luna` max, `gpt-6-astra` high, `gpt-6.1-sol` medium) |
| `team-no-entry` | `team` run | `quick_edit` | `gpt-6-astra` (low) and `minimax-m3`, which has NO row: its effort must be omitted; family variant: a GPT and a MiniMax model |
| `session-named-old-model` | `create_session` | `code_review` (readout only) | `gpt-5` by its exact name, outside the recommended list: the call must carry `user_required_model: true`. The provider may refuse it (no credit); that is not graded |

The models are Codex subscription (`cx@`) and OpenCode Go (`zengo@minimax-m3`) routes, checked
live with `bun packages/cli/dist/index.js --probe <model> --json` before the run. All Codex
connections use the Responses API, which echoes the request's `reasoning.effort` in
`response.created`; that echo is the Layer B wire evidence (below).

## What each Check proves

The effort, bare-name and layer-B Checks grade the call that STARTED work: the last start call answered with none of `needs_effort`, `unknown_model`, `not_recommended`, `Error:` (`startedCall`, `checks/effort-lib.ts`). `ConsultedTable` is a readout: `needs_effort` also hands the agent the rows.

Two layers, kept as separate Checks so one can be read without the other.

| Check (metric) | Layer | Proves | Does not prove |
|---|---|---|---|
| `environment:mcp-reachable` | setup | the worktree's MCP server started in the run's sandbox and answered madbench | anything about the agent |
| `environment:skill-registered` `claudish:claudish-usage` | setup | Claude Code registered the staged plugin's skill | which text it holds (the guard diff and the staged folder say that) |
| `session:skill-used` `claudish:claudish-usage` (`SkillUsed`, readout) | A, readout | the agent opened the skill | nothing about the verdict |
| `ts` `checks/needs-effort.ts` (`NeedsEffort`, readout) | A, readout | how many start calls claudish answered with `needs_effort` before the call that started work, whether that call carries the Scenario column's levels, and every column its levels are consistent with | why the agent chose the column |
| `ts` `checks/bare-names.ts` (`BareNames`) | A | every model in the first start call is a bare name: no `provider@` (no prompt names a provider) and no aggregator-qualified `vendor/model` id | that routing chose a subscription |
| `session:tool-sequence` [`list_models`, start tool] (`ConsultedTable`) | A | the agent read `list_models` (where the table is) before it started the work | that it read the table, or the right column |
| `ts` `checks/model-choice.ts` (`ModelChoice`) | A | `expect: recommended`: every id the last STARTED call ran (not answered `unknown_model:` / `not_recommended:` / `needs_effort:` / an error) is in `~/.claudish/recommended-models-cache-v2.json` `models[].id`, read at grading time. `expect: user-named`: it ran the named `model` and marked it in `user_required_model`. Evidence: `modelCheckBefore`, the `unknown_model` / `not_recommended` answers before it | why the agent chose that id |
| `ts` `checks/effort-args.ts` (`EffortArgs`) | A | the FIRST start call passed, for every model it ran, exactly the table entry of the Scenario's column in the newest sidecar generation, and no effort where the table has no entry; for named-model Scenarios, it ran exactly the named models. Score = fraction of models right | why it chose (the reasoning is not graded) |
| `ts` `checks/effort-plumbing.ts` stage `flag` (`EffortFlag`) | B | for each (model, level) the agent passed, a child claudish wrote `[ComposedHandler] --effort <level> pinned for <model>`: the child got `--effort-override <level>` | the request body; see `wire` |
| `ts` `checks/effort-plumbing.ts` stage `wire` (`EffortWire`) | B | the provider's own `response.created` event, logged raw as `[SSE:responses]` in the same process's debug log, echoes `"reasoning":{"effort":"<sent>"}` where `<sent>` is the level, or the level a `[Wire] … effort A → B` note says step 5w mapped it to | anything for a connection that is not the Responses API (no echo) |

Layer B grades whatever effort the agent passed, right or wrong, so a Layer A miss does not hide
a working pipe. The Checks pin no level: they read the newest generation of the sidecar
at grading time, which is the generation `list_models` rendered (`latestEffortRecommendations`
picks the largest `writtenAt`; the Check does the same) and record its id in Evidence.

## Where Layer B's evidence comes from

The MCP server is declared inline with two environment variables:

- `CLAUDISH_BIN=<dist/index.js>`: `team` and `create_session` children run this build
  (`spawn-claudish.ts`), not the `claudish` on PATH.
- `CLAUDISH_DEBUG=1`: the server (`mcpDebugLogEnabled`) and every child (inherited through
  `buildPaneEnv`) write a debug log to `<cwd>/logs/claudish_<time>_<pid>.log`. The cwd of the
  server and of every slot and session is the workspace, so `Session.work_dir/logs/` holds one
  file per process. `run_prompt` runs in the server's own proxy, so its evidence is in the
  server's file; a child's is in the child's file, matched by its pin line.

claudish itself names the effort in a `[Wire]` line only when step 5w changes it (`effort A → B`,
`wire-request.ts` `applyReasoning`); a level the connection publishes is sent unchanged and
logged nowhere. That is why the wire stage reads the provider's echo.

## Running

From the worktree root, after `bun run build`:

```
madbench preflight ai-docs/benches/recommended-effort/madbench.yaml
madbench check     ai-docs/benches/recommended-effort/madbench.yaml
madbench ai-docs/benches/recommended-effort/madbench.yaml --report-json <path>
madbench ai-docs/benches/recommended-effort/effort.experiment.yaml --trials 2 --report-json <path>
```

`claudish_js` is an absolute path into this worktree; override it with
`--param claudish_js=<path>` elsewhere. The Bench errors under `--harness mock` (the mock starts
no MCP server, so `environment:mcp-reachable` has nothing to read); `madbench check` lists that
Check as not applicable and is the gate. A graded miss exits 0.

## Why each choice

- `sandbox: home` with `~/.claudish` shared `rw`: `config.plugins` is refused below `home`, and
  `home` hides `~/.claudish` (credentials, catalog, the effort sidecar) unless it is shared. Not
  yet run at this level: macOS Keychain-held keys (for example `OPENCODE_API_KEY` for
  `zengo@minimax-m3`) may not resolve with HOME replaced. The Codex OAuth credential is a file in
  `~/.claudish` and is shared.
- `interactive: true` for the host, with `--permission-mode bypassPermissions`: only an
  interactive run gets madbench's first-run seeding (onboarding, workspace trust) in the
  sandbox's `~/.claude.json`, and the team / session children are interactive Claude Code in the
  same HOME and cwd. Under `--print` a child stopped at the theme picker (`first_run_dialog`).
  `environment:mcp-connected` is not used: on the interactive path it reports "the tool lists no
  MCP server named" although the server works; `environment:mcp-reachable` plus the
  `mcp__claudish__*` calls are the evidence.
- `--allowedTools mcp__claudish`: at `home` the user's own permission settings are gone, and the
  host was refused `mcp__claudish__create_session` ("you haven't granted it yet").
- What `home` needed besides `~/.claudish` (each found by a one-Session probe; see
  `madbench-skill-gap.md`): an absolute MCP `command` (`bun_bin`), live shares of `~/.bun`,
  `~/.local/bin` and `~/.local/share/claude` (the children's `claude`), of
  `<root>/packages/cli` and `<root>/package.json` and `<root>/node_modules` (the bundle imports
  `@opentui/*` at run time), and a dedicated pane socket root (`pane_root`, created once with
  `mkdir -m 700 -p /private/tmp/claudish-bench-mux`) passed as `CLAUDISH_PANE_ROOT`. `ro` shares
  are refused below `container`, so all shares are `rw`.
- Keychain-held keys do not resolve at `home`: `minimax-m3` routed to OpenRouter (metered), not
  `zengo@`. A model whose only funded route is a Keychain key is not measured on its subscription.
- `--strict-mcp-config`: keeps any plugin's MCP server out of the run; only the worktree build serves `mcp__claudish__*`.
- The named models have different levels in their column where possible (`gpt-6-astra` xhigh
  vs `gpt-6.1-sol` high for `frontend_ui`) so a single guessed level cannot pass for both.
- The columns were chosen for tasks with one obvious reading. A pilot run graded a "shell
  one-liner" task as `terminal_ops`; the agent read it as `quick_edit`. That is a fair reading,
  so the pick Scenario now asks for an implementation instead.
- `run-prompt-pick` no longer tells the agent to use the bare name; `BareNames` measures it. In
  the pilot the agent took `oai@gpt-6-luna` from `list_models`' Access line, and the metered
  OpenAI account had no credit.
- Levels were chosen away from `high` where possible, so the wire echo cannot be Claude Code's
  own default level passed through.
