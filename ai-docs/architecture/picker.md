# The interactive model picker

What bare `claudish` shows when no model was given: an OpenTUI dialog, in
`packages/cli/src/picker/`, launched by `selectModel` in `model-selector.ts`. This file records
why it has the shape it has. Colour and chip construction live in [`theming.md`](theming.md);
the provider list's derivation lives in [`routing.md`](routing.md).

## It is a dialog, not a dashboard

The first OpenTUI build was a full-screen two-pane dashboard: a provider rail beside a model
list, gradient context and price meters on every row, an aggregate panel. The owner rejected
it — *"no no no this is super unclear what is happening, that should be dialog style"* — and a
blind three-model panel agreed the FORM was the defect.

The cause is measurable. The house TUI guidance requires over half of a frame to be graphics
rows. On a screen whose content is a list, a row counts only if it carries a bar, so the gate
did not permit a meter per row, it required one. On the rejected capture 19 of 32 visible rows
read `1M`, and their meters were indistinguishable. **That density gate is for monitoring
surfaces a user lives in. A picker is a one-shot question; do not apply the gate to it.**

Three structural rules follow, and each removes a class of defect:

1. **Inline** — `screenMode: "main-screen"`, never the alternate screen. The shell prompt and
   the claudish banner stay above the dialog. (`@opentui/core@0.1.107` renamed
   `useAlternateScreen` to `screenMode`; the old key is silently ignored.)
2. **One list, one cursor.** Two panes meant two cursors and only a border colour to say which
   one the keys drove — the literal cause of "unclear". A test counts exactly one `▶`.
3. **No per-row graphics.** Plain aligned columns; colour carries meaning only. The one meter
   left is the credential sweep's `done/total`, which is real progress over countable work.

## The provider list is the default screen, and nothing is prefetched

An intermediate build opened on a flat cross-provider list and warmed the cloud models catalog
plus every credentialled provider's dynamic models catalog to fill it. The owner's
corrections: *"why we prefetching? we should not, as we show on demand"* and *"we should show a
list of providers by default and only when we go inside we load"*.

So startup does ONE thing — probe credentials, streaming each answer into the provider list as
it settles. `⏎` on a provider fetches that provider's models. `a` opens the cross-provider list
from one cached catalog fetch.

Opening the picker also reads the stored dynamic models catalogs from disk, with no network
call. As each credential probe settles present for a provider that keeps a stored list, the
picker starts a background refresh of that list (`refreshAccountModelsList`, trigger
`picker-open`, skipped for a list under 5 minutes old). No render waits for one: a list that
lands is shown through `onModelsListsChanged`, and the provider list stays the default screen.

Measured when the prefetch was removed: time to first screen
3915 ms → 1436 ms (commit `ff00f56`).

Only providers with a credential are listed. `k` reveals the rest, each saying why it is hidden
(`needs X_API_KEY`, or `not enabled in config` for a local provider, which is opt-in).

## An empty list must say WHY it is empty

The founding complaint: when discovery failed, the old picker showed *"fewer model names, like
the provider does not have any models"*. `buildDiscoveredModelRows` returned `[]` for five
different states, and the caller fell back to the catalog silently for all of them.

Two layers now carry the distinction instead of destroying it:

- **Discovery** returns a `ModelsCatalogOutcome` (`providers/model-discovery.ts`) —
  `served` (non-empty by construction), `failed` with one of seven failure kinds, or
  `unsupported` (nothing attempted, nothing wrong). `discoverProviderModelsCatalog` never
  rejects: every await is inside a `try`, because a live renderer has no stderr to absorb a
  rejection, and a stuck promise leaves a spinner running forever.
- **The registered fetchers** (Devin, Antigravity, Ollama) return a `FetcherResult`, not a bare
  array. As arrays they could only ever say "empty", so a stopped Ollama daemon and a
  logged-out Antigravity account both read as "this provider serves nothing".

The picker maps the outcome to a `PickerDiscoveryOutcome` and renders the non-`rows` variants
through `DiscoveryNotice.tsx` in three tiers: error (red), notice (warn), and nothing at all
for `unsupported` — about 25 providers declare no discovery, and a panel on the majority case
teaches users to ignore the panel. A fallback list says so three ways that derive from one
value: the dialog title (`live model list unavailable`), a per-row `catalog` mark, and a
sentence stating the rows *do not confirm access, so launching one may still fail*.

## The cross-provider list never leaves the machine

The flat list asks about every provider at once. Asking the network per provider was measured
at 10 018 ms for 22 concurrent queries, every one aborting on its shared timeout and returning
zero rows — "this provider has no models", manufactured by the fix for it (commit `43218b4`).
`CatalogClient.servedByVendor` answers from the local slim-catalog cache instead, using the
same route-binding rule as `modelsByVendor`'s own served-by filter, so the two cannot disagree.

## Claude has two rows: the Claude subscription and the Claude API

