# `claudish serve` — Claude Desktop custom-model gateway

**Status:** implemented, unreleased (on branch `worktree-models-list-serve`).
**Audience:** the next developer picking this up — the `claude-desktop-profiles`
macOS app author, and anyone touching provider routing.

This is the developer handoff for the `serve` feature: a standalone inference
gateway that lets **Claude Desktop's "third-party inference" mode** display and
route to non-Anthropic models through claudish. It also covers the supporting
`providers --json` command and the provider-slug rename that the feature depends
on, plus the **live-catalog routing-alignment validation** that was run to
confirm the slugs line up.

---

## 1. What problem this solves

Claude Desktop can point its model picker at a third-party OpenAI-compatible
endpoint. But it is opinionated about what it will show:

- It builds its picker **only** from a live `GET /v1/models` call, and
  **silently drops any model id it does not recognize as a Claude slot.** You
  cannot make it display `grok-4` or `gemini-3-pro`; it will only show ids like
  `claude-sonnet-4-6`, `claude-opus-4-1`, etc.
- It then sends `POST /v1/messages` with `body.model = <that slot id>`.

So to surface an arbitrary external model in Claude Desktop, you have to:

1. Advertise a **Claude-recognized slot id** on `/v1/models`.
2. When a request comes in for that slot, **rewrite it** to the real model the
   user assigned to that slot and route it through claudish's normal pipeline.

`claudish serve` is that gateway. The `claude-desktop-profiles` app writes a
`models.json` mapping slots → real models, spawns `claudish serve`, and points
Claude Desktop at it.

---

## 2. The pieces (what was implemented)

Five files. Two new, three touched. (A separate, independent change — the
provider-slug rename — rides in the same branch; see §6.)

| File | Change |
|---|---|
| `src/serve-command.ts` | **new** — `claudish serve` entry point: parse flags, load + validate `models.json`, start the proxy parked. |
| `src/providers-command.ts` | **new** — `claudish providers --json`: credential-presence report (no key material) so the profiles app knows which providers are configured here. |
| `src/proxy-server.ts` | `SlotRoute` type + `slotMap`/`servedSlotIds` options; exact-slot routing in `getHandlerForRequest`; `GET /v1/models` route. |
| `src/index.ts` | subcommand dispatch for `serve` and `providers`. |

### 2.1 `claudish serve --port <n> --models <path>`

```bash
claudish serve --port 8787 --models ~/.../models.json
```

- Parses **only** `--port`/`-p` and `--models`/`-m`. It deliberately does **not**
  reuse the full CLI parser — `serve` must not inherit Claude-Code-launch
  semantics (no child spawn, no interactive prompts).
- Loads and **strictly validates** `models.json` (see §3). Malformed input
  exits non-zero with a specific message — the operator finds out at startup,
  not via an empty picker at runtime.
- Reads `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` from the environment.
  `index.ts`'s `loadStoredApiKeys()` has already merged
  `~/.claudish/config.json` keys into `process.env` at module load, so both
  env-set and config-stored keys are visible. `serve` bypasses `parseArgs`, so
  these must be read explicitly here or null-provider→OpenRouter and `claude-*`
  passthrough slots would have no credentials.
- Calls `createProxyServer(...)` with `{ slotMap, servedSlotIds }` and then
  **parks** (`await new Promise(() => {})`). No `finally`/shutdown, no Claude
  spawn: the profiles app owns this process's lifecycle and `SIGTERM`s it on
  stop. (`stats-buffer.ts` already installs `SIGINT`/`SIGTERM` → flush →
  `process.exit(0)` handlers on import, so termination is already clean; `serve`
  adds none of its own.)

### 2.2 `claudish providers --json`

```json
{ "providers": [
    { "slug": "x-ai",   "ready": true,  "authSource": "env" },
    { "slug": "google", "ready": false, "authSource": null }
] }
```

- One entry per non-virtual provider. `slug` is the **canonical
  `BUILTIN_PROVIDERS` name** (`tui/providers.ts` sets `catalogName: def.name`) —
  the exact string `serve` accepts as a pinned `provider`, and the string
  `parseModelSpec`/`resolveRemoteProvider` match on. **Not** the picker label
  (`slug` is `"google"`, never `"gemini"`).
- **Security:** presence + source only. It must never touch the `--probe`
  provenance path (which prints unmasked keys) and must never emit any value,
  masked fragment, or key material.

### 2.3 `GET /v1/models` (in `proxy-server.ts`)

Returns the OpenAI list shape, `data[]` populated from `options.servedSlotIds`
— the **slot ids**, not the real model ids. Defaults to `[]` for non-serve
callers (the picker is irrelevant to them, so this route is inert in normal
`claudish` runs).

