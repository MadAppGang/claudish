# Offline routing from the bundled recommended list: live validation

Measured 2026-11-10 on claudish built from source (`packages/cli/dist/index.js`, `bun run build:cli`)
just before 14.20.0. The binary held the bundled recommended list of generation
`g-20261109161553532-980a49e4` (27 entries). Rationale and rules: `ai-docs/architecture/routing.md`
and `ai-docs/architecture/routing-rulebook.md` (RB-16 to RB-21).

## The problem this measures

With no cloud models catalog on disk and the backend unreachable, every bare name that no dynamic
models catalog claimed got an empty routing chain. New users and offline users were blocked.
Baseline on published 14.18.0, empty HOME, unreachable backend, a Codex login in the Keychain:

```
claudish --model gpt-6.1-sol -p "Reply with exactly the word OK and nothing else."
Error: OpenAI API Key is required for model "gpt-6.1-sol"     (exit 1 after 0.2 s)
```

## Setup

Each check ran in a fresh HOME that held only:

- a copy of `~/.claudish/config.json` (credential settings and account lists, no catalog data);
- a link `Library/Keychains` → the user's real `~/Library/Keychains`.

The backend was `CLAUDISH_CATALOG_URL=http://127.0.0.1:9` (a closed port). Check 6 used
`http://10.255.255.1/` (a black hole, so the request times out instead of being refused). Every
run started with `catalog files: 0`. The user's real keys and subscriptions were used.

Sandbox trap: without the Keychain link, macOS drops the login keychain from the search list
(`HOME=<sandbox> security list-keychains` shows only `System.keychain`). Every Keychain credential
is then unreadable, and Codex answers 401 "Every Codex account needs a browser login". That is a
property of the sandbox, not of claudish. Any HOME-sandboxed live test on macOS needs the link.

The harness (zsh):

```zsh
H=<sandbox>/home-$name
rm -rf "$H"; mkdir -p "$H/.claudish" "$H/Library"
cp ~/.claudish/config.json "$H/.claudish/config.json"
ln -sfn ~/Library/Keychains "$H/Library/Keychains"
env HOME="$H" CLAUDISH_CATALOG_URL=${CATALOG_URL:-http://127.0.0.1:9} bun packages/cli/dist/index.js "$@"
```

## Results

| # | Action | Observed | Verdict |
|---|---|---|---|
| 1 | `--probe gpt-6.1-sol` | Route `bundled recommended list (g-20261109161553532-980a49e4, fetched 2026-11-10)`; `cx@` subscription ✓ → `oai@` native ✓ → OpenRouter fallback ✓, wire id `openai/gpt-6.1-sol` read from OpenRouter's models list | pass |
| 1 | `--probe grok-4.7` | bundled list; `zengo@` → `x-ai@` native ✓ → OpenRouter ✓; Grok Build has no credential | pass |
| 1 | `--probe gemini-4-argon` | bundled list; `ag@` Antigravity ✓ → `zengo@` → `g@` native 429 (the user's Gemini key over quota) → OpenRouter ✓ | pass |
| 1 | `--probe kimi-k3.1-pro` | bundled list; `kc@` ✓ → `zengo@` → `kimi@` native ✓ → OpenRouter ✓ | pass |
| 2 | `CLAUDISH_DEFAULT_PROVIDER=openrouter` | OpenRouter appears only as the last hop | pass |
| 2 | `CLAUDISH_DEFAULT_PROVIDER=` (control) | no gateway hop | pass |
| 3 | `--probe kimi-k3` (outside the list) | route `no cloud models catalog · not in the bundled recommended list`; one account-listed hop `zengo@kimi-k3` (RB-20) | pass, see note 1 |
| 4 | `--model grok-4.7 -p ... -d` | `OK`, exit 0 after 7.2 s; log `[catalog] reading the bundled recommended list (g-20261109161553532-980a49e4)`, `Handler: provider=opencode-zen-go`, `[Zen Go] Response status: 200` on `responses` | pass |
| 5 | catalog files copied into HOME, `--probe gpt-6.1-sol` | `Route catalog · subscription first`, the full catalog chain with gateway connections; the bundled list is not read | pass |
| 6 | backend `http://10.255.255.1/`, `--model gpt-6.1-sol -p ...` | `OK`, exit 0 after 17.3 s (baseline: exit 1 after 0.2 s); log names the bundled list, `Handler: provider=openai-codex` | pass |
| 7 | `--model mistral-large-3 -p ...` (outside the list) | exit 1 after 2.6 s: `API Error: 400 [Route] No cloud models catalog could be read, and "mistral-large-3" is not in the bundled recommended list (g-20261109161553532-980a49e4, fetched 2026-11-10). Run claudish --models-refresh once online, or name the provider explicitly (provider@model).` No vendor-key message | pass |
| 7 | `--model kimi-k3 -p ...` (outside the list, account-listed) | `OK`, exit 0 after 4.9 s, through the account-listed `zengo@` hop | pass |

Note 1: the criterion said "empty chain". That was too strict. RB-20 keeps account-listed
candidates when a name is outside the list, and OpenCode Go lists `kimi-k3` in its own dynamic
models catalog. `main` with a disk catalog builds the same hop.

Note 2: check 6 took 17.3 s, against 7.2 s for check 4. Not measured, inferred: the black-hole
address makes the catalog refresh wait until its timeout before the backend counts as
unreachable, while a closed port is refused at once.

## Finding: the probe refused a routed hop that real traffic tries in turn

First run: offline, `--probe` showed every OpenCode Zen Go hop as `error 400` "no cloud models
catalog; the bundled recommended list has no opencode-zen-go connection for <model>".

Cause: `probe-live.ts` sent each hop to the proxy as its own explicit spec (`zengo@<model>`). An
explicit spec carries no hop origin, so `buildWireHandler` (`wire-handler.ts`) refused it under
RB-2. A real request on the bare name builds the same hop as routed (`proxy-server.ts`) and tries
the provider's APIs in turn: check 4 got 200 from `opencode-zen-go`. Only the probe display was
wrong.

Fix: `fix(probe): probe a routed hop as routed when no catalog exists`. The probe marks a routed
hop with the header `x-claudish-hop-origin: routed`. Only a proxy started for probing honours it.
Re-run on the rebuilt binary:

| Probe | OpenCode Zen Go hop |
|---|---|
| `--probe gemini-4-argon` | `zengo@gemini-4-argon` ✓ 3.58 s |
| `--probe grok-4.7` | `zengo@grok-4.7` ✓ 1.54 s |
| `--probe zengo@grok-4.7` (explicit, control) | still `error 400`, `Route explicit` (RB-2 unchanged) |

## Observations outside claudish

- The user's Gemini API key answered 429 (quota) on `g@gemini-4-argon`.
- An OpenCode Zen gateway account was out of funds during the run.

Neither is a claudish defect, and neither changes a verdict.

## Verdict

All seven checks pass on the built binary with no cloud models catalog and an unreachable backend.
The one finding (the probe display) was fixed and re-measured live.
