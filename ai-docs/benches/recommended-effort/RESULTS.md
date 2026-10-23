# recommended-effort: results, 2026-10-23

## run11: rebased on v14.1.0, corrected started-call rule (2026-10-23, 05:54:37–06:00:31Z)

Same Experiment and procedure (`--trials 2`, 24 Sessions, interactive `claude-sonnet-5-5` host,
`sandbox: home`, plugin staged by `harness.config.plugins`). Build: the coordinator's rebuild on
origin/main, `bun packages/cli/dist/index.js --version` → `claudish version 14.1.0` (needs_effort
keys in the caller's spelling for run_prompt/create_session; a rejected recommended cache of another
projection version logged as `[recommended] … has projection version …`; the projection-2 disk
cache readable). Before the run: the worktree skill copy refreshed and `cmp`-identical; the shared
`packages/cli`, root `package.json` and root `node_modules` resolve after the rebase
(`packages/cli/node_modules/@opentui/core` → `node_modules/.bun/@opentui+core@0.1.107+…/…`,
`package.json` present); preflight `PREFLIGHT OK  3 benches · 150 components verified`; check
`93/93 gradable checks failed as required · 0 errored (could not grade) · 0 wrongly passed · 12 not applicable under mock`.
Grading uses the corrected rule: the effort, bare-name and layer-B Checks grade the LAST start call
answered neither with needs_effort nor `Error:`. Effort generation at grading:
`g-20261023054016830-cce2d5b3`.

Report: `ai-docs/sessions/recommended-effort-bench-20261023/reports/run11.json` (gitignored).
Cost: host $2.45 (subscription). Trials 184 s and 161 s.

### Scenario verdicts (`.aggregate.perScenario`)

| Scenario | `installed-skill` | `worktree-skill` | `worktree-family` |
|---|---|---|---|
| `team-frontend` | 2/2 | 2/2 | 2/2 |
| `session-code-review` | 2/2 | 2/2 | 2/2 |
| `run-prompt-pick` | 2/2 | 2/2 | 2/2 |
| `team-no-entry` | 2/2 | 1/2 | 2/2 |
| total | 8/8 | 7/8 | 8/8 |

### Per check

| Check | `installed-skill` | `worktree-skill` | `worktree-family` |
|---|---|---|---|
| `list_models` called first (`ConsultedTable`, readout) | 2/8 | 2/8 | 8/8 |
| efforts equal the table on the started call (`EffortArgs`) | 8/8 | 7/8 | 8/8 |
| bare names on the started call (`BareNames`) | 8/8 | 8/8 | 8/8 |
| skill opened (`SkillUsed`, readout) | 2/8 | 0/8 | 0/8 |
| needs_effort answers before the started call | 6 (6 Sessions) | 5 (5 Sessions) | 0 |
| after needs_effort, the retry carried the Scenario column's levels | 6/6 | 5/5 | n/a |
| `NeedsEffort` readout | 8/8 | 7/8 | 8/8 |
| B1 child pinned the level (`EffortFlag`) | 6/6 | 5/6 | 6/6 |
| B2 provider echoed the level (`EffortWire`) | 8/8 | 7/8 | 8/8 |

The retried levels were consistent with `frontend_ui` (4), `code_review`+`frontend_ui` (4) and
`quick_edit`+`terminal_ops`+`long_context` (3): each set includes the Scenario's own column. In 23
Sessions the started call passed an effort; all 29 (model, level) pairs were pinned (team/session)
and echoed by the provider at that level. No mapping note (`effort A → B`) appeared.

For create_session the needs_effort text now speaks the singular form, e.g. `worktree-skill`/`session-code-review` trial 1:

```
mcp__claudish__create_session {"model":"gpt-6-luna"}
  → needs_effort: nothing was started. Map your task to one task type and call again with effort: "<level>" (effort: "default" keeps Claude Code's own).
    Recommended levels: {"gpt-6-luna": {"implementation": "max", "planning": "max", "research": "max", "code_review": "xhigh", "debugging": "high", "quick_edit": "low", "frontend_ui": "xhigh", "tool_automation": "max", …}}
mcp__claudish__create_session {"effort":"xhigh","model":"gpt-6-luna"}
  → {"session_id":"e8dc4cf8","state":"STARTING"}
```

### Tool calls, verbatim

Passing, family names, `worktree-family`/`team-no-entry` trial 1:

```
mcp__claudish__list_models {}
mcp__claudish__team {"efforts":{"gpt-6.1-sol":"low"},"mode":"run","models":["gpt-6.1-sol","minimax-m3"],"path":"team-typo"}
```

The one failure, `worktree-skill`/`team-no-entry` trial 2: the agent's first and only start call
used the needs_effort **opt-out** unprompted, so claudish started the run with Claude Code's own
effort for both models:

```
mcp__claudish__team {"efforts":{},"mode":"run","models":["gpt-6-astra","minimax-m3"],"path":"team-typo"}
  → {"started": true, "run_id": "team-typo-mvkk7qdz-ba6418", …}
```

`EffortArgs`: "1/2 models right for column quick_edit; gpt-6-astra: passed none, recommended low".
The agent did not open the skill (`SkillUsed` 0/8 in this variant) and said nothing about effort
in its answer; the `efforts: {}` spelling is in the `team` tool's own description and in the
needs_effort text (`efforts: {} keeps Claude Code's own for every model`). The opt-out is
deliberate API, so the agent was free to pass it; for a quick edit it also cost little (the
recommended level was `low`). Whether to keep `{}` as a silent opt-out, or require a reason, is a
product decision.

### Layer B evidence, verbatim

`worktree-skill`/`team-frontend`, trial 1 (after needs_effort):

```
[2026-10-23T05:56:10.410Z] [ComposedHandler] --effort xhigh pinned for cx@gpt-6-astra (catalog clamp skipped)
[2026-10-23T05:56:10.410Z] [Wire] openai-codex@gpt-6-astra → openai/codex-subscription · gpt-6-astra: responses (credential-decided host) [generation g-20261023054016830-cce2d5b3]
[2026-10-23T05:56:12.384Z] [SSE:responses] response.created … "reasoning":{"effort":"xhigh","summary":"detailed","context":"all_turns","mode":"standard"}
[2026-10-23T05:56:10.284Z] [ComposedHandler] --effort high pinned for cx@gpt-6.1-sol (catalog clamp skipped)
[2026-10-23T05:56:10.284Z] [Wire] openai-codex@gpt-6.1-sol → openai/codex-subscription · gpt-6.1-sol: responses (credential-decided host) [generation g-20261023054016830-cce2d5b3]
[2026-10-23T05:56:12.520Z] [SSE:responses] response.created … "reasoning":{"effort":"high","summary":"detailed","context":"all_turns","mode":"standard"}
```

`worktree-skill`/`session-code-review`, trial 1:

```
[2026-10-23T05:55:56.186Z] [ComposedHandler] --effort xhigh pinned for cx@gpt-6-luna (catalog clamp skipped)
[2026-10-23T05:55:56.186Z] [Wire] openai-codex@gpt-6-luna → openai/codex-subscription · gpt-6-luna: responses (credential-decided host) [generation g-20261023054016830-cce2d5b3]
[2026-10-23T05:55:57.237Z] [SSE:responses] response.created … "reasoning":{"effort":"xhigh","summary":"detailed","context":"all_turns","mode":"standard"}
```

`worktree-family`/`run-prompt-pick`, trial 1 (run_prompt `effort: "medium"`):

```
[2026-10-23T05:56:51.593Z] [Wire] openai-codex@gpt-6.1-sol → openai/codex-subscription · gpt-6.1-sol: responses (credential-decided host) [generation g-20261023054016830-cce2d5b3]
[2026-10-23T05:56:53.654Z] [SSE:responses] response.created … "reasoning":{"effort":"medium","summary":"detailed","context":"all_turns","mode":"standard"}
```

### `list_models`, the disk fallback and projection lines

- 12 `list_models` calls, **12 live lists with the effort table**; 0 `No recommended models found`;
  **0 disk-fallback notes** (`_The live catalog could not be read; …_`). No fetch failed while an
  agent was waiting on `list_models`, so the fallback path was not exercised in this run.
- **0 `[recommended] … has projection version …` lines.**

### claudish-mcp log lines written during the run (48 files, 05:54–06:00Z)

All `[mcp]`/`[catalog]`/`[recommended]`/`[effort]`/`[team]` lines, verbatim:

```
[2026-10-23T05:58:00.257Z] [recommended] warm failed: Unable to load v3 recommended models: The operation timed out.
[2026-10-23T05:58:03.257Z] [catalog] refresh failed: timeout
```

### Not verified

- The disk fallback on the v14.1.0 build (no `list_models` call hit a failed fetch).
- That the `minimax-m3` children ran without a pinned effort; `minimax-m3` still ran on
  OpenRouter at `home` (Keychain keys unavailable). Any host but `claude-sonnet-5-5`.

## run10: needs_effort, no Access line (2026-10-23, 05:36:57–05:43:32Z)

Same Experiment and procedure as run9 (`--trials 2`, 24 Sessions, interactive host
`claude-sonnet-5-5`, `sandbox: home`, plugin staged by `harness.config.plugins`). Build: the
coordinator's `packages/cli/dist/index.js` with needs_effort (a start call without
`efforts`/`effort` for a model that has a row starts nothing and returns the rows), no provider in
`list_models`, 500 kept `claudish-mcp_*.log` files. Worktree skill copy `cmp`-identical.
Effort generation at grading: `g-20261023053138920-f8b4cbb5` (new since run9; the levels used here
are unchanged).

Report: `ai-docs/sessions/recommended-effort-bench-20261023/reports/run10.json` (gitignored).
Cost: host $2.36 (subscription). Trials 169 s and 220 s.

Check changes for this run: the effort, bare-name and layer-B Checks grade the call that
**started** work, not the first call; `ConsultedTable` is a readout (measurement); a new readout
`checks/needs-effort.ts` (`NeedsEffort`) counts needs_effort answers before the started call,
scores whether that call carries the Scenario column's levels, and records every column the
levels are consistent with. Gates: preflight `PREFLIGHT OK  3 benches · 150 components verified`;
check `93/93 gradable checks failed as required · 0 errored (could not grade) · 0 wrongly passed · 12 not applicable under mock`.

**One grading caveat.** run10 picked "the first start call not answered with needs_effort". In
`worktree-family`/`team-no-entry` trial 2 that was a run of the literal family names
(`models: ["gpt","minimax"]`), not the agent's working retry, so that Session's layer-B Checks
graded the wrong call. The rule is now "the last start call answered neither with needs_effort
nor `Error:`" (`checks/effort-lib.ts`), which picks the retry. madbench cannot re-grade `ts` file
Checks offline, so run10's numbers stay as recorded. The counts below say where this changes a
verdict.

### Scenario verdicts (`.aggregate.perScenario`)

| Scenario | `installed-skill` | `worktree-skill` | `worktree-family` |
|---|---|---|---|
| `team-frontend` | 2/2 | 2/2 | 2/2 |
| `session-code-review` | 2/2 | 2/2 | 1/2 |
| `run-prompt-pick` | 2/2 | 2/2 | 2/2 |
| `team-no-entry` | 2/2 | 2/2 | 1/2 |
| total | 8/8 | 8/8 | 6/8 |

### Per check (counted from `.trials[].results[].checks[]`)

