# recommended-models: does every recommended model work through claudish?

Two Benches, one question each, swept over the recommended list by two Experiments.

| Bench | Path under test | The model must |
|---|---|---|
| `cli.madbench.yaml` | `claudish --model <spec>`: Claude Code through the proxy, interactive | fix `slugify.ts` with real tool calls (Read or Bash, then Edit or Write) until `bun test` passes |
| `mcp.madbench.yaml` | native Claude Code → claudish MCP `run_prompt` → `runPromptViaProxy` | answer `4817 + 2906` inside the MCP tool result |

The CLI Bench is the stronger test: it exercises the wire, streaming tool calls and the
Claude Code TUI. `run_prompt` sends one text request with no tools, so the MCP Bench proves
that a route answers, not that the model can use tools.

## The variants come from the catalog

```
bun scripts/gen-experiments.ts
```

Every command in this README runs from this folder
(`ai-docs/benches/recommended-models/`). The Benches resolve their own paths against the
Bench file, and the script writes next to itself, so the folder is the only working
directory to remember.

writes `cli.experiment.yaml` and `mcp.experiment.yaml` from `claudish --models-top --json`:
first every recommended model by bare name (routing chooses the hop), then every distinct
subscription command the list publishes (`cx@gpt-6.1-sol`, `kc@k3`, ...). The list changes
with each catalog generation, so re-run the script before a real run. Each file names the
generation it was written from.

## Running

The free gates (no spend):

```
madbench preflight cli.madbench.yaml
madbench check     cli.madbench.yaml
madbench preflight mcp.madbench.yaml
madbench check     mcp.madbench.yaml
```

A real run, one variant first:

```
madbench cli.experiment.yaml --variant kimi-k3 --report-json <path>
madbench mcp.experiment.yaml --report-json <path>
```

Both Benches run the `claudish` on `PATH`. Check `claudish --version` first: a stale global
install tests the old release, not the one under review.

A graded miss exits 0. Add `--fail-on-failure` where a miss must go red.

## Why each choice

- **`sandbox: workspace`, not `home`.** `home` replaces `HOME`, which hides `~/.claudish`
  (config, 1Password and Keychain references, catalog cache). madbench's own example
  `local-agent-orchestration` measured 20/20 Scenarios failing as "agent never started"
  under `home`. The cost: the run shares this machine's `HOME`.
- **The CLI anti-cheat is inside the outcome Check.** "The four cases are still in the test
  file" passes against an agent that did nothing, so on its own it fails `madbench check`
  as WRONGLY PASSED. `bun test && grep ...` passes only for a real fix. It counts lines, so it is weak; MadAppGang/madbench#131 asks for a `file-changes` Check to replace it.
- **The MCP detector reads the tool result.** The host Claude can compute 7723 itself; it
  cannot write an MCP `tool_result`. `session:match` with `type: tool_result` reads only
  what claudish returned, and a failed route returns `Error: ...` with no number.
- **Exactly one `run_prompt` call.** A retry with a second model could supply the answer
  the first model failed to give.
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
