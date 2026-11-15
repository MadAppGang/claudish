# The /model lineup

> A launch with listing entries (`--model devin@`, `--model 'or@*'`) puts the listed claudish
> providers' models into Claude Code's own `/model` list, and a pick there routes the next request
> through claudish with no restart. This file records what was measured in Claude Code, the rules
> as built, and why the user's `settings.json` is written at exit.
>
> Indexed in [`README.md`](./README.md). User guide: `docs/settings-reference.md` §5.2.2.

Code: `launcher/model-lineup.ts` (rows, the 6 s builder, the report, the `modelPicker` value),
`launcher/model-setting-restore.ts` (the restore ledger, the compare-and-set write, the crash
sweep), `launcher/model-setting-ledger-path.ts` (a leaf the per-launch stat loads),
`providers/model-parser.ts` (`parseListingEntry`, `parseModelFlags`), `launcher/claude-launch.ts`
(`decideModelListings`, `claudeRowsAsPicked`, the listing branch of `decideClaudeLaunch`),
`claude-runner.ts` (`startsOnClaudeSubscription`, `modelPickerSources`, the two temp-settings
writers, `RunHooks`), `model-vars-env.ts`, and the lineup branch of `proxy-server.ts`
(`resolveHandlerForRequest`, `GET /v1/models`). Paths are relative to `packages/cli/src/`.

## Words

- **model lineup**: the claudish rows one launch hands Claude Code as its `modelPicker` setting,
  plus the per-provider outcomes behind them (`ModelLineup`). Fixed for the session.
- **listing entry**: a `--model` value that is a provider shortcut, `@`, and no model (`devin@`),
  or `*` after the `@` (`or@*`). It names a provider to list; it never starts the session.
- A launch **has a lineup** when it has at least one listing entry. Full specs alone never make
  one: any number of `--model <spec>` flags without a listing entry keep the old last-wins path.

## Claude Code's /model does not read GET /v1/models

The first premise was that `/model` lists whatever the proxy's `GET /v1/models` returns. It does
not. From the installed Claude Code 2.1.325 bundle and its docs: Claude Code asks a gateway's
`/v1/models` only under `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, once at startup, unawaited,
with a 3 s timeout; it drops every id that does not match `/(claude|anthropic)/i`, and caches the
answer keyed on the exact `ANTHROPIC_BASE_URL`, which for claudish is a new port each launch.

What carries many foreign ids is the `modelPicker` setting (2.1.243+): `{options: [{model, label?,
description?, behavesAs?}], replaceBuiltInOptions?}`, honoured from managed settings,
`--settings` and user settings. The highest source wins outright; nothing merges. claudish hands
it over in its one `--settings` temp file.

`GET /v1/models` still returns the lineup rows with `display_name` on a lineup launch, for other
clients of the proxy; `serve`'s slot ids win over it, and every other launch is unchanged.

## Measurements

Proxy auth, 2026-11-14: Claude Code 2.1.325, a mock gateway, an empty `CLAUDE_CONFIG_DIR`,
`ANTHROPIC_AUTH_TOKEN=mock-token`.

| Question | Observed |
|---|---|
| `--settings` `modelPicker` with foreign ids on a custom base URL | Honoured. 5 rows shown after the 5 built-in rows, in file order, with label and description |
| `model` string after a pick | Verbatim: `or@moonshotai/kimi-k3`, `ollama@llama3.2:3` (with `@`, `/`, `:`) |
| Validation probe on a pick | None. Only the real prompt (`max_tokens: 32000`) was sent |
| Switch without restart | Works. Second switch reached the mock with the new id in the same process |
| Enter or digit on a row | Sets the model AND writes `"model": "<id>"` to the user `settings.json` ("saved as your default for new sessions") |
| `s` on a row | Session only; `settings.json` unchanged. Prompts "conversation is cached ... switch?" first |
| Background request | Carries the picked id when `ANTHROPIC_SMALL_FAST_MODEL` is unset (two POSTs per prompt) |
| Unrecognized id request shape | `thinking: adaptive`, `output_config.effort: high`, `context_management` present, effort and context-management betas |
| 300 rows | All loaded; 10 visible, "… +295 models"; PageDown moves 10 rows; typing does NOT filter |
| User `modelPicker` + `--settings` `modelPicker` | `--settings` wins; the user's row is gone (no merge) |
| `GET /v1/models` | Not called (discovery env unset), as expected |

### Gate M0: the kept-login launch

The table above was measured under proxy auth only. A listing-only launch keeps the user's own
Claude login instead, so the same path was run on the built binary before the Claude-row routing
and the restore were added: 2026-11-15, claudish at `e12d0592`, Claude Code 2.1.325, the user's
own HOME and `CLAUDE_CONFIG_DIR`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` unset (`env -u`),
header "Opus 5.5 with medium effort · Claude Ultra", Ollama 0.40.16 serving `qwen2.5:0.5b`,
`--model ollama@`. Result: PASS, no divergence from the proxy-auth measurement.