| Check | `installed-skill` | `worktree-skill` | `worktree-family` |
|---|---|---|---|
| `list_models` called first (`ConsultedTable`, readout) | 2/8 | 2/8 | 7/8 |
| efforts equal the table on the started call (`EffortArgs`) | 8/8 | 8/8 | 8/8 |
| bare names on the started call (`BareNames`) | 8/8 | 8/8 | 8/8 |
| skill opened (`SkillUsed`, readout) | 1/8 | 0/8 | 0/8 |
| needs_effort answers before the started call | 6 (6 Sessions) | 6 (6 Sessions) | 0 |
| after needs_effort, the retry carried the Scenario column's levels | 6/6 | 6/6 | n/a |
| `NeedsEffort` readout (started call carries the column's levels) | 8/8 | 8/8 | 8/8 |
| B1 child pinned the level (`EffortFlag`) | 6/6 | 6/6 | 4/6 |
| B2 provider echoed the level (`EffortWire`) | 8/8 | 8/8 | 6/8 |

What changed from run9:

- **needs_effort did the job the skill did not.** With exact ids the agent still went straight to
  `team`/`create_session` without `list_models` (12/12 in the two exact-id variants). claudish
  answered all 12 with needs_effort, and all 12 retries carried exactly the Scenario column's
  levels. The columns the retried levels are consistent with always include the Scenario's own:
  `frontend_ui` (only), `code_review` (with `frontend_ui`, same level), `quick_edit` (with
  `terminal_ops`, `long_context`, same level). Every retry was the first retry: one needs_effort
  per Session, never two.
- **The skill still made no measurable difference with exact ids**: `installed-skill` and
  `worktree-skill` made identical calls in 16/16 Sessions, and the worktree skill was never
  opened (0/16).
- **Bare names 24/24 on the started call.** The Access line is gone and no agent sent a
  `provider@` spec.
- **The two `worktree-family` failures are both "no row, no effort, nothing for layer B to
  follow":**
  1. `session-code-review` trial 1 picked `gpt-5` without `list_models`; it has no row, so no
     needs_effort and no effort (correct), and the session failed `credit_balance_exhausted` on
     metered OpenAI. EffortArgs passed; B1/B2 fail with "passed no effort, so there is nothing to
     follow".
  2. `team-no-entry` trial 2 first ran `models: ["gpt","minimax"]`, the family words themselves.
     claudish **started** that run (`"started": true`, slot `gpt` spawned as `or@gpt` on
     OpenRouter, FAILED); no needs_effort, since neither word has a row. The agent then called
     `list_models` and retried correctly (`{"efforts":{"gpt-6.1-sol":"low"}, models
     ["gpt-6.1-sol","minimax-m3"]}`, first refused with "Session already exists", then started
     after it deleted the directory). Under the corrected rule this Session's B Checks would grade
     the retry; run10 graded the `gpt`/`minimax` run. Its EffortArgs passed either way.

### Tool calls, verbatim (input and prompt text omitted)

Passing, with needs_effort, `installed-skill`/`team-frontend` trial 1 (identical in all 12
exact-id team/session Sessions, per Scenario):

```
mcp__claudish__team {"mode":"run","models":["gpt-6-astra","gpt-6.1-sol"],"path":"team-ui"}
  → needs_effort (text below)
mcp__claudish__team {"efforts":{"gpt-6-astra":"xhigh","gpt-6.1-sol":"high"},"mode":"run","models":["gpt-6-astra","gpt-6.1-sol"],"path":"team-ui"}
```

The needs_effort text the agent received (this call, verbatim):

```
needs_effort: nothing was started. Map your task to one task type and call again with efforts: {"<model>": "<level>"} (efforts: {} keeps Claude Code's own for every model).
Recommended levels: {
  "gpt-6-astra": {
    "implementation": "high",
    "planning": "max",
    "research": "xhigh",
    "code_review": "xhigh",
    "debugging": "high",
    "quick_edit": "low",
    "frontend_ui": "xhigh",
    "tool_automation": "max",
    "terminal_ops": "low",
    "long_context": "low"
  },
  "gpt-6.1-sol": {
    "implementation": "medium",
    "planning": "max",
    "research": "xhigh",
    "code_review": "xhigh",
    "debugging": "high",
    "quick_edit": "low",
    "frontend_ui": "high",
    "tool_automation": "xhigh",
    "terminal_ops": "xhigh",
    "long_context": "low"
  }
}
```

The other needs_effort pairs: `create_session {"model":"gpt-6-luna"}` → `{"effort":"xhigh","model":"gpt-6-luna"}`;
`team {"models":["gpt-6-astra","minimax-m3"]}` → `{"efforts":{"gpt-6-astra":"low"}, …}` (minimax-m3 left out).

Every failure:

```
worktree-family/session-code-review, trial 1:
mcp__claudish__create_session {"model":"gpt-5"}
  → FAILED prompt_not_read: "credit_balance_exhausted: You have no credits remaining"

worktree-family/team-no-entry, trial 2:
mcp__claudish__team {"mode":"run","models":["gpt","minimax"],"path":"team-typo"}
  → "started": true; slot "gpt" spawnModel "or@gpt", provider OpenRouter, FAILED
mcp__claudish__list_models {}
mcp__claudish__team {"efforts":{"gpt-6.1-sol":"low"},"mode":"run","models":["gpt-6.1-sol","minimax-m3"],"path":"team-typo"}
  → "Error: Session already exists at …/team-typo. Use a new directory path or delete the existing session first."
mcp__claudish__team {"efforts":{"gpt-6.1-sol":"low"},"mode":"run","models":["gpt-6.1-sol","minimax-m3"],"path":"team-typo"}
  → "started": true; gpt-6.1-sol COMPLETED on Openai-codex
```

### Layer B evidence, verbatim

`installed-skill`/`team-frontend`, trial 1 (after needs_effort):

```
[2026-10-23T05:37:16.289Z] [ComposedHandler] --effort xhigh pinned for cx@gpt-6-astra (catalog clamp skipped)
[2026-10-23T05:37:16.289Z] [Wire] openai-codex@gpt-6-astra → openai/codex-subscription · gpt-6-astra: responses (credential-decided host) [generation g-20261023053138920-f8b4cbb5]
[2026-10-23T05:37:18.452Z] [SSE:responses] response.created … "reasoning":{"effort":"xhigh","summary":"detailed","context":"all_turns","mode":"standard"}
[2026-10-23T05:37:16.342Z] [ComposedHandler] --effort high pinned for cx@gpt-6.1-sol (catalog clamp skipped)
[2026-10-23T05:37:16.342Z] [Wire] openai-codex@gpt-6.1-sol → openai/codex-subscription · gpt-6.1-sol: responses (credential-decided host) [generation g-20261023053138920-f8b4cbb5]
[2026-10-23T05:37:18.399Z] [SSE:responses] response.created … "reasoning":{"effort":"high","summary":"detailed","context":"all_turns","mode":"standard"}
```

`installed-skill`/`session-code-review`, trial 1 (create_session `effort: "xhigh"` after needs_effort):

```
[2026-10-23T05:37:13.576Z] [ComposedHandler] --effort xhigh pinned for cx@gpt-6-luna (catalog clamp skipped)
[2026-10-23T05:37:15.070Z] [SSE:responses] response.created … "reasoning":{"effort":"xhigh","summary":"detailed","context":"all_turns","mode":"standard"}
```

`worktree-skill`/`run-prompt-pick`, trial 1 (run_prompt `effort: "medium"`, MCP server's proxy):

```
[2026-10-23T05:38:20.676Z] [Wire] openai-codex@gpt-6.1-sol → openai/codex-subscription · gpt-6.1-sol: responses (credential-decided host) [generation g-20261023053138920-f8b4cbb5]
[2026-10-23T05:38:22.457Z] [SSE:responses] response.created … "reasoning":{"effort":"medium","summary":"detailed","context":"all_turns","mode":"standard"}
```

In all 22 Sessions whose started call passed an effort, every (model, level) pair was echoed at
that level (28 pairs: `echoedEfforts` equal to the level in every `response.created`). No
`[Wire] … effort A → B` mapping note appeared.

### `list_models` answers: 11 calls, 0 disk-fallback notes, 3 without a model list

| Answer | Count |
|---|---|
| live list + effort table | 8 |
| `No recommended models found. Try search_models instead.` + effort table | 3 |
| the disk-fallback note (`_The live catalog could not be read; …_`) | **0** |

The three are trial 2 of `worktree-family` (`team-frontend` 05:42:19.111Z, `run-prompt-pick`
05:42:19.091Z, `session-code-review` 05:42:22.185Z); each matches an
`[mcp] list_models: Unable to load v3 recommended models: The operation timed out.` line below.
**The effort table was appended in all three** (the run2 defect is fixed), but the disk fallback
did not answer them with a model list, although run9 saw it do so twice and
`~/.claudish/recommended-models-cache-v2.json` exists. Not established why; the effort generation
had changed at 05:31 (`g-20261023053138920-f8b4cbb5`). All three agents still passed the table's
levels (they had the table).

### claudish-mcp log lines written during the run (48 files, 05:36–05:44Z, all kept)

```
[2026-10-23T05:37:19.378Z] [recommended] warm failed: Unable to load v3 recommended models: The operation timed out.
[2026-10-23T05:37:22.378Z] [catalog] refresh failed: timeout
[2026-10-23T05:38:26.774Z] [recommended] warm failed: Unable to load v3 recommended models: The operation timed out.
[2026-10-23T05:38:28.657Z] [catalog] refresh failed: timeout
[2026-10-23T05:40:12.764Z] [recommended] warm failed: Unable to load v3 recommended models: The operation timed out.
[2026-10-23T05:41:16.154Z] [recommended] warm failed: Unable to load v3 recommended models: The operation timed out.
[2026-10-23T05:42:19.087Z] [mcp] list_models: Unable to load v3 recommended models: The operation timed out.
[2026-10-23T05:42:19.107Z] [mcp] list_models: Unable to load v3 recommended models: The operation timed out.
[2026-10-23T05:42:22.181Z] [mcp] list_models: Unable to load v3 recommended models: The operation timed out.
[2026-10-23T05:42:30.641Z] [recommended] warm failed: Unable to load v3 recommended models: The operation timed out.
[2026-10-23T05:42:30.909Z] [catalog] refresh failed: timeout
```

No `[effort]` or `[team]` line was written. No `[mcp] provider removed` line either (no agent sent
a provider).

### Observations

- **`team` starts a run for model names that are not models** (`"gpt"`, `"minimax"` → `or@gpt`,
  FAILED on OpenRouter). needs_effort does not fire for them (no row), so nothing stops the run
  before a slot is spawned. Worth a look in production: a name with no catalog record could be
  refused like needs_effort refuses a missing effort.
- **Keychain-held keys at `home`**: `minimax-m3` again ran on OpenRouter (12 status rows
  `"provider": "OpenRouter"`), not `zengo@`.
- **Catalog/recommended refreshes time out at `home`** in every trial (`[catalog] refresh failed:
  timeout`, `[recommended] warm failed`); the live list still came back 8/11 times.

### Not verified

- Layer B for the corrected started-call rule on `worktree-family`/`team-no-entry` trial 2
  (the workspace is gone; madbench does not re-grade `ts` file Checks).
- Why the disk fallback did not answer the three timed-out `list_models` calls.
- That the `minimax-m3` children ran without a pinned effort; any host but `claude-sonnet-5-5`.

## run9: installed vs worktree skill, exact ids vs families (2026-10-23, 02:48–02:53Z)

`effort.experiment.yaml --trials 2`: 3 variants × 4 Scenarios × 2 trials = 24 Sessions, host
`claude-sonnet-5-5`, interactive, `sandbox: home`, the claudish plugin staged by
`harness.config.plugins`. Build: the coordinator's `packages/cli/dist/index.js` (list_models
disk fallback, provider removal with `user_required_provider`, skill "Model Names" section); the
worktree skill copy `cmp`-identical to `packages/cli/skills/claudish-usage/SKILL.md`.
Report: `ai-docs/sessions/recommended-effort-bench-20261023/reports/run9.json` (gitignored).

Gates: preflight `PREFLIGHT OK  3 benches · 150 components verified`; check
`81/81 gradable checks failed as required · 0 errored (could not grade) · 0 wrongly passed · 12 not applicable under mock`.
Before the sweep, single-Session probes (`--variant worktree-skill --scenario session-code-review`)
found four more things `home` hides, fixed one at a time (README, "Why each choice"; quoted in
`madbench-skill-gap.md`); run6–run8 show `environment:mcp-reachable` passing and
`~/.claudish/logs/claudish-mcp_*.log` appearing. In run9, `environment:mcp-reachable` and
`environment:skill-registered claudish:claudish-usage` passed 24/24.

Cost: host $2.21 (24 Sessions, subscription). Trials 160 s and 126 s. Probes run4–run8: about
$0.25 together. Children: Codex subscription, plus `minimax-m3` on OpenRouter (metered; see below).

### Scenario verdicts (`.aggregate.perScenario`)

| Scenario | `installed-skill` | `worktree-skill` | `worktree-family` |
|---|---|---|---|
| `team-frontend` | 0/2 | 0/2 | 1/2 |
| `session-code-review` | 0/2 | 0/2 | 1/2 |
| `run-prompt-pick` | 2/2 | 2/2 | 2/2 |
| `team-no-entry` | 0/2 | 0/2 | 1/2 |
| total | 2/8 | 2/8 | 5/8 |

### Per check (counted from `.trials[].results[].checks[]`)

| Check | `installed-skill` | `worktree-skill` | `worktree-family` |
|---|---|---|---|
| `list_models` called before the start call (`ConsultedTable`) | 2/8 | 2/8 | 7/8 |
| efforts equal the table (`EffortArgs`) | 2/8 | 2/8 | 8/8 |
| bare model names in the agent's arguments (`BareNames`) | 8/8 | 8/8 | 6/8 |
| skill opened (`SkillUsed`, readout) | 2/8 | 0/8 | 0/8 |
| B1 child pinned the level (`EffortFlag`) | 0/6 (no effort passed) | 0/6 (no effort passed) | 5/6 (the miss passed no effort) |
| B2 provider echoed the level (`EffortWire`) | 2/8 (6 passed no effort) | 2/8 (6 passed no effort) | 7/8 (the miss passed no effort) |

Wherever an effort was passed (11 start calls, 13 models), it equalled the table entry for the
Scenario's column in the newest generation (`g-20261022161717577-cdb3e76a`, which replaced
`g-20261022002624894-85e83b1a` between run2 and run9), and all 13 (model, level) pairs reached a process and
were echoed by the provider at that level. Every model with no row (`minimax-m3`, `gpt-5`) got
no effort.

