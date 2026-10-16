> `muse@` on a Muse Code subscription: a minted `LLM|` key, the Muse CLI's Keychain login, and why the mint is the entitlement evidence.
>
> Added in the Muse Code work (2026-10-16, on v10.6.1). Indexed in [`README.md`](../README.md).

# Muse Code (`muse@`): Meta models on your Muse Code subscription

The claudish provider `meta-muse-code` (provider shortcut `muse@`, tier `subscription`) signs
requests with a Muse Code login. Its metered sibling is `meta` (`meta@`, tier `native`), signed by
`META_API_KEY` on route `meta/direct-api`. They are two credential silos on one host:

| | `meta` (`meta@`) | `meta-muse-code` (`muse@`) |
|---|---|---|
| Credential | `META_API_KEY` | a Meta `dca:` access token, minted into a short-lived `LLM\|` key |
| `apiKeyEnvVar` | `META_API_KEY` | `""` (load-bearing, see below) |
| Request | catalog connection on `meta/direct-api` | `POST https://api.meta.ai/v1/responses`, `stream: true`, `store: false` |
| Route binding | `meta/direct-api` | none yet (backend M1 to M3) |
| Billing | per token, from the connection's `pricing` | `SUBSCRIPTION_PROVIDERS`: `$0`, `SUB` |
| Models | catalog connections | the account's dynamic models catalog, `GET /muse-code/models` |

The `meta` provider shortcut belonged to `ollamacloud` until `ca4be53b`. It moved with no alias
(CLAUDE.md: a rename removes the old name).

**claudish has no runtime dependency on the `muse` binary.** It reads one Keychain item the Muse
CLI writes and calls the same two Meta endpoints the CLI calls. Nothing is executed, parsed out of
the binary at runtime, or version-gated. That matters because muse auto-updates: it went from
1.4.8 to 1.4.9 in the middle of the capture session.

## The wire, as captured

The Muse CLI 1.4.8 was run through a logging reverse proxy (`muse exec --base-url`), and on
2026-10-16 through a user-approved mitmdump for the two calls that bypass `--base-url`. Every
secret was redacted at write time.

```
POST https://api.meta.ai/v1/responses
authorization: Bearer LLM|<17 digits>|<27 chars>        # 49 chars, opaque, not a JWT
content-type: application/json
{"model":"muse-wonder-full-1.0","instructions":"…","input":[…],
 "max_output_tokens":128000,"store":false,"tools":[…],
 "reasoning":{"effort":"high","summary":"auto"},
 "include":["reasoning.encrypted_content"],"stream":true}
```

- The bearer alone is enough. Probes with only `authorization` and `content-type` answered 200,
  without `user-agent`, `x-client-id` or the `x-tbh-*` session headers. claudish sends none of
  those.
- `MuseCodeTransport.transformPayload` (`providers/transport/meta-muse-code.ts`) reproduces the
  three fields the CLI sends that the Responses adapter does not: `store: false`,
  `reasoning.encrypted_content` in `include`, and `reasoning.summary: "auto"` when reasoning is
  sent. With `store: false` the encrypted reasoning items replay statelessly on the next turn.
- Effort values come from the model's `variants` keys in `/muse-code/models`. On the wire,
  `minimal`, `xhigh` and `max` answer 200; `none` and `ultra` answer 400. The CLI's own `ultra`
  never reaches the wire as `ultra`.
- A bad bearer answers
  `401 {"error":{"code":"invalid_api_key","message":"Unauthorized","type":"authentication_error"}}`,
  with no `www-authenticate`.

### `response.subscription_usage`

The Responses and chat-completions streams carry one Meta event after `response.completed`:

```json
{"type":"response.subscription_usage","subscription":{"tier":"27681631238169137",
 "weekly":{"resets_at":1792368000,"used_percent":0},
 "window":{"resets_at":1792088451,"used_percent":2,"window_duration_mins":300}}}
```