### 2.4 Exact-slot routing (the core)

In `getHandlerForRequest`, **before** the substring tier match:

```ts
const slot = options.slotMap?.get(requestedModel);   // exact id, not substring
if (slot) {
  target = slot.provider ? `${slot.provider}@${slot.model}` : slot.model;
  slotMatched = true;          // skip tier match + --model fallback entirely
}
```

Exact-id lookup is deliberate: two slots can share a tier substring
(`claude-opus-4-1` and `claude-opus-4-20250514` both contain `opus`). The old
substring `modelMap` would collide them; the slot map routes them distinctly.
After rewriting `target`, control **falls through to the existing pipeline** —
so pinned providers take the explicit-`provider@model` path, `null`-provider
slots take auto-route + catalog vendor-prefix resolution, and `claude-*` reals
take native Anthropic passthrough. No new routing engine; just a new front door.

---

## 3. `models.json` contract (what the profiles app writes)

```jsonc
[
  { "slot": "claude-sonnet-4-6", "model": "grok-4",            "provider": "x-ai" },
  { "slot": "claude-opus-4-1",   "model": "gemini-3-pro-preview", "provider": null },
  { "slot": "claude-haiku-4-5",  "model": "kimi-k2",          "provider": "kimi" }
]
```

| field | meaning | rules |
|---|---|---|
| `slot` | the Claude-recognized id Claude Desktop sends as `body.model` | required, non-empty, **unique** (duplicates throw at load) |
| `model` | the real model id to route to | required, non-empty |
| `provider` | pinned routing slug, **or** `null`/omitted = autoroute | optional; if present must be a string |

> **The single most important contract rule** (see §5 for why):
> **`provider` must be a slug from `claudish providers --json`, or `null`.**
> It is a *routing* slug (a `BUILTIN_PROVIDERS` name), **not** the model's
> origin-vendor slug from the catalog. Pin `null` for anything you're unsure of
> — autoroute is the safe default and covers every catalog model.

---

## 4. Routing-alignment validation (live catalog)

The rename in §6 exists so claudish and the cloud catalog speak one slug. This
was verified against the **live deployed catalog**, not just the repo:

```
GET https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?limit=200&offset=…
→ 898 models, paged
```

**Method:** collect every distinct `provider` value the live catalog serves,
then check each against claudish's routable slug set (`BUILTIN_PROVIDERS` names
+ shortcuts + the vendor → native provider bridge: at the time a hand-written
table, `FIREBASE_SLUG_TO_PROVIDER_NAME`, since derived by `nativeProviderForVendor`).

**Headline results:**

- **The rename succeeded.** `x-ai` (7 models) and `z-ai` (22 models) are now
  **identity-aligned**: the catalog's slug *is* claudish's canonical
  `BUILTIN_PROVIDERS` name. A profiles app reading the catalog `provider` field
  for an xAI or Z.AI model and pinning it verbatim now routes correctly.
- **Providers claudish routes directly all align** by identity:
  `openai`, `google`, `deepseek`, `minimax`, `qwen`, `x-ai`, `z-ai`.
- **One real divergence among direct providers:** catalog **`moonshotai`** ↔
  claudish **`kimi`**. `nativeProviderForVendor` (`providers/route-candidates.ts`)
  bridges `moonshotai → kimi` *for the recommended-catalog renderer*, but the
  **serve slot path does not apply that map** — it builds
  `${slot.provider}@${slot.model}` verbatim. So `provider: "moonshotai"` pinned
  into `models.json` is **not** a routable claudish slug. Pin `"kimi"` (or
  `null`) instead.

