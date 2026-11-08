# advisor-subscription: `--advisor` panel members on the subscription

A re-runnable live check of subscription-aware advisor routing (session
`dev-feature-advisor-subscription-20261020-233354-f7e4`, live checks L1–L7). Through v12.1.2
every advisor panel call was one bare `fetch` with a metered key: a Codex subscriber paid per
token, and `cx@` went to OpenRouter. Each panel member is now planned by the function main
routing is derived from and called through the same handler machinery
(`ai-docs/architecture/advisor.md`, "Panel routing and billing").

Real Claude Code drives this worktree's claudish build against the real subscription backends:
ChatGPT Codex (`cx@`, OAuth), Kimi Coding (`kc@`) and the Claude Code login. There is no mock
upstream, and **no metered key may serve a live call**. A correct answer proves nothing here:
claudish's debug log says who served each panel call and how it billed.

## What the Checks read

`claudish-under-test` passes `--debug-claudish`, so claudish writes `logs/claudish_*.log` into
the workspace. Three kinds of line are graded (`checks/advisor-log.ts`, one `section` per Check):

| Line | Carries | Section |
|---|---|---|
| `[advisor-origin] {json}` | one `advisor_call` per panel member, one `advisor_collector_call` per collector run: `origin`, `stubPath`, `upstreamStatus`, `servedBy {provider, displayName, arm, billing}`, `credentialSource` | `records` |
| `[advisor-notice] <line>` | the startup notice: each member's first hop and its billing | `notice` |
| `… Calling API: <url>` | every upstream request; `[advisor] Calling API: … (role, auth, source)` is the Claude boundary line | `hosts`, `secrets` |

`records` requires at least one record per expected member and requires EVERY record of that
member to match, so one metered record for a subscription member fails it. `notice` also
compares the notice's first hop (`<model> -> <displayName> (`) with every upstream record's
`servedBy.displayName` (L4: the notice promised what ran).

## The Scenarios

The Bench's `harness.args` carry `--permission-mode bypassPermissions`; each Scenario adds its
own `--advisor` (and, for `claude-login`, `--model`) through its own `harness: {args: […]}`,
which madbench appends after the Bench's. claudish keeps the last `--model`;
`claudish-provenance.txt` records the argv.