`openai-responses-sse.ts` has no branch for it, so the parser drops it and Claude Code never sees
it. A quota display that reads it (architecture phase 18) is not built. `used_percent` is an
integer, too coarse to attribute one small request.

### Endpoints claudish does not use, and why

The subscription bearer also gets 200 from `POST /v1/chat/completions` and `POST /v1/messages`
(full Anthropic SSE with `redacted_thinking` and `tool_use`). claudish uses neither:

- Whether either one bills the subscription or the metered API was not measured.
  `used_percent` cannot show one request.
- `/v1/messages` emits no `subscription_usage` event, so it carries no evidence of subscription
  accounting at all.
- The CLI itself sends only `/v1/responses`.

So `transportFor` builds `MuseCodeTransport` only for `api === "responses"`, and try-in-turn for
`meta-muse-code` is restricted to `responses` (`wire-handler.ts`). Opening another API needs a
billing measurement first, not a code change.

### Contributor mode

`muse exec --contributor-mode on` changes exactly two things: header `x-tbh-contributor-mode: 1`
and the model id `<id>-contributor`. The catalog describes those ids as "Your content, including
inter-session messages, may be used for product improvement." claudish never sends the header.
It sends a contributor id only when the user typed it (see the contributor guard below).

## The Keychain item

```
keychain: login.keychain-db    class: genp
service (svce): ai.meta.dev.credentials    account (acct): meta
value: {"secret_schema_version":1, "api_key":"LLM|…"(49), "access_token":"dca:…"(282)}
```