What the numbers say:

- **The worktree skill did not change behaviour with exact ids.** `installed-skill` and
  `worktree-skill` made identical calls in 16/16 Sessions: team and create_session went
  straight to the start tool with no `list_models` and no effort (12/12); run-prompt-pick called
  `list_models` (it needed a model) and passed the table's level (4/4). The agent opened the
  installed skill twice (both `installed-skill`/`run-prompt-pick`) and never opened the worktree
  skill (0/16), so its effort and "Model Names" text was not read.
- **Naming only a family is what sent the agent to `list_models`** (7/8 against 2/8), and then it
  applied the table every time (8/8, the eighth being `gpt-5`, correctly with no effort).
- **Bare names fail only in the family variant** (2/8): the agent copied `oai@` specs from
  `list_models`' Access lines. claudish removed them and said so (below), the children ran on
  `cx@`, and the efforts still reached the wire.

### Tool calls, verbatim (prompt and input text omitted, shown in the madbench.yaml)

Passing, `worktree-family`/`team-frontend`, trial 1:

```
mcp__claudish__list_models {}
mcp__claudish__team {"efforts":{"gpt-6-luna":"xhigh","gpt-6.1-sol":"high"},"mode":"run","models":["gpt-6.1-sol","gpt-6-luna"],"path":"team-ui"}
```

Passing, a model with no row, `worktree-family`/`team-no-entry`, trial 1:

```
mcp__claudish__list_models {}
mcp__claudish__team {"efforts":{"gpt-6.1-sol":"low"},"mode":"run","models":["gpt-6.1-sol","minimax-m3"],"path":"team-typo"}
```

Every failing start call:

```
installed-skill and worktree-skill, team-frontend, trials 1 and 2 (4 Sessions, identical):
mcp__claudish__team {"mode":"run","models":["gpt-6-astra","gpt-6.1-sol"],"path":"team-ui"}

installed-skill and worktree-skill, session-code-review, trials 1 and 2 (4 Sessions, identical):
mcp__claudish__create_session {"model":"gpt-6-luna"}

installed-skill and worktree-skill, team-no-entry, trials 1 and 2 (4 Sessions, identical):
mcp__claudish__team {"mode":"run","models":["gpt-6-astra","minimax-m3"],"path":"team-typo"}

worktree-family/team-frontend, trial 2 (fails BareNames only):
mcp__claudish__list_models {}
mcp__claudish__team {"efforts":{"oai@gpt-6-luna":"xhigh","oai@gpt-6.1-sol":"high"},"mode":"run","models":["oai@gpt-6.1-sol","oai@gpt-6-luna"],"path":"team-ui"}
  claudish: "provider_note": "Provider removed so claudish routing decides: oai@gpt-6.1-sol -> gpt-6.1-sol, oai@gpt-6-luna -> gpt-6-luna. Pass 'user_required_provider' only when the user named the provider."

worktree-family/team-no-entry, trial 2 (fails BareNames only):
mcp__claudish__list_models {}
mcp__claudish__team {"efforts":{"oai@gpt-6.1-sol":"low"},"mode":"run","models":["oai@gpt-6.1-sol","mm@minimax-m3"],"path":"team-typo"}
  claudish: "provider_note": "Provider removed so claudish routing decides: oai@gpt-6.1-sol -> gpt-6.1-sol, mm@minimax-m3 -> minimax-m3. Pass 'user_required_provider' only when the user named the provider."

worktree-family/session-code-review, trial 2 (no list_models; the family pick was an old model):
mcp__claudish__create_session {"model":"gpt-5"}
  → FAILED prompt_not_read, "credit_balance_exhausted" (gpt-5 has no Codex route; metered OpenAI has no credit)
```

The efforts map kept the agent's `oai@…` keys while `models` was rewritten; the children still
pinned the right levels (B1/B2 below), so the keys were matched before or with the rewrite.

### Layer B evidence, verbatim (from the Checks' Evidence; workspaces are deleted)

`worktree-family`/`team-frontend`, trial 1:

```
[2026-10-23T02:50:25.845Z] [ComposedHandler] --effort xhigh pinned for cx@gpt-6-luna (catalog clamp skipped)
[2026-10-23T02:50:25.845Z] [Wire] openai-codex@gpt-6-luna → openai/codex-subscription · gpt-6-luna: responses (credential-decided host) [generation g-20261022161717577-cdb3e76a]
[2026-10-23T02:50:27.023Z] [SSE:responses] response.created … "reasoning":{"effort":"xhigh","summary":"detailed","context":"all_turns","mode":"standard"}
[2026-10-23T02:50:25.554Z] [ComposedHandler] --effort high pinned for cx@gpt-6.1-sol (catalog clamp skipped)
[2026-10-23T02:50:25.554Z] [Wire] openai-codex@gpt-6.1-sol → openai/codex-subscription · gpt-6.1-sol: responses (credential-decided host) [generation g-20261022161717577-cdb3e76a]
[2026-10-23T02:50:28.186Z] [SSE:responses] response.created … "reasoning":{"effort":"high","summary":"detailed","context":"all_turns","mode":"standard"}
```

`worktree-family`/`session-code-review`, trial 1 (create_session `effort: "xhigh"`):

```
[2026-10-23T02:50:22.573Z] [ComposedHandler] --effort xhigh pinned for cx@gpt-6.1-sol (catalog clamp skipped)
[2026-10-23T02:50:24.719Z] [SSE:responses] response.created … "reasoning":{"effort":"xhigh","summary":"detailed","context":"all_turns","mode":"standard"}
```

`worktree-family`/`team-frontend`, trial 2, after claudish removed `oai@` (agent keys `oai@gpt-6-luna`, `oai@gpt-6.1-sol`):

```
[2026-10-23T02:52:34.123Z] [ComposedHandler] --effort xhigh pinned for cx@gpt-6-luna (catalog clamp skipped)
[2026-10-23T02:52:35.259Z] [SSE:responses] response.created … "reasoning":{"effort":"xhigh","summary":"detailed","context":"all_turns","mode":"standard"}
[2026-10-23T02:52:33.823Z] [ComposedHandler] --effort high pinned for cx@gpt-6.1-sol (catalog clamp skipped)
[2026-10-23T02:52:36.501Z] [SSE:responses] response.created … "reasoning":{"effort":"high","summary":"detailed","context":"all_turns","mode":"standard"}
```

`worktree-family`/`team-no-entry`, trial 1 (`low` for the GPT model; no pin for `minimax-m3`
was asserted):

```
[2026-10-23T02:50:24.901Z] [ComposedHandler] --effort low pinned for cx@gpt-6.1-sol (catalog clamp skipped)
[2026-10-23T02:50:29.098Z] [SSE:responses] response.created … "reasoning":{"effort":"low","summary":"detailed","context":"all_turns","mode":"standard"}
```

run_prompt (all six run-prompt-pick Sessions passed `effort: "medium"` on `gpt-6.1-sol`), e.g.
`installed-skill`, trial 1, in the MCP server's own proxy:

```
[2026-10-23T02:48:36.114Z] [Wire] openai-codex@gpt-6.1-sol → openai/codex-subscription · gpt-6.1-sol: responses (credential-decided host) [generation g-20261022161717577-cdb3e76a]
[2026-10-23T02:48:38.537Z] [SSE:responses] response.created … "reasoning":{"effort":"medium","summary":"detailed","context":"all_turns","mode":"standard"}
```

No `[Wire] … effort A → B` mapping note appeared.

### `list_models` disk fallback: seen, 2 of 11 calls

All 11 `list_models` answers carried the effort table. Two carried the fallback note, both in
trial 1 of `worktree-family`, 0.3 s apart while four servers started together:

- `session-code-review` (02:50:18.460Z) and `run-prompt-pick` (02:50:18.162Z):
  `_The live catalog could not be read; this list is from generation g-20261022161717577-cdb3e76a, the last one this machine stored._`

The other nine were live. Both fallback Sessions still applied the table (efforts right, 2/2).
The run2 defect (a failed fetch dropping the table) did not recur.

### claudish-mcp log lines written during the run

`~/.claudish/logs` keeps 20 `claudish-mcp_*.log` files, and this run started well over 20 MCP server
processes (madbench's pre-launch probe plus the host's server, per Session), so every file from
02:48–02:51Z had been rotated away when I read the directory. The surviving 20 files (trial 2,
02:51–02:53Z) hold these tagged lines, quoted in full:

```
[2026-10-23T02:52:02.132Z] [catalog] refresh failed: timeout
[2026-10-23T02:52:31.786Z] [mcp] provider removed: oai@gpt-6.1-sol -> gpt-6.1-sol, oai@gpt-6-luna -> gpt-6-luna
[2026-10-23T02:52:32.092Z] [mcp] provider removed: oai@gpt-6.1-sol -> gpt-6.1-sol, mm@minimax-m3 -> minimax-m3
[2026-10-23T02:52:39.756Z] [recommended] warm failed: Unable to load v3 recommended models: The operation timed out.
```