| # | Check | Result |
|---|---|---|
| 1 | `/model` shows Claude's rows, then the Ollama row | PASS: row 6 `qwen2.5:0.5b  Ollama (local) · local` |
| 2 | `s` pick + prompt: the spec reaches the proxy as sent, routed to Ollama | PASS: `model=ollama@qwen2.5:0.5b`, `fp_ollama`; the background title request also carries the pick |
| 3 | Claude row pick + prompt: native passthrough, login only | PASS: `x-api-key: (not set)`, OAuth bearer, `oauth-2025-04-20`, the subscription usage line |
| 4 | Enter pick, quit: the user `settings.json` `model` is the spec | PASS: `"model": "claude-opus-5-5"` became `"model": "ollama@qwen2.5:0.5b"` |
| 5 | Org policy (`availableModels`, managed `modelPicker`) filters rows | NOT TESTED: no managed settings, and no layer set either key |

Observations from the same run:

- The first run listed nothing: Ollama was not in the user's `localProviders`, and claudish said
  so (`/model: Ollama (local) not listed — Provider "ollama" is a LOCAL server and is not enabled
  ...`) and started on Claude's rows. A local provider must be enabled to be listed.
- The launch report prints before Claude Code takes the screen and stays in the scrollback.
- Claude Code shows its own "Switch model?" dialog (prompt cache) on a switch after the first turn;
  text typed while it is open is dropped.
- After a Claude row, the exit summary names only the foreign model's tokens: the native handler
  writes no token file.

Re-measure all of the above when Claude Code changes how `/model` reads `modelPicker`, how it
saves a pick, or the precedence of `--settings` over user settings.

## Rules as built

