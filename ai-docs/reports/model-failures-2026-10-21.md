# Failed models in the 2026-10-21 preflight run

One `preflight` run (claudish MCP server, global claudish 12.1.2, `probe: true`) over every model in
the recommended list plus four explicit specs: **27 models, 12 live, 11 failed, 4 native (not
probed)**. Each failure was then checked against the branch build of `worktree-investgiage-gpt-file`
(HEAD `e6bbdda5`, `bun packages/cli/dist/index.js --probe`). This report separates claudish
defects from account and configuration states.

## Every failure

| Model / spec | 12.1.2 preflight | Class |
|---|---|---|
| `grok-4.7`, `gk@grok-4.7` | `Grok token refresh failed: Refresh token has been revoked` | D1 after re-login; account before it |
| `muse-wonder-full` | OpenRouter: `muse-wonder-full is not a valid model ID` | D2, D3 |
| `gemini-4-argon` | Zen Go HTTP 401 `This API key has expired` | account |
| `deepseek-v4-pro` | same Zen Go 401 | account |
| `deepseek-v4.1-flash` | same Zen Go 401 | account |
| `mimo-v2.6-pro` | same Zen Go 401 | account |
| `mimo-v2.6-flash` | same Zen Go 401 | account |
| `muse-spark-1.3` | same Zen Go 401 | account |
| `ag@gemini-3.8-flash` | no route: `Antigravity does not serve "gemini-3.8-flash"` | account (dynamic models catalog) |
| `go@gemini-3.8-flash` | no route: `No credentials configured for "go"` | configuration |

## claudish defects

### D1 — a long-lived claudish process keeps a revoked Grok refresh token after `claudish login grok`

Observed: the owner ran `claudish login grok`; `~/.claudish/grok-oauth.json` was rewritten at
23:27:20 local. A fresh process then served the subscription:
`bun packages/cli/dist/index.js --probe gk@grok-4.7` → `Grok Build (subscription) · 1/1 live`,
1.35 s. The claudish MCP server, started before the login, still answered every later
`preflight` for `gk@grok-4.7` and `grok-4.7` with
`Grok token refresh failed: Refresh token has been revoked. Run claudish login grok to sign in.`

Effect: every `team` / `create_session` / `preflight` through that MCP server reports SuperGrok as
logged out until the server restarts, and the message tells the user to do what they already did.

Expected: after a refresh failure (or on each refresh), the Grok credential re-reads
`grok-oauth.json` when its mtime changed, as a fresh process does.

### D2 — 12.1.2 resolves the explicit spec `meta@muse-wonder-full` to OllamaCloud

Observed (12.1.2 `preflight`, `probe: false`): `meta@muse-wonder-full` → provider `OllamaCloud`,
wire id `oc@muse-wonder-full`, metered. An explicit `provider@model` spec must pin its provider.
The branch build answers `explicit · Meta`, so the defect may already be fixed after 12.1.2. To do:
reproduce on `main` before fixing; if `main` is correct, close as fixed by the next release.

### D3 — the recommended list advertises `muse-wonder-full`, which no route serves

Observed: `list_models` lists `muse-wonder-full` under Flagship with `Access: muse-wonder-full`.
12.1.2 routes the bare name to OpenRouter, which rejects it (`not a valid model ID`). The branch
build answers `No route (catalog-empty): No provider in the catalog serves "muse-wonder-full"`,
while `zengo@muse-wonder-full` plans on OpenCode Zen Go (subscription). A recommendation must name
a model that a route can serve; either the catalog lacks the Zen Go route candidate for the bare
name, or the recommendation filter does not require one. Owner of the data: models-index (check the
`muse-wonder-full` record's connections before changing claudish).

## Test-suite defects found in the same session

### D4 — `routing-rules.test.ts` is not hermetic to `POE_API_KEY`

`ENV_KEYS_TO_CLEAR` (`routing-rules.test.ts:635-660`) omits `POE_API_KEY`. In a shell that has it,
two tests fail: `claude-opus-4-7 with only OPENROUTER_API_KEY → primary openrouter` (receives
`poe`) and `claude-opus-4-7 with no credentials → no-route` (receives `ok`). Removing only
`POE_API_KEY` from the environment makes the unchanged file pass (116 pass, 0 fail).

### D5 — tests run inside a claudish pane write their fake upstream errors into that pane's session log

The Phase 6 runner session (`a32f7e7a`) ran the suite inside a claudish pane. Its `get_diagnostics`
then listed dozens of upstream errors from test doubles (`Sakana Fugu fugu-ultra`, `Ep-one m-one`,
`fixture-upstream-error`, `stub`). The suite inherits the pane's session environment and appends to
`~/.claudish/sessions/<id>/upstream-errors.jsonl`, so a session's diagnostics are polluted by the
tests it ran. The test setup should scrub the session variables (as it scrubs credentials).

## Account and configuration actions (no code change)

| Action | Unblocks |
|---|---|
| Renew the OpenCode Zen Go key (OpenCode Console) | `gemini-4-argon`, `deepseek-v4-pro`, `deepseek-v4.1-flash`, `mimo-v2.6-pro`, `mimo-v2.6-flash`, `muse-spark-1.3` |
| Restart the claudish MCP server (until D1 is fixed) | `grok-4.7`, `gk@grok-4.7` through MCP |
| Configure `go@` (Gemini Code Assist) if wanted | `go@gemini-*` |

`ag@` serving no tested Gemini model is the account's dynamic models catalog, not a defect.
Each Zen Go model shows `+2`..`+8` fallback hops. `preflight` probes only the first hop, so this run
does not show whether a rejected Zen Go key stays off the metered hops; the `rejected-sub` scenario
of `ai-docs/benches/advisor-subscription/` measures that for an advisor panel call.
