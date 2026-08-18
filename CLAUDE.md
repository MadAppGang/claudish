# Claudish - Development Notes

For planned but not-yet-implemented work — including the SEP-1686 channel migration, optional `notifications/progress` for terminal UI, and the Anthropic plugin allowlist consideration — see `ROADMAP.md`. Each item there has an explicit trigger condition; if a condition is met, the item moves to active development.

## Release Process

**Releases are handled by CI/CD** - do NOT manually run `npm publish`.

1. Bump version in `package.json`
2. Commit with conventional commit message (e.g., `feat!: v3.0.0 - description`)
3. Create annotated tag: `git tag -a v3.0.0 -m "message"`
4. Push with tags: `git push origin main --tags`
5. CI/CD will automatically publish to npm

## Build Commands

- `bun run build` - Build CLI and macOS bridge bundles
- `bun run dev` - Development mode

## Model Routing (v4.0+)

### New Syntax: `provider@model[:concurrency]`

```bash
# Explicit provider routing
claudish --model google@gemini-2.0-flash "task"
claudish --model openrouter@deepseek/deepseek-r1 "task"

# Native auto-detection (no prefix needed)
claudish --model gpt-4o "task"          # → OpenAI
claudish --model gemini-2.0-flash "task" # → Google
claudish --model llama-3.1-70b "task"   # → OllamaCloud

# Local models with concurrency
claudish --model ollama@llama3.2:3 "task"  # 3 concurrent requests
```

### Provider Shortcuts
- `g@`, `google@` → Google Gemini (direct API, `GEMINI_API_KEY`)
- `ag@`, `antigravity@` → Antigravity (Gemini via your Antigravity subscription — see "Antigravity Provider" below)
- `go@` → **deprecated alias → `ag@`** (Gemini Code Assist for individuals was retired by Google; the provider has been REMOVED, `go@` prints a one-line deprecation notice and routes to Antigravity)
- `oai@` → OpenAI Direct
- `cx@`, `codex@` → OpenAI Codex (Responses API)
- `or@`, `openrouter@` → OpenRouter
- `mm@`, `mmax@` → MiniMax
- `mmc@` → MiniMax Coding Plan
- `kimi@`, `moon@` → Kimi
- `glm@`, `zhipu@` → GLM
- `gc@` → GLM Coding Plan
- `sakana@`, `fugu@` → Sakana Fugu
- `sc@` → Sakana Fugu Subscription
- `qc@` → Qwen Plan (Alibaba Model Studio **Token Plan** subscription)
- `qp@`, `dashscope@` → Qwen PAYG (Alibaba Model Studio **pay-as-you-go**, `DASHSCOPE_API_KEY`)
- `dv@`, `devin@` → Devin (Cognition/Codeium subscription — see "Devin Provider" below)
- `gk@` → Grok Build subscription (SuperGrok / X Premium+ — see "Grok Build Provider" below). `grok@` stays with the METERED `x-ai` provider
- `x-ai@`, `xai@`, `grok@` → xAI direct API, metered (`XAI_API_KEY`)
- `llama@`, `oc@` → OllamaCloud
- `litellm@`, `ll@` → LiteLLM (requires LITELLM_BASE_URL)
- `ollama@` → Ollama (local)
- `lmstudio@` → LM Studio (local)
- Custom endpoint names also work as provider prefixes (e.g., `my-vllm@model-name`) — see "Custom Endpoints" below
- **Bundled catalog vendors** each use their own name as their only prefix, and appear only when their key is locally present: `groq@`, `cerebras@`, `together@`, `fireworks@`, `deepinfra@`, `nebius@`, `hyperbolic@`, `sambanova@`, `novita@`, `baseten@`, `perplexity@`, `venice@`, `chutes@`, `featherless@`, `parasail@`, `inference-net@`, `aimlapi@`, `requesty@`, `nanogpt@`, `cohere@`, `scaleway@`, `upstage@`, `writer@`, `moonshot-cn@`, `tuningengines@` — see "Predefined Endpoints" below. `moonshot-cn@` is the China-region Moonshot product, a DIFFERENT service from the builtin Kimi provider reached by `moonshot@`

### Devin Provider (`dv@`) — many vendors' models on one Cognition subscription

The only **binary** wire in the pipeline: Connect-protocol envelopes carrying protobuf, on
`POST <server>/exa.api_server_pb.ApiServerService/GetChatMessage` with `authorization: Basic <k>-<k>`
(the key literally doubled), `content-type: application/connect+proto`, `connect-protocol-version: 1`.
Codec, request builder, credentials, live roster, and uid resolution live in `providers/devin/`;
Layer 1 is `adapters/devin-api-format.ts`, Layer 3 `providers/transport/devin.ts`, the parser
`handlers/shared/stream-parsers/devin-connect.ts`. Full reverse-engineering write-up:
`ai-docs/sessions/dev-arch-devin-subscription-20260806-120000-a1b2c3d4/protocol-spec.md` (write-up lost — predates the ai-docs tracking fix).

**Auth is the Devin CLI's own token, verbatim.** `~/.local/share/devin/credentials.toml`
(`windsurf_api_key = "devin-session-token$<JWT>"`), overridable with `WINDSURF_API_KEY`;
`WINDSURF_API_SERVER_URL` re-points the backend, which is also the cheapest way to capture traffic
(the CLI validates against the macOS **system** trust store and ignores `SSL_CERT_FILE`, so a
plain-HTTP forwarder beats a MITM CA). No exchange, no refresh, no keychain. There is **no
`claudish login devin`** — the Devin CLI mints the token; claudish only reads it.

**`apiKeyEnvVar` MUST stay `""`.** proxy-server's credential-extraction block runs only for a
non-empty value and extracts the key by stripping `Bearer ` from `auth.headers.Authorization`.
Devin's artifact is `Basic <k>-<k>` on a LOWERCASE header, so that yields `""` → `return null` → the
handler is never built and the model **silently falls through to OpenRouter**. A wrong provider
quietly succeeding is worse than a crash. Same pattern as Antigravity: empty env var + a dedicated
`CredentialProvider` + transport-side `credentials.getRequestAuth()`.

**Access is always EXPLICIT — no bare name ever routes to Devin.** Its uids collide head-on with
other providers' namespaces (`claude-opus-5-medium` matches native-anthropic's `/^claude-/i`,
`gpt-5-6-luna-medium` matches OpenAI's, `glm-5-2` GLM's, `kimi-k3-high` Kimi's), so the definition
declares **no `nativeModelPatterns`** and there is **no `DEFAULT_ROUTING_RULES` entry**. Same
reasoning as Qwen Plan, which also re-serves other vendors' models.

**The reasoning tier is IN the model id — there is no effort parameter.** `dv@claude-opus-5` at
effort `high` resolves to the uid `claude-opus-5-high` via `resolveDevinModelUid` against the LIVE
roster (`getServedDevinModels` = `GetCliModelConfigs` ∩ `GetCliTeamSettings.allowed_model_uids`,
minus `contextWindow === 0`, which is what drops the `adaptive` router pseudo-model). No roster,
window, family, or tier is ever hardcoded — 167 models on the developer's own account. Note the two
metadata rpcs are **unary and BARE** (`application/proto`, no envelope), field 1 is `"chisel"` there
versus `"devin-cli"` on `GetChatMessage`, `GetCliTeamSettings` lives on `SeatManagementService` not
`ApiServerService`, and metadata field 7 is required (dropping it → HTTP 400).

**Three wire facts that cost real money to get wrong:**

- **Errors ride an HTTP 200.** The fault is a `flags=2` frame carrying
  `{"error":{"code","message"}}`; the status code alone NEVER signals failure. `sniffDevinStreamHead`
  settles it while the status is still ours to choose — retryable (`unavailable`/`internal`/
  `deadline_exceeded`, non-quota `resource_exhausted`, prose overloads) retries on the shared
  3s→15s→30s schedule then 503; terminal (`permission_denied`/`unauthenticated`/`invalid_argument`/
  `not_found`, quota-worded `resource_exhausted`) goes straight to a **400 rendered inline**. An
  UNRECOGNIZED code is terminal on purpose: guessing "retryable" costs 48s of backoff and still hides
  the reason. An **unserved uid comes back as `permission_denied`, not `not_found`** — the transport's
  served-set-aware rewrite names it and lists available families, but keeps the upstream text, because
  `permission_denied` was also the symptom of the wrong role enum.
- **Field 28 usage is float32 LITTLE-endian** at `28→2→4→2`, selected by the STRING key at `28→2→5`.
  Field 28 is repeated with the groups in unspecified order, so select by key, never by index; an
  absent value means zero. LE reads 16185 tokens where BE reads 2.09e-38.
- **Field 5 (stop_reason) can be ABSENT** (GPT sends none) and is family-specific where present
  (2 on GLM, 4 on Claude, both meaning ordinary completion). A `stop_reason: undefined` is rejected by
  Claude Code, and a numeric→name table would be hardcoded per-model data, so it is DERIVED: any
  tool_use block emitted → `tool_use`, else `end_turn`. Likewise **field 9 (reasoning) is
  family-dependent** — GPT emits it, the Claude family does not even at `-high` — so the thinking
  block must be genuinely optional.

**`max_tokens` is deliberately NOT sent.** Request field 8 fails EVERY request as a length-delimited
message (`invalid_argument` even when empty, while unknown fields 9/11 with the same shape return
200 — so it is field-8 type validation), and as a varint it is accepted and silently ignored: a
budget of 16 produced a complete 326-token answer on claude-sonnet-5-medium and 430 on glm-5-2. Since
Claude Code sends `max_tokens` on essentially every request, encoding the originally-documented
`{2: n}` shape would have broken 100% of Devin turns. Measurements are pinned in
`devin-request.ts`'s header; revisit only with a capture showing field 8 truncating a turn.

