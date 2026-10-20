# Recommended models: CLI and MCP Bench run, 2026-10-20

Question: does every model on the recommended list work end to end through the claudish CLI
and the claudish MCP server?

Answer: 16 of the 24 recommended model rows pass every Scenario on both Benches. The other
8 fail on both for two reasons, both account credentials, neither a claudish defect.

## Run

| | CLI Bench | MCP Bench |
|---|---|---|
| Bench | `ai-docs/benches/recommended-models/cli.madbench.yaml` | `…/mcp.madbench.yaml` |
| Experiments | `experiments/{flagship,cost_efficient,lightweight,luxury}.cli.experiment.yaml` | the same four, `.mcp` |
| Scenarios | `fix-slugify` | `run-prompt`, `create-session`, `team` |
| Started | 2026-10-20T20:02:26+11:00 | 2026-10-20T20:17:42+11:00 |
| Duration | 719 s | 874 s |
| Summary (report JSON) | 24 rows: 14 pass, 2 fail, 8 error | 72 rows: 48 pass, 24 fail, 0 error |
| After the Check fix below | 16 pass, 8 error | unchanged |

Versions: claudish 12.1.0, madbench 0.47.0, catalog generation `g-20261020001716074-15736aba`.
Raw reports were in the gitignored session folder `ai-docs/sessions/bench-recommended-20261020/`.

## Per model

`gpt-6.1-sol`, `gemini-4-argon` and `mimo-v2.6-pro` are recommended in two tiers, so they are
two rows each.

| Recommendation tier | Pass on both Benches | Fail on both Benches |
|---|---|---|
| flagship | `claude-opus-5-5`, `gpt-6.1-sol`, `gemini-4-argon`, `grok-4.7`, `kimi-k3`, `minimax-m3` | `qwen3.8-max`, `glm-5.3`, `deepseek-v4-pro`, `mimo-v2.6-pro` |
| cost_efficient | `gpt-6.1-sol`, `claude-sonnet-5-5`, `gemini-4-argon` | `mimo-v2.6-pro` |
| lightweight | `claude-haiku-5-5`, `gpt-6-luna`, `gemini-3.8-flash`, `qwen3.8-omni-flash`, `muse-spark-1.3` | `deepseek-v4.1-flash`, `glm-5.3-flash`, `mimo-v2.6-flash` |
| luxury | `claude-fable-5-1`, `gpt-6-astra` | none |

## Why the 8 fail

**Zen Go key expired (7 rows).** Every routing chain for `glm-5.3`, `glm-5.3-flash`,
`deepseek-v4-pro`, `deepseek-v4.1-flash`, `mimo-v2.6-pro` and `mimo-v2.6-flash` puts
`zengo@` (subscription) first or second. The provider answered:

```
Zen Go error (HTTP 401): … — This API key has expired. Create a new API key in OpenCode
Console and replace it in your client or secret store.
```

The chain stops there, although later hops are live (`claudish --probe glm-5.3`: `glm@`,
`z-ai@`, `oc@`, `poe@`, `fireworks@` answer). That stop is the rule of 2026-10-16, not a
defect: a terminal credential failure of a subscription provider stops the routing chain and
is never passed to a metered hop (`packages/cli/src/handlers/shared/auth-failure.ts:5-10`,
`ai-docs/architecture/adapters.md` § "A subscription's credential failure stops the chain
(2026-10-16)"). The verdict header is minted at
`handlers/composed-handler.ts:2207` and honoured at `handlers/fallback-handler.ts:131-139`.

For contrast, the GLM Coding Plan (`gc@`, first hop for `glm-5.3`) has also expired, but it
answers `HTTP 429` "package has expired". That is quota wording, so the chain advances past it.

**Qwen Token Plan has no access to `qwen3.8-max` (1 row).**
`Qwen-token-plan error (HTTP 403): … Access to model denied. Please make sure you are
eligible for using the model.` The key is accepted; the account is not entitled to the model.
`qwen3.8-omni-flash` on the same plan passes.

## Bench change made from this run

The CLI Bench first graded `claude-opus-5-5` and `claude-fable-5-1` as **fail**. Both fixed
the test (`bun test` exit 0; `file-changes`: only `slugify.ts` updated), but wrote the file
with a Bash heredoc, and the Bench also required `session:tool-used` Edit or Write. The Bench
asks whether a model can fix a failing test, not which tool wrote the file, so that Check was
removed (`test(madbench): remove the Edit-or-Write Check from the CLI Bench`).
`madbench check` still holds (3/3 Checks fail under the mock harness), and
`madbench grade --bench <experiment>` re-grades all 16 recorded Sessions as pass.

## To re-run

From `ai-docs/benches/recommended-models/`, after `bun scripts/gen-experiments.ts`:

```
madbench experiments/flagship.cli.experiment.yaml experiments/cost_efficient.cli.experiment.yaml \
  experiments/lightweight.cli.experiment.yaml experiments/luxury.cli.experiment.yaml \
  --report-dir <dir> --report-json <dir>/report.json
```

and the same with `.mcp.`. Only the 8 failing rows need a re-run once the credentials are
fixed: add `--variant <model>` per row.