| Scenario | Main model | `--advisor` | Passes when |
|---|---|---|---|
| `routed-codex` (L1, L2, L4, L6) | `cx@gpt-6.1-sol`, code mode auto | `gpt-6.1-sol,cx@gpt-6.1-sol,kc@k3:` | the answer carries `REF: heron-5521` (only in `plan.md`) and an `ADVICE:` line; `plan.md` was read; every record of `gpt-6.1-sol` and `cx@gpt-6.1-sol` is `upstream` and served by `openai-codex`, `servedBy.arm` `oauth`, billing `subscription`; every `kc@k3` record is `upstream`, `kimi-coding`, `subscription`; each member's notice line says `(subscription` and names the provider that served; no notice line says "never use a subscription"; every `Calling API:` goes to `chatgpt.com/backend-api/codex/` or the Kimi Coding host (`api.kimi.ai/coding/`, what the catalog's kimi-coding connection publishes; `api.kimi.com/coding/` is the built-in default), both present; no `was served by … not … as the notice said` line; code mode on from discovery and every relayed exec resumed |
| `routed-grok` (L3 grok) | `cx@gpt-6.1-sol` | `grok-4.7,gk@grok-4.7:` | the answer has an `ADVICE:` line; every record of both members is `upstream`, served by `grok-subscription`, billing `subscription`; both notice lines say `Grok Build (subscription` and name the provider that served; every `Calling API:` goes to `chatgpt.com/backend-api/codex/` or `cli-chat-proxy.grok.com`, both present, none to `api.x.ai` or OpenRouter; no served-unlike line |
| `routed-antigravity` (fix D8) | `cx@gpt-6.1-sol` | `ag@gemini-3.8-flash` | the answer has an `ADVICE:` line; the launch was not refused (`not_refused`: the notice says `--advisor is on for this launch`, no `--advisor cannot work in this launch` line); every record is `upstream`, served by `antigravity`, billing `subscription`; the notice line says `Antigravity` and `(subscription`; `wire_id_resolved`: on every `[Antigravity] Auth refreshed, … model: <requested> -> <sent>, served: <list>` line, `<requested>` is `gemini-3.8-flash`, `<sent>` is in `<list>`, and `<sent>` is `gemini-3.8-flash` or a `gemini-3.8-flash-*` variant (the account's dynamic models catalog lists only suffixed variants, so before D8 the availability check matched the bare id exactly and dropped the `ag@` hop). No variant is pinned: which one is sent is the account's choice (2026-10-21: it listed `-high`, `-medium`, `-low` and `-tiered`, and the resolver sent `-high`); every `Calling API:` goes to `chatgpt.com/backend-api/codex/` or `daily-cloudcode-pa.googleapis.com`, both present, none to `generativelanguage.googleapis.com`, OpenRouter or `api.openai.com`; no served-unlike line |
| `rejected-sub` (L3 gemini) | `cx@gpt-6.1-sol` | `gemini-4-argon` | **an observation, not a verdict.** What an expired subscription key should do to the chain is not settled, so only two Checks grade: the answer has a `STATUS:` line (the session completed) and an `advisor_call` record exists. Readouts record the rest: `chain_observed` (hops tried in order, statuses, servedBy, stub reason, `[advisor]` warnings, the `Calling API:` sequence), `stubbed_on_401`, `hosts_subscription_only` and `notice_observed` (the earlier expectation: a stub carrying 401, no metered host). On 2026-10-21 the plan had no Zen Go hop at all (`content-use opt-in id only`), and the call was served metered by Gemini |
| `claude-login` (L7) | `claude-sonnet-5-5`, native: claudish controls the child's auth | `cx@gpt-6.1-sol,sonnet:haiku` | the answer has an `ADVICE:` line; `cx@gpt-6.1-sol` served by `openai-codex` on `oauth`; `sonnet` and the collector `haiku` are `upstream`, `servedBy.arm` `oauth`, billing `subscription`, `credentialSource: claude-code-login`; the notice says `sonnet -> api.anthropic.com (subscription: your Claude Code login` and has a collector line for `haiku` on the subscription, and never the uncontrolled form `metered, billed per token: ANTHROPIC_API_KEY`; one `[advisor] Calling API: https://api.anthropic.com/v1/messages (role: panel, auth: bearer, source: claude-code-login` line and one with `role: collector`; no `auth: bearer` line to any other host; no log line matches `Bearer sk-ant`, `sk-ant-oat` or `sk-ant-api` |
| `refusal` (L5) | `cx@gpt-6.1-sol`, no advisor | none in the session | see below |

Every Scenario also carries **`provenance`**: the shim wrote `claudish-provenance.txt` naming
the `dist/index.js` it ran, its `claudish version`, the git head and the argv.

`routed-codex` also has the readout `advisor_tool_seen` (`session:tool-used: advisor`): whether
the captured Session records the advisor tool call at all. The log records are the graded
evidence; the readout only says what the transcript shows.

### Why `routed-codex` names no collector

A panel of two or more with no `:` gets the default collector `haiku`. On a `cx@` launch there is
no Claude login, so `haiku` would sign with an `ANTHROPIC_API_KEY` if claudish finds one (env,
config, Keychain, 1Password): metered. The trailing `:` names no collector, so the Scenario
stays subscription-only. The Claude collector is covered by `claude-login`.

### `refusal`: a startup refusal as a real Check

A refused launch exits 1 before Claude Code starts, so it cannot be the Scenario's own session (madbench would
record an error, never a grade). Instead the Scenario sets `ADVISOR_REFUSAL_PROBE=1` in its
`sandbox.env`, and the shim, before it starts the (advisor-free) session, runs

```
bun <repo>/packages/cli/dist/index.js --debug-claudish --log-level debug --advisor "<spec>" -p "hi"
```

with a 60 s `timeout`, once for `ag@gemini-0-nonexistent` and once for `opusplan`, each in its own
`refusal/<name>/` directory, recording `exit.txt`, `stdout.txt`, `stderr.txt` and its own
`logs/`. The Checks pass when the exit code is 1, stderr carries `--advisor cannot work in this
launch` and names the member (and, for the `opusplan` Claude selector, its reason `switches tier`),
and that directory's log has no `Calling API:` line.