The binary's strings name a wider serde struct (`access_token, obtained_via, refresh_token,
expires_at, api_key, api_base_url, user_full_name, user_email, user_avatar_url, subs_active,
secret_schema_version`). The item observed on 2026-10-16 held only the three fields above: no
`refresh_token`, no `expires_at`.

- **claudish reads `access_token` only** (`parseMuseKeychainValue`, `muse-keychain.ts`). The
  `dca:` token is the durable credential.
- **`api_key` is never used.** It is the CLI's current minted key, and it rotates under the CLI.
  On a synthetic 401 the CLI re-minted and rewrote the item: its `mdat` moved from
  `20261015131850Z` to `20261016023620Z` at the instant of the retry.
- **claudish never writes the item.** `claudish logout muse` does not touch it.

### Presence is free; a value read is a dialog

`find-generic-password` without `-w` returns attributes only, with no dialog. The `-w` read of an
item another application created opens the macOS access dialog the first time, and a person may
take minutes to answer it. So presence and value are separate calls (`keychain.md`): presence is
async and memoized for 3 s, never on a render path. The value read is the only thing gated.

### Never kill `security`

A killed `security` mid-transaction is how this codebase once made macOS restart `securityd`
(`keychain.md`). `startGenericPasswordRead` (`providers/keychain.ts`, `a0fad487`) therefore
returns `{ done, pid }` and has no kill path:

1. `done` resolves only when `security` itself exits, and never rejects.
2. Each caller races `done` against its own deadline: 120 s (`MUSE_KEYCHAIN_READ_DEADLINE_MS`).
3. A caller whose deadline wins stops waiting. `security` keeps running.
4. A late approval resolves `done`. The answer is kept in-process (`lateResult`) for the next
   caller, which takes it without a second dialog.

Locked-keychain and Deny exit codes are NOT measured. Both open a desktop dialog, and no kill is
allowed to end one, so they need an interactive run.

### One read per machine: `~/.claudish/muse-keychain-read.lock`

Joining `done` works inside one process. Across processes, a fan-out of CLI `--team` grid panes
or two launches in two terminals, a lock file does the same job:

- The holder creates it with `wx` (exclusive), then rewrites it with the `security` CHILD's pid
  while the dialog is up. A holder that gives up and exits leaves a lock that stays live exactly as
  long as the dialog does.
- A process that finds a live lock does not spawn. It polls every 500 ms until the lock clears,
  then reads the borrowed copy the holder wrote. If no copy appeared, it reads for itself, when its
  role allows.
- A lock is stale when its pid is dead, when it is older than 30 minutes (pids are reused), or
  when it is unreadable for more than 5 s.

## The prompt role: which process may open the dialog

`credentialPromptRole()` (`auth/credentials/prompt-role.ts`, `da9c2c17`) is fixed once per process
by its entry point. The default is `never`. After the first set, the role can only be lowered to
`never`. A request can read the role and can never raise it.

| Entry point | Role | Muse Keychain value reads |
|---|---|---|
| `index.ts` `runCli`, stdin AND stderr are TTYs, not a pane child, no `--probe` | `interactive-launch` | the startup hook and the request path |
| `index.ts` in a pane child (`CLAUDISH_PANE_CHILD`), piped, or CI | `never` | none |
| `--probe` (`cli.ts`) | `never` | none |
| MCP server (`mcp-server.ts`): `team`, `create_session`, `preflight` | `never` | none |
| `claudish serve` | `never` | none |
| config TUI (`tui/index.tsx`) | `tui` | only inside `withInteractiveCredential(action)`, in-process, before the action sends a proxy request |

**`isPaneChild()`, never `isatty`.** A magmux pane has a real PTY, so an MCP `team` slot passes
every TTY test. `pane-launch.ts` sets `CLAUDISH_PANE_CHILD` for every MCP `team` slot and
`create_session` pane. CLI `--team` grid panes do NOT carry it, because the user who ran `--team`
is at that terminal. They take `interactive-launch`, and the lock bounds them to one dialog.

**A `never` process asks the Keychain nothing**, not even the attribute-only presence question.
A locked login keychain can answer any `security` call with an unlock dialog, and the process
could not use the item anyway. So in a `never` process a Keychain-only login reads as absent
(`MuseCodeCredentialProvider.describeReadiness`), and the error says how to fix it:

```
muse@ in a team slot / MCP session needs a claudish login: run `claudish login muse`, or one
interactive `claudish --model muse@<model>` and allow Keychain access.
```

## Sources, and the borrowed 0600 copy

`ensureMuseCredentialReady` (`providers/meta-muse/muse-credentials.ts`) tries three sources in order:

1. `~/.claudish/meta-muse-oauth.json`: claudish's own login (`claudish login muse`).
2. `~/.claudish/meta-muse-borrowed.json`: claudish's copy of the Muse CLI's `dca:` token.
3. The Keychain item, only when the caller may prompt AND the role is not `never`.

The borrowed copy is what lets a `team` slot, an MCP session or a piped launch use the Muse CLI's
login without a dialog of its own:

```json
{ "schema": 1, "access_token": "dca:…", "copied_at": "2026-10-16T02:36:20.000Z",
  "subs_tier_name": "Muse Code Power Usage" }
```

- It is written only after a Keychain read AND a mint that confirmed the subscription, by a
  process whose role allows the read.
- Both files are mode 0600 (the directory is created 0700 when missing), written by temp file
  plus `rename`, and valid only when they parse with a non-empty string `access_token`
  (`isValidMuseStore`, the one predicate every reader uses).
- An env handoff was rejected. A minted key in the environment cannot be re-minted by the child,
  and it would reach the child's Claude Code, whose Bash tool can print it.
- The Muse CLI's own logout revokes the `dca:` token remotely. After that, the mint answers 401 and
  the copy is useless. `claudish logout muse` deletes both files (`deleteMuseStores`).

### claudish's own login: `claudish login muse`

`MuseCodeOAuth` (`auth/meta-muse-oauth.ts`, `ad1cb22f`) runs Meta's RFC 8628 device flow, so a
user needs neither the Muse CLI nor a Keychain approval:

```
POST https://auth.meta.com/oidc/device/authorization/   (form)  client_id=1031625952748946
→ {device_code, user_code, verification_uri, verification_uri_complete, expires_in: 600, interval: 5}
POST https://auth.meta.com/oidc/device/token/   (form)
  grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=1031625952748946