| # | Rule |
|---|---|
| R1 Start model | The LAST full spec in argv order starts the session. Any argv `--model` replaces `CLAUDISH_MODEL`/`ANTHROPIC_MODEL` as the source. On a lineup launch every earlier full spec is a pinned row of its provider, and the start spec's provider is listed with the start spec as its first row (`--model devin@swe-1.7 --model ag@` lists Devin too). With no listing entry, `cli.ts`'s loop decides alone (each `--model` overwrites `config.model` and clears an earlier chain) and `parseModelFlags` is never called, so no launch that worked before changes. |
| R1a Pinned rows | A pinned spec must be an explicit claudish provider spec. Refused in `parseModelFlags`: a Claude model (`native-anthropic`), a bare name, an unknown vendor/model, a raw URL, each naming the value and the form to use. The START spec may be a bare Claude or bare foreign name: it starts the session and lists nothing. |
| R1b Dedup | Rows are keyed by `(provider, model, mode, speed, concurrency)` after `parseModelSpec`, so `or@x` and `openrouter@x` are one row. A pinned spec keeps its string as typed and takes the matching row's label. |
| R2 Chains | On a lineup launch a routing chain (`parseModelChain(v).length > 1`, so `oai@gpt-6-sol+pro` is one spec) is refused. Without a listing entry chains keep the old handling. |
| R3 Listing entries | `x@` / `x@*` must name a known claudish provider (`isKnownProviderName`), checked in `decideModelListings` AFTER `ensureEndpointsRegistered()`, so custom and predefined endpoints count. `claude@` is refused (Claude Code's own rows); `custom-url@` is refused (the raw-URL sentinel passes `isKnownProviderName` but has no definition or model list). `anthropic@` lists metered rows. Provider order: the start spec's provider, then listing entries in flag order, then providers only pinned specs name; `*` wins for one provider. |
| R4 Claude start | Listing entries, no full spec, no tier, no `--monitor` → `startsOnClaudeSubscription`, OR-ed into `hasNativeAnthropicMapping`, so key hiding, `shouldPreserveNativeAuth`, the native-auth notice, `launchSigningFor` (login-only unless the API-billing opt-in) and `childAuthControl` all see it. `subscriptionCause` does not read that predicate and carries its own clause: `because --model devin@ names no start model, so the session starts on Claude's default model`. A `claude@<id>` start with listings runs as the bare `<id>` with `claudeSubscriptionPin`, as a pane child does, never as a monitor session. |
| R5 Foreign start | Keeps proxy auth, the host marker and the placeholder. A Claude-named request keeps the old rule (role mapping, else the start model); the report says `/model: this session starts on a foreign model, so a Claude row runs that start model`. Refused with a lineup: `--monitor`, and an `anthropic@<id>` start (both forward every request to Anthropic). |
| R6 Routing a pick | A request whose `model` exactly equals a lineup row's spec is routed as sent. So is one of the user's own `modelPicker` rows (R14b) whose `model` is an explicit claudish model spec on a known provider (`routedUserRows`, carried as `config.modelLineup.userRows`); a Claude name, a `claude@` spec, a raw URL, a legacy prefix or an unknown `x@` keeps the ordinary steps. The check skips the `serve` slot map, the role-mapping substring match (which would catch `or@anthropic/claude-opus-5` as `opus`) and the `--model` fallback. `proxy-server.ts` gets the rows as data and never imports `model-lineup.ts`. |
| R7 Gateway rows | `gateway` tier: `x@` lists the recommended models it serves, `x@*` every chat model it serves. Every other tier lists every chat model it serves. Rows come from the stored dynamic models catalog (`readAccountModelsList`, null when expired; a live refresh runs unawaited for the next launch), else `liveOrStoredModelsCatalog(provider, "launch-lineup")`, else the catalog's served-by index after `ensureCatalogReady`, read through `readAllModelsCache` so an offline launch lists the bundled recommended list's rows (source `bundled`); the readiness wait itself reads the disk only. A discovered row matches a recommended model by the wire id `resolveProviderExternalId` gives, never by canonical id. Recommendations: `bundledRecommendedModelsDoc()` when `bundledListActive()`, else one `getRecommendedModels()` raced against the deadline, re-checking `bundledListActive()` after a throw or null. No answer → pinned rows only and `recommended list unavailable; 'x@*' lists every model it serves`. Custom endpoints are `gateway`: declared `models` when any (either scope), else `x@*` lists discovered models, else `declare models for <name>, or use '<name>@*'`, answered with no `/models` request. |
| R8 Row filter | Chat models only (the picker's `outcomeFromModelsCatalog`); `supportsTools === false` dropped. A provider that is not ready lists nothing, pinned rows included. A discovery outcome without rows lists nothing unless pinned specs exist: the catalog never stands in for an account's entitlement. |
| R9 Status line | No new mechanism: each handler's `TokenTracker` writes model, provider and window to the one token file. Limit: the native handler writes none, so after a Claude row the status line keeps the last foreign model. |
| R10 Context window | Sized once at spawn. `sessionWindow(env, computed)`: the user's `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, else `computeMainThreadContextWindow` above 0, else the 200K Claude Code assumes for an unknown id. Computed once in `index.ts` (`config.mainThreadWindow`) and reused by the runner. The report counts smaller rows and names the smallest. |
| R11 Small fast model | Not set on a launch with listing entries (keyed on `modelListings`, so print mode too): background requests follow the pick (measured). A user's own `ANTHROPIC_SMALL_FAST_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` still wins and the report names it. |
| R12 `behavesAs` | Never set on claudish's rows: the catalog publishes no basis for it, so choosing one would be hardcoded model data. A user's own row keeps the `behavesAs` it was written with (R14b). `replaceBuiltInOptions` is never carried (R14b). |
| R13 `GET /v1/models` | With a lineup and no slot ids: exactly the rows R6 routes as sent (the lineup rows, then the user's claudish-spec rows), `display_name` through `redactForClient` per request (a signing value leased after startup is covered). |
| R14 Restore | See [Restore at exit](#restore-at-exit). |
| R14b User `modelPicker` | `modelPickerSources` reads every layer below CLI args through `claudeSettingsLayers` (`--setting-sources` honoured) plus passthrough `--settings`; the highest non-managed layer that sets `modelPicker` supplies rows that come first, each passed through with every field it was written with (Claude Code merges nothing below claudish's layer, so a dropped `behavesAs` would be gone for the session). One value, computed in `index.ts` (`reportModelLineup`) and carried as `config.modelLineup.picker`, is set last by BOTH temp-file writers (`buildClaudishSettingsOverlay` and the `--settings` merge). On a lineup launch every passthrough `--settings` occurrence (both spellings) is merged in argv order and spliced out, so Claude Code gets one `--settings`; an unreadable one refuses the launch, naming the occurrence and never the value. A user `replaceBuiltInOptions: true` is overridden with one notice; a managed `modelPicker` or any `availableModels` gets a notice naming the file. |
| R15 Print mode | Listing entries accepted, no list fetched, no ledger touched, a debug line. The refusals (R17, unreadable `--settings`) still run. |
| R16 Time limit | `LINEUP_WAIT_MS` = 6 000 for the whole lineup, providers and the recommended list in parallel, overlapping advisor-check, stdin-read, find-port and the resume picker. 6 s covers the 5 000 ms discovery timeout plus row building; a 1Password unlock (up to 30 s) is not waited for. A provider pending at the deadline is `not-listed` naming its stage (credential, list, recommended); only the credential stage mentions 1Password. A late list is stored for the next launch, never added. |
| R17 Settings base URL | A lineup launch whose child keeps the login (`!isProxyAuthMode`: a Claude start with or without the API-billing opt-in, or classifier passthrough with a resolvable login) is REFUSED when a settings layer sets `env.ANTHROPIC_BASE_URL`. Checked in `decideModelListings`, before the picker, key validation, catalog warm and any fetch. A proxy-auth launch is not refused: the host marker stops a settings `env` block from moving its base URL ([`settings-env.md`](settings-env.md)). Refuse, not drop the lineup: with the lineup dropped the session would be plain Claude Code on the user's own gateway, ignoring the request. |
| R18 Inherited model vars | Where claudish sets `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` in a child it also writes `CLAUDISH_SET_MODEL_VARS` (name → value). Where it sets neither itself, `scrubInheritedModelVars` removes one whose value matches that record, or, only when the child keeps the login (`childKeepsLogin` = `!isProxyAuthMode` and not the Claude API launch, whose child holds only the placeholder), one whose value is an explicit claudish provider spec. On proxy auth a user's own `or@cheap` survives: the proxy routes it. The scrub runs once before the monitor/advisor branch; the MCP print child scrubs with `keepsLogin: true`. `parseArgs` reads the same record first: an inherited `ANTHROPIC_MODEL` still equal to it is not taken as the launch model (`isModelVarSetByClaudish`), so a nested launch with no `--model` does not start on the parent's spec. The report names survivors and removed names (never values). |
| R19 Claude rows as picked | `claudeRowsAsPicked(config)`: listing entries, `!isProxyAuthMode` (so the API-billing opt-in counts), and a Claude start model or none. A Claude-named request no role mapping caught then skips the `--model` fallback and goes to the native passthrough as requested, with the launch's signing. A foreign start keeps R5. |
| R20 Listings + tiers, no full spec | The tiers decide the posture as on any profile launch. On proxy auth the report says `/model: Claude rows run your mapped tiers; an unmapped Claude row is not served on this launch`. |
| R21 Token file totals | Session totals (`total_cost`, `billed_input_tokens`, `output_tokens`, `total_tokens`, `tool_calls`, earliest `started_at`) are summed across every tracker writing one token file, each adding its deltas since its own last write, so switching back never double-counts. Per-request fields come from the writing tracker. `writesTokenFile === false` (advisor) adds nothing. Limit: the summary's cost split uses the last writer's rates. |

Row strings (`label`, `description`) are upstream text: `redactSecrets` first, then truncated to 60
and 100 characters with "…", and a cut never lands inside a redaction marker. A local provider's
price reads `local`, a subscription's `SUB`.

## Restore at exit

Enter in `/model` writes `model` to the user `settings.json` (measured), and nothing claudish
hands Claude Code changes where that write goes: a `model` key in the `--settings` overlay does not
stop it, and a private `CLAUDE_CONFIG_DIR` would move the login, history and every user setting
with it. A listed spec left there makes plain `claude` start on a model only claudish can route. So
the restore needs one write, and that write is made conditional.

- **Ledger.** `~/.claudish/model-setting-restore.json` (0600, directory 0700), under `withFileLock`
  (2 s) or, on the signal-deadline path, `acquireFileLockSync` (250 ms). Keyed by
  `canonicalSettingsPath`: `realpathSync.native` of the file when it exists, else of its longest
  existing ancestor plus the rest, so a symlinked `CLAUDE_CONFIG_DIR`, `..` and a case variant on a
  case-insensitive volume are one key. The settings file is `userSettingsFile(CLAUDE_CONFIG_DIR,
  HOME || homedir(), cwd)`: the child resolves `~` from `HOME`. An entry holds the original value
  (or its absence), the union of listed specs, and one session row (uuid) per running launch. The
  file is deleted with its last entry, so a machine with nothing pending only stats a missing file
  through the leaf path module. A settings file unreadable at launch makes the watch inert.
- **Last one out restores.** The exit removes its own row; if another session is live it writes
  nothing. Otherwise `restoreDecision`: the file's `model` must still equal one of the listed
  specs, else it is left alone.
- **Compare-and-set** (`restoreSettingsFile`). Read bytes and five stat fields; write a temp file
  beside the target with the same mode, indentation (the first line's after `{`) and trailing
  newline kept; immediately before `rename`, check the key still resolves to the same
  target, the stat matches and the bytes are identical. Any difference sends the decision round
  again from the new content, up to 3 rounds, then the entry waits for the next sweep. A symlinked
  `settings.json` stays a symlink. Residual window, accepted: POSIX has no conditional rename, so a
  write landing between the last check and `rename(2)` (sub-millisecond) is lost, and a writer
  holding an older copy that writes after the rename undoes the restore.
- **Normalized rewrite.** The temp file is `JSON.stringify` of the parsed file with `model` put
  back or removed, so "only `model` changed" holds for the parsed value, not for the bytes: string
  escapes are rewritten (`"é"` becomes `"é"`), numbers lose their spelling (`1.0` becomes
  `1`), and mixed indentation becomes the first line's. Every other key keeps its value and its
  place, except that `JSON.parse` moves integer-like keys first.
- **A newer default can be overwritten.** `original` is recorded once, when the first session for
  the settings file registers. In this sequence the user's newer default is lost with no message:
  while a lineup session runs, the user sets a new default in another `claude` (the file now holds
  a non-listed value), then presses Enter on a listed spec in the lineup session (the file holds a
  listed spec again); at exit `restoreDecision` sees a listed spec and writes back the launch-time
  `original`, not the value set in between. Documented, not fixed: noticing it would need the
  sweep or the exit to have seen the intermediate value, and a pick between two stats would still
  hide it.
- **Liveness.** A session is live while its launcher OR its Claude Code child is: Claude Code is
  spawned with no parent-death link and SIGKILL is not forwarded, so it outlives a killed launcher
  and can still save a pick. Each mark is a pid plus a start time measured in-process (launcher:
  `Date.now() - process.uptime()`, child: `Date.now()` at spawn), compared with the `ps` row's
  start through `process-identity.ts`'s `startedAt` (2 s tolerance; `etime` has whole-second
  resolution), so a reused pid is not mistaken for the session. A child never recorded (launcher
  killed between `spawn` and the record) is looked for by the `--settings <temp path>` recorded
  before spawn. No process table: live, until 14 days after the session started.
- **Exit paths.** Normal exit, an exception and a signal within budget all await `watch.end()` in
  the `finally` after `proxy.shutdown()`. Past the 4.5 s signal budget `RunHooks.onDeadline` runs
  `endSync()` first; `end()` and `endSync()` share one latch. A crash or SIGKILL leaves the entry
  for the sweep.
- **Sweep.** Every interactive launch stats the ledger; when present it drops ended sessions,
  restores each entry no live session holds, and unlinks orphaned compare-and-set temp files of
  dead pids. It runs before the new watch registers and before the diag output takes stderr, so
  its lines reach the user and the new Claude Code reads the restored value. An unparsable or
  unwritable file is reported once with the manual remedy, retried only after its stat changes,
  and dropped after 14 days.

## Known limits

- `cx@` rows come from the cloud models catalog's `openai` vendor list, not from the Codex
  account's own list, so a `cx@` row can fail on its first request. The user docs say so.
- The native handler writes no token file (R9).
- 300+ rows with `'x@*'`: PageDown works, typing does not filter (measured).
- The lineup is fixed for the session; a bundled-list source prints a partial-list line because
  the bundled-cache rebuild rule cannot apply to a list Claude Code already holds.
