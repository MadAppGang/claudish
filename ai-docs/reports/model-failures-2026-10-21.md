# Failed models in the 2026-10-21 preflight run

One `preflight` run (claudish MCP server, `probe: true`) over every model in the recommended list
plus four explicit specs: **27 models, 12 live, 11 failed, 4 native (not probed)**. Each failure was
traced read-only in the source of `worktree-investgiage-gpt-file` (HEAD `e6bbdda5`, 171 commits
behind `origin/main` 13.2.0; the traced logic is the same on main, only line numbers shift) and
re-run with a fresh process (`bun packages/cli/dist/index.js --probe …`). Owner review on the same
day reclassified three first-draft "account" rows as claudish behaviour; this version records that.

## Status (2026-10-22)

| Item | Status |
|---|---|
| D3 | fixed on main: `56df54b5 fix(muse): route bare muse-wonder-full to the muse@ subscription` (13.3.0) |
| D7 | fixed in 14.0.0: `9ace3fe5`, `2f282101`; the connection-fault exclusion `f8e09504` |
| D8 | fixed in 14.0.0: `8452d275`; verified live 2026-10-22 (`ag@gemini-3.8-flash` served by Antigravity, sent `gemini-3.8-flash-high`) |
| D1 | fixed on branch `worktree-investgiage-gpt-file`, unmerged: `6a4d111d`, `5f0e8aaa`, `0ebd6460` (Grok), `93efa21b`, `9f4da732` (Kimi), `80a41d9f` (Devin); behaviour tests and the live re-login check pending |
| D4 | fixed on the same branch: `77ad1ebf` (derived key list). Measured: at 14.0.0 the two tests no longer fail even with the old list (they route on a temp catalog) |
| D5 | fixed on the same branch: `a1c71ad5` (preload), `1cf7bbef` (guard), `0e7e447a` (spawn `env` rule) |
| D6 | fixed on the same branch: `a41955b4`, `25763f10`, `346310f0`, `b138f00d`; behaviour tests and the live preflight check pending |
| D9 | fixed on the same branch: `66180b69` (routing), `6e00ea93` (proxy); behaviour tests pending |
| D2 | open (closed by the owner 2026-10-22 as a stale process) |

Details: `advisor-subscription-routing-2026-10.md`.

## Every failure

| Model / spec | preflight answer | Cause | Item |
|---|---|---|---|
| `grok-4.7`, `gk@grok-4.7` | `Refresh token has been revoked` | revoked before the owner re-logged; after the login the long-lived MCP server kept the old token | D1 |
| `muse-wonder-full` | OpenRouter: `not a valid model ID` | recommended list advertises a model no route serves | D3 |
| `gemini-4-argon`, `deepseek-v4-pro`, `deepseek-v4.1-flash`, `mimo-v2.6-pro`, `mimo-v2.6-flash`, `muse-spark-1.3` | Zen Go HTTP 401 `This API key has expired` | expired Zen Go key (account) + preflight probes only hop 1 + a rejected subscription key never reaches metered hops | D6, D7 |
| `ag@gemini-3.8-flash` | `Antigravity does not serve "gemini-3.8-flash"` | availability check skips the Antigravity id resolver; the account serves `gemini-3.8-flash-tiered` | D8 |
| `go@gemini-3.8-flash` | `No credentials configured for "go"` | `go@` was removed in v7.36.0; the message blames credentials for an unknown shortcut | D9 |

## claudish defects and changes

### D1 — a long-lived claudish process keeps a revoked Grok refresh token after `claudish login grok`

After the login rewrote `~/.claudish/grok-oauth.json` (23:27:20 local), a fresh process served
`gk@grok-4.7` (`--probe`: `Grok Build (subscription) · 1/1 live`, 1.35 s). The MCP server, started
earlier, kept answering `Grok token refresh failed: Refresh token has been revoked. Run claudish
login grok to sign in.` Expected: re-read `grok-oauth.json` when its mtime changed. Workaround:
restart the MCP server. Four `claudish --mcp` processes on this machine (started 13:25, 19:47, 21:51,
21:53) predate the 22:55 install of 13.2.0 and run whatever code they loaded.

### D2 — 12.1.2 resolved the explicit spec `meta@muse-wonder-full` to OllamaCloud