→ 400 authorization_pending | 400 slow_down | 200 {access_token, …}
```

- No scope parameter. `slow_down` adds 5 s to the interval for the rest of the wait (RFC 8628
  §3.5).
- The 200 body was never captured: the captured `muse login` was stopped before approval, so
  the Muse CLI's own login stayed intact. Only
  `access_token` is required; `refresh_token` and `expires_in` are kept if present and never read.
- The token is minted once BEFORE it is stored. An unsubscribed account is NOT stored: an own
  login is tried first, and a stored unconfirmed one would block a working borrowed copy on every
  request. A transient mint failure stores the login with a warning.
- Logout deletes both files and revokes nothing remotely. The shape of `muse-code/logout` was
  never captured.

## One host, with no override

The `dca:` login, the minted key and every Muse request go only to `https://api.meta.ai`
(`MUSE_CODE_BASE_URL`, a constant in `providers/meta-muse/muse-mint.ts`); the definition declares
no `baseUrlEnvVars`. An earlier cut honoured an environment override, then an opt-in variable for
a non-Meta host, then the opt-in only from the inherited environment. Each was bypassable: Bun loads
`.env`, `.env.local` and `.env.<NODE_ENV>` from the working directory before the first claudish
module runs (measured on Bun 1.4.0), so any repository the user runs claudish in could set both
variables and receive the login, which may be the one copied from the Muse Code CLI's Keychain
item. No environment-based switch can be trusted, so there is none. Tests use the mint's injected
`fetch` seam.

## The mint is the entitlement evidence

```
POST https://api.meta.ai/muse-code/key
authorization: Bearer dca:…              # 282 chars
x-api-version: 1.0.0
content-type: application/json
{"onboard":false}
→ 200 {"api_key":"LLM|…","base_url":"https://api.meta.ai/v1",
       "is_subs_active":true,"require_payment":false,"action_url":null,
       "subs_tier_id":"27681631238169137","subs_tier_name":"Muse Code Power Usage",
       "subs_usage":{…}, …}
```

The CLI calls this at start and again on a 401 from `/v1/responses`. That remint goes straight to
`api.meta.ai:443`, bypasses `--base-url`, and never contacts `auth.meta.com`. So the device-code
server is not part of renewal: the `dca:` token mints new keys until the mint itself answers 401.

**A mint is confirmed only when `is_subs_active === true` AND `require_payment === false`**, both
present as booleans (`interpretMint`, `muse-mint.ts`). Missing, `"true"` or `null` is unconfirmed.
An unconfirmed mint throws `MuseSubscriptionRequiredError`, a terminal error that links
`action_url`, or `https://accountscenter.meta.com/muse_code/?ep=no_payg` when the response names
none. It deliberately carries no login hint, because logging in again changes nothing.

This is the reason a mint happens before any signing. `meta-muse-code` is in
`SUBSCRIPTION_PROVIDERS`, so every request it signs reads `SUB` and accrues `$0`. A key minted for
an account with no active subscription would otherwise be labelled flat-rate while Meta charged or
refused it.

| Mint answer | Thrown | `classifyAuthFailure` |
|---|---|---|
| 401, 403 | `MuseLoginExpiredError` | terminal |
| 200, unconfirmed | `MuseSubscriptionRequiredError` | terminal |
| 429, 5xx | `MuseMintTransientError` | transient |
| network fault, 15 s timeout | `Error` with `cause` and `claudishEndpoint` | connection |
| 200 with no `api_key`, other status | `MuseMintProtocolError` | terminal |

claudish sends `User-Agent: claudish/<version>`, not the CLI's `muse-build/0.1.0`. Whether the
endpoint checks it was not measured, because no live mint was run during implementation.