The Antigravity member is `ag@gemini-0-nonexistent`, a family that does not exist, so no account can ever
serve a variant of it. It was `ag@gemini-4-argon` until 2026-10-21, when the account's Antigravity dynamic
models catalog began listing `gemini-4-argon-high`, `-medium` and `-low`; since fix D8 the availability check
resolves a bare family id to a served variant, so that launch was planned, not refused. A refusal member must
not depend on what one account happens to serve today. The mock harness never runs the shim, so under `madbench check` the files are absent
and both Checks fail.

## Grok needs a live login

`routed-grok` needs a current SuperGrok login (`claudish login grok`). A revoked refresh token
makes both members fail; trust a fresh claudish process, not a long-lived MCP server's preflight,
which can hold a stale token in memory.

## `rejected-sub` can spend

When bare `gemini-4-argon` has no usable subscription candidate (the 2026-10-21 run: Antigravity
does not serve it, Zen Go is skipped as `content-use opt-in id only`), its chain is metered and
the call bills the Google key. Skip it with `--scenario` when that must not happen. madbench 0.53.1
takes one `--scenario`: a repeated flag silently keeps only the last value, and a comma list
selects nothing (exit 1). Run one madbench per Scenario, each with its own `--report-json`.

## Running it

```bash
madbench list      ai-docs/benches/advisor-subscription/madbench.yaml
madbench preflight ai-docs/benches/advisor-subscription/madbench.yaml
madbench check     ai-docs/benches/advisor-subscription/madbench.yaml   # 41/41 failed as required
ADVISOR_SUB_KEEP_LOGS=<dir> madbench ai-docs/benches/advisor-subscription/madbench.yaml --report-json <out.json>
```

Run it in a visible terminal and never pipe it: a pipe turns on `--plain`. `use_subscription:
required` makes madbench mask any `ANTHROPIC_API_KEY` it resolves, so claudish never receives one
from madbench; preflight says so.

## Keeping the logs

madbench deletes the workspace after grading and has no retention flag; its documented answer
is to have a Check copy what it needs out (madbench `docs/sandbox-and-testdata.md`, "No workspace
retention flag"). The `provenance` Check's first line does that: with
`ADVISOR_SUB_KEEP_LOGS=<dir>` set it copies `logs/claudish_*.log`, `claudish-provenance.txt` and
`refusal/` to `<dir>/<workspace name>/`. Match a folder to its Scenario with the report's
`.results[].session.work_dir`. A passing `exec` Check also keeps its own output in the report's
`evidence.output` (madbench 0.53.0).

## Reading a failure

Read `.summary.errors` before `.summary.failed`: an errored Scenario never graded.

```bash
jq -c '.summary' out.json
jq -r '.results[] | "\(.scenario_id) \(.status)", (.checks[] | select(.result.pass==false) | "  \(.spec.metric): \(.result.reason)")' out.json
```

| Failed Check | Means | Look at |
|---|---|---|
| `panel_served` with `servedBy.billing=metered` | a panel call was billed per token: the defect this Bench exists for | the record's `hopsTried`, `servedBy` in the Check's evidence |
| `panel_served` with `no advisor_call record` | the main model never called the advisor, or the decorator never captured it | `advisor_tool_seen`; `[advisor-swap]` lines in the log |
| `panel_stubbed` with `origin=upstream` | a rejected subscription member was served by another hop | the record's `servedBy`; `hosts` will name the host |
| `notice_matches` with `notice said X, served by Y` | L4: the notice promised one provider and another served | the notice lines and records in the evidence |
| `notice_matches` with `metered, billed per token: ANTHROPIC_API_KEY` | `claude-login`: the launch was not one claudish controls (settings or env carry a credential) | the notice text names the reason; `childAuthControl` |
| `hosts` | a request went to a host outside the subscription set | the `calling_api` tally in the evidence |
| `no_bearer_value` | a Claude login value reached the log | the matched pattern and line count |
| `refusal_*` | the launch was not refused, refused for another reason, or made a request first | the Check's output: spec, exit code, stderr |
| `code_mode_on` / `resumed` | the main session's code mode broke alongside the advisor | `codex-code-mode` README |
| `provenance` | the shim did not run, so the build under test is unknown | `harness.binary`; `bun run build` |