The MCP `preflight` (`probe: false`) answered provider `OllamaCloud`, wire id `oc@muse-wonder-full`.
A fresh branch build answers `explicit · Meta`. Probably a stale MCP process (D1's note); reproduce on
`main` before fixing.

### D3 — the recommended list advertises `muse-wonder-full`, which no route serves

`list_models` lists it under Flagship with `Access: muse-wonder-full`. A fresh branch build answers
`No route (catalog-empty)`, while `zengo@muse-wonder-full` plans on Zen Go. Check the models-index
record's connections, then whether the recommendation filter requires a serving route.

### D6 — `preflight` probes only the first hop, then says "Drop or replace"

`mcp-server.ts:1330` plans with `route(model)`, the same plan `--probe` prints, but probes only
`plan.primary` as an explicit `provider@model` spec (`mcp-server.ts:1366-1376`,
`probe-live.ts:211-227`): a one-hop request with no fallback. The fallback hops are only counted
(`:1390`). A model whose hop 1 fails lands in `failedModels` and gets "Drop or replace before
running" (`:1408-1412`) even when a later hop would serve. Expected: probe through the chain, or
each hop until one serves, and report which hop would serve.

### D7 — a rejected subscription key blocks every metered hop (owner rule change)

Owner rule (2026-10-21): an expired subscription key must not block the routing chain; the request
moves to the next provider. Today: a subscription's 401 is remapped to 400 with
`x-claudish-auth-verdict: terminal` (`composed-handler.ts:2631-2654`, via `isCredentialRejection`,
`auth-failure.ts:107-113`, which does not distinguish expired from wrong or revoked). `FallbackHandler`
then records `credentialStop`, skips every hop not in `SUBSCRIPTION_PROVIDERS`
(`fallback-handler.ts:68`), tries only later subscription hops (`:168-206`), and returns the
provider's login 400 when none serves (`:251-256`); `isRetryableError` refuses terminal verdicts
(`:382`, `:422`). This was deliberate (owner decisions 2026-10-16 and 2026-10-20) and is pinned by
`fallback-handler.subscription-only.test.ts`, `routing.md:406-411` and `adapters.md:611-635`.

Change: advance past a terminal subscription credential verdict onto the next hop, metered included,
with a loud stderr notice naming the provider, the next hop and "billed per token", and the login or
key-renewal hint. Keep the connection, recovery-hold and stream-failure verdicts ahead of it
(`fallback-handler.ts:134-153`, `:366-370`) so a network fault never walks onto metered billing
(CLAUDE.md's five-site invariant). Open question for the owner: all credential rejections, or only
an expired key (needs a new expiry predicate beside `isCredentialRejection`). Impact: every bare-name
chain with a subscription hop (Kimi, Grok Build, Zen Go, Token Plan, Devin, Antigravity, `cx@`).

Note: bare `gemini-4-argon` is not affected today. Its chain on the branch and on 13.2.0 is
`g@gemini-4-argon` → OpenRouter `google/gemini-4-argon` → `zen@gemini-4-argon`; the Zen Go candidate
`gemini-4-argon-contributor` is excluded for a bare name (`excluded-by-content-use`,
`route-candidates.ts:267-291`). The Zen-Go-first chain in the preflight above did not reproduce in a
fresh process, so it most likely came from a stale MCP server (D1's note).

### D8 — the availability check ignores Antigravity's id resolver

`ag@gemini-3.8-flash` → `explainExplicitSpec` (`routing-rules.ts:681`) → `providerServesModel`
(`model-availability.ts:113-134`) matches exactly against the account's dynamic models catalog, after
`expandSelection`, which returns the name unchanged because Antigravity has no resolver
(`model-resolvers/registry.ts:22-30`). The account serves `gemini-3.8-flash-tiered`, so the check says
not-served, while the transport would have sent `gemini-3.8-flash-tiered`
(`resolveAntigravityModelId`, `transport/antigravity.ts:164-192`). The same check filters bare-name
chains (`routing-rules.ts:1169`), so a bare `gemini-3.8-flash` loses its `ag@` subscription hop and
goes to the metered `g@` or OpenRouter. Fix: resolve with the transport's rule before matching (the
check and the transport must resolve identically). Test: `ag@gemini-3.8-flash` against a served list
of only `gemini-3.8-flash-tiered` returns `serves`.

The account's live Antigravity list today (Gemini, after exclusions): `gemini-2.5-flash`,
`gemini-2.5-flash-lite`, `gemini-2.5-flash-thinking`, `gemini-2.5-pro`, `gemini-3-flash`,
`gemini-3-flash-agent`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-extra-low`,
`gemini-3.5-flash-lite`, `gemini-3.5-flash-low`, `gemini-3.8-flash-tiered`. No `gemini-4*`, `3.6` or
`3.7`. Where the owner sees Gemini 4 (picker or config) is open: if a view built from the cloud models
catalog shows it under Antigravity, that view does not reflect entitlement. Latent risk: after a fetch
error `getServedAntigravityModels` keeps the last good list forever (`auth/antigravity-user.ts:435`).

### D9 — an unknown provider shortcut is reported as missing credentials

`go@` (Gemini Code Assist) was removed in v7.36.0 (`8258e1fb`); `~/.claudish/gemini-oauth.json` is a
leftover ignored on purpose (`auth/oauth-registry.ts:77-87`). `model-parser.ts:239` passes an unknown
shortcut through as explicit; the authority finds no registry entry (`authority.ts:150`), and routing
prints `No credentials configured for "go"` (`routing-rules.ts:706-710`, `:1458`), while `--probe`
already labels the tier `unregistered provider`. Expected: "unknown provider shortcut" with the valid
shortcuts, e.g. `ag@` for Gemini on a subscription, `google@` for the metered API.

## Test-suite defects found in the same session

### D4 — `routing-rules.test.ts` is not hermetic to `POE_API_KEY`

`ENV_KEYS_TO_CLEAR` (`routing-rules.test.ts:635-660`) omits it. With it set, two tests fail
(`claude-opus-4-7 with only OPENROUTER_API_KEY → primary openrouter` receives `poe`;
`… with no credentials → no-route` receives `ok`). Unset: 116 pass, 0 fail.

### D5 — tests run inside a claudish pane write their fake upstream errors into that pane's session log

The suite inherits the pane's session environment and appends to
`~/.claudish/sessions/<id>/upstream-errors.jsonl`, so the runner session's `get_diagnostics` listed
test doubles (`Sakana Fugu fugu-ultra`, `fixture-upstream-error`, `stub`). Test setup should scrub
the session variables.

## Account actions

| Action | Unblocks |
|---|---|
| Renew the OpenCode Zen Go key (OpenCode Console) | the six Zen Go models above |
| Restart the claudish MCP servers (until D1 is fixed) | Grok through MCP; a current routing build |