### Rotation: per process, on 401, and on a 30-minute TTL

The minted key lives only in the memory of the process that minted it (`MuseState`), never on
disk, so every process mints its own. Three events renew it:

- **Process start.** The first request mints. For an interactive launch, the startup hook mints
  before Claude Code starts (below).
- **A 30-minute entitlement TTL** (`MUSE_ENTITLEMENT_TTL_MS`). This is a rule, not a vendor value.
  It bounds a lapsed subscription in `claudish serve` or a long session to 30 minutes of `SUB`
  labelling. A TTL re-mint first re-confirms the token already in use, so a working source is not
  abandoned for an earlier one.
- **A 401 from `/v1/responses`.** See the algorithm below.

Every source switch is logged with the tier name (`[MuseCode] signing source …`), so a silent
account switch between the own login and a borrowed one shows up in the debug log. Whether a
claudish mint invalidates the CLI's current key is not measured. The CLI re-mints on its own 401,
so either answer is survivable.

### The 401 algorithm

`MuseCodeTransport.forceRefreshAuth` receives the headers of the rejected request (the
`forceRefreshAuth?(ctx?: { rejectedHeaders })` parameter added in `c6a7b4a5`) and calls
`forceRefreshMuseApiKey({ rejectedKey })`:

1. Add the rejected key to the process's dead-key set.
2. If the key in use is a different key that is not dead, return it. The 401 was stale: a
   concurrent request already replaced that key.
3. Otherwise mark the current key dead and resolve again, single-flight: re-mint from the token in
   use; on a mint 401/403, try the next source.
4. If no source works, throw a terminal `MuseCredentialError`:
   `Meta rejected a freshly minted Muse Code key (HTTP 401): run claudish login muse (or muse login).`

A mint that confirms a key removes it from the dead-key set, because the service can hand back the
key it rejected a moment earlier, and a dead mark left on it would re-mint on every request.

A source whose mint answers 401/403 falls to the next source. A network or transient mint failure
is rethrown unchanged. It never falls to another source and never falls back to an unconfirmed key.

## The startup hook

`prepareMuseLoginForLaunch` (`providers/meta-muse/muse-launch.ts`) runs in `index.ts` after
`warmCatalogIfNeeded`, in every launch role, and is skipped under `--monitor`. It exists for two
reasons:

- `claude-runner` reads the served context window from discovery before it spawns Claude Code, and
  discovery needs a signed key. In a `never` role that key comes from the two files.
- In an interactive launch, the Keychain dialog belongs in front of the user who typed the command,
  not inside Claude Code's first turn.

An explicit `muse@` slot whose login is terminally unusable exits 1 before spawn, and the message
names its fix. A bare-name slot that gathers `meta-muse-code` only warns, because its routing chain
continues. A network or transient fault warns and continues.

## Classification at the auth sites

The terminal/transient contract every subscription now follows is in [`adapters.md`](../adapters.md)
("A subscription's credential failure stops the chain"). For `muse@` the consequence is direct: an
expired Muse login answers 400 with the login hint, and the chain never walks onto metered `meta@`.

`probe-live.ts` lists `meta-muse-code` in `OAUTH_PROVIDERS`. A login-fixable failure gets the
`claudish login muse` hint. An unsubscribed account gets `subscribe at <url>` instead.

## Models and effort

- **Discovery.** `GET /muse-code/models` (`muse-models.ts`, format `muse-code-models`) returns
  OpenAI-style rows with `metadata["muse-code"]`: modalities, `limit.context` / `limit.output`,
  effort `variants`, `is_hidden`. Hidden rows (`muse-image-1.0`) are not offered. `GET /v1/models`
  lists ids only, with `created: 0`, so it is not used.
