# recommended-models: does every recommended model work through claudish?

Two Benches, one question each, swept over the recommended list by one Experiment per
recommendation tier and Bench.

| Bench | Path under test | The model must |
|---|---|---|
| `cli.madbench.yaml` | `claudish --model <spec>`: Claude Code through the proxy, interactive | fix `slugify.ts` with real tool calls (Read or Bash, then Edit or Write) until `bun test` passes |
| `mcp.madbench.yaml` | native Claude Code → the claudish MCP server, three Scenarios (below) | answer `4817 + 2906` inside an MCP or Read tool result |

The CLI Bench is the stronger test: it exercises the wire, streaming tool calls and the
Claude Code TUI. The MCP Bench sends one text task with no tools, so it proves that each
MCP path reaches the model and returns its answer, not that the model can use tools.

The MCP Bench's three Scenarios each send the same task (`What is 4817 + 2906?`) by a
different tool, and each grades the same three things: the server came up, the call named
the model under test letter for letter (`session:tool-args-match` on `{{model}}`), and
`7723` appears in a `tool_result` the host did not write.

| Scenario | The host | Where `7723` must appear |
|---|---|---|
| `run-prompt` | calls `run_prompt` once | `run_prompt`'s own result |
| `create-session` | calls `create_session` once, polls `list_sessions` with `sleep 10` between polls, then calls `get_output` | `get_output`'s result |
| `team` | calls `team` mode `run` with `models: ["{{model}}"]`, polls mode `status`, then reads `team-sum/response-<slot>.md` | the Read of the slot's response file |

`run-prompt` and `create-session` also require exactly one call (`eq: 1`), and `team`'s
`models` list is matched exactly, so a second model cannot supply the answer.

## The variants come from the catalog

Every command in this README runs from this folder
(`ai-docs/benches/recommended-models/`). The Benches resolve their own paths against the
Bench file, and the script writes into `experiments/` beside it.

```
bun scripts/gen-experiments.ts
```

reads `claudish --models-top --json` and writes one Experiment per recommendation tier
(`models[].recommendationTier`) and Bench:

| Recommendation tier | Variants (one model spec each) | Files |
|---|---|---|
| `flagship` | the flagship models by bare name; routing chooses the hop | `experiments/flagship.cli.experiment.yaml`, `experiments/flagship.mcp.experiment.yaml` |
| `cost_efficient` | the same, for the cost-efficient models | `experiments/cost_efficient.cli.experiment.yaml`, `experiments/cost_efficient.mcp.experiment.yaml` |
| `lightweight` | the same, for the lightweight models | `experiments/lightweight.cli.experiment.yaml`, `experiments/lightweight.mcp.experiment.yaml` |
| `luxury` | the same, for the luxury models | `experiments/luxury.cli.experiment.yaml`, `experiments/luxury.mcp.experiment.yaml` |
| `subscription` | each published subscription command (`cx@gpt-6.1-sol`, `kc@k3`, ...); a native-route row is its bare name (`claude-opus-5-5`) | `experiments/subscription.cli.experiment.yaml`, `experiments/subscription.mcp.experiment.yaml` |

The recommendation tiers are read from the list, so a new one gets its own files and an empty
one (today `subscription`) gets none. A model in two tiers is a variant in both files. The
luxury files are the most expensive run: those are the priciest models on the list. Each
variant is named by its model spec; quote it on the command line: `--variant oc@glm-5.3`. The
list changes with each catalog generation, so re-run the script before a real run. Each file
names the generation it was written from, and the script deletes files for a recommendation
tier that left the list.

## Running

The Benches need madbench 0.46.0 or later: a Check's keys sit beside `type:`.

The free gates (no spend):

```
madbench preflight cli.madbench.yaml
madbench check     cli.madbench.yaml
madbench preflight mcp.madbench.yaml
madbench check     mcp.madbench.yaml
```

A real run, one recommendation tier at a time, MCP first because it is cheaper:

```
madbench experiments/flagship.mcp.experiment.yaml --report-json <path>
madbench experiments/flagship.cli.experiment.yaml --report-json <path>
madbench experiments/flagship.cli.experiment.yaml --variant kimi-k3 --report-json <path>
```

Both Benches run the `claudish` on `PATH`. Check `claudish --version` first: a stale global
install tests the old release, not the one under review.

A graded miss exits 0. Add `--fail-on-failure` where a miss must go red.

## Why each choice

- **`sandbox: workspace`, not `home`.** `home` replaces `HOME`, which hides `~/.claudish`
  (config, 1Password and Keychain references, catalog cache). madbench's own example
  `local-agent-orchestration` measured 20/20 Scenarios failing as "agent never started"
  under `home`. The cost: the run shares this machine's `HOME`.
- **The CLI anti-cheat is a `file-changes` Check.** `exec: bun test` proves the work;
  `file-changes` with `must: {update: slugify.ts}` and `must-not: {touch: slugify.test.ts}`
  proves it stayed inside its boundary. A ban alone passes against an agent that did
  nothing, and `madbench check` reports it WRONGLY PASSED, so it sits beside the exec Check.
  It replaces a `grep -c` line count (MadAppGang/madbench#131). Needs madbench 0.46.0 or
  later: a Check's keys sit beside `type:`.
- **The MCP detector reads the tool result.** The host Claude can compute 7723 itself; it
  cannot write an MCP `tool_result`. `session:match` with `type: tool_result` reads only
  what claudish returned, and a failed route returns `Error: ...` with no number.
- **Exactly one `run_prompt` or `create_session` call.** A retry with a second model could
  supply the answer the first model failed to give.
- **`--allowedTools "Bash(sleep:*)"`.** The server pushes no session events, so the host
  polls `create_session` and `team`. Under `--print` with no permission mode an un-allowed
  Bash call is denied, and polling with no wait burns the host's turns. madbench appends
  `args:` last and pipes the prompt on stdin, so the variadic flag swallows nothing.
  `run-prompt` makes no Bash call and is unaffected.
- **Check keys are written flat, beside `type:`** (`eq:`, `tool_args:`, `event_type:`,
  `regex:`). madbench 0.46.0 refuses a nested `args:` map on these Checks at preflight
  (`unknown key "args"`).
- **The MCP server is declared inline in `args:`, not with `config.dirs`.** `config.dirs`
  needs sandbox level `home`, and claudish needs `workspace`. madbench 0.43.2 refuses that
  pair only at run time ("harness.config.dirs cannot apply at sandbox level workspace"),
  after `preflight` and `check` both passed (MadAppGang/madbench#130). The value is JSON, not a file path, because a
  path would resolve in the workspace. `--strict-mcp-config` keeps the user's installed
  claudish plugin server out of the run.
- **`environment:mcp-connected`, not `environment:tool-available`.** `tool-available`
  always errors under the mock, so the negative control could never hold
  (madbench `docs/checks.md`, the environment table).
- **The MCP Bench errors under `--harness mock`.** `environment:mcp-reachable` reads the
  run's MCP preflight, and the mock starts no server. `madbench check` lists it as not
  applicable; the negative control is the gate, not the mock run's exit code.
- **The MCP host model is fixed** (`claude-haiku-5-5`, billed to the subscription), so the
  variants differ only in the prompt and the Checks. That Experiment declares no
  `guard_changes:` because its staged inputs never differ; the CLI Experiment allows
  `harness/model` and nothing else.