No `[effort]` or `[team]` line survived. The two trial-1 fallbacks' own `[recommended]`/`[catalog]`
lines were among the rotated files, so their cause is not quoted.

### The open `home` risks, as observed

- **Keychain-held keys**: not available. `minimax-m3` routed to OpenRouter (team status
  `"provider": "OpenRouter"`, spawn `or@minimax/…`) instead of `zengo@`, whose key lives in the
  Keychain; the slots completed, on metered billing. Codex (`~/.claudish/codex-oauth.json`) worked.
- **Fresh child HOME**: broke the first probe (theme picker); fixed by an interactive host,
  whose seeding the children share. No child hit a dialog in run9.
- **Dropped hooks**: neither variant loads the installed plugin's hooks or any other host
  plugin; nothing in run9 depended on them.

### Not verified

- Whether the `minimax-m3` children ran with Claude Code's own effort (no Check asserts the
  absence of a pin line).
- Cause of the two fallback answers (their log files were rotated).
- Layer B on a non-Responses connection, and the step 5w mapping path (no clamp occurred).
- Any host but `claude-sonnet-5-5`; two trials per variant and Scenario.

## run3: the plugin-staging design at `sandbox: home` (2026-10-23, 02:34–02:36Z) — the MCP server never came up

`effort.experiment.yaml --trials 2`, three variants × four Scenarios × 2 trials = 24 Sessions.
Report: `ai-docs/sessions/recommended-effort-bench-20261023/reports/run3.json` (gitignored).
Gates before it: preflight `PREFLIGHT OK  3 benches · 138 components verified`; check
`93/93 gradable checks failed as required · 0 errored (could not grade) · 0 wrongly passed · 12 not applicable under mock`.
Build: the coordinator's `packages/cli/dist/index.js` (not rebuilt); the worktree skill copy was
`cmp`-identical to `packages/cli/skills/claudish-usage/SKILL.md`.

**Result: 0/24 Scenarios passed, and none of them measured the feature.** In every Session:

- madbench's MCP preflight, from inside the `home` sandbox, 24/24:
  `environment:mcp-reachable: MCP server "claudish" did not answer madbench's pre-launch handshake: the initialize deadline elapsed before the server answered: context deadline exceeded; exit: signal: killed`
- the host Claude Code's own record (`failedMcpServers`), 24/24:
  `{"error":"Connection closed","errorCode":"CONNECTION_CLOSED","name":"claudish"}`
- so no `mcp__claudish__*` call was made (0 in 24 Sessions); every effort, bare-name and
  layer-B Check failed with `no <tool> start call in the Session`. The host said, e.g.: "I
  couldn't run this. The claudish MCP server failed to connect (`CONNECTION_CLOSED`), so its
  `team` tool isn't available in this session."

What did work at `home`: **plugin staging**. `environment:skill-registered claudish:claudish-usage`
passed 24/24, and the skill list the host received names the staged text per variant:
`installed-skill` → "claudish:claudish-usage: Runs models through the claudish MCP tools — team,
create_session, run_prompt — and resolves model IDs against the live …" (the installed 2.10.0
skill); `worktree-*` → "claudish:claudish-usage: CRITICAL - Guide for using Claudish CLI ONLY
through sub-agents …" (the worktree skill). `session:skill-used` (readout) 0/24: never invoked.

**Not established: why the server does not start under `home`.** The Session carries no stderr
from the server. No `~/.claudish/logs/claudish-mcp_*.log` was written during the run (0 files of
that name exist), although `~/.claudish` was shared `rw`: the server either never reached its
logger or did not see the shared path. Its debug log (`CLAUDISH_DEBUG`, `<cwd>/logs/`) was in the
deleted workspace. The `[mcp]`/`[catalog]`/`[recommended]`/`[effort]`/`[team]` grep therefore
has nothing to quote. Candidates, none tested: the macOS read confinement of `home` denying a
file `bun` or the bundle needs outside the allow-set; something blocking on the replaced HOME
(Keychain via `security`, 1Password); the share not resolving. I did not switch back to
`workspace`, as instructed.

Cost and time: host $0.75 (24 Sessions, subscription); trials 59 s and 58 s. A duplicate of the
same command (a keystroke batch the new pane replayed after the first run ended) started at
02:36Z and was stopped with Ctrl-C after one trial; its partial report is
`run3-duplicate-interrupted.json` (host $0.12, same failure) and is not counted.

> These runs used the earlier design: `sandbox: workspace`, the host's installed `claudish@magus`
> plugin and its `claudish-usage` skill (no effort section), and variants `unprompted` / `asked`.
> The Bench now stages the skill with `harness.config.plugins` at `home` (see README). The
> results below are the installed-skill condition only.

Build under test: this worktree, `bun run build`, `packages/cli/dist/index.js` (reports
`claudish version 13.1.0`), uncommitted effort changes included. madbench 0.54.0. Host
`claude-sonnet-5-5` on the Claude Max subscription. Effort sidecar generation
`g-20261022002624894-85e83b1a` in every run.

| Run | What | Report JSON (gitignored session dir) |
|---|---|---|
| run1 | pilot: `madbench.yaml`, one trial, an earlier version of the Scenarios (below) | `ai-docs/sessions/recommended-effort-bench-20261023/reports/run1.json` |
| run2 | `effort.experiment.yaml`, variants `unprompted` and `asked`, `--trials 2` | `ai-docs/sessions/recommended-effort-bench-20261023/reports/run2.json` |

The free gates, before each real run:

```
madbench preflight → PREFLIGHT OK  2 benches · 68 components verified
madbench check     → 38/38 gradable checks failed as required · 0 errored (could not grade) · 0 wrongly passed · 8 not applicable under mock
                     control holds: every gradable check was graded, and none passed against a harness that did nothing.
madbench grade run2.json → 48/48 checks reproduced · 0 diverged · 0 could not be re-graded · 44 skipped (stated above)
```

`grade` skips every `ts` file Check (madbench skips file-loading script Checks by design), so the
positive control covers only the `session:*` and `environment:*` Checks.

Cost and time: host cost as Claude Code reports it, billed to the subscription: run1 $0.35, run2
$1.59 (16 Sessions). The children ran on the Codex subscription and `zengo@` (team status
`costUsd: 0`). run2 wall time: trial 1 117 s, trial 2 100 s. Each Session took 13 to 63 s.

## Scenario verdicts (run2, from `.aggregate.perScenario`)

| Scenario | `unprompted` | `asked` |
|---|---|---|
| `team-frontend` | 0/2 | 1/2 |
| `session-code-review` | 0/2 | 2/2 |
| `run-prompt-pick` | 2/2 | 1/2 |
| `team-no-entry` | 0/2 | 2/2 |
| total | 2/8 | 6/8 |

## Per layer (run2, counted from `.trials[].results[].checks[]`)