**What is *not* a gap (don't be alarmed by it):** the catalog also carries
origin-vendor slugs like `mistralai`, `meta-llama`, `nvidia`, `cohere`,
`microsoft`, etc. (≈220 models). These are **who made the model**, not claudish
routing providers — they were never direct-provider candidates and all route
fine via OpenRouter/autoroute when you pin `provider: null`. They are a
non-issue *as long as the profiles app pins from the `providers --json` set or
`null`* (§5).

Reproduce the validation:

```bash
# distinct provider slugs in the live catalog
python3 - <<'PY'
import json, urllib.request
base='https://us-central1-claudish-6da10.cloudfunctions.net/queryModels'
prov=set(); off=0
while True:
    d=json.load(urllib.request.urlopen(f'{base}?limit=200&offset={off}', timeout=25))
    for m in d['models']: prov.add(m['provider'])
    if not d.get('hasMore') or not d['models']: break
    off+=len(d['models'])
print(sorted(prov))
PY

# claudish's routable slugs
claudish providers --json | python3 -c "import json,sys;print([p['slug'] for p in json.load(sys.stdin)['providers']])"
```

> **Note on `aggregators[]`:** CLAUDE.md describes an `aggregators[]` routing
> index (`{provider, externalId, confidence}`) on catalog documents. In the
> **currently deployed** catalog that field is empty (0/898). Until it's
> populated, the model's top-level `provider` field is the only provider signal
> the profiles app can read — and that's the field this validation checked.

---

## 5. ⚠️ The one sharp edge — pinned-provider failure mode

If `models.json` pins a `provider` that is **not** a claudish routable slug
(e.g. the catalog origin-vendor `moonshotai`, `mistralai`, …), the request does
**not** clean-error with "unknown provider." It falls through to OpenRouter, and
**the observable outcome depends on whether `OPENROUTER_API_KEY` is set** —
either way the user never learns their `provider` pin was invalid. The flow:

- `getHandlerForRequest` builds `target = "moonshotai@kimi-k2"`.
- The explicit-provider path can't resolve `moonshotai` to a direct profile, so
  `createHandlerForProvider` returns `null` (`provider-profiles.ts:397`), the
  resolution path returns `null` (`proxy-server.ts:305`)…
- …and the request falls through to the **OpenRouter handler**.

**Verified empirically** (`serve --debug`, POST the slot, watch
`[Serve] slot … → moonshotai@kimi-k2`):

| `OPENROUTER_API_KEY` | Result |
|---|---|
| **set** | **HTTP 200 — silently served by OpenRouter** (here it even resolved `kimi-k2` on OpenRouter, so it *looks* like it worked). Pure silent mis-route — the worst case, because nothing signals the pin was wrong. |
| **unset** | **HTTP 401** `authentication_error` from the OpenRouter handler — an opaque auth failure, *not* a "you pinned a bad provider" message. |

This is the known "missing-profile → silent OpenRouter fallback" behavior. It
makes the §3 contract rule load-bearing:

> **The profiles app MUST pin a `providers --json` slug or `null`. Never pin a
> raw catalog origin-vendor slug.**

**Recommended fix on the profiles-app side** (pick one):

1. Populate the provider picker **from `claudish providers --json`** — then a
   raw catalog slug like `moonshotai` is never offered; the user picks `kimi`,
   or leaves it `null`. *(Lowest-risk; `providers-command.ts` exists for exactly
   this.)*
2. Or always write `provider: null` and let claudish autoroute. Simplest;
   you lose the ability to pin a specific provider but gain "can't get it wrong."

**Optional hardening on the claudish side** (not yet done — a decision for the
next dev): make `serve` reject (or warn + downgrade to `null`) a `slot.provider`
that isn't in the `providers --json` set, instead of letting it reach the silent
OpenRouter fallback. This would turn the sharp edge into a startup error. See
`memory: project_silent_provider_fallback.md`.

> **Open verification:** the `claude-desktop-profiles` app source is **not in
> this repo or `~/mag`**, so its actual `provider`-pinning logic was not read.
> The §3/§5 contract is what `serve` *requires*; confirm the app honors it
> (ideally option 1 above) before shipping.

---

## 6. The provider-slug rename (independent change, same branch)

`xai → x-ai`, `zai → z-ai` across `BUILTIN_PROVIDERS` (18 files). This is the
prerequisite that makes §4 identity-aligned. Done as a **full canonical
rename**; old forms kept as **input aliases** so existing commands still route:

```ts
// provider-definitions.ts
name: "x-ai",  shortcuts: ["x-ai", "xai", "grok"],  shortestPrefix: "x-ai",
name: "z-ai",  shortcuts: ["z-ai", "zai"],          shortestPrefix: "z-ai",
```

**Credentials do not break.** Verified empirically:

| Credential path | Keyed by | Breaks? |
|---|---|---|
| Env `XAI_API_KEY` / `ZAI_API_KEY` | env-var name (unchanged) | No |
| `config.json` stored key | `apiKeyEnvVar = XAI_API_KEY` (unchanged) | No |
| OAuth token | `oauthSlug` (xai/zai have none) | N/A |
| Typed `xai@` / `zai@` | kept as shortcuts | No |

Only the canonical name string changed — surfacing correctly as `x-ai`/`z-ai`
in `providers --json` and matching the catalog.

**Commit guidance:** the serve feature (`serve-command.ts`,
`providers-command.ts`, `proxy-server.ts`, `index.ts`) and the rename (18 files)
are **logically independent — split into two commits** so the rename can be
reverted without unwinding the feature. **Exclude `.gitignore`** — its only diff
(`.claudemem/` removal) is unrelated session noise.

---

## 7. Verification status

- **Build:** CLI package bundles clean (418 modules). *(The `macos-bridge`
  package fails to build — missing `node_modules` there — but it is a separate
  package, untouched by this work; purely environmental.)*
- **Tests:** provider-name suites pass (`default-routing-rules`, `routing-rules`,
  `model-selector`, `model-catalog` → 158/158). Prior session reported 379/379
  across all 13 provider-name suites.
- **Live alignment:** validated against the deployed catalog (898 models) — §4.
- **Serve path, locally:** verified end-to-end against the worktree build —
  `GET /v1/models` returns the slot ids; `POST /v1/messages` routes through the
  slot rewrite; `providers --json` emits `x-ai`/`z-ai` with no old `xai`/`zai`.
  The §5 pinned-unrouteable-provider failure mode was **reproduced** (silent
  OpenRouter mis-route with a key; 401 without).
- **Profiles-app contract:** **not yet run against the real
  `claude-desktop-profiles` app** (not on this machine). Confirming the app pins
  from the `providers --json` set (not raw catalog slugs) is the remaining gate
  before release — see §5 open verification.

---

## 8. Running the dev build (for the cloud-profiles developer)

Officially, claudish is the **global install** (`bun install -g claudish`, or
Homebrew). `serve` and `providers` will reach users through that channel. But
**this branch is not yet released**, so to test the profiles app against it you
must point at *this worktree*. The two facts that make this fiddly:

1. **The global `claudish` (v7.2.0) does NOT have `serve`/`providers`.** They are
   branch-only. Running the released binary just prints the help banner — it
   silently ignores the unknown subcommand. You will get nothing useful until
   this branch ships.
2. **The profiles app resolves `claudish` from `PATH`** (bare name — there is no
   `CLAUDISH_PATH`/binary-override env var in the codebase; the channel
   `session-manager` spawns `"claudish"` the same way). So the dev hook is to put
   a `claudish` that runs this worktree **earlier on `PATH`**.

### Recommended: a `PATH` wrapper that runs this worktree's source

Faithful to "it relies on the global `claudish`" — the profiles app spawns bare
`claudish` exactly as in production; the wrapper just intercepts it for dev.

```sh
# 1. Create a wrapper somewhere early on the profiles app's PATH (e.g. ~/bin):
mkdir -p ~/bin
cat > ~/bin/claudish <<'EOF'
#!/bin/sh
exec bun --no-env-file run <claudish-checkout>/packages/cli/src/index.ts "$@"
EOF
chmod +x ~/bin/claudish

# 2. Put ~/bin ahead of the npm global bin on PATH (in your shell rc, or the
#    environment the profiles app inherits):
export PATH="$HOME/bin:$PATH"

# 3. Verify it's this build, not the global one:
claudish providers --json            # → {"providers":[ … "slug":"x-ai" … "z-ai" … ]}
claudish serve --port 8787 --models ~/models.json
```

After this branch merges and you `bun install -g claudish` (or `brew upgrade`),
**delete `~/bin/claudish`** so you're back on the real global binary.

### Quickest: call the source directly (no PATH change)

If the profiles app can be configured with an explicit command for dev instead
of a bare `claudish`:

```sh
bun --no-env-file run <claudish-checkout>/packages/cli/src/index.ts serve --port 8787 --models ~/models.json
bun --no-env-file run <claudish-checkout>/packages/cli/src/index.ts providers --json
```

`<claudish-checkout>` is the absolute path of your clone. Keep `--no-env-file` in both
recipes: it stops Bun loading the env files of whatever directory the command runs in,
which is what the installed `claudish` does. Without it claudish cannot tell those
values from yours, so it ignores `CLAUDISH_CONFIG` and the other control variables, and
every name the files set, with one stderr line.

### Two traps — do NOT use these in this worktree

- **`bun link` / installing this package globally** → produces a `claudish` that
  **crashes** with `Cannot find module '@opentui/core'`. This worktree does not
  have full deps installed (`@opentui` is absent from its `node_modules`), and
  the build marks `@opentui/*`/`react` as **external**, so the bundled
  `dist/index.js` can't resolve them at runtime when run outside a proper
  install.
- **`bun dist/index.js …` directly** → same `@opentui/core` failure, for the
  same reason.

**Why the source run (`bun run src/index.ts`) sidesteps this:** `@opentui` is
lazy-imported on **only** the `config` TUI path (`index.ts` →
`import("./tui/index.js")`). `serve` and `providers` never touch the TUI, so a
source run of those subcommands never needs `@opentui` — Bun resolves only what
those codepaths import. (If you *do* want the build/link route to work, run a
full `bun install` in the worktree first — unnecessary for testing `serve`.)