The provider list starts with two Claude rows (`PICKER_ORDER`, `model-selector.ts`): **Claude
subscription** (`native-anthropic`, Claude Code's own login) and **Claude API** (`anthropic`,
metered on the user's Anthropic API key). Each is an ordinary provider row, so every model row
carries its route in its spec, `claude@<wire id>` or `anthropic@<wire id>`
(`buildExplicitModelSpec`), in the provider view and in the `all models` view alike. A caller that
receives only the string keeps the choice: the launch, `claudish init`, `profile add` and
`profile edit`. The two rows of one model have different specs, so they never share a React key.

What picking a row starts is decided by the launch, not the picker (`launcher/claude-launch.ts`):
`--model claude@<id>` is a monitor session on Claude Code's own login, and `--model
anthropic@<id>` a monitor session that claudish's proxy signs with the key
([settings-env.md](settings-env.md)). A profile tier is a role mapping, not a launch: `claude@<id>`
in a tier is the native passthrough for that role, and `anthropic@<id>` a proxied hop claudish
signs, metered.

**One readiness rule for every picker.** `pickerProviderReady` (`providers/picker-readiness.ts`)
answers for the OpenTUI picker's credential sweep (`PickerDataSource.probeCredentials`) and for
`getProviderChoices`, which the classic picker (`CLAUDISH_PICKER=classic`) and the profile picker
use. Nothing else enumerates provider readiness for a picker.

- Claude subscription: `hasClaudeCodeLogin()` (`auth/claude-code-login.ts`): a real
  `CLAUDE_CODE_OAUTH_TOKEN`, `~/.claude/.credentials.json`, or Claude Code's macOS Keychain item,
  probed by attributes only, so no secret is read and no access dialog opens. An Anthropic API key
  never makes this row ready, because the Claude subscription is never signed with one, and the
  credential authority is not asked about `native-anthropic`.
- Claude API and every other provider: the credential authority's `isAvailable`. For `anthropic`
  that is a key present in the environment, the config, the Keychain (by enumeration, never read:
  [keychain.md](keychain.md)) or 1Password. When the focused provider is missing and declares
  `vaultKeyReadAtUse`, the hint row names where claudish looked, `looked in: env, config,
  Keychain, 1Password` (`lookedInHint`, `picker/ModelPicker.tsx`, from `keySourcesSearched`). A
  login-backed provider gets no such line: its missing state is not about those stores.

**One billing label for every picker.** `displayBillingOf` (`model-selector.ts`) answers `sub` for
a `SUBSCRIPTION_PROVIDERS` member and for `native-anthropic`. The OpenTUI row prints `SUB` from it
(`billingModeOf`, `priceLabel` in `picker/rows.tsx`), and so does `resolveProviderDisplayPrice` for
the classic and profile pickers. It is display only: `calculateCost` never asks it.
`native-anthropic` stays out of `SUBSCRIPTION_PROVIDERS` because the advisor prices its Claude
API-key arm through `calculateCost("native-anthropic", …)`, which must stay metered.

**Each row lists its own connections.** The Claude subscription row lists the mapped catalog
connections bound to `anthropic/claude-code-subscription`, the Claude API row those bound to
`anthropic/direct-api`. `servedByVendor` and `filterToServedByProvider` (`providers/model-catalog.ts`)
count only `routeStatus === "mapped"` entries, the thesaurus' definition of a connection; an
unmapped `aggregators[]` entry is not one.

## Never open without a terminal

`cli.ts` sets `interactive` whenever no prompt was given, which includes `claudish < /dev/null`,
a CI runner and a detached run. Measured before the fix: a piped bare `claudish` wrote 195
bytes of menu and a cursor-hide escape into stdout, then blocked until killed at 45 s.

`tui/runtime/should-open-picker.ts` holds the gate as two pure predicates that are exact
complements over runs that need a model: `shouldOpenPicker` and `requiresExplicitModel`. No
input can skip the picker silently AND keep the error quiet. Every reason a run needs no model
(`--monitor`, a native `--advisor` session, `--model`, profile tiers) lives inside the shared
`noModelConfigured`, never as an extra condition at one call site — a term on one gate only is
how the two drift apart. The test enumerates the full 32-cell grid.

## Testing a TUI here

- **A `<span>` outside a `<text>` renders an error page while the process exits 0.** Only a
  screenshot catches it, so visual changes are verified by capture, not by exit code.
- Captures run with `CLAUDISH_DISABLE_OP=1 CLAUDISH_DISABLE_KEYCHAIN=1` so they cannot raise a
  1Password or Keychain prompt on the desktop. That leaves few providers with credentials.
- `CLAUDISH_PICKER_FIXTURE=<name>` swaps in `picker/fixtures/fixture-source.ts` to force the
  states a live provider cannot be made to produce (a held credential sweep, a discovery that
  never lands, a timeout). It forges the OUTCOME, never the data, and is reached only through a
  dynamic import, so `bun build --compile` never bundles it.
- `picker/no-terminal-writes.test.ts` forbids `process.stdout.write`, `process.stderr.write`
  and `console.*` inside `picker/` and `tui/`. A write behind a live renderer leaves ghost
  cells OpenTUI cannot invalidate, silently — and `setStderrQuiet(true)` is not a defence, as
  it gates only `logStderr`.
- `picker/import-direction.test.ts` keeps OpenTUI out of processes whose stdout is a
  protocol: `tui/` never imports `picker/`, and `model-selector.ts` reaches `picker/` only
  through a dynamic `await import()`.
- `C.*` and `tokens.*` are read at render time; see `theming.md` for why a module-level
  snapshot takes the dark palette on a light terminal.

## The compiled binary

OpenTUI is pinned at `0.1.107` because `release.yml` builds with `bun build --compile`, which
requires it. A locally compiled binary on Apple Silicon is killed on launch (`Killed: 9`, exit
137) until it is ad-hoc signed — `codesign --force --deep --sign - <binary>` — the same step
`release.yml` runs. That is macOS, not claudish. Verified 2026-09-23: the signed compiled
binary draws the picker.