| Check | `unprompted` | `asked` |
|---|---|---|
| A0 `ConsultedTable`: `list_models` before the start call | 2/8 (both `run-prompt-pick`) | 8/8 |
| `list_models` output carried the effort table | 2/2 calls | 6/8 calls (2 returned "No recommended models found") |
| A `EffortArgs`: every model's effort equals its table entry | 2/8 | 6/8 |
| B1 `EffortFlag`: the child pinned the level (team, create_session) | 0/6, no effort passed | 5/6 (the miss passed no effort) |
| B2 `EffortWire`: the provider echoed the level | 2/2 (`run-prompt-pick`); 0/6 elsewhere, no effort passed | 7/8 (the miss passed no effort) |

Per model, wherever the agent passed an effort:

- **Layer A**: 11 of 11 model efforts equalled the table entry, in 8 of 8 start calls. Both
  `team-no-entry` calls in `asked` left `minimax-m3` out of `efforts` (`{"gpt-6-astra":"low"}`).
- **Layer B**: 6 of 6 (model, level) pairs reached a child as a pin line, and 9 of 9 pairs were
  echoed by the provider at the level the agent passed. No `[Wire] … effort A → B` mapping note
  appeared: every level was one the Codex connection publishes.

Every Layer A miss is one of two kinds:

1. **The agent never opened `list_models`** (6/6 `unprompted` team and create_session runs, and
   3/4 in run1). It loaded only `team` or `create_session` through ToolSearch and called it
   with no `efforts`/`effort`. The `efforts` description ("Take each level from list_models'
   'Recommended effort by task type' table") was in the schema it loaded. The tool description
   alone did not lead it to the table in 0 of 6 runs. When the agent opened `list_models` for its
   own reason (to pick a model, `run-prompt-pick`), it applied the table without being asked,
   2/2.
2. **`list_models` returned no table** (2/8 `asked` runs, the production defect below). The
   agent then said so and passed no effort.

## Tool calls, verbatim

Passing, `asked`/`team-frontend`, trial 1:

```
mcp__claudish__list_models {}
mcp__claudish__team {"efforts":{"gpt-6-astra":"xhigh","gpt-6.1-sol":"high"},"input":"Write a small React component `PricingCard` (TypeScript, Tailwind classes) that shows a plan name, a monthly price and a \"Choose plan\" button. Reply with the code only. Do not create or edit any files.","mode":"run","models":["gpt-6-astra","gpt-6.1-sol"],"path":"team-ui"}
```

Passing, a model with no table entry, `asked`/`team-no-entry`, trials 1 and 2 (identical):

```
mcp__claudish__list_models {}
mcp__claudish__team {"efforts":{"gpt-6-astra":"low"},"input":"The line `return \"Helo, \" + name;` has a typo. Reply with the corrected line only. Do not create or edit any files.","mode":"run","models":["gpt-6-astra","minimax-m3"],"path":"team-typo"}
```

Passing without being asked, `unprompted`/`run-prompt-pick`:

```
trial 1: mcp__claudish__run_prompt {"effort":"max","model":"gpt-6-luna","prompt":"Write a TypeScript function `isLeapYear(year: number): boolean` that follows the Gregorian calendar rules (divisible by 4, except centuries unless divisible by 400). Return only the code in a single TypeScript code block, with a brief doc comment."}
trial 2: mcp__claudish__run_prompt {"effort":"medium","model":"gpt-6.1-sol","prompt":"Write a TypeScript function `isLeapYear(year: number): boolean` that follows the Gregorian calendar rules (divisible by 4, except century years, unless divisible by 400). Return only the code in a single TypeScript code block, with a brief doc comment."}
```

Each failing start call (no `list_models` call before it, unless shown):

```
unprompted/team-frontend, trials 1 and 2:
mcp__claudish__team {"input":"Write a small React component `PricingCard` (TypeScript, Tailwind classes) that shows a plan name, a monthly price and a \"Choose plan\" button. Reply with the code only. Do not create or edit any files.","mode":"run","models":["gpt-6-astra","gpt-6.1-sol"],"path":"team-ui"}

unprompted/session-code-review, trials 1 and 2:
mcp__claudish__create_session {"model":"gpt-6-luna","prompt":"Review this TypeScript function for bugs. Reply with a short list of the bugs you find. Do not create or edit any files.\n\nfunction average(xs: number[]): number {\n  let sum = 0;\n  for (let i = 1; i <= xs.length; i++) sum += xs[i];\n  return sum / xs.length;\n}"}

unprompted/team-no-entry, trials 1 and 2:
mcp__claudish__team {"input":"The line `return \"Helo, \" + name;` has a typo. Reply with the corrected line only. Do not create or edit any files.","mode":"run","models":["gpt-6-astra","minimax-m3"],"path":"team-typo"}

asked/team-frontend, trial 2 (list_models returned "No recommended models found. Try search_models instead."):
mcp__claudish__list_models {}
mcp__claudish__team {"input":"Write a small React component `PricingCard` (TypeScript, Tailwind classes) that shows a plan name, a monthly price and a \"Choose plan\" button. Reply with the code only. Do not create or edit any files.","mode":"run","models":["gpt-6-astra","gpt-6.1-sol"],"path":"team-ui"}
  agent: "`list_models` returned "No recommended models found", so I had no effort table to read a level from. I didn't want to guess."

asked/run-prompt-pick, trial 2 (same list_models result):
mcp__claudish__list_models {}
mcp__claudish__run_prompt {"model":"gpt-6-luna","prompt":"Write a TypeScript function `isLeapYear(year: number): boolean` that follows the Gregorian calendar rules (divisible by 4, except centuries unless divisible by 400). Return only the code in one code block, with a brief doc comment."}
  agent: "`list_models` returned "No recommended models found", so claudish had no recommended effort to apply, and I didn't want to invent one."
```

run1 (pilot, `unprompted` wording; the team and session calls match the run2 failures above):

```
run-prompt-pick (then a terminal_ops task: "a shell one-liner that lists the 5 largest files"):
mcp__claudish__list_models {}
mcp__claudish__run_prompt {"effort":"low","model":"oai@gpt-6-luna","prompt":"Give me a single shell one-liner …"}
mcp__claudish__run_prompt {"effort":"low","model":"oai@gpt-6.1-sol","prompt":"…same…"}
  → both: "[API Error: credit_balance_exhausted You have no credits remaining. …]"