**Role enum: 1 = USER, 2 = ASSISTANT, 4 = TOOL_RESULT — never 3.** Public prior art
(`opencode-windsurf-auth`, documenting Windsurf's `LanguageServerService`) says 3, and a 3 here
produces FAMILY-SPECIFIC failures that look transient: `permission_denied` on Claude, "third-party
model provider is experiencing issues" on GLM, while `gpt-5.6-luna` silently tolerates it. An
assistant turn with text *and* N tool calls is encoded as **N+1** messages (one text, then one per
call); a pure tool call carries field 6 and no field 3.

**Layer 4 is force-armed.** The devin profile sets `forceForeignModel: true`, because Devin serves
uids like `claude-sonnet-5-medium` that match ComposedHandler's `^claude-` "native Anthropic" test —
which would switch the behavior supervisor OFF for exactly the models most likely to need it. The
87/87 plan-mode measurement behind that rule is about Claude reached through Anthropic's own harness
and says nothing about a `claude-*` uid re-served over a reverse-engineered endpoint. The flag is
opt-in per profile; every other provider is untouched.

`ProviderTransport.serializeBody?()` is the seam that lets a binary body exist at all, and it is
**default-preserving by construction**: ComposedHandler computes it once and applies
`serialized?.body ?? JSON.stringify(payload)` / `serialized?.contentType ?? "application/json"` at
BOTH fetch call sites (the main request and the 401-retry twin), so the other ~15 transports execute
the identical instruction sequence they always did. It lives on Layer 3, not Layer 1, because the
encoded body embeds the credential — the same reason `transformPayload` is a transport hook.
`supportsVision()` is false, which routes images through the existing vision-proxy path for free.

### Grok Build Provider (`gk@`) — Grok on your SuperGrok / X Premium+ plan

The subscription sibling of the metered `x-ai`: same models, billed by the user's plan instead
of per token. Full verified protocol: `ai-docs/reports/grok-subscription/protocol-spec.md`.

| | `x-ai` (`grok@`, `xai@`) | `grok-subscription` (`gk@`) |
|---|---|---|
| Auth | `XAI_API_KEY` | `claudish login grok` (own OAuth), else the Grok CLI's token |
| Backend | `api.x.ai/v1/chat/completions` | `cli-chat-proxy.grok.com/v1/chat/completions` |
| Billing | pay-per-token | SuperGrok / X Premium+ subscription |

**claudish owns the login: `claudish login grok`, no Grok CLI required.** This is the deliberate
opposite of Antigravity, and the difference is structural. Google registered Antigravity as a
CONFIDENTIAL client, so its rotating `GOCSPX-` secret has to be extracted from the user's own `agy`
binary at runtime; xAI registered the Grok CLI as a **PUBLIC** client (`"none"` in
`token_endpoint_auth_methods_supported`), which is correct for a CLI because a distributed secret
is not a secret. Nothing rotates, so nothing needs chasing. The client id is published in xAI's own
installer, and a local `auth.json`'s id wins when present so a rotation needs no release.

Flow is **RFC 8628 device authorization**, not authorization-code + loopback: claudish frequently
runs where a localhost redirect cannot be received (MCP child, `team` fan-out, remote shell).
`slow_down` raises the poll interval PERMANENTLY per §3.5 — a one-shot bump is rejected on the very
next iteration.

**A clean login is NOT a working credential.** Requesting a sensible-looking subset of the issuer's
`scopes_supported` produced a token the IdP issued happily and the resource server refused:
`403 OAuth2 token missing required scope: api:access`. The authorization server and the resource
server disagree, and only the latter matters. Scopes are therefore matched EXACTLY to the CLI's own
`scope` claim (`…grok-cli:access api:access conversations:read/write workspaces:read/write`), with
`offline_access` load-bearing for the refresh token.

**Credential order is claudish's own store → the CLI's file**, so an existing `grok login`
(`~/.grok/auth.json`) is still reused for free. Own-store first because claudish owns that file
outright — refresh and write-back carry none of the lost-update risk of writing a file the Grok CLI
also owns. Verified live: minting a claudish token does NOT invalidate an existing CLI session.

**The `x-grok-client-version` value is discovered, not pinned.** The gate is a MINIMUM, so a
constant works only until xAI raises the floor — then every request 426s and it takes a release to
fix. Resolution is local install → `https://x.ai/cli/stable` (the same channel pointer xAI's
installer reads, shape-validated so an HTML error page can never be signed into a header) →
constant.

**The file is keyed by an OIDC SCOPE string, not a fixed name** (`https://auth.x.ai::<client_id>`,
with a `https://accounts.x.ai/sign-in` legacy form still parsed by xAI's own installer). The scope
EMBEDS the client id and can rotate, so the entry is selected by `auth_mode === "oidc"` → legacy
scope → lone entry, never by matching a hardcoded literal.

**The token lives 6 hours, so refresh is mandatory** — measured, create→expire exactly 6h. This is
the one structural difference from Devin, whose token is static and whose credential module is
therefore fully synchronous. Refresh is a standard OIDC **public-client** exchange against
`https://auth.x.ai/oauth2/token`: `auth.x.ai`'s discovery document lists `"none"` among its
supported token-endpoint auth methods and the `client_id` is a field in the credential file, so
**no secret is needed** — strictly simpler than Antigravity, which extracts a client_id/secret pair
out of the user's local `agy` binary at runtime.

**Write-back is not optional.** An OIDC server may rotate the refresh token on use, so refreshing
without persisting would leave the user's own `grok` CLI holding a dead token — claudish would have
broken a tool it does not own. The whole file is read-modify-written atomically (temp + rename,
mode 0600) so unrelated scopes and fields survive. Refresh is also **single-flight**: two concurrent
refreshes would have the second present a token the first just invalidated.

**Three client-identity headers are ALL mandatory.** The proxy enforces a minimum CLI version and
answers anything without them `{"error":"Your Grok CLI version (none) is outdated..."}` — on both
surfaces, so it is not a per-endpoint quirk:

```
Authorization: Bearer <key>
x-grok-client-version: <the installed version>
x-grok-client-identifier: grok-shell
```

Header names were recovered from the shipped binary (`strings`, adjacent to `1.0.4`, `grok-shell`,
`cli-chat-proxy`) — the same technique used for Antigravity. **The version is READ from the local
install** (`~/.grok/version.json` → `models_cache.json`'s `grok_version` → a floor constant), never
pinned: the gate is a *minimum* and the user's CLI self-updates, so a literal would guarantee a
future silent breakage of exactly the kind the gate exists to cause.

**Chat Completions is used even though the models declare `api_backend: "responses"`.** Both
surfaces work live. Chat Completions wins because claudish already has a Layer-2 `GrokModelDialect`
(model dialect + reasoning-effort mapping) that applies on that path only; choosing `responses`
would route through the Codex adapter and strand it, for no measured benefit. `--probe grok-4.6`
shows the composition: `openai-sse · GrokModelDialect · 500K`.

**`apiKeyEnvVar` MUST stay `""`.** Unlike Devin — where the reason is that a `Basic <k>-<k>` artifact
cannot survive proxy-server's `Bearer `-stripping extraction — here the extraction would *succeed*
and then CACHE a bearer token past the six hours it actually lives. Empty makes proxy-server skip
the block, so every request goes through the credential authority, the only place expiry is checked.

**`XAI_API_KEY` is deliberately NOT aliased.** That key is the metered `x-ai` credential; honouring
it here would let a pay-per-token key authenticate a provider claudish reports as flat-rate `SUB` —
the exact ambiguity that keeps `openai-codex` out of `SUBSCRIPTION_PROVIDERS`. Because this provider
has no metered path, it is *not* dual-mode and **is** in that set. `GROK_DEPLOYMENT_KEY` (enterprise)
is out of scope for v1 for the same reason: it would reintroduce the ambiguity.

**Bare `grok-*` routes subscription-FIRST** — `["grok-subscription", "x-ai", "openrouter"]`, matching
every other split family. Unlike Devin and Qwen Plan, which are explicit-access-only because their
uids collide with other vendors' namespaces, these ids are xAI's own, so a bare name is safe here.
The provider declares **no `nativeModelPatterns`** (`x-ai` already owns `/^grok-/i`, and patterns are
first-wins on array order); bare-name reachability comes from the routing chain instead.

**The roster is discovered, never pinned.** `/v1/models` is genuinely authenticated (401 without a
token — unlike Alibaba's `coding-intl` roster, where a 200 proves nothing) and the served set is
account-scoped. Note the per-model effort ladders differ — `grok-4.6` offers `xhigh`, `grok-4.5`
does not — which is exactly the drifting per-account data that must not be hardcoded.

### Antigravity Provider (`ag@`) — Gemini via your Antigravity subscription

Two separate Gemini flows, deliberately split:

| Flow | Prefix | Auth | Backend | Billing |
|---|---|---|---|---|
| Direct Gemini API | `g@` / `google@` | `GEMINI_API_KEY` | `generativelanguage.googleapis.com` | pay-per-use |
| **Antigravity** | `ag@` / `antigravity@` | your Antigravity OAuth token (shared with the `agy` CLI) | `cloudcode-pa.googleapis.com/v1internal` | your Antigravity subscription (free / Pro / Ultra) |

`go@` is a **deprecated alias → `ag@`**. Google retired the old "Gemini Code Assist for individuals" tier for gemini-cli's OAuth client (`UNSUPPORTED_CLIENT`); that product is dead, so `go@` now routes to Antigravity with a one-line deprecation notice.

**The `gemini-codeassist` provider was fully REMOVED (v7.36.0)** — definition, transport, credential provider, OAuth registration, quota adapter, probe entry, and the `--gemini-login`/`--gemini-logout` flags. It could not authenticate for any consumer account, yet it sat FIRST in the `gemini-*` routing chain, so every bare `gemini-*` name paid a guaranteed-failing round-trip before falling through to the metered `google` API — silently billing per-token for a model the user's subscription already covered. The chain is now `["antigravity", "google", "openrouter"]`, matching the subscription-first convention every other family already follows. A leftover `~/.claudish/gemini-oauth.json` no longer reads as a live credential (its `oauth-registry.ts` entries are gone), which is what kept a dead provider in the config TUI's Test All list.

The Antigravity half of the old `auth/gemini-oauth.ts` was extracted to **`auth/antigravity-user.ts`** (project/tier resolution, `retrieveUserQuota`, live served-set discovery) before that file was deleted — Antigravity depends on it, so deleting wholesale would have taken `ag@` down too. `retrieveUserQuota` deliberately keeps the gemini-cli User-Agent it was written with: that exact call is verified working on Ultra, and `loadCodeAssist` is known to gate on identity, so changing it is a live experiment, not a tidy-up.

**Why not just spoof the identity:** the backend has two independent gates. `loadCodeAssist` gates the visible *tier* on request identity (`User-Agent` + `metadata.ideType: ANTIGRAVITY`), but `streamGenerateContent` gates *generation* on the OAuth **client that minted the token** — headers can't fake it (403 PERMISSION_DENIED). So claudish does not spoof; it **reuses the user's own Antigravity token**.

**Token lifecycle** (`auth/antigravity-token.ts`, macOS):
- **Shared store**: the same keychain item the `agy` CLI uses — `service=gemini, account=antigravity`, value `go-keyring-base64:<base64(JSON)>` (zalando/go-keyring). claudish reads AND writes it, so both tools reuse one live token.
- **Self-refresh**: when the token is expired, POST `oauth2/token` with `grant_type=refresh_token`. The Antigravity client_id/secret are **never shipped** — they're extracted at runtime from the user's own local `agy` binary (`strings` for the `…apps.googleusercontent.com` id + `GOCSPX-` secret; the working combo is discovered by first-200 and cached). The refreshed (and possibly rotated) token is written back to the shared store.
- **Degradation**: no store (agy not installed / not signed in) or non-macOS → actionable error pointing at `g@` + `GEMINI_API_KEY`.

**Model ids — LIVE discovery, no hardcoded map**: the Antigravity backend requires a reasoning-tier suffix (bare `gemini-3.6-flash` → 404), but which variants a subscription serves is **per-account and drifts**, so claudish never hardcodes a roster. `getServedAntigravityModels()` fetches the live set from the backend's own `v1internal:fetchAvailableModels` (body `{project}`) — the served ids are the response `models` keys, plus a backend `defaultAgentModelId` — cached with a TTL. `resolveAntigravityModelId(requested, servedIds, defaultId)` then resolves against that LIVE set: exact match passes through; a bare family (e.g. `gemini-3.6-flash`) resolves to the backend's `defaultAgentModelId` when it's a variant of that family, else to the strongest reasoning tier by a *rank rule* (`high>medium>low>extra-low>tiered` — a rule, like `rankCodeAssistModel`, not pinned ids); anything else passes through to the F1–F7 404 rewrite. The only literals are the tier-rank ordering and endpoint strings — no concrete model ids in source.

**Identity strings**: `User-Agent: antigravity/cli/<ver> (aidev_client; os_type=<platform>; arch=<arch>; auth_method=consumer)` + `metadata: { ideType: "ANTIGRAVITY" }`. The transport keeps all the F1–F7 improvements from the old codeassist path (terminal-error → 400 surfaced inline, served-set-aware 404 rewrite, `rankCodeAssistModel`). Full reverse-engineering write-up: `ai-docs/sessions/antigravity-refactor-20260803-125333-d0791562/architecture.md` (write-up lost — predates the ai-docs tracking fix).

### Qwen / Alibaba: ONE service, TWO consoles, THREE isolated silos

The single most confusing provider in claudish, so state it plainly:

**Alibaba Model Studio and QwenCloud are the same service.** Two consoles run in
parallel (`modelstudio.console.alibabacloud.com` and `home.qwencloud.com`), neither doc
set mentions the other, and there is no migration notice — which is exactly why it reads
as two products. A QwenCloud account *is* an Alibaba Cloud International account; closing
one kills the other. There is **no `*.qwencloud.com` API host** (`api.qwencloud.com`
serves a placeholder page); every published endpoint is on `aliyuncs.com`.

**qwen.ai OAuth is a genuinely separate, DEAD product** — the `chat.qwen.ai` device flow
(`~/.qwen/oauth_creds.json`) had its free tier discontinued 2026-04-15 with no paid
replacement, and Qwen Code CLI now points at the Alibaba plans. Nothing to support.

What actually splits three ways is the **plan silo**. Alibaba's own words: keys and base
URLs are "completely isolated and must be used in matching pairs" — **every silo rejects
every other silo's key**, with near-identical 401s.

| Silo | Anthropic host (+ `/v1/messages`) | Provider |
|---|---|---|
| Token Plan (subscription) | `token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` | `qc@` → `qwen-cloud` |
| Coding Plan | `coding-intl.dashscope.aliyuncs.com/apps/anthropic` | **not built** |
| Pay-as-you-go (metered) | `dashscope-intl.aliyuncs.com/apps/anthropic` | `qp@` → `qwen-payg` |

`qwen-payg` is deliberately **absent from `SUBSCRIPTION_PROVIDERS`** (it is metered, so it
must show real per-token pricing, never `SUB`) and carries **no `nativeModelPatterns`**
(`qwen-cloud` owns the dotted `/^qwen3\.\d/i` namespace; patterns are first-wins on array
order). Bare-name reachability comes from the `qwen3.*` chain, where it sits AFTER the
subscription — subscription-first, so a user holding both keys is never silently billed
per token for a model their plan covers. `DASHSCOPE_API_KEY` may alias `QWEN_API_KEY`
(both are metered, i.e. one billing mode in two spellings); **neither may ever alias onto
the plan key**, which is the same reasoning as the sakana-subscription precedent.

**Two measurement traps, both of which cost real time:**

- **`coding-intl…/v1/models` is PUBLIC** — it returns the full roster with a bogus key
  and with no auth header at all. A 200 there proves *nothing* about a credential. Always
  re-test a list endpoint with a deliberately bogus key before believing it. By contrast
  `token-plan…/compatible-mode/v1/models` IS authenticated, provable because a fake path
  under the same prefix 404s while the real path 401s.
- **`provider-definitions.ts`'s "a plan key authenticates ONLY against token-plan" was
  generalised from probing ONE Token Plan key.** True for that key; the actual rule is
  symmetric across all three silos.

**Dotted vs hyphenated is a PRODUCT LINE, not a vendor.** `/^qwen3\.\d/i` used to justify
itself by claiming dotted = Model Studio and hyphenated = OpenRouter/HuggingFace. Measured
2026-08-10, false: Token Plan serves only dotted ids (`qwen3.8-max`, `qwen3.7-max`,
`qwen3.7-plus`, `qwen3.6-flash`) while the Coding Plan serves both — `qwen3-coder-plus`,
`qwen3-coder-next`, `qwen3-max-2026-01-23` next to `qwen3.5-plus`/`qwen3.6-plus`. The coder
line and dated snapshots are hyphenated *Alibaba* names.

The pattern is nonetheless CORRECT for `qwen-cloud`, since Token Plan is dotted-only, and a
bare `qwen3-coder-plus` correctly reaches OpenRouter — no silo claudish implements serves
it. **Do not point hyphenated names at `qwen-payg` on the strength of the id shape**:
routing filters by CREDENTIAL, not by model, so an unserved id earns a `400 Model not exist`
and STOPS (400 is non-retryable), the same dead-end documented for `glm-*`. Unlike the
Coding Plan's public list, the PAYG roster is authenticated (401 without a key), so that
change needs a real `DASHSCOPE_API_KEY` to verify against — or routing that consults live
`modelDiscovery` rather than guessing from the name.

### Default Provider Configuration (v7.0.0+)

`defaultProvider` is a **last-resort fallback** appended to every bare-name routing chain. It is not a "front of the line" override — specific patterns (`gpt-*`, `gemini-*`, etc.) still try their normal providers first. `defaultProvider` only catches models whose explicit chain has zero credentialed providers, or models that match no rule at all.

Set it via:

- **Config file**: `"defaultProvider": "openrouter"` in `~/.claudish/config.json`
- **Env var**: `CLAUDISH_DEFAULT_PROVIDER=openrouter`
- **CLI flag**: `claudish --default-provider openrouter "task"`

**Precedence** (highest to lowest):
1. CLI flag `--default-provider`
2. `CLAUDISH_DEFAULT_PROVIDER` env var
3. `defaultProvider` in config file
4. `OPENROUTER_API_KEY` present → `"openrouter"`
5. Hardcoded `"openrouter"`

**Example config**:
```json
{
  "defaultProvider": "openrouter",
  "customEndpoints": { ... }
}
```

Valid values: any built-in provider name (`"openrouter"`, `"openai"`, `"google"`, `"litellm"`, etc.) or a custom endpoint name defined in `customEndpoints`.

**How it interacts with routing rules**: For each bare-name model, `route()` matches against the rules table, builds the candidate chain, then **appends `defaultProvider` to the end** if it isn't already in the chain (deduped against shortcuts — `or` and `openrouter` are treated as the same provider). The combined chain is then credential-filtered. Explicit `provider@model` specs are not affected — `defaultProvider` only applies to bare names.

**No more LiteLLM auto-promotion** (removed in commit 5 of the model-catalog and routing redesign): Setting `LITELLM_BASE_URL` + `LITELLM_API_KEY` no longer makes LiteLLM the default. Users who want LiteLLM as the catch-all must set `defaultProvider: "litellm"` explicitly.

### Vendor Prefix Auto-Resolution (ModelCatalogResolver)

API aggregators (OpenRouter, LiteLLM) require vendor-prefixed model names that users shouldn't need to know. The `ModelCatalogResolver` interface searches each aggregator's dynamic model catalog to find the correct prefix automatically.

**How it works**: User types bare model name → resolver searches the provider's already-fetched model list → finds the exact match with vendor prefix → sends the prefixed name to the API.

**Current resolvers**:
- **OpenRouter**: `or@qwen3-coder-next` → searches catalog → sends `qwen/qwen3-coder-next`
- **LiteLLM**: `ll@gpt-4o` → searches model groups → finds `openai/gpt-4o` (prefix-strip match)
- **Static fallback**: `OPENROUTER_VENDOR_MAP` for cold starts when catalog isn't loaded yet

**Key design rules**:
- Exact match only — no fuzzy/normalized matching. Find the right prefix, don't guess the model.
- Dynamic catalogs (from provider APIs) are PRIMARY. Static map is cold-start fallback only.
- Resolution happens BEFORE handler construction (in `proxy-server.ts`), not inside adapters.
- Sync entry point (`resolveModelNameSync()`) — uses in-memory caches + `readFileSync`, no async propagation.

**Firebase slim catalog** (v7.0.0+): The `aggregators[]` field on model documents provides a typed multi-provider routing index. Each entry is `{ provider, externalId, confidence }`. Claudish only consumes this hosted catalog at runtime. Catalog extraction, recommendation generation, portal hosting, and API documentation live in the [models-index](https://github.com/MadAppGang/models-index) repo.

**Adding a new aggregator resolver**: Implement `ModelCatalogResolver` interface in `providers/catalog-resolvers/`, register in `model-catalog-resolver.ts`. No changes to proxy-server or provider-resolver needed.

**Architecture doc**: `ai-docs/sessions/dev-arch-20260305-104836-a48a463d/architecture.md` (write-up lost — predates the ai-docs tracking fix)

### The interactive picker roster is DERIVED — never add a membership table

Bare `claudish` shows "Select provider:" from `model-selector.ts`. That list used to be a
hand-written `ALL_PROVIDER_CHOICES` array, so **membership was opt-in and a new provider
defaulted to invisible**. `devin` and `antigravity` were both fully working — routing,
`--probe`, and the config TUI (which has always derived its list from `getAllProviders()`) —
while absent from the picker. `3a293b9` even built Antigravity's correct 20-model roster for
a provider the picker could not offer.

The v7389502 credential refactor is the trap here: it unified availability **checking** (it
deleted the three duplicate readiness oracles) and left the **roster** alone. Unifying how a
list is filtered is not the same as unifying what is in it.

- `isPickableProvider(def)` = `def.shortcuts.length > 0`. A definition with no shortcuts has
  no user-typeable `@` prefix and exists only so `nativeModelPatterns` can steer a BARE name;
  `qwen` and `native-anthropic` are the two, and both carry an empty `baseUrl`/`apiPath`.
  A rule, not a roster — there is no exclusion list to keep current.
- `PICKER_COPY` and `PICKER_ORDER` are **editorial only**: labels and ordering. Anything
  unlisted still appears, at the end. Never use either as a membership gate.
- The `@prefix` filter aliases (`getProviderFilterAliases`) are derived the same way, from
  each definition's name + `shortcuts`, because that table had drifted identically — `@dv`
  matched nothing. Alias insertion order follows `PICKER_ORDER` so an ambiguous partial like
  `@op` resolves to the first row the user actually sees (OpenRouter).
- The emitted prefix comes from `shortestPrefix`; `PROVIDER_MODEL_PREFIX_OVERRIDE` holds only
  four readability aliases. The danger the old map created was returning **undefined**, which
  makes `buildExplicitModelSpec` hand back a BARE id — for Devin that is
  `claude-opus-5-medium`, which matches native-anthropic's `/^claude-/i` and is answered by a
  different provider entirely. (`parseModelSpec` passes an unrecognized prefix through
  verbatim — `model-parser.ts:160` — so a canonical NAME also resolves; assert the parser
  round-trip, not membership in `shortcuts`.)

The drift test is `buildProviderChoices()` ⊇ every pickable builtin. It asserts CONTAINMENT,
not equality: runtime custom endpoints legitimately appear too (a real gain — the old array
could never show one), so equality made the test order-dependent on whichever sibling test
file had registered one.

### Subscription pricing is decided by BILLING, not by `modelDiscovery`

`SUBSCRIPTION_PROVIDERS` (`handlers/shared/remote-provider-types.ts`) drives both the picker's
`SUB` label and `getModelPricing`'s zero-cost verdict, so a missing entry quotes a flat-rate
user a per-token rate they do not pay — and TokenTracker then accrues fictional spend.

Two paths render a price and only one used to ask the question: a provider WITH
`modelDiscovery` goes through `buildDiscoveredModelRows` (which asks), everything else goes
through `resolveProviderDisplayPrice` (which did not). That is why a missing entry was
invisible on one path and merely wrong on the other. `resolveProviderDisplayPrice` now checks
`isSubscriptionProvider` FIRST, ahead of both the aggregator and model-level rates.

Found by that audit and added: `antigravity` (was N/A) and `sakana-subscription`, alongside
the already-listed `minimax-coding` / `glm-coding`, which were quoting their metered
siblings' dollar rates. When adding a provider, ask "does the user pay per token?", not
"does it declare discovery?".

**`openai-codex` is deliberately NOT in the set**, and the reasoning generalises. It was
added in the same pass — its picker row literally says "ChatGPT Plus/Pro subscription" — and
a multi-model review caught it. The provider is DUAL-MODE: `oauthFallback:
"codex-oauth.json"` is the subscription, but `apiKeyAliases: ["OPENAI_API_KEY"]` means a
plain metered key authenticates `cx@` just as well. So the flat-rate answer is right for one
credential and wrong for the other. **The two errors are not symmetric**: quoting a dollar
rate to a subscriber is a cosmetic over-estimate, while reporting `SUB` (and zero accrued
cost) to someone OpenAI is metering silently under-reports real money. Membership is a
property of the provider NAME today; until it can be decided from the credential actually in
play, a dual-mode provider stays out. `antigravity` (no `apiKeyEnvVar` at all) and
`sakana-subscription` (which deliberately does not alias the PAYG `SAKANA_API_KEY`) have no
such ambiguity.

## Local Model Support

Claudish supports local models via:
- **Ollama**: `claudish --model ollama@llama3.2` (or `ollama@llama3.2:3` for concurrency)
- **LM Studio**: `claudish --model lmstudio@model-name`
- **Custom URLs**: `claudish --model http://localhost:11434/model`

### Context Tracking for Local Models

Local model APIs (LM Studio, Ollama) report `prompt_tokens` as the **full conversation context** each request, not incremental tokens. The `writeTokenFile` function uses assignment (`=`) not accumulation (`+=`) for input tokens to handle this correctly.

## Context Window and Auto-Compaction (v7.24.0+, status line v7.28.0+)

Claude Code resolves its compaction point as `min(CLAUDE_CODE_AUTO_COMPACT_WINDOW, maxContextTokens(model))`, and `maxContextTokens` falls back to a hardcoded **200,000** for any model name it does not recognise — which is every model claudish proxies. Setting only the first lever therefore accomplishes nothing: the real window is accepted and then thrown away by the `min()`. `resolveContextWindowEnv()` (`claude-runner.ts`) sets **both**, and Claude Code honours `CLAUDE_CODE_MAX_CONTEXT_TOKENS` only for model names not starting with `claude-`, i.e. exactly the pure-proxy case.

**The env is read at SPAWN and never revisited.** A long-running claudish process keeps whatever window it was launched with; upgrading the package on disk does nothing for a live session. Diagnosing this is easy once you know the tell: inside ONE pre-fix process, subagents pinned to `model: "opus"` (a name Claude Code knows as 1M) compact at ~340K while the main thread on the proxied model compacts at ~170K. Ground truth is `compactMetadata.preTokens` in the Claude Code transcript.

**The status line reports the ENFORCED window, not the spec window.** `TokenTracker.writeFile` derives `context_left_percent` from `inputTokens` alone — folding in the session-CUMULATIVE `outputTokens` made the value decay with session AGE and pin at 0 forever once lifetime output passed the window (measured: input 94,018 of a 372,000 window reporting 0% left). Both generated status-line variants then recompute against `min(spec window, CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? 200000, CLAUDE_CODE_AUTO_COMPACT_WINDOW)` and render `18% (164k/200k of 372k)` when those disagree, so a clamp is visible on day one instead of costing days of half-context work.

The status line is a generated **shell one-liner** (and a generated JS file on Windows), so TypeScript cannot catch a typo in it — test the generated artifact by executing it (`status-line-context.test.ts`). `CLAUDISH_TOKEN_FILE` redirects `TokenTracker`'s output path for hermetic tests; do NOT try to move `HOME`, since `homedir()` cannot be re-pointed at runtime in Bun. Bash integer division truncates where JS `Math.round` rounds, so the bash variant uses `((x*200/w)+1)/2` to keep both platforms on the same number.

## Custom Endpoints (v7.0.0+)

Define named custom endpoints in `~/.claudish/config.json` under the `customEndpoints` key. Each endpoint registers as a provider prefix usable with `@` syntax.

### Config schema

**Simple endpoint** (most common):
```json
{
  "customEndpoints": {
    "my-vllm": {
      "kind": "simple",
      "url": "http://gpu-box:8000",
      "format": "openai",
      "apiKey": "${VLLM_API_KEY}",
      "modelPrefix": "my-org/",
      "models": ["llama3.1-70b", "qwen2.5-72b"]
    }
  }
}
```

**Complex endpoint** (full control):
```json
{
  "customEndpoints": {
    "corp-proxy": {
      "kind": "complex",
      "displayName": "Corporate LLM Proxy",
      "transport": "openai",
      "baseUrl": "https://llm.corp.internal",
      "apiPath": "/api/v2/chat/completions",
      "apiKey": "${CORP_LLM_KEY}",
      "authScheme": "x-api-key",
      "headers": { "X-Team": "platform" },
      "streamFormat": "openai-sse",
      "modelPrefix": "",
      "models": ["gpt-4o", "claude-sonnet"]
    }
  }
}
```

Use as: `claudish --model my-vllm@llama3.1-70b "task"` or `claudish --model corp-proxy@gpt-4o "task"`.

### Key details

- **`${VAR_NAME}` expansion**: The `apiKey` field expands environment variables at startup. Use this instead of hardcoding secrets in config.
- **Zod validation**: Claudish validates all custom endpoints at proxy startup. Invalid entries emit a stderr warning and are skipped — they don't crash the proxy.
- **Runtime registration**: Endpoints call `registerRuntimeProvider()` and `registerRuntimeProfile()` to inject themselves into the provider resolver and transport layers.
- **`models` field** (optional): When present, limits the endpoint to listed models. Omit to allow any model name.
- **`modelPrefix` field** (optional): Prepended to the user-specified model name before sending to the API.
- **`authScheme` is a lowercase enum** — `"bearer"` or `"x-api-key"` (`config-schema.ts`). A capitalized `"X-Api-Key"` fails Zod validation and the WHOLE entry is skipped with a stderr warning, which reads as "my endpoint disappeared" rather than as a typo. This doc carried the wrong spelling until v7.48.0; the example above is the validated one.

## Predefined Endpoints (unreleased — ships in the next minor)

A **predefined endpoint** is a `customEndpoints` entry that ships inside the package. The user gets `groq@llama-3.3-70b` with no config file at all, and adding vendor N+1 is appending one object literal to `providers/predefined-catalog.ts` — no new transport, no `PROVIDER_PROFILES` row, no `provider-definitions.ts` entry, no other file touched. That constraint is the feature: the two-table coupling between `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES` is this project's documented worst failure class (a missing profile routes silently to OpenRouter), and a catalog row cannot create one because it never becomes a builtin. A row compiles into exactly the `CustomEndpointComplex` object a user would have hand-written and travels the same validate → definition → profile → register×3 path.

25 vendors ship. PR #136 (@cerebrixos) proposed one of them — `tuningengines` — as a full built-in provider; it lands here as a data row instead, which is a better outcome for that PR than closing it.

### Activation is gated on a LOCALLY-PRESENT credential

A row registers only when its key is already in `process.env`, one of its aliases, or `config.apiKeys`. Not because 25 dead providers would be untidy — because registration is what makes a provider visible at all. `buildProviderDefinition` sets `shortcuts: [name]`, and both the picker roster and the `@prefix` alias table are DERIVED from that, so registering unconditionally would pollute the `@prefix` namespace and its partial-match resolver with vendors that cannot serve a request, and would cost one async credential resolution per row per picker open — each able to open a 1Password handshake on a machine where concurrent handshakes are arbitrated globally and a burst of denials trips a 15-second machine-wide suppression.

Which is why the question is asked with `hasLocalApiKey()` — env → aliases → `config.apiKeys`, **sync**, structurally unable to reach the SDK. Not `credentials.isAvailable()`: a bundled row is not in the authority's map until `registerEndpoint` puts it there, so that call answers `false` for every row and the catalog would never activate at all.

**The honest consequence: a key that lives ONLY behind an `op://` reference will not make its vendor appear.** Activation is sync and 1Password is async; there is no ordering that fixes this without re-opening the handshake-storm door. Once a row IS active its op:// key resolves through the normal authority path with no special-casing. Two escape hatches, both explicit:

```json
{ "predefinedEndpoints": {
    "enabled": true,
    "enable": ["groq", "cerebras"],
    "disable": ["perplexity"] } }
```

`enable` registers a row regardless of credential; `disable` beats `enable`; `"enabled": false` (or `CLAUDISH_NO_PREDEFINED_ENDPOINTS=1`) turns the whole catalog off. An INVALID `predefinedEndpoints` block warns once and is treated as ABSENT rather than as "off" — a typo in an opt-out section must not silently remove providers a user relies on.

**Disabling requires a RESTART, and claudish now says so.** Re-evaluation (`ensureEndpointsRegistered({ force: true })`, which the config TUI runs after a key import) can only ADD: `registerRuntimeProvider` is a `Map.set` with no removal, and the same name is simultaneously live in the credential authority, in the derived `@prefix` alias table and in any handler cache built since. De-registration was considered and NOT built — a partial removal (definition gone, credential still registered) is a provider that half-exists, which is worse than a stale one, and its only consumer is a config edit made mid-session. The actual defect was silence: "I turned it off and it kept answering" reads as a bug rather than as a documented limit. So a row that this process registered and that is no longer eligible — disabled, catalog switched off, credential gone, or now replaced by a `customEndpoints` entry — emits one warning naming the reason and stating that a restart is required.

The refusals (collision with a builtin, duplicate row, already registered, replaced by user config) are checked BEFORE the permissions. A user may opt in to a vendor they have no key for; a user may not opt in to shadowing a builtin, because that is one provider quietly answering in another's namespace.

### A user `customEndpoints` entry REPLACES a bundled row entirely

No deep merge. The user's entry is registered by `loadCustomEndpoints` at its own call site and the bundled row simply stands aside — suppression rather than write-order, because `ensureEndpointsRegistered()` runs from six sites and "whoever registers last wins" is a guarantee a future reordering would silently flip.

The consequence worth stating: **the replacement does not inherit the vendor's conventional env var.** A hand-written `customEndpoints.groq` gets `CUSTOM_GROQ_KEY`, so a perfectly good `GROQ_API_KEY` sitting in the environment is now ignored — silently, and from neither file's point of view. Claudish warns about this exactly when it can bite (the vendor's own variable is actually set) and says the fix: add `"apiKey": "${GROQ_API_KEY}"` to your entry. It stays quiet otherwise, because an unconditional line would print on every launch of a correct config, into a stderr that during an interactive session is Claude Code's own TTY.

### Base-URL override (R12): a malformed override SKIPS, it does not fall back

Gateway-shaped vendors declare `baseUrlEnvVars` — `tuningengines` carries `TUNING_ENGINES_BASE_URL`, the variable PR #136 shipped — because a self-hosted instance does not live at the public hostname and without the override those users cannot use the bundled row at all.

The override is read through **`baseUrlOverrideCandidates()`, the same chain `getEffectiveBaseUrl()` uses**: `config.endpoints[VAR]` (what the config TUI's URL editor and `claudish config` persist) for every declared variable, then `process.env[VAR]` for every declared variable, then the bundled default. Config wins as a TIER, not per variable — matching the `apiKeys` rule. One resolver, because an earlier revision had two: this path read `process.env` only, and since the TUI writes BOTH the config entry and the env var it looked correct for the rest of the session and diverged after a restart, at which point the TUI still DISPLAYED the saved private URL while requests went to the bundled public host. UI says private, wire says public — the same data-egress class as a silent fallback, inverted.

If the override is set but malformed, the row is **skipped with a warning** — from either source. It does NOT silently fall back to the bundled public URL. The reasoning is data egress: a user who exported `TUNING_ENGINES_BASE_URL` did so to keep their prompts inside their own network, and a typo that quietly redirected the traffic to a vendor's public host would send exactly the data they were isolating to exactly the place they were isolating it from. A provider that fails to appear is diagnosable in one warning line; a provider that appears and sends conversations somewhere unintended is not diagnosable at all. The check runs at the gate AND at handler build — at the gate so a bad override never produces a provider that cannot serve, at handler build so a URL exported AFTER startup is checked too.

### Evidence tiers — ALL 25 rows are probe-verified. NONE is live-verified.

Every row carries `evidence` and it is never read at run time; it exists for the catalog invariant test, `claudish providers --json`, and the reviewer of the next vendor PR.

- `tier: "live"` — a real turn was driven through claudish with a real key. **No shipped row carries this tier.**
- `tier: "probe"` — a POST to the CONFIGURED chat path with a deliberately invalid key was answered by the vendor's own auth layer (`verdict: "auth-realm"`, 401/403) or by its model gate (`verdict: "model-gate"`, the route resolved and rejected a nonexistent model), and the reply DIFFERED from a deliberately bogus sibling path.

**25 of 25 are `probe`; 0 are `live`.** Live verification needs a paid account per vendor, and claudish holds a key for none of them. Say exactly what the probe method does and does not establish, because the difference decides what a bug report against one of these rows means:

- It is **strong evidence about ROUTING** — that `baseUrl + apiPath` reaches a live endpoint which authenticates, and that the configured path is the vendor's real one rather than a catch-all. The sibling-path comparison is what buys that: a bogus sibling answering differently proves the route resolved. It exists because pass 1 ("401/403 with a JSON `error` object?") produced four false negatives, and because a status alone proves nothing about a route.
- It is **weak evidence about the vendor's STREAMING DIALECT.** A 401 says nothing about SSE chunking, tool-call encoding, `finish_reason` vocabulary or error-body shape on a successful turn. Those remain untested per vendor until someone holding each key runs a turn.

`GET /v1/models` is **never** evidence here: Alibaba's `coding-intl` roster endpoint returns its full list to a bogus key and to no key at all.

**The LAYER itself is verified end to end, live.** A shipped catalog row (`tuningengines`, whose `apiPath` is byte-identical to OpenAI's) was pointed at `https://api.openai.com` via its own `TUNING_ENGINES_BASE_URL` override with a real key, and produced correct model output through the whole path — catalog → credential gate → compile → collision check → runtime registration → explicit `provider@model` routing → `OpenAIProviderTransport` → SSE parse → stdout — with no source change. The invisible-without-a-key gate, the malformed-override refusal and the placeholder-is-unset rule were confirmed on real traffic at the same time. Transcript, debug-log line numbers and the exact wire URL: `ai-docs/reports/predefined-endpoints/live-run.md`. That run proves the mechanism for every row; it proves the DIALECT of none of them, including Tuning Engines' own (the row was deliberately pointed away from its vendor).

Measured 2026-08-14: **DeepInfra** (`/v1/openai` + `/chat/completions`), **Novita** (`/v3/openai` + `/chat/completions`) and **Perplexity** (`/chat/completions`, no `/v1`) do not use `/v1/chat/completions`. That is why `apiPath` is REQUIRED with no default — an optional field with a default makes the failure mode *omission*, and omission is invisible in review.

Two rows (`parasail`, `writer`) return non-OpenAI error shapes and say so in `evidence.note`. Probed against claudish's own classifiers: both are 401s, so `isTerminalError` returns true on the status before any body is inspected, they are remapped to a 400 surfaced inline, and the 3s/15s/30s in-stream ladder is structurally unreachable (it is gated on HTTP 200 + `openai-responses-sse`/devin). `JSON.parse` failures are caught. The degradation is one long unparsed line for Writer, whose message lives at `errors[0].description` where `extractProviderMessage` does not look. Full write-up: `ai-docs/reports/predefined-endpoints/error-shape-probe.md`.

### No model data, ever (R7)

The schema is `.strict()` and has no `models`, `contextWindow`, `maxOutputTokens`, `pricing`, `capabilities` or `modelDiscovery` field, so a future contributor cannot add one by accident — an unknown key is a parse error, not a silently ignored field. A shipped roster is exactly the hardcoded model data this project forbids: it rots the moment a vendor adds a model, and the failure shape is claudish refusing a model that actually works. So a catalog vendor gets a **free-text model prompt** in the picker rather than a list. Model metadata comes from models-index or is absent.

### The caveat: activation infers intent from an ambient env var

A user who exported `PERPLEXITY_API_KEY` for some unrelated tool silently gains a claudish provider they never asked for. That is real, and it is stated rather than argued away.

It is acceptable for one specific reason: **nothing claudish ships puts a catalog row in a bare-name routing chain.** No row declares `nativeModelPatterns` (the schema has no such field), none owns a legacy prefix, and none appears anywhere in `DEFAULT_ROUTING_RULES` — all three are pinned by `predefined-containment.test.ts`, the third because it is the one a future contributor can open with a single well-meaning edit ("`llama-*` should try Groq first"). So a row is reachable only by typing `perplexity@model` — the same explicit-access rule Devin and Qwen Plan already follow, for the same reason. The cost of the wrong inference is therefore one extra row in a picker, never a request billed to a provider the user did not choose.

The one qualification, stated because the absolute version is false: `route()` appends `defaultProvider` to EVERY bare chain, so a user who sets `"defaultProvider": "groq"` really does put a catalog row in bare chains. That is explicit user action naming the vendor, not a silent path, so the safety argument survives — but "can never" does not. If a catalog row ever becomes bare-name reachable WITHOUT the user naming it, this gate has to be revisited, because the inference would then be able to move money.

## 1Password Integration (v7.6.0+)

All 1Password logic lives in `packages/cli/src/providers/onepassword.ts` (dependency-light: imported by `index.ts` before heavy deps; uses only node built-ins at module load). Secret operations are **SDK-only** — the `@1password/sdk` is **dynamically imported** (`await import` inside `defaultSdkClientFactory`) only when SDK auth is present AND a secret/field/environment is actually needed — a normal run never loads the ~10MB WASM. **Requires the beta** `@1password/sdk@0.4.1-beta.1` (exact pin): the stable 0.4.0 has no `environments` API.

### Resolution model: SDK-ONLY (no `op` CLI for secrets)
- **All three operations** — resolving `op://` refs (`secrets.resolveAll`), glob field discovery (`vaults.list` → `items.list` → `items.get`), and Environments (`environments.getVariables`) — go through the SDK. There is **no `op` CLI fallback**.
- Public async entry points: `resolveSecrets()`, `readEnvironment()`, `discoverItemFields()`/`resolveGlobImport()`. All accept `{ sdkFactory?, auth?, env? }`; `acquireSdkClient()` is the shared "resolve auth → build client → hard-fail if no auth" helper.
- **Hard-fail** on any failure including no-auth (explicit opt-in via `op://` or `--op-env`); **zero cost** (no SDK/`op` touched) when no op:// source is present.
- The **one** remaining `op` binary touch is an **optional, read-only `op account list --format=json`** (`defaultOpAccountLister`) used SOLELY for the multi-account picker — it never sees a secret and degrades to an actionable error when `op` is absent.

### Auth resolution (DesktopAuth account selection)
`detectSdkAuth(env)` is env-only: `OP_SERVICE_ACCOUNT_TOKEN` → token; else `OP_ACCOUNT` → DesktopAuth. The richer `resolveSdkAuth(opts)` (async, called once by `index.ts` and memoized via `getSdkAuth()`, so a multi-account user is prompted at most once per run) resolves in order: **token → `OP_ACCOUNT` → `onepasswordAccount` config (global `~/.claudish/config.json`, local `.claudish.json` wins) → single auto-detected account (`op account list`) → interactive picker (multiple accounts + TTY; the choice is saved to global config) → hard-fail** (multiple accounts non-interactive, or `op` absent). The account **URL** (e.g. `my-team.1password.com`) is the saved/`OP_ACCOUNT` value — it's unique even when two accounts share an email. The SDK cannot reuse an interactive `op signin` session, so an `op signin`-only setup must now set `OP_ACCOUNT` (DesktopAuth) or a service-account token.

### Locked-screen denial recovery (v7.20.0+)
1Password returns the SAME error for two different situations: the user saw the desktop approval dialog and clicked **Cancel** (a decision), and the Mac was **locked** so the dialog could not be shown at all and 1Password auto-denied (an environmental condition). Both read `Denied authorization for SDK client`, which is why `isTransientSdkError` pins any denial as TERMINAL — retrying a Cancel re-opens the dialog the user just dismissed (the "second dialog" bug, commit `aa71ce3`). That guard is **unchanged**.

The ambiguity is resolved from OUTSIDE the error, by probing screen-lock state: `defaultScreenLockProbe` runs `ioreg -n Root -d1 -a` and matches `CGSSessionScreenIsLocked` (present only while locked; ~15ms; darwin-only — other platforms return false and keep terminal behavior). `isLockedDenial(err, env)` = denial **&&** no `OP_SERVICE_ACCOUNT_TOKEN` (token auth never shows a desktop prompt, so waiting would be theatre) **&&** screen locked. `withSdkRetry` now **wraps** the transient-IPC loop (`withSdkTransientRetry`) in an OUTER lock-round loop, keeping the two time domains separate: the inner loop owns millisecond-scale IPC blips (150ms·attempt), the outer owns the human-scale "go unlock your Mac" wait. Every non-locked-denial error propagates from the inner loop unchanged.

On a locked denial the user gets a friendly explanation (printed ONCE, on round 1 — re-explaining every 10s reads as nagging) plus a 10-second countdown, up to `LOCK_RETRY_ROUNDS` (3) → 3 retries ≈ 30s. The countdown **breaks early** the moment the probe reports unlocked, so approving is immediately followed by the prompt. Cancellation degrades by CAPABILITY, not by mode (interactive and non-interactive must behave identically — an explicit product decision): TTY stdin → Esc/q/Ctrl-C; otherwise Ctrl-C via SIGINT. The live `\r\x1b[2K` redraw and ANSI styling apply ONLY when `process.stderr.isTTY` (checked at call time, not module load) — under an MCP host or channel session stderr is a captured pipe, which gets one static line per round instead. Test seams: `setScreenLockProbe()` and `setLockRetryTiming({seconds, tickMs})` — the latter is MANDATORY in tests or the suite gains 30 real seconds.

**A THIRD recoverable cause: `peer`.** `LockCause` is now `"screen" | "app" | "peer"`. A peer denial is another LIVE claudish holding `~/.claudish/op-handshake.lock` — a sibling standing at the 1Password prompt right now. It is EVIDENCE, not inference: the lock is written `O_EXCL` by exactly one process, carries its pid, and is removed the instant its handshake returns, so a live foreign holder means precisely "wait and you will get your turn". It cannot be confused with a real Cancel, because a Cancel happens INSIDE the holder's own handshake and the denied peer holds nothing — so the `aa71ce3` guard is untouched. Precedence is screen → app → peer: waiting behind a sibling is pointless while the Mac is locked, since the sibling cannot finish either.

`setPeerLockProbe()` is **MANDATORY** in any test asserting a denial is terminal. The default probe reads a real file under `~/.claudish`, so without the seam the verdict depends on whether an unrelated claudish happens to be mid-handshake — which is how the seam came to exist: a sibling worktree's live run turned "unlocked denial is terminal" into a 30-second countdown, and the 1Password suite from 4.8s into 35.8s.

**The countdown offers an exit as well as a wait.** `countdownForUnlock` returns `"retry" | "cancel" | "skip"`. `s` (TTY stdin) → skip, which sets `process.env.CLAUDISH_DISABLE_OP=1` so 1Password is skipped for the REST OF THE RUN — a bare model name walks a routing CHAIN, so one refusal otherwise buys three more countdowns for the same run. Reusing that existing kill switch means no second flag to keep in sync, but it required moving the `CLAUDISH_DISABLE_OP` test OUT of `computeHasOpSources` and to the top of `hasOpSources`, ahead of the `sniffed` memo: by the time a denial has happened the memo is certainly populated, so behind it the skip silently did nothing.

**The raw SDK error is never shown.** `humanizeOpError` maps a denial to its cause (`your Mac is locked…` / `the 1Password app is locked…` / `another claudish process is holding the 1Password prompt` / `…was dismissed (or never answered)`) and strips the Rust `Error { msg: …, inner: None }` wrapper from everything else. DISPLAY ONLY — `recordOpFailure` still stores the RAW message, because `wasOpAuthorizationDenied` matches on that wording.

### Concurrent-spawn denial prevention (v7.22.0+)

A THIRD situation produces the same `Denied authorization for SDK client`, and unlike the two above it is neither a decision nor a lock state: **several claudish processes racing the DesktopAuth handshake at once**. 1Password arbitrates that handshake across the whole MACHINE, not per process — it authorizes ONE client and instantly denies every concurrent peer. `runSdkExclusive` serializes SDK calls WITHIN a process (the `-4` IPC fix), but `team-orchestrator.ts` and channel `create_session` spawn N sibling PROCESSES, each building its own client, and no in-process queue can span those.

Measured on a real 7-model `team` run (session `team-20260729-163623`): all seven children spawned within 6ms, five hit the denial, and only the models whose key was already in the shell env survived — `errors/01.log` shows a model that COMPLETED while still logging two denials. Reduced repro with lock state held constant (unlocked in both arms): 6 children in a tight loop → **5 denied**; the same 6 staggered 4s apart → **0 denied**; a single child → fine. So this is not the locked-screen case and the lock probe does not fire for it (`isLockedDenial` requires a locked screen, and a denial while unlocked stays TERMINAL).

The fix PREVENTS the race rather than recovering from it: `auth/credentials/prehydrate.ts`'s `prehydrateCredentialsForSpawn(models)` runs `validateApiKeysForModels` in the PARENT before any child is spawned. The authority write-throughs each resolved op:// key into `process.env` (api-key-credential.ts), children inherit `process.env`, so they find the key in step 1 of the chain and never construct an SDK client at all — exactly the state the surviving models were already in. One serialized resolve, one handshake, regardless of model count (a 1Password Environment is fetched once per process via the single-flight memo). Called at both spawn sites; NEVER throws (a credential that cannot be pre-resolved just stays missing and the child reports it as before — failing the spawn would turn "one model has no key" into "the whole team run died").

This covers every spawn site claudish owns, but it is not the whole fix — see the next section.

### The denial is SELF-AMPLIFYING, and the handshake lock (v7.25.0+)

Measured 2026-07-31 with a bare `@1password/sdk` probe — no claudish in the picture, screen unlocked, app unlocked (`ai-docs/sessions/op-denial-rootcause-20260731-153357-90bf2332/`): 1 process → authorized; **6 concurrent → 1 authorized, 5 denied in 945–1029ms**; 6 concurrent behind a cross-process lock → **6 authorized, 0 denied**. Two structural facts came out of it: the denial fires on **`createClient()` — the handshake**, not the secret fetch; and an already-authorized client is **not** revoked when a peer authorizes. So the lock needs to cover the handshake ONLY.

1Password's own log names the mechanism:

```
WARN  [1P:op-automated-unlock/src/lib.rs:620] Suppressing Automated Unlock for 15s.
      Too many denied attempts in a short time period.
```

The handshake is gated by **Automated Unlock**, and a burst of denials trips a **15-second global suppression** during which EVERY request is denied instantly — including sequential ones from unrelated processes. One race poisons the next 15 seconds for all of claudish, which is why the failures looked erratic and why a single collision could cost a team run several models. It also confounds naive A/B measurement: an arm run seconds after a failing arm measures the penalty box, not the change. **Separate measurement arms by ≥40s.** Denial latency is a real discriminator — suppression returns in ~190ms, a successful authorization takes ~1.5–1.9s, a human Cancel takes seconds.

Two additions, both preventive:

- **`providers/onepassword-handshake-lock.ts`** — `withHandshakeLock()` wraps `createClient()` in `defaultSdkClientFactory`, **DesktopAuth only** (a service-account token is authorized by its value; there is nothing to arbitrate). `O_CREAT|O_EXCL` at `~/.claudish/op-handshake.lock`, jittered poll, dead-holder detection via `kill(pid, 0)`, 120s stale-steal (generous ON PURPOSE — the handshake can block on a human clicking Authorize, and stealing mid-approval recreates the race), 45s acquire timeout then proceed unlocked. Never throws, never blocks a run indefinitely: the lock is an optimisation of WHEN, not a gate on WHETHER. `CLAUDISH_NO_OP_HANDSHAKE_LOCK=1` bypasses; `CLAUDISH_OP_LOCK_TRACE=1` emits one stderr line per transition — added because a lock that silently fails to engage is indistinguishable from no lock, which is exactly how the confounded arm above was caught. This closes the INDEPENDENT-process case that no parent/child protocol can reach. Test seams: `setHandshakeLockTestSeams({path, timing})` — MANDATORY in tests or the suite inherits the 45s timeout.
- **The `CLAUDISH_OP_UNAVAILABLE` skip-list** — pre-hydration only covers keys 1Password CAN supply. A bare model name filters a CHAIN; the parent short-circuits at the first credentialed candidate while each child walks the chain from the top, so candidates 1Password has nothing for still send every child to the SDK. `op-source.ts` records the names a CLEAN resolve came back empty for; `prehydrateCredentialsForSpawn` publishes them to children, and children drop those names before resolving. **Published ONLY when `getOpFailures()` is empty** — a denial also produces an empty resolve, and publishing that would teach every child that a key the user really does store in 1Password is permanently absent, turning one transient denial into a run-wide outage. Children apply the INHERITED list only; within a process a miss stays uncached, as `api-key-credential.ts` intends.

Concretely, on the developer's own config the Environment holds CODING-PLAN credentials — `GLM_CODING_API_KEY` (claudish's `gc@` GLM Coding Plan provider, alias `ZAI_CODING_API_KEY`) and `GOOGLE_GEMINI_API_KEY` — while the chain for a bare `glm-*` / `gemini-*` name also probes the PAYG names `ZHIPU_API_KEY` / `GLM_API_KEY` / `GEMINI_API_KEY`. Those are **different credentials on different billing plans, not misspellings of each other**: they are absent from the Environment because they genuinely do not belong there, and aliasing one onto the other would silently bill the wrong plan. So the PAYG lookups can never resolve, and before the skip-list every child opened an SDK client to chase them.

**Not built:** retrying a denial once the 15s suppression expires. `isTransientSdkError` pins denials as TERMINAL to prevent the "second dialog" bug (`aa71ce3`), and relaxing that needs its own decision; the ~190ms latency signature is the evidence that would justify it. (The `peer` cause above is NOT this: it waits on positive evidence of a live lock holder, not on a latency guess, and it never retries a denial that could have been a Cancel.)

### Parent-side route pinning — one dialog per multi-model run (v7.38.0+)

Pre-hydration hands the child the KEY but still passed a BARE model name, and a bare name is a routing CHAIN. `validateApiKeysForModels` asks the authority about the one provider `resolveModelProvider` picked and stops there — `rescueRoutableResolutions` only walks the rest when that first verdict was already "missing" — so every candidate the parent never queried is still a miss in the child, `api-key-credential.ts:160`'s `hasOpSources()` gate fires, and the child builds its own client. That is the dialog. `withHandshakeLock` works exactly as designed here, which is what makes it visible: N children become N SEQUENTIAL dialogs rather than 1 dialog + N-1 denials.

Measured from real session logs (`ai-docs/sessions/dev-feature-parent-resolve-20260806-000350-abc216c5/baseline-evidence.md`): **17** `create_session` children logged `Denied authorization for SDK client`. **16 survived** — each found a key later in the chain — so the cost was mostly DIALOGS, not outages; the one casualty, `glm-5.2`, died in 0.6s chasing `ZHIPU_API_KEY` while the credential that actually works is `GLM_CODING_API_KEY`. All 17 came from the spawn site that DOES pre-hydrate, which is precisely what proves pre-hydration alone is insufficient. The skip-list above cannot close it either: `recordOpUnavailableVars` records only the names a CLEAN resolve actually ASKED for, and the parent never asked — and it is additionally suppressed whenever the run logged any op failure, i.e. exactly when it is needed.

**The fix is that the parent resolves the ROUTE as well as the credential.** `prehydrateCredentialsForSpawn` returns `SpawnPlan { pinned: Map<bare, "provider@model"> }`, and children spawn with the explicit spec. `parseModelSpec().isExplicitProvider` is then true, so the child's routing step is skipped, it has exactly one candidate, that candidate's key is already in the inherited env, and `resolveFromEnvConfig()` returns at step 1 — `hasOpSources()` is never reached. No `CLAUDISH_OP_PREHYDRATED` marker was added and none is wanted: once the key is in env the op path is structurally unreachable, so a marker would guard a door already welded shut.

**ORDERING IS LOAD-BEARING.** Phase A (hydrate) must precede phase B (route), because `route()`'s own credential filter reads the env phase A writes. Reversed, every candidate is a miss and `route()` itself re-enters the SDK for candidates hydration would have satisfied — the same storm, relocated into the parent. That is why the pin lives inside `prehydrate.ts` rather than at the call sites.

Two traps, both found during implementation and both pinned by tests:

- **`Route.modelSpec` is NOT argv-safe for OpenRouter.** `buildRoutingChain` emits a bare catalog-resolved id there (`x-ai/grok-4.20`) because inside the proxy the sibling `provider` field disambiguates it; on argv the string must describe itself. `parseModelSpec("x-ai/grok-4.20")` → provider `x-ai`, `isExplicitProvider` **FALSE** — so an un-normalized pin silently NO-OPS for the most common primary in the default rules. Hence `normalizePinnedSpec` (→ `or@x-ai/grok-4.20`), verified 29/29 over `PROVIDER_TO_PREFIX`.
- **Natives must never be pinned.** `route("opus")` answers `ok: openrouter` — `defaultProvider` is appended to EVERY bare chain — and `create_session` does not screen natives the way `team`'s `setupSession` does, so an unguarded pin would spawn `--model or@opus`. `isRoutablyPinnable` mirrors the child's own step-2c gate; mutation-tested, removing the guard really does yield `or@opus`.

Note also that `parseModelSpec` STRIPS a concurrency suffix (`ollama@llama3.2:3` → model `llama3.2`), so what protects those specs is the explicit-spec EARLY-OUT, not lossless round-tripping.

**The trade, stated honestly**: MCP-spawned children lose in-child provider fallback — one candidate, not a chain. Acceptable because the parent already credential-filtered the chain, and a failure surfaces as one model reported FAILED in the team report rather than a dead run. Interactive `claudish --model X` is UNTOUCHED — full chain as before. Escape hatch: `prehydrateCredentialsForSpawn(models, { pin: false })`, which is also used automatically for `create_session` with a `work_dir` outside the parent's cwd, because `route()` reads project-local config relative to `process.cwd()` and would otherwise decide with the wrong project's rules (`process.chdir()` is not an option — process-global, races concurrent calls).

**Verified live** (`verification-live-run.md`, same session dir): keys stripped, 3 bare models, dev tree. Parent = **1** `op:client-handshake`, **0** denials. All 3 children AND their 3 `--mcp` grandchildren = **0** handshakes, **0** denials, **0** `op:*` spans, each reporting `auth none` with its startup-trace table PRESENT — so the zeros are measured, not missing output. Children's argv captured as `gc@glm-5.2`, `mm@minimax-m2.5`, `kc@k3`. Exactly one dialog for the whole run. Context windows were confirmed identical bare-vs-pinned across 4 models, including the `kimi-k3` → `kc@k3` subscription wire-id translation.

### 1Password failure provenance
Every op-source failure is deliberately NON-FATAL (warn + skip, so a broken import can never lock the user out). That meant a denied authorization surfaced downstream as a plain "missing key" error telling the user to `export` a credential they already store in 1Password. `recordOpFailure()` / `getOpFailures()` / `renderOpFailureNotice(envVar)` in `onepassword.ts` are the negative counterpart to `recordOpHydratedVars` (same run-scoped, in-memory rationale), recorded at all four non-fatal catch sites in `op-source.ts`. `getMissingKeyError` splices the notice ABOVE the generic remediation and switches its header to "Or set the key directly:" — when a key lives in 1Password, approving is the fix and exporting a literal is the bypass. The record is deliberately COARSE (run-scoped, not per-env-var): an Environment fetch is all-or-nothing, so when it fails claudish genuinely cannot know which variables it would have supplied. Output is byte-identical to the old error when no failure was recorded, so non-1Password users see no change.

### Glob field import
A top-level `onepassword: string[]` config array holds glob paths. `isGlobImport()` detects a `*` in the post-item path segment(s); `resolveGlobImport()` does three phases: **discover** field names via the SDK (`vaults.list` → `items.list` → `items.get`, matching by title; duplicate titles → first-match + stderr warn) → **filter** by section-glob + field-glob (`globToRegExp`) → **resolve** only survivors via `resolveSecrets` (batched, in-memory). The SDK's `ItemField` has no ready-made `reference`, so each field's `op://` ref is **synthesized** from the vault/item/section/field titles. The SDK decrypts every field value to list names — no different from `op item get`, which also decrypts everything in-process; we keep only a `hasValue` flag, never the value. Field labels are trimmed; invalid env-var names are skipped with a warning.

### Custom-endpoint op:// apiKeys (pre-resolved at startup)
Provider construction is **synchronous** and can't await the async SDK, so a custom endpoint's `op://` `apiKey` is **pre-resolved in `index.ts` `applyCustomEndpointOpKeys()`** into `CUSTOM_<sanitize(name)>_KEY` (UPPERCASE, non-alphanumerics → `_`). `custom-endpoints-loader.ts`'s `createHandler` reads `process.env[apiKeyEnvVar]` **first**, falling back to `resolveCustomEndpointApiKey()` (which now only expands `${VAR}`/literals — it no longer touches 1Password).

### CLI surface (`onepassword-command.ts`)
- `claudish --op "op://.../*" --list` → `opPreviewCommand(glob, { auth })`: lists matching field names via SDK `items.get`, **never values**.
- `claudish --op "op://.../*" [...args]` → `applyOpImport()`: resolves glob → hydrates `process.env` → runs a normal session with the remaining args (inline mode is glob-only; single refs go in config).
- `--op-env <id>` → 1Password Environments via the SDK `environments.getVariables` (beta-only). **Point-of-need since v7.16.0**: registered as a lazy op source (like config `onepasswordEnvironments[]`) and resolved by the credential authority ONLY when a routed provider's key misses env/config — no longer resolved eagerly at startup (which prompted on `--update`/`--version`/OAuth-only sessions and stormed across spawned children), no longer a highest-priority overwrite (env/config already set wins).

### TUI surface — the "1Password" tab (`claudish config`, tab 5)
The OpenTUI config interface (`packages/cli/src/tui/`) exposes a dedicated **1Password tab** managing, at both **global** (`~/.claudish/config.json`) and **project** (`./.claudish.json`) scope: the `onepasswordAccount`, per-item `op://` refs + glob imports (`onepassword[]`), and 1Password **Environments** (`onepasswordEnvironments[]`, a NEW persisted config field mirroring `--op-env`).

- **Persistence**: `providers/onepassword-config.ts` — scope-aware, **config-only** (no SDK at module load), all SYNC with an injectable `OpConfigPaths` test seam. Both scopes use a **raw read-modify-write** (preserves unrelated keys; never routes global through profile-config's cached-`homedir()` `CONFIG_FILE`, so global is hermetically testable). `index.ts`'s `readConfiguredOnepasswordAccount`/`saveOnepasswordAccount` now delegate here. **Point-of-need (v7.16.0):** `applyOpEnvironment()` no longer resolves anything — it only **validates** the `--op-env` flag shape; both `onepasswordEnvironments[]` config and the `--op-env` flag are discovered + resolved LAZILY by `auth/credentials/op-source.ts` (`registeredEnvironmentIds` = seam-aware config env ids + argv `--op-env`; `resolveEnvironmentShared` = single-flight, whole-environment `getVariables` cached into `resolvedCache`) only when a routed provider key misses env/config. `onepasswordEnvironments` is added to `profile-config.ts`'s `loadConfig` allowlist so global round-trips preserve it, and to `op-source.ts`'s `SniffedConfig` so tests can inject it through the existing seam.
- **TUI wiring**: tab/mode/types in `tui/types.ts` (`OpEntry`/`OpScope`/`OpKind`); `tui/components/OnepasswordContent.tsx` (auth card + merged scope-marked scrollable list — ▴ project / • global / · env), `OnepasswordDetail.tsx` (browse-only entry detail), and `OnepasswordModal.tsx` (the centered **absolute-overlay** add-wizard — `position="absolute"` + `zIndex`, painted as the topmost sibling of the root box, NOT crammed in the bottom strip). `App.tsx` owns state + the keyboard handler. Scope model mirrors Routing; pickers follow the Profiles `<select>` pattern (focused `<select>` owns ↑↓ via `onChange`; `useKeyboard` owns Enter/Esc).
- **Add wizard flow** (`a` key) — **browse, don't type**: Step 1 **scope** (global/project) → Step 2 **account** picker (shown ONLY when `!detectSdkAuth()` AND `resolveDesktopAccount()` returns `needsPicker`, i.e. >1 account & not authed; auto-skipped otherwise) → Step 3 **kind** (intent-labeled `<select>` with descriptions ON: "API key from an item" / "Environment") → Step 4 **value**:
  - **API key** → per-level pickers `pick_op_vault` → `pick_op_item` → `pick_op_field` (from `listVaults`/`listItems`/`discoverItemFields` — two tiny new engine exports `listVaults`/`listItems` mirror `discoverItemFields`' `acquireSdkClient`). The `op://Vault/Item/[Section/]Field-or-*` path is **built from the literal titles** (`buildFieldOptions` in the modal) — the user never types `op://`. Globs always target ONE concrete vault+item (the grammar forbids multi-vault/item globs). Each level shows a "◌ Loading…" state while the async SDK call runs; Esc steps back one level (field→item→vault→browse). **Inline fuzzy filter**: the vault/item/field (and account) pickers are MANUALLY rendered (not `<select>`) so App owns ↑↓ + a shared `opFilter` string — typing narrows the list via `fuzzyMatch` (case-insensitive subsequence, in `OnepasswordModal.tsx`), backspace widens, a "filter: … N matches" header + "no matches" empty state show state, and the filter resets on every level entry/exit. `*` is excluded from filter input (`isFilterChar`) — it'd match literally in the subsequence filter and exclude every concrete-field row.
  - **Grouped field picker** (`buildFieldOptions` → `FieldPickerOption` with a `selectable` flag): rows are `★ Import everything (all N fields)`, then per-SECTION groups — a non-selectable **header** = the section title (often the user's key name, e.g. `GOOGLE_GEMINI_API_KEY`), then a nested `↳ import all N fields` glob, then each concrete field — then a `(no section)` group for top-level fields. This replaced the confusing flat `section 'X' — all fields (*)` rows (when a user keeps one key per section, the header now reads as the key group, not gibberish). The cursor SKIPS header rows (App's `nextSelectable`/`firstSelectable` + a `useEffect` cursor-snap; Enter guards on `chosen.selectable`). The selected option's full `op://` path renders on ONE fixed "saves: …" footer line, mid-truncated (`midTruncate`) so it never wraps/overlaps rows.
  - **Environment** → typed ID (the SDK has **no** way to enumerate Environments — only `getVariables(id)`) with a **two-Enter NAME preview**: Enter#1 → `readEnvironment` → render variable names (no values); Enter#2 → persist.
- **Importable-only, FLAT field list** (`buildFieldOptions`): only **importable** fields are shown — concealed (SDK `fieldType === "Concealed"`, case-insensitive) AND a valid env-var name; everything else (notes/username/`credential`) is hidden, and sections with zero importable fields are omitted. The list is **flat and uniform** (no headers/gaps — earlier grouped/collapsed layouts made single-key and multi-key sections look like different items): one selectable key row per field, rendered `ENVNAME  ·  section` (env-var name green, section a dim aligned tag). A MULTI-key section additionally gets one `↳ all of <section> (N, auto-updates)` glob row after its keys; the sectionless `★ All top-level keys (N, auto-updates)` glob is appended only when importable top-level keys exist. `renderFieldPicker` renders this in a bordered scroll region with `▲/▼ more` indicators; the selected option's full `op://` path shows on the fixed "saves: …" footer (`midTruncate`d, `dialogW - 16`, so it never wraps).
- **SDK call SERIALIZATION (`-4` fix)**: the 1Password SDK's WASM↔desktop-app IPC bridge is **NOT safe for concurrent calls on a shared client** — two ops in flight at once corrupt the channel → `IPC operation failed: -4`. The config TUI fires overlapping calls (e.g. a post-save confirm AND the main-list glob-expansion at the same instant), which reliably triggered it. Fix in `onepassword.ts`: a process-wide `runSdkExclusive` queue chains every SDK op so **at most one runs at a time**, plus `withSdkRetry` (cache-reset + 150ms·attempt backoff, up to 3 attempts) for genuinely transient blips, plus the per-auth client cache (`defaultSdkClientFactory`, one desktop handshake reused). `isTransientSdkError` also matches **stale-desktop-session** errors (`invalid client id` / `invalid session` / `session expired` / `unauthorized` / `token expired`) — after an idle period 1Password expires the SDK session and the cached client's id goes invalid; these are retryable (reset cache → rebuild client = fresh DesktopAuth handshake → retry), so claudish self-heals after idle instead of surfacing `invalid client id`. (The desktop app's re-authorization prompt after idle is 1Password's own session-timeout behavior — claudish can't suppress it, but now auto-retries once approved.) ALL TUI SDK calls (`loadOpVaults/Items/Fields`, `runOpAdd` confirm, `testOpEntry`, `previewOpEnvironment`, the `opExpansions` effect) go through `withSdkRetry` → serialized. Serialization is the PRIMARY fix; the client cache + retry are secondary. Tests: `withSdkRetry` serialization (max-concurrency=1), retry-then-succeed, give-up-after-3, no-retry-on-genuine-error.
- **Field-load speed**: the field picker uses `discoverItemFieldsById(vaultId, itemId, vaultTitle, itemTitle)` — ONE `items.get` SDK call instead of `discoverItemFields`' three (`vaults.list` → `items.list` → `items.get`), ~3× faster on the 1Password desktop-app IPC path. Results are **cached per `${vaultId}:${itemId}`** in `opFieldsCache` (a `useRef` Map), so re-entering an item is instant (no spinner). The latency is desktop-app IPC + WASM load + decrypt (not a network call), so caching + the single-call path are the real wins. `discoverItemFields` (title-based, 3 calls) is retained for `runOpAdd`'s confirm + the main-list glob expansion, which don't have the IDs handy.
- **User-facing terms (no jargon)**: the main list + detail use **key** (single ref), **set** (a glob = many keys), **environment** — never "ref"/"glob". The KIND column color-codes them (key=blue, set=yellow, env=cyan); the auth card summarizes "N keys / M sets / K environments".
- **Sets auto-expand in the main list**: each glob entry resolves its key names + a MASKED value tail lazily via a cached `opExpansions` effect (`discoverItemFields`+`filterGlobFields`, keyed by glob value) and renders them as dim `↳ NAME   ••••XXXX` sub-rows (with `◌ resolving…` / `✗ error` states). The tail is `DiscoveredField.valueTail` — the LAST 4 chars of the value, captured at discovery (where the SDK has already decrypted in-process) via the exported `valueTail()` helper; the full value is never stored/returned/logged. This is the standard "••••1234" identification pattern so the user can confirm WHICH credential is wired up. (The op keys themselves ARE applied to providers — they hydrate `process.env` at startup via `loadStoredApiKeys`, and the Providers tab reads `process.env[apiKeyEnvVar]`; an earlier "providers show not set" report was the `-4` concurrency bug, now fixed by SDK serialization.) Both the main list and the field picker render selected rows as a height-1 highlight box and **non-selected rows as bare `<text>`** (transparent → no dark/blue strips; the earlier `flexGrow` row box painted the whole panel). The field picker's list sits in a **bordered scroll region** with `▲ N above` / `▼ N below` indicators.
- **Glob grammar (claudish-side only — 1Password rejects `*`/`**` outright, so it never sees them)**: `op://V/Item/*` = sectionless/top-level fields only; `op://V/Item/Section/*` (or `*/*`, `M*/*`, `*_KEY/*`) = fields in matching section(s) only; **`op://V/Item/**` = the WHOLE item — every importable field, sectioned AND sectionless** (the `matchAll` flag on `GlobImport`, added because no `*`/`*/*` form unions both axes). `parseGlobImport` maps a lone single-segment `**` → `{sectionGlob:null, fieldGlob:"*", matchAll:true}`; `filterGlobFields` short-circuits the section check when `matchAll`. `**` is purely additive — `*`'s sectionless-only meaning (and its pinned test) is unchanged.
- **`★` rows in the field picker** (`buildFieldOptions`): **`★ All keys in this item (N)` → `op://V/Item/**`** is shown first whenever the item has ≥1 importable key — ONE config entry covers every item shape (no-sections / all-sectioned / mixed). A second **`★ All top-level keys → op://V/Item/*`** appears ONLY for a MIXED item (has sections AND top-level keys), as a narrower pick; it's suppressed for a no-sections item (where `**` already equals `*`). Both counts reflect importable fields only. This replaced an earlier `★ All top-level keys`-only design that couldn't express "the whole item" when keys live in sections.
- **Startup glob failures are NON-FATAL** (`index.ts` `loadStoredApiKeys`): a saved glob that matches nothing (e.g. after a 1Password item edit) now warns + skips per-glob instead of `process.exit(1)` — a bad import must never lock the user out of claudish (especially `claudish config`, where they'd go to fix it). Genuine auth/token failures still hard-fail via the single-ref `resolveSecrets` path.
- **Hydrate-on-add (keys apply WITHOUT a restart)**: after a successful add, `runOpAdd` resolves the new ref/set/environment and **gap-fills the values into the running process's `process.env`** (env already set wins, same rule as startup), then drops all probe handler caches (`invalidateProbeProxyHandlers()`) and `refreshConfig()`. The Providers tab reads `process.env[apiKeyEnvVar]`, so the imported keys light up **immediately** in the same session — previously they only appeared after relaunching claudish (the import only hydrated env at startup). Sets use `resolveGlobImport` (returns the `{envVar:value}` map directly — one resolution both confirms and hydrates); refs use `resolveSecrets` + `envNameFromOpRef`; environments use `readEnvironment`. The status line reports "N keys applied".
- **`runOpAdd` is PERSIST-FIRST**: it writes the ref/glob/env to config **immediately** (the picked option is valid by construction — it came from an SDK-discovered list), then runs a **non-fatal** confirmation test (`resolveSecrets`/`discoverItemFields`+`filterGlobFields`/`readEnvironment`) that only annotates the status line (masked value / key count / var count) — a flaky second SDK round-trip can no longer silently lose the save. A genuine persist failure (or the confirm error) is logged to stderr and shown in the status line. (Earlier bug: re-validating before persist meant a thrown confirm left `onepassword[]` empty — "Imports: 0" despite a successful pick.) Auth still resolves via `resolveSdkAuth` (in-TUI multi-account picker via `pick_op_account` + deferred-promise `onNeedsPicker`); the heavy SDK/WASM stays lazy.

### Tests
`onepassword.test.ts` — hermetic via injectable `SdkClientFactory` (fake client answering `vaults`/`items`/`secrets`/`environments`) and `OpAccountLister` (fake account list) seams; neither the `op` binary nor the real SDK is ever invoked. The SDK-shaped item fixture is **derived** from the real-captured CLI item fixture (no hand-crafted secret-like data). Covers no-auth hard-fail and `resolveDesktopAccount`/`resolveSdkAuth` (env / config / single-auto / multi-picker / multi-error).
`onepassword-config.test.ts` — hermetic via the `OpConfigPaths` seam pointing global/project at temp files (`homedir()` can't be re-pointed at runtime in Bun); covers scope-independent account/imports/environments read-write, project-then-global precedence, idempotent add, empty-list key deletion, `readAllOnepasswordEnvironments` dedup, raw-merge preservation of unrelated fields, and garbled-file tolerance.

## Three-Layer Adapter Architecture (v5.14.0+)

The translation pipeline has three decoupled layers:

### Layer 1: FormatConverter — wire format translation
Translates between Claude API format and target model's wire format (messages, tools, payload).
Each converter declares its stream format via `getStreamFormat()`.
- **Interface**: `adapters/format-converter.ts`
- **Implementations**: OpenAIAdapter, AnthropicPassthroughAdapter, GeminiAdapter, CodexAdapter, OllamaCloudAdapter, LiteLLMAdapter
- **Message/tool conversion**: `handlers/shared/format/openai-messages.ts`, `openai-tools.ts`

### Layer 2: ModelTranslator — model dialect translation
Translates model-specific dialect differences (context windows, thinking→reasoning_effort, vision rules).
- **Interface**: `adapters/model-translator.ts`
- **Implementations**: GLMAdapter, GrokAdapter, MiniMaxAdapter, DeepSeekAdapter, QwenAdapter, CodexAdapter
- **Selection**: `AdapterManager` auto-selects based on model ID

### Layer 3: ProviderTransport — HTTP transport
Handles auth, endpoints, headers, rate limiting. Optionally overrides stream format for aggregators.
- **Interface**: `providers/transport/types.ts`
- **Stream format override**: LiteLLM and OpenRouter implement `overrideStreamFormat()` → `"openai-sse"`

### Composition in ComposedHandler
```
ComposedHandler = FormatConverter (explicit adapter) + ModelTranslator (auto-selected) + ProviderTransport
```

**Stream parser selection** (3-tier priority):
```typescript
transport.overrideStreamFormat() ?? modelAdapter.getStreamFormat() ?? providerAdapter.getStreamFormat()
```

**Adding a new provider**: Add one entry to `PROVIDER_PROFILES` table in `providers/provider-profiles.ts`.
**Adding a new model**: Create a ModelTranslator adapter, register in `adapters/adapter-manager.ts`.
**Verifying wiring**: `claudish --probe <model>` shows the full adapter composition.

### Stream Parsers
Located in `handlers/shared/stream-parsers/`:
- `openai-sse.ts` — OpenAI SSE → Claude SSE (used by most providers)
- `anthropic-sse.ts` — Anthropic SSE passthrough (MiniMax, Kimi direct)
- `gemini-sse.ts` — Gemini SSE → Claude SSE
- `ollama-jsonl.ts` — Ollama JSONL → Claude SSE
- `openai-responses-sse.ts` — OpenAI Responses API → Claude SSE (Codex)

### Errors that ride an HTTP 200 stream (`stream-head-sniffer.ts`)

The Codex backend (`chatgpt.com/backend-api/codex/responses`) reports capacity faults **inside** a 200 body, not via the status code:

```
200 OK
data: {"type":"response.created", ...}
data: {"type":"response.in_progress", ...}
data: {"type":"error","error":{"code":"server_is_overloaded", ...},"sequence_number":2}
```

Every retry hook in claudish keys off the HTTP **status** (`anthropic-compat.ts`'s 429 loop, `antigravity.ts`'s 429 classifier), so this class of failure bypassed all of them. The parser turned it into an assistant **text block** with `stop_reason: "end_turn"` and `onApiError` only flagged stats — so a transient, textbook-retryable fault became a permanent, successful-looking answer reading `[API Error: server_is_overloaded]`.

`sniffResponsesStreamHead()` peeks at the stream head in `composed-handler.ts` step **7b**, which is the only window where the status code is still ours to choose (once Hono flushes the 200, a 503 is no longer expressible):

- **Retryable** (`server_is_overloaded`, `server_error`, `service_unavailable_error`, prose "overloaded"/"try again later") → re-issue upstream with **progressive** backoff `3s → 15s → 30s` (`STREAM_RETRY_DELAYS_MS`). Progressive, not tight: the outage that motivated this ran ~6.5 minutes, so only the late attempts recover anything.
- **All retries exhausted** → HTTP **503** `overloaded_error`. Safe specifically because `fallback-handler.ts`'s `isRetryableError` does NOT list 503 — it cannot silently switch the user off a pinned model, it reaches Claude Code, which runs its own retry loop.
- **Terminal** in-stream errors (`context_length_exceeded`, `invalid_request_error`) are NOT retried — they keep the existing inline-text treatment, which is the actionable path for them.
- **Anything else** (any content event) → `clean`, and the consumed bytes are **replayed byte-identically** so the real parser sees an unchanged stream.

This is the one place the 400-not-503 doctrine (`composed-handler.ts` ~line 461) is deliberately inverted. That rule exists because a 503 makes Claude Code show "API error · Retrying · attempt N/10" with the real reason buried — correct for **terminal** faults, where retrying is theatre. An upstream overload is the opposite: genuinely transient, and the retry banner is the appropriate behaviour because retrying is the actual remedy. Terminal → 400 inline; transient-after-our-own-retries → 503.

**Trade-off to know:** sniffing withholds response headers until the first decisive event, capped by `DEFAULT_SNIFF_BUDGET_MS` (12s, chosen above the 0.85s–7.7s error latencies observed in the real log). On a healthy xhigh-reasoning turn that delays `message_start` by however long the model thinks before its first output item. No content is lost or reordered — the client shows a spinner either way — but time-to-first-byte is genuinely later than before. Past the budget claudish flushes and degrades gracefully to the inline-text path.

`latency_ms` for a retried turn includes the backoff waits by design: the honest figure is time-to-usable-response.

## Layer 4: Behavior Compatibility Layer (`behavior/`)

Layers 1-3 translate the wire format, the model dialect, and the transport. Layer 4 translates **harness behavioral conventions** — the unwritten protocols Claude Code expects an agent to follow. A foreign model can speak the wire format perfectly, use every tool correctly, and still break Claude Code by violating one.

**The motivating case.** CC 2.1.220's `ExitPlanModeV2` takes **no** `plan` parameter — its advertised schema is `{allowedPrompts?}` and its description says "This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote". `normalizeToolInput` injects `plan` from disk at the session's assigned path. So `ExitPlanMode({})` is **correct**; the failure is upstream. gpt-5.6-sol wrote a complete 12.9 KB plan under a filename it invented, CC read the assigned path, found nothing, and returned `plan: null` — which downgrades the approval dialog from the rich form (`Yes, and bypass permissions` / `Yes, auto-accept edits` / `Yes, manually approve edits`) to a bare "Exit plan mode?" yes/no. That rich dialog is the **only** surface offering permission elevation on exit, so the session always falls back to `prePlanMode ?? "default"` = manual approval.

Measured over 115 recorded `ExitPlanMode` calls: native Claude 87/87 carried a plan, Kimi-via-claudish 4/4, gpt-5.6-sol 17/24 empty. The discriminator is exact — sessions that wrote to the assigned path got the rich dialog 7/7, sessions that did not got the degraded one 17/17 — and failures ran at ~1.75x the context (178K vs 102K median input tokens). **Not a translation bug**: the same model through the same proxy got the random CC slug right in a shorter session.

### Two pipeline defects this required fixing first

- **`beforeRequest` ran after `buildPayload`.** It is now step **3b**, before step 4. On Chat Completions the old order worked only by accident (`payload.messages = messages` aliases); on **Codex/Responses** `buildPayload` deep-copies both arrays and lifts system into `payload.instructions`, so every middleware mutation was silently discarded on exactly the path gpt-5.x uses. Keep 3b ahead of 4.
- **`openai-responses-sse.ts` had no hooks at all** — no middleware, no `tool-call-recovery`, while `openai-sse.ts` had both. Now wired.

### Design

Rules **return** actions; the engine applies them. Nothing else in the layer mutates the request, which is what makes severity levels meaningful and every change attributable to a rule id.

- **Severity is linter semantics**: `off` / `warn` (log, don't apply) / `fix` (apply). Config resolution is exact id → longest glob → the rule's own default, so `{"plan-mode/*": "off", "plan-mode/plan-file-path": "fix"}` works.
- **`RuleAction` is a closed union** (`injectSystemNote`, `rewriteToolDescription`, `repairToolArgs`, `warn`). An open "run this callback" action would make rule effects unauditable and defeat severity.
- **Sessions, not instance state.** `ComposedHandler` is cached per model and can serve overlapping requests, so detected harness facts live on a per-request `BehaviorSession` captured by the stream-parser closure. Two in-flight turns cannot read each other's plan path.
- **`armed(facts)` gates buffering.** `repairToolArgs` is only possible if a tool's arguments are withheld until the call completes (the Responses parser streams `input_json_delta` the instant each fragment arrives). Buffering is therefore opt-in per tool AND per request: outside plan mode nothing is buffered and streaming is byte-for-byte unchanged. Without `armed`, intercepting `Write` would suppress incremental file-content delivery on every foreign-model request.
- **Repair is wired into every stream format that carries tool calls**, so it is not a Codex-only feature:

| Parser | Providers | How repair lands |
|---|---|---|
| `openai-sse` | GLM, Kimi, Grok, DeepSeek, Qwen, OpenRouter, LiteLLM | Already buffers whenever the request carries tools (`toolSchemas`), so repair hooks the 6 sites that emit a COMPLETE argument object. The incremental `partial_json` fragment path is deliberately **not** hooked — repairing a fragment would emit malformed JSON. |
| `openai-responses-sse` | Codex / gpt-5.x | Streams fragments immediately, so buffering is opt-in per tool via `shouldBufferTool`. |
| `anthropic-sse` | MiniMax, Kimi direct, Z.AI | Byte-level passthrough, so interception is strictly opt-in: only a named tool has its `input_json_delta` frames withheld and rewritten. Verified byte-identical output for untargeted tools. |
| `gemini-sse` | Gemini | No buffering needed — Gemini delivers each `functionCall` with complete `args` in one part. Uses `repairToolArgs`, deliberately separate from the pre-existing `onToolCall` thought-signature hook. |
| `ollama-jsonl` | Ollama local | Not wired — this parser has no tool-call handling at all. |
- **Off for native Claude** (`claude-*` or provider `anthropic`) — a naming rule, not a pinned roster.
- **Anchors live in `harness.ts` only.** `PLAN_MODE_HINT` is a cheap pre-test and **must stay a superset of the anchors** — an earlier version omitted "create your plan at" and short-circuited a valid anchor away. Never assume `~/.claude/plans`: CC has a `planDir` setting, so the path is always taken from the reminder.

### Why the layer is a SUPERVISOR, not a hint system

Claudish routes **arbitrary models, in arbitrary combinations** — a `team` run mixes vendors in one session, and any of them may be swapped tomorrow. There is no capability floor to design against. Specifically, none of the following can be assumed of a model claudish is asked to drive:

- that it follows an instruction it was given many turns ago, under context pressure
- that it invokes a skill, plugin, or tool that is merely *available* to it
- that it knows Claude Code's conventions at all, let alone the current release's
- that it honours the user's own rules (CLAUDE.md, project conventions) rather than taking a shortcut
- that a capability present in one model of a team is present in its siblings

So conformance cannot be delegated to the model's judgement. That is what makes this a supervisor: it enforces from outside rather than asking nicely from inside.

**The measurement this is built on** (plan mode, 115 recorded `ExitPlanMode` calls across 8 models): the plan-file path was in the conversation the whole time — CC re-injects it every turn — and gpt-5.6-sol still wrote to a self-invented filename in 17 of 24 calls, while native Claude was 87/87 correct and Kimi 4/4. The discriminator was context pressure: failures ran at ~178K median input tokens against ~102K for successes. The information was present and the model stopped acting on it, and *which* model it was mattered more than anything else.

The design rule that follows:

> **Put the fact where the decision is made, deterministically. Do not ask the model to go and get it.**

Hence `plan-mode/plan-file-path` rewrites the **ExitPlanMode tool description** rather than re-stating the reminder: a tool description is re-read at the instant the model decides to call the tool, while a system reminder sits 178K tokens away.

Practical consequences for future rules:

- Prefer **injecting content** over instructing the model to fetch it. If a skill matters for the task, inline what it says rather than telling the model to load it.
- Prefer **deterministic repair** over guidance whenever the correct value is knowable.
- Treat "the model was told" as **no evidence** of compliance. Rules are validated by outcome — did the plan file exist at the assigned path — never by whether the instruction was delivered.
- Assume **nothing transfers between models**. A rule proven on one model is a hypothesis on the next; the corpus is per-model for that reason.
- Scoped to **foreign models**. Native Claude honours CC's own mechanisms (hooks, skills, output styles), so the layer stays off for `claude-*` rather than competing with a harness that already works.

*Related reading, as one illustration of the same class from another team: Vercel's [AGENTS.md outperforms Skills in our agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) found a skill went uninvoked in 56% of cases, with always-in-context docs scoring 100% against 53% for skills. Single model, and a narrow eval targeting APIs absent from training data — so it is an anecdote about one symptom, not a basis for this design.*

### The four surfaces a rule can observe

| Hook | When | Can it change the turn? |
|---|---|---|
| `onRequest` | before `buildPayload` | yes — `injectSystemNote`, `rewriteToolDescription` |
| `onToolCall` | tool arguments fully accumulated | yes — `repairToolArgs` (requires buffering) |
| `onModelOutput` | after the response stream completes | **no** — the turn is already on the wire |
| `armed(facts)` | gate | decides whether the rule participates at all |

`onModelOutput` receives **normalized** text, reasoning, and the ordered list of tool names the turn called — never raw stream events. The four parsers deliver four different shapes (a Chat Completions `delta`, a Responses API event, an Anthropic frame, a Gemini part); making every rule understand all four would produce rules that silently work on some providers and not others. Each parser knows its own shape, rules see prose.

Because the response has already reached the client, an `injectSystemNote` returned from `onModelOutput` is **queued for the next request** rather than applied. This is what makes shortcut detection actionable: "you claimed the tests pass but called no command this turn" can only be judged once the turn is over.

**Cross-turn state is keyed by the Claude Code session id.** CC sends it nested inside `metadata.user_id`, which is itself a JSON *string*:

```
metadata.user_id = '{"device_id":"073c…","account_uuid":"","session_id":"ce7d…"}'
```

`extractSessionId()` returns only `session_id`. **`device_id` is a stable machine identifier and must never be journalled or uploaded** — it would defeat the journal's entire no-paths design in a single field. Queued corrections live on the engine keyed by session id (not per-model, or two concurrent conversations against the same model would leak into each other), bounded to 64 conversations with oldest-first eviction.

### Reading the system prompt

`BehaviorContext.systemText` and `harness.skills` expose what already arrives on every request: CLAUDE.md, the user's project rules, and the skill listing. A rule reads these to decide a skill or user rule applies, then **injects the relevant content** — it does not tell the model to go and load a skill, for the reason set out above. `extractAvailableSkills()` returns `[]` when no listing is present, which means *unknown*, not "the user has no skills".

### Config

```json
{ "behavior": {
    "rules": {
      "plan-mode/*": "warn",
      "gpt-5.6-*:plan-mode/plan-file-path": "fix"
    },
    "hooks": ["./.claudish/hooks/my-rule.ts"],
    "observer": { "enabled": true, "mode": "suggest" },
    "telemetry": { "enabled": false } } }
```

Rule keys may be **model-scoped** as `modelGlob:ruleId`. Scoped keys beat unscoped ones, and within each tier an exact id beats a glob and a longer glob beats a shorter one. This exists because nothing transfers between models — a rule proven on one is a hypothesis on the next — so a rule can be armed for the model that needs it without arming it everywhere. (`hook:` ids also contain a colon and are deliberately *not* parsed as model-scoped.)

Hooks are user modules exporting `BehaviorRule`s, namespaced `hook:<file>/<id>` so they can never shadow a built-in; load failures warn and skip. The **observer** is a small local model (vision-proxy contract: hard timeout, `null` on failure, never blocks) that sees only a **digest** — tool names, harness facts, the proposed call's argument keys plus path-like values — never conversation text. Its model is **discovered** via `ollama-discovery` (smallest non-embedding), never pinned, and ids outside the rule vocabulary are discarded as hallucinations.

`behavior/observer/corpus.ts` replays recorded CC transcripts offline to build a **labelled** divergence corpus with no live traffic: CC records `toolUseResult.filePath` (the path it actually read) and `plan: null` (whether it found anything), so every replayed session is known-good or known-degraded for free. Over 1129 local transcripts it independently reproduced the diagnosis — 11 degraded, all gpt-5.6-sol, all four Claude models and all three Kimi models clean, and the rule would have caught 11/11.

### Telemetry — the cross-user corpus (v7.35.0+)

The corpus above is one developer's models on one developer's projects. A rule for a model the maintainer never runs needs evidence from someone who does, which is what `POST https://claudish.com/v1/behavior` collects. Contract and intent: `docs/specs/behavior-telemetry-backend.md`; server-side retention is 12 months, then non-identifying weekly aggregates.

**Opt-in, default off**, via `behavior.telemetry.enabled` or `claudish behavior telemetry --enable`. Deliberately NOT sharing `stats.enabled` — that consent was granted for usage statistics, and reusing it for behavioural records would be consent laundering. Local journalling is unaffected and always on.

- **Session aggregates, not decision records.** One payload per session, counters only, so the server never holds a raw per-decision row. Emitted by `telemetry/aggregate.ts` alongside the local journal write at the same call site, so the two can never disagree.
- **Safety is structural, not promised.** `toUploadable()` is an allow-list projection — a field a future contributor adds to the journal cannot leak, it has to be added explicitly. `pathRelation` is the pattern: `same_dir_wrong_name` is the exact discriminator the plan-mode rule keys off and carries no path. Categorical instead of literal, everywhere.
- **`session_id` is a salted SHA-256** (the server rejects a raw CC UUID). The salt is **per-process and never persisted** — strictly stronger than a stored one: no key on disk to steal, and no way for anyone including us to reverse a delivered id. The model id is folded in, so a session routing to several models yields one aggregate per model rather than colliding on an id the server would treat as a duplicate.
- **`context_bucket` is a CLOSED set** (`0-50k` … `200k+`) validated server-side. Adding a value — e.g. splitting `200k+` for 1M-context models — is a spec change, not a client change.
- **Delivery is spool-then-upload, and it has to be.** A session ends when claudish exits, and `process.on("exit")` is SYNCHRONOUS — a `fetch` started there never completes, and blocking shutdown on a round-trip is not an option when the user is waiting on their prompt. So exit does the one thing it reliably can (`appendFileSync` to `~/.claudish/behavior-outbox.jsonl`) and a LATER run drains it in the background. Same trade `stats-buffer.ts` makes, and a hard kill loses nothing.
- **The drain timeout is 15s, not the 3s `/v1/report` uses.** That endpoint is fire-and-forget on the request path where slowness costs the user; this one blocks nothing. Measured against the deployed service: warm ≈600ms, but a **cold start exceeds 3s** — at 3s the first drain after any idle period fails every time and reports only ever land on a second run. Found by running the real client against the real endpoint; the payload was never the problem.
- 429 is **not** honoured by waiting. A background drain must not sit on a 60s timer, and deferring to the next run is the same outcome, later.

## Debug Logging

Debug logging is behind the `--debug` flag and outputs to `logs/` directory. It's disabled by default.
Keep full debug logging (including empty chunks, raw deltas) in log files — needed to understand real model streaming behavior. Suppress noise at the registration/initialization level (e.g., conditional middleware), not at the streaming data level.

### `CLAUDISH_UPSTREAM_ERROR_LOG` — the one thing `--debug` being off loses forever

A non-ok upstream response short-circuits before the stream parser, so
`response-capture` never sees it. `composed-handler.ts` reads the body, hands it
to the classifier, and drops it — and `log()` persists **nothing** unless
`--debug` set a log file. So on a normal run the literal 429/402 body is gone
the instant it has been classified, which is exactly the artifact that
distinguishes a rate limit worth retrying from a hard quota wall that is not.
Reported by @jsboige (#184) from a real incident: a GLM coding-plan 5h cap
saturated, the shape was reconstructable from request counts, the body was not.

`CLAUDISH_UPSTREAM_ERROR_LOG=<path>` appends one JSON line per non-ok upstream
response: `{at, provider, model, status, body}`. Unset = off, and off is the
default **on purpose** — this writes provider error text, which can carry
account identifiers, to a path the user names. It is not part of `--debug`
because the two answer different questions: `--debug` is "show me everything
about this run", this is "keep the one field I will want next week".

Three properties worth preserving if it is ever touched: the body is capped at
2KB; truncation is **marked** (`truncated` + `original_bytes` appear only when
it happened, so an unmarked body can be trusted as whole); and it **never
throws**, because it runs on the error path where something is already going
wrong and a capture facility that can break a request is worse than none.

### Raw SSE Capture (v5.14.0+)

When `--debug` is active, both stream parsers log raw SSE events:
- `[SSE:openai] {...}` — every OpenAI SSE data line
- `[SSE:anthropic] {...}` — every Anthropic SSE data line

These are greppable and extractable into test fixtures for regression testing.

## Debugging Failed Model Translations

When a model produces wrong output (0 bytes, garbled, wrong format), use this workflow:

### 1. Reproduce with --debug
```bash
claudish --model minimax-m2.5 --debug "say hello"
# Debug log written to logs/claudish_YYYY-MM-DD_HH-MM-SS.log
```

### 2. Verify wiring with --probe
```bash
claudish --probe minimax-m2.5
# Shows: transport, format adapter, model translator, stream format, overrides
```

### 3. Analyze the debug log
Use the `/debug-logs` slash command in Claude Code:
```
/debug-logs logs/claudish_2026-03-17_09-41-32.log
```

This command:
1. Reads the log and counts text chunks, tool calls, HTTP errors, fallback chains
2. Diagnoses the failure mode (no SSE content, text but 0 stdout, wrong parser, etc.)
3. Extracts SSE fixtures from `[SSE:*]` lines using `test-fixtures/extract-sse-from-log.ts`
4. Adds a regression test to `format-translation.test.ts`
5. Runs tests to confirm the regression is captured

### 4. Extract fixtures manually (alternative)
```bash
bun run packages/cli/src/test-fixtures/extract-sse-from-log.ts logs/claudish_*.log
# Creates: test-fixtures/sse-responses/<model>-<format>-turn<N>.sse
```

### 5. Run format translation tests
```bash
bun test packages/cli/src/format-translation.test.ts
```

## The `team` success oracle — why exit 0 proves nothing

`claude -p` in text output mode emits **ONLY the final assistant message**. Any turn the child takes AFTER writing its answer replaces that answer on the captured surface. Isolated proof, no claudish anywhere in the path:

```
$ echo "Say exactly ALPHA_MARKER on its own line. Then run the bash command: echo hi. Then say exactly OMEGA_MARKER on its own line." | claude -p --model haiku
OMEGA_MARKER          <- 13 bytes. ALPHA_MARKER is gone.
```

Under `--output-format stream-json --verbose` BOTH messages are present, and the `result` field equals the last message — i.e. exactly what text mode prints. **The data survives upstream; only the capture path discards it.** The trigger is any post-answer turn, most often a background `Task`/`Agent` completing, whose notification prompts an acknowledgement — and that acknowledgement becomes `response-NN.md`.

Measured on claudish's `team`, deterministic 2/2 on the first attempt:

| model | output tokens generated | bytes captured | exit | reported | `vote` blocks |
|---|---|---|---|---|---|
| `gc@glm-5.2` | 7,743 | 250 B | 0 | succeeded | 0 |
| `kc@k3` | 4,737 | 396 B | 0 | succeeded | 0 |

Both surviving texts referred to "the review and vote above" — a review that is not on disk. The originally reported incident (236 B from `glm-5.2`) is the same shape. **It is not model-specific and not a claudish bug**: a madbench eval reproduced it on `claude-haiku-4-5` through plain Claude Code, no claudish in the path, 3 consecutive runs. It is a property of the print-mode capture surface.

The existing classifier could not see it because the epilogue passes every test it ran: exit code 0, no `[API Error: ...]` marker, non-whitespace output. `DEFAULT_MIN_OUTPUT_BYTES` is 0 (opt-in, off).

**A byte threshold is the wrong instrument, and this is the design point.** An earlier default of 200 produced a 2/2 false-positive rate against real short answers (measured 141 B and 96 B replies, both valid). Length is a guess. A caller that MANDATED an output shape, by contrast, knows what a complete answer looks like — so `require_pattern` is a precise oracle where length is not.

Detection, then:

- `FailureReason` gains `shape_mismatch`; `classifyRunOutput` gains optional `requirePattern` and `fullOutput`.
- `runModels` gains `requirePattern` and validates the regex **BEFORE reading the manifest and before spawning anything** — a bad regex discovered later would either waste the whole run or, worse, silently enforce nothing.
- The MCP `team` tool exposes `require_pattern` and `min_output_bytes`. The reporter of the original bug had no way to opt in, which is why the option existing internally was not enough.

Two ordering decisions worth keeping:

1. **The shape check runs LAST**, after the api_error / background-ceiling / empty checks. A run that hit one of those would fail the shape check too, and reporting "no `vote` block" for what is really an API error sends the caller after the wrong problem.
2. **The pattern is matched against the FULL response, not `stdoutTail`**, because that tail is capped at `STDOUT_TAIL_LIMIT` (4000 B) — a contract whose marker sits near the START of a long answer would otherwise silently never match. Mutation-tested: changing `fullOutput ?? stdoutTail` to `stdoutTail` fails the suite.

### Recovery — the answer is no longer lost (v7.50.0+)

Detection turned a silent wrong verdict into a loud failure, but the generated answer was still gone: the caller re-ran and paid again. Children now spawn with `--output-format stream-json` and `team-stream-capture.ts` concatenates **every** assistant text block, so a post-answer turn costs nothing.

Deterministic A/B, one real captured stream replayed through `runModels` twice:

| capture | `response-NN.md` | bytes | verdict |
|---|---|---|---|
| `print` (pre-7.50) | `OMEGA_MARKER` | 13 | EMPTY · `shape_mismatch` |
| `stream-json` (default) | `ALPHA_MARKER` + `OMEGA_MARKER` | 27 | COMPLETED |

**Concatenate-everything was chosen over "keep the last substantial message"** because "substantial" is a byte threshold, and `DEFAULT_MIN_OUTPUT_BYTES` is 0 precisely because a 200-byte default recorded two correct short answers (141 B, 96 B) as EMPTY. Intermediate "let me read that file" chatter now lands in the response file; that cost is visible and bounded, whereas a wrong "substantial" verdict discards the answer again silently. `response-NN.md` stays prose either way, so the judge phase and every downstream reader are unaffected.

Four things that are load-bearing:

- **Argv order.** Children get `--verbose --quiet --output-format stream-json`, and `--verbose` MUST precede `--quiet`. claudish consumes `--verbose` as its own verbosity flag *and* forwards a copy to `claude`, which hard-errors on `--print --output-format stream-json` without it (`cli.ts` ~line 645). Reversed, every child narrates itself onto stderr. Verified live end-to-end: real claudish + `gc@glm-5.2` produced stream-json on stdout with exactly one stderr line.
- **`byteCount` and `stdoutTail` are fed the RECOVERED prose, not the raw JSON.** Every consumer — the empty check, `minOutputBytes`, the `[API Error:` match, the reported `outputSize` — is asking about the answer, and raw JSON inflates all of them (an empty answer wrapped in events is still kilobytes). `classifyRunOutput` never learns the wire format changed.
- **Unrecognised JSON is passed through, not dropped.** Only a line that is valid JSON *and* carries a `type` in {system, assistant, user, result} is treated as an event. The rule is per-line and never latches: sniffing the format once from the first line would let a single unexpected banner silently disable recovery for a whole run and quietly restore the original bug. Worst case is raw JSON in a response file — ugly, and visibly so.
- **Passthrough is byte-EXACT; only recovered messages get a synthesised trailing newline.** Not cosmetic: `team-timeout-repro.test.ts` pins a child that writes exactly 65536 bytes with no trailing newline to `outputSize === 65536`, and an added newline made it 65537. Two separators exist for the same reason — a blank line belongs *between messages*, while raw lines are a byte stream that already carries its own newline, and using the message separator for them inserted a blank line between every pair of prose lines.
- **The `is_error` result event is kept.** A terminal `result` normally just repeats the final assistant message, but on a failed turn it carries the error prose print mode would have put on stdout — which is what `API_ERROR_RE` matches. Dropping it would have silently disabled `api_error` detection.

`shape_mismatch` now means something different and says so: under recovery every assistant message was captured, so a missing marker means the model never produced the shape. The old "your answer was discarded" explanation survives only for `captureMode: "print"`. Escape hatch: `CLAUDISH_TEAM_CAPTURE=print` or `TeamRunOptions.captureMode`, kept for diagnosing a capture problem by comparing the two.

Fixture: `test-fixtures/stream-json/haiku-post-answer-turn.jsonl`, a real capture whose `.result` is `OMEGA_MARKER` alone while the stream carries both messages. That one file is the whole bug and the whole fix.

Unrelated but adjacent: `teamCommand` is exported from `team-cli.ts` and imported nowhere, so `claudish team run` is dead code that silently falls through to catalog search. The `team` surface is **MCP-only**.

## Channel Mode (v6.4.0+)

The MCP server supports a channel mode that enables async model sessions with push notifications.

### Architecture

Uses the low-level `Server` class (not `McpServer`) from `@modelcontextprotocol/sdk/server/index.js` to declare `experimental: { 'claude/channel': {} }` capability. The SDK's `assertNotificationCapability()` has no default case — custom notification methods like `notifications/claude/channel` pass through.

### Components (`packages/cli/src/channel/`)

- **SessionManager** — spawns `claudish --model X --stdin --quiet` child processes, tracks lifecycle, enforces timeouts
- **SignalWatcher** — per-session state machine (starting→running→tool_executing→waiting_for_input→completed/failed/cancelled)
- **ScrollbackBuffer** — in-memory ring buffer (2000 lines) for session output

### MCP Tools (12 total)

- **Low-level** (4): `run_prompt`, `list_models`, `search_models`, `compare_models`
- **Agentic** (3): `preflight`, `team`, `report_error`
- **Channel** (5): `create_session`, `send_input`, `get_output`, `cancel_session`, `list_sessions`

`preflight` exists because `--probe` is CLI-ONLY. An MCP consumer had no way to
check a roster before committing to it, so it either shelled out to the CLI or
discovered provisioning failures minutes in with the slots already spent — a real
`team` run lost 3 of 10 slots that way. It reports, per model, WHICH provider
would serve it (via `route()`, the same rules and credential filter a real run
uses), whether that hop is flat-rate or METERED, and whether it is reachable now.
The billing column is the non-obvious half: subscription-vs-metered is a property
of the PROVIDER, not the model, so the same bare name can be free through a plan
or billed per token depending on which credential is present — which is precisely
what a caller cannot see from the model id.

The roster is pinned by an EXACT frozen array in `channel/e2e-channel.test.ts`, so
adding or removing a tool without updating that test fails CI. That is deliberate:
it is a wire contract, and an accidental change to the tool surface should be loud.

Tool gating via `CLAUDISH_MCP_TOOLS` env var: `all` (default), `low-level`, `agentic`, `channel`.

### Tool Registration Pattern

Uses a `ToolDefinition[]` registry with raw JSON Schema (not Zod). Two `setRequestHandler` calls replace McpServer's ergonomic API:
- `ListToolsRequestSchema` → returns filtered tool list
- `CallToolRequestSchema` → dispatches to handler by name

### Channel Notifications

`server.notification({ method: "notifications/claude/channel", params: { content, meta } })` — pushed by SessionManager's `onStateChange` callback on state transitions. The method, capability, and params shape match Anthropic's [Channels reference](https://code.claude.com/docs/en/channels-reference) byte-for-byte.

The wire format is contractually pinned by `channel-wire-format.test.ts`:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "<string>",
    "meta": {
      "session_id": "<8-char hex>",
      "event": "starting|running|tool_executing|waiting_for_input|completed|failed|cancelled",
      "model": "<model-id>",
      "elapsed_seconds": "<numeric string>",
      "task_id": "<same as session_id>",
      "status": "working|input_required|completed|failed|cancelled",
      "created_at": "<ISO 8601 from session start>",
      "last_updated_at": "<ISO 8601 at notification time>"
    }
  },
  "jsonrpc": "2.0"
}
```

When rendered by Claude Code, each notification arrives in the agent's context as:

```
<channel source="claudish" session_id="…" event="…" model="…" elapsed_seconds="…">
<content here>
</channel>
```

`meta` keys must match `[a-zA-Z0-9_]+` — Claude Code silently drops keys with hyphens or other characters. Our schema uses underscore-only keys (`session_id`, `elapsed_seconds`, etc.); when adding new `extraMeta` keys via `SignalWatcher`, keep this constraint.

The `task_id` / `status` / `created_at` / `last_updated_at` fields are SEP-1686 (MCP Tasks) forward-compatibility — additive only, no current consumer behavior change. The 7-value `event` collapses to the 5-value `status` per `EVENT_TO_TASK_STATUS` in `mcp-server.ts`. When Claude Code ships `notifications/tasks/status` receiver support, the migration is a method-name swap + payload restructure; see `ROADMAP.md` (Channel notifications → Phase 2) and `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/sep-1686-migration-schema.md` (write-up lost — predates the ai-docs tracking fix) for the full plan.

### Enabling channel rendering in Claude Code

The Claudish MCP server emits the documented wire format, but Claude Code gates channel **registration** behind several conditions that have nothing to do with the wire contract. All of these must be satisfied for `<channel>` blocks to surface in the agent's context:

| Requirement | Why |
|---|---|
| Claude Code v2.1.80 or later | Channels feature minimum version |
| Anthropic auth via claude.ai OR Console API key | Channels are NOT supported on Bedrock, Vertex, or Foundry |
| Interactive session (no `-p` / `--print`) | Channel registration is bound to the interactive event loop. Empirically verified: in `-p` mode the registration codepath never runs and frames are silently dropped |
| Server defined in project `.mcp.json` or `~/.claude.json` | `--mcp-config` is NOT consulted by the channel resolver. Tools loaded via `--mcp-config` work; channels declared by the same server do not register |
| Server explicitly named in `--channels` OR `--dangerously-load-development-channels` | Being in MCP config alone is not enough. Per Anthropic docs: *"a server also has to be named in `--channels`"* |
| Org policy `channelsEnabled: true` (Team/Enterprise only) | Pro/Max users without an org skip this check |

**Launch command — bare server**:

```bash
# in a directory with .mcp.json containing a "claudish" entry
claude --dangerously-load-development-channels server:claudish
```

**Launch command — via the Magus `code-analysis` plugin** (Claudish is bundled there as an MCP server):

```bash
claude --dangerously-load-development-channels plugin:code-analysis@magus
```

The `--dangerously-load-development-channels` flag triggers a one-time confirmation prompt per session. To remove that prompt, the plugin would need to be added to Anthropic's curated channel allowlist (security review required) or to your org's `allowedChannelPlugins` managed setting.

### Diagnostic tracing — `CLAUDISH_CHANNEL_TRACE=1`

When the channel pipeline appears broken (e.g., client never renders `<channel>` blocks), set `CLAUDISH_CHANNEL_TRACE=1` before starting the MCP server. The diagnostics module (`packages/cli/src/channel/diagnostics.ts`) then emits `[channel-trace] …` lines to stderr at three checkpoints:

1. `fired sid=… type=… model=… elapsed=…s` — onStateChange callback entered (producer side fires)
2. `callback returned sid=… type=…` — bridge invoked `server.notification()` without throwing
3. `WIRE-OUT {…json…}` — the JSON-RPC frame literally hit stdout

If you see (1) but not (2): the bridge is throwing or rejecting silently.
If you see (1)+(2) but not (3): the SDK's transport is dropping the frame.
If you see all three but the client doesn't render the notification: the issue is client-side — most often one of the gating conditions in "Enabling channel rendering in Claude Code" above is unmet.

Off by default. Zero overhead in production.

When the MCP server is spawned by a host that captures stderr (e.g. Claude Code), set `CLAUDISH_CHANNEL_TRACE_FILE=/path/to/log` alongside `CLAUDISH_CHANNEL_TRACE=1` to mirror trace lines to a file you can `tail` from outside the host process. The file is opened with `appendFileSync` so multiple sessions append safely.

Two diagnostic scripts:
- `packages/cli/src/channel/test-helpers/channel-diagnostic.ts` — drives the MCP server with raw JSON-RPC against the OpenRouter free model. Confirms the producer→bridge→wire pipeline.
- `packages/cli/src/channel/test-helpers/client-diagnostic.ts` — spawns `claude -p` against the instrumented MCP server and compares what the server sent vs. what the client surfaced. Useful for diagnosing client-side gating.
- `packages/cli/src/channel/test-helpers/claudish-mock.ts` — a standalone mock MCP server that exposes a single `start_mock_session` tool, then emits a scripted sequence of 6 channel notifications over ~9 seconds. Decouples channel-rendering tests from real-model behavior.

### Testing

```bash
bun test --cwd . ./packages/cli/src/channel/*.test.ts
```

65 tests across 5 files: scrollback-buffer (11), signal-watcher (12), session-manager (21), e2e-channel (15), channel-wire-format (6). The wire-format tests run without an API key by using the fake-claudish PATH shim, so they execute on every CI run.

E2E tests use `--strict-mcp-config --bare --dangerously-skip-permissions` for isolation. SessionManager tests use a fake-claudish PATH shim (`channel/test-helpers/fake-claudish.ts`).

**`--bare` defers the MCP connection past `system/init` — do not assert MCP discovery under it.** Measured 2026-08-01 with a 20-line dependency-free stdio MCP server, so this is Claude Code behaviour, not a claudish one:

| flags | `system/init` `mcp_servers` | MCP tools in the init `tools` array | what the model did |
|---|---|---|---|
| `-p --strict-mcp-config --bare` | `status: "pending"` | none | two `Bash` calls first, then *sometimes* the MCP tool |
| `-p --strict-mcp-config` | `status: "connected"` | present | `ToolSearch` → the MCP tool |

Under `--bare` the tools are not in the model's toolset when it decides what to do, so it improvises with `Bash` — with the real claudish server it answered *"I don't have access to a tool called `mcp__claudish__list_models`. My available tools are `Bash`, `Edit`, and `Read`."* Any test asserting that a tool was DISCOVERED or CALLED must drop `--bare`; `--strict-mcp-config` alone still restricts MCP to the temp config, which is the isolation that matters. Keep `--bare` for tests that only drive the server directly over JSON-RPC.

Assert on the protocol, never on prose: `--output-format stream-json --verbose` exposes the `init` server status, the `tools` array, and the `tool_use`/`tool_result` pair. An assertion like `stdout.includes("Recommended Models")` passes for the wrong reason — it matched output the model produced via `Bash` while MCP discovery was silently broken. Also `proc.stdin.end()` on the spawned `claude`, or every run stalls 3s on "no stdin data received".

### The `notifications/progress` keepalive (`mcp/progress-heartbeat.ts`)

Claude Code aborts a tool call that puts nothing on the transport for its idle window — `MCP server "plugin:claudish:claudish" tool "team" sent no response or progress for 1800s; aborting`. Measured 2026-08-14 on **2.1.231** with three tools of identical 90s duration against a 30s window (`ai-docs/reports/mcp-progress-keepalive/findings.md`):

| Tool emits every 10s | Outcome |
|---|---|
| nothing | aborted at 30s |
| `notifications/progress` | survived 90s |
| `notifications/claude/channel` | aborted at 30s |

Channel and progress are **complementary, not alternatives**: channel is the visible surface with no keepalive, progress is the invisible keepalive — it still renders nowhere. A tool that blocks for minutes needs both.

**`heartbeat: true` is set on exactly three tools**: `team`, `run_prompt`, `compare_models`. `create_session` deliberately does NOT carry it — it returns in milliseconds with `{session_id, status:"starting"}` and cannot reach the idle timer; the session's own long life is reported over channel frames, which is a different question.

**The emitter is TIME-driven, not event-driven**, and that is the load-bearing choice. `team` already emitted a channel frame on every state change and still died at exactly 1800s, because a model that thinks for 30 minutes produces no state changes — an event-driven emitter goes silent precisely while the idle timer is counting.

Interval defaults to 10s (the measured-working value), overridable with `CLAUDISH_MCP_PROGRESS_INTERVAL_MS`, clamped to `[1000, 60000]`, garbage → default. Resolved once per server, not per call, so a long session cannot change cadence mid-flight. The first frame lands at t+interval, so a 200ms call stays completely silent.

**An absent or invalid `progressToken` degrades to `NOOP_HEARTBEAT`** — a shared frozen handle: no timer, no frame, no warning, no throw. The token is optional in the spec, so a host that omits it has not misbehaved, and a tool call must never fail because its keepalive could not arm. (2.1.231 does send it — observed value `2` in every probe arm. `anthropics/claude-code#58687`, which reports the client sends no `_meta.progressToken`, is STALE.)

**`stop()` latches; `clearInterval` alone would not be enough.** The dispatch owns start and stop in a `finally`, and `stopped` is re-checked at the top of `emit`, so a tick already queued on the macrotask queue when the response was computed is dropped instead of reaching the wire after its own response — the `GLips/Figma-Context-MCP#362` teardown pattern, where a frame arriving after the client cleaned up its token tears down stdio.

**Idle-window defaults, for sizing any test or config**: 30 min on stdio, 5 min on HTTP/SSE/WS. A per-server `timeout` (ms, ≥1000) in `.mcp.json` floors it for that server only; `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` disables the check entirely. **Undocumented floor worth knowing**: values below ~30s are silently ignored by the client — `1000` and `5000` were (a silent 20s call survived a nominal 5s window), `30000` was honoured exactly. Any test using a shorter window is confounded, because its control cannot fail.

## Test Infrastructure

### Format Translation Test Harness
`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.

## Version Bumping Checklist

When releasing a new version, update ALL of these locations:
1. `package.json` (root monorepo version)
2. `packages/cli/package.json` (npm-published package - **CI/CD publishes from here**)
3. `packages/cli/src/version.ts` (fallback VERSION constant — moved from cli.ts in v7.0.0)

The fallback VERSION in version.ts ensures compiled binaries (Homebrew, standalone) display the correct version when package.json isn't available. The `packages/cli/package.json` version is what npm publishes - if it's not updated, npm publish will fail.

## Session Artifacts

`ai-docs/` is TRACKED, but `ai-docs/sessions/` is GITIGNORED. The split is load-bearing, not bookkeeping.

**Ephemeral working artifacts** — scratch notes, raw run directories, intermediate logs, one-off probe scripts — go in `ai-docs/sessions/{task-slug}-{YYYYMMDD-HHMMSS}-{hash}/`, not `/tmp` (cleared on reboot). That directory does NOT survive a fresh clone or `git worktree remove`.

**Anything referenced from CLAUDE.md, or otherwise meant to outlive the session, must be written somewhere TRACKED under `ai-docs/`** — `ai-docs/reports/` for findings and write-ups, `ai-docs/benches/` for reusable evals. Both exist and hold real content. A session dir is where you work; a tracked dir is where the conclusion goes.

The cost is already paid: under the old "everything in `ai-docs/sessions/`" rule, of the four session write-ups CLAUDE.md cites, **three no longer exist anywhere** — never committed, so they died with the worktree that produced them. The prose citing them survives and now points at nothing, which is why those references carry an inline "write-up lost" marker. Only `dev-feature-parent-resolve-…/baseline-evidence.md` is still readable, and only by accident.

## Learned Preferences

### Tools & Commands
<!-- learned: 2026-03-28 session: 03cd7cc5 source: repeated_pattern -->
- Use `bun` for all package management and scripts (`bun run build`, `bun test`, etc.) — not npm or yarn
<!-- learned: 2026-04-06 session: df311293 source: repeated_pattern -->
<!-- revised: 2026-07-26 — root cause was a missing Ollama embedding model, not mnemex itself -->
- Prefer mnemex AST lookups over grep for symbol/caller questions: `mnemex --agent symbol|callers|callees "Name"`
- Semantic search is `mnemex --agent search "concept"` — NOT `map`, which ignores its argument entirely and always dumps the same PageRank overview
- `search` needs Ollama serving `nomic-embed-text` — without it embeddings are zero-length, so search is useless and `status` panics with a lance divide-by-zero. Fix: `ollama pull nomic-embed-text` → `rm -rf .mnemex/vectors` → `mnemex index`

### Workflow
<!-- learned: 2026-04-06 session: df311293 source: explicit_rule -->
- Don't run claudish directly in main bash — use dedicated channel sessions or `/delegate`