- **Context window.** The transport reads the served window (1,007,997 on the captured account)
  from the dynamic models catalog, memoized, with a 5-minute backoff after a miss. The
  `direct-api` catalog records publish 1,048,576. Both numbers belong to different routes.
- **Effort borrow** (`muse-wire.ts`, `281caf0a`). With no route binding, no connection describes
  the `muse@` request shape. `ownerWireForModel` borrows the KNOWN `responses` wire of the same wire
  id on `meta/direct-api`, after a 5 s registry wait, with its speed and mode forced to `unknown`
  because those carry entitlement and price (`wire.md`).
- **The `muse-wonder-full-1.0` gap.** `meta/direct-api` does not publish that id, so it gets no
  borrowed wire, and its effort is whatever the Responses adapter sends. The `direct-api`
  contributor rows publish no reasoning support either, so an explicit contributor id gets only the
  token limit. Both gaps close when backend M3 to M5 publish subscription connections.

## The contributor guard, and when to remove it

Jack's decision (2026-10-16): **a contributor wire id is never chosen implicitly, on any route.** A
user who types `provider@<id>-contributor` gets it verbatim.

`isOptInWireId` (`providers/content-use.ts`, `d9193383`) matches `-contributor` and
`-contributor-free` on the last path segment. Where catalog data enters memory, the matching
connections move from `aggregators[]` to `optInConnections[]`, which only exact-id readers
(`allConnections`) consult. [`routing.md`](../routing.md) lists the entry points and readers.

**Remove the guard when models-index publishes a content-use field on every route (backend M3).**
It is the one wire-id name rule claudish keeps. The trigger is that field, not Meta: OpenCode Zen's
`-contributor-free` ids are covered by the same regex.

## Backend tasks (models-index)

Filed in `ai-docs/reports/BACKEND_TASKS_meta_muse_code_route-20261016.md`, read against generation
`g-20261015133900604-fb6199b5`:

| Task | What | Unblocks |
|---|---|---|
| M1 | a subscription route profile on route `meta`, `apis: [responses]`, its own credential profile | the binding row (architecture phase 17) |
| M2 | plan `meta-muse-code` to `supported` with that route | membership gating |
| M3 | one mapped connection per member, wire id as `/muse-code/models` spells it; contributor ids marked by a field, not only the suffix | bare-name routing to `muse@`; removing the contributor guard |
| M4 | a model record `muse-wonder-full`, wire id `muse-wonder-full-1.0` | bare `muse-wonder-full` |
| M5 | per-connection limits and effort from `/muse-code/models` | the effort and window gaps above |
| M6 | per-tier membership: Wonder Full is Power and Maximum only | no 4xx candidate on a lower tier |

Until M1 to M3 land, a bare `muse-*` name never reaches `muse@`. `meta-muse-code` is tier
`subscription`, not `dynamic-subscription`, so it makes no namespace claim; with no mapped
connection the gatherer has nothing to offer. A bare `muse-spark-1.3` goes to `meta@` (with
`META_API_KEY`), then OpenCode Zen, then OpenRouter.

## Captures

The full reverse-engineering notes, §1 to §8, are tracked at
`ai-docs/reports/meta-muse-code-wire-capture-20261016.md` (tokens redacted at capture time; the
home path and the subscription tier id scrubbed).

The raw captures stayed in the GITIGNORED session directory
`ai-docs/sessions/dev-feature-muse-code-20261016-010810-37623ac2/research/`. They do not survive a
fresh clone; the report and the facts above are the durable record.

| File | What |
|---|---|
| `capture.log` | a PONG run through the base-url proxy |
| `cap2/` | a one-tool-call run (the Responses round trip) |
| `cap3/` | a contributor-mode run |
| `cap4/capture.log`, `cap4/connect.log` | the synthetic-401 run and the CONNECT host log that placed the remint on `api.meta.ai` |
| `cap5-mitm.log` | the decrypted mint |
| `cap6-login.log` | the device login, stopped before approval |