```

The agent read the shell task as `quick_edit` (`low` for both models) where the Scenario expected
`terminal_ops` (`max`, `xhigh`). That is a fair reading, so run2 replaced it with an
implementation task. It took the `oai@` spec from `list_models`' Access line (see
Observations), and the metered OpenAI account had no credit.

## Layer B evidence, verbatim

The lines below are from the debug logs claudish wrote into each workspace, as the Checks
recorded them in Evidence (`.checks[].result.evidence.perModel`). The workspaces are deleted
after each run. `[SSE:responses]` lines are cut to the event type and the `reasoning` object.

`asked`/`team-frontend`, trial 1. Child for `gpt-6-astra`, given `xhigh`:

```
[2026-10-22T15:41:09.213Z] [ComposedHandler] --effort xhigh pinned for cx@gpt-6-astra (catalog clamp skipped)
[2026-10-22T15:41:09.213Z] [Wire] openai-codex@gpt-6-astra → openai/codex-subscription · gpt-6-astra: responses (credential-decided host) [generation g-20261022002624894-85e83b1a]
[2026-10-22T15:41:11.265Z] [SSE:responses] response.created … "reasoning":{"effort":"xhigh","summary":"detailed","context":"all_turns","mode":"standard"}
```

Child for `gpt-6.1-sol`, given `high`:

```
[2026-10-22T15:41:09.447Z] [ComposedHandler] --effort high pinned for cx@gpt-6.1-sol (catalog clamp skipped)
[2026-10-22T15:41:09.447Z] [Wire] openai-codex@gpt-6.1-sol → openai/codex-subscription · gpt-6.1-sol: responses (credential-decided host) [generation g-20261022002624894-85e83b1a]
[2026-10-22T15:41:11.710Z] [SSE:responses] response.created … "reasoning":{"effort":"high","summary":"detailed","context":"all_turns","mode":"standard"}
```

`asked`/`session-code-review`, trial 2, create_session `effort: "xhigh"`:

```
[2026-10-22T15:43:01.563Z] [ComposedHandler] --effort xhigh pinned for cx@gpt-6-luna (catalog clamp skipped)
[2026-10-22T15:43:01.563Z] [Wire] openai-codex@gpt-6-luna → openai/codex-subscription · gpt-6-luna: responses (credential-decided host) [generation g-20261022002624894-85e83b1a]
[2026-10-22T15:43:03.362Z] [SSE:responses] response.created … "reasoning":{"effort":"xhigh","summary":"detailed","context":"all_turns","mode":"standard"}
```

`asked`/`team-no-entry`, trial 2. Child for `gpt-6-astra`, given `low`:

```
[2026-10-22T15:43:07.180Z] [ComposedHandler] --effort low pinned for cx@gpt-6-astra (catalog clamp skipped)
[2026-10-22T15:43:07.180Z] [Wire] openai-codex@gpt-6-astra → openai/codex-subscription · gpt-6-astra: responses (credential-decided host) [generation g-20261022002624894-85e83b1a]
[2026-10-22T15:43:09.986Z] [SSE:responses] response.created … "reasoning":{"effort":"low","summary":"detailed","context":"all_turns","mode":"standard"}
```

`unprompted`/`run-prompt-pick`, trial 1. run_prompt `effort: "max"`, in the MCP server's own proxy
(no child, so no pin line; `output_config.effort` went through step 5w):

```
[2026-10-22T15:40:09.641Z] [Wire] openai-codex@gpt-6-luna → openai/codex-subscription · gpt-6-luna: responses (credential-decided host) [generation g-20261022002624894-85e83b1a]
[2026-10-22T15:40:10.883Z] [SSE:responses] response.created … "reasoning":{"effort":"max","summary":"detailed","context":"all_turns","mode":"standard"}
```

`asked`/`run-prompt-pick`, trial 1, `effort: "medium"` on `gpt-6.1-sol`: echoed `"effort":"medium"` at
15:41:15.290Z, after the same `[Wire] openai-codex@gpt-6.1-sol` line.

Each child's log file echoed the same level in every `response.created` (2 or 3 per child).

## Production defect

**`list_models` drops the effort table whenever the recommendation fetch fails, although the
table is on disk.** `packages/cli/src/mcp-server.ts`, `list_models` handler: when
`getRecommendedModels()` throws, or returns no models, the handler returns
`"No recommended models found. Try search_models instead."` before it reads
`latestEffortRecommendations()`. The sidecar (generation `g-20261022002624894-85e83b1a`) was
present the whole time. In trial 2 of `asked`, four MCP servers (one per Session, concurrency 4)
answered `list_models` within 2.6 s. The first, at 15:42:55.842Z (`session-code-review`), and the
fourth, at 15:42:58.451Z (`team-no-entry`), returned the table. The second, at 15:42:55.883Z
(`run-prompt-pick`), and the third, at 15:42:57.992Z (`team-frontend`), returned only that
sentence. The same four-way start in trial 1 returned four tables. The handler's own comment
says an older sidecar "still shows the last generation this machine read", but on this path
nothing is shown. The `catch {}` also discards the error, and the MCP server writes no always-on
log (`initLogger(true, "debug", true)`). The debug log was in the deleted workspace, so this run
cannot say why the fetch failed. It happened in 2 of 10 `list_models` calls in run2. Effect,
measured: in both cases the agent explicitly declined to pass an effort, and both Scenarios failed
Layer A. Not fixed here, as instructed.

## Observations (not defects of this feature)

- **`list_models`' Access line names the metered route.** For the GPT models it prints
  `oai@gpt-6-luna`, `oai@gpt-6.1-sol`, `oai@gpt-6-astra`, although `--probe` shows `cx@`
  (subscription) first in the routing chain for each. In run1 the agent used `oai@gpt-6-luna`
  and `oai@gpt-6.1-sol` from that line, and both calls failed `credit_balance_exhausted`. This
  predates the effort table (`renderRecommendedMarkdown` / `nativeShortcutForVendor`). run2 works
  around it by asking for the bare name.
- **claudish logs the effort it sends only when step 5w changes it.** `applyReasoning`
  (`providers/wire-request.ts`) writes `[Wire] … effort A → B` only for a mapped level, and
  `sentEffort` is never logged. A level the connection publishes leaves no claudish line naming
  it. This Bench therefore proves the wire through the provider's `response.created` echo, which
  exists only on Responses connections. A Chat Completions or Messages connection (`kc@k3`,
  `zengo@minimax-m3`) would leave Layer B unprovable from logs.
- **run_prompt returns an upstream error as an ordinary result**: `"[API Error:
  credit_balance_exhausted …]\n\n---\nTokens: 100 input, 1 output"` (run1). The agent read it
  correctly, but the token footer suggests a completed call.

## Not verified, and why

- **That `minimax-m3` ran with Claude Code's own effort.** The Checks grade efforts the agent
  passed. They do not assert that the `minimax-m3` child has no pin line, and the workspace logs
  are gone. Layer A shows only that no effort was passed for it.
- **Layer B on a connection that is not the Responses API.** Every effort that was passed went to
  a Codex `responses` connection. No clamp (`effort A → B`) case occurred, so the mapping path of
  step 5w was not exercised.
- **A native Claude model.** Effort on a bare Claude name is ignored by design (wire.md). No
  Scenario picked one.
- **Why the two `list_models` fetches failed** (above).
- **Statistics**: 2 trials per variant and Scenario, plus a 1-trial pilot. The "never opens
  `list_models` unprompted" result is 0/6 in run2 and 0/3 in run1 (team and session Scenarios).
  The other rates are small counts, not estimates.
- **Host model**: only `claude-sonnet-5-5`. A different host (Opus, Haiku) was not measured.
- run1 used the earlier Scenario set (`team-implementation`, a `terminal_ops` pick task, and the
  name `team-no-cell` for `team-no-entry`). The checks in `checks/effort-trace.ts` were renamed
  `checks/effort-plumbing.ts` after run1, with the same logic.
